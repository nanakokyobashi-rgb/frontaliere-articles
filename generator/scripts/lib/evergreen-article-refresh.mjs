/**
 * Shared freshness-bump helpers for EVERGREEN blog articles (stable id, body
 * rewritten periodically instead of a new article per run — see AGENTS.md §6:
 * a construct duplicated across ≥2 scripts must live in one module).
 *
 * Extracted from generate-events-digest-article.mjs (issue #2963) so the
 * dogane-ranking digest (and any future evergreen digest) reuses the exact
 * same regex-scoped rewrite logic instead of a copy-pasted sibling.
 */
import { readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusPath } from './corpus-paths.mjs';
import { sanitizeText } from '../../../scripts/lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from './control-char-write-report.mjs';

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
let writeTmpSeq = 0;
function writeCorpusFile(file, content) {
  const clean = sanitizeText(content);
  // Non basta togliere il byte: toglierlo distrugge il MARKER che rende
  // esatta una riparazione futura (issue #95). Si registra prima, con il
  // contesto che conserva la coppia (byte, carattere seguente).
  reportStrippedControlChars(file, content, clean);
  const tmp = `${file}.${process.pid}.${writeTmpSeq++}.tmp`;
  try {
    writeFileSync(tmp, clean, 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/** Bump (or insert) `updatedAt` on the ARTICLES entry so sitemap lastmod reflects the refresh. */
export function bumpUpdatedAt(id, todayIso, repoRoot = DEFAULT_REPO_ROOT) {
  const file = path.join(repoRoot, corpusPath('data/blog-articles-data.ts'));
  let src = readFileSync(file, 'utf-8');
  const entryRe = new RegExp(`(\\n([ \\t]*)id: '${id}',[\\s\\S]*?)(\\n[ \\t]*\\},)`);
  const m = src.match(entryRe);
  if (!m) return false;
  const indent = m[2];
  let block = m[1];
  // updatedAt is stored date-only (no time-of-day); if the entry's original
  // `date` timestamp falls later the same calendar day (article registered
  // earlier today), a midnight-anchored updatedAt would parse as *before* it —
  // an incoherent freshness signal (google-news-compliance.test.ts). Same
  // clamp rationale as bumpDateModified below; skip the bump in that
  // same-day case instead of writing a value that can never be >= `date`.
  const dateMatch = block.match(/\n[ \t]*date: '([^']*)',/);
  if (dateMatch && Date.parse(`${todayIso}T00:00:00Z`) < Date.parse(dateMatch[1])) {
    return true;
  }
  if (/updatedAt:/.test(block)) {
    block = block.replace(/updatedAt: '[^']*'/, `updatedAt: '${todayIso}'`);
  } else {
    block = block.replace(/(\n[ \t]*date: '[^']*',)/, `$1\n${indent}updatedAt: '${todayIso}',`);
  }
  if (block === m[1]) return false;
  src = src.replace(m[1], block);
  writeCorpusFile(file, src);
  return true;
}

/**
 * Bump the NewsArticle `dateModified` on the article's blog-SEO entry so the
 * freshness signal tracks the periodic body refresh (datePublished is left at
 * the original publish date). Scoped to this article's block only.
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
) {
  const file = path.join(repoRoot, corpusPath(seoFile));
  const src = readFileSync(file, 'utf-8');
  const startIdx = src.indexOf(`'blog-${id}':`);
  if (startIdx < 0) return false;
  // Scope the rewrite to THIS entry's block (stop at the next top-level entry
  // key) so a future nested object can never make us touch a sibling's date.
  const after = src.slice(startIdx);
  const nextKey = after.slice(1).search(/\n {2}'[^']+':\s*\{/);
  const blockEnd = nextKey < 0 ? after.length : nextKey + 1;
  const block = after.slice(0, blockEnd);
  const dmRe = /"dateModified":\s*"[^"]*"/;
  if (!dmRe.test(block)) return false;
  // dateModified must never precede datePublished: on the publish day a fixed
  // midnight stamp falls before the publish time → an incoherent freshness
  // signal in the indexed NewsArticle JSON-LD. Clamp up to datePublished when earlier.
  const pub = block.match(/"datePublished":\s*"([^"]*)"/);
  const effective = pub && Date.parse(pub[1]) > Date.parse(isoDateTime) ? pub[1] : isoDateTime;
  const replaced = block.replace(dmRe, `"dateModified": "${effective}"`);
  writeCorpusFile(file, src.slice(0, startIdx) + replaced + after.slice(blockEnd));
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
