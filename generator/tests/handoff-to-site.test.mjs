/**
 * handoff-to-site.test.mjs — il passaggio di consegne verso il sito.
 *
 * Il difetto, misurato il 2026-08-24: `blocked-admin-settings` su questo repo non
 * descrive impostazioni di repo. Su tutte e 4 le issue aperte che lo portavano —
 * #548, #531, #513, #472 — la forma era «lato sbagliato del mirror»: il fixer
 * verifica al turno 1 che il file da cambiare vive sul SITO, lo scrive, e si
 * ferma. La diagnosi è corretta, completa e già pagata, e nessuno la portava di
 * là: il verdetto la trasformava in un parcheggio, che è il modo più costoso di
 * avere ragione.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handoffDecision,
  extractSitePaths,
  handoffTitle,
  lastVerdictComment,
  HANDOFF_VERDICTS,
  MIRROR_LOCKED_MODES,
  mirrorLockedPaths,
  SITE_REPO,
} from '../../scripts/ci/handoff-to-site.mjs';

const MIRROR_BODY = 'Root cause nota: il JSDoc bugiardo vive in `scripts/create-article.mjs` '
  + 'del repo **`valerielinc-ops/frontaliere-si-o-no`**, non in questo repo. '
  + 'Confermato: `generator/scripts/create-article.mjs` qui è diverso.';

test('instrada il caso mirror: verdetto + repo del sito + path', () => {
  const d = handoffDecision({ verdict: 'blocked-admin-settings', body: MIRROR_BODY });
  assert.equal(d.handoff, true);
  assert.ok(d.paths.includes('scripts/create-article.mjs'));
});

test('serve la CONGIUNZIONE: due condizioni su tre non bastano', () => {
  // È la congiunzione a selezionare 4 casi su 4 senza falsi. Allentarla a una
  // disgiunzione spedirebbe al sito ogni `blocked-admin-settings`, incluse le
  // impostazioni di repo che sono davvero tali.
  assert.equal(handoffDecision({ verdict: 'already-fixed', body: MIRROR_BODY }).handoff, false);
  assert.equal(handoffDecision({
    verdict: 'blocked-admin-settings',
    body: 'serve branch protection su `main`, niente a che vedere con l\'altro repo',
  }).handoff, false);
  assert.equal(handoffDecision({
    verdict: 'blocked-admin-settings',
    body: 'il fix va in valerielinc-ops/frontaliere-si-o-no ma non so dove',
  }).handoff, false, 'senza un path la diagnosi non è azionabile: non si spedisce');
});

test('senza verdetto → non instradata, e il default è non spedire', () => {
  assert.equal(handoffDecision({}).handoff, false);
  assert.equal(handoffDecision({ verdict: null, body: MIRROR_BODY }).handoff, false);
});

test('i verdetti instradabili sono solo quelli osservati', () => {
  assert.ok(HANDOFF_VERDICTS.has('blocked-admin-settings'));
  assert.ok(HANDOFF_VERDICTS.has('blocked-workflows-scope'));
  // #316: `no-root-cause` è entrato perché su quella issue NON significava
  // «causa non trovata» — la causa era scritta e riconfermata 10 volte, ed era
  // il mirror a bloccare. Resta però ambiguo, quindi porta la quarta condizione.
  assert.ok(HANDOFF_VERDICTS.has('no-root-cause'));
  for (const v of ['already-fixed', 'max-turns', 'pr-created', 'overlap-skip']) {
    assert.equal(HANDOFF_VERDICTS.has(v), false, v);
  }
});

// --- #316: il discriminante di `no-root-cause` è il manifest, non il verdetto ---

const LOCKED = new Set(['scripts/ci/followup-drainer.mjs']);

// La forma esatta dei 10 verdetti di #316: causa trovata, file `identical`.
const NRC_MIRROR_BODY = 'Root cause: `isQueueManaged` in `scripts/ci/followup-drainer.mjs` '
  + 'esclude le issue `route:\'none\'` dall\'age-out. Il file è `mode: identical` '
  + 'col sito (`valerielinc-ops/frontaliere-si-o-no`): scriverlo qui produrrebbe '
  + 'corpus-ahead, vietato da AGENTS.md #6. Vedi `scripts/ci/loop-sync-manifest.json`.';

test('no-root-cause con un path `identical` è il caso mirror, e si spedisce', () => {
  const d = handoffDecision({ verdict: 'no-root-cause', body: NRC_MIRROR_BODY, lockedPaths: LOCKED });
  assert.equal(d.handoff, true);
  assert.ok(d.paths.includes('scripts/ci/followup-drainer.mjs'));
  assert.match(d.reason, /mirror/);
});

test('si spediscono i soli path BLOCCATI, non tutti quelli citati', () => {
  // `NRC_MIRROR_BODY` cita anche `scripts/ci/loop-sync-manifest.json`, che il
  // fixer nomina come PROVA e non come file da cambiare. Elencarlo di là sotto
  // «path del sito» manderebbe il ciclo del sito a toccare un file che il
  // mirror non condivide — rumore in una consegna che esiste per essere precisa.
  const d = handoffDecision({ verdict: 'no-root-cause', body: NRC_MIRROR_BODY, lockedPaths: LOCKED });
  assert.deepEqual(d.paths, ['scripts/ci/followup-drainer.mjs']);
  assert.ok(extractSitePaths(NRC_MIRROR_BODY).includes('scripts/ci/loop-sync-manifest.json'));
});

test('no-root-cause SENZA path bloccati dal mirror resta un vicolo cieco', () => {
  // Il falso positivo misurato il 2026-09-04: #694 cita path `adapted` e
  // corpus-only, cioè lavoro NOSTRO. Spedirlo aprirebbe una issue inutile sul
  // sito e chiuderebbe qui una issue legittima — peggio del parcheggio.
  const d = handoffDecision({
    verdict: 'no-root-cause',
    body: 'Il gemello su `valerielinc-ops/frontaliere-si-o-no` è allineato; qui manca '
      + 'la pipeline in `scripts/offload-generated-images-cdn.mjs`.',
    lockedPaths: LOCKED,
  });
  assert.equal(d.handoff, false);
  assert.match(d.reason, /vicolo cieco/);
});

test('per no-root-cause il manifest SOSTITUISCE il nome del repo in prosa', () => {
  // 4 dei 14 verdetti di #316 non scrivono lo slug `frontaliere-si-o-no` pur
  // diagnosticando lo stesso file `identical`. Legare la consegna alla prosa
  // dell'agente la renderebbe un terno al lotto; `mode: identical` è
  // l'affermazione formale che quel file è condiviso col sito.
  const senzaSlug = 'Root cause: `isQueueManaged` in `scripts/ci/followup-drainer.mjs`. '
    + 'Il file è byte-identico al gemello: scriverlo qui verrebbe sovrascritto al mirror.';
  assert.equal(senzaSlug.includes('frontaliere-si-o-no'), false);
  assert.equal(handoffDecision({ verdict: 'no-root-cause', body: senzaSlug, lockedPaths: LOCKED }).handoff, true);
});

test('la condizione sul manifest vale SOLO per no-root-cause', () => {
  // I `blocked-*` sono già disambigui: hanno selezionato 4 casi su 4 senza
  // falsi con la sola congiunzione a tre. Estendere il vincolo a loro
  // smetterebbe di spedire proprio i casi per cui lo script è nato.
  const d = handoffDecision({ verdict: 'blocked-admin-settings', body: MIRROR_BODY, lockedPaths: new Set() });
  assert.equal(d.handoff, true);
});

test('mirrorLockedPaths legge il manifest reale, non un elenco ricopiato', () => {
  assert.deepEqual([...MIRROR_LOCKED_MODES], ['identical']);
  const locked = mirrorLockedPaths();
  assert.ok(locked.size > 0, 'il manifest dichiara dei file identical');
  assert.ok(locked.has('scripts/ci/followup-drainer.mjs'), 'il file di #316 è fra quelli bloccati');
  // Un `adapted` è nostro da modificare: non deve mai finire qui dentro.
  assert.equal(locked.has('scripts/lib/classify-issue.mjs'), false);
});

// --- i due lati non hanno lo stesso path ---

test('mirrorLockedPaths mappa sul `sitePath`, che nella maggior parte dei casi DIFFERISCE', () => {
  // 112 dei 157 entry `identical` portano un `sitePath` diverso dal path del
  // corpus. Spedire il path del corpus manderebbe il fixer di là a cercare un
  // file che nel suo repo non esiste — e la consegna esiste per essere precisa.
  const locked = mirrorLockedPaths();
  assert.equal(locked.get('host/shared/clauseTail.mjs'), 'build-plugins/shared/clauseTail.mjs');
  // Quando `sitePath` manca, i due lati coincidono: identità, non `undefined`.
  assert.equal(locked.get('scripts/ci/followup-drainer.mjs'), 'scripts/ci/followup-drainer.mjs');
  for (const [corpusPath, sitePath] of locked) assert.ok(sitePath, `sitePath vuoto per ${corpusPath}`);
});

test('si matcha sul path del CORPUS e si spedisce quello del SITO', () => {
  // Il fixer scrive la diagnosi coi path di QUESTO repo (è qui che gira), quindi
  // il match resta sul path del corpus; ma la issue di là li presenta come
  // «path del sito», e lì deve leggere la forma che di là esiste.
  const d = handoffDecision({
    verdict: 'no-root-cause',
    body: 'Root cause: la stopword manca in `host/shared/clauseTail.mjs`, `mode: identical` col sito.',
    lockedPaths: new Map([['host/shared/clauseTail.mjs', 'build-plugins/shared/clauseTail.mjs']]),
  });
  assert.equal(d.handoff, true);
  assert.deepEqual(d.paths, ['build-plugins/shared/clauseTail.mjs']);
});

// --- la consegna non è la risoluzione: il residuo decide la chiusura ---

test('i path citati che il mirror NON porta tornano come `residual`', () => {
  // #316 è aggregata: l'item 2 vive su `scripts/lib/classify-issue.mjs`, che è
  // `adapted` — nostro, e nessun mirror lo consegnerà. Chiudere la issue
  // `completed` dopo la consegna dichiarerebbe risolto anche quello e ne farebbe
  // evaporare l'unico portatore. `residual` è ciò che fa parcheggiare invece di
  // chiudere (vedi `main`).
  const d = handoffDecision({
    verdict: 'no-root-cause',
    body: 'Item 1: `isQueueManaged` in `scripts/ci/followup-drainer.mjs` (identical). '
      + 'Item 2: il mislabel silenzioso in `scripts/lib/classify-issue.mjs`.',
    lockedPaths: LOCKED,
  });
  assert.equal(d.handoff, true);
  assert.deepEqual(d.paths, ['scripts/ci/followup-drainer.mjs']);
  assert.deepEqual(d.residual, ['scripts/lib/classify-issue.mjs']);
});

test('nessun residuo quando tutto ciò che è citato scende col mirror', () => {
  const solo = 'Root cause: `isQueueManaged` in `scripts/ci/followup-drainer.mjs`, `mode: identical`.';
  assert.deepEqual(handoffDecision({ verdict: 'no-root-cause', body: solo, lockedPaths: LOCKED }).residual, []);
  // I `blocked-*` non cambiano: la forma misurata 4 su 4 è «un solo file, e vive
  // sul sito», quindi niente residuo e la chiusura resta quella di sempre.
  assert.deepEqual(handoffDecision({ verdict: 'blocked-admin-settings', body: MIRROR_BODY }).residual, []);
});

test('manifest illeggibile → non si spedisce niente (fallimento sicuro)', () => {
  assert.equal(mirrorLockedPaths('/nonexistent/loop-sync-manifest.json').size, 0);
  assert.equal(
    handoffDecision({ verdict: 'no-root-cause', body: NRC_MIRROR_BODY, lockedPaths: new Set() }).handoff,
    false,
  );
});

test('extractSitePaths prende solo i path in backtick, che è la forma prescritta', () => {
  assert.deepEqual(extractSitePaths('vedi `scripts/a/b.mjs` e `x/y.ts`'), ['scripts/a/b.mjs', 'x/y.ts']);
  // Prosa che nomina un file senza backtick: non è un path citato, ed è giusto
  // che non conti — il fixer li scrive in backtick per contratto.
  assert.deepEqual(extractSitePaths('il file scripts/a/b.mjs è rotto'), []);
  assert.deepEqual(extractSitePaths(''), []);
  assert.deepEqual(extractSitePaths(null), []);
});

test('il titolo mette il discriminante PRIMO', () => {
  // Chi legge i titoli taglia a 60 caratteri: un discriminante in coda si perde,
  // e due consegne diverse diventerebbero lo stesso titolo.
  const t = handoffTitle(548, 'follow-up(#537): JSDoc bugiardo nel gemello sito');
  assert.ok(t.startsWith('corpus#548:'));
});

test('lastVerdictComment prende il PIÙ RECENTE, in entrambe le forme di data', () => {
  const got = lastVerdictComment([
    { body: '<!-- FIX_OUTCOME: no-root-cause -->', created_at: '2026-08-19T10:00:00Z' },
    { body: `<!-- FIX_OUTCOME: blocked-admin-settings -->\n${MIRROR_BODY}`, createdAt: '2026-08-22T10:00:00Z' },
  ]);
  assert.equal(got.verdict, 'blocked-admin-settings');
  assert.ok(got.body.includes('create-article.mjs'));
});

test('lastVerdictComment è null quando non c\'è nessun marker', () => {
  assert.equal(lastVerdictComment([{ body: 'solo prosa' }]), null);
  assert.equal(lastVerdictComment([]), null);
  assert.equal(lastVerdictComment(null), null);
});

test('#815: un verdetto senza data non viene scartato come «nessun verdetto»', () => {
  // Gemello `corpus-only` dell'item 1 di #815. Le due forme accettate hanno
  // chiavi diverse (`created_at` REST, `createdAt` GraphQL) e nessuna e'
  // garantita da un tipo: scartare il commento senza data faceva tornare `null`,
  // indistinguibile dal caso in cui nessun fixer e' mai passato. Qui il costo e'
  // preciso — un `blocked-workflows-scope` che nomina un file del sito non
  // verrebbe MAI spedito, e l'unico segnale sarebbe una diagnosi che non arriva.
  const got = lastVerdictComment([
    { body: `<!-- FIX_OUTCOME: blocked-admin-settings -->\n${MIRROR_BODY}`, created_at: 'non-una-data' },
  ]);
  assert.equal(got.verdict, 'blocked-admin-settings');
  assert.ok(got.body.includes('create-article.mjs'));
  // Ma un verdetto DATATO batte sempre uno senza data, a qualunque distanza.
  const mixed = lastVerdictComment([
    { body: '<!-- FIX_OUTCOME: blocked-admin-settings -->' },
    { body: '<!-- FIX_OUTCOME: no-root-cause -->', created_at: '2020-01-01T00:00:00Z' },
  ]);
  assert.equal(mixed.verdict, 'no-root-cause');
});

test('il repo di destinazione è il sito, non un placeholder', () => {
  assert.match(SITE_REPO, /^valerielinc-ops\/frontaliere-si-o-no$/);
});

test('lo script è CITATO da issue-fix.yml: non è codice scollegato', async () => {
  // Difetto ricorrente di questo ciclo: un meccanismo costruito e mai attaccato
  // a niente non fa fallire nulla. Se qualcuno lo scollega, questo test lo dice.
  const fs = await import('node:fs');
  const wf = fs.readFileSync(new URL('../../.github/workflows/issue-fix.yml', import.meta.url), 'utf8');
  assert.match(wf, /handoff-to-site\.mjs/);
  assert.match(wf, /SITE_TOKEN:/);
});
