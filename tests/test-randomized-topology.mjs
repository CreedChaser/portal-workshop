import assert from 'node:assert/strict';
import Engine from '../engine/portal-workshop-engine.mjs';

let seed = 0x5eed1234;
function rand() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; }
function between(a, b) { return a + (b - a) * rand(); }
function choice(values) { return values[Math.floor(rand() * values.length)]; }
const shapes = ['rectangle', 'circle', 'oval', 'triangle'];
let rays = 0, movements = 0, scenes = 0;
for (let caseIndex = 0; caseIndex < 240; caseIndex++) {
  const pairCount = 1 + Math.floor(rand() * 6), portals = [];
  for (let pair = 0; pair < pairCount; pair++) {
    const a = `p${pair * 2}`, b = `p${pair * 2 + 1}`, pairId = `pair${pair}`, shape = choice(shapes);
    const axis = pair % 3, sign = rand() < 0.5 ? -1 : 1;
    const p1 = [between(-2.5, 2.5), between(-2.5, 2.5), between(-2.5, 2.5)];
    p1[axis] = sign * between(1.2, 3.2);
    const p2 = [between(-2.5, 2.5), between(-2.5, 2.5), between(-2.5, 2.5)];
    p2[axis] = -sign * between(1.2, 3.2);
    const rot1 = [between(-Math.PI, Math.PI), between(-Math.PI, Math.PI), between(-Math.PI, Math.PI)];
    const rot2 = [between(-Math.PI, Math.PI), between(-Math.PI, Math.PI), between(-Math.PI, Math.PI)];
    portals.push({ id: a, pairId, targetId: b, shape, position: p1, rotation: rot1, size: [between(0.5, 3), between(0.5, 3)], priority: pair * 2 });
    portals.push({ id: b, pairId, targetId: a, shape, position: p2, rotation: rot2, size: [between(0.5, 3), between(0.5, 3)], priority: pair * 2 + 1 });
  }
  const scene = Engine.normalizeScene({ id: `random-${caseIndex}`, settings: { roomSize: [4, 4, 4] }, portals, compressedSpaces: [] });
  assert.equal(Engine.validateScene(scene).ok, true);
  const encoded = Engine.encodeScene(scene), decoded = Engine.decodeScene(encoded);
  assert.equal(Engine.sceneFingerprint(decoded), Engine.sceneFingerprint(scene));
  for (let sample = 0; sample < 6; sample++) {
    const origin = [between(-3.8, 3.8), between(-3.8, 3.8), between(-3.8, 3.8)];
    const direction = [between(-1, 1), between(-1, 1), between(-1, 1)];
    if (Math.hypot(...direction) < 1e-6) direction[2] = 1;
    const rayA = Engine.traceRay(scene, origin, direction, { maxEvents: 32 });
    const rayB = Engine.traceRay(scene, origin, direction, { maxEvents: 32 });
    assert.deepEqual(rayB, rayA, 'ray oracle must be deterministic');
    assert(Number.isFinite(rayA.travel));
    assert(rayA.crossings <= 33);
    rays++;
    const delta = direction.map(v => v * between(0.05, 4));
    const moveA = Engine.traceMovement(scene, origin, delta, { maxCrossings: 24 });
    const moveB = Engine.traceMovement(scene, origin, delta, { maxCrossings: 24 });
    assert.deepEqual(moveB, moveA, 'movement oracle must be deterministic');
    assert(moveA.position.every(Number.isFinite));
    assert(moveA.remaining.every(Number.isFinite));
    assert(moveA.crossings <= 24);
    movements++;
  }
  scenes++;
}

for (let i = 0; i < 120; i++) {
  const branches = 2 + Math.floor(rand() * 10), maxCopies = branches + 1 + Math.floor(rand() * 100);
  const rootChildren = Array.from({ length: branches }, (_, k) => ({ id: `b${k}`, priority: k, area: 100 - k }));
  const schedule = Engine.fairSchedule({ path: 'root' }, node => node.path === 'root' ? rootChildren : [{ id: `${node.rootBranch}-${node.depth}`, area: 1 }], { maxCopies, maxDepth: 128 });
  assert(schedule.stats.fairnessSpan <= 1, `random fair schedule span ${schedule.stats.fairnessSpan}`);
  assert.equal(schedule.stats.conservativeTerminal, true);
}

console.log('PASS test-randomized-topology', { seed: '0x5eed1234', scenes, rays, movements, fairSchedules: 120 });
