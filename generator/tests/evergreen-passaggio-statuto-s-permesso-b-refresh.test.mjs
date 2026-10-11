/**
 * Refresh source-backed dell’articolo sullo statuto S e il permesso B.
 *
 * Il difetto originario mescolava una proroga superata al 2027, stime locali
 * senza fonte e requisiti inventati. Questo test tiene agganciati i quattro
 * corpi, i metadati, la SEO e la data materiale del registry alle fonti
 * federali/cantonali usate dal refresh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'passaggio-statuto-s-permesso-b';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-10-11';
const TICINO_SOURCE = 'https://www4.ti.ch/generale/crisi-ucraina/it/informazioni/permesso-s';
const SOURCES = {
  it: {
    sem: 'https://www.sem.admin.ch/sem/it/home/sem/aktuell/ukraine-krieg.html',
    federal: 'https://www.efd.admin.ch/it/newnsb/hFEfxUQEMQFg',
    fedlex: 'https://www.fedlex.admin.ch/eli/cc/1999/358/it',
    date: /4 marzo 2028/,
    years: /cinque anni/,
    authority: /autorità cantonale/,
  },
  en: {
    sem: 'https://www.sem.admin.ch/sem/en/home/sem/aktuell/ukraine-krieg.html',
    federal: 'https://www.bk.admin.ch/en/newnsb/hFEfxUQEMQFg',
    fedlex: 'https://www.fedlex.admin.ch/eli/cc/1999/358/en',
    date: /4 March 2028/,
    years: /five years/,
    authority: /cantonal authority/,
  },
  de: {
    sem: 'https://www.sem.admin.ch/sem/de/home/sem/aktuell/ukraine-krieg.html',
    federal: 'https://www.agov.admin.ch/de/newnsb/hFEfxUQEMQFg',
    fedlex: 'https://www.fedlex.admin.ch/eli/cc/1999/358/de',
    date: /4\. März 2028/,
    years: /fünf Jahre/,
    authority: /kantonale Behörde/,
  },
  fr: {
    sem: 'https://www.sem.admin.ch/sem/fr/home/sem/aktuell/ukraine-krieg.html',
    federal: 'https://www.agov.admin.ch/fr/newnsb/hFEfxUQEMQFg',
    fedlex: 'https://www.fedlex.admin.ch/eli/cc/1999/358/fr',
    date: /4 mars 2028/,
    years: /cinq ans/,
    authority: /autorité cantonale/,
  },
};

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function bodySource(locale) {
  return read('content/blog-body/' + locale + '/' + SLUG + '.ts');
}

function metaExcerpt(locale) {
  const source = read('content/blog-meta-' + locale + '.ts');
  const key = 'blog.article.' + SLUG + '.excerpt';
  const match = source.match(new RegExp("'" + key + "': '([^']*)'"));
  assert.ok(match, locale + ': estratto assente');
  return match[1];
}

test('il registry porta la data del refresh fattuale', () => {
  const registry = read('content/blog-articles-data.ts');
  assert.match(
    registry,
    new RegExp("id: '" + SLUG + "'[\\s\\S]{0,260}updatedAt: '" + REFRESHED_ON + "'"),
  );
  const start = registry.indexOf("id: '" + SLUG + "'");
  const entry = registry.slice(start, start + 600);
  assert.doesNotMatch(entry, /verifiedAt:/, 'un cambio fattuale non va registrato come sola verifica');
});

for (const locale of LOCALES) {
  test(locale + ': fonti federali, base legale e ruolo cantonale restano nel corpo', () => {
    const source = bodySource(locale);
    const expected = SOURCES[locale];
    for (const url of [expected.sem, expected.federal, expected.fedlex, TICINO_SOURCE]) {
      assert.ok(source.includes(url), locale + ': fonte assente: ' + url);
    }
    assert.match(source, expected.date, locale + ': proroga aggiornata al 4 marzo 2028');
    assert.match(source, expected.years, locale + ': soggiorno quinquennale');
    assert.match(source, /74/, locale + ': articolo 74');
    assert.match(source, expected.authority, locale + ': autorità cantonale');
    assert.match(source, /(?:3.?000|3 000|3’000|3,000)/, locale + ': contributo federale del programma S');
  });

  test(locale + ': estratto aggiornato senza la proroga superata', () => {
    const excerpt = metaExcerpt(locale);
    assert.match(excerpt, SOURCES[locale].date, locale + ': data corrente nell’estratto');
    assert.doesNotMatch(excerpt, /2027/, locale + ': estratto ancora ancorato al 2027');
  });
}

test('SEO: description e dateModified seguono il refresh', () => {
  const seo = read('content/seo/seo-blog-3.ts');
  const start = seo.indexOf("'blog-" + SLUG + "'");
  const end = seo.indexOf("'blog-chiusure-notturne-autostrada'", start);
  assert.ok(start >= 0 && end > start, 'blocco SEO dello slug assente');
  const block = seo.slice(start, end);
  assert.match(block, /4 marzo 2028/);
  assert.match(block, /"dateModified": "2026-10-11T00:00:00\+00:00"/);
  assert.doesNotMatch(block, /fino al 2027/);
});

test('nessun corpo reintroduce numeri, scadenze o requisiti non source-backed', () => {
  const bodies = LOCALES.map(bodySource).join('\n');
  const staleClaims = [
    /(?:1[.’']?200|1,200|1 200).{0,70}(?:potrebbero|could|könnten|pourraient)/i,
    /(?:circa|about|etwa|environ).{0,20}(?:10 milioni|10 million|10 Millionen|10 millions)/i,
    /(?:circa|about|etwa|environ).{0,20}(?:250\s+(?:franchi|CHF|francs|Franken))/i,
    /(?:entro|by|bis|avant|within|dans).{0,20}(?:31 dicembre|31 December|31\\. Dezember|31 décembre|90 giorni|90 days|90 Tage|90 jours)/i,
    /(?:reddito|income|Einkomm|revenu).{0,45}(?:30[’' ]?000|30,000|30 000)/i,
    /(?:contratto|contract|Vertrag|contrat).{0,45}(?:almeno|at least|mindestens|au moins).{0,12}(?:12|dodici|twelve|zwölf|douze)/i,
    /(?:prorogato|extended|verlängert|prolongé).{0,45}2027/i,
    /(?:passaggio|transition|Übergang|passage).{0,80}(?:automatico|automatic|automatisch|automatique)/i,
  ];
  for (const pattern of staleClaims) {
    assert.doesNotMatch(bodies, pattern, 'claim obsoleto o non documentato: ' + pattern);
  }
});
