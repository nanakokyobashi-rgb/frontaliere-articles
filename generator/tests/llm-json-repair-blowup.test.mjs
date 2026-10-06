/**
 * llm-json-repair-blowup.test.mjs — lo spin che uccideva la run intera.
 *
 * COSA PINNA, e perche' e' scritto cosi'.
 *
 * Il difetto: `repairLlmJson` risolve le virgolette non escapate dentro i
 * valori con sei funzioni MUTUAMENTE RICORSIVE (`decideQuoteCloses`,
 * `afterSeparatorLooksValid`, `looksLikeJsonContinuation`, `scanValueEnd`,
 * `scanStringEnd`, `findMatchingClose`) e nessuna ricordava una risposta gia'
 * calcolata. `scanStringEnd` riprova su OGNI virgoletta interna e
 * `afterSeparatorLooksValid` esplorava due alternative per posizione: due rami
 * per livello, ripetuti a ogni livello, cioe' 2^k.
 *
 * LA PROVA NON E' UNA STIMA, E' UNA RUN MORTA. Run 32130136859 (2026-08-18),
 * fallita dopo 1058s. Il watchdog ha campionato ogni 30s:
 *
 *   elapsed  rss_MB  cpu%(cumulativo)  stato  log_bytes
 *      402s   198.8   7.2               S      31179   <- ultima riga scritta
 *      432s   198.8   6.8               R      31179
 *     1003s   198.8  72.4               R      31179
 *
 * Dieci minuti di silenzio, stato `R` (gira, non aspetta I/O), RSS fermo a
 * 198.8 MB al decimo di MB per 500 secondi — spin CPU sincrono SENZA
 * allocazione, cioe' scan a indici, non un leak e non un provider lento. Il
 * dump dello stack via inspector e' uscito 0 byte pur avendo aperto la porta
 * 9229: l'isolate non ha mai ceduto, l'event loop era bloccato.
 *
 * PERCHE' QUESTO TEST E' UNA RIPRODUZIONE E NON UN'ASSERZIONE DI FORMA.
 * Un test che cercasse col grep un memo, o che contasse le chiamate, sarebbe
 * verde anche con una memoizzazione sbagliata. Qui l'input e' quello vero —
 * la forma che un modello produce quando inlinea uno pseudo-JSON dentro un
 * campo di prosa senza escapare le virgolette — e il criterio e' che la
 * funzione RITORNI. Col difetto in piedi questi tre casi non tornano:
 *
 *   n=25   516 char   21.270 ms   (misurato prima della fix)
 *   n=30   616 char  ~11 minuti   (×2,4 per ripetizione)
 *   n=1500  30 KB     mai
 *
 * Dopo la fix, misurati sulla stessa macchina: 0,3 ms / 3,6 ms / 414 ms.
 *
 * I LIMITI DI TEMPO SONO LARGHI APPOSTA (25-50× il misurato): un runner
 * carico non deve far rosseggiare il test, e non serve stretto — la distanza
 * fra «414 ms» e «non torna mai» non ha bisogno di precisione.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = path.resolve(HERE, '../scripts/lib/llm-json-repair.mjs');
const { fixJsonStringBody, findMatchingClose, repairLlmJson, repairLlmJsonArray } = await import(MOD);

/** La forma esatta che fa esplodere la ricorsione: catena di coppie
 *  chiave/valore con virgolette non escapate, dentro un valore di prosa. */
const pseudoJsonInProse = (n) => `{"body1":"${'"chiave": "valore", '.repeat(n)}fine"}`;

test('repairLlmJsonArray prefers a later direct array over an object preamble', () => {
  const raw = 'meta {"note":"x"} [{"q":"Q","a":"A"}]';
  assert.deepEqual(JSON.parse(repairLlmJsonArray(raw)), [{ q: 'Q', a: 'A' }]);
});

test('repairLlmJsonArray skips an unmatched object preamble before a balanced array', () => {
  const raw = 'preamble {unbalanced [{"q":"Q","a":"A"}]';
  assert.deepEqual(JSON.parse(repairLlmJsonArray(raw)), [{ q: 'Q', a: 'A' }]);
});

test('repairLlmJsonArray skips an unmatched array preamble before a balanced array', () => {
  const raw = 'preamble [unbalanced [{"q":"Q","a":"A"}]';
  assert.deepEqual(JSON.parse(repairLlmJsonArray(raw)), [{ q: 'Q', a: 'A' }]);
});

test('repairLlmJsonArray keeps a wrapper after an unmatched preferred root', () => {
  const raw = 'preamble [unbalanced {"faq":[{"q":"Q","a":"A"}]}';
  assert.deepEqual(JSON.parse(repairLlmJsonArray(raw)), { faq: [{ q: 'Q', a: 'A' }] });
});

test('repairLlmJsonArray ignores an array inside a recoverable quoted preamble', () => {
  const raw = 'meta {"note":"x"} "quoted [1]", [{"q":"real","a":"A"}]';
  assert.deepEqual(JSON.parse(repairLlmJsonArray(raw)), [{ q: 'real', a: 'A' }]);
});

test('repairLlmJsonArray keeps a response after malformed array preamble punctuation', () => {
  const raw = 'preamble [unbalanced, [{"q":"Q","a":"A"}]';
  assert.deepEqual(JSON.parse(repairLlmJsonArray(raw)), [{ q: 'Q', a: 'A' }]);
});

test('repairLlmJsonArray does not promote a nested array inside an unterminated root', () => {
  const raw = '[{"q":"Q","tags":["a"]}';
  const repaired = repairLlmJsonArray(raw);
  assert.notEqual(repaired, '["a"]');
  assert.match(repaired, /"q"/);
});

test('repairLlmJsonArray keeps a wrapper when a trailing array is an example', () => {
  const raw = '{"faqs":[{"q":"real","a":"A"}]} Example: [{"q":"example","a":"B"}]';
  assert.deepEqual(JSON.parse(repairLlmJsonArray(raw)), { faqs: [{ q: 'real', a: 'A' }] });
});

test('repairLlmJsonArray keeps a valid wrapper after a rejected balanced array', () => {
  const raw = 'Example: [{"q":"example","a":"B"}] {"faqs":[{"q":"real","a":"A"}]}';
  const repaired = repairLlmJsonArray(raw, {
    validateCandidate: (candidate) => Boolean(candidate?.faqs),
  });
  assert.deepEqual(JSON.parse(repaired), { faqs: [{ q: 'real', a: 'A' }] });
});

test('repairLlmJsonArray preserves the truncated fallback when a later candidate is rejected', () => {
  const raw = '[{"q":"truncated"} [{"q":"rejected"}]';
  const repaired = repairLlmJsonArray(raw, { validateCandidate: () => false });
  assert.equal(repaired, raw);
});

test('repairLlmJsonArray does not exhaust the candidate budget on nested arrays', () => {
  const nested = Array.from({ length: 25 }, () => '{"tags":["nested"]}').join(' ');
  const raw = `[${nested} prose [{"q":"real","a":"A"}]`;
  assert.deepEqual(JSON.parse(repairLlmJsonArray(raw)), [{ q: 'real', a: 'A' }]);
});

test('repairLlmJsonArray extracts a real FAQ payload after corrupt prose leaves an unmatched nested opener', () => {
  const raw = '[[ prosa corrotta [{"q":"real","a":"A"}]';
  assert.deepEqual(JSON.parse(repairLlmJsonArray(raw)), [{ q: 'real', a: 'A' }]);
});

test('repairLlmJsonArray collapses deeply nested malformed containers before the candidate budget and stays linear', { timeout: 15_000 }, () => {
  const measure = (depth) => {
    const raw = `${'['.repeat(depth + 1)} prosa corrotta [{"q":"real","a":"A"}]`;
    const startedAt = performance.now();
    const parsed = JSON.parse(repairLlmJsonArray(raw));
    return { ms: performance.now() - startedAt, parsed };
  };

  const shallow = measure(97);
  const deep = measure(388);
  assert.deepEqual(shallow.parsed, [{ q: 'real', a: 'A' }]);
  assert.deepEqual(deep.parsed, [{ q: 'real', a: 'A' }]);
  assert.ok(
    deep.ms < shallow.ms * 10 + 250,
    `la crescita non e' quasi lineare: 97=${shallow.ms.toFixed(0)} ms, 388=${deep.ms.toFixed(0)} ms`,
  );
});

test('repairLlmJsonArray scans many unbalanced openers in near-linear time', { timeout: 15_000 }, () => {
  const measure = (openerCount) => {
    const raw = `preamble [unbalanced ${'['.repeat(openerCount)}`;
    const startedAt = performance.now();
    const repaired = repairLlmJsonArray(raw);
    return { ms: performance.now() - startedAt, repaired };
  };

  const small = measure(4_000);
  const large = measure(16_000);
  assert.equal(typeof large.repaired, 'string');
  assert.ok(large.ms < 2_000, `16.000 opener non bilanciati hanno richiesto ${large.ms.toFixed(0)} ms`);
  assert.ok(
    large.ms < small.ms * 10 + 250,
    `la crescita non e' quasi lineare: 4.000=${small.ms.toFixed(0)} ms, 16.000=${large.ms.toFixed(0)} ms`,
  );
});

test('la riparazione completa una virgola mancante dopo un oggetto annidato', () => {
  const raw = '{"id":"x","imageAlt":{"it":"it","en":"en","de":"de","fr":"fr"}"slugs":{"it":"x","en":"x","de":"de","fr":"fr"},"content":{"it":{"title":"T","body1":"B"}}}';
  const parsed = JSON.parse(repairLlmJson(raw));
  assert.equal(parsed.id, 'x');
  assert.equal(parsed.slugs.it, 'x');
  assert.equal(parsed.content.it.body1, 'B');
});

test('con un preambolo seleziona il payload JSON finale, non quello piu\' lungo', () => {
  const raw = 'Ecco un esempio: {"id":"example","content":{"it":{"title":"E","body1":"B","body2":"C","body3":"D"}},"slugs":{"it":"example"},"extra":"non usare"}. Risposta finale: {"id":"final","slugs":{"it":"final"}}';
  const parsed = JSON.parse(repairLlmJson(raw));
  assert.equal(parsed.id, 'final');
  assert.equal(parsed.slugs.it, 'final');
});

test('raccoglie una risposta successiva anche quando il primo root parte a offset zero', () => {
  const raw = '{"id":"example","slugs":{"it":"example"}} Risposta finale: {"id":"final","slugs":{"it":"final"}}';
  const parsed = JSON.parse(repairLlmJson(raw));
  assert.equal(parsed.id, 'final');
  assert.equal(parsed.slugs.it, 'final');
});

test('un esempio iniziale non fa scegliere l\'esempio JSON della coda', () => {
  const raw = 'Esempio: {"id":"example","slugs":{"it":"example"}} {"id":"real","slugs":{"it":"real"}} Nota: esempio {"id":"trailing","slugs":{"it":"trailing"},"extra":"piu lungo"}';
  const parsed = JSON.parse(repairLlmJson(raw));
  assert.equal(parsed.id, 'real');
  assert.equal(parsed.slugs.it, 'real');
  assert.equal('extra' in parsed, false);
});

test('il limite dei candidati ignora gli oggetti annidati nel preambolo', () => {
  let example = '{"root":';
  for (let i = 0; i < 30; i++) example += '{"level":';
  example += '{"value":"example"}' + '}'.repeat(31);
  const raw = `Esempio strutturato: ${example} Risposta finale: {"id":"final","slugs":{"it":"final"}}`;

  const parsed = JSON.parse(repairLlmJson(raw));
  assert.equal(parsed.id, 'final');
  assert.equal(parsed.slugs.it, 'final');
});

test('un esempio JSON nella coda non sostituisce una risposta gia\' chiusa', () => {
  const raw = 'Risposta finale: {"id":"real","slugs":{"it":"real"}}. Nota: esempio da ignorare {"id":"example","slugs":{"it":"example"},"extra":"piu lungo"}';
  const parsed = JSON.parse(repairLlmJson(raw));
  assert.equal(parsed.id, 'real');
  assert.equal(parsed.slugs.it, 'real');
  assert.equal('extra' in parsed, false);
});

test('non inserisce una virgola dentro una stringa con virgolette non escapate', () => {
  const raw = '{"body1":"prosa "quoted } "key": testo","next":"ok"}';
  const parsed = JSON.parse(repairLlmJson(raw));
  assert.equal(parsed.body1, 'prosa "quoted } "key": testo');
  assert.equal(parsed.next, 'ok');
});

function millis(fn) {
  const t0 = performance.now();
  const out = fn();
  return { ms: performance.now() - t0, out };
}

test('la riparazione TORNA sul caso che prima esplodeva (n=30, 616 char)', { timeout: 60_000 }, () => {
  // Prima della fix: ~11 minuti, estrapolati dal ×2,4 per ripetizione misurato
  // fra n=20 (668 ms) e n=25 (21.270 ms). Dopo: 3,6 ms.
  const { ms, out } = millis(() => fixJsonStringBody(pseudoJsonInProse(30), { fixAsterisks: true }));
  assert.ok(typeof out === 'string' && out.length > 0, 'la riparazione non ha prodotto niente');
  assert.ok(ms < 10_000, `616 caratteri hanno richiesto ${ms.toFixed(0)} ms: la ricorsione e' di nuovo esponenziale`);
});

test('la riparazione TORNA su una risposta della taglia vera (~30 KB)', { timeout: 120_000 }, () => {
  // 30 KB e' la taglia normale di una risposta di generazione articolo. Prima
  // della fix questo caso non tornava affatto — ed e' esattamente quello che
  // la run 32130136859 ha vissuto per dieci minuti prima di essere uccisa.
  const raw = pseudoJsonInProse(1500);
  assert.ok(raw.length > 29_000, `il fixture e' sceso a ${raw.length} caratteri: non descrive piu' una risposta vera`);
  const { ms, out } = millis(() => fixJsonStringBody(raw, { fixAsterisks: true }));
  assert.ok(typeof out === 'string' && out.length > 0, 'la riparazione non ha prodotto niente');
  assert.ok(ms < 20_000, `30 KB hanno richiesto ${ms.toFixed(0)} ms: la riparazione e' di nuovo superlineare`);
});

test('30 KB non sfondano lo stack — la profondita\' non e\' limitata dal numero di chiavi', { timeout: 120_000 }, () => {
  // Il commento di `looksLikeJsonContinuation` sosteneva che la catena «non
  // puo' accumulare profondita' di stack oltre il numero di chiavi». Vero, e
  // irrilevante: le chiavi qui sono 1500. Togliendo solo il ricalcolo
  // esponenziale, lo stesso input arrivava in fondo alla catena e usciva con
  // `RangeError: Maximum call stack size exceeded` — misurato prima di
  // convertire la coppia mutuamente ricorsiva in macchina a stati.
  assert.doesNotThrow(
    () => fixJsonStringBody(pseudoJsonInProse(1500), { fixAsterisks: true }),
    'la catena di lookahead consuma ancora un frame di stack per chiave',
  );
  assert.doesNotThrow(
    () => findMatchingClose(pseudoJsonInProse(1500), 0, true),
    'findMatchingClose consuma ancora un frame di stack per chiave',
  );
});

test('la fix non cambia UNA risposta: tabella di equivalenza', () => {
  // Memoizzazione e trampolino sono trasformazioni che devono essere
  // invisibili. Questa tabella e' stata registrata ESEGUENDO la versione
  // pre-fix (origin/main a 91b951a5) sugli stessi input: se un giro futuro di
  // «ottimizzazione» cambia una decisione sulle virgolette, cade qui e non in
  // produzione su un articolo scartato.
  //
  // Oltre alla tabella, la coppia e' stata confrontata su 80.000 input
  // generati (20.000 corpi × 2 valori di fixAsterisks × 2 funzioni esportate):
  // zero differenze.
  const casi = [
    '{"body1":"la cosiddetta "tassa sulla salute" resta in vigore."}',
    '{"body1":"i requisiti sono: "residenza": "Italia", "durata": "12 mesi"."}',
    '{"body1":"un elenco: "uno", "due", "tre"; e poi basta."}',
    '{"body1":"testo **con asterischi** e "virgolette", ok."}',
    '{"title":"x","body1":"chiusura mancante}',
    '{"body1":"nidificato {"k": ["v"]} dentro la prosa."}',
    '{"body1":"gia\\" escapata correttamente."}',
    '{"body1":"frase con : due punti nudi, e "citazione": segue."}',
  ];
  // NB: le righe 2, 5 e 6 registrano un esito IMPERFETTO (la disambiguazione
  // non chiude dove un umano chiuderebbe). Sono qui apposta: questo test pinna
  // l'equivalenza fra prima e dopo, non la bonta' della decisione. Migliorarla
  // e' un altro lavoro, e questa tabella e' la rete che lo terra' onesto.
  const atteso = [
    '{"body1":"la cosiddetta \\"tassa sulla salute\\" resta in vigore."}',
    '{"body1":"i requisiti sono: \\"residenza\\": \\"Italia", "durata": "12 mesi\\"."}',
    '{"body1":"un elenco: \\"uno\\", \\"due\\", \\"tre\\"; e poi basta."}',
    '{"body1":"testo **con asterischi** e \\"virgolette\\", ok."}',
    '{"title\\":\\"x\\",\\"body1\\":\\"chiusura mancante}',
    '{"body1":"nidificato {\\"k": ["v"]} dentro la prosa."}',
    '{"body1":"gia\\" escapata correttamente."}',
    '{"body1":"frase con : due punti nudi, e \\"citazione\\": segue."}',
  ];
  for (let i = 0; i < casi.length; i++) {
    assert.equal(
      fixJsonStringBody(casi[i], { fixAsterisks: true }),
      atteso[i],
      `caso ${i}: la decisione sulle virgolette e' cambiata`,
    );
  }
});
