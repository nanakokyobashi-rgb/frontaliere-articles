import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BODY_FIELDS,
  BODY_ROOTS,
  TARGET_LOCALES,
  parseGitStatusPaths,
  extractBodyFields,
  formatViolationForCli,
  projectReportForCli,
  inspectBlogLocaleCompleteness,
} from '../../scripts/ci/check-blog-locale-completeness.mjs';
import { floorPolicyOf } from '../../scripts/lib/corpus-floors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HISTORICAL_BODY_ROOTS = BODY_ROOTS.filter(({ name }) => floorPolicyOf(name) !== 'family');

test('la CLI può riportare violazioni senza path o ID del contenuto', () => {
  const violation = {
    code: 'missing-key',
    section: 'frontaliere',
    locale: 'de',
    message: 'content/blog-body/de/private-trend-topic.ts: blog.article.private-trend-topic.body1 mancante',
  };
  assert.equal(
    formatViolationForCli(violation, { redactPaths: true }),
    '[missing-key] section=frontaliere locale=de: content check failed',
  );
  assert.equal(formatViolationForCli(violation), violation.message);
  const report = projectReportForCli({
    changedPaths: ['content/blog-body/de/private-trend-topic.ts'],
    violations: [violation],
  }, { redactPaths: true });
  assert.equal(JSON.stringify(report).includes('private-trend-topic'), false);
  assert.equal(report.changedPaths[0], '[path redacted]');
});

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

test('extractBodyFields legge anche chiavi e valori delimitati da doppi apici', () => {
  const entries = extractBodyFields([
    '"blog.article.demo.body1": "Titolo \\"citato\\"\\nseconda"',
    '"blog.article.demo.body2": "Secondo corpo"',
  ].join('\n'));
  assert.deepEqual(entries, [
    { id: 'demo', field: 'body1', value: 'Titolo "citato"\nseconda' },
    { id: 'demo', field: 'body2', value: 'Secondo corpo' },
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

test('extractBodyFields ignora chiavi dentro commenti e prosa dei body', () => {
  const entries = extractBodyFields([
    "// 'blog.article.demo.body4': 'commento'",
    '/* "blog.article.demo.body5": "commento" */',
    'const body = {',
    "  'blog.article.demo.body1': 'Testo con \\'blog.article.demo.body4\\': falso',",
    '  \'blog.article.demo.body2\': `Testo con blog.article.demo.body5: falso`,',
    "  'blog.article.demo.body3': 'Tre',",
    '};',
  ].join('\n'));
  assert.deepEqual(entries.map(({ id, field }) => ({ id, field })), [
    { id: 'demo', field: 'body1' },
    { id: 'demo', field: 'body2' },
    { id: 'demo', field: 'body3' },
  ]);
});

test('extractBodyFields rejects interpolation before returning partial body keys', () => {
  const source = [
    "const body = { 'blog.article.demo.body1': 'valid before failure' };",
    'const unrelated = `runtime ${value}`;',
  ].join('\n');

  assert.throws(() => extractBodyFields(source), /Interpolated template literal/u);
});

test('parseGitStatusPaths conserva i path modificati anche con spazi e rename', () => {
  const status = [
    ' M content/blog-body/en/with spaces.ts',
    '?? content/blog-body/fr/new-body.ts',
    'R  content/blog-body/it/old-body.ts',
    'content/blog-body/it/new-body.ts',
    '',
  ].join('\0');
  assert.deepEqual(parseGitStatusPaths(status), [
    'content/blog-body/en/with spaces.ts',
    'content/blog-body/fr/new-body.ts',
    'content/blog-body/it/old-body.ts',
    'content/blog-body/it/new-body.ts',
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
  assert.equal(report.counts['missing-key'], BODY_ROOTS.length);
  assert.equal(report.counts['source-echo'], BODY_ROOTS.length);
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
  assert.equal(report.counts['missing-key'], BODY_ROOTS.length * 2);
  assert.ok(report.violations.every((violation) => violation.field !== 'body21'));
  assert.deepEqual(
    report.violations
      .filter((violation) => violation.code === 'missing-key')
      .map((violation) => violation.field),
    BODY_ROOTS.flatMap(() => ['body4', 'body20']),
  );
});

test('FU-009 — il pavimento impedisce uno scan vuoto', () => {
  const root = fixtureRoot();
  const report = inspectBlogLocaleCompleteness({ root, minItalianFiles: 1, minItalianFields: 1 });
  assert.equal(report.ok, false);
  assert.equal(report.counts['source-floor'], HISTORICAL_BODY_ROOTS.length);
  assert.equal(report.counts['source-field-floor'], HISTORICAL_BODY_ROOTS.length);
});

test('FU-009 scoped — una scrittura valida non eredita violazioni di altri articoli', () => {
  const root = fixtureRoot();
  const target = 'scoped-target';
  const unrelated = 'preexisting-incomplete';
  const source = { body1: 'Testo italiano uno', body2: 'Testo italiano due', body3: 'Testo italiano tre' };
  const translations = {
    en: { body1: 'English text one', body2: 'English text two', body3: 'English text three' },
    de: { body1: 'Deutscher Text eins', body2: 'Deutscher Text zwei', body3: 'Deutscher Text drei' },
    fr: { body1: 'Texte français un', body2: 'Texte français deux', body3: 'Texte français trois' },
  };

  for (const { rel } of BODY_ROOTS) {
    writeArticle(root, rel, 'it', target, source);
    for (const locale of TARGET_LOCALES) writeArticle(root, rel, locale, target, translations[locale]);
    writeArticle(root, rel, 'it', unrelated, source);
    writeArticle(root, rel, 'en', unrelated, { body1: 'Only one translated field' });
  }

  const full = inspectBlogLocaleCompleteness({ root, minItalianFiles: 1, minItalianFields: 1 });
  assert.equal(full.ok, false, 'il corpus completo deve vedere il residuo preesistente');

  const changedPaths = BODY_ROOTS.map(({ rel }) => `${rel}/en/${target}.ts`);
  const scoped = inspectBlogLocaleCompleteness({
    root,
    minItalianFiles: 1,
    minItalianFields: 1,
    changedPaths,
  });
  assert.equal(scoped.ok, true, 'il writer deve verificare il target senza ereditare il residuo');
  assert.equal(scoped.scoped, true);
  assert.deepEqual(scoped.violations, []);

  writeArticle(root, BODY_ROOTS[0].rel, 'de', target, { body1: 'Nur ein Feld' });
  const targetBroken = inspectBlogLocaleCompleteness({
    root,
    minItalianFiles: 1,
    minItalianFields: 1,
    changedPaths: [changedPaths[0]],
  });
  assert.equal(targetBroken.ok, false, 'lo scope non deve nascondere un locale del target rotto');
  assert.ok(targetBroken.violations.some((violation) => violation.code === 'missing-key'));
});

test('publish-api espone il gate di completezza prima delle credenziali', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish-api.yml'), 'utf8');
  const gate = workflow.indexOf('check-blog-locale-completeness.mjs');
  const credentials = workflow.indexOf('Prepare Firebase credentials');
  assert.ok(gate >= 0, 'publish-api non richiama il gate FU-009');
  assert.ok(gate < credentials, 'il gate FU-009 deve precedere le credenziali di produzione');
});

test('i writer scansionano il delta dei body e publish-api conserva il gate globale', () => {
  const writerFiles = [
    'generate-article-core.yml',
    'generate-article.yml',
    'generate-border-wait-ranking-weekly.yml',
    'generate-daily-brief.yml',
    'publish-journalist-articles.yml',
    'refresh-events-digest.yml',
  ];
  for (const file of writerFiles) {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
    const calls = workflow.match(/node scripts\/ci\/check-blog-locale-completeness\.mjs[^\n]*/g) ?? [];
    assert.ok(calls.length > 0, `${file}: manca la guardia FU-009`);
    assert.ok(calls.every((call) => call.includes('--changed-paths')), `${file}: guardia non scoped`);
    if (file === 'generate-article.yml' || file === 'generate-article-core.yml') {
      assert.ok(calls.every((call) => call.includes('--redact-paths')), `${file}: path non redatti nei log pubblici`);
    }
  }

  const publishApi = fs.readFileSync(path.join(ROOT, '.github/workflows/publish-api.yml'), 'utf8');
  assert.match(publishApi, /run: node scripts\/ci\/check-blog-locale-completeness\.mjs\n/);
  assert.doesNotMatch(publishApi, /check-blog-locale-completeness\.mjs --changed-paths/);
});
