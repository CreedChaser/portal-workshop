# Portal Workshop Engine API

`engine/portal-workshop-engine.mjs` is the dependency-free reusable core. The
standalone build embeds the identical UMD source and exposes
`window.PortalWorkshopEngine`.

## Scene and persistence

- `normalizeScene(scene, options)` returns canonical scene version 2 data.
- `validateScene(scene)` returns `{ok, errors, warnings, scene}`.
- `encodeScene(scene)` / `decodeScene(token)` provide deterministic UTF-8
  base64url persistence.
- `stableStringify(scene)` and `sceneFingerprint(scene)` support reproducible
  fixtures and cache keys.

## Portal geometry and movement

- `portalTeleport(source, target)` returns the rigid source-to-target matrix.
- `deterministicCrossing(scene, from, to)` chooses the earliest portal, then
  resolves ties by explicit priority and stable ID.
- `traceMovement(scene, from, delta, options)` maps movement through multiple
  portals with a finite crossing envelope.
- `traceRay(scene, origin, direction, options)` resolves portal events and the
  terminal room face for depth/movement oracles.

Rectangle, circle, oval, and triangle apertures are supported.

## Fair bounded work

`fairSchedule(root, expand, options)` is a breadth-fair scheduler. Pending
visible branches reserve one copy each before deeper work is accepted. Work
beyond the cap is returned as conservative terminals instead of being opened
as unowned holes. `stats.fairnessSpan` makes starvation regressions auditable.

## Live workshop adapter

The canonical HTML binds its editor/runtime to the core. After load:

```js
const runtime = PortalWorkshopEngine.runtime();
runtime.getScene();
runtime.loadScene(scene);
runtime.setEditMode(true);
runtime.addPair('oval');
runtime.undo();
runtime.getState();
```

The adapter intentionally exposes serializable state, not Three.js objects.
