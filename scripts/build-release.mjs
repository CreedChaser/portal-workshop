#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'Portals+Compressed Space.html');
const enginePath = path.join(root, 'engine', 'portal-workshop-engine.umd.js');
const dagPath = path.join(root, 'tools', 'portal-screen-dag.js');
const outputPath = path.join(root, 'dist', 'Portal Workshop.html');
const manifestPath = path.join(root, 'dist', 'PORTAL_WORKSHOP_BUILD.json');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const normalize = text => text.replace(/\r\n?/g, '\n');
const inlineSafe = text => normalize(text).replace(/<\/script/gi, '<\\/script');

const [sourceRaw, engineRaw, dagRaw] = await Promise.all([
  readFile(sourcePath, 'utf8'),
  readFile(enginePath, 'utf8'),
  readFile(dagPath, 'utf8')
]);
let html = normalize(sourceRaw);
const engineTag = '<script src="engine/portal-workshop-engine.umd.js"></script>';
const dagTag = '<script src="tools/portal-screen-dag.js"></script>';
if ((html.match(new RegExp(engineTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length !== 1) {
  throw new Error('Expected exactly one engine script tag');
}
if ((html.match(new RegExp(dagTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length !== 1) {
  throw new Error('Expected exactly one DAG script tag');
}
html = html.replace(engineTag, `<script data-portal-component="engine-core">\n${inlineSafe(engineRaw)}\n</script>`);
html = html.replace(dagTag, `<script data-portal-component="screen-dag">\n${inlineSafe(dagRaw)}\n</script>`);
if (/<script\b[^>]*\bsrc\s*=/i.test(html)) throw new Error('Standalone output still contains an external script');
if (!html.includes('PortalWorkshopEngine') || !html.includes('PortalScreenDag')) throw new Error('Standalone dependencies were not embedded');
if (!html.includes('euclidean-exact-fair') || !html.includes('breadth-fair-v1')) throw new Error('Release renderer markers missing');
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, html, 'utf8');
const outputBytes = Buffer.from(html, 'utf8');
const manifest = {
  schema: 'portal-workshop-build/v1',
  releaseVersion: '1.0.0',
  deterministic: true,
  entrypoint: 'Portal Workshop.html',
  source: {
    'Portals+Compressed Space.html': { bytes: Buffer.byteLength(normalize(sourceRaw)), sha256: sha256(normalize(sourceRaw)) },
    'engine/portal-workshop-engine.umd.js': { bytes: Buffer.byteLength(normalize(engineRaw)), sha256: sha256(normalize(engineRaw)) },
    'tools/portal-screen-dag.js': { bytes: Buffer.byteLength(normalize(dagRaw)), sha256: sha256(normalize(dagRaw)) }
  },
  output: { bytes: outputBytes.length, sha256: sha256(outputBytes) },
  claims: {
    canonicalRenderer: 'euclidean-unfolded-raster-breadth-fair-v1',
    exactness: 'exact-within-certified-finite-envelope',
    compressedSpaces: 'opt-in-bounded-extension',
    infiniteExactnessClaimed: false
  }
};
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ outputPath, bytes: outputBytes.length, sha256: manifest.output.sha256 }, null, 2));
