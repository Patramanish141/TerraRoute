const express = require("express");
const { findRoute, inBounds, bounds } = require("./core/astar");
const { planRoutes, assumptions } = require("./planner");
const td = require("./layers/terrainData");
const { PUBLIC_DIR } = require("./config/paths");

const app = express();
const PORT = 3000;

app.use(express.static(PUBLIC_DIR));
app.use(express.json());

function parseCoords(req, res) {
  const startLat = parseFloat(req.query.startLat);
  const startLon = parseFloat(req.query.startLon);
  const endLat = parseFloat(req.query.endLat);
  const endLon = parseFloat(req.query.endLon);

  if ([startLat, startLon, endLat, endLon].some((v) => isNaN(v))) {
    res.status(400).json({ error: "Missing or invalid coordinates. Expected startLat, startLon, endLat, endLon." });
    return null;
  }
  if (!inBounds(startLat, startLon) || !inBounds(endLat, endLon)) {
    res.status(400).json({ error: "Coordinates outside supported region.", bounds });
    return null;
  }
  return { startLat, startLon, endLat, endLon };
}

// GET /api/route?startLat=..&startLon=..&endLat=..&endLon=..  — single least-cost route (original API)
app.get("/api/route", (req, res) => {
  const c = parseCoords(req, res);
  if (!c) return;
  const route = findRoute(c.startLat, c.startLon, c.endLat, c.endLon);
  if (!route) {
    return res.status(404).json({ error: "No path found between the given points." });
  }
  res.json(route);
});

// GET /api/routes?startLat=..&startLon=..&endLat=..&endLon=..[&legacy=1]
// 4–5 diverse candidates, each with an itemized ₹ breakdown and constraint checklist, ranked,
// top 3 selected. legacy=1 adds the original v2-grid route for comparison.
app.get("/api/routes", (req, res) => {
  const c = parseCoords(req, res);
  if (!c) return;
  try {
    const result = planRoutes(c.startLat, c.startLon, c.endLat, c.endLon, { includeLegacy: req.query.legacy === "1" });
    if (result.error) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Route planning failed: " + err.message });
  }
});

// All cost / constraint assumptions, so the UI can show exactly what the numbers are based on
app.get("/api/assumptions", (req, res) => {
  res.json(assumptions());
});

// Religious sites (blocked in the grid) for the map overlay
app.get("/api/religious-sites", (req, res) => {
  res.json(td.religious.map((r) => ({ id: r.id, name: r.name, kind: r.kind, religion: r.religion, lat: r.lonlat[1], lon: r.lonlat[0] })));
});

// Simple health check + bounds info, useful for the frontend to know the valid map area
app.get("/api/bounds", (req, res) => {
  res.json(bounds);
});

app.listen(PORT, () => {
  console.log(`TerraRoute server running at http://localhost:${PORT}`);
  console.log(`Supported region: ${JSON.stringify(bounds)}`);
});
