# Current portal tools

This directory is intentionally limited to code that directly supports the
retained portal implementations.

- `portal-screen-dag.js` is loaded at runtime by the source shell and is also
  the optional Euclidean DAG backend already referenced by
  `Portals+Compressed Space.html`.
- `test-portal-screen-dag-boundary.mjs` verifies exact portal-plane ownership.
- `test-portal-screen-dag-float32.mjs` verifies the float32 recurrence proofs
  used by the DAG runtime.
- `portal-screen-dag-scene-probe.js` provides a small deterministic scene
  exercise for performance and raster-ownership investigation.
- `portal-screen-dag-integration.md` documents the renderer contract.

Run the focused checks with Node 20 or newer:

```sh
node tools/test-portal-screen-dag-boundary.mjs
node tools/test-portal-screen-dag-float32.mjs
node tools/portal-screen-dag-scene-probe.js 640 360
```
