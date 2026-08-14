/**
 * loop-drift-stranded-twin.test.mjs — pinna l'invariante «un gemello
 * `identical` fermo indietro oltre la soglia deve ESSERE DETTO» (issue #303).
 *
 * ## Il buco che chiude
 *
 * `classify()` risponde a «chi si è mosso», mai a «da quanto». Per `site-ahead`
 * quella seconda domanda è tutto, perché separa due situazioni opposte che
 * producevano la stessa identica riga:
 *
 *   - il sito ha toccato il file ieri  → latenza, qualcuno lo porterà;
 *   - il sito lo ha lasciato indietro da due settimane → non lo porterà
 *     nessuno, perché NESSUN workflow porta quel path.
 *
 * La seconda è la classe che ha morso davvero. Il 2026-08-14 cinque gemelli
 * `identical` erano fermi da 2,50 / 2,50 / 3,88 / 5,96 / 15,75 giorni — fra
 * questi `host/shared/localeEmitFilter.ts`, che sul sito aveva già prodotto
 * `/en.html` `/de.html` `/fr.html` a 404 (#5327) e qui girava ancora con quel
 * difetto — e il drift check li elencava ogni mattina nella stessa riga
 * invariata. Una riga che non cambia mai smette di essere letta.
 *
 * ## Perché non basta il mirror
 *
 * `mirror-articles-engine.yml` copre `engine/`, e il manifest tiene `engine/`
 * `outOfScope` PROPRIO perché quello un trasporto ce l'ha. Sorvegliato e
 * trasportato sono insiemi disgiunti per costruzione: misurato il 2026-08-14,
 * **122 voci `identical` su 122 senza trasporto automatico**. Per ognuna la
 * discesa è una copia a mano, e questo verdetto è l'unica cosa che dice quando
 * non è stata fatta.
 *
 * ## Cosa è testato qui, e cosa no
 *
 * Solo la parte PURA, `strandedVerdict()`, con `nowMs` iniettato: un guard che
 * dipende dall'orologio o dalla rete non è un guard, è un flake. La metà che fa
 * rete (`repoHistoryMatch` → `matchedDate`) resta fuori per la stessa ragione
 * per cui `loop-drift-check-provenance.test.mjs` tiene fuori la sua: dipende
 * dall'API di GitHub, 60 richieste/ora per IP anonimo condivise fra i runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strandedVerdict } from '../../scripts/ci/loop-drift-check.mjs';

// Istante fisso: ogni caso sotto è deterministico, mai relativo a `Date.now()`.
const NOW = Date.parse('2026-08-14T06:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

test('IL CASO #303: identical fermo da 15,75 giorni → stranded', () => {
  // `generator/scripts/lib/meta-field-regex.mjs`, il più vecchio dei cinque.
  const v = strandedVerdict({
    mode: 'identical', state: 'site-ahead',
    baselineLastSeenAt: daysAgo(15.75), nowMs: NOW, thresholdDays: 3,
  });
  assert.equal(v.stranded, true, 'un gemello fermo da due settimane deve accendersi');
  assert.ok(Math.abs(v.ageDays - 15.75) < 0.01, `ageDays atteso ~15.75, ricevuto ${v.ageDays}`);
});

test('la calibrazione della soglia: 2,50 giorni è latenza, 3,88 no', () => {
  // I due estremi reali del 2026-08-14 attorno al default di 3 giorni: sotto
  // stanno `followup-drainer.mjs` e `github-issue-creator.mjs` (mossi dal sito
  // due giorni prima, che qualcuno stava per portare), sopra `triage-sweep.mjs`.
  const fresh = strandedVerdict({
    mode: 'identical', state: 'site-ahead',
    baselineLastSeenAt: daysAgo(2.5), nowMs: NOW, thresholdDays: 3,
  });
  assert.equal(fresh.stranded, false, '2,50 giorni è latenza normale del cron giornaliero, non deve accendersi');

  const old = strandedVerdict({
    mode: 'identical', state: 'site-ahead',
    baselineLastSeenAt: daysAgo(3.88), nowMs: NOW, thresholdDays: 3,
  });
  assert.equal(old.stranded, true, '3,88 giorni è oltre la soglia e deve accendersi');
});

test('la soglia è inclusiva: esattamente 3 giorni è già stranded', () => {
  const v = strandedVerdict({
    mode: 'identical', state: 'site-ahead',
    baselineLastSeenAt: daysAgo(3), nowMs: NOW, thresholdDays: 3,
  });
  assert.equal(v.stranded, true, 'il confronto è `>=`: al giorno esatto della soglia il verdetto scatta');
});

test('`adapted` non è mai stranded, per quanto vecchio: la sua istruzione è diversa', () => {
  // Un adattato non è copiabile — la sua riga chiede già di rileggere la
  // modifica del sito e riapplicarla a mano. Alzare la voce sull'età lì
  // sarebbe rumore su un lavoro che ha un rimedio diverso.
  const v = strandedVerdict({
    mode: 'adapted', state: 'site-ahead',
    baselineLastSeenAt: daysAgo(99), nowMs: NOW, thresholdDays: 3,
  });
  assert.equal(v.stranded, false);
  assert.equal(v.ageDays, null);
});

test('solo `site-ahead`: nessun altro verdetto viene escalato', () => {
  for (const state of ['stable', 'corpus-ahead', 'both-moved', 'undeclared-drift', 'missing-here']) {
    const v = strandedVerdict({
      mode: 'identical', state,
      baselineLastSeenAt: daysAgo(99), nowMs: NOW, thresholdDays: 3,
    });
    assert.equal(v.stranded, false, `${state} non deve diventare stranded-twin`);
  }
});

test('età sconosciuta → mai stranded (fail-open, come il resto dello script)', () => {
  // Succede con `--no-provenance`, o quando il walk di storia fallisce. Un dato
  // mancante non deve produrre un rosso: è la stessa scelta di `ghostVerdict`,
  // dove un mancato match su storia non esaurita resta "non verificato".
  for (const bad of [null, undefined, '', 'non-una-data']) {
    const v = strandedVerdict({
      mode: 'identical', state: 'site-ahead',
      baselineLastSeenAt: bad, nowMs: NOW, thresholdDays: 3,
    });
    assert.equal(v.stranded, false, `baselineLastSeenAt=${JSON.stringify(bad)} non deve accendere il verdetto`);
    assert.equal(v.ageDays, null);
  }
});

test('data nel futuro → non stranded: è un dato illeggibile, non un gemello fermo', () => {
  const v = strandedVerdict({
    mode: 'identical', state: 'site-ahead',
    baselineLastSeenAt: daysAgo(-5), nowMs: NOW, thresholdDays: 3,
  });
  assert.equal(v.stranded, false, "un'età negativa (clock skew) non è una prova di stranding");
  assert.equal(v.ageDays, null);
});

test('la soglia è configurabile: STRANDED_AFTER_DAYS cambia il verdetto sullo stesso fatto', () => {
  const args = { mode: 'identical', state: 'site-ahead', baselineLastSeenAt: daysAgo(5), nowMs: NOW };
  assert.equal(strandedVerdict({ ...args, thresholdDays: 3 }).stranded, true);
  assert.equal(strandedVerdict({ ...args, thresholdDays: 7 }).stranded, false);
});
