/* ============================================================================
 * hurricane-card.js — global hurricane/typhoon/cyclone cone card
 * A standalone Home Assistant Lovelace card. Draws a storm-framed SVG cone from
 * the Hurricane Tracker integration: basemap (coast + state lines + land), the
 * cone of uncertainty, past + forecast tracks, Saffir-Simpson forecast dots,
 * watch/warning coastal segments, current-position marker, and a home pin —
 * with a data bar underneath.
 *
 * Data arrives over the integration's websocket command (authenticated, keeps
 * the large geometry out of entity attributes). Storm-identity colors (the
 * Saffir-Simpson dot ramp + NHC watch/warning colors) are fixed hexes on
 * purpose; everything else follows the active HA theme and can be overridden
 * per-card via config (see README / the visual editor).
 * ========================================================================== */

const WS_TYPE = "hurricane_tracker/data";
const WS_LAYER_TYPE = "hurricane_tracker/layer";
const REFRESH_MS = 5 * 60 * 1000;   // re-pull at most every 5 min (coordinator polls every 30)
const VBW = 800, VBH = 600;

/* Optional-layer registry (Session E platform). Baseline layers always draw --
 * that's the product. These are LAZY: off by default, requested over the layer
 * websocket only when toggled on, session-cached per (storm, advisory). `radio`
 * names a mutual-exclusion group (one active per group; turning one on turns
 * its siblings off) -- null means an independent toggle. Choices are sticky per
 * BROWSER via localStorage, not card config: a layer is a viewer preference,
 * not dashboard config, and stickiness is what makes the lazy fetch cost okay
 * (paid once per advisory, not per glance). */
const OPTIONAL_LAYERS = [
  { id: "advisory", label: "Advisory text", group: "Storm info", radio: null },
];
const LAYER_STORE_KEY = "hurricane-card:layers";
function loadLayerPrefs() {
  try { return JSON.parse(localStorage.getItem(LAYER_STORE_KEY)) || {}; }
  catch (_) { return {}; }   // storage blocked (some webviews) -> session-only
}
function saveLayerPrefs(p) {
  try { localStorage.setItem(LAYER_STORE_KEY, JSON.stringify(p)); } catch (_) {}
}
function setLayerPref(prefs, id, on) {
  const def = OPTIONAL_LAYERS.find((l) => l.id === id);
  if (def && def.radio && on)   // radio group: siblings off
    OPTIONAL_LAYERS.forEach((l) => {
      if (l.radio === def.radio && l.id !== id) prefs[l.id] = false;
    });
  prefs[id] = on;
  saveLayerPrefs(prefs);
  return prefs;
}

/* Saffir-Simpson identity colors (fixed — a Cat-3 dot must read as Cat-3 on any
 * theme). TD/TS are the sub-hurricane intensities. */
const CAT_COLOR = {
  TD: "#5BA8E0", TS: "#3ECC7A", HU: "#B5474D",
  "1": "#FFE14D", "2": "#FFB52E", "3": "#FF7A33", "4": "#FF4D6D", "5": "#E05BE0",
};
const catColor = (c) => CAT_COLOR[c] || CAT_COLOR.TS;

/* NHC watch/warning coastal-segment identity colors, keyed by TCWW code. */
const WW_COLOR = { TWA: "#FFE14D", TWR: "#3B7DDB", HWA: "#FF6FB0", HWR: "#E03030" };
const wwColor = (t) => WW_COLOR[(t || "").toUpperCase()] || null;

/* Wind-band identity colors, GDACS-style: green 34kt / orange 50kt / red 64kt,
 * drawn nested (34 widest/bottom -> 64 core/top). Fixed hexes like the cat ramp. */
const WIND_BAND = { 34: "#43A047", 50: "#FB8C00", 64: "#E53935" };
const windBandColor = (kt) => WIND_BAND[kt] || "var(--primary-text-color)";

/* Config knobs -> CSS custom properties. Each is optional; unset falls back to
 * the theme default baked into STYLE. Keeps per-card theming declarative. */
const COLOR_VARS = {
  land_color: "--hu-land-color", land_opacity: "--hu-land-opacity",
  coast_color: "--hu-coast-color", coast_width: "--hu-coast-width", coast_opacity: "--hu-coast-opacity",
  state_color: "--hu-state-color", state_width: "--hu-state-width",
  region_color: "--hu-region-color", cone_color: "--hu-cone-color",
  track_color: "--hu-track-color", track_past_color: "--hu-track-past-color",
  background_color: "--hu-bg",
};
/* Layer toggles (default on). */
const TOGGLES = ["show_land", "show_states", "show_coast", "show_cities", "show_labels", "show_scale", "show_home", "show_winds", "show_timeline", "smooth"];

function catDotLabel(c) {
  const k = String(c || "").toUpperCase();
  if (["1", "2", "3", "4", "5"].includes(k)) return k;
  if (k === "HU") return "HU";
  return k === "TD" ? "TD" : "TS";
}
function catLabel(c) {
  if (c == null || c === "") return "";
  const k = String(c).toUpperCase();
  if (["1", "2", "3", "4", "5"].includes(k)) return "CAT " + k;
  if (k === "TS" || k === "TD") return k;
  if (k === "HU" || /HURRICANE/.test(k)) return "HURRICANE";
  if (/TROP.*STORM/.test(k)) return "TS";
  if (/DEPRESS/.test(k)) return "TD";
  return "";
}
/* Wind-radii threshold (kt) -> plain-language force name. */
function windForceName(kt) {
  return kt === 64 ? "Hurricane force winds"
       : kt === 50 ? "Storm force winds"
       : "Tropical Storm force winds";
}
/* Short force name for the exposure-timeline rows. */
function forceShort(kt) {
  return kt === 64 ? "Hurricane force" : kt === 50 ? "Storm force" : "Tropical-storm force";
}
const withCommas = (n) => (n == null ? "" : Number(n).toLocaleString("en-US"));
/* Relative ETA from a forecast hour (tau). Relative, not wall-clock: tau is hours
 * from the advisory synoptic time (~now), so "~" signals the inherent slop. */
function fmtEta(h) {
  if (h == null) return "";
  if (h < 1) return "now";
  if (h < 36) return `~${Math.round(h)} h`;
  const r = Math.round((h / 24) * 2) / 2;   // nearest half-day
  return `~${r} day${r === 1 ? "" : "s"}`;
}
/* Forecast hour (tau) -> wall-clock day+time from an absolute reference (epoch ms,
 * UTC to match the on-map dot labels). No reference -> relative hours. Rounded to
 * the hour; the "possible" framing covers the slop. */
function fmtClock(refTime, tau) {
  if (refTime == null) {
    const h = Math.round(tau);
    return h < 1 ? "now" : `~${h} h`;
  }
  const d = new Date(refTime + Math.round(tau) * 3600 * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let h = d.getUTCHours();
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12; if (h === 0) h = 12;
  return `${days[d.getUTCDay()]} ${h} ${ap}`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* Failed-source codes -> plain names for the failure notes. The coordinator
 * sends ["NHC"], ["GDACS"], both, or ["storm feed"] as a generic fallback. */
function sourceNames(list) {
  const map = { NHC: "the NHC", GDACS: "GDACS" };
  const named = (list || []).map((s) => map[s] || "the storm feed");
  if (!named.length) return "the storm feed";
  if (named.length === 1) return named[0];
  if (named.length === 2) return `${named[0]} and ${named[1]}`;
  return named.slice(0, -1).join(", ") + ", and " + named[named.length - 1];
}

/* epoch-ms -> short local date/time for the stale note, in the browser's zone
 * (users think local, not UTC). e.g. "3:40 PM" today, "Jul 4, 3:40 PM" if older. */
function fmtLocal(ms) {
  if (ms == null) return "";
  const d = new Date(ms), now = new Date();
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return t;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + t;
}

/* ---- projection: lng/lat -> SVG px through the storm bbox ----------------- */
function makeProject(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const midLat = (minLat + maxLat) / 2;
  const cosf = Math.max(0.2, Math.cos(midLat * Math.PI / 180));
  const wLng = Math.max((maxLng - minLng) * cosf, 1e-6);
  const hLat = Math.max((maxLat - minLat), 1e-6);
  const s = Math.min(VBW / wLng, VBH / hLat);
  const ox = (VBW - wLng * s) / 2;
  const oy = (VBH - hLat * s) / 2;
  return (lng, lat) => [ox + (lng - minLng) * cosf * s, oy + (maxLat - lat) * s];
}
const projectPart = (proj, coords) => coords.map(([lng, lat]) => proj(lng, lat));
const ptsStr = (proj, coords) =>
  projectPart(proj, coords).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/* ---- coastline smoothing: Catmull-Rom -> cubic bezier path ----------------
 * Turns the (budget-thinned) basemap points into smooth curves so coastlines
 * read as detailed rather than faceted. Basemap layers only — never the cone,
 * tracks, or watch/warning segments, which are official geometry. */
function smoothPath(pts, closed) {
  const n = pts.length;
  if (n < 2) return "";
  if (n === 2) return `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}L${pts[1][0].toFixed(1)},${pts[1][1].toFixed(1)}`;
  const at = (i) => closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  if (closed) d += "Z";
  return d;
}
const straightPath = (pts, closed) => {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += `L${pts[i][0].toFixed(1)},${pts[i][1].toFixed(1)}`;
  return d + (closed ? "Z" : "");
};
const basePath = (proj, coords, closed, smooth) => {
  const pts = projectPart(proj, coords);
  return smooth ? smoothPath(pts, closed) : straightPath(pts, closed);
};

/* ---- forecast-dot time-label declutter (spoke placement + thinning) ------- */
const CHAR_W = 9.2, LBL_H = 17, R_OUT = 16, MIN_GAP = 34;
function labelBox(cx, cy, w, deg) {
  const r = deg * Math.PI / 180, ux = Math.cos(r), uy = Math.sin(r);
  const leftward = Math.abs(deg) > 90;
  const nx = cx + ux * R_OUT, ny = cy + uy * R_OUT;
  const fx = nx + ux * (leftward ? -w : w), fy = ny + uy * (leftward ? -w : w);
  const pad = LBL_H / 2;
  return { x1: Math.min(nx, fx) - pad, y1: Math.min(ny, fy) - pad,
           x2: Math.max(nx, fx) + pad, y2: Math.max(ny, fy) + pad };
}
const boxHit = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
function thinLabels(jobs) {
  if (jobs.length <= 2) return jobs.slice();
  const kept = [jobs[0]]; let lastKept = jobs[0];
  for (let i = 1; i < jobs.length - 1; i++) {
    const j = jobs[i];
    if (Math.hypot(j.cx - lastKept.cx, j.cy - lastKept.cy) >= MIN_GAP) { kept.push(j); lastKept = j; }
  }
  kept.push(jobs[jobs.length - 1]);
  return kept;
}
function placeLabels(jobsIn) {
  const jobs = thinLabels(jobsIn), placed = [];
  for (const j of jobs) {
    const w = (j.text ? j.text.length : 0) * CHAR_W;
    const away = (j.tdy > 0) ? -1 : 1;
    let chosen = 0;
    if (placed.some((pb) => boxHit(labelBox(j.cx, j.cy, w, 0), pb))) {
      let done = false;
      for (const step of [15, 30, 45]) {
        const deg = away * step;
        if (!placed.some((pb) => boxHit(labelBox(j.cx, j.cy, w, deg), pb))) { chosen = deg; done = true; break; }
      }
      if (!done) chosen = away * 45;
    }
    j.deg = chosen;
    j.anchor = Math.abs(chosen) > 90 ? "end" : "start";
    placed.push(labelBox(j.cx, j.cy, w, chosen));
  }
  return jobs;
}

/* mdi-home as an SVG path, scaled + centered. */
const MDI_HOME_PATH = "M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z";
function houseGlyph(cx, cy) {
  const S = 1.5;
  return `<g class="hu-home" transform="translate(${(cx - 12 * S).toFixed(2)},${(cy - 12 * S).toFixed(2)}) scale(${S})"><path d="${MDI_HOME_PATH}"/></g>`;
}

/* Off-screen home: clamp the house to the viewport edge at home's projected spot
 * and draw a chevron along the house-center -> home line, pointing outward toward
 * home. Direction is derived from the clamped position every time, so it aims
 * correctly from any edge or corner. Distance labeled further inboard. */
const EDGE_M = 50;
function homeEdgeMarker(hx, hy, m) {
  const cx = Math.max(EDGE_M, Math.min(VBW - EDGE_M, hx));
  const cy = Math.max(EDGE_M, Math.min(VBH - EDGE_M, hy));
  let ux = hx - cx, uy = hy - cy;
  const len = Math.hypot(ux, uy) || 1;
  ux /= len; uy /= len;                 // unit vector, house -> true home (outboard)
  const px = -uy, py = ux;              // perpendicular
  const parts = [];
  const wing = 11;
  const tipx = cx - ux * 22, tipy = cy - uy * 22;      // arrowhead tip, toward house
  const tailx = cx - ux * 46, taily = cy - uy * 46;    // tail end, inboard
  parts.push(`<line class="hu-edge-chev" x1="${tailx.toFixed(1)}" y1="${taily.toFixed(1)}" x2="${tipx.toFixed(1)}" y2="${tipy.toFixed(1)}"/>`);
  const b1x = tipx - ux * wing + px * wing * 0.7, b1y = tipy - uy * wing + py * wing * 0.7;
  const b2x = tipx - ux * wing - px * wing * 0.7, b2y = tipy - uy * wing - py * wing * 0.7;
  parts.push(`<polyline class="hu-edge-chev" points="${b1x.toFixed(1)},${b1y.toFixed(1)} ${tipx.toFixed(1)},${tipy.toFixed(1)} ${b2x.toFixed(1)},${b2y.toFixed(1)}"/>`);
  if (m && m.dist != null) {
    const unit = m.distUnit || "mi";
    const lx = cx - ux * 60, ly = cy - uy * 60 + 4;
    const anc = ux > 0.3 ? "end" : ux < -0.3 ? "start" : "middle";
    parts.push(`<text class="hu-edge-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anc}">${esc(withCommas(m.dist) + " " + unit)}</text>`);
  }
  parts.push(houseGlyph(cx, cy));
  return parts.join("");
}

/* point-in-polygon (ray cast); poly is [[x,y],...] in px */
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/* Region name labels (country/state). Drawn under the storm data; any that would
 * touch a keep-out box (forecast dots, time labels, home marker) or sit inside
 * the cone are nudged to nearby open water, and only dropped if no clear spot is
 * found. Tier 1 (states) shows only when zoomed in enough. Region-agnostic:
 * whatever is in `src` gets considered. */
const REGION_CHAR_W = 7.4;
/* Nudge offsets tried in order (px). Anchor first, then toward open water nearby. */
const REGION_NUDGES = [[0, 0], [0, 15], [0, -15], [16, 0], [-16, 0], [0, 28], [0, -28], [22, 14], [-22, 14], [22, -14], [-22, -14], [0, 42], [0, -42]];
function regionLabels(src, proj, bbox, keepOut, conePx) {
  if (!src || !src.length) return [];
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  const maxTier = span > 16 ? 0 : 1;
  const placed = [], out = [];
  const clear = (box) => {
    if (box.x1 < 22 || box.x2 > VBW - 22 || box.y1 < 14 || box.y2 > VBH - 14) return false;
    const my = (box.y1 + box.y2) / 2;
    if (conePx.length >= 3 && [box.x1 + 2, (box.x1 + box.x2) / 2, box.x2 - 2].some((tx) => pointInPoly(tx, my, conePx))) return false;
    if (keepOut.some((b) => boxHit(box, b))) return false;
    if (placed.some((b) => boxHit(box, b))) return false;
    return true;
  };
  for (const r of src) {
    if (r.tier > maxTier) continue;
    const [ax, ay] = proj(r.lng, r.lat);
    if (ax < 24 || ax > VBW - 24 || ay < 18 || ay > VBH - 18) continue;   // anchor must be on-frame
    const name = String(r.name).toUpperCase();
    const w = name.length * REGION_CHAR_W;
    let hit = null;
    for (const [dx, dy] of REGION_NUDGES) {
      const x = ax + dx, y = ay + dy;
      const box = { x1: x - w / 2 - 4, y1: y - 9, x2: x + w / 2 + 4, y2: y + 9 };
      if (clear(box)) { hit = { x, y, box }; break; }   // nudge to open water rather than drop
    }
    if (!hit) continue;
    placed.push(hit.box);
    out.push(`<text class="hu-region" x="${hit.x.toFixed(1)}" y="${(hit.y + 4).toFixed(1)}">${esc(name)}</text>`);
  }
  return out;
}

/* nearest "nice" mile interval giving roughly `want` px between ticks */
function niceMiles(pxPerMile) {
  const targets = [50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000];
  const want = 120;
  let best = targets[0], bd = Infinity;
  for (const m of targets) { const d = Math.abs(m * pxPerMile - want); if (d < bd) { bd = d; best = m; } }
  return best;
}

/* Far-offshore mileage scale: tick marks along the two edges opposite the house,
 * cumulative miles from that corner. Over open water only — any tick that would
 * fall on land, in the cone, or on storm data is dropped. */
function scaleAxes(bbox, proj, geo, keepOut, conePx, hcx, hcy) {
  const midLng = (bbox[0] + bbox[2]) / 2, midLat = (bbox[1] + bbox[3]) / 2;
  const [, ya] = proj(midLng, midLat);
  const [, yb] = proj(midLng, midLat + 1);
  const pxPerMile = Math.abs(yb - ya) / 69.05;
  if (!isFinite(pxPerMile) || pxPerMile <= 0) return [];
  const step = niceMiles(pxPerMile), stepPx = step * pxPerMile;
  if (stepPx < 44) return [];

  const bottom = hcy < VBH / 2;
  const left = hcx > VBW / 2;
  const axisY = bottom ? VBH - 16 : 16;
  const axisX = left ? 16 : VBW - 16;
  const landPx = ((geo && geo.land) || []).map((part) => part.map((c) => proj(c[0], c[1])));
  const blocked = (x, y) => {
    if (conePx.length >= 3 && pointInPoly(x, y, conePx)) return true;
    for (const poly of landPx) if (poly.length >= 3 && pointInPoly(x, y, poly)) return true;
    const box = { x1: x - 18, y1: y - 10, x2: x + 18, y2: y + 10 };
    return keepOut.some((b) => boxHit(box, b));
  };
  const out = [];
  const sx = left ? 1 : -1, sy = bottom ? -1 : 1;
  for (let k = 1; ; k++) {
    const x = axisX + sx * stepPx * k;
    if (x < 34 || x > VBW - 34) break;
    if (blocked(x, axisY)) continue;
    out.push(`<line class="hu-scale-tick" x1="${x.toFixed(1)}" y1="${axisY.toFixed(1)}" x2="${x.toFixed(1)}" y2="${(axisY + (bottom ? -7 : 7)).toFixed(1)}"/>`);
    const txt = k === 1 ? withCommas(step) + " mi" : withCommas(step * k);
    out.push(`<text class="hu-scale-label" x="${x.toFixed(1)}" y="${(axisY + (bottom ? -10 : 17)).toFixed(1)}" text-anchor="middle">${esc(txt)}</text>`);
  }
  for (let k = 1; ; k++) {
    const y = axisY + sy * stepPx * k;
    if (y < 34 || y > VBH - 34) break;
    if (blocked(axisX, y)) continue;
    out.push(`<line class="hu-scale-tick" x1="${axisX.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(axisX + (left ? 7 : -7)).toFixed(1)}" y2="${y.toFixed(1)}"/>`);
    out.push(`<text class="hu-scale-label" x="${(axisX + (left ? 11 : -11)).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${left ? "start" : "end"}">${esc(withCommas(step * k))}</text>`);
  }
  return out;
}

/* ---- build the SVG from one baked storm payload --------------------------- */
function buildConeSvg(st, cfg) {
  const proj = makeProject(st.bbox);
  const smooth = cfg.smooth !== false;
  const base = [];
  if (cfg.show_land !== false)
    for (const part of (st.geo && st.geo.land) || [])
      if (part.length >= 3) base.push(`<path class="hu-land" d="${basePath(proj, part, true, smooth)}"/>`);
  if (cfg.show_states !== false)
    for (const part of (st.geo && st.geo.states) || [])
      if (part.length >= 2) base.push(`<path class="hu-state" d="${basePath(proj, part, false, smooth)}"/>`);
  if (cfg.show_coast !== false)
    for (const part of (st.geo && st.geo.coast) || [])
      if (part.length >= 2) base.push(`<path class="hu-coast" d="${basePath(proj, part, false, smooth)}"/>`);

  // Phase 3 wind field: nested semi-transparent fills (34/50/64 kt), theme text
  // color, no outline/legend. Overlap stacks alpha so the core reads brighter.
  // Drawn UNDER the cone/tracks/dots. Handles 0-3 thresholds. The radii are
  // per-quadrant (NE/SE/SW/NW) so the raw polygon has hard corners at the quadrant
  // lines; we run it through the same Catmull-Rom smoother as the coastlines to
  // round those into organic curves. This keeps the lopsided extents intact --
  // smoothing, not circularizing.
  const windLayer = [];
  if (cfg.show_winds !== false && st.windField && st.windField.length)
    for (const w of st.windField) {
      // Union the tier's rings into ONE path so the blobs along the track merge into
      // a single uniform fill (nonzero winding) -- no darker seams where they overlap.
      // One blob (current-position field) or many (the wind swath) both work here.
      // Nested 34/50/64 tiers stay separate stacked paths -> alpha deepens in the core.
      let d = "";
      for (const ring of (w.rings || []))
        if (ring.length >= 3) d += basePath(proj, ring, true, smooth);
      if (d) windLayer.push(`<path class="hu-wind" style="fill:${windBandColor(w.kt)}" d="${d}"/>`);
    }

  // E3 city dots: geographic reference furniture, so they ride hu-pan and
  // pan/zoom with the map like the coastline (labels scale with zoom --
  // accepted until a zoom-aware label engine exists, see spec horizon).
  // Payload arrives biggest-population first and capped server-side; a greedy
  // min-gap pass (at the default frame) drops labels that would pile up in a
  // metro-dense frame -- the dots stay, only the text thins. Drawn under the
  // storm data on purpose: official geometry always wins.
  const cities = [];
  if (cfg.show_cities !== false && st.places && st.places.length) {
    const taken = [];
    for (const p of st.places) {
      const [x, y] = proj(p.lng, p.lat);
      cities.push(`<circle class="hu-city" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6"/>`);
      if (taken.some((t) => Math.hypot(t[0] - x, t[1] - y) < 64)) continue;
      taken.push([x, y]);
      cities.push(`<text class="hu-city-label" x="${(x + 6).toFixed(1)}" y="${(y + 3.5).toFixed(1)}">${esc(p.name)}</text>`);
    }
  }

  const storm = [];
  for (const seg of st.ww || []) {
    const col = wwColor(seg.type);
    if (col && seg.coords && seg.coords.length >= 2)
      storm.push(`<polyline class="hu-ww" points="${ptsStr(proj, seg.coords)}" stroke="${col}"/>`);
  }
  if (st.cone && st.cone.length >= 3)
    storm.push(`<polygon class="hu-cone-poly" points="${ptsStr(proj, st.cone)}"/>`);
  if (st.pastTrack && st.pastTrack.length >= 2)
    storm.push(`<polyline class="hu-track-past" points="${ptsStr(proj, st.pastTrack)}"/>`);
  if (st.fcstTrack && st.fcstTrack.length >= 2)
    storm.push(`<polyline class="hu-track-fcst" points="${ptsStr(proj, st.fcstTrack)}"/>`);

  const keepOut = [];
  const labelJobs = [];
  const projPts = (st.points || []).map((p) => (p.lng == null || p.lat == null) ? null : proj(p.lng, p.lat));
  (st.points || []).forEach((p, i) => {
    if (p.lng == null || p.lat == null) return;
    const [x, y] = projPts[i];
    const ink = (p.cat === "TD" || p.cat === "TS" || p.cat === "HU") ? "#EDE3D2" : "#14110d";
    storm.push(`<circle class="hu-fdot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="12" fill="${catColor(p.cat)}"/>`);
    storm.push(`<text class="hu-fcat" x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" fill="${ink}">${esc(catDotLabel(p.cat))}</text>`);
    keepOut.push({ x1: x - 15, y1: y - 15, x2: x + 15, y2: y + 15 });
    if (p.label) {
      const a = projPts[i - 1] || [x, y], b = projPts[i + 1] || [x, y];
      labelJobs.push({ cx: x, cy: y, text: p.label, tdx: b[0] - a[0], tdy: b[1] - a[1] });
    }
  });
  placeLabels(labelJobs).forEach((L) => {
    const rot = L.deg ? ` transform="rotate(${L.deg.toFixed(1)},${L.cx.toFixed(1)},${L.cy.toFixed(1)})"` : "";
    storm.push(`<text class="hu-flabel" x="${(L.cx + 16).toFixed(1)}" y="${(L.cy + 5).toFixed(1)}" text-anchor="${L.anchor}"${rot}>${esc(L.text)}</text>`);
    const w = (L.text ? L.text.length : 0) * CHAR_W;
    keepOut.push(labelBox(L.cx, L.cy, w, L.deg));
  });

  const homeParts = [];
  let farCase = false, hcx = 0, hcy = 0;
  if (cfg.show_home !== false && st.home && st.home[0] != null) {
    // Normalize home longitude into the map's 360-degree window so a home more than
    // half the globe away in raw longitude still projects to the correct side (short
    // way round), not the wrong edge. Then project it like everything else -- the
    // marker sits where home actually is on THIS map, and the chevron aims at it.
    const cLng = (st.bbox[0] + st.bbox[2]) / 2;
    let hlng = st.home[0];
    while (hlng - cLng > 180) hlng -= 360;
    while (hlng - cLng < -180) hlng += 360;
    const [hx, hy] = proj(hlng, st.home[1]);
    if (hx >= 0 && hx <= VBW && hy >= 0 && hy <= VBH) {
      homeParts.push(houseGlyph(hx, hy));
      keepOut.push({ x1: hx - 20, y1: hy - 20, x2: hx + 20, y2: hy + 20 });
    } else {
      // Off-frame: clamp the house to the edge at home's projected position; the
      // chevron points from the house center straight at home.
      homeParts.push(homeEdgeMarker(hx, hy, st.meta || {}));
      hcx = Math.max(EDGE_M, Math.min(VBW - EDGE_M, hx));
      hcy = Math.max(EDGE_M, Math.min(VBH - EDGE_M, hy));
      // keep-out AABB covering the whole marker (house + chevron + distance label)
      // so region labels and the scale avoid it -- collision rules apply to it too.
      let ux = hx - hcx, uy = hy - hcy;
      const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
      const inX = hcx - ux * 160, inY = hcy - uy * 160;   // inboard (label) reach
      const outX = hcx + ux * 34, outY = hcy + uy * 34;   // outboard (arrow) reach
      const P = 22;
      keepOut.push({
        x1: Math.min(inX, outX, hcx) - P, y1: Math.min(inY, outY, hcy) - P,
        x2: Math.max(inX, outX, hcx) + P, y2: Math.max(inY, outY, hcy) + P,
      });
      farCase = true;
    }
  }

  const conePx = (st.cone || []).map((c) => proj(c[0], c[1]));
  const region = cfg.show_labels !== false ? regionLabels(st.labels, proj, st.bbox, keepOut, conePx) : [];
  const scale = (farCase && cfg.show_scale !== false) ? scaleAxes(st.bbox, proj, st.geo, keepOut, conePx, hcx, hcy) : [];

  // Two sibling groups. hu-pan holds the GEOGRAPHIC layers (basemap, wind wash,
  // cone/track/dots/ww + on-dot labels) -- these scale honestly, so pan/zoom is a
  // transform on this group alone. hu-overlays holds SCREEN-SPACE furniture (region
  // names, off-screen home marker, offshore mileage scale) whose edge-clamp/keepOut
  // math is only valid at the default frame; it hides whenever the view leaves default
  // (set by the gesture layer) and returns on recenter. The outer viewBox is always
  // the default 800x600 frame; the buffered coastline in `geo` extends past it and is
  // simply clipped until a gesture reveals it. viewBox/maxScale ride as data-attrs so
  // the gesture layer can read the pannable extent + zoom ceiling off the DOM.
  const panGroup = [...base, ...windLayer, ...cities, ...storm];
  const overlayGroup = [...region, ...scale, ...homeParts];
  const vb = st.viewBox ? st.viewBox.join(" ") : "";
  const ms = st.maxScale != null ? st.maxScale : 1;
  return `<svg class="hu-svg" viewBox="0 0 ${VBW} ${VBH}" preserveAspectRatio="xMidYMid meet"`
    + ` data-viewbox="${vb}" data-maxscale="${ms}" data-bbox="${(st.bbox || []).join(" ")}" xmlns="http://www.w3.org/2000/svg">`
    + `<g class="hu-pan">${panGroup.join("")}</g>`
    + `<g class="hu-overlays">${overlayGroup.join("")}</g>`
    + `</svg>`;
}

function dataBar(st) {
  const m = st.meta || {};
  let name = (m.name || "Storm").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const tag = catLabel(m.cat);
  if (tag) name = `${name} (${tag})`;
  const bits = [];
  if (m.type) bits.push(m.type);
  if (m.wind != null) { let s = `${m.wind} ${m.windUnit}`; if (m.gust != null) s += ` (gust ${m.gust})`; bits.push(s); }
  if (m.moveText) bits.push(m.moveText);
  // Distance line + closest approach, kept on ONE basis so "closest" can't read
  // farther than "now": with a wind field both are wind-EDGE distances, else both
  // are eye distances (geometry shifts cpaDist to match). curShown is whatever the
  // current-distance line shows; null when winds are already at home.
  let curShown = null, distLine = null;
  if (m.hasWind && m.windAtHome != null) {
    distLine = `${windForceName(m.windAtHome)} at home`;
  } else if (m.hasWind && m.windDist != null) {
    if (m.windDist <= 0) {                      // rounds to 0 -> home is at/inside the edge, not "0 mi from"
      distLine = `${windForceName(34)} at home`;
    } else {
      curShown = m.windDist;
      distLine = `${withCommas(curShown)} ${m.distUnit} from Tropical Storm force winds`;
    }
  } else if (m.dist != null) {
    curShown = m.dist;
    distLine = `${withCommas(curShown)} ${m.distUnit} from home`;
  }
  if (distLine) bits.push(distLine);
  if (curShown != null && m.cpaDist != null) {
    if (m.cpaDist < curShown) {                 // forecast to get closer than it is now
      let s = `closest ~${withCommas(m.cpaDist)} ${m.distUnit}`;
      const eta = fmtEta(m.cpaHours);
      if (eta && eta !== "now") s += ` in ${eta}`;
      bits.push(s);
    } else {
      bits.push("moving away");                  // closest point is now/behind -- receding
    }
  }
  let peak = "";
  if (m.peak && m.peak.word) peak = `<div class="hu-bar-peak">Peak ${esc(m.peak.word)}${m.peak.label ? " by " + esc(m.peak.label) : ""}</div>`;
  return `<div class="hu-bar-name">${esc(name)}</div><div class="hu-bar-data">${esc(bits.join(" \u00b7 "))}</div>${peak}`;
}

/* Phase 4: the at-home wind timeline -- a compact, self-contained graph UNDER the
 * map (its own zone, never on the map). A titled wind bar whose opacity deepens
 * where stronger thresholds overlap (same nested-alpha language as the on-map
 * wash); the home glyph on the bar at the storm centre's closest pass with the
 * distance tagged above it; and day/time labels INLINE at the real wind start/stop
 * points (weekday shown only when it changes, thinned to avoid collision, ends
 * always kept). Returns "" (renders nothing) unless home is forecast into a field. */
function exposureTimeline(st, cfg) {
  if (cfg.show_timeline === false) return "";
  const ex = st.meta && st.meta.exposure;
  if (!ex || !ex.rows || !ex.rows.length) return "";        // hidden when no data
  const ref = ex.refTime != null ? ex.refTime : null;
  const unit = (st.meta && st.meta.distUnit) || "mi";
  const OP = { 34: 0.16, 50: 0.30, 64: 0.46 };

  // Axis spans exactly the data: earliest wind start -> latest wind stop, widened
  // to include the closest-pass time if it falls outside. No fixed hour grid.
  const bounds = [];
  for (const r of ex.rows) for (const [a, b] of r.windows) bounds.push(a, b);
  const cpa = ex.cpa && ex.cpa.tau != null ? ex.cpa : null;
  const lo = 0;                                             // graph always starts at "now"
  let hi = Math.max.apply(null, bounds);
  if (cpa) hi = Math.max(hi, cpa.tau);
  if (hi - lo < 0.5) hi = lo + 0.5;
  const pct = (t) => ((Math.max(lo, Math.min(hi, t)) - lo) / (hi - lo)) * 100;
  const anchor = (x) => (x < 12 ? "translateX(0)" : x > 88 ? "translateX(-100%)" : "translateX(-50%)");

  // wind bar: stronger thresholds stacked on top -> darker where they overlap
  let bars = "";
  for (const r of ex.rows) for (const [a, b] of r.windows) {
    const l = pct(a), w = Math.max(1.5, pct(b) - l);
    bars += `<span class="hu-tl-win" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%;opacity:${OP[r.kt] || 0.16}"></span>`;
  }

  // closest-pass marker = the same home glyph the map uses, on the bar; distance
  // tagged just above it
  let home = "", tag = "";
  if (cpa) {
    const x = pct(cpa.tau);
    home = `<span class="hu-tl-home" style="left:${x.toFixed(2)}%"><svg viewBox="0 0 24 24"><path d="${MDI_HOME_PATH}"/></svg></span>`;
    if (cpa.dist != null)
      tag = `<span class="hu-tl-tag" style="left:${x.toFixed(2)}%;transform:${anchor(x)}">${esc(withCommas(cpa.dist) + " " + unit)}</span>`;
  }

  // day/time labels at the real wind start/stop points, INLINE (one row): weekday
  // shown only when it changes, then thinned so nothing collides (ends always kept)
  const seen = {}, blist = [];
  for (const t of bounds) { const k = Math.round(t); if (!(k in seen)) { seen[k] = 1; blist.push(t); } }
  blist.sort((a, b) => a - b);
  let prevDay = null;
  const items = [{ x: 0, label: "now" }];                   // left edge is always "now"
  for (const t of blist) {
    const full = ref != null ? fmtClock(ref, t) : `~${Math.round(t)}h`;
    let label = full;
    if (ref != null) {
      const sp = full.indexOf(" ");
      const day = sp > 0 ? full.slice(0, sp) : full;
      if (day === prevDay) label = full.slice(sp + 1);      // drop repeated weekday
      prevDay = day;
    }
    items.push({ x: pct(t), label });
  }
  const n = items.length;
  const wpc = (it) => (it.label.length * 6.2 / 330) * 100;   // est width %, worst-case phone
  const leftOf = (it) => it.x < 12 ? it.x : it.x > 88 ? it.x - wpc(it) : it.x - wpc(it) / 2;
  const keep = new Set([0, n - 1]);
  let lastRight = leftOf(items[0]) + wpc(items[0]);
  const lastLeft = leftOf(items[n - 1]);
  for (let i = 1; i < n - 1; i++) {
    const l = leftOf(items[i]);
    if (l > lastRight + 1 && l + wpc(items[i]) < lastLeft - 1) { keep.add(i); lastRight = l + wpc(items[i]); }
  }
  let times = "";
  items.forEach((it, i) => {
    if (!keep.has(i)) return;
    times += `<span class="hu-tl-tick" style="left:${it.x.toFixed(2)}%"></span>`;
    times += `<span class="hu-tl-time" style="left:${it.x.toFixed(2)}%;transform:${anchor(it.x)}">${esc(it.label)}</span>`;
  });

  return `<div class="hu-tl">
    <div class="hu-tl-title">Storm force winds at home / Closest to eye</div>
    <div class="hu-tl-tagrow">${tag}</div>
    <div class="hu-tl-track">${bars}${home}</div>
    <div class="hu-tl-times">${times}</div>
  </div>`;
}

const STYLE = `
  ha-card { padding: 0; overflow: hidden; }
  .hu-wrap { display: flex; flex-direction: column; position: relative; }
  .hu-tag { font: 600 13px/1 var(--ha-card-header-font-family, inherit); letter-spacing: .08em;
            text-transform: uppercase; color: var(--secondary-text-color); padding: 12px 14px 8px; }
  .hu-conewrap { position: relative; width: 100%; background: var(--hu-bg, var(--primary-background-color)); }
  .hu-svg { display: block; width: 100%; height: auto; touch-action: none; }
  .hu-svg.hu-zoomable { cursor: grab; }
  .hu-svg.hu-zoomable.hu-grabbing { cursor: grabbing; }
  .hu-pan { will-change: transform; }
  .hu-overlays.hu-hide { display: none; }
  .hu-tools { position: absolute; top: 10px; right: 10px; z-index: 2; display: flex; gap: 6px; align-items: center; }
  .hu-recenter { display: none; align-items: center; gap: 5px; border: none; cursor: pointer;
                 background: var(--secondary-background-color); color: var(--primary-text-color);
                 border-radius: 16px; padding: 5px 11px 5px 9px; font: 600 12px/1 sans-serif;
                 box-shadow: 0 1px 4px rgba(0,0,0,.3); opacity: .94; }
  .hu-recenter.hu-show { display: inline-flex; }
  .hu-recenter ha-icon { --mdc-icon-size: 15px; }
  .hu-toolbtn { display: inline-flex; align-items: center; justify-content: center; border: none;
                cursor: pointer; background: var(--secondary-background-color); color: var(--primary-text-color);
                border-radius: 16px; width: 32px; height: 26px;
                box-shadow: 0 1px 4px rgba(0,0,0,.3); opacity: .94; }
  .hu-toolbtn ha-icon { --mdc-icon-size: 16px; }
  .hu-panel { position: absolute; top: 44px; right: 10px; z-index: 3; display: none; min-width: 170px;
              background: var(--card-background-color, var(--primary-background-color)); color: var(--primary-text-color);
              border-radius: 8px; padding: 10px 12px; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
  .hu-panel.hu-open { display: block; }
  .hu-panel-group { font: 700 11px/1 sans-serif; letter-spacing: .06em; text-transform: uppercase;
                    color: var(--secondary-text-color); margin: 6px 0 4px; }
  .hu-panel-group:first-child { margin-top: 0; }
  .hu-panel-row { display: flex; align-items: center; gap: 8px; font: 400 13px/1.2 sans-serif;
                  padding: 4px 0; cursor: pointer; }
  .hu-adv { position: absolute; inset: 0; z-index: 4; display: flex; flex-direction: column;
            background: var(--card-background-color, var(--primary-background-color)); }
  .hu-adv-head { display: flex; align-items: center; justify-content: space-between; gap: 10px;
                 padding: 12px 14px 8px; font: 700 14px/1.2 sans-serif; color: var(--primary-text-color); }
  .hu-adv-close { border: none; background: var(--secondary-background-color); color: var(--primary-text-color);
                  border-radius: 50%; width: 26px; height: 26px; cursor: pointer; font-size: 13px; flex: none; }
  .hu-adv-body { overflow-y: auto; padding: 0 14px 14px; }
  .hu-adv-text { white-space: pre-wrap; overflow-wrap: break-word; color: var(--primary-text-color);
                 font: 400 13px/1.45 ui-monospace, Menlo, Consolas, monospace; }
  .hu-adv-wait { display: flex; justify-content: center; padding: 30px 0; }
  .hu-adv-sub { font-size: 13px; color: var(--secondary-text-color); text-align: center; padding: 20px 0; }
  .hu-land { fill: var(--hu-land-color, var(--divider-color)); opacity: var(--hu-land-opacity, .55); stroke: none; }
  .hu-state { fill: none; stroke: var(--hu-state-color, var(--secondary-text-color)); stroke-width: var(--hu-state-width, .6); opacity: .4; }
  .hu-coast { fill: none; stroke: var(--hu-coast-color, var(--primary-text-color)); stroke-width: var(--hu-coast-width, 1); opacity: var(--hu-coast-opacity, .7); stroke-linejoin: round; stroke-linecap: round; }
  .hu-region { font: 600 12px/1 sans-serif; letter-spacing: .1em; text-transform: uppercase;
               text-anchor: middle; fill: var(--hu-region-color, var(--secondary-text-color)); opacity: .5;
               paint-order: stroke; stroke: var(--hu-bg, var(--primary-background-color)); stroke-width: 3px; }
  .hu-city { fill: var(--secondary-text-color); opacity: .75; }
  .hu-city-label { font: 500 9.5px/1 sans-serif; fill: var(--secondary-text-color); opacity: .75;
                   paint-order: stroke; stroke: var(--hu-bg, var(--primary-background-color)); stroke-width: 2.5px; }
  .hu-scale-tick { stroke: var(--secondary-text-color); stroke-width: 1.5; opacity: .55; }
  .hu-scale-label { font: 600 11px/1 sans-serif; fill: var(--secondary-text-color); opacity: .7;
                    paint-order: stroke; stroke: var(--hu-bg, var(--primary-background-color)); stroke-width: 3px; }
  .hu-wind { fill-opacity: .42; stroke: none; }
  .hu-ww { fill: none; stroke-width: 4; stroke-linecap: round; }
  .hu-cone-poly { fill: var(--hu-cone-color, var(--primary-text-color)); fill-opacity: .08; stroke: var(--hu-cone-color, var(--primary-text-color)); stroke-opacity: .3; stroke-width: 1; }
  .hu-track-past { fill: none; stroke: var(--hu-track-past-color, var(--secondary-text-color)); stroke-width: 2; stroke-dasharray: 4 5; opacity: .6; }
  .hu-track-fcst { fill: none; stroke: var(--hu-track-color, var(--primary-text-color)); stroke-width: 2.5; opacity: .85; }
  .hu-fdot { stroke: rgba(0,0,0,.35); stroke-width: 1; }
  .hu-fcat { font: 700 13px/1 sans-serif; text-anchor: middle; }
  .hu-flabel { font: 700 17px/1 sans-serif; fill: var(--primary-text-color);
               paint-order: stroke; stroke: var(--hu-bg, var(--primary-background-color)); stroke-width: 3px; }
  .hu-home path { fill: #fff; stroke: rgba(0,0,0,.55); stroke-width: 1.5; paint-order: stroke; }
  .hu-edge-chev { fill: none; stroke: var(--primary-text-color); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; opacity: .9; }
  .hu-edge-label { font: 700 17px/1 sans-serif; fill: var(--primary-text-color);
                   paint-order: stroke; stroke: var(--hu-bg, var(--primary-background-color)); stroke-width: 3px; }
  .hu-bar { padding: 10px 14px 14px; }
  .hu-bar-name { font-size: 20px; font-weight: 700; color: var(--primary-text-color); }
  .hu-bar-data { font-size: 14px; color: var(--secondary-text-color); margin-top: 2px; }
  .hu-bar-peak { font-size: 13px; color: var(--secondary-text-color); margin-top: 4px; opacity: .9; }
  .hu-tl { padding: 8px 14px 10px; }
  .hu-tl-title { font-size: 12px; font-weight: 700; letter-spacing: .02em; color: var(--primary-text-color); opacity: .9; margin-bottom: 6px; }
  .hu-tl-tagrow { position: relative; height: 15px; }
  .hu-tl-tag { position: absolute; bottom: 0; white-space: nowrap; font: 600 11px/1 sans-serif; color: var(--secondary-text-color); }
  .hu-tl-track { position: relative; height: 16px; border-radius: 3px;
                 background: var(--divider-color, rgba(127,127,127,.2)); }
  .hu-tl-win { position: absolute; top: 0; height: 100%; border-radius: 3px; background: var(--primary-text-color); }
  .hu-tl-home { position: absolute; top: 50%; width: 18px; height: 18px; transform: translate(-50%, -50%); }
  .hu-tl-home svg { width: 100%; height: 100%; display: block; }
  .hu-tl-home path { fill: #fff; stroke: rgba(0,0,0,.55); stroke-width: 1.5; paint-order: stroke; }
  .hu-tl-times { position: relative; height: 20px; margin-top: 4px; }
  .hu-tl-tick { position: absolute; top: 0; width: 1px; height: 5px; transform: translateX(-50%);
                background: var(--secondary-text-color); opacity: .5; }
  .hu-tl-time { position: absolute; top: 7px; white-space: nowrap; font: 400 11px/1 sans-serif; color: var(--secondary-text-color); }
  .hu-msg { padding: 28px 18px; text-align: center; color: var(--secondary-text-color); }
  .hu-msg .hu-msg-icon { --mdc-icon-size: 40px; color: var(--secondary-text-color); opacity: .7; }
  .hu-msg .hu-msg-icon.hu-spin { animation: hu-spin 1.4s linear infinite; transform-origin: center; }
  @keyframes hu-spin { to { transform: rotate(360deg); } }
  .hu-msg .hu-msg-title { font-size: 18px; font-weight: 700; color: var(--primary-text-color); margin-top: 8px; }
  .hu-msg .hu-msg-sub { font-size: 14px; margin-top: 4px; }
  .hu-stale { font-size: 12px; color: var(--warning-color, #d68b00); padding: 0 14px 10px; }
  .hu-pager { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 0 0 12px; }
  .hu-pager button { border: none; background: var(--secondary-background-color); color: var(--primary-text-color);
                     border-radius: 50%; width: 30px; height: 30px; font-size: 16px; cursor: pointer; }
  .hu-pager .hu-page { font-size: 13px; color: var(--secondary-text-color); min-width: 40px; text-align: center; }
`;

class HurricaneCard extends HTMLElement {
  constructor() {
    super(); this._data = null; this._err = false; this._idx = 0; this._timer = null;
    this._built = false; this._savedView = null; this._viewStormId = null; this._resetView = false;
    // Optional-layer platform (Session E): sticky toggles, panel/overlay open
    // state (kept on the instance so a background poll's re-render doesn't
    // close them under the user), and the per-(storm,advisory) session cache.
    this._layerPrefs = loadLayerPrefs(); this._panelOpen = false;
    this._advOpen = false; this._advTitle = ""; this._advBody = ""; this._layerCache = {};
  }

  setConfig(config) { this._config = config || {}; if (this.shadowRoot) this._render(); }
  getCardSize() { return 6; }
  static getStubConfig() { return {}; }
  static getConfigElement() { return document.createElement("hurricane-card-editor"); }

  set hass(hass) {
    const first = !this._built;
    this._hass = hass;
    if (first) { this._built = true; this._render(); this._fetch(); }
  }

  connectedCallback() {
    if (this._hass && !this._data) { this._render(); this._fetch(); }
    if (!this._timer) this._timer = setInterval(() => this._fetch(), REFRESH_MS);
  }
  disconnectedCallback() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  _fetch() {
    if (!this._hass) return;
    this._hass.callWS({ type: WS_TYPE }).then((res) => {
      const prevId = this._currentStormId();   // remember which storm the user is on
      this._data = res && res.data ? res.data : null;
      this._lastOk = res ? res.last_success !== false : true;
      this._err = false;
      // Keep the user on the same storm across a background poll (don't snap to
      // storm 1). Re-find it by id in the new list; fall back to 0 if it's gone.
      // A poll is NOT a storm switch, so the pan/zoom view is preserved (see
      // _setupPanZoom) -- only an explicit pager tap or a storm change resets it.
      const storms = (this._data && this._data.storms) || [];
      let idx = 0;
      if (prevId != null) {
        const found = storms.findIndex((s) => s.stormId === prevId);
        if (found >= 0) idx = found;
      }
      this._idx = idx;
      this._render();
    }).catch(() => {
      // Keep the last good render if we have one; only surface an error on cold start.
      if (!this._data) { this._err = true; this._render(); }
    });
  }

  // Id of the storm currently shown (for view/selection continuity across polls).
  _currentStormId() {
    const storms = (this._data && this._data.storms) || [];
    const st = storms[this._idx];
    return st ? (st.stormId || null) : null;
  }

  /* Advisory-text layer (E2, first rider on the layer platform): requested over
   * the layer websocket only when the user opens it, session-cached per
   * (storm, advisory) -- a new advisory misses and refetches; re-open is
   * instant. Failure renders an honest 'unavailable', never fake text. */
  _openAdvisory() {
    const storms = (this._data && this._data.storms) || [];
    const st = storms[this._idx];
    if (!st || !this._hass) return;
    const sid = st.stormId || "";
    const key = `advisory|${sid}|${st.advisory || ""}`;
    this._advOpen = true;
    this._advTitle = `${(st.meta && st.meta.name) || "Storm"} advisory`;
    const cached = this._layerCache[key];
    if (cached) {
      this._advTitle = cached.title || this._advTitle;
      this._advBody = `<div class="hu-adv-text">${esc(cached.text)}</div>`;
      this._render();
      return;
    }
    this._advBody = `<div class="hu-adv-wait"><ha-icon class="hu-msg-icon hu-spin" icon="mdi:weather-hurricane"></ha-icon></div>`;
    this._render();
    this._hass.callWS({ type: WS_LAYER_TYPE, storm_id: sid, layer: "advisory" }).then((res) => {
      if (!this._advOpen) return;   // closed while loading
      if (res && res.ok && res.text) {
        this._layerCache[key] = res;
        this._advTitle = res.title || this._advTitle;
        this._advBody = `<div class="hu-adv-text">${esc(res.text)}</div>`;
      } else {
        this._advBody = `<div class="hu-adv-sub">Advisory text isn&rsquo;t available right now. It&rsquo;ll be retried next time you open this.</div>`;
      }
      this._render();
    }).catch(() => {
      if (!this._advOpen) return;
      this._advBody = `<div class="hu-adv-sub">Advisory text isn&rsquo;t available right now. It&rsquo;ll be retried next time you open this.</div>`;
      this._render();
    });
  }

  _msg(icon, title, sub, spin) {
    return `<div class="hu-msg"><ha-icon class="hu-msg-icon${spin ? " hu-spin" : ""}" icon="${icon}"></ha-icon>
      <div class="hu-msg-title">${esc(title)}</div>${sub ? `<div class="hu-msg-sub">${esc(sub)}</div>` : ""}</div>`;
  }

  _styleVars() {
    const c = this._config || {};
    let s = "";
    for (const [k, v] of Object.entries(COLOR_VARS))
      if (c[k] != null && c[k] !== "") s += `${v}:${c[k]};`;
    return s;
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const cfg = this._config || {};
    const d = this._data;
    let body;

    if (!d) {
      body = this._err
        ? this._msg("mdi:cloud-alert", "Can\u2019t reach Home Assistant", "Retrying automatically\u2026", false)
        : this._msg("mdi:weather-hurricane", "Loading\u2026", "", true);
    } else if (d.ok && (d.storms || []).length) {
      const storms = d.storms;
      if (this._idx >= storms.length) this._idx = 0;
      const st = storms[this._idx];
      // Per-storm staleness: this storm's live re-bake failed and we're showing
      // its last-good cached cone. Name the time so the user knows how old it is.
      const stale = st.stale
        ? `<div class="hu-stale">Live feed unreachable \u2014 showing last update${
            st.bakedTs ? " from " + esc(fmtLocal(st.bakedTs)) : ""}.</div>` : "";
      let pager = "";
      if (storms.length > 1) {
        pager = `<div class="hu-pager">
          <button data-nav="-1" aria-label="Previous storm">\u2039</button>
          <span class="hu-page">${this._idx + 1} / ${storms.length}</span>
          <button data-nav="1" aria-label="Next storm">\u203a</button></div>`;
      }
      const tagName = cfg.title != null ? cfg.title : `Hurricane \u00b7 ${(st.meta && st.meta.basinName) || ""}`;
      let svg = "";
      try { svg = buildConeSvg(st, cfg); }
      catch (e) { svg = this._msg("mdi:map-marker-alert", "Couldn\u2019t draw this storm", "", false); }
      // Map chrome: recenter (zoom), the advisory doc button (only when that
      // layer is on), and the gear that opens the layers panel. The panel lists
      // OPTIONAL_LAYERS grouped by topic; the advisory overlay covers the whole
      // card and survives background re-renders via instance state.
      const prefs = this._layerPrefs || {};
      let panelRows = "", lastGroup = null;
      for (const l of OPTIONAL_LAYERS) {
        if (l.group !== lastGroup) { panelRows += `<div class="hu-panel-group">${esc(l.group)}</div>`; lastGroup = l.group; }
        panelRows += `<label class="hu-panel-row"><input type="checkbox" data-layer="${l.id}" ${prefs[l.id] ? "checked" : ""}/> ${esc(l.label)}</label>`;
      }
      const tools = `<div class="hu-tools">
          <button class="hu-recenter" aria-label="Recenter map"><ha-icon icon="mdi:image-filter-center-focus"></ha-icon>Recenter</button>
          ${prefs.advisory ? `<button class="hu-toolbtn hu-doc" aria-label="Advisory text" title="Advisory text"><ha-icon icon="mdi:text-box-outline"></ha-icon></button>` : ""}
          <button class="hu-toolbtn hu-gear" aria-label="Map layers" title="Map layers"><ha-icon icon="mdi:cog-outline"></ha-icon></button>
        </div>
        <div class="hu-panel${this._panelOpen ? " hu-open" : ""}">${panelRows}</div>`;
      const adv = this._advOpen ? `<div class="hu-adv">
          <div class="hu-adv-head"><span>${esc(this._advTitle || "Advisory")}</span>
          <button class="hu-adv-close" aria-label="Close">&#x2715;</button></div>
          <div class="hu-adv-body">${this._advBody || ""}</div></div>` : "";
      body = `<div class="hu-tag">${esc(tagName)}</div>
        <div class="hu-conewrap">${svg}${tools}</div>
        <div class="hu-bar">${dataBar(st)}</div>${exposureTimeline(st, cfg)}${pager}${stale}${adv}`;
    } else if (d.reason === "none_matched") {
      const n = d.activeAnywhere || 0;
      body = this._msg("mdi:map-marker-off", "No storms near you",
        n ? `${n} active elsewhere \u2014 none match this card\u2019s scope.` : "");
    } else if (d.off_season === "hide") {
      this.style.display = "none";
      return;
    } else if (d.reason === "unavailable") {
      // A source is down. If systems are known active anywhere, a storm may be
      // live and we simply can\u2019t draw it -- say so, and make clear this is an
      // outage, NOT an all-clear. Name the feed that failed so it\u2019s checkable.
      const src = sourceNames(d.failedSources);
      if (d.activeAnywhere) {
        body = this._msg("mdi:cloud-alert", "Storm active \u2014 map unavailable",
          `A storm is active, but its map couldn\u2019t load from ${src}. This is a data outage, not an all-clear. Retrying automatically.`);
      } else {
        body = this._msg("mdi:cloud-alert", "Storm feed unavailable",
          `Couldn\u2019t reach ${src}. This is a data outage, not an all-clear \u2014 there may be a storm we can\u2019t see. Retrying automatically.`);
      }
    } else if (d.reason === "no_geometry") {
      // Defensive: post-cache this should rarely fire (a failed bake now serves
      // cached data or routes to "unavailable"). Treat it as map-unavailable.
      body = this._msg("mdi:cloud-alert", "Storm active \u2014 map unavailable",
        "A storm is active, but its map couldn\u2019t load. Retrying automatically.");
    } else {
      body = this._msg("mdi:weather-sunny", "All clear", "No active storms right now.");
    }

    this.style.display = "";
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card><div class="hu-wrap" style="${this._styleVars()}">${body}</div></ha-card>`;
    this.shadowRoot.querySelectorAll("[data-nav]").forEach((b) =>
      b.addEventListener("click", () => {
        const n = Number(b.getAttribute("data-nav"));
        const len = (this._data.storms || []).length;
        this._idx = (this._idx + n + len) % len;
        this._resetView = true;   // explicit storm switch -> reset pan/zoom to default
        this._panelOpen = false;
        this._advOpen = false;    // overlay is per-storm; a switch closes it
        this._render();
      }));

    // Layer platform chrome (gear/panel/doc/overlay). All open/pref state lives
    // on the instance, so it survives the full innerHTML rebuild every render.
    const gear = this.shadowRoot.querySelector(".hu-gear");
    gear && gear.addEventListener("click", () => { this._panelOpen = !this._panelOpen; this._render(); });
    this.shadowRoot.querySelectorAll("input[data-layer]").forEach((el) =>
      el.addEventListener("change", () => {
        const id = el.getAttribute("data-layer");
        this._layerPrefs = setLayerPref(this._layerPrefs || {}, id, el.checked);
        if (id === "advisory" && !el.checked) this._advOpen = false;
        this._render();
      }));
    const doc = this.shadowRoot.querySelector(".hu-doc");
    doc && doc.addEventListener("click", () => this._openAdvisory());
    const closeBtn = this.shadowRoot.querySelector(".hu-adv-close");
    closeBtn && closeBtn.addEventListener("click", () => { this._advOpen = false; this._render(); });

    // Rebuild attaches a fresh gesture layer. Whether it starts at the default
    // frame or restores the user's zoom/pan is decided in _setupPanZoom: a storm
    // switch or a storm-identity change resets; a background poll of the SAME storm
    // preserves the view so it doesn't snap out from under the user mid-read.
    this._setupPanZoom();
  }

  /* ---- pan / zoom (Session C) -----------------------------------------------
   * The map layers (hu-pan group) are transformed in SVG user space; the buffered
   * coastline baked into the payload extends past the 800x600 frame, so panning
   * just reveals already-drawn geometry -- no re-fetch, no reprojection, no DOM
   * rebuild. Pointer Events cover mouse drag, touch drag, and two-finger pinch;
   * wheel zooms at the cursor. Transform writes are rAF-batched. Screen-space
   * overlays hide off-default and return on recenter. */
  _setupPanZoom() {
    const svg = this.shadowRoot.querySelector(".hu-svg");
    // Decide reset vs restore ONCE per render, then clear the one-shot flag. Reset
    // when: an explicit storm switch (pager set _resetView), or the shown storm's
    // id differs from the one the saved view belongs to (storm changed under us).
    const stormId = this._currentStormId();
    const reset = this._resetView === true || this._viewStormId !== stormId;
    this._resetView = false;
    if (!svg) { this._view = null; this._savedView = null; this._viewStormId = stormId; return; }
    const pan = svg.querySelector(".hu-pan");
    const overlays = svg.querySelector(".hu-overlays");
    const btn = this.shadowRoot.querySelector(".hu-recenter");
    const vb = (svg.getAttribute("data-viewbox") || "").split(" ").map(Number).filter((x) => !isNaN(x));
    const bb = (svg.getAttribute("data-bbox") || "").split(" ").map(Number).filter((x) => !isNaN(x));
    const maxScale = Number(svg.getAttribute("data-maxscale")) || 1;
    if (!pan || vb.length !== 4 || bb.length !== 4 || maxScale <= 1) {
      // No buffered frame (older payload) or nothing to zoom into: leave the map
      // static, exactly as before Session C.
      this._view = null; this._savedView = null; this._viewStormId = stormId;
      return;
    }
    svg.classList.add("hu-zoomable");

    // Pannable pixel extent. The default frame maps bbox -> 0..VBW / 0..VBH. The
    // buffered viewBox is wider by (vb_span / bb_span); drawn through the SAME
    // default projection, its edges land that many px outside the frame. At scale s
    // the on-screen content spans s*VBW; translate is clamped so you can pan to the
    // buffer edge but no further into empty space. Longitude uses the x ratio,
    // latitude the y ratio (handles the aspect-fitted bbox + antimeridian-wrapped
    // viewBox alike: the wrap is already resolved in the baked pixel coords, so we
    // only ever reason about pixel spans here, never longitudes).
    const bbW = bb[2] - bb[0], bbH = bb[3] - bb[1];
    const marginX = bbW > 0 ? ((vb[2] - vb[0]) / bbW - 1) / 2 * VBW : 0;  // px of buffer past each L/R edge
    const marginY = bbH > 0 ? ((vb[3] - vb[1]) / bbH - 1) / 2 * VBH : 0;  // px past each T/B edge

    // Zoom-out floor: at scale 1 the content fills the frame; the buffered viewBox
    // is (vb/bb)x wider, so zooming out to bb/vb (~0.5 for the 2x buffer) makes the
    // WHOLE baked buffer fit the frame. That's as far out as there's geometry to
    // show -- past it is empty. Derived from the payload so it tracks the buffer
    // factor. Never let the floor exceed 1 (guards a degenerate/absent buffer).
    const minScale = Math.min(1, Math.max(bbW / (vb[2] - vb[0] || bbW),
                                          bbH / (vb[3] - vb[1] || bbH)));

    // Start at the default frame on a reset (storm switch / new storm); otherwise
    // restore the view the user left on the SAME storm before this poll rebuilt the
    // DOM. The restored value is clamped below, so a slightly different frame can't
    // push it out of bounds.
    const saved = (!reset && this._savedView) ? this._savedView : null;
    const view = saved ? { s: saved.s, tx: saved.tx, ty: saved.ty } : { s: 1, tx: 0, ty: 0 };
    this._view = view;
    this._viewStormId = stormId;
    let raf = 0;
    const EPS = 0.001;
    const isDefault = () => view.s <= 1 + EPS && view.s >= 1 - EPS
                          && Math.abs(view.tx) < 0.5 && Math.abs(view.ty) < 0.5;

    // Legal translate slack at a given scale. Above s=1 you can pan across the
    // zoomed content + into the baked buffer. At/below s=1 the content is no larger
    // than the frame, so slack floors at 0 -> the map stays centered. HARD limits:
    // no rubber-band, no overpan -- the clamp is applied every frame in apply().
    const slackAt = (s) => [
      Math.max(0, (s - 1) * VBW / 2) + marginX * s,
      Math.max(0, (s - 1) * VBH / 2) + marginY * s,
    ];
    const clampScale = (s) => Math.max(minScale, Math.min(maxScale, s));
    const clamp = () => {
      view.s = clampScale(view.s);
      const [sx, sy] = slackAt(view.s);
      view.tx = Math.max(-sx, Math.min(sx, view.tx));
      view.ty = Math.max(-sy, Math.min(sy, view.ty));
    };

    const apply = () => {
      raf = 0;
      clamp();   // enforce hard bounds before every paint -- nothing illegal renders
      pan.setAttribute("transform", `translate(${view.tx.toFixed(2)} ${view.ty.toFixed(2)}) scale(${view.s.toFixed(4)})`);
      const def = isDefault();
      overlays && overlays.classList.toggle("hu-hide", !def);
      btn && btn.classList.toggle("hu-show", !def);
      // Remember the live view so a background poll (which rebuilds the DOM) can
      // restore it. Cleared to null when at the default frame, so a fresh storm or
      // a recenter starts clean.
      this._savedView = def ? null : { s: view.s, tx: view.tx, ty: view.ty };
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };

    // px per SVG user-unit (the SVG is width:100%, so this varies with card width)
    const scaleFactor = () => {
      const r = svg.getBoundingClientRect();
      return r.width ? VBW / r.width : 1;   // client px -> user units
    };
    // client coords -> SVG user coords (pre-transform frame)
    const toUser = (clientX, clientY) => {
      const r = svg.getBoundingClientRect();
      const f = scaleFactor();
      return [(clientX - r.left) * f, (clientY - r.top) * f];
    };
    // Zoom about a fixed user-space point, holding that point under the cursor/pinch.
    // Scale is clamped to [minScale, maxScale] FIRST, then the translate is derived
    // from the clamped scale -- so a zoom that hits a limit produces no leftover
    // translate drift (the old bug where repeated wheel-in crept down-right).
    const zoomAt = (ux, uy, ns) => {
      ns = clampScale(ns);
      const k = ns / view.s;
      view.tx = ux - (ux - view.tx) * k;
      view.ty = uy - (uy - view.ty) * k;
      view.s = ns;
      schedule();
    };

    const pointers = new Map();
    let pinchDist = 0, pinchMid = [0, 0];

    const onDown = (e) => {
      pointers.set(e.pointerId, e);
      svg.setPointerCapture(e.pointerId);
      svg.classList.add("hu-grabbing");
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
        pinchMid = toUser((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      }
    };
    const onMove = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, e);
      const f = scaleFactor();
      if (pointers.size === 1) {
        view.tx += (e.clientX - prev.clientX) * f;
        view.ty += (e.clientY - prev.clientY) * f;
        schedule();   // clamp() in apply() bounds it -- can't pan past the edge
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
        const mid = toUser((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        // pan by the midpoint drift, then scale about the current midpoint
        view.tx += mid[0] - pinchMid[0];
        view.ty += mid[1] - pinchMid[1];
        pinchMid = mid;
        zoomAt(mid[0], mid[1], view.s * (dist / pinchDist));
        pinchDist = dist;
      }
    };
    const onUp = (e) => {
      pointers.delete(e.pointerId);
      try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) svg.classList.remove("hu-grabbing");
    };
    const onWheel = (e) => {
      e.preventDefault();
      const [ux, uy] = toUser(e.clientX, e.clientY);
      const factor = Math.exp(-e.deltaY * 0.0015);   // smooth, direction-correct
      zoomAt(ux, uy, view.s * factor);
    };

    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
    svg.addEventListener("wheel", onWheel, { passive: false });
    btn && btn.addEventListener("click", () => {
      view.s = 1; view.tx = 0; view.ty = 0; schedule();
    });

    // If we restored a non-default view (background poll of the same storm), paint
    // it now so the map comes back exactly where the user left it -- not at default
    // for a frame until the next gesture.
    if (saved) schedule();
  }
}

/* ---- lightweight visual editor (optional; YAML config also fully works) ---- */
const EDITOR_FIELDS = [
  { key: "title", label: "Title override", type: "text" },
  { key: "show_land", label: "Show land fill", type: "bool", def: true },
  { key: "show_coast", label: "Show coastlines", type: "bool", def: true },
  { key: "show_states", label: "Show state/province lines", type: "bool", def: true },
  { key: "show_cities", label: "Show city dots", type: "bool", def: true },
  { key: "show_labels", label: "Show region labels", type: "bool", def: true },
  { key: "show_scale", label: "Show offshore mileage scale", type: "bool", def: true },
  { key: "show_home", label: "Show home marker", type: "bool", def: true },
  { key: "show_winds", label: "Show wind field", type: "bool", def: true },
  { key: "show_timeline", label: "Show at-home wind timeline", type: "bool", def: true },
  { key: "smooth", label: "Smooth coastlines", type: "bool", def: true },
  { key: "coast_color", label: "Coastline color", type: "color" },
  { key: "land_color", label: "Land fill color", type: "color" },
  { key: "state_color", label: "State line color", type: "color" },
  { key: "track_color", label: "Forecast track color", type: "color" },
  { key: "cone_color", label: "Cone color", type: "color" },
  { key: "region_color", label: "Label color", type: "color" },
  { key: "background_color", label: "Map background", type: "color" },
];

class HurricaneCardEditor extends HTMLElement {
  setConfig(config) { this._config = { ...config }; this._render(); }
  set hass(h) { this._hass = h; }

  _emit() {
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config }, bubbles: true, composed: true,
    }));
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const c = this._config || {};
    const rows = EDITOR_FIELDS.map((f) => {
      if (f.type === "bool") {
        const on = c[f.key] == null ? f.def : c[f.key];
        return `<label class="row"><input type="checkbox" data-k="${f.key}" ${on ? "checked" : ""}/> ${f.label}</label>`;
      }
      if (f.type === "color") {
        const v = c[f.key] || "";
        return `<label class="row">${f.label}
          <span class="cwrap"><input type="color" data-k="${f.key}" value="${v || "#888888"}"/>
          <button data-clear="${f.key}" title="Reset to theme">reset</button></span></label>`;
      }
      return `<label class="row">${f.label}<input type="text" data-k="${f.key}" value="${(c[f.key] || "").replace(/"/g, "&quot;")}"/></label>`;
    }).join("");
    this.shadowRoot.innerHTML = `<style>
      .row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 2px; font-size:14px; }
      .row input[type=text], .row input[type=color] { min-width: 120px; }
      .cwrap { display:flex; align-items:center; gap:6px; }
      .cwrap button { font-size:11px; cursor:pointer; }
      .note { font-size:12px; opacity:.7; padding:6px 2px 10px; }
    </style>
    <div class="note">Leave colors on "reset" to follow your dashboard theme. All options are optional.</div>
    ${rows}`;

    this.shadowRoot.querySelectorAll("input[data-k]").forEach((el) =>
      el.addEventListener("input", () => {
        const k = el.getAttribute("data-k");
        if (el.type === "checkbox") this._config[k] = el.checked;
        else if (el.value === "") delete this._config[k];
        else this._config[k] = el.value;
        this._emit();
      }));
    this.shadowRoot.querySelectorAll("button[data-clear]").forEach((b) =>
      b.addEventListener("click", () => {
        delete this._config[b.getAttribute("data-clear")];
        this._render(); this._emit();
      }));
  }
}

if (!customElements.get("hurricane-card")) {
  customElements.define("hurricane-card", HurricaneCard);
  if (!customElements.get("hurricane-card-editor"))
    customElements.define("hurricane-card-editor", HurricaneCardEditor);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "hurricane-card",
    name: "Hurricane Tracker",
    description: "Storm-framed cone for hurricanes, typhoons & cyclones worldwide (NHC + GDACS).",
    preview: false,
  });
}
