/**
 * Rewrite (in place) the THREE descriptive texts a published article already
 * carries — `excerpt`/`seoDescription`/`ogDescription` per locale (in
 * `content/blog-meta-<locale>.ts`) and `description`/`ogDescription`/
 * `structuredData.description` on its IT-only `content/seo/**` entry — when
 * a content builder's current output disagrees with what was written at
 * registration.
 *
 * ## Why this exists (issue #85)
 *
 * `registerArticleFiles()` (create-article.mjs) writes these fields exactly
 * ONCE, at registration — it is append-only by design (an upsert there would
 * let a stray re-registration silently overwrite an unrelated article's
 * fields; `checkArticleIdExists` already throws before it runs). The daily
 * Bollettino's `exists` branch (generate-daily-brief-article.mjs) could
 * therefore only ever refresh the BODY files on a same-day rerun
 * (`refreshBodyFiles`) — whatever excerpt/description/ogDescription got
 * written at first registration was frozen forever, even across a template
 * change.
 *
 * That is exactly what happened with #79→#83: `bollettino-frontaliere-
 * 2026-08-08` and `-09` registered with a single collapsed string doing
 * triple duty as excerpt, meta description AND og description (#79/#80). #83
 * fixed the TEMPLATE going forward but, by construction, cannot touch what is
 * already on disk — `content/` is written only by the generator (CLAUDE.md),
 * and the generator's only write path for an EXISTING id was
 * `refreshBodyFiles`.
 *
 * This module is that missing write path: a small, dependency-free (no
 * jsdom — importable under plain `node --test`, unlike create-article.mjs)
 * upsert. A content builder's `exists` branch calls it alongside
 * `refreshBodyFiles` to keep meta+seo current on same-day reruns, and a
 * one-off repair can call it directly for a PAST id whose descriptive texts
 * are reconstructable without the source day's snapshot (see
 * `buildDescriptiveTexts` in daily-brief-content.mjs, and
 * `repair-daily-brief-descriptive-texts.mjs`).
 *
 * ## Idempotence, and why it matters here specifically
 *
 * Every field is compared against its CURRENT stored value before writing —
 * a value already correct leaves the file untouched (no write syscall, not
 * just "no visible diff"). This is what keeps a same-day cron rerun (the
 * `exists` branch can run several times a day) from producing a needless
 * diff when nothing about the text actually changed, mirroring the
 * clamp-to-`datePublished` guard `bumpDateModified` already applies next to
 * this call for the same reason. This module clamps nothing itself — the
 * 160/250 safety net stays `clampSeoDescriptions`'s job in
 * create-article.mjs; a caller that hands over an over-budget string gets it
 * written over-budget.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusPath } from './corpus-paths.mjs';
import { sanitizeText } from '../../../scripts/lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from './control-char-write-report.mjs';
import { escapeForSingleQuoteTS } from './article-meta-block.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Two levels up from `generator/scripts/lib/` is `generator/`; one more is the
// repo root — same derivation as evergreen-article-refresh.mjs, and for the
// same reason (this module sits at the transported path, not main's).
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * The per-locale meta fields this module may touch, in the order they'd be
 * INSERTED when missing. `title`/`imageAlt` are never touched here — this
 * issue is scoped to the three descriptive surfaces #79/#80/#83 collapsed and
 * split, not to every field the meta block carries.
 */
const LOCALE_FIELDS = ['excerpt', 'seoDescription', 'ogDescription'];

// Same write-time guard as create-article.mjs's write() / evergreen-article-
// refresh.mjs's writeCorpusFile: a `.ts` under content/ must never carry a C0
// control character other than TAB/LF/CR (issue #66). Kept as its own small
// copy rather than an import across module boundaries meant to stay
// dependency-light — see the header on why this file avoids create-article.mjs.
function writeCorpusFile(file, content) {
  const clean = sanitizeText(content);
  reportStrippedControlChars(file, content, clean);
  writeFileSync(file, clean);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Update-or-insert the per-locale meta lines for one article id. A field
 * already holding the target value is left untouched; a field whose line
 * does not exist yet (the pre-#83 editions never got `seoDescription`/
 * `ogDescription` at all) is appended right after the LAST existing
 * `blog.article.<id>.*` line for this id, preserving `LOCALE_FIELDS` order
 * among the fields being inserted together.
 *
 * @param {string} src - the meta file's current content
 * @param {string} id
 * @param {Record<string,string>} fields - a subset of LOCALE_FIELDS → value
 * @returns {string} the new content (`=== src` when nothing changed)
 */
export function upsertLocaleMetaFields(src, id, fields) {
  let out = src;
  const missing = [];
  for (const field of LOCALE_FIELDS) {
    if (!(field in fields)) continue;
    const value = fields[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const escaped = escapeForSingleQuoteTS(value);
    const re = new RegExp(`'blog\\.article\\.${escapeRegex(id)}\\.${field}':\\s*'((?:[^'\\\\]|\\\\.)*)'`);
    const m = out.match(re);
    if (!m) {
      missing.push(field);
      continue;
    }
    if (m[1] === escaped) continue; // already correct: idempotent no-op
    out = out.replace(re, `'blog.article.${id}.${field}': '${escaped}'`);
  }

  if (missing.length > 0) {
    const anyFieldRe = new RegExp(
      `([ \\t]*)'blog\\.article\\.${escapeRegex(id)}\\.[A-Za-z]+':\\s*'(?:[^'\\\\]|\\\\.)*',?`,
      'g',
    );
    let lastMatch = null;
    let m;
    while ((m = anyFieldRe.exec(out))) lastMatch = m;
    if (!lastMatch) {
      throw new Error(
        `upsertLocaleMetaFields: '${id}' non e' registrato in questo file — nessuna riga ` +
          `'blog.article.${id}.*' trovata. Questa funzione aggiorna un articolo esistente, ` +
          'non ne registra uno nuovo (registerArticleFiles fa quello).',
      );
    }
    const indent = lastMatch[1];
    const insertAt = lastMatch.index + lastMatch[0].length;
    const newLines = missing
      .map((field) => `\n${indent}'blog.article.${id}.${field}': '${escapeForSingleQuoteTS(fields[field])}',`)
      .join('');
    out = out.slice(0, insertAt) + newLines + out.slice(insertAt);
  }

  return out;
}

/**
 * Update the `description` / `ogDescription` / `structuredData.description`
 * fields of one `blog-<id>` SEO entry, scoped to that entry's block only —
 * same next-top-level-key scoping `bumpDateModified` uses, so this can never
 * bleed into a sibling entry. A field already at the target value is left
 * untouched.
 *
 * @param {string} src - the SEO file's current content
 * @param {string} id
 * @param {{description?:string, ogDescription?:string}} seo
 * @returns {string} the new content (`=== src` when nothing changed)
 */
export function upsertSeoDescriptionBlock(src, id, seo) {
  const startIdx = src.indexOf(`'blog-${id}':`);
  if (startIdx < 0) {
    throw new Error(`upsertSeoDescriptionBlock: nessuna entry 'blog-${id}' trovata in questo file.`);
  }
  const after = src.slice(startIdx);
  const nextKey = after.slice(1).search(/\n {2}'[^']+':\s*\{/);
  const blockEnd = nextKey < 0 ? after.length : nextKey + 1;
  const original = after.slice(0, blockEnd);
  let block = original;

  if (typeof seo.description === 'string' && seo.description.trim() !== '') {
    const single = escapeForSingleQuoteTS(seo.description);
    block = block.replace(
      /(\n {4}description: ')((?:[^'\\]|\\.)*)(',)/,
      (m, g1, g2, g3) => (g2 === single ? m : `${g1}${single}${g3}`),
    );
    // The structuredData twin is double-quoted and escaped the way
    // modifySeoService escapes it elsewhere in create-article.mjs — only `"`,
    // not a full JSON escape (these texts are plain sentences, never containing
    // a literal double quote in practice).
    const dbl = seo.description.replace(/"/g, '\\"');
    block = block.replace(
      /("description":\s*")((?:[^"\\]|\\.)*)(")/,
      (m, g1, g2, g3) => (g2 === dbl ? m : `${g1}${dbl}${g3}`),
    );
  }
  if (typeof seo.ogDescription === 'string' && seo.ogDescription.trim() !== '') {
    const single = escapeForSingleQuoteTS(seo.ogDescription);
    block = block.replace(
      /(\n {4}ogDescription: ')((?:[^'\\]|\\.)*)(',)/,
      (m, g1, g2, g3) => (g2 === single ? m : `${g1}${single}${g3}`),
    );
  }

  if (block === original) return src;
  return src.slice(0, startIdx) + block + after.slice(blockEnd);
}

/**
 * Refresh the descriptive texts of an ALREADY-REGISTERED article across all
 * four locale meta files and its SEO entry. Convenience wrapper around
 * `upsertLocaleMetaFields`/`upsertSeoDescriptionBlock` that does the file
 * I/O and only writes a file whose content actually changed.
 *
 * @param {string} id
 * @param {Record<'it'|'en'|'de'|'fr', {excerpt?:string, seoDescription?:string, ogDescription?:string}>} localeTexts
 * @param {{description?:string, ogDescription?:string}} [seoTexts] - IT-only, `content/seo/**` entry
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.metaPrefix] - 'blog-meta' (frontaliere, default) | 'blog-meta-ch' (svizzera)
 * @param {string} [opts.seoFile] - relative to main's layout, default 'services/seo/seo-blog-5.ts'
 * @returns {{ changed: boolean, touched: string[] }}
 */
export function refreshDescriptiveTexts(id, localeTexts, seoTexts, opts = {}) {
  if (!id) throw new Error('refreshDescriptiveTexts: id mancante');
  const repoRoot = opts.repoRoot || DEFAULT_REPO_ROOT;
  const metaPrefix = opts.metaPrefix || 'blog-meta';
  const seoFile = opts.seoFile || 'services/seo/seo-blog-5.ts';
  const touched = [];

  for (const locale of LOCALES) {
    const fields = localeTexts?.[locale];
    if (!fields) continue;
    const file = path.join(repoRoot, corpusPath(`services/locales/${metaPrefix}-${locale}.ts`));
    const before = readFileSync(file, 'utf-8');
    const after = upsertLocaleMetaFields(before, id, fields);
    if (after !== before) {
      writeCorpusFile(file, after);
      touched.push(file);
    }
  }

  if (seoTexts && (seoTexts.description || seoTexts.ogDescription)) {
    const seoPath = path.join(repoRoot, corpusPath(seoFile));
    const before = readFileSync(seoPath, 'utf-8');
    const after = upsertSeoDescriptionBlock(before, id, seoTexts);
    if (after !== before) {
      writeCorpusFile(seoPath, after);
      touched.push(seoPath);
    }
  }

  return { changed: touched.length > 0, touched };
}
