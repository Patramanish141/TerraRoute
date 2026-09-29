// Generates several meaningfully DIFFERENT candidate routes between the same two points using
// the iterative penalty method (Johnson, Joy & Clarke 1992; Akgün, Erkut & Batta 2000,
// "On finding dissimilar paths"):
//   1. Find the least-cost path on the calibrated grid.
//   2. Multiply the cost of every cell in a corridor around that path by a penalty factor.
//   3. Search again on the penalized grid. The new path is accepted as a candidate only if it
//      is dissimilar enough from every accepted one (limited-overlap test); either way its
//      corridor is penalized too, so the search keeps being pushed into new territory.
// Candidates are always reported with their TRUE (unpenalized) grid cost and ₹ estimate.
const astar = require("./astar");
const { grid } = astar;

// ---- Candidate-generation parameters ---------------------------------------------------------
const NUM_CANDIDATES = 5;          // target number of candidates
const MIN_CANDIDATES = 4;          // if diversity is hard to reach, relax overlap to still return this many
const MAX_ITERATIONS = 16;         // max searches before giving up
const PENALTY_FACTOR = 1.6;        // cost multiplier applied to a used corridor (compounds on reuse)
const PENALTY_CORRIDOR_M = 90;     // corridor half-width penalized around each found path (~3 cells)
const OVERLAP_TOLERANCE_M = 60;    // two paths "share" a stretch if within this distance
const MAX_OVERLAP_SHARE = 0.5;     // accept only if ≤ 50% of the new path runs alongside any accepted one
const ENDPOINT_EXEMPT_M = 200;     // all paths must meet at the ends: not penalized / not counted there
const MAX_COST_STRETCH = 2.0;      // reject candidates whose true grid cost > 2x the best route's

const { width: W, height: H, cellWidthM: CW, cellHeightM: CH } = grid;

function discOffsets(radiusM) {
  const out = [];
  const rx = Math.ceil(radiusM / CW), ry = Math.ceil(radiusM / CH);
  for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) if (Math.hypot(dx * CW, dy * CH) <= radiusM) out.push([dx, dy]);
  return out;
}
const CORRIDOR = discOffsets(PENALTY_CORRIDOR_M);
const OVERLAP = discOffsets(OVERLAP_TOLERANCE_M);
const ENDPOINT = discOffsets(ENDPOINT_EXEMPT_M);

function stampDisc(cells, offsets, fn) {
  for (const c of cells) {
    const x = c % W, y = (c - x) / W;
    for (const [dx, dy] of offsets) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) fn(ny * W + nx);
    }
  }
}

function generateCandidates(start, end) {
  const N = W * H;
  const exempt = new Uint8Array(N);
  stampDisc([start.y * W + start.x, end.y * W + end.x], ENDPOINT, (i) => (exempt[i] = 1));

  const penalty = new Float32Array(N).fill(1);
  const accepted = [], rejected = [];
  let bestCost = Infinity, iterations = 0;

  // Share of `cells` (by length, outside the endpoint zones) lying within OVERLAP_TOLERANCE_M of `mask`.
  const overlapShare = (cells, mask) => {
    let shared = 0, total = 0;
    for (let k = 1; k < cells.length; k++) {
      if (exempt[cells[k]]) continue;
      const len = astar.stepLengthM(cells[k - 1], cells[k]);
      total += len;
      if (mask[cells[k]]) shared += len;
    }
    return total > 0 ? shared / total : 1;
  };

  while (accepted.length < NUM_CANDIDATES && iterations < MAX_ITERATIONS) {
    iterations++;
    const res = astar.search(start, end, accepted.length ? { costMultiplier: penalty } : {});
    if (!res) break;
    const trueCost = astar.pathCost(res.cells);
    if (!accepted.length) bestCost = trueCost;

    const overlaps = accepted.map((a) => overlapShare(res.cells, a.mask));
    const maxOverlap = overlaps.length ? Math.max(...overlaps) : 0;
    const cand = { cells: res.cells, gridCost: trueCost, iteration: iterations, maxOverlap };

    if (!accepted.length || (maxOverlap <= MAX_OVERLAP_SHARE && trueCost <= MAX_COST_STRETCH * bestCost)) {
      const mask = new Uint8Array(N);
      stampDisc(res.cells, OVERLAP, (i) => (mask[i] = 1));
      accepted.push({ ...cand, mask });
    } else if (trueCost <= MAX_COST_STRETCH * bestCost) {
      rejected.push(cand);
    }

    // Penalize this path's corridor once (compounds with earlier penalties on shared cells)
    const seen = new Uint8Array(N);
    stampDisc(res.cells, CORRIDOR, (i) => {
      if (seen[i] || exempt[i]) return;
      seen[i] = 1;
      penalty[i] *= PENALTY_FACTOR;
    });
  }

  // Too few sufficiently different paths (e.g. a narrow valley or a single bridge site):
  // top up with the least-overlapping rejected ones that are not duplicates of each other.
  if (accepted.length < MIN_CANDIDATES) {
    rejected.sort((a, b) => a.maxOverlap - b.maxOverlap);
    for (const r of rejected) {
      if (accepted.length >= MIN_CANDIDATES) break;
      const mask = new Uint8Array(N);
      stampDisc(r.cells, OVERLAP, (i) => (mask[i] = 1));
      if (accepted.some((a) => overlapShare(r.cells, a.mask) > 0.9)) continue;
      accepted.push({ ...r, mask, relaxed: true });
    }
  }

  return {
    candidates: accepted.map(({ mask, ...c }) => c),
    iterations,
    params: { NUM_CANDIDATES, MAX_ITERATIONS, PENALTY_FACTOR, PENALTY_CORRIDOR_M, OVERLAP_TOLERANCE_M, MAX_OVERLAP_SHARE, MAX_COST_STRETCH },
  };
}

module.exports = { generateCandidates };
