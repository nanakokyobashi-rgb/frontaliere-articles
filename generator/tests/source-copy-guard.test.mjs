import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSourceCopy,
  generateWithSourceCopyGuard,
  getSourceCopyMode,
  logSourceCopyVerdict,
  SOURCE_COPY_OVERLAP_THRESHOLD,
  sourceCopyModeBlocks,
  SourceCopyError,
} from '../scripts/lib/source-copy-guard.mjs';

const WORDS = 'uno due tre quattro cinque sei sette otto nove dieci undici dodici tredici';

test('la modalità anti-copia è warn per default, valida e fail-safe', () => {
  const previous = process.env.ARTICLE_SOURCE_COPY_MODE;
  try {
    delete process.env.ARTICLE_SOURCE_COPY_MODE;
    assert.equal(getSourceCopyMode(), 'warn');
    assert.equal(sourceCopyModeBlocks(), false);
    assert.equal(getSourceCopyMode('repair'), 'repair');
    assert.equal(sourceCopyModeBlocks('repair'), false);
    assert.equal(getSourceCopyMode('enforce'), 'enforce');
    assert.equal(sourceCopyModeBlocks('enforce'), true);
    assert.equal(getSourceCopyMode('invalid'), 'warn');
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
