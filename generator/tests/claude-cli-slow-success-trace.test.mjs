/**
 * ── UNA DIAGNOSTICA APPESA AL FALLIMENTO E' MUTA DAVANTI ALLA LENTEZZA ──────
 *
 * `createClaudeCliStreamTrace` raccoglie a ogni chiamata tutto cio' che serve a
 * spiegare dove sono finiti i secondi: primo evento, `rate_limit_event`, giri
 * di `StructuredOutput`, e l'involucro `result` con la scomposizione che il CLI
 * dichiara da solo. Ma `trace.describe()` era chiamato SOLO dai due rami
 * d'errore di `_callClaudeCli`.
 *
 * Finche' il difetto era «timeout a 120s» quello bastava, perche' il difetto
 * ERA un errore. Non lo e' piu'. Misurato sulla run 32230961988 (2026-08-19,
 * job `generate` 08:06:22→08:23:22, 17m00s, `success`, un articolo prodotto):
 *
 *     ⏳ [claude-cli/haiku] in-flight 60s/120s/180s   → chiamata da ~197s
 *     ⏳ [claude-cli/haiku] in-flight 60s/120s/180s   → chiamata da ~206s
 *     ⏳ [claude-cli/haiku] in-flight 60s/…/240s      → chiamata da ~253s
 *     riepilogo roster: claude-cli 3 served/0 failed
 *
 * 656 secondi su 1020, cioe' il 64% del job, mentre nessun altro modello del
 * roster supera mai i 60s (l'heartbeat scatta solo oltre quella soglia e per
 * nessun altro compare). Tre chiamate RIUSCITE: il riepilogo dice «3 served/0
 * failed» e non una parola su quei 656 secondi.
 *
 * Questo file e' l'osservatore della riga che li racconta.
 *
 * PERCHE' NON E' L'ENNESIMA LEVA. Il commento di `createClaudeCliStreamTrace`
 * registra TRE tentativi alla cieca gia' spesi su questo stesso sintomo (floor
 * 60s→120s, semaforo `CLAUDE_CLI_MAX_CONCURRENCY`, soglia del breaker a 3),
 * nessuno con un dato su cui puntare. Qui non se ne tocca nessuna: si rende
 * leggibile il numero che dice QUALE delle tre famiglie di rimedio ha senso,
 * visto che sono mutuamente esclusive (coda vs generazione vs anello di
 * schema).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClaudeCliStreamTrace } from '../scripts/lib/ai-models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/lib/ai-models.mjs'), 'utf-8');

/** L'involucro `result` nella forma reale (campi verificati sul CLI 2.1.235). */
function eventoResult(over = {}) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 197_000,
    duration_api_ms: 196_400,
    ttft_ms: 181_000,
    num_turns: 1,
    usage: {
      input_tokens: 11_512,
      output_tokens: 2_140,
      output_tokens_details: { thinking_tokens: 1_180 },
    },
    ...over,
  });
}

const TOOL_USE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { content: { it: { title: 't' } } } }] },
});

describe('describeCost(): la scomposizione che separa la coda dalla generazione', () => {
  it('riporta i quattro numeri che decidono il rimedio', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(`${eventoResult()}\n`);
    const s = t.describeCost();
    assert.match(s, /primo token a 181000ms/, 'senza ttft non si distingue la coda dalla generazione');
    assert.match(s, /api 196400ms/);
    assert.match(s, /1 giro\b/, 'num_turns=1 va al singolare');
    assert.match(s, /2140 token di output \(1180 di thinking\)/);
    assert.match(s, /11512 token di input/);
  });

  it('i giri di StructuredOutput ci sono SEMPRE, anche a uno solo', () => {
    // Stessa regola del `rate_limit_event` in describe(): un campo che compare
    // solo quando c'e' qualcosa costringe chi legge a distinguere «non e'
    // successo» da «non lo guardavamo». E' il numero per cui il cap dei giri
    // di schema era dichiarato `blocked:` in #487/#6080.
    const vuoto = createClaudeCliStreamTrace();
    vuoto.feed(`${eventoResult()}\n`);
    assert.match(vuoto.describeCost(), /0 giri-schema/);

    const doppio = createClaudeCliStreamTrace();
    doppio.feed(`${TOOL_USE}\n${TOOL_USE}\n${eventoResult()}\n`);
    assert.match(doppio.describeCost(), /2 giri-schema/, 'l\'anello di schema resta invisibile');
  });

  it('un `result` minimo non fa esplodere la riga: cio\' che manca non compare', () => {
    // I mock della suite emettono `{type:'result', is_error:false, result:'…'}`
    // e basta. Una riga che throwa sul campo assente varrebbe meno di nessuna
    // riga — e girerebbe sul percorso caldo della generazione.
    const t = createClaudeCliStreamTrace();
    t.feed(`${JSON.stringify({ type: 'result', is_error: false, result: '{}' })}\n`);
    let s;
    assert.doesNotThrow(() => { s = t.describeCost(); });
    assert.match(s, /0 giri-schema/);
    assert.doesNotMatch(s, /NaN|undefined|null/, 'un campo assente e\' trapelato nel messaggio');
  });

  it('senza nessun `result` resta comunque una frase leggibile', () => {
    const t = createClaudeCliStreamTrace();
    let s;
    assert.doesNotThrow(() => { s = t.describeCost(); });
    assert.match(s, /costo:/);
    assert.doesNotMatch(s, /undefined/);
  });

  it('num_turns > 1 va al plurale: e\' il segnale dell\'anello che rigenera', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(`${eventoResult({ num_turns: 3 })}\n`);
    assert.match(t.describeCost(), /3 giri\b/);
  });
});

describe('il ramo di SUCCESSO di _callClaudeCli non e\' piu\' muto', () => {
  /** Il corpo di `_callClaudeCli` dal ramo `is_error` fino al return finale. */
  function ramoDiSuccesso() {
    const a = SRC.indexOf('async function _callClaudeCli(');
    assert.notEqual(a, -1, 'ancora non trovata — aggiornare questo test');
    const fine = SRC.indexOf('\n  return parsed.result;\n}', a);
    assert.notEqual(fine, -1, 'il return finale non e\' piu\' quello — aggiornare questo test');
    const isErr = SRC.indexOf('if (code !== 0 || parsed.is_error) {', a);
    assert.notEqual(isErr, -1, 'ancora del ramo is_error non trovata — aggiornare questo test');
    return SRC.slice(isErr, fine);
  }

  it('allega la diagnosi del flusso E la scomposizione del costo', () => {
    const blocco = ramoDiSuccesso();
    assert.match(blocco, /trace\.describe\(\)/, 'il successo e\' tornato cieco su dove sono finiti i secondi');
    assert.match(blocco, /trace\.describeCost\(\)/, 'senza il costo non si distingue la coda dalla generazione');
  });

  it('e\' condizionata a una soglia, cosi\' una chiamata sana non sporca il log', () => {
    const blocco = ramoDiSuccesso();
    assert.match(blocco, /CLAUDE_CLI_SLOW_CALL_LOG_MS/, 'la riga e\' incondizionata: uscirebbe su ogni chiamata');
    assert.match(blocco, /elapsedMs >= CLAUDE_CLI_SLOW_CALL_LOG_MS/);
  });

  it('il cronometro parte PRIMA della coda del semaforo, non allo spawn', () => {
    // Il tempo passato in `_withClaudeCliSlot` e' tempo che il chiamante paga:
    // misurarlo dopo nasconderebbe proprio la causa «coda».
    const a = SRC.indexOf('async function _callClaudeCli(');
    // La CHIAMATA, non una menzione: il commento qui sopra nomina
    // `_withClaudeCliSlot` per spiegare perche' il cronometro lo precede, e un
    // ancoraggio al nome nudo troverebbe quella e non il codice.
    const spawn = SRC.indexOf('_withClaudeCliSlot(async () =>', a);
    const cron = SRC.indexOf('const startedAt = Date.now();', a);
    assert.notEqual(spawn, -1, 'ancora della coda non trovata — aggiornare questo test');
    assert.notEqual(cron, -1, 'il cronometro non c\'e\' piu\'');
    assert.ok(cron < spawn, 'il cronometro parte dopo la coda: il tempo in attesa sparisce dalla misura');
  });

  it('la soglia si puo\' spegnere, e un valore assurdo non la rompe', () => {
    const a = SRC.indexOf('const CLAUDE_CLI_SLOW_CALL_LOG_MS = ');
    assert.notEqual(a, -1, 'la costante non c\'e\' piu\'');
    const blocco = SRC.slice(a, a + 400);
    assert.match(blocco, /process\.env\.CLAUDE_CLI_SLOW_CALL_LOG_MS/, 'non c\'e\' una leva d\'ambiente');
    assert.match(blocco, /Number\.isFinite/, 'un valore non numerico passerebbe');
    assert.match(blocco, /60_000/, 'il default non e\' piu\' allineato all\'heartbeat da 60s');
  });

  it('non tocca nessuna delle tre leve gia\' bruciate alla cieca', () => {
    // Il valore di questa PR e' esattamente che NON e' la quarta. Se un domani
    // qualcuno ci appende una modifica al floor, al semaforo o al breaker, il
    // cambiamento smette di essere puramente osservativo e questo test lo dice.
    assert.match(SRC, /const CLAUDE_CLI_MIN_TIMEOUT_MS = 180_000;/, 'il floor e\' cambiato in questo giro');
    assert.match(SRC, /const CLAUDE_CLI_MAX_CONCURRENCY = 2;/, 'il semaforo e\' cambiato in questo giro');
    assert.match(SRC, /const CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD = 3;/, 'la soglia del breaker e\' cambiata in questo giro');
  });
});
