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
  { id: "models", label: "Forecast model tracks", group: "Storm info", radio: null, nhcOnly: true },
  { id: "wind_history", label: "Wind history trail", group: "Storm info", radio: null, nhcOnly: true },
  // Advisory text sits LAST in the panel and is off by default (Aaron's call).
  { id: "advisory", label: "Advisory text", group: "Storm info", radio: null },
];
/* Three-way sibling toggles (E5). Each group is ONE slider: LEFT = the default
 * sibling (matches pre-E5 always-on behavior, so left is the out-of-box state),
 * CENTER = both off, RIGHT = the alternate sibling. States are the strings
 * "left" | "off" | "right" in prefs.tri[key] (sticky per browser, like the
 * layer toggles). Wind + dots are client-only re-renders (data already baked);
 * stripe-right (storm surge) is an on-demand fetch over the layer websocket.
 * `master` names a card-config toggle that gates the whole group (dashboard
 * admin wins over viewer prefs); `nhcOnly` groups render disabled on GDACS
 * storms and fall back to their left/default state. */
const TRI_GROUPS = [
  { key: "wind",   title: "Wind field",     lLabel: "Current",    rLabel: "Swath",      def: "left", master: "show_winds" },
  { key: "dots",   title: "Place dots",     lLabel: "Cities",     rLabel: "Population", def: "left", master: "show_cities" },
  { key: "stripe", title: "Coastal stripe", lLabel: "Watch/warn", rLabel: "Surge",      def: "left", nhcOnly: true },
];
function triState(prefs, key) {
  const g = TRI_GROUPS.find((t) => t.key === key);
  const v = prefs && prefs.tri ? prefs.tri[key] : null;
  return (v === "left" || v === "off" || v === "right") ? v : (g ? g.def : "off");
}
function setTriPref(prefs, key, v) {
  prefs.tri = prefs.tri || {};
  prefs.tri[key] = v;
  saveLayerPrefs(prefs);
  return prefs;
}
/* Population-scaled dot radius (E5 pop-density rendering): RELATIVE to the
 * places in the current frame -- biggest drawn place = POP_DOT_MAX_R px,
 * smallest = POP_DOT_MIN_R px, sqrt-interpolated (area-proportional between
 * the frame's extremes). Two absolute ramps were tried and BOTH flattened out
 * (log compressed everything to a 1-2px spread; absolute-sqrt capped every
 * 1.5M+ metro at 9px, and in a metro-dense frame like East Asia the top-N
 * selection is ALL 1.5M+ metros). Per-frame normalization is standard
 * graduated-symbol practice and shows the full size range in every region;
 * don't go back to an absolute ramp. */
const POP_DOT_MIN_R = 1.2;   // px radius of the frame's smallest place
const POP_DOT_MAX_R = 9.0;   // px radius of the frame's biggest place
function popScaler(pops) {
  let lo = Infinity, hi = 0;
  for (const n of pops) {
    const v = Math.sqrt(Math.max(Number(n) || 0, 1));
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  return (pop) => {
    if (span <= 0) return (POP_DOT_MIN_R + POP_DOT_MAX_R) / 2;   // degenerate frame (all same pop)
    const v = Math.sqrt(Math.max(Number(pop) || 0, 1));
    return POP_DOT_MIN_R + (POP_DOT_MAX_R - POP_DOT_MIN_R) * ((v - lo) / span);
  };
}
/* Min px distance from a point to a polygon/polyline (0 when inside a
 * closed poly). Used for the population-dot fade along the projected path. */
function distToPoly(x, y, poly) {
  if (poly.length >= 3 && pointInPoly(x, y, poly)) return 0;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], ay = poly[j][1];
    const dx = poly[i][0] - ax, dy = poly[i][1] - ay;
    const dd = dx * dx + dy * dy;
    let t = dd ? ((x - ax) * dx + (y - ay) * dy) / dd : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}
/* Population-dot fade: gaussian falloff of dot opacity with px distance from
 * the cone (sigma below); full strength inside/at the cone, gone ~2.5 sigma
 * out. Per-dot opacity is the cheap equivalent of a blur-out -- an actual SVG
 * gaussian filter over hundreds of circles would wreck phone GPUs. Dots that
 * fade below POP_ALPHA_MIN are skipped entirely (fewer DOM nodes). */
const POP_FADE_SIGMA = 100;   // fade falloff px from the cone (Aaron, 2026-07-09)
const POP_BASE_ALPHA = 0.7;    // dot opacity at the cone (Aaron, 2026-07-09)
const POP_ALPHA_MIN = 0.04;
/* Compact population figure for the data bar: 34M / 3.4M / 820k. */
const fmtPop = (n) => n >= 1e6 ? ((n / 1e6 >= 10 ? Math.round(n / 1e6) : (n / 1e6).toFixed(1)) + "M")
  : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
/* Cities-mode draw cap: the payload carries ~120 places for the density view;
 * uniform city dots keep the old top-30 look (payload arrives pop-sorted). */
const CITY_DOT_DRAW = 30;
/* Peak-surge band identity colors (NHC's blue->purple severity ramp, fixed
 * hexes). symbolid is matched by color word; unknown falls back by index. */
const SURGE_COLOR = { blue: "#64B5F6", yellow: "#FFE14D", orange: "#FB8C00", red: "#E53935", purple: "#AB47BC" };
const SURGE_ORDER = ["blue", "yellow", "orange", "red", "purple"];
function surgeColor(band, i) {
  const s = String((band && band.sym) || "").toLowerCase();
  for (const k of SURGE_ORDER) if (s.includes(k)) return SURGE_COLOR[k];
  return SURGE_COLOR[SURGE_ORDER[Math.min(Math.max(i, 0), 4)]];
}
/* NHC storm ids are basin-prefixed (al/ep/cp + number + year); GDACS ids are
 * bare event numbers. Gates the NHC-only layers (model tracks). */
const isNhcId = (sid) => /^(al|ep|cp)\d/i.test(sid || "");
/* E4 model-track identity colors (fixed hexes like the cat ramp -- a GFS line
 * must read as GFS on any theme). HCCA shares TVCN's color: same consensus
 * slot, never drawn together. */
const MODEL_COLOR = {
  OFCL: "#EDE3D2", TVCN: "#00E5FF", HCCA: "#00E5FF",
  AVNO: "#B388FF", HFSA: "#FFAB40", UKX: "#F06292",
};
const modelColor = (id) => MODEL_COLOR[id] || "#9E9E9E";
const LAYER_STORE_KEY = "hurricane-card:layers";
function loadLayerPrefs() {
  let p;
  try { p = JSON.parse(localStorage.getItem(LAYER_STORE_KEY)) || {}; }
  catch (_) { p = {}; }   // storage blocked (some webviews) -> session-only
  // Migrate the pre-E5 wind_swath boolean into the wind tri-state.
  if (!p.tri) { p.tri = {}; if (p.wind_swath) p.tri.wind = "right"; }
  delete p.wind_swath;
  return p;
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

/* ---- E6 zoom-aware label engine -------------------------------------------
 * Region names + city labels are GEOGRAPHIC (they ride hu-pan and pan with the
 * map) but their text must hold a constant on-screen size and their collision/
 * visibility must be decided at the CURRENT view, not the default frame. Each
 * label is its own <g class="hu-zl"> anchored at its geographic point with a
 * counter-scale: translate(ax,ay) scale(1/s). The gesture layer updates that
 * counter-scale every frame (cheap) and re-runs this layout pass ~150 ms after
 * the view settles (collision, tier gating, reveal-on-pan). Screen position of
 * any default-frame px point under the view (s,tx,ty) is simply s*p+t, so the
 * keep-out boxes of the geographic storm furniture (forecast dots + their time
 * labels) and the cone polygon transform affinely. Screen-space overlay boxes
 * (home marker, model legend) apply only at the default frame -- the overlays
 * are hidden everywhere else. */
const REGION_CHAR_W = 7.4;
/* Nudge offsets tried in order (px). Anchor first, then toward open water nearby. */
const REGION_NUDGES = [[0, 0], [0, 15], [0, -15], [16, 0], [-16, 0], [0, 28], [0, -28], [22, 14], [-22, 14], [22, -14], [-22, -14], [0, 42], [0, -42]];
function layoutZoomLabels(ctx, view) {
  const s = view.s || 1, tx = view.tx || 0, ty = view.ty || 0;
  const T = (x, y) => [s * x + tx, s * y + ty];
  const keep = ctx.keepGeo.map((b) =>
    ({ x1: s * b.x1 + tx, y1: s * b.y1 + ty, x2: s * b.x2 + tx, y2: s * b.y2 + ty }));
  const atDefault = s <= 1.001 && s >= 0.999 && Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5;
  if (atDefault) keep.push(...ctx.keepScreen);
  const conePx = ctx.conePx.map(([x, y]) => T(x, y));
  const k = (1 / s).toFixed(4);
  const zl = (ax, ay, inner) =>
    `<g class="hu-zl" data-ax="${ax.toFixed(1)}" data-ay="${ay.toFixed(1)}" transform="translate(${ax.toFixed(1)} ${ay.toFixed(1)}) scale(${k})">${inner}</g>`;

  // Region names: tier gate on the EFFECTIVE span (zooming in reveals states),
  // anchor must be on the current frame (panning into the buffer reveals more),
  // then the same nudge-to-open-water pass as ever -- all in screen space.
  const placed = [], regions = [];
  const maxTier = (ctx.span / s) > 16 ? 0 : 1;
  const clear = (box) => {
    if (box.x1 < 22 || box.x2 > VBW - 22 || box.y1 < 14 || box.y2 > VBH - 14) return false;
    const my = (box.y1 + box.y2) / 2;
    if (conePx.length >= 3 && [box.x1 + 2, (box.x1 + box.x2) / 2, box.x2 - 2].some((px) => pointInPoly(px, my, conePx))) return false;
    if (keep.some((b) => boxHit(box, b))) return false;
    if (placed.some((b) => boxHit(box, b))) return false;
    return true;
  };
  for (const r of ctx.regions) {
    if (r.tier > maxTier) continue;
    const [sax, say] = T(r.ax, r.ay);
    if (sax < 24 || sax > VBW - 24 || say < 18 || say > VBH - 18) continue;   // anchor must be on-frame
    let hit = null;
    for (const [dx, dy] of REGION_NUDGES) {
      const x = sax + dx, y = say + dy;
      const box = { x1: x - r.w / 2 - 4, y1: y - 9, x2: x + r.w / 2 + 4, y2: y + 9 };
      if (clear(box)) { hit = { x, y, box }; break; }   // nudge to open water rather than drop
    }
    if (!hit) continue;
    placed.push(hit.box);
    regions.push(zl(r.ax, r.ay,
      `<text class="hu-region" x="${(hit.x - sax).toFixed(1)}" y="${(hit.y - say + 4).toFixed(1)}">${esc(r.name)}</text>`));
  }

  // City dots + labels: dots always draw (constant on-screen size); text thins
  // on a 64 px min-gap at the CURRENT view, biggest population first, and only
  // cities on or near the current frame compete for a label slot (an off-frame
  // metro no longer suppresses an on-frame town's name).
  const taken = [], cities = [];
  for (const p of ctx.cities) {
    const [sx, sy] = T(p.x, p.y);
    let txt = "";
    if (sx > -40 && sx < VBW + 40 && sy > -40 && sy < VBH + 40
        && !taken.some((t) => Math.hypot(t[0] - sx, t[1] - sy) < 64)) {
      taken.push([sx, sy]);
      txt = `<text class="hu-city-label" x="6" y="3.5">${esc(p.name)}</text>`;
    }
    cities.push(zl(p.x, p.y, `<circle class="${p.cls || "hu-city"}" r="${(p.r || 2.6).toFixed(1)}"/>` + txt));
  }
  return { regions: regions.join(""), cities: cities.join("") };
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
function buildConeSvg(st, cfg, models, prefs, lay) {
  prefs = prefs || {};
  lay = lay || {};
  // E5 three-way sibling groups, resolved once per build. Card-config masters
  // gate whole groups (dashboard admin wins); the stripe group is NHC-only and
  // falls back to its left/default (watch/warning) on GDACS storms -- GDACS
  // carries no ww segments, so that draws nothing there anyway.
  const nhcStorm = isNhcId(st.stormId);
  const triWind = cfg.show_winds === false ? "off" : triState(prefs, "wind");
  const triDots = cfg.show_cities === false ? "off" : triState(prefs, "dots");
  const triStripe = nhcStorm ? triState(prefs, "stripe") : "left";
  const proj = makeProject(st.bbox);
  const conePx = (st.cone || []).map((c) => proj(c[0], c[1]));
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
  // Wind source follows the wind tri-state: LEFT (default) = the singular
  // current-position 34/50/64 field, RIGHT = the full-track swath (GDACS's
  // whole-track envelope / NHC's forecast corridor), CENTER = off. Each side
  // falls back to whichever exists so a storm with only one still draws.
  let windSrc = null;
  if (triWind === "left")
    windSrc = (st.windField && st.windField.length) ? st.windField : st.windSwath;
  else if (triWind === "right")
    windSrc = (st.windSwath && st.windSwath.length) ? st.windSwath : st.windField;
  if (windSrc && windSrc.length)
    for (const w of windSrc) {
      // Union the tier's rings into ONE path so the blobs along the track merge into
      // a single uniform fill (nonzero winding) -- no darker seams where they overlap.
      // One blob (current-position field) or many (the wind swath) both work here.
      // Nested 34/50/64 tiers stay separate stacked paths -> alpha deepens in the core.
      let d = "";
      for (const ring of (w.rings || []))
        if (ring.length >= 3) d += basePath(proj, ring, true, smooth);
      if (d) windLayer.push(`<path class="hu-wind" style="fill:${windBandColor(w.kt)}" d="${d}"/>`);
    }

  // E6: cities and region names are placed by the zoom-aware label engine
  // (layoutZoomLabels). Here we only compute their pan-local anchor px once;
  // the engine decides dot/text emission per view. Longitudes are normalized
  // into the map's 360-degree window (home-marker trick) so a wrapped frame
  // still places anchors the short way round.
  const cLng0 = (st.bbox[0] + st.bbox[2]) / 2;
  const normLng = (lng) => {
    let x = lng;
    while (x - cLng0 > 180) x -= 360;
    while (x - cLng0 < -180) x += 360;
    return x;
  };
  // Place dots, two very different modes:
  // - Cities (left): top CITY_DOT_DRAW places as uniform labeled dots via the
  //   zoom-label engine -- the classic navigational look.
  // - Population (right): the DENSITY picture. The mapped places in the
  //   buffered view (popGrid, capped server-side at POP_GRID_CAP -- a dense
  //   frame arrives pre-aggregated per grid cell), dot AREA scaled relative to
  //   the frame's extremes, freely overlapping. Drawn as plain circles in
  //   hu-pan so they zoom with the coastline (a density surface, not
  //   furniture) -- this also keeps the gesture loop free of hundreds of
  //   counter-scaled label groups. No names: names live in Cities mode.
  //   Falls back to the top-N places when an old payload has no popGrid.
  const ctxCities = [];
  const gridDots = [];
  let gridPts = null;   // [x, y, pop] px points for the in-cone impact sum
  if (triDots === "left" && st.places && st.places.length) {
    for (const p of st.places.slice(0, CITY_DOT_DRAW)) {
      const [x, y] = proj(normLng(p.lng), p.lat);
      ctxCities.push({ name: p.name, x, y, r: 2.6, cls: "hu-city" });
    }
  } else if (triDots === "right") {
    const grid = (st.popGrid && st.popGrid.length)
      ? st.popGrid : (st.places || []).map((p) => [p.lng, p.lat, p.pop]);
    if (grid.length) {
      const rOf = popScaler(grid.map((g) => g[2]));
      // Fade reference: the cone polygon (projected path incl. uncertainty);
      // no cone -> the forecast track line; neither -> no fade (all dots).
      let fadePoly = conePx.length >= 3 ? conePx
        : (st.fcstTrack && st.fcstTrack.length >= 2)
          ? st.fcstTrack.map((c) => proj(c[0], c[1])) : null;
      const s2 = 2 * POP_FADE_SIGMA * POP_FADE_SIGMA;
      gridPts = [];
      for (const [lng, lat, pop] of grid) {
        const [x, y] = proj(normLng(lng), lat);
        gridPts.push([x, y, pop]);
        let a = POP_BASE_ALPHA;
        if (fadePoly) {
          const d = distToPoly(x, y, fadePoly);
          a = POP_BASE_ALPHA * Math.exp(-(d * d) / s2);
          if (a < POP_ALPHA_MIN) continue;   // invisible -> skip the node
        }
        gridDots.push(`<circle class="hu-popdot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rOf(pop).toFixed(1)}" opacity="${a.toFixed(2)}"/>`);
      }
    }
  }

  // E5 storm surge (stripe-right, on-demand): inundation bands drawn as filled
  // coastal polygons UNDER the storm data, NHC's blue->purple severity ramp.
  // Geometry arrives pre-simplified from the layer websocket; no smoothing
  // (these are detailed coastal fills -- curves would misplace water lines).
  const surgeLayer = [];
  if (triStripe === "right" && lay.surge && lay.surge.bands)
    lay.surge.bands.forEach((b, i) => {
      let d = "";
      for (const ring of b.rings || [])
        if (ring.length >= 3) d += basePath(proj, ring.map(([lng, lat]) => [normLng(lng), lat]), true, false);
      if (d) surgeLayer.push(`<path class="hu-surge" style="fill:${surgeColor(b, i)}" d="${d}"/>`);
    });

  // E5 wind-history trail (independent on-demand layer): each past advisory's
  // 34 kt field as a faint dashed outline -- the growth trail along the track.
  const whistLayer = [];
  if (lay.whist && lay.whist.advisories)
    for (const advE of lay.whist.advisories)
      for (const ring of advE.rings || [])
        if (ring.length >= 3)
          whistLayer.push(`<polygon class="hu-whist" points="${ptsStr(proj, ring.map(([lng, lat]) => [normLng(lng), lat]))}"/>`);

  const storm = [];
  if (triStripe === "left")
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

  // E4 forecast model tracks (on-demand layer): dashed guidance polylines over
  // the official track but UNDER the forecast dots (official geometry wins).
  // Geographic -> they ride hu-pan and pan/zoom with the map. Longitudes are
  // normalized into the map's 360-degree window (same trick as the home marker)
  // so an antimeridian-straddling track draws the short way round.
  const modelRows = [];
  if (models && models.list && models.list.length) {
    const cLng = (st.bbox[0] + st.bbox[2]) / 2;
    for (const m of models.list) {
      const coords = (m.points || []).map(([lng, lat]) => {
        let x = lng;
        while (x - cLng > 180) x -= 360;
        while (x - cLng < -180) x += 360;
        return [x, lat];
      });
      if (coords.length < 2) continue;
      storm.push(`<polyline class="hu-model" points="${ptsStr(proj, coords)}" stroke="${modelColor(m.id)}"/>`);
      modelRows.push([m.label || m.id, modelColor(m.id)]);
    }
  }

  const keepOut = [];      // GEOGRAPHIC keep-out boxes (forecast dots + time labels): transform affinely with the view
  const keepScreen = [];   // screen-space overlay boxes (home marker, model legend): only valid at the default frame
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
      keepScreen.push({ x1: hx - 20, y1: hy - 20, x2: hx + 20, y2: hy + 20 });
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
      keepScreen.push({
        x1: Math.min(inX, outX, hcx) - P, y1: Math.min(inY, outY, hcy) - P,
        x2: Math.max(inX, outX, hcx) + P, y2: Math.max(inY, outY, hcy) + P,
      });
      farCase = true;
    }
  }

  // E4 model legend: screen-space furniture -> hu-overlays (hides on zoom with
  // the rest, like region labels). Reserved in keepOut BEFORE region labels and
  // the scale so they route around it. Loading/failure states are named
  // honestly -- never a silently missing layer.
  const mlegend = [];
  const whistPending = lay.whist && (lay.whist.loading || lay.whist.failed);
  if ((models && (modelRows.length || models.loading || models.failed)) || whistPending) {
    const rows = modelRows.length ? modelRows.slice() : [];
    if (models && !modelRows.length && (models.loading || models.failed))
      rows.push([models.loading ? "Loading model tracks…" : "Model tracks unavailable", null]);
    if (whistPending)
      rows.push([lay.whist.loading ? "Loading wind history…" : "Wind history unavailable", null]);
    const rowH = 16, padX = 8, padY = 6;
    const maxCh = Math.max(...rows.map((r) => r[0].length));
    const w = padX + 24 + maxCh * 6.6 + padX;
    const h = rows.length * rowH + padY * 2;
    const x0 = 12, y0 = VBH - 12 - h;
    mlegend.push(`<rect class="hu-mlegend-bg" x="${x0}" y="${y0}" width="${w.toFixed(0)}" height="${h}" rx="6"/>`);
    rows.forEach(([label, col], i) => {
      const cy = y0 + padY + i * rowH + rowH / 2;
      if (col) mlegend.push(`<line class="hu-mlegend-sw" x1="${x0 + padX}" y1="${cy.toFixed(1)}" x2="${x0 + padX + 18}" y2="${cy.toFixed(1)}" stroke="${col}"/>`);
      mlegend.push(`<text class="hu-mlegend-t" x="${x0 + padX + (col ? 24 : 0)}" y="${(cy + 3.5).toFixed(1)}">${esc(label)}</text>`);
    });
    keepScreen.push({ x1: x0 - 4, y1: y0 - 4, x2: x0 + w + 4, y2: y0 + h + 4 });
  }

  // E5 surge legend: bottom-right screen-space furniture (hu-overlays; hides on
  // zoom like the model legend). Band labels with their fill swatches; loading/
  // failure states named honestly -- never a silently missing layer.
  const slegend = [];
  if (triStripe === "right" && lay.surge
      && (lay.surge.loading || lay.surge.failed || (lay.surge.bands && lay.surge.bands.length))) {
    const seen = new Set(), rows = [];
    if (lay.surge.bands)
      lay.surge.bands.forEach((b, i) => {
        const lbl = b.label || "Surge area";
        if (seen.has(lbl) || rows.length >= 5) return;
        seen.add(lbl);
        rows.push([lbl, surgeColor(b, i)]);
      });
    if (!rows.length)
      rows.push([lay.surge.loading ? "Loading storm surge…" : "Storm surge unavailable", null]);
    const rowH = 16, padX = 8, padY = 6;
    const maxCh = Math.max(...rows.map((r) => r[0].length));
    const w = padX + 18 + maxCh * 6.6 + padX;
    const h = rows.length * rowH + padY * 2;
    const x0 = VBW - 12 - w, y0 = VBH - 12 - h;
    slegend.push(`<rect class="hu-mlegend-bg" x="${x0.toFixed(0)}" y="${y0}" width="${w.toFixed(0)}" height="${h}" rx="6"/>`);
    rows.forEach(([label, col], i) => {
      const cy = y0 + padY + i * rowH + rowH / 2;
      if (col) slegend.push(`<rect class="hu-slegend-sw" x="${(x0 + padX).toFixed(1)}" y="${(cy - 5).toFixed(1)}" width="10" height="10" rx="2" fill="${col}"/>`);
      slegend.push(`<text class="hu-mlegend-t" x="${(x0 + padX + (col ? 16 : 0)).toFixed(1)}" y="${(cy + 3.5).toFixed(1)}">${esc(label)}</text>`);
    });
    keepScreen.push({ x1: x0 - 4, y1: y0 - 4, x2: x0 + w + 4, y2: y0 + h + 4 });
  }

  // E5 population impact: sum the mapped-place population inside the forecast
  // cone (Population mode only). An undercount by construction -- the basemap
  // only carries places >= 5k (GeoNames cities5000) -- so the data bar labels
  // it "mapped cities".
  let popImpact = null;
  if (gridPts && conePx.length >= 3) {
    popImpact = 0;
    for (const [gx, gy, gp] of gridPts)
      if (pointInPoly(gx, gy, conePx)) popImpact += gp || 0;
  }
  const scale = (farCase && cfg.show_scale !== false)
    ? scaleAxes(st.bbox, proj, st.geo, keepOut.concat(keepScreen), conePx, hcx, hcy) : [];

  // E6 label-engine context: everything layoutZoomLabels needs to re-place the
  // region/city labels at ANY view, precomputed in default-frame px. Region
  // anchors come from the whole BUFFERED payload (panning reveals them); the
  // engine's on-frame test decides visibility per view.
  const ctxRegions = [];
  if (cfg.show_labels !== false)
    for (const r of st.labels || []) {
      const name = String(r.name).toUpperCase();
      const [ax, ay] = proj(normLng(r.lng), r.lat);
      ctxRegions.push({ name, w: name.length * REGION_CHAR_W, ax, ay, tier: r.tier || 0 });
    }
  const ctx = {
    span: Math.max(st.bbox[2] - st.bbox[0], st.bbox[3] - st.bbox[1]),
    regions: ctxRegions, cities: ctxCities,
    keepGeo: keepOut, keepScreen, conePx,
  };
  const zl0 = layoutZoomLabels(ctx, { s: 1, tx: 0, ty: 0 });

  // Two sibling groups. hu-pan holds the GEOGRAPHIC layers (basemap, wind wash,
  // cone/track/dots/ww + on-dot labels) -- these scale honestly, so pan/zoom is a
  // transform on this group alone. The E6 label groups live in hu-pan too: cities
  // UNDER the storm data, region names ABOVE it (same stacking as before), each a
  // counter-scaled .hu-zl group the gesture layer maintains per frame. hu-overlays
  // keeps the true screen-space furniture (off-screen home marker, offshore mileage
  // scale, model legend) whose edge-clamp math is only valid at the default frame;
  // it hides whenever the view leaves default and returns on recenter. The outer
  // viewBox is always the default 800x600 frame; the buffered coastline in `geo`
  // extends past it and is simply clipped until a gesture reveals it. viewBox/
  // maxScale ride as data-attrs so the gesture layer can read the pannable extent
  // + zoom ceiling off the DOM. Returns {svg, ctx}: the card stashes ctx for the
  // engine's re-runs.
  const panGroup = [...base, ...windLayer, ...surgeLayer, ...whistLayer, ...gridDots,
    `<g class="hu-zl-cities">${zl0.cities}</g>`, ...storm,
    `<g class="hu-zl-regions">${zl0.regions}</g>`];
  const overlayGroup = [...scale, ...homeParts, ...mlegend, ...slegend];
  const vb = st.viewBox ? st.viewBox.join(" ") : "";
  const ms = st.maxScale != null ? st.maxScale : 1;
  const svg = `<svg class="hu-svg" viewBox="0 0 ${VBW} ${VBH}" preserveAspectRatio="xMidYMid meet"`
    + ` data-viewbox="${vb}" data-maxscale="${ms}" data-bbox="${(st.bbox || []).join(" ")}" xmlns="http://www.w3.org/2000/svg">`
    + `<g class="hu-pan">${panGroup.join("")}</g>`
    + `<g class="hu-overlays">${overlayGroup.join("")}</g>`
    + `</svg>`;
  return { svg, ctx, popImpact };
}

function dataBar(st, lay, popImpact) {
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
  // E5 surge at-home line: present only while the surge layer is selected AND
  // home sits inside a returned band. The label is NHC's own band text.
  if (lay && lay.surge && lay.surge.ok && lay.surge.atHome)
    bits.push(`surge at home: ${lay.surge.atHome}`);
  // E5 population impact (Population dot mode): honest about the undercount --
  // only mapped places (>= 5k, GeoNames) are summed.
  if (popImpact != null && popImpact > 0)
    bits.push(`~${fmtPop(popImpact)} people in the cone (mapped cities)`);
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
  .hu-model { fill: none; stroke-width: 1.6; stroke-dasharray: 5 4; opacity: .85;
              stroke-linejoin: round; stroke-linecap: round; }
  .hu-mlegend-bg { fill: #14110d; opacity: .55; }
  .hu-mlegend-sw { stroke-width: 2; stroke-dasharray: 5 4; }
  .hu-mlegend-t { font: 600 11px/1 sans-serif; fill: #EDE3D2; }
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
  .hu-panel { position: absolute; top: 44px; right: 10px; z-index: 3; display: none; width: 232px;
              max-width: calc(100% - 20px); box-sizing: border-box;
              background: var(--card-background-color, var(--primary-background-color)); color: var(--primary-text-color);
              border-radius: 16px; padding: 12px 14px 10px; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
  .hu-panel.hu-open { display: block; }
  .hu-panel-row.hu-na { opacity: .45; }
  .hu-panel-note { font: 400 10px/1.2 sans-serif; opacity: .7; margin-left: 4px; }
  .hu-panel-group { font: 700 10.5px/1 sans-serif; letter-spacing: .08em; text-transform: uppercase;
                    color: var(--secondary-text-color); margin: 12px 0 6px; display: flex;
                    align-items: baseline; gap: 6px; }
  .hu-panel-group:first-child { margin-top: 0; }
  /* M3 segmented button: full-width pill, hairline outline, equal segments,
   * selected segment tinted with the theme primary. Disabled group = 38%. */
  .hu-seg { display: flex; width: 100%; height: 32px; box-sizing: border-box;
            border: 1px solid var(--divider-color, rgba(127,127,127,.45)); border-radius: 16px; overflow: hidden; }
  .hu-seg-btn { flex: 1 1 0; min-width: 0; border: none; background: transparent; cursor: pointer;
                color: var(--primary-text-color); font: 500 12px/1 sans-serif; padding: 0 2px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                border-left: 1px solid var(--divider-color, rgba(127,127,127,.45)); }
  .hu-seg-btn:first-child { border-left: none; }
  .hu-seg-btn.hu-sel { background: rgba(3,169,244,.24);
                       background: color-mix(in srgb, var(--primary-color, #03a9f4) 26%, transparent);
                       font-weight: 700; }
  .hu-seg.hu-na { opacity: .38; pointer-events: none; }
  /* M3 list row + switch: label left, switch right, one vertical grid. */
  .hu-panel-row { display: flex; align-items: center; justify-content: space-between; gap: 12px;
                  font: 400 13px/1.25 sans-serif; padding: 5px 0; cursor: pointer; }
  .hu-row-lbl { display: flex; flex-direction: column; min-width: 0; }
  .hu-row-lbl .hu-panel-note { margin-left: 0; }
  input.hu-sw { appearance: none; -webkit-appearance: none; width: 44px; height: 26px; border-radius: 13px;
                margin: 0; flex: none; position: relative; cursor: pointer;
                background: var(--secondary-background-color); box-sizing: border-box;
                border: 1.5px solid var(--divider-color, rgba(127,127,127,.55));
                transition: background .15s, border-color .15s; }
  input.hu-sw::after { content: ""; position: absolute; top: 50%; left: 3px; transform: translateY(-50%);
                       width: 16px; height: 16px; border-radius: 50%;
                       background: var(--secondary-text-color); transition: left .15s, width .15s, height .15s, background .15s; }
  input.hu-sw:checked { background: var(--primary-color, #03a9f4); border-color: var(--primary-color, #03a9f4); }
  input.hu-sw:checked::after { left: 21px; width: 20px; height: 20px; background: #fff; }
  .hu-panel-perf { font: 400 10.5px/1.4 sans-serif; color: var(--secondary-text-color); opacity: .8;
                   margin-top: 10px; padding-top: 8px;
                   border-top: 1px solid var(--divider-color, rgba(127,127,127,.3)); }
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
  .hu-surge { fill-opacity: .5; stroke: none; }
  .hu-whist { fill: none; stroke: var(--primary-text-color); stroke-opacity: .3; stroke-width: 1.2; stroke-dasharray: 3 3; }
  .hu-popdot { fill: #4FC3F7; stroke: rgba(0,0,0,.35); stroke-width: .5; }
  .hu-slegend-sw { stroke: rgba(0,0,0,.3); stroke-width: .5; }
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
    this._layerBusy = {};   // in-flight layer fetches, keyed like _layerCache
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
    // A tap/click anywhere OUTSIDE the open layers panel closes it. Capture
    // phase + composedPath so taps on other cards or dashboard chrome count;
    // taps on the panel itself or the gear button pass through untouched.
    if (!this._docClose) {
      this._docClose = (e) => {
        if (!this._panelOpen) return;
        const path = e.composedPath ? e.composedPath() : [];
        if (path.some((n) => n && n.classList
            && (n.classList.contains("hu-panel") || n.classList.contains("hu-gear")))) return;
        this._panelOpen = false;
        this._render();
      };
      document.addEventListener("click", this._docClose, true);
    }
  }
  disconnectedCallback() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._docClose) { document.removeEventListener("click", this._docClose, true); this._docClose = null; }
  }

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

  /* Generic on-demand layer fetch (E4 models / E5 surge + wind history):
   * requested over the layer websocket only while the layer is selected,
   * client-cached per (layer, storm, advisory). Failures are cached as
   * {failed:true} so a dead layer doesn't refetch every render; re-selecting
   * the layer clears the failure and retries. */
  _fetchLayer(layer, key, sid) {
    if (this._layerBusy[key] || !this._hass) return;
    this._layerBusy[key] = true;
    this._hass.callWS({ type: WS_LAYER_TYPE, storm_id: sid, layer }).then((res) => {
      delete this._layerBusy[key];
      this._layerCache[key] = (res && res.ok) ? res : { failed: true };
      this._render();
    }).catch(() => {
      delete this._layerBusy[key];
      this._layerCache[key] = { failed: true };
      this._render();
    });
  }

  /* Resolve one on-demand layer's draw state for the current storm: the cached
   * result, a cached failure, or {loading:true} while a fetch is kicked off. */
  _layerState(layer, st) {
    const key = `${layer}|${st.stormId || ""}|${st.advisory || ""}`;
    const c = this._layerCache[key];
    if (c && c.ok) return c;
    if (c && c.failed) return { failed: true };
    this._fetchLayer(layer, key, st.stormId || "");
    return { loading: true };
  }

  /* Apply a tri-group change (slider or side-label tap). Re-selecting surge
   * clears its cached failures so the fetch retries fresh (models pattern). */
  _applyTri(key, v) {
    if (!key || !(v === "left" || v === "off" || v === "right")) return;
    this._layerPrefs = setTriPref(this._layerPrefs || {}, key, v);
    if (key === "stripe" && v === "right")
      for (const k of Object.keys(this._layerCache))
        if (k.startsWith("surge|") && this._layerCache[k].failed) delete this._layerCache[k];
    this._render();
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
      const prefs = this._layerPrefs || {};
      // E4 model tracks: resolve this storm's layer state for the draw --
      // cached list, cached failure, or kick an on-demand fetch (loading).
      // NHC-only; the toggle is disabled for GDACS storms below.
      const nhcSt = isNhcId(st.stormId);
      let modelState = null;
      if (prefs.models && nhcSt) {
        const ms = this._layerState("models", st);
        modelState = ms.ok ? { list: ms.models } : ms;
      }
      // E5 on-demand layers on the same cache/fetch path: storm surge draws
      // when the coastal-stripe tri sits RIGHT; the wind-history trail is an
      // independent toggle. Both NHC-only.
      const lay = { surge: null, whist: null };
      if (nhcSt && triState(prefs, "stripe") === "right")
        lay.surge = this._layerState("surge", st);
      if (nhcSt && prefs.wind_history)
        lay.whist = this._layerState("wind_history", st);
      let svg = "", popImpact = null;
      this._labelCtx = null;   // E6: engine context, set only on a successful build
      try {
        const built = buildConeSvg(st, cfg, modelState, prefs, lay);
        svg = built.svg;
        this._labelCtx = built.ctx;
        popImpact = built.popImpact;
      }
      catch (e) { svg = this._msg("mdi:map-marker-alert", "Couldn\u2019t draw this storm", "", false); }
      // Map chrome: recenter (zoom), the advisory doc button (only when that
      // layer is on), and the gear that opens the layers panel. The panel lists
      // OPTIONAL_LAYERS grouped by topic; the advisory overlay covers the whole
      // card and survives background re-renders via instance state.
      // E5 panel: the three-way sibling sliders first (left = default sibling,
      // middle = off, right = alternate), then the independent toggles, with
      // advisory text LAST; a short perf note closes the panel.
      let panelRows = "", lastGroup = null;
      for (const t of TRI_GROUPS) {
        const na = t.nhcOnly && !nhcSt;
        const v = na ? t.def : triState(prefs, t.key);
        const seg = (set, lbl) =>
          `<button class="hu-seg-btn${v === set ? " hu-sel" : ""}" data-tri="${t.key}" data-set="${set}"${na ? " disabled" : ""}>${esc(lbl)}</button>`;
        panelRows += `<div class="hu-panel-group">${esc(t.title)}${na ? `<span class="hu-panel-note">NHC storms only</span>` : ""}</div>
          <div class="hu-seg${na ? " hu-na" : ""}" role="group" aria-label="${esc(t.title)}">
            ${seg("left", t.lLabel)}${seg("off", "Off")}${seg("right", t.rLabel)}
          </div>`;
      }
      for (const l of OPTIONAL_LAYERS) {
        if (l.group !== lastGroup) { panelRows += `<div class="hu-panel-group">${esc(l.group)}</div>`; lastGroup = l.group; }
        const na = l.nhcOnly && !nhcSt;
        panelRows += `<label class="hu-panel-row${na ? " hu-na" : ""}"><span class="hu-row-lbl">${esc(l.label)}${na ? `<span class="hu-panel-note">NHC storms only</span>` : ""}</span><input type="checkbox" class="hu-sw" data-layer="${l.id}" ${prefs[l.id] && !na ? "checked" : ""}${na ? " disabled" : ""}/></label>`;
      }
      panelRows += `<div class="hu-panel-perf">Turn off what you don’t need — fewer layers means a faster card.</div>`;
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
        <div class="hu-bar">${dataBar(st, lay, popImpact)}</div>${exposureTimeline(st, cfg)}${pager}${stale}${adv}`;
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
        // Re-toggling a fetching layer clears cached failures -> fresh retry.
        if ((id === "models" || id === "wind_history") && el.checked)
          for (const k of Object.keys(this._layerCache))
            if (k.startsWith(id + "|") && this._layerCache[k].failed) delete this._layerCache[k];
        this._render();
      }));
    // E5 tri-group segmented buttons (Material 3 pattern: one segment per
    // state, selected segment filled -- "Off" is its own labeled segment).
    this.shadowRoot.querySelectorAll(".hu-seg-btn").forEach((el) =>
      el.addEventListener("click", () =>
        this._applyTri(el.getAttribute("data-tri"), el.getAttribute("data-set"))));
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
    // E6: a pending label re-layout belongs to the previous render's DOM.
    if (this._zlTimer) { clearTimeout(this._zlTimer); this._zlTimer = null; }
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

    // E6 zoom-aware label engine wiring. Labels are counter-scaled .hu-zl groups
    // inside hu-pan: every frame apply() updates their scale(1/s) so text holds a
    // constant on-screen size while riding the map; the full collision/visibility
    // layout (layoutZoomLabels) re-runs only once the view settles (150 ms).
    let zlNodes = [];
    const cacheZl = () => {
      zlNodes = [];
      svg.querySelectorAll("g.hu-zl").forEach((el) => {
        zlNodes.push({ el, ax: el.getAttribute("data-ax"), ay: el.getAttribute("data-ay") });
      });
    };
    const runLabels = () => {
      const ctx = this._labelCtx;
      if (!ctx) return;
      const out = layoutZoomLabels(ctx, { s: view.s, tx: view.tx, ty: view.ty });
      const gr = svg.querySelector(".hu-zl-regions");
      const gc = svg.querySelector(".hu-zl-cities");
      if (gr) gr.innerHTML = out.regions;
      if (gc) gc.innerHTML = out.cities;
      cacheZl();
    };
    cacheZl();

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
      // E6: hold every label at constant on-screen size through the gesture,
      // then re-run the collision layout once the view stops moving.
      const zk = (1 / view.s).toFixed(4);
      for (const n of zlNodes)
        n.el.setAttribute("transform", `translate(${n.ax} ${n.ay}) scale(${zk})`);
      if (this._zlTimer) clearTimeout(this._zlTimer);
      this._zlTimer = setTimeout(runLabels, 150);
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
