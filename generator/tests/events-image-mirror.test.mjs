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
