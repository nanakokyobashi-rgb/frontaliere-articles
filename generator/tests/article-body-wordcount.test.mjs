/**
 * PORTATO da valerielinc-ops/frontaliere-si-o-no `tests/article-body-wordcount.test.ts`
 * (manifest: `adapted`). Gate duro sul thin content: ogni corpo IT sotto le
 * 300 parole fallisce la suite. Gli articoli si generano QUI: un corpo magro
 * va fermato prima che il mirror lo consegni al sito, non dopo.
 *
 * ## ADATTAMENTI rispetto al sito
 *  - Path: `content/blog-body{,-ch}/it` al posto di
 *    `services/locales/blog-body{,-ch}/it` (layout di questo repo).
 *  - `node:test` + expect-shim al posto di vitest.
 *  - Sanity rafforzata: >3000 corpi IT invece di «la lista può essere vuota»
 *    — in un worktree sparse `content/` non esiste e un gate che passa su 0
 *    file scanditi è un falso verde.
 *  - Logica di conteggio INVARIATA (strip tag, split su spazi).
 *
 * Misurato sul corpus attuale (3.769 corpi IT, 2026-08-08): 0 offender —
 * il gate parte severo e verde, nessuna baseline necessaria.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Intestazione originale del sito:
 *
 * Verifies that Italian blog body files meet the minimum word count threshold.
 * Thin content (< 300 words) is penalised by search engines and is a signal
 * that the article generation pipeline needs tuning.
 *
 * This is a hard gate: any article below MIN_WORDS fails the suite and blocks deploy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { expect } from './lib/expect-shim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Both blog-body (frontaliere section) and blog-body-ch (svizzera section)
// share the same {id}.ts-per-locale layout — checking only the former left
// the entire svizzera-section corpus ungated for thin content.
const BLOG_BODY_IT_DIRS = [
  path.join(ROOT, 'content', 'blog-body', 'it'),
  path.join(ROOT, 'content', 'blog-body-ch', 'it'),
];
const MIN_WORDS = 300;

function countWords(text) {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
}

function getArticleFiles() {
  return BLOG_BODY_IT_DIRS.flatMap((dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(dir, f));
  });
}

describe('article body word count', () => {
  const files = getArticleFiles();

  it('should have IT body files to check (a sparse checkout must NOT pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(3000);
  });

  it(`each article IT body should have at least ${MIN_WORDS} words`, () => {
    const failures = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Extract string content between backticks or quotes (simplified)
      const bodyText = content.replace(/^[^'`]*['`]/, '').replace(/['`][^'`]*$/, '');
      const words = countWords(bodyText);
      if (words < MIN_WORDS) {
        failures.push(`${path.basename(filePath)}: ${words} words`);
      }
    }

    if (failures.length > 0) {
      console.error('Articles below minimum word count:');
      failures.forEach((f) => console.error(`  - ${f}`));
    }

    expect(failures, 'Articles below minimum word count (elenco completo sopra)').toHaveLength(0);
  });
});
