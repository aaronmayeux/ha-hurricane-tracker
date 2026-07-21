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
from homeassistant.loader import async_get_integration

from .const import (
    BASINS,
    CARD_FILENAME,
    CONF_BASIN,
    CONF_FILTER,
    CONF_OFF_SEASON,
    CONF_RANGE,
    CONF_UNITS,
    DOMAIN,
    FILTERS,
    FRONTEND_URL_BASE,
    IMAGERY_LAYERS,
    OFF_SEASON,
    SERVICE_SET_OPTIONS,
    UNITS,
)
from . import imagery, layers
from .coordinator import HurricaneCoordinator

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [
    Platform.SENSOR,
    Platform.BINARY_SENSOR,
    Platform.SELECT,
    Platform.NUMBER,
]
_CARD_URL = f"{FRONTEND_URL_BASE}/{CARD_FILENAME}"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    # Register the card + websocket FIRST, before the (network) first refresh.
    # If NHC is down at setup time the refresh raises ConfigEntryNotReady and HA
    # retries later -- but the card must still load so the dashboard resolves
    # `custom:hurricane-card` instead of erroring. Both are idempotent.
    await _async_register_frontend(hass)
    _register_ws(hass)
    _register_imagery_view(hass)
    _register_services(hass)

    coordinator = HurricaneCoordinator(hass, entry)
    # Load the persisted bake cache BEFORE the first refresh, so if a feed is
    # down at startup the first poll can already fall back to cached storms
    # instead of waking up blind (the gap the in-memory-only v0.1.6 cache left).
    await coordinator.async_hydrate_cache()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    # Do NOT block setup on the first poll. The per-storm bake -- especially the
    # slow/flaky GDACS geometry endpoint -- can take up to GDACS_GEOMETRY_TIMEOUT
    # (90 s) PER storm; with a couple of slow storms the first refresh has stalled
    # HA startup for ~3 min. On a Pi that can trip HA's setup watchdog and cascade
    # into other integrations. So we forward platforms now (entities register
    # immediately) and kick the first poll off in the background; the card renders
    # its normal "no data yet" state for one cycle until the poll lands. The
    # frontend/ws are already registered above, so the dashboard resolves the card
    # regardless. Persisted-cache hydrate already ran, so a startup-time outage can
    # still fall back to cached storms on that first background poll.
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_create_background_task(
        hass, coordinator.async_refresh(), "hurricane_tracker_first_refresh"
    )
    entry.async_on_unload(entry.add_update_listener(_reload_on_change))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unloaded


async def _reload_on_change(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


# ---------------------------------------------------------------------------
# Options control API: the ONE path that mutates entry.options.
# The set_options service and the select/number entities both call this. It
# merges validated changes into entry.options and hands off to HA's
# async_update_entry, which trips the update listener (_reload_on_change) so the
# coordinator reloads with the new settings. Keeping a single funnel means the
# service and the entities can never drift in how they apply a change.
# ---------------------------------------------------------------------------
def async_apply_options(
    hass: HomeAssistant, entry: ConfigEntry, changes: dict
) -> None:
    clean = {k: v for k, v in changes.items() if v is not None}
    if not clean:
        return
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, **clean}
    )


# ---------------------------------------------------------------------------
# Service: set_options -- the scripting / one-shot half of the public control
# API (the entities are the primary interface). Accepts any subset of the
# writable options; validates against the same value spaces the config flow
# uses; applies through async_apply_options. Registered once, entry-agnostic
# (single-instance integration), guarded like the websocket command.
# ---------------------------------------------------------------------------
@callback
def _register_services(hass: HomeAssistant) -> None:
    if hass.data.get(f"{DOMAIN}_services"):
        return
    hass.data[f"{DOMAIN}_services"] = True

    schema = vol.Schema({
        vol.Optional(CONF_BASIN): vol.In(BASINS),
        vol.Optional(CONF_FILTER): vol.In(FILTERS),
        vol.Optional(CONF_RANGE): vol.Coerce(float),
        vol.Optional(CONF_UNITS): vol.In(UNITS),
        vol.Optional(CONF_OFF_SEASON): vol.In(OFF_SEASON),
    })

    async def _set_options(call) -> None:
        entries = hass.config_entries.async_entries(DOMAIN)
        if not entries:
            return
        changes = {k: call.data[k] for k in call.data}
        async_apply_options(hass, entries[0], changes)

    hass.services.async_register(
        DOMAIN, SERVICE_SET_OPTIONS, _set_options, schema=schema
    )


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
    # appears in the card picker with no manual resource step. The ?v= is the
    # manifest version -- it forces browsers to fetch fresh JS after every
    # release instead of serving a stale cached card.
    integration = await async_get_integration(hass, DOMAIN)
    frontend.add_extra_js_url(hass, f"{_CARD_URL}?v={integration.version}")


# ---------------------------------------------------------------------------
# Imagery overlay (§13): an HTTP view streams cached raster PNG bytes to the
# card's <image> tag. The bytes ride HTTP (not the websocket), authenticated by
# the signed query param the layer websocket hands back. Registered once,
# entry-agnostic; the getter resolves the single coordinator's byte cache lazily
# at request time (the view is registered before the coordinator exists).
# ---------------------------------------------------------------------------
@callback
def _register_imagery_view(hass: HomeAssistant) -> None:
    if hass.data.get(f"{DOMAIN}_imagery_view"):
        return
    hass.data[f"{DOMAIN}_imagery_view"] = True

    def _imagery_cache():
        store = hass.data.get(DOMAIN) or {}
        coordinator = next(iter(store.values()), None)
        return getattr(coordinator, "imagery_cache", None)

    hass.http.register_view(imagery.ImageryView(_imagery_cache))


# ---------------------------------------------------------------------------
# Websocket: the card pulls the heavy geometry here (authenticated, not stored
# in the recorder like a big entity attribute would be). A second command
# serves the on-demand optional layers (Session E): the card asks only when a
# layer is toggled on; layers.py caches per advisory and soft-fails honestly.
# ---------------------------------------------------------------------------
@callback
def _register_ws(hass: HomeAssistant) -> None:
    if hass.data.get(f"{DOMAIN}_ws"):
        return
    hass.data[f"{DOMAIN}_ws"] = True

    def _coordinator():
        store = hass.data.get(DOMAIN) or {}
        return next(iter(store.values()), None)

    @websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/data"})
    @callback
    def _ws_data(hass, connection, msg):
        coordinator = _coordinator()
        payload = None
        if coordinator is not None:
            payload = {
                "data": coordinator.data,
                "last_success": coordinator.last_update_success,
            }
        connection.send_result(msg["id"], payload)

    @websocket_api.websocket_command({
        vol.Required("type"): f"{DOMAIN}/layer",
        vol.Required("storm_id"): str,
        vol.Required("layer"): str,
        # Imagery layers carry the card's current lng/lat frame so the backend
        # can request the raster over exactly what the card is drawing. Other
        # layers ignore it.
        vol.Optional("bbox"): [vol.Coerce(float)],
    })
    @websocket_api.async_response
    async def _ws_layer(hass, connection, msg):
        coordinator = _coordinator()
        if coordinator is None:
            connection.send_result(msg["id"], {"ok": False, "reason": "unavailable"})
            return
        layer = msg["layer"]
        if layer in IMAGERY_LAYERS:
            result = await imagery.async_get_imagery(
                hass, coordinator, layer, msg.get("bbox"), msg["storm_id"])
        else:
            result = await layers.async_get_layer(
                hass, coordinator, msg["storm_id"], layer)
        connection.send_result(msg["id"], result)

    websocket_api.async_register_command(hass, _ws_data)
    websocket_api.async_register_command(hass, _ws_layer)
