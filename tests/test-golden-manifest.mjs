import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'fixtures/oracles/MANIFEST.json'), 'utf8'));
const oracle = JSON.parse(await readFile(path.join(root, 'fixtures/oracles-v1.json'), 'utf8'));
const report = JSON.parse(await readFile(path.join(root, manifest.generatedFrom), 'utf8'));
assert.equal(manifest.exactRgbaMatch, true);
assert.equal(report.pass, true);
assert.equal(report.htmlSha256, manifest.verifiedHtmlSha256);
assert.equal(Object.keys(manifest.scenes).length, 8);
for (const [id, entry] of Object.entries(manifest.scenes)) {
  const bytes = await readFile(path.join(root, entry.file));
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha, entry.pngSha256, `${id} PNG`);
  assert.equal(bytes.length, entry.bytes, `${id} bytes`);
  assert.equal(entry.differentPixels, 0, `${id} different pixels`);
  assert.equal(entry.maxChannelDelta, 0, `${id} max channel delta`);
  assert.equal(oracle.scenes[id].pixel.pngSha256, entry.pngSha256);
  assert.equal(oracle.scenes[id].pixel.rgbaSha256, entry.rgbaSha256);
  assert.equal(oracle.scenes[id].pixel.verifiedHtmlSha256, manifest.verifiedHtmlSha256);
}
console.log('PASS test-golden-manifest', { scenes: 8, htmlSha256: manifest.verifiedHtmlSha256 });
