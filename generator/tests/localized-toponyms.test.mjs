import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCALIZED_TOPONYM_LOCALES,
  LOCALIZED_TOPONYMS,
  findLocalizedToponymMismatches,
  replaceLocalizedToponymMismatches,
  validateLocalizedToponymTable,
} from '../scripts/lib/localized-toponyms.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('la tabella copre 26 cantoni, capoluoghi e tutte le quattro lingue', () => {
  assert.deepEqual(LOCALIZED_TOPONYM_LOCALES, ['it', 'en', 'de', 'fr']);
  assert.equal(LOCALIZED_TOPONYMS.length, 26);
  assert.deepEqual(validateLocalizedToponymTable(), []);
  for (const entity of LOCALIZED_TOPONYMS) {
    assert.equal(Object.keys(entity.canton).length, 4, `${entity.code}: cantone incompleto`);
    assert.equal(Object.keys(entity.capital).length, 4, `${entity.code}: capoluogo incompleto`);
  }
});

test('la tabella canonica conserva gli esonimi richiesti', () => {
  const byCode = new Map(LOCALIZED_TOPONYMS.map((entity) => [entity.code, entity]));
  assert.deepEqual(byCode.get('LU').canton, {
    it: ['Lucerna'], en: ['Lucerne'], de: ['Luzern'], fr: ['Lucerne'],
  });
  assert.deepEqual(byCode.get('GE').canton, {
    it: ['Ginevra'], en: ['Geneva'], de: ['Genf'], fr: ['Genève'],
  });
  assert.deepEqual(byCode.get('ZH').canton, {
    it: ['Zurigo'], en: ['Zurich'], de: ['Zürich'], fr: ['Zurich'],
  });
  assert.deepEqual(byCode.get('BE').capital, {
    it: ['Berna'], en: ['Bern'], de: ['Bern'], fr: ['Berne'],
  });
  assert.deepEqual(byCode.get('BS').canton, {
    it: ['Basilea Città'], en: ['Basel-Stadt'], de: ['Basel-Stadt'], fr: ['Bâle-Ville'],
  });
  assert.deepEqual(byCode.get('GR').canton, {
    it: ['Grigioni'], en: ['Graubünden'], de: ['Graubünden'], fr: ['Grisons'],
  });
  assert.deepEqual(byCode.get('VS').canton, {
    it: ['Vallese'], en: ['Valais'], de: ['Wallis'], fr: ['Valais'],
  });
  assert.deepEqual(byCode.get('FR').canton, {
    it: ['Friburgo'], en: ['Fribourg'], de: ['Freiburg'], fr: ['Fribourg'],
  });
  assert.deepEqual(byCode.get('SG').canton, {
    it: ['San Gallo'], en: ['St. Gallen'], de: ['St. Gallen'], fr: ['Saint-Gall'],
  });
});

test('rileva un esonimo copiato e accetta la forma giusta', () => {
  const source = 'La partita si gioca a Lucerna e coinvolge il cantone di Lucerna.';
  assert.deepEqual(
    findLocalizedToponymMismatches({ sourceText: source, targetText: 'Fans in Lucerna', locale: 'en' }),
    [{ code: 'LU', type: 'canton', locale: 'en', form: 'Lucerna', expected: 'Lucerne' }],
  );
  assert.deepEqual(
    findLocalizedToponymMismatches({ sourceText: source, targetText: 'Fans in Lucerne', locale: 'en' }),
    [],
  );
  assert.deepEqual(
    findLocalizedToponymMismatches({ sourceText: 'Berna e Zurigo', targetText: 'Bern und Zürich', locale: 'de' }),
    [],
  );
  assert.deepEqual(
    findLocalizedToponymMismatches({ sourceText: 'Berna e Zurigo', targetText: 'Bern et Zurigo', locale: 'fr' }),
    [
      { code: 'BE', type: 'canton', locale: 'fr', form: 'Bern', expected: 'Berne' },
      { code: 'ZH', type: 'canton', locale: 'fr', form: 'Zurigo', expected: 'Zurich' },
    ],
  );
});

test('non confonde una citazione URL o una parola fuori dall articolo', () => {
  assert.deepEqual(
    findLocalizedToponymMismatches({
      sourceText: 'Partita a Lucerna',
      targetText: 'Partita a Lucerne (https://example.test/lucerna-lugano)',
      locale: 'en',
    }),
    [],
  );
  assert.deepEqual(
    findLocalizedToponymMismatches({ sourceText: 'Una notizia sul Ticino', targetText: 'Eine Nachricht über Basel', locale: 'de' }),
    [],
  );
});

test('la riparazione deterministica non riscrive gli URL', () => {
  const result = replaceLocalizedToponymMismatches({
    sourceText: 'Notizia sul cantone di Lucerna',
    targetText: 'News from Lucerna: https://example.test/lucerna-lugano',
    locale: 'en',
  });
  assert.equal(result.text, 'News from Lucerne: https://example.test/lucerna-lugano');
  assert.equal(result.replacements, 1);
});

test('non riscrive brand o nomi ufficiali che contengono un toponimo', () => {
  const source = 'Il servizio opera nel Canton Ticino e cita Argovia.';
  assert.deepEqual(
    findLocalizedToponymMismatches({
      sourceText: source,
      targetText: 'Use Frontaliere Ticino, SVA Aargau and Ticino Turismo: Canton Ticino.',
      locale: 'de',
    }),
    [{ code: 'TI', type: 'canton', locale: 'de', form: 'Ticino', expected: 'Tessin' }],
  );
  const result = replaceLocalizedToponymMismatches({
    sourceText: source,
    targetText: 'Use Frontaliere Ticino, SVA Aargau and Ticino Turismo: Canton Ticino.',
    locale: 'de',
  });
  assert.equal(result.text, 'Use Frontaliere Ticino, SVA Aargau and Ticino Turismo: Canton Tessin.');
  assert.deepEqual(
    findLocalizedToponymMismatches({
      sourceText: 'Il cantone di Ticino ospita Caritas Ticino e BancaStato Ticino.',
      targetText: 'Der Kanton Ticino, Caritas Ticino, BancaStato Ticino und Ticino 2020.',
      locale: 'de',
    }),
    [{ code: 'TI', type: 'canton', locale: 'de', form: 'Ticino', expected: 'Tessin' }],
  );
});

const ENTRY_RE = /['"]blog\.article\.([^'"]+)\.([^'"]+)['"]\s*:\s*(['"])((?:\\.|(?!\3)[^\r\n])*?)\3\s*(?=[,}])/gu;

function unescapeTsValue(value) {
  return value.replace(/\\([\\'"\\\\])/gu, '$1');
}

function walkTypeScriptFiles(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walkTypeScriptFiles(file, output);
    else if (entry.isFile() && file.endsWith('.ts')) output.push(file);
  }
  return output;
}

function corpusLocale(file) {
  const basename = path.basename(file);
  const metaLocale = basename.match(/-(it|en|de|fr)\.ts$/u)?.[1];
  if (metaLocale) return metaLocale;
  const parts = file.split(path.sep).reverse();
  return parts.find((part) => LOCALIZED_TOPONYM_LOCALES.includes(part)) || null;
}

function corpusFiles() {
  return walkTypeScriptFiles(path.join(ROOT, 'content')).filter((file) => {
    const relative = path.relative(ROOT, file);
    return relative.split(path.sep).some((part) => part.startsWith('blog-body'))
      || /^content\/blog-meta(?:-canton-[^-]+|-ch)?-(?:it|en|de|fr)\.ts$/u.test(relative);
  });
}

function collectCorpusEntries() {
  const byLocale = new Map(LOCALIZED_TOPONYM_LOCALES.map((locale) => [locale, new Map()]));
  for (const file of corpusFiles()) {
    const locale = corpusLocale(file);
    if (!locale) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(ENTRY_RE)) {
      const key = `${match[1]}|${match[2]}`;
      const entries = byLocale.get(locale).get(key) || [];
      entries.push({ key, field: match[2], value: unescapeTsValue(match[4]), file });
      byLocale.get(locale).set(key, entries);
    }
  }
  return byLocale;
}

test('il corpus storico e le 24 sezioni cantonali non copiano esonimi fra lingue', () => {
  const byLocale = collectCorpusEntries();
  const italian = byLocale.get('it');
  assert.ok(italian.size >= 5000, `corpus italiano incompleto: ${italian.size} campi`);
  for (const locale of ['en', 'de', 'fr']) {
    assert.ok(byLocale.get(locale).size >= 5000, `corpus ${locale} incompleto: ${byLocale.get(locale).size} campi`);
  }

  let offenderCount = 0;
  const sampleOffenders = [];
  for (const [key, sourceEntries] of italian) {
    const sourceValues = [...new Set(sourceEntries.map((entry) => entry.value))];
    for (const locale of ['en', 'de', 'fr']) {
      for (const targetEntry of byLocale.get(locale).get(key) || []) {
        const issues = sourceValues.flatMap((sourceText) => findLocalizedToponymMismatches({
          sourceText,
          targetText: targetEntry.value,
          locale,
        }));
        const uniqueIssues = new Map(issues.map((issue) => [
          `${issue.code}|${issue.locale}|${issue.form}|${issue.expected}`,
          issue,
        ]));
        for (const issue of uniqueIssues.values()) {
          offenderCount += 1;
          if (sampleOffenders.length < 80) {
            sampleOffenders.push({ ...issue, key, file: path.relative(ROOT, targetEntry.file) });
          }
        }
      }
    }
  }

  assert.equal(offenderCount, 0, [
    `esonimi errati: ${offenderCount}`,
    ...sampleOffenders.map((issue) => `${issue.locale} ${issue.code}.${issue.type} ${issue.form}→${issue.expected} ${issue.key} (${issue.file})`),
  ].join('\n'));
});

test('il gate di generazione importa e invoca il controllo prima della scrittura', () => {
  const source = readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');
  assert.match(source, /findArticleLocalizedToponymMismatches/);
  assert.match(source, /assertArticlePassesFactualityGates\(data, options = \{\}\)/);
  assert.match(source, /assertLocalizedToponyms\(data\)/);
  const gatePosition = source.indexOf('assertLocalizedToponyms(data)');
  const lockPosition = source.indexOf('beginRegisterLock(data.id)', gatePosition);
  assert.ok(gatePosition >= 0 && lockPosition > gatePosition, 'il gate deve precedere il lock di registrazione');

  const workflow = readFileSync(path.join(ROOT, '.github/workflows/generate-article.yml'), 'utf8');
  assert.match(workflow, /generator\/tests\/wrong-latin-language-adoption\.test\.mjs/);
  assert.match(workflow, /generator\/tests\/localized-toponyms\.test\.mjs/);
});
