"""Geometry: basemap reader, storm-framed bbox, clip, and payload assembly.

Stdlib ONLY. The basemap is the compact packed file shipped with the
integration (see tools/pack_basemap.py). This module reads it, clips it to a
box around the storm, frames the view on the storm, converts units, and
assembles the final draw-ready payload the card consumes.
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


# ---------------------------------------------------------------------------
# Basemap (packed binary) reader — matches tools/pack_basemap.py output
# ---------------------------------------------------------------------------
_basemap_cache = None


def load_basemap(path=_BASEMAP_PATH):
    """Read the packed basemap into {'coast':[...], 'states':[...], 'land':[...]}
    where each layer is a list of parts, each part a list of [lng, lat]."""
    global _basemap_cache
    if _basemap_cache is not None:
        return _basemap_cache
    with open(path, "rb") as f:
        buf = f.read()
    if buf[:4] != b"HURB":
        raise ValueError("bad basemap magic")
    q = struct.unpack_from("<I", buf, 4)[0]
    nlayers = struct.unpack_from("<I", buf, 8)[0]
    p = 12
    dirs = []
    for _ in range(nlayers):
        off, ln = struct.unpack_from("<II", buf, p)
        p += 8
        dirs.append((off, ln))
    out = {}
    for name, (off, _ln) in zip(_LAYER_NAMES, dirs):
        parts = []
        pp = off
        nparts = struct.unpack_from("<I", buf, pp)[0]
        pp += 4
        for _ in range(nparts):
            npts = struct.unpack_from("<I", buf, pp)[0]
            pp += 4
            coords = []
            for _ in range(npts):
                xi, yi = struct.unpack_from("<ii", buf, pp)
                pp += 8
                coords.append([xi / q, yi / q])
            parts.append(coords)
        out[name] = parts
    _basemap_cache = out
    return out


# ---------------------------------------------------------------------------
# Clipping helpers
# ---------------------------------------------------------------------------
def _seg_in_box(coords, box, pad):
    min_lng, min_lat, max_lng, max_lat = box
    for x, y in coords:
        if (min_lng - pad) <= x <= (max_lng + pad) and (min_lat - pad) <= y <= (max_lat + pad):
            return True
    return False


def _decimate(coords, step):
    if step <= 1 or len(coords) <= 2:
        return coords
    out = coords[::step]
    if out[-1] != coords[-1]:
        out.append(coords[-1])
    return out


def clip_basemap(basemap, bbox, pad):
    span = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
    if span <= 6:
        step = 1
    elif span <= 12:
        step = 2
    elif span <= 22:
        step = 3
    else:
        step = 5

    def clip(layer, min_pts):
        out = []
        for part in basemap.get(layer, []):
            if len(part) < min_pts:
                continue
            if _seg_in_box(part, bbox, pad):
                out.append([[round(x, 4), round(y, 4)] for x, y in _decimate(part, step)])
        return out

    return {
        "coast": clip("coast", 2),
        "states": clip("states", 2),
        "land": clip("land", 3),
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

    # E/W and N/S components for the off-screen home edge marker on the card.
    # E/W measured along home's parallel, N/S along home's meridian. dateline-safe.
    ew_mi = ns_mi = None
    ew_dir = ns_dir = None
    if (cur_lat is not None and cur_lng is not None
            and home_lat is not None and home_lon is not None):
        dlon = ((cur_lng - home_lon + 180.0) % 360.0) - 180.0
        ew_mi = haversine_mi(home_lat, home_lon, home_lat, home_lon + dlon)
        ew_dir = "E" if dlon >= 0 else "W"
        ns_mi = haversine_mi(home_lat, home_lon, cur_lat, home_lon)
        ns_dir = "N" if cur_lat >= home_lat else "S"

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
    ew_val = _dist_conv(ew_mi)
    ns_val = _dist_conv(ns_mi)

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
        "ew": ew_val,
        "ewDir": ew_dir,
        "ns": ns_val,
        "nsDir": ns_dir,
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
