/**
 * Shared freshness-bump helpers for EVERGREEN blog articles (stable id, body
 * rewritten periodically instead of a new article per run — see AGENTS.md §6:
 * a construct duplicated across ≥2 scripts must live in one module).
 *
 * Extracted from generate-events-digest-article.mjs (issue #2963) so the
 * dogane-ranking digest (and any future evergreen digest) reuses the exact
 * same balanced-record rewrite logic instead of a copy-pasted sibling.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusPath } from './corpus-paths.mjs';
import { readTopLevelString, scanTopLevelArticleRecords } from '../../../scripts/lib/article-registry-reader.mjs';
import { findSeoEntryMatches } from '../../../scripts/lib/seo-entry.mjs';
import { sanitizeText } from '../../../scripts/lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from './control-char-write-report.mjs';
import { writeFileSnapshotAtomically } from '../../../scripts/lib/write-file-pair-atomically.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `../../..`, not `../..`. In the site repo this module sits at
// scripts/lib/, so two levels up WAS the repo root; the transport (#4974 item 3)
// put it at generator/scripts/lib/, which makes two levels up the `generator/`
// directory. Left unchanged, every corpus read here resolves to
// generator/content/... and throws ENOENT — which is exactly how the events
// digest died after the sitemap writes were no-op'd. The rewire fixed this for
// the seven ENTRY POINTS but not for the libraries they call.
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Write-time guard (issue #66): same rule as create-article.mjs write() — a
// `.ts` under content/ must never carry a C0 control character other than
// TAB/LF/CR. These two functions rewrite an existing corpus file in place
// (a date/timestamp substring), so in practice they can only reintroduce a
// byte the file already carried; the guard is here anyway so this write
// choke point can't be the one that's missing it.
//
// Commits via temp+rename (issue #561, same rule as create-article.mjs's
// write()): this rewrites an EXISTING `data/blog-articles-data.ts` entry in
// place, reached from workflows (generate-events-digest-article.mjs and
// siblings) with `timeout-minutes` that kill via SIGKILL — a direct
// writeFileSync on the target can leave it truncated mid-write. `renameSync`
// is a single POSIX syscall, atomic on the same filesystem; the temp file
// lives next to the target so the rename never crosses a filesystem boundary.
function writeCorpusFile(file, content, before) {
  const clean = sanitizeText(content);
  // Non basta togliere il byte: toglierlo distrugge il MARKER che rende
  // esatta una riparazione futura (issue #95). Si registra prima, con il
  // contesto che conserva la coppia (byte, carattere seguente).
  reportStrippedControlChars(file, content, clean);
  writeFileSnapshotAtomically(file, before, clean);
}

function writeSnapshot(file, before, content, writeFile) {
  if (writeFile === writeCorpusFile) return writeFile(file, content, before);
  return writeFile(file, content);
}

function isAtOrAfter(stored, candidate) {
  const storedMs = Date.parse(stored);
  const candidateMs = Date.parse(candidate);
  return !Number.isNaN(storedMs) && !Number.isNaN(candidateMs) && storedMs >= candidateMs;
}

function literalRange(source, property) {
  if (!property) return null;
  const raw = source.slice(property.valueStart, property.valueEnd);
  const value = raw.trim();
  if (!value) return null;
  const offset = raw.indexOf(value);
  return {
    start: property.valueStart + offset,
    end: property.valueStart + offset + value.length,
    value,
  };
}

function replaceLiteral(source, property, nextValue) {
  const range = literalRange(source, property);
  if (!range) return null;
  return source.slice(0, range.start) + nextValue + source.slice(range.end);
}

function insertUpdatedAt(source, record, dateProperty, todayIso) {
  const close = record.end - 1;
  const newline = source.indexOf('\n', dateProperty.valueEnd);
  const lineStart = source.lastIndexOf('\n', dateProperty.valueStart - 1) + 1;
  const indent = source.slice(lineStart, dateProperty.valueStart).match(/^[ \t]*/u)?.[0] ?? '';
  if (newline >= 0 && newline < close) {
    const breakEnd = newline + 1;
    const lineBreak = source.slice(newline, breakEnd);
    return source.slice(0, breakEnd)
      + `${indent}updatedAt: '${todayIso}',${lineBreak}`
      + source.slice(breakEnd);
  }

  const trailing = source.slice(0, close).match(/[ \t]*$/u)?.[0] ?? '';
  const insertAt = close - trailing.length;
  return source.slice(0, insertAt)
    + `, updatedAt: '${todayIso}'`
    + source.slice(insertAt);
}

/** Bump (or insert) `updatedAt` on an article registry entry so sitemap lastmod reflects the refresh. */
export function bumpUpdatedAt(
  id,
  todayIso,
  repoRoot = DEFAULT_REPO_ROOT,
  registryFile = 'data/blog-articles-data.ts',
  writeFile = writeCorpusFile,
  readFile = readFileSync,
) {
  const file = path.join(repoRoot, corpusPath(registryFile));
  const src = readFile(file, 'utf-8');
  const record = scanTopLevelArticleRecords(src).find((entry) => entry.id === id);
  if (!record) return false;

  const dateProperty = record.properties.get('date');
  const date = readTopLevelString(record, 'date');
  // updatedAt is stored date-only (no time-of-day); if the entry's original
  // `date` timestamp falls later the same calendar day (article registered
  // earlier today), a midnight-anchored updatedAt would parse as *before* it —
  // an incoherent freshness signal (google-news-compliance.test.ts). Same
  // clamp rationale as bumpDateModified below; skip the bump in that
  // same-day case instead of writing a value that can never be >= `date`.
  if (date !== null && Date.parse(`${todayIso}T00:00:00Z`) < Date.parse(date)) {
    return true;
  }
  const updatedAtProperty = record.properties.get('updatedAt');
  if (updatedAtProperty) {
    const current = readTopLevelString(record, 'updatedAt');
    if (current === null) return false;
    if (isAtOrAfter(current, todayIso)) return true;
    const nextSource = replaceLiteral(src, updatedAtProperty, `'${todayIso}'`);
    if (nextSource === null) return false;
    writeSnapshot(file, src, nextSource, writeFile);
    return true;
  }

  if (!dateProperty || date === null) return false;
  writeSnapshot(file, src, insertUpdatedAt(src, record, dateProperty, todayIso), writeFile);
  return true;
}

/**
 * Bump the NewsArticle `dateModified` on the article's blog-SEO entry so the
 * freshness signal tracks the periodic body refresh (datePublished is left at
 * the original publish date). Scoped to this article's unique block; duplicate
 * keys are rejected before the file can be written.
 *
 * `seoFile` defaults to the "frontaliere" section's active SEO shard — must
 * match `SECTION.seoFile` in create-article.mjs for whichever section the
 * article was registered under (both events and border-wait digests are
 * "frontaliere" section, so the default is correct for both).
 */
export function bumpDateModified(
  id,
  isoDateTime,
  repoRoot = DEFAULT_REPO_ROOT,
  seoFile = 'services/seo/seo-blog-5.ts',
  writeFile = writeCorpusFile,
  readFile = readFileSync,
) {
  const file = path.join(repoRoot, corpusPath(seoFile));
  const src = readFile(file, 'utf-8');
  const entries = findSeoEntryMatches(src, id);
  if (entries.length > 1) {
    throw new Error(
      "bumpDateModified: entry 'blog-" + id + "' duplicata (" + entries.length + " occorrenze); " +
      'refresh rifiutato prima della scrittura.',
    );
  }
  const entry = entries[0];
  if (!entry) return false;
  // Scope the rewrite to THIS entry's balanced object so indentation changes
  // cannot make us touch a sibling's date.
  const { index: startIdx, closeIdx } = entry;
  const block = src.slice(startIdx, closeIdx + 1);
  const dmRe = /"dateModified":\s*"([^"]*)"/;
  if (!dmRe.test(block)) return false;
  // dateModified must never precede datePublished: on the publish day a fixed
  // midnight stamp falls before the publish time → an incoherent freshness
  // signal in the indexed NewsArticle JSON-LD. Clamp up to datePublished when earlier.
  const pub = block.match(/"datePublished":\s*"([^"]*)"/);
  const effective = pub && Date.parse(pub[1]) > Date.parse(isoDateTime) ? pub[1] : isoDateTime;
  const current = block.match(dmRe);
  if (current && isAtOrAfter(current[1], effective)) return true;
  const replaced = block.replace(dmRe, `"dateModified": "${effective}"`);
  writeSnapshot(file, src, src.slice(0, startIdx) + replaced + src.slice(closeIdx + 1), writeFile);
  return true;
}

/** Bump the `<lastmod>` on the article's sitemap-blog.xml entry to match the refresh date. */
export function bumpSitemapLastmod(slug, isoDate, repoRoot = DEFAULT_REPO_ROOT, sitemapFile = 'public/sitemap-blog.xml') {
  // No-op since generation moved to this repository (issue #4974 item 3).
  //
  // public/sitemap-blog.xml does not exist here — scripts/build-api.mjs REGENERATES
  // that sitemap from the corpus on every publish, and takes each <lastmod> from the
  // article's own `updatedAt || date`. So the freshness signal this function existed
  // to write is already carried by bumpUpdatedAt(), which the callers invoke first;
  // rewriting a file that is rebuilt from scratch minutes later would change nothing
  // even if the file were here.
  //
  // Left as a reading of the site's copy it would throw ENOENT and take the events
  // digest down with it. Returns true so callers do not log a spurious
  // "lastmod not bumped" warning for work that is now someone else's by design.
  void slug; void isoDate; void repoRoot; void sitemapFile;
  return true;
}
