import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  endsWithSentenceAbbreviation,
  isFinalTerminatorOnlyChange,
  minimumDescriptionLength,
} from '../scripts/lib/article-excerpt.mjs';
import { inspectCorpusExcerptCompleteness } from '../scripts/repair-plain-excerpts.mjs';
import {
  assertNoExcerptCompletenessRegression,
  evaluateExcerptCompleteness,
  excerptCompletenessKey,
} from '../../scripts/lib/excerpt-completeness-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE_PATH = path.join(ROOT, 'scripts/ci/excerpt-completeness-baseline.json');
const INITIAL_BASELINE_SHA256 = 'fa922020f7e521d063f40199b992eef07fe2d9431ba4080c621793d678c91249';

function readBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

let cachedCorpusReport;
function corpusReport() {
  cachedCorpusReport ??= inspectCorpusExcerptCompleteness();
  return cachedCorpusReport;
}

test('il corpus applica le riparazioni a/b/d e lascia invariati i soli casi c', () => {
  const report = corpusReport();
  assert.ok(report.files >= 100, `il controllo deve coprire i chunk meta e SEO: ${report.files}`);
  assert.equal(report.changedValues, 0, JSON.stringify(report.details.slice(0, 20), null, 2));
  assert.equal(report.needsRepairValues, report.byStrategy.c);
  assert.ok(report.nonRepairable.every((item) => item.before === item.after));
  assert.ok(report.randomSamples.every((item) => item.strategy === 'c'));
  assert.equal(report.functionWordPeriodViolations, 0);
  assert.equal(report.minimumLengthViolations, 0);
  assert.equal(report.abbreviationEndingViolations, 0);
  assert.equal(report.details.some((item) => (
    item.file === 'content/seo/seo-blog-5.ts'
    && item.id === 'cavalcavia-boesio-chiusura-lavori-2026'
    && item.field === 'ogDescription'
  )), false, 'il numero civico italiano terminale è una frase completa');
  assert.equal(report.dPunctuationOnlyViolations, 0);
  assert.ok(report.details.filter((item) => item.strategy === 'd').every((item) => (
    item.defects.length === 1
    && item.defects[0] === 'missing-final-terminator'
    && isFinalTerminatorOnlyChange(item.before, item.after)
  )));
});

test('le sostituzioni testuali rispettano la soglia e i valori non terminano con un’abbreviazione', () => {
  const report = corpusReport();
  const invalid = report.details.filter((item) => {
    const value = item.after.trim();
    const repairedFromText = item.strategy === 'a' || item.strategy === 'b';
    const repaired = repairedFromText || item.strategy === 'd';
    return (repairedFromText && value.length < minimumDescriptionLength(item.field))
      || (repaired && endsWithSentenceAbbreviation(value, { locale: item.locale }));
  });
  assert.deepEqual(invalid.map(({ file, id, field, after }) => ({ file, id, field, after })), []);
});

test('build-api controlla la completezza prima di cancellare la superficie pubblica', () => {
  const source = readFileSync(path.join(ROOT, 'scripts/build-api.mjs'), 'utf8');
  const check = source.indexOf('inspectCorpusExcerptCompleteness()');
  const deletion = source.indexOf('fs.rmSync(OUT');
  assert.ok(check >= 0, 'build-api deve eseguire il preflight di completezza');
  assert.ok(deletion > check, 'il preflight deve avvenire prima di cancellare dist/api');
  assert.match(source, /excerpt-completeness-baseline\.json/u);
  assert.match(source, /assertNoExcerptCompletenessRegression/u);

  const generator = readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');
  const register = generator.indexOf('export async function registerArticleFiles(data, opts = {})');
  const repair = generator.indexOf('repairGeneratedArticleDescriptions(data);', register);
  const nextWritePreparation = generator.indexOf('const slugs = deriveAndSanitizeArticleSlugs(data);', register);
  assert.ok(register >= 0 && repair > register, 'il generatore deve riparare ogni articolo nel writer condiviso');
  assert.ok(nextWritePreparation > repair, 'il controllo deve precedere la registrazione dei file');

  const primaryRepair = generator.indexOf('const excerptRepairs = repairGeneratedArticleDescriptions(data);');
  const primaryWrite = generator.indexOf('modifyRouterTs(data);', primaryRepair);
  assert.ok(primaryRepair >= 0, 'il percorso AI principale deve riparare i propri articoli');
  assert.ok(primaryWrite > primaryRepair, 'il controllo deve precedere anche la prima scrittura del percorso principale');
});

test('il prompt excerpt richiede una frase completa e il fallback pesca dal body', () => {
  const generator = readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');
  const start = generator.indexOf('async function generateExcerpt(');
  const end = generator.indexOf('\n}\n', start);
  const source = generator.slice(start, end);
  assert.match(source, /una frase completa con terminatore finale/u);
  assert.match(source, /Non concatenare bullet o key facts/u);
  assert.match(source, /firstCompleteBodyExcerpt\(body/u);
});

test('build-api accetta i casi nel baseline e rifiuta un nuovo campo incompleto', () => {
  const report = corpusReport();
  const result = assertNoExcerptCompletenessRegression(report.details, readBaseline());
  assert.equal(result.known.length, readBaseline().entries.length);
  assert.deepEqual(result.regressions, []);

  const regression = {
    file: 'content/blog-meta-it.ts',
    locale: 'it',
    id: 'nuovo-articolo-test',
    field: 'excerpt',
    strategy: 'c',
    defects: ['dangling-clause'],
  };
  assert.throws(
    () => assertNoExcerptCompletenessRegression([...report.details, regression], readBaseline()),
    /outside the approved baseline/u,
  );
});

test('la chiave baseline distingue occorrenze dello stesso campo su superfici diverse', () => {
  const meta = { file: 'content/blog-meta-it.ts', locale: 'it', id: 'stesso-articolo', field: 'description' };
  const seo = { file: 'content/seo/seo-blog.ts', locale: 'it', id: 'stesso-articolo', field: 'description' };
  assert.notEqual(excerptCompletenessKey(meta), excerptCompletenessKey(seo));
  const result = evaluateExcerptCompleteness([
    { ...meta, strategy: 'c' },
    { ...seo, strategy: 'c' },
  ], { entries: [meta, seo] });
  assert.equal(result.known.length, 2);
  assert.deepEqual(result.regressions, []);
});

test('il baseline è monotono: ogni chiave attiva appartiene al tetto iniziale e i casi riparati si rimuovono', () => {
  const baseline = readBaseline();
  const report = corpusReport();
  const initialHash = createHash('sha256').update(JSON.stringify(baseline.initialEntries)).digest('hex');
  assert.equal(baseline.version, 2, 'il formato versionato distingue le chiavi per superficie');
  assert.equal(initialHash, INITIAL_BASELINE_SHA256, 'il tetto iniziale non si può ampliare');
  assert.ok(baseline.initialEntries.every((entry) => typeof entry.file === 'string'), 'il baseline usa chiavi per superficie');

  const initialKeys = new Set(baseline.initialEntries.map(excerptCompletenessKey));
  const activeKeys = new Set(baseline.entries.map(excerptCompletenessKey));
  assert.ok([...activeKeys].every((key) => initialKeys.has(key)), 'il baseline attivo deve essere sottoinsieme del tetto iniziale');

  const currentKeys = new Set(report.nonRepairable.map(excerptCompletenessKey));
  assert.deepEqual([...activeKeys].sort(), [...currentKeys].sort(), 'rimuovere dal baseline ogni caso ormai riparato');

  const repairedKey = baseline.entries[0] && excerptCompletenessKey(baseline.entries[0]);
  const withoutRepairedCase = report.details.filter((item) => excerptCompletenessKey(item) !== repairedKey);
  const beforeRemoval = evaluateExcerptCompleteness(withoutRepairedCase, baseline);
  assert.deepEqual(beforeRemoval.resolved, [repairedKey], 'il caso riparato resta segnalato finché non viene tolto');
  const reducedBaseline = {
    ...baseline,
    entries: baseline.entries.filter((item) => excerptCompletenessKey(item) !== repairedKey),
  };
  const afterRemoval = assertNoExcerptCompletenessRegression(withoutRepairedCase, reducedBaseline);
  assert.equal(afterRemoval.known.length, reducedBaseline.entries.length);
  assert.deepEqual(afterRemoval.resolved, []);
});
