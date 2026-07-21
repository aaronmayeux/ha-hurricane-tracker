"""Weather-imagery overlay data plane (Session §13).

Draws live weather imagery UNDER the cone as a raster underlay. Two on-demand
raster layers, fetched ONLY when the card toggles imagery on:

- Satellite: IEM GOES-East Band 13 (color-enhanced IR). LEADS, because ground
  radar is blank over the open ocean where storms live.
- Radar: NOAA nowCOAST MRMS base reflectivity. A near-land bonus.

Both are public-domain EPSG:3857 PNGs. This module is stdlib-only (urllib): it
converts the card's lng/lat frame to a Web-Mercator bbox, fetches the raw PNG
bytes, caches them in a bounded in-memory LRU (protects the SD card), and hands
the card a SIGNED HTTP path (async_sign_path) that an aiohttp view streams from
that cache. No image library touches the pixels -- the black-sky knockout is a
client-side SVG filter, not a server pixel op. Proxying the bytes through HA
(rather than the card hitting NOAA/IEM directly) also keeps the <image>
same-origin so the SVG filter applies without cross-origin tainting, and dodges
CORS.
"""
from __future__ import annotations

import json
import logging
import math
import time
import urllib.parse
import urllib.request
from datetime import timedelta

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.http.auth import async_sign_path

from .const import (
    IMAGERY_CACHE_MAX_BYTES,
    IMAGERY_CACHE_MAX_FRAMES,
    IMAGERY_HTTP_TIMEOUT,
    IMAGERY_MAX_DIM,
    IMAGERY_RADAR,
    IMAGERY_RADAR_COVERAGE,
    IMAGERY_RADAR_URL,
    IMAGERY_SAT,
    IMAGERY_SAT_COVERAGE,
    IMAGERY_SAT_LAYER,
    IMAGERY_SAT_URL,
    IMAGERY_SIGN_TTL_S,
    IMAGERY_TTL_S,
    MERC_LAT_LIMIT,
    MERC_R,
    USER_AGENT,
)

_LOGGER = logging.getLogger(__name__)

IMAGERY_VIEW_PATH = "/api/hurricane_tracker/imagery"


# ---------------------------------------------------------------------------
# Web-Mercator (EPSG:3857) transform -- mirrors the card's makeProject: x linear
# in lng, y through the Mercator log-tan stretch. Same math, in meters.
# ---------------------------------------------------------------------------
def _merc(lng, lat):
    lat = max(-MERC_LAT_LIMIT, min(MERC_LAT_LIMIT, lat))
    x = MERC_R * math.radians(lng)
    y = MERC_R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def _bbox_3857(bbox):
    minx, miny = _merc(bbox[0], bbox[1])
    maxx, maxy = _merc(bbox[2], bbox[3])
    return minx, miny, maxx, maxy


def _req_size(b3857):
    """Pixel W,H from the 3857 bbox aspect, longest side capped at MAX_DIM. The
    card stretches the raster to the projected rect (preserveAspectRatio=none),
    so matching the aspect just avoids wasting pixels."""
    w = max(b3857[2] - b3857[0], 1.0)
    h = max(b3857[3] - b3857[1], 1.0)
    if w >= h:
        return IMAGERY_MAX_DIM, max(1, int(round(IMAGERY_MAX_DIM * h / w)))
    return max(1, int(round(IMAGERY_MAX_DIM * w / h))), IMAGERY_MAX_DIM


def _covered(layer, bbox):
    cx = (bbox[0] + bbox[2]) / 2.0
    cy = (bbox[1] + bbox[3]) / 2.0
    cov = IMAGERY_SAT_COVERAGE if layer == IMAGERY_SAT else IMAGERY_RADAR_COVERAGE
    return cov[0] <= cx <= cov[2] and cov[1] <= cy <= cov[3]


def _sat_url(b3857, w, h):
    q = {
        "SERVICE": "WMS", "VERSION": "1.1.1", "REQUEST": "GetMap",
        "LAYERS": IMAGERY_SAT_LAYER, "STYLES": "",
        "SRS": "EPSG:3857",
        "BBOX": "%f,%f,%f,%f" % b3857,
        "WIDTH": str(w), "HEIGHT": str(h),
        "FORMAT": "image/png", "TRANSPARENT": "TRUE",
    }
    return IMAGERY_SAT_URL + "?" + urllib.parse.urlencode(q)


def _radar_url(b3857, w, h):
    q = {
        "bbox": "%f,%f,%f,%f" % b3857,
        "bboxSR": "3857", "imageSR": "3857",
        "size": "%d,%d" % (w, h),
        "format": "png", "transparent": "true", "f": "image",
    }
    return IMAGERY_RADAR_URL + "/exportImage?" + urllib.parse.urlencode(q)


def _http_bytes(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=IMAGERY_HTTP_TIMEOUT) as resp:
        return resp.read(), resp.headers.get("Content-Type", "")


def _radar_observed_ms():
    """Latest MRMS frame time from the ImageServer JSON (epoch ms). None on any
    failure -> the caller falls back to fetch-time."""
    try:
        raw, _ = _http_bytes(IMAGERY_RADAR_URL + "?f=json")
        te = (json.loads(raw).get("timeInfo") or {}).get("timeExtent")
        if isinstance(te, (list, tuple)) and len(te) == 2 and te[1]:
            return int(te[1])
    except Exception:  # noqa: BLE001 -- best-effort; a bad time never fails a fetch
        return None
    return None


def _fetch(layer, bbox):
    """Blocking: build the source URL, fetch PNG bytes, resolve observed time.
    Returns (png_bytes, observed_ms). Raises on a hard fetch failure. Runs in an
    executor (urllib + a second short HTTP GET for the radar timestamp)."""
    b3857 = _bbox_3857(bbox)
    w, h = _req_size(b3857)
    now_ms = int(time.time() * 1000)
    if layer == IMAGERY_SAT:
        data, ctype = _http_bytes(_sat_url(b3857, w, h))
        observed = now_ms  # WMS GetMap carries no per-image time -> fetch-time
    else:
        data, ctype = _http_bytes(_radar_url(b3857, w, h))
        observed = _radar_observed_ms() or now_ms
    if not data or "png" not in (ctype or "").lower():
        # A bad exportImage/GetMap request returns a JSON/XML error with a
        # non-image content-type; treat anything that isn't a PNG as a failure.
        raise ValueError("non-image response (%s)" % (ctype or "?"))
    return data, observed


def _evict(cache):
    """Bound the LRU: newest IMAGERY_CACHE_MAX_FRAMES, then a hard byte cap.
    cache is an OrderedDict token -> {"bytes":.., "observed":..}, MRU last."""
    while len(cache) > IMAGERY_CACHE_MAX_FRAMES:
        cache.popitem(last=False)
    total = sum(len(e["bytes"]) for e in cache.values())
    while total > IMAGERY_CACHE_MAX_BYTES and len(cache) > 1:
        _, ent = cache.popitem(last=False)
        total -= len(ent["bytes"])


def _last_good(cache, prefix):
    """Most-recently-used token for a (layer,bbox) prefix, or None."""
    for tok in reversed(cache):
        if tok.startswith(prefix):
            return tok
    return None


async def async_get_imagery(hass, coordinator, layer, bbox, storm_id):
    """Serve one imagery frame: coverage-gate, cache hit, else executor fetch.
    Returns a dict the card understands:
      no coverage  -> {"ok": True, "covered": False}
      good/stale   -> {"ok": True, "covered": True, "href": <signed>,
                        "observed": <epoch_ms|None>, "stale": bool}
      hard failure -> {"ok": False, "reason": "unavailable"}
    Never raises -- the card soft-fails to an honest note."""
    if layer not in (IMAGERY_SAT, IMAGERY_RADAR):
        return {"ok": False, "reason": "unknown_layer"}
    try:
        bbox = [float(v) for v in (bbox or [])]
    except (TypeError, ValueError):
        bbox = []
    if len(bbox) != 4:
        return {"ok": False, "reason": "no_bbox"}
    if not _covered(layer, bbox):
        return {"ok": True, "layer": layer, "covered": False}

    cache = coordinator.imagery_cache
    ts = int(time.time()) // IMAGERY_TTL_S  # 5-min bucket
    bkey = ",".join("%.3f" % v for v in bbox)
    prefix = "%s|%s|" % (layer, bkey)
    token = "%s%d" % (prefix, ts)
    stale = False

    if token not in cache:
        try:
            data, observed = await hass.async_add_executor_job(_fetch, layer, bbox)
        except Exception as err:  # noqa: BLE001 -- any fetch/parse error soft-fails
            _LOGGER.warning("hurricane_tracker: imagery %s fetch failed: %s",
                            layer, err)
            data = None
        if data:
            cache[token] = {"bytes": data, "observed": observed}
            cache.move_to_end(token)
            _evict(cache)
        else:
            # Fetch failed -> serve the last-good frame for this exact frame if we
            # have one, flagged stale. Nothing cached -> honest unavailable.
            token = _last_good(cache, prefix)
            if not token:
                return {"ok": False, "layer": layer, "reason": "unavailable"}
            stale = True

    cache.move_to_end(token)
    ent = cache[token]
    path = "%s?layer=%s&k=%s" % (
        IMAGERY_VIEW_PATH, urllib.parse.quote(layer), urllib.parse.quote(token))
    href = async_sign_path(hass, path, timedelta(seconds=IMAGERY_SIGN_TTL_S))
    return {"ok": True, "layer": layer, "covered": True, "href": href,
            "observed": ent.get("observed"), "stale": stale, "bbox": bbox}


class ImageryView(HomeAssistantView):
    """Streams a cached imagery PNG by its frame token. Auth rides the signed
    query param (the <image> tag can't send an Authorization header); the bytes
    are public-domain weather, so the token+signature is belt-and-suspenders."""

    url = IMAGERY_VIEW_PATH
    name = "api:hurricane_tracker:imagery"
    requires_auth = True

    def __init__(self, cache_getter):
        self._cache_getter = cache_getter

    async def get(self, request):
        token = request.query.get("k") or ""
        cache = self._cache_getter()
        ent = cache.get(token) if cache is not None else None
        if not ent or not ent.get("bytes"):
            return web.Response(status=404)
        return web.Response(
            body=ent["bytes"], content_type="image/png",
            headers={"Cache-Control": "private, max-age=%d" % IMAGERY_TTL_S})
