"""Config + options flow for Hurricane Tracker.

Single instance. Setup collects: home location (map picker, defaults to this
HA's configured location), basin, units, off-season display, and storm filter.
All of it is editable later through the options flow.
"""
from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers import selector
from homeassistant.util.unit_system import METRIC_SYSTEM

from .const import (
    BASIN_ATLANTIC,
    BASIN_AUTO,
    BASIN_CENTRAL_PACIFIC,
    BASIN_EAST_PACIFIC,
    CONF_BASIN,
    CONF_FILTER,
    CONF_LATITUDE,
    CONF_LOCATION,
    CONF_LONGITUDE,
    CONF_OFF_SEASON,
    CONF_UNITS,
    DEFAULT_BASIN,
    DEFAULT_FILTER,
    DEFAULT_OFF_SEASON,
    DOMAIN,
    FILTER_ALL,
    FILTER_THREAT,
    OFF_SEASON_CALM,
    OFF_SEASON_HIDE,
    UNIT_KM,
    UNIT_MI,
)

_BASIN_OPTS = [
    {"value": BASIN_AUTO, "label": "Auto (from home location)"},
    {"value": BASIN_ATLANTIC, "label": "Atlantic"},
    {"value": BASIN_EAST_PACIFIC, "label": "East Pacific"},
    {"value": BASIN_CENTRAL_PACIFIC, "label": "Central Pacific"},
]
_UNIT_OPTS = [
    {"value": UNIT_MI, "label": "Miles / mph"},
    {"value": UNIT_KM, "label": "Kilometers / km/h"},
]
_OFF_OPTS = [
    {"value": OFF_SEASON_CALM, "label": "Show a calm \u201call clear\u201d state"},
    {"value": OFF_SEASON_HIDE, "label": "Hide the card entirely"},
]
_FILTER_OPTS = [
    {"value": FILTER_THREAT, "label": "Storm threatening / closest to home"},
    {"value": FILTER_ALL, "label": "All active systems (card cycles)"},
]


def _select(options):
    return selector.SelectSelector(
        selector.SelectSelectorConfig(
            options=options, mode=selector.SelectSelectorMode.DROPDOWN
        )
    )


def _schema(hass, defaults: dict[str, Any]):
    loc_default = defaults.get(CONF_LOCATION) or {
        "latitude": hass.config.latitude,
        "longitude": hass.config.longitude,
    }
    unit_default = defaults.get(CONF_UNITS) or (
        UNIT_KM if hass.config.units is METRIC_SYSTEM else UNIT_MI)
    return vol.Schema({
        vol.Required(CONF_LOCATION, default=loc_default):
            selector.LocationSelector(),
        vol.Required(CONF_BASIN, default=defaults.get(CONF_BASIN, DEFAULT_BASIN)):
            _select(_BASIN_OPTS),
        vol.Required(CONF_UNITS, default=unit_default):
            _select(_UNIT_OPTS),
        vol.Required(CONF_OFF_SEASON,
                     default=defaults.get(CONF_OFF_SEASON, DEFAULT_OFF_SEASON)):
            _select(_OFF_OPTS),
        vol.Required(CONF_FILTER, default=defaults.get(CONF_FILTER, DEFAULT_FILTER)):
            _select(_FILTER_OPTS),
    })


def _flatten(user_input: dict[str, Any]) -> dict[str, Any]:
    """Lift the LocationSelector dict into flat lat/lon we store + read."""
    out = dict(user_input)
    loc = out.get(CONF_LOCATION) or {}
    out[CONF_LATITUDE] = loc.get("latitude")
    out[CONF_LONGITUDE] = loc.get("longitude")
    return out


class HurricaneConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the initial setup."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        # Single instance — one home, one card.
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            return self.async_create_entry(
                title="Hurricane Tracker", data=_flatten(user_input))
        return self.async_show_form(
            step_id="user", data_schema=_schema(self.hass, {}))

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return HurricaneOptionsFlow()


class HurricaneOptionsFlow(OptionsFlow):
    """Edit settings after setup. `self.config_entry` is supplied by HA."""

    async def async_step_init(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(title="", data=_flatten(user_input))
        current = {**self.config_entry.data, **self.config_entry.options}
        if current.get(CONF_LATITUDE) is not None:
            current[CONF_LOCATION] = {
                "latitude": current[CONF_LATITUDE],
                "longitude": current[CONF_LONGITUDE],
            }
        return self.async_show_form(
            step_id="init", data_schema=_schema(self.hass, current))
