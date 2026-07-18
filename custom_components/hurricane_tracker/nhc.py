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
    ADECK_URL,
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
    MODEL_TRACK_MAX_PTS,
    MODEL_TRACK_MAX_TAU,
    MODEL_TRACK_STALE_H,
    MODEL_TRACK_TECHS,
    PAST_MILES,
    SURGE_ENVELOPE_DEG,
    SURGE_OFFSET_DEG,
    SURGE_POLY_LAYER,
    SURGE_URL,
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
    # Layers 250/251 store stormid LOWERCASE ('ep052026') while the past-radii
    # layer stores it UPPERCASE; the service '=' is case-sensitive, so match with
    # UPPER() to work regardless of how NOAA cased this layer. (Bug: uppercase
    # literal returned 0 features on live Elida -> empty wind field/swath.)
    where = "UPPER(stormid)='%s'" % sid if sid else "1=1"
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
    # Case-insensitive: this layer stores stormid lowercase (see fetch_wind_field).
    where = "UPPER(stormid)='%s'" % sid if sid else "1=1"
    url = ("%s/%d/query?where=%s&outFields=radii,tau,ne,se,sw,nw"
           "&returnGeometry=false&f=json"
           % (WIND_RADII_URL, lid, urllib.parse.quote(where)))
    try:
        return parse_wind_forecast(json.loads(http_get(url)))
    except Exception:
        return []


def build_wind_swath(fdata, storm):
    """Assemble the wind swath as ordered per-threshold CENTER points, each carrying
    that time's quadrant radii, so geometry sweeps ONE smooth corridor spanning
    past + forecast (the GDACS whole-track look):
      [{"kt": 34, "ordered": True, "points": [{"lat","lng","ne","se","sw","nw"}, ...]}, ...]
    Order is strictly along travel: past advisories (oldest->newest, from the
    best-track radii+centers in fdata['pastWind']), then the current position, then
    the forecast taus. Points are PRE-ORDERED here (NHC times are reliable), so
    geometry skips its nearest-neighbour reordering for these tiers -- the past is
    swept by the SAME corridor builder as the forecast, not drawn as raw polygons.
    [] when there's no wind data (NHC-only; soft-fails with the rest of the pipeline).
    """
    wf = fdata.get("windField") or []
    wfc = fdata.get("windForecast") or []
    pts = fdata.get("points") or []
    past_wind = fdata.get("pastWind") or {}
    cur_lat = _num(storm.get("latitudeNumeric"))
    cur_lng = _num(storm.get("longitudeNumeric"))
    centers = {}
    for p in pts:
        t = p.get("tau")
        if t is not None and p.get("lat") is not None and p.get("lng") is not None:
            centers[round(float(t))] = (p["lat"], p["lng"])

    fwd = {34: [], 50: [], 64: []}   # forecast side (current tau0 + forecast taus)

    def _pt(lat, lng, r, tau):
        return {"lat": round(lat, 4), "lng": round(lng, 4),
                "ne": r.get("ne", 0), "se": r.get("se", 0),
                "sw": r.get("sw", 0), "nw": r.get("nw", 0), "_tau": tau}

    if cur_lat is not None and cur_lng is not None:
        for r in wf:
            if r.get("kt") in fwd:
                fwd[r["kt"]].append(_pt(cur_lat, cur_lng, r, 0.0))
    for entry in wfc:
        t = entry.get("tau")
        if t is None:
            continue
        c = centers.get(round(float(t)))
        if not c:
            continue
        for r in entry.get("radii") or []:
            if r.get("kt") in fwd:
                fwd[r["kt"]].append(_pt(c[0], c[1], r, float(t)))

    out = []
    for kt in (34, 50, 64):
        past = list(past_wind.get(kt) or [])          # already oldest->newest
        fset = sorted(fwd[kt], key=lambda p: p["_tau"])
        # Drop any past point that coincides with the current position so the
        # past/forecast seam has no zero-length segment (~0.05 deg guard).
        if past and fset:
            c0 = fset[0]
            past = [p for p in past
                    if (p["lng"] - c0["lng"]) ** 2 + (p["lat"] - c0["lat"]) ** 2 > 2.5e-3]
        seq = past + [{k: v for k, v in p.items() if k != "_tau"} for p in fset]
        if seq:
            out.append({"kt": kt, "ordered": True, "points": seq})
    return out


def parse_besttrack_wind_points(zb):
    """From the best-track GIS zip: past wind-radii CENTER points per threshold, so
    the past half of the wind swath is swept by the same smooth corridor builder as
    the forecast (matching smoothing, no raw-polygon scallops). Centers come from
    the _pts layer (LAT/LON keyed by synoptic time); the quadrant radii come from
    the _radii layer (NE/SE/SW/NW per SYNOPTIME + threshold); the two are paired on
    the 10-digit synoptic time (YYYYMMDDHH). Returns
      {34: [{"lat","lng","ne","se","sw","nw"}, ...], 50: [...], 64: [...]}
    time-ordered oldest->newest; soft-fails to {}.
    """
    z = zipfile.ZipFile(io.BytesIO(zb))
    names = z.namelist()

    def find(suffix):
        return next((n for n in names if n.endswith(suffix)), None)

    pd, rd = find("_pts.dbf"), find("_radii.dbf")
    if not (pd and rd):
        return {}
    # centers: synoptic time (YYYYMMDDHH) -> (lat, lng)
    _, prows = _read_dbf(z.read(pd))
    centers = {}
    for r in prows:
        dtg = (r.get("DTG") or "").split(".")[0].strip()[:10]
        lat, lng = _num(r.get("LAT")), _num(r.get("LON"))
        if len(dtg) == 10 and lat is not None and lng is not None:
            centers[dtg] = (lat, lng)
    # radii: pair each (synoptic time, threshold) to its center; dedup by time
    _, rrows = _read_dbf(z.read(rd))
    bykt = {34: {}, 50: {}, 64: {}}
    for r in rrows:
        kt = _num(r.get("RADII"))
        if kt is None:
            continue
        kt = int(round(kt))
        if kt not in bykt:
            continue
        st = (r.get("SYNOPTIME") or "").split(".")[0].strip()[:10]
        c = centers.get(st)
        if not c:
            continue
        bykt[kt][st] = {"lat": round(c[0], 4), "lng": round(c[1], 4),
                        "ne": _num(r.get("NE")) or 0, "se": _num(r.get("SE")) or 0,
                        "sw": _num(r.get("SW")) or 0, "nw": _num(r.get("NW")) or 0}
    out = {}
    for kt, d in bykt.items():
        if d:
            out[kt] = [d[t] for t in sorted(d)]   # YYYYMMDDHH sorts chronologically
    return out


def fetch_storm_geometry(storm):
    """Fetch + parse one storm's forecast (and best-track) GIS. Blocking."""
    fz = _adv_zip_url(storm)
    if not fz:
        return None
    fdata = parse_forecast(http_get(fz, binary=True))
    past = []
    past_wind = {}
    bz = _besttrack_zip_url(storm)
    if bz:
        zb = None
        try:
            zb = http_get(bz, binary=True)
            past = parse_besttrack(zb)
        except Exception:  # best-track is optional; soft-fail
            past = []
        if zb is not None:
            try:
                # Past wind-radii centers -> the past half of the wind swath.
                past_wind = parse_besttrack_wind_points(zb)
            except Exception:
                past_wind = {}
    fdata["pastTrack"] = past
    fdata["pastWind"] = past_wind
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
    # Wind swath: ONE smooth corridor per threshold spanning past + forecast
    # (build_wind_swath prepends the past centers from fdata["pastWind"]). Same
    # normalized schema GDACS emits. Soft-fails to [].
    try:
        fdata["windSwath"] = build_wind_swath(fdata, storm)
    except Exception:
        fdata["windSwath"] = []
    return fdata


# ---------------------------------------------------------------------------
# Forecast model tracks (E4 layer; on-demand only, never in the bake)
# ---------------------------------------------------------------------------
# ATCF a-deck for the storm: gzipped comma-separated rows, one per
# (cycle, tech, tau[, wind-radii threshold]). Columns used (0-based): 2 = DTG
# (YYYYMMDDHH cycle), 4 = tech, 5 = tau, 6/7 = lat/lon (tenths of a degree with
# a N/S/E/W suffix). A tau repeats across radii-threshold rows -- first row per
# tau wins. Stdlib only, blocking: run in an executor.
def _atcf_ll(tok):
    """'286N' / '920W' -> signed degrees. None on junk."""
    tok = (tok or "").strip()
    if len(tok) < 2 or tok[-1] not in "NSEWnsew":
        return None
    try:
        v = float(tok[:-1]) / 10.0
    except ValueError:
        return None
    return -v if tok[-1] in "WwSs" else v


def _dtg_dt(dtg):
    """ATCF DTG 'YYYYMMDDHH' -> datetime (UTC-naive), or None on junk."""
    from datetime import datetime
    try:
        return datetime.strptime((dtg or "").strip(), "%Y%m%d%H")
    except (ValueError, TypeError):
        return None


def _clip_behind(pts, cur, motion_dir):
    """Drop the leading points that fall behind the current storm position and
    anchor the line there, so each guidance line starts at the current-position
    ring instead of trailing into the past. 'Behind' = the far side of the plane
    through cur perpendicular to the storm's motion (heading half-plane); with no
    usable heading, keep from the point nearest cur. cur is (lng, lat). This is a
    PHYSICAL clip, not a time one: raw models analyze the storm a touch behind
    NHC's official current position even on the matching cycle, so a timestamp
    trim can't catch those points -- geometry can."""
    if not cur or cur[0] is None or cur[1] is None or len(pts) < 2:
        return pts
    clng, clat = float(cur[0]), float(cur[1])
    cosf = math.cos(math.radians(clat)) or 1.0
    mv = None
    try:
        if motion_dir is not None:
            r = math.radians(float(motion_dir))
            mv = (math.sin(r), math.cos(r))   # (east, north) unit heading
    except (TypeError, ValueError):
        mv = None
    if mv:
        i = 0
        while i < len(pts):
            ex = (pts[i][0] - clng) * cosf
            ny = pts[i][1] - clat
            if ex * mv[0] + ny * mv[1] >= 0:   # at/ahead of the ring -> stop
                break
            i += 1
        kept = pts[i:]
    else:
        best, bi = None, 0
        for i, p in enumerate(pts):
            ex = (p[0] - clng) * cosf
            ny = p[1] - clat
            d = ex * ex + ny * ny
            if best is None or d < best:
                best, bi = d, i
        kept = pts[bi:]
    if not kept:
        return []
    anchor = [round(clng, 2), round(clat, 2)]
    if kept[0] != anchor:
        kept = [anchor] + kept
    return kept


def parse_model_tracks(text, cur=None, motion_dir=None):
    """a-deck text -> [{"id": tech, "label": .., "points": [[lng, lat], ..]}, ..]
    in MODEL_TRACK_TECHS order. Per tech, the tech's OWN latest cycle is used
    (raw models lag OFCL by a cycle), but only if it's within
    MODEL_TRACK_STALE_H of the deck's newest cycle -- a model that stopped
    running must not draw a days-old track. TVCN is the preferred consensus;
    HCCA fills in only when TVCN is absent.

    `cur` (lng, lat) is the current storm position and `motion_dir` its compass
    heading. When given, each tech's line is clipped to the current-position ring
    (see _clip_behind): leading points behind the ring are dropped and the line
    is anchored at cur, so guidance radiates from the current dot instead of
    trailing into the past. cur=None -> no clip. Empty list on an empty/junk
    deck."""
    wanted = {t for t, _ in MODEL_TRACK_TECHS}
    # rows[tech][dtg][tau] = (lng, lat), first row per tau wins
    rows = {}
    for ln in (text or "").splitlines():
        f = [c.strip() for c in ln.split(",")]
        if len(f) < 9 or f[4] not in wanted:
            continue
        try:
            tau = int(float(f[5]))
        except (TypeError, ValueError):
            continue
        if not (0 <= tau <= MODEL_TRACK_MAX_TAU):
            continue
        lat, lng = _atcf_ll(f[6]), _atcf_ll(f[7])
        if lat is None or lng is None or (lat == 0 and lng == 0):
            continue
        rows.setdefault(f[4], {}).setdefault(f[2], {}).setdefault(
            tau, (round(lng, 2), round(lat, 2)))
    if not rows:
        return []
    newest = max(dtg for percyc in rows.values() for dtg in percyc)
    newest_dt = _dtg_dt(newest)

    def _fresh(dtg):
        # DTGs are fixed-width YYYYMMDDHH; hour distance via int subtraction is
        # only safe same-day, so compare as timestamps.
        d = _dtg_dt(dtg)
        return bool(newest_dt and d and
                    (newest_dt - d).total_seconds() <= MODEL_TRACK_STALE_H * 3600)

    out = []
    have_tvcn = "TVCN" in rows
    for tech, label in MODEL_TRACK_TECHS:
        if tech == "HCCA" and have_tvcn:
            continue    # consensus slot already filled by TVCN
        percyc = rows.get(tech)
        if not percyc:
            continue
        dtg = max(percyc)
        if not _fresh(dtg):
            continue
        taus = sorted(percyc[dtg])
        # Clip the stale "back half": drop leading points that fall behind the
        # current-position ring and anchor the line at it, so guidance radiates
        # from the current dot instead of trailing into the past (raw models
        # analyze the storm slightly behind NHC's official position, so their
        # early points sit where the storm already was).
        pts = _clip_behind([list(percyc[dtg][t]) for t in taus],
                           cur, motion_dir)[:MODEL_TRACK_MAX_PTS]
        if len(pts) >= 2:
            out.append({"id": tech, "label": label, "points": pts})
    return out


def fetch_model_tracks(storm_id, cur=None, motion_dir=None):
    """Fetch + parse the a-deck guidance tracks for one NHC storm. Blocking;
    raises on network/parse failure (the layer platform soft-fails it).
    `cur` (lng, lat) + `motion_dir` (compass heading) clip each model's stale
    back half at the current-position ring (see parse_model_tracks)."""
    import gzip
    sid = (storm_id or "").lower().strip()
    if not sid:
        return []
    raw = http_get(ADECK_URL % sid, binary=True)
    return parse_model_tracks(
        gzip.decompress(raw).decode("utf-8", "replace"), cur, motion_dir)


# ---------------------------------------------------------------------------
# E5 on-demand layers: peak storm surge + per-advisory wind history (NHC-only)
# ---------------------------------------------------------------------------
# Both blocking (executor-only), both raise on network failure -- the layer
# platform (layers.py) catches and soft-fails to an honest "unavailable".
# Both UNVALIDATED against a live NHC storm (written to the probed schema);
# on the first-live-storm validation list with Phases 3/4.
def _esri_rings(feat):
    """One ArcGIS polygon feature -> list of rings, each [[lng, lat], ...].
    Assumes outSR=4326 was requested (coords arrive as lon/lat degrees)."""
    rings = ((feat or {}).get("geometry") or {}).get("rings") or []
    out = []
    for r in rings:
        pts = [[_num(p[0]), _num(p[1])] for p in r
               if isinstance(p, (list, tuple)) and len(p) >= 2]
        pts = [p for p in pts if p[0] is not None and p[1] is not None]
        if len(pts) >= 4:   # esri rings repeat the first point; <4 is degenerate
            out.append(pts)
    return out


def fetch_peak_surge(lat, lng):
    """Peak Storm Surge inundation polygons near a storm's current position.

    The PeakStormSurge service is NOT per-storm (no stormid field), so the
    per-storm filter is spatial: an envelope +/- SURGE_ENVELOPE_DEG around the
    current center. Returns raw bands [{"name", "sym", "rings"}] in feature
    order; layers.py simplifies/budgets the rings and runs the at-home test.
    maxAllowableOffset asks the SERVER to generalize first (these coastal
    polygons are huge at full resolution)."""
    if lat is None or lng is None:
        return []
    env = "%.4f,%.4f,%.4f,%.4f" % (lng - SURGE_ENVELOPE_DEG, lat - SURGE_ENVELOPE_DEG,
                                   lng + SURGE_ENVELOPE_DEG, lat + SURGE_ENVELOPE_DEG)
    params = urllib.parse.urlencode({
        "geometry": env, "geometryType": "esriGeometryEnvelope",
        "inSR": 4326, "outSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "name,symbolid", "returnGeometry": "true",
        "maxAllowableOffset": SURGE_OFFSET_DEG, "where": "1=1", "f": "json",
    })
    url = "%s/%d/query?%s" % (SURGE_URL, SURGE_POLY_LAYER, params)
    data = json.loads(http_get(url))
    out = []
    for ft in data.get("features") or []:
        a = ft.get("attributes") or {}
        rings = _esri_rings(ft)
        if not rings:
            continue
        name = a.get("name") or a.get("NAME") or ""
        sym = a.get("symbolid")
        if sym is None:
            sym = a.get("SYMBOLID")
        out.append({"name": str(name).strip(), "sym": sym, "rings": rings})
    return out


# ---------------------------------------------------------------------------
# Advisory text products (Session E layer; on-demand only, never in the bake)
# ---------------------------------------------------------------------------
def fetch_advisory_text(products):
    """Fetch NHC text products and return [(label, plain_text), ...].

    `products` is {label: url} of the storm's CurrentStorms.json advisory pages
    (publicAdvisory / forecastAdvisory / forecastDiscussion). Each page wraps
    the raw text product in a <pre> block; we pull that and unescape entities --
    stdlib only. Blocking: run in an executor. A product that fails or parses
    empty is skipped, so a schema surprise degrades to fewer sections, never an
    exception. UNVALIDATED against a live NHC storm (written to the documented
    CurrentStorms schema) -- on the first-live-storm validation list.
    """
    import html as _html
    import re

    out = []
    for label, url in (products or {}).items():
        try:
            raw = http_get(url)
            m = re.search(r"<pre[^>]*>(.*?)</pre>", raw, re.S | re.I)
            # The <pre> can carry stray inline markup (e.g. the "en Espanol"
            # link) -- strip tags, then unescape entities. Verified on a live
            # NHC text page (TWO uses the same template as the advisories).
            txt = _html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip() if m else ""
            if txt:
                out.append((label, txt))
        except Exception:
            continue
    return out
