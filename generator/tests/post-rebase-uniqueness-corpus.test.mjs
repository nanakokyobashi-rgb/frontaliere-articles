/**
 * post-rebase-uniqueness-corpus.test.mjs — il corpus VERO supera la premessa
 * del ricontrollo dopo il rebase.
 *
 * ## Il difetto che sorveglia
 *
 * `scripts/ci/check-post-rebase-uniqueness.mjs` gira nello step «Commit and
 * push» dei generatori, dopo un rebase, quando l'articolo e' gia' stato pagato:
 * LLM, quattro traduzioni, immagine. Prima di confrontare qualcosa pretende che
 * il meta IT di ogni sezione descriva esattamente gli id di registro e mappa
 * slug (`assertArticleMetaCoverage`); se non e' cosi' esce 2
 * (`POST_REBASE_UNIQUENESS_ERROR`) e lo step non pusha.
 *
 * Quella pretesa e' entrata l'8 ottobre 2026 (PR 2467) verificata solo su
 * fixture. Sul corpus era falsa dal 30 luglio: `content/blog-meta-it.ts`
 * portava le voci di due articoli ritirati, `naspi-disoccupazione-frontalieri`
 * e `tassa-salute-frontalieri-accordo-frontalieri`, assenti da registro e mappa
 * slug. Da quel merge ogni run che ha dovuto fare un rebase ha scartato il
 * proprio articolo: 37725348107 e 37725994362 (tutte e due con `ARTICLE: true`)
 * e 37738088947, in tre ore.
 *
 * Il difetto non era nell'articolo scartato ne' nel rebase: era nella BASE, e
 * nessun gate la guardava. Questo file la guarda con le stesse funzioni dello
 * script, cosi' una PR che la rompe diventa rossa prima del merge e un push di
 * un bot che la rompe apre la issue dei gate di contenuto, invece di costare un
 * articolo a ogni run.
 *
 * ## Perche' sta fra i gate di contenuto
 *
 * Legge registri, mappe slug, meta e ledger pubblicati, che i bot scrivono
 * direttamente su `main`. Su una PR lo esegue `generator-ci.yml` quando la PR
 * tocca `generator/**`; su `main` lo esegue `content-gates-main.yml` a ogni
 * push di contenuto.
 *
 * ## Anti-falso-verde
 *
 * Un lettore che non trova i file renderebbe verde ogni asserzione su zero
 * confronti. Quindi: il core deve avere sezioni, almeno una deve portare piu'
 * di cento id, e l'ultimo caso reintroduce una voce orfana sul meta letto dal
 * corpus e pretende che la premessa cada nominandola.
 *
 * Lancia con:
 *   node --test generator/tests/post-rebase-uniqueness-corpus.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  registryIdsOf,
  sectionSurfaces,
  slugIdsOf,
  snapshotSections,
} from '../../scripts/ci/check-post-rebase-uniqueness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Il file come lo trova il generatore. Dal disco quando c'e'; dall'indice di
 * git quando il checkout e' sparse e il file e' tracciato ma non
 * materializzato: letto come «assente» toglierebbe la sezione dal confronto e
 * il test passerebbe verde proprio dove non ha guardato.
 */
function readCorpusFile(rel) {
  const absolute = path.join(ROOT, rel);
  if (existsSync(absolute)) return readFileSync(absolute, 'utf8');
  if (git(['ls-files', '--', rel]).trim() === '') return null;
  return git(['show', `:${rel}`]);
}

const surfaces = sectionSurfaces();

test('il core ha sezioni e le loro superfici si leggono davvero', () => {
  assert.ok(surfaces.length > 0, 'nessuna sezione nel core');
  const sizes = surfaces.map((surface) => new Set([
    ...slugIdsOf(readCorpusFile(surface.slugDataFile)),
    ...registryIdsOf(readCorpusFile(surface.registryFile)),
  ]).size);
  assert.ok(
    Math.max(...sizes) > 100,
    `la sezione piu' grande porta ${Math.max(...sizes)} id: il lettore non sta leggendo i registri`,
  );
});

test('ogni sezione supera la premessa del ricontrollo dopo il rebase', () => {
  const broken = [];
  for (const surface of surfaces) {
    try {
      snapshotSections([surface], readCorpusFile, 'corpus');
    } catch (error) {
      broken.push(`${surface.section}: ${error.message}`);
    }
  }
  assert.deepEqual(
    broken,
    [],
    'Con una sezione in questo stato check-post-rebase-uniqueness.mjs esce 2 e ogni run che fa un rebase '
      + 'scarta l\'articolo gia\' generato. Un id presente solo nel meta e\' il residuo di un ritiro a meta\': '
      + 'toglilo con scripts/retire-article.mjs, o togli le sue voci dai quattro blog-meta della sezione.',
  );
});

test('una voce di meta senza registro ne\' slug fa cadere la premessa, e viene nominata', () => {
  const [target] = surfaces
    .map((surface) => ({ surface, meta: readCorpusFile(surface.metaFile) }))
    .filter(({ meta }) => typeof meta === 'string' && meta.trim() !== '');
  assert.ok(target, 'nessuna sezione ha un meta IT leggibile');
  const orphan = 'residuo-di-un-ritiro-a-meta';
  const withOrphan = (rel) => {
    const text = readCorpusFile(rel);
    if (rel !== target.surface.metaFile) return text;
    return `${text}\n  'blog.article.${orphan}.title': 'Titolo rimasto',\n`
      + `  'blog.article.${orphan}.excerpt': 'Estratto rimasto',\n`;
  };
  assert.throws(
    () => snapshotSections([target.surface], withOrphan, 'corpus'),
    (error) => error.message.includes('non presenti in slug/registro') && error.message.includes(orphan),
  );
});
