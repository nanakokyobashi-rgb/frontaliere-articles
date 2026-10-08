/**
 * Ogni copertina dedicata `public/images/blog/article-*.webp` toccata dalla
 * PR deve avere una provenienza governata che ne prova i byte.
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
 * romperlo è la PR che aggiunge il file o il record, ed è lì che va fermato.
 * Il perimetro viene dal diff contro la base della PR, non dal disco: così una
 * copertina già pubblicata ma lasciata senza record da un'altra PR resta un
 * finding esplicito di quella PR, senza bloccare una riparazione indipendente.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imageRecordForPath } from '../scripts/lib/blog-image-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function gitText(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
}

function pullRequestBase() {
  const explicitBase = process.env.GITHUB_BASE_SHA;
  if (/^[0-9a-f]{40}$/iu.test(explicitBase || '')) return explicitBase;
  const base = gitText(['merge-base', 'HEAD', 'origin/main']);
  assert.match(base, /^[0-9a-f]{40}$/iu, 'base della PR illeggibile: il gate non può calcolare il perimetro');
  return base;
}

function registryRecordsAt(revision) {
  const raw = revision === 'WORKTREE'
    ? readFileSync(path.join(ROOT, 'data/generated-image-registry.json'), 'utf8')
    : gitText(['show', `${revision}:data/generated-image-registry.json`]);
  const registry = JSON.parse(raw);
  return new Map((registry.assets || [])
    .filter((record) => typeof record?.assetId === 'string'
      && typeof record?.imageUrl === 'string'
      && /^\/images\/blog\/article-[^/]+\.webp$/u.test(record.imageUrl))
    .map((record) => [record.assetId, record]));
}

function relevantDedicatedCovers(base) {
  const changedFiles = gitText(['diff', '--name-only', '--diff-filter=AMR', `${base}...HEAD`])
    .split('\n')
    .filter((file) => /^public\/images\/blog\/article-[^/]+\.webp$/u.test(file))
    .map((file) => file.replace(/^public/u, ''));
  const before = registryRecordsAt(base);
  const after = registryRecordsAt('WORKTREE');
  const changedRecords = [...after.values()]
    .filter((record) => JSON.stringify(before.get(record.assetId)) !== JSON.stringify(record))
    .map((record) => record.imageUrl);
  return [...new Set([...changedFiles, ...changedRecords])].sort();
}

test('ogni copertina dedicata toccata dalla PR ha una provenienza governata che ne prova i byte', (t) => {
  const covers = relevantDedicatedCovers(pullRequestBase());
  if (covers.length === 0) {
    t.skip('la PR non tocca una copertina dedicata né il suo record');
    return;
  }
  const ungoverned = covers
    .filter((imagePath) => !imageRecordForPath(ROOT, imagePath, { strict: true }));
  assert.deepEqual(
    ungoverned,
    [],
    `${ungoverned.length} copertine dedicate toccate dalla PR su ${covers.length} senza provenienza governata, `
      + 'oppure con un record che non corrisponde ai byte del file.\n'
      + 'Una copertina generata vuole il suo record in data/generated-image-registry.json '
      + '(appendGeneratedImageRecord, con sha256 e bytes del file pubblicato); una copertina '
      + 'da Wikimedia Commons vuole il record di credito.\n  '
      + ungoverned.join('\n  '),
  );
});
