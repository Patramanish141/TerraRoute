// Explicit, itemized cost estimate (INR) for a candidate route.
//
// The A* search still runs on the calibrated abstract cost grid (slope / water / forest / road /
// blocked). This module then prices the route it found in rupees, line by line, so the choice
// can be explained and defended: pavement, earthwork, land acquisition, bridges (compared with
// a land-only detour for every water crossing) and forest compensation.
const astar = require("../core/astar");
const td = require("../layers/terrainData");
const geo = require("../core/geometry");
const { grid } = astar;

const LAKH = 1e5, CRORE = 1e7;

// =============================================================================================
// COST ASSUMPTIONS — preliminary (feasibility-level) estimates, 2024-25 price level.
// Every figure marked "ESTIMATE" is a judgement call, not a quoted schedule rate: verify against
// the current Odisha Works Dept / MoRTH Standard Data Book / CPWD DSR before presenting.
// =============================================================================================

// ---- Cross-section ---------------------------------------------------------------------------
// Right-of-way to be acquired. IRC:73 gives 30–60 m land width for NH/SH (45 m normal in open
// country, 30 m in built-up areas); 30 m is the lower end, typical for a 2-lane state highway.
const ROW_WIDTH_M = 30;
// Formation (roadway) width used for earthwork cross-sections: IRC:73 roadway width for a
// 2-lane NH/SH = 12 m (7.0 m carriageway + shoulders).
const ROADWAY_FORMATION_WIDTH_M = 12;

// ---- Pavement --------------------------------------------------------------------------------
// ESTIMATE. New 2-lane flexible pavement with paved shoulders (GSB + WMM + DBM + BC on prepared
// subgrade), incl. side drains, minor cross-drainage and road furniture; EXCLUDES land, bridges
// and terrain-driven cut/fill (costed separately below). Published all-in figures for a 2-lane
// NH in plain terrain are ₹6–12 Cr/km; ₹5 Cr/km is used because those items are split out here.
const FLEXIBLE_PAVEMENT_INR_PER_KM = 5 * CRORE;

// ---- Earthwork (terrain) ---------------------------------------------------------------------
// ESTIMATE. Excavation in ordinary soil by mechanical means incl. disposal within 1 km
// (CPWD DSR / MoRTH SOR order of magnitude).
const EARTHWORK_CUT_INR_PER_M3 = 250;
// ESTIMATE. Embankment with borrow earth incl. haulage, spreading and compaction to 97% MDD.
const EARTHWORK_FILL_INR_PER_M3 = 450;
const CUT_SIDE_SLOPE_H_PER_V = 1.0;  // 1H:1V cut slopes in ordinary soil
const FILL_SIDE_SLOPE_H_PER_V = 2.0; // 2H:1V embankment slopes (MoRTH typical)
// The design vertical profile is fitted to the ground with this maximum grade; wherever the
// ground is steeper, cut/fill makes up the difference. IRC:73 ruling gradient for plain/rolling
// terrain = 3.3%.
const DESIGN_MAX_GRADE_PCT = 3.3;
// SRTM has several metres of vertical noise; the ground profile is smoothed with this moving
// window before fitting, so DEM noise is not billed as earthwork.
const DEM_SMOOTHING_WINDOW_M = 150;

// ---- Bridges ---------------------------------------------------------------------------------
// Overall deck width for a 2-lane bridge (7.5 m carriageway per IRC:5 + crash barriers/kerbs +
// footpaths) ≈ 12 m.
const BRIDGE_DECK_WIDTH_M = 12;
// Added to each end of the measured water crossing for abutments / bank protection.
const BRIDGE_END_ALLOWANCE_M = 5;
// IRC classification by total length: culvert ≤ 6 m, minor bridge ≤ 60 m, major bridge > 60 m.
const CULVERT_MAX_LENGTH_M = 6;
const MINOR_BRIDGE_MAX_LENGTH_M = 60;
// ESTIMATE. RCC solid-slab / box structure (culverts and minor bridges), complete with
// foundations, substructure, deck, wearing coat, railings, per m² of deck. Reference points:
// a PMGSY Jharkhand bridge at ~₹5.3 lakh per running metre (~8.4 m wide ≈ ₹63,000/m²) and
// ₹80,000–1,50,000/m² quoted for complete steel bridges. RCC slab is the cheapest form.
const RCC_SLAB_BRIDGE_INR_PER_M2 = 55000;
// ESTIMATE. RCC / PSC box-girder (major bridges > 60 m, deeper foundations, longer spans).
const RCC_BOX_GIRDER_BRIDGE_INR_PER_M2 = 70000;
// Width assumed for an OSM waterway LINE when it has no `width` tag and no water polygon.
const WATERWAY_DEFAULT_WIDTH_M = { river: 30, canal: 8, stream: 5, tidal_channel: 5, drain: 3, ditch: 2 };
// Crossing length along the road = width / sin(angle); the angle is floored here so a nearly
// parallel crossing does not blow up to an absurd length.
const MIN_CROSSING_ANGLE_DEG = 20;

// ---- Bridge-vs-detour comparison ------------------------------------------------------------
// The detour is searched between route points this many cells (~30 m each) before/after the water.
const DETOUR_ENDPOINT_OFFSET_CELLS = 3;
// Detour search window: the bbox of those two points grown by this margin.
const DETOUR_SEARCH_MARGIN_M = 3000;
// Largest crossings first; smaller ones beyond this count are reported without a detour.
const MAX_DETOUR_EVALUATIONS_PER_ROUTE = 8;

// ---- Land acquisition ------------------------------------------------------------------------
// ESTIMATE. Market value (₹ per hectare; 1 ha = 2.471 acre) by land class around Rourkela.
// Replace with the IGR Odisha benchmark valuation for the actual mouzas crossed.
const LAND_MARKET_VALUE_INR_PER_HA = {
  rural_unclassified: 18 * LAKH, // untagged rural land (mostly paddy / fallow)  ≈ ₹7.3 L/acre
  agricultural: 25 * LAKH,       // OSM farmland / orchard / meadow             ≈ ₹10 L/acre
  forest: 10 * LAKH,             // non-reserved woodland; reserved forest is DIVERTED (₹0 purchase) — see FOREST_* below
  open_scrub: 12 * LAKH,         // scrub / grassland / barren                   ≈ ₹4.9 L/acre
  settlement: 1.5 * CRORE,       // village homestead land near buildings        ≈ ₹140/sq ft
  residential: 5 * CRORE,        // urban residential                            ≈ ₹465/sq ft
  commercial: 10 * CRORE,        // commercial / retail                          ≈ ₹930/sq ft
  industrial: 2 * CRORE,         // industrial / railway (e.g. RSP land)
  institutional: 2 * CRORE,      // campuses, schools, hospitals (govt land transfer value)
  recreation: 2 * CRORE,         // parks, grounds
  water: 0,                      // river / pond bed — government land, bridged over
};
// RFCTLARR Act 2013, First Schedule: market value x multiplication factor (rural: 1.0–2.0 by
// distance from the urban centre, urban: 1.0), then + 100% solatium. The study area is within
// ~10 km of Rourkela, so rural land uses 1.5.
const RFCTLARR_MULTIPLIER = {
  rural_unclassified: 1.5, agricultural: 1.5, forest: 1.5, open_scrub: 1.5, settlement: 1.5,
  residential: 1.0, commercial: 1.0, industrial: 1.0, institutional: 1.0, recreation: 1.0, water: 1.0,
};
const RFCTLARR_SOLATIUM = 1.0; // 100% of compensation (Sec. 30)
// ESTIMATE. Per building footprint falling inside the ROW: structure value + solatium + R&R grant.
const STRUCTURE_COMPENSATION_INR_PER_BUILDING = 15 * LAKH;
// Where the route runs ALONG an existing road for at least this many cells, the existing road
// width (already public land) is deducted from the ROW to be acquired.
const ALONG_ROAD_MIN_CELLS = 3;

// ---- Forest (ecological / compensatory — shown separately from land purchase) ---------------
// Net Present Value payable on forest diversion under the Forest (Conservation) Act. Operative
// rates (Supreme Court, 2008): ₹4.38–10.43 lakh/ha by eco-class and density; ₹9.39 lakh/ha is
// "dense forest, eco-class I/II". A proposed revision would raise this to ₹9.5–16 lakh/ha.
const FOREST_NPV_INR_PER_HA = 9.39 * LAKH;
// ESTIMATE. Compensatory afforestation: raising + ~10 years maintenance of an equivalent area.
const COMPENSATORY_AFFORESTATION_INR_PER_HA = 3.5 * LAKH;

// =============================================================================================

const W = grid.width;
const landRateInrPerHa = (cls) => LAND_MARKET_VALUE_INR_PER_HA[cls] * RFCTLARR_MULTIPLIER[cls] * (1 + RFCTLARR_SOLATIUM);
const toLonLat = (p) => td.proj.toLonLat(p[0], p[1]).map((v) => +v.toFixed(6));
const cellXYOf = (c) => [(c % W) * grid.cellWidthM, Math.floor(c / W) * grid.cellHeightM];

// Step lengths, chainage and per-vertex tributary length (half of each adjacent step).
function polylineMetrics(xy) {
  const n = xy.length, step = new Float64Array(n), chain = new Float64Array(n), trib = new Float64Array(n);
  for (let k = 1; k < n; k++) {
    step[k] = Math.hypot(xy[k][0] - xy[k - 1][0], xy[k][1] - xy[k - 1][1]);
    chain[k] = chain[k - 1] + step[k];
  }
  for (let k = 0; k < n; k++) trib[k] = ((k > 0 ? step[k] : 0) + (k + 1 < n ? step[k + 1] : 0)) / 2;
  return { step, chain, trib, lengthM: chain[n - 1] || 0 };
}

// ---------------------------------------------------------------------------------------------
// Land acquisition for a list of cells (used for the route and for detours)
// ---------------------------------------------------------------------------------------------
function landForCells(cells, trib) {
  const n = cells.length;
  const onRoad = cells.map((c) => td.roadWidthM[c] > 0);
  const alongRoad = new Uint8Array(n);
  for (let k = 0; k < n;) {
    if (!onRoad[k]) { k++; continue; }
    let e = k;
    while (e < n && onRoad[e]) e++;
    if (e - k >= ALONG_ROAD_MIN_CELLS) alongRoad.fill(1, k, e);
    k = e;
  }
  const byType = {};
  let hectares = 0, inr = 0, forestLengthM = 0;
  for (let k = 0; k < n; k++) {
    const c = cells[k];
    if (td.water[c]) continue; // bridged — river/pond bed is government land
    const cls = td.landClassNames[td.landClass[c]];
    if (cls === "water") continue;
    if (cls === "forest") forestLengthM += trib[k];
    const widthM = ROW_WIDTH_M - (alongRoad[k] ? Math.min(td.roadWidthM[c], ROW_WIDTH_M) : 0);
    const ha = (trib[k] * widthM) / 1e4;
    const cost = ha * landRateInrPerHa(cls);
    const t = (byType[cls] = byType[cls] || { type: cls, hectares: 0, lengthM: 0, ratePerHaInr: landRateInrPerHa(cls), inr: 0 });
    t.hectares += ha; t.lengthM += trib[k]; t.inr += cost;
    hectares += ha; inr += cost;
  }
  return { hectares, inr, byType: Object.values(byType).sort((a, b) => b.inr - a.inr), forestLengthM };
}

// ---------------------------------------------------------------------------------------------
// Features within `radius` of a polyline -> Map(feature -> min distance)
// ---------------------------------------------------------------------------------------------
function featuresNear(xy, radius, index, distToSeg) {
  const found = new Map();
  for (let k = 1; k < xy.length; k++) {
    const [ax, ay] = xy[k - 1], [bx, by] = xy[k];
    for (const f of index.query(Math.min(ax, bx) - radius, Math.min(ay, by) - radius, Math.max(ax, bx) + radius, Math.max(ay, by) + radius)) {
      const d = distToSeg(f, ax, ay, bx, by);
      if (d <= radius && (!found.has(f) || d < found.get(f))) found.set(f, d);
    }
  }
  return found;
}
const polygonSegDist = (f, ax, ay, bx, by) => geo.segPolygonDist(ax, ay, bx, by, f.rings);
const religiousSegDist = (f, ax, ay, bx, by) => (f.point ? geo.pointSegDist(f.point[0], f.point[1], ax, ay, bx, by) : geo.segPolygonDist(ax, ay, bx, by, f.rings));

// ---------------------------------------------------------------------------------------------
// Earthwork from the ground profile along the route
// ---------------------------------------------------------------------------------------------
function earthworkFor(cells, m, onBridge) {
  const n = cells.length, { chain, step, trib } = m;
  const z = cells.map((c) => td.elev[c]);

  // Moving-average smoothing over DEM_SMOOTHING_WINDOW_M of chainage
  const zs = new Float64Array(n), half = DEM_SMOOTHING_WINDOW_M / 2;
  let lo = 0, hi = -1, sum = 0;
  for (let k = 0; k < n; k++) {
    while (hi + 1 < n && chain[hi + 1] <= chain[k] + half) sum += z[++hi];
    while (chain[lo] < chain[k] - half) sum -= z[lo++];
    zs[k] = sum / (hi - lo + 1);
  }

  // Grade-limited design line: midway between the largest g-Lipschitz profile below the ground
  // (U) and the smallest one above it (L). Where the ground is within the max grade, U = L =
  // ground and no earthwork is needed; elsewhere hills are cut and hollows filled symmetrically.
  const g = DESIGN_MAX_GRADE_PCT / 100;
  const U = Float64Array.from(zs), L = Float64Array.from(zs);
  for (let k = 1; k < n; k++) { U[k] = Math.min(U[k], U[k - 1] + g * step[k]); L[k] = Math.max(L[k], L[k - 1] - g * step[k]); }
  for (let k = n - 2; k >= 0; k--) { U[k] = Math.min(U[k], U[k + 1] + g * step[k + 1]); L[k] = Math.max(L[k], L[k + 1] - g * step[k + 1]); }

  let cutM3 = 0, fillM3 = 0, maxCutM = 0, maxFillM = 0;
  const B = ROADWAY_FORMATION_WIDTH_M;
  const design = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    design[k] = (U[k] + L[k]) / 2;
    if (onBridge[k]) continue; // bridge deck — no earthwork
    const h = design[k] - zs[k];
    if (h > 0) { fillM3 += (B * h + FILL_SIDE_SLOPE_H_PER_V * h * h) * trib[k]; maxFillM = Math.max(maxFillM, h); }
    else if (h < 0) { const d = -h; cutM3 += (B * d + CUT_SIDE_SLOPE_H_PER_V * d * d) * trib[k]; maxCutM = Math.max(maxCutM, d); }
  }
  return {
    inr: cutM3 * EARTHWORK_CUT_INR_PER_M3 + fillM3 * EARTHWORK_FILL_INR_PER_M3,
    cutM3, fillM3, maxCutM, maxFillM,
    profile: { groundSmoothed: zs, design },
  };
}

// ---------------------------------------------------------------------------------------------
// Water crossings: detect, measure from OSM geometry, price bridge, compare with detour
// ---------------------------------------------------------------------------------------------
function classifyBridge(lengthM) {
  if (lengthM <= CULVERT_MAX_LENGTH_M) return { type: "culvert", structure: "RCC box culvert", ratePerM2: RCC_SLAB_BRIDGE_INR_PER_M2 };
  if (lengthM <= MINOR_BRIDGE_MAX_LENGTH_M) return { type: "minor bridge", structure: "RCC solid slab", ratePerM2: RCC_SLAB_BRIDGE_INR_PER_M2 };
  return { type: "major bridge", structure: "RCC/PSC box girder", ratePerM2: RCC_BOX_GIRDER_BRIDGE_INR_PER_M2 };
}

// Length of the polyline lying inside any of the given polygons (union, not double counted).
function lengthInsidePolygons(xy, polys) {
  let inside = 0;
  const hit = new Set();
  for (let k = 1; k < xy.length; k++) {
    const [ax, ay] = xy[k - 1], [bx, by] = xy[k];
    const segLen = Math.hypot(bx - ax, by - ay);
    const ts = [0, 1];
    for (const p of polys) for (const ring of p.rings) for (let i = 1; i < ring.length; i++) {
      const r = geo.segIntersect(ax, ay, bx, by, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]);
      if (r) ts.push(r.t);
    }
    ts.sort((a, b) => a - b);
    for (let j = 1; j < ts.length; j++) {
      const tm = (ts[j - 1] + ts[j]) / 2;
      const mx = ax + (bx - ax) * tm, my = ay + (by - ay) * tm;
      const p = polys.find((pp) => geo.pointInRings(mx, my, pp.rings));
      if (p) { inside += (ts[j] - ts[j - 1]) * segLen; hit.add(p); }
    }
  }
  return { inside, polygons: [...hit] };
}

function detectCrossings(cells, xy, m) {
  const n = cells.length;
  const isWater = cells.map((c) => td.water[c] === 1);

  // 1. Runs of water cells on the route (gaps of a single land cell are bridged over)
  const runs = [];
  for (let k = 0; k < n;) {
    if (!isWater[k]) { k++; continue; }
    const a = k;
    while (k < n && isWater[k]) k++;
    const last = runs[runs.length - 1];
    if (last && a - last.b <= 2) last.b = k - 1; else runs.push({ a, b: k - 1, hits: [] });
  }

  // 2. Every geometric crossing of an OSM waterway line (catches drains the raster missed)
  for (let k = 1; k < n; k++) {
    const [ax, ay] = xy[k - 1], [bx, by] = xy[k];
    for (const ww of td.index.waterways.query(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) {
      for (let i = 1; i < ww.coords.length; i++) {
        const [cx, cy] = ww.coords[i - 1], [dx, dy] = ww.coords[i];
        const r = geo.segIntersect(ax, ay, bx, by, cx, cy, dx, dy);
        if (!r) continue;
        const a1 = Math.atan2(by - ay, bx - ax), a2 = Math.atan2(dy - cy, dx - cx);
        let ang = Math.abs(((a1 - a2) * 180) / Math.PI) % 180;
        if (ang > 90) ang = 180 - ang; // acute angle between road and stream, 0..90
        const hitInfo = { k, point: [ax + (bx - ax) * r.t, ay + (by - ay) * r.t], waterway: ww, angleDeg: ang };
        const run = runs.find((ru) => k >= ru.a - 2 && k <= ru.b + 3);
        if (run) run.hits.push(hitInfo);
        else runs.push({ a: k - 1, b: k, hits: [hitInfo], geometricOnly: true });
      }
    }
  }
  runs.sort((p, q) => p.a - q.a);

  // 3. Measure each crossing
  return runs.map((run, i) => {
    const lo = Math.max(0, run.a - 2), hi = Math.min(n - 1, run.b + 2);
    const sub = xy.slice(lo, hi + 1);
    const bb = geo.ringsBBox([sub]);
    const polys = [...td.index.waterPolygons.query(bb[0], bb[1], bb[2], bb[3])];
    const { inside, polygons } = lengthInsidePolygons(sub, polys);

    let lineLen = 0, widthSource = polygons.length ? "OSM water polygon" : null, skewDeg = null;
    for (const h of run.hits) {
      const skew = 90 - h.angleDeg;
      skewDeg = skewDeg === null ? skew : Math.max(skewDeg, skew);
      if (polys.some((p) => geo.pointInRings(h.point[0], h.point[1], p.rings))) continue; // already measured by polygon
      const w = h.waterway.widthTagM || WATERWAY_DEFAULT_WIDTH_M[h.waterway.type] || 5;
      lineLen += w / Math.sin((Math.max(h.angleDeg, MIN_CROSSING_ANGLE_DEG) * Math.PI) / 180);
      widthSource = widthSource ? widthSource + " + line" : h.waterway.widthTagM ? "OSM width tag" : `default ${h.waterway.type} width (${w} m)`;
    }
    let waterLengthM = inside + lineLen;
    if (waterLengthM <= 0) {
      // Raster says water but no OSM geometry intersects (e.g. water only in the v2 grid)
      for (let k = run.a; k <= run.b; k++) waterLengthM += m.trib[k];
      widthSource = "raster (cost-grid water cells)";
    }

    const bridgeLengthM = waterLengthM + 2 * BRIDGE_END_ALLOWANCE_M;
    const cls = classifyBridge(bridgeLengthM);
    const deckAreaM2 = bridgeLengthM * BRIDGE_DECK_WIDTH_M;
    const mid = run.hits.length ? run.hits[0].point : xy[Math.round((run.a + run.b) / 2)];
    const name = polygons.find((p) => p.name)?.name || run.hits.find((h) => h.waterway.name)?.waterway.name || null;
    const nearBridge = featuresNear([mid, mid], 40, td.index.bridges, (f, ax, ay) =>
      Math.min(...f.coords.slice(1).map((c, j) => geo.pointSegDist(ax, ay, f.coords[j][0], f.coords[j][1], c[0], c[1]))));

    return {
      id: `X${i + 1}`,
      name,
      waterbody: polygons[0]?.water || run.hits[0]?.waterway.type || "water",
      a: run.a, b: run.b,
      waterLengthM, bridgeLengthM, widthSource, skewDeg,
      location: toLonLat(mid),
      existingBridgeNearby: nearBridge.size ? [...nearBridge.keys()][0].name || "unnamed road bridge" : null,
      bridge: { ...cls, deckWidthM: BRIDGE_DECK_WIDTH_M, deckAreaM2, inr: deckAreaM2 * cls.ratePerM2 },
    };
  });
}

// Price one crossing's bridge against the cheapest land-only (flexible pavement) detour
const detourCache = new Map();
function compareWithDetour(crossing, cells, m) {
  const n = cells.length;
  let p = Math.max(0, crossing.a - DETOUR_ENDPOINT_OFFSET_CELLS), q = Math.min(n - 1, crossing.b + DETOUR_ENDPOINT_OFFSET_CELLS);
  while (p > 0 && td.water[cells[p]]) p--;
  while (q < n - 1 && td.water[cells[q]]) q++;
  const directCells = cells.slice(p, q + 1);
  const directLenM = m.chain[q] - m.chain[p];
  const directTrib = polylineMetrics(directCells.map(cellXYOf)).trib;
  const directLand = landForCells(directCells, directTrib);
  const bridgeOptionInr = crossing.bridge.inr + (FLEXIBLE_PAVEMENT_INR_PER_KM * Math.max(0, directLenM - crossing.bridgeLengthM)) / 1000 + directLand.inr;
  const out = {
    directSegmentKm: directLenM / 1000,
    bridgeOptionInr,
    bridgeOptionDetail: `${crossing.bridge.type} ${crossing.bridgeLengthM.toFixed(0)} m + ${(Math.max(0, directLenM - crossing.bridgeLengthM) / 1000).toFixed(2)} km approach road + land`,
    gridCostDirect: astar.pathCost(directCells),
  };

  if (td.water[cells[p]] || td.water[cells[q]]) return { ...out, detourFeasible: false, note: "Route starts/ends in water — no land-only detour to compare." };

  const P = { x: cells[p] % W, y: Math.floor(cells[p] / W) }, Q = { x: cells[q] % W, y: Math.floor(cells[q] / W) };
  const key = `${cells[p]}-${cells[q]}`;
  let det = detourCache.get(key);
  if (det === undefined) {
    const mx = Math.ceil(DETOUR_SEARCH_MARGIN_M / grid.cellWidthM), my = Math.ceil(DETOUR_SEARCH_MARGIN_M / grid.cellHeightM);
    const window = { x0: Math.min(P.x, Q.x) - mx, x1: Math.max(P.x, Q.x) + mx, y0: Math.min(P.y, Q.y) - my, y1: Math.max(P.y, Q.y) + my };
    det = astar.search(P, Q, { extraBlocked: td.water, window });
    if (detourCache.size > 500) detourCache.clear();
    detourCache.set(key, det);
  }
  if (!det) {
    return {
      ...out, detourFeasible: false, cheaper: "bridge", consistent: true,
      note: `No land-only detour exists within ${DETOUR_SEARCH_MARGIN_M / 1000} km — the water body cuts across the area, so a bridge is the only option.`,
    };
  }
  const dm = polylineMetrics(det.cells.map(cellXYOf));
  const detLand = landForCells(det.cells, dm.trib);
  const detourOptionInr = (FLEXIBLE_PAVEMENT_INR_PER_KM * dm.lengthM) / 1000 + detLand.inr;
  const gridCostDetour = astar.pathCost(det.cells);
  const cheaper = bridgeOptionInr <= detourOptionInr ? "bridge" : "detour";
  const gridPrefersBridge = out.gridCostDirect <= gridCostDetour;
  const diff = Math.abs(detourOptionInr - bridgeOptionInr);
  // Water mapped in current OSM but absent from the calibrated grid's water cells: A* never
  // "saw" this crossing, so it made no bridge-vs-detour decision here.
  const gridSawWater = directCells.some((c) => Math.abs(grid.cost[c] - 18) < 1e-4 || Math.abs(grid.cost[c] - 6.3) < 1e-3);
  return {
    ...out,
    detourFeasible: true,
    detourKm: dm.lengthM / 1000,
    extraKm: (dm.lengthM - directLenM) / 1000,
    detourOptionInr,
    detourOptionDetail: `${(dm.lengthM / 1000).toFixed(2)} km flexible pavement + land`,
    gridCostDetour,
    cheaper,
    consistent: cheaper === "bridge",
    gridPrefersBridge,
    gridSawWater,
    note: cheaper === "bridge"
      ? `Bridging is cheaper by ${formatInr(diff)} — consistent with the route crossing here.`
      : !gridSawWater
        ? `A land detour would be ${formatInr(diff)} cheaper. This watercourse is in current OSM but not in the calibrated grid's water cells, so A* did not price it — shift the alignment here.`
        : gridPrefersBridge
          ? `A land detour would be ${formatInr(diff)} cheaper in explicit ₹ terms, yet the grid's water cost (18/cell) favoured the bridge — water may be under-priced at this site.`
          : `A land detour would be ${formatInr(diff)} cheaper; the grid also prefers the detour, so this crossing was forced by the alternative-route penalty.`,
    detourGeometry: astar.cellsToLonLat(det.cells.filter((_, k) => k % 2 === 0 || k === det.cells.length - 1)),
  };
}

function formatInr(v) {
  if (v >= CRORE) return `₹${(v / CRORE).toFixed(2)} Cr`;
  if (v >= LAKH) return `₹${(v / LAKH).toFixed(1)} L`;
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}

// ---------------------------------------------------------------------------------------------
// Main entry: full itemized estimate for one route (array of grid cell indices)
// ---------------------------------------------------------------------------------------------
function analyzeRoute(cells) {
  const xy = cells.map(cellXYOf);
  const m = polylineMetrics(xy);
  const n = cells.length;

  const crossings = detectCrossings(cells, xy, m);
  const onBridge = new Uint8Array(n);
  for (const c of crossings) onBridge.fill(1, c.a, c.b + 1);
  [...crossings].sort((p, q) => q.bridgeLengthM - p.bridgeLengthM).forEach((c, rank) => {
    c.comparison = rank < MAX_DETOUR_EVALUATIONS_PER_ROUTE
      ? compareWithDetour(c, cells, m)
      : { detourFeasible: null, note: "Not evaluated (smaller crossing beyond the per-route detour limit)." };
  });

  const earthwork = earthworkFor(cells, m, onBridge);
  const land = landForCells(cells, m.trib);
  const structuresInRow = featuresNear(xy, ROW_WIDTH_M / 2, td.index.buildings, polygonSegDist);
  const structuresInr = structuresInRow.size * STRUCTURE_COMPENSATION_INR_PER_BUILDING;

  const bridgeLengthM = crossings.reduce((s, c) => s + c.bridgeLengthM, 0);
  const bridgesInr = crossings.reduce((s, c) => s + c.bridge.inr, 0);
  const pavedKm = Math.max(0, m.lengthM - bridgeLengthM) / 1000;
  const pavementInr = pavedKm * FLEXIBLE_PAVEMENT_INR_PER_KM;
  const forestHa = (land.forestLengthM * ROW_WIDTH_M) / 1e4;
  const forestInr = forestHa * (FOREST_NPV_INR_PER_HA + COMPENSATORY_AFFORESTATION_INR_PER_HA);

  const cost = {
    pavement: { inr: pavementInr, lengthKm: pavedKm, ratePerKmInr: FLEXIBLE_PAVEMENT_INR_PER_KM },
    earthwork: {
      inr: earthwork.inr, cutM3: earthwork.cutM3, fillM3: earthwork.fillM3,
      maxCutM: earthwork.maxCutM, maxFillM: earthwork.maxFillM, designMaxGradePct: DESIGN_MAX_GRADE_PCT,
    },
    landAcquisition: {
      inr: land.inr + structuresInr, landInr: land.inr, hectares: land.hectares, rowWidthM: ROW_WIDTH_M, byType: land.byType,
      structures: { count: structuresInRow.size, inr: structuresInr, ratePerBuildingInr: STRUCTURE_COMPENSATION_INR_PER_BUILDING },
    },
    bridges: { inr: bridgesInr, count: crossings.length, totalLengthM: bridgeLengthM, crossings },
    forest: {
      inr: forestInr, hectares: forestHa, lengthM: land.forestLengthM,
      sharePct: m.lengthM ? (100 * land.forestLengthM) / m.lengthM : 0,
      npvPerHaInr: FOREST_NPV_INR_PER_HA, caPerHaInr: COMPENSATORY_AFFORESTATION_INR_PER_HA,
    },
  };
  cost.totalInr = pavementInr + earthwork.inr + cost.landAcquisition.inr + bridgesInr + forestInr;

  return {
    cells, xy, metrics: m, onBridge, crossings, cost,
    profile: earthwork.profile,
    structuresInRow: [...structuresInRow.entries()].map(([b, d]) => ({ id: b.id, distanceM: d })),
    religiousNearby: [...featuresNear(xy, 500, td.index.religious, religiousSegDist).entries()]
      .map(([r, d]) => ({ id: r.id, name: r.name, kind: r.kind, distanceM: d })).sort((a, b) => a.distanceM - b.distanceM),
    buildingsCrossed: [...featuresNear(xy, 0, td.index.buildings, polygonSegDist).keys()].map((b) => b.id),
  };
}

const ASSUMPTIONS = {
  ROW_WIDTH_M, ROADWAY_FORMATION_WIDTH_M, FLEXIBLE_PAVEMENT_INR_PER_KM,
  EARTHWORK_CUT_INR_PER_M3, EARTHWORK_FILL_INR_PER_M3, CUT_SIDE_SLOPE_H_PER_V, FILL_SIDE_SLOPE_H_PER_V,
  DESIGN_MAX_GRADE_PCT, DEM_SMOOTHING_WINDOW_M,
  BRIDGE_DECK_WIDTH_M, BRIDGE_END_ALLOWANCE_M, CULVERT_MAX_LENGTH_M, MINOR_BRIDGE_MAX_LENGTH_M,
  RCC_SLAB_BRIDGE_INR_PER_M2, RCC_BOX_GIRDER_BRIDGE_INR_PER_M2, WATERWAY_DEFAULT_WIDTH_M,
  LAND_MARKET_VALUE_INR_PER_HA, RFCTLARR_MULTIPLIER, RFCTLARR_SOLATIUM, STRUCTURE_COMPENSATION_INR_PER_BUILDING,
  FOREST_NPV_INR_PER_HA, COMPENSATORY_AFFORESTATION_INR_PER_HA,
  DETOUR_SEARCH_MARGIN_M,
};

module.exports = { analyzeRoute, formatInr, polylineMetrics, featuresNear, religiousSegDist, ROW_WIDTH_M, ASSUMPTIONS };
