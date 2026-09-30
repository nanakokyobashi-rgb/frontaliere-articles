import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BODY_FIELDS,
  BODY_ROOTS,
  extractBodyFields,
  inspectBlogLocaleCompleteness,
} from '../../scripts/ci/check-blog-locale-completeness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-locale-completeness-'));
  for (const { rel } of BODY_ROOTS) {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      fs.mkdirSync(path.join(root, rel, locale), { recursive: true });
    }
  }
  return root;
}

function bodyFile(id, values) {
  return `const body = {\n${BODY_FIELDS
    .filter((field) => values[field] !== undefined)
    .map((field) => `  'blog.article.${id}.${field}': '${String(values[field]).replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}',`)
    .join('\n')}\n};\nexport default body;\n`;
}

function writeArticle(root, bodyRoot, locale, id, values) {
  fs.writeFileSync(path.join(root, bodyRoot, locale, `${id}.ts`), bodyFile(id, values));
}

test('extractBodyFields decodifica le stringhe TS senza confondere gli escape JSON', () => {
  const entries = extractBodyFields(
    "'blog.article.demo.body1': 'Titolo\\' e riga\\nseconda',\n"
      + "'blog.article.demo.faq': '[{\\\"a\\\":\\\"x\\\"}]',\n"
      + "'blog.article.demo.body2': `## Titolo`,\n",
  );
  assert.deepEqual(entries, [
    { id: 'demo', field: 'body1', value: "Titolo' e riga\nseconda" },
    { id: 'demo', field: 'body2', value: '## Titolo' },
  ]);
});

test('extractBodyFields include i body opzionali emessi dal writer fino a body20', () => {
  const entries = extractBodyFields(
    "'blog.article.demo.body4': 'Quattro',\n"
      + "'blog.article.demo.body20': 'Venti',\n"
      + "'blog.article.demo.body21': 'fuori schema',\n",
  );
  assert.deepEqual(entries, [
    { id: 'demo', field: 'body4', value: 'Quattro' },
    { id: 'demo', field: 'body20', value: 'Venti' },
  ]);
});

test('FU-009 — il controllo rileva chiavi mancanti e copie italiane', () => {
  const root = fixtureRoot();
  const id = 'demo';
  const source = { body1: 'Testo italiano uno', body2: 'Testo italiano due', body3: 'Testo italiano tre' };
  for (const { rel } of BODY_ROOTS) {
    writeArticle(root, rel, 'it', id, source);
    writeArticle(root, rel, 'en', id, { body1: 'English text one', body3: 'English text three' });
    writeArticle(root, rel, 'de', id, { body1: source.body1, body2: 'Deutscher Text zwei', body3: 'Deutscher Text drei' });
    writeArticle(root, rel, 'fr', id, { body1: 'Texte français un', body2: 'Texte français deux', body3: 'Texte français trois' });
  }

  const report = inspectBlogLocaleCompleteness({ root, minItalianFiles: 1, minItalianFields: 1 });
  assert.equal(report.ok, false);
  assert.equal(report.counts['missing-key'], 2);
  assert.equal(report.counts['source-echo'], 2);
  assert.ok(report.violations.every((violation) => violation.path.includes('content/')));
});

test('FU-009 — il controllo segue i body opzionali presenti nella sorgente', () => {
  const root = fixtureRoot();
  const id = 'optional-bodies';
  const source = {
    body1: 'Testo italiano uno',
    body2: 'Testo italiano due',
    body3: 'Testo italiano tre',
    body4: 'Testo italiano quattro',
    body20: 'Testo italiano venti',
  };
  for (const { rel } of BODY_ROOTS) {
    writeArticle(root, rel, 'it', id, source);
    writeArticle(root, rel, 'en', id, {
      body1: 'English text one',
      body2: 'English text two',
      body3: 'English text three',
    });
    writeArticle(root, rel, 'de', id, {
      ...source,
      body4: 'Deutscher Text vier',
      body20: 'Deutscher Text zwanzig',
    });
    writeArticle(root, rel, 'fr', id, {
      ...source,
      body4: 'Texte français quatre',
      body20: 'Texte français vingt',
    });
  }

  const report = inspectBlogLocaleCompleteness({ root, minItalianFiles: 1, minItalianFields: 1 });
  assert.equal(report.ok, false);
  assert.equal(report.counts['missing-key'], 4);
  assert.ok(report.violations.every((violation) => violation.field !== 'body21'));
  assert.deepEqual(
    report.violations
      .filter((violation) => violation.code === 'missing-key')
      .map((violation) => violation.field),
    ['body4', 'body20', 'body4', 'body20'],
  );
});

test('FU-009 — il pavimento impedisce uno scan vuoto', () => {
  const root = fixtureRoot();
  const report = inspectBlogLocaleCompleteness({ root, minItalianFiles: 1, minItalianFields: 1 });
  assert.equal(report.ok, false);
  assert.equal(report.counts['source-floor'], 2);
  assert.equal(report.counts['source-field-floor'], 2);
});

test('publish-api espone il gate di completezza prima delle credenziali', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish-api.yml'), 'utf8');
  const gate = workflow.indexOf('check-blog-locale-completeness.mjs');
  const credentials = workflow.indexOf('Prepare Firebase credentials');
  assert.ok(gate >= 0, 'publish-api non richiama il gate FU-009');
  assert.ok(gate < credentials, 'il gate FU-009 deve precedere le credenziali di produzione');
});
