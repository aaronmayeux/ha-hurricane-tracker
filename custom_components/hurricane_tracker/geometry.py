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

    # Phase 3: current wind field (NHC-only). fdata carries per-threshold quadrant
    # radii ({kt, ne, se, sw, nw} in nm); we build a smooth lopsided ring per
    # threshold centered on the storm.
    built_wind = []
    if cur_lat is not None and cur_lng is not None:
        for wr in (fdata.get("windField") or []):
            ring = _wind_ring_from_radii(cur_lat, cur_lng, wr)
            if ring:
                built_wind.append({"kt": wr["kt"], "rings": [ring]})
    wind_dist_mi, wind_at_home = _wind_report(built_wind, home_lat, home_lon)
    wind_dist_val = _dist_conv(wind_dist_mi)

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
        "hasWind": bool(built_wind),
        "windDist": wind_dist_val,
        "windAtHome": wind_at_home,
        "distUnit": dist_unit,
        "windUnit": wind_unit,
        "basin": bkey,
        "basinName": BASIN_NAME.get(bkey, ""),
        "peak": _peak(points, p0.get("cat", "TS")),
    }

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
        "home": [home_lon, home_lat],
        "cur": [cur_lng, cur_lat] if cur_lng is not None else None,
        "cone": cone,
        "fcstTrack": fcst,
        "pastTrack": past,
        "points": points,
        "ww": fdata.get("ww") or [],
        "windField": built_wind,
        "geo": geo,
        "labels": labels,
        "meta": meta,
    }
