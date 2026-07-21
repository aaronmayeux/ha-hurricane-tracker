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
# OFCL is intentionally absent: it IS the official forecast track, which the
# card always draws as the solid line -- a dashed OFCL overlay was invisible
# on top of it and redundant in the legend (Aaron, 2026-07-17).
MODEL_TRACK_TECHS = (
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

# --- E5 on-demand layers: storm surge + wind history (NHC-only) --------------
# Peak Storm Surge: its OWN MapServer -- NOT per-storm slots. One Points/Lines/
# Polygons trio serves ALL active storms, and features carry NO stormid field
# (probed 2026-07-08). Per-storm selection is therefore SPATIAL: query the
# Polygons layer (2) for features intersecting an envelope around the storm's
# current position. `name` carries the band label, `symbolid` the NHC color
# class (blue/yellow/orange/red/purple, rising severity). NOTE: surge
# watch/warning does NOT exist as a vector product anywhere in the NHC
# services (layer 9's tcww carries only wind codes HWA/HWR/TWA/TWR;
# NHC_Breakpoints is static reference points) -- the old "surge W/W stripe"
# idea is void. Same shipped-unvalidated / soft-fail / validate-on-first-live-
# storm status as Phases 3/4.
SURGE_URL = ("https://mapservices.weather.noaa.gov/tropical/rest/services/"
             "tropical/NHC_PeakStormSurge/MapServer")
SURGE_POLY_LAYER = 2
SURGE_ENVELOPE_DEG = 12.0     # +/- degrees around the current position (spatial filter)
SURGE_OFFSET_DEG = 0.005      # server-side generalization (maxAllowableOffset, degrees)
SURGE_POINT_BUDGET = 6000     # client-side DP cap across all returned rings
# --- watch/warning coast tracing --------------------------------------------
# NHC's _ww_wwlin is a BREAKPOINT list, not a coastline: the whole Florida
# Panhandle TWA arrives as 7 vertices joined by straight chords, so the drawn
# stripe cuts across every bay (measured live on AL02 adv 1A, 2026-07-19).
# geometry.trace_ww_on_coast snaps those breakpoints onto the ALREADY-CLIPPED,
# ALREADY-SIMPLIFIED coast arrays and re-emits the stripe as a slice of the same
# vertices the card draws as coastline -- so it registers exactly, at any zoom,
# and picks up the card's Catmull-Rom smoothing for free.
#
# WW_SNAP_TOL_DEG: max breakpoint->coast distance (degrees, cos-lat corrected)
# that still counts as a snap. Live AL02 worst case was 0.0945 deg (~6.5 mi) on
# the simplified coast, so 0.25 (~17 mi) clears real data with room while
# staying well under the gap that must still SPLIT a stripe (e.g. the Keys vs
# the mainland, ~50+ mi) into separate runs. Any segment whose breakpoints all
# miss by more than this falls back to NHC's raw chords -- never nothing.
WW_SNAP_TOL_DEG = 0.25
# Hard ceiling on a single traced run's vertex count. The source coast is
# already DP-budgeted, so this only ever fires on a pathological frame; over it,
# the run is re-simplified rather than shipped whole.
WW_TRACE_MAX_PTS = 2000
# Barrier islands. The stripe traces ONE coast part (the mainland), but a real
# coastal warning covers the barrier islands fronting it -- Santa Rosa, St.
# George, St. Vincent -- which are separate parts in the basemap and would
# otherwise sit unstroked right where the warning is loudest. So after the
# mainland trace, any OTHER coast part running within this distance of it gets
# stroked too, clipped to the stretch that's actually close (which is what keeps
# a long island from spilling past the warning's ends).
# Measured on AL02 (2026-07-19): the four fronting islands sit 0.1-3.7 mi off
# the traced run, and the next-nearest part is 32.4 mi away. 10 mi sits in the
# middle of that gap, so the choice is not delicate on this storm.
WW_ISLAND_DIST_DEG = 0.145   # ~10 mi

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
# Max NAMED places per payload (top-N by pop in the buffered view). The card's
# Cities mode draws the top CITY_DOT_DRAW of these as uniform labeled dots;
# Population mode ignores this list and draws the (unnamed) popGrid instead.
CITY_DOT_CAP = 120
CITY_DOT_DRAW = 30           # Cities-mode draw cap (card-side slice)

# --- population-density grid (popGrid) knobs (v0.3.0) ------------------------
# The basemap places layer is GeoNames cities5000 (~64k places, pop >= 5000,
# CC-BY 4.0 -- attribution lives in the README) as of v0.3.0; it was Natural
# Earth populated_places (~5.2k, >= 25k) before. popGrid ships every in-view
# place UNLESS the count tops POP_GRID_CAP, in which case geometry's
# _thin_pop_grid aggregates per grid cell (pop-weighted centroid + summed pop)
# until it fits. Tuning:
#   POP_GRID_CAP       payload/DOM ceiling. Higher = finer density picture,
#                      heavier websocket payload + more SVG circles per frame.
#   POP_GRID_MIN_POP   payload-side population floor applied BEFORE
#                      aggregation. 0 = everything in the file. 25000 mimics
#                      the old Natural-Earth-era look without touching
#                      basemap.bin (the quick "don't like it" revert knob).
#   POP_GRID_START_DIV initial aggregation cell = view span / this. Bigger =
#                      finer starting cells (denser result before the cap
#                      forces coarsening); each retry doubles the cell.
POP_GRID_CAP = 4000
POP_GRID_MIN_POP = 0
POP_GRID_START_DIV = 256

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

# --- weather imagery overlay (§13, on-demand raster underlay) ----------------
# Draw live weather imagery UNDER the cone. Two PUBLIC-DOMAIN EPSG:3857 PNG
# sources; satellite LEADS (covers open ocean where storms live), radar is a
# near-land bonus. Fetched stdlib-only (urllib) as raw bytes, cached in a
# bounded in-memory LRU, and handed to the card as a SIGNED HTTP path -- NEVER
# over the websocket (no binary bloat). The black-sky knockout is a client SVG
# filter; the backend never touches pixels, so requirements[] stays empty.
IMAGERY_SAT = "imagery_sat"
IMAGERY_RADAR = "imagery_radar"
IMAGERY_LAYERS = {IMAGERY_SAT, IMAGERY_RADAR}

# Satellite: IEM GOES-East Band 13 (Clean LWIR, color-enhanced). WMS 1.1.1
# GetMap. Clear sky renders SOLID BLACK (not alpha) -- the card's
# #extract-clouds filter knocks the black out. MUST be PNG, not JPEG: JPEG
# mosquito-noise near black keys as colored halos.
IMAGERY_SAT_URL = "https://mesonet.agron.iastate.edu/cgi-bin/wms/goes_east.cgi"
IMAGERY_SAT_LAYER = "conus_ch13"
# Radar: NOAA nowCOAST MRMS base reflectivity ImageServer (exportImage). 5-min
# updates; CONUS + Caribbean + AK/HI/Guam. True transparent PNG.
IMAGERY_RADAR_URL = ("https://mapservices.weather.noaa.gov/eventdriven/rest/"
                     "services/radar/radar_base_reflectivity_time/ImageServer")

# Refresh cadence == source cadence (5 min). The CARD drives the refresh; the
# backend never self-initiates. TTL also buckets the byte-cache key.
IMAGERY_TTL_S = 300
# Bounded in-memory byte cache (protects the SD card): a few recent frames,
# evicted oldest-first past the frame cap or the hard byte cap.
IMAGERY_CACHE_MAX_FRAMES = 6
IMAGERY_CACHE_MAX_BYTES = 8 * 1024 * 1024
# Requested raster pixel size is derived from the 3857 bbox aspect, longest side
# capped so one frame can't balloon the cache or the fetch.
IMAGERY_MAX_DIM = 1800
IMAGERY_HTTP_TIMEOUT = 20
# Signed-path lifetime handed to the card. Comfortably longer than one refresh
# cycle so a cached frame's URL stays valid between heartbeats.
IMAGERY_SIGN_TTL_S = 15 * 60

# EPSG:3857 (Web Mercator) sphere radius + latitude clamp, mirroring the card's
# makeProject (x linear in lng, y through the Mercator stretch).
MERC_R = 6378137.0
MERC_LAT_LIMIT = 85.05112878

# Coverage gates as (min_lng, min_lat, max_lng, max_lat) tested against the bbox
# CENTER. Outside -> the card shows a "no coverage" note, not a blank raster.
# Satellite: GOES-East reaches the Atlantic + E Pacific but NOT the GDACS basins
# (W Pacific / Indian) or CPac west of ~140W. Radar (MRMS): CONUS + Caribbean +
# AK/HI/Guam, i.e. the W hemisphere north of the deep tropics' south edge.
IMAGERY_SAT_COVERAGE = (-140.0, -60.0, 10.0, 65.0)
IMAGERY_RADAR_COVERAGE = (-170.0, 10.0, -60.0, 72.0)
