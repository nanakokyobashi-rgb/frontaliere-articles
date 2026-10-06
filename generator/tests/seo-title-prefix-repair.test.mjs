/**
 * The SEO title-prefix gate and its source-level contract.
 *
 * `content.it.title` is the canonical H1. A generated `ogTitle` or JSON-LD
 * `headline` may be shorter only when the shared clause helper says that the
 * cut is intentional and complete; a strict prefix with a missing tail is a
 * live page defect, not an editorial variant.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAllSeoEntryMatches } from '../../scripts/lib/seo-entry.mjs';
import { metaFieldRegex, unescapeTsValue } from '../scripts/lib/meta-field-regex.mjs';
import { unescapeTsString } from '../scripts/lib/unescape-ts-string.mjs';
import {
  SEO_TITLE_FIELD_LIMITS,
  isStrictSeoTitlePrefix,
  repairSeoTitleField,
} from '../scripts/lib/seo-title-repair.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEO_DIR = path.join(ROOT, 'content', 'seo');

function readCanonicalTitles() {
  const source = fs.readFileSync(path.join(ROOT, 'content', 'blog-meta-it.ts'), 'utf8');
  return new Map([...source.matchAll(metaFieldRegex('title'))]
    .map((match) => [match[1], unescapeTsValue(match[2]).trim()]));
}

function readField(block, field) {
  if (field === 'ogTitle') {
    const match = /\bogTitle\s*:\s*'((?:[^'\\]|\\.)*)'/.exec(block);
    return match ? unescapeTsValue(match[1]).trim() : '';
  }
  const match = /"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(block);
  return match ? unescapeTsString(match[1], { '"': '"', '\\': '\\' }).trim() : '';
}

function scanCorpus() {
  const titles = readCanonicalTitles();
  const files = fs.readdirSync(SEO_DIR).filter((file) => /^seo-blog.*\.ts$/.test(file)).sort();
  const rows = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(SEO_DIR, file), 'utf8');
    for (const entry of findAllSeoEntryMatches(source, path.join('content/seo', file))) {
      const canonical = titles.get(entry.id);
      if (!canonical) continue;
      const block = source.slice(entry.openIdx, entry.closeIdx + 1);
      for (const [field, maxLen] of Object.entries(SEO_TITLE_FIELD_LIMITS)) {
        const value = readField(block, field);
        if (!value || !isStrictSeoTitlePrefix(value, canonical)) continue;
        rows.push({ file, id: entry.id, field, value, canonical, maxLen });
      }
    }
  }
  return { titles, files, rows };
}

describe('repairSeoTitleField — casi accettati dalla issue #2281', () => {
  const cases = [
    [
      'Risparmio Casa arriva al Centro Breggia di Balerna: cosa',
      'Risparmio Casa arriva al Centro Breggia di Balerna: cosa cambia per i frontalieri',
      60,
      'Risparmio Casa arriva al Centro Breggia di Balerna',
    ],
    [
      'Confine tesissimo: stop agli assegni familiari ai',
      'Confine tesissimo: stop agli assegni familiari ai frontalieri',
      60,
      'Confine tesissimo: stop agli assegni familiari',
    ],
    [
      'Il paradosso del Ticino: 600 candidature per 3 posti di',
      'Il paradosso del Ticino: 600 candidature per 3 posti di lavoro',
      60,
      'Il paradosso del Ticino: 600 candidature per 3 posti',
    ],
    [
      'Chiasso: il Tribunale Federale impone la riscrittura del',
      'Chiasso: il Tribunale Federale impone la riscrittura del Piano Regolatore per la telefonia',
      60,
      'Chiasso: il Tribunale Federale impone la riscrittura',
    ],
  ];

  for (const [candidate, canonical, maxLen, expected] of cases) {
    test(`ripara «${candidate}»`, () => {
      assert.equal(repairSeoTitleField(candidate, canonical, maxLen), expected);
    });
  }

  test('non indovina un valore che non è un prefisso del titolo', () => {
    const candidate = 'Titolo editoriale diverso';
    const canonical = 'Risparmio Casa arriva al Centro Breggia di Balerna';
    assert.equal(repairSeoTitleField(candidate, canonical, 60), candidate);
  });
});

describe('content/seo — gate sui prefissi SEO troncati', () => {
  const { titles, files, rows } = scanCorpus();

  test('lo scan non è vacuo', () => {
    assert.ok(files.length >= 8, `attesi almeno 8 chunk SEO, trovati ${files.length}`);
    assert.ok(titles.size > 3000, `titoli IT letti: ${titles.size}`);
    assert.ok(rows.length > 100, `prefissi storici letti: ${rows.length}`);
  });

  test('nessun prefisso stretto pubblicato resta diverso dalla riparazione clause-safe', () => {
    const offenders = rows
      .filter((row) => repairSeoTitleField(row.value, row.canonical, row.maxLen) !== row.value)
      .map((row) => `${row.file}: ${row.id}.${row.field} = ${JSON.stringify(row.value)}`);
    assert.deepEqual(offenders, [], `prefissi SEO troncati ancora pubblicati:\n${offenders.slice(0, 20).join('\n')}`);
  });
});

test('il generatore usa la stessa sorgente di riparazione per entrambi i campi', () => {
  const source = fs.readFileSync(path.join(ROOT, 'generator', 'scripts', 'create-article.mjs'), 'utf8');
  assert.match(source, /import \{ repairSeoTitleFields \} from '\.\/lib\/seo-title-repair\.mjs';/);
  assert.match(source, /repairSeoTitleFields\(data\.seo, seoTitleCore\)/);
  assert.match(source, /data\.seo\.ogTitle = data\.seo\.ogTitle \? String\(data\.seo\.ogTitle\)\.trim\(\) : seoTitleCore/);
  assert.match(source, /data\.seo\.headline = data\.seo\.headline \? String\(data\.seo\.headline\)\.trim\(\) : seoTitleCore/);
});
