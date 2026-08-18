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
const { fixJsonStringBody, findMatchingClose } = await import(MOD);

/** La forma esatta che fa esplodere la ricorsione: catena di coppie
 *  chiave/valore con virgolette non escapate, dentro un valore di prosa. */
const pseudoJsonInProse = (n) => `{"body1":"${'"chiave": "valore", '.repeat(n)}fine"}`;

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
