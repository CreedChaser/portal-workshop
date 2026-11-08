import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const api = require('./portal-workshop-engine.umd.js');
export default api;
export const {
  VERSION, SCENE_VERSION, CORPUS_VERSION, SUPPORTED_ENVELOPE,
  normalizeScene, validateScene, stableStringify, encodeScene, decodeScene,
  sceneFingerprint, portalMatrix, portalTeleport, mapPointThrough,
  mapVectorThrough, apertureContains, deterministicCrossing, traceMovement,
  traceRay, fairSchedule, attachRuntime, runtime, _internals
} = api;
