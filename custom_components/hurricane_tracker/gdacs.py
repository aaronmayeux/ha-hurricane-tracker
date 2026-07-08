"""GDACS adapter — global tropical cyclones outside NHC's basins.

Open EU/JRC feed (attribution-only: "Global Disaster Alert and Coordination
System, GDACS"), GeoJSON over HTTPS, stdlib ONLY. Everything here is mapped into
the SAME internal schema nhc.parse_forecast emits, so geometry.py and the card
consume it unchanged. Blocking; the coordinator runs it in an executor.

Fidelity notes (honest, MVP):
- cone: taken as-is from GDACS's computed uncertainty polygon (Poly_Cones). This
  is the hero visual and it's exact.
- track + forecast points: reconstructed from the time-labelled uncertainty
  circles (the track LineStrings are grouped by intensity, not time, so they
  can't be trusted for chronological order).
- current category/wind: derived from the event severity (km/h -> knots).
- per-forecast-point category: coarse — nearest track segment's intensity
  (TD / TS / hurricane). NHC storms keep full per-point fidelity.
- watch/warning coastal segments: GDACS doesn't provide them (ww stays empty).
"""
from __future__ import annotations

import json
import ssl
import urllib.request
from datetime import datetime, timezone

from .const import GDACS_EVENTS_URL, GDACS_GEOMETRY_TIMEOUT, HTTP_TIMEOUT, USER_AGENT
from .nhc import basin_from_latlon, bearing_deg, haversine_mi

_HEADERS = {"User-Agent": USER_AGENT}
_CTX = ssl.create_default_context()

# Saffir-Simpson-ish thresholds in knots (mirrors nhc.cat_from's intent).
_SS_KT = [(137, "5"), (113, "4"), (96, "3"), (83, "2"), (64, "1")]
# GDACS line intensity label -> our category token.
_INTENSITY_CAT = {"HU": "HU", "TS": "TS", "TD": "TD", "SD": "TD", "SS": "TS"}
_KT_PER_KMH = 1.0 / 1.852
_KT_PER_MPH = 1.0 / 1.15078

# GDACS's per-event geometry (getgeometry, the same call we make for the cone)
# carries Poly_Green/Orange/Red features: nested wind-speed bands, one polygon per
# forecast time. They map to the standard 34/50/64 kt thresholds (Green outer/
# weakest -> Red inner/strongest -- confirmed by radius: Green ~260, Orange ~140,
# Red ~90 nm on a Cat-5). This is GDACS's wind field; earlier specs wrongly assumed
# GDACS gave no wind radii. We take ONLY the slice centered on the storm's current
# position (the active-point field; the ~9 forecast-time slices are dropped) and
# reduce each band polygon to its 4 quadrant radii (max extent per NE/SE/SW/NW),
# emitting the SAME [{kt,ne,se,sw,nw}] schema nhc.py emits. geometry then rebuilds
# the blob through the identical cosine-interpolated ring builder NHC uses, so the
# result is an organic smooth wash -- NOT a trace of GDACS's faceted polygon. GDACS
# publishes only the rendered polygons (no raw quadrant numbers in its API); pulling
# the 4 radii back out is what lets us smooth it the NHC way.
_BAND_KT = {"Poly_Green": 34, "Poly_Orange": 50, "Poly_Red": 64}
_WIND_QUADRANTS = {"ne": (0.0, 90.0), "se": (90.0, 180.0),
                   "sw": (180.0, 270.0), "nw": (270.0, 360.0)}
_NM_PER_MI = 1.0 / 1.15078


# ---------------------------------------------------------------------------
# HTTP (blocking)
# ---------------------------------------------------------------------------
def _get(url, timeout=HTTP_TIMEOUT):
    req = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


# ---------------------------------------------------------------------------
# Storm list (centroid-level; geometry fetched per-storm later)
# ---------------------------------------------------------------------------
def list_storms():
    """Return active GDACS tropical cyclones as storm summaries shaped like the
    NHC activeStorms entries (id / lat / lon / name / basin + a private handle)."""
    fc = _get(GDACS_EVENTS_URL) or {}
    out = []
    for feat in fc.get("features", []):
        p = feat.get("properties", {}) or {}
        if p.get("eventtype") != "TC":
            continue
        if str(p.get("iscurrent", "")).lower() != "true":
            continue
        coords = (feat.get("geometry") or {}).get("coordinates") or [None, None]
        lon, lat = coords[0], coords[1]
        gurl = (p.get("url") or {}).get("geometry")
        if lat is None or lon is None or not gurl:
            continue
        raw_name = (p.get("eventname") or "").strip()
        name = raw_name.rsplit("-", 1)[0] if "-" in raw_name else (raw_name or "Cyclone")
        out.append({
            "id": "gdacs-%s" % p.get("eventid"),
            "basin": basin_from_latlon(lat, lon),
            "latitudeNumeric": lat,
            "longitudeNumeric": lon,
            "movementDir": None,       # filled from geometry at bake time
            "movementSpeed": None,
            "name": name,
            "classification": "",
            "_gdacs": {
                "eventid": p.get("eventid"),
                "episodeid": p.get("episodeid"),
                "geometry": gurl,
                "source": p.get("source"),
                "severity": (p.get("severitydata") or {}).get("severity"),
                "modified": p.get("datemodified"),
                # GDACS's own official alert tier (Green/Orange/Red + 0-3 score)
                # and the structured affected-country list. Carried through to the
                # summary sensor as attributes -- honest source-of-record values,
                # distinct from our derived category. NHC storms have no equivalent.
                "alertlevel": p.get("alertlevel"),
                "alertscore": p.get("alertscore"),
                "affectedcountries": p.get("affectedcountries") or [],
            },
        })
    return out


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def _ring_centroid(ring):
    n = len(ring)
    if not n:
        return None
    return [sum(c[0] for c in ring) / n, sum(c[1] for c in ring) / n]


def _is_envelope(props):
    """True for GDACS's pre-built full-swath band polygon. Its Poly_* features come
    in two flavours: per-forecast-time circles labelled with a date ('07/07 18:00')
    and ONE envelope of the whole track labelled with the threshold wind speed
    ('60 km/h' = 34 kt, '120 km/h' = 64 kt). The envelope is the exact tapering band
    GDACS renders, so we draw it directly and mirror their map."""
    return "km/h" in str(props.get("polygonlabel") or "").lower()


def _outer_ring(geom):
    """Outer ring [[lng,lat],...] of a (Multi)Polygon feature; largest ring for a
    MultiPolygon. [] if not a polygon."""
    co = geom.get("coordinates") or []
    if geom.get("type") == "Polygon" and co:
        return co[0]
    if geom.get("type") == "MultiPolygon" and co:
        return max((poly[0] for poly in co if poly), key=len, default=[])
    return []


def _quad_radii_nm(ring, clat, clon):
    """Max wind extent (nm) in each NE/SE/SW/NW quadrant of a band polygon, measured
    from the storm center -- exactly NHC's ne/se/sw/nw semantics (max radius per 90-
    deg quadrant). Feeding these to geometry._wind_ring_from_radii rebuilds the blob
    with the same cosine-interpolated organic ring NHC uses, so we smooth GDACS the
    NHC way instead of tracing its faceted polygon."""
    mx = {"ne": 0.0, "se": 0.0, "sw": 0.0, "nw": 0.0}
    for lng, lat in ring:
        b = bearing_deg(clat, clon, lat, lng) % 360.0
        d_nm = haversine_mi(clat, clon, lat, lng) * _NM_PER_MI
        for k, (lo, hi) in _WIND_QUADRANTS.items():
            if lo <= b < hi:
                if d_nm > mx[k]:
                    mx[k] = d_nm
                break
    return mx


def _wind_field_from_bands(feats, cur):
    """Current-position wind field from GDACS's Poly_Green/Orange/Red bands, as
    NHC-shaped quadrant radii.

    Each color is a wind-speed threshold (Green 34 / Orange 50 / Red 64 kt) and
    GDACS emits one polygon per forecast time. We keep ONLY the slice whose
    centroid is nearest the storm's current center -- the active-point field --
    drop the ~9 forecast-time slices, and reduce each kept band to its 4 quadrant
    radii. Returns the SAME schema nhc.parse_wind_field emits, ascending kt:
      [{"kt": 34, "ne": .., "se": .., "sw": .., "nw": ..}, ...]  (radii in nm)
    so geometry builds + smooths it through the identical NHC path. [] when there's
    no current center or no usable bands (soft-fail).
    """
    if not cur or cur[0] is None or cur[1] is None:
        return []
    clon, clat = cur[0], cur[1]
    out = []
    for cls, kt in _BAND_KT.items():
        best = None   # (centroid_dist2, ring)
        for f in feats:
            props = f.get("properties") or {}
            if str(props.get("Class")) != cls:
                continue
            if _is_envelope(props):     # skip the full-swath envelope; want a time circle
                continue
            ring = _outer_ring(f.get("geometry") or {})
            if len(ring) < 8:
                continue
            c = _ring_centroid(ring)
            if c is None:
                continue
            d2 = (c[0] - clon) ** 2 + (c[1] - clat) ** 2
            if best is None or d2 < best[0]:
                best = (d2, ring)
        if best is not None:
            r = _quad_radii_nm(best[1], clat, clon)
            if max(r.values()) > 0:
                out.append({"kt": kt, "ne": r["ne"], "se": r["se"],
                            "sw": r["sw"], "nw": r["nw"]})
    return sorted(out, key=lambda d: d["kt"])


def _wind_swath_from_bands(feats):
    """Full wind swath per threshold, as GDACS's own pre-built band polygon (the
    'km/h'-labelled envelope of the whole track). Emitted as a ready-to-draw ring so
    geometry just simplifies + colours it -- an exact mirror of the GDACS map, no
    reconstruction. Ascending kt:
      [{"kt": 34, "ring": [[lng,lat], ...]}, ...]
    A threshold with no envelope is omitted (rare; NHC uses the built corridor
    instead, so cross-source imagery still matches).
    """
    out = []
    for cls, kt in _BAND_KT.items():
        env = None
        for f in feats:
            props = f.get("properties") or {}
            if str(props.get("Class")) != cls or not _is_envelope(props):
                continue
            ring = _outer_ring(f.get("geometry") or {})
            if len(ring) >= 8:
                env = ring
                break
        if env is not None:
            out.append({"kt": kt,
                        "ring": [[round(x, 4), round(y, 4)] for x, y in env]})
    return sorted(out, key=lambda d: d["kt"])


def _cat_from_kt(kt):
    if kt is None:
        return ""
    for thr, c in _SS_KT:
        if kt >= thr:
            return c
    if kt >= 34:
        return "TS"
    return "TD"


def _type_from_kt(kt):
    if kt is None:
        return "Tropical Cyclone"
    if kt >= 64:
        return "Hurricane/Typhoon"
    if kt >= 34:
        return "Tropical Storm"
    return "Tropical Depression"


def _parse_when(label, ref_year, ref_month):
    """GDACS circle labels look like '01/07 00:00 UTC' (DD/MM HH:MM)."""
    try:
        datepart = label.split("UTC")[0].strip()
        dm, hm = datepart.split(" ")
        d, mo = (int(x) for x in dm.split("/"))
        hh, mm = (int(x) for x in hm.split(":"))
        yr = ref_year
        if ref_month >= 11 and mo <= 2:   # Dec -> Jan rollover
            yr = ref_year + 1
        return datetime(yr, mo, d, hh, mm, tzinfo=timezone.utc)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Geometry -> internal schema
# ---------------------------------------------------------------------------
def fetch_storm_geometry(storm):
    """Fetch one storm's GDACS geometry and map it into the parse_forecast
    schema. Mutates `storm` with derived movement so assemble_payload can render
    the motion line. Blocking."""
    meta = storm.get("_gdacs") or {}
    # per-event geometry is the slow endpoint -> longer timeout (see const)
    g = _get(meta.get("geometry"), timeout=GDACS_GEOMETRY_TIMEOUT) or {}
    feats = g.get("features", []) or []

    out = {
        "cone": [], "fcstTrack": [], "pastTrack": [], "points": [], "ww": [],
        "name": storm.get("name", ""), "type": "",
        "advisory": str(meta.get("episodeid") or ""),
    }

    def cls(f):
        return str((f.get("properties") or {}).get("Class") or "")

    # --- cone: Poly_Cones outer ring ---
    for f in feats:
        if cls(f) == "Poly_Cones":
            geom = f.get("geometry") or {}
            co = geom.get("coordinates") or []
            ring = []
            if geom.get("type") == "Polygon" and co:
                ring = co[0]
            elif geom.get("type") == "MultiPolygon" and co:
                ring = max((poly[0] for poly in co if poly), key=len, default=[])
            out["cone"] = [[round(x, 4), round(y, 4)] for x, y in ring]
            break

    # reference "now" for the DD/MM labels
    ref = datetime.now(timezone.utc)
    try:
        ref = datetime.fromisoformat(
            (meta.get("modified") or "").replace("Z", "")).replace(tzinfo=timezone.utc)
    except Exception:
        pass

    # --- time-ordered track from the labelled uncertainty circles ---
    circles = []
    for f in feats:
        if cls(f).startswith("Point_Polygon_Point_"):
            geom = f.get("geometry") or {}
            co = geom.get("coordinates") or []
            if geom.get("type") == "Polygon" and co:
                center = _ring_centroid(co[0])
                if center is None:
                    continue
                lab = (f.get("properties") or {}).get("polygonlabel") or ""
                circles.append((_parse_when(lab, ref.year, ref.month), center, lab))
    circles.sort(key=lambda t: (t[0] is None, t[0] or ref))

    # intensity lookup: nearest track-line vertex -> HU/TS/TD label
    segs = []
    for f in feats:
        if cls(f).startswith("Line_Line_"):
            lab = (f.get("properties") or {}).get("polygonlabel") or ""
            for v in (f.get("geometry") or {}).get("coordinates") or []:
                segs.append((v, lab))

    def intensity_at(pt):
        best, bl = None, ""
        for v, lab in segs:
            d = (v[0] - pt[0]) ** 2 + (v[1] - pt[1]) ** 2
            if best is None or d < best:
                best, bl = d, lab
        return bl

    # current position + category (from event severity, km/h -> knots)
    cur = [storm.get("longitudeNumeric"), storm.get("latitudeNumeric")]
    sev = meta.get("severity")
    cur_kt = float(sev) * _KT_PER_KMH if sev else None
    cur_cat = _cat_from_kt(cur_kt)
    out["type"] = _type_from_kt(cur_kt)

    # split past vs forecast at the circle nearest the current centroid
    pivot = 0
    if circles and cur[0] is not None:
        pivot = min(range(len(circles)),
                    key=lambda i: (circles[i][1][0] - cur[0]) ** 2
                    + (circles[i][1][1] - cur[1]) ** 2)

    past = [c[1] for c in circles[:pivot + 1]]
    fcst = [c[1] for c in circles[pivot:]]
    out["pastTrack"] = [[round(x, 4), round(y, 4)] for x, y in past]
    out["fcstTrack"] = [[round(x, 4), round(y, 4)] for x, y in fcst]

    pts = []
    for i in range(pivot, len(circles)):
        _when, center, lab = circles[i]
        if i == pivot and cur_cat:
            cat, wind = cur_cat, (round(cur_kt) if cur_kt else None)
        else:
            cat, wind = _INTENSITY_CAT.get(intensity_at(center), ""), None
        pts.append({
            "lng": round(center[0], 4), "lat": round(center[1], 4),
            "label": lab, "type": "", "cat": cat,
            "wind": wind, "gust": None, "mslp": None,
            "dir": None, "spd": None, "tau": None,
        })
    out["points"] = pts

    # movement: heading along the forecast track, speed from consecutive timed circles
    if len(fcst) >= 2:
        (x1, y1), (x2, y2) = fcst[0], fcst[1]
        storm["movementDir"] = bearing_deg(y1, x1, y2, x2)
    storm["movementSpeed"] = _speed_kt(circles, pivot)

    # Wind field from the Poly_Green/Orange/Red bands in this same response (the wind
    # field earlier specs assumed GDACS didn't provide), reduced to NHC-shaped
    # quadrant radii so geometry rebuilds + smooths it through the identical NHC path.
    #  - windField: the current-position trio -> drives the bar's distance/at-home.
    #  - windSwath: every forecast slice -> the drawn wind corridor along the track.
    # Soft-fail to [] -> no wash, no regression.
    try:
        out["windField"] = _wind_field_from_bands(feats, cur)
        out["windSwath"] = _wind_swath_from_bands(feats)
    except Exception:
        out["windField"] = []
        out["windSwath"] = []

    return out


def _speed_kt(circles, pivot):
    """Forward speed in knots from the first pair of timed circles at/after pivot."""
    try:
        for j in range(pivot, len(circles) - 1):
            t1, c1, _ = circles[j]
            t2, c2, _ = circles[j + 1]
            if t1 and t2 and t2 > t1:
                hrs = (t2 - t1).total_seconds() / 3600.0
                if hrs > 0:
                    mi = haversine_mi(c1[1], c1[0], c2[1], c2[0])
                    return round((mi / hrs) * _KT_PER_MPH)
    except Exception:
        pass
    return None
