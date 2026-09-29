// Fetches OSM XML for the FULL cost-grid bounding box from the Overpass API and saves it
// next to the original export (data/raw/osm/map.osm).
//
// Why this exists: data/raw/osm/map.osm (the original openstreetmap.org export) only covers
// lat 22.21–22.28 / lon 84.85–84.92, i.e. ~26% of the cost grid (22.18–22.26 / 84.78–84.90).
// Religious sites, land-use classes and water geometry are needed for the whole grid (e.g. the
// Vedvyas temples at the Koel–Sankh confluence are outside map.osm), so this pulls the same
// kinds of features for the full grid bbox. The output is plain OSM XML, so build_layers.js
// parses it with exactly the same fast-xml-parser code path as map.osm.
//
// The query is split into small per-feature-family requests because the public Overpass
// server frequently answers heavy queries with HTTP 504 ("too busy"); each part is retried.
//
// Usage: node scripts/fetch_osm.js            (skips parts already downloaded)
//        node scripts/fetch_osm.js --force    (re-downloads everything)
const fs = require("fs");
const path = require("path");

const paths = require("../src/config/paths");

const grid = JSON.parse(fs.readFileSync(paths.GRID_V2, "utf8"));
const { minLat, minLon, maxLat, maxLon } = grid.bounds;
const OSM_DIR = paths.OSM_DIR;
const ENDPOINT = "https://overpass-api.de/api/interpreter";
const USER_AGENT = "TerraRoute-capstone/1.0 (NIT Rourkela student project)";
const MAX_RETRIES = 8;

const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;

// One output file per feature family. Big admin-boundary relations are deliberately excluded.
const PARTS = {
  religious: `
    nwr["amenity"="place_of_worship"];
    nwr["building"~"^(church|mosque|temple|shrine|chapel|cathedral|gurudwara|synagogue|monastery)$"];
    nwr["historic"="wayside_shrine"];
    nwr["amenity"="grave_yard"];
    nwr["landuse"="cemetery"];`,
  water: `
    way["natural"="water"];
    relation["natural"="water"];
    way["waterway"];
    way["water"];
    way["natural"="wetland"];`,
  landcover: `
    way["landuse"];
    relation["landuse"];
    way["natural"~"^(wood|scrub|grassland|heath|sand|bare_rock)$"];
    relation["natural"~"^(wood|scrub|grassland|heath)$"];
    way["leisure"];
    way["amenity"~"^(university|college|school|hospital)$"];
    relation["amenity"~"^(university|college|school|hospital)$"];`,
  highways: `
    way["highway"];`,
  buildings: `
    way["building"];
    relation["building"];`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPart(name, statements) {
  const out = path.join(OSM_DIR, `region_${name}.osm`);
  if (fs.existsSync(out) && !process.argv.includes("--force")) {
    console.log(`[${name}] already downloaded, skipping`);
    return true;
  }
  const query = `[out:xml][timeout:180][bbox:${bbox}];(${statements}\n);out body;>;out skel qt;`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(240000),
      });
      const text = await res.text();
      if (res.ok && text.includes("<osm") && !text.includes("runtime error")) {
        fs.writeFileSync(out, text);
        console.log(`[${name}] saved ${(text.length / 1e6).toFixed(2)} MB -> ${path.basename(out)}`);
        return true;
      }
      console.warn(`[${name}] attempt ${attempt}: HTTP ${res.status} (server busy), retrying...`);
    } catch (err) {
      console.warn(`[${name}] attempt ${attempt}: ${err.message}`);
    }
    await sleep(4000 * attempt);
  }
  return false;
}

async function main() {
  console.log(`Downloading OSM features for grid bbox ${bbox}`);
  let failed = [];
  for (const [name, statements] of Object.entries(PARTS)) {
    if (!(await fetchPart(name, statements))) failed.push(name);
  }
  if (failed.length) {
    console.error(`Failed parts: ${failed.join(", ")} — re-run the script to retry them.`);
    process.exit(1);
  }
}

main();
