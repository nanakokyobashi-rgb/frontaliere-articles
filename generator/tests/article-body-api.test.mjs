import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  articleBodyRevision,
  buildArticleBodyPayload,
  emitArticleBodyApi,
  extractArticleBodyFields,
  verifyArticleBodyApiOnDisk,
} from '../../scripts/lib/article-body-api.mjs';
import { metaFieldRegex, unescapeTsValue } from '../scripts/lib/meta-field-regex.mjs';

const articleId = 'example-article';
const sourceFor = (id = articleId, body = 'First body') => [
  'const articleBody = {',
  `  'blog.article.${id}.body1': '${body}',`,
  `  'blog.article.${id}.body2': 'Second body',`,
  `  'blog.article.${id}.body3': 'Third body',`,
  `  'blog.article.${id}.faq': '[{"q":"Question?","a":"Answer."}]',`,
  '};',
].join('\n');

const metaFor = (id = articleId, title = 'Example title') => ({
  [`blog.article.${id}.title`]: title,
  [`blog.article.${id}.excerpt`]: 'Short summary.',
  [`blog.article.${id}.imageAlt`]: 'A descriptive image alternative.',
});

function readRealArticleMeta(locale, id) {
  const source = fs.readFileSync(new URL(`../../content/blog-meta-${locale}.ts`, import.meta.url), 'utf8');
  const meta = {};
  for (const field of ['title', 'excerpt', 'imageAlt']) {
    const match = [...source.matchAll(metaFieldRegex(field))].find((entry) => entry[1] === id);
    assert.ok(match, `metadata ${field} mancante per ${id}/${locale}`);
    meta[`blog.article.${id}.${field}`] = unescapeTsValue(match[2]);
  }
  return meta;
}

test('the static body scanner supports quoted keys, all literal delimiters, FAQ, comments and escapes', () => {
  const slash = String.fromCharCode(92);
  const templateLine = `  'blog.article.example-article.body3': \`three ${slash}\`ticks${slash}\` and escaped ${slash}\${placeholder}\`,`;
  const continuationLine = `  'blog.article.example-article.body4': \`continued${slash}
line\`,`;
  const source = [
    '// \'blog.article.example-article.body8\': \'comment\'',
    'const body = {',
    "  'blog.article.example-article.body1': 'one\\nline \\'quoted\\' and \\u00a0',",
    '  "blog.article.example-article.body2": "two \\"quoted\\"",',
    templateLine,
    continuationLine,
    `  'blog.article.example-article.faq': '[{"q":"Q","a":"A"}]',`,
    '};',
  ].join('\n');
  const fields = extractArticleBodyFields(source);
  assert.deepEqual(fields.map(({ field }) => field), ['body1', 'body2', 'body3', 'body4', 'faq']);
  assert.equal(fields[0].value, "one\nline 'quoted' and \u00a0");
  assert.equal(fields[1].value, 'two "quoted"');
  assert.equal(fields[2].value, 'three `ticks` and escaped ${placeholder}');
  assert.equal(fields[3].value, 'continuedline');
  assert.equal(fields[4].value, '[{"q":"Q","a":"A"}]');
});

test('Unicode escapes are decoded once, preserving backslashes for body text and FAQ JSON', () => {
  const source = sourceFor()
    .replace("'blog.article.example-article.body1': 'First body',", "'blog.article.example-article.body1': '\\u005Ct',")
    .replace("'blog.article.example-article.faq': '[{\"q\":\"Question?\",\"a\":\"Answer.\"}]',", "'blog.article.example-article.faq': '[{\"q\":\"Question?\",\"a\":\"First\\u005CnSecond\"}]',");
  const payload = buildArticleBodyPayload({
    section: 'frontaliere', locale: 'it', id: articleId, meta: metaFor(), source,
  });
  assert.equal(payload.translations.body1, '\\t');
  assert.equal(JSON.parse(payload.translations.faq)[0].a, 'First\nSecond');
});

test('single- and double-quoted literals accept escaped physical line continuations', () => {
  const slash = String.fromCharCode(92);
  const source = [
    'const body = {',
    `  'blog.article.example-article.body1': 'single${slash}
continued',`,
    `  "blog.article.example-article.body2": "double${slash}
continued",`,
    '};',
  ].join('\n');
  const fields = extractArticleBodyFields(source);
  assert.deepEqual(fields.map(({ value }) => value), ['singlecontinued', 'doublecontinued']);

  const invalid = extractArticleBodyFields(`'blog.article.example-article.body1': 'split
without escape',`);
  assert.equal(invalid[0].error, 'newline-in-quoted-string');
});

test('the producer accepts real body and localized metadata for the 24 educator pages', () => {
  const ids = [
    'frontaliere-educatore-ticino-stipendio-requisiti',
    'educatore-infanzia-ticino-stipendio-requisiti',
    'educatore-infanzia-ticino-stipendi-2026',
    'educatore-infanzia-ticino-stipendi',
    'educatore-infanzia-ticino-stipendi-requisiti',
    'educatore-infanzia-ticino-stipendio',
  ];
  let built = 0;
  for (const locale of ['it', 'en', 'de', 'fr']) {
    for (const id of ids) {
      const source = fs.readFileSync(new URL(`../../content/blog-body/${locale}/${id}.ts`, import.meta.url), 'utf8');
      const payload = buildArticleBodyPayload({
        section: 'frontaliere', locale, id, meta: readRealArticleMeta(locale, id), source,
      });
      assert.equal(payload.id, id);
      assert.ok(payload.translations.body1 && payload.translations.body2 && payload.translations.body3);
      built += 1;
    }
  }
  assert.equal(built, 24);
});

test('dynamic templates and expressions after literals are reported as invalid', () => {
  const dynamic = extractArticleBodyFields([
    'const body = {',
    '  "blog.article.example-article.body1": `prefix ${compute()} suffix`,',
    '};',
  ].join('\n'));
  assert.equal(dynamic[0].error, 'dynamic-template');
  assert.equal(dynamic[0].value, null);

  for (const suffix of [" + ' tail'", ".replace('x', 'y')"]) {
    const fields = extractArticleBodyFields([
      'const body = {',
      `  'blog.article.example-article.body1': 'literal'${suffix},`,
      '};',
    ].join('\n'));
    assert.equal(fields[0].error, 'trailing-expression');
    assert.equal(fields[0].value, null);
  }
});

test('payload revisions cover identity, localized metadata, and translations', () => {
  const payload = buildArticleBodyPayload({
    section: 'frontaliere',
    locale: 'it',
    id: articleId,
    meta: metaFor(),
    source: sourceFor(),
  });
  assert.match(payload.revision, /^[a-f0-9]{64}$/u);
  assert.equal(payload.translations.faq, '[{"q":"Question?","a":"Answer."}]');
  assert.equal(articleBodyRevision({ ...payload, meta: { ...payload.meta, title: 'Changed title' } }) === payload.revision, false);
  assert.equal(articleBodyRevision({ ...payload, translations: { ...payload.translations, body1: 'Changed body' } }) === payload.revision, false);
  assert.equal(articleBodyRevision({ ...payload, id: 'another-article' }) === payload.revision, false);
  const noFaq = buildArticleBodyPayload({
    section: 'frontaliere', locale: 'it', id: articleId, meta: metaFor(),
    source: sourceFor().replace(`  'blog.article.${articleId}.faq': '[{"q":"Question?","a":"Answer."}]',\n`, ''),
  });
  assert.equal(Object.prototype.hasOwnProperty.call(noFaq.translations, 'faq'), false);
  assert.throws(() => buildArticleBodyPayload({
    section: 'frontaliere', locale: 'it', id: articleId, meta: metaFor(),
    source: sourceFor().replace("'blog.article.example-article.body2': 'Second body',", ''),
  }), /campo obbligatorio mancante body2/u);
  assert.throws(() => buildArticleBodyPayload({
    section: 'frontaliere', locale: 'it', id: articleId, meta: metaFor(),
    source: sourceFor().replace("'blog.article.example-article.body1': 'First body',", "'blog.article.example-article.body1': 'First body' + suffix,"),
  }), /trailing-expression/u);
  assert.throws(() => buildArticleBodyPayload({
    section: 'frontaliere', locale: 'it', id: articleId, meta: metaFor(),
    source: sourceFor().replace('};', "  'blog.article.example-article.body21': 'Must not be truncated',\n};"),
  }), /campo non supportato body21/u);
});

test('section/locale indexes explicitly represent missing sources and inactive sections', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-api-source-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-api-output-'));
  const locales = ['it', 'en'];
  const sections = [
    { section: 'frontaliere', bodyDir: 'content/frontaliere' },
    { section: 'canton-example', bodyDir: 'content/canton-example' },
  ];
  const registries = {
    frontaliere: [{ id: articleId }, { id: 'missing-article' }],
    'canton-example': [{ id: 'inactive-article' }],
  };
  const metaBySectionLocale = { frontaliere: {} };
  for (const locale of locales) {
    const localeDir = path.join(root, 'content/frontaliere', locale);
    fs.mkdirSync(localeDir, { recursive: true });
    fs.writeFileSync(path.join(localeDir, `${articleId}.ts`), sourceFor());
    metaBySectionLocale.frontaliere[locale] = metaFor();
  }
  const emitted = emitArticleBodyApi({
    root,
    outDir,
    locales,
    sections,
    registries,
    publicSections: new Set(['frontaliere']),
    metaBySectionLocale,
  });
  assert.deepEqual(emitted.totals, { expected: 4, available: 2, missing: 2 });
  const itIndex = JSON.parse(fs.readFileSync(path.join(outDir, 'bodies/frontaliere/it/index.json'), 'utf8'));
  assert.equal(itIndex.entries[articleId].status, 'available');
  assert.equal(itIndex.entries['missing-article'].status, 'missing');
  const inactive = JSON.parse(fs.readFileSync(path.join(outDir, 'bodies/canton-example/it/index.json'), 'utf8'));
  assert.equal(inactive.status, 'inactive');
  assert.deepEqual(inactive.entries, {});

  const verified = verifyArticleBodyApiOnDisk({
    outDir,
    capability: emitted.capability,
    sections,
    registries,
    publicSections: new Set(['frontaliere']),
    locales,
  });
  assert.deepEqual(verified.totals, emitted.totals);
});

test('the disk gate rejects tampered payloads and body documents absent from their index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-api-tamper-source-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-api-tamper-output-'));
  const locales = ['it'];
  const sections = [{ section: 'frontaliere', bodyDir: 'content/frontaliere' }];
  const registries = { frontaliere: [{ id: articleId }] };
  const metaBySectionLocale = { frontaliere: { it: metaFor() } };
  const sourceDir = path.join(root, 'content/frontaliere/it');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, `${articleId}.ts`), sourceFor());
  const emitted = emitArticleBodyApi({
    root, outDir, locales, sections, registries, metaBySectionLocale,
    publicSections: new Set(['frontaliere']),
  });
  const bodyPath = path.join(outDir, 'bodies/frontaliere/it/example-article.json');
  const payload = JSON.parse(fs.readFileSync(bodyPath, 'utf8'));
  payload.translations.body1 = 'tampered';
  fs.writeFileSync(bodyPath, JSON.stringify(payload));
  assert.throws(() => verifyArticleBodyApiOnDisk({
    outDir, capability: emitted.capability, sections, registries,
    publicSections: new Set(['frontaliere']), locales,
  }), /revision payload non corrisponde/u);

  emitArticleBodyApi({
    root, outDir, locales, sections, registries, metaBySectionLocale,
    publicSections: new Set(['frontaliere']),
  });
  fs.writeFileSync(path.join(outDir, 'bodies/frontaliere/it/orphan.json'), '{}');
  assert.throws(() => verifyArticleBodyApiOnDisk({
    outDir, capability: emitted.capability, sections, registries,
    publicSections: new Set(['frontaliere']), locales,
  }), /non indicizzati/u);
});

test('a missing source locale directory cannot be confused with an all-missing index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-api-sparse-source-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-api-sparse-output-'));
  assert.throws(() => emitArticleBodyApi({
    root,
    outDir,
    locales: ['it'],
    sections: [{ section: 'frontaliere', bodyDir: 'content/frontaliere' }],
    registries: { frontaliere: [{ id: articleId }] },
    publicSections: new Set(['frontaliere']),
    metaBySectionLocale: {},
  }), /directory assente/u);
});
