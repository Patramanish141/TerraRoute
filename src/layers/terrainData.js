// Loads the per-cell layers (DEM, land class, water, roads) and the OSM vector features once at
// startup, projects features into the grid-aligned metric frame and builds spatial indexes.
// Produced by scripts/fetch_dem.js and scripts/build_layers.js.
const fs = require("fs");
const path = require("path");
const geo = require("../core/geometry");
const { grid } = require("../core/astar");
const paths = require("../config/paths");

const readJson = (p) => {
  if (!fs.existsSync(p)) throw new Error(`Missing ${path.relative(paths.ROOT, p)} — run: node scripts/fetch_dem.js && node scripts/build_layers.js`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
};

const dem = readJson(paths.DEM_GRID);
const layers = readJson(paths.LAYERS_V3);
const features = readJson(paths.OSM_FEATURES);
if (dem.width !== grid.width || layers.width !== grid.width || dem.height !== grid.height || layers.height !== grid.height)
  throw new Error("DEM/layers do not match the cost grid dimensions — rebuild them.");

const proj = geo.makeProjection(grid);
const N = grid.width * grid.height;

// Water = OSM water (polygons + waterway lines) OR the calibrated grid's water cells
// (cost 18 = water, 6.3 = water under an existing road bridge, i.e. 18 x 0.35).
const water = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const c = grid.cost[i];
  water[i] = layers.water[i] || Math.abs(c - 18) < 1e-4 || Math.abs(c - 6.3) < 1e-3 ? 1 : 0;
}

const withBBox = (f, rings) => ({ ...f, rings, bbox: geo.ringsBBox(rings) });
const toXYRings = (rings) => rings.map((r) => r.map(([lon, lat]) => proj.toXY(lon, lat)));

const buildings = features.buildings.map((b) => withBBox({ id: b.id }, toXYRings(b.rings)));
const religious = features.religious.map((r) => {
  const base = { id: r.id, name: r.name, kind: r.kind, religion: r.religion };
  if (r.geometry.type === "Point") {
    const [X, Y] = proj.toXY(...r.geometry.coordinates);
    return { ...base, point: [X, Y], bbox: [X, Y, X, Y], lonlat: r.geometry.coordinates };
  }
  const rings = toXYRings(r.geometry.rings);
  const ring0 = r.geometry.rings[0];
  const lonlat = [ring0.reduce((s, p) => s + p[0], 0) / ring0.length, ring0.reduce((s, p) => s + p[1], 0) / ring0.length];
  return { ...withBBox(base, rings), lonlat };
});
const waterPolygons = features.waterPolygons.map((w) => withBBox({ id: w.id, name: w.name, water: w.water }, toXYRings(w.rings)));
const waterways = features.waterways.map((w) => {
  const coords = w.coords.map(([lon, lat]) => proj.toXY(lon, lat));
  return { id: w.id, name: w.name, type: w.type, widthTagM: w.widthTagM, coords, bbox: geo.ringsBBox([coords]) };
});
const bridges = features.bridges.map((b) => {
  const coords = b.coords.map(([lon, lat]) => proj.toXY(lon, lat));
  return { id: b.id, name: b.name, highway: b.highway, coords, bbox: geo.ringsBBox([coords]) };
});

function indexOf(items) {
  const idx = new geo.BucketIndex(250);
  for (const it of items) idx.insert(it, it.bbox);
  return idx;
}

module.exports = {
  proj,
  elev: Float32Array.from(dem.elev),
  demSource: dem.source,
  landClass: Uint8Array.from(layers.landClass),
  landClassNames: layers.landClassNames,
  water,
  river: Uint8Array.from(layers.river),
  roadWidthM: Uint8Array.from(layers.roadWidthM),
  religiousBlocked: Uint8Array.from(layers.religiousBlocked),
  buildings, religious, waterPolygons, waterways, bridges,
  index: {
    buildings: indexOf(buildings), religious: indexOf(religious), waterPolygons: indexOf(waterPolygons),
    waterways: indexOf(waterways), bridges: indexOf(bridges),
  },
  cellXY: (i) => proj.cellXY(i % grid.width, Math.floor(i / grid.width)),
  featureMeta: features.meta,
};
