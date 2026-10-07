import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSeoMetadata } from '../scripts/lib/seo-metadata-derivation.mjs';
import { appendSeoEntrySource, buildSeoEntry, toIsoWithTz } from '../scripts/lib/seo-entry-builder.mjs';

function article() {
  return {
    id: 'demo-2026',
    date: '2026-03-03T14:39:51.004Z',
    content: {
      it: {
        title: 'Titolo deterministico per',
        excerpt: 'Una descrizione abbastanza lunga da verificare il percorso SEO senza generazione automatica e con una fine di frase completa per il limite.'
          + ' Dati locali del Ticino.',
      },
    },
    imageAlt: { it: 'Panorama del Ticino' },
    slugs: { it: 'titolo-deterministico', en: 'deterministic-title', de: 'deterministischer-titel', fr: 'titre-deterministe' },
    seo: {},
    _generatedImagePath: '/images/places/lugano-view.webp',
    author: { slug: 'redazione', name: 'Redazione Frontaliere Ticino' },
  };
}

test('la derivazione usa i meta esistenti e rimuove la coda funzionale con la regola condivisa', () => {
  const data = article();
  deriveSeoMetadata(data);
  assert.equal(data.seo.headline, 'Titolo deterministico');
  assert.equal(data.seo.ogTitle, 'Titolo deterministico');
  assert.match(data.seo.title, /^Titolo deterministico \| Frontaliere Ticino$/);
  assert.ok(data.seo.description.length <= 160);
  assert.match(data.seo.keywords, /^frontalieri, ticino, svizzera, italia,/);
});

test('il builder mantiene una sola forma JSON-LD e distingue Commons da fallback governato', () => {
  const commons = article();
  deriveSeoMetadata(commons);
  const commonsEntry = buildSeoEntry(commons, {
    provenance: { kind: 'wikimedia-commons', record: { width: 3712, height: 2088 } },
    publishedAt: toIsoWithTz(commons.date, { preserveExplicitOffset: false }),
    modifiedAt: toIsoWithTz(commons.date, { preserveExplicitOffset: false }),
  });
  assert.match(commonsEntry, /"@type": "NewsArticle"/);
  assert.match(commonsEntry, /"datePublished": "2026-03-03T15:39:51\+01:00"/);
  assert.doesNotMatch(commonsEntry, /acquireLicensePage|copyrightNotice|creditText/);

  const generated = article();
  deriveSeoMetadata(generated);
  const generatedEntry = buildSeoEntry(generated, {
    provenance: {
      kind: 'generated',
      record: { licenseUrl: 'https://openai.com/policies/terms-of-use/', credit: 'frontaliereticino.ch', width: 1200, height: 675 },
    },
    publishedAt: toIsoWithTz(generated.date, { preserveExplicitOffset: false }),
    modifiedAt: toIsoWithTz(generated.date, { preserveExplicitOffset: false }),
  });
  assert.match(generatedEntry, /"license": "https:\/\/openai\.com\/policies\/terms-of-use\/"/);
  assert.match(generatedEntry, /"url": `\$\{BASE_URL\}\/images\/places\/lugano-view\.webp`/);
});

test('le date senza orario usano mezzogiorno Europe/Zurich con il cambio DST dichiarato', () => {
  assert.equal(
    toIsoWithTz('2026-01-03', { preserveExplicitOffset: false }),
    '2026-01-03T12:00:00+01:00',
  );
  assert.equal(
    toIsoWithTz('2026-07-03', { preserveExplicitOffset: false }),
    '2026-07-03T12:00:00+02:00',
  );
});

test('appendSeoEntrySource usa il chunk scelto dal writer e non seo-blog.ts', () => {
  const data = article();
  deriveSeoMetadata(data);
  const entry = buildSeoEntry(data, {
    provenance: { kind: 'generated', record: { licenseUrl: 'https://openai.com/policies/terms-of-use/', credit: 'frontaliereticino.ch' } },
    publishedAt: data.date,
    modifiedAt: data.date,
  });
  const source = 'const BLOG_SEO_METADATA_5 = {\n  \'blog-existing\': {},\n};\nexport default BLOG_SEO_METADATA_5;\n';
  const updated = appendSeoEntrySource(source, entry, { seoConstName: 'BLOG_SEO_METADATA', updateRouterUnion: true });
  assert.match(updated, /blog-demo-2026/);
  assert.match(updated, /export default BLOG_SEO_METADATA_5;/);
});
