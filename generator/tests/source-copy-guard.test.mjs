import test from 'node:test';
import assert from 'node:assert/strict';
import {
  condenseSourceCopyArticle,
  evaluateSourceCopy,
  generateWithSourceCopyGuard,
  getSourceCopyMode,
  logSourceCopyVerdict,
  repairSourceCopyArticle,
  SOURCE_COPY_OVERLAP_THRESHOLD,
  sourceCopyModeBlocks,
  SourceCopyError,
} from '../scripts/lib/source-copy-guard.mjs';

const WORDS = 'uno due tre quattro cinque sei sette otto nove dieci undici dodici tredici';

test('la modalità anti-copia è repair per default, valida e fail-safe', () => {
  const previous = process.env.ARTICLE_SOURCE_COPY_MODE;
  try {
    delete process.env.ARTICLE_SOURCE_COPY_MODE;
    assert.equal(getSourceCopyMode(), 'repair');
    assert.equal(sourceCopyModeBlocks(), false);
    assert.equal(getSourceCopyMode('repair'), 'repair');
    assert.equal(sourceCopyModeBlocks('repair'), false);
    assert.equal(getSourceCopyMode('enforce'), 'enforce');
    assert.equal(sourceCopyModeBlocks('enforce'), true);
    assert.equal(getSourceCopyMode('invalid'), 'repair');
  } finally {
    if (previous === undefined) delete process.env.ARTICLE_SOURCE_COPY_MODE;
    else process.env.ARTICLE_SOURCE_COPY_MODE = previous;
  }
});

test('il log espone la modalità effettiva senza bloccare il verdetto warn', () => {
  const lines = [];
  const verdict = evaluateSourceCopy(WORDS, WORDS);
  logSourceCopyVerdict('articolo-test', verdict, (line) => lines.push(line), 'warn');
  assert.equal(verdict.safe, false);
  assert.match(lines[0], /max_overlap=13/);
  assert.match(lines[0], /mode=warn/);
});

test('warn restituisce il primo draft senza rigenerare né rigettare', async () => {
  let calls = 0;
  const result = await generateWithSourceCopyGuard({
    sourceText: WORDS,
    mode: 'warn',
    generate: async () => {
      calls += 1;
      return WORDS;
    },
    logger: () => {},
  });
  assert.equal(calls, 1);
  assert.equal(result.retries, 0);
  assert.equal(result.verdict.safe, false);
});

test('rifiuta una sequenza di almeno dodici parole consecutive', () => {
  const exact = evaluateSourceCopy(WORDS, WORDS);
  assert.equal(exact.maxWords, WORDS.split(' ').length);
  assert.equal(exact.safe, false);

  const eleven = WORDS.split(' ').slice(0, SOURCE_COPY_OVERLAP_THRESHOLD - 1).join(' ');
  const below = evaluateSourceCopy(WORDS, eleven);
  assert.equal(below.maxWords, SOURCE_COPY_OVERLAP_THRESHOLD - 1);
  assert.equal(below.safe, true);
});

test('ignora gli accenti nelle quattro lingue supportate', () => {
  const verdict = evaluateSourceCopy(
    'L’assicurazione obbligatoria protegge i lavoratori frontalieri durante l’anno fiscale corrente',
    "L'ASSICURAZIONE obbligatoria protegge i lavoratori frontalieri durante l'anno fiscale corrente",
    { locale: 'it' },
  );
  assert.equal(verdict.safe, false);
  assert.ok(verdict.maxWords >= SOURCE_COPY_OVERLAP_THRESHOLD);
});

test('ammette al massimo due citazioni brevi attribuite', () => {
  const source = [
    'La prima fonte dice una frase breve davvero importante per il lettore locale.',
    'La seconda fonte aggiunge una frase breve davvero importante per il lettore locale.',
    'La terza fonte ripete una frase breve davvero importante per il lettore locale.',
  ].join(' ');
  const article = [
    'Secondo la fonte «La prima fonte dice una frase breve davvero importante per il lettore locale».',
    'Come riferisce il comunicato «La seconda fonte aggiunge una frase breve davvero importante per il lettore locale».',
    'La terza fonte ripete una frase breve davvero importante per il lettore locale.',
  ].join(' ');
  const verdict = evaluateSourceCopy(source, article);
  assert.equal(verdict.allowedQuotes, 2);
  assert.equal(verdict.safe, false);
  assert.ok(verdict.maxWords >= SOURCE_COPY_OVERLAP_THRESHOLD);
});

test('una citazione non attribuita o oltre 25 parole resta nel confronto', () => {
  const source = 'La fonte presenta una spiegazione chiara e completa del provvedimento per tutti i lavoratori frontalieri della regione durante il prossimo anno fiscale.';
  const unattributed = evaluateSourceCopy(source, '«La fonte presenta una spiegazione chiara e completa del provvedimento per tutti i lavoratori frontalieri della regione durante il prossimo anno fiscale».');
  assert.equal(unattributed.allowedQuotes, 0);
  assert.equal(unattributed.safe, false);

  const longQuote = `Secondo la fonte «${source} La misura entra in vigore domani e riguarda anche i datori di lavoro».`;
  const longVerdict = evaluateSourceCopy(source, longQuote);
  assert.equal(longVerdict.allowedQuotes, 0);
  assert.equal(longVerdict.safe, false);
});

test('calcola la posizione reale delle citazioni dopo un prefisso lungo', () => {
  const quote = 'La fonte conferma una misura importante per i lavoratori frontalieri della regione';
  const prefix = 'Contesto redazionale neutro. '.repeat(12);
  const verdict = evaluateSourceCopy(
    quote,
    `${prefix} Secondo la fonte «${quote}».`,
  );
  assert.equal(verdict.allowedQuotes, 1);
  assert.ok(verdict.maxWords < SOURCE_COPY_OVERLAP_THRESHOLD);
  assert.equal(verdict.safe, true);
});

test('rigenera dopo il primo overlap e poi accetta la parafrasi', async () => {
  const drafts = [WORDS, 'Una parafrasi indipendente con lessico e struttura completamente diversi.'];
  const calls = [];
  const logs = [];
  const result = await generateWithSourceCopyGuard({
    sourceText: WORDS,
    articleId: 'articolo-test',
    mode: 'enforce',
    logger: (line) => logs.push(line),
    generate: async ({ retry, instruction }) => {
      calls.push({ retry, instruction });
      return drafts[retry];
    },
  });
  assert.equal(result.retries, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[1].instruction, /12 parole consecutive/);
  assert.equal(logs.length, 2);
});

test('fallisce esplicitamente dopo il tetto di rigenerazioni', async () => {
  await assert.rejects(
    generateWithSourceCopyGuard({
      sourceText: WORDS,
      maxRetries: 1,
      mode: 'enforce',
      generate: async () => WORDS,
      logger: () => {},
    }),
    (error) => error instanceof SourceCopyError && error.retries === 1 && error.qualityReject === true,
  );
});

test('ripara solo il paragrafo indicato e scende sotto soglia senza rigenerare l articolo', async () => {
  const source = 'alfa bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
  const article = {
    body1: `${source}. Questo paragrafo contiene anche contesto editoriale indipendente per mantenere valido il corpo.`,
    body2: 'Secondo paragrafo con fatti verificati e contesto locale aggiuntivo.',
    body3: 'Terzo paragrafo con una chiusura editoriale autonoma e completa.',
  };
  const originalBody2 = article.body2;
  const passes = [];
  const result = await repairSourceCopyArticle({
    sourceText: source,
    article,
    articleId: 'mirato',
    mode: 'repair',
    logger: () => {},
    repair: async ({ targets, pass }) => {
      passes.push({ pass, fields: targets.map((target) => target.field), paragraphs: targets.map((target) => target.paragraphIndex) });
      return {
        ...article,
        body1: 'Paragrafo riformulato con fatti invariati e lessico indipendente dal testo sorgente.',
      };
    },
  });
  assert.equal(result.rejected, false);
  assert.equal(result.verdict.safe, true);
  assert.equal(result.passes, 1);
  assert.deepEqual(passes, [{ pass: 1, fields: ['body1'], paragraphs: [0] }]);
  assert.equal(result.article.body2, originalBody2);
});

test('onora maxPasses=0 e non considera una callback mutante un no-op', async () => {
  const source = 'uno due tre quattro cinque sei sette otto nove dieci undici dodici';
  const article = {
    body1: `${source}. Contesto editoriale indipendente e verificato.`,
    body2: 'Secondo paragrafo autonomo con informazioni utili.',
    body3: 'Conclusione autonoma con contesto locale.',
  };
  let calls = 0;
  const noPasses = await repairSourceCopyArticle({
    sourceText: source,
    article,
    mode: 'repair',
    maxPasses: 0,
    repair: async () => {
      calls += 1;
      return article;
    },
    logger: () => {},
  });
  assert.equal(calls, 0);
  assert.equal(noPasses.passes, 0);
  assert.equal(noPasses.rejected, false);
  assert.equal(noPasses.outcome, 'repaired');

  const mutating = await repairSourceCopyArticle({
    sourceText: source,
    article,
    mode: 'repair',
    repair: async ({ article: draft }) => {
      draft.body1 = 'Paragrafo riformulato con lessico indipendente e fatti invariati.';
      return draft;
    },
    logger: () => {},
  });
  assert.equal(mutating.passes, 1);
  assert.equal(mutating.changed, true);
  assert.equal(mutating.verdict.safe, true);
  assert.equal(article.body1.startsWith(source), true);
});

test('condensa la frase incriminata quando la riparazione non cambia il testo', async () => {
  const source = 'uno due tre quattro cinque sei sette otto nove dieci undici dodici';
  const article = {
    body1: `Apertura autonoma. ${source}. Chiusura con informazioni aggiuntive non copiate e utili al lettore.`,
    body2: 'Contesto separato con abbastanza parole per evitare una copertura strutturale.',
    body3: 'Conclusione separata.',
  };
  const result = await repairSourceCopyArticle({
    sourceText: source,
    article,
    mode: 'repair',
    logger: () => {},
    repair: async () => article,
  });
  assert.equal(result.rejected, false);
  assert.equal(result.verdict.safe, true);
  assert.doesNotMatch(result.article.body1, /uno due tre quattro cinque/);
  assert.match(result.article.body1, /Apertura autonoma/);
  assert.match(result.article.body1, /Chiusura con informazioni/);
  assert.equal(condenseSourceCopyArticle(article, evaluateSourceCopy(source, article)).changed, true);
});

test('esenta sequenze brevi composte soprattutto da nomi propri e denominazioni/date/cifre', () => {
  const properSource = 'Lugano Mendrisio Bellinzona Locarno Varese Como Ticino Lombardia Svizzera Italia Zurigo Milano';
  const proper = evaluateSourceCopy(properSource, properSource);
  assert.equal(proper.maxWords, 0);
  assert.equal(proper.rawMaxWords, 12);
  assert.equal(proper.sequences[0].exempt, true);
  assert.equal(proper.sequences[0].exemptionReason, 'nomi-propri');

  const officialSource = 'Accordo Italia Svizzera legge federale del 2026 Ministero dell Economia Ufficio federale delle imposte';
  const official = evaluateSourceCopy(officialSource, officialSource);
  assert.equal(official.maxWords, 0);
  assert.ok(official.sequences.some((sequence) => sequence.exempt));
  assert.equal(official.safe, true);

  const figuresSource = '2020 2021 2022 2023 2024 2025 2026 2027 2028 2029 2030 2031';
  const figures = evaluateSourceCopy(figuresSource, figuresSource);
  assert.equal(figures.maxWords, 0);
  assert.equal(figures.sequences[0].exemptionReason, 'date-cifre');
});

test('rigetta solo una copia strutturale che nessuna delle tre passate riesce a riparare', async () => {
  const source = Array.from({ length: 45 }, (_, index) => `parola${index}`).join(' ');
  const article = {
    body1: `${source}.`,
    body2: 'Paragrafo autonomo.',
    body3: 'Altro contenuto autonomo.',
  };
  let passes = 0;
  const result = await repairSourceCopyArticle({
    sourceText: source,
    article,
    mode: 'repair',
    logger: () => {},
    repair: async () => {
      passes += 1;
      return { ...article, body1: `${source}. aggiunta${passes}` };
    },
    condense: () => ({ article, changed: false }),
  });
  assert.equal(passes, 3);
  assert.equal(result.verdict.structural, true);
  assert.equal(result.rejected, true);
  assert.equal(result.outcome, 'rejected');
});
