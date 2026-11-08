import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'Portals+Compressed Space.html'), 'utf8');
const standalonePath = path.join(root, 'dist', 'Portal Workshop.html');
const standalone = await readFile(standalonePath, 'utf8');
const manifest = JSON.parse(await readFile(path.join(root, 'dist', 'PORTAL_WORKSHOP_BUILD.json'), 'utf8'));
const sha256 = data => createHash('sha256').update(data).digest('hex');

assert(source.includes('<script src="engine/portal-workshop-engine.umd.js"></script>'));
assert(source.includes('<script src="tools/portal-screen-dag.js"></script>'));
assert(source.includes('enabled:false,locked:false},1)'), 'default compressed space must be disabled');
assert(source.includes('scheduler:"breadth-fair-v1"'));
assert(source.includes('pending=queue.length-cursor'));
assert(source.includes('conservativeTerminal:true'));
assert(source.includes('workshopReleaseMetricRenderer'));
assert(source.includes('exact-within-certified-finite-envelope'));
assert(!source.includes('native-pixel-exact'));
assert(!source.includes('unboundedExact:true'));

assert(!/<script\b[^>]*\bsrc\s*=/i.test(standalone), 'standalone must not depend on external scripts');
assert(standalone.includes('data-portal-component="engine-core"'));
assert(standalone.includes('data-portal-component="screen-dag"'));
assert(standalone.includes('PortalWorkshopEngine'));
assert(standalone.includes('PortalScreenDag'));
assert.equal(Buffer.byteLength(standalone), manifest.output.bytes);
assert.equal(sha256(standalone), manifest.output.sha256);
assert.equal(manifest.claims.infiniteExactnessClaimed, false);
assert.equal(manifest.claims.compressedSpaces, 'opt-in-bounded-extension');

const checkFile = path.join(root, 'dist', '.standalone-syntax-check.js');
const scripts = [...standalone.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].filter(match => !/\bsrc\s*=/.test(match[1])).map(match => match[2]);
await import('node:fs/promises').then(fs => fs.writeFile(checkFile, scripts.join('\n;\n')));
const syntax = spawnSync(process.execPath, ['--check', checkFile], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
await import('node:fs/promises').then(fs => fs.unlink(checkFile));

for (const forbidden of ['sk-' + 'proj-', 'AIza' + 'Sy', 'BEGIN ' + 'PRIVATE KEY', 'aws_' + 'secret_access_key']) assert(!standalone.includes(forbidden));
for (const name of await readdir(root)) assert.notEqual(name, 'node_modules');
for (const required of ['engine/API.md', 'engine/SUPPORTED_ENVELOPE.md', 'fixtures/scenes-v1.json', 'fixtures/oracles-v1.json']) {
  assert((await stat(path.join(root, required))).size > 0, `${required} missing or empty`);
}

const before = sha256(await readFile(standalonePath));
const build = spawnSync(process.execPath, ['scripts/build-release.mjs'], { cwd: root, encoding: 'utf8' });
assert.equal(build.status, 0, build.stderr || build.stdout);
const after = sha256(await readFile(standalonePath));
assert.equal(after, before, 'release build must be deterministic');

console.log('PASS test-release-contract', { standaloneBytes: Buffer.byteLength(standalone), sha256: before });
