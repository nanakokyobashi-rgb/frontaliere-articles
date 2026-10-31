// Tiene ferma la bonifica del 31/10/2026: nessuna superficie pubblicata del
// corpus puo' tornare a dire che i frontalieri sono tassati solo in Svizzera o
// che i vecchi frontalieri hanno 7.500 euro di esenzione fino al 2033, in
// nessuna lingua. Le regole stanno in `engine/shared/editorialClaims.mjs`, lo
// stesso modulo che ferma l'articolo prima della pubblicazione.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTsStringLiteral } from '../scripts/lib/ts-string-map.mjs';
import { CLAIM_LOCALES, findEditorialClaims } from '../../engine/shared/editorialClaims.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIELD_KEY = /(['"])blog\.article\.([^'"]+?)\.(title|excerpt|imageAlt|body\d*|faq)\1\s*:\s*/g;

function offendersIn(file, locale) {
  const source = readFileSync(file, 'utf8');
  const found = [];
  FIELD_KEY.lastIndex = 0;
  for (let match = FIELD_KEY.exec(source); match; match = FIELD_KEY.exec(source)) {
    const literal = readTsStringLiteral(source, match.index + match[0].length);
    if (!literal) continue;
    for (const claim of findEditorialClaims(literal.value, { locale })) {
      found.push(`${path.relative(root, file)} ${match[3]} [${claim.class}] ${claim.sentence.slice(0, 120)}`);
    }
  }
  return found;
}

test('corpi degli articoli senza affermazioni fiscali vietate, nelle quattro lingue', () => {
  const offenders = [];
  for (const section of ['blog-body', 'blog-body-ch']) {
    for (const locale of CLAIM_LOCALES) {
      const dir = path.join(root, 'content', section, locale);
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.ts')) offenders.push(...offendersIn(path.join(dir, name), locale));
      }
    }
  }
  assert.deepEqual(offenders.slice(0, 20), [], `${offenders.length} frasi vietate`);
});

test('meta degli articoli senza affermazioni fiscali vietate, nelle quattro lingue', () => {
  const offenders = [];
  for (const locale of CLAIM_LOCALES) {
    for (const name of [`blog-meta-${locale}.ts`, `blog-meta-ch-${locale}.ts`]) {
      offenders.push(...offendersIn(path.join(root, 'content', name), locale));
    }
  }
  assert.deepEqual(offenders.slice(0, 20), [], `${offenders.length} frasi vietate`);
});
