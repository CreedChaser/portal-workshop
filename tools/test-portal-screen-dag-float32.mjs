#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Dag = require("./portal-screen-dag.js");
const {
  add3Float32,
  advancePortal,
  affineFloat32Shift,
  float32AffineWordRepeatLimit,
  makeSurfaces
} = Dag._internals;

function portal(translation, index = 0) {
  return {
    index,
    kind: "portal",
    translation: translation.map(Math.fround),
    targetIndex: index,
    targetGroup: index
  };
}

function word(startShift, translations) {
  const surfaces = translations.map((translation, index) => portal(translation, index));
  const context = { surfaces };
  let state = {
    shift: startShift.map(Math.fround),
    currentSurface: -1,
    skipGroup: -1,
    denSigns: [],
    crossings: 0
  };
  const history = [];
  for (let selected = 0; selected < surfaces.length; ++selected) {
    history.push({
      state: { ...state, shift: state.shift.slice() },
      selected,
      certificate: []
    });
    state = advancePortal(state, surfaces[selected]);
  }
  return { history, state, context };
}

// Deferred binary64 accumulation demonstrably differs from four sequential
// highp-float additions at this binade boundary.
let sequential = [16777214, 0, 0];
for (let i = 0; i < 4; ++i) sequential = add3Float32(sequential, [1, 0, 0]);
assert.equal(sequential[0], 16777216);
assert.equal(Math.fround(16777214 + 4), 16777218);

// Portal inputs are quantized exactly as their highp vec3 uniforms are.
const quantized = makeSurfaces([{
  u: [1, 0, 0, 0], v: [0, 1, 0, 0], n: [0, 0, 1, 0],
  bounds: [-1, -1, 1, 1], translation: [0.1, -0.2, 0.3],
  group: 0, targetGroup: 0, targetIndex: 0
}], [4, 4, 4])[0].translation;
assert.deepEqual(quantized, [0.1, -0.2, 0.3].map(Math.fround));

// A rounded state cycle is safe forever even when its intermediate additions
// are not exact real-number additions.
const cycle = word([16777216, 0, 0], [[0.25, 0, 0], [-0.25, 0, 0]]);
assert.equal(float32AffineWordRepeatLimit(cycle.history, 0, cycle.state,
  cycle.context), Infinity);

// A +1 word stops being affine on the third repetition at 2^24.  The proof
// must cap the jump before float32 begins swallowing the increment.
const boundary = word([16777214, 0, 0], [[1, 0, 0]]);
assert.equal(float32AffineWordRepeatLimit(boundary.history, 0, boundary.state,
  boundary.context), 2);
assert.deepEqual(affineFloat32Shift(boundary.history[0].state.shift,
  [1, 0, 0], 2), [16777216, 0, 0]);

// Exactly aligned progressions retain the full production jump cap.
const aligned = word([0, 0, 0], [[2, -4, 8]]);
assert.equal(float32AffineWordRepeatLimit(aligned.history, 0, aligned.state,
  aligned.context), 1 << 20);

// Property-check every accepted proof against literal scalar replay over a
// range of binades and short event words.  This independently exercises the
// long dyadic-grid branch as well as the bounded direct-proof branch.
let randomState = 0x8f6e37a1;
const random = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x100000000;
};
for (let trial = 0; trial < 256; ++trial) {
  const start = Array.from({ length: 3 }, () => Math.fround(
    (random() * 2 - 1) * 2 ** Math.floor(random() * 48 - 24)));
  const translations = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
    Array.from({ length: 3 }, () => Math.fround(
      (random() * 2 - 1) * 2 ** Math.floor(random() * 40 - 20))));
  const candidate = word(start, translations);
  const limit = float32AffineWordRepeatLimit(candidate.history, 0,
    candidate.state, candidate.context, 128);
  const checked = limit === Infinity ? 128 : Math.min(128, limit);
  const delta = start.map((value, axis) => candidate.state.shift[axis] - value);
  let replay = start.slice();
  for (let repetition = 0; repetition < checked; ++repetition) {
    for (let event = 0; event < candidate.history.length; ++event) {
      const base = candidate.history[event].state.shift;
      for (let axis = 0; axis < 3; ++axis) {
        const expected = base[axis] + repetition * delta[axis];
        assert.equal(Math.fround(expected), expected);
        assert.equal(replay[axis], expected);
      }
      replay = add3Float32(replay,
        candidate.context.surfaces[candidate.history[event].selected].translation);
    }
  }
}

console.log(JSON.stringify({
  sequentialFloat32: sequential[0],
  deferredFloat32: Math.fround(16777214 + 4),
  cycleLimit: "infinite",
  boundaryLimit: 2,
  alignedLimit: 1 << 20,
  randomizedProofs: 256
}, null, 2));
