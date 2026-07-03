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

from .const import GDACS_EVENTS_URL, HTTP_TIMEOUT, USER_AGENT
from .nhc import basin_from_latlon, bearing_deg, haversine_mi

_HEADERS = {"User-Agent": USER_AGENT}
_CTX = ssl.create_default_context()

# Saffir-Simpson-ish thresholds in knots (mirrors nhc.cat_from's intent).
_SS_KT = [(137, "5"), (113, "4"), (96, "3"), (83, "2"), (64, "1")]
# GDACS line intensity label -> our category token.
_INTENSITY_CAT = {"HU": "1", "TS": "TS", "TD": "TD", "SD": "TD", "SS": "TS"}
_KT_PER_KMH = 1.0 / 1.852
_KT_PER_MPH = 1.0 / 1.15078


# ---------------------------------------------------------------------------
# HTTP (blocking)
# ---------------------------------------------------------------------------
def _get(url):
    req = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT, context=_CTX) as r:
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
    g = _get(meta.get("geometry")) or {}
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
