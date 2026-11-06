import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findEditorialClaims } from '../../engine/shared/editorialClaims.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'];

function articleSource(root, locale, slug) {
  return readFileSync(new URL(`../../${root}/${locale}/${slug}.ts`, import.meta.url), 'utf8');
}

function bodyFields(source) {
  return source.split('\n').filter((line) => /\.body\d+':/.test(line)).join('\n');
}

test('FU-2026-10-31-002: tassa salute, prompt e permesso G restano senza residui nel target', () => {
  const slug = 'tassa-salute-frontalieri-attacco-ticino';
  const residuals = [];

  for (const locale of LOCALES) {
    const file = `content/blog-body-ch/${locale}/${slug}.ts`;
    const source = articleSource('content/blog-body-ch', locale, slug);
    assert.match(source, /https:\/\/www\.normattiva\.it\//u, `${file}: fonte normativa italiana assente`);
    assert.match(source, /https:\/\/www\.fedlex\.admin\.ch\//u, `${file}: fonte normativa svizzera assente`);
    for (const claim of findEditorialClaims(source, { locale })) {
      residuals.push(`${file}: ${claim.class}: ${claim.sentence}`);
    }
  }

  assert.deepEqual(residuals, []);
});

test('FU-2026-10-31-004: le citazioni non verificabili di Cassis, Licata e Zocchi restano assenti', () => {
  const articleFamilies = [
    ['Cassis', 'content/blog-body-ch', 'tassa-salute-frontalieri-blocco-ristorni-ticino'],
    ['Licata', 'content/blog-body', 'tassa-salute-frontalieri-licata-2026'],
    ['Zocchi', 'content/blog-body', 'frontalieri-contributo-sanitario-2026'],
  ];
  const quoteAttributions = [
    /(?:\\n|': ')>\s*/u,
    /\*(?:«|").*?(?:»|")\*,\s+(?:ha dichiarato|he stated|erklärte er|a-t-il déclaré)\./u,
    /(?:"|»),?\s+(?:ha dichiarato (?:Cassis|il Consiglio di Stato)|Cassis said|sagte Cassis|a déclaré M\. Cassis)\./u,
  ];
  const residuals = [];

  for (const [person, root, slug] of articleFamilies) {
    for (const locale of LOCALES) {
      const bodies = bodyFields(articleSource(root, locale, slug));
      if (quoteAttributions.some((pattern) => pattern.test(bodies))) {
        residuals.push(`${person}: ${root}/${locale}/${slug}.ts`);
      }
    }
  }

  assert.deepEqual(residuals, []);
});
