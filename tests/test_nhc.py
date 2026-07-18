"""Tests for nhc.py: hand-rolled GIS/ATCF parsing + geo helpers.

These guard the fragile hand-parsers against upstream schema drift and lock in
the v0.2.1 model-track back-half clip.
"""
import math

from hurricane_tracker import nhc


# --- small geo/format helpers ------------------------------------------------
def test_atcf_ll_signs():
    assert nhc._atcf_ll("286N") == 28.6
    assert nhc._atcf_ll("1202W") == -120.2
    assert nhc._atcf_ll("0S") == 0.0
    assert nhc._atcf_ll("junk") is None
    assert nhc._atcf_ll("") is None


def test_haversine_one_degree_lat():
    # 1 degree of latitude is ~69 miles.
    d = nhc.haversine_mi(0.0, 0.0, 1.0, 0.0)
    assert 68.5 < d < 69.5


def test_bearing_cardinals():
    assert abs(nhc.bearing_deg(0, 0, 1, 0) - 0.0) < 1e-6      # due north
    assert abs(nhc.bearing_deg(0, 0, 0, 1) - 90.0) < 1e-6     # due east


def test_compass():
    assert nhc.compass(0) == "N"
    assert nhc.compass(90) == "E"
    assert nhc.compass(180) == "S"
    assert nhc.compass(270) == "W"
    assert nhc.compass(None) == ""


def test_cat_from():
    assert nhc.cat_from("HU", None, 120) == "4"     # 120 kt -> Cat 4
    assert nhc.cat_from("HU", None, 140) == "5"
    assert nhc.cat_from("TS", None, 50) == "TS"
    assert nhc.cat_from("TD", None, 30) == "TD"
    assert nhc.cat_from(None, 3, None) == "3"        # SS number wins


def test_dtg_dt():
    assert nhc._dtg_dt("2026071706") is not None
    assert nhc._dtg_dt("2026071706").hour == 6
    assert nhc._dtg_dt("garbage") is None
    assert nhc._dtg_dt(None) is None


# --- forecast-cone zip -------------------------------------------------------
def test_parse_forecast(forecast_zip):
    fd = nhc.parse_forecast(forecast_zip)
    assert len(fd["cone"]) > 3
    assert all(len(pt) == 2 for pt in fd["cone"])
    assert len(fd["fcstTrack"]) >= 2
    assert fd["points"], "expected forecast points"
    p0 = fd["points"][0]
    assert p0["tau"] == 0.0
    assert p0["lat"] is not None and p0["lng"] is not None
    assert p0["cat"]
    assert isinstance(fd["name"], str) and fd["name"]
    assert isinstance(fd["advisory"], str)


def test_parse_besttrack(best_track_zip):
    track = nhc.parse_besttrack(best_track_zip)
    assert len(track) >= 2
    assert all(len(p) == 2 for p in track)


def test_parse_besttrack_wind_points(best_track_zip):
    pw = nhc.parse_besttrack_wind_points(best_track_zip)
    assert isinstance(pw, dict)
    for kt, seq in pw.items():
        assert kt in (34, 50, 64)
        assert all({"lat", "lng"} <= set(p) for p in seq)


# --- model tracks + the back-half clip (v0.2.1) ------------------------------
def _synthetic_deck():
    """AVNO on the 00Z cycle (6 h behind the advisory), TVCN on 06Z. Both track
    WNW like the storm. AVNO's first two points sit BEHIND the current ring and
    its later points cross ahead; TVCN is on-cycle and already at the ring. Rows
    are ATCF-shaped: basin, cyclonum, DTG, techtype, tech, tau, lat, lon, vmax.
    lat/lon are tenths-of-a-degree with a hemisphere suffix."""
    avno = [(0, "166N", "1207W"), (6, "170N", "1215W"),
            (12, "175N", "1223W"), (18, "180N", "1231W")]
    tvcn = [(0, "171N", "1221W"), (12, "180N", "1235W"), (24, "190N", "1250W")]
    lines = ["EP, 05, 2026071700, 03, AVNO, %d, %s, %s, 55, XX," % r for r in avno]
    lines += ["EP, 05, 2026071706, 03, TVCN, %d, %s, %s, 55, XX," % r for r in tvcn]
    return "\n".join(lines)


def test_parse_model_tracks_shape(adeck_text):
    models = nhc.parse_model_tracks(adeck_text)
    assert isinstance(models, list)
    for m in models:
        assert m["id"]
        assert len(m["points"]) >= 2
        assert all(len(pt) == 2 for pt in m["points"])


def test_clip_anchors_at_current_ring():
    # cur just NW of the AVNO tau-0 point; storm heading WNW (295 deg).
    cur = (-121.9, 17.1)
    deck = _synthetic_deck()
    clipped = nhc.parse_model_tracks(deck, cur, 295)
    assert clipped, "expected at least one model"
    anchor = [round(cur[0], 2), round(cur[1], 2)]
    for m in clipped:
        assert m["points"][0] == anchor, "%s not anchored at ring" % m["id"]
    # AVNO's 00Z tau-0 point sits behind the ring -> dropped by the clip.
    avno_raw = next(m for m in nhc.parse_model_tracks(deck) if m["id"] == "AVNO")
    avno_clip = next(m for m in clipped if m["id"] == "AVNO")
    assert len(avno_clip["points"]) < len(avno_raw["points"])


def test_clip_no_cur_is_passthrough():
    deck = _synthetic_deck()
    assert nhc.parse_model_tracks(deck) == nhc.parse_model_tracks(deck, None, None)


def test_clip_behind_nearest_fallback():
    # No heading -> nearest-point fallback still anchors at cur and drops nothing
    # ahead. Points march east; cur sits at the 3rd point.
    pts = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]]
    cur = (2.0, 0.0)
    kept = nhc._clip_behind([p[:] for p in pts], cur, None)
    assert kept[0] == [2.0, 0.0]
    assert [3.0, 0.0] in kept
    assert [0.0, 0.0] not in kept
