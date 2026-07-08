"""Constants for the Hurricane Tracker integration."""

DOMAIN = "hurricane_tracker"

# --- config / options keys -------------------------------------------------
CONF_LOCATION = "location"          # {"latitude": .., "longitude": ..}
CONF_LATITUDE = "latitude"
CONF_LONGITUDE = "longitude"
CONF_BASIN = "basin"
CONF_UNITS = "units"
CONF_OFF_SEASON = "off_season"
CONF_FILTER = "storm_filter"
CONF_RANGE = "range"                # number, in the user's distance unit

# --- scope / basin ----------------------------------------------------------
# The CONF_BASIN value space holds three SCOPE modes plus explicit basins; the
# user picks one from a single dropdown.
BASIN_AUTO = "auto"        # "My region" — home basin only (quiet basin => all clear)
BASIN_RANGE = "range"      # any storm within CONF_RANGE of home
BASIN_GLOBAL = "global"    # every active storm on earth
SCOPES = [BASIN_AUTO, BASIN_RANGE, BASIN_GLOBAL]

# NHC / CPHC basins — native cone, preferred wherever they reach.
BASIN_ATLANTIC = "atlantic"
BASIN_EAST_PACIFIC = "east_pacific"
BASIN_CENTRAL_PACIFIC = "central_pacific"
NHC_BASINS = {BASIN_ATLANTIC, BASIN_EAST_PACIFIC, BASIN_CENTRAL_PACIFIC}
# GDACS basins — the rest of the world.
BASIN_NW_PACIFIC = "nw_pacific"
BASIN_NORTH_INDIAN = "north_indian"
BASIN_SW_INDIAN = "sw_indian"
BASIN_AUSTRALIAN = "australian"
BASIN_SOUTH_PACIFIC = "south_pacific"

BASINS = [
    BASIN_AUTO, BASIN_RANGE, BASIN_GLOBAL,
    BASIN_ATLANTIC, BASIN_EAST_PACIFIC, BASIN_CENTRAL_PACIFIC,
    BASIN_NW_PACIFIC, BASIN_NORTH_INDIAN, BASIN_SW_INDIAN,
    BASIN_AUSTRALIAN, BASIN_SOUTH_PACIFIC,
]

# NHC storm-id 2-letter basin prefixes -> our basin keys. (GDACS storms carry a
# precomputed "basin" instead; see nhc.storm_basin / basin_from_latlon.)
BASIN_PREFIX = {"al": BASIN_ATLANTIC, "ep": BASIN_EAST_PACIFIC, "cp": BASIN_CENTRAL_PACIFIC}
# Human names (no jargon in the UI).
BASIN_NAME = {
    BASIN_ATLANTIC: "Atlantic",
    BASIN_EAST_PACIFIC: "East Pacific",
    BASIN_CENTRAL_PACIFIC: "Central Pacific",
    BASIN_NW_PACIFIC: "Northwest Pacific",
    BASIN_NORTH_INDIAN: "North Indian",
    BASIN_SW_INDIAN: "Southwest Indian",
    BASIN_AUSTRALIAN: "Australian region",
    BASIN_SOUTH_PACIFIC: "South Pacific",
}

# --- units ------------------------------------------------------------------
UNIT_MI = "mi"
UNIT_KM = "km"
UNITS = [UNIT_MI, UNIT_KM]

# --- off-season display -----------------------------------------------------
OFF_SEASON_CALM = "calm"    # show a quiet "all clear" state
OFF_SEASON_HIDE = "hide"    # hide the card entirely
OFF_SEASON = [OFF_SEASON_CALM, OFF_SEASON_HIDE]

# --- storm filter -----------------------------------------------------------
FILTER_THREAT = "threat"    # show the storm threatening/closest to home (default)
FILTER_ALL = "all"          # expose every active system (card cycles through them)
FILTERS = [FILTER_THREAT, FILTER_ALL]

# --- defaults ---------------------------------------------------------------
DEFAULT_BASIN = BASIN_AUTO
DEFAULT_OFF_SEASON = OFF_SEASON_CALM
DEFAULT_FILTER = FILTER_THREAT
DEFAULT_RANGE = 1500        # "within range" radius, in the user's distance unit

# --- polling ----------------------------------------------------------------
# NHC issues full advisories every 6h (00/06/12/18 UTC) and intermediate
# advisories every 3h (2h with coastal watches/warnings). 30 min catches the
# intermediates comfortably without hammering a government server. GDACS refreshes
# on a similar cadence, so one interval covers both.
POLL_MINUTES = 30

# --- sources ----------------------------------------------------------------
# NHC/CPHC: Atlantic + E/Central Pacific (native cone). GDACS (EU/JRC): the rest
# of the world's basins, open GeoJSON, attribution "Global Disaster Alert and
# Coordination System, GDACS".
CURRENT_STORMS_URL = "https://www.nhc.noaa.gov/CurrentStorms.json"
GDACS_EVENTS_URL = "https://www.gdacs.org/gdacsapi/api/Events/geteventlist/EVENTS4APP"
HTTP_TIMEOUT = 45
# GDACS's per-event GEOMETRY endpoint (the cone polygon) is materially slower and
# flakier than the event list or NHC -- it routinely needs more than 45 s. Give
# only that one call more room so the bake can succeed and seed the cache; the
# list fetch and NHC stay at HTTP_TIMEOUT. Not blanket-raised, because a hung
# fetch ties up an HA executor thread for the whole duration (matters on a Pi).
GDACS_GEOMETRY_TIMEOUT = 90
USER_AGENT = "ha-hurricane-tracker (Home Assistant custom integration)"

# --- NHC forecast wind radii (Phase 3, NHC-only) ----------------------------
# The tropical MapServer serves per-storm-slot layers. Each active slot
# (AT1..AT5 / EP1..EP5 / CP1..CP5) exposes an "Advisory Wind Field" layer: the
# CURRENT (initial) 34/50/64 kt wind-radii polygons at the storm's present
# center. The layer id is deterministic from the storm's bin:
#   layer = WIND_SLOT_BLOCK[group] + (slot-1)*WIND_SLOT_STEP + WIND_ADVISORY_OFFSET
# (e.g. AT1 -> 17, AT2 -> 43, EP1 -> 147, CP1 -> 277). Fields on the layer:
# radii (34/50/64), stormid, tau, ne/se/sw/nw; geometry is polygon (drawn as-is).
# SHIPPED v0.1.4 unvalidated (Aaron's call -- no active NHC storm existed at build
# time). Fetch soft-fails to an empty field, so an install is never broken by its
# absence; but the live fetch/parse is UNPROVEN end-to-end. Validate on the first
# real active NHC storm and patch if the live schema differs from the assumed one.
WIND_RADII_URL = ("https://mapservices.weather.noaa.gov/tropical/rest/services/"
                  "tropical/NHC_tropical_weather/MapServer")
WIND_SLOT_BLOCK = {"AT": 4, "EP": 134, "CP": 264}
WIND_SLOT_STEP = 26
WIND_ADVISORY_OFFSET = 13   # "<slot> Advisory Wind Field" = current radii
# Phase 4: the sibling "<slot> Forecast Wind Radii" layer (offset +12, e.g. AT1=16)
# carries a `tau` field, so it gives the 34/50/64 kt radii at every forecast time,
# not just the current one. Same radii fields; same shipped-v0.1.4-unvalidated,
# soft-fail, validate-on-first-live-storm status as the Advisory Wind Field above.
WIND_FORECAST_OFFSET = 12
WIND_RADII_KTS = (34, 50, 64)

# --- forecast model tracks (E4, NHC-only; on-demand layer) -------------------
# Guidance ("spaghetti") tracks from the NHC ATCF a-deck for the storm, served
# over the layer websocket ONLY when the viewer toggles the layer on -- never in
# the 30-min bake. Capped shortlist: the point is spread, not a model zoo.
# aid_public serves the CURRENT season's decks over HTTPS (same host also does
# FTP; we use HTTPS via the stock http_get). EMXI (ECMWF) is access-restricted
# in public decks (rows blank) -- excluded on purpose. GFS is AVNO (not GFSO);
# UKMET is UKX (not EGRR). Verified against a live a-deck aep012026, 2026-07.
ADECK_URL = "https://ftp.nhc.noaa.gov/atcf/aid_public/a%s.dat.gz"
# Ordered (tech, human label). TVCN and HCCA are both consensus aids: TVCN is
# preferred, HCCA is the fallback when TVCN is absent (handled in nhc.py).
MODEL_TRACK_TECHS = (
    ("OFCL", "NHC Official"),
    ("TVCN", "Consensus"),
    ("HCCA", "Consensus"),
    ("AVNO", "GFS"),
    ("HFSA", "HAFS-A"),
    ("UKX", "UKMET"),
)
MODEL_TRACK_MAX_TAU = 168     # hours; past 7 days guidance is noise
MODEL_TRACK_MAX_PTS = 32      # per-model point cap (taus are 6-12 h apart)
# A tech's own latest cycle must be within this many hours of the deck's newest
# cycle or the tech is dropped -- late/raw models lag one cycle behind OFCL, so
# per-tech-latest keeps them on the map, but a model that stopped running
# entirely must not draw a days-old track.
MODEL_TRACK_STALE_H = 12

# --- past-track trail -------------------------------------------------------
# Miles of TRAVEL kept behind the storm, so a fast and a slow storm trail the
# same physical length on screen (consistent zoom).
PAST_MILES = 110

# --- bake-cache persistence -------------------------------------------------
# The per-storm bake cache (coordinator._bake_cache) is persisted to HA's
# .storage so an HA restart DURING a feed outage doesn't wake up blind -- the
# residual gap left by the v0.1.6 in-memory-only cache. Store is versioned: a
# version mismatch on load drops the cache (a stale-shaped payload is worse than
# an empty cache -- the next poll rebuilds it). The 9 h age-out (CACHE_MAX_AGE_MS)
# is re-applied on hydrate, so entries that aged out while HA was off are dropped
# on load, and the cache is capped at MAX_STORMS newest entries.
CACHE_STORAGE_KEY = "hurricane_tracker_bake_cache"
CACHE_STORAGE_VERSION = 1

# --- zoom / pan (buffered clip) ---------------------------------------------
# The card lets the user pinch/drag/wheel to zoom+pan the map. To keep that a
# pure client-side transform (no re-fetch, no DOM rebuild mid-gesture), the bake
# clips a BUFFER larger than the default storm frame -- so there's already-baked
# coastline to reveal when panning/zooming. The default view is unchanged: it
# still frames on the storm bbox at the default point budget, so default-zoom
# coastline quality is byte-identical to before. The buffer is baked at the
# DEFAULT frame's detail level (tolerance pinned to the default span, not the
# buffer span), so zoomed-in coast stays sharp -- that costs points, hence the
# higher budget + a hard payload cap. Measured (Aaron's Mac, in-container):
# a 2x sharp buffer lands ~16-17k pts / ~290-325 KB, tolerance-floor limited,
# well under the cap; clip ~150-420 ms in the executor, off the event loop.
ZOOM_BUFFER_FACTOR = 2.0     # buffered extent = this * the default frame, about its center
ZOOM_POINT_BUDGET = 20000    # simplification ceiling for the buffered clip (a cap, not a target)
ZOOM_PAYLOAD_CAP_BYTES = 400000  # hard cap on the serialized geo; back off tolerance until under
ZOOM_MAX_SCALE = 3.0         # card zoom-in limit (past this the DP coastline reads chunky)
CITY_DOT_CAP = 30            # max city dots per payload (top-N by pop_max in the buffered view)

# --- frontend ---------------------------------------------------------------
CARD_FILENAME = "hurricane-card.js"
FRONTEND_URL_BASE = "/hurricane_tracker_frontend"

# --- public control API -----------------------------------------------------
# The integration's options (basin/filter/range/units/off-season) are Python-only
# by nature: HA lets outside code change an integration only via services or by
# operating its entities. We expose BOTH -- a set_options service (one-shot /
# scripting) and select/number entities (the primary, self-documenting interface).
# Both funnel through the same __init__.async_apply_options path: merge into
# entry.options -> async_update_entry -> the update listener reloads the coordinator.
SERVICE_SET_OPTIONS = "set_options"
# Service field names == the option keys they write, so the service payload is
# just a subset of the options dict. (basin/storm_filter/range/units/off_season
# are already defined above as CONF_* / values.)
