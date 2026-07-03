# Hurricane Tracker for Home Assistant

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
- Distance from your home, current intensity, movement, and peak forecast
  category.
- Bundled offline global basemap built from Natural Earth (no map tiles, no API
  keys).
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

## Installation (HACS — custom repository)

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
| `show_labels` | Region/country name labels. |
| `show_scale` | Far-offshore mileage scale (only appears when home is off-frame). |
| `show_home` | Home marker. |
| `smooth` | Smooth (curved) coastlines vs. straight segments. |

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

## How storm selection works

- **Scope** (the *Storms to show* option) decides which storms are eligible:
  your home basin only, everything within a range of home, the whole globe, or
  one specific basin.
- **Which storms to show** then decides how the eligible storms are presented:
  the single storm threatening or closest to home (default), or all of them with
  a pager on the card to cycle between them.
- Where NHC and GDACS overlap, NHC's official cone is used; GDACS fills the
  basins NHC doesn't forecast.

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
  [Natural Earth](https://www.naturalearthdata.com/) (public domain).

Sources are polled every 30 minutes. This project is not affiliated with or
endorsed by NOAA/NHC, GDACS, the European Commission, or Natural Earth.

## License

[MIT](LICENSE)
