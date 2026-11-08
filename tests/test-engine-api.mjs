import assert from 'node:assert/strict';
import Engine from '../engine/portal-workshop-engine.mjs';

assert.equal(Engine.VERSION, '1.0.0');
assert.equal(Engine.SCENE_VERSION, 2);
assert.match(Engine.SUPPORTED_ENVELOPE.canonicalRenderer, /breadth-fair/);
assert.match(Engine.SUPPORTED_ENVELOPE.infinite, /No finite renderer/);

const raw = {
  id: 'api-test',
  name: '  API test  ',
  selectedId: 'missing',
  player: { x: Infinity, y: 2, z: -3, yaw: 99, pitch: 99 },
  settings: { fov: 999, portalDistance: -3, roomSize: [0, 9999, 4] },
  portals: [
    { id: 'A', pairId: 'pair', targetId: 'B', shape: 'oval', position: [0, 0, -1], size: [2, 3] },
    { id: 'A', pairId: 'pair', targetId: 'missing', shape: 'bogus', position: [0, 0, 1], size: [-2, 3] }
  ],
  compressedSpaces: [{ id: 'A', enabled: false, scale: [0, 99, 0.5] }]
};
const normalized = Engine.normalizeScene(raw);
assert.equal(normalized.portals.length, 2);
assert.equal(normalized.portals[0].id, 'A');
assert.equal(normalized.portals[1].id, 'A-2');
assert.equal(normalized.portals[1].shape, 'rectangle');
assert.equal(normalized.portals[1].targetId, 'A');
assert.equal(normalized.compressedSpaces[0].id, 'A-3');
assert.equal(normalized.compressedSpaces[0].enabled, false, 'compressed spaces must remain opt-in');
assert.equal(normalized.selectedId, 'A');
assert(Number.isFinite(normalized.player.x));
assert(normalized.player.pitch < Math.PI / 2);
assert(normalized.settings.fov <= Math.PI * 1.4);
assert.deepEqual(normalized.settings.roomSize, [0.25, 256, 4]);

const token = Engine.encodeScene(normalized);
assert.match(token, /^[A-Za-z0-9_-]+$/);
assert.deepEqual(Engine.decodeScene(token), normalized);
assert.equal(Engine.encodeScene(Engine.decodeScene(token)), token);
assert.equal(Engine.sceneFingerprint(normalized), Engine.sceneFingerprint(Engine.decodeScene(token)));
assert.equal(Engine.stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
assert.throws(() => { const x = {}; x.x = x; Engine.stableStringify(x); }, /cyclic/);

const valid = Engine.validateScene(normalized);
assert.equal(valid.ok, true);
assert.equal(valid.errors.length, 0);

const pairScene = Engine.normalizeScene({
  id: 'pair',
  settings: { roomSize: [4, 4, 4] },
  portals: [
    { id: 'A', pairId: 'p', targetId: 'B', shape: 'rectangle', position: [0, 0, 1], rotation: [0, 0, 0], size: [2, 2], priority: 0 },
    { id: 'B', pairId: 'p', targetId: 'A', shape: 'rectangle', position: [2, 0, -1], rotation: [0, Math.PI, 0], size: [2, 2], priority: 1 }
  ],
  compressedSpaces: []
});
const crossing = Engine.deterministicCrossing(pairScene, [0, 0, 0], [0, 0, 2]);
assert(crossing, 'expected a crossing');
assert.equal(crossing.portal.id, 'A');
assert.equal(crossing.target.id, 'B');
const mapped = Engine.mapPointThrough(crossing.portal, crossing.target, crossing.point);
assert.equal(mapped.length, 3);
assert(mapped.every(Number.isFinite));
const movement = Engine.traceMovement(pairScene, [0, 0, 0], [0, 0, 2], { maxCrossings: 8 });
assert.equal(movement.crossings, 1);
assert.equal(movement.events[0].source, 'A');
assert(movement.position.every(Number.isFinite));
const ray = Engine.traceRay(pairScene, [0, 0, 0], [0, 0, 1], { maxEvents: 8 });
assert.equal(ray.truncated, false);
assert(ray.crossings >= 1);
assert(Number.isFinite(ray.travel));

let sceneState = normalized;
let edit = false;
let rerenders = 0;
const runtime = Engine.attachRuntime({
  getScene: () => sceneState,
  loadScene: scene => { sceneState = scene; return true; },
  getState: () => ({ edit, id: sceneState.id }),
  rerender: () => ++rerenders,
  setEditMode: value => (edit = value),
  toggleEdit: () => (edit = !edit),
  lifecycle: () => ({ ready: true })
});
assert(Object.isFrozen(runtime));
assert.notEqual(runtime.getScene(), sceneState, 'runtime must return serializable clones');
assert.equal(runtime.setEditMode(true), true);
assert.equal(runtime.getState().edit, true);
assert.equal(runtime.rerender(), 1);
assert.deepEqual(runtime.lifecycle(), { ready: true });
assert.throws(() => Engine.attachRuntime({}), /missing getScene/);

console.log('PASS test-engine-api', { fingerprint: Engine.sceneFingerprint(normalized), tokenBytes: token.length });
