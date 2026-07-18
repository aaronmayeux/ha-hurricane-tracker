"""Tests for geometry.py: basemap reader, spatial helpers, payload assembly."""
from hurricane_tracker import geometry, nhc


# --- pure spatial helpers ----------------------------------------------------
def test_dp_drops_collinear():
    pts = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]]
    out = geometry._dp(pts, 0.1)
    assert out[0] == [0.0, 0.0] and out[-1] == [2.0, 0.0]
    assert len(out) == 2   # middle collinear point removed


def test_pt_in_ring():
    ring = [[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]
    assert geometry._pt_in_ring(1, 1, ring) is True
    assert geometry._pt_in_ring(3, 3, ring) is False
    assert geometry._pt_in_ring(-1, 1, ring) is False


def test_compute_bbox_contains_points():
    cone = [[-100, 20], [-98, 22], [-96, 20], [-98, 18], [-100, 20]]
    bbox = geometry.compute_bbox(cone, [], [])
    assert bbox is not None and len(bbox) == 4
    assert bbox[0] <= -100 and bbox[2] >= -96
    assert bbox[1] <= 18 and bbox[3] >= 22


def test_compute_bbox_empty():
    assert geometry.compute_bbox([], [], []) is None


def test_wind_ring_from_radii():
    r = {"ne": 40, "se": 30, "sw": 20, "nw": 25}
    ring = geometry._wind_ring_from_radii(17.0, -120.0, r, step=30.0)
    assert ring is not None and len(ring) >= 4
    assert ring[0] == ring[-1]   # closed
    assert geometry._wind_ring_from_radii(17.0, -120.0,
                                          {"ne": 0, "se": 0, "sw": 0, "nw": 0}) is None


def test_thin_pop_grid_passthrough():
    places = [{"lng": -100.0, "lat": 20.0, "pop": 5000},
              {"lng": -99.5, "lat": 20.5, "pop": 8000}]
    grid = geometry._thin_pop_grid(places, [-101, 19, -98, 21])
    assert len(grid) == 2
    assert all(len(g) == 3 for g in grid)


def test_thin_pop_grid_aggregates_over_cap():
    from hurricane_tracker.const import POP_GRID_CAP
    n = POP_GRID_CAP + 500
    places = [{"lng": -100.0 + (i % 100) * 0.01,
               "lat": 20.0 + (i // 100) * 0.01, "pop": 5000} for i in range(n)]
    grid = geometry._thin_pop_grid(places, [-101, 19, -98, 25])
    assert len(grid) <= POP_GRID_CAP


# --- basemap reader (v4: GeoNames density + Natural Earth named) -------------
def test_basemap_loads_v4():
    bm = geometry.load_basemap()
    assert bm.places, "expected GeoNames density places"
    assert bm.named, "expected Natural Earth named places (v4 layer)"


def test_named_prominence_over_boroughs():
    bm = geometry.load_basemap()
    # box over central/southern Mexico + SW US
    box = [-120.0, 14.0, -95.0, 40.0]
    named = bm.named_in(box)
    assert named, "expected named places in the box"
    names = {p["name"] for p in named}
    # curated set carries the recognizable cities, not GeoNames metro boroughs
    assert "Mexico City" in names
    assert "Iztapalapa" not in names and "Ecatepec de Morelos" not in names
    # sorted by prominence (scalerank asc, then pop) -> a top city, not a suburb
    top = sorted(named, key=lambda p: (p["rank"], -p["pop"]))[0]
    assert top["name"] in ("Mexico City", "Los Angeles")


def test_places_in_shape():
    bm = geometry.load_basemap()
    got = bm.places_in([-120.0, 14.0, -95.0, 40.0])
    assert got
    for p in got[:5]:
        assert {"name", "lng", "lat", "rank", "pop"} <= set(p)


# --- end-to-end payload smoke ------------------------------------------------
def test_assemble_payload_smoke(storm, forecast_zip, best_track_zip):
    fd = nhc.parse_forecast(forecast_zip)
    fd["pastTrack"] = nhc.parse_besttrack(best_track_zip)
    payload = geometry.assemble_payload(storm, fd, 34.0, -118.0, "mi")
    assert isinstance(payload, dict)
    assert payload.get("cone")
    assert payload.get("bbox") and len(payload["bbox"]) == 4
    geo = payload.get("geo") or {}
    assert geo.get("coast") and geo.get("land")
    places = payload.get("places")
    assert places, "expected named city dots"
    names = {p["name"] for p in places}
    assert "Iztapalapa" not in names   # boroughs gone
    assert names & {"Los Angeles", "Mexico City", "San Diego", "Tijuana"}
