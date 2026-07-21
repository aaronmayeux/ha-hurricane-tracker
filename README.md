# Hurricane Tracker for Home Assistant

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=aaronmayeux&repository=ha-hurricane-tracker&category=integration)

Draws a live tropical-cyclone forecast cone on a Lovelace card — the cone of
uncertainty, past and forecast tracks, Saffir–Simpson forecast points, coastal
watch/warning segments, region labels, your home location, and a data bar
underneath. **Covers storms worldwide.**

The integration polls the U.S. [National Hurricane Center](https://www.nhc.noaa.gov/)
(NHC) for the Atlantic and East/Central Pacific, and
[GDACS](https://www.gdacs.org/) (the EU's Global Disaster Alert and Coordination
System) for every other basin. It parses the storm geometry, picks the storms
that match your chosen scope, clips a bundled global coastline basemap to each
storm, and hands the card a ready-to-draw payload over an authenticated
websocket. The card is a single vanilla-JS file that the integration loads for
you automatically — no manual dashboard resource to add.

## Features

- **Global coverage** — Atlantic, East/Central Pacific (NHC), plus Northwest
  Pacific, North Indian, Southwest Indian, Australian region, and South Pacific
  (GDACS).
- Cone of uncertainty, past track, forecast track, and forecast dots colored by
  Saffir–Simpson category.
- Coastal watch/warning segments in the official NHC colors (Atlantic/Pacific;
  GDACS basins don't publish these).
- Map overlays: region/country labels, an off-screen home marker that points
  toward home when it's outside the frame, and a far-offshore mileage scale.
- **Pan and zoom** — drag, pinch, or scroll to explore around the storm;
  a Recenter button restores the default frame, or lock the map from the gear
  menu to keep it put.
- **Live weather imagery** — optionally draw GOES-East satellite (color-enhanced
  infrared) or U.S. radar under the cone, fetched on demand from the gear menu.
  Satellite covers the Atlantic and eastern Pacific; radar covers the U.S.;
  elsewhere the card shows a brief "no coverage" note.
- **Fits your dashboard automatically** — in a sections view the card
  drag-resizes like any other and fills whatever size you give it (panel views
  too). Wide, short cards move the storm info into a right-hand side column
  with a vertical wind timeline — no configuration, the card decides from its
  own shape.
- Distance from your home, current intensity, movement, and peak forecast
  category.
- Bundled offline global basemap built from Natural Earth and GeoNames (no map
  tiles, no API keys).
- **Auto-themes to your dashboard** — every color follows your active Home
  Assistant theme out of the box, and any of them can be overridden per card.
- Miles/mph or kilometers/km-h.
- A quiet "all clear" state in the off-season, or hide the card entirely.

## Requirements

- Home Assistant **2024.8.0** or newer.
- HACS installed (for the install path below).
- A home location anywhere on Earth — coverage is global.

No Python dependencies — the integration parses everything with the standard
library.

## Installation (HACS)

**One-click** — click this badge, and it opens your Home Assistant with the
add-repository screen pre-filled. Confirm it, click **Download**, and restart HA:

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=aaronmayeux&repository=ha-hurricane-tracker&category=integration)

**Or add it manually:**

1. In Home Assistant, open **HACS**.
2. Click the three-dot menu (top right) → **Custom repositories**.
3. Paste the repository URL: `https://github.com/aaronmayeux/ha-hurricane-tracker`
4. Set **Type** to **Integration**, then click **Add**.
5. Find **Hurricane Tracker** in the HACS list and click **Download**.
6. **Restart Home Assistant** when prompted.

## Setup

1. Go to **Settings → Devices & Services → Add Integration**.
2. Search for **Hurricane Tracker** and select it.
3. Fill in the options:

   | Option | What it does |
   |---|---|
   | **Home location** | Map pin used for distance and storm selection. Defaults to your HA location. |
   | **Storms to show** | Scope — one of: **My region** (storms in your home basin only), **Within range** (any storm within the range below), **Global** (every active storm on Earth), or a single named basin (Atlantic, East Pacific, Central Pacific, Northwest Pacific, North Indian, Southwest Indian, Australian region, South Pacific). Defaults to **My region**. |
   | **Range for "within range"** | Only used when scope is **Within range**. Radius from home, in your chosen units. Default 1500. |
   | **Units** | Miles/mph or kilometers/km-h. Defaults to your HA unit system. |
   | **When no storms are active** | Show a calm "all clear" state, or hide the card entirely. |
   | **Which storms to show** | Show only the storm threatening/closest to home, or all active systems (the card cycles through them). |

All of these are editable later via the integration's **Configure** button.

## Adding the card

Once the integration is set up, the card loads automatically — you don't add a
dashboard resource by hand. Add it to any dashboard:

```yaml
type: custom:hurricane-card
```

Or pick **Hurricane Tracker** from the card picker. With no options at all it
inherits your dashboard theme and shows everything.

## Card options and theming

**The card auto-themes by default.** Every part of the map and data bar reads
your active Home Assistant theme — background, land, coastlines, state lines,
region labels, cone, tracks, and text all follow theme variables, so the card
matches your dashboard in both light and dark without any configuration.

You only add options to override that. Two exceptions that are **fixed on
purpose and can't be recolored**: the Saffir–Simpson category dot colors and
the NHC watch/warning segment colors. Those encode storm severity — a Category 3
dot and a Hurricane Warning must read the same on every theme.

All options are optional and can be set in YAML or in the card's visual editor.

```yaml
type: custom:hurricane-card
title: Storms near us
coast_color: "#7fd1ff"     # override just the coastline; everything else stays on-theme
show_scale: false
```

### Layer toggles (all default on)

| Option | Effect |
|---|---|
| `show_land` | Land fill. |
| `show_coast` | Coastlines. |
| `show_states` | State/province border lines. |
| `show_cities` | City dots + names (populated places from GeoNames, biggest first). |
| `show_labels` | Region/country name labels. |
| `show_scale` | Far-offshore mileage scale (only appears when home is off-frame). |
| `show_home` | Home marker. |
| `show_winds` | Wind-field wash under the cone (Atlantic/Pacific storms only). |
| `smooth` | Smooth (curved) coastlines vs. straight segments. |

### Map layers (gear menu on the card)

The gear button on the map opens per-viewer layer settings. Your layer choices
**sync across your devices** — the same Home Assistant login shows the same
layers on a phone and a wall tablet, and flipping one pushes live to the others.
On-demand layers fetch their data **only when switched on**, so they never add to
the integration's background polling and the baseline card stays cheap on
low-end hardware. (Where each block *sits* — the data bar and the at-home wind
graph — is remembered per device instead, since that depends on the screen.)
Tapping anywhere outside the panel closes it.

**Three-way toggles** — sibling pairs that would fight for the same map space,
so one draws at a time (left = default, middle = off, right = the alternate):

| Group | Left (default) | Right | Notes |
|---|---|---|---|
| Wind field | Current-position 34/50/64 kt field | Full-track wind swath | `show_winds` card config is the master on/off. |
| Place dots | City dots + names (top places) | Population density — the mapped places in view, dot size scaled by population, fading with distance from the projected path; adds a "~X people in the cone" line to the data bar (mapped places with population ≥ 5,000 only, so it's an undercount) | `show_cities` card config is the master on/off. |
| Coastal stripe | Watch/warning segments | Peak storm surge inundation bands + "surge at home" (fetched on demand) | Atlantic/East Pacific/Central Pacific storms only. |
| Imagery | Satellite (GOES-East color-enhanced IR) | Radar (NOAA MRMS reflectivity) | **Off by default** (center). Drawn under the cone, fetched on demand. Satellite covers the Atlantic/eastern Pacific; radar the U.S.; elsewhere a "no coverage" note. |

**On-demand layers:**

| Layer | What it shows |
|---|---|
| Forecast model tracks | Guidance ("spaghetti") tracks from the NHC forecast models — NHC Official, consensus, GFS, HAFS-A, UKMET. Atlantic/East Pacific/Central Pacific storms only; other basins don't publish per-model tracks. |
| Advisory text | The storm's full advisory / alert text in an overlay. |

### Colors and style (default = follow theme)

| Option | Controls | In visual editor? |
|---|---|---|
| `background_color` | Map background | Yes |
| `land_color` | Land fill color | Yes |
| `land_opacity` | Land fill opacity (0–1) | **YAML only** |
| `coast_color` | Coastline color | Yes |
| `coast_width` | Coastline stroke width | **YAML only** |
| `coast_opacity` | Coastline opacity (0–1) | **YAML only** |
| `state_color` | State/province line color | Yes |
| `state_width` | State/province line width | **YAML only** |
| `region_color` | Region label color | Yes |
| `cone_color` | Cone of uncertainty color | Yes |
| `track_color` | Forecast track color | Yes |
| `track_past_color` | Past-track color | **YAML only** |
| `title` | Header text override | Yes |

The visual editor exposes the title, all seven toggles, and seven of the colors,
each with a **reset** button that clears the override and returns that element to
your theme. The five rows marked **YAML only** (`land_opacity`, `coast_width`,
`coast_opacity`, `state_width`, `track_past_color`) aren't in the editor — set
them in YAML if you need them.

## Troubleshooting

**"Custom element doesn't exist: hurricane-card"** means the card's JavaScript
hasn't loaded in your browser yet. The card only loads *after* the integration
itself is set up, in this order:

1. Add the integration under **Settings → Devices & Services → Add Integration**
   (downloading it in HACS is not enough — the integration has to be added here).
2. **Restart Home Assistant** if you haven't since installing.
3. **Hard-refresh your browser** (Ctrl/Cmd+Shift+R), or fully close and reopen the
   app — the browser caches the old dashboard and won't see the card until you do.

If you've done all three and still see the error, open
**Settings → System → Logs**, search for `hurricane_tracker`, and
[file an issue](https://github.com/aaronmayeux/ha-hurricane-tracker/issues) with
what you find.

**The same error, but only on a full-page (panel) dashboard, and only on the
first load after clearing your cache?** The card's JavaScript is loaded on
demand, and a panel-view dashboard can occasionally try to draw the card a moment
before that script finishes loading on a cold browser cache — so you briefly see
"custom element doesn't exist." A single refresh fixes it, and it won't recur
once the script is cached. Regular masonry and sections dashboards don't hit
this. If it bothers you, put the card on a normal (non-panel) view.

**"Storm active — map unavailable"** (or "Storm feed unavailable") means a data
source timed out or errored on that poll. It is deliberately **not** an all-clear:
if a storm's map can't be loaded, the card says so rather than showing a calm sky.
The card retries automatically on the next poll. If a storm was drawn recently,
the last good map stays up with a "showing last update" note instead of vanishing.

## How storm selection works

- **Scope** (the *Storms to show* option) decides which storms are eligible:
  your home basin only, everything within a range of home, the whole globe, or
  one specific basin.
- **Which storms to show** then decides how the eligible storms are presented:
  the single storm threatening or closest to home (default), or all of them with
  a pager on the card to cycle between them.
- Where NHC and GDACS overlap, NHC's official cone is used; GDACS fills the
  basins NHC doesn't forecast.

## Changing settings from automations and dashboards

Every setting is editable from the integration's **Configure** button, but you
can also change it live — from a dashboard control, a script, or an automation.
The integration exposes its settings two ways; both take effect immediately and
reload the integration.

### Entities (the easy way)

Under the **Hurricane Tracker** device you'll find control entities whose current
value is the live setting — so they double as a readout of what's configured:

| Entity | Setting it controls |
|---|---|
| `select.hurricane_tracker_storms_to_show` | Scope / basin (My region, Within range, Global, or a specific basin). |
| `select.hurricane_tracker_which_storms` | Threatening/closest storm only, or all active systems. |
| `select.hurricane_tracker_units` | Miles or kilometers. |
| `number.hurricane_tracker_range` | The "within range" radius, in your configured unit. |

Drop them on a dashboard and change them like any other select or number, or set
them from an automation:

```yaml
service: select.select_option
target:
  entity_id: select.hurricane_tracker_storms_to_show
data:
  option: Anywhere in the world
```

### `hurricane_tracker.set_options` service (for scripting)

A single service changes any subset of settings in one call — handy in scripts.
Any field you leave out is unchanged:

```yaml
service: hurricane_tracker.set_options
data:
  basin: atlantic
  storm_filter: all
  range: 800
  units: mi
  off_season: calm
```

Valid values: **basin** — `auto`, `range`, `global`, `atlantic`, `east_pacific`,
`central_pacific`, `nw_pacific`, `north_indian`, `sw_indian`, `australian`,
`south_pacific`; **storm_filter** — `threat`, `all`; **units** — `mi`, `km`;
**off_season** — `calm`, `hide`; **range** — a number (100–6000).

## Sensors for automations

The **Hurricane Tracker** device also exposes read-only sensors that describe the
primary (closest/threatening) storm, so you can trigger automations on it. The
heavy map geometry never rides on entity state — these are plain scalars.

| Entity | State |
|---|---|
| `sensor.hurricane_tracker_storm` | Storm name, or `clear` / `unavailable`. |
| `sensor.hurricane_tracker_distance` | Distance from home to the storm. |
| `sensor.hurricane_tracker_closest_approach` | Forecast closest approach. |
| `sensor.hurricane_tracker_category` | Category token (`TD`, `TS`, `1`–`5`, `HU`). |
| `binary_sensor.hurricane_tracker_watch_or_warning` | On when the storm carries an NHC watch/warning (NHC basins only). |

The summary `sensor.hurricane_tracker_storm` carries the details as attributes:
`category`, `classification`, `wind`, `gust`, `pressure_mb`, `movement`,
`distance`, `closest_approach`, `closest_approach_hours`, `basin`, and `advisory`.

For storms sourced from GDACS (every basin outside the NHC's), four more
attributes carry GDACS's own official alert data — absent on NHC storms:

| Attribute | Meaning |
|---|---|
| `gdacs_alert_level` | GDACS alert tier: `Green`, `Orange`, or `Red`. |
| `gdacs_alert_score` | Numeric alert score (0–3). |
| `affected_countries` | Countries GDACS lists as affected, by name. |
| `affected_iso` | The same countries as ISO-2 codes. |

## Data sources and credits

- **NHC / CPHC** — Atlantic and East/Central Pacific storms and GIS
  (`https://www.nhc.noaa.gov/CurrentStorms.json` and linked advisory
  shapefiles).
- **GDACS** — all other basins, via the Global Disaster Alert and Coordination
  System (GDACS), a joint framework of the European Commission and the United
  Nations. GDACS reconstructs track and forecast points from time-labelled
  uncertainty circles, so those basins carry slightly coarser per-point detail
  than NHC's.
- **Basemap** — coastlines, land, and admin-1 border lines from
  [Natural Earth](https://www.naturalearthdata.com/) (public domain); city and
  town points (names, positions, populations) from the
  [GeoNames](https://www.geonames.org/) cities5000 dataset, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- **Weather imagery** (optional, on demand) — satellite from the
  [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) GOES-East
  service; radar from [NOAA nowCOAST](https://nowcoast.noaa.gov/) (MRMS). Both
  public domain, and fetched only when you turn the imagery layer on.

Storm sources are polled every 30 minutes. This project is not affiliated with or
endorsed by NOAA/NHC, GDACS, the European Commission, Natural Earth, or
GeoNames.

## License

[MIT](LICENSE)
