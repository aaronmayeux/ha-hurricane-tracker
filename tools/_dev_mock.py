"""DEV-ONLY mock — NOT part of the shipped integration.

Renders a real historical storm through the real payload + card path so the wind
field (Phase 3), the per-tau at-home exposure timeline (Phase 4), the past-track
trail, and the distance readouts can be exercised on glass with no live storm
active. Home placement (MOCK_HOME) decides which of those are exercised.

Fully a-deck-driven, so it works for ANY storm in the ATCF archive (~2004 on),
including ones with no archived cone GIS (e.g. Katrina 2005). Real from the a-deck:
current + forecast positions, per-tau intensity, past track, and the issued
34/50/64 kt wind radii. The ONE synthesized piece is the cone polygon (2005 has no
archived cone shapefile) — built here from the forecast points + NHC error-circle
radii, purely for visual context. The shipped product never synthesizes a cone; it
uses live NHC GIS.

Never copied into the release clone. coordinator.py imports it under try/except, so
its absence is a clean no-op. ENABLED=False (or delete the file) to run live.

WHERE THIS LIVES / HOW TO USE IT
--------------------------------
This file is ARCHIVED here in `tools/` and does NOT run from this directory: it uses
package-relative imports (`from . import nhc`), so Python can only load it from inside
the integration package. `tools/` is never pulled by HACS (`content_in_root: false`),
which is the point -- the mock must never ship to users.

To use it, copy it into the DEV COPY's integration folder and flip ENABLED:

    docker cp tools/_dev_mock.py \\
      hurricane-ha:/config/custom_components/hurricane_tracker/_dev_mock.py
    # set ENABLED = True, then: docker restart hurricane-ha

Delete it from the dev copy (or set ENABLED=False) to go back to live data. A HACS
pull clobbers the dev copy to released files and removes it anyway.

It is committed here for ONE reason: it was never in git, and for a while the only
copy on earth sat in a local backup folder slated for deletion. Losing it would have
cost the ability to develop against a real storm during quiet season, which is exactly
when that ability matters. Do not "clean it up" out of the repo.
"""
from __future__ import annotations

import gzip
import time
from datetime import datetime, timedelta, timezone

from . import nhc
from .const import PAST_MILES
from .geometry import assemble_payload, _wind_dest

# --- knobs ------------------------------------------------------------------
ENABLED = False

# Storm + advisory to render. MOCK_STORM is the ATCF id (basin+num+year); the
# a-deck path is derived from it. MOCK_SYNOPTIC is the YYYYMMDDHH block to show as
# "now" (tau=0). Katrina at Aug 29 2005 00Z: Cat 4-5, ~12 h off Louisiana, full
# 34/50/64 kt field.
MOCK_STORM = "al122005"          # Hurricane Katrina
MOCK_NAME = "Katrina"
MOCK_SYNOPTIC = "2005082900"

# Demo home. Gulfport, MS sits inside Katrina's forecast wind field at several
# forecast times -> exercises the Phase 4 at-home exposure timeline (all three
# thresholds around 12 h, 34 kt lingering to ~24 h, the 50/64 kt data-gap after).
# Swap to e.g. (34.05, -118.24) Los Angeles to exercise the off-screen home marker
# instead. Only affects the mock, not the real HA config.
MOCK_HOME = (30.37, -89.09)      # Gulfport, MS

_ADECK = "https://ftp.nhc.noaa.gov/atcf/archive/%s/a%s.dat.gz"

# NHC Atlantic cone error-circle radii (nm) by tau -- approximate, MOCK-ONLY, used
# only to synthesize a cone for storms with no archived cone GIS.
_CONE_ERR = [(0, 16), (12, 29), (24, 45), (36, 62), (48, 79),
             (72, 107), (96, 159), (120, 211)]


def _ll(tok):
    """'286N'/'920W' -> signed degrees."""
    v = float(tok[:-1]) / 10.0
    return -v if tok[-1] in "WwSs" else v


def _adeck_rows():
    year = MOCK_STORM[4:8]
    raw = nhc.http_get(_ADECK % (year, MOCK_STORM), binary=True)
    txt = gzip.decompress(raw).decode("utf-8", "replace")
    out = []
    for ln in txt.splitlines():
        f = [c.strip() for c in ln.split(",")]
        if len(f) > 16 and f[4] == "OFCL":
            out.append(f)
    return out


def _err_nm(tau):
    tbl = _CONE_ERR
    if tau <= tbl[0][0]:
        return tbl[0][1]
    if tau >= tbl[-1][0]:
        return tbl[-1][1]
    for (t0, r0), (t1, r1) in zip(tbl, tbl[1:]):
        if t0 <= tau <= t1:
            f = (tau - t0) / (t1 - t0) if t1 > t0 else 0.0
            return r0 + (r1 - r0) * f
    return tbl[-1][1]


def _hull(pts):
    """Convex hull (Andrew's monotone chain) on [lng,lat], planar approx."""
    pts = sorted(set((round(x, 4), round(y, 4)) for x, y in pts))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lo = []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    up = []
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


def _label(synoptic, tau):
    dt = (datetime.strptime(synoptic, "%Y%m%d%H").replace(tzinfo=timezone.utc)
          + timedelta(hours=tau))
    h = dt.hour % 12 or 12
    return "%d %s %s" % (h, "AM" if dt.hour < 12 else "PM", dt.strftime("%a"))


def build(home_lat, home_lon, units):
    """Coordinator-shaped payload dict, or None to fall through to live."""
    try:
        rows = _adeck_rows()
        syn = [r for r in rows if r[2] == MOCK_SYNOPTIC]
        if not syn:
            return None

        # forecast points, one per tau (real positions/intensity)
        taus = sorted({int(float(r[5])) for r in syn})
        pts = []
        for tau in taus:
            fr = next((r for r in syn if int(float(r[5])) == tau), None)
            if not fr:
                continue
            try:
                vmax = float(fr[8])
            except (TypeError, ValueError):
                vmax = 0.0
            pts.append({"lng": round(_ll(fr[7]), 4), "lat": round(_ll(fr[6]), 4),
                        "tau": float(tau), "cat": nhc.cat_from(None, None, vmax),
                        "wind": vmax, "label": _label(MOCK_SYNOPTIC, tau)})
        if not pts:
            return None
        p0 = pts[0]
        clat, clon = p0["lat"], p0["lng"]
        fcst = [[p["lng"], p["lat"]] for p in pts]

        # synth cone: hull of NHC error circles around each forecast point
        circ = []
        for p in pts:
            r = _err_nm(p["tau"])
            for b in range(0, 360, 30):
                circ.append(_wind_dest(p["lat"], p["lng"], b, r))
        cone = [[round(x, 4), round(y, 4)] for x, y in _hull(circ)]
        if cone and cone[0] != cone[-1]:
            cone.append(cone[0])

        # real past track: tau=0 positions from advisories up to this one, trimmed
        # to PAST_MILES of travel behind the current center
        past_all = []
        for t in sorted({r[2] for r in rows if r[2] <= MOCK_SYNOPTIC}):
            fr = next((r for r in rows if r[2] == t and int(float(r[5])) == 0), None)
            if fr:
                past_all.append([_ll(fr[7]), _ll(fr[6])])
        past = []
        if len(past_all) >= 2:
            kept = [past_all[-1]]
            acc = 0.0
            for i in range(len(past_all) - 1, 0, -1):
                a, b = past_all[i], past_all[i - 1]
                acc += nhc.haversine_mi(a[1], a[0], b[1], b[0])
                kept.append(b)
                if acc >= PAST_MILES:
                    break
            kept.reverse()
            past = [[round(x, 4), round(y, 4)] for x, y in kept]

        # wind field radii (tau=0)
        wind = []
        for kt in (34, 50, 64):
            fr = next((r for r in syn if int(float(r[5])) == 0 and r[11] == str(kt)), None)
            if fr:
                wind.append({"kt": kt, "ne": float(fr[13]), "se": float(fr[14]),
                             "sw": float(fr[15]), "nw": float(fr[16])})

        # forecast wind field radii per tau (Phase 4) -- same a-deck rows, every
        # tau instead of just 0. Drives the at-home exposure timeline.
        wind_fc = []
        for tau in taus:
            radii = []
            for kt in (34, 50, 64):
                fr = next((r for r in syn if int(float(r[5])) == tau
                           and r[11] == str(kt)), None)
                if fr:
                    ne, se, sw, nw = (float(fr[13]), float(fr[14]),
                                      float(fr[15]), float(fr[16]))
                    if max(ne, se, sw, nw) > 0:
                        radii.append({"kt": kt, "ne": ne, "se": se,
                                      "sw": sw, "nw": nw})
            if radii:
                wind_fc.append({"tau": float(tau), "radii": radii})

        # tau=0 wall-clock reference (epoch ms, UTC) so the card labels the
        # exposure windows in real time instead of relative hours.
        ref_ms = int(datetime.strptime(MOCK_SYNOPTIC, "%Y%m%d%H")
                     .replace(tzinfo=timezone.utc).timestamp() * 1000)

        # motion from tau=0 -> next forecast point
        md = ms = None
        if len(pts) >= 2:
            a, b = pts[0], pts[1]
            md = round(nhc.bearing_deg(a["lat"], a["lng"], b["lat"], b["lng"]), 1)
            dt = b["tau"] - a["tau"]
            if dt > 0:
                mi = nhc.haversine_mi(a["lat"], a["lng"], b["lat"], b["lng"])
                ms = round(mi / 1.15078 / dt, 1)   # knots

        fdata = {"cone": cone, "fcstTrack": fcst, "pastTrack": past, "points": pts,
                 "ww": [], "windField": wind, "windForecast": wind_fc,
                 "refTime": ref_ms, "name": MOCK_NAME,
                 "type": "Hurricane", "advisory": ""}
        storm = {"id": MOCK_STORM, "name": MOCK_NAME, "classification": "HU",
                 "latitudeNumeric": clat, "longitudeNumeric": clon,
                 "movementDir": md, "movementSpeed": ms}
        hlat, hlon = MOCK_HOME
        pl = assemble_payload(storm, fdata, hlat, hlon, units)
        if not pl:
            return None
        return {"ok": True, "storms": [pl], "count": 1,
                "ts": int(time.time() * 1000), "_mock": True}
    except Exception:
        return None
