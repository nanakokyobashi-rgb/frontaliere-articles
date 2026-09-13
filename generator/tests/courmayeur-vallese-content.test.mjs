import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTICLE_ID = 'vivere-courmayeur-e-lavorare-vallese-da-frontaliere';
const FORBIDDEN = /Ticino|Tessin|Lugano|Bellinzona|150 CHF/;
const LOCALES = ['it', 'en', 'de', 'fr'];

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function extractMetaBlock(source) {
  const start = source.indexOf(`'blog.article.${ARTICLE_ID}.title'`);
  const end = source.indexOf(`'blog.article.${ARTICLE_ID}.imageAlt'`, start);
  assert.notEqual(start, -1, 'target metadata title is present');
  assert.notEqual(end, -1, 'target metadata imageAlt terminates the metadata slice');
  return source.slice(start, end);
}

function extractSeoEntry(source) {
  const start = source.indexOf(`'blog-${ARTICLE_ID}': {`);
  const structuredStart = source.indexOf('    structuredData:', start);
  const nextEntry = source.indexOf("\n  'blog-", structuredStart);
  assert.notEqual(start, -1, 'target SEO entry is present');
  assert.notEqual(structuredStart, -1, 'target structured data is present');
  assert.notEqual(nextEntry, -1, 'target SEO entry has a following boundary');
  return {
    topLevel: source.slice(start, structuredStart),
    structuredData: source.slice(structuredStart, nextEntry),
  };
}

test('l’articolo Courmayeur–Vallese non contiene toponimi o importi inventati', () => {
  for (const locale of LOCALES) {
    const body = read(`content/blog-body/${locale}/${ARTICLE_ID}.ts`);
    assert.doesNotMatch(body, FORBIDDEN, `${locale} body has no forbidden reference`);
    assert.match(body, /Courmayeur/);
    assert.match(body, /Pré-Saint-Didier/);
    assert.match(body, /Morgex/);
    assert.match(body, /La Salle/);
    assert.match(body, /Aosta|Aoste/);
  }
});

test('titoli ed excerpt delle quattro lingue restano allineati al SEO italiano', () => {
  const expectedTitles = {
    it: 'Courmayeur: lavorare in Vallese vivendo in Valle d’Aosta',
    en: 'Courmayeur: working in Valais while living in Aosta Valley',
    de: 'Courmayeur: Im Wallis arbeiten und im Aostatal leben',
    fr: 'Courmayeur : travailler en Valais en vivant dans la Vallée d’Aoste',
  };
  const expectedExcerpts = {
    it: 'Come valutare un pendolarismo tra Courmayeur e il Vallese: percorsi, residenza e verifiche da fare prima di accettare un lavoro.',
    en: 'How to assess cross-border commuting between Courmayeur and Valais, including routes, residence and checks before accepting a job.',
    de: 'Wie Sie das Pendeln zwischen Courmayeur und dem Wallis prüfen: Strecke, Wohnsitz und wichtige Abklärungen vor einer Zusage.',
    fr: 'Comment évaluer le trajet transfrontalier entre Courmayeur et le Valais, le logement et les vérifications avant d’accepter un emploi.',
  };

  for (const locale of LOCALES) {
    const block = extractMetaBlock(read(`content/blog-meta-${locale}.ts`));
    assert.doesNotMatch(block, FORBIDDEN, `${locale} metadata has no forbidden reference`);
    assert.match(block, new RegExp(expectedTitles[locale].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(block, new RegExp(expectedExcerpts[locale].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const seo = extractSeoEntry(read('content/seo/seo-blog-5.ts'));
  assert.doesNotMatch(seo.topLevel, FORBIDDEN);
  assert.match(seo.topLevel, /title: 'Courmayeur: lavorare in Vallese vivendo in Valle d’Aosta'/);
  assert.match(seo.topLevel, /description: 'Come valutare un pendolarismo tra Courmayeur e il Vallese:/);
  assert.match(seo.topLevel, /keywords: 'frontalieri, valle d’Aosta, courmayeur, vallese, valais, lavoro transfrontaliero'/);
  assert.match(seo.structuredData, /"headline": "Courmayeur: lavorare in Vallese vivendo in Valle d’Aosta"/);
  assert.match(seo.structuredData, /"description": "Come valutare un pendolarismo tra Courmayeur e il Vallese:/);
  assert.match(seo.structuredData, /"name": "Frontaliere Ticino"/);
  assert.match(seo.structuredData, /"name": "Redazione Frontaliere Ticino"/);
});
