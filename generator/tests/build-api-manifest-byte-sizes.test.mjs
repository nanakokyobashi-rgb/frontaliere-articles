/**
 * `manifest.files` deve contare BYTE, non code unit UTF-16. Run with `node --test`.
 *
 * IL DIFETTO. `dist/api/manifest.json` documenta `files` come «per-file byte
 * sizes», ed e' l'unico modo che un consumer ha di rifiutare un payload
 * troncato *prima* di usarlo: si confronta la dimensione dichiarata con quella
 * ricevuta (`Content-Length`, o il file su disco). I writer di
 * `scripts/build-api.mjs` registravano pero' `String.length`, che conta code
 * unit UTF-16. Su un corpus italiano/tedesco ogni accento, ogni virgoletta
 * tipografica e ogni emoji costa 2-4 byte e 1 code unit, quindi i due numeri
 * divergono su qualunque documento reale.
 *
 * Misurato il 2026-09-05 sul corpus pubblicato (3781 articoli): 24 delle 29
 * voci sbagliate, da +238 su `meta-ch-en.json` fino a +16.941 su
 * `meta-de.json`. Il confronto lato consumer quindi non falliva su un file
 * troncato: falliva SEMPRE — che e' il modo piu' rapido per far disattivare il
 * controllo a chi lo consuma, e lasciare passare in silenzio proprio il set
 * troncato che il manifest esisteva per intercettare.
 *
 * PERCHE' UN TEST E NON SOLO LA FIX. La differenza fra `s.length` e
 * `Buffer.byteLength(s)` e' invisibile rileggendo un diff, non fa fallire
 * nessuna build, e su un fixture ASCII i due valori COINCIDONO — quindi anche
 * un test scritto distrattamente resterebbe verde. Qui si asserisce sui
 * sorgenti: nessun writer registra piu' una lunghezza di stringa in `written`,
 * e il gate finale che ricontrolla il manifest contro il disco e' presente.
 * Il gate e' la rete a runtime; questo test e' la rete sul gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(resolve(ROOT, 'scripts/build-api.mjs'), 'utf-8');

test('nessun writer registra una lunghezza di stringa in manifest.files', () => {
  const offenders = SRC.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /written\[[^\]]+\]\s*=/.test(line))
    .filter(([, line]) => !/=\s*byteSize\(/.test(line));
  assert.deepEqual(
    offenders,
    [],
    `written[...] deve ricevere byteSize(...), non .length:\n${offenders.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n')}`,
  );
});

test('byteSize misura i byte UTF-8, non i code unit', () => {
  const decl = /const byteSize = \(text\) => (.+);/.exec(SRC);
  assert.ok(decl, 'scripts/build-api.mjs deve definire byteSize');
  assert.equal(decl[1], "Buffer.byteLength(text, 'utf-8')");
});

test('il gate finale ricontrolla manifest.files contro i byte su disco', () => {
  assert.match(SRC, /manifest byte-size gate/);
  assert.match(SRC, /manifest\.files does not describe the bytes served/);
  // Il confronto deve leggere il manifest EMESSO, non l'oggetto in memoria:
  // altrimenti verifica se stesso e non puo' mai fallire.
  assert.match(SRC, /readFileSync\(path\.join\(OUT, 'manifest\.json'\), 'utf-8'\)\)\.files/);
  assert.match(SRC, /fs\.statSync\(path\.join\(OUT, name\)\)\.size/);
});

test('un contatore in code unit sarebbe davvero divergente sul testo del corpus', () => {
  // Ancora il difetto a un fatto, non a una preferenza di stile: i titoli
  // reali del corpus sono accentati, e su ASCII puro i due contatori
  // coincidono — un fixture sbagliato renderebbe il test cieco.
  const sample = '{"t":"Frontalieri: l’indennità è più alta a Zürich"}';
  assert.notEqual(Buffer.byteLength(sample, 'utf-8'), sample.length);
});
