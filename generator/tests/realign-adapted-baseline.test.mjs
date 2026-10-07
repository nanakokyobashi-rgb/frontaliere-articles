/**
 * realign-adapted-baseline.test.mjs — la baseline di un gemello `adapted` si
 * riallinea da sola SOLO con le tre prove, e mai altrimenti (issue #1997).
 *
 * ## Perche' esiste
 *
 * Una baseline scritta in automatico afferma un allineamento cosciente. Senza
 * le tre prove — PR del sito mergiate, ogni commit del sito coperto da una PR
 * dichiarata, corpus fermo dal merge della dichiarante — il job seppellirebbe
 * un drift che nessuno ha letto: e' il difetto che `--init` senza `--force`
 * rifiuta gia' (issue #978), rifatto da un cron.
 *
 * Titolo dell'allarme se questo osservatore scatta in produzione:
 * «Mirror: gemello `adapted` con riallineamento dichiarato e mai avvenuto».
 *
 * ## Perche' testa le funzioni pure
 *
 * `main()` parla con GitHub e riscrive il manifest versionato. La decisione e'
 * pura e i lookup sono iniettati, come per `classify` e `ghostVerdict`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  STALE_DECLARATION_TITLE,
  EXIT_PARTIAL,
  convergedModeDecision,
  convertConvergedEntry,
  baselineNewerThanDeclaration,
  collectDeclarations,
  declarationCandidateLines,
  evaluateDeclaration,
  initRunFailed,
  isStaleDeclaration,
  parseRealignDeclarations,
  realignDeclarationLine,
  realignDecision,
  verifyInitResult,
} from '../../scripts/ci/realign-adapted-baseline.mjs';
import {
  EXIT_INVALID_MANIFEST,
  writeManifestWithGuard,
} from '../../scripts/ci/lib/manifest-entry-rules.mjs';
import { pruneRatchetFile } from '../../scripts/ci/lib/adapted-drift.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = '.github/workflows/transport-identical-twins-realign.yml';
const MANIFEST_REL = 'scripts/ci/loop-sync-manifest.json';
const RATCHET_REL = 'scripts/ci/adapted-drift-ratchet.json';

const REL = 'scripts/ci/esempio.mjs';
const entry = (over = {}) => ({
  path: REL,
  mode: 'adapted',
  baseline: { site: 'site-base', corpus: 'corpus-base', alignedAt: '2026-09-01' },
  ...over,
});

/**
 * Un mondo finto: `history` e' la storia del file sul sito dal piu' recente,
 * ogni commit col proprio hash e le PR a cui appartiene.
 */
function world({ history, sitePrs = {}, corpus = {}, calls = [] }) {
  return {
    calls,
    async sitePr(number) {
      calls.push(`sitePr:${number}`);
      return sitePrs[number] || { number, merged: false, baseRef: null };
    },
    async siteHistory(sitePath, cap) {
      calls.push(`siteHistory:${sitePath}`);
      return history.slice(0, cap).map(({ sha }) => ({ sha }));
    },
    async siteHashAt(_sitePath, sha) {
      return history.find((commit) => commit.sha === sha).hash;
    },
    async commitPrs(sha) {
      return history.find((commit) => commit.sha === sha).prs || [];
    },
    corpusHashAt(ref) {
      return ref in corpus ? corpus[ref] : null;
    },
  };
}

const merged = (number) => ({ number, merged: true, baseRef: 'main' });
const declaration = (sitePrs, source = { kind: 'pr', number: 50, mergedAt: '2026-09-20T10:00:00Z', mergeCommitSha: 'merge50' }) => ({
  path: REL,
  sitePrs,
  sources: [source],
});
const evaluate = (declared, io, over = {}) => evaluateDeclaration({ entry: entry(over.entry), declaration: declared, io, cap: over.cap ?? 30 });

test('tre prove vere, una PR del sito: riallinea sulla coppia di hash valutata', async () => {
  const io = world({
    history: [
      { sha: 'c2', hash: 'site-new', prs: [101] },
      { sha: 'c1', hash: 'site-base', prs: [90] },
    ],
    sitePrs: { 101: merged(101) },
    corpus: { merge50: 'corpus-new', HEAD: 'corpus-new' },
  });
  const decision = await evaluate(declaration([101]), io);
  assert.equal(decision.realign, true, decision.reason);
  assert.deepEqual(decision.expected, { site: 'site-new', corpus: 'corpus-new' });
});

test('convergenza sicura: la voce puo\' diventare `identical` e perde la reason', () => {
  const before = entry({ reason: 'adattamento storico', adaptationIssue: 'https://github.com/nanakokyobashi-rgb/frontaliere-articles/issues/2337' });
  const decision = convergedModeDecision({
    entry: before,
    expected: { site: 'same', corpus: 'same' },
    couplings: [],
  });
  assert.equal(decision.convert, true);
  assert.equal(decision.held, false);
  assert.equal(decision.status, 'converged-to-identical');
  assert.equal(
    convergedModeDecision({ entry: before, expected: { site: 'different', corpus: 'same' } }).convert,
    false,
    'una convergenza assente non deve cambiare il percorso storico',
  );

  const after = convertConvergedEntry({
    ...before,
    baseline: { site: 'same', corpus: 'same', alignedAt: '2026-10-07' },
  });
  assert.equal(after.mode, 'identical');
  assert.equal(after.reason, undefined);
  assert.equal(after.adaptationIssue, undefined);
  assert.equal(after.baseline.site, after.baseline.corpus);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'converged-ratchet-'));
  try {
    const ratchetPath = path.join(dir, RATCHET_REL);
    fs.mkdirSync(path.dirname(ratchetPath), { recursive: true });
    fs.writeFileSync(ratchetPath, JSON.stringify({ paths: [REL, 'scripts/ci/altro.mjs'] }));
    assert.deepEqual(pruneRatchetFile(dir, decision.status === 'converged-to-identical' ? [REL] : []), [REL]);
    assert.deepEqual(JSON.parse(fs.readFileSync(ratchetPath, 'utf8')).paths, ['scripts/ci/altro.mjs']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('convergenza con accoppiamento bloccante: serve una decisione sulla mode e la voce resta trattenuta', () => {
  const before = entry({ path: 'host/tests/esempio.golden.json', reason: 'adattamento storico' });
  const snapshot = structuredClone(before);
  const decision = convergedModeDecision({
    entry: before,
    expected: { site: 'same', corpus: 'same' },
    couplings: [{ path: 'host/shared/consumer.ts', mode: 'adapted' }],
  });
  assert.equal(decision.convert, false);
  assert.equal(decision.held, true);
  assert.equal(decision.status, 'converged-needs-mode');
  assert.match(decision.reason, /convergente: serve la decisione sulla `mode`/);
  assert.deepEqual(before, snapshot, 'una convergenza trattenuta non deve mutare la voce del manifest');
});

test('guardia writer: un manifest reso invalido non viene scritto e restituisce il codice che non pusha', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-guard-'));
  try {
    const manifestPath = path.join(dir, 'loop-sync-manifest.json');
    const original = {
      files: [entry({ reason: 'adattamento storico' })],
    };
    const originalBytes = Buffer.from(`${JSON.stringify(original, null, 2)}\n`);
    fs.writeFileSync(manifestPath, originalBytes);
    const invalid = {
      files: [entry({ baseline: { site: 'same', corpus: 'same' }, reason: undefined })],
    };

    const result = writeManifestWithGuard({
      manifestPath,
      manifest: invalid,
      originalBytes,
      log: () => {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, EXIT_INVALID_MANIFEST);
    assert.deepEqual(fs.readFileSync(manifestPath), originalBytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('catena di due PR del sito dichiarate, entrambe mergiate: riallinea', async () => {
  const io = world({
    history: [
      { sha: 'c3', hash: 'site-newer', prs: [102] },
      { sha: 'c2', hash: 'site-new', prs: [101] },
      { sha: 'c1', hash: 'site-base', prs: [90] },
    ],
    sitePrs: { 101: merged(101), 102: merged(102) },
    corpus: { merge50: 'corpus-new', HEAD: 'corpus-new' },
  });
  const decision = await evaluate(declaration([101, 102]), io);
  assert.equal(decision.realign, true, decision.reason);
  assert.equal(decision.expected.site, 'site-newer');
});

test('un commit del sito non coperto da PR dichiarate: nessuna scrittura', async () => {
  const io = world({
    history: [
      { sha: 'c3aaaaaaaaaaaaaa', hash: 'site-newer', prs: [102] },
      { sha: 'c2', hash: 'site-new', prs: [101] },
      { sha: 'c1', hash: 'site-base', prs: [90] },
    ],
    sitePrs: { 101: merged(101) },
    corpus: { merge50: 'corpus-new', HEAD: 'corpus-new' },
  });
  const decision = await evaluate(declaration([101]), io);
  assert.equal(decision.realign, false);
  assert.equal(decision.status, 'site-commit-uncovered');
  assert.match(decision.reason, /c3aaaaaaaaaa/);
});

test('un push diretto sul sito (commit senza PR) non e\' coperto da nessuna dichiarazione', async () => {
  const io = world({
    history: [
      { sha: 'direct', hash: 'site-new', prs: [] },
      { sha: 'c1', hash: 'site-base', prs: [90] },
    ],
    sitePrs: { 101: merged(101) },
    corpus: { merge50: 'corpus-new', HEAD: 'corpus-new' },
  });
  assert.equal((await evaluate(declaration([101]), io)).status, 'site-commit-uncovered');
});

test('una delle PR non MERGED: nessuna scrittura, e la storia del sito non viene nemmeno letta', async () => {
  const io = world({
    history: [{ sha: 'c1', hash: 'site-base', prs: [90] }],
    sitePrs: { 101: merged(101), 102: { number: 102, merged: false, baseRef: 'main' } },
    corpus: { merge50: 'corpus-new', HEAD: 'corpus-new' },
  });
  const decision = await evaluate(declaration([101, 102]), io);
  assert.equal(decision.realign, false);
  assert.equal(decision.status, 'site-pr-not-merged');
  assert.match(decision.reason, /#102/);
  assert.doesNotMatch(decision.reason, /#101/);
  assert.ok(!io.calls.some((call) => call.startsWith('siteHistory')));
});

test('una PR mergiata su un ramo che non e\' main non vale come mergiata', async () => {
  const io = world({
    history: [{ sha: 'c1', hash: 'site-base', prs: [] }],
    sitePrs: { 101: { number: 101, merged: true, baseRef: 'release' } },
  });
  assert.equal((await evaluate(declaration([101]), io)).status, 'site-pr-not-merged');
});

test('corpus mosso dopo la PR dichiarante: nessuna scrittura', async () => {
  const io = world({
    history: [
      { sha: 'c2', hash: 'site-new', prs: [101] },
      { sha: 'c1', hash: 'site-base', prs: [90] },
    ],
    sitePrs: { 101: merged(101) },
    corpus: { merge50: 'corpus-new', HEAD: 'corpus-later' },
  });
  const decision = await evaluate(declaration([101]), io);
  assert.equal(decision.realign, false);
  assert.equal(decision.status, 'corpus-moved');
});

test('storia oltre il tetto senza ritrovare la baseline: nessuna scrittura', async () => {
  const io = world({
    history: [
      { sha: 'c4', hash: 'site-4', prs: [101] },
      { sha: 'c3', hash: 'site-3', prs: [101] },
      { sha: 'c2', hash: 'site-2', prs: [101] },
      { sha: 'c1', hash: 'site-base', prs: [90] },
    ],
    sitePrs: { 101: merged(101) },
    corpus: { merge50: 'corpus-new', HEAD: 'corpus-new' },
  });
  const capped = await evaluate(declaration([101]), io, { cap: 3 });
  assert.equal(capped.realign, false);
  assert.equal(capped.status, 'site-history-unresolved');
  // Controprova: con un tetto che arriva alla baseline la stessa storia passa.
  assert.equal((await evaluate(declaration([101]), io, { cap: 4 })).realign, true);
});

test('senza meta\' corpus (dispatch): la terza prova e\' «corpus fermo a baseline.corpus»', async () => {
  const history = [
    { sha: 'c2', hash: 'site-new', prs: [101] },
    { sha: 'c1', hash: 'site-base', prs: [90] },
  ];
  const still = world({ history, sitePrs: { 101: merged(101) }, corpus: { HEAD: 'corpus-base' } });
  const ok = await evaluate(declaration([101], { kind: 'dispatch' }), still);
  assert.equal(ok.realign, true, ok.reason);
  assert.deepEqual(ok.expected, { site: 'site-new', corpus: 'corpus-base' });

  const moved = world({ history, sitePrs: { 101: merged(101) }, corpus: { HEAD: 'corpus-altro' } });
  assert.equal((await evaluate(declaration([101], { kind: 'dispatch' }), moved)).status, 'corpus-moved');
});

test('sito fermo alla baseline: gia\' allineata se il corpus e\' fermo, trattenuta se si e\' mosso solo il corpus', async () => {
  const history = [{ sha: 'c1', hash: 'site-base', prs: [101] }];
  const aligned = await evaluate(declaration([101]), world({ history, sitePrs: { 101: merged(101) }, corpus: { merge50: 'corpus-base', HEAD: 'corpus-base' } }));
  assert.deepEqual([aligned.realign, aligned.held, aligned.status], [false, false, 'already-aligned']);
  const corpusOnly = await evaluate(declaration([101]), world({ history, sitePrs: { 101: merged(101) }, corpus: { merge50: 'corpus-new', HEAD: 'corpus-new' } }));
  assert.deepEqual([corpusOnly.realign, corpusOnly.held, corpusOnly.status], [false, true, 'site-not-moved']);
});

test('solo le voci adapted con una baseline completa: le altre non pagano una richiesta', async () => {
  const io = world({ history: [], sitePrs: { 101: merged(101) } });
  assert.equal((await evaluateDeclaration({ entry: null, declaration: declaration([101]), io, cap: 30 })).status, 'unknown-path');
  assert.equal((await evaluate(declaration([101]), io, { entry: { mode: 'identical' } })).status, 'not-adapted');
  assert.equal((await evaluate(declaration([101]), io, { entry: { baseline: { site: null, corpus: 'x' } } })).status, 'no-baseline');
  assert.deepEqual(io.calls, []);
});

test('realignDecision: hash del corpus illeggibile non e\' una prova', () => {
  const decision = realignDecision({
    entry: entry(),
    declaration: declaration([101]),
    sitePrs: [merged(101)],
    siteCommits: { commits: [{ sha: 'c2', hash: 'site-new', prs: [101] }], baselineFound: true, headHash: 'site-new', cap: 30 },
    corpusHashAtMerge: null,
    corpusHashNow: null,
  });
  assert.equal(decision.status, 'corpus-hash-unknown');
});

test('riga Realign-adapted malformata: ignorata e segnalata, le righe valide restano', () => {
  const body = [
    '## Implementato',
    '- Realign-adapted: `scripts/ci/a.mjs` site-prs=#12,#34',
    'Realign-adapted: scripts/ci/b.mjs site-prs=#7',
    'Realign-adapted: scripts/ci/c.mjs site-prs=12',
    'Realign-adapted: scripts/ci/d.mjs',
    'Realign-adapted: scripts/ci/e.mjs site-prs=#1, #2',
    'In prosa: la riga Realign-adapted: scripts/ci/f.mjs site-prs=#9 non e\' a inizio riga.',
  ].join('\r\n');
  const parsed = parseRealignDeclarations(body);
  assert.deepEqual(parsed.declarations, [
    { path: 'scripts/ci/a.mjs', sitePrs: [12, 34] },
    { path: 'scripts/ci/b.mjs', sitePrs: [7] },
  ]);
  assert.deepEqual(parsed.malformed, [
    'Realign-adapted: scripts/ci/c.mjs site-prs=12',
    'Realign-adapted: scripts/ci/d.mjs',
    'Realign-adapted: scripts/ci/e.mjs site-prs=#1, #2',
  ]);
});

test('un esempio del formato in un blocco di codice recintato non dichiara nulla', () => {
  const body = [
    'Formato:',
    '```',
    'Realign-adapted: scripts/ci/esempio.mjs site-prs=#1',
    'Realign-adapted: <path> site-prs=#N[,#M…]',
    '```',
    '~~~text',
    'Realign-adapted: scripts/ci/tilde.mjs site-prs=#2',
    '```',
    'Realign-adapted: scripts/ci/ancora-dentro.mjs site-prs=#3',
    '~~~',
    'Realign-adapted: scripts/ci/vera.mjs site-prs=#4',
  ].join('\n');
  const parsed = parseRealignDeclarations(body);
  assert.deepEqual(parsed.declarations, [{ path: 'scripts/ci/vera.mjs', sitePrs: [4] }]);
  assert.deepEqual(parsed.malformed, []);
  // Il pre-filtro dell'elenco delle PR usa le stesse righe candidate.
  assert.deepEqual(declarationCandidateLines(body), ['Realign-adapted: scripts/ci/vera.mjs site-prs=#4']);
  assert.deepEqual(declarationCandidateLines('```\nRealign-adapted: x site-prs=#1\n```'), []);
});

test('il formato ha una sorgente: la riga prodotta e\' quella che il parser rilegge', () => {
  const line = realignDeclarationLine({ path: REL, sitePrs: [5, 8] });
  assert.equal(line, `Realign-adapted: ${REL} site-prs=#5,#8`);
  assert.deepEqual(parseRealignDeclarations(line).declarations, [{ path: REL, sitePrs: [5, 8] }]);
});

test('piu\' PR del corpus sullo stesso path: PR del sito in unione, prova sul corpus dalla piu\' recente', () => {
  const { declarations, malformed } = collectDeclarations([
    { number: 50, mergedAt: '2026-09-20T10:00:00Z', mergeCommitSha: 'm50', body: `Realign-adapted: ${REL} site-prs=#101` },
    { number: 60, mergedAt: '2026-09-25T10:00:00Z', mergeCommitSha: 'm60', body: `Realign-adapted: ${REL} site-prs=#102\nRealign-adapted: rotto` },
  ]);
  assert.equal(declarations.length, 1);
  assert.deepEqual(declarations[0].sitePrs, [101, 102]);
  assert.deepEqual(declarations[0].sources.map((source) => source.number), [60, 50]);
  assert.deepEqual(malformed, [{ pr: 60, line: 'Realign-adapted: rotto' }]);
});

test('verifyInitResult: la baseline scritta deve essere la coppia valutata', () => {
  const before = entry();
  const expected = { site: 'site-new', corpus: 'corpus-new' };
  const written = (site, corpus) => entry({ baseline: { site, corpus, alignedAt: '2026-10-03', forcedAt: '2026-10-03T00:00:00.000Z' } });
  assert.equal(verifyInitResult({ before, after: written('site-new', 'corpus-new'), expected }).ok, true);
  // `--init` ha rifiutato la voce (attestazione): niente da riportare indietro.
  assert.deepEqual(
    (({ ok, revert, status }) => ({ ok, revert, status }))(verifyInitResult({ before, after: entry(), expected })),
    { ok: false, revert: false, status: 'init-refused' },
  );
  // Il sito si e' mosso fra valutazione e scrittura: la voce torna com'era.
  assert.deepEqual(
    (({ ok, revert, status }) => ({ ok, revert, status }))(verifyInitResult({ before, after: written('site-ancora-dopo', 'corpus-new'), expected })),
    { ok: false, revert: true, status: 'moved-during-init' },
  );
});

test('initRunFailed: un rifiuto di `--init` dopo le tre prove lascia il job rosso', () => {
  // `loop-drift-check.mjs --init` esce 1 apposta quando rifiuta una voce: il wrapper non lo zittisce.
  assert.equal(initRunFailed({ childStatus: 1, statuses: ['realigned'] }), true);
  // Ucciso da un segnale: `status` e' null.
  assert.equal(initRunFailed({ childStatus: null, statuses: ['realigned'] }), true);
  // Exit 0 ma voce non riscritta: e' comunque un rifiuto.
  assert.equal(initRunFailed({ childStatus: 0, statuses: ['realigned', 'init-refused'] }), true);
  // Un lato mosso durante `--init` si ritenta alla passata dopo: non e' rosso.
  assert.equal(initRunFailed({ childStatus: 0, statuses: ['moved-during-init'] }), false);
  assert.equal(initRunFailed({ childStatus: 0, statuses: ['realigned'] }), false);
  assert.equal(EXIT_PARTIAL, 3);
});

test('dichiarazione trattenuta oltre la soglia: allarme, salvo baseline riscritta dopo la dichiarazione', () => {
  const held = { held: true, realign: false, status: 'site-pr-not-merged', reason: '' };
  const source = { kind: 'pr', number: 50, mergedAt: '2026-09-20T10:00:00Z', mergeCommitSha: 'm50' };
  const day = 24 * 60 * 60 * 1000;
  const at = (days) => Date.parse(source.mergedAt) + days * day;
  assert.equal(isStaleDeclaration({ decision: held, entry: entry(), source, nowMs: at(8), staleDays: 7 }), true);
  assert.equal(isStaleDeclaration({ decision: held, entry: entry(), source, nowMs: at(6), staleDays: 7 }), false);
  assert.equal(isStaleDeclaration({ decision: { ...held, held: false }, entry: entry(), source, nowMs: at(8), staleDays: 7 }), false);
  assert.equal(isStaleDeclaration({ decision: held, entry: entry(), source: { kind: 'dispatch' }, nowMs: at(8), staleDays: 7 }), false);
  // Gia' onorata e poi di nuovo in drift: e' un drift nuovo, non un riallineamento mancato.
  const honored = entry({ baseline: { site: 's', corpus: 'c', alignedAt: '2026-09-20', forcedAt: '2026-09-20T16:23:00.000Z' } });
  assert.equal(baselineNewerThanDeclaration(honored, source.mergedAt), true);
  assert.equal(isStaleDeclaration({ decision: held, entry: honored, source, nowMs: at(8), staleDays: 7 }), false);
  // `alignedAt` dello stesso giorno non prova che sia venuta dopo.
  assert.equal(baselineNewerThanDeclaration(entry({ baseline: { site: 's', corpus: 'c', alignedAt: '2026-09-20' } }), source.mergedAt), false);
  assert.equal(baselineNewerThanDeclaration(entry({ baseline: { site: 's', corpus: 'c', alignedAt: '2026-09-21' } }), source.mergedAt), true);
  assert.match(STALE_DECLARATION_TITLE, /riallineamento dichiarato e mai avvenuto/);
});

// ───────────────────── Contratto del workflow (testo YAML) ─────────────────────

const yml = fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf8');
/** Il blocco di un job: dalla sua chiave fino alla prossima chiave di job. */
function jobBlock(name) {
  const start = yml.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job \`${name}\` assente da ${WORKFLOW}`);
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** Il testo prima di `jobs:`; un indice mancante non deve far leggere tutto il file. */
function workflowHead() {
  const idx = yml.indexOf('\njobs:\n');
  assert.ok(idx >= 0, `chiave \`jobs:\` non trovata in ${WORKFLOW}`);
  return yml.slice(0, idx);
}

test('workflow: realign-adapted scrive sotto lo stesso lock globale del realign dei trasporti', () => {
  const head = workflowHead();
  assert.match(head, /\nconcurrency:\n(?:\s+#.*\n)*\s+group: transport-identical-twins-realign-main\n\s+cancel-in-progress: false\n/);
  // Il lock e' del workflow: un `concurrency:` di job lo sostituirebbe per quel job.
  for (const name of ['realign', 'realign-adapted']) {
    assert.doesNotMatch(jobBlock(name), /\n\s+concurrency:/, `il job \`${name}\` non deve dichiarare un gruppo proprio`);
  }
});

test('workflow: trigger a orario e a mano, e il job dei trasporti resta sul solo evento pull_request', () => {
  const head = workflowHead();
  assert.match(head, /\n  schedule:\n\s+- cron: '\d+ \*\/6 \* \* \*'\n/);
  assert.match(head, /\n  workflow_dispatch:\n\s+inputs:\n\s+paths:[\s\S]*?\n\s+site_prs:[\s\S]*?\n\s+dry_run:/);
  assert.match(head, /\npermissions:\n\s+contents: write\n\s+pull-requests: read\n/);
  assert.match(jobBlock('realign'), /github\.event\.pull_request\.merged == true/);
  assert.match(jobBlock('realign-adapted'), /\n    if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\n/);
});

test('workflow: il push e\' condizionato al diff del SOLO manifest (e del ratchet adapted), e gli input non entrano nello script', () => {
  const job = jobBlock('realign-adapted');
  const diffGuard = job.indexOf(`git diff --name-only | grep -vxF -e ${MANIFEST_REL} -e ${RATCHET_REL}`);
  const noChange = job.indexOf(`git diff --quiet -- ${MANIFEST_REL}`);
  const add = job.indexOf(`git add -- ${MANIFEST_REL}`);
  const push = job.indexOf('git push origin HEAD:main');
  assert.ok(noChange >= 0 && diffGuard > noChange, 'manca il controllo «solo il manifest e\' cambiato»');
  assert.ok(add > diffGuard && push > add, 'il push deve venire dopo il controllo sul diff');
  assert.doesNotMatch(job, /git add (?!-- scripts\/ci\/(?:loop-sync-manifest|adapted-drift-ratchet)\.json)/);
  assert.match(job, /for attempt in 1 2 3; do/);
  // Il checkout non deve persistere il token del job: coprirebbe il PAT del push.
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /runtime_pat="\$\{GITHUB_PAT_NANAKO:-\}"/);
  // Gli input del dispatch arrivano come env, mai interpolati in `run:`.
  const runStart = job.indexOf('        run: |\n          set -euo pipefail\n          args=()');
  assert.ok(runStart >= 0, 'step di riallineamento non trovato: il controllo sugli input sarebbe vacuo');
  const run = job.slice(runStart);
  assert.match(run, /node scripts\/ci\/realign-adapted-baseline\.mjs/);
  assert.doesNotMatch(run, /\$\{\{/);
});

test('workflow: si pusha solo con rc 0 o 3; un\'eccezione (rc 1) non porta il manifest fuori dal runner', () => {
  const job = jobBlock('realign-adapted');
  const gate = job.indexOf('if [ "$rc" != "0" ] && [ "$rc" != "3" ]; then');
  const add = job.indexOf(`git add -- ${MANIFEST_REL}`);
  assert.ok(gate >= 0, 'manca il cancello sull\'exit code dello script');
  assert.ok(add > gate, 'il cancello sull\'exit code deve precedere `git add`');
  // L'esito parziale pusha le voci certificate ma chiude rosso.
  assert.match(job, /if \[ "\$rc" = "3" \]; then final=1; fi/);
  const pushBlock = job.slice(job.indexOf('if git push origin HEAD:main; then'));
  assert.match(pushBlock.slice(0, pushBlock.indexOf('fi\n')), /exit "\$final"/);
});
