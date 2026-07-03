"""Geometry: basemap reader, storm-framed bbox, clip, and payload assembly.

Stdlib ONLY. The basemap is the compact packed file shipped with the
integration (built by tools/pack_basemap.py). It is GLOBAL and high-resolution,
so it is read lazily: the packed bytes stay in memory, a light per-part bbox
index is parsed up front, and only the parts inside the storm view are decoded
on a clip. That keeps a global 10m map cheap enough for low-end hardware (a Pi).

Per view, coastlines are simplified with Douglas-Peucker down to a point budget,
so the payload the card draws stays bounded no matter how dense the region or how
deep the zoom. The card smooths the budgeted points into curves at draw time.
"""
from __future__ import annotations

import math
import os
import struct

from .const import (
    BASIN_NAME,
    UNIT_KM,
)
from .nhc import compass, haversine_mi, storm_basin
from .regions import REGION_LABELS

_BASEMAP_PATH = os.path.join(os.path.dirname(__file__), "basemap.bin")
_LAYER_NAMES = ["coast", "states", "land"]

# unit conversions from NHC native units
_KT_TO_MPH = 1.15078
_KT_TO_KMH = 1.852
_MI_TO_KM = 1.609344

# Per-view draw budget: total points across all basemap layers after
# simplification. Keeps the websocket payload + SVG bounded at any zoom.
_POINT_BUDGET = 12000
_MIN_PTS = {"coast": 2, "states": 2, "land": 3}


# ---------------------------------------------------------------------------
# Basemap (packed binary) reader — HURB v2, matches tools/pack_basemap.py
# ---------------------------------------------------------------------------
class _Basemap:
    """Lazy reader over the packed basemap. Holds the raw bytes plus a per-part
    bbox index; decodes point coordinates only for parts a clip actually needs."""

    def __init__(self, buf):
        if buf[:4] != b"HURB":
            raise ValueError("bad basemap magic")
        ver, self.quant, nlayers = struct.unpack_from("<III", buf, 4)
        if ver != 2:
            raise ValueError("unsupported basemap version %d (need 2)" % ver)
        self.buf = buf
        p = 16
        dirs = []
        for _ in range(nlayers):
            off, ln = struct.unpack_from("<II", buf, p)
            p += 8
            dirs.append((off, ln))
        # index[layer] = list of (minx, miny, maxx, maxy, points_offset, npts)
        self.index = {}
        for name, (off, _ln) in zip(_LAYER_NAMES, dirs):
            parts = []
            cur = off
            nparts = struct.unpack_from("<I", buf, cur)[0]
            cur += 4
            for _ in range(nparts):
                mnx, mny, mxx, mxy = struct.unpack_from("<iiii", buf, cur)
                cur += 16
                npts = struct.unpack_from("<I", buf, cur)[0]
                cur += 4
                parts.append((mnx, mny, mxx, mxy, cur, npts))
                cur += 8 * npts
            self.index[name] = parts

    def _decode(self, poff, npts):
        q = self.quant
        buf = self.buf
        out = []
        o = poff
        for _ in range(npts):
            xi, yi = struct.unpack_from("<ii", buf, o)
            o += 8
            out.append([xi / q, yi / q])
        return out

    def clip(self, layer, bbox, pad):
        """Decode only the parts of `layer` whose stored bbox intersects the
        padded view box. Returns a list of parts (each a list of [lng, lat])."""
        q = self.quant
        mnx = int((bbox[0] - pad) * q)
        mny = int((bbox[1] - pad) * q)
        mxx = int((bbox[2] + pad) * q)
        mxy = int((bbox[3] + pad) * q)
        out = []
        for (a, b, c, d, poff, npts) in self.index.get(layer, []):
            if a > mxx or c < mnx or b > mxy or d < mny:
                continue
            out.append(self._decode(poff, npts))
        return out


_basemap_cache = None


def load_basemap(path=_BASEMAP_PATH):
    """Read + index the packed basemap once (cached)."""
    global _basemap_cache
    if _basemap_cache is None:
        with open(path, "rb") as f:
            _basemap_cache = _Basemap(f.read())
    return _basemap_cache


# ---------------------------------------------------------------------------
# Douglas-Peucker simplification (per view)
# ---------------------------------------------------------------------------
def _dp(pts, tol):
    if tol <= 0 or len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        dd = dx * dx + dy * dy
        idx, far = -1, tol
        for i in range(a + 1, b):
            px, py = pts[i]
            if dd == 0:
                dist = math.hypot(px - ax, py - ay)
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / dd
                if t < 0:
                    t = 0.0
                elif t > 1:
                    t = 1.0
                dist = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if dist > far:
                idx, far = i, dist
        if idx != -1:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [pts[i] for i, k in enumerate(keep) if k]


def clip_basemap(basemap, bbox, pad):
    """Decode the in-view parts of each layer and simplify to the point budget.
    Coastlines get finer detail when zoomed in and thin out when zoomed out; the
    total point count is capped so the payload never blows up."""
    raw = {name: basemap.clip(name, bbox, pad) for name in _LAYER_NAMES}
    span = max(bbox[2] - bbox[0], bbox[3] - bbox[1], 0.01)

    # Start near screen resolution, then back off (coarser) until under budget.
    tol = span / 700.0
    for _ in range(7):
        simplified = {}
        total = 0
        for name in _LAYER_NAMES:
            minp = _MIN_PTS[name]
            parts = []
            for part in raw[name]:
                s = _dp(part, tol)
                if len(s) < minp:
                    continue
                parts.append(s)
                total += len(s)
            simplified[name] = parts
        if total <= _POINT_BUDGET:
            break
        tol *= 1.7

    return {
        name: [[[round(x, 4), round(y, 4)] for x, y in part] for part in simplified[name]]
        for name in _LAYER_NAMES
    }


# ---------------------------------------------------------------------------
# Storm-framed bbox
# ---------------------------------------------------------------------------
def compute_bbox(cone, fcst, past):
    """Frame on the cone + tracks ONLY (home is not forced in) so a distant
    storm stays zoomed. Fitted to a 4:3 aspect with cos(lat) longitude
    correction. Returns [minLng, minLat, maxLng, maxLat] or None."""
    xs, ys = [], []
    for seq in (cone, fcst, past):
        for x, y in seq:
            xs.append(x)
            ys.append(y)
    if not xs:
        return None
    min_lng, max_lng = min(xs), max(xs)
    min_lat, max_lat = min(ys), max(ys)
    span = max(max_lng - min_lng, max_lat - min_lat, 1.0)
    pad = max(span * 0.12, 1.2)
    bbox = [min_lng - pad, min_lat - pad, max_lng + pad, max_lat + pad]
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    target = 4.0 / 3.0
    cx = (bbox[0] + bbox[2]) / 2
    cy = (bbox[1] + bbox[3]) / 2
    cosf = max(0.2, math.cos(math.radians(cy)))
    aw = w * cosf
    if aw / h > target:
        nh = aw / target
        bbox = [bbox[0], cy - nh / 2, bbox[2], cy + nh / 2]
    else:
        nw = (h * target) / cosf
        bbox = [cx - nw / 2, bbox[1], cx + nw / 2, bbox[3]]
    return [round(v, 3) for v in bbox]


# ---------------------------------------------------------------------------
# Payload assembly (draw-ready, unit-converted)
# ---------------------------------------------------------------------------
_CAT_ORDER = {"TD": 0, "TS": 1, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6}


def _peak(points, cur_cat):
    peak = None
    for pt in points:
        rank = _CAT_ORDER.get(pt["cat"], 1)
        if peak is None or rank > peak[0]:
            peak = (rank, pt["cat"], pt.get("label", ""))
    if peak and peak[0] > _CAT_ORDER.get(cur_cat, 1):
        word = "Cat %s" % peak[1] if peak[1] in ("1", "2", "3", "4", "5") else peak[1]
        return {"cat": peak[1], "label": peak[2], "word": word}
    return None


def assemble_payload(storm, fdata, home_lat, home_lon, units):
    """Build the final card payload from a selected storm + its parsed GIS."""
    basemap = load_basemap()
    cone = fdata.get("cone") or []
    fcst = fdata.get("fcstTrack") or []
    past = fdata.get("pastTrack") or []
    points = fdata.get("points") or []

    bbox = compute_bbox(cone, fcst, past)
    if not bbox:
        return None
    pad = max((bbox[2] - bbox[0]), (bbox[3] - bbox[1])) * 0.15
    geo = clip_basemap(basemap, bbox, pad)

    # Region labels whose anchor falls in view; the card decides what to draw and
    # hides any that would collide with storm data.
    labels = [r for r in REGION_LABELS
              if bbox[0] <= r["lng"] <= bbox[2] and bbox[1] <= r["lat"] <= bbox[3]]

    cur_lat = storm.get("latitudeNumeric")
    cur_lng = storm.get("longitudeNumeric")
    dist_mi = (haversine_mi(home_lat, home_lon, cur_lat, cur_lng)
               if cur_lat is not None and cur_lng is not None else None)

    km = units == UNIT_KM
    wind_unit = "km/h" if km else "mph"
    dist_unit = "km" if km else "mi"
    wind_k = _KT_TO_KMH if km else _KT_TO_MPH

    def spd(kt):
        try:
            return round(float(kt) * wind_k)
        except (TypeError, ValueError):
            return None

    p0 = points[0] if points else {}
    md = storm.get("movementDir")
    ms = storm.get("movementSpeed")
    move_text = ""
    if md is not None and ms is not None:
        s = spd(ms)
        if s is not None:
            move_text = "%s at %d %s" % (compass(md), s, wind_unit)

    def _dist_conv(mi):
        if mi is None:
            return None
        return round(mi * _MI_TO_KM) if km else round(mi)

    dist_val = _dist_conv(dist_mi)

    bkey = storm_basin(storm)
    meta = {
        "name": fdata.get("name") or storm.get("name", ""),
        "type": fdata.get("type") or storm.get("classification", ""),
        "cat": p0.get("cat", ""),
        "wind": spd(p0.get("wind")),
        "gust": spd(p0.get("gust")),
        "mslp": p0.get("mslp"),
        "moveText": move_text,
        "dist": dist_val,
        "distUnit": dist_unit,
        "windUnit": wind_unit,
        "basin": bkey,
        "basinName": BASIN_NAME.get(bkey, ""),
        "peak": _peak(points, p0.get("cat", "TS")),
    }

    return {
        "ok": True,
        "stormId": storm.get("id", ""),
        "advisory": fdata.get("advisory", ""),
        "bbox": bbox,
        "home": [home_lon, home_lat],
        "cur": [cur_lng, cur_lat] if cur_lng is not None else None,
        "cone": cone,
        "fcstTrack": fcst,
        "pastTrack": past,
        "points": points,
        "ww": fdata.get("ww") or [],
        "geo": geo,
        "labels": labels,
        "meta": meta,
    }
