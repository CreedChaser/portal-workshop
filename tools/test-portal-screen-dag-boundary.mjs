import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Dag = require("./portal-screen-dag.js");

// Camera is on portal zero at z=0 and looks tangent to its plane.  NDC x is
// therefore the signed portal-plane ray direction.  Portal one is the opposite
// endpoint at z=2; narrow bounds keep later positive-time hits out of the test.
const portals = [
  {
    u: [1, 0, 0, 0], v: [0, 1, 0, 0], n: [0, 0, 1, 0],
    bounds: [-0.25, -0.25, 0.25, 0.25], translation: [0, 0, 2],
    group: 0, targetGroup: 1, targetIndex: 1, rank: 0
  },
  {
    u: [-1, 0, 0, 0], v: [0, 1, 0, 0], n: [0, 0, -1, 2],
    bounds: [-0.25, -0.25, 0.25, 0.25], translation: [0, 0, -2],
    group: 1, targetGroup: 0, targetIndex: 0, rank: 1
  }
];

const baseOptions = {
  origin: [0, 0, 0],
  ray: { c: [1, 0, 0], x: [0, 0, 1], y: [0, 1, 0] },
  portals,
  roomHalf: [4, 4, 4],
  viewport: [320, 180],
  interiorInvariant: true,
  limits: { maxCells: 2000, maxEventsPerCell: 24, maxWord: 8 }
};

function contains(poly, point) {
  let sign = 0;
  for (let index = 0, previous = poly.length - 1; index < poly.length;
       previous = index++) {
    const a = poly[previous], b = poly[index];
    const cross = (b.x - a.x) * (point.y - a.y) -
      (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) <= 1e-10) continue;
    const next = cross > 0 ? 1 : -1;
    if (sign && sign !== next) return false;
    sign = next;
  }
  return true;
}

function ownerAt(result, x, y = 0.5) {
  const matches = [...result.terminal, ...result.residual]
    .filter(record => contains(record.polygon, { x, y }));
  assert.equal(matches.length, 1, `expected one state owner at (${x}, ${y})`);
  return matches[0];
}

for (const side of [1, -1]) {
  const result = Dag.build({
    ...baseOptions,
    boundarySeeds: [{ portalIndex: 0, side }]
  });
  assert.equal(result.stats.boundarySeedPolygons, 1);

  const contactX = side > 0 ? -0.5 : 0.5;
  const rootX = -contactX;
  const contact = ownerAt(result, contactX);
  const root = ownerAt(result, rootX);

  assert.equal(contact.state.crossings, 1,
    "history-owned half-screen must begin after one zero-travel crossing");
  assert.deepEqual(contact.state.shift.map(Math.fround), [0, 0, 2]);
  assert.equal(root.state.crossings, 0,
    "the complementary half-screen must remain in the root Euclidean copy");
  assert.deepEqual(root.state.shift.map(Math.fround), [0, 0, 0]);
}

// Force both initial states into the GPU completion stream.  Only the contact
// state carries residual kind 3, which authorizes zero-travel reconstruction.
const residual = Dag.build({
  ...baseOptions,
  boundarySeeds: [{ portalIndex: 0, side: 1 }],
  limits: { maxCells: 2000, maxEventsPerCell: 0, maxWord: 8 }
});
assert(residual.residual.some(record => record.state.boundarySeed));
assert(residual.residual.some(record => !record.state.boundarySeed));
const kinds = new Set();
for (let vertex = 0; vertex < residual.stateBuildGeometry.metadata.length / 4; ++vertex) {
  kinds.add(residual.stateBuildGeometry.metadata[vertex * 4]);
}
assert(kinds.has(3), "contact residuals must encode the zero-travel seed kind");
assert(kinds.has(0), "root residuals must retain the ordinary seed kind");

// A zero-time contact is still the replay origin after an ordinary positive-
// time portal crossing.  Widen portal zero just enough for the contact-side
// sample at NDC (-0.5, 0.1) to hit it once more (x=4), but not twice (x=8).
// Stopping after that later crossing forces the descendant into GPU completion
// and exercises the persistent boundary ancestry rather than boundarySeed's
// immediate-state marker.
const descendantPortals = portals.map((portal, index) => ({
  ...portal,
  bounds: index === 0 ? [-5, -1, 5, 1] : portal.bounds.slice()
}));
const descendant = Dag.build({
  ...baseOptions,
  portals: descendantPortals,
  boundarySeeds: [{ portalIndex: 0, side: 1 }],
  limits: { maxCells: 2000, maxEventsPerCell: 1, maxWord: 8 }
});
const descendantContact = ownerAt(descendant, -0.5, 0.1);
assert.equal(descendantContact.kind, "residual");
assert.equal(descendantContact.state.crossings, 2,
  "contact descendant must include one later positive-time portal crossing");
assert.equal(descendantContact.state.boundarySeed, false,
  "the immediate boundary marker must clear after the later crossing");
assert.equal(descendantContact.state.replayBoundaryPortal, 0,
  "the original zero-time portal must remain the replay origin");
assert.deepEqual(descendantContact.state.replayWord, [0],
  "the later positive-time portal must be retained in replay order");

let encodedDescendant = false;
for (let vertex = 0; vertex < descendant.stateBuildGeometry.metadata.length / 4; ++vertex) {
  const offset = vertex * 4;
  if (descendant.stateBuildGeometry.metadata[offset] === 3 &&
      descendant.stateBuildGeometry.metadata[offset + 2] === 0) {
    encodedDescendant = true;
    break;
  }
}
assert(encodedDescendant,
  "boundary descendants must encode residual kind 3 and original portal index z=0");

console.log("portal-screen-dag boundary ownership: ok");
