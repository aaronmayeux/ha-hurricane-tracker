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

from . import geometry, nhc
from .const import (
    SURGE_BAND_FLOOR,
    SURGE_POINT_BUDGET,
    SURGE_RING_KEEP,
)

_LOGGER = logging.getLogger(__name__)

LAYER_ADVISORY = "advisory"
LAYER_MODELS = "models"
LAYER_SURGE = "surge"
LAYERS = {LAYER_ADVISORY, LAYER_MODELS, LAYER_SURGE}

# Rising-severity order of the PeakStormSurge symbolid color classes -- used to
# pick the WORST band containing home when bands overlap. Unknown symbols rank
# lowest (still reported, just conservatively ordered).
_SURGE_SEVERITY = ("blue", "yellow", "orange", "red", "purple")


def _surge_rank(sym):
    s = str(sym or "").lower()
    for i, c in enumerate(_SURGE_SEVERITY):
        if c in s:
            return i
    return -1

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
    models = nhc.fetch_model_tracks(
        storm_id, (meta.get("lng"), meta.get("lat")), meta.get("dir"))
    if not models:
        return None
    return {"ok": True, "layer": LAYER_MODELS,
            "advisory": str(meta.get("advisory") or ""),
            "models": models}


def _surge_result(meta):
    """Peak storm surge (E5) for one NHC storm: inundation bands + the at-home
    test. NHC-only (GDACS has no surge product) -> None for GDACS. Blocking
    (HTTP) -> executor-only. None = nothing usable (honest 'unavailable')."""
    if meta.get("source") == "gdacs":
        return None
    feats = nhc.fetch_peak_surge(meta.get("lat"), meta.get("lng"))
    if not feats:
        return None
    # v0.2.7 surge rework: the budget is allocated ACROSS bands proportional
    # to raw size (with a floor so small bands always survive), never spent
    # front-to-back -- the old running `remaining` + hard break dropped every
    # band after the budget ran out, which read on glass as missing coverage.
    # tol=0: the server already generalized (maxAllowableOffset); a second
    # always-on DP pass here deleted small rings and inland fingers, so the
    # client only coarsens a band that overruns its own allocation.
    sized = [(ft, sum(len(r) for r in ft["rings"])) for ft in feats]
    sized = [(ft, n) for ft, n in sized if n]
    raw_total = sum(n for _, n in sized) or 1
    bands = []
    for ft, n in sized:
        share = max(SURGE_BAND_FLOOR, SURGE_POINT_BUDGET * n // raw_total)
        rings = geometry.simplify_rings(ft["rings"], 0, budget=share,
                                        keep_small=SURGE_RING_KEEP)
        if not rings:
            continue
        bands.append({"label": ft["name"], "sym": ft["sym"], "rings": rings})
    if not bands:
        return None
    # At-home test on the RAW (pre-simplify) rings -- worst band containing
    # home wins. Uses the same ray-cast as the Phase 3 wind report.
    at_home, at_rank = None, -2
    home = meta.get("home") or [None, None]
    hlat, hlng = home[0], home[1]
    if hlat is not None and hlng is not None:
        for ft in feats:
            if any(geometry._pt_in_ring(hlng, hlat, r) for r in ft["rings"]):
                rank = _surge_rank(ft["sym"])
                if rank > at_rank:
                    at_home, at_rank = ft["name"], rank
    # v0.2.7: atHomeSev is the severity INDEX (0=blue .. 4=purple) so the card
    # can name the depth from the service legend instead of showing atHome --
    # the feature `name`, which is a bay/reach place label. atHome still rides
    # along as the fallback for mixed-version card/server pairs.
    return {"ok": True, "layer": LAYER_SURGE,
            "advisory": str(meta.get("advisory") or ""),
            "bands": bands, "atHome": at_home,
            "atHomeSev": at_rank if at_rank >= 0 else None}


def _build_result(layer, storm_id, meta):
    """Dispatch: build one layer's result. Blocking; executor-only."""
    if layer == LAYER_MODELS:
        return _models_result(storm_id, meta)
    if layer == LAYER_SURGE:
        return _surge_result(meta)
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
