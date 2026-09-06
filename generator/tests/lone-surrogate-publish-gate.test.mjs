/**
 * Un surrogate spaiato non deve raggiungere `dist/api/`. Run with `node --test`.
 *
 * IL DIFETTO (follow-up di #905, issue #921). Sul percorso XML — sitemap e feed
 * — un lone surrogate veniva mappato su U+FFFD **sia** da `fs.writeFileSync`
 * **sia** da `Buffer.byteLength`. Dichiarato e disco quindi coincidevano, il
 * gate byte-size di `manifest.files` restava verde, e il documento pubblicato
 * era gia' alterato rispetto al corpus. E' il caso peggiore di AGENTS.md,
 * quello che non fallisce da solo — e il sito non ribuilda, quindi va live
 * subito.
 *
 * `JSON.stringify` protegge i writer JSON (well-formed stringify: emette
 * `\udXXX` invece di perdere il code unit), ma sul percorso XML non c'e'
 * l'equivalente: l'unica risposta corretta e' RIFIUTARE a monte, non sostituire
 * in silenzio. Sostituire e' esattamente cio' che gia' faceva `writeFileSync`.
 *
 * PERCHE' UN TEST. Il difetto non fa fallire niente: nessuna build rossa,
 * nessun byte fuori posto nel manifest, nessun errore lato consumer. Rileggendo
 * un diff e' invisibile. Il primo test qui sotto ancora la diagnosi al
 * comportamento reale di Node, cosi' che se un giorno cambiasse, il test dica
 * quale meta' del ragionamento e' decaduta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findLoneSurrogates,
  assertNoControlChars,
} from '../../scripts/lib/sanitize-control-chars.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HIGH = '\uD83D'; // high surrogate senza il suo low: meta' di U+1F600
const LOW = '\uDE00';
const PAIR = HIGH + LOW; // la coppia valida, cioe' il carattere intero
const REPLACEMENT = '�';

test('il difetto e reale: writeFileSync e byteLength concordano sul testo ALTERATO', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lone-surrogate-'));
  const file = join(dir, 'sitemap.xml');
  const xml = `<loc>https://frontaliereticino.ch/a${HIGH}b</loc>`;
  writeFileSync(file, xml);
  // Entrambi i lati del gate byte-size vedono lo stesso U+FFFD, quindi il gate
  // non puo' accorgersene: e' per questo che serve un rifiuto a monte.
  assert.equal(statSync(file).size, Buffer.byteLength(xml, 'utf-8'));
  const readBack = readFileSync(file, 'utf-8');
  assert.ok(readBack.includes(REPLACEMENT), 'il byte su disco e gia U+FFFD');
  assert.notEqual(readBack, xml, 'il pubblicato differisce dal corpus, senza che nulla fallisca');
  // E riletto dal disco non c'e' piu' niente da vedere: nessun surrogate.
  assert.deepEqual(findLoneSurrogates(readBack), []);
});

test('findLoneSurrogates trova gli spaiati e lascia stare le coppie valide', () => {
  assert.deepEqual(findLoneSurrogates(`Frontalieri ${PAIR} a Zurigo — nulla da segnalare`), []);
  assert.deepEqual(findLoneSurrogates(''), []);
  assert.deepEqual(findLoneSurrogates('indennità'), []);
  assert.deepEqual(findLoneSurrogates(`a${HIGH}b`), [{ index: 1, code: 0xd83d }]);
  assert.deepEqual(findLoneSurrogates(`a${LOW}b`), [{ index: 1, code: 0xde00 }]);
  // High in coda al testo: non c'e' un next da guardare, e resta spaiato.
  assert.deepEqual(findLoneSurrogates(`ab${HIGH}`), [{ index: 2, code: 0xd83d }]);
  // Due coppie valide di fila non devono generare falsi positivi per
  // disallineamento dell'indice dopo il consumo del low surrogate.
  assert.deepEqual(findLoneSurrogates(`${PAIR}${PAIR}`), []);
  // High seguito da un ALTRO high: il primo e' spaiato, il secondo pure.
  assert.deepEqual(findLoneSurrogates(`${HIGH}${HIGH}`), [
    { index: 0, code: 0xd83d },
    { index: 1, code: 0xd83d },
  ]);
  // Low seguito da high: ordine invertito, quindi nessuna coppia.
  assert.deepEqual(findLoneSurrogates(`${LOW}${HIGH}`), [
    { index: 0, code: 0xde00 },
    { index: 1, code: 0xd83d },
  ]);
  assert.equal(findLoneSurrogates(null).length, 0);
});

test('assertNoControlChars rifiuta un surrogate spaiato e nomina il file', () => {
  assert.doesNotThrow(() => assertNoControlChars(`<urlset>${PAIR}</urlset>`, 'sitemap-blog.xml'));
  assert.throws(
    () => assertNoControlChars(`<loc>x${HIGH}</loc>`, 'sitemap-blog.xml'),
    (err) => {
      assert.match(err.message, /sitemap-blog\.xml/);
      assert.match(err.message, /lone surrogate/);
      assert.match(err.message, /0xd83d@6/);
      assert.match(err.message, /refusing to publish/);
      return true;
    },
  );
  // Il control character resta la prima cosa segnalata: la diagnosi non
  // cambia per i casi gia' coperti.
  assert.throws(
    () => assertNoControlChars('<loc>x</loc>', 'rss.xml'),
    /XML-invalid control character/,
  );
});

test('i writer XML asseriscono PRIMA di scrivere, che e la sola posizione utile', () => {
  // Riletta dal disco la stringa e' gia' U+FFFD (primo test): un gate che
  // legge il file scritto non puo' vedere il surrogate, per costruzione.
  const src = readFileSync(resolve(ROOT, 'scripts/build-api.mjs'), 'utf-8');
  const lines = src.split('\n');
  const asserts = lines
    .map((line, i) => [i, line])
    .filter(([, line]) => /assertNoControlChars\((?!fs\.readFileSync)/.test(line));
  assert.ok(asserts.length >= 3, `attesi >=3 assert pre-write nei writer XML, trovati ${asserts.length}`);
  for (const [i] of asserts) {
    const next = lines.slice(i + 1, i + 4).join('\n');
    assert.match(next, /fs\.writeFileSync/, `l'assert a riga ${i + 1} deve precedere la writeFileSync`);
  }
});
