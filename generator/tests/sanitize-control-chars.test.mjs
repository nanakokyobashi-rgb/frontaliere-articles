/**
 * scripts/lib/sanitize-control-chars.mjs — the output-boundary guard. `node --test`.
 *
 * ## What broke
 *
 * Two article titles in `content/` carry raw C0 bytes (upstream mangling of
 * «sarà» into `sar\u00170` and of «martedì» into `marted\u00088`). Every
 * emitter treated them as ordinary text and forwarded them:
 *
 *   - `sitemap-blog.xml` shipped 0x08 and 0x17 inside `<image:title>` at lines
 *     8745 and 10089 of 3120 `<url>` blocks. XML 1.0 §2.2 admits no C0 but
 *     TAB/LF/CR, so the document was not well-formed and a strict consumer may
 *     reject ALL of it — a 3120-url sitemap lost to four bytes.
 *   - the live apex page shipped them raw in `<title>`, `og:title`,
 *     `og:image:alt`, `<h1>` and the hero `alt`, and JSON-escaped inside the
 *     `ld+json` `headline`/`caption`/`name`.
 *   - `meta-it.json` and `data/blog-index-frontaliere-it-full.json` shipped
 *     them through `JSON.stringify`, which escapes them into VALID JSON — so
 *     nothing anywhere raised, and a byte scan of the artifact found nothing.
 *
 * ## Why the assertions look like this
 *
 * The failure is a silent one on both sides, so the cases below pin the two
 * spellings separately (raw byte, and `\u00XX`/`\b` escape) and pin what must
 * NOT change — TAB/LF/CR, accented text, a `\b` word boundary inside a regex
 * literal. A sanitiser that eats one character too many is a corpus corrupter,
 * which is a worse bug than the one it fixes.
 *
 * No XML library is used, deliberately: this repo's gates are dependency-free,
 * and the property that was violated is character legality, not tag structure.
 * `assertXmlCharsLegal` below is exactly the check a strict parser fails on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isInvalidControlCode,
  sanitizeText,
  sanitizeDeep,
  sanitizeXmlDocument,
  sanitizeHtmlDocument,
  sanitizeJsonText,
  findControlChars,
  assertNoControlChars,
} from '../../scripts/lib/sanitize-control-chars.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The two real titles, byte-for-byte as `content/` holds them. */
const DIRTY_TITLE = 'Trump: "Intesa o sar\u00170 l\'inferno". Il giallo dell\'ultimatum spostato a marted\u00088';
const DIRTY_QUOTED = 'Il \u00083territorio poroso\u00083 tra Varese e la Svizzera';
const CLEAN_TITLE = 'Trump: "Intesa o sar0 l\'inferno". Il giallo dell\'ultimatum spostato a marted8';

/** Every character an XML 1.0 document may contain (§2.2). */
function assertXmlCharsLegal(xml, label) {
  for (let i = 0; i < xml.length; i++) {
    const code = xml.charCodeAt(i);
    const legal =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd);
    assert.ok(
      legal,
      `${label}: character 0x${code.toString(16)} at ${i} is not permitted in XML 1.0 — ` +
        `a strict parser rejects the whole document here`,
    );
  }
}

// ── the predicate ────────────────────────────────────────────────────────

test('the three C0 characters XML and JSON both admit are not "invalid"', () => {
  assert.equal(isInvalidControlCode(0x09), false, 'TAB');
  assert.equal(isInvalidControlCode(0x0a), false, 'LF');
  assert.equal(isInvalidControlCode(0x0d), false, 'CR');
  assert.equal(isInvalidControlCode(0x20), false, 'SPACE is not C0');
  assert.equal(isInvalidControlCode(0xe0), false, 'à is not C0');
});

test('every other C0 code point is invalid, boundaries included', () => {
  for (let code = 0x00; code <= 0x1f; code++) {
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    assert.equal(isInvalidControlCode(code), true, `0x${code.toString(16)}`);
  }
});

// ── sanitizeText ─────────────────────────────────────────────────────────

test('strips the two bytes measured in the corpus, 0x08 and 0x17', () => {
  assert.equal(sanitizeText(DIRTY_TITLE), CLEAN_TITLE);
  assert.equal(sanitizeText(DIRTY_QUOTED), 'Il 3territorio poroso3 tra Varese e la Svizzera');
  assert.equal(findControlChars(sanitizeText(DIRTY_TITLE)).length, 0);
});

test('preserves TAB, LF and CR', () => {
  assert.equal(sanitizeText('a\tb\nc\r\nd'), 'a\tb\nc\r\nd');
});

test('leaves a clean string byte-identical, accents and typographic quotes included', () => {
  const clean = 'Perché «martedì» costa 1,20 CHF — e più: \u2019 \u201C \u201D';
  assert.equal(sanitizeText(clean), clean);
});

test('passes non-strings through untouched', () => {
  assert.equal(sanitizeText(null), null);
  assert.equal(sanitizeText(undefined), undefined);
  assert.equal(sanitizeText(42), 42);
});

// ── sanitizeDeep ─────────────────────────────────────────────────────────

test('sanitises nested values and object keys', () => {
  const dirty = {
    ['blog.article.x.ti\u0008tle']: DIRTY_TITLE,
    nested: { list: ['ok', DIRTY_QUOTED, 7, null] },
  };
  const clean = sanitizeDeep(dirty);
  assert.deepEqual(Object.keys(clean), ['blog.article.x.title', 'nested']);
  assert.equal(clean['blog.article.x.title'], CLEAN_TITLE);
  assert.equal(clean.nested.list[1], 'Il 3territorio poroso3 tra Varese e la Svizzera');
  assert.equal(clean.nested.list[2], 7);
  assert.equal(clean.nested.list[3], null);
});

test('a control character survives JSON.stringify as an escape — sanitising the VALUE is the only fix', () => {
  // This is the reason meta-it.json shipped poisoned for weeks with every gate
  // green: the serialised bytes are valid JSON, so nothing downstream raised.
  const serialisedDirty = JSON.stringify({ title: DIRTY_TITLE });
  assert.match(serialisedDirty, /\\b|\\u00/, 'stringify escapes rather than rejects');
  assert.equal(findControlChars(serialisedDirty).length, 0, 'a byte scan of the artifact sees nothing');
  assert.equal(JSON.parse(serialisedDirty).title, DIRTY_TITLE, 'but the consumer gets it back');

  const serialisedClean = JSON.stringify(sanitizeDeep({ title: DIRTY_TITLE }));
  assert.equal(JSON.parse(serialisedClean).title, CLEAN_TITLE);
  assert.doesNotMatch(serialisedClean, /\\u00[01]|\\b|\\f/);
});

test('refuses two keys that collapse onto the same key, in either order', () => {
  // Stripping a key is the one way this module can LOSE data: the poisoned key
  // and the clean one become the same string, and whichever arrives second
  // wins. A wrong article's title under the right key raises nothing anywhere,
  // so it stops here rather than being resolved by iteration order.
  const DIRTY_KEY = 'blog.article.x.ti\u0008tle';
  const CLEAN_KEY = 'blog.article.x.title';
  const dirtyFirst = { [DIRTY_KEY]: 'sbagliato', [CLEAN_KEY]: 'giusto' };
  const cleanFirst = { [CLEAN_KEY]: 'giusto', [DIRTY_KEY]: 'sbagliato' };
  assert.equal(Object.keys(dirtyFirst).length, 2, 'the two keys really are distinct');
  for (const [label, obj] of [['dirty first', dirtyFirst], ['clean first', cleanFirst]]) {
    assert.throws(() => sanitizeDeep(obj), /both become .*blog\.article\.x\.title.*refusing/s, label);
  }
});

test('a key that only needs sanitising, with no twin, still goes through', () => {
  assert.deepEqual(sanitizeDeep({ ['a\u0008b']: 1, c: 2 }), { ab: 1, c: 2 });
});

test('does not rebuild a non-plain object into a bare one', () => {
  const when = new Date('2026-08-08T00:00:00.000Z');
  const out = sanitizeDeep({ when });
  assert.equal(out.when, when);
  assert.equal(JSON.stringify(out), '{"when":"2026-08-08T00:00:00.000Z"}');
});

// ── sanitizeXmlDocument, and the sitemap entry that broke ────────────────

const xmlEsc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

test('a sitemap <url> block built from a dirty title is XML-legal after sanitising', () => {
  // The same shape build-api.mjs's buildSitemap() emits, at the field that
  // actually carried the bytes on the live file.
  const block =
    `  <url>\n` +
    `    <loc>https://frontaliereticino.ch/articoli-frontaliere/trump-intesa-o-inferno/</loc>\n` +
    `    <image:image>\n` +
    `      <image:loc>https://cdn.frontaliereticino.ch/images/blog/trump-intesa-o-inferno.webp</image:loc>\n` +
    `      <image:title>${xmlEsc(DIRTY_TITLE)}</image:title>\n` +
    `    </image:image>\n` +
    `  </url>\n`;
  const doc =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    block +
    `</urlset>\n`;

  // Escaping alone does not save it: xmlEsc handles markup characters and has
  // nothing to say about a control byte.
  assert.ok(findControlChars(doc).length > 0, 'the unsanitised document is the bug');
  assert.throws(() => assertXmlCharsLegal(doc, 'unsanitised'));

  const clean = sanitizeXmlDocument(doc);
  assertXmlCharsLegal(clean, 'sanitised');
  assert.ok(clean.includes(`<image:title>Trump: &quot;Intesa o sar0 l&#39;`) === false); // apostrophes are not escaped by xmlEsc
  assert.ok(clean.includes('spostato a marted8</image:title>'));
  assert.equal((clean.match(/<url>/g) ?? []).length, 1, 'the entry survives, only the bytes go');
});

test('a numeric character reference to a forbidden character is removed too', () => {
  // `&#8;` is another spelling of 0x08 and equally fatal; `&#233;` and
  // `&#x2019;` are ordinary text and must survive.
  const xml = '<t>a&#8;b&#x17;c&#233;d&#x2019;e&amp;f</t>';
  assert.equal(sanitizeXmlDocument(xml), '<t>abc&#233;d&#x2019;e&amp;f</t>');
});

test('a clean XML document comes back byte-identical', () => {
  const xml = '<?xml version="1.0"?>\n<a>Perché\tsì\r\n</a>\n';
  assert.equal(sanitizeXmlDocument(xml), xml);
});

// ── sanitizeHtmlDocument, and the JSON-LD block that shipped poisoned ────

/** The live page's shape, reduced to the tags that carried the bytes. */
const DIRTY_PAGE =
  `<!doctype html><html lang="it"><head>\n` +
  `<title>${xmlEsc(DIRTY_TITLE)}</title>\n` +
  `<meta property="og:title" content="${xmlEsc(DIRTY_TITLE)}">\n` +
  `<meta property="og:image:alt" content="${xmlEsc(DIRTY_TITLE)}">\n` +
  `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: DIRTY_TITLE,
    image: { caption: DIRTY_TITLE },
  })}</script>\n` +
  `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [{ '@type': 'ListItem', position: 3, name: DIRTY_TITLE }],
  })}</script>\n` +
  `<script>window.__ARTICLE_TITLE__=${JSON.stringify(DIRTY_TITLE)}</script>\n` +
  `<script defer src="https://cdn.frontaliereticino.ch/assets/adsense-loader.js"></script>\n` +
  `</head><body><h1>${xmlEsc(DIRTY_TITLE)}</h1>` +
  `<img src="/x.webp" alt="${xmlEsc(DIRTY_TITLE)}"></body></html>\n`;

test('strips the raw bytes from title, og:*, h1 and alt', () => {
  assert.ok(findControlChars(DIRTY_PAGE).length > 0);
  const clean = sanitizeHtmlDocument(DIRTY_PAGE);
  assert.equal(findControlChars(clean).length, 0);
  assert.ok(clean.includes(`<title>Trump: &quot;Intesa o sar0 l'inferno&quot;. Il giallo dell'ultimatum spostato a marted8</title>`));
  assert.ok(clean.includes(`<h1>Trump: &quot;Intesa o sar0 l'inferno&quot;`));
  assert.ok(clean.includes(`alt="Trump: &quot;Intesa o sar0 l'inferno&quot;`));
  assert.ok(clean.includes('<meta property="og:image:alt" content="Trump: &quot;Intesa o sar0'));
});

test('every ld+json block still parses, and parses CLEAN', () => {
  const clean = sanitizeHtmlDocument(DIRTY_PAGE);
  const blocks = [...clean.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 2, 'both structured-data blocks are still there');
  for (const [, body] of blocks) {
    const parsed = JSON.parse(body); // throws if the sanitiser broke the JSON
    assert.equal(findControlChars(JSON.stringify(parsed)).length, 0);
    const decoded = JSON.stringify(parsed);
    assert.doesNotMatch(decoded, /\\u00[01]|\\b|\\f/, 'no escaped control character survives');
  }
  const news = JSON.parse(blocks[0][1]);
  assert.equal(news.headline, CLEAN_TITLE);
  assert.equal(news.image.caption, CLEAN_TITLE);
  assert.equal(news['@type'], 'NewsArticle');
  const crumbs = JSON.parse(blocks[1][1]);
  assert.equal(crumbs.itemListElement[0].name, CLEAN_TITLE);
});

test('the escaped spelling inside an inline script is caught too', () => {
  // The raw-byte scan is blind here: JSON.stringify already turned 0x08 into
  // `\b` and 0x17 into `\u0017`, both of which are plain ASCII in the file.
  const withEscapes = `<script>window.__ARTICLE_TITLE__="marted\\b8 sar\\u00170"</script>`;
  assert.equal(findControlChars(withEscapes).length, 0, 'nothing for a byte scan to find');
  const clean = sanitizeHtmlDocument(withEscapes);
  assert.equal(clean, `<script>window.__ARTICLE_TITLE__="marted8 sar0"</script>`);
});

test('an escaped backslash is not mistaken for an escape opener', () => {
  const html = String.raw`<script>var s="C:\\backup\bfile"</script>`;
  // `\\` is a literal backslash; the `\b` right after it IS a backspace escape.
  assert.equal(sanitizeHtmlDocument(html), String.raw`<script>var s="C:\\backupfile"</script>`);
});

test('a \\b word boundary in a regex literal is left alone', () => {
  // The whole reason the escape pass is confined to double-quoted spans inside
  // inline scripts: deleting this `\b` would change what the program matches.
  const html = '<script>if(/\\bdark\\b/.test(document.documentElement.className)){}</script>';
  assert.equal(sanitizeHtmlDocument(html), html);
});

test('single-quoted string literals are covered too, not only double-quoted ones', () => {
  // JSON.stringify emits double quotes; hand-written inline script does not,
  // and the escape rules are the same in either.
  const html = "<script>var t='marted\\b8 sar\\u00170'</script>";
  assert.equal(sanitizeHtmlDocument(html), "<script>var t='marted8 sar0'</script>");
});

test('a single-quoted string containing double quotes is matched as one span', () => {
  // The exact shape the renderer emits; a naive alternation would open a
  // double-quoted span in the middle of it.
  const html =
    '<script>var ls=document.querySelectorAll(\'link[media="print"][href]\');' +
    "var u='x\\u0017y'</script>";
  assert.equal(
    sanitizeHtmlDocument(html),
    '<script>var ls=document.querySelectorAll(\'link[media="print"][href]\');' +
      "var u='xy'</script>",
  );
});

test('template literals are deliberately NOT covered, and the reason is the interpolation', () => {
  // A `${...}` can hold a regex literal, where `\b` is a word boundary. The
  // limit is documented on QUOTED; this pins it so it cannot be widened by
  // accident without someone reading why.
  const html = '<script>var t=`a\\bb${/\\bx\\b/.source}`</script>';
  assert.equal(sanitizeHtmlDocument(html), html);
});

test('an external script and a clean page are untouched', () => {
  const html =
    '<script defer src="https://cdn.frontaliereticino.ch/a.js"></script>' +
    '<p>Perché\tmartedì</p>\n';
  assert.equal(sanitizeHtmlDocument(html), html);
});

// ── sanitizeJsonText, the verbatim republishes ───────────────────────────

test('a clean JSON document is republished byte-identical, formatting included', () => {
  const raw = '{\n  "ranking": [ { "name": "Chiasso" } ]\n}\n';
  assert.equal(sanitizeJsonText(raw), raw, 'the verbatim contract holds');
});

test('a JSON document carrying an escaped control character is re-serialised clean', () => {
  const raw = JSON.stringify({ ranking: [{ name: 'Chi\u0008asso' }] });
  const out = sanitizeJsonText(raw);
  assert.notEqual(out, raw);
  assert.equal(JSON.parse(out).ranking[0].name, 'Chiasso');
});

test('an unparsable document is handed back for the caller to refuse', () => {
  assert.equal(sanitizeJsonText('{not json'), '{not json');
});

// ── the fail-closed gate ─────────────────────────────────────────────────

test('assertNoControlChars is silent on clean text and names the offenders otherwise', () => {
  assert.doesNotThrow(() => assertNoControlChars('tutto\tbene\n', 'x.xml'));
  assert.throws(
    () => assertNoControlChars(DIRTY_TITLE, 'sitemap-blog.xml'),
    /sitemap-blog\.xml: 2 XML-invalid control character\(s\).*0x17@.*0x08@/s,
  );
});

// ── the emitters are actually wired to it ────────────────────────────────
//
// A sanitiser nothing calls is the same defect with extra files. Checked
// statically, in the spirit of loop-scripts-closure.test.mjs: importing these
// scripts would RUN them (build-api.mjs writes dist/api at module scope).

test('every emitter that writes the public surface goes through the sanitiser', () => {
  const wired = {
    'scripts/build-api.mjs': [
      /from '\.\/lib\/sanitize-control-chars\.mjs'/,
      /sanitizeDeep\(value\)/,
      /sanitizeXmlDocument\(xml\)/,
      /sanitizeJsonText\(raw\)/,
      /assertNoControlChars\(/,
    ],
    'scripts/build-blog-index.mjs': [
      /from '\.\/lib\/sanitize-control-chars\.mjs'/,
      /sanitizeDeep\(payload\)/,
      /sanitizeDeep\(fullPayload\)/,
      /assertNoControlChars\(/,
    ],
    'scripts/publish-article-fast.mjs': [
      /from '\.\/lib\/sanitize-control-chars\.mjs'/,
      /sanitizeHtmlDocument\(indexHtml\)/,
      /writeFileSync\(indexAbs, indexClean/,
      /sanitizeHtmlDocument\(finalBridgeHtml\)/,
      /writeFileSync\(flatAbs, flatClean/,
    ],
    'scripts/refresh-hub-landing.mjs': [
      /from '\.\/lib\/sanitize-control-chars\.mjs'/,
      /sanitizeHtmlDocument\(patched\)/,
      /writeFileSync\(abs, cleanPage/,
    ],
  };

  // Le forme inline (`writeFileSync(abs, sanitize…(x))`) sono state spezzate in
  // due istruzioni da #133, perche' fra il sanitize e la scrittura ora passa
  // `reportStrippedControlChars`: il marker va registrato PRIMA di essere
  // distrutto. I pattern qui sopra seguono la forma nuova e restano due —
  // sanitize sull'input giusto, write del valore sanificato — cosi' che
  // scollegarli resti visibile.
  for (const [rel, patterns] of Object.entries(wired)) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
    for (const re of patterns) {
      assert.match(src, re, `${rel} no longer calls the sanitiser as ${re}`);
    }
  }
});

test('no source file under scripts/ carries a control character of its own', () => {
  // Cheap, and it is how the first attempt at this module broke: the regex
  // literal was authored with the raw bytes it was meant to match.
  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.(mjs|js|json)$/.test(e.name)) acc.push(p);
    }
    return acc;
  };
  const offenders = [];
  for (const file of walk(path.join(REPO_ROOT, 'scripts'))) {
    const found = findControlChars(fs.readFileSync(file, 'utf-8'));
    if (found.length > 0) offenders.push(`${path.relative(REPO_ROOT, file)} (${found.length})`);
  }
  assert.deepEqual(offenders, []);
});
