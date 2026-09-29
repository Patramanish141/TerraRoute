// "Field engineer" siting checklist: every candidate route is checked against these named
// boundary conditions and annotated with which it meets / violates.
//
// HARD constraints must never be violated (a violating route ranks below every compliant one).
// SOFT constraints are preferences; each violation adds a ranking penalty (see planner.js).
const astar = require("../core/astar");
const td = require("../layers/terrainData");
const geo = require("../core/geometry");
const { ROW_WIDTH_M } = require("./costModel");
const { grid } = astar;

// =============================================================================================
// CONSTRAINT THRESHOLDS
// =============================================================================================

// ---- HARD ------------------------------------------------------------------------------------
// H1: centreline may not pass through any building footprint (the grid also blocks a 10 m buffer).
// H2: no religious site (place of worship, wayside shrine, burial ground) inside the right-of-way:
//     centreline must stay at least ROW/2 from the site footprint.
const RELIGIOUS_HARD_CLEARANCE_M = ROW_WIDTH_M / 2;
// H3: "no wide water without a bridge" — every crossing must be bridgeable within project scope.
//     Longer than this would be a mega-structure outside a state-highway budget.
const MAX_SINGLE_BRIDGE_LENGTH_M = 500;

// ---- SOFT ------------------------------------------------------------------------------------
// S1: ground gradient (DEM, smoothed) may exceed the IRC:73 *exceptional* gradient for plain /
//     rolling terrain (6.7%) for no more than this continuous length — beyond that, heavy cutting
//     or a switchback would be needed.
const MAX_GROUND_GRADE_PCT = 6.7;
const MAX_STEEP_STRETCH_M = 150;
// S2: buffer zone — keep clear of religious sites even when not encroaching (noise, access,
//     festival crowds).
const RELIGIOUS_BUFFER_ZONE_M = 50;
// S3: buildings inside the ROW must be demolished / compensated (R&R).
const MAX_BUILDINGS_IN_ROW = 0;
// S4: forest crossing as a share of route length (forest clearance / NPV burden).
const MAX_FOREST_SHARE_PCT = 15;
// S5: floodplain avoidance. A cell counts as floodplain when it is within
//     FLOODPLAIN_MAX_DISTANCE_M of a river and less than FLOODPLAIN_MAX_HEIGHT_M above it
//     (Height Above Nearest Drainage from SRTM — coarse, ±several m).
const FLOODPLAIN_MAX_DISTANCE_M = 300;
const FLOODPLAIN_MAX_HEIGHT_M = 3;
const MAX_FLOODPLAIN_SHARE_PCT = 10;
// S6: minimum horizontal curve radius. IRC:73: R = V² / (127 (e + f)); design speed 65 km/h
//     (rolling terrain minimum), max superelevation 7%, side friction 0.15 → ~151 m.
//     The 8-connected grid path is first simplified (Douglas–Peucker) with a tolerance of one
//     grid cell: a cell-centre path only locates the alignment to about ±1 cell, and its
//     staircase steps (a 42 m diagonal between long straights) are quantization, not bends.
//     At each remaining bend, the largest circular curve whose tangents fit on the adjacent
//     straights is checked against the minimum radius; up to MAX_TIGHT_BENDS_PER_10KM such
//     bends are tolerated (they would be eased during detailed design).
const DESIGN_SPEED_KMPH = 65;
const MAX_SUPERELEVATION = 0.07;
const SIDE_FRICTION_COEFF = 0.15;
const MIN_CURVE_RADIUS_M = DESIGN_SPEED_KMPH ** 2 / (127 * (MAX_SUPERELEVATION + SIDE_FRICTION_COEFF));
const CURVE_FIT_TOLERANCE_M = Math.max(grid.cellWidthM, grid.cellHeightM);
const IGNORE_DEFLECTION_BELOW_DEG = 5;
const MAX_TIGHT_BENDS_PER_10KM = 5;
// S7: bridge skew — crossings should be as square to the stream as possible; skew above ~30°
//     (commonly cited IRC bridge-siting guidance) lengthens spans and complicates abutments.
//     Culverts are exempt.
const MAX_BRIDGE_SKEW_DEG = 30;
// S8: directness — route length / straight-line distance between the end points.
const MAX_CIRCUITY_RATIO = 1.5;

// =============================================================================================

// Height Above Nearest River + distance to it, by a two-pass chamfer distance transform that
// carries the source river cell's elevation along with the distance. Computed once at startup.
const { width: W, height: H, cellWidthM: CW, cellHeightM: CH } = grid;
const riverDist = new Float32Array(W * H).fill(Infinity);
const riverElev = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) if (td.river[i]) { riverDist[i] = 0; riverElev[i] = td.elev[i]; }
{
  const D = Math.hypot(CW, CH);
  const relax = (i, j, w) => { if (riverDist[j] + w < riverDist[i]) { riverDist[i] = riverDist[j] + w; riverElev[i] = riverElev[j]; } };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (x > 0) relax(i, i - 1, CW);
    if (y > 0) { relax(i, i - W, CH); if (x > 0) relax(i, i - W - 1, D); if (x < W - 1) relax(i, i - W + 1, D); }
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    if (x < W - 1) relax(i, i + 1, CW);
    if (y < H - 1) { relax(i, i + W, CH); if (x < W - 1) relax(i, i + W + 1, D); if (x > 0) relax(i, i + W - 1, D); }
  }
}
const isFloodplain = (i) => !td.water[i] && riverDist[i] <= FLOODPLAIN_MAX_DISTANCE_M && td.elev[i] - riverElev[i] <= FLOODPLAIN_MAX_HEIGHT_M;

// Largest horizontal curve radius that fits at each bend of the simplified alignment.
function curveCheck(xy) {
  const pts = geo.douglasPeucker(xy, CURVE_FIT_TOLERANCE_M);
  const seg = [];
  for (let k = 1; k < pts.length; k++) seg.push(Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  let tight = 0, minR = Infinity;
  for (let k = 1; k < pts.length - 1; k++) {
    const a1 = Math.atan2(pts[k][1] - pts[k - 1][1], pts[k][0] - pts[k - 1][0]);
    const a2 = Math.atan2(pts[k + 1][1] - pts[k][1], pts[k + 1][0] - pts[k][0]);
    let defl = Math.abs(a2 - a1);
    if (defl > Math.PI) defl = 2 * Math.PI - defl;
    if ((defl * 180) / Math.PI < IGNORE_DEFLECTION_BELOW_DEG) continue;
    // Each interior straight is shared by two curves (half each); straights touching the route
    // ends belong wholly to this curve.
    const tPrev = k - 1 === 0 ? seg[k - 1] : seg[k - 1] / 2;
    const tNext = k + 1 === pts.length - 1 ? seg[k] : seg[k] / 2;
    const R = Math.min(tPrev, tNext) / Math.tan(defl / 2);
    minR = Math.min(minR, R);
    if (R < MIN_CURVE_RADIUS_M) tight++;
  }
  return { tight, minR, bends: pts.length - 2 };
}

const fmt = (v, d = 0) => (v === Infinity || v === null || v === undefined ? "—" : Number(v).toFixed(d));

function evaluateConstraints(analysis, { straightLineM }) {
  const { cells, xy, metrics, onBridge, crossings, profile } = analysis;
  const n = cells.length, L = metrics.lengthM;
  const items = [];
  const add = (id, type, name, passed, value, limit, failText) => items.push({ id, type, name, passed, value, limit, failText });

  // H1 — buildings: footprints crossed by the centreline, plus route cells inside the v3 grid's
  // building safety buffer (only possible for the legacy v2 route or a snapped end point)
  const blockedCells = cells.filter((c) => astar.isBlocked(c) && !td.religiousBlocked[c]).length;
  const crossed = analysis.buildingsCrossed.length;
  add("H1", "hard", "No building crossed", crossed === 0 && blockedCells === 0,
    `${crossed} footprint${crossed === 1 ? "" : "s"} crossed, ${blockedCells} cell${blockedCells === 1 ? "" : "s"} in 10 m buffer`, "0", "passes through a building / its buffer");

  // H2 — religious sites inside ROW
  const nearestRel = analysis.religiousNearby[0];
  const relCells = cells.filter((c) => td.religiousBlocked[c]).length;
  const relMin = nearestRel ? nearestRel.distanceM : Infinity;
  add("H2", "hard", "No religious site within ROW", relMin >= RELIGIOUS_HARD_CLEARANCE_M && relCells === 0,
    (nearestRel ? `${fmt(relMin)} m (${nearestRel.name || nearestRel.kind})` : "none within 500 m") + (relCells ? `, ${relCells} cells in 20 m buffer` : ""),
    `≥ ${fmt(RELIGIOUS_HARD_CLEARANCE_M)} m`,
    "encroaches on a religious site");

  // H3 — bridgeable water
  const longest = crossings.reduce((mx, c) => Math.max(mx, c.bridgeLengthM), 0);
  add("H3", "hard", "All water crossings bridgeable", longest <= MAX_SINGLE_BRIDGE_LENGTH_M,
    crossings.length ? `longest ${fmt(longest)} m` : "no crossings", `≤ ${MAX_SINGLE_BRIDGE_LENGTH_M} m`, "water crossing too wide to bridge");

  // S1 — steep stretches (smoothed ground grade)
  let run = 0, longestSteep = 0, maxGrade = 0;
  for (let k = 1; k < n; k++) {
    const step = metrics.step[k];
    const grade = step > 0 ? (100 * Math.abs(profile.groundSmoothed[k] - profile.groundSmoothed[k - 1])) / step : 0;
    if (!onBridge[k]) maxGrade = Math.max(maxGrade, grade);
    if (grade > MAX_GROUND_GRADE_PCT && !onBridge[k]) { run += step; longestSteep = Math.max(longestSteep, run); } else run = 0;
  }
  add("S1", "soft", `Gradient > ${MAX_GROUND_GRADE_PCT}% for ≤ ${MAX_STEEP_STRETCH_M} m`, longestSteep <= MAX_STEEP_STRETCH_M,
    `max ${fmt(maxGrade, 1)}%, steep run ${fmt(longestSteep)} m`, `≤ ${MAX_STEEP_STRETCH_M} m`, "long steep stretch");

  // S2 — religious buffer zone
  add("S2", "soft", `Religious sites ≥ ${RELIGIOUS_BUFFER_ZONE_M} m away`, relMin >= RELIGIOUS_BUFFER_ZONE_M,
    nearestRel ? `${fmt(relMin)} m` : "none within 500 m", `≥ ${RELIGIOUS_BUFFER_ZONE_M} m`, "inside a religious-site buffer zone");

  // S3 — buildings inside ROW
  const inRow = analysis.structuresInRow.length;
  add("S3", "soft", `No buildings inside ${ROW_WIDTH_M} m ROW`, inRow <= MAX_BUILDINGS_IN_ROW,
    `${inRow} building${inRow === 1 ? "" : "s"}`, `≤ ${MAX_BUILDINGS_IN_ROW}`, `${inRow} building${inRow === 1 ? "" : "s"} in ROW`);

  // S4 — forest share
  const forestPct = analysis.cost.forest.sharePct;
  add("S4", "soft", `Forest ≤ ${MAX_FOREST_SHARE_PCT}% of length`, forestPct <= MAX_FOREST_SHARE_PCT,
    `${fmt(forestPct, 1)}%`, `≤ ${MAX_FOREST_SHARE_PCT}%`, "exceeds max forest-crossing %");

  // S5 — floodplain share
  let floodM = 0;
  for (let k = 0; k < n; k++) if (!onBridge[k] && isFloodplain(cells[k])) floodM += metrics.trib[k];
  const floodPct = L ? (100 * floodM) / L : 0;
  add("S5", "soft", `Floodplain ≤ ${MAX_FLOODPLAIN_SHARE_PCT}% of length`, floodPct <= MAX_FLOODPLAIN_SHARE_PCT,
    `${fmt(floodPct, 1)}% (${fmt(floodM)} m)`, `≤ ${MAX_FLOODPLAIN_SHARE_PCT}%`, "runs along a floodplain");

  // S6 — curve radius
  const cc = curveCheck(xy);
  const allowedTight = Math.floor((MAX_TIGHT_BENDS_PER_10KM * L) / 10000);
  add("S6", "soft", `Curves fit R ≥ ${fmt(MIN_CURVE_RADIUS_M)} m (${DESIGN_SPEED_KMPH} km/h)`, cc.tight <= allowedTight,
    `${cc.tight} tight of ${cc.bends} bends (min R ${fmt(cc.minR)} m)`, `≤ ${allowedTight} tight bends (${MAX_TIGHT_BENDS_PER_10KM}/10 km)`,
    `${cc.tight} bends too sharp`);

  // S7 — bridge skew
  const skews = crossings.filter((c) => c.bridge.type !== "culvert" && c.skewDeg !== null);
  const maxSkew = skews.reduce((mx, c) => Math.max(mx, c.skewDeg), 0);
  add("S7", "soft", `Bridge skew ≤ ${MAX_BRIDGE_SKEW_DEG}°`, maxSkew <= MAX_BRIDGE_SKEW_DEG,
    skews.length ? `max ${fmt(maxSkew)}°` : "n/a", `≤ ${MAX_BRIDGE_SKEW_DEG}°`, "skewed bridge crossing");

  // S8 — circuity
  const circuity = straightLineM > 0 ? L / straightLineM : 1;
  add("S8", "soft", `Length ≤ ${MAX_CIRCUITY_RATIO}× straight line`, circuity <= MAX_CIRCUITY_RATIO,
    `${fmt(circuity, 2)}×`, `≤ ${MAX_CIRCUITY_RATIO}×`, "too circuitous");

  const hard = items.filter((i) => i.type === "hard"), soft = items.filter((i) => i.type === "soft");
  const passed = items.filter((i) => i.passed).length;
  const failed = items.filter((i) => !i.passed);
  return {
    items,
    passed, total: items.length,
    hardPassed: hard.filter((i) => i.passed).length, hardTotal: hard.length,
    softPassed: soft.filter((i) => i.passed).length, softTotal: soft.length,
    hardViolations: hard.filter((i) => !i.passed).length,
    softViolations: soft.filter((i) => !i.passed).length,
    summary: `meets ${passed}/${items.length} conditions` + (failed.length ? ` — ${failed.map((f) => f.failText).join("; ")}` : ""),
  };
}

const THRESHOLDS = {
  RELIGIOUS_HARD_CLEARANCE_M, MAX_SINGLE_BRIDGE_LENGTH_M, MAX_GROUND_GRADE_PCT, MAX_STEEP_STRETCH_M,
  RELIGIOUS_BUFFER_ZONE_M, MAX_BUILDINGS_IN_ROW, MAX_FOREST_SHARE_PCT, FLOODPLAIN_MAX_DISTANCE_M,
  FLOODPLAIN_MAX_HEIGHT_M, MAX_FLOODPLAIN_SHARE_PCT, DESIGN_SPEED_KMPH, MIN_CURVE_RADIUS_M: Math.round(MIN_CURVE_RADIUS_M),
  MAX_TIGHT_BENDS_PER_10KM,
  MAX_BRIDGE_SKEW_DEG, MAX_CIRCUITY_RATIO,
};

module.exports = { evaluateConstraints, THRESHOLDS };
