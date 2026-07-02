"""A single summary sensor. Scalars only — the heavy geometry goes over the
websocket, never into entity attributes (recorder health)."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import HurricaneCoordinator

_REASON_STATE = {
    "clear": "clear",
    "not_covered": "not covered",
    "none_matched": "clear",
    "no_geometry": "unavailable",
}


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([HurricaneSensor(coordinator, entry)])


class HurricaneSensor(CoordinatorEntity[HurricaneCoordinator], SensorEntity):
    _attr_has_entity_name = True
    _attr_name = "Storm"
    _attr_icon = "mdi:weather-hurricane"

    def __init__(self, coordinator: HurricaneCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_storm"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Hurricane Tracker",
            manufacturer="NHC / NOAA",
            entry_type=None,
        )

    @property
    def native_value(self):
        data = self.coordinator.data or {}
        if not data.get("ok"):
            return _REASON_STATE.get(data.get("reason"), "clear")
        storms = data.get("storms") or []
        if not storms:
            return "clear"
        return (storms[0].get("meta") or {}).get("name") or "Active storm"

    @property
    def extra_state_attributes(self):
        data = self.coordinator.data or {}
        if not data.get("ok"):
            return {"active": False, "reason": data.get("reason")}
        storms = data.get("storms") or []
        if not storms:
            return {"active": False}
        m = storms[0].get("meta") or {}
        return {
            "active": True,
            "count": data.get("count"),
            "category": m.get("cat"),
            "classification": m.get("type"),
            "wind": m.get("wind"),
            "wind_unit": m.get("windUnit"),
            "gust": m.get("gust"),
            "pressure_mb": m.get("mslp"),
            "movement": m.get("moveText"),
            "distance": m.get("dist"),
            "distance_unit": m.get("distUnit"),
            "basin": m.get("basinName"),
            "advisory": storms[0].get("advisory"),
        }
