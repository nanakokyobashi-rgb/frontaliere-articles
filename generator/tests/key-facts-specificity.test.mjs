/**
 * Test della misura #1054 e della regola pura usata dal gate #1055.
 *
 * Il test non importa create-article.mjs: l'entry point inizializza rete e
 * dipendenze del generatore. Il wiring viene comunque pin-nato con un controllo
 * statico, mentre il comportamento e' provato sul modulo senza effetti.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findReferenceVacuousFacts,
  findVacuousFacts,
  factValueOf,
  matchesVacuousValue,
  parseAiSearchSections,
  stripVacuousFacts,
} from '../scripts/lib/key-facts-specificity.mjs';
import { buildAiSearchMarkdown, getKeyFactsHeading } from '../scripts/lib/ai-search-template.mjs';
import { scanCorpus, unescapeTs } from '../scripts/scan-vacuous-key-facts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CREATE_ARTICLE_PATH = path.join(ROOT, 'generator/scripts/create-article.mjs');
const CONTENT_PATH = path.join(ROOT, 'content');

test('il gate riconosce il non-valore nelle quattro lingue', () => {
  for (const value of [
    'non specificato',
    'not specified',
    'nicht angegeben',
    'non spécifié',
    'Non specificato.',
    'Not yet specified',
    'Noch nicht spezifiziert',
    'Non encore précisé.',
  ]) {
    assert.equal(matchesVacuousValue(value), true, `valore non riconosciuto: ${value}`);
  }
});

test('un valore breve ma specifico non viene contato', () => {
  for (const value of [
    '3 marzo 2026',
    'Cantone di Zugo',
    'CHF 200-300 al mese',
    "Il servizio non e' disponibile il sabato",
  ]) {
    assert.equal(matchesVacuousValue(value), false, `falso positivo: ${value}`);
  }
});

test('la prosa prudenziale viene osservata ma non potata', () => {
  const body = [
    '## Fatti chiave',
    '- Cosa: borse di studio.',
    '- Importo: Gli importi massimi non sono ancora specificati.',
    '- Dove: Cantone di Sciaffusa.',
  ].join('\n');
  const hits = findVacuousFacts(body);
  assert.deepEqual(hits.map((hit) => hit.kind), ['hedged-prose']);
  const result = stripVacuousFacts(body);
  assert.equal(result.changed, false);
  assert.deepEqual(result.residual.map((hit) => hit.kind), ['hedged-prose']);
});

test('la forma di riferimento dell issue conta quattro varianti e non i fatti specifici', () => {
  const body = [
    '- Quando: non specificato',
    '- When: not specified',
    '- Wann: nicht angegeben',
    '- Quand: non spécifié',
    '- Dove: 3 marzo 2026',
  ].join('\n');
  assert.equal(findReferenceVacuousFacts(body).length, 4);
  assert.equal(findReferenceVacuousFacts('- Quando: 3 marzo 2026').length, 0);
});

test('il valore di un fatto e\' cio\' che segue l ultimo due punti', () => {
  assert.equal(factValueOf('- **Chi**: Ente competente: non specificato.'), 'non specificato.');
  assert.equal(factValueOf('- **Dove**: Cantone di Zugo'), 'Cantone di Zugo');
});

test('lo scanner decodifica gli escape Unicode e hexadecimal dei literal TS', () => {
  assert.equal(unescapeTs('\\u0043ittino \\x2d \\u{1F30D}'), 'Cittino - 🌍');
});

test('le intestazioni emesse dal serializzatore sono tutte leggibili', () => {
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const markdown = buildAiSearchMarkdown({
      tldr: ['Un fatto', 'Un altro fatto'],
      keyFacts: [
        { term: 'Cosa', value: 'un fatto' },
        { term: 'Quando', value: 'non specificato' },
        { term: 'Dove', value: 'un luogo' },
      ],
      locale,
    });
    const sections = parseAiSearchSections(markdown);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, getKeyFactsHeading(locale));
    assert.equal(findVacuousFacts(markdown).length, 1);
  }
});

test('con almeno tre superstiti il fatto vuoto viene rimosso', () => {
  const body = [
    '## Fatti chiave',
    '- **Cosa**: assegno familiare.',
    '- Quando: non specificato.',
    '- Dove: Cantone di Zugo.',
    '- **Chi**: cittadini residenti.',
    '- Importo: CHF 200-300 al mese.',
    '',
    'Il Cantone di Zugo sostiene le famiglie.',
  ].join('\n');
  const result = stripVacuousFacts(body);
  assert.equal(result.rejected, false);
  assert.equal(result.changed, true);
  assert.deepEqual(result.dropped, ['- Quando: non specificato.']);
  assert.ok(!result.value.includes('non specificato'));
  assert.ok(result.value.includes('Il Cantone di Zugo sostiene le famiglie.'));
});

test('sotto la soglia il payload viene rifiutato e resta immutato', () => {
  const body = [
    '## Fatti chiave',
    '- **Cosa**: assegno familiare.',
    '- Quando: non specificato.',
    '- Dove: Cantone di Zugo.',
    '',
    'Il Cantone di Zugo sostiene le famiglie.',
  ].join('\n');
  const result = stripVacuousFacts(body);
  assert.equal(result.rejected, true);
  assert.deepEqual(result.rejectedSections, ['## Fatti chiave']);
  assert.equal(result.changed, false);
  assert.equal(result.value, body);
});

test('i bullet sulla stessa riga non fanno perdere il conteggio', () => {
  const body = '## Fatti chiave\n* **Cosa**: Borsa * Quando: non specificato * Dove: Zugo * Chi: Cantone * Importo: CHF 10.';
  const result = stripVacuousFacts(body);
  assert.equal(result.rejected, false);
  assert.deepEqual(result.dropped, ['* Quando: non specificato']);
  assert.ok(result.value.includes('* Dove: Zugo'));
});

test('lo scanner riproduce la baseline corrente senza fatti vacui', { skip: !fs.existsSync(CONTENT_PATH) }, () => {
  const report = scanCorpus(ROOT);
  assert.equal(report.files.length, 0);
  assert.equal(report.articles.length, 0);
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.byLocale).map(([locale, value]) => [locale, value.files.length])),
    { it: 0, en: 0, de: 0, fr: 0 },
  );
});

test('create-article applica il gate dopo validate e marca il rifiuto come qualita\'', () => {
  const source = fs.readFileSync(CREATE_ARTICLE_PATH, 'utf8');
  assert.match(source, /from ['"]\.\/lib\/key-facts-specificity\.mjs['"]/);
  assert.match(source, /from ['"]\.\/lib\/cantone-toponimi-coerenza\.mjs['"]/);
  assert.match(source, /function qualityRejectError\([\s\S]*?error\.qualityReject = true/);
  const validated = source.indexOf('data = validate(rawData');
  const gate = source.indexOf('assertGeneratedArticleQuality(data);', validated);
  assert.ok(validated >= 0 && gate > validated, 'il gate non e\' nel percorso post-validate');
  assert.ok(
    (source.match(/^\s*assertGeneratedArticleQuality\(data(?:,|\);)/gm) || []).length >= 3,
    'il gate non copre il percorso primario e quello di scrittura condiviso',
  );
  const translatedGate = source.indexOf(
    'assertGeneratedArticleQuality(data);',
    source.indexOf('// Step 3a.1: Reject/repair prompt-schema placeholders'),
  );
  const cta = source.indexOf('validateAndEnforceCTA(data);');
  assert.ok(translatedGate > -1 && translatedGate < cta, 'il guard post-traduzione deve precedere l\'iniezione CTA');
  const registrar = source.indexOf('export async function registerArticleFiles');
  const registrarCantonGate = source.indexOf('cantonBody: data._cantonGuardBodyBeforeCta', registrar);
  assert.ok(registrar > -1 && registrarCantonGate > registrar, 'il registrar deve riusare il body cantonale pre-CTA');
  assert.match(source, /data\._cantonGuardBodyBeforeCta = bodyTextForQuality\(contentIt\)/);
});
