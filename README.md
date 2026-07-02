# Hurricane Tracker for Home Assistant

Draws a live [National Hurricane Center](https://www.nhc.noaa.gov/) forecast
cone on a Lovelace card — the cone of uncertainty, the past and forecast
tracks, Saffir–Simpson forecast points, coastal watch/warning segments, your
home location, and a data bar underneath. Covers the **Atlantic** and
**East/Central Pacific** basins.

The integration polls NHC, parses the GIS shapefiles, picks the storm nearest
or most threatening to your home, clips a bundled coastline basemap to the
storm, and hands the card a ready-to-draw payload over a websocket. The card
is a single vanilla-JS file that the integration loads for you automatically —
no manual dashboard resource to add.

## Features

- Atlantic + East Pacific + Central Pacific storms
- Cone of uncertainty, past track, forecast track, and forecast dots colored by
  Saffir–Simpson category
- Coastal watch/warning segments in the official NHC colors
- Distance from your home, current intensity, movement, and peak forecast
  category
- Bundled offline coastline/state basemap (no map tiles or API keys)
- "All clear" state in the off-season, or hide the card entirely — your choice
- Miles/mph or kilometers/km-h

## Requirements

- Home Assistant **2024.8.0** or newer
- HACS installed (for the easy install path below)
- A home location inside NHC's forecast area (roughly longitude −180…15,
  latitude −10…80). A home outside it shows a clear "region not covered" note
  instead of an empty card.

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
   | **Basin** | Auto (from your location), or force Atlantic / East Pacific / Central Pacific. |
   | **Units** | Miles/mph or kilometers/km-h. Defaults to your HA unit system. |
   | **Off-season display** | Show a calm "all clear" state, or hide the card entirely. |
   | **Storm filter** | Show only the storm threatening/closest to home, or all active systems (the card cycles through them). |

All of these are editable later via the integration's **Configure** button.

## Adding the card

The card auto-loads, so you usually just add it to a dashboard:

```yaml
type: custom:hurricane-card
```

It needs no configuration of its own — everything comes from the integration.

## How storm selection works

- **Threat** filter (default): shows the storm whose motion points toward your
  home; if none is approaching, the closest one.
- **All** filter: exposes every active system and the card shows a pager to
  cycle between them.
- **Auto** basin: prefers the basin your home sits in; if that basin is quiet,
  falls through to the closest storm elsewhere.

## Data source

Storm data and GIS come from the U.S. National Hurricane Center
(`https://www.nhc.noaa.gov/CurrentStorms.json` and the linked advisory
shapefiles), polled every 30 minutes. This project is not affiliated with or
endorsed by NOAA/NHC.

## License

[MIT](LICENSE)
