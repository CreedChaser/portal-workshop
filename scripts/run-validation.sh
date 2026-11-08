#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
LOG="${1:-test-results/full-validation.log}"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1
printf 'Portal Workshop full validation\nUTC start: %s\nNode: %s\nPython: %s\nChromium: %s\n\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(node --version)" "$(python3 --version 2>&1)" "$(chromium --version 2>&1 || true)"
node scripts/build-release.mjs
node scripts/build-scene-corpus.mjs
npm test
npm run test:legacy
python3 tests/browser_matrix.py --verify-goldens --results test-results/browser-matrix-verify.json
node scripts/finalize-golden-manifest.mjs test-results/browser-matrix-verify.json
node tests/test-golden-manifest.mjs
node tests/test-release-hygiene.mjs
printf '\nUTC finish: %s\nVALIDATION PASS\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
