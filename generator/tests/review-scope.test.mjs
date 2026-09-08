import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyImportantFindings,
  followupIssueBody,
  importantFindings,
  normalizePath,
} from '../../scripts/ci/review-scope.mjs';

test('legge il verdetto: Important: 0 non è un finding', () => {
  const body = [
    '## Findings (Important: 0, Nit: 0)',
    'Important: 0',
    '`scripts/ci/review-gate.mjs:10`: 🔴 Important: manca il controllo.',
  ].join('\n');
  assert.equal(importantFindings(body).length, 1);
});

test('normalizza alias diff e risolve un path citato in forma abbreviata', () => {
  assert.equal(normalizePath('a/scripts/lib/detect-language.mjs:L12'), 'scripts/lib/detect-language.mjs');
  const result = classifyImportantFindings(
    '`lib/detect-language.mjs:12`: 🔴 Important: correggere `detectLanguage()`.',
    ['engine/other.mjs'],
    ['scripts/lib/detect-language.mjs', 'engine/other.mjs'],
  );
  assert.equal(result.outsideOnly, true);
  assert.equal(result.outside[0].resolvedFiles[0], 'scripts/lib/detect-language.mjs');
});

test('associa al finding anche il file citato dopo il verdetto', () => {
  const result = classifyImportantFindings(
    '## Findings (Important: 1)\n🔴 Important: il controllo manca; vedi `scripts/lib/detect-language.mjs:12` e `detectLanguage()`.',
    ['engine/other.mjs'],
    ['scripts/lib/detect-language.mjs', 'engine/other.mjs'],
  );
  assert.equal(result.outsideOnly, true);
  assert.equal(result.outside[0].resolvedFiles[0], 'scripts/lib/detect-language.mjs');
});

test('basename ambiguo resta non risolvibile e quindi bloccante', () => {
  const result = classifyImportantFindings(
    '`detect-language.mjs`: 🔴 Important: correggere `detectLanguage()`.',
    ['engine/other.mjs'],
    ['scripts/lib/detect-language.mjs', 'generator/lib/detect-language.mjs'],
  );
  assert.equal(result.outsideOnly, false);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].reason, 'basename ambiguo');
  assert.equal(result.blocking, true);
});

test('il follow-up aggrega tutti i finding della PR in una issue tracciabile', () => {
  const body = followupIssueBody({
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    pr: 901,
    findings: [{
      resolvedFiles: ['scripts/lib/detect-language.mjs'],
      citations: [{ line: 12 }],
      line: '`scripts/lib/detect-language.mjs:12`: 🔴 Important: correggere `detectLanguage()`.',
    }],
  });
  assert.match(body, /OUT_OF_SCOPE_REVIEW_FOLLOWUP/);
  assert.match(body, /### 1\./);
  assert.match(body, /- Suggested action:.*`detectLanguage\(\)`/);
  assert.match(body, /- Suggested action:.*$/m);
});
