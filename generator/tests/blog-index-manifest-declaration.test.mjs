/**
 * Gli shard `blog-index-*.json` devono essere dichiarati in `manifest.files`.
 * Run with `node --test`.
 *
 * IL DIFETTO (follow-up di #905, issue #921). `manifest.json` e' il primo file
 * che il sito legge: `counts` gli permette di rifiutare un set troncato *prima*
 * di usarlo, `files` di rifiutare un singolo payload troncato confrontando i
 * byte dichiarati col `Content-Length` servito. Ma `manifest.json` lo scrive
 * `build-api.mjs`, e registra solo cio' che scrive lui — mentre gli shard
 * `dist/api/data/blog-index-*.json`, che sono ESATTAMENTE i file da cui il sito
 * rende le liste (hub, archivio, homepage), li scrive `build-blog-index.mjs` in
 * uno step successivo di `publish-api.yml`.
 *
 * Restavano quindi l'unica parte della superficie pubblicata senza rete lato
 * consumer: difesi solo dai pavimenti del proprio produttore. Una lista
 * troncata e' il caso che il sito accetta e mostra — meno articoli di quelli
 * che ci sono, nessun errore da nessuna parte, e il sito non ribuilda.
 *
 * Lo stesso `readdir` piatto rendeva cieco il gate control-character di
 * `build-api.mjs` verso qualunque sottocartella di `dist/api/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declareApiArtifacts, byteSize } from '../../scripts/lib/api-manifest.mjs';
import { sliceFrom, sliceUntil } from './lib/anchored-slice.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Un `dist/api/` finto: manifest gia' scritto, piu' i file passati. */
function fixture(files = {}) {
  const api = mkdtempSync(join(tmpdir(), 'api-manifest-'));
  const declared = {};
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(api, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    declared[rel] = byteSize(text);
  }
  writeFileSync(join(api, 'manifest.json'), JSON.stringify({ schema: 1, counts: {}, files: declared }));
  return { api, declared };
}

test('gli shard entrano in manifest.files coi loro byte, accanto a quelli esistenti', () => {
  const { api } = fixture({ 'articles.json': '[{"id":"x"}]' });
  const shard = '{"version":1,"articles":[]}\n';
  const rel = 'data/blog-index-frontaliere-it.json';
  mkdirSync(join(api, 'data'), { recursive: true });
  writeFileSync(join(api, rel), shard);

  const total = declareApiArtifacts(api, { [rel]: byteSize(shard) });
  const manifest = JSON.parse(readFileSync(join(api, 'manifest.json'), 'utf-8'));
  assert.equal(manifest.files[rel], byteSize(shard));
  assert.equal(manifest.files['articles.json'], byteSize('[{"id":"x"}]'), 'le voci preesistenti restano');
  assert.equal(total, 2);
  assert.equal(manifest.schema, 1, 'il resto del manifest non viene toccato');
  assert.equal(manifest.files['manifest.json'], undefined, 'il manifest non descrive se stesso');
});

test('byteSize conta byte UTF-8, non code unit: un titolo accentato divergerebbe', () => {
  const shard = '{"title":"Frontalieri: l’indennità è più alta a Zürich"}\n';
  const { api } = fixture();
  mkdirSync(join(api, 'data'), { recursive: true });
  writeFileSync(join(api, 'data/s.json'), shard);
  assert.notEqual(byteSize(shard), shard.length, 'fixture cieco: su ASCII i due contatori coincidono');
  assert.doesNotThrow(() => declareApiArtifacts(api, { 'data/s.json': byteSize(shard) }));
  // Con `String.length` la stessa dichiarazione sarebbe stata rifiutata dal
  // gate qui sotto — che e' il punto: il gate legge il DISCO.
  assert.throws(
    () => declareApiArtifacts(api, { 'data/s.json': shard.length }),
    /does not describe the bytes served/,
  );
});

test('una dichiarazione che non combacia col disco viene rifiutata', () => {
  const { api } = fixture();
  mkdirSync(join(api, 'data'), { recursive: true });
  writeFileSync(join(api, 'data/s.json'), 'abc');
  assert.throws(
    () => declareApiArtifacts(api, { 'data/s.json': 99 }),
    (err) => {
      assert.match(err.message, /data\/s\.json: declared 99, on disk 3/);
      return true;
    },
  );
});

test('una voce dichiarata ma assente dal disco viene rifiutata, non ignorata', () => {
  // `statSync` su un path inesistente lancia ENOENT, che e' un rosso oscuro:
  // il messaggio deve dire quale artefatto manca.
  const { api } = fixture();
  assert.throws(
    () => declareApiArtifacts(api, { 'data/mancante.json': 10 }),
    /data\/mancante\.json: declared 10, missing on disk/,
  );
});

test('rivalida TUTTE le voci, non solo quelle appena aggiunte', () => {
  const { api } = fixture({ 'articles.json': '[1,2,3]' });
  // Un altro produttore tronca un artefatto gia' dichiarato dopo build-api.
  writeFileSync(join(api, 'articles.json'), '[1]');
  mkdirSync(join(api, 'data'), { recursive: true });
  writeFileSync(join(api, 'data/s.json'), 'ok');
  assert.throws(
    () => declareApiArtifacts(api, { 'data/s.json': 2 }),
    /articles\.json: declared 7, on disk 3/,
  );
});

test('senza manifest.json rifiuta invece di inventarne uno', () => {
  const api = mkdtempSync(join(tmpdir(), 'api-manifest-'));
  assert.throws(() => declareApiArtifacts(api, { 'data/s.json': 1 }), /manifest\.json not found/);
});

test('build-blog-index dichiara i suoi shard e rifiuta un set parziale', () => {
  const src = readFileSync(resolve(ROOT, 'scripts/build-blog-index.mjs'), 'utf-8');
  assert.match(src, /declareApiArtifacts\(API_ROOT, writtenShards\)/);
  // I byte dichiarati sono quelli del testo scritto, newline finale compreso.
  assert.match(src, /writtenShards\[path\.relative\(API_ROOT, file\)\] = byteSize\(text\)/);
  assert.match(src, /writtenShards\[path\.relative\(API_ROOT, fullFile\)\] = byteSize\(fullText\)/);
  // Il set e' un prodotto cartesiano chiuso: una voce mancante e' un set
  // troncato, e va rifiutata prima della pubblicazione.
  assert.match(src, /SECTIONS\.length \* LOCALES\.length \* 2/);
  assert.match(src, /refusing to publish a partial index set/);
  // Fuori da dist/api/ non c'e' un manifest da arricchire, e non se ne inventa uno.
  assert.match(src, /PUBLISHES_TO_API = OUT === DEFAULT_OUT/);
  assert.match(src, /if \(!failed && PUBLISHES_TO_API\)/);
});

test('il gate control-character di build-api scende nelle sottocartelle', () => {
  const src = readFileSync(resolve(ROOT, 'scripts/build-api.mjs'), 'utf-8');
  const gate = sliceFrom(src, 'control-character gate', { offset: -2000 });
  assert.doesNotMatch(
    sliceUntil(gate, 'control-character gate:'),
    /fs\s*\.?\s*readdirSync\(OUT\)\s*\.filter/,
    'un readdir piatto su OUT non vede data/blog-index-*.json',
  );
  assert.match(src, /const walk = \(dir\) => \{[\s\S]*?if \(e\.isDirectory\(\)\) walk\(abs\);/);
});
