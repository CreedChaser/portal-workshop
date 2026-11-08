# Architecture

## Release surfaces

The release deliberately keeps both forms that were valuable in the inherited project:

1. **Modular canonical source** — `workspace/3js-portals/Portals+Compressed Space.html` loads the engine UMD and retained screen-DAG source for review and continued development.
2. **Portable production build** — `workspace/3js-portals/dist/Portal Workshop.html` embeds those dependencies into one directly openable HTML file.


## Canonical render path

The pure-portal default is a per-frame Euclidean scene expansion. A room copy has a complete transform, clip/aperture ownership, level, source portal, and screen-area estimate. Rendering remains ordinary Three.js rasterization; no ray or hybrid portal substitute is selected for canonical scenes.

The former global depth-first cap could spend all capacity in the first visible recursive loop. The release builder uses a FIFO breadth queue and pending-sibling reservations. A candidate is admitted only when there is room for it and every already-visible sibling awaiting work. This keeps simultaneous branches within one level of each other under finite capacity. Rejected candidates do not open apertures; the portal surface stays closed as a conservative terminal.

Release metadata is exposed through `window.__portalRendererInfo()` and `window.__portalDebug`. The product labels canonical pure portals as `euclidean-exact-fair` and compressed-space scenes as `metric-bounded-extension`.

## Engine boundary

`engine/portal-workshop-engine.umd.js` is dependency-free. `engine/portal-workshop-engine.mjs` re-exports the identical API for Node/browser modules. It owns serializable concerns:

- scene normalization, validation, deterministic encoding, and fingerprints;
- portal aperture tests for rectangle, circle, oval, and triangle;
- source-to-target teleport matrices;
- deterministic overlap/crossing ownership;
- finite movement and ray traces;
- the reusable breadth-fair scheduler;
- a narrow live-workshop runtime adapter.

Three.js meshes, materials, cameras, and editor visuals remain renderer concerns and are not exposed as engine state.

## Editor and persistence

The live workshop owns portal-pair creation, selection, pointer hit testing, move/resize/rotate operations, copy/cut/paste/duplicate/delete, linked-endpoint selection, and bounded undo/redo. Scene state is serializable and remains compatible with the retained URL scene token workflow. Edit mode does not force the user to leave pointer interaction for ordinary selection/manipulation.

## Oracles

The release oracle has two layers:

- **semantic:** eight fixed scenes with fingerprints, depth rays, movement traces, crossing ownership, resize targets, editor requirements, and lifecycle requirements;
- **visual:** exact 640×360 RGBA reference images captured from the production standalone in Chromium 144 with ANGLE Vulkan SwiftShader.

The corpus includes a basic pair, simultaneous loops, coincident ownership, a portal-plane boundary, all supported shapes, scaled/rotated endpoints, editor operations, and the compressed-space opt-in lane.
