/**
 * harvest-escalation-rules.test.mjs — l'osservatore che manca: una regola
 * dell'harvester che torna INERTE oggi non fa fallire niente.
 *
 * ## Il difetto che copre
 *
 * `harvest-agent-lessons.mjs` decide quali esiti `FIX_OUTCOME` possono aprire
 * un'escalation «ricorre nonostante regola». La decisione è sparsa in tre posti
 * che non si parlano: i filtri per-comment dentro `main()`, i classificatori
 * `isAvoidable*`, e la carve-out `isEscalationDriver`. Nessuno dei tre dichiara
 * l'insieme dei codici che sta trattando, quindi un codice non trattato non è
 * distinguibile da un codice trattato e ritenuto escalabile.
 *
 * Due volte questo ha prodotto un'escalation che nessuna fix poteva chiudere:
 *
 *  · **#4938** — la carve-out di `no-root-cause` «non aveva mai funzionato in
 *    produzione»: `main()` costruisce le chiavi come `fix-outcome:${code}`, ma
 *    il confronto guardava il codice nudo, una forma che esisteva SOLO nello
 *    unit test. La regola c'era, matchava nel test, ed era inerte al call site
 *    vero. È la ragione per cui ogni asserzione qui sotto su `isEscalationDriver`
 *    usa la chiave PREFISSATA: testare la forma comoda invece di quella reale è
 *    esattamente come si è prodotto quel difetto.
 *
 *  · **#229** — `fix-outcome:overlap-skip` ricorre da 9×/14gg. Misurato il
 *    2026-08-13 sui marker veri di questo repo: **11 marker su 11 contati, zero
 *    scartati**. Non è una regola che sbaglia il match: per `overlap-skip` una
 *    regola nell'harvester non esiste affatto — nessun `isAvoidableOverlapSkip`,
 *    nessuna voce in `isEscalationDriver` — mentre `followup-drainer.mjs` lo
 *    classifica già «transiente» nel proprio `NON_RETRYABLE` e la pre-flight
 *    #3810 esiste apposta per prevenirlo. I due lati del ciclo non sono
 *    d'accordo, e niente lo dice.
 *
 * ## Perché il rimedio qui è una DICHIARAZIONE e non una regex in più
 *
 * `HARVESTER_DECISION` elenca, codice per codice, cosa l'harvester ne fa OGGI.
 * Il vocabolario contro cui viene confrontato non è scritto a mano: è derivato
 * dal repo (`ISSUES.md` + ogni marker letterale emesso sotto `scripts/ci/`,
 * `scripts/lib/`, `.github/workflows/`). Da qui i due errori che diventano
 * rossi, che sono i due che sono accaduti davvero:
 *
 *   · un codice NUOVO entra nel ciclo senza che nessuno decida come trattarlo
 *     (è così che `overlap-skip` è arrivato a escalare);
 *   · una regola esistente smette di avere effetto, e un codice scivola da
 *     `carved-out`/`filtered` a `escalatable` senza che nessuno lo noti.
 *
 * `HARVESTER_DECISION` sta QUI e non in un JSON di dati, per la stessa ragione
 * per cui `REQUIRED_ROOTS` sta dentro `loop-sync-manifest-scope.test.mjs`: un
 * guard i cui confini vivono nel dato che sorveglia si disarma cancellando una
 * riga di dato. Cambiarlo qui è una modifica al codice del guard, e in review
 * si vede.
 *
 * ## Dove gira
 *
 * `npm test` del corpus (`node --test generator/tests/*.test.mjs`), quindi
 * dentro `tests.yml` — che ha `branches-ignore: [main]`: **gira sulle PR, NON
 * sui push a `main`**.
 *
 * ## Cosa questo file NON fa
 *
 * Non ripara `overlap-skip`. `scripts/ci/harvest-agent-lessons.mjs` è
 * `mode: identical` nel `loop-sync-manifest.json`: la fix va fatta sul sito e
 * scende col mirror. Qui `overlap-skip` è dichiarato `escalatable` perché è ciò
 * che l'harvester fa oggi — e quando la fix del sito atterrerà, questo test
 * diventerà rosso e costringerà ad aggiornare la dichiarazione. È il
 * comportamento voluto: la mappa è un contratto sullo stato reale, non
 * un'approvazione.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAvoidableMaxTurns,
  isAvoidableAlreadyFixed,
  isAvoidableNoRootCause,
  isEscalationDriver,
} from '../../scripts/ci/harvest-agent-lessons.mjs';
import {
  classifyMaxTurnsRun,
  hasRecoverableWork,
  branchNameForIssue,
  fixOutcomeCode,
  selectRecoverableWork,
} from '../../scripts/ci/orphan-max-turns-work.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Cosa l'harvester fa OGGI di ogni codice. Quattro verdetti:
 *
 *   `healthy`      il percorso sano, scartato per primo (`pr-created`).
 *   `filtered`     ha un classificatore `isAvoidable*` che ne scarta una parte.
 *   `carved-out`   `isEscalationDriver` lo esclude: può contare come volume, mai
 *                  guidare una proposta di regole.
 *   `escalatable`  nessun filtro: ogni marker conta, e sopra soglia×fattore apre
 *                  un'escalation.
 */
const HARVESTER_DECISION = Object.freeze({
  // Il percorso sano: `main()` lo scarta prima di ogni altra cosa.
  'pr-created': 'healthy',
  // `isAvoidableAlreadyFixed`: scarta gli aggregati e i non-follow-up, dove la
  // pre-flight zero-Claude non poteva short-circuitare (root cause #2290).
  'already-fixed': 'filtered',
  // `isAvoidableMaxTurns`: scarta consegnato / `needs-human` / aggregato
  // (#2439, #2653) e, dal trasporto di #303, anche chi ha lasciato LAVORO
  // RECUPERABILE sul branch — commit su `fix/issue-<N>` avanti a `main` dal
  // checkpoint WIP di issue-fix.yml (#4337). Misurato sul corpus su 31 morti
  // `max-turns`: consegnate 0, recuperabili 11, vuote 20; due delle undici sono
  // state riaperte a mano e mergiate (sito #5767 → PR #5774, qui #166 → PR
  // #293). La firma accetta ora sia il booleano legacy sia
  // `{hasDeliveredPr, hasRecoverableBranch}`.
  'max-turns': 'filtered',
  // Carve-out #4750: la diagnosi è prosa LLM, spazio d'input illimitato; una
  // riga di doc non può prevenire quante parafrasi esistono di «era transitorio».
  'no-root-cause': 'carved-out',
  // Carve-out 2026-08-05: condizione ambientale (quota Max condivisa esaurita),
  // non una regola che un agent ha violato.
  'rate-limited': 'carved-out',
  // Carve-out #5288, sceso col riallineamento #234. Mode 2 di
  // `check-workflows-scope.mjs` emetteva lo stesso marker di Mode 1
  // (`blocked-workflows-scope`), che pero' significa l'opposto: Mode 1 e' una
  // capability MANCATA, Mode 2 e' la guardia che RIESCE e salta una diagnosi gia'
  // pagata su una issue di pari titolo, a costo zero. Contarli insieme faceva
  // alzare a una guardia funzionante proprio il bucket la cui ricorrenza apre
  // l'escalation — il fix che funziona rifaceva scattare l'allarme. Ora Mode 2 ha
  // un codice suo, escluso da `isEscalationDriver` (uno skip deterministico
  // zero-Claude non e' una regola violata) ma tenuto in `NON_RETRYABLE` del
  // drainer, perche' il verdetto e' deterministico e ri-accodarlo lo riprodurrebbe.
  'skip-duplicate-diagnosis': 'carved-out',
  // Carve-out #229, scesa col trasporto di #303 (era: `escalatable`, con 11
  // marker su 11 contati nella finestra 14gg al 2026-08-13, tutti aborti
  // CORRETTI del fixer davanti a una PR aperta sugli stessi file). I due codici
  // sono quelli che `followup-drainer.mjs` dichiara TRANSITORI — li tiene fuori
  // da `NON_RETRYABLE` apposta, «l'overlap e' transitorio (la PR bloccante puo'
  // mergiare → ri-tentabile)», e `close-recovered-structural-hold.mjs` si
  // rifiuta di trattenerli («scheduling, not a fault»). Un'escalation su questo
  // bucket chiederebbe una regola di prosa contro il fatto che due issue
  // indipendenti nominino lo stesso file insieme: nessuna riga di doc la
  // previene. Restano CONTATI come volume nel summary, come `rate-limited`.
  // Il rimedio strutturale e' la pre-flight zero-Claude (#3810), la cui meta'
  // corpus era INERTE — `CODE_PATH_RE` matchava dalla directory e mai dal path
  // completo — ed e' scesa nello stesso giro (`scripts/lib/workflow-scope-detect.mjs`,
  // `CODE_DIRS` + `repoRelativeTail`).
  // L'UNICO caso che resta contabile lo tiene `isAvoidableOverlapSkip`: la issue
  // porta anche un marker `pr-created`, cioe' il fixer e' stato ri-promosso su
  // una issue che la PR ce l'aveva gia' — quello e' un buco del gate `hasFixPR`.
  'overlap-skip': 'carved-out',
  'pr-already-open': 'carved-out',
  // Ha già escalato e la sua escalation (#228) è stata chiusa.
  'blocked-workflows-scope': 'escalatable',
  'blocked-secrets': 'escalatable',
  'blocked-admin-settings': 'escalatable',
  'revenue-tracker-manual': 'escalatable',
});

/** I codici `FIX_OUTCOME` vivi nel repo: contratto dichiarato + marker emessi. */
function liveOutcomeVocabulary() {
  const codes = new Set();
  const issuesMd = fs.readFileSync(path.join(ROOT, 'ISSUES.md'), 'utf8');
  const declared = /`<code>`\s*∈([\s\S]*?)\.\n/.exec(issuesMd);
  assert.ok(declared, 'ISSUES.md non dichiara più l\'insieme dei codici FIX_OUTCOME');
  for (const m of declared[1].matchAll(/`([a-z0-9-]+)`/g)) codes.add(m[1]);
  for (const dir of ['scripts/ci', 'scripts/lib', '.github/workflows']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      const p = path.join(abs, name);
      if (!fs.statSync(p).isFile()) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/g)) {
        codes.add(m[1]);
      }
    }
  }
  return codes;
}

test('vocabolario: ogni codice FIX_OUTCOME vivo ha una decisione dichiarata', () => {
  const live = liveOutcomeVocabulary();
  const declared = new Set(Object.keys(HARVESTER_DECISION));
  const undecided = [...live].filter((c) => !declared.has(c)).sort();
  assert.deepEqual(
    undecided,
    [],
    `${undecided.length} codici FIX_OUTCOME entrano nel ciclo senza che l'harvester dichiari\n` +
      'cosa ne fa. È esattamente così che `overlap-skip` (#229) è arrivato a escalare senza\n' +
      'che nessuna regola lo trattasse. Ognuno va classificato in HARVESTER_DECISION:\n' +
      `  ${undecided.join('\n  ')}`,
  );
});

test('vocabolario: nessuna decisione resta dichiarata per un codice sparito', () => {
  const live = liveOutcomeVocabulary();
  const stale = Object.keys(HARVESTER_DECISION).filter((c) => !live.has(c)).sort();
  assert.deepEqual(
    stale,
    [],
    'Dichiarazioni stale: questi codici non sono più emessi né dichiarati da nessuna parte ' +
      'nel repo. Una riga che descrive un mondo che non esiste più insegna a leggere questa ' +
      `mappa come approssimativa:\n  ${stale.join('\n  ')}`,
  );
});

test('carve-out: inerte se non regge la chiave PREFISSATA del call site (#4938)', () => {
  // `main()` costruisce `fix-outcome:${code}`. Questa è la forma vera; il codice
  // nudo esisteva solo nel test, ed è per questo che la carve-out è rimasta
  // inerte in produzione finché nessuno se n'è accorto.
  for (const [code, decision] of Object.entries(HARVESTER_DECISION)) {
    if (decision !== 'carved-out') continue;
    assert.equal(
      isEscalationDriver('fix-outcome', `fix-outcome:${code}`), false,
      `\`${code}\` è dichiarato carved-out ma isEscalationDriver lo lascia guidare ` +
        'un\'escalation alla chiave prefissata: la carve-out è INERTE (difetto #4938).',
    );
    // La forma nuda deve restare coperta: entrambi i chiamanti sono legittimi.
    assert.equal(isEscalationDriver('fix-outcome', code), false, `\`${code}\`: carve-out persa sulla chiave nuda`);
  }
});

test('carve-out: chi non è carved-out guida davvero l\'escalation', () => {
  // L'errore opposto, e quello che conta di più: una carve-out troppo larga
  // spegne in silenzio il segnale che l'harvester esiste per produrre.
  for (const [code, decision] of Object.entries(HARVESTER_DECISION)) {
    if (decision === 'carved-out') continue;
    assert.equal(
      isEscalationDriver('fix-outcome', `fix-outcome:${code}`), true,
      `\`${code}\` è dichiarato \`${decision}\` ma isEscalationDriver lo esclude: una carve-out ` +
        'si è allargata e sopprime un segnale reale.',
    );
  }
  // `issue-class` resta escluso in blocco: volume operativo, non segnale d'istruzione.
  assert.equal(isEscalationDriver('issue-class', 'issue:crawler-failure'), false);
});

test('isAvoidableMaxTurns non è inerte: scarta consegnato, parcheggiato, aggregato', () => {
  assert.equal(isAvoidableMaxTurns('follow-up(#1): una cosa sola', [], true), false,
    'una run che ha CONSEGNATO una PR non è burn evitabile (#2653)');
  assert.equal(isAvoidableMaxTurns('follow-up(#1): una cosa sola', ['needs-human'], false), false,
    'una issue già parcheggiata dal drainer muore in modo atteso (#2439)');
  assert.equal(isAvoidableMaxTurns('follow-up(#1): 5 items deferred', [], false), false,
    'un aggregato multi-item sfonda il budget per costruzione');
  assert.equal(isAvoidableMaxTurns('sweep dei redirect', [], false), false,
    'sweep/batch/bulk: aggregato per parola chiave');
});

test('isAvoidableMaxTurns non è troppo larga: il caso singolo resta contato', () => {
  assert.equal(isAvoidableMaxTurns('follow-up(#1): 1 item deferred', [], false), true,
    'un follow-up a UN item è il bersaglio vero del gate, non rumore');
  assert.equal(isAvoidableMaxTurns('Il guard di scrittura strippa in silenzio', [], false), true);
});

test('isAvoidableAlreadyFixed non è inerte in nessuna delle due direzioni', () => {
  const FU = ['follow-up'];
  assert.equal(isAvoidableAlreadyFixed('follow-up(#9): 3 items deferred', FU), false,
    'un aggregato è la conferma attesa, non burn prevenibile (#2290)');
  assert.equal(isAvoidableAlreadyFixed('follow-up(#9): una cosa sola', []), false,
    'senza la label `follow-up` la issue è fuori dallo scope della pre-flight');
  assert.equal(isAvoidableAlreadyFixed('follow-up(#9): una cosa sola', FU), true,
    'il follow-up a un solo item è il bersaglio vero del gate');
});

test('isAvoidableNoRootCause non è inerte in nessuna delle due direzioni', () => {
  assert.equal(
    isAvoidableNoRootCause('Verificato live, nessuna root cause di codice: era un self-heal.'), false,
    'un non-bug verificato live non è un fallimento di diagnosi (#4580)');
  assert.equal(
    isAvoidableNoRootCause('Il fix dipende esplicitamente dalla sub-issue #12, non ancora chiusa.'), false,
    'un blocco di dipendenza non è un fallimento di diagnosi');
  assert.equal(
    isAvoidableNoRootCause('Esplorato il modulo per quindici turni, la causa non emerge.'), true,
    'il vero «non riesco a diagnosticare» deve restare contato');
});

// ── La metà mancante di `max-turns`: il lavoro lasciato indietro ─────────────

test('max-turns: un branch avanti a main senza PR è lavoro RECUPERABILE, non rumore', () => {
  // Misurato il 2026-08-13: dieci branch `fix/issue-N` avanti a `main`, zero PR
  // mai aperte. Oggi l'harvester non ha modo di distinguerli da una run morta a
  // mani vuote, perché la sua unica prova di consegna è il marker `pr-created`.
  assert.equal(classifyMaxTurnsRun({ hasDeliveredPr: false, branch: { aheadBy: 1, prNumbers: [] } }),
    'recoverable');
  assert.equal(hasRecoverableWork({ hasDeliveredPr: false, branch: { aheadBy: 2, prNumbers: [] } }), true);
});

test('max-turns: senza prova di un commit non si inventa lavoro da recuperare', () => {
  assert.equal(classifyMaxTurnsRun({ hasDeliveredPr: false, branch: null }), 'empty');
  assert.equal(classifyMaxTurnsRun({ hasDeliveredPr: false, branch: { aheadBy: 0, prNumbers: [] } }), 'empty');
  assert.equal(classifyMaxTurnsRun({}), 'empty');
  assert.equal(classifyMaxTurnsRun({ hasDeliveredPr: false, branch: undefined }), 'empty',
    'un errore di rete non deve diventare un falso recupero');
});

test('max-turns: se il lavoro è già in una PR, il ciclo lo gestisce da solo', () => {
  assert.equal(classifyMaxTurnsRun({ hasDeliveredPr: true, branch: { aheadBy: 3, prNumbers: [] } }),
    'delivered');
  assert.equal(classifyMaxTurnsRun({ hasDeliveredPr: false, branch: { aheadBy: 3, prNumbers: [77] } }),
    'delivered', 'una PR sul branch è consegna anche senza il marker `pr-created`');
});

test('selectRecoverableWork guarda solo i max-turns, e solo quelli orfani', () => {
  const issues = [
    { number: 148, outcomes: ['max-turns'] },                 // branch avanti, nessuna PR
    { number: 189, outcomes: ['max-turns'] },                 // nessun branch
    { number: 200, outcomes: ['max-turns', 'pr-created'] },   // consegnata
    { number: 300, outcomes: ['overlap-skip'] },              // altro esito
  ];
  const branches = new Map([
    [148, { aheadBy: 1, prNumbers: [] }],
    [189, null],
    [200, { aheadBy: 4, prNumbers: [] }],
    [300, { aheadBy: 9, prNumbers: [] }],
  ]);
  assert.deepEqual(selectRecoverableWork(issues, branches),
    [{ issue: 148, branch: 'fix/issue-148', aheadBy: 1 }]);
});

test('helper: nome del branch e lettura del marker', () => {
  assert.equal(branchNameForIssue(148), 'fix/issue-148');
  assert.equal(fixOutcomeCode('testo\n<!-- FIX_OUTCOME: max-turns -->\naltro'), 'max-turns');
  assert.equal(fixOutcomeCode('<!-- FIX_OUTCOME: OVERLAP-SKIP -->'), 'overlap-skip');
  assert.equal(fixOutcomeCode('nessun marker'), null);
});
