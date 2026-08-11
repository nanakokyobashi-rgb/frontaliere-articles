/**
 * generation-health-watchdog.test.mjs — la suite di `scripts/ci/scan-generation-health.mjs`.
 *
 * Le tre cose che prova, e la terza è quella che di solito manca:
 *
 *  1. **Il parsing dei marker**, su campioni VERBATIM da run reali. Un watchdog
 *     che legge log è forte quanto il suo parser: se un marker smette di
 *     agganciare, tutte le condizioni diventano «spente» e il silenzio torna
 *     esattamente dov'era.
 *  2. **La deduplica**: il titolo di una condizione è stabile per condizione e
 *     non contiene mai la misura del momento — è ciò che rende una issue una
 *     sola issue invece di una al ciclo.
 *  3. **Che ogni condizione che si può APRIRE si possa anche CHIUDERE**, e che
 *     il workflow che esegue lo scanner esista davvero.
 *
 * Il punto (3) è il test che avrebbe intercettato il precedente di
 * `alert-pat-down.mjs` (#45): quel file dichiarava in un commento che un certo
 * workflow era «l'unico punto di chiusura» del suo alert, e quel workflow non
 * esisteva. La issue `priority:urgent` che apriva non poteva essere chiusa da
 * niente, e col dedup sul titolo sarebbe restata accesa per sempre.
 * `loop-references-exist.test.mjs` copre ORA le citazioni testuali; qui si prova
 * la proprietà a monte, che è più forte: che il percorso di chiusura sia
 * ESEGUITO, sulla stessa tabella e con lo stesso titolo con cui si apre.
 *
 * corpus-only: non c'è un gemello sul sito. Il sito non genera più il corpus.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONDITIONS,
  IDLE_HOURS,
  OVERSIZE_MIN_MODELS,
  OVERSIZE_MIN_RUNS,
  PAIR_WINDOW_MINUTES,
  RUN_LOOKBACK_HOURS_DEFAULT,
  SATURATION_MIN_RUNS,
  SATURATION_RATE,
  SECTIONS,
  SECTION_DRY_HOURS,
  SECTION_DRY_PEER_MIN,
  SECTION_DRY_SUPPRESSORS,
  TOTAL_REJECTION_MIN_GATE_RUNS,
  TOTAL_REJECTION_RATE,
  collectCorpus,
  evaluateConditions,
  findDuplicateTopicPairs,
  pairKeyOf,
  parseGenerationCommit,
  parseRunLog,
  reconcile,
  summarizeRuns,
} from '../../scripts/ci/scan-generation-health.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const H = 3_600_000;
const NOW = Date.parse('2026-08-10T16:00:00.000Z');

// ── Campioni VERBATIM da run reali. Non riscriverli a mano: sono il contratto
// col produttore, e la loro forma esatta è l'unica cosa che il parser deve
// sapere. Provengono dalle run 31402084443 / 31405217754 / 31394604922 e dalla
// finestra 2026-08-09→10 di `generate-article.yml`.
//
// ⚠ Un campione che invecchia è PEGGIO di nessun campione: certifica il parser
// contro un input che la produzione non produce più, e resta verde mentre il
// watchdog è cieco. È successo qui: la riga `PRESPEND_GATE_TOTAL_REJECTION` di
// questa fixture non aveva `backstop=`, che #185 emette dal 2026-08-10, e il
// parser posizionale che la leggeva non agganciava più NIENTE in produzione
// (misurato l'11-08: 35 righe reali, 0 match) mentre questa suite passava.
// Chi tocca un marker della pipeline aggiorna il campione nello stesso giro.
const LOG_SVIZZERA_EMPTIED = [
  'generate\tResolve run mode and section\t2026-08-10T09:08:01.6991912Z \x1b[36;1mecho "event=$EV chain=$CHAIN → section=$SEC dry_run=$DRY"\x1b[0m',
  'generate\tResolve run mode and section\t2026-08-10T09:08:01.7127129Z event=schedule chain=false → section=svizzera dry_run=false',
  'generate\tGenerate the article\t2026-08-10T09:08:10.4887160Z   TARGET_SECTION: svizzera',
  'generate\tGenerate the article\t2026-08-10T09:08:40.1Z PRESPEND_GATE_TOTAL_REJECTION before=5 classifier_calls=5 anchor_candidates=0 restored=0 backstop=none kept_after=0 section=svizzera',
  'generate\tGenerate the article\t2026-08-10T09:08:51.9Z ⚠️  Tutte le keyword evergreen risultano già coperte dal pre-flight. Push prosegue senza nuovo articolo.',
  'generate\tGenerate the article\t2026-08-10T09:08:52.0029325Z PRESPEND_GATE_OUTCOME emptied=1 recovered=none before=6 kept=0 status=skipped section=svizzera',
].join('\n');

// La forma PRE-#185 della stessa riga, senza `backstop=`. Resta in retention
// per giorni, quindi il parser deve leggerla ancora: è il campo OPZIONALE, non
// il campo obbligatorio di ieri.
const LOG_TOTAL_REJECTION_PRE_185 =
  'generate\tGenerate the article\t2026-08-09T22:10:00.1Z PRESPEND_GATE_TOTAL_REJECTION before=5 classifier_calls=5 anchor_candidates=0 restored=0 kept_after=0 section=svizzera';

// ── Il difetto di questa PR, VERBATIM dalla run 31455920617 (2026-08-11T03:36).
// Il pool news è svuotato (`emptied=1`) e la sezione pubblica lo stesso, con un
// evergreen al posto della news (`recovered=evergreen`). Nella finestra di 12h
// misurata l'11-08 questa è la forma di 29 run su 32 svuotate: era la totalità
// del difetto, e il predicato `recovered === 'none'` non ne vedeva nessuna.
const LOG_FRONTALIERE_EMPTIED_EVERGREEN = [
  'generate\tResolve run mode and section\t2026-08-11T03:36:50.1Z event=schedule chain=false → section=frontaliere dry_run=false',
  'generate\tGenerate the article\t2026-08-11T03:37:10.1Z   TARGET_SECTION: frontaliere',
  'generate\tGenerate the article\t2026-08-11T03:40:02.1Z PRESPEND_GATE_TOTAL_REJECTION before=31 classifier_calls=31 anchor_candidates=0 restored=0 backstop=none kept_after=0 section=frontaliere',
  'generate\tGenerate the article\t2026-08-11T03:44:11.1Z PRESPEND_GATE_OUTCOME emptied=1 recovered=evergreen before=31 kept=0 status=generated section=frontaliere',
].join('\n');

// ── Una run sola che prova ENTRAMBE le sezioni, VERBATIM dalla run 31426037947
// (2026-08-10T19:50). Due righe `PRESPEND_GATE_OUTCOME`: la prima frontaliere,
// la seconda svizzera. Con `exec` la seconda non la leggeva nessuno.
const LOG_DUE_SEZIONI = [
  'generate\tResolve run mode and section\t2026-08-10T19:50:10.1Z event=push chain=true → section=frontaliere dry_run=false',
  'generate\tGenerate the article\t2026-08-10T19:52:00.1Z PRESPEND_GATE_OUTCOME emptied=1 recovered=none before=33 kept=0 status=deferred section=frontaliere',
  'generate\tGenerate the article\t2026-08-10T19:58:00.1Z PRESPEND_GATE_OUTCOME emptied=0 recovered=news before=62 kept=30 status=generated section=svizzera',
].join('\n');

const LOG_FRONTALIERE_OK = [
  'generate\tResolve run mode and section\t2026-08-10T15:10:01.7127129Z event=schedule chain=false → section=frontaliere dry_run=false',
  'generate\tGenerate the article\t2026-08-10T15:10:10.4887160Z   TARGET_SECTION: frontaliere',
  'generate\tGenerate the article\t2026-08-10T15:18:14.6037711Z PRESPEND_GATE_OUTCOME emptied=0 recovered=evergreen before=54 kept=3 status=generated section=frontaliere',
].join('\n');

const LOG_OVERSIZE = [
  'generate\tResolve run mode and section\t2026-08-10T12:35:30.1Z event=schedule chain=false → section=frontaliere dry_run=false',
  'generate\tGenerate the article\t2026-08-10T12:36:01.1Z ⏭️  [gpt-4.1] Skipped — request would exceed 8000-token limit (estimated 9431)',
  'generate\tGenerate the article\t2026-08-10T12:36:02.1Z ⏭️  [Cohere-command-a] Skipped — request would exceed 4000-token limit (estimated 9431)',
  'generate\tGenerate the article\t2026-08-10T12:36:03.1Z ⏭️  [Phi-4] Skipped — request would exceed 6000-token limit (estimated 9431)',
  'generate\tGenerate the article\t2026-08-10T12:36:04.1Z ⏭️  [Codestral-2501] Skipped — request would exceed 8000-token limit (estimated 10930)',
  'generate\tGenerate the article\t2026-08-10T12:36:05.1Z ⏭️  [groq/qwen/qwen3.6-27b] Skipped — request would exceed 3000-token limit (estimated 10930)',
  'generate\tGenerate the article\t2026-08-10T12:36:06.1Z ⏭️  [gpt-4.1] Skipped — request would exceed 8000-token limit (estimated 10930)',
].join('\n');

const LOG_DRY = [
  'generate\tResolve run mode and section\t2026-08-10T14:27:40.1Z event=push chain=false → section=frontaliere dry_run=true',
  'generate\tLoad the generator without running it (dry run)\t2026-08-10T14:27:50.1Z ok',
].join('\n');

// ── 1. Parsing ──────────────────────────────────────────────────────────────

describe('parseGenerationCommit — i due esiti che il workflow già distingue', () => {
  test('riconosce un articolo prodotto, con la sua sezione', () => {
    assert.deepEqual(parseGenerationCommit('Generate blog article (svizzera)'), { kind: 'article', section: 'svizzera' });
    assert.deepEqual(parseGenerationCommit('Generate blog article (frontaliere)'), { kind: 'article', section: 'frontaliere' });
  });

  test('riconosce il commit che dice ONESTAMENTE che non ha prodotto niente', () => {
    // Il trattino è un EM DASH, non un meno: è il carattere che il workflow
    // scrive davvero, ed è l'unico motivo per cui questo test esiste separato.
    assert.deepEqual(
      parseGenerationCommit('Record rejected topic candidates (svizzera — no article generated)'),
      { kind: 'rejected', section: 'svizzera' },
    );
  });

  test('non aggancia i commit che non sono di generazione', () => {
    for (const s of [
      'Daily brief edition 2026-08-10',
      'Auto-generated FAQ for 16 blog articles',
      'Lockstep engine/ with frontaliere-si-o-no@fb2b280c',
      'fix(rss): build guid from articleId instead of slug (#174)',
      'Weekly border-wait ranking digest refresh',
      // La forma vicina ma NON quella: se un giorno il workflow cambiasse
      // subject, il watchdog deve tacere invece di leggere male.
      'Generate blog article',
    ]) {
      assert.equal(parseGenerationCommit(s), null, `non doveva agganciare: ${s}`);
    }
  });
});

describe('parseRunLog — i marker già emessi dalla pipeline', () => {
  test('legge sezione, gate svuotato e pool evergreen saturo da una run svizzera reale', () => {
    const r = parseRunLog(LOG_SVIZZERA_EMPTIED);
    assert.equal(r.section, 'svizzera');
    assert.equal(r.dryRun, false);
    assert.equal(r.event, 'schedule');
    assert.deepEqual(r.gates, [{
      emptied: true, recovered: 'none', before: 6, kept: 0, status: 'skipped', section: 'svizzera',
    }]);
    assert.equal(r.totalRejections.length, 1);
    assert.equal(r.evergreenSaturated, true);
  });

  test('legge `backstop=`, il campo che #185 ha aggiunto in MEZZO alla riga', () => {
    // Il campione sopra porta la riga di OGGI. Questo test la interroga sul
    // campo nuovo: se qualcuno rimettesse un parser posizionale, `backstop`
    // tornerebbe `null` — o, come è successo davvero, la riga non aggancerebbe
    // affatto e `totalRejections` sarebbe vuoto con la suite verde.
    const r = parseRunLog(LOG_SVIZZERA_EMPTIED);
    assert.deepEqual(r.totalRejections[0], {
      before: 5, classifierCalls: 5, anchorCandidates: 0, restored: 0,
      backstop: 'none', keptAfter: 0, section: 'svizzera',
    });
  });

  test('la forma PRE-#185, senza `backstop=`, resta leggibile', () => {
    // I log in retention non si riscrivono: il campo è opzionale, non sparito.
    const r = parseRunLog(LOG_TOTAL_REJECTION_PRE_185);
    assert.equal(r.totalRejections.length, 1);
    assert.equal(r.totalRejections[0].backstop, null);
    assert.equal(r.totalRejections[0].keptAfter, 0);
    assert.equal(r.totalRejections[0].section, 'svizzera');
  });

  test('un campo NUOVO non rompe il marker — è il difetto di #185 reso impossibile', () => {
    // La proprietà che il parser posizionale non aveva: chi aggiunge un campo
    // alla telemetria non deve poter azzerare in silenzio un denominatore.
    const r = parseRunLog(
      'generate\tx\t2026-08-11T00:00:00Z PRESPEND_GATE_OUTCOME emptied=1 recovered=evergreen'
      + ' before=31 kept=0 status=generated campo_del_futuro=42 section=frontaliere',
    );
    assert.equal(r.gates.length, 1);
    assert.equal(r.gates[0].emptied, true);
    assert.equal(r.gates[0].section, 'frontaliere');
  });

  test('un marker senza le chiavi che servono viene SCARTATO, non completato con zeri', () => {
    // «Permissivo» non è «credulone»: uno zero inventato entrerebbe nei
    // denominatori come se fosse una misura.
    const r = parseRunLog('generate\tx\t2026-08-11T00:00:00Z PRESPEND_GATE_OUTCOME emptied=1 recovered=none');
    assert.deepEqual(r.gates, []);
  });

  test('una run sana non produce nessun segnale acceso', () => {
    const r = parseRunLog(LOG_FRONTALIERE_OK);
    assert.equal(r.section, 'frontaliere');
    assert.equal(r.gates[0].emptied, false);
    assert.equal(r.gates[0].recovered, 'evergreen');
    assert.equal(r.gates[0].status, 'generated');
    assert.equal(r.evergreenSaturated, false);
    assert.equal(r.tokenLimitSkips.length, 0);
  });

  test('DUE righe del gate nella stessa run: si leggono entrambe', () => {
    // Dopo #180 una run prova entrambe le sezioni. `exec` leggeva la prima e
    // basta: la seconda non la leggeva nessuno, e l'esito del gate di quella
    // sezione spariva dal suo denominatore.
    const r = parseRunLog(LOG_DUE_SEZIONI);
    assert.equal(r.gates.length, 2);
    assert.deepEqual(r.gates.map((g) => g.section), ['frontaliere', 'svizzera']);
    // La sezione della RUN resta frontaliere: è un'altra domanda.
    assert.equal(r.section, 'frontaliere');
  });

  test('l\'ECO del comando non viene scambiata per il suo output', () => {
    // La riga `event=$EV chain=$CHAIN → section=$SEC dry_run=$DRY` compare nel
    // log PRIMA dei valori risolti. Se il parser la agganciasse, ogni run
    // finirebbe con `section: "$SEC"` — cioè in nessuna sezione, e tutte le
    // condizioni per sezione tacerebbero per sempre.
    const onlyEcho = 'generate\tResolve\t2026-08-10T09:08:01.6Z \x1b[36;1mecho "event=$EV chain=$CHAIN → section=$SEC dry_run=$DRY"\x1b[0m';
    const r = parseRunLog(onlyEcho);
    assert.equal(r.section, null);
    assert.equal(r.event, null);
  });

  test('estrae ogni salto per tetto di token, con modello, tetto e stima', () => {
    const r = parseRunLog(LOG_OVERSIZE);
    assert.equal(r.tokenLimitSkips.length, 6);
    assert.deepEqual(r.tokenLimitSkips[0], { model: 'gpt-4.1', limit: 8000, estimated: 9431 });
    // Il nome del modello può contenere `/`: un parser che si fermasse al primo
    // separatore perderebbe l'intera famiglia groq/nvidia.
    assert.ok(r.tokenLimitSkips.some((s) => s.model === 'groq/qwen/qwen3.6-27b'));
    assert.equal(new Set(r.tokenLimitSkips.map((s) => s.model)).size, 5);
  });

  test('una run dry è riconosciuta come tale (non è evidenza di niente)', () => {
    const r = parseRunLog(LOG_DRY);
    assert.equal(r.dryRun, true);
    assert.equal(r.section, 'frontaliere');
  });

  test('un log vuoto o troncato non lancia, restituisce un record vuoto', () => {
    for (const t of ['', null, undefined, 'una riga qualsiasi']) {
      const r = parseRunLog(t);
      assert.equal(r.section, null);
      assert.deepEqual(r.gates, []);
      assert.deepEqual(r.totalRejections, []);
      assert.deepEqual(r.tokenLimitSkips, []);
    }
  });
});

describe('summarizeRuns — i denominatori', () => {
  test('le run dry non entrano in nessun denominatore', () => {
    const s = summarizeRuns([parseRunLog(LOG_DRY), parseRunLog(LOG_DRY), parseRunLog(LOG_FRONTALIERE_OK)]);
    assert.equal(s.bySection.get('frontaliere').runs, 1);
  });

  test('il denominatore del gate sono le sole run in cui il gate è GIRATO', () => {
    // Una run senza `PRESPEND_GATE_OUTCOME` non è evidenza in nessuna
    // direzione: `finalizeRunReport` non emette la riga quando il gate non è
    // stato eseguito. Contarla come "non svuotata" diluirebbe il segnale.
    const noGate = parseRunLog('generate\tx\t2026-08-10T00:00:00Z event=schedule chain=false → section=svizzera dry_run=false');
    const s = summarizeRuns([parseRunLog(LOG_SVIZZERA_EMPTIED), noGate, noGate]);
    const agg = s.bySection.get('svizzera');
    assert.equal(agg.runs, 3);
    assert.equal(agg.gateRuns, 1);
    assert.equal(agg.gateEmptied, 1);
  });

  test('IL DIFETTO: `recovered=evergreen` è uno SVUOTAMENTO, non un recupero', () => {
    // Il test che conta. `resolveRunRecovery()` risponde a «questa run ha
    // pubblicato, e cosa» — non a «il pool news si è ripreso». `evergreen`
    // significa che la sezione ha pubblicato un evergreen AL POSTO della news:
    // il pool news è rimasto vuoto. Contarlo come recupero (il vecchio
    // `emptied && recovered === 'none'`) rendeva invisibile il 91% del difetto
    // misurato l'11-08 (29 `evergreen` su 32 svuotamenti frontaliere).
    const s = summarizeRuns([parseRunLog(LOG_FRONTALIERE_EMPTIED_EVERGREEN)]);
    const agg = s.bySection.get('frontaliere');
    assert.equal(agg.gateRuns, 1);
    assert.equal(agg.gateEmptied, 1, 'uno svuotamento con recovered=evergreen DEVE contare');
    assert.equal(agg.gateRecovered.evergreen, 1);
    assert.equal(agg.gateRecovered.none, 0);
    // `recovered` resta come dimensione del corpo, non come filtro.
    assert.equal(agg.totalRejections, 1);
    assert.equal(agg.anchorCandidatesZero, 1);
    assert.equal(agg.restoredZero, 1);
    assert.deepEqual(agg.backstopKinds, { none: 1 });
  });

  test('le due righe di una run bi-sezione vanno alle LORO sezioni', () => {
    // La run è dichiarata `frontaliere`, ma porta anche l'esito di `svizzera`.
    // Attribuire entrambe alla sezione della run gonfierebbe un denominatore e
    // svuoterebbe l'altro.
    const s = summarizeRuns([parseRunLog(LOG_DUE_SEZIONI)]);
    const front = s.bySection.get('frontaliere');
    const sviz = s.bySection.get('svizzera');
    assert.equal(front.gateRuns, 1);
    assert.equal(front.gateEmptied, 1);
    assert.equal(sviz.gateRuns, 1, 'la seconda riga non deve sparire');
    assert.equal(sviz.gateEmptied, 0);
    // `runs` resta della sezione della RUN: sono due denominatori di due
    // domande diverse, e `gateRuns` può legittimamente superare `runs`.
    assert.equal(front.runs, 1);
    assert.equal(sviz.runs, 0);
  });

  test('un valore NUOVO di `recovered` compare nel conteggio invece di sparire', () => {
    // Stessa regola di `pairKeyOf`: un cambio di contratto a monte si vede.
    const s = summarizeRuns([parseRunLog(
      'generate\tx\t2026-08-11T00:00:00Z PRESPEND_GATE_OUTCOME emptied=1 recovered=sintetico'
      + ' before=9 kept=0 status=generated section=svizzera',
    )]);
    const agg = s.bySection.get('svizzera');
    assert.equal(agg.gateEmptied, 1);
    assert.equal(agg.gateRecovered.sintetico, 1);
  });

  test('conta le run oversize per MODELLI DISTINTI, non per numero di salti', () => {
    // Una run può stampare 110 salti su 22 modelli: il cascade riprova. È il
    // numero di modelli diversi che dice quanta parte del roster è fuori gioco.
    const s = summarizeRuns([parseRunLog(LOG_OVERSIZE)]);
    assert.equal(s.oversize.runs, 1); // 5 modelli distinti ≥ OVERSIZE_MIN_MODELS
    assert.equal(s.oversize.distinctModels, 5);
    assert.equal(s.oversize.maxEstimated, 10930);
    assert.deepEqual(s.oversize.limitsCrossed, [3000, 4000, 6000, 8000]);
  });
});

// ── 2. Le condizioni e le loro soglie ───────────────────────────────────────

/**
 * Un aggregato di sezione con TUTTI i campi che `summarizeRuns` produce.
 *
 * Costruito da una funzione e non a mano in ogni test: un fixture scritto a
 * mano che dimentica un campo nuovo fa passare un corpo di issue che in
 * produzione lancerebbe, ed è la stessa classe di difetto del campione di log
 * invecchiato qui sopra.
 */
const agg = (over = {}) => ({
  runs: 30,
  saturated: 0,
  gateRuns: 10,
  gateEmptied: 0,
  gateRecovered: { none: 0, evergreen: 0, news: 0 },
  totalRejections: 0,
  anchorCandidatesZero: 0,
  restoredZero: 0,
  backstopKinds: {},
  ...over,
});

/** Misura di riferimento: tutto sano. Ogni condizione deve essere SPENTA qui. */
function healthy() {
  const bySection = new Map();
  for (const s of SECTIONS) {
    bySection.set(s, agg());
  }
  return {
    now: NOW,
    commits: {
      available: true,
      lookbackHours: 48,
      windowStart: NOW - 48 * H,
      total: 200,
      rejected: 4,
      lastArticleAt: NOW - 0.5 * H,
      perSection: Object.fromEntries(SECTIONS.map((s) => [s, {
        articles: 20,
        rejected: 2,
        lastArticleAt: NOW - 0.5 * H,
        timestamps: Array.from({ length: 20 }, (_, i) => NOW - (i + 1) * H),
      }])),
    },
    runs: {
      available: true, total: 60, logFailures: 0, spanHours: 12, bySection,
      oversize: { runs: 0, maxEstimated: 0, limitsCrossed: [], distinctModels: 0, models: [] },
    },
    corpus: { available: true, total: 3845, duplicatePairs: [] },
  };
}

const verdictFor = (m, id, section = null) =>
  evaluateConditions(m).find((v) => v.id === id && v.section === section);

describe('le condizioni sono SPENTE sulla normalità misurata', () => {
  test('nessuna condizione si accende sulla misura di riferimento', () => {
    const firing = evaluateConditions(healthy()).filter((v) => v.firing);
    assert.deepEqual(firing.map((v) => `${v.id}${v.section ? `[${v.section}]` : ''}`), []);
  });

  test('un intervallo globale al p99 misurato (5,2h) non accende generation-idle', () => {
    // p99 dello storico 2026-07-30→08-10 su 215 intervalli. Se questa soglia
    // scendesse sotto, il watchdog suonerebbe su una normalità documentata.
    const m = healthy();
    m.commits.lastArticleAt = NOW - 5.2 * H;
    assert.equal(verdictFor(m, 'generation-idle').firing, false);
    assert.ok(IDLE_HOURS > 5.2, 'IDLE_HOURS deve stare sopra il p99 misurato');
  });

  test('il p95 per sezione (7,45h svizzera) non accende section-dry', () => {
    const m = healthy();
    m.commits.perSection.svizzera.lastArticleAt = NOW - 7.45 * H;
    assert.equal(verdictFor(m, 'section-dry', 'svizzera').firing, false);
    assert.ok(SECTION_DRY_HOURS > 7.45, 'SECTION_DRY_HOURS deve stare sopra il p95 misurato di svizzera');
  });

  test('la quota di saturazione del lato ancora produttivo (64%) non accende', () => {
    const m = healthy();
    m.runs.bySection.set('svizzera', agg({ runs: 25, saturated: 16, gateRuns: 10 }));
    assert.ok(16 / 25 < SATURATION_RATE);
    assert.equal(verdictFor(m, 'evergreen-pool-saturated', 'svizzera').firing, false);
  });

  test('una singola run oversize non basta: la condizione non sfarfalla sul bordo', () => {
    const m = healthy();
    m.runs.oversize = { runs: 1, maxEstimated: 9431, limitsCrossed: [8000], distinctModels: 7, models: ['a'] };
    assert.equal(verdictFor(m, 'prompt-oversize').firing, false);
    assert.ok(OVERSIZE_MIN_RUNS >= 2);
  });
});

describe('le condizioni sono ACCESE sui guasti realmente accaduti', () => {
  test('generation-idle: nessun articolo da 6h', () => {
    const m = healthy();
    m.commits.lastArticleAt = NOW - 6.5 * H;
    const v = verdictFor(m, 'generation-idle');
    assert.equal(v.firing, true);
    assert.match(v.body, /6\.5h/);
  });

  test('section-dry: svizzera ferma 17h mentre frontaliere ne pubblica 14 (2026-08-08→09)', () => {
    const m = healthy();
    m.commits.perSection.svizzera.lastArticleAt = NOW - 17 * H;
    m.commits.perSection.frontaliere.timestamps = Array.from({ length: 14 }, (_, i) => NOW - i * H);
    const v = verdictFor(m, 'section-dry', 'svizzera');
    assert.equal(v.firing, true);
    assert.match(v.body, /17\.0h/);
    assert.match(v.body, /\*\*14\*\*/);
  });

  test('section-dry NON si accende se anche l\'altra sezione è ferma: quello è un guasto globale', () => {
    // È la congiunzione che rende la condizione diagnostica. Senza, ogni pausa
    // di quota aprirebbe due issue di sezione al posto di una globale.
    const m = healthy();
    m.commits.perSection.svizzera.lastArticleAt = NOW - 17 * H;
    m.commits.perSection.frontaliere.timestamps = [NOW - 16 * H, NOW - 15 * H];
    assert.ok(2 < SECTION_DRY_PEER_MIN);
    assert.equal(verdictFor(m, 'section-dry', 'svizzera').firing, false);
  });

  test('evergreen-pool-saturated: svizzera a 16/18 (89%), frontaliere a 0/62', () => {
    const m = healthy();
    m.runs.bySection.set('svizzera', agg({ runs: 18, saturated: 16, gateRuns: 4 }));
    m.runs.bySection.set('frontaliere', agg({ runs: 62, saturated: 0, gateRuns: 10 }));
    assert.equal(verdictFor(m, 'evergreen-pool-saturated', 'svizzera').firing, true);
    assert.equal(verdictFor(m, 'evergreen-pool-saturated', 'frontaliere').firing, false);
  });

  test('news-pool-total-rejection: svizzera 11/13 (85%), frontaliere 0/10', () => {
    const m = healthy();
    m.runs.bySection.set('svizzera', agg({ runs: 40, saturated: 0, gateRuns: 13, gateEmptied: 11, gateRecovered: { none: 11, evergreen: 0, news: 0 }, totalRejections: 11, anchorCandidatesZero: 11, restoredZero: 11, backstopKinds: { none: 11 } }));
    const v = verdictFor(m, 'news-pool-total-rejection', 'svizzera');
    assert.equal(v.firing, true);
    assert.match(v.body, /11 run su 13/);
    // La causa, che è ciò che serve al fixer: il backstop non può scattare.
    assert.match(v.body, /anchor_candidates/);
    assert.equal(verdictFor(m, 'news-pool-total-rejection', 'frontaliere').firing, false);
  });

  test('IL DIFETTO, dal lato della condizione: frontaliere 32/34 con recovered=evergreen ACCENDE', () => {
    // La misura reale dell'11-08 (finestra 12h, 69 run non-cancellate). Col
    // vecchio predicato questa stessa finestra dava 3/34 = 9% e la condizione
    // taceva, mentre la sezione svuotava il pool news nel 94% delle run.
    const m = healthy();
    m.runs.bySection.set('frontaliere', agg({
      runs: 38, gateRuns: 34, gateEmptied: 32,
      gateRecovered: { none: 3, evergreen: 29, news: 0 },
      totalRejections: 35, anchorCandidatesZero: 35, restoredZero: 35, backstopKinds: { none: 35 },
    }));
    m.runs.bySection.set('svizzera', agg({ runs: 31, gateRuns: 34, gateEmptied: 0 }));
    const v = verdictFor(m, 'news-pool-total-rejection', 'frontaliere');
    assert.equal(v.firing, true, 'con recovered=evergreen la condizione DEVE accendersi');
    assert.match(v.body, /32 run su 34/);
    // `recovered` sopravvive come DIMENSIONE del corpo, non come filtro.
    assert.match(v.body, /`none` 3, `evergreen` 29/);
    // Il lato sano resta spento: la fix allarga il numeratore, non la soglia.
    assert.equal(verdictFor(m, 'news-pool-total-rejection', 'svizzera').firing, false);
    assert.ok(32 / 34 >= TOTAL_REJECTION_RATE && 3 / 34 < TOTAL_REJECTION_RATE,
      'la soglia 0,70 separa il predicato corretto da quello vecchio SULLA STESSA finestra');
  });

  test('il corpo NON fa scattare il gate already-resolved: la issue resta lavorabile', async () => {
    // `check-issue-already-resolved.mjs` salta il fixer quando OGNI token
    // distintivo del `## Suggested action` si trova verbatim in un file citato.
    // Il footer cita QUESTO scanner, che contiene le stringhe del corpo alla
    // lettera: un `path.mjs:771` fra backtick si auto-confermerebbe e la issue
    // nascerebbe non-lavorabile — «un body povero produce una issue che nessuno
    // può prendere», nella forma peggiore, cioè con la CI verde.
    const { detectAlreadyResolved } = await import('../../scripts/ci/followup-resolution-match.mjs');
    const io = {
      fileExists: (p) => fs.existsSync(path.join(ROOT, p)),
      readFile: (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return null; } },
    };
    const m = healthy();
    m.runs.bySection.set('frontaliere', agg({
      runs: 38, gateRuns: 34, gateEmptied: 32,
      gateRecovered: { none: 3, evergreen: 29, news: 0 },
      totalRejections: 35, anchorCandidatesZero: 35, restoredZero: 35, backstopKinds: { none: 35 },
    }));
    const v = verdictFor(m, 'news-pool-total-rejection', 'frontaliere');
    assert.equal(v.firing, true);
    const r = detectAlreadyResolved(v.body, io);
    assert.equal(r.resolved, false,
      `il gate short-circuiterebbe il fixer su token: ${JSON.stringify(r.tokens)}`);
    // Il path resta CITATO — è ciò che dà al fixer il file su cui lavorare.
    assert.ok(r.files.includes('generator/scripts/create-article.mjs'));
  });

  test('prompt-oversize: 4 run con ≥5 modelli distinti saltati', () => {
    const m = healthy();
    m.runs.oversize = {
      runs: 4, maxEstimated: 10930, limitsCrossed: [3000, 4000, 6000, 8000],
      distinctModels: 22, models: ['gpt-4.1', 'Cohere-command-a'],
    };
    const v = verdictFor(m, 'prompt-oversize');
    assert.equal(v.firing, true);
    assert.match(v.body, /10930 token/);
    assert.match(v.body, /3000, 4000, 6000, 8000/);
  });

  test('duplicate-topic-burst: la coppia piastrellista del 2026-08-09 (23 minuti)', () => {
    const first = {
      id: 'frontaliere-piastrellista-ticino-stipendio-requisiti',
      title: 'Lavorare come piastrellista in Ticino: stipendio, requisiti e riconoscimento del titolo',
      date: '2026-08-09T15:44:33.669Z',
    };
    const second = {
      id: 'lavoro-piastrellista-ticino-frontaliere',
      title: 'Lavorare come piastrellista in Ticino: guida per frontalieri',
      date: '2026-08-09T16:08:00.001Z',
    };
    const pairs = findDuplicateTopicPairs([first, second], { now: Date.parse(second.date) + H });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].key, 'profession-guide:piastrellista');
    assert.ok(pairs[0].minutesApart > 23 && pairs[0].minutesApart < 24);

    const m = healthy();
    m.corpus.duplicatePairs = pairs;
    const v = verdictFor(m, 'duplicate-topic-burst');
    assert.equal(v.firing, true);
    // Sulla CHIAVE, non sulla parola: entrambi gli id contengono gia'
    // «piastrellista», quindi un `match(/piastrellista/)` passerebbe anche con
    // la chiave collassata a `profession-guide:` — un verde per il motivo
    // sbagliato, che e' peggio di un rosso.
    assert.match(v.body, /`profession-guide:piastrellista`/);
    assert.match(v.body, /`profession-guide` 1/);
  });

  test('findDuplicateTopicPairs ignora le coppie fuori dalla finestra di lookback', () => {
    // Senza questo, una coppia storica terrebbe la issue accesa per sempre e la
    // condizione non avrebbe rientro.
    const first = {
      id: 'frontaliere-piastrellista-ticino-stipendio-requisiti',
      title: 'Lavorare come piastrellista in Ticino: stipendio, requisiti e riconoscimento del titolo',
      date: '2026-08-09T15:44:33.669Z',
    };
    const second = {
      id: 'lavoro-piastrellista-ticino-frontaliere',
      title: 'Lavorare come piastrellista in Ticino: guida per frontalieri',
      date: '2026-08-09T16:08:00.001Z',
    };
    assert.deepEqual(findDuplicateTopicPairs([first, second], { now: Date.parse(second.date) + 48 * H }), []);
  });

  test('le serie per comune SONO coppie — l\'allargamento è arrivato da solo con #184', () => {
    // Questa asserzione era rovesciata, e aveva ragione a esserlo: fino a #184
    // `topicCoverageKey` conosceva solo `profession-guide`, quindi la serie per
    // comune non produceva coppie. #184 ha aggiunto `comune-guide` e
    // `canton-theme`, e questo controllo ha guadagnato due famiglie di
    // duplicati senza che una riga cambiasse per ottenerlo — che è il motivo
    // per cui la chiave si IMPORTA invece di riscriverla.
    //
    // Dati verbatim dal corpus: la coppia cadegliano del 2026-08-10, a 102
    // minuti, la più larga delle undici uscite dopo il gate #120.
    const pairs = findDuplicateTopicPairs([
      { id: 'trasferirsi-a-cadegliano-viconago-da-frontaliere-pro-e-contro', title: 'Trasferirsi a Cadegliano-Viconago da frontaliere: pro e contro', date: '2026-08-10T07:10:02.611Z' },
      { id: 'vivere-cadegliano-viconago-frontaliere', title: 'Vivere a Cadegliano-Viconago da frontaliere', date: '2026-08-10T08:51:58.552Z' },
    ], { now: Date.parse('2026-08-10T09:00:00.000Z') });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].key, 'comune-guide:cadegliano-viconago');
    assert.ok(pairs[0].minutesApart > 101 && pairs[0].minutesApart < 103);
  });

  test('anche le coppie per cantone sono viste — la terza famiglia di #184', () => {
    // Verbatim dal corpus: la coppia LPP/Berna del 2026-08-09→10, a 12 minuti.
    const pairs = findDuplicateTopicPairs([
      { id: 'secondo-pilastro-lpp-svizzera-guida-2026-bern', title: 'Secondo pilastro LPP in Svizzera: guida 2026 per il canton Bern', date: '2026-08-09T23:51:38.781Z' },
      { id: 'secondo-pilastro-lpp-bern-2026-guida', title: 'Secondo pilastro LPP a Bern nel 2026: la guida', date: '2026-08-10T00:03:58.093Z' },
    ], { now: Date.parse('2026-08-10T01:00:00.000Z') });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].key, 'canton-theme:lpp:berna');
  });
});

// ── Il difetto che il cambio di forma della chiave ha prodotto ──────────────
//
// #184 ha cambiato `topicCoverageKey` da `{kind, professionId}` a
// `{kind, value}`. La riga che costruiva la chiave composita qui era
// `${kind}:${key.professionId || key.key || ''}`: non ha lanciato, ha prodotto
// `profession-guide:` per TUTTE e 162 le guide-mestiere del corpus — cioè un
// confronto in cui ogni mestiere è duplicato di ogni altro. I due test sotto
// sono quelli che lo avrebbero preso; il primo fallisce con la catena di
// fallback, il secondo con qualunque sua variante futura.

describe('la chiave composita non può collassare in silenzio', () => {
  test('due mestieri DIVERSI non sono la stessa coppia', () => {
    const pairs = findDuplicateTopicPairs([
      { id: 'frontaliere-piastrellista-ticino-stipendio-requisiti', title: 'Lavorare come piastrellista in Ticino: stipendio e requisiti', date: '2026-08-10T10:00:00.000Z' },
      { id: 'frontaliere-idraulico-ticino-stipendio-requisiti', title: 'Lavorare come idraulico in Ticino: stipendio e requisiti', date: '2026-08-10T10:10:00.000Z' },
    ], { now: Date.parse('2026-08-10T11:00:00.000Z') });
    assert.deepEqual(pairs, [], 'piastrellista e idraulico non sono lo stesso argomento: la chiave sta collassando sul solo `kind`');
  });

  test('pairKeyOf rifiuta una chiave senza `value` invece di indovinarla', () => {
    assert.equal(pairKeyOf({ kind: 'profession-guide', value: 'piastrellista' }), 'profession-guide:piastrellista');
    // Le forme che un cambio di contratto può produrre. Nessuna deve restituire
    // una stringa: una stringa qui è una chiave condivisa da tutti.
    for (const bad of [
      { kind: 'profession-guide' },
      { kind: 'profession-guide', value: '' },
      { kind: 'profession-guide', value: '   ' },
      { kind: 'profession-guide', professionId: 'piastrellista' }, // la forma PRE-#184
      { value: 'piastrellista' },
      {},
      null,
    ]) {
      assert.equal(pairKeyOf(bad), null, `pairKeyOf ha accettato una chiave inutilizzabile: ${JSON.stringify(bad)}`);
    }
  });

  test('una chiave malformata esclude l\'articolo, non lo accoppia a tutti', () => {
    // Fail-safe nella direzione giusta: nessuna coppia (nessun falso positivo),
    // e il chiamante lo dice con un `::warning::`.
    const articles = Array.from({ length: 5 }, (_, i) => ({
      id: `art-${i}`, title: `Titolo ${i}`, date: `2026-08-10T10:0${i}:00.000Z`,
    }));
    assert.deepEqual(findDuplicateTopicPairs(articles, { now: NOW }), []);
  });
});

describe('soppressione: una incidenza, una issue', () => {
  test('section-dry tace quando una condizione più specifica spiega già perché', () => {
    const m = healthy();
    m.commits.perSection.svizzera.lastArticleAt = NOW - 17 * H;
    m.commits.perSection.frontaliere.timestamps = Array.from({ length: 14 }, (_, i) => NOW - i * H);
    m.runs.bySection.set('svizzera', agg({ runs: 18, saturated: 16, gateRuns: 4 }));

    const v = verdictFor(m, 'section-dry', 'svizzera');
    assert.equal(v.firing, false);
    assert.deepEqual(v.suppressedBy, ['evergreen-pool-saturated']);
    assert.equal(verdictFor(m, 'evergreen-pool-saturated', 'svizzera').firing, true);
  });

  test('section-dry parla quando nessuna condizione specifica spiega perché', () => {
    const m = healthy();
    m.commits.perSection.svizzera.lastArticleAt = NOW - 17 * H;
    m.commits.perSection.frontaliere.timestamps = Array.from({ length: 14 }, (_, i) => NOW - i * H);
    assert.equal(verdictFor(m, 'section-dry', 'svizzera').firing, true);
  });

  test('la soppressione non dipende dall\'ORDINE della tabella', () => {
    // Se dipendesse, spostare una riga di `CONDITIONS` cambierebbe il
    // comportamento in silenzio. Si prova invertendo l'array e verificando che
    // il verdetto sia identico.
    const m = healthy();
    m.commits.perSection.svizzera.lastArticleAt = NOW - 17 * H;
    m.commits.perSection.frontaliere.timestamps = Array.from({ length: 14 }, (_, i) => NOW - i * H);
    m.runs.bySection.set('svizzera', agg({ runs: 18, saturated: 16, gateRuns: 4 }));
    const before = evaluateConditions(m).map((v) => `${v.id}[${v.section}]=${v.firing}`).sort();
    CONDITIONS.reverse();
    try {
      const after = evaluateConditions(m).map((v) => `${v.id}[${v.section}]=${v.firing}`).sort();
      assert.deepEqual(after, before);
    } finally {
      CONDITIONS.reverse();
    }
  });

  test('i soppressori nominati esistono davvero nella tabella', () => {
    const ids = new Set(CONDITIONS.map((c) => c.id));
    for (const id of SECTION_DRY_SUPPRESSORS) {
      assert.ok(ids.has(id), `SECTION_DRY_SUPPRESSORS nomina "${id}", che non è una condizione`);
    }
  });
});

// ── 3. Deduplica, chiusura, e il workflow che deve esistere ─────────────────

describe('deduplica: il titolo è la chiave, e non contiene la misura', () => {
  test('lo stesso guasto misurato due volte produce lo STESSO titolo', () => {
    const a = healthy();
    a.commits.lastArticleAt = NOW - 6.5 * H;
    const b = healthy();
    b.commits.lastArticleAt = NOW - 19 * H; // molto peggio, ore diverse
    assert.equal(verdictFor(a, 'generation-idle').title, verdictFor(b, 'generation-idle').title);
  });

  test('nessun titolo contiene cifre, date, id di run o percentuali', () => {
    // Un numero nel titolo è una issue nuova a ogni ciclo: la deduplica di
    // `createGithubIssue` confronta i primi 60 caratteri del titolo.
    for (const c of CONDITIONS) {
      for (const section of c.scope === 'section' ? SECTIONS : [null]) {
        const t = c.title(section);
        assert.ok(!/\d/.test(t), `il titolo di ${c.id} contiene una cifra: "${t}"`);
        assert.ok(t.length > 0 && t.length <= 120, `titolo di lunghezza sospetta per ${c.id}: "${t}"`);
      }
    }
  });

  test('i titoli sono distinti fra condizioni E fra sezioni, anche nei primi 60 caratteri', () => {
    // 60 è la lunghezza su cui `github-issue-creator.mjs` deduplica: due
    // condizioni che condividono quel prefisso collasserebbero in una issue
    // sola, e la seconda diventerebbe invisibile.
    const prefixes = [];
    for (const c of CONDITIONS) {
      for (const section of c.scope === 'section' ? SECTIONS : [null]) prefixes.push(c.title(section).slice(0, 60));
    }
    assert.equal(new Set(prefixes).size, prefixes.length, `prefissi di titolo collidenti: ${prefixes.join(' | ')}`);
  });
});

describe('ogni condizione che si apre si può chiudere — il test del precedente #45', () => {
  test('ogni condizione ha uno stato in cui NON è firing', () => {
    // La proprietà minima: nessuna condizione è "sempre vera". Una che lo fosse
    // aprirebbe una issue che nessun rientro potrebbe chiudere.
    const verdicts = evaluateConditions(healthy());
    const ids = new Set(CONDITIONS.map((c) => c.id));
    for (const id of ids) {
      const closable = verdicts.some((v) => v.id === id && v.available && !v.firing);
      assert.ok(closable, `la condizione "${id}" non ha uno stato spento raggiungibile`);
    }
  });

  test('reconcile CHIUDE con lo stesso titolo con cui apre', async () => {
    const created = [];
    const resolved = [];
    const m = healthy();
    m.commits.lastArticleAt = NOW - 19 * H; // accende generation-idle

    await reconcile(evaluateConditions(m), {
      createIssue: async (o) => { created.push(o.title); return { number: 1 }; },
      resolveIssue: (t) => { resolved.push(t); return null; },
      log: () => {},
    });

    assert.deepEqual(created, ['Watchdog generazione: nessun articolo da nessuna sezione']);
    // Tutte le altre condizioni misurabili e spente passano dal resolve, cioè
    // ogni titolo che questo file sa APRIRE è anche un titolo che sa CHIUDERE.
    const openable = [];
    for (const c of CONDITIONS) {
      for (const s of c.scope === 'section' ? SECTIONS : [null]) openable.push(c.title(s));
    }
    for (const t of openable) {
      assert.ok(created.includes(t) || resolved.includes(t), `"${t}" non è né aperta né chiusa: sarebbe una issue orfana`);
    }
  });

  test('quando tutto è sano, reconcile chiude OGNI titolo e non ne apre nessuno', async () => {
    const created = [];
    const resolved = [];
    await reconcile(evaluateConditions(healthy()), {
      createIssue: async (o) => { created.push(o.title); return { number: 1 }; },
      resolveIssue: (t) => { resolved.push(t); return { number: 9 }; },
      log: () => {},
    });
    assert.deepEqual(created, []);
    assert.equal(resolved.length, CONDITIONS.reduce((n, c) => n + (c.scope === 'section' ? SECTIONS.length : 1), 0));
  });

  test('«non ho misurato» non apre e non CHIUDE — non è «sta bene»', async () => {
    // È la classe di difetto che questo watchdog esiste per chiudere: scambiare
    // l'assenza di misura per salute. Se una sorgente è giù, una issue aperta
    // NON deve essere richiusa sulla base di un dato che non c'è.
    const m = healthy();
    m.runs = { available: false };
    m.commits = { available: false, lookbackHours: 48 };
    m.corpus = { available: false };

    const created = [];
    const resolved = [];
    await reconcile(evaluateConditions(m), {
      createIssue: async (o) => { created.push(o.title); return { number: 1 }; },
      resolveIssue: (t) => { resolved.push(t); return { number: 9 }; },
      log: () => {},
    });
    assert.deepEqual(created, []);
    assert.deepEqual(resolved, []);
  });

  test('il cap sulle issue non chiude in silenzio ciò che tronca', async () => {
    const m = healthy();
    m.commits.lastArticleAt = NOW - 19 * H;
    m.commits.perSection.svizzera.lastArticleAt = NOW - 19 * H;
    m.commits.perSection.frontaliere.timestamps = Array.from({ length: 14 }, (_, i) => NOW - i * H);
    m.runs.bySection.set('svizzera', agg({ runs: 18, saturated: 16, gateRuns: 13, gateEmptied: 11, gateRecovered: { none: 11, evergreen: 0, news: 0 }, totalRejections: 11, anchorCandidatesZero: 11, restoredZero: 11, backstopKinds: { none: 11 } }));
    m.runs.oversize = { runs: 4, maxEstimated: 10930, limitsCrossed: [8000], distinctModels: 22, models: [] };

    const created = [];
    const resolved = [];
    const res = await reconcile(evaluateConditions(m), {
      createIssue: async (o) => { created.push(o.title); return { number: 1 }; },
      resolveIssue: (t) => { resolved.push(t); return null; },
      maxIssues: 2,
      log: () => {},
    });
    assert.equal(created.length, 2);
    assert.ok(res.capped > 0, 'il cap deve essere contato, non subito in silenzio');
    // Una condizione troncata dal cap NON viene chiusa: sarebbe la bugia
    // opposta, cioè dichiarare rientrato ciò che non si è nemmeno segnalato.
    for (const t of created) assert.ok(!resolved.includes(t));
  });

  test('dry-run non apre e non chiude niente', async () => {
    const m = healthy();
    m.commits.lastArticleAt = NOW - 19 * H;
    let touched = 0;
    await reconcile(evaluateConditions(m), {
      createIssue: async () => { touched++; return { number: 1 }; },
      resolveIssue: () => { touched++; return null; },
      dryRun: true,
      log: () => {},
    });
    assert.equal(touched, 0);
  });
});

describe('il cablaggio esiste davvero — non solo nei commenti', () => {
  const WORKFLOW = path.join(ROOT, '.github/workflows/generation-health-watchdog.yml');

  test('il workflow che esegue lo scanner ESISTE', () => {
    // Il test che avrebbe intercettato #45: `alert-pat-down.mjs` nominava in un
    // commento il proprio «unico punto di chiusura», e quel workflow non
    // esisteva. Qui apertura e chiusura vivono nello stesso file, quindi basta
    // provare che il file sia eseguito da qualcosa.
    assert.ok(fs.existsSync(WORKFLOW), 'generation-health-watchdog.yml non esiste: lo scanner non verrebbe mai eseguito, e nessuna issue potrebbe chiudersi');
  });

  test('lo esegue davvero, su schedule, e gli passa il PAT', () => {
    const src = fs.readFileSync(WORKFLOW, 'utf8');
    assert.match(src, /node scripts\/ci\/scan-generation-health\.mjs/, 'il workflow non invoca lo scanner');
    assert.match(src, /schedule:/, 'senza schedule il watchdog gira solo a mano: nessuna issue si chiuderebbe da sola');
    assert.match(src, /cron: '(\d+) \*\/(\d+) \* \* \*'/, 'cron assente o in una forma che questo test non sa leggere');
    // Il PAT: una issue aperta col GITHUB_TOKEN non emette `issues: opened` e
    // nasce fuori dal triage; una label applicata col GITHUB_TOKEN non fa
    // partire il fixer.
    assert.match(src, /GITHUB_PAT_NANAKO/, 'lo scanner deve ricevere il PAT, non il solo GITHUB_TOKEN');
    // Le label di routing non si creano da sole.
    assert.match(src, /ensure-loop-labels\.mjs/, 'senza questo step il routing sarebbe inerte');
  });

  test('il cron non collide con gli altri di questo repo né col blocco del sito', () => {
    const dir = path.join(ROOT, '.github/workflows');
    const mine = /cron: '(\d+) \*\/\d+ \* \* \*'/.exec(fs.readFileSync(WORKFLOW, 'utf8'));
    assert.ok(mine, 'cron non leggibile');
    const myMinute = Number(mine[1]);

    const others = new Set();
    for (const f of fs.readdirSync(dir)) {
      if (f === 'generation-health-watchdog.yml' || !f.endsWith('.yml')) continue;
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/cron:\s*'([^' ]+) /g)) {
        for (const part of m[1].split(',')) if (/^\d+$/.test(part)) others.add(Number(part));
      }
    }
    assert.ok(!others.has(myMinute), `il minuto :${myMinute} è già usato da un altro workflow di questo repo`);

    // I minuti del SITO, che condivide con questo repo la stessa quota API.
    // Sono cablati qui e non letti da nessun file, perché il sito non è in
    // questo checkout: se cambiassero, questo test va aggiornato a mano — ed è
    // esattamente il momento in cui qualcuno si riaccorge del vincolo.
    for (const siteMinute of [15, 17, 20, 23]) {
      assert.notEqual(myMinute, siteMinute, `il minuto :${myMinute} collide col cron :${siteMinute} del sito: i due repo sommerebbero i picchi sulla stessa quota`);
    }
  });

  test('la finestra dei log nel workflow è QUELLA su cui le soglie sono tarate', () => {
    // Non è pedanteria: misurato sugli stessi dati, la quota di saturazione di
    // `svizzera` vale 87% su 12,6h, 63% su 16,6h e 47% su 21,1h. Con una
    // finestra più lunga la condizione tace su una sezione effettivamente
    // satura — verificato in dry-run contro il repo vivo il 2026-08-10. La
    // finestra e la soglia sono UN parametro solo, e questo test lega le due
    // metà che vivono in file diversi.
    const src = fs.readFileSync(WORKFLOW, 'utf8');
    const m = /--run-lookback-hours \$\{\{ github\.event\.inputs\.run_lookback_hours \|\| '(\d+)' \}\}/.exec(src);
    assert.ok(m, 'il workflow non passa --run-lookback-hours con un default leggibile');
    assert.equal(
      Number(m[1]),
      RUN_LOOKBACK_HOURS_DEFAULT,
      'il default del workflow e quello dello scanner divergono: le soglie sono tarate su una finestra sola',
    );
    assert.equal(RUN_LOOKBACK_HOURS_DEFAULT, 12, 'la taratura di SATURATION_RATE/TOTAL_REJECTION_RATE è su 12h');
  });

  test('il comando di ri-misura nel corpo della issue è ESEGUIBILE sul corpus vero', () => {
    // Il corpo di `duplicate-topic-burst` promette un comando che rilegge il
    // corpus e riconta le coppie per finestra. Quel comando usa
    // `collectCorpus(...).articles` — un campo che all'inizio NON esisteva: la
    // stessa promessa non mantenuta di un commento che cita un workflow
    // inesistente (#45), solo in una riga di bash. Qui si esegue la catena vera.
    const c = collectCorpus(ROOT);
    assert.equal(c.available, true, 'il corpus del checkout non si legge: il comando di ri-misura non funzionerebbe');
    assert.ok(Array.isArray(c.articles), 'collectCorpus non espone `articles`, che il comando di ri-misura usa');
    assert.ok(c.articles.length > 3000, `corpus sospettosamente piccolo: ${c.articles.length}`);
    for (const a of c.articles.slice(0, 5)) {
      assert.equal(typeof a.id, 'string');
      assert.equal(typeof a.title, 'string');
    }
    // E il conteggio per finestra deve essere MONOTONO non decrescente: è la
    // proprietà che rende leggibile la tabella di taratura nel corpo.
    const counts = [15, 30, 60, 120, 180, 360].map(
      (w) => findDuplicateTopicPairs(c.articles, { pairWindowMinutes: w, lookbackHours: 24 * 365 * 10 }).length,
    );
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i] >= counts[i - 1], `finestra più larga, meno coppie: ${counts.join(', ')}`);
    }
    assert.ok(counts[counts.length - 1] > 0, 'zero coppie su tutto lo storico: la chiave non sta agganciando niente');
  });

  test('lo scanner è registrato nel loop-sync-manifest', () => {
    // `scripts/ci` è un albero CENSITO: un file senza voce di manifest è la
    // forma in cui «nessuno ha guardato» resta invisibile (issue #97).
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
    const entry = manifest.files.find((f) => f.path === 'scripts/ci/scan-generation-health.mjs');
    assert.ok(entry, 'scan-generation-health.mjs non è nel manifest');
    assert.equal(entry.mode, 'corpus-only');
  });
});

describe('le costanti di soglia restano quelle misurate', () => {
  test('ogni soglia sta dal lato giusto della misura che l\'ha scelta', () => {
    // Un ratchet, non una tautologia: se qualcuno abbassa una soglia senza
    // rimisurare, questo test dice quale misura sta contraddicendo.
    assert.ok(IDLE_HOURS >= 6, 'p99 globale misurato = 5,20h');
    assert.ok(SECTION_DRY_HOURS >= 8, 'p95 svizzera misurato = 7,45h');
    assert.ok(SECTION_DRY_PEER_MIN >= 2, 'con 1 solo articolo dell\'altra sezione la congiunzione non prova che la pipeline è viva');
    assert.ok(SATURATION_RATE >= 0.65 && SATURATION_RATE <= 0.9, 'ultima quota "sana" osservata su svizzera = 64%; prima quota "a secco" = 84%');
    assert.ok(SATURATION_MIN_RUNS >= 10, 'sotto 10 run la quota è rumore');
    assert.ok(TOTAL_REJECTION_RATE >= 0.6 && TOTAL_REJECTION_RATE <= 0.78, 'minimo osservato sul lato rotto = 78%, massimo sul lato sano = 0%');
    assert.ok(TOTAL_REJECTION_MIN_GATE_RUNS >= 3, 'il gate gira ~0,38 volte l\'ora per sezione');
    assert.ok(OVERSIZE_MIN_MODELS >= 5, 'le run sane ne saltavano 1-2');
    // Rimisurato dopo #184: le 11 coppie uscite dopo il gate #120 distano al
    // massimo 132 minuti (ronago), e fra 180 e 360 minuti il conteggio non si
    // muove (11 -> 11, e 72 -> 72 sul totale storico): la soglia sta all'inizio
    // di un plateau, non su un fianco.
    assert.ok(PAIR_WINDOW_MINUTES >= 132, 'la coppia post-gate piu larga misurata e a 132 minuti (comune-guide:ronago)');
    assert.ok(PAIR_WINDOW_MINUTES <= 360, 'oltre il plateau si comincerebbe a marcare aggiornamenti legittimi');
  });
});
