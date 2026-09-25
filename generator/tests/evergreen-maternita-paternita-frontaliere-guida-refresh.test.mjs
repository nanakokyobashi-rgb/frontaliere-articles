/**
 * Refresh evergreen di `maternita-paternita-frontaliere-guida` (corpus #1804).
 *
 * Fissa nelle quattro lingue i fatti verificati il 2026-09-25 e fallisce se
 * tornano i valori smentiti dalle fonti ufficiali:
 *  - indennita' IPG di maternita' e per l'altro genitore: 80%, al massimo
 *    CHF 220 al giorno (salario mensile di CHF 8'250), promemoria AVS/AI 6.02
 *    (stato 1.1.2025) e 6.04 (stato 1.1.2024); non "CHF 230 stimati";
 *  - congedo dell'altro genitore: 2 settimane = 10 giorni lavorativi pagati
 *    con 14 indennita' giornaliere (promemoria 6.04), non "14 giorni" di
 *    assenza; la stessa cifra compare in `congedo-genitori-frontaliere-ticino`.
 * L'excerpt dei quattro `blog-meta` e l'ogDescription SEO ripetono il
 * massimale: vanno allineati con il body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'maternita-paternita-frontaliere-guida';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';
const MEMENTO_SUFFIX = { it: 'i', en: 'e', de: 'd', fr: 'f' };

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function excerpt(locale) {
  const meta = read(`content/blog-meta-${locale}.ts`);
  const line = meta.split('\n').find((l) => l.includes(`blog.article.${SLUG}.excerpt`));
  assert.ok(line, `${locale}: excerpt presente`);
  return line;
}

test('il registry porta updatedAt del refresh fattuale', () => {
  const registry = read('content/blog-articles-data.ts');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: massimale IPG 220 e congedo dell'altro genitore con fonte`, () => {
    const source = read(`content/blog-body/${locale}/${SLUG}.ts`);
    assert.match(source, /CHF 220/, 'massimale giornaliero IPG');
    assert.doesNotMatch(source, /230/, 'massimale superato (CHF 230)');
    assert.match(source, /8(?:\\'|,)250/, 'salario mensile che da il massimale');
    assert.match(source, /\b10\b[^.]{0,40}(?:lavorativ|working|Arbeitstage|ouvrables)/, '10 giorni lavorativi');
    assert.match(source, /\b14\b[^.]{0,20}(?:indennità giornaliere|daily allowances|Taggelder|indemnités journalières)/, '14 indennita giornaliere');
    assert.doesNotMatch(source, /\(14 (?:giorni|days|Tage|jours)\)/, 'congedo presentato come 14 giorni di assenza');
    assert.doesNotMatch(source, /(?:Giugno|June|Juni|juin) 2024/, 'fonte datata giugno 2024');
    const suffix = MEMENTO_SUFFIX[locale];
    assert.ok(source.includes(`https://www.ahv-iv.ch/p/6.02.${suffix}`), 'fonte promemoria 6.02');
    assert.ok(source.includes(`https://www.ahv-iv.ch/p/6.04.${suffix}`), 'fonte promemoria 6.04');
  });

  test(`${locale}: l'excerpt usa il massimale 220`, () => {
    const line = excerpt(locale);
    assert.match(line, /220/);
    assert.doesNotMatch(line, /230/);
  });
}

test("l'ogDescription SEO usa il massimale 220", () => {
  const seo = read('content/seo/seo-blog.ts');
  const start = seo.indexOf(`'blog-${SLUG}': {`);
  assert.ok(start >= 0, 'voce SEO presente');
  const og = seo.slice(start).split('\n').find((l) => l.includes('ogDescription'));
  assert.match(og, /CHF 220/);
  assert.doesNotMatch(og, /230/);
});
