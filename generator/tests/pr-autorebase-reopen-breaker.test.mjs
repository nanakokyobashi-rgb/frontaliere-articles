/**
 * pr-autorebase-reopen-breaker.test.mjs — precondizione + circuit breaker sul
 * close+reopen di `pr-autorebase`.
 *
 * Gemello di `tests/pr-autorebase-reopen-breaker.test.ts` sul sito
 * (valerielinc-ops/frontaliere-si-o-no#5914), riscritto per `node --test`
 * perche' qui non c'e' vitest. I corpi dei casi restano quasi byte-identici
 * all'originale grazie a `lib/expect-shim.mjs`, cosi' un aggiornamento della
 * suite sul sito si riporta qui come copia + l'intestazione. Lo SCRIPT
 * (`scripts/ci/pr-autorebase.mjs`) e la LIBRERIA (`scripts/ci/lib/reopen-breaker.mjs`)
 * sono `mode: identical` nel manifest e restano byte-identici; il test no, ed
 * e' giusto cosi': e' il runner a differire, non il comportamento sotto test.
 *
 * ## Perche' questo test vive QUI e non solo sul sito
 *
 * `pr-autorebase.mjs` gira su ENTRAMBI i repo, e qui la coda di CI e' la stessa
 * di ogni articolo pubblicato: un loop di close+reopen la affama esattamente
 * come sul sito. Ma il manifest sorveglia i file uno per uno e non vede
 * l'ASSENZA di un test da questo lato — e' il punto cieco gia' pagato con
 * `pr-collision-detector` (issue #40 punto 1, PR #44). Senza questo file, una
 * ri-sincronizzazione dal sito potrebbe riportare indietro la guardia senza
 * che niente qui lo veda: `node --test` e' l'unico guard locale che lo vedrebbe.
 *
 * ## Il difetto che fissa (misurato sul sito, 2026-08-14/15)
 *
 * `reopenToRetrigger` chiude e riapre la PR ~2s dopo perche' l'evento
 * `reopened` fa ripartire pr-review-loop e tests. Con il check richiesto in
 * FAILURE per un motivo suo, pr-review-loop non parte (gira solo su `tests`
 * success) -> nessuna review -> nessun LGTM -> `!lgtm` resta vero -> il tick
 * dopo riapre di nuovo. Misurato in ~8h:
 *   #5896  12 riaperture, 89 run di CI (23 di `tests`)
 *   #5906  10 riaperture, 77 run di CI (19 di `tests`)
 * cioe' 166 run su 300 di TUTTO il repo — 55% della CI consumata da due PR che
 * per costruzione non potevano mergiare, su una coda serializzata.
 *
 * Le tre invarianti della fix, piu' le due che la rendono qualcosa di diverso
 * da una guardia che esiste e non guarda.
 */
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from './lib/expect-shim.mjs';
import {
  decideReopen,
  decideNeedsHumanPass,
  reopenFingerprint,
  parseReopenBudget,
  renderReopenBudget,
  DEFAULT_MAX_REOPENS,
} from '../../scripts/ci/lib/reopen-breaker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = readFileSync(path.join(ROOT, 'scripts/ci/pr-autorebase.mjs'), 'utf8');

/** Stato di una PR ferma e VERDE (il caso in cui il riciclo ha senso). */
const green = {
  additions: 40, deletions: 3, changedFiles: 2,
  vitestConclusion: 'success', reviewCount: 0,
};

describe('precondizione: non riciclare cio che il riciclo non puo riparare', () => {
  it('check richiesto in FAILURE -> NON si ricicla, mai', () => {
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    const d = decideReopen({ vitestConclusion: 'failure', fingerprint: fp, prior: null });
    expect(d.action).toBe('skip-failing-check');
  });

  it('e non si ricicla nemmeno al primo giro, con contatore vergine', () => {
    // La precondizione deve battere il budget: se valesse solo DOPO N giri,
    // ogni PR rossa pagherebbe comunque N suite intere prima di fermarsi.
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    for (const prior of [null, { count: 0, fingerprint: fp }]) {
      expect(decideReopen({ vitestConclusion: 'failure', fingerprint: fp, prior }).action)
        .toBe('skip-failing-check');
    }
  });

  it('una CANCELLAZIONE da concurrency NON e un failure: la PR resta riciclabile', () => {
    // Il chiamante normalizza il verdetto transient. Se lo trattassimo come
    // rosso bloccheremmo PR sane — l'errore opposto, e altrettanto caro.
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'transient' });
    expect(decideReopen({ vitestConclusion: 'transient', fingerprint: fp, prior: null }).action)
      .toBe('reopen');
  });
});

describe('breaker: una PR verde e ferma si ricicla, ma non piu di N volte', () => {
  it(`si ferma dopo ${DEFAULT_MAX_REOPENS} riaperture sullo stesso stato`, () => {
    const fp = reopenFingerprint(green);
    let prior = null;
    const actions = [];
    // 8 tick sullo STESSO stato: il loop reale girava ~ogni 30-60 minuti.
    for (let tick = 0; tick < 8; tick++) {
      const d = decideReopen({ vitestConclusion: 'success', fingerprint: fp, prior });
      actions.push(d.action);
      prior = { count: d.count, fingerprint: fp };
    }
    expect(actions.filter((a) => a === 'reopen')).toHaveLength(DEFAULT_MAX_REOPENS);
    // Tutto cio' che segue e' definitivamente fermo: nessun risveglio spontaneo.
    expect(actions.slice(DEFAULT_MAX_REOPENS).every((a) => a === 'skip-breaker')).toBe(true);
  });

  it('il tetto e configurabile e viene rispettato', () => {
    const fp = reopenFingerprint(green);
    let prior = null;
    let reopens = 0;
    for (let tick = 0; tick < 10; tick++) {
      const d = decideReopen({ vitestConclusion: 'success', fingerprint: fp, prior, max: 2 });
      if (d.action === 'reopen') reopens++;
      prior = { count: d.count, fingerprint: fp };
    }
    expect(reopens).toBe(2);
  });
});

describe('il contatore si azzera quando lo stato cambia DAVVERO', () => {
  it('un commit nuovo rimette la PR in gioco', () => {
    const before = reopenFingerprint(green);
    const exhausted = { count: DEFAULT_MAX_REOPENS, fingerprint: before };
    expect(decideReopen({ vitestConclusion: 'success', fingerprint: before, prior: exhausted }).action)
      .toBe('skip-breaker');
    // Nuovo lavoro: il contributo proprio della PR cambia.
    const after = reopenFingerprint({ ...green, additions: 57, changedFiles: 3 });
    const d = decideReopen({ vitestConclusion: 'success', fingerprint: after, prior: exhausted });
    expect(d.action).toBe('reopen');
    expect(d.count).toBe(1); // riparte da zero, non da max
  });

  it('un check tornato verde, o una review arrivata, azzerano allo stesso modo', () => {
    const stuck = reopenFingerprint({ ...green, vitestConclusion: 'transient' });
    const exhausted = { count: DEFAULT_MAX_REOPENS, fingerprint: stuck };
    for (const changed of [
      reopenFingerprint({ ...green, vitestConclusion: 'success' }),
      reopenFingerprint({ ...green, vitestConclusion: 'transient', reviewCount: 1 }),
    ]) {
      const d = decideReopen({ vitestConclusion: 'success', fingerprint: changed, prior: exhausted });
      expect(d.action).toBe('reopen');
      expect(d.count).toBe(1);
    }
  });

  it('REGRESSIONE: un merge di solo main NON azzera il contatore', () => {
    // LA trappola di questa fix. pr-autorebase pusha un merge commit di
    // `origin/main` sul branch a ogni tick, subito PRIMA di chiamare il reopen.
    // Se l'impronta dipendesse dall'head OID (o dal conteggio dei commit)
    // cambierebbe SEMPRE, il contatore ripartirebbe da 1 a ogni giro e il
    // breaker non scatterebbe MAI: guardia presente, loop intatto.
    // GitHub calcola additions/deletions/changedFiles contro la merge-base,
    // quindi un merge di solo main li lascia invariati: stessa impronta.
    const beforeMerge = reopenFingerprint(green);
    const afterMainMerge = reopenFingerprint({ ...green }); // contributo proprio invariato
    expect(afterMainMerge).toBe(beforeMerge);

    let prior = null;
    let reopens = 0;
    for (let tick = 0; tick < 8; tick++) {
      const d = decideReopen({
        vitestConclusion: 'success', fingerprint: reopenFingerprint({ ...green }), prior,
      });
      if (d.action === 'reopen') reopens++;
      prior = { count: d.count, fingerprint: reopenFingerprint({ ...green }) };
    }
    expect(reopens).toBe(DEFAULT_MAX_REOPENS); // NON 8
  });
});

describe('il contatore sopravvive al close+reopen', () => {
  it('round-trip render -> parse: count e impronta si rileggono identici', () => {
    // Vive in un commento sticky sulla PR, non in una variabile di job: lo
    // script e' stateless fra un run e l'altro, e un contatore in RAM muore a
    // ogni tick. Un commento sopravvive al close+reopen come una label, e a
    // differenza di una label porta un intero E l'impronta a cui si riferisce.
    const fp = reopenFingerprint(green);
    const body = renderReopenBudget({
      count: 2, max: DEFAULT_MAX_REOPENS, fingerprint: fp, action: 'reopen', reason: 'x',
    });
    expect(parseReopenBudget(body)).toEqual({ count: 2, fingerprint: fp });
  });

  it('uno stato illeggibile non blocca la PR (fail-open)', () => {
    expect(parseReopenBudget('')).toBe(null);
    expect(parseReopenBudget('nessun marker qui')).toBe(null);
    expect(parseReopenBudget('<!-- reopen-budget-state {rotto -->')).toBe(null);
  });
});

describe('needs-human: una passata sola, non 48 al giorno', () => {
  // Fermare il close+reopen lasciava in piedi la meta' piu' cara: il ramo
  // needs-human viene DOPO `pushBranch`, quindi ogni tick del cron `*/30`
  // rebasava, pushava e lanciava la suite — 48 tick/giorno per UNA PR che
  // aspetta una persona, su una coda serializzata.
  it('stato invariato -> nessun lavoro: niente rebase, niente CI', () => {
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    const d = decideNeedsHumanPass({ fingerprint: fp, prior: { count: 0, fingerprint: fp } });
    expect(d.action).toBe('skip-idle');
  });

  it('48 tick su uno stato fermo producono ZERO passate', () => {
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    let prior = { count: 0, fingerprint: fp };
    let passes = 0;
    for (let tick = 0; tick < 48; tick++) {
      if (decideNeedsHumanPass({ fingerprint: fp, prior }).action === 'pass') passes++;
      prior = { count: 0, fingerprint: fp };
    }
    expect(passes).toBe(0);
  });

  it('stato cambiato -> UNA passata piena, poi di nuovo silenzio', () => {
    // L'intento del dispatchTests si preserva: chi arriva a guardare la PR
    // trova un risultato riferito allo stato attuale. Ma una volta, non 48.
    const stale = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    let prior = { count: 0, fingerprint: stale };
    const fresh = reopenFingerprint({ ...green, additions: 61, vitestConclusion: 'failure' });
    let passes = 0;
    for (let tick = 0; tick < 12; tick++) {
      const d = decideNeedsHumanPass({ fingerprint: fresh, prior });
      if (d.action === 'pass') passes++;
      prior = { count: 0, fingerprint: fresh }; // l'impronta si registra alla passata
    }
    expect(passes).toBe(1);
  });

  it('senza stato registrato la prima passata si fa (fail-open)', () => {
    const fp = reopenFingerprint(green);
    expect(decideNeedsHumanPass({ fingerprint: fp, prior: null }).action).toBe('pass');
  });

  it('il gate e PRIMA del rebase, non sul dispatchTests', () => {
    // Se stesse sul `dispatchTests` il costo resterebbe: il push del rebase e'
    // autenticato App/PAT e ri-triggera da se' `pull_request` (#3038), quindi
    // tests.yml — e pr-review-loop, cioe' quota Claude — partirebbero comunque.
    // `decideNeedsHumanPass(` con la parentesi: cercare il solo identificatore
    // trova l'IMPORT in cima al file, che precede qualunque cosa — il test
    // resterebbe verde anche col gate spostato dopo il push (verificato per
    // mutazione: senza la parentesi, M3b passava).
    const gate = script.indexOf('decideNeedsHumanPass({');
    const push = script.indexOf('const pushed = pushBranch(branch)');
    const dispatchOnNeedsHuman = script.indexOf("labels.includes('needs-human')", push);
    expect(gate).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(push);
    expect(gate).toBeLessThan(dispatchOnNeedsHuman);
  });
});

describe('la guardia e sul percorso, non accanto ad esso', () => {
  it('nessun call-site chiama reopenToRetrigger scavalcando il breaker', () => {
    // Senza questo, aggiungere un quarto ramo che chiama direttamente
    // `reopenToRetrigger(num)` rimette in piedi il loop con tutti i test
    // sopra ancora verdi. L'unica chiamata lecita e' quella DENTRO
    // `guardedReopen`, che e' il posto in cui la decisione e' gia' stata presa.
    const guardStart = script.indexOf('function guardedReopen');
    expect(guardStart).toBeGreaterThan(-1);
    const guardEnd = script.indexOf('\n}', script.indexOf('return reopenToRetrigger', guardStart));
    const calls = [...script.matchAll(/\breopenToRetrigger\s*\(/g)]
      .map((m) => m.index)
      // la definizione stessa non e' una chiamata
      .filter((i) => !script.slice(Math.max(0, i - 20), i).includes('function '))
      .filter((i) => i < guardStart || i > guardEnd);
    expect(calls).toHaveLength(0);
  });

  it('la segnalazione e UNA: commento sticky, non un commento nuovo a ogni giro', () => {
    const guard = script.slice(script.indexOf('function guardedReopen'),
      script.indexOf('function readReopenBudgetBody'));
    expect(guard).toContain('upsertStickyComment');
    // `gh pr comment` diretto = un commento nuovo per tick: lo stesso difetto
    // in un'altra forma.
    expect(guard).not.toMatch(/'pr',\s*'comment'/);
    // E non si riscrive nemmeno lo sticky se il body non e' cambiato.
    expect(guard).toContain('body !== next');
  });
});

describe('stuck-red: un failure PROVATO non attribuibile non blocca il reopen', () => {
  // Il rescue STUCK-RED entra nel flusso con vitest=failure PER DEFINIZIONE —
  // ma e' un failure che `vitestFailureIsNotAttributableToPr` ha appena provato
  // non essere della PR (red-main/stale), e il commento STUCK_RED dello stesso
  // run promette «rebase + ri-esecuzione dei test, una sola volta». Senza
  // l'eccezione, la precondizione negava il reopen, etichettava `needs-human`
  // e il marker one-shot restava consumato: se il push-trigger non riparte
  // (head a zero check-run, classe #1587/#1526), la PR — senza label
  // near-merge — finisce in uno stato assorbente a zero segnali, la stessa
  // classe «zero archi uscenti» che lo stuck-red esiste per chiudere.
  it('failure + failureNotAttributable -> reopen consentito, e conta nel budget', () => {
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    const d = decideReopen({
      vitestConclusion: 'failure', fingerprint: fp, prior: null,
      failureNotAttributable: 'red-main',
    });
    expect(d.action).toBe('reopen');
    expect(d.count).toBe(1); // consuma budget: nemmeno uno stuck-red si ricicla all'infinito
  });

  it('senza la prova, lo stesso failure resta bloccato (nessuna scappatoia di default)', () => {
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    for (const failureNotAttributable of [undefined, '']) {
      expect(decideReopen({
        vitestConclusion: 'failure', fingerprint: fp, prior: null, failureNotAttributable,
      }).action).toBe('skip-failing-check');
    }
  });

  it('il breaker vale anche per gli stuck-red: budget esaurito -> stop comunque', () => {
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    const exhausted = { count: DEFAULT_MAX_REOPENS, fingerprint: fp };
    expect(decideReopen({
      vitestConclusion: 'failure', fingerprint: fp, prior: exhausted,
      failureNotAttributable: 'red-main',
    }).action).toBe('skip-breaker');
  });

  it('WIRING: il call-site post-rebase passa stuckRedReason a guardedReopen', () => {
    // La decisione pura sopra non basta: senza il wiring il call-site
    // chiamerebbe `guardedReopen(num, head)` e l'eccezione non scatterebbe
    // mai — guardia presente, buco intatto, la stessa forma della guardia
    // morta trovata su M3b (identificatore giusto, punto sbagliato).
    expect(script).toContain('guardedReopen(num, head, { stuckRedReason })');
    expect(script).toMatch(/failureNotAttributable:\s*stuckRedReason/);
  });

  it('lo sticky di skip-breaker non chiede di «far passare» un vitest gia verde', () => {
    // Il breaker scatta tipicamente su PR VERDI (le rosse le ferma la
    // precondizione): il canale di escalation non deve indicare all'umano
    // un'azione gia' soddisfatta. Gli sblocchi veri: commit nuovo o review.
    const fp = reopenFingerprint(green);
    const body = renderReopenBudget({
      count: DEFAULT_MAX_REOPENS, max: DEFAULT_MAX_REOPENS, fingerprint: fp,
      action: 'skip-breaker', reason: 'x',
    });
    expect(body).toContain('un commit nuovo, o una review');
    expect(body).not.toContain('far passare');
  });
});

describe('il nome del check e quello di QUESTO repo, non quello del sito', () => {
  // `lib/constants.mjs` e' `adapted` nel manifest: qui VITEST_CHECK_NAME vale
  // `tests (node --test)`, sul sito `vitest (unit + integration)`. La libreria
  // e' `identical` e legge la costante invece di cablare la stringa: e' cosi'
  // che lo stesso file puo' scendere byte-identico e produrre comunque un
  // messaggio corretto qui. Una copia futura che inlinasse il nome del sito
  // manderebbe l'umano a cercare un check che su questo repo non esiste.
  it('lo sticky di skip-failing-check nomina il check locale', async () => {
    const { VITEST_CHECK_NAME } = await import('../../scripts/ci/lib/constants.mjs');
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    const d = decideReopen({ vitestConclusion: 'failure', fingerprint: fp, prior: null });
    expect(d.reason).toContain(VITEST_CHECK_NAME);
    expect(d.reason).not.toContain('vitest (unit + integration)');
  });
});
