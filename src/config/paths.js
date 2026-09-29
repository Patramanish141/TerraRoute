// Single source of truth for every file location the app and the build scripts use.
// Nothing else in the codebase should join paths against the project root, so moving a
// data folder means editing this file only.
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const DATA = path.join(ROOT, "data");

module.exports = {
  ROOT,
  DATA,
  PUBLIC_DIR: path.join(ROOT, "public"),

  // data/grids — the A* cost grids (one number per ~30 m cell)
  GRIDS_DIR: path.join(DATA, "grids"),
  GRID_V2: path.join(DATA, "grids", "cost_grid_v2.json"), // original calibrated grid (legacy comparison)
  GRID_V3: path.join(DATA, "grids", "cost_grid_v3.json"), // v2 + religious/building blocks + water re-pricing

  // data/layers — derived per-cell rasters and vector features used for pricing and checks
  LAYERS_DIR: path.join(DATA, "layers"),
  DEM_GRID: path.join(DATA, "layers", "dem_grid.json"),
  LAYERS_V3: path.join(DATA, "layers", "layers_v3.json"),
  OSM_FEATURES: path.join(DATA, "layers", "osm_features.json"),

  // data/raw — downloaded source data, never edited by hand
  OSM_DIR: path.join(DATA, "raw", "osm"),
  DEM_TILES_DIR: path.join(DATA, "raw", "dem_tiles"),
};
