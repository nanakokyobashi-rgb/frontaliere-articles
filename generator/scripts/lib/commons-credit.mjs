/**
 * commons-credit.mjs — author and licence of a Wikimedia Commons cover, read
 * when the cover is chosen (P14).
 *
 * Owner decision, 2026-10-03: «recuperiamo autore e licenza, corregendo i dati
 * strutturati». Until now the generator saved only `id → thumburl` for a
 * Commons cover, and every article declared the photo as «© Frontaliere
 * Ticino. Tutti i diritti riservati» — false for a CC BY-SA photo by someone
 * else. From here on a Commons cover is used only together with its credit
 * record (`content/image-credits/blog/<cover>.json`), which the engine turns
 * into the ImageObject and the visible line (`engine/shared/imageCredits.mjs`).
 *
 * What this module does, all on the response of the search request the
 * generator already makes (`extmetadata` is one more `iiprop`, no extra call):
 *
 *   - `sanitizeCommonsHtml`: Commons `Artist`/`Attribution` are HTML. Reduced
 *     to text + links, dropping what a reader does not see (hidden spans,
 *     styles, scripts, reference marks). The probe of 2026-10-04 found 15
 *     shapes of `Artist` over 531 files (`ARTIST_SHAPES`).
 *   - `assessCommonsFile`: the acceptance rule measured on those files (the
 *     probe's review-queue-v2: 492 accepted, 38 to review, 2 to replace).
 *     Accepted = a free licence the record can name, no reuse restriction,
 *     and — where the licence requires attribution — a clean name.
 *   - `creditTemplate` / `finalizeCreditRecord`: the schema-1 record, built
 *     with the engine's own `normaliseLicenceUrl` and `isAllowedAuthorUrl` and
 *     checked with its `validateImageCreditRecord` before anything is written.
 *   - `loadCommonsUsage` / `chooseCommonsCredit`: dedup by Commons FILE title
 *     (usage maps + existing records), not by URL. A file already credited is
 *     reused only as a last resort, and then inherits its record's file fields
 *     (including human curation), so two covers of one photo never disagree.
 *
 * Builtins only, on purpose: the generator gates run `node --test` with no
 * `npm ci` (tests.yml, generator-ci.yml), so a jsdom-based sanitiser could not
 * be tested where it is gated. The tokenizer below is equivalent to the
 * probe's jsdom reduction on all 531 probed files (same text and links).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  IMAGE_CREDIT_SCHEMA_VERSION,
  IMAGE_CREDIT_SOURCE,
  coverKey,
  isAllowedAuthorUrl,
  normaliseLicenceUrl,
  validateImageCreditRecord,
} from '../../../engine/shared/imageCredits.mjs';
import {
  IMAGE_CREDIT_RECORDS_DIR,
  corpusCreditReader,
  readCreditRecords,
} from '../../../scripts/lib/image-credit-records.mjs';
import { writeJsonAtomic } from './atomic-write-json.mjs';

export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const COMMONS_FILE_PAGE = 'https://commons.wikimedia.org/wiki/File:';

/**
 * The `extmetadata` fields read. The rule needs Artist, Attribution, the four
 * licence fields and Restrictions; NonFree is a refusal on its own; Credit,
 * UsageTerms and Copyrighted are kept for the human who curates a file.
 */
export const COMMONS_EXTMETADATA_FIELDS = Object.freeze([
  'Artist', 'Attribution', 'Credit', 'LicenseShortName', 'LicenseUrl', 'License',
  'UsageTerms', 'AttributionRequired', 'Copyrighted', 'Restrictions', 'NonFree',
]);
export const COMMONS_EXTMETADATA_FILTER = COMMONS_EXTMETADATA_FIELDS.join('|');

/**
 * The imageinfo part of a Commons query, for the generator's search request
 * and for a single-title lookup alike: the original size (to tell a crop from
 * a resize), the upload timestamp (the revision the cover was cut from) and
 * the licence metadata, in English.
 */
export const COMMONS_IMAGEINFO_PARAMS = 'prop=imageinfo&iiprop=url|size|mime|timestamp|extmetadata'
  + `&iiextmetadatalanguage=en&iiextmetadatafilter=${COMMONS_EXTMETADATA_FILTER}`;

/** API etiquette: a descriptive User-Agent with a contact URL (https://meta.wikimedia.org/wiki/User-Agent_policy). */
export const COMMONS_USER_AGENT = `FrontaliereTicino-ImageCredits/1.0 (https://frontaliereticino.ch/; cover photo credits) node/${process.versions.node}`;

/** Where the article covers are written, and the size the pipeline crops them to. */
export const GENERATED_COVER_SIZE = Object.freeze({ width: 1200, height: 675 });

/** The two maps of Commons covers used so far: the corpus one and the site's frozen copy (C2 adds it). */
export const COMMONS_USAGE_MAPS = Object.freeze([
  'data/blog-images-used.json',
  'data/blog-images-used-site-legacy.json',
]);

// ── HTML → text and links ──────────────────────────────────────────────────

const LATIN1_ENTITY_NAMES = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn '
  + 'sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave '
  + 'Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml '
  + 'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN '
  + 'szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute '
  + 'icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml '
  + 'yacute thorn yuml'
).split(' ');

/** HTML named references: the markup five, Latin-1 (U+00A0–U+00FF in order) and common typography. */
const NAMED_ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ...LATIN1_ENTITY_NAMES.map((name, index) => [name, String.fromCharCode(0xa0 + index)]),
  ['OElig', 'Œ'], ['oelig', 'œ'], ['Scaron', 'Š'], ['scaron', 'š'], ['Yuml', 'Ÿ'], ['fnof', 'ƒ'],
  ['circ', 'ˆ'], ['tilde', '˜'], ['ensp', ' '], ['emsp', ' '], ['thinsp', ' '],
  ['zwnj', '‌'], ['zwj', '‍'], ['lrm', '‎'], ['rlm', '‏'], ['ndash', '–'],
  ['mdash', '—'], ['lsquo', '‘'], ['rsquo', '’'], ['sbquo', '‚'], ['ldquo', '“'], ['rdquo', '”'],
  ['bdquo', '„'], ['dagger', '†'], ['Dagger', '‡'], ['bull', '•'], ['hellip', '…'], ['permil', '‰'],
  ['prime', '′'], ['Prime', '″'], ['lsaquo', '‹'], ['rsaquo', '›'], ['euro', '€'], ['trade', '™'],
]);

/** Numeric references 0x80–0x9F mean Windows-1252, as the HTML parser reads them. */
const WINDOWS_1252 = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020],
  [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152],
  [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022],
  [0x96, 0x2013], [0x97, 0x2014], [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a],
  [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
]);

/** @param {string} value */
function decodeEntities(value) {
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (match, dec, hex, name) => {
    if (name) return NAMED_ENTITIES.get(name) ?? match;
    let codePoint = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    codePoint = WINDOWS_1252.get(codePoint) ?? codePoint;
    if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '�';
    return String.fromCodePoint(codePoint);
  });
}

/** The characters `validateImageCreditRecord` refuses: bidi overrides/isolates and non-space controls. */
const BIDI_CONTROL_RX = /[‪-‮⁦-⁩]/g;
const NON_SPACE_CONTROL_RX = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;

/**
 * Text as a credit may carry it: NFC, no bidi override, no control character,
 * whitespace collapsed. `null` stays `null`.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function cleanCreditText(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .normalize('NFC')
    .replace(BIDI_CONTROL_RX, '')
    .replace(NON_SPACE_CONTROL_RX, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Raw-text elements: their content is not markup and never text a reader sees. */
const DROPPED_RAW_ELEMENTS = new Set(['script', 'style']);
/**
 * Elements a browser lays out on their own line: their boundary separates
 * words. `textContent` would glue «Name<br>City» into «NameCity».
 */
const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'ol', 'p', 'pre', 'section',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const TAG_RX = /<(\/?)([A-Za-z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<[!?][^>]*>/y;
const ATTRIBUTE_RX = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** @param {string} source */
function parseAttributes(source) {
  /** @type {Map<string, string>} */
  const attributes = new Map();
  for (const m of source.matchAll(ATTRIBUTE_RX)) {
    const name = m[1].toLowerCase();
    if (!attributes.has(name)) attributes.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attributes;
}

/**
 * What a reader of the Commons page does not see: hidden elements (Commons
 * writes «Unknown<span style="display: none;">Unknown </span>»), MediaWiki's
 * `.mw-hidden`, and reference marks.
 *
 * @param {string} name
 * @param {Map<string, string>} attributes
 */
function isHiddenElement(name, attributes) {
  const cls = ` ${attributes.get('class') ?? ''} `;
  if (name === 'sup' && /\sreference\s/.test(cls)) return true;
  if (/\smw-hidden\s/.test(cls)) return true;
  return /display\s*:\s*none/i.test(attributes.get('style') ?? '');
}

/** Commons hrefs are protocol- or site-relative. */
function absoluteCommonsHref(value) {
  const href = value.trim();
  if (!href) return null;
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) return `https://commons.wikimedia.org${href}`;
  return href;
}

/**
 * Commons `extmetadata` HTML reduced to what a reader sees: the text and the
 * links, in order. `null` in, `{ text: null }` out — absent is not empty.
 *
 * @param {unknown} html
 * @returns {{ text: string | null, links: { href: string | null, text: string }[], hasHtml: boolean }}
 */
export function sanitizeCommonsHtml(html) {
  if (html === null || html === undefined) return { text: null, links: [], hasHtml: false };
  const source = String(html);
  /** @type {{ name: string, hidden: boolean, anchor: { href: string | null, raw: string } | null }[]} */
  const stack = [];
  const anchors = [];
  let text = '';
  const hiddenNow = () => stack.length > 0 && stack[stack.length - 1].hidden;
  const append = (chunk) => {
    if (!chunk || hiddenNow()) return;
    text += chunk;
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      if (stack[k].anchor) { stack[k].anchor.raw += chunk; break; }
    }
  };
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) { append(decodeEntities(source.slice(i))); break; }
    if (lt > i) append(decodeEntities(source.slice(i, lt)));
    i = lt;
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    TAG_RX.lastIndex = i;
    const m = TAG_RX.exec(source);
    if (!m) { append('<'); i += 1; continue; }
    i = TAG_RX.lastIndex;
    if (!m[2]) continue; // <!doctype …>, <?…>: not content
    const name = m[2].toLowerCase();
    if (BLOCK_ELEMENTS.has(name)) append(' ');
    if (m[1] === '/') {
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      continue;
    }
    if (DROPPED_RAW_ELEMENTS.has(name)) {
      const close = source.toLowerCase().indexOf(`</${name}`, i);
      const end = close === -1 ? -1 : source.indexOf('>', close);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (VOID_ELEMENTS.has(name)) continue;
    const attributes = parseAttributes(m[3]);
    if (name === 'a') {
      // HTML closes an open <a> when another one starts.
      const open = stack.findIndex((entry) => entry.name === 'a');
      if (open !== -1) stack.length = open;
    }
    const hidden = hiddenNow() || isHiddenElement(name, attributes);
    let anchor = null;
    if (name === 'a' && attributes.has('href') && !hidden) {
      anchor = { href: absoluteCommonsHref(attributes.get('href')), raw: '' };
      anchors.push(anchor);
    }
    stack.push({ name, hidden, anchor });
  }
  return {
    text: cleanCreditText(text),
    links: anchors.map((a) => ({ href: a.href, text: cleanCreditText(a.raw) })),
    hasHtml: /<[a-z][^>]*>/i.test(source),
  };
}

/**
 * Where a link points, in the probe's vocabulary (`analyze.mjs`). The author
 * rule only trusts the first link's text when it is a profile.
 *
 * @param {string | null} href
 */
export function commonsLinkKind(href) {
  if (!href) return 'none';
  let u;
  try { u = new URL(href); } catch { return 'bad'; }
  const host = u.hostname;
  if (host === 'commons.wikimedia.org' && /^\/wiki\/User:/.test(u.pathname)) return 'commons-user';
  if (host === 'commons.wikimedia.org' && /redlink=1/.test(u.search)) return 'commons-redlink';
  if (host === 'commons.wikimedia.org' && /^\/wiki\/Creator:/.test(u.pathname)) return 'commons-creator';
  if (host === 'commons.wikimedia.org') return 'commons-other';
  if (host.endsWith('.wikipedia.org') && /\/wiki\/User:/.test(u.pathname)) return 'wikipedia-user';
  if (host.endsWith('.wikipedia.org')) return 'wikipedia-article';
  if (host === 'www.wikidata.org') return 'wikidata';
  if (/flickr\.com$/.test(host)) return 'flickr';
  if (/panoramio/.test(host)) return 'panoramio';
  return `external:${host.replace(/^www\./, '')}`;
}

/** The 15 shapes of `Artist` the probe found on the 531 existing files. */
export const ARTIST_SHAPES = Object.freeze([
  'one-link:commons-user', 'one-link:commons-user+text', 'one-link:commons-redlink',
  'one-link:commons-other', 'one-link:wikidata', 'one-link:wikipedia-article', 'one-link:flickr',
  'one-link:flickr+text', 'one-link:external', 'one-link:external+text', 'multi-link',
  'plain-text', 'html-no-link', 'unknown-author', 'absent',
]);

const UNKNOWN_AUTHOR_RX = /\b(unknown|anonymous|anonym|unbekannt|sconosciut|inconnu|not known)\b/i;

/**
 * The probe's classification of an `Artist` value (diagnostics and fixtures).
 *
 * @param {unknown} raw the HTML as Commons returns it
 * @param {ReturnType<typeof sanitizeCommonsHtml>} [reduced]
 */
export function classifyArtistShape(raw, reduced = sanitizeCommonsHtml(raw)) {
  if (raw === null || raw === undefined) return 'absent';
  if (!reduced.text) return 'empty';
  if (UNKNOWN_AUTHOR_RX.test(reduced.text)) return 'unknown-author';
  if (!reduced.hasHtml) return 'plain-text';
  if (reduced.links.length === 0) return 'html-no-link';
  if (reduced.links.length > 1) return 'multi-link';
  const kind = commonsLinkKind(reduced.links[0].href);
  const fullyLinked = reduced.links[0].text === reduced.text;
  return `one-link:${kind.startsWith('external:') ? 'external' : kind}${fullyLinked ? '' : '+text'}`;
}

// ── Licences ───────────────────────────────────────────────────────────────

/**
 * The probe's licence classes. Hardening over the probe: a Creative Commons
 * licence with an NC or ND element is never read as plain CC BY — Commons
 * hosts neither today, and this keeps it so if one ever slips through.
 *
 * @param {unknown} shortName `LicenseShortName`
 * @param {unknown} code `License`
 */
export function commonsLicenceClass(shortName, code) {
  const s = String(shortName ?? '').toLowerCase();
  const c = String(code ?? '').toLowerCase();
  if (/\b(?:nc|nd)\b/.test(s) || /-(?:nc|nd)(?:-|$)/.test(c)) return `OTHER:${shortName || code}`;
  if (/^cc[- ]?by[- ]sa/.test(s) || /^cc-by-sa/.test(c)) return 'CC BY-SA';
  if (/^cc[- ]?by(?![- ]?sa)/.test(s) || /^cc-by(?!-sa)/.test(c)) return 'CC BY';
  if (/cc0|cc-zero/.test(s) || c === 'cc0') return 'CC0';
  if (/public domain|^pd/.test(s) || c.startsWith('pd')) return 'Public domain';
  if (/gfdl/.test(s) || c.startsWith('gfdl')) return 'GFDL';
  if (/attribution/.test(s) || c === 'attribution') return 'Attribution (free, Commons)';
  if (/no restrictions/.test(s)) return 'No restrictions (Flickr Commons)';
  if (/copyrighted free use/.test(s)) return 'Copyrighted free use';
  if (/ogl|open government/.test(s)) return 'OGL';
  if (/fal|free art/.test(s)) return 'Free Art License';
  return `OTHER:${shortName || code || 'none'}`;
}

/** Licence class → record family. A class not here cannot be credited. */
const FAMILY_OF_CLASS = Object.freeze({
  'CC BY-SA': 'cc-by-sa',
  'CC BY': 'cc-by',
  CC0: 'cc0',
  'Public domain': 'pd',
  'No restrictions (Flickr Commons)': 'no-known-restrictions',
  'Free Art License': 'fal',
  'OTHER:GODL-India': 'other-attribution',
  'Attribution (free, Commons)': 'other-attribution',
});

/** Where attribution is a courtesy, an unknown author is acceptable. */
const COURTESY_CLASSES = new Set(['CC0', 'Public domain', 'No restrictions (Flickr Commons)']);
const DEFAULT_LICENCE_NAME = Object.freeze({ cc0: 'CC0', pd: 'Public domain', 'no-known-restrictions': 'No restrictions' });

// ── The acceptance rule (probe review-queue-v2) ────────────────────────────

const SENTENCE_RX = /\b(appreciate|notif|feel free|please|mention me|thank you|visiting|do not copy|this file|requested|note:|acquired on|provided by|camera|lens|original uploader|courtesy of|stitched by|possibly)\b/i;
const EMAIL_HINT_RX = /@|\(at\)|\[at\]/i;
const PERSON_LINK_KINDS = new Set(['commons-user', 'commons-redlink', 'wikipedia-user', 'wikidata', 'flickr', 'commons-creator', 'wikipedia-article']);

/** Signatures and talk links are not part of a name. */
function stripSignature(value) {
  return String(value ?? '')
    .replace(/\s*\((talk|discussione|diskussion|discussion)\)\s*/gi, ' ')
    .replace(/\d{1,2}:\d{2}, \d{1,2} \w+ \d{4} \(UTC\)/g, '')
    .replace(/^User:/, '')
    .trim();
}

/**
 * A clean name from `Artist` alone: the first profile link's text, else the
 * plain text when it reads as a name (short, no sentence, no address).
 *
 * @param {string | null} artistText
 * @param {{ href: string | null, text: string, kind: string }[]} artistLinks
 */
function nameFromArtist(artistText, artistLinks) {
  const text = stripSignature(artistText);
  if (!text || /\b(unknown|anonym)/i.test(text)) return { name: null, via: 'no-author', link: null };
  const links = artistLinks.filter((l) => l.text && !/^(talk|discussione)$/i.test(l.text));
  if (links.length >= 1 && PERSON_LINK_KINDS.has(links[0].kind)) {
    const linkText = stripSignature(links[0].text);
    if (linkText && linkText.length <= 60 && !SENTENCE_RX.test(linkText) && !EMAIL_HINT_RX.test(linkText) && !/^https?:/.test(linkText)) {
      return { name: linkText, via: 'first-profile-link', link: links[0] };
    }
  }
  if (!SENTENCE_RX.test(text) && !EMAIL_HINT_RX.test(text) && !/^https?:/.test(text) && text.length <= 80) {
    return { name: text, via: 'plain-text', link: links[0] ?? null };
  }
  return { name: null, via: 'artist-not-a-name', link: null };
}

/**
 * The name the credit uses. `Attribution` wins when present (CommonsMetadata:
 * it replaces Artist + Credit), if it is short and is not an instruction or an
 * address; otherwise the Artist rule above.
 */
function creditName(attributionText, artistText, artistLinks) {
  if (attributionText) {
    const attribution = attributionText.replace(/^"|"$/g, '').trim();
    if (!SENTENCE_RX.test(attribution) && !EMAIL_HINT_RX.test(attribution) && attribution.length <= 100) {
      return { name: attribution, via: 'attribution', attribution };
    }
    return { name: null, via: 'attribution-needs-curation', attribution: null };
  }
  return { ...nameFromArtist(artistText, artistLinks), attribution: null };
}

/**
 * A Commons file as the API describes it, independent of `formatversion`:
 * `{ title, exists, pageId, width, height, revision, pageUrl, meta }` with
 * `meta` the plain `extmetadata` values. This is also the shape of the
 * backfill snapshot.
 *
 * @param {any} page a `query.pages` entry
 */
export function readCommonsPage(page) {
  const title = String(page?.title ?? '').replace(/^File:/, '');
  const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
  const missing = page?.missing !== undefined || page?.invalid !== undefined || !info;
  if (missing) return { title, exists: false };
  /** @type {Record<string, string>} */
  const meta = {};
  for (const [key, entry] of Object.entries(info.extmetadata ?? {})) {
    const value = entry && typeof entry === 'object' ? entry.value : entry;
    if (value !== undefined && value !== null) meta[key] = String(value);
  }
  return {
    title,
    exists: true,
    pageId: page.pageid,
    width: info.width,
    height: info.height,
    revision: info.timestamp,
    pageUrl: info.descriptionurl,
    meta,
  };
}

/**
 * The acceptance rule, verbatim from the probe (`review-queue-v2.mjs`):
 *
 *   replace  the file is deleted, or GFDL-only (the licence wants its full
 *            text with every copy);
 *   review   a licence the record cannot name (none machine-readable,
 *            anything not in FAMILY_OF_CLASS), a reuse restriction
 *            (personality, insignia, …), no clean name where attribution is
 *            required, a non-name or an instruction where it is a courtesy,
 *            an address in the author text with no attribution to use instead;
 *   ok       everything else.
 *
 * Plus `NonFree`, which the probe never met: never credited, always review.
 *
 * @param {ReturnType<typeof readCommonsPage>} file
 */
export function assessCommonsFile(file) {
  const title = file?.title ?? '';
  if (!file?.exists) {
    return { title, exists: false, decision: 'replace', reasons: ['deleted-on-commons'] };
  }
  const meta = file.meta ?? {};
  const artist = sanitizeCommonsHtml(meta.Artist ?? null);
  const artistLinks = artist.links.map((link) => ({ ...link, kind: commonsLinkKind(link.href) }));
  const attributionText = sanitizeCommonsHtml(meta.Attribution ?? null).text;
  const licenceClass = commonsLicenceClass(meta.LicenseShortName, meta.License);
  const restrictions = String(meta.Restrictions ?? '');
  const family = Object.hasOwn(FAMILY_OF_CLASS, licenceClass) ? FAMILY_OF_CLASS[licenceClass] : null;
  const reasons = [];
  let decision = 'ok';
  if (!family) {
    decision = licenceClass === 'GFDL' ? 'replace' : 'review';
    reasons.push(`licence:${licenceClass}`);
  }
  if (restrictions) {
    reasons.push(`restriction:${restrictions}`);
    if (decision === 'ok') decision = 'review';
  }
  const named = creditName(attributionText, artist.text, artistLinks);
  const courtesy = COURTESY_CLASSES.has(licenceClass);
  if (!named.name && !courtesy) {
    reasons.push(`author:${named.via}`);
    if (decision === 'ok') decision = 'review';
  }
  if (!named.name && courtesy && named.via !== 'no-author') {
    reasons.push(`author:${named.via}(courtesy)`);
    if (decision === 'ok') decision = 'review';
  }
  if (EMAIL_HINT_RX.test(artist.text ?? '') && !attributionText) {
    reasons.push('email-in-artist');
    if (decision === 'ok') decision = 'review';
  }
  if (meta.NonFree && meta.NonFree.toLowerCase() !== 'false') {
    reasons.push('non-free');
    if (decision === 'ok') decision = 'review';
  }
  return {
    title,
    exists: true,
    decision,
    reasons,
    licenceClass,
    family,
    artistShape: classifyArtistShape(meta.Artist ?? null, artist),
    artistText: artist.text,
    artistLinks,
    attributionText,
    named,
  };
}

// ── The record ─────────────────────────────────────────────────────────────

/** Institutions, not people: archives, agencies, ministries, Flickr Commons members. */
const ORGANIZATION_RX = /\b(ministry|department|office|archive|archief|library|bibliothek|nasa|county|government|museum|agency|collection|images|corporation|federal|european union|copernicus|police|university|foundation|swisstopo|topograph|wellcome)\b/i;

/** «CC BY-SA 3.0 at» → «CC BY-SA 3.0 AT»: a port's jurisdiction is a country code. */
function licenceDisplayName(shortName, family) {
  const name = cleanCreditText(shortName);
  if (!name) return DEFAULT_LICENCE_NAME[family] ?? null;
  return name.replace(/^(CC .*\d\.\d) ([a-z]{2})$/i, (_m, base, port) => `${base} ${port.toUpperCase()}`);
}

/** The file page of a title, when the API did not hand one over. */
function commonsFilePageUrl(title) {
  return `${COMMONS_FILE_PAGE}${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Everything a record says about the FILE — all but `cover` and `modified`,
 * which belong to the cover cut from it. `status` is `ok` only for a file the
 * rule accepts, `review` otherwise; only the backfill, after human curation,
 * turns a reviewed file into a written `ok` record.
 *
 * @param {ReturnType<typeof assessCommonsFile>} assessment
 * @param {ReturnType<typeof readCommonsPage>} file
 * @param {{ fetchedAt: string }} options
 */
export function creditTemplate(assessment, file, { fetchedAt }) {
  const { named } = assessment;
  // With an attribution, the author is still the Artist's name when it has
  // one; else the attribution names whom to credit. The link is only ever the
  // profile the name was read from: Artist's other links can be the uploader's
  // («Unknown, upload by <User:…>»), and the uploader is never the author.
  const artistName = named.via === 'attribution' ? nameFromArtist(assessment.artistText, assessment.artistLinks) : named;
  const name = named.via === 'attribution' ? (artistName.name ?? named.attribution) : named.name;
  const link = artistName.name ? artistName.link : null;
  const authorUrl = name && link?.href && isAllowedAuthorUrl(link.href) ? link.href : null;
  const family = assessment.family;
  const meta = file.meta ?? {};
  const required = String(meta.AttributionRequired ?? '').toLowerCase();
  const commons = { title: file.title, pageUrl: file.pageUrl || commonsFilePageUrl(file.title) };
  if (isPositiveInteger(file.pageId)) commons.pageId = file.pageId;
  if (isPositiveInteger(file.width)) commons.width = file.width;
  if (isPositiveInteger(file.height)) commons.height = file.height;
  if (typeof file.revision === 'string' && file.revision) commons.revision = file.revision;
  if (Array.isArray(file.aliases) && file.aliases.length) commons.aliases = [...file.aliases];
  return {
    schema: IMAGE_CREDIT_SCHEMA_VERSION,
    source: IMAGE_CREDIT_SOURCE,
    commons,
    author: {
      text: assessment.artistText || null,
      name: name || null,
      url: authorUrl,
      type: ORGANIZATION_RX.test(named.attribution ?? name ?? assessment.artistText ?? '') ? 'Organization' : 'Person',
    },
    attribution: named.via === 'attribution' ? named.attribution : null,
    licence: {
      name: licenceDisplayName(meta.LicenseShortName, family),
      url: normaliseLicenceUrl(meta.LicenseUrl),
      family,
      attributionRequired: required === 'true' ? true : required === 'false' ? false : !COURTESY_CLASSES.has(assessment.licenceClass),
    },
    restrictions: String(meta.Restrictions ?? '').split('|').map((r) => r.trim()).filter(Boolean),
    fetchedAt,
    status: assessment.decision === 'ok' ? 'ok' : 'review',
    curation: null,
  };
}

/**
 * The record of one cover: the template's file fields plus the cover's own.
 * Keys in schema order, so a rewrite never reorders a diff.
 */
export function finalizeCreditRecord(template, { cover, modified }) {
  return {
    schema: template.schema,
    cover,
    source: template.source,
    commons: template.commons,
    author: template.author,
    attribution: template.attribution,
    licence: template.licence,
    restrictions: template.restrictions,
    modified,
    fetchedAt: template.fetchedAt,
    status: template.status,
    curation: template.curation,
  };
}

/** A record's file fields, to credit a second cover cut from the same file. */
export function inheritCreditTemplate(record) {
  const { cover, modified, ...template } = structuredClone(record);
  void cover; void modified;
  return template;
}

/** Any cover key passes the validator; used to check a template before the cover exists. */
const PROVISIONAL_COVER = '/images/blog/provisional-cover.webp';

/**
 * The generator's verdict on a search result: `ok` with the record template,
 * or the reasons it cannot be credited. Only an `ok` file whose record would
 * validate is accepted — the cover is downloaded only after this says yes.
 *
 * @param {ReturnType<typeof readCommonsPage>} file
 * @param {{ fetchedAt?: string }} [options]
 */
export function acceptCommonsCandidate(file, { fetchedAt = utcDate() } = {}) {
  const assessment = assessCommonsFile(file);
  if (assessment.decision !== 'ok') return { ok: false, title: assessment.title, reasons: assessment.reasons };
  const template = creditTemplate(assessment, file, { fetchedAt });
  const { valid, errors } = validateImageCreditRecord(finalizeCreditRecord(template, { cover: PROVISIONAL_COVER, modified: 'resized' }));
  if (!valid) return { ok: false, title: assessment.title, reasons: errors.map((e) => `record:${e}`) };
  return { ok: true, title: assessment.title, template };
}

/**
 * `cropped` when the cover's aspect ratio differs from the original's by more
 * than 2%, else `resized` (every cover is at least resized and re-encoded).
 * `null` when a size is unknown.
 */
export function modifiedFor(original, cover) {
  const ow = Number(original?.width);
  const oh = Number(original?.height);
  const cw = Number(cover?.width);
  const ch = Number(cover?.height);
  if (!(ow > 0 && oh > 0 && cw > 0 && ch > 0)) return null;
  const ratio = ow / oh;
  return Math.abs(cw / ch - ratio) / ratio > 0.02 ? 'cropped' : 'resized';
}

/**
 * Width and height from a WebP header (lossy, lossless or extended), or null.
 * Header bytes only: no decoder, no dependency.
 *
 * @param {Uint8Array} bytes
 */
export function webpDimensions(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  return null;
}

/**
 * The record for a cover just written to disk. The cover's size comes from
 * its header; when it cannot be read the pipeline's target size stands in,
 * and when the original's size is unknown the change is declared as a crop —
 * overstating a modification is safe, understating it is not.
 *
 * @param {ReturnType<typeof creditTemplate>} template
 * @param {{ cover: string, original?: { width?: number, height?: number }, coverSize?: { width: number, height: number } | null }} cover
 */
export function creditRecordForCover(template, { cover, original, coverSize }) {
  const modified = modifiedFor(original, coverSize ?? GENERATED_COVER_SIZE) ?? 'cropped';
  return finalizeCreditRecord(template, { cover, modified });
}

// ── Usage: what has already been taken ─────────────────────────────────────

/**
 * The Commons file of an upload URL, in either form the API hands out:
 *   https://upload.wikimedia.org/wikipedia/commons/a/ab/<File>
 *   https://{upload,thumb}.wikimedia.org/wikipedia/commons/thumb/a/ab/<File>/<NNNpx-File>[?utm_…]
 * Returned as a title without `File:` (underscores as spaces), or null.
 *
 * @param {unknown} url
 */
export function titleFromCommonsUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.hostname !== 'upload.wikimedia.org' && u.hostname !== 'thumb.wikimedia.org') return null;
  const m = u.pathname.match(/^\/wikipedia\/commons\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/([^/]+)\/[^/]+$/)
    || u.pathname.match(/^\/wikipedia\/commons\/[0-9a-f]\/[0-9a-f]{2}\/([^/]+)$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).replace(/_/g, ' ');
  } catch {
    return null;
  }
}

/**
 * Which Commons files the corpus already uses: every title in the two usage
 * maps, and every publishable record (its title and aliases). `records`
 * maps a title to the record a reuse inherits.
 *
 * @param {string} root repository root
 */
export function loadCommonsUsage(root) {
  /** @type {Set<string>} */
  const titles = new Set();
  /** @type {Map<string, Record<string, any>>} */
  const records = new Map();
  for (const rel of COMMONS_USAGE_MAPS) {
    let map;
    try {
      map = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8'));
    } catch {
      continue; // the site's legacy copy only exists from the backfill on
    }
    for (const url of Object.values(map ?? {})) {
      const title = titleFromCommonsUrl(url);
      if (title) titles.add(title);
    }
  }
  for (const { key, record } of readCreditRecords(root)) {
    if (!record || record.status !== 'ok' || coverKey(record.cover) !== key) continue;
    if (!validateImageCreditRecord(record).valid) continue;
    for (const title of [record.commons.title, ...(record.commons.aliases ?? [])]) {
      titles.add(title);
      if (!records.has(title)) records.set(title, record);
    }
  }
  return { titles, records };
}

/**
 * The credit for a candidate: a file already credited inherits its record
 * (so a curated author or an owner-accepted restriction carries over, and the
 * two covers agree); any other file must pass `acceptCommonsCandidate`, which
 * also refuses reuse restrictions on a NEW pick. `reused` marks a file the
 * corpus already uses, which the caller takes only as a last resort.
 *
 * @param {ReturnType<typeof readCommonsPage>} file
 * @param {ReturnType<typeof loadCommonsUsage>} usage
 * @param {{ fetchedAt?: string }} [options]
 */
export function chooseCommonsCredit(file, usage, options = {}) {
  const existing = usage.records.get(file.title);
  if (existing) return { ok: true, title: file.title, template: inheritCreditTemplate(existing), reused: true };
  const verdict = acceptCommonsCandidate(file, options);
  return { ...verdict, reused: usage.titles.has(file.title) };
}

// ── One file, by title (journalist picks) ──────────────────────────────────

/**
 * One read-only API call for one file (`titles=File:<title>`), following
 * redirects. Returns the `readCommonsPage` shape; a renamed file carries the
 * requested title in `aliases`.
 *
 * @param {string} title without `File:`
 * @param {{ fetchImpl?: typeof fetch, userAgent?: string, timeoutMs?: number }} [options]
 */
export async function fetchCommonsFileInfo(title, { fetchImpl = globalThis.fetch, userAgent = COMMONS_USER_AGENT, timeoutMs = 15_000 } = {}) {
  const url = `${COMMONS_API}?action=query&format=json&formatversion=2&redirects=1&maxlag=5&${COMMONS_IMAGEINFO_PARAMS}`
    + `&titles=${encodeURIComponent(`File:${title}`)}`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': userAgent, 'Api-User-Agent': userAgent, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Commons API HTTP ${res.status}`);
  const json = await res.json();
  if (json?.error) throw new Error(`Commons API error ${json.error.code ?? 'unknown'}`);
  const pages = json?.query?.pages;
  const page = Array.isArray(pages) ? pages[0] : Object.values(pages ?? {})[0];
  if (!page) throw new Error('Commons API returned no page');
  const file = readCommonsPage(page);
  if (file.exists && file.title !== title) file.aliases = [title];
  return file;
}

/**
 * The credit of a journalist's picked URL. Not a Commons upload URL →
 * `{ commons: false }` and the caller proceeds as before. A Commons file
 * already credited inherits its record without a request; any other one costs
 * one API call and must pass the same rule as the generator's picks. A failed
 * call is a refusal: a Commons cover never goes out without its credit.
 *
 * @param {{ root: string, url: string, fetchImpl?: typeof fetch, fetchedAt?: string }} input
 */
export async function resolveCommonsPick({ root, url, fetchImpl = globalThis.fetch, fetchedAt = utcDate() }) {
  const title = titleFromCommonsUrl(url);
  if (!title) return { commons: false };
  const usage = loadCommonsUsage(root);
  const existing = usage.records.get(title);
  if (existing) {
    return {
      commons: true, ok: true, title, reused: true,
      template: inheritCreditTemplate(existing),
      original: { width: existing.commons.width, height: existing.commons.height },
    };
  }
  let file;
  try {
    file = await fetchCommonsFileInfo(title, { fetchImpl });
  } catch (error) {
    return { commons: true, ok: false, title, reasons: [`commons-api:${error instanceof Error ? error.message : String(error)}`] };
  }
  const verdict = chooseCommonsCredit(file, usage, { fetchedAt });
  if (!verdict.ok) return { commons: true, ok: false, title: file.title || title, reasons: verdict.reasons };
  return {
    commons: true, ok: true, title: file.title, reused: verdict.reused,
    template: verdict.template,
    original: { width: file.width, height: file.height },
  };
}

// ── Writing and reading records ────────────────────────────────────────────

/** `content/image-credits/blog/<key>.json` under `root`. */
export function creditRecordPath(root, key) {
  return path.join(root, IMAGE_CREDIT_RECORDS_DIR, `${key}.json`);
}

/**
 * Validates and writes one record, atomically (temp + rename). Throws on an
 * invalid record: the caller then drops the cover, because a Commons cover
 * without a valid credit is exactly what P14 removes.
 *
 * @returns {string} the path written
 */
export function writeCreditRecord(root, record) {
  const { valid, errors } = validateImageCreditRecord(record);
  if (!valid) throw new Error(`credit record for ${record?.cover} is invalid: ${errors.join('; ')}`);
  const file = creditRecordPath(root, coverKey(record.cover));
  writeJsonAtomic(file, record);
  return file;
}

/** The publishable record of a cover path, or null — what the engine page will show. */
export function coverCreditFor(root, cover) {
  return corpusCreditReader(root).get(cover);
}

/** Today in UTC, `YYYY-MM-DD` (the record's `fetchedAt`). */
export function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
