// Follow-up FU-2026-11-07-002: a kill during the second discovery-marker
// write must not replace the previous complete marker with partial JSON.
// create-article.mjs is intentionally tested as source here: importing it
// initializes the full generator and requires dependencies unavailable to the
// node:test gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const file = path.join(root, 'generator', 'scripts', 'create-article.mjs');
const source = fs.readFileSync(file, 'utf8');

function extractFunctionBody(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `atteso di trovare "${signature}" in ${file}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart + 1, index);
    }
  }
  throw new Error(`parentesi graffa di chiusura non trovata per "${signature}"`);
}

test('il marker discovery passa dal writer JSON atomico condiviso', () => {
  const importLine = source.split('\n').find((line) => line.includes("from './lib/atomic-write-json.mjs'"));
  assert.ok(importLine, 'il writer JSON atomico condiviso deve essere importato');
  assert.match(importLine, /writeJsonAtomic\s+as\s+_writeJsonAtomic/u);

  const atomicBody = extractFunctionBody('function writeDiscoveryAttemptMarkerAtomically(markerPath, marker) {');
  assert.match(atomicBody, /_writeJsonAtomic\(markerPath,\s*marker,\s*\{\s*compact:\s*true\s*\}\)/u);
  assert.doesNotMatch(atomicBody, /writeFileSync|appendFileSync/u);
});

test('il marker discovery costruisce un payload completo prima del commit atomico', () => {
  const markerBody = extractFunctionBody('function writeDiscoveryAttemptMarker({ section, poolKind, recoveryEligible, candidateAttempted = false, stage = null }) {');
  assert.match(markerBody, /const markerPath = process\.env\.DISCOVERY_ATTEMPT_MARKER/u);
  assert.match(markerBody, /writeDiscoveryAttemptMarkerAtomically\(markerPath,\s*\{/u);
  assert.match(markerBody, /schemaVersion:\s*1/u);
  assert.match(markerBody, /candidateAttempted:\s*candidateAttempted === true/u);
  assert.doesNotMatch(markerBody, /writeFileSync\(\s*markerPath/u);
});
