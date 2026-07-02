"""Hurricane Tracker integration setup.

Registers the data coordinator, a small sensor, a websocket command the card
uses to pull the (large) draw-ready geometry, and auto-serves + auto-loads the
card JS so the user never has to add a dashboard resource by hand.
"""
from __future__ import annotations

import logging
import os

import voluptuous as vol
from homeassistant.components import frontend, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback

from .const import CARD_FILENAME, DOMAIN, FRONTEND_URL_BASE
from .coordinator import HurricaneCoordinator

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.SENSOR]
_CARD_URL = f"{FRONTEND_URL_BASE}/{CARD_FILENAME}"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator = HurricaneCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_reload_on_change))

    await _async_register_frontend(hass)
    _register_ws(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unloaded


async def _reload_on_change(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


# ---------------------------------------------------------------------------
# Frontend: serve + auto-load the card
# ---------------------------------------------------------------------------
async def _async_register_frontend(hass: HomeAssistant) -> None:
    if hass.data.get(f"{DOMAIN}_frontend"):
        return
    hass.data[f"{DOMAIN}_frontend"] = True
    card_dir = os.path.dirname(__file__)
    await hass.http.async_register_static_paths([
        StaticPathConfig(FRONTEND_URL_BASE, card_dir, cache_headers=False)
    ])
    # add_extra_js_url loads the card as a module on every dashboard, so it
    # appears in the card picker with no manual resource step.
    frontend.add_extra_js_url(hass, _CARD_URL)


# ---------------------------------------------------------------------------
# Websocket: the card pulls the heavy geometry here (authenticated, not stored
# in the recorder like a big entity attribute would be).
# ---------------------------------------------------------------------------
@callback
def _register_ws(hass: HomeAssistant) -> None:
    if hass.data.get(f"{DOMAIN}_ws"):
        return
    hass.data[f"{DOMAIN}_ws"] = True

    @websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/data"})
    @callback
    def _ws_data(hass, connection, msg):
        store = hass.data.get(DOMAIN) or {}
        coordinator = next(iter(store.values()), None)
        payload = None
        if coordinator is not None:
            payload = {
                "data": coordinator.data,
                "last_success": coordinator.last_update_success,
            }
        connection.send_result(msg["id"], payload)

    websocket_api.async_register_command(hass, _ws_data)
