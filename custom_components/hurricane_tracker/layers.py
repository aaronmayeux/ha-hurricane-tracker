"""On-demand layer platform (Session E).

Optional card layers are NEVER part of the 30-min bake: the card asks for a
layer over the `hurricane_tracker/layer` websocket command only when the user
toggles it on, any network fetch runs in an executor, and the result is cached
PER ADVISORY (a new advisory naturally invalidates the cache). This keeps the
baseline card Pi-cheap and, because HA proxies the fetch, dodges CORS.

Inputs ride `coordinator.layer_meta` -- a per-storm dict `_build` refreshes on
every poll from the storm lists it already fetched:
- GDACS: the advisory text itself (htmldescription + severitytext) rides the
  event feed, so serving it costs zero extra HTTP.
- NHC: only the text-product URLs are carried; the text is fetched on demand.

Layers here are data-plane only; which layers exist, how they group, and radio
exclusivity live in the card's OPTIONAL_LAYERS registry.
"""
from __future__ import annotations

import html as _html
import logging
import re

from . import nhc

_LOGGER = logging.getLogger(__name__)

LAYER_ADVISORY = "advisory"
LAYER_MODELS = "models"
LAYERS = {LAYER_ADVISORY, LAYER_MODELS}

# Cache cap. Keys are (storm_id, layer, advisory); texts are small, but don't
# let a long multi-storm season accumulate stale advisories.
_CACHE_MAX = 16

_GDACS_ATTRIBUTION = ("Source: Global Disaster Alert and Coordination System "
                      "(GDACS), European Commission JRC.")


def _strip_html(s):
    """Plain text from a GDACS html snippet: strip tags, unescape entities."""
    return _html.unescape(re.sub(r"<[^>]+>", " ", s or "")).strip()


def _advisory_result(meta):
    """Build the advisory-text result for one storm from its layer meta.
    Blocking for NHC (HTTP) -> always called in an executor. None = no text."""
    if meta.get("source") == "gdacs":
        parts = [p for p in (meta.get("severitytext"),
                             _strip_html(meta.get("htmldescription"))) if p]
        if not parts:
            return None
        parts.append(_GDACS_ATTRIBUTION)
        title = "%s — GDACS alert" % (meta.get("name") or "Storm")
        text = "\n\n".join(parts)
    else:
        sections = nhc.fetch_advisory_text(meta.get("products") or {})
        if not sections:
            return None
        title = "%s — NHC advisory" % (meta.get("name") or "Storm")
        text = "\n\n".join("=== %s ===\n\n%s" % (lbl, txt)
                           for lbl, txt in sections)
    return {"ok": True, "layer": LAYER_ADVISORY,
            "advisory": str(meta.get("advisory") or ""),
            "title": title, "text": text}


def _models_result(storm_id, meta):
    """Forecast model tracks (E4) for one NHC storm, from its ATCF a-deck.
    NHC-only: GDACS has no per-model guidance (its track lines are one JTWC
    track split by intensity), so a GDACS storm returns None -> the platform's
    honest 'unavailable' (the card hides the toggle for GDACS anyway).
    Blocking (HTTP) -> always called in an executor. None = nothing usable."""
    if meta.get("source") == "gdacs":
        return None
    models = nhc.fetch_model_tracks(storm_id)
    if not models:
        return None
    return {"ok": True, "layer": LAYER_MODELS,
            "advisory": str(meta.get("advisory") or ""),
            "models": models}


def _build_result(layer, storm_id, meta):
    """Dispatch: build one layer's result. Blocking; executor-only."""
    if layer == LAYER_MODELS:
        return _models_result(storm_id, meta)
    return _advisory_result(meta)


async def async_get_layer(hass, coordinator, storm_id, layer):
    """Serve one storm's optional layer: cache hit, else executor fetch.
    Always returns a dict; failures are {"ok": False, "reason": ...} so the
    card soft-fails to an honest 'unavailable' message, never an exception."""
    if layer not in LAYERS:
        return {"ok": False, "reason": "unknown_layer"}
    meta = (getattr(coordinator, "layer_meta", None) or {}).get(storm_id)
    if not meta:
        # Storm unknown to the current poll (e.g. served purely from the bake
        # cache after a restart) -> honest unavailable, never a stale advisory.
        return {"ok": False, "reason": "unavailable"}
    cache = coordinator.layer_cache
    key = (storm_id, layer, str(meta.get("advisory") or ""))
    if key in cache:
        return cache[key]
    try:
        result = await hass.async_add_executor_job(
            _build_result, layer, storm_id, meta)
    except Exception as err:
        _LOGGER.warning("hurricane_tracker: %s layer fetch failed for %s: %s",
                        layer, storm_id, err)
        result = None
    if not result:
        # Do NOT cache the failure -- the next open retries.
        return {"ok": False, "reason": "unavailable"}
    if len(cache) >= _CACHE_MAX:
        cache.clear()   # tiny texts; simplest hard bound
    cache[key] = result
    return result
