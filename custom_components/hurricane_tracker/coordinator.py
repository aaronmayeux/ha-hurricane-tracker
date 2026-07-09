"""Data coordinator: polls NHC, selects storms, bakes draw-ready payloads.

All blocking work (network + shapefile parse + basemap clip) runs in an executor
so the event loop is never touched. On a failed poll the coordinator keeps the
last-good data (DataUpdateCoordinator behaviour) and the card shows staleness.

Per-storm bake cache (source-agnostic). The storm-list fetch is cheap and rarely
fails; the PER-STORM geometry fetch is the fragile part -- NHC shapefile zips and
GDACS's per-event geometry endpoint both go slow/flaky, and a single timeout used
to drop the storm off the card entirely (it still showed on the provider's own
site, so the card looked like an all-clear when it wasn't). Now every successful
bake is cached by storm id; if a later poll fails to bake that same storm, we serve
the last-good payload flagged `stale` (with the bake time) instead of dropping it.
A slightly old cone beats a vanished hurricane. Cache entries age out after
CACHE_MAX_AGE_MS so a genuinely-gone storm doesn't linger.
"""
from __future__ import annotations

import logging
import time
from datetime import timedelta

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util.unit_system import METRIC_SYSTEM

from . import gdacs, nhc
from .const import (
    CACHE_STORAGE_KEY,
    CACHE_STORAGE_VERSION,
    CURRENT_STORMS_URL,
    NHC_BASINS,
    POLL_MINUTES,
)
from .geometry import assemble_payload
from .repairs import sync_blind_outage_issue

# DEV-ONLY mock (real historical storm through the real path; see _dev_mock.py).
# Not present in the release clone -> this import cleanly no-ops there.
try:
    from . import _dev_mock
except Exception:  # pragma: no cover
    _dev_mock = None

_LOGGER = logging.getLogger(__name__)

MAX_STORMS = 8  # cap baked systems in "show all" mode (peak season safety)
_MI_PER_KM = 1.0 / 1.609344

# How long a cached bake is allowed to stand in for a failed re-bake. NHC and
# GDACS both reissue on the standard advisory cadence -- ~every 6 h -- so 9 h
# (1.5x that) rides out one fully-missed update cycle without holding a
# dissipated storm on screen indefinitely. Past this, the cache entry is dropped
# and the storm falls through to the unavailable/none_matched/clear logic.
CACHE_MAX_AGE_MS = 9 * 60 * 60 * 1000

# Delay-save window for the persisted cache. The cache changes at most once per
# 30-min poll, so this delay isn't throttling a busy stream -- it exists to
# coalesce the one burst case (hydrate + first poll seconds apart on startup)
# into a single write, and to keep the write off the critical path. Combined
# with change-gating (we only call save when the cache actually changed), the
# real write rate is ~2/hour, gentle on SD cards.
CACHE_SAVE_DELAY_S = 30


def _cache_signature(cache):
    """Cheap change-detector: the set of (id, ts) pairs. _build mutates the
    cache in an executor thread; comparing this before/after on the event loop
    tells us whether to persist, without threading a flag out of the executor.
    Fresh bakes change a ts, prunes drop a pair -- both shift the signature."""
    return frozenset((k, v["ts"]) for k, v in cache.items())


class _CacheStore(Store):
    """Store subclass whose migration discards old data. HA invokes
    `_async_migrate_func` on a version mismatch; the base class raises
    NotImplementedError, so without this a future CACHE_STORAGE_VERSION bump
    would warn on every load. A cached bake is disposable -- drop it, the next
    poll rebuilds it -- so we just return an empty cache."""

    async def _async_migrate_func(self, old_major, old_minor, old_data):
        return {"entries": {}}


def _build(home_lat, home_lon, basin, units, storm_filter, range_mi=None,
           cache=None):
    """Blocking pipeline: fetch (NHC + GDACS) -> merge/dedupe -> select -> bake.
    Returns the coordinator data dict. Runs inside an executor.

    `cache` is the coordinator's per-storm bake cache {id: {payload, ts}}, passed
    in so it survives across polls. Mutated in place: fresh bakes overwrite,
    stale-but-usable entries are served on failure, expired entries are pruned.
    """
    import json

    if cache is None:
        cache = {}
    now_ms = int(time.time() * 1000)

    if _dev_mock is not None and getattr(_dev_mock, "ENABLED", False):
        mock = _dev_mock.build(home_lat, home_lon, units)
        if mock:
            return mock

    active = []
    errors = []
    # NHC: Atlantic + E/Central Pacific, native cone.
    try:
        raw = nhc.http_get(CURRENT_STORMS_URL)
        active += (json.loads(raw) or {}).get("activeStorms") or []
    except Exception as err:  # one source down shouldn't blind the other
        _LOGGER.warning("hurricane_tracker: NHC fetch failed: %s", err)
        errors.append("NHC")
    # GDACS: rest of the world. Drop any GDACS storm sitting in an NHC basin so
    # NHC's official cone wins there (dedupe).
    try:
        gstorms = [s for s in gdacs.list_storms()
                   if nhc.storm_basin(s) not in NHC_BASINS]
        active += gstorms
    except Exception as err:
        _LOGGER.warning("hurricane_tracker: GDACS fetch failed: %s", err)
        errors.append("GDACS")

    selected = nhc.select_storms(active, home_lat, home_lon, basin,
                                 storm_filter, range_mi)

    if not selected:
        # No storm to show. Three distinct cases, and we must NOT conflate them:
        #  - a source errored and nothing came through -> we're partly/fully blind;
        #    say "unavailable", never "all clear" (a user in a live basin would be
        #    falsely reassured).
        #  - systems are active but none matched this card's scope -> "none_matched".
        #  - everything fetched clean and the ocean is genuinely empty -> "clear".
        if errors and not active:
            reason = "unavailable"
        elif active:
            reason = "none_matched"
        else:
            reason = "clear"
        return {"ok": False, "reason": reason,
                "activeAnywhere": len(active),
                "failedSources": errors,
                "ts": now_ms}

    payloads = []
    baked_ok = False        # did at least one storm bake fresh this poll?
    bake_failed_sources = set()   # which sources had a storm fail to bake
    for storm in selected[:MAX_STORMS]:
        sid = storm.get("id")
        is_gdacs = bool(storm.get("_gdacs"))
        try:
            if is_gdacs:
                fdata = gdacs.fetch_storm_geometry(storm)
            else:
                fdata = nhc.fetch_storm_geometry(storm)
            pl = assemble_payload(storm, fdata, home_lat, home_lon, units) if fdata else None
            if pl:
                # Fresh, good bake: serve it and cache it (not stale).
                pl["stale"] = False
                payloads.append(pl)
                if sid:
                    cache[sid] = {"payload": pl, "ts": now_ms}
                baked_ok = True
                continue
            # fdata/payload empty but no exception -> fall through to cache below
            raise ValueError("empty geometry")
        except Exception as err:
            _LOGGER.warning("hurricane_tracker: failed baking %s: %s", sid, err)
            bake_failed_sources.add("GDACS" if is_gdacs else "NHC")
            # Fall back to the last-good bake if we have one and it's fresh enough.
            ent = cache.get(sid) if sid else None
            if ent and (now_ms - ent["ts"]) <= CACHE_MAX_AGE_MS:
                stale_pl = dict(ent["payload"])
                stale_pl["stale"] = True
                stale_pl["bakedTs"] = ent["ts"]     # epoch-ms; card formats local
                payloads.append(stale_pl)
                _LOGGER.info("hurricane_tracker: serving cached %s (%.0f min old)",
                             sid, (now_ms - ent["ts"]) / 60000.0)

    # prune expired cache entries so a dead storm doesn't haunt the cache
    for sid in [k for k, v in cache.items() if now_ms - v["ts"] > CACHE_MAX_AGE_MS]:
        cache.pop(sid, None)

    if not payloads:
        # Storms WERE selected but nothing baked and nothing cacheable -> we're
        # blind to a known-active storm. That's "unavailable", not a silent
        # nothing -- same falsely-reassured risk as the no-selection case above.
        # Name the source(s) whose bake failed so the card can say "GDACS" rather
        # than a generic "storm feed" (the list fetch succeeded, so we know which).
        failed = errors or sorted(bake_failed_sources) or ["storm feed"]
        return {"ok": False, "reason": "unavailable",
                "activeAnywhere": len(active),
                "failedSources": failed,
                "ts": now_ms}

    return {"ok": True, "storms": payloads, "count": len(payloads),
            "anyStale": any(p.get("stale") for p in payloads),
            "anyFresh": baked_ok, "ts": now_ms,
            "layerMeta": _layer_meta(selected[:MAX_STORMS], home_lat, home_lon)}


def _layer_meta(storms, home_lat=None, home_lon=None):
    """Per-storm inputs for the on-demand layer platform (layers.py), built
    from the storm lists this poll already fetched -- no extra HTTP. GDACS
    carries its advisory text inline (it rides the event feed); NHC carries
    only the text-product URLs, fetched on demand. Keyed by storm id; popped
    off the result by the coordinator so it never rides the /data websocket.
    Built from `selected` (not `payloads`), so a stale-served storm still gets
    its advisory layer as long as the list fetch saw it this poll."""
    out = {}
    for storm in storms:
        sid = storm.get("id")
        if not sid:
            continue
        g = storm.get("_gdacs")
        if g:
            out[sid] = {
                "source": "gdacs", "name": storm.get("name") or "",
                "advisory": str(g.get("episodeid") or ""),
                "htmldescription": g.get("htmldescription"),
                "severitytext": g.get("severitytext"),
            }
        else:
            products = {}
            pub = {}
            for label, k in (("Public Advisory", "publicAdvisory"),
                             ("Forecast Advisory", "forecastAdvisory"),
                             ("Forecast Discussion", "forecastDiscussion")):
                prod = storm.get(k)
                if not isinstance(prod, dict):
                    continue
                if k == "publicAdvisory":
                    pub = prod
                url = prod.get("url")
                if url:
                    products[label] = url
            out[sid] = {
                "source": "nhc", "name": storm.get("name") or "",
                "advisory": str(pub.get("advNum") or ""),
                "products": products,
                # E5 (surge + wind history): the slot bin drives the per-slot
                # layer id; lat/lng anchors the surge spatial envelope; home
                # feeds the surge at-home test. All already in hand this poll.
                "binNumber": storm.get("binNumber"),
                "lat": storm.get("latitudeNumeric"),
                "lng": storm.get("longitudeNumeric"),
                "home": [home_lat, home_lon],
            }
    return out


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
        self._bake_cache = {}   # {storm_id: {"payload": .., "ts": epoch_ms}}
        self._store = _CacheStore(hass, CACHE_STORAGE_VERSION, CACHE_STORAGE_KEY)
        # On-demand layer platform (layers.py). layer_meta: per-storm fetch
        # inputs, refreshed every poll. layer_cache: served layer results,
        # keyed (storm_id, layer, advisory) so a new advisory misses.
        self.layer_meta = {}
        self.layer_cache = {}

    async def async_hydrate_cache(self) -> None:
        """Load the persisted bake cache from .storage into _bake_cache.

        Called once at setup, before the first refresh, so the first poll can
        already fall back to persisted entries during an outage. Store returns
        None on a version mismatch or a missing/corrupt file (it doesn't raise),
        which we treat as "start empty" -- a stale-shaped cache is worse than no
        cache. The 9 h age-out is re-applied here so entries that expired while
        HA was off are dropped on load; then we cap at MAX_STORMS newest.
        """
        try:
            stored = await self._store.async_load()
        except Exception as err:  # never let a bad cache file block setup
            _LOGGER.warning("hurricane_tracker: bake cache load failed, "
                            "starting empty: %s", err)
            stored = None
        if not stored:
            return
        entries = stored.get("entries") or {}
        now_ms = int(time.time() * 1000)
        fresh = {
            sid: ent for sid, ent in entries.items()
            if isinstance(ent, dict) and "payload" in ent and "ts" in ent
            and (now_ms - ent["ts"]) <= CACHE_MAX_AGE_MS
        }
        # cap at the newest MAX_STORMS if the file somehow holds more
        if len(fresh) > MAX_STORMS:
            newest = sorted(fresh.items(), key=lambda kv: kv[1]["ts"],
                            reverse=True)[:MAX_STORMS]
            fresh = dict(newest)
        self._bake_cache = fresh
        if fresh:
            _LOGGER.info("hurricane_tracker: hydrated %d cached bake(s) from "
                         "storage", len(fresh))

    @callback
    def _cache_store_data(self):
        """Snapshot for Store.async_delay_save (called by the delayed save).
        Wrapped under an `entries` key so the schema can grow without a version
        bump. Payloads are already JSON-safe (they serialize over the WS)."""
        return {"entries": self._bake_cache}

    def _cfg(self):
        """Options override data (options flow is how settings get edited)."""
        from .const import (
            CONF_BASIN, CONF_FILTER, CONF_LATITUDE, CONF_LONGITUDE,
            CONF_OFF_SEASON, CONF_RANGE, CONF_UNITS, DEFAULT_BASIN,
            DEFAULT_FILTER, DEFAULT_OFF_SEASON, DEFAULT_RANGE, UNIT_KM, UNIT_MI,
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
            "range": d.get(CONF_RANGE, DEFAULT_RANGE),
            "off_season": d.get(CONF_OFF_SEASON, DEFAULT_OFF_SEASON),
        }

    async def _async_update_data(self):
        cfg = self._cfg()
        # range is stored in the user's distance unit; the pipeline works in miles
        range_mi = (cfg["range"] * _MI_PER_KM
                    if cfg["units"] == "km" else cfg["range"])
        # _build mutates self._bake_cache in the executor thread. Snapshot its
        # signature before/after so we can persist ONLY when it actually changed
        # (a fresh bake or a prune) -- no change, no write.
        before = _cache_signature(self._bake_cache)
        try:
            result = await self.hass.async_add_executor_job(
                _build, cfg["lat"], cfg["lon"], cfg["basin"], cfg["units"],
                cfg["filter"], range_mi, self._bake_cache,
            )
        except Exception as err:
            raise UpdateFailed(f"update failed: {err}") from err
        if _cache_signature(self._bake_cache) != before:
            self._store.async_delay_save(self._cache_store_data, CACHE_SAVE_DELAY_S)
        # Layer meta is coordinator state, not card data: pop it so it rides
        # neither the /data websocket nor diagnostics. A non-ok poll clears it
        # (no storms shown -> no layer requests can target them).
        self.layer_meta = result.pop("layerMeta", {}) or {}
        result["off_season"] = cfg["off_season"]
        # Raise/clear the blind-outage Repairs issue to match this result. Only a
        # genuinely blind state (known-active storm, nothing baked, cache empty)
        # raises; a stale-but-served cone does not. Runs on the loop, idempotent.
        sync_blind_outage_issue(self.hass, result)
        return result
