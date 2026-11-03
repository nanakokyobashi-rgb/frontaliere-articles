import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPlainExcerpt,
  assertPlainDescriptionFields,
  endsWithFunctionWordBeforePeriod,
  endsWithSentenceAbbreviation,
  findExcerptCompletenessDefects,
  findExcerptMarkdownDefects,
  firstCompleteBodyExcerpt,
  findDescriptionDefects,
  maximumDescriptionLength,
  minimumDescriptionLength,
  normalizeExcerpt,
  repairGeneratedArticleDescriptions,
  repairExcerptFromOriginal,
  SENTENCE_ABBREVIATIONS,
  startsAfterNonSentenceBoundary,
  stripExcerptMarkdown,
} from '../scripts/lib/article-excerpt.mjs';
import { buildMetaBlockLines } from '../scripts/lib/article-meta-block.mjs';

test('normalizza l intestazione In breve in una sola frase utile', () => {
  const raw = '## In breve - L’USTRA ha pubblicato il progetto A2 tra Mendrisio e Melano. - I lavori inizieranno dopo il 2031.';
  assert.equal(
    normalizeExcerpt(raw),
    'L’USTRA ha pubblicato il progetto A2 tra Mendrisio e Melano.',
  );

  const sentence = 'La sentenza n. 83/2026 riconosce il diritto al credito d’imposta per i lavoratori frontalieri residenti in Italia.';
  const duplicateMixedHeaders = [
    '## In breve',
    '## En bref',
    `- **${sentence}**`,
    '- Ulteriori dettagli sono disponibili nella decisione completa.',
  ].join('\n');
  assert.equal(normalizeExcerpt(duplicateMixedHeaders), sentence);
});

test('strip deterministico rimuove heading, elenco, grassetto, link e tabella', () => {
  const raw = [
    '## In short',
    '- **First fact** from [the source](https://example.test).',
    '| field | value |',
    '| --- | --- |',
    '| source | verified |',
  ].join('\n');
  assert.equal(
    stripExcerptMarkdown(raw),
    'First fact from the source. field value source verified',
  );
  assert.deepEqual(findExcerptMarkdownDefects(raw), ['heading', 'list', 'bold', 'link', 'table', 'label']);
});

test('non tratta una data con giorno puntato come un elenco ordinato', () => {
  const raw = '1. gennaio 2027 entrerà in vigore il nuovo regolamento, con effetti per tutti i residenti interessati.';
  assert.equal(stripExcerptMarkdown(raw), raw);
  assert.deepEqual(findExcerptMarkdownDefects(raw), []);
  assert.doesNotThrow(() => assertPlainExcerpt(raw));
});

test('rimuove link reference e separatori orizzontali Markdown', () => {
  const raw = [
    'Leggi [la fonte][fonte] per i dettagli.',
    '',
    '---',
    '',
    '[fonte]: https://example.test',
  ].join('\n');
  assert.equal(stripExcerptMarkdown(raw), 'Leggi la fonte per i dettagli.');
  assert.deepEqual(findExcerptMarkdownDefects(raw), ['reference-link', 'horizontal-rule']);
});

test('rileva e ripulisce un delimitatore Markdown rimasto aperto', () => {
  const malformed = '** Il riferimento è il prezzo del diesel alla pompa, quasi a 2,50 franchi al litro.';
  assert.deepEqual(findExcerptMarkdownDefects(malformed), ['unmatched-markdown-delimiter']);
  assert.equal(
    stripExcerptMarkdown(malformed),
    'Il riferimento è il prezzo del diesel alla pompa, quasi a 2,50 franchi al litro.',
  );
});

test('la guardia condivisa controlla anche i campi SEO fuori dal meta builder', () => {
  assert.throws(
    () => assertPlainDescriptionFields(
      { description: '[testo][ref]' },
      { fieldPrefix: 'seo.', id: 'a2-test', locale: 'it' },
    ),
    /excerpt-plain.*seo\.description.*reference-link/,
  );
});

test('la codifica dei meta distingue il testo plain dal preflight di completezza', () => {
  assert.equal(
    assertPlainExcerpt('Excerpt EN', { locale: 'en', checkCompleteness: false }),
    'Excerpt EN',
  );
  assert.throws(
    () => assertPlainExcerpt('Excerpt EN', { locale: 'en' }),
    /\[excerpt-complete\]/u,
    'il controllo di completezza resta attivo per default',
  );
  assert.throws(
    () => assertPlainExcerpt('**Short excerpt**', { checkCompleteness: false }),
    /\[excerpt-plain\]/u,
    'l’encoder continua a rifiutare Markdown',
  );
});

test('la completezza rileva code sintattiche aperte, parentesi e label orfane', () => {
  assert.deepEqual(findExcerptCompletenessDefects('The vote is'), ['dangling-clause']);
  assert.deepEqual(findExcerptCompletenessDefects('A rate applies (starting at'), ['unclosed-parenthesis', 'dangling-clause']);
  assert.deepEqual(findExcerptCompletenessDefects('The deadline is expected by mid-'), ['unfinished-hyphenated-word']);
  assert.deepEqual(
    findExcerptCompletenessDefects('Der Gerichtshof verweist auf Art.', { locale: 'de' }),
    ['unfinished-abbreviation'],
  );
  assert.deepEqual(
    findExcerptCompletenessDefects('Die Vereinbarung gilt seit dem 1.', { locale: 'de' }),
    ['unfinished-abbreviation', 'unfinished-date'],
  );
  assert.deepEqual(
    findExcerptCompletenessDefects('Die Vernehmlassung ist bis zum 7.', { locale: 'de' }),
    ['unfinished-abbreviation', 'unfinished-date'],
  );
  assert.deepEqual(findExcerptCompletenessDefects('A complete sentence. Subject'), ['orphaned-label']);
  assert.deepEqual(findExcerptCompletenessDefects('Sunday work would remain subject'), ['orphaned-label']);
  assert.deepEqual(findExcerptCompletenessDefects('Eine vollständige Aussage. gegenstand'), ['orphaned-label']);
  assert.deepEqual(findExcerptCompletenessDefects('Une phrase complète. objet'), ['orphaned-label']);
  assert.deepEqual(findExcerptCompletenessDefects('Guida pratica al Permesso G.'), []);
});

test('le abbreviazioni non chiudono una frase e una coda breve resta da riparare', () => {
  for (const abbreviation of SENTENCE_ABBREVIATIONS) {
    assert.equal(endsWithSentenceAbbreviation(`La norma richiama ${abbreviation}`), true, abbreviation);
  }
  assert.equal(endsWithSentenceAbbreviation('La sentenza n.'), true);
  assert.equal(endsWithSentenceAbbreviation('La sentenza ART.'), true);
  assert.equal(endsWithSentenceAbbreviation('«La sentenza n.»'), true);
  assert.equal(endsWithSentenceAbbreviation('La norma cita A.'), true);
  const permitGExcerpt = 'Die Anforderungen und das Durchschnittsgehalt für Fliesenleger im Tessin als Grenzgänger, mit Informationen zur möglichen Anerkennung des Bildungsabschlusses und zum Ausweis G.';
  assert.equal(endsWithSentenceAbbreviation(permitGExcerpt), false);
  assert.deepEqual(findExcerptCompletenessDefects(permitGExcerpt, { locale: 'de' }), []);
  assert.deepEqual(repairExcerptFromOriginal(permitGExcerpt, { locale: 'de' }), {
    value: permitGExcerpt,
    strategy: null,
    defects: [],
  });
  assert.equal(endsWithSentenceAbbreviation('Die Temperatur steigt auf 25°C.'), false);
  assert.deepEqual(findExcerptCompletenessDefects('Die Temperatur steigt auf 25°C.', { locale: 'de' }), []);
  assert.equal(endsWithSentenceAbbreviation('Parmelin am 17.'), true);
  assert.equal(endsWithSentenceAbbreviation('Applications close on October 23.'), false);
  assert.equal(endsWithSentenceAbbreviation('La quota è 3.5.'), false);
  assert.ok(findExcerptCompletenessDefects('La sentenza n.').includes('unfinished-abbreviation'));
  assert.ok(findExcerptCompletenessDefects('Parmelin am 17.', { locale: 'de' }).includes('unfinished-abbreviation'));
  assert.ok(findExcerptCompletenessDefects('Parmelin am 17.', { locale: 'de' }).includes('unfinished-date'));
  assert.deepEqual(findExcerptCompletenessDefects('La riunione è finita. Ecco perché.', { locale: 'it' }), []);

  const italianSentence = 'La sentenza n. 83/2026, cfr. art. 5 del decreto, disciplina il credito per i frontalieri con aliquota del 3.5% residenti in Italia.';
  assert.equal(firstCompleteBodyExcerpt([italianSentence], { locale: 'it', minLength: 60 }), italianSentence);

  const germanSentence = 'Parmelin am 17. Mai 2027 wurde vom Bundesrat über die nächsten Schritte zur Umsetzung der Vereinbarung informiert.';
  assert.equal(firstCompleteBodyExcerpt([germanSentence], { locale: 'de', minLength: 60 }), germanSentence);

  const clippedMonth = 'Dezember 2020 unterzeichnet und ist seit dem 1. Januar 2024 in Kraft.';
  const completeDateSentence = 'Die Neue Grenzgängervereinbarung wurde am 23. Dezember 2020 unterzeichnet und ist seit dem 1. Januar 2024 in Kraft.';
  const splitStartRepair = repairExcerptFromOriginal(clippedMonth, {
    body: [completeDateSentence],
    locale: 'de',
    minLength: 60,
  });
  assert.equal(splitStartRepair.strategy, 'b');
  assert.equal(splitStartRepair.value, completeDateSentence);

  const tooShort = repairExcerptFromOriginal('Una frase intera ma inferiore alla soglia.', { minLength: 60 });
  assert.equal(tooShort.strategy, null);
  assert.equal(tooShort.value, 'Una frase intera ma inferiore alla soglia.');
});

test('un item completo non è un inizio a metà frase, mentre un ordinal date sì', () => {
  const orderedItem = 'Den aktuellen Stand festhalten: Das Bundesverwaltungsgericht hat die Busse aufgehoben.';
  const bulletItem = 'Distinguere il dato certo dalle conseguenze ancora da definire.';
  const dateContinuation = 'Januar 2026 hat der Stadtschulrat Schaffhausen das Modell beschlossen.';

  assert.equal(startsAfterNonSentenceBoundary(orderedItem, [`1. ${orderedItem}`]), false);
  assert.equal(startsAfterNonSentenceBoundary(bulletItem, [`- **${bulletItem}**`]), false);
  assert.equal(
    startsAfterNonSentenceBoundary(dateContinuation, ['Am 22. Januar 2026 hat der Stadtschulrat Schaffhausen das Modell beschlossen.']),
    true,
  );
  assert.deepEqual(findDescriptionDefects(orderedItem, { locale: 'de', body: [`1. ${orderedItem}`] }), []);
});

test('la lunghezza non rende difettosa una frase completa, breve o oltre il massimo', () => {
  const short = 'Frase completa.';
  const long = 'Il Comune ha pubblicato gli orari aggiornati per l’ufficio dei residenti. '.repeat(8);

  assert.equal(short.length < 60, true);
  assert.deepEqual(repairExcerptFromOriginal(short, { minLength: 60 }), {
    value: short,
    strategy: null,
    defects: [],
  });
  assert.doesNotThrow(() => assertPlainExcerpt(short, { field: 'excerpt' }));

  assert.equal(long.length > 150, true);
  assert.deepEqual(repairExcerptFromOriginal(long, { maxLength: 150 }), {
    value: long,
    strategy: null,
    defects: [],
  });
  assert.doesNotThrow(() => assertPlainExcerpt(long, { field: 'seo.description' }));
});

test('i campi descrittivi condividono i limiti di lunghezza del writer e del corpus', () => {
  assert.equal(minimumDescriptionLength('excerpt'), 60);
  assert.equal(minimumDescriptionLength('ogDescription'), 60);
  assert.equal(minimumDescriptionLength('seoDescription'), 80);
  assert.equal(minimumDescriptionLength('structuredData.description'), 80);
  assert.equal(maximumDescriptionLength('excerpt'), 280);
  assert.equal(maximumDescriptionLength('description'), 150);
  assert.equal(maximumDescriptionLength('ogDescription'), 250);
  assert.doesNotThrow(
    () => assertPlainExcerpt('Descrizione completa ma sotto la soglia SEO.', { field: 'seo.description' }),
  );
});

test('il writer ripara excerpt e SEO del singolo articolo da testo già presente', () => {
  const article = {
    id: 'articolo-di-test',
    content: {
      it: {
        excerpt: 'L’agenzia annuncia una misura che riguarda i lavoratori transfrontalieri dal prossimo gennaio.',
        body1: 'L’agenzia annuncia una misura che riguarda i lavoratori transfrontalieri dal prossimo gennaio.',
      },
      en: {
        excerpt: 'Cross-border workers will face a change in their working conditions for',
        body1: 'Cross-border workers will face a change in their working conditions next year after the agreement takes effect.',
      },
    },
    seo: {
      description: 'Il provvedimento entrerà in vigore nel prossimo anno perché',
      ogDescription: 'La misura descritta dall’agenzia riguarda i lavoratori transfrontalieri dal prossimo gennaio.',
    },
  };

  const repairs = repairGeneratedArticleDescriptions(article);
  assert.equal(article.seo.description, article.seo.ogDescription);
  assert.equal(article.content.en.excerpt, article.content.en.body1);
  assert.deepEqual(
    repairs.map(({ locale, field, source }) => ({ locale, field, source })),
    [
      { locale: 'en', field: 'excerpt', source: 'article-body' },
      { locale: 'it', field: 'description', source: 'sibling-description' },
    ],
  );
  for (const value of [
    article.content.it.excerpt,
    article.content.en.excerpt,
    article.seo.description,
    article.seo.ogDescription,
  ]) {
    assert.deepEqual(findExcerptCompletenessDefects(value), []);
  }
});

test('un articolo senza una fonte completa fallisce prima di essere registrato', () => {
  assert.throws(
    () => repairGeneratedArticleDescriptions({
      id: 'articolo-incompleto',
      content: { it: { excerpt: 'La proposta riguarda i lavoratori perché' } },
      seo: { description: 'La proposta riguarda i lavoratori perché' },
    }),
    (error) => error.qualityReject === true && /cannot be repaired safely/u.test(error.message),
  );
});

test('il gate scopre un punto aggiunto dopo una frase troncata negli esempi del corpus', () => {
  assert.ok(findExcerptCompletenessDefects(
    "L'Accordo Italia-Svizzera del 2020 introduce un nuovo regime di tassazione per i lavoratori frontalieri, sostituendo il quadro del 1974. L'analisi valuta.",
  ).includes('short-final-sentence'));
  assert.ok(findExcerptCompletenessDefects(
    'La Corte di cassazione afferma che gli enti esteri non possono subire un trattamento fiscale più gravoso per il solo fatto di essere costituiti secondo.',
  ).includes('dangling-clause'));
  assert.ok(findExcerptCompletenessDefects(
    'The agreement, which affects all workers, has been.',
    { locale: 'en' },
  ).includes('dangling-clause'));
  for (const [value, locale] of [
    ['The agreement, which has been.', 'en'],
    ['The agreement, which is.', 'en'],
    ['Das Gesetz gilt, weil es wichtig gewesen.', 'de'],
    ['Das Gesetz gilt, weil es.', 'de'],
    ['The ruling was delayed, because the documents are.', 'en'],
    ['The deadline changed because the required forms are.', 'en'],
    ['The deadline changed because young people are.', 'en'],
    ['Die Entscheidung wurde angefochten, weil die Unterlagen sind.', 'de'],
    ['Die Regel gilt, weil wichtige Unterlagen sind.', 'de'],
    ['Die Änderung ist nötig, weil die zuständigen Behörden des Kantons sind.', 'de'],
    ['Die Regel gilt, weil die Dokumente der Behörde sind.', 'de'],
    ['The deadline changed because the required forms have been.', 'en'],
    ['The report explains how foreign workers are.', 'en'],
    ['This article explains how the required forms are.', 'en'],
    ['This guide explains how the important details are.', 'en'],
    ['The article explains how many local businesses are.', 'en'],
    ['The report explains how many local businesses have been.', 'en'],
    ['Die Behörde erklärt, wie wichtige Steuerregeln sind.', 'de'],
    ['Die Redaktion erklärt, wie die notwendigen Unterlagen sind.', 'de'],
    ['Die Behörde erklärt, wie viele wichtige Steuerregeln sind.', 'de'],
    ['Der Bericht erklärt, wie guter Kaffee ist.', 'de'],
    ['Der Bericht erklärt, wie danach die Beiträge sind.', 'de'],
    ['Der Bericht erklärt, wie damals die Vorschriften sind.', 'de'],
    ['Der Bericht erklärt, wie die Vorschriften damals sind.', 'de'],
    ['Die Studie zeigt, wie schneller die Züge sind.', 'de'],
    ['The report explains how higher the rates are.', 'en'],
    ['The report explains how much faster.', 'en'],
    ['Die Studie zeigt, wie viel schneller.', 'de'],
  ]) {
    assert.ok(findExcerptCompletenessDefects(value, { locale }).includes('dangling-clause'), value);
  }
  assert.ok(findExcerptCompletenessDefects('Das Gesetz gilt, weil es.', { locale: 'de' }).includes('dangling-clause'));
  assert.ok(findExcerptCompletenessDefects('Der Antrag zielt auf.', { locale: 'de' }).includes('dangling-clause'));
  for (const example of [
    "L'Accordo introduce nuove regole per i frontalieri. L'analisi valuta.",
    'The agreement introduces new rules for cross-border workers. The analysis evaluates.',
    'Das Abkommen führt neue Regeln für Grenzgänger ein. Die Analyse bewertet.',
    'L’accord introduit de nouvelles règles pour les frontaliers. L’analyse évalue.',
  ]) {
    assert.ok(findExcerptCompletenessDefects(example).includes('short-final-sentence'), example);
  }
  for (const example of [
    'Il progetto resta in vigore per IL.',
    'The change applies to THE.',
    'Die neue Regel gilt nur für.',
    'La mesure concerne le.',
    'Il progetto è stato.',
    'The policy has been.',
    'Die Regel ist gewesen.',
    'La règle a été.',
  ]) {
    assert.ok(findExcerptCompletenessDefects(example).includes('dangling-clause'), example);
  }
  assert.equal(endsWithFunctionWordBeforePeriod('La frase termina con IL.'), true);
  assert.equal(endsWithFunctionWordBeforePeriod('La frase termina con IL.”'), true);
  assert.equal(endsWithFunctionWordBeforePeriod('Die Regel weist den Betrag aus.', { locale: 'de' }), false);
  assert.equal(endsWithFunctionWordBeforePeriod('Eine Person steht früh auf.', { locale: 'de' }), false);
  for (const completeSeparableVerb of [
    'Die Familie zeichnet das Unternehmen für sein Jubiläum aus.',
    'Die Demonstranten lösten unterschiedliche Reaktionen aus.',
    'Die Gewerkschaft klagt unangemessene Nettoerhöhungen an.',
    'Die Bewegung greift in die Situation der Grenzgänger ein.',
    'Die Zahl der Käufer steigt auf dem Immobilienmarkt an.',
    'Der Leitfaden beschreibt das Abkommen, das am 1. Januar 2024 in Kraft getreten ist.',
  ]) {
    assert.equal(
      endsWithFunctionWordBeforePeriod(completeSeparableVerb, { locale: 'de' }),
      false,
      completeSeparableVerb,
    );
  }
  assert.equal(
    findExcerptCompletenessDefects('Erfahren Sie, wie die Sozialbeiträge in Lohnabrechnungen aufgeteilt sind.')
      .includes('dangling-clause'),
    false,
  );
  for (const completePredicate of [
    'Hier ist, was für eine ordnungsgemäße Steuerverwaltung des landwirtschaftlichen Betriebs zu überwachen ist.',
    'Nachdem die Kosten wegen des Iran-Konflikts gestiegen sind.',
    'Es muss einfach die am besten geeignete Person sein.',
    'Ein Modekonzern, dessen Ziel noch ungewiss ist.',
    'In Svizzera le regole coprono i rimborsi tra Stati.',
    'Research looks to the Federal Institutes of Technology AI.',
    'Das Gesetz gilt, weil es wichtig ist.',
    'Das Gesetz gilt, weil die Unterlagen wichtig sind.',
    'Die Regel gilt, weil die Dokumente der Behörde wichtig sind.',
    'Die Behörde sagt, dass die Angestellten mit einer zuständigen Behörde sind.',
    'Die Bären sind sicher, weil die Tiere unter der Brücke sind.',
    'Der Bericht sagt, dass Deutschland dafür und Frankreich dagegen sind.',
    'We need to know where he is.',
    'Die Redaktion erklärt, wo er ist.',
    'The report explains how important the rules are.',
    'The report explains how very important it is.',
    'Die Behörde erklärt, wie wichtig die Fristen sind.',
    'Die Behörde erklärt, wie besonders wichtig die Fristen sind.',
    'We know how high the rates are.',
    'We know how much higher the rates are.',
    'The report explains how significantly higher the rates are.',
    'We know how much faster the trains are.',
    'We know how much cheaper the cars are.',
    'The report explains how much more expensive the cars are.',
    'Wir wissen, wie hoch die Beiträge sind.',
    'Wir wissen, wie alt das Gesetz ist.',
    'Der Bericht erklärt, wie viel höher die Beiträge sind.',
    'Die Studie zeigt, wie viel niedriger die Kosten sind.',
    'Die Studie zeigt, wie viel schneller die Züge sind.',
    'Die Studie zeigt, wie viel langsamer die Züge sind.',
    'Die Studie zeigt, wie deutlich schneller die Züge sind.',
    'Der Bericht erklärt, wie teuer die Autos sind.',
    'Die Redaktion erklärt, wie groß die Unterschiede sind.',
    'Der Bericht erklärt, wie viel teurer die Autos sind.',
    'Die Studie zeigt, wie viel billiger die Autos sind.',
    'Wir wissen, wie viel wichtiger die Frage ist.',
    'We know how many rules there are.',
    'The report explains how many local businesses there are.',
    'The report explains how many local businesses there have been.',
    'The report explains how many local businesses there will be.',
    'We need to know where the office has been.',
    'La redazione spiega dove il collega è stato.',
    'Neue Steuervereinbarung für Grenzgänger: Was sich ändert und was zu tun ist.',
    'We need to know where the office is.',
    'Die Redaktion erklärt, wo das Büro ist.',
  ]) {
    assert.equal(findExcerptCompletenessDefects(completePredicate).includes('dangling-clause'), false, completePredicate);
  }
  assert.equal(
    findExcerptCompletenessDefects('Der Voranschlag weist Einnahmen und Ausgaben aus.').includes('dangling-clause'),
    true,
    'senza il locale non si assume che una particella isolata sia un verbo separabile tedesco',
  );
  assert.equal(
    findExcerptCompletenessDefects('Der Voranschlag weist Einnahmen und Ausgaben aus.', { locale: 'de' })
      .includes('dangling-clause'),
    false,
  );
  assert.equal(
    findExcerptCompletenessDefects('The agreement, which affects all workers, has been.', { locale: 'en' })
      .includes('dangling-clause'),
    true,
  );
  assert.equal(
    findExcerptCompletenessDefects('Der Antrag zielt auf.', { locale: 'de' }).includes('dangling-clause'),
    true,
  );
  assert.throws(
    () => assertPlainExcerpt(
      "L'Accordo Italia-Svizzera del 2020 introduce un nuovo regime di tassazione per i lavoratori frontalieri. L'analisi valuta.",
      { id: 'tail', locale: 'it' },
    ),
    /excerpt-complete.*short-final-sentence/,
  );
});

test('la riparazione usa solo un prefisso con punteggiatura originaria, una frase del body o il valore originale', () => {
  const original = "L'Accordo Italia-Svizzera del 2020 introduce un nuovo regime di tassazione per i lavoratori frontalieri, sostituendo il quadro del 1974. L'analisi valuta il";
  const strategyA = repairExcerptFromOriginal(original);
  assert.equal(strategyA.strategy, 'a');
  assert.equal(strategyA.value, original.slice(0, original.indexOf(' L\'analisi')));
  assert.ok(original.startsWith(strategyA.value));
  assert.equal(strategyA.value.endsWith('.'), true);
  const dateTail = 'Die SVA Aargau versendet die Codes für die Prämienverbilligung. Für 2027 muss der Antrag bis Donnerstag, 31. Dezember, eingereicht werden und';
  assert.equal(repairExcerptFromOriginal(dateTail).value, 'Die SVA Aargau versendet die Codes für die Prämienverbilligung.');

  const bodySentence = 'Gli enti esteri che perseguono finalità analoghe a quelle di fondazioni o enti non commerciali italiani non possono subire un trattamento fiscale più gravoso sui dividendi di fonte italiana per il solo fatto di essere costituiti secondo un diverso ordinamento.';
  const originalWithoutBoundary = 'La Corte afferma che gli enti non possono subire un trattamento fiscale più gravoso per il solo fatto di essere costituiti secondo un';
  const strategyB = repairExcerptFromOriginal(originalWithoutBoundary, { body: [bodySentence], maxLength: 280 });
  assert.equal(strategyB.strategy, 'b');
  assert.equal(strategyB.value, bodySentence);
  assert.ok(bodySentence.includes(strategyB.value));

  const dateTruncated = 'Das Adoptionsverfahren wird durch die Neue Grenzgängervereinbarung geregelt, die am 23. Dezember 2020 unterzeichnet wurde und seit dem 1.';
  const dateBodySentence = 'Die Neue Grenzgängervereinbarung wurde am 23. Dezember 2020 unterzeichnet und ist seit dem 1. Januar 2024 in Kraft.';
  const dateRepair = repairExcerptFromOriginal(dateTruncated, {
    body: [dateBodySentence],
    locale: 'de',
    maxLength: 280,
  });
  assert.equal(dateRepair.strategy, 'b');
  assert.equal(dateRepair.value, dateBodySentence);

  const ordinalDateBody = 'Die Bewerbungen sind bis zum 15. September 2026 möglich und können online eingereicht werden.';
  const ordinalDateRepair = repairExcerptFromOriginal('Bewerbungen sind bis zum 15.', {
    body: [ordinalDateBody],
    locale: 'de',
    maxLength: 280,
  });
  assert.equal(ordinalDateRepair.strategy, 'b');
  assert.equal(ordinalDateRepair.value, ordinalDateBody);

  const strategyC = repairExcerptFromOriginal('The consultation deadline is', { body: [] });
  assert.equal(strategyC.strategy, 'c');
  assert.equal(strategyC.value, 'The consultation deadline is');

  const weaklyRelated = repairExcerptFromOriginal(
    'The report details the number of work permits issued in Switzerland and the effect on local employers in 2026 for',
    { body: ['The daily briefing is published on Tuesday, 1 September 2026.'] },
  );
  assert.equal(weaklyRelated.strategy, 'c');

  const unrelatedCandidate = repairExcerptFromOriginal(
    'The report explains cross-border permit changes in Switzerland for',
    {
      title: 'Swiss cross-border permit rules for 2026',
      body: ['The weekly briefing reviews local election results and district council appointments from Monday.'],
      locale: 'en',
    },
  );
  assert.equal(unrelatedCandidate.strategy, 'c');
  assert.equal(unrelatedCandidate.value, 'The report explains cross-border permit changes in Switzerland for');
});

test('la strategia b scarta giunzioni senza terminatore e attraversamenti di elenchi o righe', () => {
  const original = 'Das Schweizer-EU-Paket befindet sich seit dem 13.';
  const bulletBody = [
    '- Das Schweizer-EU-Paket befindet sich seit dem 13. März 2026 im Parlament',
    '- Die Volksabstimmung ist für den 29. November 2026 angesetzt.',
  ].join('\n');
  const listed = repairExcerptFromOriginal(original, {
    body: [bulletBody],
    locale: 'de',
    title: 'Schweizer-EU-Paket im Parlament',
    minLength: 60,
  });
  assert.equal(listed.strategy, 'c');
  assert.equal(listed.value, original);
  const oneBulletSentence = 'Das Schweizer-EU-Paket befindet sich seit dem 13. März 2026 im Parlament.';
  assert.equal(
    firstCompleteBodyExcerpt(['- ' + oneBulletSentence], { locale: 'de', minLength: 60 }),
    oneBulletSentence,
  );
  const separatedBulletRepair = repairExcerptFromOriginal(
    'Le regole consentono ai richiedenti asilo di lavorare in Svizzera, anche in',
    {
      body: [[
        '- Richiedenti asilo e titolari statuto S possono lavorare in Ticino.',
        '- Autorizzazione cantonale richiesta, iter semplificato entro 30 giorni.',
      ].join('\n')],
      locale: 'it',
      title: 'Richiedenti asilo e ucraini possono lavorare in Svizzera',
      field: 'description',
      maxLength: 150,
      minLength: 80,
    },
  );
  assert.equal(separatedBulletRepair.strategy, 'b');
  assert.equal(
    separatedBulletRepair.value,
    'Richiedenti asilo e titolari statuto S possono lavorare in Ticino. Autorizzazione cantonale richiesta, iter semplificato entro 30 giorni.',
  );

  const inlineJoin = 'Das Schweizer-EU-Paket befindet sich seit dem 13. März 2026 im Parlament Die Volksabstimmung ist für den 29. November 2026 angesetzt.';
  assert.equal(firstCompleteBodyExcerpt([inlineJoin], { locale: 'de', minLength: 60 }), null);

  const properlySeparated = 'Das Schweizer-EU-Paket befindet sich seit dem 13. März 2026 im Parlament. Die Volksabstimmung ist für den 29. November 2026 angesetzt.';
  assert.equal(
    firstCompleteBodyExcerpt([properlySeparated], { locale: 'de', minLength: 60 }),
    properlySeparated.slice(0, properlySeparated.indexOf('Parlament.') + 'Parlament.'.length),
  );
});

test('la strategia b non confonde i pronomi e i nomi propri con l’inizio di una frase unita', () => {
  const germanSentence = 'Beachten Sie den Hinweis und prüfen Sie Ihre Unterlagen bis zur Frist am 30. November 2026 sorgfältig.';
  const germanRepair = repairExcerptFromOriginal('Der Artikel erklärt die geltenden Regeln und', {
    body: [germanSentence],
    locale: 'de',
    title: 'Hinweis Unterlagen Frist',
  });
  assert.equal(germanRepair.strategy, 'b');
  assert.equal(germanRepair.value, germanSentence);

  const italianSentence = 'La cooperativa Il Granello di Cislago mette a disposizione un pulmino elettrico per le attività dei ragazzi.';
  const italianRepair = repairExcerptFromOriginal('Il pulmino elettrico per i ragazzi di Cislago e', {
    body: [italianSentence],
    locale: 'it',
    title: 'pulmino elettrico Cislago ragazzi',
  });
  assert.equal(italianRepair.strategy, 'b');
  assert.equal(italianRepair.value, italianSentence);

  const germanCompoundSentence = 'Die Kontrollen bei der Ein- und Ausreise werden an allen Schweizer Grenzen einheitlich durchgeführt.';
  const germanCompoundRepair = repairExcerptFromOriginal('Die Behörden erläutern die Regeln zur Einreise und', {
    body: [germanCompoundSentence],
    locale: 'de',
    title: 'Kontrollen Ausreise Schweizer Grenzen',
  });
  assert.equal(germanCompoundRepair.strategy, 'b');
  assert.equal(germanCompoundRepair.value, germanCompoundSentence);
});

test('la strategia b scarta le frasi del body rilevate in una lingua diversa dal campo', () => {
  const original = 'Der Bericht zur Gemeindefusion im Basso Mendrisiotto bezieht Chiasso, Mendrisio und Vacallo ein und';
  const italianCandidate = 'Il progetto di aggregazione del Basso Mendrisiotto, che coinvolge i comuni di Chiasso, Mendrisio e Vacallo, sta facendo progressi, ma non senza difficoltà.';
  const germanCandidate = 'Das Fusionsprojekt im unteren Mendrisiotto mit den Gemeinden Chiasso, Mendrisio und Vacallo macht Fortschritte, steht aber weiterhin vor finanziellen Schwierigkeiten.';
  const options = {
    locale: 'de',
    title: 'Gemeindefusion Basso Mendrisiotto Chiasso Mendrisio Vacallo',
    body: [italianCandidate, germanCandidate],
  };

  const repaired = repairExcerptFromOriginal(original, options);
  assert.equal(repaired.strategy, 'b');
  assert.equal(repaired.value, germanCandidate);
  assert.equal(
    firstCompleteBodyExcerpt(options.body, { locale: 'de' }),
    germanCandidate,
    'anche il selettore condiviso esclude la frase italiana',
  );

  const withoutGermanCandidate = repairExcerptFromOriginal(original, {
    ...options,
    body: [italianCandidate],
  });
  assert.equal(withoutGermanCandidate.strategy, 'c');
  assert.equal(withoutGermanCandidate.value, original);
  assert.equal(
    firstCompleteBodyExcerpt([italianCandidate], { locale: 'de' }),
    null,
    'il selettore non deve proporre una frase italiana come excerpt tedesco',
  );
});

test('il gate accetta testo semplice e rifiuta Markdown nei campi descrittivi', () => {
  assert.doesNotThrow(() => assertPlainExcerpt('Il progetto è stato pubblicato oggi, con effetti per tutti i residenti interessati.', {
    field: 'excerpt',
    id: 'a2-test',
    locale: 'it',
  }));
  assert.throws(
    () => assertPlainExcerpt('En bref - **texte**.', { field: 'excerpt', id: 'a2-test', locale: 'fr' }),
    /excerpt-plain.*bold.*label/,
  );
  assert.throws(
    () => buildMetaBlockLines({
      id: 'a2-test',
      content: { it: { title: 'Titolo', excerpt: '## In breve - Testo.' } },
    }, 'it'),
    /excerpt-plain.*heading/,
  );
  assert.throws(
    () => buildMetaBlockLines({
      id: 'a2-test',
      content: {
        it: {
          title: 'Titolo',
          excerpt: 'Testo semplice che supera la soglia minima prevista per la pubblicazione del riepilogo.',
          seoDescription: '## SERP contaminata',
        },
      },
    }, 'it'),
    /excerpt-plain.*seoDescription.*heading/,
  );
});
