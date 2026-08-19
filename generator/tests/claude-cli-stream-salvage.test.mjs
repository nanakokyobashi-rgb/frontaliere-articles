/**
 * ── LO STREAM NON SI FERMA: L'ANELLO DI StructuredOutput NON CONVERGE ───────
 *
 * La diagnostica di #441 riportava «fermo dopo assistant a 223671ms» e si
 * leggeva come uno STALLO dello stream. Non lo e'. Riproduzione locale con i
 * flag esatti di produzione (CLI 2.1.235, haiku, `--json-schema`, 2026-08-18),
 * uccisa a 400s:
 *
 *     system/init   →  tools: ["StructuredOutput"]   (anche con `--tools ''`)
 *     assistant  23:46:58  blocks=['thinking']   textlen=0
 *     assistant  23:50:31  blocks=['tool_use']   textlen=0   ← 21.886 byte
 *     user       23:50:31  tool_result is_error:true
 *                          «Output does not match required schema:
 *                           root: must have required property 'reason'»
 *     result/error_during_execution   num_turns=3   output_tokens=6773
 *
 * Cioe': `--json-schema` fa esporre al CLI un tool sintetico
 * `StructuredOutput`; il modello lo chiama con l'articolo dentro `input`; il
 * CLI valida in locale e, se manca un campo required, RIFIUTA e il modello
 * rigenera da capo. 224-288 eventi e 110-160 KB di stdout non sono uno stream
 * fermo: sono N giri di quell'anello, a ~3m30s e ~6.800 token l'uno.
 *
 * DUE CONSEGUENZE che questi test difendono.
 *
 * 1. Il contenuto NON sta nei blocchi `text` — `textlen` e' 0 su entrambi gli
 *    eventi `assistant` della riproduzione. Sta nell'`input` del `tool_use`.
 *    Un salvataggio che concatenasse i `text`, che e' la forma ovvia, avrebbe
 *    recuperato la stringa vuota su OGNI chiamata di produzione, con la CI
 *    verde. E' la ragione per cui il primo test qui sotto guarda `tool_use` e
 *    non `text`.
 *
 * 2. I 17-29s di silenzio prima del SIGKILL non provano niente: fra due eventi
 *    di UN SOLO giro sano ne passano 3m32s (23:46:58 → 23:50:31), perche' un
 *    blocco `tool_use` viene emesso solo a blocco chiuso. Aspettare di piu' non
 *    era il rimedio; non buttare cio' che era gia' arrivato lo e'.
 *
 * COSTO DEL DIFETTO, misurato sulle quattro run citate in #441 (2026-08-18):
 * 9 timeout, e in ognuno lo stdout gia' ricevuto veniva scartato per intero —
 * 110.868, 122.026, 133.111 e 160.208 byte nei quattro casi peggiori.
 *
 * PERCHE' I TEST SONO SUL TRACCIATORE E NON SU `_runClaudeCliProcess`: farlo
 * scattare per davvero vorrebbe dire spawnare `claude` e aspettare minuti. Il
 * tracciatore e' esportato apposta. Che il ramo di timeout lo usi davvero e'
 * verificato dalle asserzioni sul sorgente in fondo.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClaudeCliStreamTrace } from '../scripts/lib/ai-models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/lib/ai-models.mjs'), 'utf-8');

const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', tools: ['StructuredOutput'] });
const THINKING = JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 12 });
const RATE_LIMIT = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
});

/** L'evento `assistant` che porta SOLO il blocco `thinking`: textlen 0. */
const ASSISTANT_THINKING = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'thinking', thinking: 'rifletto' }] },
});

/** Un giro dell'anello: il modello chiama StructuredOutput con l'articolo. */
function assistantToolUse(input, { name = 'StructuredOutput', id = 'toolu_x' } = {}) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });
}

/** Il rifiuto del CLI, che e' cio' che fa ripartire il giro. */
const TOOL_RESULT_ERR = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'tool_result',
      is_error: true,
      content: "Output does not match required schema: root: must have required property 'reason'",
      tool_use_id: 'toolu_x',
    }],
  },
});

const ARTICOLO = {
  content: { it: { title: 'I frontalieri del Ticino', excerpt: 'Oltre 74.000 lavoratori.', body1: 'x'.repeat(3000), body2: 'y'.repeat(2600), body3: 'z'.repeat(2800) } },
  abort_topical_relevance: false,
};

describe('lo stream ucciso a meta\' anello non butta via il contenuto gia\' pagato', () => {
  it('recupera l\'articolo dall\'input di tool_use quando il terminale non arriva mai', () => {
    const t = createClaudeCliStreamTrace();
    // La sequenza esatta della riproduzione, senza `result`: il SIGKILL e'
    // caduto mentre il modello generava il giro successivo.
    t.feed(`${INIT}\n${THINKING}\n${RATE_LIMIT}\n${ASSISTANT_THINKING}\n${assistantToolUse(ARTICOLO)}\n${TOOL_RESULT_ERR}\n`);

    assert.equal(t.result, null, 'per costruzione questo stream non ha evento result');

    const salvato = t.salvage();
    assert.ok(salvato, 'senza salvataggio 5 eventi e un articolo intero finiscono nel cestino');
    assert.match(salvato.source, /tool_use/, `il canale del contenuto e' tool_use, non text (ricevuto: ${salvato?.source})`);

    // La prova che conta: cio' che si recupera e' l'articolo, non un guscio.
    const ripreso = JSON.parse(salvato.text);
    assert.equal(ripreso.content.it.title, 'I frontalieri del Ticino');
    assert.equal(ripreso.content.it.body1.length, 3000);
  });

  it('concatenare i blocchi `text` NON basta: in produzione textlen e\' 0', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(`${INIT}\n${ASSISTANT_THINKING}\n${assistantToolUse(ARTICOLO)}\n`);
    // Questa e' la trappola che il commento in testa descrive: un salvataggio
    // scritto sui `text` sarebbe passato in CI e avrebbe recuperato '' in
    // produzione. Il tracciatore deve vedere zero testo e salvare lo stesso.
    assert.equal(t.state.text, '', 'gli assistant di produzione non portano testo');
    assert.ok(t.salvage(), 'il salvataggio non deve dipendere dai blocchi text');
  });

  it('l\'ultimo tentativo vince: e\' quello piu\' vicino allo schema', () => {
    const t = createClaudeCliStreamTrace();
    const primo = { content: { it: { title: 'bozza' } } };
    const secondo = { content: { it: { title: 'rifinito' } }, abort_topical_relevance: false };
    t.feed(`${INIT}\n${assistantToolUse(primo)}\n${TOOL_RESULT_ERR}\n${assistantToolUse(secondo)}\n`);

    const salvato = t.salvage();
    assert.equal(JSON.parse(salvato.text).content.it.title, 'rifinito');
    assert.equal(salvato.attempts, 2, 'il numero di giri dell\'anello e\' cio\' che rende il difetto misurabile dai log');
  });

  it('un tool_use di un altro tool non e\' un articolo', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(`${INIT}\n${assistantToolUse({ command: 'ls' }, { name: 'Bash' })}\n`);
    assert.equal(t.salvage(), null, 'salvare l\'input di un tool qualsiasi consegnerebbe spazzatura al chiamante');
  });
});

describe('senza schema il canale e\' il testo, ma solo se e\' intero', () => {
  it('recupera il testo concatenato quando non c\'e\' nessun tool_use', () => {
    const t = createClaudeCliStreamTrace();
    const parla = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    t.feed(`${INIT}\n${parla('Prima parte. ')}\n${parla('Seconda parte.')}\n`);
    const salvato = t.salvage();
    assert.equal(salvato.text, 'Prima parte. Seconda parte.');
    assert.equal(salvato.source, 'assistant/text');
  });

  it('un JSON troncato a meta\' NON viene salvato — consegnarlo sarebbe peggio del timeout', () => {
    const t = createClaudeCliStreamTrace();
    const parla = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    t.feed(`${INIT}\n${parla('{"content":{"it":{"title":"tron')}\n`);
    assert.equal(t.salvage(), null, 'i blocchi text arrivano a delta: un JSON aperto puo\' essere monco');
  });

  it('niente di arrivato, niente da salvare', () => {
    const t = createClaudeCliStreamTrace();
    t.feed(`${INIT}\n${THINKING}\n`);
    assert.equal(t.salvage(), null);
  });
});

describe('il ramo di timeout usa davvero il salvataggio, e non punisce il modello', () => {
  it('l\'errore di timeout porta con se\' il payload recuperato', () => {
    assert.match(
      SRC,
      /err\.claudeCliSalvage\s*=\s*trace\.salvage\(\)/,
      'senza questa riga il salvataggio esiste ma non raggiunge mai il chiamante',
    );
  });

  it('_callClaudeCli preferisce il payload al rilancio dell\'errore', () => {
    assert.match(
      SRC,
      /_salvageClaudeCliPayload\(model,\s*err\?\.claudeCliSalvage/,
      'il ramo catch deve tentare il recupero prima di rilanciare',
    );
  });

  it('un guasto di trasporto non tocca il punteggio del modello', () => {
    // Il costo osservato: -50 per timeout (SCORE_EXHAUSTED), cioe' lo scivolo
    // -256 → -306 → -356 della run 32187412494, mentre nelle stesse quattro run
    // haiku serviva 48 risposte riuscite. Stessa carve-out di `topic-gate-abort`.
    assert.match(SRC, /err\.transportFault\s*=\s*true/, 'il trasporto deve marcare i propri guasti');
    assert.match(
      SRC,
      /const penalty = transportOnly \? 0/,
      'un guasto di trasporto deve costare zero punti',
    );
    assert.match(
      SRC,
      /const transportOnly = !!e\.transportFault && provider === PROVIDER\.CLAUDE_CLI;[\s\S]{0,220}?transportOnly,\s*\n\s*\}\);/,
      'callLLM deve propagare il flag a recordModelFailure',
    );
  });

  it('il fallimento si CONTA anche quando non si paga', () => {
    // Azzerare pure il conteggio farebbe apparire nel ledger un modello che non
    // fallisce mai (`Nok/0ko`) proprio mentre sta fallendo: si perderebbe il
    // segnale del prossimo incidente per salvare il punteggio di questo.
    const dopo = SRC.slice(SRC.indexOf('const penalty = transportOnly ? 0'));
    const corpo = dopo.slice(0, dopo.indexOf('\n}'));
    assert.match(corpo, /d\.failures\+\+/, 'il contatore dei fallimenti deve restare incondizionato');
    assert.match(corpo, /_bumpOutcome\(modelId, 'failures'\)/, 'l\'outcome deve finire nel ledger comunque');
    assert.match(corpo, /if \(penalty !== 0\) _modelScores\.set/, 'un `+ 0` creerebbe una voce spuria a punteggio 0');
  });

  it('il breaker di trasporto NON viene disarmato dalla carve-out', () => {
    // La carve-out protegge il punteggio, non il circuito: un anello che non
    // converge deve comunque poter spegnere claude-cli per il resto della run.
    assert.match(
      SRC,
      /_claudeCliConsecutiveTimeouts\+\+/,
      'il contatore del breaker deve restare armato',
    );
    const carve = SRC.slice(SRC.indexOf('const transportOnly'));
    assert.ok(
      SRC.indexOf('_claudeCliConsecutiveTimeouts++') < SRC.indexOf('const transportOnly'),
      'il breaker deve essere contato PRIMA della carve-out, altrimenti la carve-out lo salta',
    );
    assert.ok(carve.length > 0);
  });
});
