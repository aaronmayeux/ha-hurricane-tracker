"""Binary sensors for Hurricane Tracker.

Automatable/accessible booleans about the primary (closest/threatening) storm,
storms[0]. No map involvement.
"""
from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import HurricaneCoordinator

_WW_LABEL = {
    "TWA": "Tropical Storm Watch", "TWR": "Tropical Storm Warning",
    "HWA": "Hurricane Watch", "HWR": "Hurricane Warning",
}


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([HurricaneWatchWarningBinarySensor(coordinator, entry)])


class _HurricaneBinary(CoordinatorEntity[HurricaneCoordinator], BinarySensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: HurricaneCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Hurricane Tracker",
            manufacturer="NHC/NOAA + GDACS (JRC)",
            entry_type=None,
        )

    def _primary(self):
        """The primary (closest/threatening) storm payload, or None when clear."""
        data = self.coordinator.data or {}
        if not data.get("ok"):
            return None
        storms = data.get("storms") or []
        return storms[0] if storms else None


class HurricaneWatchWarningBinarySensor(_HurricaneBinary):
    """On when the primary storm carries active NHC coastal watches/warnings.

    NHC-only: GDACS provides no watch/warning segments, so this reads off for GDACS
    storms and when clear. Not home-specific -- it reflects whether the storm has
    any NHC watch/warning in effect, the automatable signal we actually have.
    """

    _attr_name = "Watch or warning"
    _attr_icon = "mdi:alert"

    def __init__(self, coordinator, entry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_watch_warning"

    @property
    def is_on(self):
        s = self._primary()
        return bool(s.get("ww")) if s else False

    @property
    def extra_state_attributes(self):
        s = self._primary()
        codes = sorted({(seg.get("type") or "").upper()
                        for seg in (s.get("ww") or [])}) if s else []
        return {"types": [_WW_LABEL.get(c, c) for c in codes if c]}
