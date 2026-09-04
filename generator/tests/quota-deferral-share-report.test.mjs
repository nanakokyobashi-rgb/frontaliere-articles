/**
 * ── IL PARSER MUORE DI VOCABOLARIO, NON DI ARITMETICA (issue #804) ──────────
 *
 * `scripts/ci/quota-deferral-share-report.mjs` misura sui log lo share
 * transient/total su cui `isLegitimateQuotaDeferral` decide se una run senza
 * articolo esce verde (differimento) o rossa (Workflow-Failure). Il tally e il
 * quoziente NON sono scritti nello script — arrivano da `classifyExhaustionCause`
 * e `quotaDeferralShare`, che sono gia' coperti altrove. Cio' che questo file
 * blocca e' l'unica cosa che lo script dichiara da solo: LA FORMA DEL TESTO che
 * legge.
 *
 * Perche' proprio quella. Le due frasi di skip da cooldown di provider sono
 * cambiate una volta gia': prima di #767 un host morto lasciava `cooling down
 * (rate-limited)` (vocabolario transitorio) e GONFIAVA lo share, da #767 scrive
 * `unreachable (…), non-retryable` e lo SGONFIA. La polarita' si e' invertita
 * senza che una sola riga di test si accorgesse di niente, ed e' esattamente
 * cio' che rende fragile una misura fatta sui log: un parser che non trova piu'
 * la sua frase non fallisce, restituisce ZERO — e uno zero e' indistinguibile
 * da «nessuna cascata esaurita», cioe' da una buona notizia.
 *
 * Quindi le fixture qui sotto contengono ENTRAMBE le frasi, mescolate, e i
 * numeri attesi sono contati a mano riga per riga.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CASCADE_RE,
  PROMPT_BUDGET_TAIL_RE,
  parseCascades,
  cascadeToError,
  analyseCascade,
  summariseRun,
  formatCascadeLine,
  formatRunLine,
} from '../../scripts/ci/quota-deferral-share-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', '..', 'scripts', 'ci', 'quota-deferral-share-report.mjs');

/** Il prefisso che `gh run view --log` antepone a ogni riga: job, step, timestamp. */
const GH = 'generate\tGenerate the article\t2026-09-04T03:11:07.4180000Z ';

const cascade = (errors, tail = '') =>
  `All AI models failed. Chain: [${errors.length} models]. Errors: ${errors.join(' | ')}${tail}`;

/**
 * La notte con l'host GitHub giu': gli echi votano PERSISTENTE (#767), quindi
 * toglierli ALZA lo share. Contati a mano: 3 transitori, 4 persistenti (tutti
 * echi), 1 ambiguo — `fetch failed` non matcha nessuna delle due regex.
 */
const HOST_DOWN = [
  'openrouter/a: skipped — exhausted (daily limit / consecutive 429s)',
  'openrouter/b: skipped — exhausted (daily limit / consecutive 429s)',
  'openrouter/c: skipped — exhausted (daily limit / consecutive 429s)',
  'github/gpt-1: skipped — provider github unreachable (ENOTFOUND), non-retryable',
  'github/gpt-2: skipped — provider github unreachable (ENOTFOUND), non-retryable',
  'github/gpt-3: skipped — provider github unreachable (ENOTFOUND), non-retryable',
  'github/gpt-4: skipped — provider github unreachable (ENOTFOUND), non-retryable',
  'github/gpt-0: fetch failed',
];

/**
 * La notte di 429: gli echi votano TRANSITORIO (vocabolario pre-#767, che
 * `cooldownProvider` emette ancora per il rate-limit), quindi toglierli
 * ABBASSA lo share. 3 transitori (2 echi + 1 quota vera), 3 persistenti.
 */
const RATE_LIMITED = [
  'openrouter/a: skipped — provider openrouter cooling down (rate-limited)',
  'openrouter/b: skipped — provider openrouter cooling down (rate-limited)',
  'gemini/flash: skipped — exhausted (daily limit / consecutive 429s)',
  'x/one: skipped — no API key',
  'x/two: skipped — no API key',
  'x/three: skipped — no API key',
];

describe('quota-deferral-share-report — la forma del testo che legge', () => {
  test('riconosce il messaggio aggregato di callLLM, e solo quello', () => {
    const ok = CASCADE_RE.exec(cascade(['a: daily limit', 'b: no API key']));
    assert.ok(ok, 'il messaggio nella forma di callLLM deve combaciare');
    assert.equal(ok[1], 'a: daily limit | b: no API key');
    // Una riga qualunque che elenchi errori NON e' una cascata: raccoglierla
    // produrrebbe uno share sbagliato, che e' peggio di nessuno share.
    assert.equal(CASCADE_RE.exec('Errors: a: daily limit | b: no API key'), null);
    assert.equal(CASCADE_RE.exec('All AI models failed. Errors: a: daily limit'), null);
  });

  test('la coda «Prompt budget» esce dal conteggio, e lascia il numero di rifiuti', () => {
    const tail = ' | Prompt budget: 2 model(s) refused a ~9740-token request;'
      + ' the most permissive cap among them is 8000 tokens (over by ~1740).'
      + ' A retry must rebuild the prompt under 8000 tokens — resending the same messages cannot succeed.';
    const m = PROMPT_BUDGET_TAIL_RE.exec(tail);
    assert.ok(m);
    assert.equal(Number(m[1]), 2);
  });

  test('una riga «All AI models failed» che non combacia e\' un DIFETTO, non uno zero', () => {
    // Il modo esatto in cui questa misura muore in silenzio: il messaggio viene
    // riformulato, il parser non trova piu' niente ed esce 0 — indistinguibile
    // da una run sana. Deve restare visibile.
    const parsed = parseCascades(`${GH}All AI models failed. Roster: []. Reasons: a: daily limit`);
    assert.equal(parsed.cascades.length, 0);
    assert.equal(parsed.unrecognised, 1);
    assert.match(formatRunLine('x', parsed, summariseRun([])), /NON riconosciute/);
  });

  test('sopravvive al prefisso di `gh run view --log` e alle sequenze ANSI', () => {
    const line = `${GH}[33m${cascade(HOST_DOWN)}[0m\r`;
    const parsed = parseCascades(line);
    assert.equal(parsed.cascades.length, 1);
    assert.equal(parsed.cascades[0].errors.length, 8, 'gli 8 motivi, nessuno perso nell\'ANSI');
    assert.equal(parsed.cascades[0].errors[7], 'github/gpt-0: fetch failed');
  });

  test('lo stesso errore ristampato non e\' una seconda cascata', () => {
    // Il catch di primo livello riemette `e.message` dentro la riga «Differito»
    // e il report di run lo ricopia nelle note: contare le righe conterebbe lo
    // stesso guasto tre volte.
    const msg = cascade(RATE_LIMITED);
    const text = [
      `${GH}❌ ${msg}`,
      `${GH}⚠️  Differito: tutti i modelli AI gratuiti sono temporaneamente esauriti (quota giornaliera, 1/4 = 25.0%). Riprovo al prossimo run. ${msg}`,
      `${GH}    "note": "Deferred (all free models exhausted): ${msg}"`,
    ].join('\n');
    const parsed = parseCascades(text);
    assert.equal(parsed.lines, 3);
    assert.equal(parsed.cascades.length, 1);
  });
});

describe('quota-deferral-share-report — il numero che la issue chiede', () => {
  test('host giu\' (#767): gli echi persistenti tolti ALZANO lo share', () => {
    const [c] = parseCascades(cascade(HOST_DOWN)).cascades;
    const a = analyseCascade(c);
    assert.deepEqual(a.gross, {
      transient: 3, persistent: 4, ambiguous: 1, total: 8, share: 3 / 8,
    });
    assert.equal(a.providerCooldownSkips.total, 4);
    assert.equal(a.providerCooldownSkips.persistent, 4);
    // Netto: i 4 echi escono dal denominatore E dal secchio persistente.
    assert.equal(a.net.total, 4);
    assert.equal(a.net.transient, 3);
    assert.equal(a.net.share, 3 / 4);
    // Il verdetto e' quello del codice di produzione, non una ricopiatura:
    // lordo 0,375 → rosso, netto 0,75 → differimento. E' lo scarto che #805 ha
    // introdotto e che questa misura serve a quantificare su run vere.
    assert.equal(a.deferral, true);
    assert.equal(a.inputCapVeto, false);
  });

  test('429 (vocabolario pre-#767): gli echi transitori tolti ABBASSANO lo share', () => {
    const [c] = parseCascades(cascade(RATE_LIMITED)).cascades;
    const a = analyseCascade(c);
    assert.deepEqual(a.gross, {
      transient: 3, persistent: 3, ambiguous: 0, total: 6, share: 0.5,
    });
    assert.equal(a.providerCooldownSkips.transient, 2);
    assert.equal(a.net.transient, 1);
    assert.equal(a.net.total, 4);
    assert.equal(a.net.share, 0.25);
    // 0,5 non e' > 0,5 nemmeno al lordo: la maggioranza e' STRETTA.
    assert.equal(a.deferral, false);
  });

  test('il veto input-cap resta visibile: un differimento annunciato su una run uscita 3 e\' una metrica che nessuno rilegge', () => {
    const text = cascade(
      ['m1: skipped — request ~9740 tokens exceeds 8000-token input cap', 'm2: daily limit'],
      ' | Prompt budget: 1 model(s) refused a ~9740-token request;'
        + ' the most permissive cap among them is 8000 tokens (over by ~1740).',
    );
    const [c] = parseCascades(text).cascades;
    assert.equal(c.errors.length, 2, 'la prosa della coda non e\' un motivo di fallimento');
    assert.equal(c.inputCapRefusals, 1);
    const a = analyseCascade(c);
    assert.equal(a.gross.total, 2);
    // 1 vs 1: il pareggio va al persistente quando c'e' un rifiuto su taglia.
    assert.equal(a.inputCapVeto, true);
    assert.match(formatCascadeLine(1, a), /VETO input-cap/);
  });

  test('l\'errore ricostruito ha la forma esatta che i predicati leggono', () => {
    const err = cascadeToError({ errors: ['a: daily limit'], inputCapRefusals: 0 });
    assert.equal(err.code, 'ALL_MODELS_EXHAUSTED');
    assert.equal(err.inputCapReport, null);
    assert.deepEqual(err.exhaustionBreakdown.providerCooldownSkips, { total: 0, transient: 0, persistent: 0 });
  });

  test('il verdetto di una run e\' quello dell\'ULTIMA cascata', () => {
    // Le precedenti sono state riassorbite da un retry di sezione e non hanno
    // mai raggiunto il catch di primo livello: non hanno deciso niente.
    const parsed = parseCascades([
      `${GH}${cascade(HOST_DOWN)}`,
      `${GH}${cascade(RATE_LIMITED)}`,
    ].join('\n'));
    const analyses = parsed.cascades.map(analyseCascade);
    const s = summariseRun(analyses);
    assert.equal(s.cascades, 2);
    assert.equal(s.transient, 6);
    assert.equal(s.total, 14);
    assert.equal(s.echoes, 6);
    assert.equal(s.share, 6 / 14);
    assert.equal(s.deferral, false, 'decide RATE_LIMITED, che e\' l\'ultima');
    assert.match(formatRunLine(42, parsed, s), /cascate=2/);
  });

  test('nessuna cascata → nessuna misura, non uno share zero', () => {
    const parsed = parseCascades('generate\tstep\t2026-09-04T00:00:00Z ✅ Article published');
    const s = summariseRun(parsed.cascades.map(analyseCascade));
    assert.equal(s.cascades, 0);
    assert.equal(s.deferral, null, 'null e non false: una run senza cascate non ha rifiutato niente');
    assert.match(formatRunLine(7, parsed, s), /nessuna cascata esaurita/);
  });
});

describe('quota-deferral-share-report — la CLI', () => {
  test('`--stdin` stampa la misura senza toccare la rete', () => {
    const out = execFileSync('node', [SCRIPT, '--stdin'], {
      input: `${GH}${cascade(HOST_DOWN)}`,
      encoding: 'utf-8',
    });
    assert.match(out, /run <stdin>/);
    assert.match(out, /lordo 3\/8/);
    assert.match(out, /netto 3\/4/);
    assert.match(out, /DIFFERIMENTO/);
  });
});
