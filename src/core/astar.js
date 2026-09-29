const fs = require("fs");
const path = require("path");
const { GRID_V2, GRID_V3 } = require("../config/paths");

// cost_grid_v3 = the calibrated v2 grid + religious sites blocked (built by scripts/build_layers.js).
// Falls back to v2 if v3 has not been built yet.
const GRID_V3_PATH = GRID_V3;
const GRID_V2_PATH = GRID_V2;
const IMPASSABLE_THRESHOLD = 1e8; // cells at/above this are treated as blocked (buildings, religious sites, wide rivers)

// A diagonal step may not squeeze between two blocked orthogonal neighbours (e.g. through the
// shared corner of two buffered buildings, or across a 1-cell-wide diagonal stream line).
const PREVENT_DIAGONAL_CORNER_CUTTING = true;

// If a clicked start/end point lands in a blocked cell, snap to the nearest passable cell
// within this many cells (~30 m each).
const MAX_SNAP_RADIUS_CELLS = 20;

// Load grid once at startup (kept in memory, not re-read per request)
const gridPath = fs.existsSync(GRID_V3_PATH) ? GRID_V3_PATH : GRID_V2_PATH;
const grid = JSON.parse(fs.readFileSync(gridPath, "utf8"));
const gridVersion = path.basename(gridPath);
const { width, height, cellWidthM, cellHeightM, bounds } = grid;
const cost = Float32Array.from(grid.cost);
const avgCellM = (cellWidthM + cellHeightM) / 2;

// Admissible A* heuristic: straight-line distance x the cheapest cell cost in the grid, so
// the heuristic never overestimates and A* returns the true least-cost path. (Penalty
// multipliers used for alternative routes are >= 1, so this stays admissible for them too.)
let minCellCost = Infinity;
for (const c of cost) if (c > 0 && c < minCellCost) minCellCost = c;

// The original v2 grid, loaded on demand only for the "legacy route" comparison.
let legacyCost = null;
function getLegacyCost() {
  if (!legacyCost) legacyCost = Float32Array.from(JSON.parse(fs.readFileSync(GRID_V2_PATH, "utf8")).cost);
  return legacyCost;
}

// Binary min-heap of (cell index, f) pairs in typed arrays — avoids allocating an object per push.
class IndexHeap {
  constructor(capacity = 1 << 16) {
    this.idx = new Int32Array(capacity);
    this.f = new Float64Array(capacity);
    this.size = 0;
  }
  push(i, f) {
    if (this.size === this.idx.length) {
      const idx = new Int32Array(this.size * 2), ff = new Float64Array(this.size * 2);
      idx.set(this.idx); ff.set(this.f);
      this.idx = idx; this.f = ff;
    }
    let k = this.size++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.f[p] <= f) break;
      this.idx[k] = this.idx[p]; this.f[k] = this.f[p];
      k = p;
    }
    this.idx[k] = i; this.f[k] = f;
  }
  pop() {
    const top = this.idx[0];
    const lastI = this.idx[--this.size], lastF = this.f[this.size];
    let k = 0;
    while (true) {
      let c = 2 * k + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.f[c + 1] < this.f[c]) c++;
      if (this.f[c] >= lastF) break;
      this.idx[k] = this.idx[c]; this.f[k] = this.f[c];
      k = c;
    }
    this.idx[k] = lastI; this.f[k] = lastF;
    return top;
  }
}

const NEIGHBORS = [
  [-1, -1, Math.SQRT2], [0, -1, 1], [1, -1, Math.SQRT2],
  [-1, 0, 1],                       [1, 0, 1],
  [-1, 1, Math.SQRT2],  [0, 1, 1],  [1, 1, Math.SQRT2],
];

function heuristic(x1, y1, x2, y2) {
  const dx = (x2 - x1) * avgCellM;
  const dy = (y2 - y1) * avgCellM;
  return Math.sqrt(dx * dx + dy * dy) * minCellCost;
}

function latLonToPixel(lat, lon) {
  const x = Math.round(((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * width);
  const y = Math.round(((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * height);
  return { x: Math.min(width - 1, Math.max(0, x)), y: Math.min(height - 1, Math.max(0, y)) };
}

function pixelToLatLon(x, y) {
  const lon = bounds.minLon + (x / width) * (bounds.maxLon - bounds.minLon);
  const lat = bounds.maxLat - (y / height) * (bounds.maxLat - bounds.minLat);
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
}

function inBounds(lat, lon) {
  return lat >= bounds.minLat && lat <= bounds.maxLat && lon >= bounds.minLon && lon <= bounds.maxLon;
}

const isBlocked = (i, extraBlocked) => cost[i] >= IMPASSABLE_THRESHOLD || (extraBlocked && extraBlocked[i] === 1);

// Nearest passable cell to (x, y), searching outward ring by ring.
function snapToPassable(x, y, extraBlocked = null) {
  if (!isBlocked(y * width + x, extraBlocked)) return { x, y, snappedM: 0 };
  let best = null;
  for (let r = 1; r <= MAX_SNAP_RADIUS_CELLS && !best; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || isBlocked(ny * width + nx, extraBlocked)) continue;
      const d = Math.hypot(dx * cellWidthM, dy * cellHeightM);
      if (!best || d < best.snappedM) best = { x: nx, y: ny, snappedM: d };
    }
  }
  return best;
}

// Core least-cost search between two cells.
// opts.costMultiplier: Float32Array of per-cell multipliers (>= 1) — used by the iterative
//                      penalty method to push later candidates away from earlier ones.
// opts.extraBlocked:   Uint8Array of additional impassable cells (e.g. water for detour search).
// opts.window:         { x0, y0, x1, y1 } restricts the search area.
// opts.baseCost:       search a different cost array (only used for the legacy v2 comparison).
// Returns { cells: number[] (cell indices start..end), searchCost, nodesExplored } or null.
function search(start, end, opts = {}) {
  const { costMultiplier = null, extraBlocked = null, window = null, baseCost = cost } = opts;
  const blocked = (i) => baseCost[i] >= IMPASSABLE_THRESHOLD || (extraBlocked !== null && extraBlocked[i] === 1);
  const N = width * height;
  const gScore = new Float64Array(N).fill(Infinity);
  const visited = new Uint8Array(N);
  const cameFrom = new Int32Array(N).fill(-1);
  const wx0 = window ? Math.max(0, window.x0) : 0, wy0 = window ? Math.max(0, window.y0) : 0;
  const wx1 = window ? Math.min(width - 1, window.x1) : width - 1, wy1 = window ? Math.min(height - 1, window.y1) : height - 1;

  const startIdx = start.y * width + start.x, endIdx = end.y * width + end.x;
  gScore[startIdx] = 0;
  const open = new IndexHeap();
  open.push(startIdx, heuristic(start.x, start.y, end.x, end.y));
  let nodesExplored = 0;

  while (open.size > 0) {
    const curIdx = open.pop();
    if (visited[curIdx]) continue;
    visited[curIdx] = 1;
    nodesExplored++;

    if (curIdx === endIdx) {
      const cells = [];
      for (let c = curIdx; c !== -1; c = cameFrom[c]) cells.push(c);
      cells.reverse();
      return { cells, searchCost: gScore[curIdx], nodesExplored };
    }

    const cx = curIdx % width, cy = (curIdx - cx) / width;
    for (const [dx, dy, distMult] of NEIGHBORS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < wx0 || nx > wx1 || ny < wy0 || ny > wy1) continue;
      const nIdx = ny * width + nx;
      if (visited[nIdx] || blocked(nIdx)) continue;
      if (PREVENT_DIAGONAL_CORNER_CUTTING && dx !== 0 && dy !== 0 && blocked(cy * width + nx) && blocked(ny * width + cx)) continue;

      const cellCost = costMultiplier ? baseCost[nIdx] * costMultiplier[nIdx] : baseCost[nIdx];
      const tentativeG = gScore[curIdx] + avgCellM * distMult * cellCost;
      if (tentativeG < gScore[nIdx]) {
        gScore[nIdx] = tentativeG;
        cameFrom[nIdx] = curIdx;
        open.push(nIdx, tentativeG + heuristic(nx, ny, end.x, end.y));
      }
    }
  }
  return null;
}

// Grid-cost (the calibrated abstract score) and metric length of a cell path.
function pathCost(cells, costArr = cost) {
  let total = 0;
  for (let k = 1; k < cells.length; k++) total += avgCellM * stepMult(cells[k - 1], cells[k]) * costArr[cells[k]];
  return total;
}
const stepMult = (a, b) => ((a % width) !== (b % width) && Math.floor(a / width) !== Math.floor(b / width) ? Math.SQRT2 : 1);
function stepLengthM(a, b) {
  const dx = ((b % width) - (a % width)) * cellWidthM, dy = (Math.floor(b / width) - Math.floor(a / width)) * cellHeightM;
  return Math.sqrt(dx * dx + dy * dy);
}
function pathLengthM(cells) {
  let d = 0;
  for (let k = 1; k < cells.length; k++) d += stepLengthM(cells[k - 1], cells[k]);
  return d;
}
function cellsToLonLat(cells) {
  return cells.map((c) => {
    const ll = pixelToLatLon(c % width, Math.floor(c / width));
    return [ll.lon, ll.lat];
  });
}

// Single least-cost route (original /api/route behaviour): lat/lon in, GeoJSON Feature out
function findRoute(startLat, startLon, endLat, endLon) {
  const sp = latLonToPixel(startLat, startLon), ep = latLonToPixel(endLat, endLon);
  const s = snapToPassable(sp.x, sp.y);
  const e = snapToPassable(ep.x, ep.y);
  if (!s || !e) return null;

  const result = search(s, e);
  if (!result) return null;
  const { cells, nodesExplored, searchCost } = result;

  return {
    type: "Feature",
    properties: {
      totalCost: +searchCost.toFixed(1),
      distanceKm: +(pathLengthM(cells) / 1000).toFixed(2),
      nodesExplored,
      gridCellsInPath: cells.length,
    },
    geometry: { type: "LineString", coordinates: cellsToLonLat(cells) },
  };
}

module.exports = {
  findRoute, inBounds, bounds, search, snapToPassable, latLonToPixel, pixelToLatLon,
  pathCost, pathLengthM, stepLengthM, cellsToLonLat, isBlocked, getLegacyCost,
  grid: { width, height, cellWidthM, cellHeightM, bounds, cost, avgCellM, minCellCost, version: gridVersion },
  IMPASSABLE_THRESHOLD,
};
