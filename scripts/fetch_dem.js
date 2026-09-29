// Downloads a DEM for the cost-grid bbox and resamples it onto the cost grid (same width,
// height, bounds and cell convention as astar.js) -> data/layers/dem_grid.json.
//
// Source: AWS Open Data "Terrain Tiles" in Terrarium PNG encoding (Mapzen/Tilezen). Over India
// these tiles are built from SRTM (~30 m), the same DEM family used for cost_grid_v2.
// Terrarium decoding: elevation_m = (R * 256 + G + B / 256) - 32768.
//
// The per-cell elevation is needed for the explicit earthwork (cut/fill) estimate, the slope
// constraint check and the floodplain (height-above-river) check — cost_grid_v2 only stores the
// combined routing cost, from which slope cannot be separated back out.
//
// Usage: node scripts/fetch_dem.js
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const ZOOM = 13; // ~17.6 m/pixel at this latitude — finer than the ~30 m grid and the SRTM source
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const paths = require("../src/config/paths");
const CACHE_DIR = paths.DEM_TILES_DIR;

const grid = JSON.parse(fs.readFileSync(paths.GRID_V2, "utf8"));
const { width, height, bounds } = grid;

const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latToTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

async function loadTile(x, y) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${ZOOM}_${x}_${y}.png`);
  if (!fs.existsSync(file)) {
    const res = await fetch(TILE_URL(ZOOM, x, y), { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`tile ${x},${y}: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`  downloaded tile ${ZOOM}/${x}/${y}`);
  }
  const png = PNG.sync.read(fs.readFileSync(file));
  const elev = new Float32Array(png.width * png.height);
  for (let i = 0; i < elev.length; i++) {
    const r = png.data[i * 4], g = png.data[i * 4 + 1], b = png.data[i * 4 + 2];
    elev[i] = r * 256 + g + b / 256 - 32768;
  }
  return { w: png.width, h: png.height, elev };
}

async function main() {
  const x0 = Math.floor(lonToTileX(bounds.minLon, ZOOM)), x1 = Math.floor(lonToTileX(bounds.maxLon, ZOOM));
  const y0 = Math.floor(latToTileY(bounds.maxLat, ZOOM)), y1 = Math.floor(latToTileY(bounds.minLat, ZOOM));
  console.log(`Fetching ${(x1 - x0 + 1) * (y1 - y0 + 1)} Terrarium tiles (z${ZOOM}, x ${x0}-${x1}, y ${y0}-${y1})`);
  const tiles = new Map();
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) tiles.set(`${tx},${ty}`, await loadTile(tx, ty));

  // Global-pixel sampler with bilinear interpolation across tile borders
  const pixel = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = tiles.get(`${tx},${ty}`);
    return t.elev[(gy - ty * 256) * 256 + (gx - tx * 256)];
  };
  const sample = (lat, lon) => {
    const fx = lonToTileX(lon, ZOOM) * 256 - 0.5, fy = latToTileY(lat, ZOOM) * 256 - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
    return (
      pixel(ix, iy) * (1 - ax) * (1 - ay) + pixel(ix + 1, iy) * ax * (1 - ay) +
      pixel(ix, iy + 1) * (1 - ax) * ay + pixel(ix + 1, iy + 1) * ax * ay
    );
  };

  // Same cell -> lat/lon convention as astar.js pixelToLatLon()
  const elev = new Array(width * height);
  let mn = Infinity, mx = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const lon = bounds.minLon + (Math.min(x, width - 1) / width) * (bounds.maxLon - bounds.minLon);
      const lat = bounds.maxLat - (Math.min(y, height - 1) / height) * (bounds.maxLat - bounds.minLat);
      const e = Math.round(sample(lat, lon) * 10) / 10;
      elev[y * width + x] = e;
      if (e < mn) mn = e;
      if (e > mx) mx = e;
    }
  }
  const out = { source: "AWS Terrain Tiles (Terrarium, SRTM-derived)", zoom: ZOOM, width, height, bounds, elev };
  fs.writeFileSync(paths.DEM_GRID, JSON.stringify(out));
  console.log(`Wrote data/layers/dem_grid.json (${width}x${height}), elevation range ${mn} – ${mx} m`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
