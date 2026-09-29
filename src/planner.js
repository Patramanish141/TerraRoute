// Orchestrates the multi-route study: generate diverse candidates -> price each one ->
// check the field-engineer constraints -> rank -> select the top 3.
const astar = require("./core/astar");
const { generateCandidates } = require("./core/candidates");
const { analyzeRoute, ASSUMPTIONS } = require("./analysis/costModel");
const { evaluateConstraints, THRESHOLDS } = require("./analysis/constraints");

// ---- Ranking parameters ----------------------------------------------------------------------
// Ranking is lexicographic on HARD violations first (any route that breaks a hard constraint —
// building, religious site, unbridgeable water — ranks below every compliant route, however
// cheap), then by a penalized cost: total ₹ x (1 + SOFT_VIOLATION_PENALTY x soft violations).
// With 0.10, a route with one extra soft violation needs to be >10% cheaper to rank higher.
const SOFT_VIOLATION_PENALTY = 0.10;
const TOP_N = 3;

const LETTERS = "ABCDEFGHIJ";

function round(v, d = 2) {
  return typeof v === "number" && isFinite(v) ? +v.toFixed(d) : v;
}

// Strip internal fields / typed arrays and round numbers for the JSON response.
function serializeCost(cost) {
  const r = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "a" || k === "b" ? undefined : typeof v === "number" ? round(v, 3) : v)));
  return r(cost);
}

// options.includeLegacy: also run the ORIGINAL cost_grid_v2 (no religious-site blocking, older
// building/water data) once and put its least-cost route through the same pricing, checklist
// and ranking — shows the checker catching hard violations the old grid could not see.
function planRoutes(startLat, startLon, endLat, endLon, { includeLegacy = false } = {}) {
  const t0 = Date.now();
  const sp = astar.latLonToPixel(startLat, startLon), ep = astar.latLonToPixel(endLat, endLon);
  const start = astar.snapToPassable(sp.x, sp.y), end = astar.snapToPassable(ep.x, ep.y);
  if (!start || !end) return { error: "Start or end point is inside a blocked area (building / religious site / wide river) with no passable cell nearby." };

  const gen = generateCandidates(start, end);
  if (!gen.candidates.length) return { error: "No path found between the given points." };
  const candidates = gen.candidates.map((c, i) => ({ ...c, id: LETTERS[i], name: `Route ${LETTERS[i]}` }));
  if (includeLegacy) {
    const legacyCost = astar.getLegacyCost();
    const res = astar.search(start, end, { baseCost: legacyCost });
    if (res) candidates.push({ cells: res.cells, gridCost: astar.pathCost(res.cells, legacyCost), iteration: 0, maxOverlap: 0, legacy: true, id: "L", name: "Legacy (v2 grid)" });
  }
  const tGen = Date.now();

  const straightLineM = Math.hypot((end.x - start.x) * astar.grid.cellWidthM, (end.y - start.y) * astar.grid.cellHeightM);

  const routes = candidates.map((c) => {
    const analysis = analyzeRoute(c.cells);
    const constraints = evaluateConstraints(analysis, { straightLineM });
    const totalInr = analysis.cost.totalInr;
    return {
      id: c.id,
      name: c.name,
      legacy: !!c.legacy,
      generation: c.legacy
        ? { note: "Least-cost path on the original cost_grid_v2 (grid cost shown is on v2)" }
        : { iteration: c.iteration, maxOverlapWithEarlierPct: round(100 * c.maxOverlap, 1), relaxedDiversity: !!c.relaxed },
      geometry: { type: "LineString", coordinates: astar.cellsToLonLat(c.cells) },
      summary: {
        distanceKm: round(analysis.metrics.lengthM / 1000, 2),
        gridCost: round(c.gridCost, 0),
        totalInr: round(totalInr, 0),
        bridges: analysis.crossings.length,
        forestPct: round(analysis.cost.forest.sharePct, 1),
      },
      cost: serializeCost(analysis.cost),
      constraints,
      religiousNearby: analysis.religiousNearby.slice(0, 3).map((r) => ({ ...r, distanceM: round(r.distanceM, 0) })),
      ranking: {
        hardViolations: constraints.hardViolations,
        softViolations: constraints.softViolations,
        rankScoreInr: round(totalInr * (1 + SOFT_VIOLATION_PENALTY * constraints.softViolations), 0),
      },
    };
  });

  const order = [...routes].sort((a, b) => a.ranking.hardViolations - b.ranking.hardViolations || a.ranking.rankScoreInr - b.ranking.rankScoreInr);
  order.forEach((r, i) => {
    r.ranking.rank = i + 1;
    r.ranking.selected = i < TOP_N;
    r.ranking.note = r.ranking.hardViolations > 0
      ? "Violates a hard constraint — not recommended"
      : i < TOP_N ? `Top ${TOP_N}` : "Rejected (costlier and/or more soft violations)";
  });

  const toLL = (p) => astar.pixelToLatLon(p.x, p.y);
  return {
    request: {
      start: { lat: startLat, lon: startLon }, end: { lat: endLat, lon: endLon },
      snappedStart: { ...toLL(start), snappedM: round(start.snappedM, 0) },
      snappedEnd: { ...toLL(end), snappedM: round(end.snappedM, 0) },
      straightLineKm: round(straightLineM / 1000, 2),
    },
    method: {
      candidates: "Iterative penalty method (penalize the corridor of each found path, re-run A*, accept if overlap ≤ limit)",
      generation: { iterations: gen.iterations, ...gen.params },
      ranking: `Hard violations first, then total ₹ × (1 + ${SOFT_VIOLATION_PENALTY} × soft violations); top ${TOP_N} selected`,
      grid: astar.grid.version,
    },
    routes,
    top: order.slice(0, TOP_N).map((r) => r.id),
    timingMs: { generation: tGen - t0, analysis: Date.now() - tGen },
  };
}

module.exports = { planRoutes, assumptions: () => ({ cost: ASSUMPTIONS, constraints: THRESHOLDS, ranking: { SOFT_VIOLATION_PENALTY, TOP_N } }) };
