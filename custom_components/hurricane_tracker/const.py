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

# --- basin ------------------------------------------------------------------
BASIN_AUTO = "auto"
BASIN_ATLANTIC = "atlantic"
BASIN_EAST_PACIFIC = "east_pacific"
BASIN_CENTRAL_PACIFIC = "central_pacific"
BASINS = [BASIN_AUTO, BASIN_ATLANTIC, BASIN_EAST_PACIFIC, BASIN_CENTRAL_PACIFIC]

# NHC storm-id 2-letter basin prefixes -> our basin keys.
BASIN_PREFIX = {"al": BASIN_ATLANTIC, "ep": BASIN_EAST_PACIFIC, "cp": BASIN_CENTRAL_PACIFIC}
# Human names (no jargon in the UI).
BASIN_NAME = {
    BASIN_ATLANTIC: "Atlantic",
    BASIN_EAST_PACIFIC: "East Pacific",
    BASIN_CENTRAL_PACIFIC: "Central Pacific",
}
# Fall-through priority for AUTO basin (Atlantic preferred, then EP, then CP).
BASIN_RANK = {BASIN_ATLANTIC: 0, BASIN_EAST_PACIFIC: 1, BASIN_CENTRAL_PACIFIC: 2}

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

# --- polling ----------------------------------------------------------------
# NHC issues full advisories every 6h (00/06/12/18 UTC) and intermediate
# advisories every 3h (2h with coastal watches/warnings). 30 min catches the
# intermediates comfortably without hammering a government server.
POLL_MINUTES = 30

# --- NHC coverage window (home OUTSIDE this => "your region isn't covered") --
# NHC/CPHC forecast the Atlantic + E/Central Pacific only. This is the region
# their areas of responsibility live in; a home outside it gets a loud, honest
# "not covered" state instead of a silent empty card.
NHC_LON_MIN, NHC_LON_MAX = -180.0, 15.0
NHC_LAT_MIN, NHC_LAT_MAX = -10.0, 80.0

# --- sources ----------------------------------------------------------------
CURRENT_STORMS_URL = "https://www.nhc.noaa.gov/CurrentStorms.json"
HTTP_TIMEOUT = 45
USER_AGENT = "ha-hurricane-tracker (Home Assistant custom integration)"

# --- past-track trail -------------------------------------------------------
# Miles of TRAVEL kept behind the storm, so a fast and a slow storm trail the
# same physical length on screen (consistent zoom).
PAST_MILES = 110

# --- frontend ---------------------------------------------------------------
CARD_FILENAME = "hurricane-card.js"
FRONTEND_URL_BASE = "/hurricane_tracker_frontend"
