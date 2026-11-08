import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Engine from '../engine/portal-workshop-engine.mjs';

const root = new URL('../', import.meta.url);
const corpus = JSON.parse(await readFile(new URL('fixtures/scenes-v1.json', root), 'utf8'));
const oracles = JSON.parse(await readFile(new URL('fixtures/oracles-v1.json', root), 'utf8'));
assert.equal(corpus.version, Engine.CORPUS_VERSION);
assert.equal(oracles.sceneCorpusVersion, corpus.version);
assert.equal(oracles.renderer.canonical, Engine.SUPPORTED_ENVELOPE.canonicalRenderer);
assert.equal(corpus.scenes.length, 8);
const ids = new Set();
const shapes = new Set();

function close(actual, expected, tolerance = 1e-5, path = 'value') {
  if (typeof expected === 'number') {
    assert(Number.isFinite(actual), `${path} was non-finite`);
    assert(Math.abs(actual - expected) <= tolerance, `${path}: ${actual} != ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${path}.length`);
    expected.forEach((v, i) => close(actual[i], v, tolerance, `${path}[${i}]`));
  } else if (expected && typeof expected === 'object') {
    for (const [key, value] of Object.entries(expected)) close(actual[key], value, tolerance, `${path}.${key}`);
  } else assert.deepEqual(actual, expected, path);
}

for (const entry of corpus.scenes) {
  assert(!ids.has(entry.id)); ids.add(entry.id);
  const oracle = oracles.scenes[entry.id];
  assert(oracle, `missing oracle for ${entry.id}`);
  const check = Engine.validateScene(entry.scene);
  assert.equal(check.ok, true, check.errors.join('; '));
  assert.equal(Engine.sceneFingerprint(entry.scene), entry.fingerprint);
  assert.equal(oracle.fingerprint, entry.fingerprint);
  assert.equal(Engine.sceneFingerprint(Engine.decodeScene(Engine.encodeScene(entry.scene))), entry.fingerprint);
  for (const portal of entry.scene.portals) shapes.add(portal.shape);
  const depth = Engine.traceRay(entry.scene, oracle.depth.ray.origin, oracle.depth.ray.direction, { maxEvents: 48 });
  close({ resolved: depth.resolved, face: depth.face, crossings: depth.crossings, travel: depth.travel, truncated: depth.truncated }, oracle.depth.expected, 2e-5, `${entry.id}.depth`);
  const movement = Engine.traceMovement(entry.scene, oracle.movement.from, oracle.movement.delta, { maxCrossings: 16 });
  close(movement, oracle.movement.expected, 2e-5, `${entry.id}.movement`);
  if (oracle.crossing.deterministicOwner) {
    const hit = Engine.deterministicCrossing(entry.scene, [0, 0, 0], [0, 0, 4]);
    assert(hit, `${entry.id} expected overlap hit`);
    assert.equal(hit.portal.id, oracle.crossing.deterministicOwner);
    assert(hit.overlapOwners.length >= 2, `${entry.id} should record all tied owners`);
  }
  const activeSpaces = entry.scene.compressedSpaces.filter(space => space.enabled);
  if (entry.id === 'compressed-opt-in') assert.equal(activeSpaces.length, 1);
  else assert.equal(activeSpaces.length, 0, `${entry.id} unexpectedly enables compressed rendering`);
  assert.deepEqual(oracle.pixel.viewport, [640, 360]);
  assert.equal(oracle.pixel.tolerance.maxDifferentPixels, 0);
}
assert.deepEqual([...shapes].sort(), ['circle', 'oval', 'rectangle', 'triangle']);
assert.deepEqual([...ids].sort(), Object.keys(oracles.scenes).sort());
console.log('PASS test-scene-corpus', { scenes: ids.size, shapes: [...shapes].sort() });
