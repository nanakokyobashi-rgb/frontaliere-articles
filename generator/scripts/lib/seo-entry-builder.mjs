/**
 * Shared SEO entry builder/writer.
 *
 * `create-article.mjs` and the deterministic orphan recovery must emit the
 * same literal shape.  Keeping the builder and the comma-safe append operation
 * here prevents a recovery-only dialect of structured data from drifting away
 * from the normal generator.
 */
import { escapeForSingleQuoteTS } from './article-meta-block.mjs';
import { escapeRegExpLiteral } from './escape-regexp.mjs';

export const BASE_URL = 'https://frontaliereticino.ch';

/** Format a Date/string as the repository's ISO-8601-with-offset value. */
export function toIsoWithTz(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date for SEO structured data: ${value}`);
  const pad = (number) => String(number).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}`
    + `${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

function jsonValue(value) {
  return JSON.stringify(String(value ?? ''));
}

function imageRightsLines(provenance) {
  const record = provenance?.record;
  if (!record || typeof provenance.kind !== 'string') {
    throw new Error('SEO entry requires a governed image provenance record');
  }
  if (provenance.kind === 'wikimedia-commons') return '';
  if (provenance.kind === 'generated') {
    return `\n        "acquireLicensePage": ${jsonValue(record.licenseUrl)},`
      + `\n        "copyrightNotice": "Generated media; provider terms apply.",`
      + `\n        "license": ${jsonValue(record.licenseUrl)},`
      + '\n        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },'
      + `\n        "creditText": ${jsonValue(record.credit)},`;
  }
  if (provenance.kind === 'editorial-upload') {
    return `\n        "acquireLicensePage": ${jsonValue(record.proofUrl)},`
      + `\n        "copyrightNotice": ${jsonValue(`© ${record.rightsHolder}`)},`
      + `\n        "license": ${jsonValue(record.license)},`
      + `\n        "creator": { "@type": "Person", "name": ${jsonValue(record.author)} },`
      + `\n        "creditText": ${jsonValue(record.author)},`;
  }
  throw new Error(`Unsupported SEO image provenance kind: ${provenance.kind}`);
}

/** Build one complete `blog-<id>` literal, including JSON-LD. */
export function buildSeoEntry(data, {
  provenance,
  publishedAt = toIsoWithTz(new Date()),
  modifiedAt = publishedAt,
  hubSlug = 'articoli-frontaliere',
} = {}) {
  if (!data?.id || !data?.seo || !data?.slugs?.it || !data?._generatedImagePath) {
    throw new Error('buildSeoEntry: id, seo, slugs.it and _generatedImagePath are required');
  }
  const imagePath = data._generatedImagePath.replace(/^\//, '');
  const canonicalPath = `/${hubSlug}/${data.slugs.it}/`;
  const record = provenance?.record;
  const imageWidth = Number(record?.width) || 1200;
  const imageHeight = Number(record?.height) || 675;
  const headline = data.seo.headline || data.seo.title;
  const caption = data.imageAlt?.it || headline;
  const authorSlug = data.author?.slug || 'redazione';
  const authorName = data.author?.name || 'Redazione Frontaliere Ticino';
  const rights = imageRightsLines(provenance);

  return `
  'blog-${data.id}': {
    title: '${escapeForSingleQuoteTS(data.seo.title)}',
    description: '${escapeForSingleQuoteTS(data.seo.description)}',
    keywords: '${escapeForSingleQuoteTS(data.seo.keywords)}',
    ogTitle: '${escapeForSingleQuoteTS(data.seo.ogTitle)}',
    ogDescription: '${escapeForSingleQuoteTS(data.seo.ogDescription)}',
    canonicalPath: '${escapeForSingleQuoteTS(canonicalPath)}',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": ${jsonValue(headline)},
      "description": ${jsonValue(data.seo.description)},
      "image": {
        "@type": "ImageObject",${rights}
        "url": \`\${BASE_URL}/${imagePath}\`,
        "width": ${imageWidth},
        "height": ${imageHeight},
        "caption": ${jsonValue(caption)}
      },
      "datePublished": ${jsonValue(toIsoWithTz(publishedAt))},
      "dateModified": ${jsonValue(toIsoWithTz(modifiedAt))},
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": ${jsonValue(`${BASE_URL}/autori/${authorSlug}/#person`)},
        "name": ${jsonValue(authorName)},
        "url": ${jsonValue(`${BASE_URL}/autori/${authorSlug}/`)}
      },
      "publisher": {"@id": "${BASE_URL}/#organization"},
      "mainEntityOfPage": \`\${BASE_URL}${canonicalPath}\`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },`;
}

function replaceCaptureSafe(source, pattern, replacement) {
  return source.replace(pattern, (...args) => replacement(...args.slice(0, -2)));
}

/** Append a built entry before the metadata object's closing brace. */
export function appendSeoEntrySource(source, seoEntry, {
  seoConstName,
  updateRouterUnion = true,
  fileLabel = 'SEO file',
} = {}) {
  if (typeof source !== 'string' || typeof seoEntry !== 'string' || !seoConstName) {
    throw new TypeError('appendSeoEntrySource: source, seoEntry and seoConstName are required');
  }
  const constPattern = updateRouterUnion
    ? `${escapeRegExpLiteral(seoConstName)}(?:_\\d+)?`
    : escapeRegExpLiteral(seoConstName);
  const endPattern = new RegExp(`(\\s*\\},)\\s*(\\n};)\\s*(\\nexport default ${constPattern};)`);
  if (endPattern.test(source)) {
    return replaceCaptureSafe(source, endPattern, (_match, before, close, exportLine) => (
      `${before}\n${seoEntry}\n${close}\n${exportLine}`
    ));
  }
  const emptyPattern = new RegExp(`(const ${escapeRegExpLiteral(seoConstName)}[^=]*=\\s*\\{)(\\s*\\n)(\\};)`);
  if (!emptyPattern.test(source)) {
    throw new Error(`Cannot find end (or empty-object opener) of ${seoConstName} in ${fileLabel}`);
  }
  return replaceCaptureSafe(source, emptyPattern, (_match, opener, _newline, close) => (
    `${opener}\n${seoEntry}\n${close}`
  ));
}
