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
/* Hard floor for the side rail (v0.2.6 Phase 2 keeps this from the Pass 3
 * solver). Below this width a 240px column leaves a map too small to read, so
 * a "Side" preference falls back to Bottom. Physical constraint, not taste. */
const SIDE_MIN_W = 700;
/* Side-rail width. Trimmed from 240 (2026-07-19): the rail is text and a narrow
 * graph, and every px not spent here goes straight back to the map. */
const SIDE_RAIL_W = 210;
/* Bottom-rail packing floors (v0.2.6 Phase 3). The rail holds two flow items --
 * storm data and the at-home graph -- and shares one line when both fit
 * legibly. Packing along the rail's long axis keeps its thin dimension (height)
 * from stacking up, which in fill mode hands the reclaimed height straight to
 * the map. Each floor is the width below which that item stops being legible;
 * the graph is the only one that gets BETTER with extra width, so it absorbs
 * whatever slack is left.
 * The test is a pure WIDTH comparison against the card's own box: no content
 * measurement and nothing cached, so there is no stale cross-mode metric to rot
 * (that was the _stackHb bug Phase 1 fought -- do NOT reintroduce a cache).
 * Deliberately tunable; adjust on glass. */
const PACK_MIN_W_BAR = 340;   // px storm data needs to share a line
const PACK_MIN_W_TL = 300;    // px the at-home graph needs to share one
const PACK_GAP = 10;          // px gutter between packed blocks
/* The storm pager is NOT a flow item -- it is absolutely placed in a fixed band
 * at the rail's right-hand end, so its horizontal position is identical in both
 * layouts and toggling Bottom/Side doesn't make it appear to jump (Aaron,
 * 2026-07-19). PAGER_INSET is its margin off the foot of the side column; the
 * rail reserves PAGER_RESERVE so no content can run underneath it. */
const PAGER_INSET = 16;
const PAGER_H = 30;   // the nav buttons' diameter -- see .hu-pager button
/* Everything below is DERIVED, never a separate literal. Hand-set clearances
 * drifted out of sync with the band once already (the band was widened to
 * SIDE_RAIL_W while the reserve stayed at 132, and the graph ran underneath).
 * PAGER_RESERVE clears the band horizontally, with a visible gutter.
 * PAGER_CLEAR is the vertical room the pager needs; used BOTH as the bottom
 * bar's floor and as the side column's bottom padding, which is what makes the
 * pager occupy the identical spot in the two layouts. At exactly PAGER_CLEAR
 * the pager is also vertically centred, since the inset is equal top and
 * bottom. */
const PAGER_RESERVE = SIDE_RAIL_W + 16;
const PAGER_CLEAR = PAGER_INSET * 2 + PAGER_H;

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
  { key: "stripe", title: "Coastal hazard",  lLabel: "Wind",       rLabel: "Surge",      def: "left", nhcOnly: true },
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
  const vs = [];
  for (const n of pops) vs.push(Math.sqrt(Math.max(Number(n) || 0, 1)));
  vs.sort((a, b) => a - b);
  const lo = vs.length ? vs[0] : 0;
  // Normalize against a high PERCENTILE, not the absolute max: a few giant metros
  // (LA, NYC) otherwise anchor the top and crush every ordinary city into the
  // floor, so a metro-dense frame reads as uniform dots (Aaron, 2026-07-17).
  // Places at/above the percentile clamp to POP_DOT_MAX_R; everyone below spreads
  // across the full range. Still per-frame (relative), just outlier-robust -- NOT
  // an absolute ramp (those flattened; see history).
  const hi = vs.length ? vs[Math.floor((vs.length - 1) * 0.92)] : 0;
  const span = hi - lo;
  return (pop) => {
    if (span <= 0) return (POP_DOT_MIN_R + POP_DOT_MAX_R) / 2;   // degenerate frame (all same pop)
    const v = Math.sqrt(Math.max(Number(pop) || 0, 1));
    const t = Math.min(1, (v - lo) / span);
    return POP_DOT_MIN_R + (POP_DOT_MAX_R - POP_DOT_MIN_R) * t;
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
  TVCN: "#00E5FF", HCCA: "#00E5FF",
  AVNO: "#B388FF", HFSA: "#FFAB40", UKX: "#F06292",
};
const modelColor = (id) => MODEL_COLOR[id] || "#9E9E9E";
const LAYER_STORE_KEY = "hurricane-card:layers";
/* Layout POSITION prefs (v0.2.6 Phase 2) -- deliberately PER DEVICE and never
 * synced, unlike everything in LAYER_STORE_KEY. The split is intentional: what
 * a user wants to SEE (layers, wind field, coastal stripe) travels with them
 * across devices; where it SITS depends on the screen it is being viewed on. A
 * 43" wall panel wants the info bar in the side rail; the same user's phone
 * wants it on the bottom, and nobody should have to re-pick on every glance.
 * Own key, own load/save, never touches _pushPrefs.
 * SCOPE NOTE: per-DEVICE, not per-CARD. Two hurricane cards on one dashboard
 * share this. Accepted (Aaron's call) -- per-card keying needs a stable card
 * id, which HA does not hand out, and derived ids break on dashboard edits.
 * Keys: "pos" = where the non-map blocks sit ("bottom" | "side", default
 * bottom); "barOn" / "tlOn" = whether each block is shown at all (default true).
 *
 * POSITION IS ONE LEVER FOR BOTH BLOCKS (settled 2026-07-19 after Aaron built
 * and used the split version): the info bar in one rail and the graph in the
 * other is a combination nobody would pick, and it costs the card BOTH
 * dimensions. VISIBILITY stays per-block, because hiding one and keeping the
 * other is genuinely useful -- bar-off is what promotes the storm name into the
 * header, and graph-off is what replaced the old `show_timeline` card option.
 * Position and visibility are different questions; only position merged. */
const LAYOUT_STORE_KEY = "hurricane-card:layout";
const LAYOUT_POS = ["bottom", "side"];
/* The two hideable blocks, in gear-panel order. Neither has a card-config
 * master: as of v0.2.6 Phase 3 `show_timeline` is GONE and the graph, like the
 * info bar, is a pure viewer choice -- one lever per thing (Aaron, 2026-07-19).
 * A leftover `show_timeline: false` in an existing dashboard's YAML is simply
 * ignored now: the graph comes back on and the viewer turns it off here.
 * Called out in the v0.2.6 release notes. */
const LAYOUT_BLOCKS = [
  { key: "barOn", title: "Storm data" },
  { key: "tlOn", title: "At-home graph" },
];
function loadLayoutPrefs() {
  let p;
  try { p = JSON.parse(localStorage.getItem(LAYOUT_STORE_KEY)) || {}; }
  catch (_) { p = {}; }   // storage blocked (some webviews) -> session-only
  return (p && typeof p === "object") ? p : {};
}
function saveLayoutPrefs(p) {
  try { localStorage.setItem(LAYOUT_STORE_KEY, JSON.stringify(p)); } catch (_) {}
}
/* Where the blocks sit. Unknown/absent -> bottom. */
function layoutPos(p) {
  const v = p ? p.pos : null;
  return LAYOUT_POS.indexOf(v) >= 0 ? v : "bottom";
}
/* Whether a block is shown. Default ON for both -- the bar has always shown,
 * and the graph self-hides when no storm is forecast to reach home, so it costs
 * nothing when irrelevant and appears at the card's highest-value moment. */
function layoutOn(p, key) {
  return !(p && p[key] === false);
}
/* Normalize a raw prefs blob (from localStorage OR the HA per-user store) to the
 * current schema. Idempotent, and copies before mutating so a live subscription
 * message object is never altered in place. */
function migratePrefs(p) {
  p = (p && typeof p === "object") ? { ...p } : {};
  if (p.tri) p.tri = { ...p.tri };
  // Migrate the pre-E5 wind_swath boolean into the wind tri-state.
  if (!p.tri) { p.tri = {}; if (p.wind_swath) p.tri.wind = "right"; }
  delete p.wind_swath;
  // Split the old three-way "dots" slider into two independent toggles so
  // Cities + Population can show at once. Migrate once: left -> cities only,
  // right -> population only, off -> neither; new users default to Cities on.
  if (p.dotsCities === undefined && p.dotsPop === undefined) {
    const od = p.tri && p.tri.dots;
    p.dotsCities = od ? od === "left" : true;
    p.dotsPop = od === "right";
  }
  if (p.tri) delete p.tri.dots;
  return p;
}
function loadLayerPrefs() {
  let p;
  try { p = JSON.parse(localStorage.getItem(LAYER_STORE_KEY)) || {}; }
  catch (_) { p = {}; }   // storage blocked (some webviews) -> session-only
  return migratePrefs(p);
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
/* Plain names for the legend. These are WATCH/WARNING products, NOT "advisories"
 * -- an Advisory is a lower NWS tier, and calling a Hurricane Warning one would
 * understate it. ("Advisory" in this card means the numbered NHC bulletin.)
 * The four codes are all WIND-threshold products (34 kt TS force / 64 kt
 * hurricane force), which is why the stripe slider's left side reads "Wind"
 * against "Surge". */
const WW_LABEL = {
  TWA: "Tropical Storm Watch", TWR: "Tropical Storm Warning",
  HWA: "Hurricane Watch", HWR: "Hurricane Warning",
};
/* Legend order: warnings above watches, hurricane above tropical storm. */
const WW_ORDER = ["HWR", "HWA", "TWR", "TWA"];

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
const TOGGLES = ["show_land", "show_states", "show_coast", "show_cities", "show_labels", "show_scale", "show_home", "show_winds", "smooth"];

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
/* Pass 3: paren-safe wrapping for the data-bar text in the narrow side column.
 * Wrapping is at spaces only -- never mid-word -- and a parenthesized group
 * like "(per NHC)" is a nowrap span: it may drop to its own line but never
 * splits inside. The chunks between separators stay breakable on purpose --
 * making each data-bar chunk an unbreakable unit forces the column wide
 * (rejected). Escape FIRST, then wrap: the regex only ever sees escaped text. */
const escNoWrapParens = (s) => esc(s).replace(/\([^()]*\)/g, (m) => `<span class="hu-nw">${m}</span>`);
/* At-home graph title. Two halves, each unbreakable, with the ONLY wrap
 * opportunity at the slash -- so a wide card keeps it on one line and the
 * narrow side column breaks it cleanly in two rather than mid-phrase. The
 * slash rides with the first half so a wrapped line never opens with it. */
const TL_TITLE = `<span class="hu-nw">Storm force winds at home /</span> <span class="hu-nw">Closest to eye</span>`;

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

/* ---- projection: lng/lat -> SVG px through the storm bbox -----------------
 * Web-Mercator-style: x is linear in longitude, y runs through the Mercator
 * latitude stretch, so land SHAPES read correctly at every latitude in view.
 * The old plate carree froze its E-W compression at the storm's mid-latitude
 * (fine inside a storm-sized frame, but a frame spanning 25 degrees of
 * latitude plus the fill-mode buffer reveal drew far latitudes visibly
 * stretched -- a storm-framed US looked horizontally smeared; Aaron,
 * 2026-07-18). Mercator is conformal, so wind rings stay round and the
 * mileage scale's px-per-mile at mid-latitude holds for both axes. Latitude
 * clamps to +/-85 (Mercator pole blow-up; storms never get near it). */
function makeProject(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const mY = (lat) => {
    const p = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + p / 2));
  };
  const x0 = minLng * Math.PI / 180;
  const w = Math.max((maxLng - minLng) * Math.PI / 180, 1e-9);
  const y1 = mY(maxLat);
  const h = Math.max(y1 - mY(minLat), 1e-9);
  const s = Math.min(VBW / w, VBH / h);
  const ox = (VBW - w * s) / 2;
  const oy = (VBH - h * s) / 2;
  return (lng, lat) => [ox + (lng * Math.PI / 180 - x0) * s, oy + (y1 - mY(lat)) * s];
}
const projectPart = (proj, coords) => coords.map(([lng, lat]) => proj(lng, lat));
const ptsStr = (proj, coords) =>
  projectPart(proj, coords).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/* ---- coastline smoothing: Catmull-Rom -> cubic bezier path ----------------
 * Turns the (budget-thinned) basemap points into smooth curves so coastlines
 * read as detailed rather than faceted. Basemap-derived geometry only — never
 * the cone or tracks, which are official NHC geometry. Watch/warning segments
 * are smoothed ONLY when server-side coast tracing succeeded (seg.traced): at
 * that point they ARE basemap coastline, sliced from geo.coast, and must curve
 * with it. An untraced W/W segment is NHC's own breakpoint line — left straight. */
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

/* ---- forecast-dot time-label placement (shared-angle runs) ----------------
 * Each time label rides a SPOKE off its dot: the near end sits R_OUT from the
 * dot centre and the text radiates outward, so the label visibly points back at
 * the dot it belongs to. Two rules govern the angle:
 *
 *   1. Text never tilts more than 45 degrees off horizontal. Past that it stops
 *      being readable on a phone.
 *   2. Labels SHARE an angle. Not "every label solves for itself" (that was the
 *      old placer -- it scattered labels onto both sides at four different
 *      tilts and laid them straight along a horizontal track), and not "one
 *      angle for the whole track, drop the rest" either. The set is partitioned
 *      into contiguous RUNS along the track; each run shares one angle. Four
 *      labels at one angle and four at another beats seven plus a lone
 *      straggler, so a singleton run is penalised hard and a label that must
 *      move drags its neighbours with it when they also fit at the new angle
 *      (Aaron, 2026-07-19).
 *
 * Solved as a small dynamic program -- see placeLabels. Dropping a label is
 * legal but priced as a last resort: a missing timestamp is real information
 * loss, and the dot still carries the category. */
const CHAR_W = 9.2, LBL_H = 17, MIN_GAP = 34;
/* Forecast-dot geometry. These MUST match what the dot renderer draws and what
 * .hu-fdot / .hu-now-ring set in STYLE -- they are the same circles, described
 * once here so the label clearances can be DERIVED rather than hand-tuned. A
 * hand-set 16px clearance sat 0.25px inside the current-position ring and the
 * "now" label printed straight over the white band (Aaron, 2026-07-19). */
const FDOT_R = 12;           // .hu-fdot radius
const FDOT_SW = 1;           // .hu-fdot stroke-width
const NOW_RING_R = 15;       // .hu-now-ring radius (current position only)
const NOW_RING_SW = 2.5;     // .hu-now-ring stroke-width
/* Outer INK edge of each dot -- a stroke straddles its path, so half of it
 * sits outside the nominal radius. */
const FDOT_EDGE = FDOT_R + FDOT_SW / 2;              // 12.5
const NOW_EDGE = NOW_RING_R + NOW_RING_SW / 2;       // 16.25 -- the white ring
const LBL_GAP = 4;           // clear air between a dot's ink edge and its label
/* Where a label's spoke starts, per dot. The current-position dot is wider by
 * the whole ring, so it gets its own -- carried per job as `rOut`. */
const R_OUT = FDOT_EDGE + LBL_GAP;                   // 16.5
const R_OUT_NOW = NOW_EDGE + LBL_GAP;                // 20.25
/* Candidate spokes as SCREEN BEARINGS in degrees (SVG y points DOWN, so a
 * negative bearing points up-screen). Rightward set first, then the mirrored
 * leftward set. The rendered tilt is the bearing folded into [-45,45] -- a
 * leftward spoke draws at bearing-180 with an "end" anchor -- so rule 1 holds
 * for every candidate by construction. Ordered flattest-first so ties in the
 * scoring fall to the flatter, more readable angle. */
const BEARINGS = [0, -15, 15, -30, 30, -45, 45, 180, 165, 195, 150, 210, 135, 225];
/* DP costs, cheapest to dearest. These ARE the taste knobs -- tune on glass.
 * DEV_W is charged per RUN (a run's angle is one stylistic choice), not per
 * label, so a long run isn't taxed for existing. The ordering that matters:
 * nudging a run's angle < opening a new run < leaving a singleton < dropping. */
const LBL_DEV_W = 0.15;        // per degree a run's angle drifts off the ideal
const LBL_RUN_COST = 40;       // opening a new run -- a visible break in the pattern
const LBL_SINGLE_COST = 120;   // a run of ONE: the lone straggler, priced to hurt
const LBL_DROP_COST = 1000;    // last resort
/* Track inside a label's own `rOut` is ignored by the conflict test: every
 * spoke starts beside its dot and the track runs straight through that dot, so
 * without the exclusion the track would veto all 14 bearings for every label.
 * Using rOut itself (rather than a separate constant) means the exclusion is
 * exactly the disc the dot glyph already covers, and it widens automatically
 * for the ringed current-position dot. Beyond it a track hit is a REAL
 * conflict -- which is the "label lying along a horizontal track" case. */
const bearingNorm = (deg) => ((deg % 360) + 360) % 360;
const isLeftward = (deg) => { const d = bearingNorm(deg); return d > 90 && d < 270; };
/* Bearing -> rendered text tilt, always within [-45,45]. */
const bearingTilt = (deg) => {
  const d = bearingNorm(deg);
  return d > 90 && d < 270 ? d - 180 : d >= 270 ? d - 360 : d;
};
/* Shortest angular distance between two bearings, 0..180. A side flip is 180,
 * which is what makes flipping sides dearer than nudging the angle. */
const bearingDelta = (a, b) => Math.abs(bearingNorm(a - b + 180) - 180);
/* The label's ORIENTED box: centre, unit axis along the text, half-extents.
 * Oriented, not axis-aligned, and that distinction is load-bearing -- an AABB
 * around a 45-degree label claims a huge square of mostly-empty space, which
 * vetoed every angle for mid-track labels on a horizontal storm and made the
 * solver drop them (caught in test, 2026-07-19). Conflicts are tested against
 * THIS; the AABB below exists only to hand keep-outs to the region/city/scale
 * engine, which is axis-aligned by design. */
function labelRect(cx, cy, w, bearing, rOut) {
  const r = bearing * Math.PI / 180, ux = Math.cos(r), uy = Math.sin(r);
  const R = (rOut == null ? R_OUT : rOut) + w / 2;
  return { mx: cx + ux * R, my: cy + uy * R, ux, uy, hw: w / 2 + 4, hh: LBL_H / 2 };
}
/* Point inside an oriented rect: rotate the offset into the rect's own frame. */
function rectHasPt(R, x, y) {
  const dx = x - R.mx, dy = y - R.my;
  return Math.abs(dx * R.ux + dy * R.uy) <= R.hw && Math.abs(dy * R.ux - dx * R.uy) <= R.hh;
}
/* Oriented-rect overlap by separating axis: four candidate axes (both rects'
 * own axes), disjoint if any one separates them. */
function rectHit(A, B) {
  const dx = B.mx - A.mx, dy = B.my - A.my;
  const axes = [[A.ux, A.uy], [-A.uy, A.ux], [B.ux, B.uy], [-B.uy, B.ux]];
  for (const [ax, ay] of axes) {
    const ra = A.hw * Math.abs(A.ux * ax + A.uy * ay) + A.hh * Math.abs(A.ux * ay - A.uy * ax);
    const rb = B.hw * Math.abs(B.ux * ax + B.uy * ay) + B.hh * Math.abs(B.ux * ay - B.uy * ax);
    if (Math.abs(dx * ax + dy * ay) > ra + rb) return false;
  }
  return true;
}
/* An axis-aligned keep-out box as a rect, so it can go through rectHit. */
const boxAsRect = (b) => ({ mx: (b.x1 + b.x2) / 2, my: (b.y1 + b.y2) / 2,
                            ux: 1, uy: 0, hw: (b.x2 - b.x1) / 2, hh: (b.y2 - b.y1) / 2 });
/* AABB enclosing the oriented label -- keep-out export only (see labelRect). */
function labelBox(cx, cy, w, bearing, rOut) {
  const R = labelRect(cx, cy, w, bearing, rOut);
  const ex = R.hw * Math.abs(R.ux) + R.hh * Math.abs(R.uy);
  const ey = R.hw * Math.abs(R.uy) + R.hh * Math.abs(R.ux);
  return { x1: R.mx - ex, y1: R.my - ey, x2: R.mx + ex, y2: R.my + ey };
}
const boxHit = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
const inBox = (x, y, b) => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2;
/* Polyline -> points every ~`step` px. Sampling beats exact segment/box
 * clipping for the track test: it is trivially correct, and the near-dot
 * exclusion above falls out as a plain distance check per sample. */
function samplePoly(pts, step) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1], bx = pts[i][0], by = pts[i][1];
    const segs = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let s = 0; s < segs; s++) out.push([ax + (bx - ax) * s / segs, ay + (by - ay) * s / segs]);
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}
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
/* Tag a job with everything the renderer needs for a given bearing. */
function tagLabel(j, deg) {
  const left = isLeftward(deg), r = j.rOut == null ? R_OUT : j.rOut;
  j.bearing = deg;
  j.tilt = bearingTilt(deg);
  j.anchor = left ? "end" : "start";
  j.tx = left ? -r : r;   // rotate() maps +x to the tilt, so a leftward spoke
  return j;               // needs -x plus an "end" anchor to radiate outward
}
/* Public entry point: solve, but NEVER let a solver bug blank the map. The card
 * is a storm-warning display; if the placement math throws, flat labels in the
 * default spot beat no labels and beat a dead render. Dropping an individual
 * tag that genuinely fits nowhere is expected and fine (Aaron, 2026-07-19) --
 * this catch is for the different case where the solver itself breaks. */
function placeLabels(jobsIn, env) {
  try {
    return solveLabels(jobsIn, env);
  } catch (e) {
    console.warn("hurricane-card: label solver failed, using flat fallback", e);
    return thinLabels(jobsIn || []).map((j) => tagLabel(j, 0));
  }
}
/* Place the forecast-dot time labels. `env.boxes` are static keep-outs (the
 * forecast dots themselves, the home marker); `env.trackPts` is the sampled
 * track polyline. Returns only the labels that survived, each tagged with its
 * bearing/tilt/anchor. See the block comment above labelRect for the rules. */
function solveLabels(jobsIn, env) {
  const jobs = thinLabels(jobsIn);
  const n = jobs.length;
  if (!n) return [];
  const statics = (env && env.boxes) || [];
  const tpts = (env && env.trackPts) || [];
  const NB = BEARINGS.length;
  const W = jobs.map((j) => (j.text ? j.text.length : 0) * CHAR_W);

  // Geometry + STATIC feasibility per (label, bearing), computed once up front.
  // A keep-out box containing the label's OWN dot centre is skipped -- that is
  // its own dot, which every spoke necessarily starts next to.
  const srect = statics.map(boxAsRect);
  const box = [], ok = [];
  for (let i = 0; i < n; i++) {
    box[i] = []; ok[i] = [];
    const jx = jobs[i].cx, jy = jobs[i].cy;
    const jr = jobs[i].rOut == null ? R_OUT : jobs[i].rOut;
    for (let k = 0; k < NB; k++) {
      const R = labelRect(jx, jy, W[i], BEARINGS[k], jr);
      box[i][k] = R;
      let good = !srect.some((s, si) => !inBox(jx, jy, statics[si]) && rectHit(R, s));
      if (good)
        for (const t of tpts) {
          if (Math.hypot(t[0] - jx, t[1] - jy) <= jr) continue;   // under its own dot
          if (rectHasPt(R, t[0], t[1])) { good = false; break; }
        }
      ok[i][k] = good;
    }
  }

  // ---- Pass A: the IDEAL bearing. Score each candidate by how many labels fit
  // if the whole track used it. The objective is deliberately "fewest exceptions
  // needed", not "fewest raw collisions" -- the winner is the angle the runs get
  // built around, so it should be the one that needs the least breaking.
  let ideal = BEARINGS[0], bestScore = -Infinity;
  for (let k = 0; k < NB; k++) {
    const seen = []; let fit = 0;
    for (let i = 0; i < n; i++) {
      if (!ok[i][k] || seen.some((b) => rectHit(box[i][k], b))) continue;
      seen.push(box[i][k]); fit++;
    }
    // Ties: flatter text wins, then the up-screen spoke (negative y is up).
    const sc = fit * 1000 - Math.abs(bearingTilt(BEARINGS[k])) * 2 - Math.sin(BEARINGS[k] * Math.PI / 180) * 3;
    if (sc > bestScore) { bestScore = sc; ideal = BEARINGS[k]; }
  }

  // ---- Pass B: DP over contiguous RUNS. State is (bearing of the last PLACED
  // label, is that run still a singleton, index of that label). A dropped label
  // is transparent -- it does not break the run around it. The singleton
  // penalty is charged when a one-label run closes, and that is the whole
  // mechanism behind "neighbours come along": carrying 6,7,8 over to a new angle
  // buys one run cost, while breaking for 5 alone buys a run cost AND a
  // singleton penalty, so the DP takes the group whenever the group fits.
  const key = (k, s, li) => k + "|" + s + "|" + li;
  let cur = new Map();
  cur.set(key(-1, 1, -1), { cost: 0, back: null, k: -1, s: 1, li: -1 });
  for (let i = 0; i < n; i++) {
    const next = new Map();
    const relax = (kk, ss, li, cost, back, act) => {
      const kx = key(kk, ss, li), prev = next.get(kx);
      if (!prev || cost < prev.cost) next.set(kx, { cost, back, k: kk, s: ss, li, act });
    };
    for (const st of cur.values()) {
      // Drop label i: costly, but keeps the run structure intact across it.
      relax(st.k, st.s, st.li, st.cost + LBL_DROP_COST, st, { i, drop: true });
      for (let k = 0; k < NB; k++) {
        if (!ok[i][k]) continue;
        // Adjacency is exact here: st.li is the last label actually drawn, and
        // labels are ordered along the track, so this is the only near neighbour.
        if (st.li >= 0 && rectHit(box[i][k], box[st.li][st.k])) continue;
        if (st.k === k) {
          relax(k, 1, i, st.cost, st, { i, k });                     // extend the run
        } else {
          let c = st.cost + bearingDelta(BEARINGS[k], ideal) * LBL_DEV_W;
          if (st.k >= 0) { c += LBL_RUN_COST; if (st.s === 0) c += LBL_SINGLE_COST; }
          relax(k, 0, i, c, st, { i, k });                           // open a new run
        }
      }
    }
    cur = next;
    // Unreachable in practice -- dropping is always a legal move, so some state
    // always survives. Belt-and-braces: degrade to no labels, never to a throw.
    if (!cur.size) return [];
  }
  // Close the final run.
  let best = null;
  for (const st of cur.values()) {
    const c = st.cost + (st.s === 0 && st.k >= 0 ? LBL_SINGLE_COST : 0);
    if (!best || c < best.c) best = { c, st };
  }
  if (!best) return [];

  const chosen = new Array(n).fill(-1);
  for (let st = best.st; st && st.act; st = st.back)
    if (!st.act.drop) chosen[st.act.i] = st.act.k;

  // ---- Pass C: non-adjacent safety sweep. The DP only tests each label against
  // its immediate predecessor; a long 45-degree label can occasionally reach
  // past it. Cheap belt-and-braces -- drop anything that still overlaps.
  const out = [], kept = [];
  for (let i = 0; i < n; i++) {
    const k = chosen[i];
    if (k < 0) continue;
    if (kept.some((b) => rectHit(box[i][k], b))) continue;
    kept.push(box[i][k]);
    out.push(tagLabel(jobs[i], BEARINGS[k]));
  }
  return out;
}

/* Home's projected screen point. Longitude is normalized into the map's
 * 360-degree window first, so a home more than half the globe away in raw
 * longitude still projects to the correct side (the short way round) rather
 * than the wrong edge. May land OFF-frame -- callers decide what to do then.
 * Shared by the home marker and the label solver's keep-out, so the two can
 * never disagree about where home is. */
function homeScreenPt(st, proj) {
  const cLng = (st.bbox[0] + st.bbox[2]) / 2;
  let hlng = st.home[0];
  while (hlng - cLng > 180) hlng -= 360;
  while (hlng - cLng < -180) hlng += 360;
  return proj(hlng, st.home[1]);
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
function homeEdgeMarker(hx, hy, m, clampX, clampY) {
  const cx = clampX != null ? clampX : Math.max(EDGE_M, Math.min(VBW - EDGE_M, hx));
  const cy = clampY != null ? clampY : Math.max(EDGE_M, Math.min(VBH - EDGE_M, hy));
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
 * any default-frame px point under the view (s,tx,ty) is simply s*p+t: the cone
 * polygon transforms affinely, but the forecast dots + their time labels now
 * hold constant on-screen size (their own .hu-zl groups, like these labels), so
 * their keep-out boxes translate with the view at a FIXED size, not scaled.
 * Screen-space overlay boxes (home marker, model legend) apply only at the
 * default frame -- the overlays are hidden everywhere else. */
const REGION_CHAR_W = 8.6;   // ~14px uppercase sans-serif (matches .hu-region)
/* Nudge offsets tried in order (px). Anchor first, then toward open water nearby. */
const REGION_NUDGES = [[0, 0], [0, 15], [0, -15], [16, 0], [-16, 0], [0, 28], [0, -28], [22, 14], [-22, 14], [22, -14], [-22, -14], [0, 42], [0, -42]];
function layoutZoomLabels(ctx, view) {
  const s = view.s || 1, tx = view.tx || 0, ty = view.ty || 0;
  const T = (x, y) => [s * x + tx, s * y + ty];
  // keepGeo boxes are the forecast dots + time labels -- now CONSTANT on-screen
  // size (they're counter-scaled .hu-zl groups). Translate each box's CENTER with
  // the view but keep its size fixed; scaling the box (the old affine map) would
  // over/under-state the clearance and let region/city labels collide on zoom.
  const keep = ctx.keepGeo.map((b) => {
    const hw = (b.x2 - b.x1) / 2, hh = (b.y2 - b.y1) / 2;
    const cx = s * ((b.x1 + b.x2) / 2) + tx, cy = s * ((b.y1 + b.y2) / 2) + ty;
    return { x1: cx - hw, y1: cy - hh, x2: cx + hw, y2: cy + hh };
  });
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

/* Mileage axes: one horizontal + one vertical tick ruler hugging two frame
 * edges, numbered in cumulative miles from the corner where they meet.
 *
 * ARCHITECTURE -- returns an EMIT FUNCTION, not markup. The visible frame is
 * not the 800x600 viewBox: in fill mode the letterbox slack reveals oxU/oyU
 * extra user units of buffered map on each side, and _fitOverlays slides every
 * anchored overlay out to those real edges. A scale laid out at build time
 * against the default frame is wrong twice in fill mode -- its ticks stop at
 * the 800-unit frame while water runs on, and it dodges legends at positions
 * they've slid away from (the phantom mid-bottom gaps of 2026-07-19, three
 * storms running). So build hands back `emit(oxU, oyU)`, buildConeSvg renders
 * emit(0,0) into the initial svg, and _fitOverlays re-emits with the measured
 * slack on every layout pass, swapping the .hu-scax groups in place. All
 * collision inputs live in the closure; one emit is a few hundred Set lookups.
 *
 * RULES (Aaron, 2026-07-19):
 * - ALWAYS SHOW. No farCase gate, no house involvement. `show_scale` decides.
 * - ORIGIN = the corner whose two rulers yield the most surviving ticks over
 *   water, with a thumb on the scale for bottom-left (then bottom-right /
 *   top-left) so a close call lands where a reader expects a graph's zero.
 * - Ticks SPAN blockers: a run continues past land/cone/furniture and resumes
 *   over water -- a blocked tick is skipped, never fatal.
 * - Deconfliction moves a ruler, it never kills one: each ruler lands on its
 *   higher-yielding edge (numbers count from the origin either way, so the
 *   flip never renumbers). An axis dies only if the whole frame can't hold 2.
 * - MILEAGE ALWAYS LOSES: land, cone, tracks, model guidance, ww stripe,
 *   coast/state lines, surge, wind field, city/pop dots, every label, legend,
 *   note, the home marker and the top-right control cluster all outrank ticks.
 *
 * `boxes` = AABB keep-outs; screen-space ones carry `anch` ("bl", "r", "tr"...)
 * and are slid by the letterbox slack before testing, exactly as _fitOverlays
 * will slide the furniture itself. `conePx` + geo.land are tested as polygons
 * at box centers (their EDGES ride the sampled-line grid, so a shoreline
 * straddle is still caught). `blockPts` = everything stroked or dotted,
 * pre-sampled to px and hashed into a coarse occupancy grid. */
function scaleAxes(bbox, proj, geo, boxes, conePx, blockPts) {
  const midLng = (bbox[0] + bbox[2]) / 2, midLat = (bbox[1] + bbox[3]) / 2;
  const [, ya] = proj(midLng, midLat);
  const [, yb] = proj(midLng, midLat + 1);
  const pxPerMile = Math.abs(yb - ya) / 69.05;
  if (!isFinite(pxPerMile) || pxPerMile <= 0) return null;
  const step = niceMiles(pxPerMile), stepPx = step * pxPerMile;
  if (stepPx < 44) return null;

  const landPx = ((geo && geo.land) || []).map((part) => part.map((c) => proj(c[0], c[1])));
  // Per-polygon AABBs: most probes are over open water, so a bbox reject
  // skips the expensive pointInPoly walk for nearly every land part.
  const landBB = landPx.map((poly) => {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [x, y] of poly) {
      if (x < x1) x1 = x; if (x > x2) x2 = x;
      if (y < y1) y1 = y; if (y > y2) y2 = y;
    }
    return [x1, y1, x2, y2];
  });
  const CELL = 8, lineCells = new Set();
  for (const p of blockPts || [])
    lineCells.add(((Math.floor(p[0] / CELL)) + "," + (Math.floor(p[1] / CELL))));
  const OFF = 16;

  let memoKey = null, memoRes = null;   // _fitOverlays re-runs with unchanged slack constantly
  return function emit(oxU, oyU) {
    const key = oxU.toFixed(1) + "|" + oyU.toFixed(1);
    if (key === memoKey) return memoRes;
    // Visible frame in user units. The buffered basemap really is drawn out
    // there (no frame clip, see the svg assembly), so ticks are honest map.
    const FL = -oxU, FR = VBW + oxU, FT = -oyU, FB = VBH + oyU;
    // Slide each screen-anchored keep-out the same way _fitOverlays slides its
    // furniture. Geographic boxes (no anch) stay put.
    const sb = boxes.map((b) => {
      const a = b.anch || "";
      if (!a) return b;
      const dx = a.includes("l") ? -oxU : a.includes("r") ? oxU : 0;
      const dy = a.includes("t") ? -oyU : a.includes("b") ? oyU : 0;
      return { x1: b.x1 + dx, y1: b.y1 + dy, x2: b.x2 + dx, y2: b.y2 + dy };
    });
    const free = (x1, y1, x2, y2) => {
      if (x1 < FL + 2 || x2 > FR - 2 || y1 < FT + 2 || y2 > FB - 2) return false;
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      if (conePx.length >= 3 && pointInPoly(cx, cy, conePx)) return false;
      for (let i = 0; i < landPx.length; i++) {
        const bb = landBB[i];
        if (cx < bb[0] || cx > bb[2] || cy < bb[1] || cy > bb[3]) continue;
        if (landPx[i].length >= 3 && pointInPoly(cx, cy, landPx[i])) return false;
      }
      const box = { x1, y1, x2, y2 };
      if (sb.some((b) => boxHit(box, b))) return false;
      const gx2 = Math.floor(x2 / CELL), gy2 = Math.floor(y2 / CELL);
      for (let gx = Math.floor(x1 / CELL); gx <= gx2; gx++)
        for (let gy = Math.floor(y1 / CELL); gy <= gy2; gy++)
          if (lineCells.has(gx + "," + gy)) return false;
      return true;
    };

    /* Emitted coordinates vs tested coordinates: the group's data-anch slide
     * (applied by _fitOverlays AFTER emission) moves a bottom axis down by oyU
     * and a left axis left by oxU -- so the ANCHORED coordinate is emitted in
     * default-frame units (VBH-16 / 16) but TESTED at its visible position,
     * while the running coordinate is emitted AND tested in visible units
     * (the slide doesn't touch that direction). */
    const buildX = (bottom, ox) => {
      const out = [], sx = ox < (FL + FR) / 2 ? 1 : -1;
      const ay = bottom ? VBH - OFF : OFF;           // emitted (pre-slide)
      const vy = bottom ? FB - OFF : FT + OFF;       // tested (visible)
      const ty = ay + (bottom ? -10 : 17), y2t = ay + (bottom ? -7 : 7);
      const tvy = vy + (bottom ? -10 : 17);
      for (let k = 1; ; k++) {
        const x = ox + sx * stepPx * k;
        if (x < FL + 34 || x > FR - 34) break;
        const txt = k === 1 ? withCommas(step) + " mi" : withCommas(step * k);
        // Box tick + label off the real string width -- a flat +/-18
        // under-measures "1,500 mi" and lets it sit on things.
        const hw = Math.max(16, txt.length * 3.6 + 5);
        if (!free(x - hw, Math.min(vy - 2, tvy - 11), x + hw, Math.max(vy + (bottom ? -7 : 7) + 2, tvy + 4))) continue;
        out.push(`<line class="hu-scale-tick" x1="${x.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y2t.toFixed(1)}"/>`);
        out.push(`<text class="hu-scale-label" x="${x.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle">${esc(txt)}</text>`);
      }
      return out;
    };
    const buildY = (left, oy) => {
      const out = [], sy = oy > (FT + FB) / 2 ? -1 : 1;
      const ax = left ? OFF : VBW - OFF;             // emitted (pre-slide)
      const vx = left ? FL + OFF : FR - OFF;         // tested (visible)
      for (let k = 1; ; k++) {
        const y = oy + sy * stepPx * k;
        if (y < FT + 34 || y > FB - 34) break;
        const txt = withCommas(step * k);
        const w = txt.length * 7.2 + 6;              // label runs inboard
        const x1 = left ? vx - 2 : vx - w - 9, x2 = left ? vx + w + 9 : vx + 2;
        if (!free(x1, y - 9, x2, y + 9)) continue;
        out.push(`<line class="hu-scale-tick" x1="${ax.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(ax + (left ? 7 : -7)).toFixed(1)}" y2="${y.toFixed(1)}"/>`);
        out.push(`<text class="hu-scale-label" x="${(ax + (left ? 11 : -11)).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${left ? "start" : "end"}">${esc(txt)}</text>`);
      }
      return out;
    };

    /* THE ORIGIN IS THE CORNER WHERE THE AXES MEET -- full stop (Aaron,
     * 2026-07-19, after two wrong cuts that let a ruler drift to the opposite
     * edge "for room" and produced a y-axis counting DOWN from a top-left zero
     * while sitting on the right edge). Each candidate corner is a PACKAGE:
     * the x-ruler lives on that corner's horizontal edge, the y-ruler on its
     * vertical edge, and BOTH number outward from the corner -- so a
     * bottom-right origin reads right-to-left along the bottom and
     * bottom-to-top up the right side, always. No independent edge flips.
     *
     * Corner choice: the package with the most surviving ticks wins ("the
     * longest origination on both axes"), bottom-left taking near-ties via a
     * small bonus, bottom-right/top-left next. Both rulers share one step and
     * one px-per-mile, so the two scales are identical by construction. */
    const corners = [
      { left: true,  bottom: true,  bonus: 1.5 },   // bottom-left -- preferred
      { left: false, bottom: true,  bonus: 0.75 },  // bottom-right
      { left: true,  bottom: false, bonus: 0.75 },  // top-left
      { left: false, bottom: false, bonus: 0 },     // top-right
    ];
    let best = null;
    for (const c of corners) {
      const ox = c.left ? FL + OFF : FR - OFF;
      const oy = c.bottom ? FB - OFF : FT + OFF;
      const xr = buildX(c.bottom, ox);   // x-ruler on the origin's horizontal edge
      const yr = buildY(c.left, oy);     // y-ruler on the origin's vertical edge
      const v = (xr.length + yr.length) / 2 + c.bonus;
      if (!best || v > best.v) best = { v, c, xr, yr };
    }

    // Per-axis anchored groups (hu-scax marks them for _fitOverlays swap).
    // A lone surviving tick is noise, not a scale: 2 minimum (2 nodes each).
    const wrapA = (a, parts) => `<g class="hu-anch hu-scax" data-anch="${a}">${parts.join("")}</g>`;
    const res = [];
    if (best.xr.length >= 4) res.push(wrapA(best.c.bottom ? "b" : "t", best.xr));
    if (best.yr.length >= 4) res.push(wrapA(best.c.left ? "l" : "r", best.yr));
    memoKey = key; memoRes = res;
    return res;
  };
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
  // Place dots: two INDEPENDENT modes now (both can be on). show_cities config
  // is the dashboard master gate for both; per-mode state is a viewer pref.
  const dotsOn = cfg.show_cities !== false;
  const dotsCities = dotsOn && prefs.dotsCities !== false;
  const dotsPop = dotsOn && prefs.dotsPop === true;
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
      if (part.length >= 2) base.push(`<path class="hu-state" d="${basePath(proj, part, false, false)}"/>`);   // political borders drawn straight (never curve-smoothed)
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
  // whole-track envelope / NHC's forecast corridor), CENTER = off.
  // LEFT does NOT fall back to the swath: a TD carries no current >=34 kt
  // radii, and silently drawing the multi-day forecast swath under "Current"
  // read as the storm being enormous right now (Aaron, 2026-07-18, live on
  // Six-E). An empty field draws nothing and drops an honest note into the
  // corner legend slot instead (stacks with the stripe/surge notes). RIGHT
  // still falls back to the current field — a bigger promise degrading to a
  // smaller truth isn't misleading.
  let windSrc = null, windNote = false, swathNote = false;
  if (triWind === "left") {
    windSrc = (st.windField && st.windField.length) ? st.windField : null;
    windNote = !windSrc;
  } else if (triWind === "right") {
    const haveSwath = !!(st.windSwath && st.windSwath.length);
    // The Swath side KEEPS its fallback to the current field (settled v0.2.5 --
    // unlike the Current side, which must never silently show a multi-day
    // forecast swath). But falling back silently still leaves the viewer looking
    // at something other than what they asked for, so say so: the note fires on
    // missing swath data whether or not there was a field to fall back to.
    windSrc = haveSwath ? st.windSwath : st.windField;
    swathNote = !haveSwath;
  }
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
  if (dotsCities && st.places && st.places.length) {
    for (const p of st.places.slice(0, CITY_DOT_DRAW)) {
      const [x, y] = proj(normLng(p.lng), p.lat);
      ctxCities.push({ name: p.name, x, y, r: 2.6, cls: "hu-city" });
    }
  }
  if (dotsPop) {
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

  const storm = [];
  // Watch/warning stripe. `traced` segments were re-cut server-side from the
  // SAME vertices as geo.coast, so they must go through the SAME smoother --
  // drawn straight against a curve-smoothed coast, the stripe visibly peels off
  // the shoreline on every bend. Untraced segments are NHC's raw breakpoint
  // chords (the snap-failure fallback) and stay straight: official geometry
  // isn't ours to curve.
  if (triStripe === "left")
    for (const seg of st.ww || []) {
      const col = wwColor(seg.type);
      if (col && seg.coords && seg.coords.length >= 2)
        storm.push(`<path class="hu-ww" d="${basePath(proj, seg.coords, false, smooth && seg.traced === true)}" stroke="${col}"/>`);
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
  const modelPts = [];   // sampled px points -> mileage-axis blockers (a tick must not sit on model guidance)
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
      modelPts.push(...samplePoly(projectPart(proj, coords), 6));
      modelRows.push([m.label || m.id, modelColor(m.id)]);
    }
  }

  const keepOut = [];      // GEOGRAPHIC keep-out boxes (forecast dots + time labels): CONSTANT on-screen size, so layoutZoomLabels translates their CENTER with the view but does NOT scale the box
  const keepScreen = [];   // screen-space overlay boxes (home marker, model legend): only valid at the default frame
  const labelJobs = [];
  const projPts = (st.points || []).map((p) => (p.lng == null || p.lat == null) ? null : proj(p.lng, p.lat));
  // Forecast dots + time labels are GEOGRAPHIC anchors but hold CONSTANT on-screen
  // size (like region/city labels) via .hu-zl counter-scale groups, so they don't
  // balloon on zoom-in -- the gesture loop counter-scales every .hu-zl each frame.
  // Dots and labels go in SEPARATE groups (all dots pushed first, then all labels)
  // so labels stay painted on top of every dot, exactly as before.
  const fdotGroups = [], flabelGroups = [];
  const zlFixed = (ax, ay, inner) =>
    `<g class="hu-zl" data-ax="${ax.toFixed(1)}" data-ay="${ay.toFixed(1)}" transform="translate(${ax.toFixed(1)} ${ay.toFixed(1)}) scale(1)">${inner}</g>`;
  (st.points || []).forEach((p, i) => {
    if (p.lng == null || p.lat == null) return;
    const [x, y] = projPts[i];
    const ink = (p.cat === "TD" || p.cat === "TS" || p.cat === "HU") ? "#EDE3D2" : "#14110d";
    // Inner elements anchor at the group origin (0,0); the group's translate puts
    // them at the dot. Same paint order as before: dot, then "now" ring, then glyph.
    let inner = `<circle class="hu-fdot" cx="0" cy="0" r="${FDOT_R}" fill="${catColor(p.cat)}"/>`;
    if (i === 0) inner += `<circle class="hu-now-ring" cx="0" cy="0" r="${NOW_RING_R}"/>`;   // current position (tau 0)
    inner += `<text class="hu-fcat" x="0" y="5" fill="${ink}">${esc(catDotLabel(p.cat))}</text>`;
    fdotGroups.push(zlFixed(x, y, inner));
    // Keep-out is the dot's own reach: the current-position dot is wider by its
    // whole white ring, so it claims more room than the plain forecast dots.
    const kr = (i === 0 ? R_OUT_NOW : R_OUT) - 1;
    keepOut.push({ x1: x - kr, y1: y - kr, x2: x + kr, y2: y + kr });
    if (p.label) {
      const a = projPts[i - 1] || [x, y], b = projPts[i + 1] || [x, y];
      labelJobs.push({ cx: x, cy: y, text: p.label, tdx: b[0] - a[0], tdy: b[1] - a[1],
                       rOut: i === 0 ? R_OUT_NOW : R_OUT });
    }
  });
  // Conflict targets for the label solver. keepOut already holds every forecast
  // dot box (pushed just above); an ON-FRAME home marker joins them -- an
  // off-frame home is edge-clamped furniture that _fitOverlays owns, and it
  // never sits where a label would. SNAPSHOT (slice): keepOut keeps growing
  // below as labels are placed, and the solver must see only what exists now.
  const labelBlockers = keepOut.slice();
  if (cfg.show_home !== false && st.home && st.home[0] != null) {
    const [hx0, hy0] = homeScreenPt(st, proj);
    if (hx0 >= 0 && hx0 <= VBW && hy0 >= 0 && hy0 <= VBH)
      labelBlockers.push({ x1: hx0 - 20, y1: hy0 - 20, x2: hx0 + 20, y2: hy0 + 20 });
  }
  // Track polylines, sampled, so a label can be tested for lying ALONG the
  // track rather than merely crossing a dot. Past + forecast both count: a
  // label laid over either one is unreadable.
  const trackPts = [];
  for (const seg of [st.fcstTrack, st.pastTrack])
    if (seg && seg.length > 1) trackPts.push(...samplePoly(projectPart(proj, seg), 5));
  placeLabels(labelJobs, { boxes: labelBlockers, trackPts }).forEach((L) => {
    // Spoke label: the text starts R_OUT from the dot and radiates outward, so
    // it reads as pointing back at its dot. Rotation about the group origin is
    // translation-invariant, so the bearing's tilt applies verbatim here. A
    // leftward spoke draws at x=-R_OUT with an "end" anchor (see placeLabels).
    // y=5 is baseline centring for the 17px face, same as the dot glyph.
    const rot = L.tilt ? ` transform="rotate(${L.tilt.toFixed(1)},0,0)"` : "";
    const inner = `<text class="hu-flabel" x="${L.tx.toFixed(2)}" y="5" text-anchor="${L.anchor}"${rot}>${esc(L.text)}</text>`;
    flabelGroups.push(zlFixed(L.cx, L.cy, inner));
    keepOut.push(labelBox(L.cx, L.cy, (L.text ? L.text.length : 0) * CHAR_W, L.bearing, L.rOut));
  });
  storm.push(...fdotGroups, ...flabelGroups);

  const homeParts = [];
  let hcx = 0, hcy = 0, homeAnch = "";
  if (cfg.show_home !== false && st.home && st.home[0] != null) {
    // Home projects like everything else -- the marker sits where home actually
    // is on THIS map, and the chevron aims at it. See homeScreenPt for the
    // longitude normalization.
    const [hx, hy] = homeScreenPt(st, proj);
    if (hx >= 0 && hx <= VBW && hy >= 0 && hy <= VBH) {
      homeParts.push(houseGlyph(hx, hy));
      keepScreen.push({ x1: hx - 20, y1: hy - 20, x2: hx + 20, y2: hy + 20 });
    } else {
      // Off-frame: clamp the house to the edge at home's projected position; the
      // chevron points from the house center straight at home.
      hcx = Math.max(EDGE_M, Math.min(VBW - EDGE_M, hx));
      hcy = Math.max(EDGE_M, Math.min(VBH - EDGE_M, hy));
      // Keep clear of the top-right control cluster (Recenter/advisory/gear) --
      // HTML furniture painted OVER the SVG, so the marker would draw behind it.
      // Slide the clamp out of that corner: down the right edge for a home off to
      // the right, else left along the top edge.
      const TK_X1 = VBW - 120, TK_Y2 = 58;
      if (hcx > TK_X1 && hcy < TK_Y2) {
        if (hx > VBW) hcy = TK_Y2 + 8; else hcx = TK_X1 - 8;
      }
      // Anchor only on the axes where the marker is actually edge-clamped, so
      // _fitOverlays slides it to the visible edge it hugs -- never the axis
      // where it sits at home's true projected position.
      homeAnch = (hx < 0 ? "l" : hx > VBW ? "r" : "") + (hy < 0 ? "t" : hy > VBH ? "b" : "");
      homeParts.push(homeEdgeMarker(hx, hy, st.meta || {}, hcx, hcy));
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
    }
  }

  // E4 model legend: screen-space furniture -> hu-overlays (hides on zoom with
  // the rest, like region labels). Reserved in keepOut BEFORE region labels and
  // the scale so they route around it. Loading/failure states are named
  // honestly -- never a silently missing layer.
  const mlegend = [];
  if (models && (modelRows.length || models.loading || models.failed)) {
    const rows = modelRows.length ? modelRows.slice() : [];
    if (!modelRows.length && (models.loading || models.failed))
      rows.push([models.loading ? "Loading model tracks…" : "Model tracks unavailable", null]);
    const rowH = 19, padX = 8, padY = 6;
    const maxCh = Math.max(...rows.map((r) => r[0].length));
    const w = padX + 24 + maxCh * 8.4 + padX;
    const h = rows.length * rowH + padY * 2;
    const x0 = 12, y0 = VBH - 12 - h;
    // hu-ml-bg / hu-ml-t mark this box for the post-render width fit (see the
    // fixup after innerHTML). maxCh * 8.4 is only a char-count ESTIMATE, and
    // when it ran short the right-hand padding came out visibly tighter than the
    // left -- the box looked lopsided. Measuring the painted text fixes it.
    mlegend.push(`<rect class="hu-mlegend-bg hu-ml-bg" x="${x0}" y="${y0}" width="${w.toFixed(0)}" height="${h}" rx="6"/>`);
    rows.forEach(([label, col], i) => {
      const cy = y0 + padY + i * rowH + rowH / 2;
      if (col) mlegend.push(`<line class="hu-mlegend-sw" x1="${x0 + padX}" y1="${cy.toFixed(1)}" x2="${x0 + padX + 18}" y2="${cy.toFixed(1)}" stroke="${col}"/>`);
      mlegend.push(`<text class="hu-mlegend-t hu-ml-t" x="${x0 + padX + (col ? 24 : 0)}" y="${(cy + 3.5).toFixed(1)}">${esc(label)}</text>`);
    });
    keepScreen.push({ x1: x0 - 4, y1: y0 - 4, x2: x0 + w + 4, y2: y0 + h + 4, anch: "bl" });
  }

  // E5 surge legend: bottom-right screen-space furniture (hu-overlays; hides on
  // zoom like the model legend). Band labels with their fill swatches; loading/
  // failure states named honestly -- never a silently missing layer. The same
  // slot carries the stripe-left counterpart: an NHC storm with zero drawable
  // ww segments says so explicitly -- "none in effect" is a real fact, distinct
  // from unavailable (GDACS storms never show this; the panel gates them as
  // NHC-only and their stripe falls back silently by design).
  const slegend = [];
  {
    const rows = [];
    if (triStripe === "right" && lay.surge
        && (lay.surge.loading || lay.surge.failed || (lay.surge.bands && lay.surge.bands.length))) {
      const seen = new Set();
      if (lay.surge.bands)
        lay.surge.bands.forEach((b, i) => {
          const lbl = b.label || "Surge area";
          if (seen.has(lbl) || rows.length >= 5) return;
          seen.add(lbl);
          rows.push([lbl, surgeColor(b, i)]);
        });
      // Two DIFFERENT facts, deliberately not collapsed into one string: a
      // failed fetch means we don't know, while a clean fetch with zero bands
      // means NHC has published none. Same distinction the coastal-warning note
      // draws ("none in effect" vs unavailable) -- never imply an all-clear we
      // haven't actually confirmed.
      if (!rows.length)
        rows.push([lay.surge.loading ? "Loading storm surge…"
          : lay.surge.failed ? "Storm surge data unavailable"
          : "No current storm surge data", null]);
    } else if (triStripe === "left" && nhcStorm) {
      // Name what's actually in effect: the stripe's four colors carry the whole
      // difference between "get ready" and "this is happening", and an unlabeled
      // colored line can't communicate that. Rows appear ONLY when something is
      // active (Aaron's call) -- otherwise the honest "none in effect" note.
      // DEDUPED BY TYPE: since coast-tracing, one warning emits several segments
      // (the mainland run plus each fronting barrier island), so iterating
      // segments naively would stack five identical rows.
      const active = [];
      for (const seg of st.ww || []) {
        if (!wwColor(seg.type) || !seg.coords || seg.coords.length < 2) continue;
        const k = String(seg.type).toUpperCase();
        if (!active.includes(k)) active.push(k);
      }
      if (active.length) {
        active.sort((a, b) => WW_ORDER.indexOf(a) - WW_ORDER.indexOf(b));
        for (const k of active) rows.push([WW_LABEL[k] || k, WW_COLOR[k]]);
      } else {
        rows.push(["No coastal warnings in effect", null]);
      }
    }
    // Wind note STACKS below the stripe/surge rows in the same box — the
    // corner slot is one stacked legend; notes never fight for it. Neutral
    // wording on purpose: an empty field is usually a TD (winds under 34 kt)
    // but can also be a fetch soft-fail, and the card can't tell them apart.
    if (windNote)
      rows.push(["No current wind field data", null]);
    if (swathNote)
      rows.push(["No swath data available", null]);
    if (rows.length) {
      // Swatchless notes ("No current storm surge data", "No coastal warnings
      // in effect") are right-justified: no 18px swatch slot in the box, text
      // anchored END at the box's right padding edge -- so the label hugs the
      // corner even though the box width is only a char-count estimate.
      const hasSw = rows.some((r) => r[1]);
      const rowH = 19, padX = 8, padY = 6;
      const maxCh = Math.max(...rows.map((r) => r[0].length));
      const w = padX + (hasSw ? 18 : 0) + maxCh * 8.4 + padX;
      const h = rows.length * rowH + padY * 2;
      const x0 = VBW - 12 - w, y0 = VBH - 12 - h;
      slegend.push(`<rect class="hu-mlegend-bg${hasSw ? "" : " hu-note-bg"}" x="${x0.toFixed(0)}" y="${y0}" width="${w.toFixed(0)}" height="${h}" rx="6"/>`);
      rows.forEach(([label, col], i) => {
        const cy = y0 + padY + i * rowH + rowH / 2;
        if (col) slegend.push(`<rect class="hu-slegend-sw" x="${(x0 + padX).toFixed(1)}" y="${(cy - 5).toFixed(1)}" width="10" height="10" rx="2" fill="${col}"/>`);
        if (hasSw)
          slegend.push(`<text class="hu-mlegend-t" x="${(x0 + padX + (col ? 16 : 0)).toFixed(1)}" y="${(cy + 3.5).toFixed(1)}">${esc(label)}</text>`);
        else
          slegend.push(`<text class="hu-mlegend-t hu-note-t" text-anchor="end" x="${(x0 + w - padX).toFixed(1)}" y="${(cy + 3.5).toFixed(1)}">${esc(label)}</text>`);
      });
      keepScreen.push({ x1: x0 - 4, y1: y0 - 4, x2: x0 + w + 4, y2: y0 + h + 4, anch: "br" });
    }
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
  /* Blockers for the mileage axes that AREN'T keep-out boxes and aren't the
   * cone/land fills scaleAxes tests itself: every stroked line and dot on the
   * map, sampled to px. Land, text, cone, lines, legends and notes all outrank
   * a mileage tick -- so anything drawn here has to be visible to the ruler's
   * collision test or it will be drawn over. */
  const scaleBlockPts = [];
  // Append by loop, never `push(...arr)`: a buffered coastline sampled at 6 px
  // runs to tens of thousands of points and a spread that wide blows the
  // argument-count limit.
  const addPts = (arr) => { for (let i = 0; i < arr.length; i++) scaleBlockPts.push(arr[i]); };
  addPts(trackPts);                                // past + forecast track
  addPts(modelPts);                                // E4 model guidance
  if (triStripe === "left")
    for (const seg of st.ww || [])
      if (seg.coords && seg.coords.length >= 2)
        addPts(samplePoly(projectPart(proj, seg.coords), 6));
  if (cfg.show_coast !== false)
    for (const part of (st.geo && st.geo.coast) || [])
      if (part.length >= 2) addPts(samplePoly(part.map((c) => proj(c[0], c[1])), 6));
  if (cfg.show_states !== false)
    for (const part of (st.geo && st.geo.states) || [])
      if (part.length >= 2) addPts(samplePoly(part.map((c) => proj(c[0], c[1])), 6));
  if (windSrc && windSrc.length)
    for (const w of windSrc)
      for (const ring of w.rings || [])
        if (ring.length >= 3) addPts(samplePoly(ring.map((c) => proj(c[0], c[1])), 8));
  if (triStripe === "right" && lay.surge && lay.surge.bands)
    for (const b of lay.surge.bands)
      for (const ring of b.rings || [])
        if (ring.length >= 3)
          addPts(samplePoly(ring.map(([lng, lat]) => proj(normLng(lng), lat)), 8));
  for (const c of ctxCities) scaleBlockPts.push([c.x, c.y]);
  if (gridPts) for (const g of gridPts) scaleBlockPts.push([g[0], g[1]]);
  // The top-right control cluster (Recenter/advisory/gear) is HTML painted
  // OVER the svg and pinned to the card's top-right corner -- same dodge the
  // off-frame home marker makes (TK_X1/TK_Y2), now visible to the ruler too.
  const scaleBoxes = keepOut.concat(keepScreen,
    [{ x1: VBW - 120, y1: 0, x2: VBW, y2: 58, anch: "tr" }]);
  const scaleEmit = (cfg.show_scale !== false)
    ? scaleAxes(st.bbox, proj, st.geo, scaleBoxes, conePx, scaleBlockPts) : null;
  const scale = scaleEmit ? scaleEmit(0, 0) : [];

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
  // cone/track/ww) -- these scale honestly, so pan/zoom is a transform on this
  // group alone. The forecast dots + on-dot time labels ride hu-pan too but hold
  // constant on-screen size via their own counter-scaled .hu-zl groups (like the
  // city/region labels), so they don't balloon on zoom-in. The E6 label groups
  // live in hu-pan too: cities
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
  const panGroup = [...base, ...windLayer, ...surgeLayer, ...gridDots,
    `<g class="hu-zl-cities">${zl0.cities}</g>`, ...storm,
    `<g class="hu-zl-regions">${zl0.regions}</g>`];
  // Screen-space furniture re-anchors to the VISIBLE edges (._fitOverlays):
  // a cluster carries data-anch letters (l/r/t/b) and slides by the letterbox
  // slack, so legends and the mileage axes hug the real card edges in fill
  // mode instead of floating at the frame's (Aaron, 2026-07-18). scaleAxes
  // wraps its own two per-axis groups; the in-frame home glyph gets no anchor.
  const anchG = (a, parts) => (a && parts.length)
    ? [`<g class="hu-anch" data-anch="${a}">${parts.join("")}</g>`] : parts;
  const overlayGroup = [...scale, ...anchG(homeAnch, homeParts), ...anchG("bl", mlegend), ...anchG("br", slegend)];
  const vb = st.viewBox ? st.viewBox.join(" ") : "";
  const ms = st.maxScale != null ? st.maxScale : 1;
  // NO frame clip on the geographic layer: in fill mode (Pass 3) the
  // element's letterbox slack past the 800x600 frame shows the BUFFERED
  // basemap, so the map fills the card instead of floating as a bar-boxed 4:3
  // window (a hard frame clip was tried 2026-07-18 and read as "the map
  // narrowed" -- rejected). Projection honesty: at the DEFAULT view the slack
  // reveals (mostly) the storm's own latitude band, where the storm-local
  // projection's E-W scale is still right, so no visible stretch; far-latitude
  // geography (a horizontally smeared US) only enters when the user zooms
  // out/pans -- Session C behavior, their choice. True arbitrary-aspect
  // reprojection stays deferred (spec 12). Screen furniture re-anchors to the
  // visible edges via the data-anch groups + _fitOverlays.
  const svg = `<svg class="hu-svg" viewBox="0 0 ${VBW} ${VBH}" preserveAspectRatio="xMidYMid meet"`
    + ` data-viewbox="${vb}" data-maxscale="${ms}" data-bbox="${(st.bbox || []).join(" ")}" xmlns="http://www.w3.org/2000/svg">`
    + `<g class="hu-pan">${panGroup.join("")}</g>`
    + `<g class="hu-overlays">${overlayGroup.join("")}</g>`
    + `</svg>`;
  return { svg, ctx, popImpact, scaleEmit };
}

/* The storm's display name + classification tag, e.g. "Elida (TS)". Hoisted out
 * of dataBar because the HEADER needs it too: turning the info bar Off (v0.2.6
 * Phase 2) must not take the storm's name off the card with it. The header line
 * carries only type + basin ("Tropical Depression - Atlantic"), which names the
 * weather, not the storm. */
function stormName(st) {
  const m = (st && st.meta) || {};
  let name = (m.name || "Storm").replace(/\s*\([^)]*\)\s*$/, "").trim();
  // Storm type is shown in the top header; strip it from the name so this reads
  // just the name + classification tag.
  if (m.type && name.toLowerCase().startsWith(m.type.toLowerCase()))
    name = name.slice(m.type.length).trim();
  const tag = catLabel(m.cat);
  return tag ? `${name} (${tag})` : name;
}
function dataBar(st, lay, popImpact) {
  const m = st.meta || {};
  const name = stormName(st);
  const bits = [];
  // m.type intentionally omitted here -- it's shown in the top header now.
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
  // Keep batches together when there's room (Aaron): each bit is a .hu-chunk.
  // Bottom bar: chunks flow inline with the dot separators -- exactly the old
  // look. Side column: CSS stacks each chunk as its own line and hides the
  // separators, so a bit only wraps INSIDE itself when it's genuinely longer
  // than the column (still space-only, paren-safe wrapping -- chunks are NOT
  // unbreakable units; that forces the column wide and stays rejected).
  const bitsHtml = bits.map((b) => `<span class="hu-chunk">${escNoWrapParens(b)}</span>`)
    .join(`<span class="hu-sep"> · </span>`);
  let peak = "";
  if (m.peak && m.peak.word) peak = `<div class="hu-bar-peak">Peak ${esc(m.peak.word)}${m.peak.label ? " by " + esc(m.peak.label) : ""}</div>`;
  return `<div class="hu-bar-name">${escNoWrapParens(name)}</div><div class="hu-bar-data">${bitsHtml}</div>${peak}`;
}

/* Phase 4: the at-home wind timeline -- a compact, self-contained graph UNDER the
 * map (its own zone, never on the map). A titled wind bar whose opacity deepens
 * where stronger thresholds overlap (same nested-alpha language as the on-map
 * wash); the home glyph on the bar at the storm centre's closest pass with the
 * distance tagged above it; and day/time labels INLINE at the real wind start/stop
 * points (weekday shown only when it changes, thinned to avoid collision, ends
 * always kept). Returns "" (renders nothing) unless home is forecast into a field. */
/* Returns "" when there is nothing to show -- no exposure rows means no storm
 * is forecast to bring wind to the user's home, and the block costs zero card
 * area in that case. That self-hiding is why the graph can default ON. */
function exposureTimeline(st, vertical) {
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

  // Pass 3 side-column variant: a GENUINELY vertical render -- track top-to-
  // bottom, "now" at top, future downward; time labels as normal horizontal
  // text beside the track; the home glyph rides the track by vertical
  // position. Not a CSS rotation -- rotated text was rejected outright.
  if (vertical) {
    const H = 190;   // track px height (fixed; the side column scrolls if tight)
    let vbars = "";
    for (const r of ex.rows) for (const [a, b] of r.windows) {
      const t = pct(a), h = Math.max(1, pct(b) - t);
      vbars += `<span class="hu-tlv-win" style="top:${t.toFixed(2)}%;height:${h.toFixed(2)}%;opacity:${OP[r.kt] || 0.16}"></span>`;
    }
    let vhome = "";
    if (cpa)
      vhome = `<span class="hu-tlv-home" style="top:${pct(cpa.tau).toFixed(2)}%"><svg viewBox="0 0 24 24"><path d="${MDI_HOME_PATH}"/></svg></span>`;
    // Label items down the axis: "now", each wind start/stop (weekday dropped
    // when unchanged, same rule as the horizontal), plus the closest-pass
    // distance as a priority item near the cpa position (clamped off the ends
    // so it can't sit on top of an end label).
    const vseen = {}, vlist = [];
    for (const t of bounds) { const k = Math.round(t); if (!(k in vseen)) { vseen[k] = 1; vlist.push(t); } }
    vlist.sort((a, b) => a - b);
    let vday = null;
    const vitems = [{ y: 0, label: "now", pri: true }];
    for (const t of vlist) {
      const full = ref != null ? fmtClock(ref, t) : `~${Math.round(t)}h`;
      let label = full;
      if (ref != null) {
        const sp = full.indexOf(" ");
        const day = sp > 0 ? full.slice(0, sp) : full;
        if (day === vday) label = full.slice(sp + 1);
        vday = day;
      }
      vitems.push({ y: pct(t), label });
    }
    if (vitems.length > 1) vitems[vitems.length - 1].pri = true;   // the far end always keeps
    if (cpa && cpa.dist != null)
      vitems.push({ y: Math.max(8, Math.min(92, pct(cpa.tau))), label: withCommas(cpa.dist) + " " + unit, pri: true, tag: true });
    vitems.sort((a, b) => a.y - b.y);
    // 1D thinning in px on the fixed track height: priority items keep, the
    // rest need clearance from EVERY kept label.
    const GAP = 15;
    const yPx = (it) => it.y * H / 100;
    const kept = vitems.filter((it) => it.pri);
    for (const it of vitems) {
      if (it.pri) continue;
      if (kept.every((k2) => Math.abs(yPx(k2) - yPx(it)) >= GAP)) kept.push(it);
    }
    kept.sort((a, b) => a.y - b.y);
    const vAnchor = (y) => (y < 7 ? "translateY(0)" : y > 93 ? "translateY(-100%)" : "translateY(-50%)");
    let vlabs = "";
    for (const it of kept) {
      if (!it.tag) vlabs += `<span class="hu-tlv-tick" style="top:${it.y.toFixed(2)}%"></span>`;
      vlabs += `<span class="${it.tag ? "hu-tlv-tag" : "hu-tlv-time"}" style="top:${it.y.toFixed(2)}%;transform:${vAnchor(it.y)}">${esc(it.label)}</span>`;
    }
    return `<div class="hu-tl hu-tlv">
      <div class="hu-tl-title">${TL_TITLE}</div>
      <div class="hu-tlv-body" style="min-height:${H}px">
        <div class="hu-tlv-track">${vbars}${vhome}</div>
        <div class="hu-tlv-labels">${vlabs}</div>
      </div>
    </div>`;
  }

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
    <div class="hu-tl-title">${TL_TITLE}</div>
    <div class="hu-tl-tagrow">${tag}</div>
    <div class="hu-tl-track">${bars}${home}</div>
    <div class="hu-tl-times">${times}</div>
  </div>`;
}

const STYLE = `
  :host { display: block; height: 100%; }
  ha-card { padding: 0; overflow: hidden; height: 100%; box-sizing: border-box; }
  /* Pass 3 dynamic layout. One grid, three modes, no config -- the card decides
   * (ResizeObserver -> _layoutCheck):
   *   normal   -- content-driven height, the pre-0.2.3 behavior (masonry/mobile).
   *   hu-fill  -- the dashboard imposed a height (sections drag-resize, panel
   *               view): the card fills it; the map keeps its 800x600 projection
   *               and letterboxes via preserveAspectRatio, and the slack shows
   *               more of the buffered basemap, so it reads as map -- not bars.
   *   hu-side  -- fill + wide-and-short: the whole non-map stack (tag, bar,
   *               timeline, pager, stale note) moves to a 240px right column.
   * hu-side always rides WITH hu-fill, and its row template must win: keep the
   * .hu-side rules AFTER the .hu-fill rules (equal specificity, later wins). */
  .hu-wrap { display: grid; grid-template-columns: minmax(0, 1fr); position: relative; }
  .hu-wrap.hu-fill { height: 100%; grid-template-rows: auto minmax(0, 1fr) auto; }
  .hu-wrap.hu-fill .hu-conewrap { min-height: 0; }
  .hu-wrap.hu-fill .hu-svg { height: 100%; }
  /* v0.2.6 Phase 3: the non-map blocks live in ONE rail, and position is a
   * single lever for both of them (splitting it produced combinations nobody
   * wanted -- Aaron, on glass 2026-07-19). Which rail is a class on the
   * container; both carry .hu-stack for shared base/scrollbar styling:
   *   .hu-bot   -- the bottom rail, under the map (the default)
   *   .hu-rail  -- the right side column
   * Exactly one of the two is emitted per render, so .hu-bot needs no side-mode
   * placement rule and the side grid stays two rows. Per-block on/off decides
   * what goes IN the rail, never where the rail is. */
  .hu-wrap.hu-side { grid-template-columns: minmax(0, 1fr) ${SIDE_RAIL_W}px;
                     grid-template-rows: auto minmax(0, 1fr); }
  .hu-wrap.hu-side .hu-tag { grid-column: 2; grid-row: 1; }
  .hu-wrap.hu-side .hu-conewrap { grid-column: 1; grid-row: 1 / span 2; }
  .hu-wrap.hu-side .hu-rail { grid-column: 2; grid-row: 2; min-height: 0; overflow-y: auto;
                              overscroll-behavior: contain; scrollbar-width: thin;
                              scrollbar-color: var(--secondary-text-color) transparent;
                              display: flex; flex-direction: column; }
  .hu-wrap.hu-side .hu-rail > * { flex: none; }
  /* ...except the at-home graph, which STRETCHES to fill whatever the column
   * has left (v0.2.6 Phase 2). Without this the vertical track sat at its 190px
   * floor with dead rail beneath it. Must out-specify the 'flex: none' above,
   * hence the full .hu-wrap.hu-side .hu-rail prefix. min-height:0 lets it
   * shrink below content size when the column is tight (the rail scrolls). */
  .hu-wrap.hu-side .hu-rail .hu-tlv { flex: 1 1 auto; min-height: 0;
                                      display: flex; flex-direction: column; }
  .hu-wrap.hu-side .hu-rail .hu-tlv .hu-tlv-body { flex: 1 1 auto; min-height: 0; }
  /* Storm pager: ONE absolute rule, positioned against the CARD (.hu-wrap) and
   * not against either rail, so it occupies the identical spot in both layouts
   * and toggling Bottom/Side cannot move it a pixel in either axis (Aaron,
   * 2026-07-19). Centred in a rail-width band at the card's right edge, lifted
   * PAGER_INSET off the card's bottom. There is deliberately NO per-mode
   * override here -- a mode-specific rule is exactly how it started drifting.
   * Under the gear panel's z-index on purpose: the panel is transient. */
  .hu-pager { position: absolute; z-index: 2; display: flex; align-items: center;
              justify-content: center; gap: 10px; padding: 0;
              right: 0; width: ${SIDE_RAIL_W}px;
              bottom: var(--hu-pager-b, ${PAGER_INSET}px); }
  /* Keep content out from under it. Horizontally: the bottom bar's last flow
   * item clears the band. Vertically: the bottom bar gets PAGER_CLEAR as a floor
   * and the side column the same value as bottom padding -- the same number in
   * both places, so the pager sits the same distance off the card's bottom edge
   * either way. In side mode this is also what stops the stretched vertical
   * graph from running its bottom labels under the buttons. */
  .hu-wrap.hu-haspager .hu-bot > :last-child { padding-right: ${PAGER_RESERVE}px; }
  .hu-wrap.hu-haspager .hu-bot { min-height: ${PAGER_CLEAR}px; }
  .hu-wrap.hu-haspager .hu-rail { padding-bottom: var(--hu-pager-clear, ${PAGER_CLEAR}px); }
  /* Bottom-rail packing (Phase 3): storm data and the graph share one line.
   * Sizing is NOT equal shares -- data takes what its text needs and the graph
   * absorbs every remaining px, since it is the only one that improves with
   * width. min-width:0 on the graph keeps its absolutely positioned time labels
   * from forcing the flex base wider than its share; align-items:flex-start so
   * the shorter item doesn't stretch to the taller one's height.
   * The wrapper is EMITTED ONLY for the row tier; stacked, the blocks are plain
   * siblings and every pre-existing bottom-rail rule applies untouched. */
  .hu-packrow { display: flex; align-items: flex-start; gap: ${PACK_GAP}px; }
  .hu-packrow > .hu-bar { flex: 0 1 auto; min-width: 0; }
  .hu-packrow > .hu-tl { flex: 1 1 0; min-width: 0; }
  .hu-nw { white-space: nowrap; }
  /* Side column: each info batch (.hu-chunk) is its own line and separators
   * hide -- batches stay together when there's room and only wrap internally
   * when longer than the column. Bottom bar: chunks flow inline, unchanged. */
  .hu-wrap.hu-side .hu-tag .hu-sep, .hu-wrap.hu-side .hu-bar-data .hu-sep { display: none; }
  .hu-wrap.hu-side .hu-tag .hu-chunk, .hu-wrap.hu-side .hu-bar-data .hu-chunk { display: block; }
  .hu-wrap.hu-side .hu-bar-data .hu-sep + .hu-chunk { margin-top: 3px; }
  /* Side column: slimmer, BALANCED side padding (Aaron: split it evenly --
   * flush-left with all the slack on the right read lopsided). */
  .hu-wrap.hu-side .hu-tag, .hu-wrap.hu-side .hu-bar, .hu-wrap.hu-side .hu-tl,
  .hu-wrap.hu-side .hu-stale { padding-left: 8px; padding-right: 8px; }
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
  .hu-mlegend-t { font: 600 14px/1 sans-serif; fill: #EDE3D2; }
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
              max-width: calc(100% - 20px); box-sizing: border-box; container-type: inline-size;
              max-height: calc(100% - 54px); overflow-y: auto; overscroll-behavior: contain;
              scrollbar-width: thin; scrollbar-color: var(--secondary-text-color) transparent;
              background: var(--card-background-color, var(--primary-background-color)); color: var(--primary-text-color);
              border-radius: 16px; padding: 12px 14px 10px; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
  .hu-panel.hu-open { display: block; }
  /* Visible scroll thumb (Safari path; Chrome/Firefox use the standard props
   * above). Content is NEVER shrunk to fit -- it scrolls instead. */
  .hu-panel::-webkit-scrollbar, .hu-adv-body::-webkit-scrollbar, .hu-stack::-webkit-scrollbar { width: 8px; }
  .hu-panel::-webkit-scrollbar-track, .hu-adv-body::-webkit-scrollbar-track, .hu-stack::-webkit-scrollbar-track { background: transparent; }
  .hu-panel::-webkit-scrollbar-thumb, .hu-adv-body::-webkit-scrollbar-thumb, .hu-stack::-webkit-scrollbar-thumb {
    background: var(--secondary-text-color); border-radius: 4px; }
  .hu-panel-row.hu-na { opacity: .45; }
  .hu-panel-note { font: 400 10px/1.2 sans-serif; opacity: .7; margin-left: 4px; }
  /* Standalone note under a segmented control (not an inline group suffix):
   * full width, its own line, no left indent to line up with the pill. */
  .hu-lay-note { font: 400 10px/1.3 sans-serif; opacity: .7; margin: 5px 2px 0; }
  .hu-panel-group { font: 700 10.5px/1 sans-serif; letter-spacing: .08em; text-transform: uppercase;
                    color: var(--secondary-text-color); margin: 12px 0 6px; display: flex;
                    align-items: baseline; gap: 6px; }
  .hu-panel-group:first-child { margin-top: 0; }
  /* M3 segmented button: full-width pill, hairline outline, equal segments,
   * selected segment tinted with the theme primary. Disabled group = 38%. */
  .hu-seg { display: flex; width: 100%; height: 32px; box-sizing: border-box;
            border: 1px solid var(--divider-color, rgba(127,127,127,.45)); border-radius: 16px; overflow: hidden; }
  .hu-seg-btn { flex: 1 1 0; min-width: 0; border: none; background: transparent; cursor: pointer;
                color: var(--primary-text-color); font: 500 clamp(8.5px, 6cqi, 12px)/1 sans-serif; padding: 0 3px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                border-left: 1px solid var(--divider-color, rgba(127,127,127,.45)); }
  .hu-seg-btn:first-child { border-left: none; }
  .hu-seg-btn.hu-sel { background: rgba(3,169,244,.24);
                       background: color-mix(in srgb, var(--primary-color, #03a9f4) 26%, transparent);
                       font-weight: 600; }
  .hu-seg.hu-na { opacity: .38; pointer-events: none; }
  /* M3 list row + switch: label left, switch right, one vertical grid. */
  .hu-panel-row { display: flex; align-items: center; justify-content: space-between; gap: 12px;
                  font: 400 13px/1.25 sans-serif; padding: 5px 0; cursor: pointer; }
  .hu-row-lbl { display: flex; flex-direction: column; min-width: 0; }
  .hu-row-lbl .hu-panel-note { margin-left: 0; }
  input.hu-sw { appearance: none; -webkit-appearance: none; width: 36px; height: 20px; border-radius: 10px;
                margin: 0; flex: none; position: relative; cursor: pointer;
                background: var(--secondary-background-color); box-sizing: border-box;
                border: 1.5px solid var(--divider-color, rgba(127,127,127,.55));
                transition: background .15s, border-color .15s; }
  input.hu-sw::after { content: ""; position: absolute; top: 50%; left: 3px; transform: translateY(-50%);
                       width: 13px; height: 13px; border-radius: 50%;
                       background: var(--secondary-text-color); transition: left .15s, width .15s, height .15s, background .15s; }
  input.hu-sw:checked { background: var(--primary-color, #03a9f4); border-color: var(--primary-color, #03a9f4); }
  input.hu-sw:checked::after { left: 18px; width: 15px; height: 15px; background: #fff; }
  .hu-panel-perf { font: 400 10.5px/1.4 sans-serif; color: var(--secondary-text-color); opacity: .8;
                   margin-top: 10px; padding-top: 8px;
                   border-top: 1px solid var(--divider-color, rgba(127,127,127,.3)); }
  .hu-adv { position: absolute; inset: 0; z-index: 4; display: flex; flex-direction: column;
            background: var(--card-background-color, var(--primary-background-color)); }
  .hu-adv-head { display: flex; align-items: center; justify-content: space-between; gap: 10px;
                 padding: 12px 14px 8px; font: 700 14px/1.2 sans-serif; color: var(--primary-text-color); }
  .hu-adv-close { border: none; background: var(--secondary-background-color); color: var(--primary-text-color);
                  border-radius: 50%; width: 26px; height: 26px; cursor: pointer; font-size: 13px; flex: none; }
  .hu-adv-body { overflow-y: auto; padding: 0 14px 14px; overscroll-behavior: contain;
                 scrollbar-width: thin; scrollbar-color: var(--secondary-text-color) transparent; }
  .hu-adv-text { white-space: pre-wrap; overflow-wrap: break-word; color: var(--primary-text-color);
                 font: 400 13px/1.45 ui-monospace, Menlo, Consolas, monospace; }
  .hu-adv-wait { display: flex; justify-content: center; padding: 30px 0; }
  .hu-adv-sub { font-size: 13px; color: var(--secondary-text-color); text-align: center; padding: 20px 0; }
  .hu-land { fill: var(--hu-land-color, var(--divider-color)); opacity: var(--hu-land-opacity, .55); stroke: none; }
  .hu-state { fill: none; stroke: var(--hu-state-color, var(--secondary-text-color)); stroke-width: var(--hu-state-width, .6); opacity: .4; }
  .hu-coast { fill: none; stroke: var(--hu-coast-color, var(--primary-text-color)); stroke-width: var(--hu-coast-width, 1); opacity: var(--hu-coast-opacity, .7); stroke-linejoin: round; stroke-linecap: round; }
  .hu-region { font: 600 14px/1 sans-serif; letter-spacing: .1em; text-transform: uppercase;
               text-anchor: middle; fill: var(--hu-region-color, var(--secondary-text-color)); opacity: .5;
               paint-order: stroke; stroke: var(--hu-bg, var(--primary-background-color)); stroke-width: 3px; }
  .hu-city { fill: var(--secondary-text-color); opacity: .75; }
  .hu-city-label { font: 500 14px/1 sans-serif; fill: var(--secondary-text-color); opacity: .75;
                   paint-order: stroke; stroke: var(--hu-bg, var(--primary-background-color)); stroke-width: 2.5px; }
  .hu-scale-tick { stroke: var(--secondary-text-color); stroke-width: 1.5; opacity: .55; }
  .hu-scale-label { font: 600 11px/1 sans-serif; fill: var(--secondary-text-color); opacity: .7;
                    paint-order: stroke; stroke: var(--hu-bg, var(--primary-background-color)); stroke-width: 3px; }
  .hu-wind { fill-opacity: .42; stroke: none; }
  .hu-ww { fill: none; stroke-width: 2; stroke-linecap: round; }
  .hu-surge { fill-opacity: .5; stroke: none; }
  .hu-popdot { fill: #4FC3F7; stroke: rgba(0,0,0,.35); stroke-width: .5; }
  .hu-slegend-sw { stroke: rgba(0,0,0,.3); stroke-width: .5; }
  .hu-cone-poly { fill: var(--hu-cone-color, var(--primary-text-color)); fill-opacity: .08; stroke: var(--hu-cone-color, var(--primary-text-color)); stroke-opacity: .3; stroke-width: 1; }
  .hu-track-past { fill: none; stroke: var(--hu-track-past-color, var(--secondary-text-color)); stroke-width: 2; stroke-dasharray: 4 5; opacity: .6; }
  .hu-track-fcst { fill: none; stroke: var(--hu-track-color, var(--primary-text-color)); stroke-width: 2.5; opacity: .85; }
  .hu-fdot { stroke: rgba(0,0,0,.35); stroke-width: 1; }
  .hu-now-ring { fill: none; stroke: #fff; stroke-width: 2.5; opacity: .95; }
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
  /* Vertical timeline (side column): a real vertical track with horizontal
   * text beside it -- never rotated text. */
  /* H is a FLOOR, not a height (v0.2.6 Phase 2): in the side column the body
   * grows to eat the leftover space below it, so the track spans the column
   * instead of stranding a block of empty rail under a stubby 190px graph.
   * The stretch rules live with the side-mode block further down -- they have
   * to out-specify the side-mode 'flex: none' on .hu-stack children.
   * NB no backticks in STYLE comments: the whole sheet is a template literal. */
  .hu-tlv-body { display: flex; gap: 9px; }
  .hu-tlv-track { position: relative; flex: none; width: 16px; height: 100%; border-radius: 3px;
                  background: var(--divider-color, rgba(127,127,127,.2)); }
  .hu-tlv-win { position: absolute; left: 0; width: 100%; border-radius: 3px; background: var(--primary-text-color); }
  .hu-tlv-home { position: absolute; left: 50%; width: 18px; height: 18px; transform: translate(-50%, -50%); }
  .hu-tlv-home svg { width: 100%; height: 100%; display: block; }
  .hu-tlv-home path { fill: #fff; stroke: rgba(0,0,0,.55); stroke-width: 1.5; paint-order: stroke; }
  .hu-tlv-labels { position: relative; flex: 1 1 auto; min-width: 0; }
  .hu-tlv-tick { position: absolute; left: -7px; width: 5px; height: 1px;
                 background: var(--secondary-text-color); opacity: .5; }
  .hu-tlv-time { position: absolute; left: 3px; white-space: nowrap; font: 400 11px/1 sans-serif; color: var(--secondary-text-color); }
  .hu-tlv-tag { position: absolute; left: 3px; white-space: nowrap; font: 600 11px/1 sans-serif; color: var(--secondary-text-color); }
  .hu-msg { padding: 28px 18px; text-align: center; color: var(--secondary-text-color); }
  .hu-msg .hu-msg-icon { --mdc-icon-size: 40px; color: var(--secondary-text-color); opacity: .7; }
  .hu-msg .hu-msg-icon.hu-spin { animation: hu-spin 1.4s linear infinite; transform-origin: center; }
  @keyframes hu-spin { to { transform: rotate(360deg); } }
  .hu-msg .hu-msg-title { font-size: 18px; font-weight: 700; color: var(--primary-text-color); margin-top: 8px; }
  .hu-msg .hu-msg-sub { font-size: 14px; margin-top: 4px; }
  .hu-stale { font-size: 12px; color: var(--warning-color, #d68b00); padding: 0 14px 10px; }

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
    this._layerPrefs = loadLayerPrefs(); this._panelOpen = false; this._panelScroll = 0;
    this._advOpen = false; this._advTitle = ""; this._advBody = ""; this._layerCache = {};
    this._layerBusy = {};   // in-flight layer fetches, keyed like _layerCache
    // Layout POSITION prefs (v0.2.6 Phase 2): per-device, own store, never
    // synced. Kept separate from _layerPrefs on purpose -- see LAYOUT_STORE_KEY.
    this._layoutPrefs = loadLayoutPrefs();
    // Pass 3 dynamic layout. Fill-height is still MEASURED (it detects a height
    // the dashboard imposed, which is a fact about the box, not a preference).
    // Placement is NOT measured -- as of v0.2.6 Phase 2/3 each block carries the
    // viewer's explicit Bottom/Off/Side choice.
    // _pos = the RESOLVED position (what _layoutCheck decided AFTER the physical
    // gates), NOT the raw preference. Starts at bottom because honoring "side"
    // needs a measurement we haven't taken yet. Visibility needs no measurement
    // and is read straight from prefs at render time.
    // _boxW is the last measured card width; _present is which rail items the
    // last render actually emitted. Together they decide the bottom-rail tier
    // (see _railTier) -- width is a measurement, presence is data, and neither
    // is a cached LAYOUT metric, so the _stackHb hazard doesn't apply.
    this._fillMode = false;
    this._pos = "bottom";
    this._boxW = 0;
    this._present = { bar: false, tl: false, pager: false };
    this._sideOn = false;   // set during _render; drives the .hu-side class
    this._hadData = false;   // arms the first-data re-solve (see _render)
    this._layoutRaf = 0; this._inLayout = false;
    this._deferT = 0; this._deferN = 0;   // zero-rect retry (see _deferLayout)
  }

  setConfig(config) { this._config = config || {}; if (this.shadowRoot) this._render(); }
  getCardSize() { return 6; }
  /* Sections-grid sizing (HA 2024.11+), from the documented cell metrics: a
   * row is 56px + 8px gap, a section is 12 columns (~400px wide standard).
   * rows: 10 (632px) runs TALLER than the classic 4:3-map look (8 rows would
   * reproduce it) on purpose: storm tracks mostly run north-south, so the
   * extra height goes straight into cone/track visibility via the fill-mode
   * letterbox reveal (Aaron, judged on glass 2026-07-18). Users drag-resize
   * from there and fill-height tracks whatever they set. min_columns 6
   * (~200px): the map is unusable narrower. min_rows 4 (248px): can't be
   * crushed to a sliver. Masonry ignores this and uses getCardSize. */
  getGridOptions() { return { columns: 12, rows: 10, min_columns: 6, min_rows: 4 }; }
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
    // Pass 3: one ResizeObserver drives the whole dynamic layout. Fill-height
    // latches only until detach: a fresh attach (moving the card between
    // views/dashboards recreates or reattaches it) re-detects from scratch.
    // Phase 3: reset the resolved position and the measured width the same way.
    // Both start at their un-measured defaults; _layoutCheck re-derives them for
    // the new box. Nothing measured survives a reattach BY DESIGN -- that was
    // Phase 1's _stackHb bug, a metric from the old box reused in the new one.
    // Do not cache anything here. (Visibility needs no reset: it is read from
    // prefs at render time, not held as layout state.)
    this._fillMode = false;
    this._pos = "bottom";
    this._boxW = 0;
    this._sideOn = false;
    // _hadData re-arms the first-data re-solve (see the end of _render).
    this._hadData = false;
    if (!this._ro) {
      this._ro = new ResizeObserver(() => {
        if (this._layoutRaf) return;   // rAF-debounce the resize storm of a drag
        this._layoutRaf = requestAnimationFrame(() => { this._layoutRaf = 0; this._layoutCheck(); });
      });
      this._ro.observe(this);
    }
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
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._layoutRaf) { cancelAnimationFrame(this._layoutRaf); this._layoutRaf = 0; }
    if (this._deferT) { clearTimeout(this._deferT); this._deferT = 0; }
    if (this._docClose) { document.removeEventListener("click", this._docClose, true); this._docClose = null; }
    if (this._prefsUnsub) { this._prefsUnsub(); this._prefsUnsub = null; }
    this._prefsSubStarted = false;
  }

  /* Cross-device layer-pref sync. The toggles live in Home Assistant's per-user
   * data store (frontend/*_user_data), so the same login on a phone and a wall
   * dashboard share one set of toggles, and the subscription pushes a change on
   * one device to the others LIVE. localStorage stays as the instant first-paint
   * source and an offline fallback; the server value wins once it arrives. */
  _initPrefsSync() {
    if (this._prefsSubStarted || !this._hass || !this._hass.connection) return;
    this._prefsSubStarted = true;
    try {
      this._hass.connection.subscribeMessage(
        (msg) => this._onServerPrefs(msg && msg.value),
        { type: "frontend/subscribe_user_data", key: LAYER_STORE_KEY }
      ).then((unsub) => { this._prefsUnsub = unsub; })
       .catch(() => { this._prefsSubStarted = false; });   // WS unsupported -> local-only
    } catch (_) { this._prefsSubStarted = false; }
  }
  _onServerPrefs(value) {
    if (value && typeof value === "object" && Object.keys(value).length) {
      const norm = migratePrefs(value);
      this._serverPrefsSeen = true;
      // Adopt only on a real change (the echo of our own set_user_data matches
      // and is ignored, so there's no render loop).
      if (JSON.stringify(norm) !== JSON.stringify(this._layerPrefs)) {
        this._layerPrefs = norm;
        saveLayerPrefs(norm);           // keep the offline fallback current
        this._render();
      }
    } else if (!this._serverPrefsSeen) {
      // No server value yet -> seed it once from the current (localStorage) prefs.
      this._serverPrefsSeen = true;
      this._pushPrefs();
    }
  }
  _pushPrefs() {
    if (!this._hass || !this._layerPrefs) return;
    try {
      this._hass.callWS({ type: "frontend/set_user_data",
        key: LAYER_STORE_KEY, value: this._layerPrefs }).catch(() => {});
    } catch (_) {}
  }

  _fetch() {
    if (!this._hass) return;
    this._initPrefsSync();
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
    this._pushPrefs();   // sync to the user's other devices
    if (key === "stripe" && v === "right")
      for (const k of Object.keys(this._layerCache))
        if (k.startsWith("surge|") && this._layerCache[k].failed) delete this._layerCache[k];
    this._render();
  }

  /* v0.2.6 layout controls. Deliberately NOT _applyTri: these write the
   * per-device store and do NOT call _pushPrefs, so the choice never follows the
   * user to a differently-shaped screen. _render's tail re-solves the layout, so
   * no explicit _layoutCheck() in either.
   * Position: ONE lever moving both blocks together. */
  _applyLayoutPos(v) {
    if (LAYOUT_POS.indexOf(v) < 0) return;
    this._layoutPrefs = this._layoutPrefs || {};
    this._layoutPrefs.pos = v;
    saveLayoutPrefs(this._layoutPrefs);
    // "bottom" needs no measurement, so paint it in this frame. "side" holds the
    // current position until _layoutCheck confirms the physical gates -- the
    // same one-frame settle Phase 2 shipped with.
    if (v === "bottom") this._pos = "bottom";
    this._render();
  }

  /* How the BOTTOM rail arranges its two flow items, given the measured card
   * width. The pager is not considered here -- it is pinned to the card corner
   * and only reserves width. Two tiers:
   *   "row"   -- ONE line: [storm data] [graph, absorbing the slack]
   *   "stack" -- graph full width on top, storm data under it
   * Graph-on-top when stacked is deliberate (Aaron, on glass 2026-07-19): a
   * narrow card can't give the graph a useful share of a shared line, and a
   * full-width time axis is worth more up against the map than a half-width one.
   * The side rail always stacks, data first -- it is a column, not a line.
   * Pure width arithmetic against the item floors; no DOM measurement. */
  _railTier(w, p) {
    if (this._pos === "side") return "stack";
    if (!p.bar || !p.tl) return "stack";   // nothing to arrange with one item
    const need = PACK_MIN_W_BAR + PACK_MIN_W_TL + PACK_GAP
      + (p.pager ? PAGER_RESERVE : 0);
    return w >= need ? "row" : "stack";
  }

  /* Visibility: per block, and never a measurement -- apply and paint at once. */
  _applyLayoutVis(key, on) {
    if (!key) return;
    this._layoutPrefs = this._layoutPrefs || {};
    this._layoutPrefs[key] = !!on;
    saveLayoutPrefs(this._layoutPrefs);
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
    // Cleared up front so the message states (Loading / All clear / outage) can
    // never inherit a stale side-rail or pager class from the storm render
    // before them. The storm branch below sets both for real.
    this._sideOn = false;
    this._present = { bar: false, tl: false, pager: false };

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
      // Title chunks ride the same keep-together rule as the data bar: the
      // side column stacks type / basin as whole lines (separator hidden).
      // v0.2.6 Phase 2: with the info bar Off the header is the only thing left
      // identifying the storm, and type + basin alone doesn't say WHICH storm.
      // Append the name in that case only -- with the bar on it would duplicate
      // the bar's title. A card-config `title` is the dashboard owner's explicit
      // override and is left exactly as they wrote it.
      const barOn = layoutOn(this._layoutPrefs, "barOn");
      const tlOn = layoutOn(this._layoutPrefs, "tlOn");
      const nameChunk = !barOn
        ? `<span class="hu-sep"> · </span><span class="hu-chunk">${esc(stormName(st))}</span>` : "";
      const tagHtml = cfg.title != null ? esc(cfg.title)
        : `<span class="hu-chunk">${esc((st.meta && st.meta.type) || "Storm")}</span><span class="hu-sep"> \u00b7 </span><span class="hu-chunk">${esc((st.meta && st.meta.basinName) || "")}</span>${nameChunk}`;
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
      // E5 on-demand layer on the same cache/fetch path: storm surge draws
      // when the coastal-stripe tri sits RIGHT. NHC-only.
      const lay = { surge: null };
      if (nhcSt && triState(prefs, "stripe") === "right")
        lay.surge = this._layerState("surge", st);
      let svg = "", popImpact = null;
      this._labelCtx = null;   // E6: engine context, set only on a successful build
      this._scaleEmit = null;  // mileage-axis emitter, ditto (re-run per layout pass)
      try {
        const built = buildConeSvg(st, cfg, modelState, prefs, lay);
        svg = built.svg;
        this._labelCtx = built.ctx;
        this._scaleEmit = built.scaleEmit;
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
      // v0.2.6 Phase 2/3: card-SHAPE controls sit above the map-CONTENT sliders.
      // Same segmented look as the tri groups, deliberately different wiring:
      // data-lay (not data-tri) routes the click to the per-device layout store
      // instead of the synced prefs blob. NEITHER block has a card-config master
      // -- Phase 3 deleted show_timeline outright. Aaron's call: the card should
      // behave consistently, one lever per thing, and both are viewer choices.
      // ONE position control for both blocks, then a plain on/off switch each.
      // The segments read the raw PREFERENCE (not the resolved position) so the
      // panel shows what the user asked for even when a gate downgraded it; the
      // note explains the downgrade. Switches reuse the .hu-sw row markup from
      // the layer toggles but carry data-layvis, keeping them off both the
      // synced-prefs path and the lazy-fetch path.
      {
        const cur = layoutPos(this._layoutPrefs);
        const seg = (set, lbl) =>
          `<button class="hu-seg-btn${cur === set ? " hu-sel" : ""}" data-lay="pos" data-set="${set}">${esc(lbl)}</button>`;
        panelRows += `<div class="hu-panel-group">Info bar</div>
          <div class="hu-seg" role="group" aria-label="Info bar position">
            ${seg("bottom", "Bottom")}${seg("side", "Side")}
          </div>`;
        for (const b of LAYOUT_BLOCKS)
          panelRows += `<label class="hu-panel-row"><span class="hu-row-lbl">${esc(b.title)}</span><input type="checkbox" class="hu-sw" data-layvis="${b.key}" ${layoutOn(this._layoutPrefs, b.key) ? "checked" : ""}/></label>`;
        panelRows += `<div class="hu-lay-note">Side needs a wide card with a set height — otherwise it falls back to Bottom. The at-home graph only appears when a storm is forecast to reach your home. Saved on this device only.</div>`;
      }
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
      // Place dots: two INDEPENDENT toggles (Cities + Population can both be on),
      // client-only re-renders -> a distinct data-dot attr keeps them off the
      // lazy-fetch path the OPTIONAL_LAYERS checkboxes use below.
      {
        const dna = cfg.show_cities === false;
        const dotRow = (id, lbl, on) =>
          `<label class="hu-panel-row${dna ? " hu-na" : ""}"><span class="hu-row-lbl">${esc(lbl)}</span><input type="checkbox" class="hu-sw" data-dot="${id}" ${on && !dna ? "checked" : ""}${dna ? " disabled" : ""}/></label>`;
        panelRows += `<div class="hu-panel-group">Place dots</div>`
          + dotRow("cities", "Cities", prefs.dotsCities !== false)
          + dotRow("population", "Population", prefs.dotsPop === true);
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
      // v0.2.6 Phase 3: build the two placeable blocks once, then DISTRIBUTE
      // them into the bottom rail and/or the side rail per the positions
      // _layoutCheck resolved. Grid classes do the placing -- the only DOM
      // surgery is which container each block is written into. The advisory
      // overlay stays outside both (absolute over the whole card).
      // NB "present" means non-empty HTML, not merely "switched on": the graph
      // self-hides when no storm is forecast to bring wind to the user's home,
      // and an empty side rail must not be emitted (it would eat 240px of map).
      const side = this._pos === "side";
      const barHtml = barOn ? `<div class="hu-bar">${dataBar(st, lay, popImpact)}</div>` : "";
      const tlHtml = tlOn ? exposureTimeline(st, side) : "";
      this._sideOn = !!(side && (barHtml || tlHtml));
      // Record what is actually on screen so _layoutCheck can re-run the same
      // tier arithmetic on resize without re-deriving the storm's data.
      this._present = { bar: !!barHtml, tl: !!tlHtml, pager: !!pager };
      const tier = this._railTier(this._boxW, this._present);
      // Order: shared line reads [data][graph]; stacked BOTTOM puts the graph on
      // top (full-width time axis against the map); the side column keeps data
      // first, since a column reads top-down as identity-then-detail.
      let inner;
      if (tier === "row") inner = `<div class="hu-packrow">${barHtml}${tlHtml}</div>`;
      else if (side) inner = barHtml + tlHtml;
      else inner = tlHtml + barHtml;
      // The staleness note always closes the rail on its own line -- it is a
      // warning, and inlining it would bury it.
      const railHtml = this._sideOn ? `<div class="hu-stack hu-rail">${inner}${stale}</div>` : "";
      const botHtml = this._sideOn ? "" : `<div class="hu-stack hu-bot">${inner}${stale}</div>`;
      // Pager sits OUTSIDE both rails, as a direct child of the wrap it is
      // positioned against -- that is what pins it to one spot on the card
      // regardless of which rail is showing.
      body = `<div class="hu-tag">${tagHtml}</div>
        <div class="hu-conewrap">${svg}${tools}</div>
        ${railHtml}${botHtml}${pager}${adv}`;
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
    // Pass 3: emit the current layout-mode classes inline so a background
    // re-render paints straight into the active layout (no one-frame snap).
    const wrapCls = "hu-wrap" + (this._fillMode ? " hu-fill" : "")
      + (this._sideOn ? " hu-side" : "")
      + (this._present.pager ? " hu-haspager" : "");
    // The gear panel is a SCROLL container, and every toggle inside it triggers a
    // full re-render -- the innerHTML swap below destroys the element, so its
    // scrollTop reset to 0 and yanked the user back to the top mid-change (Aaron,
    // 2026-07-19). Carry the offset across the rebuild. Reading it HERE, in
    // _render, rather than in the individual toggle handlers is deliberate: every
    // path that rebuilds the DOM goes through this one line, so no handler can be
    // added later that forgets to do it. The `else` clears the memory whenever a
    // render happens with the panel shut, which likewise catches EVERY close path
    // (gear click, outside click, storm switch) without touching any of them --
    // so re-opening the gear always starts at the top, as expected.
    if (this._panelOpen) {
      const pOld = this.shadowRoot.querySelector(".hu-panel");
      if (pOld) this._panelScroll = pOld.scrollTop;
    } else this._panelScroll = 0;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card><div class="${wrapCls}" style="${this._styleVars()}">${body}</div></ha-card>`;
    // Put the panel back where it was. Synchronous first -- the new DOM is parsed
    // by now, so this usually lands. Then re-asserted once on the next frame: the
    // browser CLAMPS scrollTop to the scrollHeight it knows at assignment time,
    // and late layout (ha-icon upgrading, fonts settling) can grow the panel after
    // this tick, which would silently leave the restore short.
    if (this._panelOpen && this._panelScroll > 0) {
      const want = this._panelScroll;
      const pNew = this.shadowRoot.querySelector(".hu-panel");
      if (pNew) {
        pNew.scrollTop = want;
        requestAnimationFrame(() => {
          const p2 = this.shadowRoot && this.shadowRoot.querySelector(".hu-panel");
          if (p2 && this._panelOpen && Math.abs(p2.scrollTop - want) > 1) p2.scrollTop = want;
        });
      }
    }
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
        this._pushPrefs();   // sync to the user's other devices
        if (id === "advisory" && !el.checked) this._advOpen = false;
        // Re-toggling a fetching layer clears cached failures -> fresh retry.
        if (id === "models" && el.checked)
          for (const k of Object.keys(this._layerCache))
            if (k.startsWith(id + "|") && this._layerCache[k].failed) delete this._layerCache[k];
        this._render();
      }));
    // Place-dot toggles (Cities / Population): client-only re-render, no fetch.
    this.shadowRoot.querySelectorAll("input[data-dot]").forEach((el) =>
      el.addEventListener("change", () => {
        const key = el.getAttribute("data-dot") === "cities" ? "dotsCities" : "dotsPop";
        this._layerPrefs = this._layerPrefs || {};
        this._layerPrefs[key] = el.checked;
        saveLayerPrefs(this._layerPrefs);
        this._pushPrefs();   // sync to the user's other devices
        this._render();
      }));
    // E5 tri-group segmented buttons (Material 3 pattern: one segment per
    // state, selected segment filled -- "Off" is its own labeled segment).
    this.shadowRoot.querySelectorAll(".hu-seg-btn").forEach((el) =>
      el.addEventListener("click", () => {
        // Two kinds of segmented control share this look and class: layout
        // POSITION (data-lay -> per-device store) and the tri groups (data-tri
        // -> synced prefs). The attribute decides which store the click lands in.
        const set = el.getAttribute("data-set");
        const lay = el.getAttribute("data-lay");
        if (lay) this._applyLayoutPos(set);
        else this._applyTri(el.getAttribute("data-tri"), set);
      }));
    // Block VISIBILITY switches (per-device store, never synced). Distinct attr
    // from data-layer so they don't touch the lazy-fetch/sync path.
    this.shadowRoot.querySelectorAll("input[data-layvis]").forEach((el) =>
      el.addEventListener("change", () =>
        this._applyLayoutVis(el.getAttribute("data-layvis"), el.checked)));
    const doc = this.shadowRoot.querySelector(".hu-doc");
    doc && doc.addEventListener("click", () => this._openAdvisory());
    const closeBtn = this.shadowRoot.querySelector(".hu-adv-close");
    closeBtn && closeBtn.addEventListener("click", () => { this._advOpen = false; this._render(); });

    // Swatchless note fixup ("No coastal warnings in effect" / "No current
    // storm surge data"): the backing rect's width at build time is only a char-count
    // estimate. Once the text has actually PAINTED (rAF, not synchronously --
    // measuring right after innerHTML can catch pre-layout/pre-font metrics and
    // size the box wrong), fit the rect to the text's real bbox + padding. Re-run
    // once web fonts finish loading (font swap changes the metrics). A zero/NaN
    // measurement (e.g. hidden tab) leaves the estimated box alone.
    {
      const fit = () => {
        const nts = this.shadowRoot ? this.shadowRoot.querySelectorAll("text.hu-note-t") : [];
        const nb = this.shadowRoot && this.shadowRoot.querySelector("rect.hu-note-bg");
        if (!nts.length || !nb) return;
        try {
          // Notes can STACK (e.g. "No coastal warnings in effect" over "No
          // current wind field data" over "No swath data available"): fit the
          // shared rect to the UNION of every note's measured bbox — right edges
          // align (text-anchor end), the widest note sets the left edge.
          let left = Infinity, right = -Infinity;
          nts.forEach((nt) => {
            const bx = nt.getBBox();
            if (bx && bx.width > 0) {
              left = Math.min(left, bx.x);
              right = Math.max(right, bx.x + bx.width);
            }
          });
          if (!(right > left)) return;   // zero-width measures (hidden tab) leave the estimate
          const padX = 8;
          nb.setAttribute("x", (left - padX).toFixed(1));
          nb.setAttribute("width", (right - left + padX * 2).toFixed(1));
        } catch (_) {}
      };
      requestAnimationFrame(fit);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fit());
    }

    // Model-legend width fixup. Same problem, mirrored geometry: those rows are
    // LEFT-anchored behind swatches, so the box's left padding is exact and it is
    // the RIGHT edge that rides on the char-count estimate. Measure the painted
    // text and set the width so both sides get the same padX. Runs on rAF and
    // again once fonts settle, exactly like the note fit; a zero-width measure
    // (hidden tab) leaves the estimated box alone.
    {
      const fitMl = () => {
        const ts = this.shadowRoot ? this.shadowRoot.querySelectorAll("text.hu-ml-t") : [];
        const bg = this.shadowRoot && this.shadowRoot.querySelector("rect.hu-ml-bg");
        if (!ts.length || !bg) return;
        try {
          let right = -Infinity;
          ts.forEach((t) => {
            const bx = t.getBBox();
            if (bx && bx.width > 0) right = Math.max(right, bx.x + bx.width);
          });
          if (!(right > -Infinity)) return;
          const padX = 8;
          const x0 = parseFloat(bg.getAttribute("x")) || 0;
          bg.setAttribute("width", Math.max(0, right - x0 + padX).toFixed(1));
        } catch (_) {}
      };
      requestAnimationFrame(fitMl);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitMl());
    }

    // Rebuild attaches a fresh gesture layer. Whether it starts at the default
    // frame or restores the user's zoom/pan is decided in _setupPanZoom: a storm
    // switch or a storm-identity change resets; a background poll of the SAME storm
    // preserves the view so it doesn't snap out from under the user mid-read.
    this._setupPanZoom();
    // Pass 3: re-derive the dynamic layout for the fresh DOM. Runs AFTER the
    // gesture layer on purpose: a mode flip re-renders, and that inner render
    // replaces this DOM wholesale (listeners and all) -- so there are never
    // two gesture layers wired to one svg.
    this._layoutCheck();
    // FIRST DATA RENDER: the synchronous pass above runs in the same task as the
    // innerHTML write, so it can measure pre-layout / pre-font metrics. Fill
    // detection compares the host box against the wrap's NATURAL height, and a
    // pre-font wrap measures short -- read it once at the wrong moment and the
    // card can miss fill mode, or latch it, for the rest of the session. So
    // re-solve after layout settles, and again after web fonts swap (text
    // metrics move the wrap height). NB side-vs-bottom used to be the bigger
    // hazard here (a cached _stackHb estimate taken on this very pass); v0.2.6
    // Phase 2 made placement an explicit preference, so fill is now the only
    // thing this pass measures.
    // Gate on the MAP being present: the "Loading" / no-data states render a
    // message with no .hu-conewrap, and _layoutCheck bails on those. Arming
    // there would spend the one re-solve on a state that never needed it and
    // leave the real first data render unprotected.
    if (!this._hadData && this.shadowRoot && this.shadowRoot.querySelector(".hu-conewrap")) {
      this._hadData = true;
      requestAnimationFrame(() => this._layoutCheck());
      if (document.fonts && document.fonts.ready)
        document.fonts.ready.then(() => this._layoutCheck());
    }
  }

  /* ---- Pass 3: dynamic layout (fill-height + auto bar placement) ------------
   * No config, no settings -- measurements decide.
   * FILL: the dashboard imposed a height when the host's box stops tracking the
   * content's natural height (sections drag-resize, panel view, the default
   * getGridOptions rows). Detected by comparing host vs wrap height in normal
   * flow; once seen, fill latches until the element re-attaches (a fresh attach
   * re-detects from scratch -- see connectedCallback).
   * SIDE: as of v0.2.6 Phase 2 this is the VIEWER'S choice (gear panel ->
   * Bottom/Off/Side per block, stored per device), not a measurement. The old
   * meet-scale comparison, its 8% hysteresis and the cached _stackHb estimate
   * are gone. Two states only: below (default) or right column. No left, no
   * top, and no Auto -- settled with Aaron: we can't anticipate every
   * dashboard's layout, so the user gets the wheel.
   * Phase 3 keeps position a SINGLE lever for both blocks (splitting it produced
   * combinations nobody wanted -- Aaron, on glass 2026-07-19); what this pass
   * adds is the one automatic thing left: how a bottom-rail PAIR arranges
   * itself. Per-block on/off is not resolved here -- it needs no measurement. */
  _layoutCheck() {
    if (this._inLayout) return;   // the flip re-render re-enters; state is already final
    const wrap = this.shadowRoot && this.shadowRoot.querySelector(".hu-wrap");
    const cone = wrap && wrap.querySelector(".hu-conewrap");
    if (!wrap || !cone) return;   // message states keep the plain layout
    const host = this.getBoundingClientRect();
    if (!host.width || !host.height) return;   // hidden tab -> keep current mode
    // HARDENING: getBoundingClientRect reports the TRANSFORMED box. An ancestor
    // mid-animation (swipe-card slide, animated-dashboard flip) therefore hands
    // us scaled/rotated dimensions that have nothing to do with the real layout
    // box, and the solver latches the garbage -- observed live: a 948x685 card
    // measured 299x1405. offsetWidth/offsetHeight are border-box reads and are
    // transform-independent, so a disagreement between the two IS the signal
    // that a transform is active. Skip the pass and retry once it settles.
    if (Math.abs(host.width - this.offsetWidth) > 2
        || Math.abs(host.height - this.offsetHeight) > 2) { this._deferLayout(); return; }
    let fill = this._fillMode;
    if (!fill) {
      const wh = wrap.getBoundingClientRect().height;
      if (!wh) { this._deferLayout(); return; }   // fresh shadow DOM, not laid out yet
      fill = Math.abs(host.height - wh) > 8;
    }
    // v0.2.6 Phase 2/3: placement is the viewer's call, so there is nothing to
    // solve here -- just two physical gates on honoring a "Side" preference:
    //   fill      -- a content-height card has no spare vertical room to trade
    //                for a rail; the blocks sit under the map as they always did.
    //   SIDE_MIN_W -- a 240px column beside a narrower card leaves an unreadable
    //                map. This fallback is silent, hence the panel's note.
    // Both are facts about the box, not preferences. Nothing is cached, so
    // nothing can go stale -- the whole _stackHb feedback problem is gone.
    const canSide = fill && host.width >= SIDE_MIN_W;
    const want = layoutPos(this._layoutPrefs);
    const pos = want === "side" && !canSide ? "bottom" : want;
    // BOTTOM-RAIL PACKING (Phase 3) -- the one automatic behavior in this layout.
    // Re-run the same tier arithmetic _render used, against the fresh width and
    // the item presence that render recorded, and re-render if the answer moved.
    // Presence is data (which blocks are on, whether the graph self-hid, whether
    // there is more than one storm) and does not change with the box, so reusing
    // it here is safe -- it is not a cached LAYOUT metric.
    const prevPos = this._pos;
    this._pos = pos;   // _railTier reads it for the side-rail short-circuit
    const tier = this._railTier(host.width, this._present);
    const wasTier = this._railTier(this._boxW, this._present);
    // Compare against the RENDERED state (_pos/_boxW are what _render last drew)
    // rather than a separate cached signature -- one source of truth, and a
    // position already painted by _applyLayoutPos costs no second render.
    const flip = pos !== prevPos || tier !== wasTier;
    this._fillMode = fill; this._boxW = host.width;
    wrap.classList.toggle("hu-fill", fill);
    // PAGER PLACEMENT. The pager centres vertically on the BOTTOM bar, and that
    // same offset is then held in side mode so switching Bottom/Side never moves
    // it (Aaron, 2026-07-19). Only the bottom bar has a height to centre in, so
    // measure it while it is on screen and keep the number.
    // This IS a value carried across modes, which is the shape of the _stackHb
    // bug -- so note the difference: _stackHb was a stale estimate the solver FED
    // BACK IN to pick a mode, so a wrong read locked in a wrong layout forever.
    // This decides nothing; it only positions one absolute element, is re-taken
    // every pass the bottom bar is visible, and a bad read is a few px of offset
    // that the next bottom-mode pass corrects. Never let it gate a mode choice.
    const bot = wrap.querySelector(".hu-bot");
    const barH = bot ? bot.offsetHeight : 0;
    if (barH > 0) {
      const off = Math.max(PAGER_INSET, Math.round((barH - PAGER_H) / 2));
      this.style.setProperty("--hu-pager-b", off + "px");
      // The side column must clear whatever offset the bottom bar produced, or
      // the stretched vertical graph runs its labels under the buttons.
      this.style.setProperty("--hu-pager-clear", (off + PAGER_H + PAGER_INSET) + "px");
    }
    if (flip) {
      // The timeline emits a different variant per mode -- rebuild the DOM.
      this._inLayout = true;
      try { this._render(); } finally { this._inLayout = false; }
    }
    this._fitOverlays();
  }

  /* Pass 3: anchor screen-space furniture (legends, mileage axes, the edge-
   * clamped home marker) to the VISIBLE edges. In fill mode the 800x600 frame
   * centers in a wider/taller element (letterbox), so furniture placed at
   * frame edges floats mid-card. Each cluster carries data-anch letters
   * (l/r/t/b); slide it by the letterbox slack in user units on its anchored
   * axes. Normal mode: slack 0 -> a no-op transform. Idempotent, cheap, runs
   * on every layout pass (the RO path included -- no DOM rebuild needed). */
  _fitOverlays() {
    const svg = this.shadowRoot && this.shadowRoot.querySelector(".hu-svg");
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) { this._deferLayout(); return; }   // not laid out yet -> retry deferred
    this._deferN = 0;   // real measurement -> reset the retry budget
    const s = Math.min(r.width / VBW, r.height / VBH) || 1;
    const oxU = Math.max(0, r.width / s - VBW) / 2;
    const oyU = Math.max(0, r.height / s - VBH) / 2;
    /* Mileage axes re-emit against the REAL visible frame: ticks span the full
     * letterbox width and collide with furniture at its post-slide positions
     * (a build-time layout got both wrong in fill mode -- the phantom
     * mid-bottom gaps of 2026-07-19). Swap-in-place before the anchor pass
     * below so the fresh groups pick up their edge translate like everyone
     * else. Idempotent: same slack -> same markup. */
    if (this._scaleEmit) {
      const ov = svg.querySelector(".hu-overlays");
      if (ov) {
        ov.querySelectorAll("g.hu-scax").forEach((g) => g.remove());
        const fresh = this._scaleEmit(oxU, oyU).join("");
        // afterbegin: first in the overlay group = painted UNDER the legends,
        // home marker and every other overlay. Mileage always loses.
        if (fresh) ov.insertAdjacentHTML("afterbegin", fresh);
      }
    }
    svg.querySelectorAll("g.hu-anch").forEach((g) => {
      const a = g.getAttribute("data-anch") || "";
      const dx = a.includes("l") ? -oxU : a.includes("r") ? oxU : 0;
      const dy = a.includes("t") ? -oyU : a.includes("b") ? oyU : 0;
      g.setAttribute("transform", `translate(${dx.toFixed(1)} ${dy.toFixed(1)})`);
    });
  }

  /* Freshly written shadow-DOM content can measure 0x0 in the SAME task as the
   * innerHTML write -- proven live 2026-07-18: the post-render fit read a
   * 0-rect svg and bailed, so the edge anchors never applied (the floating
   * legend/mileage-axis bug); the first fill detection can hit the same hazard
   * on the wrap. Retry after layout settles: rAF for visible tabs, plus a
   * timeout fallback because rAF is throttled to never in hidden tabs.
   * Idempotent, budget-capped (a hidden tab gives up; the next render or
   * resize restarts the cycle naturally). */
  _deferLayout() {
    if (this._deferT) return;
    this._deferN = (this._deferN || 0) + 1;
    if (this._deferN > 10) return;
    const go = () => {
      if (!this._deferT) return;
      clearTimeout(this._deferT); this._deferT = 0;
      this._layoutCheck();
    };
    this._deferT = setTimeout(go, 50);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
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
      Math.max(0, (s - 1) * VBW / 2 + marginX * s),
      Math.max(0, (s - 1) * VBH / 2 + marginY * s),
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

    // Meet geometry: in fill mode (Pass 3) the svg element can be taller or
    // wider than the 800x600 frame's aspect; preserveAspectRatio "meet" centers
    // the frame with letterbox slack on one axis. All pointer math converts
    // through the REAL rendered scale + offsets so pan/zoom stays cursor-
    // accurate in every mode. Normal mode (height:auto) degenerates to the old
    // math exactly: offsets 0, s = width/VBW.
    const geom = () => {
      const r = svg.getBoundingClientRect();
      const s = Math.min(r.width / VBW, r.height / VBH) || 1;
      return { r, s, ox: (r.width - VBW * s) / 2, oy: (r.height - VBH * s) / 2 };
    };
    // px per SVG user-unit at the current rendered size
    const scaleFactor = () => 1 / geom().s;   // client px -> user units
    // client coords -> SVG user coords (pre-transform frame)
    const toUser = (clientX, clientY) => {
      const g = geom();
      return [(clientX - g.r.left - g.ox) / g.s, (clientY - g.r.top - g.oy) / g.s];
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
  // When the change originated HERE, HA echoes it straight back through
  // setConfig -- rebuilding the DOM then would destroy the very input the user
  // is on (the native color picker closes mid-drag, the title field drops focus
  // per keystroke). Self-echoes update state only; render is skipped.
  setConfig(config) {
    this._config = { ...config };
    if (this._selfEmit) { this._selfEmit = false; return; }
    this._render();
  }
  set hass(h) { this._hass = h; }

  _emit() {
    this._selfEmit = true;
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
