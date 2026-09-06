/**
 * key-facts-specificity.test.mjs — il guard sui FATTI CHIAVE VUOTI (issue #949).
 *
 * Non legge `content/`: e' un test sulla REGOLA, non sul corpus, quindi non
 * appartiene a `CONTENT_GATES`. La misura sul corpus la fa
 * `generator/scripts/scan-vacuous-key-facts.mjs`, che e' uno script.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchesVacuousValue,
  factValueOf,
  findVacuousFacts,
  stripVacuousFacts,
  parseAiSearchSections,
  MIN_FACTS_PER_SECTION,
} from '../scripts/lib/key-facts-specificity.mjs';
import {
  AI_SEARCH_SECTION_HEADINGS,
  AI_SEARCH_PROMPT_BLOCK_IT,
  buildAiSearchMarkdown,
  validateBackfillPayload,
} from '../scripts/lib/ai-search-template.mjs';
import { sanitizePromptPlaceholders } from '../scripts/lib/prompt-placeholder-guard.mjs';

test('il non-valore si riconosce nelle quattro locali, ancorato sul valore intero', () => {
  for (const v of [
    'Non specificato.',
    'non ancora specificato',
    'Non specificato',
    'Da definire',
    'N/D',
    'Not specified',
    'Not yet specified',
    'Noch nicht spezifiziert',
    'Nicht angegeben',
    'Keine Angaben',
    'Non spécifié.',
    'Non encore précisé',
    'n/a',
  ]) {
    assert.equal(matchesVacuousValue(v), true, `atteso vuoto: ${v}`);
  }
});

test('un fatto VERO che contiene la stessa frase non e\' un non-valore', () => {
  // E' l'ancoraggio a fare il lavoro: senza, ognuna di queste sarebbe rigettata.
  for (const v of [
    "Il servizio non e' disponibile il sabato",
    'CHF 200-300 al mese per un bambino',
    '150 CHF/mese',
    'Cantone di Zugo',
    'Lo sportello non e\' disponibile allo sportello di Bellinzona ma solo online',
  ]) {
    assert.equal(matchesVacuousValue(v), false, `atteso VERO: ${v}`);
  }
});

test('il valore e\' cio\' che segue l\'ULTIMO due punti', () => {
  assert.equal(factValueOf('- **Chi**: Ente competente: non specificato.'), 'non specificato.');
  assert.equal(factValueOf('- **Dove**: Cantone di Zugo'), 'Cantone di Zugo');
  // Senza due punti il bullet non e' una coppia: il valore e' il bullet intero.
  assert.equal(factValueOf('- Gli importi non sono ancora specificati'), 'Gli importi non sono ancora specificati');
});

test('le due forme si distinguono: valore-segnaposto vs non-valore annegato nella prosa', () => {
  const body = [
    '## Fatti chiave',
    '- **Cosa**: borsa di studio cantonale.',
    '- Quando: Non specificato.',
    '- Dove: Cantone di Sciaffusa.',
    '- Chi: Ufficio delle borse di studio.',
    '- Importo: Gli importi massimi non sono ancora specificati',
    '',
    'Il Cantone di Sciaffusa apre le domande.',
  ].join('\n');
  const hits = findVacuousFacts(body);
  const kinds = hits.map((h) => h.kind);
  assert.deepEqual(kinds.sort(), ['hedged-prose', 'placeholder-value']);
});

test('la riparazione toglie la coppia vuota e lascia intatte le altre', () => {
  const body = [
    '## Fatti chiave',
    '- **Cosa**: assegno familiare.',
    '- Quando: non specificato.',
    '- Dove: Cantone di Zugo.',
    '- Chi: cittadini residenti.',
    '- Importo: CHF 200-300 al mese.',
    '',
    'Nel Cantone di Zugo gli assegni familiari sostengono le famiglie.',
  ].join('\n');
  const out = stripVacuousFacts(body);
  assert.equal(out.changed, true);
  assert.deepEqual(out.dropped, ['- Quando: non specificato.']);
  assert.deepEqual(out.sectionsRemoved, []);
  assert.ok(!out.value.includes('non specificato'));
  assert.ok(out.value.includes('- **Cosa**: assegno familiare.'));
  assert.ok(out.value.includes('Nel Cantone di Zugo gli assegni familiari sostengono le famiglie.'));
});

test('sotto la soglia la sezione se ne va INTERA, ma il lead giornalistico resta', () => {
  // La regressione che questo test chiude: la sezione arriva fino alla prossima
  // intestazione, e fra l'ultimo bullet e quell'intestazione c'e' l'articolo.
  const lead = 'Il Cantone di Sciaffusa offre borse di studio agli apprendisti.';
  const body = [
    '## Fatti chiave',
    '- **Cosa**: Borse di studio.',
    '- Quando: Non specificato.',
    '- Dove: Non specificato.',
    '- Importo: Non specificato.',
    '',
    lead,
    '',
    '### Requisiti',
    'Occorre la residenza nel Cantone.',
  ].join('\n');
  const out = stripVacuousFacts(body);
  assert.deepEqual(out.sectionsRemoved, ['## Fatti chiave']);
  assert.ok(!out.value.includes('## Fatti chiave'));
  assert.ok(out.value.includes(lead), 'il lead e\' stato inghiottito dal taglio della sezione');
  assert.ok(out.value.includes('### Requisiti'));
  assert.ok(out.value.includes('Occorre la residenza nel Cantone.'));
});

test('i bullet sulla STESSA riga si separano lo stesso: il separatore e\' il marcatore, non l\'a capo', () => {
  const body =
    '## Fatti chiave\n* **Cosa**: Borse di studio. * Quando: Non specificato. * Dove: Sciaffusa. * Chi: Cantone. * Importo: CHF 10.000.\n\nIl Cantone apre le domande.';
  const sections = parseAiSearchSections(body);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].bullets.length, 5);
  const out = stripVacuousFacts(body);
  assert.deepEqual(out.dropped, ['* Quando: Non specificato.']);
  assert.ok(out.value.includes('Il Cantone apre le domande.'));
  assert.ok(out.value.includes('* Importo: CHF 10.000.'));
});

test('un corpo senza sezioni AI-search non viene toccato', () => {
  const body = 'Il Cantone di Zugo non ha ancora specificato la data.\n\n### Dettagli\nTesto.';
  const out = stripVacuousFacts(body);
  assert.equal(out.changed, false);
  assert.equal(out.value, body);
});

test('ogni intestazione che il serializzatore emette e\' riconosciuta dal rilevatore', () => {
  // UNA sola sorgente per le intestazioni: se `ai-search-template.mjs` ne
  // aggiunge una, questo test diventa rosso invece del corpus fra tre giorni.
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const md = buildAiSearchMarkdown({
      tldr: ['bullet uno', 'bullet due', 'bullet tre'],
      keyFacts: [
        { term: 'Cosa', value: 'un fatto' },
        { term: 'Quando', value: 'Non specificato' },
        { term: 'Dove', value: 'Lugano' },
        { term: 'Chi', value: 'il Cantone' },
      ],
      locale,
    });
    const sections = parseAiSearchSections(md);
    assert.equal(sections.length, 2, `locale ${locale}: sezioni non riconosciute`);
    for (const s of sections) assert.ok(AI_SEARCH_SECTION_HEADINGS.includes(s.heading));
    const out = stripVacuousFacts(md);
    assert.equal(out.changed, true, `locale ${locale}: la coppia vuota e' sopravvissuta`);
  }
});

test('il percorso di scrittura condiviso pota i body, in ogni locale', () => {
  const withVacuous = (extra) =>
    [
      '## Fatti chiave',
      '- **Cosa**: permesso G.',
      `- Quando: ${extra}`,
      '- Dove: Ticino.',
      '- Chi: Ufficio della migrazione.',
      '- Importo: CHF 0.',
      '',
      'Il permesso G si rinnova ogni anno.',
    ].join('\n');
  const data = {
    id: 'permesso-g-rinnovo',
    content: {
      it: { title: 'Permesso G', body1: withVacuous('Non specificato.') },
      de: { title: 'Bewilligung G', body1: withVacuous('Noch nicht spezifiziert') },
    },
  };
  const fixes = sanitizePromptPlaceholders(data);
  const pruned = fixes.filter((f) => f.action === 'vacuous-facts-pruned').map((f) => f.path);
  assert.deepEqual(pruned.sort(), ['content.de.body1', 'content.it.body1']);
  for (const locale of ['it', 'de']) {
    assert.ok(!/specificat|spezifiziert/i.test(data.content[locale].body1));
    assert.ok(data.content[locale].body1.includes('Il permesso G si rinnova ogni anno.'));
  }
});

test('il backfill scarta i non-valori PRIMA delle soglie, quindi un payload vuoto FALLISCE', () => {
  const ok = validateBackfillPayload({
    tldr: ['Il Cantone apre le domande', 'Le borse valgono CHF 10.000'],
    keyFacts: [
      { term: 'Cosa', value: 'Borse di studio' },
      { term: 'Quando', value: 'Non specificato' },
      { term: 'Dove', value: 'Sciaffusa' },
      { term: 'Chi', value: 'Cantone' },
      { term: 'Importo', value: 'CHF 10.000' },
    ],
  });
  assert.equal(ok.keyFacts.length, 4);
  assert.ok(!ok.keyFacts.some((kf) => matchesVacuousValue(kf.value)));

  assert.throws(
    () =>
      validateBackfillPayload({
        tldr: ['Il Cantone apre le domande', 'Le borse valgono CHF 10.000'],
        keyFacts: [
          { term: 'Cosa', value: 'Borse di studio' },
          { term: 'Quando', value: 'Non specificato' },
          { term: 'Dove', value: 'Non specificato' },
          { term: 'Importo', value: 'Non specificato' },
        ],
      }),
    /keyFacts must be an array of 3-12 entries/,
  );
});

test('il PROMPT dice di omettere la riga: e\' la meta\' che impedisce al difetto di nascere', () => {
  assert.match(AI_SEARCH_PROMPT_BLOCK_IT, /OMETTI la riga/);
  assert.match(AI_SEARCH_PROMPT_BLOCK_IT, /non specificato/i);
  assert.ok(MIN_FACTS_PER_SECTION >= 3);
});
