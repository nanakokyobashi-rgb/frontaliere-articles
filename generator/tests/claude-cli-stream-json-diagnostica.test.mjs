/**
 * ── «0 BYTE A 120s» NON ERA UNA DIAGNOSI ────────────────────────────────────
 *
 * `claude-cli/haiku` e' il modello a pagamento preferito e primo nella cascata
 * di generazione. In produzione non e' MAI riuscito, nemmeno una volta (PR #438:
 * «0 successi»), e ogni tentativo finiva con la stessa identica riga:
 *
 *     ❌ [claude-cli/haiku] Failed: claude CLI timed out after 120000ms
 *        — stdout: 0 bytes (nessun byte scritto dal processo)
 *
 * Run 32140876038, 2026-08-18: tre tentativi alle 13:12, 13:32 e 13:34, tutti a
 * 120000ms esatti, 0 byte, stderr vuoto.
 *
 * Il conteggio dei byte era stato aggiunto apposta per distinguere «generava
 * lentamente» da «non ha mai scritto». Non poteva funzionare, e la misura lo
 * dice: con `--output-format json` la CLI non scrive NIENTE su stdout finche'
 * non ha finito — primo byte a 8442ms su una chiamata che chiude a 8995ms (CLI
 * 2.1.234, argomenti esatti di produzione, misurato il 2026-08-18). Quindi «0
 * byte» era il comportamento normale di una chiamata sana fino all'ultimo
 * istante, e non separava affatto le tre cause che vogliono rimedi opposti:
 *
 *   - la CLI non e' mai partita   → auth/avvio/rete: il floor non c'entra
 *   - l'API stallava dopo l'avvio → il floor non c'entra
 *   - la risposta era solo lenta  → e allora si', il floor e' stretto
 *
 * Tre tentativi alla cieca sono gia' stati spesi su quella cecita' (floor
 * 60s→120s, semaforo `CLAUDE_CLI_MAX_CONCURRENCY`, soglia del breaker portata a
 * 3 da #438). Con `--output-format stream-json --verbose` il primo byte arriva
 * a 942ms e ogni evento e' una riga JSONL, quindi il timeout puo' finalmente
 * dire DOVE si e' fermato. Questo file e' l'osservatore di quella proprieta'.
 *
 * PERCHE' I TEST SONO SUL TRACCIATORE E NON SU `_runClaudeCliProcess`: farlo
 * scattare per davvero vorrebbe dire spawnare `claude` e aspettare due minuti.
 * Il tracciatore e' esportato apposta per essere provato senza processi; che il
 * processo lo usi davvero e' verificato dalle due asserzioni sul sorgente in
 * fondo, e end-to-end dalla suite vitest gemella del sito
 * (`tests/scripts/ai-models-claude-cli-stream-json.test.ts`), che ha il mock di
 * `node:child_process` che qui non c'e'.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClaudeCliStreamTrace } from '../scripts/lib/ai-models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/lib/ai-models.mjs'), 'utf-8');

/** Un orologio pilotato a mano: i tempi nel messaggio devono essere verificabili. */
function orologio(start = 1_000) {
  let t = start;
  return { now: () => t, avanza(ms) { t += ms; } };
}

/** Gli eventi reali osservati su una chiamata sana (CLI 2.1.234, 2026-08-18). */
const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' });
const THINKING = JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 12 });
const RATE_LIMIT = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1787066400 },
});
const ASSISTANT = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ciao' }] } });
const RESULT_OK = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'CORPO-ARTICOLO' });

describe('il flusso stream-json viene letto riga per riga', () => {
  it('trova il risultato nella riga type:"result", non nell\'intero stdout', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(`${INIT}\n${ASSISTANT}\n${RESULT_OK}\n`);
    assert.equal(t.result.result, 'CORPO-ARTICOLO');
    assert.equal(t.state.events, 3);
  });

  it('una riga spezzata fra due chunk non viene persa — un chunk NON e\' una riga', () => {
    const t = createClaudeCliStreamTrace();
    const meta = Math.floor(RESULT_OK.length / 2);
    t.feed(`${INIT}\n${RESULT_OK.slice(0, meta)}`);
    // A meta' riga il risultato non c'e' ancora: se ci fosse, vorrebbe dire che
    // stiamo parsando spazzatura.
    assert.equal(t.result, null, 'un frammento di riga non deve produrre un risultato');
    assert.ok(t.pendingBytes > 0, 'il frammento deve restare nel buffer');
    t.feed(`${RESULT_OK.slice(meta)}\n`);
    assert.equal(t.result.result, 'CORPO-ARTICOLO');
  });

  it('l\'ultima riga senza \\n finale viene chiusa da end() — altrimenti ogni successo passa per fallito', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(RESULT_OK); // nessun newline: e' cosi' che arriva l'ultima riga
    assert.equal(t.result, null, 'senza end() la riga incompleta non e\' un evento');
    t.end();
    assert.equal(t.result.result, 'CORPO-ARTICOLO');
  });

  it('una riga illeggibile viene contata, non fa esplodere il parsing', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(`{non-json\n${RESULT_OK}\n`);
    assert.equal(t.state.malformed, 1);
    assert.equal(t.result.result, 'CORPO-ARTICOLO');
  });

  it('le righe vuote non contano come eventi', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(`\n\n${INIT}\n\n`);
    assert.equal(t.state.events, 1);
  });
});

describe('il messaggio di timeout dice DOVE si e\' fermato', () => {
  it('«nessun evento»: la CLI non e\' mai partita', () => {
    const t = createClaudeCliStreamTrace();
    const msg = t.describe();
    assert.match(msg, /nessun evento/, `atteso il caso a zero eventi, ricevuto: ${msg}`);
    // La distinzione che il conteggio dei byte non poteva dare.
    assert.doesNotMatch(msg, /fermo dopo/);
  });

  it('«fermo dopo system/init a Nms»: stallo dell\'API dopo l\'avvio', () => {
    const c = orologio();
    const t = createClaudeCliStreamTrace({ now: c.now });
    c.avanza(942); // il primo byte reale misurato in locale
    t.feed(`${INIT}\n`);
    const msg = t.describe();
    assert.match(msg, /fermo dopo system\/init a 942ms/, `messaggio inatteso: ${msg}`);
  });

  it('«fermo dopo assistant»: la risposta arrivava, era solo lenta', () => {
    const c = orologio();
    const t = createClaudeCliStreamTrace({ now: c.now });
    c.avanza(942); t.feed(`${INIT}\n`);
    c.avanza(1757); t.feed(`${THINKING}\n`);
    c.avanza(1056); t.feed(`${ASSISTANT}\n`);
    const msg = t.describe();
    assert.match(msg, /fermo dopo assistant a 3755ms/, `messaggio inatteso: ${msg}`);
    assert.match(msg, /3 eventi/);
    assert.match(msg, /primo evento a 942ms/);
  });

  it('un evento senza subtype non viene etichettato «type/undefined»', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(`${ASSISTANT}\n`);
    assert.doesNotMatch(t.describe(), /undefined/);
    assert.equal(t.state.lastEventLabel, 'assistant');
  });

  it('il singolare non e\' «1 eventi»', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(`${INIT}\n`);
    assert.match(t.describe(), /\b1 evento\b/);
  });

  it('la riga a meta\' e\' riportata: «stava scrivendo quando l\'abbiamo ucciso»', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(`${INIT}\n{"type":"resu`);
    assert.match(t.describe(), /byte di riga a meta'/);
  });
});

describe('rate_limit_event: il candidato causale oggi invisibile', () => {
  it('viene riportato con status e tipo di limite', () => {
    const c = orologio();
    const t = createClaudeCliStreamTrace({ now: c.now });
    c.avanza(942); t.feed(`${INIT}\n`);
    c.avanza(3067); t.feed(`${RATE_LIMIT}\n`);
    const msg = t.describe();
    assert.match(msg, /rate_limit_event a 4009ms/, `messaggio inatteso: ${msg}`);
    assert.match(msg, /status=allowed/);
    assert.match(msg, /tipo=five_hour/);
  });

  it('quando non e\' comparso lo dice ESPLICITAMENTE, non tacendo', () => {
    // Stessa ragione per cui il conteggio dei byte di stdout c'e' anche a zero:
    // un campo che appare solo quando c'e' qualcosa costringe chi legge il
    // prossimo incidente a distinguere «non e' successo» da «non lo guardavamo».
    // E' la classe di ambiguita' che ha reso illeggibili i tre incidenti scorsi.
    const t = createClaudeCliStreamTrace();
    t.feed(`${INIT}\n`);
    assert.match(t.describe(), /nessun rate_limit_event/);
  });

  it('un rate_limit_event senza rate_limit_info non rompe il messaggio', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(`${JSON.stringify({ type: 'rate_limit_event' })}\n`);
    const msg = t.describe();
    assert.match(msg, /rate_limit_event/);
    assert.doesNotMatch(msg, /undefined/);
  });
});

describe('il processo usa davvero il tracciatore (asserzioni sul sorgente)', () => {
  it('gli argomenti passano stream-json e --verbose, non piu\' json', () => {
    const a = SRC.indexOf("const args = [\n    '-p', userPrompt,");
    assert.notEqual(a, -1, 'ancora non trovata — aggiornare questo test');
    const b = SRC.indexOf('];', a);
    const blocco = SRC.slice(a, b);
    assert.match(blocco, /'--output-format', 'stream-json', '--verbose'/, 'il formato di output non e\' piu\' quello misurato');
    assert.doesNotMatch(blocco, /'--output-format', 'json'/, 'il formato cieco e\' tornato');
  });

  it('il ramo di timeout allega la diagnosi del flusso', () => {
    const a = SRC.indexOf('const timer = setTimeout(() => {');
    assert.notEqual(a, -1, 'ancora iniziale non trovata — aggiornare questo test');
    const b = SRC.indexOf('}, timeoutMs);', a);
    assert.notEqual(b, -1, 'ancora finale non trovata — aggiornare questo test');
    const blocco = SRC.slice(a, b);
    assert.match(blocco, /trace\.describe\(\)/, 'il timeout e\' tornato cieco su dove si e\' fermato');
    // Il campo che c'era gia' non si perde: e' una scelta deliberata documentata
    // nel commento sopra al ramo, non un residuo.
    assert.match(blocco, /stdout\.length/, 'il conteggio dei byte di stdout e\' sparito');
  });

  it('lo stdout viene dato in pasto al tracciatore mentre arriva', () => {
    assert.match(SRC, /child\.stdout\.on\('data',[^\n]*trace\.feed\(d\)/, 'il tracciatore non riceve i chunk');
  });

  it('alla chiusura il buffer viene svuotato prima di risolvere', () => {
    const a = SRC.indexOf("child.on('close', (code) => {");
    assert.notEqual(a, -1, 'ancora non trovata — aggiornare questo test');
    const blocco = SRC.slice(a, a + 600);
    const posEnd = blocco.indexOf('trace.end()');
    const posResolve = blocco.indexOf('resolve({');
    assert.notEqual(posEnd, -1, 'manca il flush finale: ogni successo senza \\n finale passerebbe per fallito');
    assert.ok(posEnd < posResolve, 'il flush deve precedere la resolve');
  });
});
