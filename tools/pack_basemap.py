#!/usr/bin/env python3
"""pack_basemap.py — build custom_components/hurricane_tracker/basemap.bin

Packs global coastlines, admin-1 (state/province) border lines, land polygon
rings, and populated-place city points into the compact "HURB" binary the
integration ships. Stdlib only.

Sources:
  Lines/rings — Natural Earth vector, github.com/nvkelso/natural-earth-vector
  (public domain):
    coast  : ne_10m_coastline.geojson                      (finest NE tier)
    land   : ne_10m_land.geojson
    states : ne_10m_admin_1_states_provinces_lines.geojson (10m: full global coverage incl. Mexico; 50m was sparse)
  Places — GeoNames cities5000 (download.geonames.org/export/dump), licensed
  CC-BY 4.0 — attribution "GeoNames (geonames.org)" REQUIRED wherever the data
  ships (README carries it). ~50k populated places with pop >= 5000, versus the
  ~5.2k >= 25k the old Natural Earth populated_places source gave — this is what
  makes the Population-dots density picture dense and the in-cone population
  figure less undercounted.

GeoNames rows are filtered: feature codes PPLX (a SECTION of a city — keeping
these double-counts every metro: Brooklyn AND New York City both ship in
cities5000), plus PPLH/PPLQ/PPLW/PPLCH (historical/abandoned/destroyed) are
excluded; rows with population < --min-pop are dropped. The v3 record's rank
byte (Natural Earth scalerank, gone in GeoNames) is synthesized from population
buckets so the binary format is unchanged — nothing downstream sorts by rank
today, but the byte is part of the record.

Global. A light Douglas-Peucker pass (--tol degrees) drops redundant collinear
points to bound on-disk size; the integration re-simplifies per view at draw
time, so a sub-kilometre tol here is visually lossless at any real storm zoom.

--reuse-lines <existing basemap.bin>: copy the coast/states/land layer bytes
verbatim out of an already-built HURB v2/v3 file and rebuild ONLY the places
layer. Skips the ~30 MB Natural Earth downloads and the (slow) DP pass, and
keeps the line layers byte-identical across a places-only regen.

BINARY FORMAT (HURB v3, little-endian) — see geometry.py for the matching reader:
  b"HURB" | u32 version(=3) | u32 quant(=10000) | u32 nlayers(=4)
  nlayers x (u32 offset, u32 len)                  # layer directory
  line/ring layer @offset (coast, states, land — unchanged from v2):
    u32 nparts
    per part:
      i32 minx, i32 miny, i32 maxx, i32 maxy       # quantized bbox (spatial index)
      u32 npts
      npts x (i32 x, i32 y)                         # round(lng*quant), round(lat*quant)
  places layer @offset (POINT layer, new in v3):
    u32 nplaces
    per place:
      i32 x, i32 y                                  # quantized lng, lat
      u8 rank                                       # pop bucket (0 = biggest)
      u32 pop                                       # population
      u8 namelen | namelen bytes utf-8              # city name (ascii form)
  Layer order: coast, states, land, places.
The per-part bbox lets the reader skip parts outside the storm view without
decoding their points — so a global map costs almost no memory to clip.

Usage:
  # full build (NE downloads + GeoNames):
  python3 pack_basemap.py --download --src ./ne --out .../basemap.bin
  # places-only regen against an existing bin (fast path):
  python3 pack_basemap.py --download --src ./ne --reuse-lines old_basemap.bin --out .../basemap.bin
"""
from __future__ import annotations
import argparse, io, json, math, os, struct, urllib.request, zipfile

QUANT = 10000
MAGIC = b"HURB"
VERSION = 3
LAYER_ORDER = ["coast", "states", "land", "places"]
LINE_LAYERS = ["coast", "states", "land"]
NE_SOURCES = {
    "coast":  ("ne_10m_coastline.geojson", "line"),
    "land":   ("ne_10m_land.geojson", "ring"),
    "states": ("ne_10m_admin_1_states_provinces_lines.geojson", "line"),
}
NE_BASE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
# admin-1 lines carry only INTERNAL state/province boundaries; the national
# perimeter (e.g. the US-Mexico border) lives in admin-0. Merge admin-0 land
# borders into the states layer so international borders draw too. Land only --
# the coast layer already draws coastlines, so maritime borders would double up.
STATES_EXTRA = "ne_10m_admin_0_boundary_lines_land.geojson"

# GeoNames cities5000: every place with population > 5000 (plus admin seats).
# CC-BY 4.0 — keep the attribution wherever this data ships.
GEONAMES_URL = "https://download.geonames.org/export/dump/cities5000.zip"
GEONAMES_TXT = "cities5000.txt"
# Feature codes excluded from the pack. PPLX = a section of a populated place
# (borough/district) — its population is already inside its parent city, so
# keeping it double-counts metros in the card's in-cone population sum.
# PPLH/PPLQ/PPLW/PPLCH = historical / abandoned / destroyed / historical capital.
EXCLUDE_FCODES = {"PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"}
# rank byte: population buckets, 0 = biggest (stands in for NE scalerank).
RANK_BUCKETS = ((10_000_000, 0), (5_000_000, 1), (1_000_000, 2), (500_000, 3),
                (200_000, 4), (100_000, 5), (50_000, 6), (20_000, 7), (10_000, 8))


def fetch(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "pack_basemap"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    open(dest, "wb").write(data)
    return len(data)


def parts_from_geojson(path, kind):
    gj = json.load(open(path))
    parts = []
    for feat in gj.get("features", []):
        g = feat.get("geometry") or {}
        t, c = g.get("type"), g.get("coordinates")
        if c is None:
            continue
        if kind == "line":
            if t == "LineString":
                parts.append(c)
            elif t == "MultiLineString":
                parts.extend(c)
        else:  # ring
            if t == "Polygon":
                parts.extend(c)
            elif t == "MultiPolygon":
                for poly in c:
                    parts.extend(poly)
    return [[[float(x), float(y)] for x, y in p] for p in parts]


def pop_rank(pop):
    for floor, rank in RANK_BUCKETS:
        if pop >= floor:
            return rank
    return 9


def places_from_geonames(zip_path, min_pop):
    """(lng, lat, rank, pop, name) per GeoNames cities5000 row that survives the
    feature-code + population filters. The dump is headerless TSV, UTF-8, no
    quoting — a plain split('\\t') is the whole parse. Columns used (0-indexed):
    1 name, 2 asciiname, 4 lat, 5 lng, 7 feature code, 14 population."""
    out = []
    with zipfile.ZipFile(zip_path) as zf:
        with zf.open(GEONAMES_TXT) as fh:
            for raw in io.TextIOWrapper(fh, encoding="utf-8"):
                cols = raw.rstrip("\n").split("\t")
                if len(cols) < 15:
                    continue
                if cols[7] in EXCLUDE_FCODES:
                    continue
                try:
                    pop = int(cols[14] or 0)
                    lat = float(cols[4])
                    lng = float(cols[5])
                except ValueError:
                    continue
                if pop < min_pop:
                    continue
                name = cols[2] or cols[1]
                if not name:
                    continue
                out.append((lng, lat, pop_rank(pop), pop, name))
    return out


def douglas_peucker(pts, tol):
    if tol <= 0 or len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]; bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        dd = dx * dx + dy * dy
        idx, far = -1, tol
        for i in range(a + 1, b):
            px, py = pts[i]
            if dd == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / dd))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > far:
                idx, far = i, d
        if idx != -1:
            keep[idx] = True
            stack.append((a, idx)); stack.append((idx, b))
    return [pts[i] for i, k in enumerate(keep) if k]


def build_layer(parts, min_pts, tol):
    body = bytearray()
    kept = []
    for p in parts:
        q = [[round(x * QUANT), round(y * QUANT)] for x, y in (douglas_peucker(p, tol) if tol else p)]
        if len(q) < min_pts:
            continue
        kept.append(q)
    body += struct.pack("<I", len(kept))
    for q in kept:
        xs = [c[0] for c in q]; ys = [c[1] for c in q]
        body += struct.pack("<iiii", min(xs), min(ys), max(xs), max(ys))
        body += struct.pack("<I", len(q))
        for x, y in q:
            body += struct.pack("<ii", x, y)
    return bytes(body), len(kept), sum(len(q) for q in kept)


def build_places_layer(places):
    body = bytearray(struct.pack("<I", len(places)))
    for lng, lat, rank, pop, name in places:
        nb = name.encode("utf-8")[:255]
        body += struct.pack("<iiBIB", round(lng * QUANT), round(lat * QUANT),
                            rank, min(pop, 0xFFFFFFFF), len(nb))
        body += nb
    return bytes(body)


def line_layers_from_bin(path):
    """Copy the coast/states/land layer bytes VERBATIM from an existing HURB
    v2/v3 file (same QUANT assumed — it has never changed). Returns
    {name: bytes}."""
    buf = open(path, "rb").read()
    if buf[:4] != MAGIC:
        raise SystemExit(f"{path}: bad basemap magic")
    ver, quant, nlayers = struct.unpack_from("<III", buf, 4)
    if quant != QUANT:
        raise SystemExit(f"{path}: quant {quant} != {QUANT}; can't reuse")
    if nlayers < 3:
        raise SystemExit(f"{path}: only {nlayers} layers; can't reuse")
    out = {}
    for i, name in enumerate(LINE_LAYERS):
        off, ln = struct.unpack_from("<II", buf, 16 + i * 8)
        out[name] = buf[off:off + ln]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=".", help="dir holding (or to receive) the source files")
    ap.add_argument("--out", required=True, help="output basemap.bin path")
    ap.add_argument("--tol", type=float, default=0.003, help="Douglas-Peucker tol in degrees (0 = lossless)")
    ap.add_argument("--states-tol", type=float, default=0.01,
                    help="coarser DP tol for political borders (they re-simplify per view, so this is lossless at storm zoom; keeps the states layer light)")
    ap.add_argument("--min-pop", type=int, default=5000, help="pack-time floor on place population")
    ap.add_argument("--download", action="store_true", help="fetch missing source files into --src")
    ap.add_argument("--keep", action="store_true", help="keep downloaded source files (default: remove)")
    ap.add_argument("--reuse-lines", metavar="BIN",
                    help="existing basemap.bin to copy coast/states/land from verbatim (places-only rebuild)")
    args = ap.parse_args()
    os.makedirs(args.src, exist_ok=True)

    fetched = []

    def ensure(fname, url):
        path = os.path.join(args.src, fname)
        if not os.path.exists(path):
            if not args.download:
                raise SystemExit(f"missing {path} (pass --download to fetch)")
            n = fetch(url, path)
            fetched.append(path)
            print(f"  fetched {fname}  {n/1e6:.1f} MB")
        return path

    bodies = {}
    if args.reuse_lines:
        bodies.update(line_layers_from_bin(args.reuse_lines))
        for name in LINE_LAYERS:
            print(f"  {name:>6}: reused verbatim from {args.reuse_lines} ({len(bodies[name])/1e6:.2f} MB)")
    else:
        for name in LINE_LAYERS:
            fname, kind = NE_SOURCES[name]
            path = ensure(fname, NE_BASE_URL + fname)
            parts = parts_from_geojson(path, kind)
            layer_tol = args.tol
            if name == "states":   # merge international land borders in with the state lines
                ep = ensure(STATES_EXTRA, NE_BASE_URL + STATES_EXTRA)
                parts = parts + parts_from_geojson(ep, "line")
                layer_tol = args.states_tol   # borders re-simplify per view -> coarser is lossless
            min_pts = 3 if name == "land" else 2
            body, nparts, npts = build_layer(parts, min_pts, layer_tol)
            bodies[name] = body
            print(f"  {name:>6}: parts={nparts:>6} points={npts:>8}")

    zip_path = ensure(os.path.basename(GEONAMES_URL), GEONAMES_URL)
    places = places_from_geonames(zip_path, args.min_pop)
    bodies["places"] = build_places_layer(places)
    print(f"  places: {len(places):>6} (GeoNames cities5000, pop >= {args.min_pop}, "
          f"{len(bodies['places'])/1e6:.2f} MB)")

    out = bytearray(MAGIC + struct.pack("<III", VERSION, QUANT, len(LAYER_ORDER)))
    dirpos = len(out)
    out += b"\x00" * (8 * len(LAYER_ORDER))
    offs = {}
    for name in LAYER_ORDER:
        offs[name] = len(out)
        out += bodies[name]
    for i, name in enumerate(LAYER_ORDER):
        struct.pack_into("<II", out, dirpos + i * 8, offs[name], len(bodies[name]))

    open(args.out, "wb").write(out)
    print(f"wrote {args.out}  {len(out)/1e6:.2f} MB")

    if not args.keep:
        for p in fetched:
            try:
                os.remove(p)
            except OSError:
                pass


if __name__ == "__main__":
    main()
