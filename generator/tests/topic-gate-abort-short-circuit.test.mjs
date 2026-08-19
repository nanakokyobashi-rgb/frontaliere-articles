/**
 * topic-gate-abort-short-circuit.test.mjs — un verdetto sulla FONTE non si
 * ri-chiede a sei modelli.
 *
 * ## Il difetto
 *
 * `create-article.mjs` ha due cicli annidati. Quello ESTERNO prova fino a
 * `MAX_DUPLICATE_RETRIES` (8) headline diverse e gestisce gia' correttamente
 * l'abort di REGOLA #0: `isQualityRejectError` legge `e.topicGateAbort`, e il
 * ramo risponde `url = null; continue` — headline successiva. Quello INTERNO
 * prova fino a `maxAttempts` (6) MODELLI diversi sulla stessa fonte, e il suo
 * `catch` non guardava `topicGateAbort` affatto: l'abort cadeva nel
 * `if (attempt < maxAttempts) continue` generico.
 *
 * Cosi' un verdetto sul MATERIALE («questa fonte non ha un aggancio
 * frontaliere reale») veniva ri-chiesto a cinque modelli in piu' prima di poter
 * raggiungere il ciclo che sapeva cosa farne. E ogni giro del ciclo interno e'
 * una cascata COMPLETA sul roster: i modelli morti (402/404/429/timeout) si
 * ripagano tutti prima di ricadere sullo stesso `claude-cli/haiku` che aveva
 * gia' risposto.
 *
 * ## La misura
 *
 * Quattro run del 2026-08-18 successive a #479 — prima di #479 l'abort era
 * misclassificato come «non normalizzabile» e non arrivava nemmeno a questo
 * `catch`, quindi la finestra osservabile si apre alle 20:19Z. Per singola
 * headline, dall'abort del tentativo 1 alla resa al ciclo esterno:
 *
 *   32182923129  20:48:44 → 21:13:18   24m34s
 *   32187412494  21:24:26 → 21:32:59    8m33s
 *   32190158524  22:30:14 → 22:39:19    9m05s
 *   32197078704  23:26:33 → 23:35:01    8m28s
 *   32197078704  23:40:51 → 23:56:40   15m49s
 *
 * ~66 minuti in quattro run, e tutte e quattro chiuse con `produced no
 * article`: il cap di sezione (2400s) si consumava dentro UNA headline mentre
 * il ciclo esterno ne prevedeva 8.
 *
 * ## I tre strati, e perche' servono tutti e tre
 *
 *  · **Comportamento** — la guardia, ritagliata VERBATIM dal sorgente, rilancia
 *    su `topicGateAbort` e NON rilancia su tutto il resto. Una guardia troppo
 *    larga trasformerebbe un timeout recuperabile in una headline buttata.
 *  · **Posizione** — che stia DENTRO quel `catch` e PRIMA del `continue`
 *    generico. E' l'unico strato che difende davvero la fix: dopo il
 *    `continue` la guardia sarebbe codice morto, e il test di comportamento
 *    resterebbe verde lo stesso.
 *  · **Cablaggio a valle** — che il ciclo esterno riconosca ancora l'errore
 *    rilanciato. Se `isQualityRejectError` smettesse di leggere
 *    `topicGateAbort`, il `throw` non sarebbe piu' una resa ordinata ma un
 *    fallimento di run: la fix si convertirebbe nel suo contrario.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC_PATH = fileURLToPath(new URL('../scripts/create-article.mjs', import.meta.url));
const SRC = readFileSync(SRC_PATH, 'utf-8');

// ── Ritaglio verbatim della guardia ────────────────────────────────────────
//
// Si ritaglia dal sorgente invece di riscriverla: una copia a mano resterebbe
// verde dopo che il sorgente e' regredito, che e' il modo esatto in cui un
// test smette di provare qualcosa.
function extractGuard() {
  // Ancora volutamente CORTA (si ferma prima di `) {`): una condizione
  // allargata a mano viene comunque ritagliata ed ESEGUITA, e a bocciarla e'
  // il test di strettezza qui sotto — per il comportamento, non per un
  // ritaglio fallito. Con l'ancora lunga la mutazione «guardia allargata»
  // andava rossa perche' il ritaglio non trovava piu' niente: rosso giusto,
  // ragione sbagliata, e la proprieta' restava non provata.
  const start = SRC.indexOf('      if (e?.topicGateAbort === true');
  assert.notEqual(start, -1, 'guardia topicGateAbort assente dal sorgente');
  const end = SRC.indexOf('\n      }\n', start);
  assert.notEqual(end, -1, 'blocco della guardia non chiuso');
  return SRC.slice(start, end + '\n      }\n'.length);
}

/** Esegue la guardia verbatim con `e`, `attempt`, `maxAttempts` in scope. */
function runGuard(e, { attempt = 1, maxAttempts = 6 } = {}) {
  const block = extractGuard();
  const fn = new Function('e', 'attempt', 'maxAttempts', 'console', `${block}\nreturn 'fall-through';`);
  const silent = { error() {}, warn() {}, log() {} };
  return fn(e, attempt, maxAttempts, silent);
}

// ── Strato 1: comportamento ────────────────────────────────────────────────

test('un abort di REGOLA #0 rilancia invece di provare un altro modello', () => {
  const e = Object.assign(new Error('Topic-gate abort: la fonte parla di una riorganizzazione interna'), {
    topicGateAbort: true,
  });
  assert.throws(() => runGuard(e), (thrown) => thrown === e,
    "la guardia deve rilanciare LO STESSO errore: il ciclo esterno lo classifica per proprieta, non per messaggio");
});

test('rilancia anche all\'ultimo tentativo — non e\' un\'ottimizzazione del solo primo giro', () => {
  const e = Object.assign(new Error('Topic-gate abort'), { topicGateAbort: true });
  assert.throws(() => runGuard(e, { attempt: 6, maxAttempts: 6 }), (t) => t === e);
});

test('un errore qualunque cade nel ramo generico, come prima', () => {
  const e = new Error('All AI models failed. Chain: [...]');
  assert.equal(runGuard(e), 'fall-through');
});

test('la guardia e\' stretta: un reject di QUALITA\' non e\' un verdetto sulla fonte', () => {
  // Una fabbricazione o un fact-check fallito PUO' dipendere dal modello: un
  // altro modello puo' scrivere lo stesso articolo senza inventare. Solo
  // REGOLA #0 parla del materiale. Allargare la guardia a `isQualityReject`
  // butterebbe headline buone.
  const e = Object.assign(new Error('Articolo rigettato: veridicita\''), { qualityReject: true });
  assert.equal(runGuard(e), 'fall-through');
});

test('`topicGateAbort` falsy non basta: serve il true esplicito', () => {
  for (const v of [false, undefined, null, 0, '']) {
    const e = Object.assign(new Error('x'), { topicGateAbort: v });
    assert.equal(runGuard(e), 'fall-through', `topicGateAbort=${JSON.stringify(v)} non deve rilanciare`);
  }
});

test('un errore senza proprieta\' non fa esplodere la guardia (optional chaining)', () => {
  assert.equal(runGuard(null), 'fall-through');
  assert.equal(runGuard(undefined), 'fall-through');
});

// ── Strato 2: posizione (l'unico che difende la fix) ───────────────────────

test('la guardia sta nel catch del ciclo dei MODELLI, prima del continue generico', () => {
  const catchLog = SRC.indexOf('console.error(`  ⚠️  Tentativo ${attempt} fallito: ${e.message}`);');
  assert.notEqual(catchLog, -1, 'log del catch del ciclo interno assente — il sorgente e\' cambiato sotto il test');

  const guard = SRC.indexOf('      if (e?.topicGateAbort === true', catchLog);
  assert.notEqual(guard, -1, 'guardia non trovata DOPO il log del catch: non e\' in quel catch');

  const genericContinue = SRC.indexOf('if (attempt < maxAttempts) continue;', catchLog);
  assert.notEqual(genericContinue, -1, 'continue generico assente');

  assert.ok(
    guard < genericContinue,
    'la guardia deve precedere `if (attempt < maxAttempts) continue`: dopo sarebbe codice morto '
    + 'e i test di comportamento resterebbero verdi lo stesso',
  );
});

test('la guardia precede anche il blocco del budget del prompt', () => {
  // Non e' estetica: `lastPromptTokenBudget` e' monotono (Math.min) e una
  // volta stretto non si riallarga. Un abort non dice NIENTE sulla dimensione
  // del prompt, quindi non deve poter contribuire a quel minimo.
  const catchLog = SRC.indexOf('console.error(`  ⚠️  Tentativo ${attempt} fallito: ${e.message}`);');
  const guard = SRC.indexOf('      if (e?.topicGateAbort === true', catchLog);
  const budget = SRC.indexOf('const budgetDettato = Number(e?.retryRequestTokenBudget)', catchLog);
  assert.notEqual(budget, -1, 'blocco del budget assente');
  assert.ok(guard < budget, 'la guardia deve precedere il calcolo del budget dettato dalla flotta');
});

// ── Strato 3: cablaggio a valle ────────────────────────────────────────────

test('il ciclo esterno classifica ancora l\'errore rilanciato come reject di qualita\'', () => {
  // Senza questo, `throw e` smetterebbe di essere una resa ordinata («provo
  // un altro headline») e diventerebbe un fallimento di run.
  assert.ok(
    /e\.qualityReject === true \|\| e\.topicGateAbort === true/.test(SRC),
    'isQualityRejectError non legge piu\' e.topicGateAbort: il rilancio della guardia '
    + 'non atterrerebbe piu\' nel ramo «provo un altro headline»',
  );
});

test('il ramo «provo un altro headline» esiste e riconosce il topic-gate', () => {
  assert.ok(
    /const isTopicGateAbort = e\.topicGateAbort === true/.test(SRC),
    'il ciclo esterno non riconosce piu\' l\'abort',
  );
  assert.ok(
    /provo un altro headline/.test(SRC),
    'il ramo di resa al ciclo esterno e\' sparito',
  );
});
