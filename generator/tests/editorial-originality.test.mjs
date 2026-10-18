import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorialOriginalityIssue, extractSyntheticReferenceEvidence, validateEditorialAssessment } from '../scripts/lib/editorial-originality.mjs';

const comparisonSource = 'Il Comune ha registrato 120 domande di rinnovo nel 2024 e 156 nel 2025, secondo la statistica comunale; il dato 2025 copre il periodo 1 gennaio–31 dicembre.';

test('rejects a complete but merely paraphrased source summary with exact quote evidence', () => {
  const articleBody = 'Il numero delle richieste di rinnovo presso il Comune è passato da 120 nel 2024 a 156 nel 2025, secondo la statistica comunale.';
  const result = validateEditorialAssessment({
    classification: 'source_restatement',
    finding: 'Il corpo ripete i due dati e li riformula, senza spiegare una relazione o un confronto aggiunto.',
    articleQuote: articleBody,
    evidenceQuotes: [comparisonSource],
  }, { articleBody, evidenceText: comparisonSource });
  assert.equal(result.passed, false);
  assert.equal(result.classification, 'source_restatement');
  assert.match(result.reason, /riassume o parafrasa/);
  assert.equal(editorialOriginalityIssue(result).code, 'editorial_originality');
});

test('accepts a concrete comparison with exact article and source evidence', () => {
  const articleBody = 'Il passaggio da 120 domande nel 2024 a 156 nel 2025 significa 36 richieste in più, pari al 30%; il confronto copre due anni completi.';
  const result = validateEditorialAssessment({
    classification: 'grounded_analysis',
    finding: 'Il confronto calcola 36 richieste in più e il 30% dai 120 rinnovi del 2024 e 156 del 2025, usando due anni completi.',
    articleQuote: articleBody,
    evidenceQuotes: [comparisonSource],
  }, { articleBody, evidenceText: comparisonSource });
  assert.equal(result.passed, true);
  assert.equal(result.classification, 'grounded_analysis');
});

test('rejects unsupported causes, consequences, and invented first-hand reporting', () => {
  const cases = [
    {
      articleBody: 'L’aumento dimostra che le nuove regole hanno convinto più residenti a rinnovare il permesso.',
      classification: 'unsupported_inference',
      finding: 'La fonte non attribuisce l’aumento a una modifica delle regole né documenta il motivo delle domande.',
    },
    {
      articleBody: 'La nostra redazione ha intervistato i residenti in Comune e ha verificato sul posto il cambiamento.',
      classification: 'unsupported_inference',
      finding: 'La fonte non documenta interviste, osservazioni sul posto o verifiche umane realizzate da questa redazione.',
    },
  ];
  for (const item of cases) {
    const result = validateEditorialAssessment({ ...item, articleQuote: item.articleBody,
      evidenceQuotes: [comparisonSource] }, { articleBody: item.articleBody, evidenceText: comparisonSource });
    assert.equal(result.passed, false);
    assert.equal(result.classification, 'unsupported_inference');
    assert.match(editorialOriginalityIssue(result).fix, /Non inventare cause, conseguenze/);
  }
});

test('a generic contribution label and a boolean declaration are not evidence', () => {
  const articleBody = 'I numeri raccontano una situazione importante per la popolazione locale.';
  const vague = validateEditorialAssessment({ classification: 'grounded_analysis',
    finding: 'Il dato è importante e utile per i lettori.', articleQuote: articleBody,
    evidenceQuotes: [comparisonSource] }, { articleBody, evidenceText: comparisonSource });
  assert.equal(vague.passed, false);
  assert.equal(vague.verifiable, true);
  assert.match(vague.reason, /dettagli specifici e rintracciabili/);

  const declaration = validateEditorialAssessment({ originalita: true, passed: true },
    { articleBody, evidenceText: comparisonSource });
  assert.equal(declaration.passed, false);
  assert.equal(declaration.classification, 'invalid_assessment');
  assert.equal(declaration.verifiable, false);
});

test('accepts an Italian analysis grounded in an exact German or French source quote', () => {
  const articleBody = 'Il confronto tra 120 richieste nel 2024 e 156 nel 2025 aggiunge 36 rinnovi, pari al 30%, su due anni completi.';
  const finding = 'Il confronto tra 120 richieste e 156 richieste aggiunge 36 rinnovi, pari al 30%, sui due anni completi.';
  const sourceQuotes = [
    'Die Gemeinde registrierte 120 Verlängerungen im Jahr 2024 und 156 im Jahr 2025.',
    'La commune a enregistré 120 demandes en 2024 et 156 en 2025, selon la statistique communale.',
  ];
  for (const evidenceText of sourceQuotes) {
    const result = validateEditorialAssessment({ classification: 'grounded_analysis', finding,
      articleQuote: articleBody, evidenceQuotes: [evidenceText] }, { articleBody, evidenceText });
    assert.equal(result.passed, true, evidenceText);
    assert.equal(result.verifiable, true, evidenceText);
  }
});

test('requires exact quotes from both the article body and a source/reference', () => {
  const articleBody = 'Il passaggio da 120 domande nel 2024 a 156 nel 2025 significa 36 richieste in più, pari al 30%; il confronto copre due anni completi.';
  const assessment = { classification: 'grounded_analysis',
    finding: 'Il testo calcola differenza e variazione percentuale dai due totali e chiarisce che i periodi confrontati sono anni completi.',
    articleQuote: 'Il testo calcola una variazione del 30% sui due totali annuali completi.',
    evidenceQuotes: ['Il numero è aumentato in modo significativo.'] };
  const result = validateEditorialAssessment(assessment, { articleBody, evidenceText: comparisonSource });
  assert.equal(result.passed, false);
  assert.equal(result.verifiable, false);
  assert.match(result.reason, /citazione precisa/);

  const copiedSource = validateEditorialAssessment({ ...assessment,
    finding: 'La frase sui 120 rinnovi del 2024 e 156 del 2025 è copiata dalla fonte senza spiegare il confronto.',
    articleQuote: comparisonSource,
    evidenceQuotes: [comparisonSource] }, { articleBody: comparisonSource, evidenceText: comparisonSource });
  assert.equal(copiedSource.passed, false);
  assert.equal(copiedSource.verifiable, true);
  assert.match(copiedSource.reason, /già presente nella fonte/);
});

test('synthetic evergreen evidence excludes keywords, editorial angles, and instructions', () => {
  const prompt = [
    '[ARTICOLO EVERGREEN SEO]',
    'Keyword target: lavoro frontalieri',
    'Angolo editoriale: spiega perché trasferirsi in Ticino migliora la carriera',
    'Genera un articolo approfondito e pratico.',
    'BRIEF DI FATTI VERIFICATI: la libera circolazione si applica ai cittadini UE/AELS secondo l’accordo bilaterale.',
    '⚠️ Segui l’angolo editoriale e non inventare cifre.',
  ].join('\n');
  const trustedBrief = 'BRIEF DI FATTI VERIFICATI: la libera circolazione si applica ai cittadini UE/AELS secondo l’accordo bilaterale.';
  const evidenceText = extractSyntheticReferenceEvidence({
    sourceUrl: 'evergreen://lavoro-frontalieri',
    sourceContent: prompt,
    evergreenBrief: trustedBrief,
  });
  assert.equal(evidenceText, trustedBrief);
  assert.doesNotMatch(evidenceText, /Keyword target|Angolo editoriale|Genera un articolo|Segui l’angolo/);

  const articleBody = 'Il corpo collega la libera circolazione ai cittadini UE/AELS e chiarisce il perimetro dell’accordo bilaterale applicabile.';
  const assessment = validateEditorialAssessment({
    classification: 'grounded_analysis',
    finding: 'L’analisi aggiunge una spiegazione del perimetro UE/AELS, come indicato nell’accordo bilaterale citato nel brief.',
    articleQuote: articleBody,
    evidenceQuotes: ['Angolo editoriale: spiega perché trasferirsi in Ticino migliora la carriera'],
  }, { articleBody, evidenceText });
  assert.equal(assessment.verifiable, false);
});

test('synthetic BFS evidence stops before the requested editorial angle', () => {
  const prompt = [
    '[ARTICOLO DATI BFS STATISTICA FRONTALIERI TICINO]',
    'Trimestre appena pubblicato: 2026-Q2',
    '=== DATI VERIFICATI ===',
    '- Totale Canton Ticino: 80.000',
    '=== SERIE STORICA ===',
    '| 2026-Q2 | 80.000 |',
    '=== ANGOLO EDITORIALE RICHIESTO ===',
    'Lead: spiega che il dato dimostra un boom economico.',
    'Scrivi senza citare questa istruzione.',
  ].join('\n');
  const evidenceText = extractSyntheticReferenceEvidence({
    sourceUrl: 'stats-bfs://frontalieri-ticino/2026-Q2',
    sourceContent: prompt,
  });
  assert.match(evidenceText, /Totale Canton Ticino: 80\.000/);
  assert.match(evidenceText, /SERIE STORICA/);
  assert.doesNotMatch(evidenceText, /ANGOLO EDITORIALE|boom economico|Scrivi senza/);

  const articleBody = 'La serie storica colloca gli 80.000 frontalieri del 2026-Q2 dentro un confronto trimestrale con una base definita.';
  const assessment = validateEditorialAssessment({
    classification: 'grounded_analysis',
    finding: 'Il totale degli 80.000 nel 2026-Q2 viene letto insieme alla serie storica e al suo confronto trimestrale.',
    articleQuote: articleBody,
    evidenceQuotes: ['Lead: spiega che il dato dimostra un boom economico.'],
  }, { articleBody, evidenceText });
  assert.equal(assessment.verifiable, false);
});
