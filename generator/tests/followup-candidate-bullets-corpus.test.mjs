/**
 * followup-candidate-bullets-corpus.test.mjs — il classificatore dei bullet del
 * triage follow-up, sceso `identical` dal sito, gira QUI con `--side corpus` e
 * col manifest di mirror letto dal disco.
 *
 * Il rischio del corpus è il rovescio di quello del sito: un file `identical`
 * ESISTE in questo checkout, quindi una regola «esiste qui → bucket di questo
 * repository» conierebbe nel corpus lavoro che `bin/where-to-fix` manda nel
 * sito (correggerlo qui crea `corpus-ahead`). La verità è la voce del
 * manifest, non l'esistenza del file.
 *
 * L'import qui sotto è anche la prova che gli import relativi dello script
 * (`../lib/pr-body-sections-check.mjs`, `./followup-has-candidates.mjs`) si
 * risolvono in questo repository: un import rotto fa fallire il file intero.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  MANIFEST_PATH,
  classifyCandidateBullets,
  mirrorRoute,
  readManifestFile,
} from '../../scripts/ci/followup-candidate-bullets.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST_FILES = readManifestFile(`${ROOT}${MANIFEST_PATH}`);

/** Un lookup del gemello che registra le chiamate: per i path decisi dal manifest non deve servire. */
function recordingTwin() {
  const calls = [];
  const fn = (p) => {
    calls.push(p);
    return true;
  };
  fn.calls = calls;
  return fn;
}

const entryOf = (mode, predicate = () => true) =>
  MANIFEST_FILES.find((entry) => entry.mode === mode && predicate(entry));

test('il manifest di mirror si legge dal disco di questo checkout', () => {
  assert.ok(Array.isArray(MANIFEST_FILES), `${MANIFEST_PATH} non leggibile: ogni route sarebbe unknown`);
  assert.ok(MANIFEST_FILES.length > 0);
});

test('lo script legge di default lo stesso manifest che il prefetch gli passa', () => {
  // L'invocazione nel workflow è pinnata in followup-template-acceptance.test.mjs.
  assert.equal(MANIFEST_PATH, 'scripts/ci/loop-sync-manifest.json');
});

test('un file identical che esiste anche qui va nel sito, col suo sitePath', () => {
  // Il caso misurato da c09: `host/batchWrite.ts` esiste nel corpus, ma
  // `bin/where-to-fix` risponde «gemello identico: correggere nel sito» col
  // path `build-plugins/batchWrite.ts`.
  const entry = MANIFEST_FILES.find((e) => e.path === 'host/batchWrite.ts');
  assert.ok(entry, 'premessa: il manifest ha la voce di host/batchWrite.ts');
  assert.equal(entry.mode, 'identical');
  assert.equal(entry.sitePath, 'build-plugins/batchWrite.ts');

  const existsTwin = recordingTwin();
  const route = mirrorRoute({
    path: 'host/batchWrite.ts',
    side: 'corpus',
    manifestFiles: MANIFEST_FILES,
    existsHere: () => true,
    existsTwin,
  });
  assert.deepEqual(
    { repo: route.repo, targetPath: route.targetPath },
    { repo: 'site', targetPath: 'build-plugins/batchWrite.ts' },
    'un identical esistente qui NON è lavoro del corpus: «esiste qui» non decide il repository',
  );
  assert.deepEqual(existsTwin.calls, [], 'il manifest decide: nessuna chiamata al gemello');
});

test('ogni voce identical con sitePath diverso va nel sito col nome lato sito', () => {
  const renamed = MANIFEST_FILES.filter(
    (e) => e.mode === 'identical' && typeof e.sitePath === 'string' && e.sitePath && e.sitePath !== e.path,
  );
  assert.ok(renamed.length > 0, 'premessa: il manifest ha voci identical rinominate');
  for (const entry of renamed) {
    const route = mirrorRoute({
      path: entry.path,
      side: 'corpus',
      manifestFiles: MANIFEST_FILES,
      existsHere: () => true,
      existsTwin: () => false,
    });
    assert.equal(route.repo, 'site', `${entry.path}: atteso il sito, ottenuto ${route.repo} (${route.why})`);
    assert.equal(route.targetPath, entry.sitePath, `${entry.path}: atteso il sitePath`);
  }
});

test('un corpus-only resta qui, un adapted esistente qui resta qui', () => {
  const corpusOnly = entryOf('corpus-only');
  assert.ok(corpusOnly, 'premessa: il manifest ha una voce corpus-only');
  assert.equal(
    mirrorRoute({
      path: corpusOnly.path,
      side: 'corpus',
      manifestFiles: MANIFEST_FILES,
      existsHere: () => true,
      existsTwin: () => true,
    }).repo,
    'corpus',
  );

  const adapted = entryOf('adapted', (e) => !e.sitePath || e.sitePath === e.path);
  assert.ok(adapted, 'premessa: il manifest ha una voce adapted');
  const route = mirrorRoute({
    path: adapted.path,
    side: 'corpus',
    manifestFiles: MANIFEST_FILES,
    existsHere: () => true,
    existsTwin: () => true,
  });
  assert.deepEqual({ repo: route.repo, targetPath: route.targetPath }, { repo: 'corpus', targetPath: adapted.path });
});

test('redflag-doc-sections usa il routing della sua voce adapted reale', () => {
  const entry = MANIFEST_FILES.find((e) => e.path === 'scripts/ci/redflag-doc-sections.mjs');
  assert.ok(entry, 'premessa: redflag-doc-sections è censito');
  assert.equal(entry.mode, 'adapted');
  const route = mirrorRoute({
    path: entry.path,
    side: 'corpus',
    manifestFiles: MANIFEST_FILES,
    existsHere: () => true,
    existsTwin: () => true,
  });
  assert.deepEqual(
    { repo: route.repo, targetPath: route.targetPath, why: route.why },
    { repo: 'corpus', targetPath: entry.path, why: 'manifest:adapted:exists-here' },
  );
});

test('senza manifest la risposta è unknown, mai il corpus per sola esistenza', () => {
  const route = mirrorRoute({
    path: 'host/batchWrite.ts',
    side: 'corpus',
    manifestFiles: null,
    existsHere: () => true,
    existsTwin: () => false,
  });
  assert.equal(route.repo, 'unknown');
  assert.equal(route.why, 'manifest-unavailable');
});

test('un bullet di una PR del corpus che cita un identical viene instradato al sito', () => {
  const body = [
    '## Implementato',
    '- qualcosa',
    '',
    '## Non implementato (ancora)',
    '- Il flush di `host/batchWrite.ts` non ritenta su 429 — blocked: serve un giro di prova',
    '- Riallineamento del drift check — per scelta. **Motivo:** il trasporto lo porta da solo. **Prossimo passo:** nessuno.',
    '',
  ].join('\n');
  const existsTwin = recordingTwin();
  const bullets = classifyCandidateBullets({
    pr: { body },
    side: 'corpus',
    manifestFiles: MANIFEST_FILES,
    existsHere: () => true,
    existsTwin,
  });
  const cited = bullets.find((b) => b.text.includes('host/batchWrite.ts'));
  assert.ok(cited?.candidate, 'il bullet blocked con causa tecnica resta candidato');
  assert.deepEqual(
    cited.routes.map((r) => [r.path, r.repo, r.targetPath]),
    [['host/batchWrite.ts', 'site', 'build-plugins/batchWrite.ts']],
  );
  const byChoice = bullets.find((b) => b.text.startsWith('Riallineamento'));
  assert.equal(byChoice?.candidate, false, 'una deroga per scelta con Motivo e Prossimo passo non si conia');
  assert.deepEqual(byChoice.routes, []);
  assert.deepEqual(existsTwin.calls, []);
});

// Review della PR corpus 2080 (finding 🔴): `EMPTY_DECLARED_RE` ancorata solo
// all'inizio scartava «Nessuno: <azione>» come vuoto, mentre l'oracolo lo
// dichiara candidato. Allineato al sito #11352.
const bodyOf = (line) => `## Non implementato (ancora)\n- ${line}\n`;
const classifyOne = (line) =>
  classifyCandidateBullets({
    pr: { body: bodyOf(line) },
    side: 'corpus',
    manifestFiles: MANIFEST_FILES,
    existsHere: () => true,
    existsTwin: () => true,
  })[0];

for (const line of ['Nessuno.', '**Nessuno**', 'none', '_Niente._', 'Nothing —']) {
  test(`«${line}» da solo è una sezione dichiarata vuota`, () => {
    const bullet = classifyOne(line);
    assert.equal(bullet.kind, 'empty-declared');
    assert.equal(bullet.candidate, false);
    assert.equal(bullet.reason, 'empty');
  });
}

for (const line of [
  'Nessuno: aggiornare `scripts/ci/foo.mjs`',
  'Nessuno — aggiungere il guard',
  'Nessuno — snapshot automatizzato, senza residui.',
]) {
  test(`«${line}»: «Nessuno» seguito da un'azione resta candidato`, () => {
    const bullet = classifyOne(line);
    assert.equal(bullet.kind, 'bullet');
    assert.equal(bullet.candidate, true);
  });
}

test('una decisione vaga resta candidata finche non e auditabile', () => {
  const vague = classifyOne('Riallineamento del drift check — per scelta');
  const audited = classifyOne(
    'Riallineamento del drift check — per scelta. Motivo: il gate dipende dal flusso. ' +
      'Prossimo passo: nessun lavoro aggiuntivo.',
  );
  assert.equal(vague.candidate, true);
  assert.equal(audited.candidate, false);
});

// Allineato al sito #11371 (review della PR corpus 2080, due finding 🔴).
test('una continuazione senza marker con `per scelta` chiude il bullet: non è candidato', () => {
  const body = [
    '## Non implementato (ancora)',
    '- Riallineamento del drift check',
    '  per scelta. **Motivo:** il trasporto lo porta da solo.',
    '  **Prossimo passo:** nessuno.',
    '',
  ].join('\n');
  const bullets = classifyCandidateBullets({
    pr: { body },
    side: 'corpus',
    manifestFiles: MANIFEST_FILES,
    existsHere: () => true,
    existsTwin: () => true,
  });
  assert.equal(bullets.length, 1, 'le righe di continuazione si accorpano al bullet, non sono bullet a sé');
  assert.equal(bullets[0].candidate, false);
  assert.deepEqual(bullets[0].routes, []);
});

test('`FOLLOWUP.md` nella root, in una PR del corpus, viene instradato al corpus', () => {
  const entry = MANIFEST_FILES.find((e) => e.path === 'FOLLOWUP.md');
  assert.ok(entry, 'premessa: il manifest ha la voce FOLLOWUP.md');
  const bullet = classifyOne('Aggiornare `FOLLOWUP.md` con lo stato — blocked: serve il giro di prova');
  assert.equal(bullet.candidate, true);
  const route = bullet.routes.find((r) => r.path === 'FOLLOWUP.md');
  assert.ok(route, `FOLLOWUP.md senza route: ${JSON.stringify(bullet.routes)}`);
  assert.equal(route.repo, 'corpus', 'FOLLOWUP.md è adapted: lo si corregge nel corpus');
});
