// End-to-end test against a RUNNING server (node server.js).
// Usage: node scripts/test_routes.js [baseUrl]
const BASE = process.argv[2] || "http://localhost:3000";

// Real start/end pairs inside the grid bbox (22.18–22.26 N, 84.78–84.90 E)
const PAIRS = [
  { name: "NIT Rourkela campus -> Vedvyas (Koel–Sankh confluence)", start: [22.2525, 84.8990], end: [22.2330, 84.7880] },
  { name: "Bisra Road area -> south, across the Brahmani", start: [22.2450, 84.8400], end: [22.1900, 84.8600] },
  { name: "West bank -> east (Sector area)", start: [22.2100, 84.7900], end: [22.2200, 84.8950] },
];

const cr = (v) => `₹${(v / 1e7).toFixed(2)} Cr`;
let failures = 0;
const check = (cond, msg) => {
  if (!cond) { failures++; console.log(`   ✗ FAIL: ${msg}`); }
};

async function getJson(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json() };
}

async function main() {
  const b = await getJson("/api/bounds");
  check(b.status === 200 && b.body.minLat === 22.18, "/api/bounds returns grid bounds");

  const a = await getJson("/api/assumptions");
  check(a.status === 200 && a.body.cost.RCC_SLAB_BRIDGE_INR_PER_M2 > 0, "/api/assumptions exposes cost constants");

  const rs = await getJson("/api/religious-sites");
  check(rs.status === 200 && rs.body.length > 0, "/api/religious-sites lists sites");
  console.log(`Religious sites blocked in grid: ${rs.body.length}`);

  for (const p of PAIRS) {
    const q = `startLat=${p.start[0]}&startLon=${p.start[1]}&endLat=${p.end[0]}&endLon=${p.end[1]}`;

    // original single-route API still works
    const single = await getJson(`/api/route?${q}`);
    check(single.status === 200 && single.body.geometry.coordinates.length > 1, "/api/route (original API) returns a route");

    const t = Date.now();
    const { status, body } = await getJson(`/api/routes?${q}&legacy=1`);
    const ms = Date.now() - t;
    console.log(`\n=== ${p.name}  [HTTP ${status}, ${ms} ms]`);
    check(status === 200, `HTTP 200 (got ${status}: ${body.error || ""})`);
    if (status !== 200) continue;

    const cands = body.routes.filter((r) => !r.legacy);
    check(cands.length >= 4 && cands.length <= 5, `4–5 candidates (got ${cands.length})`);
    check(body.top.length === 3, "exactly 3 routes selected");

    for (const r of [...body.routes].sort((x, y) => x.ranking.rank - y.ranking.rank)) {
      const k = r.cost;
      const parts = k.pavement.inr + k.earthwork.inr + k.landAcquisition.inr + k.bridges.inr + k.forest.inr;
      check(Math.abs(parts - k.totalInr) < 1, `${r.id}: itemized parts sum to total`);
      check(r.constraints.total === 11 && r.constraints.items.length === 11, `${r.id}: 11 checklist items`);
      check(r.geometry.coordinates.length > 1, `${r.id}: has geometry`);
      if (!r.legacy) check(r.constraints.items.find((i) => i.id === "H2").passed, `${r.id}: no religious site inside ROW`);
      for (const x of k.bridges.crossings) {
        check(x.bridge.inr > 0 && x.bridgeLengthM > 0, `${r.id} ${x.id}: bridge priced`);
        if (x.comparison.detourFeasible) check(x.comparison.detourOptionInr > 0 && x.comparison.bridgeOptionInr > 0, `${r.id} ${x.id}: both options priced`);
      }
      const tag = r.ranking.selected ? `TOP #${r.ranking.rank}` : `rank ${r.ranking.rank}`;
      console.log(`${(r.name + (r.legacy ? "" : "")).padEnd(17)} ${tag.padEnd(8)} ${String(r.summary.distanceKm).padStart(6)} km  total ${cr(k.totalInr).padStart(12)}` +
        `  | pave ${cr(k.pavement.inr)}, earth ${cr(k.earthwork.inr)}, land ${cr(k.landAcquisition.inr)} (${k.landAcquisition.hectares.toFixed(1)} ha), bridges ${cr(k.bridges.inr)} (${k.bridges.count}), forest ${cr(k.forest.inr)}`);
      console.log(`${" ".repeat(26)}${r.constraints.summary}`);
      const big = [...k.bridges.crossings].sort((x, y) => y.bridgeLengthM - x.bridgeLengthM)[0];
      if (big) {
        const c = big.comparison;
        console.log(`${" ".repeat(26)}largest crossing: ${big.name || big.waterbody} ${Math.round(big.bridgeLengthM)} m ${big.bridge.type} — bridge ${cr(c.bridgeOptionInr)} vs detour ${c.detourFeasible ? cr(c.detourOptionInr) : "not feasible"} -> ${c.cheaper}`);
      }
    }

    // ranking invariants
    const sorted = [...body.routes].sort((x, y) => x.ranking.rank - y.ranking.rank);
    for (let i = 1; i < sorted.length; i++) {
      check(sorted[i - 1].ranking.hardViolations <= sorted[i].ranking.hardViolations, "hard-violating routes rank below compliant ones");
    }
    const compliant = sorted.filter((r) => r.ranking.hardViolations === 0);
    for (let i = 1; i < compliant.length; i++) check(compliant[i - 1].ranking.rankScoreInr <= compliant[i].ranking.rankScoreInr, "compliant routes ordered by penalized cost");
    check(sorted.slice(0, 3).every((r) => r.ranking.selected) && sorted.slice(3).every((r) => !r.ranking.selected), "top 3 = ranks 1–3");
  }

  const bad = await getJson("/api/routes?startLat=1&startLon=1&endLat=2&endLon=2");
  check(bad.status === 400, "out-of-bounds request rejected with 400");

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
