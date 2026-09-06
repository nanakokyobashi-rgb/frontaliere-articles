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
  originWriteSteps,
  lastVerdictComment,
  HANDOFF_VERDICTS,
  MIRROR_LOCKED_MODES,
  mirrorLockedPaths,
  citedAsMirrorBlocked,
  siteAbsentPaths,
  sitePathMap,
  strandedTwinPaths,
  descentBlock,
  SITE_ABSENT_MODES,
  SITE_REPO,
} from '../../scripts/ci/handoff-to-site.mjs';

const MIRROR_BODY = 'Root cause nota: il JSDoc bugiardo vive in `scripts/create-article.mjs` '
  + 'del repo **`valerielinc-ops/frontaliere-si-o-no`**, non in questo repo. '
  + 'Confermato: `generator/scripts/create-article.mjs` qui è diverso.';

test('instrada il caso mirror: verdetto + repo del sito + path', () => {
  const d = handoffDecision({ verdict: 'blocked-admin-settings', body: MIRROR_BODY });
  assert.equal(d.handoff, true);
  // Uguaglianza, non `includes`: `MIRROR_BODY` cita anche la forma corpus
  // `generator/scripts/create-article.mjs`, che il manifest dichiara `adapted`
  // con `sitePath: scripts/create-article.mjs`. Sono lo STESSO file di là, e
  // spedirlo due volte — una delle quali in una forma che sul sito non esiste —
  // e' cio' che l'assertion su `includes` lasciava passare.
  assert.deepEqual(d.paths, ['scripts/create-article.mjs']);
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

// --- #972 item 1: `identical` da solo è troppo largo (funnel-critical) ---

test('una MENZIONE incidentale di un file `identical` non instrada e non chiude', () => {
  // Il difetto: il discriminante era «un qualunque path in backtick è
  // `identical` nel manifest». Dei 157 entry `identical`, 47 stanno sotto
  // `scripts/` e sono i file del ciclo agentico stesso — cioè quelli che OGNI
  // diagnosi sul loop nomina di passaggio, spesso solo per escluderli. Misurato
  // il 2026-09-06 su 400 issue: dei 53 commenti di verdetto che citano un path
  // `identical`, 27 (51%) non affermano affatto un blocco del mirror. Con la
  // sola appartenenza al manifest ognuno di quei 27 sarebbe stato instradato e,
  // senza residuo, avrebbe CHIUSO qui la issue di origine.
  const incidentale = 'Vicolo cieco: ho seguito la catena fino a `scripts/ci/followup-drainer.mjs`, '
    + 'che però non tocca questo campo. Serve indagine umana.';
  const d = handoffDecision({ verdict: 'no-root-cause', body: incidentale, lockedPaths: LOCKED });
  assert.equal(d.handoff, false);
  assert.equal(d.close, false);
  assert.match(d.reason, /menzione incidentale/);
});

test('la corroborazione è in CONGIUNZIONE col manifest, non al suo posto', () => {
  // Un'affermazione di mirror su un file che il manifest NON dichiara
  // `identical` resta un vicolo cieco: la prosa non promuove nulla da sola.
  const d = handoffDecision({
    verdict: 'no-root-cause',
    body: 'Il fix vive in `scripts/offload-generated-images-cdn.mjs`, che è identical col sito.',
    lockedPaths: LOCKED,
  });
  assert.equal(d.handoff, false);
  assert.match(d.reason, /vicolo cieco/);
});

test('citedAsMirrorBlocked riconosce le 11 forme reali di #316 e non la menzione nuda', () => {
  // I verdetti reali di #316 scrivono l'affermazione col vocabolario del
  // manifest: `mode: identical`, `site-ahead`, «sovrascritto al mirror»,
  // `sitePath`, o lo slug del sito. Tutte e cinque devono valere: legarsi a UNA
  // sola forma è ciò che rese il nome del repo in prosa un terno al lotto.
  const p = 'scripts/ci/followup-drainer.mjs';
  for (const claim of [
    'è `mode: "identical"` nel manifest',
    'ed è già `site-ahead`',
    'scriverlo qui verrebbe sovrascritto al mirror successivo',
    'il suo `sitePath` è lo stesso',
    'il gemello vive in valerielinc-ops/frontaliere-si-o-no',
  ]) {
    assert.equal(citedAsMirrorBlocked(`Root cause in \`${p}\`, che ${claim}.`, p), true, claim);
  }
  assert.equal(citedAsMirrorBlocked(`Ho escluso \`${p}\`: non tocca questo campo.`, p), false);
  assert.equal(citedAsMirrorBlocked('', p), false);
});

// --- #972 item 1: consegnare non autorizza a chiudere, su `no-root-cause` ---

test('`no-root-cause` consegna ma NON chiude, nemmeno senza residuo', () => {
  // È il verdetto ambiguo per costruzione: copre anche il vicolo cieco vero.
  // Una chiusura sbagliata fa evaporare l'unico portatore della diagnosi e non
  // ha porta di rientro, mentre il parcheggio ha `needs-human-sweep.yml`.
  const solo = 'Root cause: `isQueueManaged` in `scripts/ci/followup-drainer.mjs`, `mode: identical`.';
  const d = handoffDecision({ verdict: 'no-root-cause', body: solo, lockedPaths: LOCKED });
  assert.equal(d.handoff, true);
  assert.deepEqual(d.residual, []);
  assert.equal(d.close, false, 'senza residuo la vecchia regola chiudeva: è la perdita che #972 item 1 nomina');
});

test('i `blocked-*` continuano a chiudere: la loro diagnosi è esplicita', () => {
  const d = handoffDecision({ verdict: 'blocked-admin-settings', body: MIRROR_BODY });
  assert.equal(d.handoff, true);
  assert.equal(d.close, true);
});

test('nessun handoff → nessuna chiusura', () => {
  for (const d of [handoffDecision({}), handoffDecision({ verdict: 'already-fixed', body: MIRROR_BODY })]) {
    assert.equal(d.close, false);
  }
});

// --- #972 item 2: i path di EVIDENZA non sono né spediti né residui ---

test('siteAbsentPaths legge dal manifest i `mode` che dichiarano «di là non esiste»', () => {
  assert.deepEqual([...SITE_ABSENT_MODES].sort(), ['corpus-only', 'corpus-only-pending']);
  const absent = siteAbsentPaths();
  assert.ok(absent.has('scripts/ci/loop-sync-manifest.json'), 'il manifest stesso non esiste sul sito');
  assert.equal(absent.has('scripts/ci/followup-drainer.mjs'), false, 'un `identical` non è mai assente');
  // Manifest illeggibile → nessun filtro, cioè il comportamento di prima: qui il
  // fallimento sicuro è non togliere niente, non togliere tutto.
  assert.equal(siteAbsentPaths('/nonexistent/loop-sync-manifest.json').size, 0);
});

test('`not-ported` NON è assente: il manifest lo definisce all\'opposto', () => {
  // «Il sito ce l'ha, qui deliberatamente no» (intestazione del manifest).
  // Contarlo fra gli assenti filtrava via il caso canonico di hand-off, e il
  // non-instradamento è silenzioso: la diagnosi non arriva mai di là e nessuno
  // se ne accorge. L'unico entry è il gate dei control character.
  assert.equal(SITE_ABSENT_MODES.has('not-ported'), false);
  assert.equal(siteAbsentPaths().has('scripts/lib/control-char-publish-gate.mjs'), false);
  const d = handoffDecision({
    verdict: 'blocked-admin-settings',
    body: 'Il fix vive su `valerielinc-ops/frontaliere-si-o-no`: il gate è '
      + '`scripts/lib/control-char-publish-gate.mjs`.',
  });
  assert.equal(d.handoff, true);
  assert.deepEqual(d.paths, ['scripts/lib/control-char-publish-gate.mjs']);
});

test('sitePathMap traduce anche i gemelli `adapted`, che `mirrorLockedPaths` non conosce', () => {
  // Due domande diverse: `mirrorLockedPaths()` risponde a «il mirror
  // sovrascriverebbe» (solo `identical`), `sitePathMap()` a «come si chiama di
  // là». 36 dei 69 `adapted` hanno un `sitePath` diverso: tradurli con la prima
  // spediva la forma corpus, cioè un file che di là non esiste.
  const names = sitePathMap();
  assert.equal(names.get('generator/scripts/create-article.mjs'), 'scripts/create-article.mjs');
  assert.equal(mirrorLockedPaths().has('generator/scripts/create-article.mjs'), false);
  // Gli `identical` restano tradotti come prima, e i `not-ported` ci sono.
  assert.equal(names.get('host/shared/clauseTail.mjs'), 'build-plugins/shared/clauseTail.mjs');
  assert.ok(names.has('scripts/lib/control-char-publish-gate.mjs'));
  // Nessun path dichiarato assente dal sito entra nella traduzione.
  for (const p of siteAbsentPaths()) assert.equal(names.has(p), false, `${p} è assente dal sito`);
  // Manifest illeggibile → nessuna traduzione, cioè la forma citata: il
  // fallimento sicuro qui è il comportamento di prima.
  assert.equal(sitePathMap('/nonexistent/loop-sync-manifest.json').size, 0);
});

test('il manifest citato come PROVA non entra nel residuo, quindi non parcheggia da solo', () => {
  // `NRC_MIRROR_BODY` cita `scripts/ci/loop-sync-manifest.json` per provare il
  // `mode`. È `corpus-only`: non è lavoro che resta qui, è evidenza. Contarlo
  // faceva parcheggiare la issue per una citazione.
  const d = handoffDecision({ verdict: 'no-root-cause', body: NRC_MIRROR_BODY, lockedPaths: LOCKED });
  assert.ok(extractSitePaths(NRC_MIRROR_BODY).includes('scripts/ci/loop-sync-manifest.json'));
  assert.deepEqual(d.residual, []);
});

test('nemmeno i `blocked-*` spediscono un path che di là non esiste', () => {
  // Stessa classe sull'altro ramo, e la misura del 2026-09-06 la mostra viva: 4
  // delle 9 consegne reali elencavano `scripts/ci/loop-sync-manifest.json` fra i
  // «path del sito». Un file `corpus-only` non è mai un bersaglio di là.
  const body = 'Il fix vive in `valerielinc-ops/frontaliere-si-o-no`, in `scripts/lib/ai-models.mjs`. '
    + 'Prova: `scripts/ci/loop-sync-manifest.json`.';
  const d = handoffDecision({ verdict: 'blocked-admin-settings', body });
  assert.equal(d.handoff, true);
  assert.deepEqual(d.paths, ['scripts/lib/ai-models.mjs']);
});

test('anche i `blocked-*` spediscono la forma del SITO di un gemello `identical`', () => {
  // Il 🔴 #1 di #914 era stato applicato al solo ramo `no-root-cause`; la misura
  // mostra consegne reali (#472, #359) che spedivano la forma CORPUS di un
  // gemello che sul sito vive altrove.
  const d = handoffDecision({
    verdict: 'blocked-admin-settings',
    body: 'Il fix vive su `valerielinc-ops/frontaliere-si-o-no`: `host/shared/clauseTail.mjs`.',
    lockedPaths: new Map([['host/shared/clauseTail.mjs', 'build-plugins/shared/clauseTail.mjs']]),
  });
  assert.deepEqual(d.paths, ['build-plugins/shared/clauseTail.mjs']);
});

test('un `blocked-*` che cita SOLO evidenza non è instradabile', () => {
  // #472: l'unico path in backtick estratto era `generator/scripts/lib/source-url-ledger.mjs`,
  // `corpus-only` — il bersaglio vero (`…:2129` con prefisso di repo) non è mai
  // stato catturato. La vecchia regola apriva di là una issue su un file che di
  // là non esiste, e chiudeva questa. Meglio non consegnare che consegnare a caso.
  const d = handoffDecision({
    verdict: 'blocked-admin-settings',
    body: 'Il target vive su valerielinc-ops/frontaliere-si-o-no; qui il fix è già in '
      + '`generator/scripts/lib/source-url-ledger.mjs`, che non ha equivalente da editare.',
  });
  assert.equal(d.handoff, false);
  assert.equal(d.close, false);
  assert.match(d.reason, /inesistenti sul sito/);
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

// ── #972 item 3: le scritture sulla issue di origine ────────────────────────
//
// Il difetto: la transizione di stato («parcheggia» o «chiudi») viaggiava in
// coda al commento e dentro UN solo `gh issue edit` con tre effetti. Il primo
// errore era terminale per tutto il resto, e il giro successivo non riparava
// niente perche' corto-circuita sul dedup — la issue del sito ORA esiste. La
// issue restava con le label di routing, cioe' ri-pagava run: esattamente il
// costo che questo script esiste per togliere.

const stepsOf = (o) => originWriteSteps(o).map((s) => `${s.kind}:${s.args.join(' ')}`);

test('#972: lo STATO passa prima del commento', () => {
  const park = originWriteSteps({ issue: '316', repo: 'o/r', close: false, comment: 'consegnata' });
  const close = originWriteSteps({ issue: '548', repo: 'o/r', close: true, comment: 'consegnata' });
  for (const steps of [park, close]) {
    assert.equal(steps.at(-1).kind, 'comment', 'il commento e\' cosmetico: se cade, lo stato dev\'essere gia\' passato');
    assert.ok(steps.slice(0, -1).every((s) => s.kind === 'state'));
    assert.ok(steps.length > 1);
  }
});

test('#972: un effetto per chiamata — le tre label non sono piu\' atomiche', () => {
  const steps = originWriteSteps({ issue: '316', repo: 'o/r', close: false, comment: 'consegnata' });
  const labelSteps = steps.filter((s) => s.args[0] === 'issue' && s.args[1] === 'edit');
  assert.equal(labelSteps.length, 3, 'add + due remove = tre chiamate indipendenti');
  for (const s of labelSteps) {
    const flags = s.args.filter((a) => a === '--add-label' || a === '--remove-label');
    assert.equal(flags.length, 1, `un solo effetto per chiamata, non ${flags.join('+')}: `
      + 'con `--add-label needs-human --remove-label agent:fix --remove-label agent:fix-queued` '
      + 'una sola label non risolvibile faceva cadere anche il parcheggio');
  }
  // L'aggiunta prima delle rimozioni: un run che muore in mezzo lascia la issue
  // parcheggiata due volte, mai senza nessuna label.
  assert.deepEqual(steps.map((s) => s.args.at(-1)),
    ['needs-human', 'agent:fix', 'agent:fix-queued', 'consegnata']);
});

test('#972: il ramo close chiude e NON tocca le label di routing', () => {
  assert.deepEqual(stepsOf({ issue: '548', repo: 'o/r', close: true, comment: 'x' }), [
    'state:issue close 548 --repo o/r --reason completed',
    'comment:issue comment 548 --repo o/r --body x',
  ]);
});

test('#972: senza commento restano i soli passi idempotenti (ramo dedup)', () => {
  // E' cio' che il dedup ri-applica: ri-mettere una label che c\'e\' gia\' non e\'
  // niente, ri-postare il commento a ogni giro sarebbe rumore.
  const steps = originWriteSteps({ issue: '316', repo: 'o/r', close: false });
  assert.ok(steps.every((s) => s.kind === 'state'));
  assert.equal(steps.length, 3);
});

test('#972: il dedup ripara lo stato invece di uscire', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../scripts/ci/handoff-to-site.mjs', import.meta.url), 'utf8');
  const dedup = src.slice(src.indexOf('già consegnata'), src.indexOf('già consegnata') + 700);
  assert.match(dedup, /runOriginSteps\(originWriteSteps\(/,
    'il ramo di dedup e\' il solo punto in cui il mezzo-stato del giro precedente e\' osservabile: '
    + 'uscirne con un `return` secco lo rende definitivo');
  // E nessuno chiama piu' `gh issue edit` con piu' di un effetto dentro.
  // Il guard si applica a un argv PER VOLTA — ogni array letterale che porta un
  // flag di label — non al file intero: i flag compaiono anche in prosa nel
  // JSDoc che spiega il difetto, e due step vicini ma distinti hanno add e
  // remove a poca distanza pur essendo due chiamate separate. Confondere le due
  // cose renderebbe il guard rosso proprio per il fix che documenta.
  for (const argv of src.match(/\[[^[\]]*'--(?:add|remove)-label'[^[\]]*\]/g) || []) {
    const flags = argv.match(/'--(?:add|remove)-label'/g) || [];
    assert.equal(flags.length, 1, `un solo effetto per chiamata, non ${flags.join('+')} in ${argv}`);
  }
});

// --- #972 item 4: `identical` non implica «trasportato» ---------------------

test('#972: i gemelli che nessun trasporto porta giù sono quelli che il trasporto stesso rifiuta', () => {
  const stuck = strandedTwinPaths();
  // I 25 workflow `identical`: `unsafeTarget` li esclude PER SEMPRE dal
  // trasporto — «il token del ciclo non ha lo scope `workflows`, quei gemelli
  // restano una copia a mano» — ed è precisamente ciò che un verdetto
  // `blocked-workflows-scope` nomina.
  assert.ok(stuck.has('.github/workflows/translate-pending.yml'));
  // Un gemello `identical` normale scende da solo: non è nell'insieme, e la
  // chiusura dei `blocked-*` resta quella di sempre.
  assert.equal(stuck.has('scripts/ci/followup-drainer.mjs'), false);
  // `engine/` non è qui, e non perché sia trasportabile da questo canale: è
  // `outOfScope` PROPRIO perché ha il suo (`mirror-articles-engine.yml`).
  // Trattare `outOfScope` come un blocco direbbe «non scende» dell'unica
  // famiglia che scende da sempre.
  for (const p of stuck) assert.ok(!p.startsWith('engine/'), p);
});

test('#972: descentBlock separa «condiviso» da «scende», e il fixture è un no prudente', () => {
  assert.equal(descentBlock({ path: 'scripts/ci/followup-drainer.mjs', mode: 'identical' }), null);
  assert.match(descentBlock({ path: '.github/workflows/translate-pending.yml', mode: 'identical' }), /workflows/);
  // Un fixture è INCERTO, non trasportabile: il trasporto lo copia solo se i
  // suoi accoppiamenti locali sono `identical`, e quella domanda vuole l'albero
  // del repo. Si sbaglia verso il parcheggio, che ha una porta di rientro.
  assert.match(descentBlock({ path: 'host/tests/shell-contract-functions.golden.json', mode: 'identical' }), /fixture/);
});

test('#972: un `blocked-*` su un gemello che non scenderà mai consegna ma NON chiude', () => {
  // Il difetto: la chiusura dei `blocked-*` promette, nel commento che lascia,
  // «quando la fix scenderà col mirror la condizione non ci sarà più». Per un
  // workflow `identical` quella frase è falsa — la discesa è una copia a mano —
  // e la issue chiusa era l'unico posto in cui quella copia risultava dovuta.
  const body = 'Blocked: il fix va scritto in `.github/workflows/translate-pending.yml` '
    + 'su valerielinc-ops/frontaliere-si-o-no, gemello `identical` di questo.';
  const d = handoffDecision({ verdict: 'blocked-workflows-scope', body });
  assert.equal(d.handoff, true, 'la diagnosi va comunque consegnata: la fix si scrive di là');
  assert.equal(d.close, false);
  assert.deepEqual(d.residual, ['.github/workflows/translate-pending.yml']);
  assert.match(d.reason, /copia a mano/);
});

test('#972: un `blocked-*` su un gemello che scende chiude come prima', () => {
  // Nessuna regressione sui 4 casi su 4 misurati: il blocco è mirato ai soli
  // path che il trasporto rifiuta per sempre, non a tutti gli `identical`.
  const d = handoffDecision({ verdict: 'blocked-admin-settings', body: MIRROR_BODY });
  assert.equal(d.close, true);
  assert.deepEqual(d.residual, []);
});

test('#972: un `no-root-cause` su un gemello fermo lascia il residuo, non lo assorbe', () => {
  // Il residuo toglieva TUTTI i path `identical` perché «li porta il mirror».
  // Per un gemello che nessun canale porta giù il lavoro resta qui (una copia a
  // mano), e senza residuo il commento di parcheggio non lo nomina.
  const body = 'Root cause: il concurrency group in `.github/workflows/translate-pending.yml`, '
    + '`mode: identical`: scriverlo qui verrebbe sovrascritto al mirror successivo.';
  const d = handoffDecision({ verdict: 'no-root-cause', body });
  assert.equal(d.handoff, true);
  assert.equal(d.close, false);
  assert.deepEqual(d.residual, ['.github/workflows/translate-pending.yml']);
});

test('#972: manifest illeggibile → nessun blocco alla chiusura, cioè il comportamento di prima', () => {
  assert.equal(strandedTwinPaths('/dev/null/manifest-che-non-esiste.json').size, 0);
  const d = handoffDecision({ verdict: 'blocked-admin-settings', body: MIRROR_BODY, stranded: new Set() });
  assert.equal(d.close, true);
});
