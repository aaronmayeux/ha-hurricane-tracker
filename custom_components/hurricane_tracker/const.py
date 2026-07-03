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
USER_AGENT = "ha-hurricane-tracker (Home Assistant custom integration)"

# --- past-track trail -------------------------------------------------------
# Miles of TRAVEL kept behind the storm, so a fast and a slow storm trail the
# same physical length on screen (consistent zoom).
PAST_MILES = 110

# --- frontend ---------------------------------------------------------------
CARD_FILENAME = "hurricane-card.js"
FRONTEND_URL_BASE = "/hurricane_tracker_frontend"
