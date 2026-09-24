/**
 * events-image-mirror.test.mjs — invarianti della pipeline di mirroring
 * immagini eventi portata dal sito (issue #694, commit del sito
 * `8bb8d125`/`c32b196a`/`f3d28485` del 2026-08-20).
 *
 * ## Cosa sorveglia
 *
 * Il mirroring non scarica piu' i byte verbatim: li ri-encoda in WebP via
 * `sharp` e tiene l'indice di cio' che ha gia' mirrorato in
 * `data/events-image-manifest.json`, perche' le immagini NON sono piu'
 * committate. Le tre parti sono un unico meccanismo, e ognuna ha un modo di
 * rompersi in silenzio:
 *
 *   - manifest illeggibile trattato come `{}` invece che come `false` →
 *     l'indice tracciato viene RIscritto con le poche entry del run corrente,
 *     e il run successivo ri-scarica l'intero catalogo dai siti sorgente:
 *     esattamente il traffico che la regola no-hotlink esiste per evitare;
 *   - probe del manifest DOPO il `fetch` → il dedup non serve piu' a niente,
 *     perche' la richiesta di rete e' gia' partita;
 *   - `public/images/events/` ignorato come DIRECTORY invece che come `/*` +
 *     negazione → git non puo' ri-includere `catalog/`, e l'eccezione muore
 *     senza dirlo.
 *
 * ## Perche' e' un test sul TESTO e non sul comportamento
 *
 * `generator/scripts/lib/events-utils.mjs` non e' importabile sotto
 * `node --test`: importa `../../data/municipalities.ts` (Node ESM puro non
 * carica TypeScript) e la suite gira senza `npm ci`, mentre `sharp` e' una
 * dipendenza npm. Lo stesso vincolo per cui il build usa `tsx` e non `node`
 * (AGENTS.md, Build e test). Si legge il sorgente, come
 * `loop-scripts-closure.test.mjs`, senza eseguire niente.
 *
 * Eccezione: il lettore del body (`readEventImageBody` e il suo cleanup) usa
 * solo builtin, quindi in fondo al file se ne estraggono le funzioni dal
 * sorgente e si ESEGUONO (#1745 FU-002/FU-003).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'generator/scripts/lib/events-utils.mjs'), 'utf8');

/** Corpo della funzione `name` (dalla firma alla prima `\n}` a colonna zero). */
function body(name) {
  const start = SRC.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `funzione ${name} assente da events-utils.mjs`);
  const end = SRC.indexOf('\n}', start);
  assert.notEqual(end, -1, `funzione ${name} senza chiusura a colonna zero`);
  return SRC.slice(start, end);
}

test('il manifest committato e\' un oggetto JSON: qualunque altra forma fa fallire il caricamento a ogni run', () => {
  const file = path.join(ROOT, 'data/events-image-manifest.json');
  assert.ok(fs.existsSync(file), 'data/events-image-manifest.json non esiste');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  for (const [id, ext] of Object.entries(parsed)) {
    assert.equal(typeof ext, 'string', `entry ${id} non mappa a una stringa`);
    assert.match(ext, /^(?:webp|jpg|jpeg|png|gif|avif)$/, `estensione inattesa per ${id}: ${ext}`);
  }
});

test('loadEventImageManifest fallisce CHIUSO: manifest illeggibile => false, non un oggetto vuoto', () => {
  const fn = body('loadEventImageManifest');
  assert.match(fn, /catch\s*\([^)]*\)\s*\{[\s\S]*eventImageManifest = false/);
  assert.doesNotMatch(fn, /catch\s*\([^)]*\)\s*\{[\s\S]*eventImageManifest = \{\}/);
});

test('recordEventImage non scrive nulla quando il manifest non e\' stato caricato', () => {
  const fn = body('recordEventImage');
  const guard = fn.indexOf('=== false) return');
  assert.notEqual(guard, -1, 'manca la guardia `manifest === false`');
  assert.ok(guard < fn.indexOf('writeFileSync'), 'la guardia deve precedere la scrittura');
});

test('il path del manifest e\' risolto lazy e sovrascrivibile, cosi\' un test non riscrive l\'indice tracciato', () => {
  const fn = body('eventImageManifestPath');
  assert.match(fn, /process\.env\.EVENTS_IMAGE_MANIFEST_PATH/);
  // Un `const X = path.join(REPO_ROOT, EVENT_IMAGE_MANIFEST_REL)` a livello di
  // modulo riporterebbe il path a essere fissato all'import, vanificando il seam.
  assert.doesNotMatch(SRC, /^const \w+ = path\.join\(REPO_ROOT, EVENT_IMAGE_MANIFEST_REL\)/m);
});

test('mirrorEventImage interroga il manifest PRIMA di toccare la rete', () => {
  const fn = body('mirrorEventImage');
  const probe = fn.indexOf('loadEventImageManifest()');
  const network = fn.indexOf('await fetch(');
  assert.notEqual(probe, -1, 'mirrorEventImage non consulta il manifest');
  assert.notEqual(network, -1);
  assert.ok(probe < network, 'il probe del manifest deve precedere il fetch');
  // Il fallback su disco resta: dentro un singolo run i file mirrorati sono
  // l'unico dedup rimasto se il manifest non ha caricato.
  assert.ok(fn.indexOf('existsSync') > -1 && fn.indexOf('existsSync') < network);
  // Ogni immagine viene registrata subito dopo la scrittura, non a fine run:
  // questo job ha una storia di kill da `timeout-minutes` prima del commit finale.
  const write = fn.indexOf('writeFileSync(path.join(EVENT_IMAGE_DIR');
  const record = fn.indexOf('recordEventImage(');
  assert.ok(write > -1 && record > write, 'recordEventImage deve seguire la scrittura del file');
});

test('encodeEventImage limita ENTRAMBI gli assi e non ingrandisce mai un file gia\' ottimizzato', () => {
  const fn = body('encodeEventImage');
  assert.match(fn, /fit: 'inside'/);
  assert.match(fn, /width: EVENT_IMAGE_MAX_WIDTH/);
  // Senza il bound sull'altezza una sorgente ritratto restava altissima.
  assert.match(fn, /height: EVENT_IMAGE_MAX_HEIGHT/);
  assert.match(fn, /withoutEnlargement: true/);
  // Re-encode piu' grande dell'originale => si tiene l'originale.
  assert.match(fn, /out\.length >= buf\.length/);
  // sharp che manca o non decodifica non deve costare l'immagine.
  assert.match(fn, /catch[\s\S]*return \{ buf, ext: originalExt \}/);
});

test('mirrorEventImage legge il body in streaming e cancella le risposte oltre il cap', () => {
  const readerFn = body('readEventImageBody');
  assert.match(readerFn, /content-length/);
  assert.match(readerFn, /getReader/);
  assert.match(readerFn, /reader\.read\(\)/);
  assert.match(readerFn, /reader\.cancel\(\)/);
  assert.doesNotMatch(readerFn, /arrayBuffer\(\)/);

  const mirrorFn = body('mirrorEventImage');
  assert.match(mirrorFn, /cancelEventImageResponse/);
  assert.match(mirrorFn, /readEventImageBody/);
});

test('il cleanup del body e del reader ha un tetto e non puo\' bloccare il crawler', () => {
  const cleanupFn = body('awaitEventImageCleanup');
  assert.match(SRC, /EVENT_IMAGE_CANCEL_TIMEOUT_MS\s*=\s*1_000/);
  assert.match(cleanupFn, /Promise\.race/);
  assert.match(cleanupFn, /setTimeout/);
  assert.match(cleanupFn, /clearTimeout/);

  const responseFn = body('cancelEventImageResponse');
  assert.match(responseFn, /awaitEventImageCleanup/);
  assert.doesNotMatch(responseFn, /await\s+response\?\.body\?\.cancel/);

  const readerFn = body('readEventImageBody');
  assert.equal((readerFn.match(/awaitEventImageCleanup\(\(\) => reader\.cancel/g) || []).length, 2);
});

test('sharp e\' una dipendenza dichiarata: l\'import dinamico deve poter risolvere', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies?.sharp || pkg.devDependencies?.sharp, 'sharp assente da package.json');
});

test('.gitignore esclude le immagini mirrorate senza uccidere l\'eccezione catalog/', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  assert.ok(lines.includes('public/images/events/*'), 'manca il pattern `/*`');
  assert.ok(lines.includes('!public/images/events/catalog/'), 'manca la negazione per catalog/');
  // Con la directory esclusa in blocco git non puo' ri-includere nulla dentro.
  assert.ok(!lines.includes('public/images/events/'), 'pattern a directory: la negazione sarebbe morta');
  // L'indice deve restare tracciato: e' cio' che sopravvive senza i byte.
  assert.ok(!lines.some((l) => l.includes('events-image-manifest')), 'il manifest non va ignorato');
});

// ── Comportamento eseguito del lettore del body (#1745 FU-002/FU-003) ──────
// Il modulo non e' importabile sotto `node --test` (vedi l'intestazione), ma il
// lettore del body usa solo builtin: se ne estraggono le funzioni dal sorgente
// e si ESEGUONO contro stream finti e contro la `Response` built-in di Node
// (undici), cioe' l'implementazione fetch con cui il crawler gira in CI.
function loadBodyReader() {
  const constant = SRC.match(/^const EVENT_IMAGE_CANCEL_TIMEOUT_MS = [^;]+;$/m);
  assert.ok(constant, 'EVENT_IMAGE_CANCEL_TIMEOUT_MS assente');
  const names = ['awaitEventImageCleanup', 'cancelEventImageResponse', 'releaseEventImageReader', 'readEventImageBody'];
  const source = [constant[0], ...names.map((name) => `${body(name)}\n}`)].join('\n\n');
  // eslint-disable-next-line no-new-func
  return new Function('Buffer', `${source}\nreturn { readEventImageBody };`)(Buffer);
}

function fakeResponse(reader, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    body: { getReader: () => reader, cancel: async () => {} },
  };
}

function readerOf(chunks, extra = {}) {
  const queue = chunks.map((c) => Uint8Array.from(c));
  return {
    read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }),
    cancel: async () => {},
    releaseLock() {},
    ...extra,
  };
}

/** Registra le dimensioni richieste a Buffer.allocUnsafe durante `fn`. */
async function recordAllocations(fn) {
  const original = Buffer.allocUnsafe;
  const sizes = [];
  Buffer.allocUnsafe = function patched(size, ...rest) {
    sizes.push(size);
    return original.call(this, size, ...rest);
  };
  try {
    return { result: await fn(), sizes };
  } finally {
    Buffer.allocUnsafe = original;
  }
}

test('FU-002: una risposta chunked senza Content-Length non riserva il cap da 20 MiB', async () => {
  const { readEventImageBody } = loadBodyReader();
  const cap = 20 * 1024 * 1024;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3]));
      controller.enqueue(Uint8Array.from([4, 5]));
      controller.close();
    },
  }));
  assert.equal(response.headers.get('content-length'), null);
  const { result, sizes } = await recordAllocations(() => readEventImageBody(response, cap));
  assert.deepEqual([...result], [1, 2, 3, 4, 5]);
  assert.ok(sizes.every((size) => size < 1024 * 1024), `allocazione sproporzionata: ${sizes.join(', ')}`);
});

test('FU-002: con Content-Length dichiarato si prealloca la lunghezza dichiarata e il cap resta per risposta', async () => {
  const { readEventImageBody } = loadBodyReader();
  const { result, sizes } = await recordAllocations(
    () => readEventImageBody(fakeResponse(readerOf([[9, 8], [7]]), { 'content-length': '3' }), 10),
  );
  assert.deepEqual([...result], [9, 8, 7]);
  assert.ok(sizes.includes(3));
  assert.ok(!sizes.includes(10), 'allocato il cap invece della lunghezza dichiarata');

  // Chunked oltre il cap: rifiutata e cancellata anche senza buffer preallocato.
  let cancelled = false;
  const over = await readEventImageBody(
    fakeResponse(readerOf([[1, 2, 3, 4], [5, 6, 7]], { cancel: async () => { cancelled = true; } })),
    6,
  );
  assert.equal(over, null);
  assert.equal(cancelled, true);
});

test('FU-003: un releaseLock() che lancia non trasforma un\'immagine letta in null', async () => {
  const { readEventImageBody } = loadBodyReader();
  const reader = readerOf([[1, 2], [3]], {
    releaseLock() { throw new TypeError('Invalid state: reader released with pending read requests'); },
  });
  const result = await readEventImageBody(fakeResponse(reader), 10);
  assert.deepEqual([...result], [1, 2, 3]);

  // Il verdetto oversize resta null e l'errore di lettura resta quello originale.
  const over = await readEventImageBody(fakeResponse(readerOf([[1, 2, 3]], {
    releaseLock() { throw new TypeError('released'); },
  })), 2);
  assert.equal(over, null);
  const failing = readerOf([], {
    read: async () => { throw new Error('upstream reset'); },
    releaseLock() { throw new TypeError('released'); },
  });
  await assert.rejects(readEventImageBody(fakeResponse(failing), 10), /upstream reset/);
});

test('FU-003: con la Response built-in (undici) cancel + releaseLock sul ramo oversize non lanciano', async () => {
  const { readEventImageBody } = loadBodyReader();
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(4)); },
  }));
  const started = Date.now();
  assert.equal(await readEventImageBody(response, 10), null);
  assert.ok(Date.now() - started < 1_000, 'cleanup appeso oltre il tetto');
  assert.equal(response.body.locked, false, 'il lock del reader non e\' stato rilasciato');
});
