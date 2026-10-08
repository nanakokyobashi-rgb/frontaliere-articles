/**
 * Ogni copertina dedicata `public/images/blog/article-*.webp` deve avere una
 * provenienza governata che ne prova i byte.
 *
 * Il motore delle copertine scrive il file e il suo record nella stessa
 * transazione, quindi da quel lato l'invariante regge per costruzione. Non
 * regge per una PR che aggiunge il file a mano: l'08-10-2026 sono entrate così
 * la copertina di Malnate (PR 2468) e quella del Festival del Racconto
 * (PR 2471), con il record dichiarato soltanto nel repository del sito. Per il
 * generatore una copertina senza record è una copertina che non può
 * pubblicare: `imageRecordForPath` risponde `null` e l'articolo passa al
 * ripiego.
 *
 * Gira nel gate delle PR e non fra i gate sul contenuto di `main`: chi può
 * romperlo è la PR che aggiunge il file, ed è lì che va fermato. L'elenco viene
 * dall'indice di git, non dal disco, così un checkout parziale non lo svuota.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imageRecordForPath } from '../scripts/lib/blog-image-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function trackedDedicatedCovers() {
  return execFileSync('git', ['ls-files', '--', ':(glob)public/images/blog/article-*.webp'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\n').filter(Boolean);
}

test('ogni copertina dedicata tracciata ha una provenienza governata che ne prova i byte', () => {
  const covers = trackedDedicatedCovers();
  assert.ok(covers.length > 0, 'nessuna copertina dedicata nell\'indice di git: il perimetro del test è vuoto');
  const ungoverned = covers
    .map((file) => file.replace(/^public/, ''))
    .filter((imagePath) => !imageRecordForPath(ROOT, imagePath, { strict: true }));
  assert.deepEqual(
    ungoverned,
    [],
    `${ungoverned.length} copertine dedicate su ${covers.length} senza provenienza governata, `
      + 'oppure con un record che non corrisponde ai byte del file.\n'
      + 'Una copertina generata vuole il suo record in data/generated-image-registry.json '
      + '(appendGeneratedImageRecord, con sha256 e bytes del file pubblicato); una copertina '
      + 'da Wikimedia Commons vuole il record di credito.\n  '
      + ungoverned.join('\n  '),
  );
});
