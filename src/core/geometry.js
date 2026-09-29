// Planar geometry + rasterization helpers shared by the build scripts and the runtime.
//
// Everything works in a local metric frame aligned with the cost grid:
//   X = metres east of the grid's west edge, Y = metres south of the grid's north edge.
// Grid cell (x, y) sits at (x * cellWidthM, y * cellHeightM) — the same cell <-> lat/lon
// convention as astar.js pixelToLatLon(). Over a ~12 km box an equirectangular frame is
// accurate to well under 0.1%, which is far below the 30 m grid resolution.

function makeProjection({ width, height, cellWidthM, cellHeightM, bounds }) {
  const dLon = bounds.maxLon - bounds.minLon, dLat = bounds.maxLat - bounds.minLat;
  const spanX = width * cellWidthM, spanY = height * cellHeightM;
  return {
    toXY: (lon, lat) => [((lon - bounds.minLon) / dLon) * spanX, ((bounds.maxLat - lat) / dLat) * spanY],
    toLonLat: (X, Y) => [bounds.minLon + (X / spanX) * dLon, bounds.maxLat - (Y / spanY) * dLat],
    cellXY: (x, y) => [x * cellWidthM, y * cellHeightM],
  };
}

function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Proper segment/segment intersection. Returns { t, u } (params along AB and CD) or null.
function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

function segDist(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointSegDist(ax, ay, cx, cy, dx, dy), pointSegDist(bx, by, cx, cy, dx, dy),
    pointSegDist(cx, cy, ax, ay, bx, by), pointSegDist(dx, dy, ax, ay, bx, by)
  );
}

// Exact distance between segment AB and the axis-aligned rectangle [x0,x1]x[y0,y1].
function segRectDist(ax, ay, bx, by, x0, y0, x1, y1) {
  const inside = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (inside(ax, ay) || inside(bx, by)) return 0;
  return Math.min(
    segDist(ax, ay, bx, by, x0, y0, x1, y0), segDist(ax, ay, bx, by, x1, y0, x1, y1),
    segDist(ax, ay, bx, by, x1, y1, x0, y1), segDist(ax, ay, bx, by, x0, y1, x0, y0)
  );
}

function pointRectDist(px, py, x0, y0, x1, y1) {
  const dx = Math.max(x0 - px, 0, px - x1), dy = Math.max(y0 - py, 0, py - y1);
  return Math.hypot(dx, dy);
}

// Even-odd point-in-polygon over all rings (outer + holes). rings: [[[X,Y],...], ...]
function pointInRings(px, py, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function ringsBBox(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}

// Minimum distance from point to polygon (0 if inside).
function pointPolygonDist(px, py, rings) {
  if (pointInRings(px, py, rings)) return 0;
  let d = Infinity;
  for (const ring of rings) for (let i = 1; i < ring.length; i++)
    d = Math.min(d, pointSegDist(px, py, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]));
  return d;
}

// Minimum distance from segment AB to polygon (0 if they touch/overlap).
function segPolygonDist(ax, ay, bx, by, rings) {
  if (pointInRings(ax, ay, rings) || pointInRings(bx, by, rings)) return 0;
  let d = Infinity;
  for (const ring of rings) for (let i = 1; i < ring.length; i++) {
    d = Math.min(d, segDist(ax, ay, bx, by, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]));
    if (d === 0) return 0;
  }
  return d;
}

// ---------- Rasterization onto the cost grid ----------
// Cell (x, y) covers the square [X - cw/2, X + cw/2] x [Y - ch/2, Y + ch/2] around its point.

function cellRange(g, x0, y0, x1, y1) {
  return {
    cx0: Math.max(0, Math.floor(x0 / g.cellWidthM - 0.5)), cx1: Math.min(g.width - 1, Math.ceil(x1 / g.cellWidthM + 0.5)),
    cy0: Math.max(0, Math.floor(y0 / g.cellHeightM - 0.5)), cy1: Math.min(g.height - 1, Math.ceil(y1 / g.cellHeightM + 0.5)),
  };
}

// Polygon fill. conservative=false: cells whose centre point is inside (scanline, even-odd).
// bufferM > 0 or conservative=true additionally marks every cell whose square lies within
// bufferM of the polygon boundary, which guarantees that no straight step between two
// unmarked cell centres can come closer than bufferM to the polygon.
function rasterizePolygon(g, rings, bufferM, conservative, mark) {
  const [bx0, by0, bx1, by1] = ringsBBox(rings);
  const { cx0, cx1, cy0, cy1 } = cellRange(g, bx0, by0, bx1, by1);
  for (let y = cy0; y <= cy1; y++) {
    const Y = y * g.cellHeightM;
    const xs = [];
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > Y !== yj > Y) xs.push(((xj - xi) * (Y - yi)) / (yj - yi) + xi);
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(cx0, Math.ceil(xs[k] / g.cellWidthM)), xb = Math.min(cx1, Math.floor(xs[k + 1] / g.cellWidthM));
      for (let x = xa; x <= xb; x++) mark(y * g.width + x);
    }
  }
  if (bufferM > 0 || conservative) {
    for (const ring of rings) for (let i = 1; i < ring.length; i++)
      rasterizeSegment(g, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1], bufferM, mark);
  }
}

// Marks cells whose CENTRE lies inside the polygon or within bufferM of it (plain buffer test).
function rasterizePolygonCentres(g, rings, bufferM, mark) {
  const [bx0, by0, bx1, by1] = ringsBBox(rings);
  const { cx0, cx1, cy0, cy1 } = cellRange(g, bx0 - bufferM, by0 - bufferM, bx1 + bufferM, by1 + bufferM);
  for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++)
    if (pointPolygonDist(x * g.cellWidthM, y * g.cellHeightM, rings) <= bufferM) mark(y * g.width + x);
}

// Marks every cell whose square lies within bufferM of segment AB (bufferM = 0 -> supercover).
function rasterizeSegment(g, ax, ay, bx, by, bufferM, mark) {
  const hw = g.cellWidthM / 2, hh = g.cellHeightM / 2;
  const { cx0, cx1, cy0, cy1 } = cellRange(g, Math.min(ax, bx) - bufferM, Math.min(ay, by) - bufferM, Math.max(ax, bx) + bufferM, Math.max(ay, by) + bufferM);
  for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) {
    const X = x * g.cellWidthM, Y = y * g.cellHeightM;
    if (segRectDist(ax, ay, bx, by, X - hw, Y - hh, X + hw, Y + hh) <= bufferM) mark(y * g.width + x);
  }
}

function rasterizePolyline(g, coords, bufferM, mark) {
  for (let i = 1; i < coords.length; i++) rasterizeSegment(g, coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1], bufferM, mark);
}

function rasterizeDisc(g, X0, Y0, radiusM, mark) {
  const hw = g.cellWidthM / 2, hh = g.cellHeightM / 2;
  const { cx0, cx1, cy0, cy1 } = cellRange(g, X0 - radiusM, Y0 - radiusM, X0 + radiusM, Y0 + radiusM);
  for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) {
    const X = x * g.cellWidthM, Y = y * g.cellHeightM;
    if (pointRectDist(X0, Y0, X - hw, Y - hh, X + hw, Y + hh) <= radiusM) mark(y * g.width + x);
  }
}

// ---------- Polyline utilities ----------

function douglasPeucker(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = pointSegDist(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Uniform-grid bucket index over feature bounding boxes, for "features near this segment" queries.
class BucketIndex {
  constructor(cellSizeM = 250) { this.size = cellSizeM; this.buckets = new Map(); }
  insert(item, [x0, y0, x1, y1]) {
    const s = this.size;
    for (let by = Math.floor(y0 / s); by <= Math.floor(y1 / s); by++)
      for (let bx = Math.floor(x0 / s); bx <= Math.floor(x1 / s); bx++) {
        const k = bx + "," + by;
        if (!this.buckets.has(k)) this.buckets.set(k, []);
        this.buckets.get(k).push(item);
      }
  }
  query(x0, y0, x1, y1) {
    const s = this.size, out = new Set();
    for (let by = Math.floor(y0 / s); by <= Math.floor(y1 / s); by++)
      for (let bx = Math.floor(x0 / s); bx <= Math.floor(x1 / s); bx++) {
        const arr = this.buckets.get(bx + "," + by);
        if (arr) for (const it of arr) out.add(it);
      }
    return out;
  }
}

module.exports = {
  makeProjection, pointSegDist, segIntersect, segDist, segRectDist, pointRectDist, pointInRings,
  ringsBBox, ringArea, pointPolygonDist, segPolygonDist,
  rasterizePolygon, rasterizePolygonCentres, rasterizeSegment, rasterizePolyline, rasterizeDisc, douglasPeucker, BucketIndex,
};
