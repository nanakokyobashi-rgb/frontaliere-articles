/**
 * image-credits-content.test.mjs — CONTENT GATE (`scripts/ci/content-gates-main.mjs`):
 * the credits of the Wikimedia Commons covers as the corpus holds them (P14).
 * Run with `node --test`.
 *
 * The generator writes `content/image-credits/blog/<id>.json` and the SEO
 * literal of the article straight to `main`, so this runs where content
 * gates run: on PRs that touch `generator/**` (generator-ci.yml) and on every
 * push of `content/**` to `main`, where an offender opens an issue.
 *
 *   - every record validates against the engine schema, is named after its
 *     cover, is publishable (`status: "ok"`), and says the same about its
 *     Commons file as every other record of that file;
 *   - no SEO literal of a credited cover still claims the photo for the site
 *     («© … Frontaliere Ticino. Tutti i diritti riservati» and the other four
 *     rights fields): the engine builds them from the record;
 *   - every live Commons cover — the image of a registry row whose cover is in
 *     either usage map with a Commons URL — has a publishable record. Since the
 *     backfill (data PR C2) a page never shows a Commons photo without its
 *     credit; a file that cannot be credited is replaced, not left uncredited.
 *
 * The literal scan is checked against a raw count, and the live covers
 * against a floor, so that a parser reading nothing cannot pass for a clean
 * corpus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditCreditRecords,
  corpusCreditReader,
  findCreditedRightsClaims,
  readCreditRecords,
  scanSeoImageBlocks,
  seoLiteralFiles,
} from '../../scripts/lib/image-credit-records.mjs';
import { liveCommonsCovers } from '../../scripts/backfill-image-credits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RECORDS_DIR = path.join(ROOT, 'content', 'image-credits', 'blog');

test('every credit record validates, is named after its cover, is publishable and agrees with the other covers of its file', () => {
  if (fs.existsSync(RECORDS_DIR)) assert.ok(fs.statSync(RECORDS_DIR).isDirectory(), `${RECORDS_DIR} is not a directory`);
  const problems = auditCreditRecords(readCreditRecords(ROOT));
  assert.deepEqual(problems, [], `credit records the pages cannot publish as they are:\n  ${problems.join('\n  ')}`);
});

test('no SEO literal of a credited cover still claims the photo for the site', () => {
  const credited = new Set(readCreditRecords(ROOT).filter((e) => e.record?.status === 'ok').map((e) => e.key));
  const claims = findCreditedRightsClaims(ROOT, credited).map((c) => `${c.file}: ${c.cover} (${c.rights.join(', ')})`);
  assert.deepEqual(claims, [], 'literals of credited covers that still carry rights fields — '
    + `run node scripts/backfill-image-credits.mjs --build:\n  ${claims.join('\n  ')}`);
});

test('the literal scan reads every image object of content/seo (no silent zero)', () => {
  const files = seoLiteralFiles(ROOT);
  assert.ok(files.length >= 4, `only ${files.length} seo-blog files under content/seo: the scan would read almost nothing`);
  let scanned = 0;
  let counted = 0;
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    scanned += scanSeoImageBlocks(src).length;
    counted += (src.match(/"image"\s*:\s*\{/g) || []).length;
  }
  assert.ok(counted > 0, 'no image object at all in content/seo');
  assert.equal(scanned, counted, 'the scanner lost image objects: a claim inside them would go unseen');
});

test('every live Commons cover has a publishable credit record', () => {
  const live = liveCommonsCovers(ROOT);
  // The 2026-10-04 corpus showed 1,478 live Commons covers; far fewer means
  // the usage maps or the registries were not read, not that the corpus is clean.
  assert.ok(live.length >= 1000, `only ${live.length} live Commons covers read from the usage maps and the registries`);
  const reader = corpusCreditReader(ROOT, () => {});
  const uncredited = live
    .filter(({ id }) => !reader.get(`/images/blog/${id}.webp`))
    .map(({ id, title }) => `${id} («${title}»)`);
  assert.deepEqual(uncredited, [], `live Commons covers without a publishable record (${path.join('content', 'image-credits', 'blog')}): `
    + `write it with node scripts/backfill-image-credits.mjs --build, or replace the cover:\n  ${uncredited.slice(0, 20).join('\n  ')}`);
});
