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

import json
import math
import os
import struct

from .const import (
    BASIN_NAME,
    CITY_DOT_CAP,
    POP_GRID_CAP,
    POP_GRID_MIN_POP,
    POP_GRID_START_DIV,
    UNIT_KM,
    ZOOM_BUFFER_FACTOR,
    ZOOM_MAX_SCALE,
    ZOOM_PAYLOAD_CAP_BYTES,
    ZOOM_POINT_BUDGET,
)
from .nhc import bearing_deg, compass, haversine_mi, storm_basin
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
# Basemap (packed binary) reader — HURB v2/v3, matches tools/pack_basemap.py
# (v3 adds a 4th POINT layer, populated places; a v2 file just has no places)
# ---------------------------------------------------------------------------
class _Basemap:
    """Lazy reader over the packed basemap. Holds the raw bytes plus a per-part
    bbox index; decodes point coordinates only for parts a clip actually needs."""

    def __init__(self, buf):
        if buf[:4] != b"HURB":
            raise ValueError("bad basemap magic")
        ver, self.quant, nlayers = struct.unpack_from("<III", buf, 4)
        if ver not in (2, 3, 4):
            raise ValueError("unsupported basemap version %d (need 2, 3 or 4)" % ver)
        self.buf = buf
        p = 16
        dirs = []
        for _ in range(nlayers):
            off, ln = struct.unpack_from("<II", buf, p)
            p += 8
            dirs.append((off, ln))
        # index[layer] = list of (minx, miny, maxx, maxy, points_offset, npts)
        self.index = {}
        # Two POINT layers of (x, y, rank, pop, name) quantized ints, decoded
        # eagerly at load (a few thousand small records each -- one-time, cheap):
        #   places = GeoNames density set (rank = pop bucket), for popGrid.
        #   named  = Natural Earth curated set (rank = scalerank), for the labels.
        self.places = []
        self.named = []
        rec = struct.calcsize("<iiBIB")   # 14: no alignment padding with "<"

        def _points(dir_index):
            out = []
            cur = dirs[dir_index][0]
            npl = struct.unpack_from("<I", buf, cur)[0]
            cur += 4
            for _ in range(npl):
                x, y, rank, pop, nlen = struct.unpack_from("<iiBIB", buf, cur)
                cur += rec
                name = buf[cur:cur + nlen].decode("utf-8", "replace")
                cur += nlen
                out.append((x, y, rank, pop, name))
            return out

        if ver >= 3 and len(dirs) >= 4:
            self.places = _points(3)
        if ver >= 4 and len(dirs) >= 5:
            self.named = _points(4)
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

    def _points_in(self, records, bbox, pad):
        if not records:
            return []
        q = self.quant
        mnx = int((bbox[0] - pad) * q)
        mny = int((bbox[1] - pad) * q)
        mxx = int((bbox[2] + pad) * q)
        mxy = int((bbox[3] + pad) * q)
        out = []
        for (x, y, rank, pop, name) in records:
            if x < mnx or x > mxx or y < mny or y > mxy:
                continue
            out.append({"name": name, "lng": x / q, "lat": y / q,
                        "rank": rank, "pop": pop})
        return out

    def places_in(self, bbox, pad=0.0):
        """GeoNames density places inside the (padded) box, as dicts (rank = pop
        bucket). Same quantized bbox compare as clip() — no antimeridian wrap,
        matching the line layers. Empty on a v2 basemap."""
        return self._points_in(self.places, bbox, pad)

    def named_in(self, bbox, pad=0.0):
        """Curated Natural Earth named places inside the (padded) box, as dicts
        with rank = scalerank (0 = most prominent). Empty on a v2/v3 basemap (no
        named layer) — the caller then falls back to the GeoNames places."""
        return self._points_in(self.named, bbox, pad)


def _thin_pop_grid(places, view_box):
    """popGrid entries for the card: compact [lng, lat, pop] triples.

    At or under POP_GRID_CAP places, everything passes through untouched (true
    positions). Over the cap, places are aggregated per grid cell: each
    occupied cell becomes ONE entry at the pop-WEIGHTED centroid of its
    members (a centroid, not the cell center -- a cell-center grid reads as a
    visible lattice) carrying the summed population. The cell size starts at
    1/POP_GRID_START_DIV of the view's larger span and doubles until the
    occupied-cell count fits the cap, so resolution degrades only as far as
    the frame's density forces it. The card is agnostic: its per-frame
    relative dot scaling, cone fade, and in-cone population sum all operate on
    [lng,lat,pop] triples whether a triple is one town or a merged cell.
    POP_GRID_MIN_POP floors the input BEFORE aggregation (0 = everything in
    the basemap; 25000 mimics the pre-GeoNames Natural Earth density)."""
    pts = ([p for p in places if p["pop"] >= POP_GRID_MIN_POP]
           if POP_GRID_MIN_POP > 0 else places)
    if len(pts) <= POP_GRID_CAP:
        return [[round(p["lng"], 3), round(p["lat"], 3), p["pop"]] for p in pts]
    span = max(view_box[2] - view_box[0], view_box[3] - view_box[1], 1e-6)
    cell = span / POP_GRID_START_DIV
    while True:
        cells = {}
        for p in pts:
            w = max(p["pop"], 1)
            k = (math.floor(p["lng"] / cell), math.floor(p["lat"] / cell))
            c = cells.get(k)
            if c is None:
                cells[k] = [w, p["lng"] * w, p["lat"] * w]
            else:
                c[0] += w
                c[1] += p["lng"] * w
                c[2] += p["lat"] * w
        if len(cells) <= POP_GRID_CAP:
            return [[round(sx / w, 3), round(sy / w, 3), w]
                    for (w, sx, sy) in cells.values()]
        cell *= 2.0


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


def simplify_rings(rings, tol, budget=None):
    """DP-simplify a list of [[lng, lat], ...] rings (degrees). Drops rings that
    degenerate below 4 points. If `budget` is set and the total point count is
    over it, the tolerance coarsens (tol *= 1.7, same backoff as the zoom clip)
    and the pass re-runs -- a hard bound so an on-demand layer (E5 surge /
    wind-history rings) can never blow up a websocket payload."""
    if not rings:
        return []
    for _ in range(8):
        out = []
        total = 0
        for r in rings:
            s = _dp([tuple(p) for p in r], tol)
            if len(s) >= 4:
                out.append([[round(x, 4), round(y, 4)] for x, y in s])
                total += len(s)
        if budget is None or total <= budget or not out:
            return out
        tol *= 1.7
    return out


def clip_basemap(basemap, bbox, pad, ref_span=None, budget=None, cap_bytes=None):
    """Decode the in-view parts of each layer and simplify to a point budget.
    Coastlines get finer detail when zoomed in and thin out when zoomed out; the
    total point count is capped so the payload never blows up.

    Default view (ref_span=None): tolerance is set from THIS bbox's own span, so
    detail matches the frame -- unchanged behaviour, used for the default clip.

    Buffered clip (ref_span given): tolerance is pinned to ref_span (the DEFAULT
    frame's span), NOT this larger buffered bbox's span. That keeps the revealed
    buffer at the same per-degree sharpness as the default view, so zooming in
    doesn't show chunky coast -- at the cost of more points, hence the higher
    budget. cap_bytes, when given, is a HARD ceiling on the serialized geo: after
    the point-budget pass, if the JSON is still over cap we keep backing off the
    tolerance until it fits (guards a pathological dense frame)."""
    raw = {name: basemap.clip(name, bbox, pad) for name in _LAYER_NAMES}
    span = max(bbox[2] - bbox[0], bbox[3] - bbox[1], 0.01)
    tol_span = ref_span if ref_span is not None else span
    max_pts = budget if budget is not None else _POINT_BUDGET

    # Start near screen resolution, then back off (coarser) until under budget.
    tol = tol_span / 700.0
    simplified = {}
    for _ in range(9):
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
        if total <= max_pts:
            break
        tol *= 1.7

    geo = {
        name: [[[round(x, 4), round(y, 4)] for x, y in part] for part in simplified[name]]
        for name in _LAYER_NAMES
    }

    # Hard payload cap: keep coarsening until the serialized geo fits. Only the
    # buffered clip passes cap_bytes; the default view leaves it None (no cap).
    if cap_bytes is not None:
        for _ in range(6):
            if len(json.dumps(geo, separators=(",", ":"))) <= cap_bytes:
                break
            tol *= 1.7
            simplified = {}
            for name in _LAYER_NAMES:
                minp = _MIN_PTS[name]
                parts = []
                for part in raw[name]:
                    s = _dp(part, tol)
                    if len(s) < minp:
                        continue
                    parts.append(s)
                simplified[name] = parts
            geo = {
                name: [[[round(x, 4), round(y, 4)] for x, y in part] for part in simplified[name]]
                for name in _LAYER_NAMES
            }

    return geo


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


def _closest_approach(points, home_lat, home_lon, cur_lat=None, cur_lon=None):
    """Nearest point on the forecast-center track to home + the forecast hour
    (tau) at that point. Returns (dist_mi, tau_hours).

    Runs on the forecast `points` (each carries lat/lng AND tau) rather than the
    denser fcstTrack line (which has no time), so the ETA is exact and the
    distance is within a hair at NHC's 12-hourly cadence. The current center is
    folded in as a tau-0 candidate so closest approach is never *farther* than
    where the storm is right now -- a receding storm's closest point is 'now'.
    (GDACS forecast points are reconstructed slightly off the reported center, so
    without this the min over forecast points alone can read > current distance.)
    Home is projected onto each segment in a local equirectangular frame (cos-lat
    corrected) and clamped; tau is interpolated at the projection. tau_hours is
    None when the points carry no tau (GDACS -> distance only, no ETA)."""
    pts = [p for p in (points or [])
           if p.get("lat") is not None and p.get("lng") is not None]
    if cur_lat is not None and cur_lon is not None:
        pts = [{"lat": cur_lat, "lng": cur_lon, "tau": 0.0}] + pts
    if not pts:
        return None, None
    if len(pts) == 1:
        p = pts[0]
        return haversine_mi(home_lat, home_lon, p["lat"], p["lng"]), p.get("tau")

    coslat = math.cos(math.radians(home_lat))
    best_d, best_tau = None, None
    for a, b in zip(pts, pts[1:]):
        # local planar coords relative to home (origin); lon scaled by cos(lat)
        ax = (a["lng"] - home_lon) * coslat
        ay = a["lat"] - home_lat
        dx = (b["lng"] - a["lng"]) * coslat
        dy = b["lat"] - a["lat"]
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
        plng = a["lng"] + t * (b["lng"] - a["lng"])
        plat = a["lat"] + t * (b["lat"] - a["lat"])
        d = haversine_mi(home_lat, home_lon, plat, plng)
        if best_d is None or d < best_d:
            best_d = d
            ta, tb = a.get("tau"), b.get("tau")
            best_tau = (ta + t * (tb - ta)) if (ta is not None and tb is not None) else None
    return best_d, best_tau


# ---------------------------------------------------------------------------
# Wind field (Phase 3): distance to the 34 kt edge + strongest field over home
# ---------------------------------------------------------------------------
def _pt_in_ring(lng, lat, ring):
    """Ray-cast point-in-polygon on a closed ring of [lng, lat] pairs."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and \
           (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _dist_to_ring_mi(home_lat, home_lon, ring):
    """Shortest distance (mi) from home to a ring's boundary. Home is projected
    onto each edge in a local cos-lat frame; the nearest point is measured with
    haversine."""
    coslat = math.cos(math.radians(home_lat))
    best = None
    for a, b in zip(ring, ring[1:]):
        ax = (a[0] - home_lon) * coslat
        ay = a[1] - home_lat
        dx = (b[0] - a[0]) * coslat
        dy = b[1] - a[1]
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
        plng = a[0] + t * (b[0] - a[0])
        plat = a[1] + t * (b[1] - a[1])
        d = haversine_mi(home_lat, home_lon, plat, plng)
        if best is None or d < best:
            best = d
    return best


def _wind_report(wind_field, home_lat, home_lon):
    """(dist_mi, at_home_kt) for a storm's current wind field.

    at_home_kt: strongest threshold (64/50/34) whose ring contains home, else
      None. dist_mi: distance to the nearest 34 kt (TS-force) edge when home is
      OUTSIDE the field; 0 when home is inside it; None when there's no field."""
    if not wind_field:
        return None, None
    rings_by_kt = {w["kt"]: (w.get("rings") or []) for w in wind_field}
    for kt in (64, 50, 34):
        for ring in rings_by_kt.get(kt, []):
            if len(ring) >= 3 and _pt_in_ring(home_lon, home_lat, ring):
                return 0.0, kt
    best = None
    for ring in rings_by_kt.get(34, []):
        if len(ring) >= 2:
            d = _dist_to_ring_mi(home_lat, home_lon, ring)
            if d is not None and (best is None or d < best):
                best = d
    return best, None


# --- build a smooth wind ring from the 4 quadrant radii ---------------------
# NHC issues wind extent as four numbers (NE/SE/SW/NW, nautical mi) per threshold.
# Drawing that literally gives hard corners at the quadrant lines. Instead we treat
# each radius as the value at its quadrant CENTER (45/135/225/315 deg) and blend
# between them with a periodic cosine, sampling a dense ring. Result: one organic
# lopsided blob, no visible quadrant seams, and (cosine never overshoots) the
# extent never exceeds the issued radii.
_R_NM = 3440.065
_WIND_CTRL = [(45.0, "ne"), (135.0, "se"), (225.0, "sw"), (315.0, "nw")]


def _wind_dest(clat, clon, brg, nm):
    """[lng, lat] at bearing `brg` deg, distance `nm` nautical mi from center."""
    d = nm / _R_NM
    br = math.radians(brg)
    la1, lo1 = math.radians(clat), math.radians(clon)
    la2 = math.asin(math.sin(la1) * math.cos(d) +
                    math.cos(la1) * math.sin(d) * math.cos(br))
    lo2 = lo1 + math.atan2(math.sin(br) * math.sin(d) * math.cos(la1),
                           math.cos(d) - math.sin(la1) * math.sin(la2))
    return [round(math.degrees(lo2), 4), round(math.degrees(la2), 4)]


def _wind_radius_at(brg, r):
    """Smoothly interpolated radius (nm) at bearing `brg`, from quadrant radii
    dict r (keys ne/se/sw/nw). Periodic cosine blend between quadrant centers."""
    b = brg % 360.0
    for i in range(4):
        a_ang, a_key = _WIND_CTRL[i]
        _, b_key = _WIND_CTRL[(i + 1) % 4]
        span = (_WIND_CTRL[(i + 1) % 4][0] - a_ang) % 360.0
        off = (b - a_ang) % 360.0
        if off <= span:
            t = off / span if span else 0.0
            s = (1 - math.cos(math.pi * t)) / 2.0
            return r[a_key] + (r[b_key] - r[a_key]) * s
    return r["ne"]


def _wind_ring_from_radii(clat, clon, r, step=5.0):
    """Smooth closed lng/lat ring from quadrant radii dict r (ne/se/sw/nw, nm),
    centered on the storm. None if all radii are zero."""
    if max(r.get("ne", 0), r.get("se", 0),
           r.get("sw", 0), r.get("nw", 0)) <= 0:
        return None
    ring = []
    b = 0.0
    while b < 360.0:
        rad = _wind_radius_at(b, r)
        ring.append([round(clon, 4), round(clat, 4)] if rad <= 0
                    else _wind_dest(clat, clon, b, rad))
        b += step
    ring.append(ring[0])
    return ring


# ---------------------------------------------------------------------------
# Wind SWATH corridor: a tapering tube along the forecast track, the way GDACS
# draws its bands. At each forecast point we take the LARGEST of the four quadrant
# radii (the outer extent) and offset the track line perpendicular by that radius
# on each side; the two edges plus rounded end caps form one smooth corridor per
# threshold. Symmetric about the track on purpose (that's GDACS's model) and cheap
# -- ~2N + caps points, not a pile of overlapping blobs.
# ---------------------------------------------------------------------------
def _circle_ring(clat, clon, r_nm, step=30.0):
    ring = []
    b = 0.0
    while b < 360.0:
        ring.append(_wind_dest(clat, clon, b, r_nm))
        b += step
    ring.append(ring[0])
    return ring


def _cap_arc(clat, clon, r_nm, hdg, front, n=4):
    """Interior arc points rounding one end of the corridor: the outboard half-
    circle from the left edge round to the right edge (front=True sweeps through the
    forward heading; False through the rear). Endpoints are already the edge points,
    so we emit only the interior samples."""
    if r_nm <= 0:
        return []
    a0, a1 = (hdg - 90.0, hdg + 90.0) if front else (hdg + 90.0, hdg + 270.0)
    return [_wind_dest(clat, clon, (a0 + (a1 - a0) * k / n) % 360.0, r_nm)
            for k in range(1, n)]


def _order_along_track(pts, slng, slat):
    """Order swath points into a track sequence: start at the one nearest the storm's
    current position, then nearest-neighbour chain. Recovers travel order without
    trusting GDACS's messy time labels."""
    rem = list(pts)
    if not rem:
        return []
    i0 = min(range(len(rem)),
             key=lambda i: (rem[i]["lng"] - slng) ** 2 + (rem[i]["lat"] - slat) ** 2)
    ordered = [rem.pop(i0)]
    while rem:
        last = ordered[-1]
        j = min(range(len(rem)),
                key=lambda i: (rem[i]["lng"] - last["lng"]) ** 2
                + (rem[i]["lat"] - last["lat"]) ** 2)
        ordered.append(rem.pop(j))
    return ordered


def _corridor_ring(pts):
    """One smooth corridor outline from ordered swath points (each {lng,lat,ne,se,
    sw,nw}); half-width at each point is the max quadrant radius. None if no extent."""
    n = len(pts)
    if n == 0:
        return None
    radii = [max(p.get("ne", 0), p.get("se", 0),
                 p.get("sw", 0), p.get("nw", 0)) for p in pts]
    if max(radii) <= 0:
        return None
    if n == 1:
        return _circle_ring(pts[0]["lat"], pts[0]["lng"], radii[0])
    hdgs, left, right = [], [], []
    for i in range(n):
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        hdg = bearing_deg(a["lat"], a["lng"], b["lat"], b["lng"])
        hdgs.append(hdg)
        left.append(_wind_dest(pts[i]["lat"], pts[i]["lng"], (hdg - 90.0) % 360.0, radii[i]))
        right.append(_wind_dest(pts[i]["lat"], pts[i]["lng"], (hdg + 90.0) % 360.0, radii[i]))
    ring = list(left)
    ring += _cap_arc(pts[-1]["lat"], pts[-1]["lng"], radii[-1], hdgs[-1], True)
    ring += list(reversed(right))
    ring += _cap_arc(pts[0]["lat"], pts[0]["lng"], radii[0], hdgs[0], False)
    ring.append(ring[0])
    return ring


# ---------------------------------------------------------------------------
# At-home exposure timeline (Phase 4): when is home inside each forecast field?
# ---------------------------------------------------------------------------
def _exposure_timeline(points, wind_forecast, home_lat, home_lon):
    """For every forecast tau that carries wind radii, build that threshold's
    smooth ring (centered on the tau's forecast position from `points`) and test
    whether home is inside it. Contiguous exposed taus collapse into a window;
    boundaries are the midpoints toward the neighbouring forecast times, so a
    single-tau hit still reads as a real span and the 'possible' framing (the
    card labels it) covers the coarseness.

    Returns {"horizon": maxTau,
             "rows": [{"kt": 34, "dataMaxTau": T, "windows": [[t0, t1], ...]}]}
    with a row ONLY for thresholds home actually enters. None when there's no
    forecast wind data or home never enters even the 34 kt field. Reuses the
    Phase 3 ring builder + point-in-ring test, so the timeline and the on-map
    wind wash come from identical geometry."""
    if not wind_forecast or not points:
        return None

    # tau -> forecast center (from the forecast points, which carry lat/lng+tau)
    centers = {}
    for p in points:
        t = p.get("tau")
        if t is not None and p.get("lat") is not None and p.get("lng") is not None:
            centers[round(float(t))] = (p["lat"], p["lng"])

    # gather (tau, radii-dict) per threshold
    per_kt = {34: [], 50: [], 64: []}
    for entry in wind_forecast:
        t = entry.get("tau")
        if t is None:
            continue
        for r in entry.get("radii") or []:
            if r.get("kt") in per_kt:
                per_kt[r["kt"]].append((float(t), r))

    rows = []
    horizon = 0.0
    for kt in (34, 50, 64):
        seq = sorted(per_kt[kt], key=lambda tr: tr[0])
        if not seq:
            continue
        taus = [t for t, _ in seq]
        horizon = max(horizon, taus[-1])
        exposed = []
        for t, r in seq:
            c = centers.get(round(t))
            hit = False
            if c:
                ring = _wind_ring_from_radii(c[0], c[1], r)
                if ring and _pt_in_ring(home_lon, home_lat, ring):
                    hit = True
            exposed.append(hit)
        # contiguous exposed runs -> windows, midpoint-crossing boundaries
        windows = []
        n = len(taus)
        i = 0
        while i < n:
            if not exposed[i]:
                i += 1
                continue
            j = i
            while j + 1 < n and exposed[j + 1]:
                j += 1
            start = taus[i] if i == 0 else (taus[i - 1] + taus[i]) / 2.0
            end = taus[j] if j == n - 1 else (taus[j] + taus[j + 1]) / 2.0
            windows.append([round(start, 1), round(end, 1)])
            i = j + 1
        if windows:
            rows.append({"kt": kt, "dataMaxTau": round(taus[-1], 1),
                         "windows": windows})

    if not rows:
        return None
    return {"horizon": round(horizon, 1), "rows": rows}


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

    # Buffered clip for zoom/pan. The DEFAULT view still frames on `bbox`; we bake
    # a larger `viewBox` (ZOOM_BUFFER_FACTOR * the frame, about its center) at the
    # default frame's detail level so the card has sharp, already-baked coastline
    # to reveal when the user pans/zooms -- no re-fetch, no DOM rebuild. Tolerance
    # is pinned to the DEFAULT span, so default-zoom quality is unchanged; the
    # zoom budget + hard byte cap keep the bigger clip bounded. Longitude half-
    # width is NOT cos-lat corrected here (bbox is already aspect-fitted in
    # lng/lat degrees; we just scale it uniformly about center).
    def_w = bbox[2] - bbox[0]
    def_h = bbox[3] - bbox[1]
    def_span = max(def_w, def_h, 0.01)
    cx = (bbox[0] + bbox[2]) / 2.0
    cy = (bbox[1] + bbox[3]) / 2.0
    hw = def_w / 2.0 * ZOOM_BUFFER_FACTOR
    hh = def_h / 2.0 * ZOOM_BUFFER_FACTOR
    view_box = [round(cx - hw, 3), round(cy - hh, 3),
                round(cx + hw, 3), round(cy + hh, 3)]
    pad = def_span * 0.15
    geo = clip_basemap(basemap, view_box, pad,
                       ref_span=def_span,
                       budget=ZOOM_POINT_BUDGET,
                       cap_bytes=ZOOM_PAYLOAD_CAP_BYTES)

    # Region labels whose anchor falls anywhere in the BUFFERED viewBox (E6: the
    # card's zoom-aware label engine re-places labels at the current view, so
    # panning into the buffer must have anchors to reveal; the card filters to
    # the visible frame per view). Longitude is also tested +/-360 so an
    # antimeridian-wrapped window still matches anchors stored in -180..180.
    labels = [r for r in REGION_LABELS
              if view_box[1] <= r["lat"] <= view_box[3]
              and any(view_box[0] <= lng <= view_box[2]
                      for lng in (r["lng"], r["lng"] + 360, r["lng"] - 360))]

    # City dots (E3): places inside the BUFFERED viewBox (they live in the
    # geographic hu-pan group, so panning reveals them like the coastline),
    # prominence-ranked (see below), capped so a dense frame stays light. The
    # card handles label declutter; a v2 basemap yields [] and nothing draws.
    all_places = basemap.places_in(view_box)   # GeoNames -> density (popGrid)
    # NAMED city dots: the curated Natural Earth set, ranked by prominence
    # (scalerank asc, then metro pop) so the labels are the cities people expect
    # on a map -- not GeoNames' raw-population picks, which surface metro boroughs
    # and sub-city municipalities (Iztapalapa over Mexico City, Zapopan over
    # Guadalajara). Falls back to GeoNames top-by-pop on a v3 basemap with no
    # named layer, so an un-regenerated install still draws city dots.
    named = basemap.named_in(view_box)
    src = (sorted(named, key=lambda p: (p["rank"], -p["pop"]))
           if named else sorted(all_places, key=lambda p: -p["pop"]))
    places = [{"name": p["name"], "lng": round(p["lng"], 4),
               "lat": round(p["lat"], 4), "pop": p["pop"], "rank": p["rank"]}
              for p in src[:CITY_DOT_CAP]]
    # E5 population-density grid: in-view places as compact [lng,lat,pop]
    # triples (no names -- the density picture doesn't label). The card's
    # Population dot mode draws all of them and sums the population inside the
    # cone. The GeoNames basemap (v0.3.0, ~64k places >= 5k pop) can put 10k+
    # places in a metro-dense buffered frame -- too many for the websocket or
    # the DOM -- so _thin_pop_grid caps the list at POP_GRID_CAP (sparse frames
    # pass through untouched; dense frames aggregate per grid cell). Rides
    # outside the geo byte cap by design -- it's data, not coastline.
    pop_grid = _thin_pop_grid(all_places, view_box)

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

    # Current-position wind field (drives the bar's distance/at-home line -- "now"
    # semantics). Per-threshold quadrant radii ({kt, ne, se, sw, nw} in nm) -> one
    # smooth lopsided ring per threshold centered on the storm. NHC gets the radii
    # from the MapServer; GDACS reduces its current band trio to the same schema, so
    # both rebuild through the identical cosine-interpolated builder -- no faceting.
    built_current = []
    if cur_lat is not None and cur_lng is not None:
        for wr in (fdata.get("windField") or []):
            ring = _wind_ring_from_radii(cur_lat, cur_lng, wr)
            if ring:
                built_current.append({"kt": wr["kt"], "rings": [ring]})
    wind_dist_mi, wind_at_home = _wind_report(built_current, home_lat, home_lon)
    wind_dist_val = _dist_conv(wind_dist_mi)

    # Wind SWATH (drawn): one tapering band per threshold along the whole track. Two
    # ways in, one look out:
    #  - GDACS emits its OWN pre-built band polygon (tier['ring']); we just simplify it
    #    -> an exact mirror of the GDACS map.
    #  - NHC has no such polygon, so we build the corridor (tier['points']): order the
    #    forecast points, offset the max quadrant radius perpendicular from the track,
    #    close with rounded caps.
    # Falls back to the current-position blob when there's no swath. Cheap either way.
    built_swath = []
    for tier in (fdata.get("windSwath") or []):
        ring = None
        if tier.get("ring"):
            r = tier["ring"]
            ring = _dp(r, 0.04) if len(r) > 40 else r
        elif tier.get("points"):
            # NHC tiers are pre-ordered by travel time (past -> current -> forecast);
            # GDACS tiers keep the nearest-neighbour ordering.
            seq = (tier["points"] if tier.get("ordered")
                   else _order_along_track(tier["points"], cur_lng, cur_lat))
            ring = _corridor_ring(seq)
        if ring and len(ring) >= 3:
            built_swath.append({"kt": tier["kt"], "rings": [ring]})
    # Current field and full-track swath are BOTH emitted now (windField +
    # windSwath). The card picks which to draw per the `wind_swath` toggle
    # (default: current position). GDACS's swath already spans the whole track
    # (past included), so "full swath" doubles as its wind-history footprint; the
    # current trio is the singular 34/50/64 field at the storm's present center.

    cpa_mi, cpa_hours = _closest_approach(points, home_lat, home_lon, cur_lat, cur_lng)
    cpa_eye_val = _dist_conv(cpa_mi)   # center/eye basis, kept for the Phase 4 dot
    # Keep closest-approach on the SAME distance basis the bar shows as "now". With a
    # wind field the bar shows the wind-EDGE distance (nearer than the eye), so shift
    # the eye-based closest approach in by the current eye->edge gap. cpa_mi <= dist_mi
    # (Phase 1 guarantee), so the shifted value stays <= wind_dist_mi -- "closest"
    # can never read farther than "now". No wind field -> both stay eye-based.
    if wind_dist_mi is not None and dist_mi is not None and cpa_mi is not None:
        cpa_mi = max(0.0, cpa_mi - (dist_mi - wind_dist_mi))
    cpa_val = _dist_conv(cpa_mi)
    cpa_hours_r = round(cpa_hours) if cpa_hours is not None else None

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
        "cpaDist": cpa_val,
        "cpaHours": cpa_hours_r,
        "hasWind": bool(built_current),
        "windDist": wind_dist_val,
        "windAtHome": wind_at_home,
        "distUnit": dist_unit,
        "windUnit": wind_unit,
        "basin": bkey,
        "basinName": BASIN_NAME.get(bkey, ""),
        "peak": _peak(points, p0.get("cat", "TS")),
    }

    # GDACS-only: pass through GDACS's own alert tier + affected-country list as
    # meta (sensor attributes). NHC storms carry no _gdacs handle -> keys stay
    # absent, and the sensor omits them. Not drawn on the map.
    gd = storm.get("_gdacs") or {}
    if gd:
        countries = gd.get("affectedcountries") or []
        meta["alertLevel"] = gd.get("alertlevel")
        meta["alertScore"] = gd.get("alertscore")
        meta["affectedCountries"] = [c.get("countryname") for c in countries
                                     if c.get("countryname")]
        meta["affectedIso"] = [c.get("iso2") for c in countries if c.get("iso2")]

    # Phase 4: at-home exposure timeline (NHC-only; reuses the Phase 3 rings). Only
    # attached when home actually enters a forecast wind field. refTime (epoch ms,
    # UTC of tau=0) lets the card show wall-clock windows; absent -> card falls back
    # to relative hours.
    exposure = _exposure_timeline(points, fdata.get("windForecast"), home_lat, home_lon)
    if exposure:
        ref = fdata.get("refTime")
        if ref is not None:
            exposure["refTime"] = ref
        # Center's closest pass (tau + eye distance) for the timeline dot -- the eye
        # basis, NOT the wind-edge-shifted cpaDist the text bar uses.
        if cpa_hours_r is not None:
            exposure["cpa"] = {"tau": cpa_hours_r, "dist": cpa_eye_val}
        meta["exposure"] = exposure

    return {
        "ok": True,
        "stormId": storm.get("id", ""),
        "advisory": fdata.get("advisory", ""),
        "bbox": bbox,
        "viewBox": view_box,      # buffered extent baked into geo; card pan/zoom clamp
        "maxScale": ZOOM_MAX_SCALE,
        "home": [home_lon, home_lat],
        "cur": [cur_lng, cur_lat] if cur_lng is not None else None,
        "cone": cone,
        "fcstTrack": fcst,
        "pastTrack": past,
        "points": points,
        "ww": fdata.get("ww") or [],
        "windField": built_current,
        "windSwath": built_swath,
        "geo": geo,
        "labels": labels,
        "places": places,
        "popGrid": pop_grid,
        "meta": meta,
    }
