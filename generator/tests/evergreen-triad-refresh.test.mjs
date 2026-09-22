import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-22';

function bodySource(locale, slug) {
  return fs.readFileSync(
    path.join(ROOT, 'content', 'blog-body', locale, `${slug}.ts`),
    'utf8',
  );
}

test('il refresh CU 2026 mantiene scadenze e fonti ufficiali in tutte le lingue', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'data', 'blog-articles-data.ts'), 'utf8');
  for (const slug of ['cu-2026-novita-frontalieri']) {
    assert.match(
      registry,
      new RegExp(`id: '${slug}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`),
    );
  }

  for (const locale of LOCALES) {
    const source = bodySource(locale, 'cu-2026-novita-frontalieri');
    assert.match(source, /16(?:\.|\s)\s*(?:March|marzo|März|mars)/i, `${locale}: deadline CU aggiornata`);
    assert.match(source, /agenziaentrate\.gov\.it/);
    assert.match(source, /estv\.admin\.ch/);
    assert.doesNotMatch(source, /mid-March|metà marzo|Mitte März|mi-mars/i);
  }
});

test('il refresh del franco usa l’ultimo riferimento BCE e il conteggio Ustat verificato', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'data', 'blog-articles-data.ts'), 'utf8');
  assert.match(
    registry,
    new RegExp("id: 'franco-forte-stipendio-frontalieri'[\\s\\S]{0,220}updatedAt: '" + REFRESHED_ON + "'"),
  );

  for (const locale of LOCALES) {
    const source = bodySource(locale, 'franco-forte-stipendio-frontalieri');
    assert.match(source, /0[.,]9462/, `${locale}: tasso BCE corrente`);
    assert.match(source, /78[., ]561/, `${locale}: conteggio Ustat corrente`);
    assert.match(source, /ecb\.europa\.eu/);
    assert.match(source, /ti\.ch\/DFE\/DR\/USTAT/);
    assert.doesNotMatch(source, /0[.,]913|5[., ]435|300-400|430\s*EUR/);
  }
});
