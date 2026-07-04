"""Sensors for Hurricane Tracker.

A human summary sensor (storm name/state) plus machine-friendly scalars that make
the storm automatable and screen-reader accessible without ever touching the map:
current distance to home, forecast closest approach, and category. Scalars only —
the heavy geometry rides the websocket, never entity attributes (recorder health).
Every entity describes the primary (closest/threatening) storm, storms[0].
"""
from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfLength
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, UNIT_KM
from .coordinator import HurricaneCoordinator

_REASON_STATE = {
    "clear": "clear",
    "not_covered": "not covered",
    "none_matched": "clear",
    "no_geometry": "unavailable",
}

_CAT_LABEL = {
    "TD": "Tropical Depression", "TS": "Tropical Storm",
    "1": "Category 1", "2": "Category 2", "3": "Category 3",
    "4": "Category 4", "5": "Category 5",
}


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    units = coordinator._cfg()["units"]
    length_unit = UnitOfLength.KILOMETERS if units == UNIT_KM else UnitOfLength.MILES
    async_add_entities([
        HurricaneSensor(coordinator, entry),
        HurricaneDistanceSensor(coordinator, entry, length_unit),
        HurricaneClosestApproachSensor(coordinator, entry, length_unit),
        HurricaneCategorySensor(coordinator, entry),
    ])


class _HurricaneEntity(CoordinatorEntity[HurricaneCoordinator], SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: HurricaneCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
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

    def _meta(self):
        s = self._primary()
        return (s.get("meta") or {}) if s else {}


class HurricaneSensor(_HurricaneEntity):
    """Human summary: state is the storm name (or 'clear'). The at-a-glance card
    complement; the scalar sensors below are the automatable channel."""

    _attr_name = "Storm"
    _attr_icon = "mdi:weather-hurricane"

    def __init__(self, coordinator: HurricaneCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_storm"

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
            "closest_approach": m.get("cpaDist"),
            "closest_approach_hours": m.get("cpaHours"),
            "basin": m.get("basinName"),
            "advisory": storms[0].get("advisory"),
        }


class HurricaneDistanceSensor(_HurricaneEntity):
    """Current great-circle distance from home to the storm center. Unknown when
    clear. (For NHC storms Phase 3 will upgrade this to distance-from-winds.)"""

    _attr_name = "Distance"
    _attr_icon = "mdi:map-marker-distance"
    _attr_device_class = SensorDeviceClass.DISTANCE
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator, entry, length_unit) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_distance"
        self._attr_native_unit_of_measurement = length_unit

    @property
    def native_value(self):
        return self._meta().get("dist")


class HurricaneClosestApproachSensor(_HurricaneEntity):
    """Forecast closest approach: how near the storm center is projected to come.
    The `hours` attribute is the forecast lead time to that pass (None for GDACS,
    which carries no forecast hour). Unknown when clear."""

    _attr_name = "Closest approach"
    _attr_icon = "mdi:map-marker-radius"
    _attr_device_class = SensorDeviceClass.DISTANCE
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator, entry, length_unit) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_closest_approach"
        self._attr_native_unit_of_measurement = length_unit

    @property
    def native_value(self):
        return self._meta().get("cpaDist")

    @property
    def extra_state_attributes(self):
        return {"hours": self._meta().get("cpaHours")}


class HurricaneCategorySensor(_HurricaneEntity):
    """Storm category token: TD, TS, or 1..5. `label` attribute spells it out.
    Unknown when clear."""

    _attr_name = "Category"
    _attr_icon = "mdi:weather-hurricane"

    def __init__(self, coordinator, entry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_category"

    @property
    def native_value(self):
        return self._meta().get("cat") or None

    @property
    def extra_state_attributes(self):
        return {"label": _CAT_LABEL.get(self._meta().get("cat"), "")}
