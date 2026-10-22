import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  articleBodyRevision,
  articleBodyDocumentPath,
  appendArticleBodyQuarantineSummary,
  assertArticleBodyQuarantineBudget,
  buildArticleBodyPayload,
  emitArticleBodyApi,
  extractArticleBodyFields,
  MAX_ARTICLE_BODY_QUARANTINES,
  verifyArticleBodyApiOnDisk,
} from '../../scripts/lib/article-body-api.mjs';
import { findNonCanonicalArticleLinks } from '../../scripts/lib/article-link-contract.mjs';
import { sanitizeDeep } from '../../scripts/lib/sanitize-control-chars.mjs';
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

const metaFor = (
  id = articleId,
  title = 'Example title',
  excerpt = 'Short summary.',
  imageAlt = 'A descriptive image alternative.',
) => ({
  [`blog.article.${id}.title`]: title,
  [`blog.article.${id}.excerpt`]: excerpt,
  [`blog.article.${id}.imageAlt`]: imageAlt,
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
    '// A template marker in a comment is not source code: `${notDynamic}`',
    '/* Neither is this: `${notDynamic}` */',
    'const singleQuoted = \'${notDynamic}\';',
    'const doubleQuoted = "${notDynamic}";',
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

test('the repaired FAQ sources have valid JSON, unchanged Q/A text, and canonical links', () => {
  const repairedFaqs = [
    {
      locale: 'en',
      id: 'svizzera-canada-mercati-alternativi-trump',
      count: 6,
      qaHash: 'fdf1bfa73bc654bf9b73256f0ada6493296f760082cb6ad3c51f9d0eaea85378',
    },
    {
      locale: 'de',
      id: 'chiasso-scoperta-enti-primo-intervento',
      count: 3,
      qaHash: '69384b40e11c172208d826f062bef8011623bc0a0eb51bfee728f08c849cae68',
    },
    {
      locale: 'fr',
      id: 'ritardi-disoccupazione-ticino',
      count: 5,
      qaHash: '8511b895d4fbfaa2b152202d2030456cdaef2f909737229604122a64d203b442',
    },
    {
      locale: 'fr',
      id: 'startup-scuola-ticino-frontalieri',
      count: 5,
      qaHash: '93d074412543b89a687fd1ac51dfad3421e66eb13df95305a1ef342d3aa69ba5',
    },
  ];

  for (const { locale, id, count, qaHash } of repairedFaqs) {
    const source = fs.readFileSync(new URL(`../../content/blog-body/${locale}/${id}.ts`, import.meta.url), 'utf8');
    const payload = buildArticleBodyPayload({
      section: 'frontaliere', locale, id, meta: metaFor(id), source,
    });
    const faq = JSON.parse(payload.translations.faq);
    assert.equal(faq.length, count, `${id}/${locale}: FAQ answer count`);

    const stripClosedNavLinks = (value) => {
      const links = [...value.matchAll(/\[([^\]]+)\]\(nav:([^)]+)\)/gu)];
      assert.equal(links.length, [...value.matchAll(/nav:/gu)].length, `${id}/${locale}: every nav target is inside a closed Markdown link`);
      for (const [, label, target] of links) {
        assert.ok(label.trim(), `${id}/${locale}: nav link label is nonempty`);
        assert.ok(target.trim(), `${id}/${locale}: nav target is nonempty`);
      }
      return value.replace(/\[([^\]]+)\]\(nav:([^)]+)\)/gu, '$1');
    };
    const normalizedQa = faq.map(({ q, a }) => {
      assert.equal(typeof q, 'string', `${id}/${locale}: FAQ question is text`);
      assert.equal(typeof a, 'string', `${id}/${locale}: FAQ answer is text`);
      assert.ok(q.trim(), `${id}/${locale}: FAQ question is nonempty`);
      assert.ok(a.trim(), `${id}/${locale}: FAQ answer is nonempty`);
      for (const [field, value] of [['q', q], ['a', a]]) {
        assert.deepEqual(
          findNonCanonicalArticleLinks(value, locale),
          [],
          `${id}/${locale} FAQ ${field}: every remaining Markdown destination is canonical`,
        );
      }
      return { q: stripClosedNavLinks(q), a: stripClosedNavLinks(a) };
    });
    const actualQaHash = createHash('sha256').update(JSON.stringify(normalizedQa)).digest('hex');
    assert.equal(actualQaHash, qaHash, `${id}/${locale}: ordered Q/A text matches the reviewed source`);
  }
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

test('the body parser fails closed on truncated trivia and strings after valid fields', () => {
  const truncatedComment = [
    "'blog.article.example-article.body1': 'valid before failure',",
    '/* unfinished',
  ].join('\n');
  assert.throws(
    () => extractArticleBodyFields(truncatedComment),
    /Unterminated block comment in static article body source/u,
  );

  const truncatedString = [
    "'blog.article.example-article.body1': 'valid before failure',",
    "'not-an-article-key",
  ].join('\n');
  assert.throws(
    () => extractArticleBodyFields(truncatedString),
    /Malformed string token in static article body source: unterminated-string/u,
  );

  const truncatedObject = [
    'const body = {',
    "  'blog.article.example-article.body1': 'one',",
    "  'blog.article.example-article.body2': 'two',",
    "  'blog.article.example-article.body3': 'three',",
  ].join('\n');
  assert.throws(
    () => extractArticleBodyFields(truncatedObject),
    /Unterminated delimiter in static article body source/u,
  );
});

test('the body parser rejects dynamic members in logical object expressions', () => {
  for (const operator of ['&&', '||']) {
    const source = [
      `const body = enabled ${operator} { [dynamicKey]: 'value' };`,
      sourceFor(),
    ].join('\n');
    assert.throws(
      () => extractArticleBodyFields(source),
      /Computed article body properties are not supported/u,
      operator,
    );
  }
});

test('the body parser resumes after every TypeScript line terminator in comments', () => {
  for (const terminator of ['\r', '\u2028', '\u2029']) {
    const source = [
      'const body = {',
      `  'blog.article.example-article.body1': 'one', // comment${terminator}  'blog.article.example-article.body2': 'two',`,
      "  'blog.article.example-article.body3': 'three',",
      '};',
    ].join('\n');
    assert.deepEqual(
      extractArticleBodyFields(source).map(({ field, value }) => ({ field, value })),
      [
        { field: 'body1', value: 'one' },
        { field: 'body2', value: 'two' },
        { field: 'body3', value: 'three' },
      ],
      terminator.charCodeAt(0).toString(16),
    );
  }
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

test('interpolated templates fail the whole source before or after static body fields', () => {
  const dynamicBefore = [
    'const unrelated = `prefix ${compute()} suffix`;',
    'const body = {',
    '  "blog.article.example-article.body1": `static body`,',
    '};',
  ].join('\n');
  const dynamicAfter = [
    'const body = {',
    '  "blog.article.example-article.body1": `static body`,',
    '};',
    'const unrelated = `prefix ${compute()} suffix`;',
  ].join('\n');
  assert.throws(() => extractArticleBodyFields(dynamicBefore), /Interpolated template literal/u);
  assert.throws(() => extractArticleBodyFields(dynamicAfter), /Interpolated template literal/u);
  assert.throws(
    () => extractArticleBodyFields("const body = { [`blog.article.example-article.${field}.body1`]: 'value' };"),
    /Computed article body properties are not supported/u,
  );
  const sourceWithDynamic = `${sourceFor()}\nconst unrelated = ` + '`prefix ${compute()} suffix`;';
  assert.throws(() => buildArticleBodyPayload({
    section: 'frontaliere', locale: 'it', id: articleId, meta: metaFor(), source: sourceWithDynamic,
  }), /Interpolated template literal/u);

  const sourceWithComputedGetter = [
    `const bodyKey = 'blog.article.${articleId}.body4';`,
    sourceFor().replace(
      `  'blog.article.${articleId}.faq':`,
      [
        `  get [bodyKey]() { return 'Optional body'; },`,
        `  'blog.article.${articleId}.faq':`,
      ].join('\n'),
    ),
  ].join('\n');
  assert.throws(() => buildArticleBodyPayload({
    section: 'frontaliere', locale: 'it', id: articleId, meta: metaFor(), source: sourceWithComputedGetter,
  }), /Computed article body properties are not supported/u);

  const sourceWithComputedGenerator = [
    `const bodyKey = 'blog.article.${articleId}.body4';`,
    sourceFor().replace(
      `  'blog.article.${articleId}.faq':`,
      [
        `  *[bodyKey]() { return 'Optional body'; },`,
        `  'blog.article.${articleId}.faq':`,
      ].join('\n'),
    ),
  ].join('\n');
  assert.throws(() => buildArticleBodyPayload({
    section: 'frontaliere', locale: 'it', id: articleId, meta: metaFor(), source: sourceWithComputedGenerator,
  }), /Computed article body properties are not supported/u);

  for (const [label, source] of [
    ['spread member', [
      `const extraFields = { 'blog.article.${articleId}.body4': 'Optional body' };`,
      sourceFor().replace(
        `  'blog.article.${articleId}.body2':`,
        `  ...extraFields,\n  'blog.article.${articleId}.body2':`,
      ),
    ].join('\n')],
    ['shorthand member', [
      `const extraFields = { 'blog.article.${articleId}.body4': 'Optional body' };`,
      sourceFor().replace(
        `  'blog.article.${articleId}.body2':`,
        `  extraFields,\n  'blog.article.${articleId}.body2':`,
      ),
    ].join('\n')],
  ]) {
    assert.throws(() => buildArticleBodyPayload({
      section: 'frontaliere', locale: 'it', id: articleId, meta: metaFor(), source,
    }), /Dynamic article body object members are not supported/u, label);
  }

  const sourceWithArrayDestructuringHelper = `const split = (head, [tail]) => tail;\n${sourceFor()}`;
  assert.doesNotThrow(() => buildArticleBodyPayload({
    section: 'frontaliere', locale: 'it', id: articleId, meta: metaFor(), source: sourceWithArrayDestructuringHelper,
  }));
  const sourceWithTypedArrayDestructuringHelper = `const split = (head: string, [tail]: string[]) => tail;\n${sourceFor()}`;
  assert.doesNotThrow(() => buildArticleBodyPayload({
    section: 'frontaliere', locale: 'it', id: articleId, meta: metaFor(), source: sourceWithTypedArrayDestructuringHelper,
  }));
  const sourceWithObjectDestructuringHelper = [
    'const pick = ({ extraFields }) => extraFields;',
    'const rest = ({ ...extraFields }) => extraFields;',
    sourceFor(),
  ].join('\n');
  assert.doesNotThrow(() => buildArticleBodyPayload({
    section: 'frontaliere', locale: 'it', id: articleId, meta: metaFor(), source: sourceWithObjectDestructuringHelper,
  }));

  const deceptiveNestedExpression = [
    'const body = { "blog.article.example-article.body1": "valid before failure" };',
    "const other = `prefix ${obj.return / /}/.test(`inner 'blog.article.example-article.body4': 'fake'`)} suffix`;",
  ].join('\n');
  assert.throws(() => extractArticleBodyFields(deceptiveNestedExpression), /Interpolated template literal/u);

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

test('metadata permits an empty excerpt and hashes an absent image alt as explicit null', () => {
  const meta = metaFor(articleId, 'Example title', '');
  delete meta[`blog.article.${articleId}.imageAlt`];
  const payload = buildArticleBodyPayload({
    section: 'frontaliere',
    locale: 'it',
    id: articleId,
    meta,
    source: sourceFor(),
  });
  const expectedMeta = { title: 'Example title', excerpt: '', imageAlt: null };
  const expectedCanonical = {
    schemaVersion: 1,
    section: 'frontaliere',
    locale: 'it',
    id: articleId,
    meta: expectedMeta,
    translations: {
      body1: 'First body',
      body2: 'Second body',
      body3: 'Third body',
      faq: '[{"q":"Question?","a":"Answer."}]',
    },
  };
  const expectedRevision = createHash('sha256')
    .update(JSON.stringify(expectedCanonical), 'utf8')
    .digest('hex');

  assert.deepEqual(payload.meta, expectedMeta);
  assert.deepEqual(Object.keys(payload.meta), ['title', 'excerpt', 'imageAlt']);
  assert.equal(payload.revision, expectedRevision);
  assert.equal(articleBodyRevision(payload), expectedRevision);

  for (const imageAlt of [undefined, null, '']) {
    const optionalAltMeta = metaFor(articleId, 'Example title', '', imageAlt);
    if (imageAlt === undefined) delete optionalAltMeta[`blog.article.${articleId}.imageAlt`];
    assert.equal(buildArticleBodyPayload({
      section: 'frontaliere', locale: 'it', id: articleId, meta: optionalAltMeta, source: sourceFor(),
    }).meta.imageAlt, null);
  }
  assert.equal(buildArticleBodyPayload({
    section: 'frontaliere', locale: 'it', id: articleId,
    meta: metaFor(articleId, 'Example title', '', '   '), source: sourceFor(),
  }).meta.imageAlt, null);
});

test('metadata rejects missing excerpts, blank titles, and non-text values', () => {
  const valid = metaFor();
  const cases = [
    ['blank title', { ...valid, [`blog.article.${articleId}.title`]: ' \t ' }, /meta title/u],
    ['non-text title', { ...valid, [`blog.article.${articleId}.title`]: 42 }, /meta title/u],
    ['missing title', Object.fromEntries(Object.entries(valid).filter(([key]) => !key.endsWith('.title'))), /meta title/u],
    ['missing excerpt', Object.fromEntries(Object.entries(valid).filter(([key]) => !key.endsWith('.excerpt'))), /meta excerpt/u],
    ['non-text excerpt', { ...valid, [`blog.article.${articleId}.excerpt`]: null }, /meta excerpt/u],
    ['non-text image alt', { ...valid, [`blog.article.${articleId}.imageAlt`]: false }, /meta imageAlt/u],
  ];
  for (const [label, meta, expected] of cases) {
    assert.throws(() => buildArticleBodyPayload({
      section: 'frontaliere', locale: 'it', id: articleId, meta, source: sourceFor(),
    }), expected, label);
  }
});

test('sanitized blank image alternatives become null before hashing and disk verification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-api-sanitized-alt-source-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-api-sanitized-alt-output-'));
  const localeDir = path.join(root, 'content/frontaliere/it');
  fs.mkdirSync(localeDir, { recursive: true });
  fs.writeFileSync(path.join(localeDir, `${articleId}.ts`), sourceFor());

  const sections = [{ section: 'frontaliere', bodyDir: 'content/frontaliere' }];
  const registries = { frontaliere: [{ id: articleId }] };
  const metaBySectionLocale = {
    frontaliere: { it: metaFor(articleId, 'Example title', 'Short summary.', '\u0000') },
  };
  const emitted = emitArticleBodyApi({
    root,
    outDir,
    locales: ['it'],
    sections,
    registries,
    publicSections: new Set(['frontaliere']),
    metaBySectionLocale,
    sanitize: (value) => sanitizeDeep(value),
  });
  const payloadPath = path.join(outDir, `bodies/frontaliere/it/${articleId}.json`);
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  assert.deepEqual(payload.meta, { title: 'Example title', excerpt: 'Short summary.', imageAlt: null });
  assert.equal(payload.revision, articleBodyRevision(payload));
  assert.deepEqual(verifyArticleBodyApiOnDisk({
    outDir,
    capability: emitted.capability,
    sections,
    registries,
    publicSections: new Set(['frontaliere']),
    locales: ['it'],
  }).totals, emitted.totals);
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
    if (locale === 'en') {
      metaBySectionLocale.frontaliere[locale] = metaFor(articleId, 'Example title', '', undefined);
      delete metaBySectionLocale.frontaliere[locale][`blog.article.${articleId}.imageAlt`];
    } else {
      metaBySectionLocale.frontaliere[locale] = metaFor();
    }
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
  assert.deepEqual(emitted.totals, { expected: 4, available: 2, missing: 2, quarantined: 0 });
  const itIndex = JSON.parse(fs.readFileSync(path.join(outDir, 'bodies/frontaliere/it/index.json'), 'utf8'));
  assert.equal(itIndex.entries[articleId].status, 'available');
  assert.equal(itIndex.entries['missing-article'].status, 'missing');
  const enPayload = JSON.parse(fs.readFileSync(path.join(outDir, `bodies/frontaliere/en/${articleId}.json`), 'utf8'));
  assert.deepEqual(enPayload.meta, { title: 'Example title', excerpt: '', imageAlt: null });
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

test('un body non parsabile viene messo in quarantena, escluso dall output e ri-verificato dal disco', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-api-invalid-source-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-api-invalid-output-'));
  const sourceDir = path.join(root, 'content/frontaliere/it');
  fs.mkdirSync(sourceDir, { recursive: true });
  const malformed = sourceFor('example-article', `broken${String.fromCharCode(0x2028)}body`);
  fs.writeFileSync(path.join(sourceDir, `${articleId}.ts`), malformed);
  const sections = [{ section: 'frontaliere', bodyDir: 'content/frontaliere' }];
  const registries = { frontaliere: [{ id: articleId }] };
  const emitted = emitArticleBodyApi({
    root,
    outDir,
    locales: ['it'],
    sections,
    registries,
    publicSections: new Set(['frontaliere']),
    metaBySectionLocale: { frontaliere: { it: metaFor() } },
  });

  assert.deepEqual(emitted.totals, { expected: 1, available: 0, missing: 1, quarantined: 1 });
  assert.equal(emitted.quarantined.length, 1);
  assert.equal(emitted.quarantined[0].source, `content/frontaliere/it/${articleId}.ts`);
  assert.match(emitted.quarantined[0].reason, /Unterminated delimiter/u);

  const index = JSON.parse(fs.readFileSync(path.join(outDir, 'bodies/frontaliere/it/index.json'), 'utf8'));
  assert.equal(index.quarantinedCount, 1);
  assert.equal(index.entries[articleId].status, 'missing', 'il contratto v1 espone la quarantena come payload assente');
  assert.deepEqual(index.quarantined, [{ id: articleId, reason: emitted.quarantined[0].reason }]);
  assert.equal(fs.existsSync(path.join(outDir, `bodies/frontaliere/it/${articleId}.json`)), false);
  const summaryPath = path.join(outDir, 'summary.md');
  appendArticleBodyQuarantineSummary(emitted.quarantined, summaryPath);
  assert.match(fs.readFileSync(summaryPath, 'utf8'), /example-article\.ts/u);
  assert.match(fs.readFileSync(summaryPath, 'utf8'), /Unterminated delimiter/u);

  const verified = verifyArticleBodyApiOnDisk({
    outDir,
    capability: emitted.capability,
    sections,
    registries,
    publicSections: new Set(['frontaliere']),
    locales: ['it'],
  });
  assert.deepEqual(verified.totals, emitted.totals);
});

test('la soglia di quarantena e esplicita e fail-closed', () => {
  assert.equal(MAX_ARTICLE_BODY_QUARANTINES, 3);
  assert.doesNotThrow(() => assertArticleBodyQuarantineBudget({ quarantined: 3 }));
  assert.throws(
    () => assertArticleBodyQuarantineBudget({ quarantined: 4 }),
    /soglia quarantena superata \(4 > 3\)/u,
  );
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

test('reserved and path-traversing article ids fail before any body API output', () => {
  for (const [id, expectedError] of [
    ['index', /riservato/u],
    ['../escape', /non valido/u],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-api-invalid-id-source-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-body-api-invalid-id-output-'));
    const localeDir = path.join(root, 'content/frontaliere/it');
    fs.mkdirSync(localeDir, { recursive: true });
    if (id === 'index') {
      fs.writeFileSync(path.join(localeDir, 'index.ts'), sourceFor(id));
    } else {
      const escapedSource = path.join(root, 'content/frontaliere/escape.ts');
      fs.writeFileSync(escapedSource, 'must stay untouched');
    }

    assert.throws(() => emitArticleBodyApi({
      root,
      outDir,
      locales: ['it'],
      sections: [{ section: 'frontaliere', bodyDir: 'content/frontaliere' }],
      registries: { frontaliere: [{ id }] },
      publicSections: new Set(['frontaliere']),
      metaBySectionLocale: { frontaliere: { it: metaFor(id) } },
    }), expectedError);
    assert.equal(fs.existsSync(path.join(outDir, 'bodies')), false);
    if (id === '../escape') {
      assert.equal(fs.readFileSync(path.join(root, 'content/frontaliere/escape.ts'), 'utf8'), 'must stay untouched');
    }
  }

  assert.throws(() => articleBodyDocumentPath('frontaliere', 'it', 'index'), /riservato/u);
  assert.throws(() => articleBodyDocumentPath('frontaliere', 'it', '../escape'), /non valido/u);
  assert.throws(() => articleBodyDocumentPath('../outside', 'it', articleId), /section non valida/u);
  assert.throws(() => articleBodyDocumentPath('frontaliere', '../it', articleId), /locale non valida/u);
});
