// Builds the extra data layers the multi-route planner needs, from the OSM XML files in
// data/raw/osm/ (the original map.osm export + the full-bbox region_*.osm files from fetch_osm.js).
//
// Outputs:
//   data/grids/cost_grid_v3.json  — cost_grid_v2 (calibrated slope/water/forest/road/building costs,
//                             untouched) + religious sites rasterized as IMPASSABLE with a buffer.
//   data/layers/layers_v3.json    — per-cell rasters aligned with the grid: land class (for land
//                             acquisition ₹/ha), water, river (floodplain check), existing road width.
//   data/layers/osm_features.json — vector features (lon/lat) used for exact geometric checks at runtime:
//                             buildings, religious sites, water polygons, waterway lines, bridges.
//
// OSM parsing follows the usual fast-xml-parser pattern: parse <node>/<way>/<relation>, index
// nodes by id, resolve way <nd ref> lists into coordinates, classify by tags.
//
// Usage: node scripts/build_layers.js
const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const geo = require("../src/core/geometry");
const paths = require("../src/config/paths");

// ------------------------------------------------------------------------------------------
// Configuration (assumptions — tune here and re-run the script)
// ------------------------------------------------------------------------------------------

// Safety buffer around every religious site, rasterized CONSERVATIVELY (any cell whose square
// comes within this distance is blocked). 20 m > half the 30 m right-of-way (15 m), so the
// road's full ROW can never overlap a religious structure, with 5 m to spare.
// (Buildings in cost_grid_v2 use a 10 m buffer; religious sites get a larger one because
// relocating a religious structure is, in practice, not an option in Indian highway siting.)
const RELIGIOUS_SITE_BUFFER_M = 20;

// Buildings: same 10 m safety buffer as cost_grid_v2 (cells whose centre is within 10 m of a
// footprint), PLUS every cell the footprint itself touches. v2 was built from an older OSM
// snapshot — 107 of the current 1,666 buildings had no blocked cell at all, and the constraint
// checker caught routes passing straight through them — so v3 re-applies the building rule to
// the current OSM buildings. This only ADDS blocked cells; v2's existing blocks are kept.
const BUILDING_SAFETY_BUFFER_M = 10;

// Water: cost_grid_v2's water layer (cost 18/cell) mostly came from waterway LINES. 3,043 cells
// inside OSM water POLYGONS (large parts of the Brahmani riverbank, ponds, lakes) were priced
// as land — 1,074 of them at exactly 1.0 (a flat SRTM water surface reads as zero slope), i.e.
// CHEAPER than ordinary ground, so least-cost routes ran lengthwise down the riverbed. With this
// flag on, v3 applies the calibrated v2 water cost to those cells (18, or 18 x the 0.35 road
// discount where an existing road bridge crosses — the same 6.3 value v2 uses).
const APPLY_WATER_COST_TO_OSM_WATER_POLYGONS = true;
const WATER_CELL_COST = 18;      // calibrated v2 value (~8–10x flat terrain)
const ROAD_DISCOUNT = 0.35;      // calibrated v2 value; v2 road cells have cost < 1

// Religious sites mapped only as a point (node) get this assumed footprint radius before the
// buffer is applied (typical small temple / shrine plot).
const RELIGIOUS_POINT_FOOTPRINT_RADIUS_M = 10;

// Treat burial grounds (amenity=grave_yard, landuse=cemetery) as religious sites. They are
// handled like places of worship in Indian R&R practice (relocation is socially infeasible).
const INCLUDE_BURIAL_GROUNDS = true;

// Unclassified land (no OSM landuse polygon) within this distance of a mapped building is
// treated as village "settlement / homestead" land rather than open rural land — OSM landuse
// coverage here is sparse, but building coverage is good.
const SETTLEMENT_PROXIMITY_M = 50;

// Approximate existing carriageway + shoulder width by OSM highway class. Where a new
// alignment runs ALONG an existing road, this width is already public land and is deducted
// from the right-of-way to be acquired.
const EXISTING_ROAD_WIDTH_M = {
  motorway: 20, trunk: 14, primary: 12, secondary: 10, tertiary: 7,
  unclassified: 6, residential: 6, living_street: 5, service: 4, track: 3, road: 5,
};

// Buildings that also carry these tags are religious sites, not ordinary buildings.
const RELIGIOUS_BUILDING_VALUES = new Set(["church", "mosque", "temple", "shrine", "chapel", "cathedral", "gurudwara", "synagogue", "monastery"]);
const WATERWAY_LINE_TYPES = new Set(["river", "stream", "canal", "drain", "ditch", "tidal_channel"]);

// Land classes (index = code stored in layers_v3.json). The ₹/ha rate for each lives in costModel.js.
const LAND_CLASSES = ["rural_unclassified", "agricultural", "forest", "open_scrub", "settlement", "residential", "commercial", "industrial", "institutional", "recreation", "water"];
const LC = Object.fromEntries(LAND_CLASSES.map((n, i) => [n, i]));

function landClassOf(t) {
  const lu = t.landuse, nat = t.natural, lei = t.leisure, am = t.amenity;
  if (nat === "water" || t.water || t.waterway === "riverbank" || lu === "reservoir" || lu === "basin") return LC.water;
  if (lu === "forest" || nat === "wood") return LC.forest;
  if (["farmland", "farmyard", "orchard", "meadow", "plant_nursery", "vineyard", "allotments", "greenhouse_horticulture", "animal_keeping", "aquaculture"].includes(lu)) return LC.agricultural;
  if (["scrub", "grassland", "heath", "sand", "bare_rock", "wetland"].includes(nat) || ["grass", "brownfield", "greenfield"].includes(lu)) return LC.open_scrub;
  if (lu === "residential") return LC.residential;
  if (lu === "commercial" || lu === "retail") return LC.commercial;
  if (["industrial", "railway", "quarry", "landfill", "construction", "garages", "depot", "military"].includes(lu)) return LC.industrial;
  if (["education", "institutional"].includes(lu) || ["university", "college", "school", "hospital"].includes(am)) return LC.institutional;
  if (["park", "garden", "pitch", "stadium", "playground", "sports_centre", "golf_course", "common", "track"].includes(lei) || ["recreation_ground", "village_green"].includes(lu)) return LC.recreation;
  return -1;
}

function religiousKind(t) {
  if (t.amenity === "place_of_worship" || RELIGIOUS_BUILDING_VALUES.has(t.building) || t.landuse === "religious") return "place_of_worship";
  if (t.historic === "wayside_shrine") return "wayside_shrine";
  if (INCLUDE_BURIAL_GROUNDS && (t.amenity === "grave_yard" || t.landuse === "cemetery")) return "burial_ground";
  return null;
}

// ------------------------------------------------------------------------------------------

const OSM_DIR = paths.OSM_DIR;
const grid = JSON.parse(fs.readFileSync(paths.GRID_V2, "utf8"));
const { width: W, height: H, bounds } = grid;
const proj = geo.makeProjection(grid);
const round7 = (v) => Math.round(v * 1e7) / 1e7;

// ---------- 1. Parse + merge every OSM XML file ----------
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => ["node", "way", "relation", "tag", "nd", "member"].includes(name),
});
const nodes = new Map(), ways = new Map(), relations = new Map();
const tagsOf = (e) => Object.fromEntries((e.tag || []).map((t) => [t.k, t.v]));
const perFile = {};

for (const file of fs.readdirSync(OSM_DIR).filter((f) => f.endsWith(".osm")).sort()) {
  const osm = parser.parse(fs.readFileSync(path.join(OSM_DIR, file), "utf8")).osm;
  for (const n of osm.node || []) {
    const prev = nodes.get(n.id);
    const tags = tagsOf(n);
    nodes.set(n.id, { lon: +n.lon, lat: +n.lat, tags: Object.keys(tags).length ? tags : prev ? prev.tags : tags });
  }
  for (const w of osm.way || []) {
    const prev = ways.get(w.id);
    const tags = tagsOf(w);
    ways.set(w.id, { id: w.id, refs: (w.nd || []).map((nd) => nd.ref), tags: Object.keys(tags).length ? tags : prev ? prev.tags : tags });
  }
  for (const r of osm.relation || []) relations.set(r.id, { id: r.id, tags: tagsOf(r), members: r.member || [] });
  perFile[file] = { nodes: (osm.node || []).length, ways: (osm.way || []).length, relations: (osm.relation || []).length };
}
console.log("Parsed OSM files:", perFile);
console.log(`Merged: ${nodes.size} nodes, ${ways.size} ways, ${relations.size} relations`);

// ---------- 2. Geometry assembly ----------
const wayLonLat = (w) => {
  const pts = [];
  for (const ref of w.refs) {
    const n = nodes.get(ref);
    if (!n) return null; // incomplete way (node outside the downloaded extract)
    pts.push([round7(n.lon), round7(n.lat)]);
  }
  return pts.length >= 2 ? pts : null;
};
const isClosed = (w) => w.refs.length >= 4 && w.refs[0] === w.refs[w.refs.length - 1];

// Stitch multipolygon member ways into closed rings (join end-to-end by shared node ids).
function assembleRings(memberWays) {
  const pool = memberWays.filter((w) => w && w.refs.length >= 2).map((w) => w.refs.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.shift();
    let guard = 0;
    while (ring[0] !== ring[ring.length - 1] && guard++ < 10000) {
      const end = ring[ring.length - 1];
      const i = pool.findIndex((r) => r[0] === end || r[r.length - 1] === end);
      if (i < 0) break;
      const next = pool.splice(i, 1)[0];
      ring = ring.concat((next[0] === end ? next : next.reverse()).slice(1));
    }
    if (ring[0] === ring[ring.length - 1] && ring.length >= 4) {
      const pts = ring.map((ref) => nodes.get(ref)).filter(Boolean).map((n) => [round7(n.lon), round7(n.lat)]);
      if (pts.length === ring.length) rings.push(pts);
    }
  }
  return rings;
}

// Collect every area feature (closed way or multipolygon relation) with its tags.
const areas = [];
for (const w of ways.values()) {
  if (!isClosed(w) || WATERWAY_LINE_TYPES.has(w.tags.waterway) || w.tags.highway && !w.tags.area) continue;
  const pts = wayLonLat(w);
  if (pts) areas.push({ id: "w" + w.id, tags: w.tags, rings: [pts] });
}
for (const r of relations.values()) {
  if (r.tags.type !== "multipolygon") continue;
  const outer = r.members.filter((m) => m.type === "way" && m.role !== "inner").map((m) => ways.get(m.ref));
  const inner = r.members.filter((m) => m.type === "way" && m.role === "inner").map((m) => ways.get(m.ref));
  const rings = assembleRings(outer).concat(assembleRings(inner));
  if (rings.length) areas.push({ id: "r" + r.id, tags: r.tags, rings });
}

// Keep only features touching the grid bbox (+ ~200 m margin)
const M = 0.002;
const touchesGrid = (coords) => coords.some(([lon, lat]) => lon >= bounds.minLon - M && lon <= bounds.maxLon + M && lat >= bounds.minLat - M && lat <= bounds.maxLat + M);
const ringsXY = (rings) => rings.map((ring) => ring.map(([lon, lat]) => proj.toXY(lon, lat)));

// ---------- 3. Classify ----------
const features = { buildings: [], religious: [], waterPolygons: [], waterways: [], bridges: [], meta: {} };
const landAreas = [];

for (const a of areas) {
  if (!touchesGrid(a.rings[0])) continue;
  const rk = religiousKind(a.tags);
  if (rk) {
    features.religious.push({ id: a.id, name: a.tags.name || null, kind: rk, religion: a.tags.religion || null, geometry: { type: "Polygon", rings: a.rings } });
    continue;
  }
  if (a.tags.building) features.buildings.push({ id: a.id, rings: a.rings });
  const lc = landClassOf(a.tags);
  if (lc === LC.water) features.waterPolygons.push({ id: a.id, name: a.tags.name || null, water: a.tags.water || a.tags.natural || a.tags.landuse || a.tags.waterway, rings: a.rings });
  if (lc >= 0 && !a.tags.building) landAreas.push({ lc, rings: a.rings, area: geo.ringArea(ringsXY(a.rings)[0]) });
}
for (const [id, n] of nodes) {
  const rk = n.tags && religiousKind(n.tags);
  if (rk && touchesGrid([[n.lon, n.lat]]))
    features.religious.push({ id: "n" + id, name: n.tags.name || null, kind: rk, religion: n.tags.religion || null, geometry: { type: "Point", coordinates: [round7(n.lon), round7(n.lat)] } });
}
// A place_of_worship node inside a mapped temple polygon is the same site — keep the polygon.
features.religious = features.religious.filter((f) => {
  if (f.geometry.type !== "Point") return true;
  const [X, Y] = proj.toXY(...f.geometry.coordinates);
  return !features.religious.some((p) => p.geometry.type === "Polygon" && geo.pointInRings(X, Y, ringsXY(p.geometry.rings)));
});

for (const w of ways.values()) {
  const t = w.tags;
  const pts = wayLonLat(w);
  if (!pts || !touchesGrid(pts)) continue;
  if (WATERWAY_LINE_TYPES.has(t.waterway)) {
    const width = parseFloat(t.width);
    features.waterways.push({ id: "w" + w.id, name: t.name || null, type: t.waterway, widthTagM: isFinite(width) ? width : null, coords: pts });
  }
  if (t.highway && t.bridge && t.bridge !== "no") features.bridges.push({ id: "w" + w.id, name: t.name || null, highway: t.highway, coords: pts });
}

// ---------- 4. Rasterize ----------
const N = W * H;
const landClass = new Uint8Array(N); // 0 = rural_unclassified
const water = new Uint8Array(N);
const river = new Uint8Array(N);
const roadWidthM = new Uint8Array(N);
const religiousBlocked = new Uint8Array(N);
const nearBuilding = new Uint8Array(N);
const waterPolygonCell = new Uint8Array(N);

// Land class: paint largest polygons first so smaller, more specific ones win.
landAreas.sort((a, b) => b.area - a.area);
for (const la of landAreas) geo.rasterizePolygon(grid, ringsXY(la.rings), 0, false, (i) => (landClass[i] = la.lc));

// Water: polygons by cell centre; waterway lines by supercover (+ half the tagged width) so a
// stream always forms a 4-connected barrier for the land-only detour search.
for (const wp of features.waterPolygons) {
  const isRiver = /river/.test(wp.water || ""); // water=river or waterway=riverbank
  geo.rasterizePolygon(grid, ringsXY(wp.rings), 0, false, (i) => { water[i] = 1; waterPolygonCell[i] = 1; landClass[i] = LC.water; if (isRiver) river[i] = 1; });
}
for (const ww of features.waterways) {
  const xy = ww.coords.map(([lon, lat]) => proj.toXY(lon, lat));
  geo.rasterizePolyline(grid, xy, (ww.widthTagM || 0) / 2, (i) => { water[i] = 1; if (ww.type === "river") river[i] = 1; });
}

// Existing road width (public land already owned)
for (const w of ways.values()) {
  const width = EXISTING_ROAD_WIDTH_M[(w.tags.highway || "").replace("_link", "")];
  if (!width) continue;
  const pts = wayLonLat(w);
  if (!pts || !touchesGrid(pts)) continue;
  geo.rasterizePolyline(grid, pts.map(([lon, lat]) => proj.toXY(lon, lat)), 0, (i) => { if (width > roadWidthM[i]) roadWidthM[i] = width; });
}

// Settlement inference around buildings
for (const b of features.buildings) geo.rasterizePolygon(grid, ringsXY(b.rings), SETTLEMENT_PROXIMITY_M, false, (i) => (nearBuilding[i] = 1));
for (let i = 0; i < N; i++) if (landClass[i] === LC.rural_unclassified && nearBuilding[i]) landClass[i] = LC.settlement;

// Religious sites -> impassable (conservative raster, so no step between two free cell
// centres can pass within RELIGIOUS_SITE_BUFFER_M of the site)
for (const r of features.religious) {
  const mark = (i) => (religiousBlocked[i] = 1);
  if (r.geometry.type === "Point") {
    const [X, Y] = proj.toXY(...r.geometry.coordinates);
    geo.rasterizeDisc(grid, X, Y, RELIGIOUS_POINT_FOOTPRINT_RADIUS_M + RELIGIOUS_SITE_BUFFER_M, mark);
  } else {
    geo.rasterizePolygon(grid, ringsXY(r.geometry.rings), RELIGIOUS_SITE_BUFFER_M, true, mark);
  }
}

// Current OSM buildings -> impassable (10 m centre buffer + touched cells, see config above)
const buildingBlocked = new Uint8Array(N);
for (const b of features.buildings) {
  const rings = ringsXY(b.rings);
  const mark = (i) => (buildingBlocked[i] = 1);
  geo.rasterizePolygonCentres(grid, rings, BUILDING_SAFETY_BUFFER_M, mark);
  geo.rasterizePolygon(grid, rings, 0, true, mark);
}

// ---------- 5. Write outputs ----------
const BLOCKED = 1e9;
const cost3 = grid.cost.slice();
let newlyBlocked = 0, newlyBlockedBuildings = 0, repricedWater = 0;
const isGridWater = (c) => Math.abs(c - WATER_CELL_COST) < 1e-4 || Math.abs(c - WATER_CELL_COST * ROAD_DISCOUNT) < 1e-3;
if (APPLY_WATER_COST_TO_OSM_WATER_POLYGONS) {
  for (let i = 0; i < N; i++) {
    if (!waterPolygonCell[i] || cost3[i] >= 1e8 || isGridWater(cost3[i])) continue;
    cost3[i] = cost3[i] < 1 ? WATER_CELL_COST * ROAD_DISCOUNT : WATER_CELL_COST;
    repricedWater++;
  }
}
for (let i = 0; i < N; i++) if (religiousBlocked[i] && cost3[i] < 1e8) { cost3[i] = BLOCKED; newlyBlocked++; }
for (let i = 0; i < N; i++) if (buildingBlocked[i] && cost3[i] < 1e8) { cost3[i] = BLOCKED; newlyBlockedBuildings++; }

fs.writeFileSync(paths.GRID_V3, JSON.stringify({
  ...grid,
  cost: cost3,
  derivedFrom: "cost_grid_v2.json + religious sites + current OSM buildings + OSM water polygons at the v2 water cost (scripts/build_layers.js)",
  religiousSiteBufferM: RELIGIOUS_SITE_BUFFER_M,
  buildingSafetyBufferM: BUILDING_SAFETY_BUFFER_M,
}));

const count = (arr) => arr.reduce((s, v) => s + (v ? 1 : 0), 0);
const lcCounts = Object.fromEntries(LAND_CLASSES.map((n, i) => [n, 0]));
for (let i = 0; i < N; i++) lcCounts[LAND_CLASSES[landClass[i]]]++;

fs.writeFileSync(paths.LAYERS_V3, JSON.stringify({
  width: W, height: H, bounds,
  landClassNames: LAND_CLASSES,
  landClass: Array.from(landClass),
  water: Array.from(water),
  river: Array.from(river),
  roadWidthM: Array.from(roadWidthM),
  religiousBlocked: Array.from(religiousBlocked),
}));

features.meta = {
  builtAt: new Date().toISOString(),
  sources: Object.keys(perFile),
  religiousSiteBufferM: RELIGIOUS_SITE_BUFFER_M,
  religiousPointFootprintRadiusM: RELIGIOUS_POINT_FOOTPRINT_RADIUS_M,
  counts: {
    buildings: features.buildings.length, religious: features.religious.length, waterPolygons: features.waterPolygons.length,
    waterways: features.waterways.length, bridges: features.bridges.length,
  },
};
fs.writeFileSync(paths.OSM_FEATURES, JSON.stringify(features));

// ---------- 6. Diagnostics ----------
console.log("Feature counts:", features.meta.counts);
console.log("Religious sites:");
for (const r of features.religious) {
  const c = r.geometry.type === "Point" ? r.geometry.coordinates : r.geometry.rings[0][0];
  console.log(`  ${r.id.padEnd(12)} ${r.kind.padEnd(16)} ${(r.name || "(unnamed)").padEnd(34)} ${r.religion || ""} @ ${c[1].toFixed(5)},${c[0].toFixed(5)}`);
}
console.log(`Religious cells blocked: ${count(religiousBlocked)} (${newlyBlocked} newly blocked vs v2)`);
console.log(`Water-polygon cells re-priced from land to the v2 water cost: ${repricedWater}`);
console.log(`Building cells blocked: ${count(buildingBlocked)} (${newlyBlockedBuildings} newly blocked vs v2; v2 had ${grid.cost.filter((c) => c >= 1e8).length} blocked cells in total)`);
console.log("Land class cells:", lcCounts);
let gridWater = 0, both = 0;
for (let i = 0; i < N; i++) {
  const gw = Math.abs(grid.cost[i] - 18) < 1e-6 || Math.abs(grid.cost[i] - 6.3) < 1e-3;
  if (gw) { gridWater++; if (water[i]) both++; }
}
console.log(`Water cells: OSM ${count(water)}, grid-v2 (cost 18) ${gridWater}, overlap ${both} (${((100 * both) / gridWater).toFixed(1)}% of grid water)`);
console.log(`River cells: ${count(river)}, road cells: ${count(roadWidthM)}`);
console.log("Wrote data/grids/cost_grid_v3.json, data/layers/layers_v3.json, data/layers/osm_features.json");
