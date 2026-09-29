# TerraRoute

Least-cost highway corridor planner for a ~12 × 9 km study area around Rourkela, Odisha.

Click two points on a map; the server searches a calibrated terrain cost grid with A\*, generates
4–5 **meaningfully different** candidate corridors, prices each one in rupees line by line
(pavement, earthwork, land acquisition, bridges, forest compensation), checks each against an
IRC-based siting checklist (11 named conditions), ranks them and selects the top 3.

The point of the project is not just "find a path" — it is that **every number on screen can be
traced back to a named assumption or a piece of source data**.

| | |
|---|---|
| Study area | 22.18–22.26 N, 84.78–84.90 E (Rourkela / NIT Rourkela / Brahmani–Koel–Sankh confluence) |
| Grid | 434 × 289 = 125,426 cells, ~28.5 m × 30.8 m per cell |
| Blocked cells (v3) | 5,138 (buildings + 10 m buffer, religious sites + 20 m buffer, wide water) |
| OSM features loaded | 1,666 buildings, 17 religious sites, 103 water polygons, 47 waterways, 74 existing bridges |
| Elevation | AWS Terrain Tiles (Terrarium PNG, SRTM-derived), z13 ≈ 17.6 m/px, resampled onto the grid |
| Stack | Node.js + Express (no framework on the frontend — plain HTML + Leaflet) |

---

## Quick start

```bash
npm install
npm start                 # http://localhost:3000
npm test                  # end-to-end check against a RUNNING server
```

The committed data in `data/` is enough to run the server. You only need to rebuild it if you
change the study area or a layer rule:

```bash
npm run build:data        # fetch OSM (Overpass) -> fetch DEM tiles -> build layers + cost_grid_v3
npm run build:layers      # just re-run build_layers.js (fast; no downloads)
```

---

## Project structure

```
terraroute_v2/
├── src/
│   ├── server.js                 Express app + HTTP API (the only entry point)
│   ├── planner.js                ORCHESTRATOR: generate -> price -> check -> rank -> select top 3
│   ├── config/
│   │   └── paths.js              every data file location, in one place
│   ├── core/                     geometry + search (no cost/rupee knowledge)
│   │   ├── geometry.js           planar geometry, rasterisation, spatial index
│   │   ├── astar.js              the cost grid + A* least-cost search
│   │   └── candidates.js         iterative-penalty method -> several DISSIMILAR routes
│   ├── layers/
│   │   └── terrainData.js        loads DEM / land class / water / roads / OSM vectors at startup
│   └── analysis/                 turns a found path into defensible numbers
│       ├── costModel.js          itemised ₹ estimate + bridge-vs-detour comparison
│       └── constraints.js        the 11-condition siting checklist (3 hard, 8 soft)
│
├── public/
│   └── index.html                the whole frontend: Leaflet map, comparison table, detail panel
│
├── scripts/                      OFFLINE data pipeline — run manually, not by the server
│   ├── fetch_osm.js              Overpass API -> data/raw/osm/region_*.osm
│   ├── fetch_dem.js              AWS Terrarium tiles -> data/layers/dem_grid.json
│   ├── build_layers.js           OSM XML -> cost_grid_v3 + layers_v3 + osm_features
│   └── test_routes.js            end-to-end test over 3 real start/end pairs
│
└── data/
    ├── grids/
    │   ├── cost_grid_v2.json     ORIGINAL calibrated grid (kept for the "legacy" comparison)
    │   └── cost_grid_v3.json     what the server actually searches (v2 + fixes, see below)
    ├── layers/
    │   ├── dem_grid.json         per-cell elevation (m)
    │   ├── layers_v3.json        per-cell land class / water / river / road width / religious block
    │   └── osm_features.json     vector features in lon/lat for exact geometric checks
    └── raw/
        ├── osm/*.osm             downloaded OSM XML (source of truth for build_layers.js)
        └── dem_tiles/*.png       cached Terrarium tiles
```

**The dependency direction is one-way:** `core` knows nothing about rupees, `analysis` knows
nothing about HTTP, and `planner` is the only module that combines them.

```
server.js ──> planner.js ──> core/candidates.js ──> core/astar.js ──> data/grids/*.json
                    │                                      │
                    ├──> analysis/costModel.js ─────────────┤
                    └──> analysis/constraints.js ───────────┘
                                   │
                              layers/terrainData.js ──> data/layers/*.json
                                   │
                              core/geometry.js
```

---

## What each file does

### Runtime

| File | Role | Key exports |
|---|---|---|
| [src/server.js](src/server.js) | Express server. Serves `public/`, validates coordinates (numeric + inside the grid bbox), exposes the 5 API endpoints. Contains **no** routing logic. | — |
| [src/planner.js](src/planner.js) | The orchestrator, and the file to read first. Snaps the clicked points to passable cells, asks `candidates.js` for alternatives, runs each through `costModel` + `constraints`, ranks them, marks the top 3, and assembles the JSON response (including the `method` block that documents how the answer was produced). | `planRoutes`, `assumptions` |
| [src/core/astar.js](src/core/astar.js) | Loads the cost grid once at startup into a `Float32Array`. Implements A\* over the 8-connected grid with a typed-array binary heap, an **admissible** heuristic (straight-line distance × cheapest cell cost, so the result is the true least-cost path), no diagonal corner-cutting, and snap-to-nearest-passable for clicked points. Also does lat/lon ↔ cell conversion and path measurement. | `search`, `findRoute`, `snapToPassable`, `latLonToPixel`, `pixelToLatLon`, `pathCost`, `grid` |
| [src/core/candidates.js](src/core/candidates.js) | Produces genuinely different corridors by the **iterative penalty method** (Johnson/Joy/Clarke 1992; Akgün/Erkut/Batta 2000): find the best path, multiply the cost of a ~90 m corridor around it by 1.6, search again, accept only if ≤ 50 % of the new path runs alongside an accepted one. Candidates are always reported with their **true, unpenalised** cost. | `generateCandidates` |
| [src/core/geometry.js](src/core/geometry.js) | Dependency-free geometry toolkit shared by the build scripts and the runtime: local metric projection, point/segment/polygon distances, segment intersection, polygon & polyline rasterisation onto the grid, Douglas–Peucker simplification, and a bucket spatial index. | `makeProjection`, `segPolygonDist`, `rasterize*`, `douglasPeucker`, `BucketIndex` |
| [src/layers/terrainData.js](src/layers/terrainData.js) | Loads `dem_grid`, `layers_v3` and `osm_features` once at startup, verifies they match the grid dimensions, projects every vector feature into the grid's metric frame, and builds a bucket index per feature type so "what is near this segment?" is fast. | `elev`, `landClass`, `water`, `river`, `roadWidthM`, `religiousBlocked`, `buildings`, `religious`, `index` |
| [src/analysis/costModel.js](src/analysis/costModel.js) | The rupee side. All cost constants sit at the top of the file with sources/comments. Computes: pavement by length; earthwork by fitting a grade-limited design profile to the smoothed DEM and integrating cut/fill volumes; land acquisition per cell by land class (RFCTLARR multiplier + 100 % solatium, minus existing road width where the route follows a road); water crossings detected from both the raster and OSM waterway geometry, measured, classified (culvert / minor / major) and priced per m² of deck; forest NPV + compensatory afforestation. For each crossing it also searches a **land-only detour** and reports whether bridging was actually the cheaper choice. | `analyzeRoute`, `ASSUMPTIONS`, `ROW_WIDTH_M`, `formatInr` |
| [src/analysis/constraints.js](src/analysis/constraints.js) | The field-engineer checklist. 3 **hard** conditions (no building crossed, no religious site inside the ROW, every crossing bridgeable ≤ 500 m) and 8 **soft** ones (gradient, religious buffer zone, buildings in ROW, forest share, floodplain share, minimum curve radius, bridge skew, circuity). Builds a height-above-nearest-river map at startup via a chamfer distance transform for the floodplain test. Each item reports `passed`, its measured value and its limit. | `evaluateConstraints`, `THRESHOLDS` |
| [src/config/paths.js](src/config/paths.js) | Every path to every data file. Nothing else joins paths against the project root. | path constants |
| [public/index.html](public/index.html) | Self-contained frontend (~530 lines: CSS + HTML + JS). Leaflet map, click two points, draws all candidates in distinct colours, comparison table, per-route detail panel with the cost breakdown, the checklist and the bridge-vs-detour bars, plus a collapsible dump of every assumption from `/api/assumptions`. | — |

### Offline data pipeline (`scripts/`)

Run in this order. Each one is independent and re-runnable.

| File | What it does | Output |
|---|---|---|
| [scripts/fetch_osm.js](scripts/fetch_osm.js) | Downloads OSM XML for the **full grid bbox** from Overpass, split into 5 small per-family queries (religious, water, landcover, highways, buildings) because the public server answers heavy queries with 504. Retries each part up to 8 times; skips parts already on disk unless `--force`. Exists because the original `map.osm` export covers only ~26 % of the grid. | `data/raw/osm/region_*.osm` |
| [scripts/fetch_dem.js](scripts/fetch_dem.js) | Downloads z13 Terrarium PNG tiles, decodes elevation (`R*256 + G + B/256 − 32768`), bilinearly resamples onto the exact cost-grid cells. Tiles are cached. Needed because `cost_grid_v2` stores only the combined routing cost — slope cannot be separated back out of it. | `data/layers/dem_grid.json` |
| [scripts/build_layers.js](scripts/build_layers.js) | The heart of the pipeline. Parses all OSM XML, resolves ways/relations into rings, classifies features, rasterises them onto the grid, and writes both the v3 cost grid and the per-cell layers. Every rule is a named constant at the top of the file. Prints diagnostics (feature counts, cells newly blocked, cells re-priced, land-class histogram) — worth pasting into the report. | `data/grids/cost_grid_v3.json`, `data/layers/layers_v3.json`, `data/layers/osm_features.json` |
| [scripts/test_routes.js](scripts/test_routes.js) | Hits a running server with 3 real start/end pairs and asserts the invariants: 4–5 candidates, exactly 3 selected, itemised costs sum to the total, 11 checklist items, every bridge priced, no candidate violating H2. Also prints a readable ranking table per pair. | console |

---

## Request flow

What happens on one click-click in the UI:

```
1. BROWSER          public/index.html
                    two map clicks -> GET /api/routes?startLat&startLon&endLat&endLon[&legacy=1]

2. VALIDATE         server.js: parseCoords()
                    all four numeric? inside the grid bbox? -> else 400

3. SNAP             planner.js -> astar.latLonToPixel() + astar.snapToPassable()
                    a click inside a building / temple buffer / wide river is moved to the
                    nearest passable cell (up to 20 cells ≈ 600 m); the response reports how
                    far it moved. No passable cell nearby -> explanatory 404.

4. GENERATE         core/candidates.js  (iterative penalty method)
                    iteration 1: plain A* on cost_grid_v3            -> Route A (the true optimum)
                    iteration n: A* with the penalty multiplier array -> accept if ≤50% overlap
                    until 5 candidates or 16 iterations; if diversity is impossible (single
                    bridge site, narrow valley) the least-overlapping rejects top it up to 4.
                    With legacy=1, one extra A* runs on cost_grid_v2 as "Route L".

5. PRICE            analysis/costModel.js  analyzeRoute(cells)   — per candidate
                    a. polylineMetrics: step lengths, chainage, per-vertex tributary length
                    b. detectCrossings: raster water runs + geometric OSM waterway crossings,
                       measured from polygons / width tags, classified, priced per m² of deck
                    c. compareWithDetour: A* again with water blocked, in a windowed search
                       -> "bridge ₹X vs land detour ₹Y", and whether the grid agreed
                    d. earthworkFor: smooth the DEM, fit a 3.3 %-grade design line, integrate
                       cut/fill prisms with side slopes
                    e. landForCells: ha × ₹/ha by land class, ROW reduced where the route
                       follows an existing road; + structure compensation for buildings in ROW
                    f. forest NPV + compensatory afforestation
                    -> cost.totalInr = pavement + earthwork + land + bridges + forest

6. CHECK            analysis/constraints.js  evaluateConstraints(analysis)
                    11 items, each with value + limit + pass/fail
                    -> hardViolations, softViolations, human-readable summary

7. RANK             planner.js
                    lexicographic: hard violations first (any hard violation ranks below every
                    compliant route, however cheap), then
                        rankScore = totalInr × (1 + 0.10 × softViolations)
                    top 3 marked selected: true

8. RESPOND          JSON: { request, method, routes[], top[], timingMs }
                    each route carries geometry, summary, full cost tree, checklist, ranking

9. RENDER           public/index.html
                    polylines (selected = solid, rejected = dashed), legend, comparison table,
                    detail panel, crossing markers, assumptions dump
```

Typical timing for the study area: **0.5–1.5 s** for the whole 5-candidate study, most of it in
the per-crossing detour searches.

---

## HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /api/routes?startLat=&startLon=&endLat=&endLon=[&legacy=1]` | **The main endpoint.** The full multi-route study described above. `legacy=1` adds the `cost_grid_v2` route so the checker can be seen catching the violations the old grid could not see. |
| `GET /api/route?startLat=&startLon=&endLat=&endLon=` | The original single least-cost route, as a GeoJSON `Feature`. Kept so the earlier version of the project still works. |
| `GET /api/assumptions` | Every cost constant, constraint threshold and ranking parameter, as used by the running server. The UI renders this verbatim — nothing is hard-coded twice. |
| `GET /api/religious-sites` | The 17 religious sites blocked in the grid, for the map overlay. |
| `GET /api/bounds` | The supported lat/lon box (health check + lets the frontend fit the map). |

---

## Where to change things

Every tunable is a **named, commented constant at the top of its file** — nothing is buried in
an expression.

| I want to change… | File | Constants |
|---|---|---|
| Rupee rates (pavement, earthwork, bridge ₹/m², land ₹/ha, forest NPV) | `src/analysis/costModel.js` | `FLEXIBLE_PAVEMENT_INR_PER_KM`, `EARTHWORK_*`, `RCC_*_INR_PER_M2`, `LAND_MARKET_VALUE_INR_PER_HA`, `FOREST_NPV_INR_PER_HA` |
| Cross-section (ROW width, formation width, deck width) | `src/analysis/costModel.js` | `ROW_WIDTH_M`, `ROADWAY_FORMATION_WIDTH_M`, `BRIDGE_DECK_WIDTH_M` |
| Checklist limits (gradient, buffers, forest %, curve radius, skew, circuity) | `src/analysis/constraints.js` | the block under `CONSTRAINT THRESHOLDS` |
| How different the alternatives must be | `src/core/candidates.js` | `NUM_CANDIDATES`, `PENALTY_FACTOR`, `PENALTY_CORRIDOR_M`, `MAX_OVERLAP_SHARE` |
| How hard a soft violation is punished / how many routes are selected | `src/planner.js` | `SOFT_VIOLATION_PENALTY`, `TOP_N` |
| Layer-building rules (buffers, land-class mapping, water re-pricing) | `scripts/build_layers.js` | the `Configuration` block — then `npm run build:layers` |
| Where data files live | `src/config/paths.js` | — |

---

## Data provenance, and what v3 fixed

`cost_grid_v2.json` is the calibrated grid from the earlier version of the project (slope, water,
forest, road discount, blocked buildings baked into one number per cell). Its builder script and
its OSM snapshot were **not** on disk, so the pipeline in `scripts/` re-derives everything it needs
from current sources and *adds to* v2 rather than replacing it. Auditing v2 against current OSM
found two defects, both fixed in v3 by `build_layers.js`:

1. **3,043 cells inside OSM water polygons were priced as land** — large parts of the Brahmani
   riverbank, plus ponds and lakes. 1,074 of them sat at exactly cost 1.0, because a flat SRTM
   water surface reads as zero slope: *cheaper than ordinary ground*, so least-cost routes ran
   lengthwise down the riverbed. v3 applies v2's own calibrated water cost (18, or 6.3 = 18 × 0.35
   under an existing road bridge) to those cells.
2. **107 current OSM buildings had no blocked cell at all** (v2 came from an older snapshot), and
   the constraint checker caught routes passing straight through them. v3 re-applies the 10 m
   building rule to all 1,666 current buildings. v2's existing blocks are never removed.

v3 additionally blocks all 17 religious sites with a 20 m buffer (> half the 30 m ROW), since
relocating a religious structure is not a real option in Indian highway siting. Turning on
`legacy=1` in the UI shows the v2 route being flagged for exactly the violations above.

## Caveats to state before presenting

- **Every ₹ figure marked `ESTIMATE` in `costModel.js` is a feasibility-level judgement call, not a
  quoted schedule rate.** Verify against the current Odisha Works Dept SOR / MoRTH Standard Data
  Book / CPWD DSR, and the IGR Odisha benchmark valuation for the actual mouzas crossed, before
  putting these numbers in front of anyone.
- Elevation is SRTM-derived and carries several metres of vertical noise. The profile is smoothed
  over 150 m before earthwork is computed so noise is not billed as excavation, but the floodplain
  (height-above-river) test is inherently coarse at ±several metres.
- A cell-centre grid path locates an alignment only to about ±1 cell and its 45° staircase steps
  are quantisation, not real bends — hence the Douglas–Peucker simplification before the
  curve-radius check. The output is a **corridor**, not a designed alignment.
- OSM landuse coverage in the study area is sparse; untagged land within 50 m of a building is
  assumed to be village homestead land. Land-class shares are therefore approximate.
- The cost grid itself is inherited and its original calibration is undocumented. v3's changes to
  it are limited to the two fixes above plus religious blocking, all reported by
  `build_layers.js`.
