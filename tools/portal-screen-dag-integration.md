# Per-frame Euclidean portal renderer

`portal-screen-dag.js` constructs a camera-centred Euclidean screen world for
pure-translation rectangle portals. The renderer never mixes that result with
direct portal rendering: every finite pixel is written to one RGBA32F state
map first, and one loop-free full-screen pass is solely responsible for visible
portal color and depth.

## State construction

The state texture stores:

- `rgb`: final canonical translation relative to the root camera ray;
- `a`: `min(crossings, 2047) * 8 + face + 1` (`0` means void/unwritten).

The CPU decision DAG certifies broad convex regions and writes their completed
state with a 14-line fragment shader. Numerically guarded boundary regions are
completed into the same texture by the exact four-portal event predicate. That
predicate has no framebuffer access and performs no lighting, grid, color, or
depth work.

The production budget is six events for the largest cells under a 900-cell
limit. On the supplied 1728x1080 stress scene this certifies about 69.8% of the
screen on the CPU; the GPU completes the remaining 30.2%. Exact raster
ownership covers all 1,866,240 pixels with no overlap or uncovered sample.

## Final resolve

The final pass fetches one state texel, reconstructs the translated room, and
intersects one ordinary room plane with one straight ray. It retains the
original `pairWriteRoom` implementation, so wall lighting, grid coordinates,
debug heat, sRGB output, and authoritative root-space depth are unchanged. It
contains no portal candidate test, traversal loop, recurrence, or fallback.

The four-portal runtime is fail-closed: if Euclidean state construction fails,
it clears the frame and reports the error instead of silently selecting the
old recursive or direct-ray renderer. Exact portal-plane camera positions use
the same deterministic state-map ownership.

## Inputs

Pass the rows already produced by `workshopRayMultiRectData`:

```js
{
  origin: [cameraX, cameraY, cameraZ],
  ray: { c, x, y },
  roomHalf: [hx, hy, hz],
  viewport: [drawingBufferWidth, drawingBufferHeight],
  interiorInvariant: true,
  portals: [{
    u: [ux,uy,uz,uw], v: [vx,vy,vz,vw], n: [nx,ny,nz,nw],
    bounds: [minX,minY,maxX,maxY], translation: [tx,ty,tz],
    group, targetGroup, targetIndex, rank
  }],
  limits: { maxEventsPerCell: 6, maxCells: 900, maxWord: 4 }
}
```

## GPU sequence

1. Clear the RGBA32F Euclidean state target to zero.
2. Draw `result.geometry` with the tiny certified-state material.
3. Draw `result.stateBuildGeometry` with the guarded state-completion material.
4. Clear the default framebuffer.
5. Draw one full-screen triangle with the loop-free resolve material.
6. Draw editor frames and gizmos.

Only steps 5 and 6 target the visible framebuffer.

## Regression checks

- `test-portal-screen-dag.mjs` validates terminal states, residual prefixes,
  typed streams, dense samples, exact raster ownership, and optional exhaustive
  residual pixel traces.
- `test-portal-screen-dag-randomized.mjs` runs deterministic camera/FOV
  regressions.
- `test-portal-dag-angle.mjs` reconstructs the production GLSL, compiles and
  links all three programs on ANGLE ES 3, then validates both state-construction
  paths through the same straight resolver, including final color and depth.
