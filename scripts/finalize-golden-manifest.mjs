#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.resolve(root, process.argv[2] || 'test-results/browser-matrix-verify.json');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
if (!report.pass || report.mode !== 'verify') throw new Error(`Browser report is not a passing verification report: ${reportPath}`);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const entries = {};
for (const [id, result] of Object.entries(report.scenes)) {
  if (result.pixelDiff?.differentPixels !== 0 || result.pixelDiff?.maxChannelDelta !== 0) throw new Error(`${id}: non-zero pixel diff`);
  const rel = result.golden;
  const pngPath = path.join(root, rel);
  const bytes = await readFile(pngPath);
  const digest = sha256(bytes);
  if (digest !== result.pngSha256) throw new Error(`${id}: PNG checksum disagrees with browser report`);
  entries[id] = {
    file: rel,
    bytes: bytes.length,
    pngSha256: digest,
    rgbaSha256: result.rgbaSha256,
    viewport: result.viewport,
    renderer: result.renderer?.renderer,
    canonical: result.renderer?.canonical,
    differentPixels: result.pixelDiff.differentPixels,
    maxChannelDelta: result.pixelDiff.maxChannelDelta,
  };
}
const manifest = {
  schema: 'portal-workshop-golden-manifest/v1',
  sceneCorpusVersion: report.sceneCorpusVersion,
  generatedFrom: path.relative(root, reportPath),
  verifiedHtml: report.html,
  verifiedHtmlSha256: report.htmlSha256,
  referenceBrowser: report.browser,
  referenceWebGL: report.webgl,
  exactRgbaMatch: true,
  scenes: entries,
};
await writeFile(path.join(root, 'fixtures/oracles/MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
const oraclePath = path.join(root, 'fixtures/oracles-v1.json');
const oracle = JSON.parse(await readFile(oraclePath, 'utf8'));
for (const [id, entry] of Object.entries(entries)) {
  if (!oracle.scenes[id]) throw new Error(`Oracle scene missing: ${id}`);
  Object.assign(oracle.scenes[id].pixel, {
    bytes: entry.bytes,
    pngSha256: entry.pngSha256,
    rgbaSha256: entry.rgbaSha256,
    verifiedHtmlSha256: report.htmlSha256,
  });
}
await writeFile(oraclePath, JSON.stringify(oracle, null, 2) + '\n');
console.log(JSON.stringify({ manifest: 'fixtures/oracles/MANIFEST.json', scenes: Object.keys(entries).length, htmlSha256: report.htmlSha256 }, null, 2));
