/**
 * Issue #983 (follow-up di #945) — la telemetria di fine run puo' non arrivare
 * nel log delle run `deferred`/`error`.
 *
 * IL FATTO. Su POSIX Node scrive su stdout/stderr in modo ASINCRONO quando sono
 * pipe, ed e' il caso di ogni job GitHub Actions. `process.exit()` non aspetta
 * quelle write: quello che e' ancora nel buffer del flusso viene scartato.
 * Misura con una pipe reale, prima del fix: 200.013 byte stampati, 65.536
 * arrivati, ultima riga persa.
 *
 * PERCHE' CONTA QUI E NON IN GENERALE. Le run che escono da `process.exit()`
 * sono esattamente quelle `deferred`/`error`/`skipped` — le altre finiscono per
 * esaurimento dell'event loop, e li' Node svuota da solo. La riga
 * `resolver flaps:` del riepilogo AI e' il denominatore di #848 item 3, e le
 * run con `silent` diverso da zero sono quelle deferite: se la riga sparisce
 * proprio da quelle, il campione torna a essere lo «zero indistinguibile da
 * nessuna misura» che il riepilogo esisteva per togliere di mezzo. Un
 * denominatore che si perde e' peggio di uno assente, perche' si legge come uno
 * zero.
 *
 * COSA PINNA. Il comportamento dell'helper contro una pipe vera (child process,
 * non un mock: il difetto vive nel trasporto, non nella logica) e il WIRING dei
 * percorsi terminali, che e' la meta' che una regressione romperebbe per prima
 * — `create-article.mjs` non e' importabile qui (761 KB, closure su
 * sharp/undici, e in CI non c'e' `node_modules`), quindi si pinna sul sorgente
 * come fa gia' `ai-models-host-unreachable.test.mjs` per lo stesso file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('../scripts/lib/drain-stdio.mjs', import.meta.url));
const srcOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf-8');

const PAYLOAD_BYTES = 400_000; // ben oltre i 64 KB del buffer di una pipe
const TAIL = 'CODA-DELLA-TELEMETRIA';

/**
 * Esegue un figlio che stampa `PAYLOAD_BYTES` e poi la riga di coda, e infine
 * esce con `process.exit()`.
 *
 * @param {{drain: boolean}} opts
 * @returns {Promise<{code: number, out: string}>}
 */
function runChild({ drain }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'drain-stdio-'));
  const file = path.join(dir, 'child.mjs');
  writeFileSync(file, [
    drain ? `import { exitAfterDrain } from ${JSON.stringify(LIB)};` : '',
    `console.log('x'.repeat(${PAYLOAD_BYTES}));`,
    `console.log(${JSON.stringify(TAIL)});`,
    drain ? 'await exitAfterDrain(7);' : 'process.exit(7);',
  ].join('\n'));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    const collect = () => { child.stdout.on('data', (c) => chunks.push(c)); };
    // Il caso senza drain legge SOLO dopo l'uscita del figlio: cosi' la pipe si
    // riempie e la perdita e' deterministica invece di dipendere da quanto in
    // fretta il genitore consuma. Il caso con drain deve leggere subito, o il
    // drain non potrebbe mai rientrare (ed e' il punto: aspetta davvero).
    if (drain) collect();
    child.on('error', reject);
    // Il lettore del caso senza drain si attacca all'uscita del figlio, non
    // alla chiusura della pipe: quello che il figlio ha davvero consegnato al
    // kernel resta leggibile, quello che era ancora nel suo buffer no.
    child.on('exit', () => { if (!drain) collect(); });
    child.on('close', (code) => {
      // Un tick per far arrivare i dati rimasti nel buffer della pipe.
      setImmediate(() => setImmediate(() => {
        resolve({ code: code ?? -1, out: Buffer.concat(chunks).toString('utf-8') });
      }));
    });
  });
}

describe('drain di stdout prima di process.exit (#983)', () => {
  it('senza drain la coda del log si perde su una pipe', async () => {
    const { out } = await runChild({ drain: false });
    assert.ok(out.length > 0, 'precondizione: qualcosa deve pur essere arrivato');
    assert.ok(
      out.length < PAYLOAD_BYTES,
      `atteso un troncamento, arrivati ${out.length} byte su ${PAYLOAD_BYTES}`,
    );
    assert.ok(!out.includes(TAIL), 'la riga di coda non doveva arrivare: e\' il difetto');
  });

  it('`exitAfterDrain` consegna tutto, riga di coda inclusa, e mantiene il codice', async () => {
    const { code, out } = await runChild({ drain: true });
    assert.equal(code, 7, 'il drain non deve cambiare il codice di uscita');
    assert.ok(out.includes(TAIL), `riga di coda persa: arrivati ${out.length} byte`);
    assert.ok(
      out.length >= PAYLOAD_BYTES,
      `atteso il payload intero, arrivati ${out.length} byte`,
    );
  });

  it('un flusso gia\' vuoto non fa aspettare nessuno', async () => {
    const { drainStdio } = await import('../scripts/lib/drain-stdio.mjs');
    // Nessuna write in coda: deve rientrare senza armare timer ne' promesse
    // appese — un'uscita non puo' pagare 2s per un buffer vuoto.
    const t0 = Date.now();
    await drainStdio(60_000);
    assert.ok(Date.now() - t0 < 1_000, 'il corto circuito sul buffer vuoto non ha funzionato');
  });
});

describe('wiring: ogni percorso terminale drena prima di uscire (#983)', () => {
  const createArticle = srcOf('../scripts/create-article.mjs');

  it('`exitAfterFlush` drena DOPO il flush e PRIMA di process.exit', () => {
    const start = createArticle.indexOf('async function exitAfterFlush(code) {');
    assert.notEqual(start, -1, 'delimitatore di exitAfterFlush da aggiornare');
    const endRel = createArticle.slice(start).indexOf('\n}\n');
    assert.notEqual(endRel, -1, 'chiusura di exitAfterFlush non trovata');
    const body = createArticle.slice(start, start + endRel);

    const iFlush = body.indexOf('flushScoresBeforeExit()');
    const iDrain = body.indexOf('drainStdio(');
    const iExit = body.indexOf('process.exit(');
    assert.notEqual(iDrain, -1, 'exitAfterFlush deve drenare stdout/stderr');
    assert.match(body, /await\s+drainStdio\(/, 'il drain va atteso, non lanciato e dimenticato');
    // L'ordine e' il fix: anche il flush del ledger stampa, quindi un drain
    // messo prima lascerebbe fuori proprio le sue righe.
    assert.ok(iFlush < iDrain, 'il drain deve venire DOPO il flush del ledger');
    assert.ok(iDrain < iExit, 'il drain deve venire PRIMA di process.exit');
    // Il tetto del drain e' un timer `unref()`ato: senza `exitCode` un flusso
    // fermo farebbe uscire il processo 0, cioe' una run deferita riportata come
    // riuscita.
    assert.ok(
      body.indexOf('process.exitCode = code') !== -1
      && body.indexOf('process.exitCode = code') < iDrain,
      'exitCode va impostato prima del drain',
    );
  });

  it('nessun `process.exit()` nudo resta in create-article.mjs', () => {
    // `exitAfterFlush` e' l'unica uscita del file (vedi la sua intestazione) e
    // il fallback della fermata cooperativa passa da `exitAfterDrain`: ogni
    // altra occorrenza sarebbe un percorso che esce senza drenare.
    const bare = (createArticle.match(/^\s*(?:await\s+)?process\.exit\(/gm) || []);
    assert.equal(
      bare.length,
      1,
      `atteso un solo process.exit() (quello di exitAfterFlush), visti ${bare.length}`,
    );
    assert.match(
      createArticle,
      /exitAfterDrain\(143\)/,
      'il fallback della fermata cooperativa deve drenare la sua ::warning:: prima di uscire',
    );
  });

  it('i signal handler del ledger escono via `exitAfterDrain`', () => {
    const aiModels = srcOf('../scripts/lib/ai-models.mjs');
    const start = aiModels.indexOf('function _registerExitHooks() {');
    assert.notEqual(start, -1, 'delimitatore di _registerExitHooks da aggiornare');
    const hooks = aiModels.slice(start, start + aiModels.slice(start).indexOf('\n}\n'));
    for (const sig of ['SIGINT', 'SIGTERM']) {
      const line = hooks.split('\n').find((l) => l.includes(`'${sig}'`));
      assert.ok(line, `handler ${sig} non trovato`);
      assert.match(line, /exitAfterDrain\(/, `${sig} esce senza drenare: ${line}`);
      assert.doesNotMatch(line, /process\.exit\(/, `${sig} esce ancora a mano: ${line}`);
    }
  });

  it('il fatal handler di batch-add-faq drena lo stack che ha appena stampato', () => {
    const batch = srcOf('../scripts/batch-add-faq-to-articles.mjs');
    const start = batch.indexOf('main().catch(');
    assert.notEqual(start, -1, 'entry point di batch-add-faq-to-articles.mjs da aggiornare');
    const tail = batch.slice(start);
    assert.match(tail, /exitAfterDrain\(1\)/, 'il fatal handler deve drenare prima di uscire');
    assert.doesNotMatch(tail, /^\s*process\.exit\(1\);/m, 'uscita a mano ancora presente');
  });
});
