"""Data coordinator: polls NHC, selects storms, bakes draw-ready payloads.

All blocking work (network + shapefile parse + basemap clip) runs in an executor
so the event loop is never touched. On a failed poll the coordinator keeps the
last-good data (DataUpdateCoordinator behaviour) and the card shows staleness.
"""
from __future__ import annotations

import logging
import time
from datetime import timedelta

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util.unit_system import METRIC_SYSTEM

from . import nhc
from .const import (
    CURRENT_STORMS_URL,
    NHC_LAT_MAX,
    NHC_LAT_MIN,
    NHC_LON_MAX,
    NHC_LON_MIN,
    POLL_MINUTES,
)
from .geometry import assemble_payload

_LOGGER = logging.getLogger(__name__)

MAX_STORMS = 8  # cap baked systems in "show all" mode (peak season safety)


def _in_coverage(lat, lon):
    return (NHC_LAT_MIN <= lat <= NHC_LAT_MAX) and (NHC_LON_MIN <= lon <= NHC_LON_MAX)


def _build(home_lat, home_lon, basin, units, storm_filter):
    """Blocking pipeline: fetch -> select -> bake. Returns the coordinator data
    dict. Runs inside an executor."""
    import json

    raw = nhc.http_get(CURRENT_STORMS_URL)
    active = (json.loads(raw) or {}).get("activeStorms") or []
    selected = nhc.select_storms(active, home_lat, home_lon, basin, storm_filter)

    if not selected:
        # No storm to show. If there are systems active but none matched the
        # explicit-basin filter, say so honestly rather than "all clear".
        reason = "clear" if not active else "none_matched"
        return {"ok": False, "reason": reason,
                "activeAnywhere": len(active), "ts": int(time.time() * 1000)}

    payloads = []
    for storm in selected[:MAX_STORMS]:
        try:
            fdata = nhc.fetch_storm_geometry(storm)
            if not fdata:
                continue
            pl = assemble_payload(storm, fdata, home_lat, home_lon, units)
            if pl:
                payloads.append(pl)
        except Exception as err:  # one bad storm shouldn't sink the whole poll
            _LOGGER.warning("hurricane_tracker: failed baking %s: %s",
                            storm.get("id"), err)

    if not payloads:
        return {"ok": False, "reason": "no_geometry",
                "activeAnywhere": len(active), "ts": int(time.time() * 1000)}

    return {"ok": True, "storms": payloads, "count": len(payloads),
            "ts": int(time.time() * 1000)}


class HurricaneCoordinator(DataUpdateCoordinator):
    """Owns the NHC poll + bake for one config entry."""

    def __init__(self, hass: HomeAssistant, entry) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name="hurricane_tracker",
            update_interval=timedelta(minutes=POLL_MINUTES),
        )
        self.entry = entry

    def _cfg(self):
        """Options override data (options flow is how settings get edited)."""
        from .const import (
            CONF_BASIN, CONF_FILTER, CONF_LATITUDE, CONF_LONGITUDE,
            CONF_OFF_SEASON, CONF_UNITS, DEFAULT_BASIN, DEFAULT_FILTER,
            DEFAULT_OFF_SEASON, UNIT_KM, UNIT_MI,
        )
        d = {**self.entry.data, **self.entry.options}
        lat = d.get(CONF_LATITUDE, self.hass.config.latitude)
        lon = d.get(CONF_LONGITUDE, self.hass.config.longitude)
        units = d.get(CONF_UNITS) or (
            UNIT_KM if self.hass.config.units is METRIC_SYSTEM else UNIT_MI)
        return {
            "lat": lat, "lon": lon,
            "basin": d.get(CONF_BASIN, DEFAULT_BASIN),
            "units": units,
            "filter": d.get(CONF_FILTER, DEFAULT_FILTER),
            "off_season": d.get(CONF_OFF_SEASON, DEFAULT_OFF_SEASON),
        }

    async def _async_update_data(self):
        cfg = self._cfg()
        if not _in_coverage(cfg["lat"], cfg["lon"]):
            # Home is outside NHC's world: loud, honest, and no pointless fetch.
            return {"ok": False, "reason": "not_covered",
                    "off_season": cfg["off_season"],
                    "ts": int(time.time() * 1000)}
        try:
            result = await self.hass.async_add_executor_job(
                _build, cfg["lat"], cfg["lon"], cfg["basin"], cfg["units"],
                cfg["filter"],
            )
        except Exception as err:
            raise UpdateFailed(f"NHC update failed: {err}") from err
        result["off_season"] = cfg["off_season"]
        return result
