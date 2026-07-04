"""NHC data: fetch, hand-rolled shapefile/dbf parsing, storm selection.

Stdlib ONLY (no pip requirements). NHC publishes forecast/best-track GIS as
zipped ESRI shapefiles, so the shapefile reader lives here and stays. Everything
is synchronous and blocking; the coordinator runs it in an executor so it never
touches Home Assistant's event loop.

De-Walled from the original dashboard baker: no hardcoded home coordinates, no
file writing, no health-status side effects. Home location and all selection
options are passed in.
"""
from __future__ import annotations

import io
import json
import math
import struct
import urllib.parse
import urllib.request
import zipfile

from .const import (
    BASIN_ATLANTIC,
    BASIN_AUTO,
    BASIN_AUSTRALIAN,
    BASIN_CENTRAL_PACIFIC,
    BASIN_EAST_PACIFIC,
    BASIN_GLOBAL,
    BASIN_NORTH_INDIAN,
    BASIN_NW_PACIFIC,
    BASIN_PREFIX,
    BASIN_RANGE,
    BASIN_SOUTH_PACIFIC,
    BASIN_SW_INDIAN,
    CURRENT_STORMS_URL,
    FILTER_ALL,
    HTTP_TIMEOUT,
    PAST_MILES,
    USER_AGENT,
    WIND_ADVISORY_OFFSET,
    WIND_FORECAST_OFFSET,
    WIND_RADII_URL,
    WIND_SLOT_BLOCK,
    WIND_SLOT_STEP,
)

_HEADERS = {"User-Agent": USER_AGENT}


# ---------------------------------------------------------------------------
# HTTP (blocking; called inside an executor)
# ---------------------------------------------------------------------------
def http_get(url: str, binary: bool = False):
    req = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# Shapefile / dbf primitives (hand-rolled, stdlib)
# ---------------------------------------------------------------------------
def _read_dbf(b):
    nrec = struct.unpack("<I", b[4:8])[0]
    hdr = struct.unpack("<H", b[8:10])[0]
    rlen = struct.unpack("<H", b[10:12])[0]
    fields, p = [], 32
    while p < len(b) and b[p] != 0x0D:
        name = b[p:p + 11].split(b"\x00")[0].decode("latin1")
        flen = b[p + 16]
        fields.append((name, flen))
        p += 32
    rows = []
    for i in range(nrec):
        off = hdr + 1 + i * rlen
        if off + rlen - 1 > len(b):
            break
        rec, fp = {}, off
        for (nm, fl) in fields:
            rec[nm] = b[fp:fp + fl].decode("latin1").strip()
            fp += fl
        rows.append(rec)
    return [f[0] for f in fields], rows


def _shp_records(b):
    n = len(b)
    p = 100
    while p + 8 <= n:
        clen = struct.unpack(">I", b[p + 4:p + 8])[0]
        start = p + 8
        end = start + clen * 2
        if end > n:
            break
        rec = b[start:end]
        if len(rec) >= 4:
            yield struct.unpack("<i", rec[0:4])[0], rec
        p = end


def _parts_points(rec):
    num_parts = struct.unpack("<i", rec[36:40])[0]
    num_points = struct.unpack("<i", rec[40:44])[0]
    pp = 44
    part_idx = list(struct.unpack("<%di" % num_parts, rec[pp:pp + 4 * num_parts]))
    pp += 4 * num_parts
    pts = struct.unpack("<%dd" % (2 * num_points), rec[pp:pp + 16 * num_points])
    coords = [[pts[2 * i], pts[2 * i + 1]] for i in range(num_points)]
    parts, bounds = [], part_idx + [num_points]
    for k in range(num_parts):
        parts.append(coords[bounds[k]:bounds[k + 1]])
    return parts


def _point_xy(rec):
    x, y = struct.unpack("<dd", rec[4:20])
    return [x, y]


# ---------------------------------------------------------------------------
# Geo maths
# ---------------------------------------------------------------------------
def haversine_mi(lat1, lon1, lat2, lon2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    """Initial bearing from point 1 to point 2, degrees clockwise from north."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _ang_diff(a, b):
    d = abs((a - b) % 360)
    return min(d, 360 - d)


# ---------------------------------------------------------------------------
# Basin helpers
# ---------------------------------------------------------------------------
def basin_of(storm_id):
    return BASIN_PREFIX.get((storm_id or "")[:2].lower())


def basin_from_latlon(lat, lon):
    """Bucket any position into a tropical-cyclone basin key. Used for the home
    location and for GDACS storms (which don't carry an NHC id prefix). Coarse
    by design — NHC storms are typed precisely from their id, not this."""
    if lat is None or lon is None:
        return None
    if lon > 180:
        lon -= 360
    if lon < -180:
        lon += 360
    if lat >= 0:
        if -180 <= lon < -140:
            return BASIN_CENTRAL_PACIFIC
        if -140 <= lon < -100:
            return BASIN_EAST_PACIFIC
        if -100 <= lon < 20:
            return BASIN_ATLANTIC
        if 20 <= lon < 100:
            return BASIN_NORTH_INDIAN
        if 100 <= lon <= 180:
            return BASIN_NW_PACIFIC
    else:
        if 20 <= lon < 90:
            return BASIN_SW_INDIAN
        if 90 <= lon < 160:
            return BASIN_AUSTRALIAN
        if lon >= 160 or lon < -70:
            return BASIN_SOUTH_PACIFIC
    return None


def storm_basin(s):
    """Basin for a storm dict: GDACS storms carry a precomputed 'basin'; NHC
    storms derive it from their id prefix."""
    return s.get("basin") or basin_of(s.get("id"))


# ---------------------------------------------------------------------------
# Storm selection
# ---------------------------------------------------------------------------
def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _storm_pos(s):
    return _num(s.get("latitudeNumeric")), _num(s.get("longitudeNumeric"))


def _is_approaching(s, home_lat, home_lon):
    """True when the storm's heading points within 90 deg of the bearing to home
    (i.e. its motion is reducing distance to home). Works at any location."""
    lat, lon = _storm_pos(s)
    md = _num(s.get("movementDir"))
    if lat is None or lon is None or md is None:
        return False
    to_home = bearing_deg(lat, lon, home_lat, home_lon)
    return _ang_diff(md, to_home) < 90


def _dist_to_home(s, home_lat, home_lon):
    lat, lon = _storm_pos(s)
    if lat is None or lon is None:
        return float("inf")
    return haversine_mi(home_lat, home_lon, lat, lon)


def _threat_key(s, home_lat, home_lon):
    """Sort key: approaching storms first, then nearer storms first."""
    return (0 if _is_approaching(s, home_lat, home_lon) else 1,
            _dist_to_home(s, home_lat, home_lon))


def select_storms(storms, home_lat, home_lon, basin_cfg, filter_cfg, range_mi=None):
    """Return an ordered list of storms to display.

    Scope (basin_cfg):
      - global           -> every active storm, anywhere.
      - range            -> storms within range_mi of home.
      - auto (my region) -> home basin only (quiet basin => nothing).
      - explicit basin   -> that basin only.
    filter_cfg:
      - all              -> whole eligible set, ordered for cycling.
      - threat           -> a single storm (approaching, else closest).
    """
    storms = [s for s in (storms or []) if s.get("id")]
    if not storms:
        return []

    if basin_cfg == BASIN_GLOBAL:
        eligible = storms
    elif basin_cfg == BASIN_RANGE:
        cap = range_mi if range_mi else float("inf")
        eligible = [s for s in storms
                    if _dist_to_home(s, home_lat, home_lon) <= cap]
    elif basin_cfg == BASIN_AUTO:
        home_basin = basin_from_latlon(home_lat, home_lon)
        eligible = ([s for s in storms if storm_basin(s) == home_basin]
                    if home_basin else [])
    else:
        eligible = [s for s in storms if storm_basin(s) == basin_cfg]

    if not eligible:
        return []

    ordered = sorted(eligible, key=lambda s: _threat_key(s, home_lat, home_lon))
    if filter_cfg == FILTER_ALL:
        return ordered
    return [ordered[0]]


# ---------------------------------------------------------------------------
# Category derivation
# ---------------------------------------------------------------------------
_SS_FROM_WIND = [(137, 5), (113, 4), (96, 3), (83, 2), (64, 1)]


def cat_from(stormtype, ssnum, wind):
    """Saffir-Simpson-ish category token: 'TD','TS','1'..'5'."""
    st = (stormtype or "").upper()
    try:
        ss = int(float(ssnum)) if ssnum not in (None, "") else 0
    except (TypeError, ValueError):
        ss = 0
    if ss >= 1:
        return str(min(ss, 5))
    try:
        w = float(wind)
    except (TypeError, ValueError):
        w = 0
    if st == "HU" or w >= 64:
        for thr, c in _SS_FROM_WIND:
            if w >= thr:
                return str(c)
        return "1"
    if st == "TS" or w >= 34:
        return "TS"
    if st == "TD" or w > 0:
        return "TD"
    if st in ("STD", "SD"):
        return "TD"
    if st in ("STS", "SS"):
        return "TS"
    return st or "TS"


def _round(v, n=1):
    try:
        return round(float(v), n)
    except (TypeError, ValueError):
        return None


def compass(deg):
    if deg is None:
        return ""
    dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    try:
        return dirs[int((float(deg) % 360) / 22.5 + 0.5) % 16]
    except (TypeError, ValueError):
        return ""


# ---------------------------------------------------------------------------
# GIS zip parsing
# ---------------------------------------------------------------------------
def _adv_zip_url(s):
    return (s.get("trackCone") or {}).get("zipFile")


def _besttrack_zip_url(s):
    return (s.get("bestTrackGIS") or {}).get("zipFile")


def parse_forecast(zb):
    """Parse the forecast-cone GIS zip: cone polygon, forecast line, forecast
    points (with per-point intensity), and watch/warning coastal segments."""
    z = zipfile.ZipFile(io.BytesIO(zb))
    names = z.namelist()

    def base(suffix):
        for n in names:
            if n.endswith(suffix):
                return n[:-4]
        return None

    out = {"cone": [], "fcstTrack": [], "points": [], "ww": [],
           "name": "", "type": "", "advisory": ""}

    pgn = base("_5day_pgn.shp") or base("_pgn.shp")
    if pgn:
        best = []
        for stype, rec in _shp_records(z.read(pgn + ".shp")):
            if stype == 5:
                for part in _parts_points(rec):
                    if len(part) > len(best):
                        best = part
        out["cone"] = [[round(x, 4), round(y, 4)] for x, y in best]

    lin = base("_5day_lin.shp") or base("_lin.shp")
    if lin:
        line = []
        for stype, rec in _shp_records(z.read(lin + ".shp")):
            if stype == 3:
                for part in _parts_points(rec):
                    line.extend(part)
        out["fcstTrack"] = [[round(x, 4), round(y, 4)] for x, y in line]

    pts = base("_5day_pts.shp") or base("_pts.shp")
    if pts:
        geo = [_point_xy(rec) for st, rec in _shp_records(z.read(pts + ".shp")) if st == 1]
        _cols, rows = _read_dbf(z.read(pts + ".dbf"))
        for i, xy in enumerate(geo):
            r = rows[i] if i < len(rows) else {}
            cat = cat_from(r.get("STORMTYPE"), r.get("SSNUM"), r.get("MAXWIND"))
            out["points"].append({
                "lng": round(xy[0], 4), "lat": round(xy[1], 4),
                "label": (r.get("DATELBL") or "").strip(),
                "type": (r.get("DVLBL") or r.get("STORMTYPE") or "").strip(),
                "cat": cat,
                "wind": _round(r.get("MAXWIND")), "gust": _round(r.get("GUST")),
                "mslp": _round(r.get("MSLP")),
                "dir": _round(r.get("TCDIR")), "spd": _round(r.get("TCSPD")),
                "tau": _round(r.get("TAU")),
            })
            if i == 0:
                out["name"] = (r.get("STORMNAME") or "").strip()
                out["type"] = (r.get("TCDVLP") or r.get("STORMTYPE") or "").strip()
                out["advisory"] = (r.get("ADVISNUM") or "").strip()

    ww = base("_ww_wwlin.shp")
    if ww:
        _cols, rows = _read_dbf(z.read(ww + ".dbf"))
        i = 0
        for stype, rec in _shp_records(z.read(ww + ".shp")):
            if stype == 3:
                tcww = (rows[i].get("TCWW") if i < len(rows) else "") or ""
                for part in _parts_points(rec):
                    out["ww"].append({
                        "type": tcww.strip(),
                        "coords": [[round(x, 4), round(y, 4)] for x, y in part],
                    })
                i += 1
    return out


def parse_besttrack(zb, cutoff_miles=PAST_MILES):
    """Parse the best-track GIS zip and trim to the trailing `cutoff_miles` of
    travel behind the storm (constant physical trail length regardless of speed)."""
    z = zipfile.ZipFile(io.BytesIO(zb))
    names = z.namelist()

    def base(suffix):
        for n in names:
            if n.endswith(suffix):
                return n[:-4]
        return None

    track = []
    linb = base("_lin.shp")
    if linb:
        for stype, rec in _shp_records(z.read(linb + ".shp")):
            if stype == 3:
                for part in _parts_points(rec):
                    track.extend(part)

    if len(track) >= 2:
        kept = [track[-1]]
        acc = 0.0
        for i in range(len(track) - 1, 0, -1):
            a = track[i]
            b = track[i - 1]
            acc += haversine_mi(a[1], a[0], b[1], b[0])
            kept.append(b)
            if acc >= cutoff_miles:
                break
        kept.reverse()
        track = kept
    return [[round(x, 4), round(y, 4)] for x, y in track]


# ---------------------------------------------------------------------------
# Forecast wind radii (Phase 3, NHC-only) -- CURRENT-position 34/50/64 kt field
# ---------------------------------------------------------------------------
# Pulled from the tropical MapServer's per-slot "Advisory Wind Field" layer, using
# the per-quadrant radii fields (ne/se/sw/nw, nautical mi) -- NOT the polygon
# geometry, so geometry.py can build a smooth organic ring instead of the raw
# quadrant shape. Internal schema handed to geometry:
#   [{"kt": 34, "ne": .., "se": .., "sw": .., "nw": ..}, ...]
# UNVERIFIED live (no active NHC storm at build): everything soft-fails to [] so
# a missing/blank field just falls back to center distance. Do NOT release until
# proven against a real active storm.
def _wind_layer_id(storm, offset=WIND_ADVISORY_OFFSET):
    """MapServer layer id for a storm's wind-radii layer, from its bin. `offset`
    picks which sibling layer: WIND_ADVISORY_OFFSET (current, Phase 3) or
    WIND_FORECAST_OFFSET (per-tau forecast, Phase 4). e.g. AT1 -> 17 / 16.
    None if the bin is missing/unrecognized."""
    bn = (storm.get("binNumber") or "").upper().strip()
    if len(bn) < 3:
        return None
    grp, num = bn[:2], bn[2:]
    base = WIND_SLOT_BLOCK.get(grp)
    try:
        slot = int(num)
    except ValueError:
        return None
    if base is None or not (1 <= slot <= 5):
        return None
    return base + (slot - 1) * WIND_SLOT_STEP + offset


def parse_wind_field(data):
    """ArcGIS query JSON -> internal wind-field schema: one dict per threshold
      [{"kt": 34, "ne": .., "se": .., "sw": .., "nw": ..}, ...]  (radii in nm)
    ascending kt, first feature per threshold wins. geometry.py turns each into a
    smooth ring. Missing/negative radii clamp to 0."""
    feats = (data or {}).get("features") or []
    out, seen = [], set()
    for ft in feats:
        a = ft.get("attributes") or ft.get("properties") or {}

        def g(key):
            v = _num(a.get(key))
            if v is None:
                v = _num(a.get(key.upper()))
            return v if (v and v > 0) else 0.0

        kt = _num(a.get("radii"))
        if kt is None:
            kt = _num(a.get("RADII"))
        if kt is None:
            continue
        kt = int(round(kt))
        if kt not in (34, 50, 64) or kt in seen:
            continue
        seen.add(kt)
        out.append({"kt": kt, "ne": g("ne"), "se": g("se"),
                    "sw": g("sw"), "nw": g("nw")})
    return sorted(out, key=lambda d: d["kt"])


def fetch_wind_field(storm):
    """Fetch + parse the current wind-radii field for one NHC storm. Blocking;
    soft-fails to []."""
    lid = _wind_layer_id(storm)
    if lid is None:
        return []
    sid = (storm.get("id") or "").upper()
    where = "stormid='%s'" % sid if sid else "1=1"
    url = ("%s/%d/query?where=%s&outFields=radii,ne,se,sw,nw"
           "&returnGeometry=false&f=json"
           % (WIND_RADII_URL, lid, urllib.parse.quote(where)))
    try:
        return parse_wind_field(json.loads(http_get(url)))
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Forecast wind radii per tau (Phase 4, NHC-only) -- the at-home exposure timeline
# ---------------------------------------------------------------------------
# Same MapServer, the sibling "Forecast Wind Radii" layer (WIND_FORECAST_OFFSET),
# which carries a `tau` field so we get the 34/50/64 kt radii at every forecast
# time. Internal schema handed to geometry:
#   [{"tau": 12.0, "radii": [{"kt": 34, "ne": .., "se": .., "sw": .., "nw": ..}, ...]}, ...]
# Same UNVERIFIED-live / soft-fail rule as Phase 3: do NOT release until proven on
# a real active storm.
def parse_wind_forecast(data):
    """ArcGIS query JSON -> per-tau forecast radii, ascending tau (ascending kt
    within each tau):
      [{"tau": T, "radii": [{"kt":34,"ne":..,"se":..,"sw":..,"nw":..}, ...]}, ...]
    First feature per (tau, kt) wins; missing/negative radii clamp to 0; a tau (or
    threshold) with no positive radii is dropped."""
    feats = (data or {}).get("features") or []
    bytau = {}
    for ft in feats:
        a = ft.get("attributes") or ft.get("properties") or {}

        def g(key):
            v = _num(a.get(key))
            if v is None:
                v = _num(a.get(key.upper()))
            return v if (v and v > 0) else 0.0

        tau = _num(a.get("tau"))
        if tau is None:
            tau = _num(a.get("TAU"))
        kt = _num(a.get("radii"))
        if kt is None:
            kt = _num(a.get("RADII"))
        if tau is None or kt is None:
            continue
        kt = int(round(kt))
        if kt not in (34, 50, 64):
            continue
        slot = bytau.setdefault(float(tau), {})
        if kt in slot:
            continue
        ne, se, sw, nw = g("ne"), g("se"), g("sw"), g("nw")
        if max(ne, se, sw, nw) <= 0:
            continue
        slot[kt] = {"kt": kt, "ne": ne, "se": se, "sw": sw, "nw": nw}
    out = []
    for tau in sorted(bytau):
        radii = [bytau[tau][kt] for kt in (34, 50, 64) if kt in bytau[tau]]
        if radii:
            out.append({"tau": tau, "radii": radii})
    return out


def fetch_wind_forecast(storm):
    """Fetch + parse the per-tau forecast wind-radii field for one NHC storm.
    Blocking; soft-fails to []."""
    lid = _wind_layer_id(storm, WIND_FORECAST_OFFSET)
    if lid is None:
        return []
    sid = (storm.get("id") or "").upper()
    where = "stormid='%s'" % sid if sid else "1=1"
    url = ("%s/%d/query?where=%s&outFields=radii,tau,ne,se,sw,nw"
           "&returnGeometry=false&f=json"
           % (WIND_RADII_URL, lid, urllib.parse.quote(where)))
    try:
        return parse_wind_forecast(json.loads(http_get(url)))
    except Exception:
        return []


def fetch_storm_geometry(storm):
    """Fetch + parse one storm's forecast (and best-track) GIS. Blocking."""
    fz = _adv_zip_url(storm)
    if not fz:
        return None
    fdata = parse_forecast(http_get(fz, binary=True))
    past = []
    bz = _besttrack_zip_url(storm)
    if bz:
        try:
            past = parse_besttrack(http_get(bz, binary=True))
        except Exception:  # best-track is optional; soft-fail
            past = []
    fdata["pastTrack"] = past
    # Current-position wind radii (NHC-only; soft-fails to []). UNVERIFIED live.
    try:
        fdata["windField"] = fetch_wind_field(storm)
    except Exception:
        fdata["windField"] = []
    # Per-tau forecast wind radii for the at-home exposure timeline (Phase 4,
    # NHC-only; soft-fails to []). UNVERIFIED live.
    try:
        fdata["windForecast"] = fetch_wind_forecast(storm)
    except Exception:
        fdata["windForecast"] = []
    return fdata
