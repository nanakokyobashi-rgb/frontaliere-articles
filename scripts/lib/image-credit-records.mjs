/**
 * image-credit-records.mjs — the credit records of the Commons covers as the
 * corpus holds them, and what the rest of the corpus says about them (P14).
 *
 * One JSON record per cover file, `content/image-credits/blog/<cover>.json`,
 * written by the generator (`generator/scripts/lib/commons-credit.mjs`) and by
 * the one-off backfill (`scripts/backfill-image-credits.mjs`). The schema, the
 * validator and every projection live in `engine/shared/imageCredits.mjs`
 * (mirrored from the site); this module only adds the corpus-side checks that
 * module cannot make on a single record:
 *
 *   - the file name is the record's cover;
 *   - only `status: "ok"` is published (`review` never reaches a page);
 *   - records of covers cut from the same Commons file agree on what they say
 *     about that file — two covers of one photo with two different authors is
 *     a wrong credit on one of the two pages;
 *   - the SEO literal of a credited cover no longer claims the photo as the
 *     site's own («© … Frontaliere Ticino. Tutti i diritti riservati»).
 *
 * It also builds `data/image-credits-<section>.json`, the compact copy the SPA
 * fetches (`buildImageCreditsIndex`, called by `scripts/build-blog-index.mjs`).
 *
 * Builtins only, like the rest of `scripts/lib/`: the content gate, the
 * backfill and the publisher all run without `npm ci`.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  coverKey,
  createImageCreditReader,
  validateImageCreditRecord,
} from '../../engine/shared/imageCredits.mjs';

/** The directory the engine reader is pointed at (it appends `blog/<key>.json`). */
export const IMAGE_CREDITS_ROOT = 'content/image-credits';

/** Where the records live, relative to the repository root. */
export const IMAGE_CREDIT_RECORDS_DIR = `${IMAGE_CREDITS_ROOT}/blog`;

/** The SEO literals of the generated articles. `seo-blog.ts` has no dash, hence the glob shape. */
export const SEO_LITERALS_DIR = 'content/seo';
const SEO_LITERAL_FILE_RX = /^seo-blog(?:-[a-z0-9]+)?\.ts$/;

/**
 * The five ImageObject fields through which a literal claims the photo for the
 * site. The engine never reads them (it takes only the hero path from the
 * literal), so for a credited cover they are a second, false copy of the credit.
 */
export const IMAGE_RIGHTS_KEYS = Object.freeze([
  'acquireLicensePage',
  'copyrightNotice',
  'license',
  'creator',
  'creditText',
]);

/** Schema of `data/image-credits-<section>.json`. */
export const IMAGE_CREDITS_INDEX_SCHEMA = 1;

// ── Records on disk ─────────────────────────────────────────────────────────

/**
 * Every `*.json` under the records directory, parsed. A missing directory is
 * an empty list: before the backfill no cover has a record, and that is a
 * legitimate state, not a broken checkout.
 *
 * @param {string} root repository root
 * @returns {{ key: string, file: string, record: unknown, parseError: string | null }[]}
 */
export function readCreditRecords(root) {
  const dir = path.join(root, IMAGE_CREDIT_RECORDS_DIR);
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = `${IMAGE_CREDIT_RECORDS_DIR}/${name}`;
      try {
        return { key: name.slice(0, -'.json'.length), file, record: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')), parseError: null };
      } catch (error) {
        return { key: name.slice(0, -'.json'.length), file, record: null, parseError: error instanceof Error ? error.message : String(error) };
      }
    });
}

/**
 * What a record says about its Commons FILE — everything except the two
 * per-cover fields. `fetchedAt` is left out too: two runs that read the same
 * unchanged file on two days are not in disagreement.
 *
 * @param {Record<string, unknown>} record
 */
export function fileLevelFields(record) {
  const { cover, modified, fetchedAt, ...rest } = record;
  void cover; void modified; void fetchedAt;
  return rest;
}

/** Key-order-independent JSON, so two equal objects compare equal. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The corpus-side checks on the records (see the header). Pure: takes the
 * output of `readCreditRecords`.
 *
 * @param {ReturnType<typeof readCreditRecords>} entries
 * @returns {string[]} one line per problem, empty when every record is publishable
 */
export function auditCreditRecords(entries) {
  const problems = [];
  /** @type {Map<string, { file: string, fields: string }>} */
  const byTitle = new Map();
  for (const { key, file, record, parseError } of entries) {
    if (parseError !== null) {
      problems.push(`${file}: not JSON (${parseError})`);
      continue;
    }
    const { valid, errors } = validateImageCreditRecord(record);
    if (!valid) {
      problems.push(`${file}: invalid record — ${errors.join('; ')}`);
      continue;
    }
    if (coverKey(record.cover) !== key) {
      problems.push(`${file}: cover ${record.cover} does not match the file name (expected /images/blog/${key}.<ext>)`);
    }
    if (record.status !== 'ok') {
      problems.push(`${file}: status "${record.status}" — a record under review is never published; curate it or remove the cover`);
    }
    const fields = canonicalJson(fileLevelFields(record));
    const known = byTitle.get(record.commons.title);
    if (!known) {
      byTitle.set(record.commons.title, { file, fields });
    } else if (known.fields !== fields) {
      problems.push(`${file}: disagrees with ${known.file} about Commons file «${record.commons.title}» (author, attribution, licence or curation differ)`);
    }
  }
  return problems;
}

// ── SEO literals ────────────────────────────────────────────────────────────

/**
 * Index of the brace that closes the one at `open`, skipping string and
 * template literals (the url value is `` `${BASE_URL}/images/…` ``). -1 when
 * unbalanced.
 *
 * @param {string} src
 * @param {number} open
 */
function closingBrace(src, open) {
  let depth = 0;
  /** @type {string | null} */
  let quote = null;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Top-level `"key": value` pairs of the object literal spanning
 * `[open, close]`. Positions are absolute in `src`; `valueEnd` is exclusive and
 * stops before the separating comma.
 *
 * @param {string} src
 * @param {number} open
 * @param {number} close
 */
function topLevelProperties(src, open, close) {
  /** @type {{ key: string, keyStart: number, valueStart: number, valueEnd: number }[]} */
  const props = [];
  let i = open + 1;
  while (i < close) {
    const keyMatch = /\s*,?\s*"([^"\\]+)"\s*:\s*/y;
    keyMatch.lastIndex = i;
    const m = keyMatch.exec(src);
    if (!m || m.index !== i) break;
    const keyStart = src.indexOf('"', i);
    const valueStart = keyMatch.lastIndex;
    // The value ends at the first comma or closing brace at depth 0.
    let depth = 0;
    /** @type {string | null} */
    let quote = null;
    let j = valueStart;
    for (; j < close; j += 1) {
      const c = src[j];
      if (quote) {
        if (c === '\\') { j += 1; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '{' || c === '[') depth += 1;
      else if (c === '}' || c === ']') depth -= 1;
      else if (c === ',' && depth === 0) break;
    }
    let valueEnd = j;
    while (valueEnd > valueStart && /\s/.test(src[valueEnd - 1])) valueEnd -= 1;
    props.push({ key: m[1], keyStart, valueStart, valueEnd });
    i = j;
  }
  return props;
}

/** The cover key a literal's image `url` value points at, or null. */
function urlValueCoverKey(rawValue) {
  const unquoted = rawValue.trim().replace(/^[`"']|[`"']$/g, '').replace(/^\$\{[^}]*\}/, '');
  return coverKey(unquoted);
}

/**
 * Every `"image": { … }` object in an SEO source, with its cover and the
 * rights fields it carries.
 *
 * @param {string} src
 * @returns {{ start: number, end: number, cover: string | null, rights: string[], props: ReturnType<typeof topLevelProperties> }[]}
 */
export function scanSeoImageBlocks(src) {
  const blocks = [];
  const rx = /"image"\s*:\s*\{/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = closingBrace(src, open);
    if (close < 0) break;
    const props = topLevelProperties(src, open, close);
    const url = props.find((p) => p.key === 'url');
    blocks.push({
      start: open,
      end: close + 1,
      cover: url ? urlValueCoverKey(src.slice(url.valueStart, url.valueEnd)) : null,
      rights: props.filter((p) => IMAGE_RIGHTS_KEYS.includes(p.key)).map((p) => p.key),
      props,
    });
    rx.lastIndex = close + 1;
  }
  return blocks;
}

/** The `content/seo` files that hold article literals, sorted. */
export function seoLiteralFiles(root) {
  const dir = path.join(root, SEO_LITERALS_DIR);
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  }
  return names.filter((name) => SEO_LITERAL_FILE_RX.test(name)).sort().map((name) => `${SEO_LITERALS_DIR}/${name}`);
}

/**
 * Literals that still claim a credited cover for the site: an image block
 * whose url is a credited cover and that carries any of the five rights keys.
 *
 * @param {string} root
 * @param {Set<string>} creditedKeys cover keys that have a record
 * @returns {{ file: string, cover: string, rights: string[] }[]}
 */
export function findCreditedRightsClaims(root, creditedKeys) {
  const claims = [];
  for (const file of seoLiteralFiles(root)) {
    const src = fs.readFileSync(path.join(root, file), 'utf-8');
    for (const block of scanSeoImageBlocks(src)) {
      if (block.cover && creditedKeys.has(block.cover) && block.rights.length > 0) {
        claims.push({ file, cover: block.cover, rights: block.rights });
      }
    }
  }
  return claims;
}

/**
 * Removes the five rights fields from the image blocks of credited covers.
 *
 * Only the run the generator has always written is removed: the rights keys
 * contiguous (`creditText` optional, it is missing on ~200 old literals),
 * followed by another key, and stating the site's claim. Anything else is left
 * untouched and returned in `unmatched`, because a literal that a human wrote
 * differently is a literal a human must look at.
 *
 * @param {string} src
 * @param {(cover: string) => boolean} isCredited
 * @returns {{ src: string, stripped: string[], unmatched: { cover: string, reason: string }[] }}
 */
export function stripCreditedImageRights(src, isCredited) {
  const edits = [];
  const stripped = [];
  const unmatched = [];
  for (const block of scanSeoImageBlocks(src)) {
    if (!block.cover || !isCredited(block.cover) || block.rights.length === 0) continue;
    const indexes = block.props.map((p, index) => (IMAGE_RIGHTS_KEYS.includes(p.key) ? index : -1)).filter((i) => i >= 0);
    const first = indexes[0];
    const last = indexes[indexes.length - 1];
    if (last - first + 1 !== indexes.length) {
      unmatched.push({ cover: block.cover, reason: 'rights fields are not contiguous' });
      continue;
    }
    const next = block.props[last + 1];
    if (!next) {
      unmatched.push({ cover: block.cover, reason: 'rights fields close the image object' });
      continue;
    }
    const run = src.slice(block.props[first].keyStart, next.keyStart);
    if (!/Frontaliere Ticino/.test(run)) {
      unmatched.push({ cover: block.cover, reason: 'rights fields are not the site\'s claim' });
      continue;
    }
    edits.push({ from: block.props[first].keyStart, to: next.keyStart });
    stripped.push(block.cover);
  }
  let out = src;
  for (const { from, to } of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, from) + out.slice(to);
  return { src: out, stripped, unmatched };
}

// ── The SPA's copy: data/image-credits-<section>.json ──────────────────────

/**
 * What the visible line and the ImageObject need from a record, and nothing
 * else (`imageCreditParts` / `imageObjectCreditFields` read exactly these).
 * `licence.attributionRequired` and `fetchedAt` are kept so a consumer can
 * rebuild a record that passes `validateImageCreditRecord`.
 *
 * @param {import('../../engine/shared/imageCredits.mjs').ImageCreditRecord} record
 */
export function imageCreditDisplayFields(record) {
  return {
    pageUrl: record.commons.pageUrl,
    author: { name: record.author.name, url: record.author.url, type: record.author.type },
    attribution: record.attribution,
    licence: {
      name: record.licence.name,
      url: record.licence.url,
      family: record.licence.family,
      attributionRequired: record.licence.attributionRequired,
    },
    fetchedAt: record.fetchedAt,
  };
}

/** @param {Record<string, unknown>} object */
function sortedObject(object) {
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
}

/**
 * The SPA's credits for one section:
 *
 *   { schema, commit, section,
 *     files:  { <Commons title>: { pageUrl, author{name,url,type}, attribution,
 *                                  licence{name,url,family,attributionRequired}, fetchedAt } },
 *     covers: { <cover key>: { file: <Commons title>, modified } } }
 *
 * Only covers used by the section's registry rows, and only publishable
 * records (the engine reader drops invalid, mismatched and `review` records,
 * exactly as the static page does). File fields are stored once per Commons
 * file, with the most recent read: records that agree but were read on
 * different days carry the latest `fetchedAt`, the day the credit was last
 * confirmed. Two records of one file that disagree (two runs that read Commons
 * at different moments) are returned in `conflicts`, and the file carries the
 * most recent read — ties go to the cover first in key order — for every
 * cover cut from it: the credit belongs to the file, and no cover goes out
 * without one while its literal no longer claims the photo for the site.
 *
 * @param {{
 *   section: string,
 *   commit: string | null,
 *   images: Iterable<string>,
 *   reader: import('../../engine/shared/imageCredits.mjs').ImageCreditReader,
 * }} input
 */
export function buildImageCreditsIndex({ section, commit, images, reader }) {
  /** @type {Map<string, string>} */
  const imageByKey = new Map();
  for (const image of images) {
    const key = coverKey(image);
    if (key && !imageByKey.has(key)) imageByKey.set(key, image);
  }
  /** @type {Record<string, ReturnType<typeof imageCreditDisplayFields>>} */
  const files = {};
  /** @type {Record<string, { file: string, modified: string }>} */
  const covers = {};
  /** @type {Map<string, string>} title -> first cover key, for the conflict message */
  const firstCover = new Map();
  const conflicts = [];
  for (const key of [...imageByKey.keys()].sort()) {
    const record = reader.get(imageByKey.get(key));
    if (!record) continue;
    const title = record.commons.title;
    const fields = imageCreditDisplayFields(record);
    const known = files[title];
    if (!known) {
      files[title] = fields;
      firstCover.set(title, key);
    } else {
      // `files[title].fetchedAt` is the most recent read of the file so far.
      const { fetchedAt: knownAt, ...knownRest } = known;
      const { fetchedAt: newAt, ...newRest } = fields;
      if (canonicalJson(knownRest) !== canonicalJson(newRest)) {
        conflicts.push(`covers ${firstCover.get(title)} and ${key} credit Commons file «${title}» differently`);
        if (newAt > knownAt) files[title] = fields;
      } else if (newAt > knownAt) {
        files[title] = { ...known, fetchedAt: newAt };
      }
    }
    covers[key] = { file: title, modified: record.modified };
  }
  return {
    payload: {
      schema: IMAGE_CREDITS_INDEX_SCHEMA,
      commit,
      section,
      files: sortedObject(files),
      covers: sortedObject(covers),
    },
    conflicts,
  };
}

/**
 * The engine reader over the corpus records, with a collecting `warn` so a
 * caller can surface dropped records instead of letting them vanish.
 *
 * @param {string} root
 * @param {(message: string) => void} [warn]
 */
export function corpusCreditReader(root, warn) {
  return createImageCreditReader(fs, path.join(root, IMAGE_CREDITS_ROOT), warn ? { warn } : {});
}
