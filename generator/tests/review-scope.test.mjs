import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyImportantFindings,
  followupIssueBody,
  importantFindings,
  mergeFollowupItems,
  normalizePath,
} from '../../scripts/ci/review-scope.mjs';
import {
  citedTokens,
  hasFalsifiableAcceptance,
  splitFollowupItems,
} from '../../scripts/ci/followup-resolution-match.mjs';

test('legge il verdetto: Important: 0 non è un finding', () => {
  const body = [
    '## Findings (Important: 0, Nit: 0)',
    'Important: 0',
    '`scripts/ci/review-gate.mjs:10`: 🔴 Important: manca il controllo.',
  ].join('\n');
  assert.equal(importantFindings(body).length, 1);
});

test('non tronca il verdetto nell\'Adversarial check', () => {
  const body = [
    '## Findings (Important: 0, Nit: 0)',
    '## Adversarial check',
    '- `scripts/lib/shared.mjs:12`: 🔴 Important: il contratto condiviso è rotto.',
  ].join('\n');
  const result = classifyImportantFindings(
    body,
    ['engine/other.mjs'],
    ['scripts/lib/shared.mjs', 'engine/other.mjs'],
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.outsideOnly, true);
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

test('un path completo assente dal tree resta non risolvibile e bloccante', () => {
  const result = classifyImportantFindings(
    '`scripts/ci/renamed-away.mjs:12`: 🔴 Important: il file citato non esiste.',
    ['engine/other.mjs'],
    ['engine/other.mjs'],
  );
  assert.equal(result.outsideOnly, false);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].reason, 'file non risolto');
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

test('un path:riga non viene spacciato per acceptance falsificabile', () => {
  const body = followupIssueBody({
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    pr: 902,
    findings: [{
      resolvedFiles: ['scripts/lib/shared.mjs'],
      citations: [{ line: 12 }],
      line: '🔴 Important: il controllo condiviso manca.',
    }],
  });
  const action = body.slice(body.indexOf('- Suggested action:'));
  assert.deepEqual(citedTokens(action), []);
  assert.equal(hasFalsifiableAcceptance(action), false);
});

test('un secondo giro aggrega gli item nel CORPO, non solo nei commenti', () => {
  const firstRound = followupIssueBody({
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    pr: 903,
    findings: [{
      resolvedFiles: ['scripts/lib/detect-language.mjs'],
      citations: [{ line: 12 }],
      line: '🔴 Important: correggere `detectLanguage()`.',
    }],
  });
  const secondRound = followupIssueBody({
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    pr: 903,
    existingBody: firstRound,
    findings: [{
      resolvedFiles: ['scripts/lib/slugify.mjs'],
      citations: [{ line: 40 }],
      line: '🔴 Important: correggere `slugify()`.',
    }],
  });
  // Il drainer legge il corpo item per item: entrambi i giri devono essere lì.
  assert.equal(splitFollowupItems(secondRound).length, 2);
  assert.match(secondRound, /### 1\. Finding fuori dal diff: `scripts\/lib\/detect-language\.mjs`/);
  assert.match(secondRound, /### 2\. Finding fuori dal diff: `scripts\/lib\/slugify\.mjs`/);
  // Idempotenza: lo stesso finding rivisto non si duplica nel corpo.
  const thirdRound = followupIssueBody({
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    pr: 903,
    existingBody: secondRound,
    findings: [{
      resolvedFiles: ['scripts/lib/slugify.mjs'],
      citations: [{ line: 40 }],
      line: '🔴 Important: correggere `slugify()`.',
    }],
  });
  assert.equal(splitFollowupItems(thirdRound).length, 2);
  assert.equal(thirdRound.trim(), secondRound.trim());
});

test('il merge conserva gli item di un corpo scritto da un giro precedente', () => {
  const legacy = [
    '## Item',
    '',
    '### 1. Finding fuori dal diff: `scripts/lib/vecchio.mjs`',
    '- Source: reviewer 🔴 Important fuori dal diff',
    '',
  ].join('\n');
  const merged = mergeFollowupItems(legacy, ['Finding fuori dal diff: `scripts/lib/nuovo.mjs`']);
  assert.equal(merged.length, 2);
  assert.match(merged[0], /vecchio\.mjs/);
  assert.match(merged[1], /nuovo\.mjs/);
});

test('il corpo aggregato resta sotto il tetto API tenendo gli item recenti', () => {
  const findings = Array.from({ length: 400 }, (_, i) => ({
    resolvedFiles: [`scripts/lib/file-${i}.mjs`],
    citations: [{ line: i + 1 }],
    line: `🔴 Important: correggere \`fn${i}()\` ${'x'.repeat(300)}.`,
  }));
  const body = followupIssueBody({ repo: 'o/r', pr: 904, findings });
  assert.ok(body.length <= 60000, `corpo ${body.length} sopra il tetto`);
  assert.match(body, /item più vecchi omessi/);
  // L'ultimo finding — il più recente — non viene mai buttato via.
  assert.match(body, /file-399\.mjs/);
});

// ── Il seam di scrittura ────────────────────────────────────────────
//
// La merge pura sopra non basta: il writer condiviso, su una follow-up già
// aperta, si limita a commentare e lascia il CORPO al primo giro. Questo test
// osserva le chiamate `gh` reali (eseguibile finto in testa a `PATH`, stessa
// tecnica di `scan-failed-runs-dedup.test.mjs`) e pretende l'`issue edit
// --body` con l'aggregato: è quella riscrittura l'unica cosa che il drainer
// legge.
const FAKE_GH = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
if (args[0] === 'api' && args[1].endsWith('/files')) {
  process.stdout.write('engine/other.mjs\\n');
  process.exit(0);
}
if (args[0] === 'api') { process.stdout.write('non-e-una-sha\\n'); process.exit(0); }
if (args[0] === 'issue' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(state.open || []));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(state.body || '');
  process.exit(0);
}
process.exit(0);
`;

test('sul secondo giro il corpo della follow-up viene riscritto, non solo commentato', async () => {
  const { classifyAndMintReview } = await import('../../scripts/ci/review-scope.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-scope-followup-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gh'), FAKE_GH, { mode: 0o755 });
  const stateFile = path.join(tmpDir, 'state.json');
  const logFile = path.join(tmpDir, 'gh.log');
  const previous = { PATH: process.env.PATH, GH_REPO: process.env.GH_REPO };

  // Giro 1 già andato: la issue #7 esiste aperta e il suo corpo porta un item.
  const firstRound = followupIssueBody({
    repo: 'o/r',
    pr: 903,
    findings: [{
      resolvedFiles: ['scripts/lib/detect-language.mjs'],
      citations: [{ line: 12 }],
      line: '🔴 Important: correggere `detectLanguage()`.',
    }],
  });
  fs.writeFileSync(stateFile, JSON.stringify({
    open: [{ number: 7, title: 'follow-up(#903): finding fuori dal diff', url: 'https://x/7', state: 'OPEN', labels: [] }],
    body: firstRound,
  }));
  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH}`;
  process.env.FAKE_GH_STATE = stateFile;
  process.env.FAKE_GH_LOG = logFile;
  delete process.env.GH_REPO;

  try {
    const result = await classifyAndMintReview(
      '`scripts/lib/slugify.mjs:40`: 🔴 Important: correggere `slugify()`.',
      { repo: 'o/r', pr: 903, prUrl: 'https://x/pr/903' },
    );
    assert.equal(result.outsideOnly, true);
    assert.equal(result.minted, true);
    assert.equal(result.followup.bodyChanged, true);
    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const edit = calls.find((args) => args[0] === 'issue' && args[1] === 'edit');
    assert.ok(edit, `nessun \`issue edit\`: ${JSON.stringify(calls)}`);
    assert.equal(edit[2], '7');
    const written = edit[edit.indexOf('--body') + 1];
    assert.equal(splitFollowupItems(written).length, 2);
    assert.match(written, /detect-language\.mjs/);
    assert.match(written, /slugify\.mjs/);
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.GH_REPO === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = previous.GH_REPO;
    delete process.env.FAKE_GH_STATE;
    delete process.env.FAKE_GH_LOG;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
