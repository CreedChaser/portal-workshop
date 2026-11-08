"use strict";

const fs = require("node:fs");
const Dag = require("./portal-screen-dag.js");

let scene = {
  origin: [0.1219, 0.4614, -0.7855],
  yaw: 1.475,
  pitch: -0.0608,
  fov: 1.5708,
  roomHalf: [4, 4, 4],
  portals: [
    { id: "p7", target: "p8", pair: "pair7", position: [0.0671, -0.0116, -1.641], rotation: [0, 6.29359, 0], size: [2, 3.2] },
    { id: "p8", target: "p7", pair: "pair7", position: [-0.0069, -0.0116, 0.4146], rotation: [0, 3.152, 0], size: [2, 3.2] },
    { id: "p9", target: "p10", pair: "pair9", position: [1.0698, -0.0166, -0.628], rotation: [0, 4.71559, 0], size: [2, 3.2] },
    { id: "p10", target: "p9", pair: "pair9", position: [-0.9544, -0.0259, -0.6195], rotation: [0, 1.574, 0], size: [2, 3.2] }
  ]
};
if (process.env.SCENE_JSON) {
  const exported = JSON.parse(fs.readFileSync(process.env.SCENE_JSON, "utf8"));
  const player = exported.player || {};
  const tm = Array.isArray(player.tm) && player.tm.length === 16 ? player.tm :
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const point = [Number(player.x || 0), Number(player.y || 0), Number(player.z || 0)];
  const origin = [
    tm[0] * point[0] + tm[4] * point[1] + tm[8] * point[2] + tm[12],
    tm[1] * point[0] + tm[5] * point[1] + tm[9] * point[2] + tm[13],
    tm[2] * point[0] + tm[6] * point[1] + tm[10] * point[2] + tm[14]
  ];
  scene = {
    origin,
    yaw: Number(player.yaw || 0),
    pitch: Number(player.pitch || 0),
    fov: Number(exported.settings?.fov || Math.PI / 2),
    roomHalf: (exported.settings?.roomSize || [4, 4, 4]).map(Number),
    portals: (exported.portals || []).filter(portal => portal.enabled !== false).map(portal => ({
      id: String(portal.id),
      target: String(portal.targetId),
      pair: String(portal.pairId),
      position: portal.position.map(Number),
      rotation: portal.rotation.map(Number),
      size: portal.size.map(Number)
    }))
  };
}
if (process.env.ORIGIN_X) scene.origin[0] = Number(process.env.ORIGIN_X);
if (process.env.ORIGIN_Y) scene.origin[1] = Number(process.env.ORIGIN_Y);
if (process.env.ORIGIN_Z) scene.origin[2] = Number(process.env.ORIGIN_Z);
if (process.env.YAW) scene.yaw = Number(process.env.YAW);
if (process.env.PITCH) scene.pitch = Number(process.env.PITCH);

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const q = Math.hypot(...a); return a.map(x => x / q); }

// Three.js Euler XYZ basis columns, with the same near-integer snapping used
// by workshopPortalMatrix.
function basisXYZ(rotation) {
  const [x, y, z] = rotation;
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  const columns = [
    [c * e, a * f + b * e * d, b * f - a * e * d],
    [-c * f, a * e - b * f * d, b * e + a * f * d],
    [d, -b * c, a * c]
  ];
  for (const column of columns) for (let i = 0; i < 3; ++i) {
    const rounded = Math.round(column[i]);
    if (Math.abs(rounded) <= 1 && Math.abs(column[i] - rounded) <= 5e-6 + 32 * Number.EPSILON) column[i] = rounded;
  }
  return columns;
}

function matVec(columns, v) {
  return [
    columns[0][0] * v[0] + columns[1][0] * v[1] + columns[2][0] * v[2],
    columns[0][1] * v[0] + columns[1][1] * v[1] + columns[2][1] * v[2],
    columns[0][2] * v[0] + columns[1][2] * v[1] + columns[2][2] * v[2]
  ];
}

function transposeMatVec(columns, v) { return columns.map(column => dot(column, v)); }
function matMul(a, b) { return [0, 1, 2].map(j => matVec(a, b[j])); }
function transpose(columns) { return [[columns[0][0], columns[1][0], columns[2][0]], [columns[0][1], columns[1][1], columns[2][1]], [columns[0][2], columns[1][2], columns[2][2]]]; }
function sub(a, b) { return a.map((x, i) => x - b[i]); }

const flip = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];
const byId = new Map(scene.portals.map(p => [p.id, p]));
for (const p of scene.portals) p.basis = basisXYZ(p.rotation);

function rawTeleport(source, target) {
  const linear = matMul(matMul(target.basis, flip), transpose(source.basis));
  const translation = sub(target.position, matVec(linear, source.position));
  return { linear, translation };
}

for (const p of scene.portals) p.raw = rawTeleport(p, byId.get(p.target));

// Mirror workshopRayBuildPortalData's symmetric reciprocal translation.
for (const p of scene.portals) {
  const reverse = byId.get(p.target).raw.translation;
  p.translation = p.raw.translation.map((x, i) => Math.fround((x - reverse[i]) * 0.5));
}

// workshopPortalOrderCompare: descending pair ID, then descending portal ID.
const sorted = scene.portals.slice().sort((a, b) => b.pair.localeCompare(a.pair) || b.id.localeCompare(a.id));
const group = new Map(sorted.map((p, i) => [p.id, i]));
const dagPortals = sorted.map((p, rank) => {
  const [u, v, n] = p.basis;
  return {
    id: p.id,
    u: [...u, -dot(u, p.position)],
    v: [...v, -dot(v, p.position)],
    n: [...n, -dot(n, p.position)],
    bounds: [-p.size[0] * 0.5, -p.size[1] * 0.5, p.size[0] * 0.5, p.size[1] * 0.5],
    translation: p.translation,
    group: group.get(p.id),
    targetGroup: group.get(p.target),
    targetIndex: group.get(p.target),
    rank
  };
});

function cameraRay(width, height) {
  const cp = Math.cos(scene.pitch), sp = Math.sin(scene.pitch);
  const forward = norm([Math.sin(scene.yaw) * cp, sp, Math.cos(scene.yaw) * cp]);
  const right = norm(cross(forward, [0, 1, 0]));
  const up = norm(cross(right, forward));
  const tan = Math.tan(scene.fov * 0.5);
  return {
    c: forward,
    x: right.map(q => q * tan * width / height),
    y: up.map(q => q * tan)
  };
}

function sumArea(records) { return records.reduce((sum, record) => sum + Math.abs(Dag.polygonArea(record.polygon)), 0); }
function estimatePixels(records, width, height) { return sumArea(records) * width * height / 4; }

function rasterize(records, width, height) {
  const mask = new Uint8Array(width * height);
  for (const record of records) {
    const poly = record.polygon;
    let minY = Infinity, maxY = -Infinity;
    for (const p of poly) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const y0 = Math.max(0, Math.ceil(((minY + 1) * height - 1) * 0.5 - 1e-10));
    const y1 = Math.min(height - 1, Math.floor(((maxY + 1) * height - 1) * 0.5 + 1e-10));
    for (let y = y0; y <= y1; ++y) {
      const py = (2 * y + 1) / height - 1;
      let minX = Infinity, maxX = -Infinity;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[j], b = poly[i];
        if (Math.abs(a.y - py) <= 1e-13) { minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x); }
        if (Math.abs(b.y - py) <= 1e-13) { minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x); }
        if ((a.y < py && b.y > py) || (b.y < py && a.y > py)) {
          const x = a.x + (b.x - a.x) * ((py - a.y) / (b.y - a.y));
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        }
      }
      if (!(minX <= maxX)) continue;
      const x0 = Math.max(0, Math.ceil(((minX + 1) * width - 1) * 0.5 - 1e-10));
      const x1 = Math.min(width - 1, Math.floor(((maxX + 1) * width - 1) * 0.5 + 1e-10));
      if (x0 <= x1) mask.fill(1, y * width + x0, y * width + x1 + 1);
    }
  }
  return mask;
}

function countMask(mask) { let count = 0; for (const value of mask) count += value; return count; }

const width = Number(process.argv[2] || 2880);
const height = Number(process.argv[3] || 1688);
const started = performance.now();
const result = Dag.build({
  portals: dagPortals,
  origin: scene.origin,
  ray: cameraRay(width, height),
  roomHalf: scene.roomHalf,
  viewport: [width, height],
  pureEuclidean: process.env.PURE_EUCLIDEAN === "1",
  allowDirectTerminal: process.env.ALLOW_DIRECT_TERMINAL === "1",
  limits: {
    maxCells: Number(process.env.MAX_CELLS || 250000),
    maxEventsPerCell: Number(process.env.MAX_EVENTS || 4096),
    maxWord: Number(process.env.MAX_WORD || 96)
  }
});
const elapsed = performance.now() - started;
const probeContext = {
  origin: scene.origin,
  ray: cameraRay(width, height),
  viewport: [width, height]
};
probeContext.surfaces = Dag._internals.makeSurfaces(dagPortals, scene.roomHalf);
probeContext.denLines = probeContext.surfaces.map(surface => Dag._internals.rayLinearDot(surface.n, probeContext.ray));
function tracePoint(point, limit = 4096) {
  const state = { shift: [0, 0, 0], currentSurface: -1, skipGroup: -1,
    denSigns: probeContext.denLines.map(l => l.a * point.x + l.b * point.y + l.c >= 0 ? 1 : -1), crossings: 0 };
  const word = [];
  for (let step = 0; step < limit; ++step) {
    const hit = Dag._internals.classifyEvent(point, state, probeContext);
    if (!hit) return { kind: "unclassified", word };
    if (hit.surface.kind === "wall") return { kind: "wall", face: hit.surface.face, word };
    word.push(sorted[hit.surface.index].id);
    state.shift = state.shift.map((v, i) => v + hit.surface.translation[i]);
    state.currentSurface = hit.surface.targetIndex;
    state.skipGroup = hit.surface.targetGroup;
  }
  return { kind: "limit", word };
}
function recurrenceAt(point) {
  const direction = [probeContext.ray.c[0] + probeContext.ray.x[0] * point.x + probeContext.ray.y[0] * point.y,
    probeContext.ray.c[1] + probeContext.ray.x[1] * point.x + probeContext.ray.y[1] * point.y,
    probeContext.ray.c[2] + probeContext.ray.x[2] * point.x + probeContext.ray.y[2] * point.y];
  const rows = dagPortals;
  return rows.map((portal, i) => {
    const dn = dot(portal.n, direction);
    return {
      id: sorted[i].id,
      k: dagPortals.map(other => -dot(portal.n, other.translation) / dn),
      du: dagPortals.map(other => dot(portal.u, other.translation) + dot(portal.u, direction) * (-dot(portal.n, other.translation) / dn)),
      dv: dagPortals.map(other => dot(portal.v, other.translation) + dot(portal.v, direction) * (-dot(portal.n, other.translation) / dn))
    };
  });
}
const requestedTrace = process.env.TRACE_X && process.env.TRACE_Y ?
  [[Number(process.env.TRACE_X), Number(process.env.TRACE_Y)]] : [];
const pointTraces = [[0, 0], [-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5], ...requestedTrace].map(([x, y]) => {
  const trace = tracePoint({ x, y });
  return { point: [x, y], kind: trace.kind, face: trace.face,
    depth: trace.word.length, word: trace.word.slice(0, process.env.FULL_TRACE ? undefined : 80).join(" ") };
});
let gridDepths = null;
if (process.env.GRID) {
  const columns = Number(process.env.GRID), rows = Math.max(1, Math.round(columns * height / width));
  const limit = Number(process.env.TRACE_LIMIT || 20000), depths = [], spatialDepths = new Uint32Array(columns * rows), terminalStates = new Map(), prefixStates = new Set();
  let tracedEvents = 0;
  let maximum = { depth: -1, point: null, kind: null }, limited = 0;
  for (let row = 0; row < rows; ++row) for (let column = 0; column < columns; ++column) {
    const point = { x: (2 * column + 1) / columns - 1, y: (2 * row + 1) / rows - 1 };
    const state = { shift: [0, 0, 0], currentSurface: -1, skipGroup: -1,
      denSigns: probeContext.denLines.map(l => l.a * point.x + l.b * point.y + l.c >= 0 ? 1 : -1), crossings: 0 };
    let kind = "limit", depth = 0;
    for (; depth < limit; ++depth) {
      const hit = Dag._internals.classifyEvent(point, state, probeContext);
      if (!hit) { kind = "unclassified"; break; }
      if (hit.surface.kind === "wall") { kind = "wall"; break; }
      prefixStates.add(`${state.currentSurface}:${state.skipGroup}:${state.shift.map(value => value.toPrecision(17)).join(",")}`);
      state.shift = state.shift.map((value, axis) => value + hit.surface.translation[axis]);
      state.currentSurface = hit.surface.targetIndex;
      state.skipGroup = hit.surface.targetGroup;
      ++tracedEvents;
    }
    if (kind === "limit") ++limited;
    else if (kind === "wall") {
      const key = `${state.currentSurface}:${state.skipGroup}:${state.shift.map(value => value.toPrecision(17)).join(",")}`;
      terminalStates.set(key, (terminalStates.get(key) || 0) + 1);
    }
    spatialDepths[row * columns + column] = depth;
    depths.push(depth);
    if (depth > maximum.depth) maximum = { depth, point: [point.x, point.y], kind };
  }
  const tileAnalysis = [2, 4, 8, 16, 32].map(size => {
    let scalarWork = 0, lockstepWork = 0, tiles = 0;
    const activeCoverage = Object.fromEntries([2, 4, 8, 16, 32, 64, 128, 256]
      .map(cap => [cap, 0]));
    for (let y0 = 0; y0 < rows; y0 += size) for (let x0 = 0; x0 < columns; x0 += size) {
      const x1 = Math.min(columns, x0 + size), y1 = Math.min(rows, y0 + size), count = (x1 - x0) * (y1 - y0);
      let maximumDepth = 0;
      for (let y = y0; y < y1; ++y) for (let x = x0; x < x1; ++x) {
        const value = spatialDepths[y * columns + x];
        scalarWork += value; maximumDepth = Math.max(maximumDepth, value);
      }
      lockstepWork += maximumDepth * count; ++tiles;
      for (const cap of Object.keys(activeCoverage)) if (maximumDepth > Number(cap)) activeCoverage[cap] += count;
    }
    for (const cap of Object.keys(activeCoverage)) activeCoverage[cap] /= columns * rows;
    return { size, tiles, scalarWork, lockstepWork, divergenceMultiplier: lockstepWork / Math.max(1, scalarWork), activeCoverage };
  });
  depths.sort((a, b) => a - b);
  const percentile = p => depths[Math.floor((depths.length - 1) * p)];
  const bins = [0, 1, 4, 16, 64, 256, 1024, 4096, limit];
  gridDepths = { columns, rows, samples: depths.length, limited, maximum, tileAnalysis,
    terminalStates: terminalStates.size,
    prefixStates: prefixStates.size, tracedEvents,
    percentile: { p50: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95),
      p99: percentile(0.99), p999: percentile(0.999) },
    histogram: bins.map((upper, index) => ({ upper,
      count: depths.filter(value => value <= upper && (index === 0 || value > bins[index - 1])).length })) };
}
const terminalPixels = estimatePixels(result.terminal, width, height);
const residualPixels = estimatePixels(result.residual, width, height);
const voidPixels = estimatePixels(result.void, width, height);
const rasterStarted = performance.now();
const terminalMask = rasterize(result.terminal, width, height);
const residualMask = rasterize(result.residual, width, height);
const voidMask = rasterize(result.void, width, height);
let terminalRasterPixels = 0, residualRasterPixels = 0, voidRasterPixels = 0, uncoveredRasterPixels = 0;
for (let i = 0; i < terminalMask.length; ++i) {
  // Guard/fallback polygons intentionally overlap certified children on their
  // mathematical boundary; authoritative fallback gets ownership there.
  if (residualMask[i]) ++residualRasterPixels;
  else if (voidMask[i]) ++voidRasterPixels;
  else if (terminalMask[i]) ++terminalRasterPixels;
  else ++uncoveredRasterPixels;
}
const rasterElapsed = performance.now() - rasterStarted;
const words = new Map();
for (const record of result.terminal) {
  const key = `${record.face}:${record.state.shift.map(x => x.toFixed(7)).join(",")}`;
  words.set(key, (words.get(key) || 0) + 1);
}
const depths = result.terminal.map(record => record.state.crossings).sort((a, b) => a - b);
const median = depths.length ? depths[(depths.length - 1) >> 1] : null;
console.log(JSON.stringify({
  elapsedMs: elapsed,
  order: sorted.map(p => p.id),
  translations: Object.fromEntries(scene.portals.map(p => [p.id, p.translation])),
  stats: result.stats,
  terminalStates: words.size,
  maximumTerminalDepth: depths.length ? depths[depths.length - 1] : null,
  medianTerminalDepth: median,
  estimatedPixels: { terminal: terminalPixels, residual: residualPixels, void: voidPixels,
    total: terminalPixels + residualPixels + voidPixels,
    residualPercent: 100 * residualPixels / (width * height) },
  rasterPixels: { terminal: terminalRasterPixels, residual: residualRasterPixels,
    void: voidRasterPixels, uncovered: uncoveredRasterPixels,
    residualPercent: 100 * residualRasterPixels / (width * height), elapsedMs: rasterElapsed },
  residualReasons: result.residual.reduce((m, r) => (m[r.reason] = (m[r.reason] || 0) + 1, m), {})
  ,pointTraces
  ,gridDepths
  ,centerRecurrence: recurrenceAt({ x: 0, y: 0 })
  ,requestedRecurrence: requestedTrace.length ? recurrenceAt({ x: requestedTrace[0][0], y: requestedTrace[0][1] }) : null
}, null, 2));
