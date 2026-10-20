import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCALES = ['it', 'en', 'de', 'fr'];
const IDS = [
  'frontaliere-educatore-ticino-stipendio-requisiti',
  'educatore-infanzia-ticino-stipendio-requisiti',
  'educatore-infanzia-ticino-stipendi-2026',
  'educatore-infanzia-ticino-stipendi',
  'educatore-infanzia-ticino-stipendi-requisiti',
  'educatore-infanzia-ticino-stipendio',
];
const PUBLISHED = {
  'frontaliere-educatore-ticino-stipendio-requisiti': '2026-07-23T03:02:49+00:00',
  'educatore-infanzia-ticino-stipendio-requisiti': '2026-05-25T09:54:59+00:00',
  'educatore-infanzia-ticino-stipendi-2026': '2026-05-25T10:25:07+00:00',
  'educatore-infanzia-ticino-stipendi': '2026-05-25T12:06:48+00:00',
  'educatore-infanzia-ticino-stipendi-requisiti': '2026-05-25T12:31:15+00:00',
  'educatore-infanzia-ticino-stipendio': '2026-06-05T07:00:40+00:00',
};
const CANONICAL_PATHS = {
  'frontaliere-educatore-ticino-stipendio-requisiti': '/articoli-frontaliere/frontaliere-educatore-ticino-stipendio-requisiti',
  'educatore-infanzia-ticino-stipendio-requisiti': '/articoli-frontaliere/educatore-infanzia-ticino-stipendio-requisiti/',
  'educatore-infanzia-ticino-stipendi-2026': '/articoli-frontaliere/educatore-infanzia-ticino-stipendi-2026/',
  'educatore-infanzia-ticino-stipendi': '/articoli-frontaliere/educatore-infanzia-ticino-stipendi/',
  'educatore-infanzia-ticino-stipendi-requisiti': '/articoli-frontaliere/educatore-infanzia-ticino-stipendi-requisiti/',
  'educatore-infanzia-ticino-stipendio': '/articoli-frontaliere/educatore-infanzia-ticino-stipendio',
};
const REGISTRY_DATES = {
  'frontaliere-educatore-ticino-stipendio-requisiti': '2026-07-23T03:02:49.747Z',
  'educatore-infanzia-ticino-stipendio-requisiti': '2026-05-25T09:54:59.901Z',
  'educatore-infanzia-ticino-stipendi-2026': '2026-05-25T10:25:07.898Z',
  'educatore-infanzia-ticino-stipendi': '2026-05-25T12:06:48.836Z',
  'educatore-infanzia-ticino-stipendi-requisiti': '2026-05-25T12:31:15.306Z',
  'educatore-infanzia-ticino-stipendio': '2026-06-05T07:00:39.982Z',
};
const GUIDE_URLS = {"it": "https://frontaliereticino.ch/articoli-frontaliere/frontaliere-educatore-ticino-stipendio-requisiti/", "en": "https://frontaliereticino.ch/en/cross-border-articles/frontalier-educator-ticino-salary-requirements/", "de": "https://frontaliereticino.ch/de/grenzgaenger-artikel/frontalier-lehrer-tessin-grosses-netto-anforderungen/", "fr": "https://frontaliereticino.ch/fr/articles-frontalier/frontalier-educateur-tessin-salaire-requis/"};
const SALARY_FACTS = {
  it: ['CHF 73’140.05–86’305.45', 'CHF 77’526.15–91’481.05', 'CHF 82’372.30–97’199.35'],
  en: ['CHF 73,140.05–86,305.45', 'CHF 77,526.15–91,481.05', 'CHF 82,372.30–97,199.35'],
  de: ['CHF 73’140.05–86’305.45', 'CHF 77’526.15–91’481.05', 'CHF 82’372.30–97’199.35'],
  fr: ['CHF 73 140,05–86 305,45', 'CHF 77 526,15–91 481,05', 'CHF 82 372,30–97 199,35'],
};

function readStringField(filePath, key) {
  const source = fs.readFileSync(filePath, 'utf8');
  const line = source.split(/\r?\n/).find((candidate) => candidate.includes(key));
  assert.ok(line, `missing ${key} in ${path.relative(ROOT, filePath)}`);
  const colon = line.indexOf(':');
  const literal = line.slice(colon + 1).trim().replace(/,$/, '');
  return JSON.parse(literal);
}

function readBody(locale, id) {
  const file = path.join(ROOT, 'content', 'blog-body', locale, `${id}.ts`);
  return ['body1', 'body2', 'body3', 'faq'].map((field) =>
    readStringField(file, `blog.article.${id}.${field}`));
}

function wordCount(value) {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
}

function readSeoEntry(id) {
  const source = fs.readFileSync(path.join(ROOT, 'content/seo/seo-blog-5.ts'), 'utf8');
  const key = `'blog-${id}': {`;
  const start = source.indexOf(key);
  assert.notEqual(start, -1, `missing SEO entry for ${id}`);
  const end = source.indexOf('\n  },', start);
  assert.notEqual(end, -1, `unterminated SEO entry for ${id}`);
  return source.slice(start, end);
}

describe('educator guides use verified LIS 2026 evidence', () => {
  it('keeps every localized body useful and above the 300-word threshold', () => {
    for (const locale of LOCALES) {
      for (const id of IDS) {
        const [body1, body2, body3, faq] = readBody(locale, id);
        const title = readStringField(path.join(ROOT, `content/blog-meta-${locale}.ts`), `blog.article.${id}.title`);
        assert.ok(body1.startsWith(`## ${title}\n`), `${locale}/${id} heading does not match its metadata`);
        assert.ok(wordCount([body1, body2, body3].join('\n')) >= 300, `${locale}/${id} is thin`);
        assert.doesNotMatch([body1, body2, body3, faq].join('\n'), /Liceo Internazionale|73K.?97K|€\s?7['’]?500|CHF\s?4['’]?500/i);
        assert.match([body1, body2, body3].join('\n'), /Lugano Istituti Sociali/);
        assert.match([body1, body2].join('\n'), /equivalent|equivalente|gleichwertig|équivalent/i);
        for (const url of [
          'https://lugano-lis.ch/wp-content/uploads/10_Capitolato-educatori-dellinfanzia.pdf',
          'https://www.sbfi.admin.ch/it/faq-processo-di-riconoscimento-delle-qualifiche-professionali',
          'https://www.sem.admin.ch/sem/it/home/themen/fza_schweiz-eu-efta/eu-efta_buerger_schweiz/faq.html',
          'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/accordo-tra-la-svizzera-e-litalia-sullimposizione-dei-lavoratori-frontalieri',
        ]) assert.ok([body1, body2, body3].join('\n').includes(url), `${locale}/${id} misses ${url}`);
        for (const fact of SALARY_FACTS[locale]) assert.ok(body1.includes(fact), `${locale}/${id} misses ${fact}`);
        assert.match(body1, /18%|18 percent|18 Prozent|18 %/i);
        assert.match(body3, /2026/);
        assert.match(body3, /17 luglio 2023|17 July 2023|17\. Juli 2023|17 juillet 2023/);
        assert.match(body3, /nav:jobs/);
        assert.match(body3, /nav:calculator/);
        assert.match(body3, /lavoro-ticino-educatore|jobs-ticino-educator|arbeit-tessin-erzieher|travail-tessin-educateur/);
        if (id !== IDS[0]) assert.ok(body3.includes(GUIDE_URLS[locale]), `${locale}/${id} links to the wrong guide locale`);
        if (locale === 'en') assert.doesNotMatch(body3, /has applied since 17 July 2023/);
      }
    }
  });

  it('updates only the reviewed metadata and modification dates', () => {
    for (const locale of LOCALES) {
      const metaPath = path.join(ROOT, `content/blog-meta-${locale}.ts`);
      for (const id of IDS) {
        const title = readStringField(metaPath, `blog.article.${id}.title`);
        const excerpt = readStringField(metaPath, `blog.article.${id}.excerpt`);
        assert.ok(title.length > 20, `${locale}/${id} title is missing`);
        assert.ok(excerpt.length > 60, `${locale}/${id} excerpt is missing`);
        assert.doesNotMatch(excerpt, /73K.?97K|€\s?7['’]?500|4['’]?500 CHF/i);
      }
    }

    const registry = fs.readFileSync(path.join(ROOT, 'content/blog-articles-data.ts'), 'utf8');
    for (const id of IDS) {
      const start = registry.indexOf(`id: '${id}'`);
      assert.notEqual(start, -1, `missing registry record for ${id}`);
      const end = registry.indexOf('\n },', start);
      const record = registry.slice(start, end);
      assert.match(record, /updatedAt: '2026-10-20'/);
      assert.ok(record.includes(`date: '${REGISTRY_DATES[id]}'`), `${id} publication date changed`);

      const seo = readSeoEntry(id);
      assert.match(seo, /"dateModified": "2026-10-20T00:00:00\+00:00"/);
      assert.ok(seo.includes(`"datePublished": "${PUBLISHED[id]}"`), `${id} SEO publish date changed`);
      assert.ok(seo.includes(`canonicalPath: '${CANONICAL_PATHS[id]}'`), `${id} canonical path changed`);
      assert.match(seo, /"headline":/);
      assert.match(seo, /"description":/);
      assert.doesNotMatch(seo, /€.?7.?500|73K.?97K|Liceo Internazionale/i);
    }
  });
});
