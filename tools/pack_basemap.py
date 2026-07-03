#!/usr/bin/env python3
"""pack_basemap.py — build custom_components/hurricane_tracker/basemap.bin

Packs global coastlines, admin-1 (state/province) border lines, and land
polygon rings from Natural Earth GeoJSON (public domain) into the compact
"HURB" binary the integration ships. Stdlib only.

Sources (Natural Earth vector, github.com/nvkelso/natural-earth-vector):
  coast  : ne_10m_coastline.geojson                      (finest NE tier)
  land   : ne_10m_land.geojson
  states : ne_50m_admin_1_states_provinces_lines.geojson (borders don't need 10m)

Global. A light Douglas-Peucker pass (--tol degrees) drops redundant collinear
points to bound on-disk size; the integration re-simplifies per view at draw
time, so a sub-kilometre tol here is visually lossless at any real storm zoom.

BINARY FORMAT (HURB v2, little-endian) — see geometry.py for the matching reader:
  b"HURB" | u32 version(=2) | u32 quant(=10000) | u32 nlayers(=3)
  nlayers x (u32 offset, u32 len)                  # layer directory
  per layer @offset:
    u32 nparts
    per part:
      i32 minx, i32 miny, i32 maxx, i32 maxy       # quantized bbox (spatial index)
      u32 npts
      npts x (i32 x, i32 y)                         # round(lng*quant), round(lat*quant)
  Layer order: coast, states, land.
The per-part bbox lets the reader skip parts outside the storm view without
decoding their points — so a global map costs almost no memory to clip.

Usage:
  python3 pack_basemap.py --download --src ./ne --out ../custom_components/hurricane_tracker/basemap.bin
"""
from __future__ import annotations
import argparse, json, math, os, struct, urllib.request

QUANT = 10000
MAGIC = b"HURB"
VERSION = 2
LAYER_ORDER = ["coast", "states", "land"]
SOURCES = {
    "coast":  ("ne_10m_coastline.geojson", "line"),
    "land":   ("ne_10m_land.geojson", "ring"),
    "states": ("ne_50m_admin_1_states_provinces_lines.geojson", "line"),
}
BASE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"


def fetch(fname, dest):
    url = BASE_URL + fname
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=".", help="dir holding (or to receive) the Natural Earth geojson")
    ap.add_argument("--out", required=True, help="output basemap.bin path")
    ap.add_argument("--tol", type=float, default=0.003, help="Douglas-Peucker tol in degrees (0 = lossless)")
    ap.add_argument("--download", action="store_true", help="fetch missing source files into --src")
    ap.add_argument("--keep", action="store_true", help="keep downloaded source files (default: remove)")
    args = ap.parse_args()
    os.makedirs(args.src, exist_ok=True)

    fetched = []
    for name in LAYER_ORDER:
        fname, _ = SOURCES[name]
        path = os.path.join(args.src, fname)
        if not os.path.exists(path):
            if not args.download:
                raise SystemExit(f"missing {path} (pass --download to fetch)")
            n = fetch(fname, path)
            fetched.append(path)
            print(f"  fetched {fname}  {n/1e6:.1f} MB")

    bodies = {}
    for name in LAYER_ORDER:
        fname, kind = SOURCES[name]
        parts = parts_from_geojson(os.path.join(args.src, fname), kind)
        min_pts = 3 if name == "land" else 2
        body, nparts, npts = build_layer(parts, min_pts, args.tol)
        bodies[name] = body
        print(f"  {name:>6}: parts={nparts:>6} points={npts:>8}")

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
