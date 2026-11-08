/*
 * Exact screen-space decision DAG prototype for pure-translation portals.
 *
 * This file is intentionally standalone while the production shader is being
 * changed elsewhere.  It contains no Three.js dependency.  The intended
 * integration point supplies the already-certified translation portal rows
 * used by workshopRayMultiRectData and the affine world-ray basis produced by
 * the camera vertex shader.
 *
 * A ray is D(x,y) = ray.c + x*ray.x + y*ray.y.  At a fixed canonical
 * translation S, every portal/wall plane time, aperture edge test, and
 * nearest-hit comparison is a linear form in NDC.  The builder below clips
 * convex NDC polygons until one complete event word is certified for every
 * pixel in a polygon.  Terminal polygons need only {translation, wallFace};
 * the remaining narrow numerical bands are returned as state-completion
 * polygons.  Both streams construct the same Euclidean map before rendering.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PortalScreenDag = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EPS64 = Number.EPSILON;
  const GPU_EPS = 1.1920928955078125e-7;
  const INF = Number.POSITIVE_INFINITY;

  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  // Portal translations are highp vec3 uniforms, and the authoritative GPU
  // state is rounded after every addition.  Keeping the CPU state in binary64
  // until attribute upload can choose a different event after only a few
  // crossings, even though the final attribute itself is a Float32Array.
  const add3Float32 = (a, b) => [
    Math.fround(Math.fround(a[0]) + Math.fround(b[0])),
    Math.fround(Math.fround(a[1]) + Math.fround(b[1])),
    Math.fround(Math.fround(a[2]) + Math.fround(b[2]))
  ];
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const dot4Point = (r, p) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3];
  const copyPoint = p => ({ x: p.x, y: p.y });

  function line(a = 0, b = 0, c = 0) { return { a, b, c }; }
  function lineScale(l, s) { return line(l.a * s, l.b * s, l.c * s); }
  function lineAdd(a, b, sa = 1, sb = 1) {
    return line(a.a * sa + b.a * sb, a.b * sa + b.b * sb, a.c * sa + b.c * sb);
  }
  function lineEval(l, p) { return l.a * p.x + l.b * p.y + l.c; }
  function lineNorm(l) { return Math.hypot(l.a, l.b) + Math.abs(l.c) * GPU_EPS + 1e-30; }

  function rayLinearDot(normal, ray) {
    return line(dot3(normal, ray.x), dot3(normal, ray.y), dot3(normal, ray.c));
  }

  function polygonArea(poly) {
    let twice = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      twice += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    }
    return twice * 0.5;
  }

  function polygonCentroid(poly) {
    let crossSum = 0, x = 0, y = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const cross = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
      crossSum += cross;
      x += (poly[j].x + poly[i].x) * cross;
      y += (poly[j].y + poly[i].y) * cross;
    }
    if (Math.abs(crossSum) > 1e-24) return { x: x / (3 * crossSum), y: y / (3 * crossSum) };
    x = 0; y = 0;
    for (const p of poly) { x += p.x; y += p.y; }
    return { x: x / poly.length, y: y / poly.length };
  }

  function clipPolygon(poly, l, threshold = 0) {
    if (!poly || poly.length < 3) return [];
    const out = [];
    let previous = poly[poly.length - 1];
    let previousValue = lineEval(l, previous) - threshold;
    for (const current of poly) {
      const currentValue = lineEval(l, current) - threshold;
      const previousInside = previousValue >= 0;
      const currentInside = currentValue >= 0;
      if (previousInside !== currentInside) {
        const denominator = previousValue - currentValue;
        if (Math.abs(denominator) > 1e-300) {
          const t = previousValue / denominator;
          out.push({
            x: previous.x + (current.x - previous.x) * t,
            y: previous.y + (current.y - previous.y) * t
          });
        }
      }
      if (currentInside) out.push(copyPoint(current));
      previous = current;
      previousValue = currentValue;
    }
    return cleanPolygon(out);
  }

  function cleanPolygon(poly) {
    if (!poly || poly.length < 3) return [];
    const out = [];
    for (const p of poly) {
      const q = out[out.length - 1];
      if (!q) out.push(p);
      else {
        const dx = p.x - q.x, dy = p.y - q.y;
        if (dx * dx + dy * dy > 1e-26) out.push(p);
      }
    }
    if (out.length > 2) {
      const a = out[0], b = out[out.length - 1];
      const dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy <= 1e-26) out.pop();
    }
    if (out.length < 3 || Math.abs(polygonArea(out)) < 1e-20) return [];
    return out;
  }

  function lineGuardPixels(l, px, py, multiplier = 0.625) {
    const raster = multiplier * (Math.abs(l.a) * px + Math.abs(l.b) * py);
    // Half a drawing-buffer pixel is enough to contain every sample whose
    // CPU-clipped triangle and GPU float32 predicate can land on opposite
    // sides.  The extra eighth-pixel plus a 64-ulp coefficient envelope cover
    // raster and interpolation rounding without turning dense recursive edge
    // sets into large GPU-completion regions.
    const arithmetic = 64 * GPU_EPS * (Math.abs(l.a) + Math.abs(l.b) + Math.abs(l.c) + 1);
    return raster + arithmetic + 256 * EPS64;
  }

  function lineGuard(l, viewport, multiplier = 0.625) {
    return lineGuardPixels(l, 2 / Math.max(1, viewport[0]),
      2 / Math.max(1, viewport[1]), multiplier);
  }

  function splitWithGuard(poly, l, viewport) {
    const pad = lineGuard(l, viewport);
    const positive = clipPolygon(poly, l, pad);
    const negative = clipPolygon(poly, lineScale(l, -1), pad);
    let band = clipPolygon(poly, l, -pad);
    band = clipPolygon(band, lineScale(l, -1), -pad);
    return { positive, negative, band, pad };
  }

  function splitForContext(poly, l, context) {
    if (!context.pureEuclidean) return splitWithGuard(poly, l, context.viewport);
    return {
      positive: clipPolygon(poly, l, 0),
      negative: clipPolygon(poly, lineScale(l, -1), 0),
      band: [], pad: 0
    };
  }

  function pointInConvex(poly, p) {
    let sign = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j], b = poly[i];
      const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (Math.abs(cross) < 1e-14) continue;
      const next = cross > 0 ? 1 : -1;
      if (sign && sign !== next) return false;
      sign = next;
    }
    return true;
  }

  // Conservative for large polygons; exact for a small pixel-center box.
  function polygonMayCoverSample(poly, viewport) {
    if (!poly || poly.length < 3) return false;
    let minX = INF, minY = INF, maxX = -INF, maxY = -INF;
    for (const p of poly) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const w = viewport[0], h = viewport[1];
    const x0 = Math.max(0, Math.ceil(((minX + 1) * w - 1) * 0.5));
    const x1 = Math.min(w - 1, Math.floor(((maxX + 1) * w - 1) * 0.5));
    const y0 = Math.max(0, Math.ceil(((minY + 1) * h - 1) * 0.5));
    const y1 = Math.min(h - 1, Math.floor(((maxY + 1) * h - 1) * 0.5));
    if (x0 > x1 || y0 > y1) return false;
    const pixelArea = Math.abs(polygonArea(poly)) * w * h * 0.25;
    if (pixelArea > 64) return true;

    // A diagonal subpixel sliver can have a huge axis-aligned bounding box.
    // The previous box-area shortcut retained those cells indefinitely and
    // made deep pure-Euclidean builds explode.  For low-area convex cells,
    // scan the shorter pixel-grid axis and test its exact intersection
    // interval.  This rejects only polygons containing no physical sample.
    if (y1 - y0 <= x1 - x0) {
      for (let y = y0; y <= y1; ++y) {
        const py = (2 * y + 1) / h - 1;
        let rowMin = INF, rowMax = -INF;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const a = poly[j], b = poly[i];
          if (Math.abs(a.y - py) <= 1e-14) {
            rowMin = Math.min(rowMin, a.x); rowMax = Math.max(rowMax, a.x);
          }
          if ((a.y < py && b.y > py) || (b.y < py && a.y > py)) {
            const x = a.x + (b.x - a.x) * ((py - a.y) / (b.y - a.y));
            rowMin = Math.min(rowMin, x); rowMax = Math.max(rowMax, x);
          }
        }
        if (!(rowMin <= rowMax)) continue;
        const first = Math.max(x0, Math.ceil(((rowMin + 1) * w - 1) * 0.5 - 1e-12));
        const last = Math.min(x1, Math.floor(((rowMax + 1) * w - 1) * 0.5 + 1e-12));
        if (first <= last) return true;
      }
    } else {
      for (let x = x0; x <= x1; ++x) {
        const px = (2 * x + 1) / w - 1;
        let columnMin = INF, columnMax = -INF;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const a = poly[j], b = poly[i];
          if (Math.abs(a.x - px) <= 1e-14) {
            columnMin = Math.min(columnMin, a.y); columnMax = Math.max(columnMax, a.y);
          }
          if ((a.x < px && b.x > px) || (b.x < px && a.x > px)) {
            const y = a.y + (b.y - a.y) * ((px - a.x) / (b.x - a.x));
            columnMin = Math.min(columnMin, y); columnMax = Math.max(columnMax, y);
          }
        }
        if (!(columnMin <= columnMax)) continue;
        const first = Math.max(y0, Math.ceil(((columnMin + 1) * h - 1) * 0.5 - 1e-12));
        const last = Math.min(y1, Math.floor(((columnMax + 1) * h - 1) * 0.5 + 1e-12));
        if (first <= last) return true;
      }
    }
    return false;
  }

  function worldBoundEdges(axisA, extentA, axisB, extentB) {
    const result = [];
    for (const [axis, extent] of [[axisA, extentA], [axisB, extentB]]) {
      const lower = [0, 0, 0, extent]; lower[axis] = 1;
      const upper = [0, 0, 0, extent]; upper[axis] = -1;
      result.push(lower, upper);
    }
    return result;
  }

  function makeWallSurfaces(roomHalf, firstIndex) {
    const walls = [];
    const faceSpecs = [
      [0, roomHalf[0], 1, roomHalf[1], 2, roomHalf[2]],
      [0, -roomHalf[0], 1, roomHalf[1], 2, roomHalf[2]],
      [1, roomHalf[1], 0, roomHalf[0], 2, roomHalf[2]],
      [1, -roomHalf[1], 0, roomHalf[0], 2, roomHalf[2]],
      [2, roomHalf[2], 0, roomHalf[0], 1, roomHalf[1]],
      [2, -roomHalf[2], 0, roomHalf[0], 1, roomHalf[1]]
    ];
    for (let face = 0; face < faceSpecs.length; ++face) {
      const [axis, coordinate, axisA, extentA, axisB, extentB] = faceSpecs[face];
      const n = [0, 0, 0]; n[axis] = 1;
      walls.push({
        index: firstIndex + face, kind: "wall", face, n, c: -coordinate,
        edges: worldBoundEdges(axisA, extentA, axisB, extentB),
        priority: 100 + face, group: -1, targetGroup: -1, targetIndex: -1,
        translation: [0, 0, 0]
      });
    }
    return walls;
  }

  function portalWorldEdges(portal) {
    const u = portal.u, v = portal.v, b = portal.bounds;
    return [
      [u[0], u[1], u[2], u[3] - b[0]],
      [-u[0], -u[1], -u[2], b[2] - u[3]],
      [v[0], v[1], v[2], v[3] - b[1]],
      [-v[0], -v[1], -v[2], b[3] - v[3]]
    ];
  }

  function makeSurfaces(portals, roomHalf) {
    const surfaces = portals.map((p, index) => ({
      index, kind: "portal", face: -1,
      n: p.n.slice(0, 3), c: p.n[3], edges: portalWorldEdges(p),
      priority: p.rank == null ? index : p.rank,
      group: p.group, targetGroup: p.targetGroup, targetIndex: p.targetIndex,
      // Match the value received by a highp vec3 uniform even when callers
      // provide an unquantized JavaScript number.
      translation: p.translation.slice(0, 3).map(Math.fround)
    }));
    surfaces.push(...makeWallSurfaces(roomHalf, surfaces.length));
    return surfaces;
  }

  function shiftedBase(context, shift) { return add3(context.origin, shift); }
  function surfaceA(surface, context, shift) {
    if (surface._originA !== undefined) {
      return surface._originA + surface.n[0] * shift[0] +
        surface.n[1] * shift[1] + surface.n[2] * shift[2];
    }
    return dot3(surface.n, shiftedBase(context, shift)) + surface.c;
  }
  function surfaceDen(surface, context) {
    return surface._den || context.denLines[surface.index];
  }

  function prepareSurfaceLines(context) {
    const ox = context.origin[0], oy = context.origin[1], oz = context.origin[2];
    for (const surface of context.surfaces) {
      surface._originA = surface.n[0] * ox + surface.n[1] * oy + surface.n[2] * oz + surface.c;
      surface._den = context.denLines[surface.index];
      surface._edgeOrigins = new Float64Array(surface.edges.length);
      surface._edgeDens = new Array(surface.edges.length);
      for (let edgeIndex = 0; edgeIndex < surface.edges.length; ++edgeIndex) {
        const edge = surface.edges[edgeIndex];
        surface._edgeOrigins[edgeIndex] = edge[0] * ox + edge[1] * oy + edge[2] * oz + edge[3];
        surface._edgeDens[edgeIndex] = line(
          edge[0] * context.ray.x[0] + edge[1] * context.ray.x[1] + edge[2] * context.ray.x[2],
          edge[0] * context.ray.y[0] + edge[1] * context.ray.y[1] + edge[2] * context.ray.y[2],
          edge[0] * context.ray.c[0] + edge[1] * context.ray.c[1] + edge[2] * context.ray.c[2]
        );
      }
    }
  }

  // Hot-path certificates use six packed numbers instead of allocating a
  // descriptor object for every predicate considered by every BSP cell.
  // [kind, first, second, signA, signB, orientation]
  const PACK_FORWARD = 1;
  const PACK_EDGE = 2;
  const PACK_COMPARE = 3;

  function writePackedLine(kind, first, second, signA, signB, orientation,
                           context, shift, out, surfaceValues = null) {
    const surfaces = context.surfaces;
    let a = 0, b = 0, c = 0;
    if (kind === PACK_FORWARD) {
      const s = surfaces[first];
      if (second < 0) {
        c = -(surfaceValues ? surfaceValues[first] : surfaceA(s, context, shift)) * signA * orientation;
      } else {
        const q = surfaces[second];
        const as = surfaceValues ? surfaceValues[first] : surfaceA(s, context, shift);
        const aq = surfaceValues ? surfaceValues[second] : surfaceA(q, context, shift);
        const ds = surfaceDen(s, context), dq = surfaceDen(q, context);
        const scale = signA * signB * orientation;
        a = (ds.a * aq - dq.a * as) * scale;
        b = (ds.b * aq - dq.b * as) * scale;
        c = (ds.c * aq - dq.c * as) * scale;
      }
    } else if (kind === PACK_EDGE) {
      const s = surfaces[first], edge = s.edges[second];
      const g0 = s._edgeOrigins ? s._edgeOrigins[second] +
        edge[0] * shift[0] + edge[1] * shift[1] + edge[2] * shift[2] :
        dot4Point(edge, shiftedBase(context, shift));
      const gd = s._edgeDens ? s._edgeDens[second] : rayLinearDot(edge.slice(0, 3), context.ray);
      const as = surfaceValues ? surfaceValues[first] : surfaceA(s, context, shift);
      const ds = surfaceDen(s, context);
      const scale = signA * orientation;
      a = (ds.a * g0 - gd.a * as) * scale;
      b = (ds.b * g0 - gd.b * as) * scale;
      c = (ds.c * g0 - gd.c * as) * scale;
    } else if (kind === PACK_COMPARE) {
      const i = surfaces[first], j = surfaces[second];
      const ai = surfaceValues ? surfaceValues[first] : surfaceA(i, context, shift);
      const aj = surfaceValues ? surfaceValues[second] : surfaceA(j, context, shift);
      const di = surfaceDen(i, context), dj = surfaceDen(j, context);
      const scale = signA * signB * orientation;
      a = (dj.a * ai - di.a * aj) * scale;
      b = (dj.b * ai - di.b * aj) * scale;
      c = (dj.c * ai - di.c * aj) * scale;
    } else {
      throw new Error(`Unknown packed portal DAG descriptor ${kind}`);
    }
    out.a = a; out.b = b; out.c = c;
    return out;
  }

  function descriptorLine(descriptor, context, shift) {
    const surfaces = context.surfaces;
    if (descriptor.kind === "constant") return line(0, 0, descriptor.value * descriptor.orientation);
    if (descriptor.kind === "den") return lineScale(surfaceDen(surfaces[descriptor.surface], context), descriptor.orientation);
    if (descriptor.kind === "forward") return writePackedLine(PACK_FORWARD,
      descriptor.surface, descriptor.current, descriptor.denSign, descriptor.currentDenSign,
      descriptor.orientation, context, shift, line());
    if (descriptor.kind === "edge") return writePackedLine(PACK_EDGE,
      descriptor.surface, descriptor.edge, descriptor.denSign, 0,
      descriptor.orientation, context, shift, line());
    if (descriptor.kind === "compare") return writePackedLine(PACK_COMPARE,
      descriptor.first, descriptor.second, descriptor.firstDenSign, descriptor.secondDenSign,
      descriptor.orientation, context, shift, line());
    throw new Error(`Unknown portal DAG descriptor ${descriptor.kind}`);
  }

  function eligibilityDescriptors(surface, state, context) {
    const signs = state.denSigns;
    const descriptors = [{
      kind: "forward", surface: surface.index, current: state.currentSurface,
      denSign: signs[surface.index],
      currentDenSign: state.currentSurface < 0 ? 1 : signs[state.currentSurface],
      orientation: 1
    }];
    for (let edge = 0; edge < surface.edges.length; ++edge) descriptors.push({
      kind: "edge", surface: surface.index, edge,
      denSign: signs[surface.index], orientation: 1
    });
    return descriptors;
  }

  function descriptorNegated(descriptor) {
    return Object.assign({}, descriptor, { orientation: -(descriptor.orientation || 1) });
  }

  function comparisonDescriptor(first, second, state) {
    return {
      kind: "compare", first: first.index, second: second.index,
      firstDenSign: state.denSigns[first.index], secondDenSign: state.denSigns[second.index],
      orientation: 1
    };
  }

  function directionAt(context, p) {
    return [
      context.ray.c[0] + context.ray.x[0] * p.x + context.ray.y[0] * p.y,
      context.ray.c[1] + context.ray.x[1] * p.x + context.ray.y[1] * p.y,
      context.ray.c[2] + context.ray.x[2] * p.x + context.ray.y[2] * p.y
    ];
  }

  function classifyEvent(point, state, context) {
    const direction = directionAt(context, point);
    const base = shiftedBase(context, state.shift);
    let currentTime = 0;
    if (state.currentSurface >= 0) {
      const current = context.surfaces[state.currentSurface];
      const divisor = dot3(current.n, direction);
      if (Math.abs(divisor) < 1e-20) return null;
      currentTime = -(dot3(current.n, base) + current.c) / divisor;
    }
    let best = null;
    function considerRange(first, last) {
      for (let surfaceIndex = first; surfaceIndex < last; ++surfaceIndex) {
      const surface = context.surfaces[surfaceIndex];
      if (surface.kind === "portal" && surface.group === state.skipGroup) continue;
      const divisor = dot3(surface.n, direction);
      if (Math.abs(divisor) < 1e-20) continue;
      const time = -(dot3(surface.n, base) + surface.c) / divisor;
      const timeTolerance = 256 * GPU_EPS * (Math.abs(time) + Math.abs(currentTime) + 1);
      if (!(time > currentTime + timeTolerance)) continue;
      const hit = add3(base, scale3(direction, time));
      let inside = true;
      for (const edge of surface.edges) {
        const value = dot4Point(edge, hit);
        const edgeTolerance = 256 * GPU_EPS *
          (Math.abs(edge[0] * hit[0]) + Math.abs(edge[1] * hit[1]) +
           Math.abs(edge[2] * hit[2]) + Math.abs(edge[3]) + 1);
        if (value < -edgeTolerance) { inside = false; break; }
      }
      if (!inside) continue;
      if (!best) best = { surface, time };
      else {
        const tolerance = 256 * GPU_EPS * (Math.abs(time) + Math.abs(best.time) + 1);
        if (time < best.time - tolerance ||
            (Math.abs(time - best.time) <= tolerance && surface.priority < best.surface.priority)) {
          best = { surface, time };
        }
      }
      }
    }
    if (context.interiorInvariant) {
      // Every accepted portal aperture is contained in the convex room and
      // the current ray point is either the in-room camera or an in-room
      // target aperture.  A segment between those points cannot cross a room
      // wall first, so portal candidates are authoritative without six
      // redundant portal-vs-wall comparisons.
      considerRange(0, context.portalCount);
      if (best) return best;
      considerRange(context.portalCount, context.surfaces.length);
    } else {
      considerRange(0, context.surfaces.length);
    }
    return best;
  }

  function minimumSafeValue(poly, l, context) {
    const pad = lineGuard(l, context.viewport);
    let minimum = INF;
    for (const p of poly) minimum = Math.min(minimum, lineEval(l, p) - pad);
    return { minimum, pad };
  }

  function normalizedAt(l, p) { return lineEval(l, p) / lineNorm(l); }

  // Return either a complete conjunction certificate or the best BSP line on
  // which to split.  A competitor loses through a disjunction: it is behind,
  // outside one aperture edge, or farther away.  We choose a true reason at
  // the representative point, then BSP the remainder if that reason is not
  // globally true.
  function certifyEvent(poly, state, selected, context) {
    const representative = polygonCentroid(poly);
    if (!context._surfaceValues) {
      context._surfaceValues = new Float64Array(context.surfaces.length);
      prepareSurfaceLines(context);
    }
    const surfaceValues = context._surfaceValues;
    for (let i = 0; i < context.surfaces.length; ++i) {
      const surface = context.surfaces[i];
      surfaceValues[i] = surface._originA + surface.n[0] * state.shift[0] +
        surface.n[1] * state.shift[1] + surface.n[2] * state.shift[2];
    }
    // Certificates stay packed for their entire lifetime.  This removes the
    // dominant source of garbage in the shallow camera-update tier: the old
    // implementation allocated and copied roughly fifty descriptor objects
    // per visited cell, including every losing disjunction candidate.
    const certificate = [];
    const scratch = line();
    let bestFailure = false, bestFailureScore = -INF;
    let failureA = 0, failureB = 0, failureC = 0;

    function rememberCertificate(kind, first, second, signA, signB, orientation) {
      certificate.push(kind, first, second, signA, signB, orientation);
    }

    function guardedMinimum(l) {
      const pad = context.pureEuclidean ? 0 : lineGuardPixels(l, context.pixelX, context.pixelY);
      let minimum = INF;
      for (let i = 0; i < poly.length; ++i) {
        const p = poly[i];
        minimum = Math.min(minimum, l.a * p.x + l.b * p.y + l.c - pad);
      }
      return minimum;
    }

    function considerRequired(kind, first, second, signA, signB, orientation) {
      const l = writePackedLine(kind, first, second, signA, signB, orientation,
        context, state.shift, scratch, surfaceValues);
      if (!(lineEval(l, representative) > 0)) return true;
      const norm = lineNorm(l);
      const minimum = guardedMinimum(l);
      // Sutherland-Hodgman places new vertices exactly on the guarded split
      // line.  The central completion strip already owns those boundary sample
      // locations, so a roundoff-sized zero here is certified, not split a
      // second time into an identical polygon.
      if (minimum >= -1e-12 * norm) {
        rememberCertificate(kind, first, second, signA, signB, orientation);
        return false;
      }
      const score = minimum / norm;
      if (!bestFailure || score > bestFailureScore) {
        bestFailure = true; bestFailureScore = score;
        failureA = l.a; failureB = l.b; failureC = l.c;
      }
      return false;
    }

    const selectedSign = state.denSigns[selected.index];
    const currentSign = state.currentSurface < 0 ? 1 : state.denSigns[state.currentSurface];
    if (considerRequired(PACK_FORWARD, selected.index, state.currentSurface,
      selectedSign, currentSign, 1)) {
      return { fallback: true, line: line(scratch.a, scratch.b, scratch.c) };
    }
    for (let edge = 0; edge < selected.edges.length; ++edge) {
      if (considerRequired(PACK_EDGE, selected.index, edge, selectedSign, 0, 1)) {
        return { fallback: true, line: line(scratch.a, scratch.b, scratch.c) };
      }
    }

    for (let competitorIndex = 0; competitorIndex < context.surfaces.length; ++competitorIndex) {
      const competitor = context.surfaces[competitorIndex];
      if (competitor.index === selected.index) continue;
      if (competitor.kind === "portal" && competitor.group === state.skipGroup) continue;
      if (context.interiorInvariant && selected.kind === "portal" && competitor.kind === "wall") continue;
      // From an in-room camera or target aperture, a certified point on one
      // bounded box face is necessarily the first room boundary reached by
      // that segment.  The selected wall's four edge predicates already split
      // adjacent-face transitions (and their tie band), so comparing it with
      // the other five walls is redundant in the same convex-room invariant.
      if (context.interiorInvariant && selected.kind === "wall" && competitor.kind === "wall") continue;

      let hasTrue = false, chosenSafe = -INF, chosenCenter = -INF, chosenNorm = 1;
      let chosenKind = 0, chosenFirst = 0, chosenSecond = 0;
      let chosenSignA = 0, chosenSignB = 0, chosenOrientation = 1;
      let chosenA = 0, chosenB = 0, chosenC = 0;

      function considerLoss(kind, first, second, signA, signB, orientation) {
        const l = writePackedLine(kind, first, second, signA, signB, orientation,
          context, state.shift, scratch, surfaceValues);
        const centerValue = lineEval(l, representative);
        if (!(centerValue > 0)) return;
        const norm = lineNorm(l);
        const center = centerValue / norm;
        const safe = guardedMinimum(l);
        if (!hasTrue || safe > chosenSafe || (safe === chosenSafe && center > chosenCenter)) {
          hasTrue = true; chosenSafe = safe; chosenCenter = center; chosenNorm = norm;
          chosenKind = kind; chosenFirst = first; chosenSecond = second;
          chosenSignA = signA; chosenSignB = signB; chosenOrientation = orientation;
          chosenA = l.a; chosenB = l.b; chosenC = l.c;
        }
      }

      const competitorSign = state.denSigns[competitor.index];
      considerLoss(PACK_FORWARD, competitor.index, state.currentSurface,
        competitorSign, currentSign, -1);
      for (let edge = 0; edge < competitor.edges.length; ++edge) {
        considerLoss(PACK_EDGE, competitor.index, edge, competitorSign, 0, -1);
      }
      considerLoss(PACK_COMPARE, selected.index, competitor.index,
        selectedSign, competitorSign, 1);

      if (!hasTrue) {
        // This is an ownership/tolerance tie.  The authoritative shader owns
        // the deliberately narrow band rather than letting CPU float64 choose.
        writePackedLine(PACK_COMPARE, selected.index, competitor.index,
          selectedSign, competitorSign, 1, context, state.shift, scratch, surfaceValues);
        return { fallback: true, line: line(scratch.a, scratch.b, scratch.c) };
      }
      if (chosenSafe >= -1e-12 * chosenNorm) {
        rememberCertificate(chosenKind, chosenFirst, chosenSecond,
          chosenSignA, chosenSignB, chosenOrientation);
      }
      else {
        const score = chosenSafe / chosenNorm;
        if (!bestFailure || score > bestFailureScore) {
          bestFailure = true; bestFailureScore = score;
          failureA = chosenA; failureB = chosenB; failureC = chosenC;
        }
      }
    }

    if (bestFailure) return { split: true, line: line(failureA, failureB, failureC) };
    return { certificate };
  }

  function phaseKey(state) { return `${state.currentSurface}/${state.skipGroup}`; }
  // The authoritative shader cannot enter its batch accelerator before three
  // accepted crossings.  Keep the terminal fast path to the first two known
  // portals, whose exact scalar arithmetic can be replayed without any portal
  // search.  Deeper/jumped states remain Euclidean-state construction pixels,
  // but use the unchanged authoritative arithmetic there.
  const TERMINAL_REPLAY_MAX = 2;

  function cloneState(state) {
    return {
      shift: state.shift.slice(), currentSurface: state.currentSurface,
      skipGroup: state.skipGroup, denSigns: state.denSigns,
      crossings: state.crossings,
      // A boundary seed is the state immediately after accepting a portal at
      // zero root travel.  It is observable only when this state must be sent
      // to the GPU completion pass; the next ordinary portal event clears it.
      boundarySeed: state.boundarySeed === true,
      // replayBoundaryPortal persists after the immediate boundarySeed flag is
      // cleared.  Descendants must still begin at the history-owned zero-time
      // contact state if they later enter GPU completion or terminal replay.
      replayBoundaryPortal: Number.isInteger(state.replayBoundaryPortal) ?
        state.replayBoundaryPortal : -1,
      replayWord: Array.isArray(state.replayWord) ? state.replayWord.slice() :
        state.replayWord === null ? null : []
    };
  }

  function advancePortal(state, portal) {
    const next = cloneState(state);
    next.shift = add3Float32(next.shift, portal.translation);
    next.currentSurface = portal.targetIndex;
    next.skipGroup = portal.targetGroup;
    next.crossings += 1;
    next.boundarySeed = false;
    if (Array.isArray(next.replayWord)) {
      if (next.replayWord.length < TERMINAL_REPLAY_MAX)
        next.replayWord.push(portal.index);
      else next.replayWord = null;
    }
    return next;
  }

  const FLOAT32_WORD_DIRECT_PROOF = 256;
  const FLOAT32_WORD_JUMP_CAP = 1 << 20;
  const float32BitBuffer = new ArrayBuffer(4);
  const float32BitValue = new Float32Array(float32BitBuffer);
  const float32BitWord = new Uint32Array(float32BitBuffer);

  function float32Bits(value) {
    float32BitValue[0] = value;
    return float32BitWord[0];
  }

  function sameFloat32(a, b) {
    return Number.isFinite(a) && Number.isFinite(b) &&
      Math.fround(a) === a && Math.fround(b) === b &&
      float32Bits(a) === float32Bits(b);
  }

  function sameFloat32Shift(a, b) {
    return sameFloat32(a[0], b[0]) && sameFloat32(a[1], b[1]) &&
      sameFloat32(a[2], b[2]);
  }

  // Return the exact integer coefficient of a float32 value in units of the
  // least positive float32, 2^-149.  BigInt keeps the proof independent of
  // JavaScript's own rounding while covering normal and subnormal values.
  function float32Units(value) {
    if (!Number.isFinite(value) || Math.fround(value) !== value) return null;
    const bits = float32Bits(value);
    const exponent = (bits >>> 23) & 0xff;
    const fraction = bits & 0x7fffff;
    if (exponent === 0xff) return null;
    let units = exponent === 0 ? BigInt(fraction) :
      BigInt(0x800000 + fraction) << BigInt(exponent - 1);
    if (bits >>> 31) units = -units;
    return units;
  }

  function bigintAbs(value) { return value < 0n ? -value : value; }

  function bigintTrailingZeros(value) {
    value = bigintAbs(value);
    if (value === 0n) return INF;
    let result = 0;
    while ((value & 0xffffffffn) === 0n) {
      value >>= 32n;
      result += 32;
    }
    while ((value & 1n) === 0n) {
      value >>= 1n;
      ++result;
    }
    return result;
  }

  // This is a deliberately sufficient (not necessary) all-q proof.  If the
  // progression is aligned to a binary quantum and never exceeds 24 bits in
  // that quantum, every intermediate value is exactly representable as a
  // float32.  Endpoints bound the absolute value of a linear progression.
  function float32ProgressionIsExact(start, delta, lastIndex) {
    if (lastIndex <= 0 || delta === 0n) return true;
    const startZeros = bigintTrailingZeros(start);
    const deltaZeros = bigintTrailingZeros(delta);
    const quantumShift = startZeros === INF ? deltaZeros :
      Math.min(startZeros, deltaZeros);
    const exactLimit = 1n << BigInt(24 + quantumShift);
    const end = start + BigInt(lastIndex) * delta;
    return bigintAbs(start) <= exactLimit && bigintAbs(end) <= exactLimit;
  }

  function wordMatchesRecordedFloat32(history, startIndex, currentState, context) {
    let shift = history[startIndex].state.shift.slice();
    for (let i = startIndex; i < history.length; ++i) {
      if (!sameFloat32Shift(shift, history[i].state.shift)) return false;
      const portal = context.surfaces[history[i].selected];
      if (!portal || portal.kind !== "portal") return false;
      shift = add3Float32(shift, portal.translation);
    }
    return sameFloat32Shift(shift, currentState.shift);
  }

  // A word certificate is affine in its repetition index only if the rounded
  // float32 state follows the same affine translation.  First recognize exact
  // state cycles (which can include cancelling rounding), then use an exact
  // dyadic-grid proof for long nonzero runs.  Finally, directly verify the
  // first 256 repetitions; returning that conservative cap is still enough
  // for the existing power-of-two jump without ever extrapolating a false
  // binary64 recurrence.
  function float32AffineWordRepeatLimit(history, startIndex, currentState,
                                        context, maximum = FLOAT32_WORD_JUMP_CAP) {
    if (!(maximum > 1) || startIndex < 0 || startIndex >= history.length ||
        !wordMatchesRecordedFloat32(history, startIndex, currentState, context)) return 1;
    const startShift = history[startIndex].state.shift;
    if (sameFloat32Shift(startShift, currentState.shift)) return INF;

    const wordDelta = sub3(currentState.shift, startShift);
    const prefixUnits = [[], [], []];
    let exactFirstWord = true;
    for (let axis = 0; axis < 3; ++axis) {
      const units = float32Units(startShift[axis]);
      if (units == null) return 1;
      prefixUnits[axis].push(units);
    }
    for (let i = startIndex; i < history.length; ++i) {
      const portal = context.surfaces[history[i].selected];
      const recorded = i + 1 < history.length ? history[i + 1].state.shift :
        currentState.shift;
      for (let axis = 0; axis < 3; ++axis) {
        const translationUnits = float32Units(portal.translation[axis]);
        const recordedUnits = float32Units(recorded[axis]);
        if (translationUnits == null || recordedUnits == null) return 1;
        const exact = prefixUnits[axis][prefixUnits[axis].length - 1] + translationUnits;
        prefixUnits[axis].push(exact);
        if (exact !== recordedUnits) exactFirstWord = false;
      }
    }

    const proofMaximum = Math.min(FLOAT32_WORD_JUMP_CAP, Math.floor(maximum));
    if (exactFirstWord) {
      let gridExact = true;
      for (let axis = 0; axis < 3 && gridExact; ++axis) {
        const values = prefixUnits[axis];
        const delta = values[values.length - 1] - values[0];
        for (let prefix = 0; prefix < values.length; ++prefix) {
          if (!float32ProgressionIsExact(values[prefix], delta, proofMaximum - 1)) {
            gridExact = false;
            break;
          }
        }
      }
      if (gridExact) return proofMaximum;
    }

    let shift = startShift.slice();
    const directMaximum = Math.min(proofMaximum, FLOAT32_WORD_DIRECT_PROOF);
    for (let repetition = 0; repetition < directMaximum; ++repetition) {
      for (let i = startIndex; i < history.length; ++i) {
        const base = history[i].state.shift;
        const expected = [
          base[0] + repetition * wordDelta[0],
          base[1] + repetition * wordDelta[1],
          base[2] + repetition * wordDelta[2]
        ];
        if (!sameFloat32Shift(shift, expected)) return Math.max(1, repetition);
        shift = add3Float32(shift, context.surfaces[history[i].selected].translation);
      }
      const completed = repetition + 1;
      const expectedEnd = [
        startShift[0] + completed * wordDelta[0],
        startShift[1] + completed * wordDelta[1],
        startShift[2] + completed * wordDelta[2]
      ];
      if (!sameFloat32Shift(shift, expectedEnd)) return Math.max(1, repetition);
    }
    return directMaximum;
  }

  function affineFloat32Shift(start, delta, repetitions) {
    return [
      Math.fround(start[0] + delta[0] * repetitions),
      Math.fround(start[1] + delta[1] * repetitions),
      Math.fround(start[2] + delta[2] * repetitions)
    ];
  }

  function descriptorRepeatLimit(poly, certificate, offset, phaseShift, wordDelta, context) {
    const kind = certificate[offset], first = certificate[offset + 1];
    const second = certificate[offset + 2], signA = certificate[offset + 3];
    const signB = certificate[offset + 4], orientation = certificate[offset + 5];
    const l0 = writePackedLine(kind, first, second, signA, signB, orientation,
      context, phaseShift, line());
    const l1 = writePackedLine(kind, first, second, signA, signB, orientation,
      context, add3(phaseShift, wordDelta), line());
    const dl = lineAdd(l1, l0, 1, -1);
    const pixelX = context.pixelX, pixelY = context.pixelY;
    const guardSlope = context.pureEuclidean ? 0 :
      0.625 * (Math.abs(dl.a) * pixelX + Math.abs(dl.b) * pixelY) +
      64 * GPU_EPS * (Math.abs(dl.a) + Math.abs(dl.b) + Math.abs(dl.c));
    let repeatLimit = INF;
    for (const vertex of poly) {
      let initial = lineEval(l0, vertex) - (context.pureEuclidean ? 0 :
        lineGuardPixels(l0, pixelX, pixelY));
      // Event BSP children share their guarded boundary with a completion
      // polygon which is constructed afterwards. Treat a float64-sized zero as
      // certified here for the same reason certifyEvent does: no sample on
      // that shared boundary can be owned only by the accelerated child.
      // Without this convention every clipped certificate has a zero-margin
      // vertex and no word can ever repeat, even when its whole interior is
      // periodic.
      const initialTolerance = 1e-12 * lineNorm(l0);
      if (initial < -initialTolerance) return 0;
      initial = Math.max(0, initial);
      const slope = lineEval(dl, vertex) - guardSlope;
      if (slope < 0) repeatLimit = Math.min(repeatLimit, Math.max(0, Math.ceil(initial / -slope)));
    }
    return repeatLimit;
  }

  // Return the guarded form for one descriptor at repetition q.  Every
  // descriptor is affine in q, and so is this conservative guard envelope.
  // Consequently q=0 and q=R-1 certify all R repetitions; no prefix loop is
  // required.
  function descriptorRepeatEndpointLine(certificate, offset, phaseShift,
                                        wordDelta, repetition, context) {
    const kind = certificate[offset], first = certificate[offset + 1];
    const second = certificate[offset + 2], signA = certificate[offset + 3];
    const signB = certificate[offset + 4], orientation = certificate[offset + 5];
    const l0 = writePackedLine(kind, first, second, signA, signB, orientation,
      context, phaseShift, line());
    const l1 = writePackedLine(kind, first, second, signA, signB, orientation,
      context, add3(phaseShift, wordDelta), line());
    const dl = lineAdd(l1, l0, 1, -1);
    const pixelX = context.pixelX, pixelY = context.pixelY;
    const guardSlope = context.pureEuclidean ? 0 :
      0.625 * (Math.abs(dl.a) * pixelX + Math.abs(dl.b) * pixelY) +
      64 * GPU_EPS * (Math.abs(dl.a) + Math.abs(dl.b) + Math.abs(dl.c));
    const proofGuard = context.pureEuclidean ? 0 :
      lineGuardPixels(l0, pixelX, pixelY) + repetition * guardSlope;
    return line(l0.a + repetition * dl.a,
      l0.b + repetition * dl.b,
      l0.c + repetition * dl.c - proofGuard);
  }

  // Find the tightest descriptor which prevents a whole polygon from
  // repeating once.  Splitting only this q=1 inequality avoids recursively
  // tracing the already-periodic part of the screen while leaving every
  // unproved sample on the authoritative scalar path.
  function tightestWordRepeatSplit(poly, history, startIndex, currentState,
                                   repetitions, context) {
    const startState = history[startIndex].state;
    const wordDelta = sub3(currentState.shift, startState.shift);
    let selected = null, selectedScore = INF;
    for (let i = startIndex; i < history.length; ++i) {
      const step = history[i];
      for (let offset = 0; offset < step.certificate.length; offset += 6) {
        const endpoint = descriptorRepeatEndpointLine(step.certificate, offset,
          step.state.shift, wordDelta, repetitions - 1, context);
        let minimum = INF;
        for (const vertex of poly) minimum = Math.min(minimum, lineEval(endpoint, vertex));
        const tolerance = 1e-12 * lineNorm(endpoint);
        if (minimum >= -tolerance) continue;
        const score = minimum / lineNorm(endpoint);
        if (!selected || score < selectedScore) {
          selected = endpoint;
          selectedScore = score;
        }
      }
    }
    return selected;
  }

  function certifiedWordRepeatLimit(poly, history, startIndex, currentState, context) {
    const startState = history[startIndex].state;
    const wordDelta = sub3(currentState.shift, startState.shift);
    let repeatLimit = INF;
    for (let i = startIndex; i < history.length; ++i) {
      const step = history[i];
      for (let offset = 0; offset < step.certificate.length; offset += 6) {
        repeatLimit = Math.min(repeatLimit,
          descriptorRepeatLimit(poly, step.certificate, offset,
            step.state.shift, wordDelta, context));
        if (repeatLimit <= 1) return { repeats: repeatLimit, wordDelta };
      }
    }
    // A geometric word proof alone is insufficient: binary64 multiplication
    // of its net delta does not reproduce a sequence of float32 portal adds in
    // general.  Cap it at the repetitions for which that state recurrence is
    // independently proven affine.
    const numericLimit = float32AffineWordRepeatLimit(history, startIndex,
      currentState, context);
    return { repeats: Math.min(repeatLimit, numericLimit), wordDelta };
  }

  // Production output is already non-indexed, so size the four GPU streams
  // exactly once.  The prototype used Array.push for every scalar and then
  // copied all four arrays into Float32Array objects; on moving-camera builds
  // that allocation/copy phase was a measurable fraction of total CPU time.
  function triangulateRecords(records) {
    let vertexCount = 0;
    for (const record of records) vertexCount += Math.max(0, record.polygon.length - 2) * 3;
    const positions = new Float32Array(vertexCount * 3);
    const translations = new Float32Array(vertexCount * 3);
    const metadata = new Float32Array(vertexCount * 4);
    const crossingCounts = new Float32Array(vertexCount);
    let vertex = 0;
    for (const record of records) {
      const poly = record.polygon;
      // Residual kind 3 tells the state-construction shader that this path has
      // a history-owned zero-travel contact ancestor.  It must restart from
      // that boundary portal rather than from the ordinary root state.
      const kind = record.kind === "terminal" ? (record.directTerminal ? 4 : 1) : record.kind === "void" ? 2 :
        record.state.replayBoundaryPortal >= 0 ? 3 : 0;
      const face = record.face == null ? -1 : record.face;
      const shift = record.state.shift;
      const currentSurface = record.state.currentSurface;
      const skipGroup = record.state.skipGroup;
      const crossings = record.state.crossings || 0;
      let replayCode = 0, replayDescriptor = 0;
      if (record.kind === "terminal") {
        const replayWord = record.state.replayWord;
        if ((!Array.isArray(replayWord) && !record.directTerminal) ||
            (Array.isArray(replayWord) && replayWord.length > TERMINAL_REPLAY_MAX))
          throw new Error("Terminal record is missing its bounded exact replay prefix");
        for (let step = 0; step < (replayWord ? replayWord.length : 0); ++step)
          replayCode += (replayWord[step] & 3) * (2 ** (step * 2));
        replayDescriptor = (replayWord ? replayWord.length : 0) +
          (Math.max(-1, record.state.replayBoundaryPortal) + 1) * 8;
      }
      for (let i = 1; i + 1 < poly.length; ++i) {
        for (let corner = 0; corner < 3; ++corner, ++vertex) {
          const point = corner === 0 ? poly[0] : corner === 1 ? poly[i] : poly[i + 1];
          const p = vertex * 3, m = vertex * 4;
          positions[p] = point.x; positions[p + 1] = point.y;
          translations[p] = shift[0]; translations[p + 1] = shift[1];
          translations[p + 2] = shift[2];
          metadata[m] = kind; metadata[m + 1] = face;
          if (record.kind === "terminal") {
            metadata[m + 2] = replayCode; metadata[m + 3] = replayDescriptor;
          } else {
            metadata[m + 2] = record.state.replayBoundaryPortal >= 0 ?
              record.state.replayBoundaryPortal : currentSurface;
            metadata[m + 3] = skipGroup;
          }
          crossingCounts[vertex] = crossings;
        }
      }
    }
    return { positions, translations, metadata, crossingCounts };
  }

  function jobPriority(job) {
    // Cover the largest unresolved screen regions first.  A mild depth
    // penalty prevents one large aperiodic path from consuming the entire
    // construction budget while sibling regions that terminate after one or
    // two events remain untouched.
    return Math.abs(polygonArea(job.polygon)) / (1 + 0.2 * (job.eventBudget || 0));
  }

  function heapPush(heap, job) {
    job._priority = jobPriority(job);
    let index = heap.length;
    heap.push(job);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent]._priority >= job._priority) break;
      heap[index] = heap[parent]; index = parent;
    }
    heap[index] = job;
  }

  function heapPop(heap) {
    if (!heap.length) return null;
    const result = heap[0], tail = heap.pop();
    if (!heap.length) return result;
    let index = 0;
    while (true) {
      const left = index * 2 + 1, right = left + 1;
      if (left >= heap.length) break;
      let child = left;
      if (right < heap.length && heap[right]._priority > heap[left]._priority) child = right;
      if (heap[child]._priority <= tail._priority) break;
      heap[index] = heap[child]; index = child;
    }
    heap[index] = tail;
    return result;
  }

  function prepartitionDenominatorSigns(initialPolygon, context, output, initialState) {
    const unique = [];
    for (const l of context.denLines) {
      const scale = Math.max(Math.abs(l.a), Math.abs(l.b), Math.abs(l.c), 1e-30);
      const canonical = line(l.a / scale, l.b / scale, l.c / scale);
      let duplicate = false;
      for (const q of unique) {
        const same = Math.hypot(canonical.a - q.a, canonical.b - q.b, canonical.c - q.c) < 1e-10;
        const opposite = Math.hypot(canonical.a + q.a, canonical.b + q.b, canonical.c + q.c) < 1e-10;
        if (same || opposite) { duplicate = true; break; }
      }
      if (!duplicate) unique.push(canonical);
    }
    let cells = [{ polygon: initialPolygon.map(copyPoint), denSigns: [] }];
    for (const l of unique) {
      const next = [];
      for (const cell of cells) {
        const split = splitForContext(cell.polygon, l, context);
        if (polygonMayCoverSample(split.band, context.viewport)) {
          output.residual.push({ kind: "residual", polygon: split.band,
            state: Object.assign(cloneState(initialState), { denSigns: null }),
            reason: "parallel-band" });
        }
        if (polygonMayCoverSample(split.positive, context.viewport)) next.push({ polygon: split.positive });
        if (polygonMayCoverSample(split.negative, context.viewport)) next.push({ polygon: split.negative });
      }
      cells = next;
    }
    for (const cell of cells) {
      const center = polygonCentroid(cell.polygon);
      cell.denSigns = context.denLines.map(l => lineEval(l, center) >= 0 ? 1 : -1);
    }
    return cells;
  }

  // At an exact camera/portal contact the physical camera is deliberately not
  // nudged.  The old exact renderer took the history-owned one-sided limit:
  // for stored side s, only rays with s*dot(N,D) <= 0 cross at zero travel.
  // Partition those rays before the ordinary event DAG and start them in the
  // already-crossed Euclidean copy.  Multiple simultaneous contact planes are
  // resolved in the same deterministic portal-rank order as ordinary ties.
  function boundaryInitialCells(initialPolygon, context, boundarySeeds) {
    const rootState = { shift: [0, 0, 0], currentSurface: -1,
      skipGroup: -1, denSigns: null, crossings: 0, boundarySeed: false,
      replayBoundaryPortal: -1, replayWord: [] };
    let unowned = [initialPolygon.map(copyPoint)];
    const seeded = [];
    const seen = new Set();
    const ordered = (Array.isArray(boundarySeeds) ? boundarySeeds : [])
      .map(seed => {
        const index = Math.trunc(seed && seed.portalIndex);
        const surface = context.surfaces[index];
        const side = Number(seed && seed.side) < 0 ? -1 : 1;
        return surface && surface.kind === "portal" ? { index, surface, side } : null;
      })
      .filter(seed => seed && !seen.has(seed.index) && seen.add(seed.index))
      .sort((a, b) => a.surface.priority - b.surface.priority || a.index - b.index);

    for (const seed of ordered) {
      // contact >= 0 is -side*dot(N,D) >= 0.  The complementary polygon keeps
      // the root state.  Their shared mathematical edge has zero area and the
      // rasterizer's common-edge rule assigns each physical sample once.
      const contactLine = lineScale(context.denLines[seed.index], -seed.side);
      const remaining = [];
      for (const polygon of unowned) {
        const contact = clipPolygon(polygon, contactLine, 0);
        const root = clipPolygon(polygon, lineScale(contactLine, -1), 0);
        if (polygonMayCoverSample(contact, context.viewport)) seeded.push({
          polygon: contact,
          state: {
            shift: add3Float32([0, 0, 0], seed.surface.translation),
            // Zero travel is authoritative here.  Leaving currentSurface at
            // root makes every following event compare against time zero.
            currentSurface: -1,
            skipGroup: seed.surface.targetGroup,
            denSigns: null,
            crossings: 1,
            boundarySeed: true,
            replayBoundaryPortal: seed.index,
            replayWord: []
          }
        });
        if (polygonMayCoverSample(root, context.viewport)) remaining.push(root);
      }
      unowned = remaining;
      if (!unowned.length) break;
    }
    for (const polygon of unowned) seeded.push({ polygon, state: cloneState(rootState) });
    return seeded;
  }

  function build(options) {
    if (!options || !Array.isArray(options.portals) || options.portals.length === 0) {
      throw new Error("PortalScreenDag.build requires portal data");
    }
    const viewport = options.viewport || [1920, 1080];
    const roomHalf = options.roomHalf || [4, 4, 4];
    const surfaces = makeSurfaces(options.portals, roomHalf);
    const context = {
      origin: options.origin.slice(0, 3), ray: options.ray,
      viewport, pixelX: 2 / Math.max(1, viewport[0]), pixelY: 2 / Math.max(1, viewport[1]),
      surfaces, denLines: surfaces.map(s => rayLinearDot(s.n, options.ray)),
      portalCount: options.portals.length,
      interiorInvariant: options.interiorInvariant === true,
      pureEuclidean: options.pureEuclidean === true,
      allowDirectTerminal: options.allowDirectTerminal === true,
      _surfaceValues: new Float64Array(surfaces.length)
    };
    prepareSurfaceLines(context);
    const initialPolygon = options.initialPolygon || [
      { x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }
    ];
    const limits = Object.assign({ maxCells: 20000, maxEventsPerCell: 192, maxWord: 48 }, options.limits || {});
    const output = { terminal: [], residual: [], void: [], stats: {
      cells: 0, splits: 0, events: 0, wordJumps: 0, jumpedEvents: 0,
      repeatSplits: 0, repeatAttempts: 0, repeatPointMaximum: 0,
      terminalPolygons: 0, residualPolygons: 0, voidPolygons: 0,
      boundarySeedPolygons: 0
    } };
    const queue = [];
    const initialCells = boundaryInitialCells(initialPolygon, context, options.boundarySeeds);
    output.stats.boundarySeedPolygons = initialCells.reduce((count, cell) =>
      count + (cell.state.boundarySeed ? 1 : 0), 0);
    for (const initial of initialCells) {
      const stableCells = prepartitionDenominatorSigns(initial.polygon, context, output,
        initial.state);
      for (const cell of stableCells) heapPush(queue, {
        polygon: cell.polygon,
        state: Object.assign(cloneState(initial.state), { denSigns: cell.denSigns }),
        history: [], eventBudget: 0
      });
    }

    while (queue.length) {
      const job = heapPop(queue);
      if (!polygonMayCoverSample(job.polygon, viewport)) continue;
      if (++output.stats.cells > limits.maxCells) {
        output.residual.push({ kind: "residual", polygon: job.polygon, state: job.state,
          reason: "cell-budget" });
        // Once the global budget is exhausted, heap priority is irrelevant.
        // Spill the remaining disjoint cells in O(n) instead of paying an
        // O(log n) heap repair for every polygon that is already guaranteed to
        // enter the GPU state constructor.
        while (queue.length) {
          const remaining = queue.pop();
          if (polygonMayCoverSample(remaining.polygon, viewport)) output.residual.push({
            kind: "residual", polygon: remaining.polygon, state: remaining.state,
            reason: "cell-budget"
          });
        }
        break;
      }
      if (job.eventBudget >= limits.maxEventsPerCell) {
        output.residual.push({ kind: "residual", polygon: job.polygon, state: job.state,
          reason: "event-budget" });
        continue;
      }

      const representative = polygonCentroid(job.polygon);
      const hit = classifyEvent(representative, job.state, context);
      if (!hit) {
        output.residual.push({ kind: "residual", polygon: job.polygon, state: job.state,
          reason: "unclassified" });
        continue;
      }
      const proof = certifyEvent(job.polygon, job.state, hit.surface, context);
      if (proof.fallback) {
        output.residual.push({ kind: "residual", polygon: job.polygon, state: job.state,
          reason: "ownership-tie" });
        continue;
      }
      if (proof.split) {
        ++output.stats.splits;
        const pieces = splitForContext(job.polygon, proof.line, context);
        if (polygonMayCoverSample(pieces.band, viewport)) output.residual.push({
          kind: "residual", polygon: pieces.band, state: job.state, reason: "predicate-band"
        });
        if (polygonMayCoverSample(pieces.positive, viewport)) heapPush(queue, {
          polygon: pieces.positive, state: cloneState(job.state), history: job.history.slice(),
          eventBudget: job.eventBudget
        });
        if (polygonMayCoverSample(pieces.negative, viewport)) heapPush(queue, {
          polygon: pieces.negative, state: cloneState(job.state), history: job.history.slice(),
          eventBudget: job.eventBudget
        });
        continue;
      }

      ++output.stats.events;
      if (hit.surface.kind === "wall") {
        const record = { kind: "terminal", polygon: job.polygon,
          state: cloneState(job.state), face: hit.surface.face };
        // An affine word jump deliberately compresses many exact events and no
        // longer has a bounded sequential prefix.  Keep those rare cells in
        // the hidden exact state-construction pass; never approximate their
        // visible terminal depth.
        if (Array.isArray(job.state.replayWord)) output.terminal.push(record);
        else if (context.allowDirectTerminal) {
          record.directTerminal = true;
          output.terminal.push(record);
        }
        else output.residual.push(Object.assign(record, {
          kind: "residual", reason: "terminal-replay-unavailable"
        }));
        continue;
      }

      const history = job.history.concat([{
        state: cloneState(job.state), selected: hit.surface.index,
        certificate: proof.certificate
      }]);
      let nextState = advancePortal(job.state, hit.surface);
      let jumped = false;
      const currentKey = phaseKey(nextState);
      const first = Math.max(0, history.length - limits.maxWord);
      for (let start = history.length - 1; start >= first; --start) {
        if (phaseKey(history[start].state) !== currentKey) continue;
        ++output.stats.repeatAttempts;
        const pointRepeat = certifiedWordRepeatLimit([polygonCentroid(job.polygon)],
          history, start, nextState, context);
        if (pointRepeat.repeats !== INF) output.stats.repeatPointMaximum = Math.max(
          output.stats.repeatPointMaximum, pointRepeat.repeats);
        // A q=1 geometric failure can still be split to discover a periodic
        // subset elsewhere in the polygon.  Only decline the attempt when the
        // float32 state itself cannot support a second affine repetition;
        // that limit is path-state dependent and no screen split can fix it.
        if (pointRepeat.repeats <= 1 &&
            float32AffineWordRepeatLimit(history, start, nextState, context) <= 1) continue;
        // Use a power-of-two endpoint no farther than the representative
        // point's exact repeat limit.  This makes one split buy an exponential
        // jump while leaving a reasonably broad certified child.  If the
        // representative itself stops immediately, q=1 still discovers any
        // periodic subset on the other side of the cell.
        const pointLimit = pointRepeat.repeats === INF ? 256 :
          Math.max(2, Math.min(256, pointRepeat.repeats));
        const targetRepeats = 2 ** Math.floor(Math.log2(pointLimit));
        let repeatPolygon = job.polygon;
        let repeat = certifiedWordRepeatLimit(repeatPolygon, history, start, nextState, context);
        // A whole cell commonly straddles the boundary at which a periodic
        // word stops being valid.  Peel off the exact q=R-1 endpoint side of
        // the tightest failing descriptor, send the opposite side on from the
        // already-reached state, and give the deliberately wide middle strip
        // to the authoritative shader.  Affinity in repetition index proves
        // every prefix between q=0 and q=R-1.
        while (repeat.repeats < targetRepeats && repeatPolygon) {
          const repeatLine = tightestWordRepeatSplit(repeatPolygon,
            history, start, nextState, targetRepeats, context);
          if (!repeatLine) break;
          ++output.stats.splits;
          ++output.stats.repeatSplits;
          const pieces = splitForContext(repeatPolygon, repeatLine, context);
          if (polygonMayCoverSample(pieces.band, viewport)) output.residual.push({
            kind: "residual", polygon: pieces.band, state: cloneState(nextState),
            reason: "repeat-predicate-band"
          });
          if (polygonMayCoverSample(pieces.negative, viewport)) heapPush(queue, {
            // The word was followed exactly once on this side; only the
            // attempted recurrence failed.  Preserve its scalar history so a
            // different (often shorter) repeated phase can be recognized on
            // the very next event.
            polygon: pieces.negative, state: cloneState(nextState), history: history.slice(),
            eventBudget: job.eventBudget + 1
          });
          if (!polygonMayCoverSample(pieces.positive, viewport)) {
            repeatPolygon = null;
            break;
          }
          repeatPolygon = pieces.positive;
          repeat = certifiedWordRepeatLimit(repeatPolygon,
            history, start, nextState, context);
        }
        if (!repeatPolygon) {
          jumped = true;
          break;
        }
        if (repeat.repeats === INF) {
          output.void.push({ kind: "void", polygon: repeatPolygon, state: cloneState(nextState),
            reason: "certified-infinite-word" });
          jumped = true;
          nextState = null;
          break;
        }
        if (repeat.repeats > 1) {
          // One repetition has already been followed explicitly.  Move from
          // the word's start state to the certified final repetition in one
          // CPU operation; the fragment shader sees no event loop at all.
          const wordLength = history.length - start;
          const repeats = Math.min(repeat.repeats, 1 << 20);
          const jumpState = cloneState(nextState);
          jumpState.shift = affineFloat32Shift(history[start].state.shift,
            repeat.wordDelta, repeats);
          jumpState.crossings = history[start].state.crossings + wordLength * repeats;
          jumpState.replayWord = null;
          ++output.stats.wordJumps;
          output.stats.jumpedEvents += wordLength * (repeats - 1);
          heapPush(queue, { polygon: repeatPolygon, state: jumpState, history: [],
            eventBudget: job.eventBudget + 1 });
          jumped = true;
          break;
        }
        if (repeatPolygon !== job.polygon) {
          heapPush(queue, { polygon: repeatPolygon, state: cloneState(nextState), history: history.slice(),
            eventBudget: job.eventBudget + 1 });
          jumped = true;
          break;
        }
      }
      if (!jumped && nextState) heapPush(queue, { polygon: job.polygon, state: nextState,
        history, eventBudget: job.eventBudget + 1 });
    }

    output.stats.terminalPolygons = output.terminal.length;
    output.stats.residualPolygons = output.residual.length;
    output.stats.voidPolygons = output.void.length;
    output.geometry = triangulateRecords(output.terminal);
    output.stateBuildGeometry = triangulateRecords(output.residual);
    output.voidGeometry = triangulateRecords(output.void);
    return output;
  }

  return {
    build,
    clipPolygon,
    polygonArea,
    polygonCentroid,
    polygonMayCoverSample,
    splitWithGuard,
    _internals: {
      makeSurfaces, descriptorLine, classifyEvent, certifyEvent,
      certifiedWordRepeatLimit, rayLinearDot, add3Float32, advancePortal,
      float32AffineWordRepeatLimit, affineFloat32Shift, float32Units
    }
  };
});
