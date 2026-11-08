import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenDirs = new Set(['node_modules', '.git', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache']);
const binaryExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.wasm', '.woff', '.woff2', '.ttf', '.otf']);
const patterns = [
  ['OpenAI project key', new RegExp('sk-' + 'proj-' + '[A-Za-z0-9_-]{12,}')],
  ['Google API key', new RegExp('AIza' + '[A-Za-z0-9_-]{24,}')],
  ['private key', new RegExp('BEGIN (?:RSA |EC |OPENSSH )?' + 'PRIVATE KEY')],
  ['AWS secret assignment', new RegExp('aws_' + 'secret_access_key\\s*[:=]', 'i')],
];
const allowedEmpty = new Set();
let files = 0, bytes = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      assert(!forbiddenDirs.has(entry.name), `forbidden cache/dependency directory: ${path.relative(root, full)}`);
      await walk(full);
    } else if (entry.isFile()) {
      const info = await stat(full); files++; bytes += info.size;
      const relative = path.relative(root, full);
      assert(info.size > 0 || allowedEmpty.has(relative), `unexpected empty release file: ${relative}`);
      if (!binaryExt.has(path.extname(entry.name).toLowerCase()) && info.size <= 8_000_000) {
        const text = await readFile(full, 'utf8');
        for (const [label, pattern] of patterns) assert(!pattern.test(text), `${label} pattern in ${path.relative(root, full)}`);
      }
    }
  }
}
await walk(root);
console.log('PASS test-release-hygiene', { files, bytes, noCaches: true, noDetectedSecrets: true });
