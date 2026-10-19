const CLASSIFICATIONS = new Set([
  'grounded_analysis',
  'source_restatement',
  'unsupported_inference',
  'insufficient_evidence',
]);

const CLASSIFICATION_REASONS = Object.freeze({
  source_restatement: 'il testo riassume o parafrasa la fonte senza un contributo analitico specifico',
  unsupported_inference: 'il contributo aggiunge una causa, conseguenza o indicazione non sostenuta dalle prove disponibili',
  insufficient_evidence: 'le fonti non documentano un contributo analitico sufficiente',
});

const normalizeWhitespace = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const wordCount = value => (normalizeWhitespace(value).match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu) || []).length;
const GENERIC_FINDING_WORDS = new Set([
  'articolo', 'aspetto', 'caso', 'contributo', 'dato', 'dati', 'dimostra', 'elemento',
  'fatto', 'importante', 'indica', 'interessante', 'locale', 'lettore', 'lettori',
  'mostra', 'notizia', 'popolazione', 'relazione', 'rilevante', 'situazione', 'testo',
  'utile', 'valore', 'fonte', 'significativo', 'significativa', 'racconta', 'spiega',
]);

function evidenceAnchors(value) {
  const tokens = normalizeWhitespace(value).toLocaleLowerCase('it').match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu) || [];
  return new Set(tokens.filter(token =>
    /\p{N}/u.test(token) || (token.length >= 5 && !GENERIC_FINDING_WORDS.has(token)),
  ));
}

function countSharedAnchors(left, right) {
  const rightAnchors = evidenceAnchors(right);
  return [...evidenceAnchors(left)].filter(token => rightAnchors.has(token)).length;
}

function exactQuoteIn(text, quote) {
  const normalizedText = normalizeWhitespace(text);
  const normalizedQuote = normalizeWhitespace(quote);
  return normalizedQuote.length > 0 && normalizedText.includes(normalizedQuote);
}

/**
 * Return only the authoritative material from generator-created references.
 * Prompt instructions, target keywords, and suggested editorial angles are
 * deliberately excluded so they can never serve as evidence for an article.
 *
 * @param {{sourceUrl?: string, sourceContent?: string, evergreenBrief?: string}} input
 * @returns {string}
 */
export function extractSyntheticReferenceEvidence({ sourceUrl = '', sourceContent = '', evergreenBrief = '' } = {}) {
  if (typeof sourceUrl !== 'string') return '';
  if (sourceUrl.startsWith('stats-bfs://') || sourceUrl.startsWith('stats-astra://')) {
    if (typeof sourceContent !== 'string') return '';
    const editorialAngleMarker = '=== ANGOLO EDITORIALE RICHIESTO ===';
    const markerIndex = sourceContent.indexOf(editorialAngleMarker);
    return markerIndex > 0 ? sourceContent.slice(0, markerIndex).trim() : '';
  }
  if (sourceUrl.startsWith('evergreen://')) {
    return typeof evergreenBrief === 'string' ? evergreenBrief.trim() : '';
  }
  return '';
}

/**
 * Validate an independent fact-checker's editorial assessment against the
 * exact article and evidence text it was shown. A label or boolean alone is
 * never accepted: the checker must provide an article passage, a source or
 * reference passage, and a specific explanation, all verifiable by string
 * containment before its semantic classification is considered.
 *
 * @param {unknown} assessment
 * @param {{articleBody?: string, evidenceText?: string}} context
 * @returns {{passed: boolean, verifiable: boolean, classification: string, reason?: string, articleQuote?: string, evidenceQuotes?: string[]}}
 */
export function validateEditorialAssessment(assessment, { articleBody = '', evidenceText = '' } = {}) {
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) {
    return { passed: false, verifiable: false, classification: 'missing_assessment', reason: 'il fact-check non ha fornito una valutazione editoriale strutturata' };
  }

  const classification = typeof assessment.classification === 'string'
    ? assessment.classification.trim().toLowerCase() : '';
  if (!CLASSIFICATIONS.has(classification)) {
    return { passed: false, verifiable: false, classification: 'invalid_assessment', reason: 'la valutazione editoriale non usa una classificazione ammessa' };
  }

  const articleQuote = typeof assessment.articleQuote === 'string' ? assessment.articleQuote.trim() : '';
  if (articleQuote.length < 40 || wordCount(articleQuote) < 7 || !exactQuoteIn(articleBody, articleQuote)) {
    return { passed: false, verifiable: false, classification, reason: 'manca una citazione precisa e verificabile del contributo nel corpo dell’articolo' };
  }

  const evidenceQuotes = Array.isArray(assessment.evidenceQuotes)
    ? assessment.evidenceQuotes.filter(quote => typeof quote === 'string').map(quote => quote.trim()).slice(0, 4)
    : [];
  const supportedQuotes = evidenceQuotes.filter(quote => quote.length >= 16 && exactQuoteIn(evidenceText, quote));
  if (supportedQuotes.length === 0) {
    return { passed: false, verifiable: false, classification, articleQuote,
      reason: 'manca una citazione esatta della fonte o di un riferimento verificato che sostenga l’analisi' };
  }

  const finding = typeof assessment.finding === 'string' ? normalizeWhitespace(assessment.finding) : '';
  if (finding.length < 35 || wordCount(finding) < 6) {
    return { passed: false, verifiable: false, classification, articleQuote, evidenceQuotes: supportedQuotes,
      reason: 'la spiegazione del contributo è vaga o troppo breve per mostrare quale relazione documentata aggiunge' };
  }

  if (classification !== 'grounded_analysis') {
    return { passed: false, verifiable: true, classification, articleQuote, evidenceQuotes: supportedQuotes,
      reason: CLASSIFICATION_REASONS[classification] };
  }

  // `finding` is written in Italian and the article body is Italian, so this
  // overlap only filters generic explanations. Source evidence is required to
  // be an exact quote, but can be German/French while the reported analysis is
  // translated; a second lexical overlap there would reject grounded work.
  const articleAnchors = countSharedAnchors(finding, articleQuote);
  if (articleAnchors < 2) {
    return { passed: false, verifiable: true, classification, articleQuote, evidenceQuotes: supportedQuotes,
      reason: 'la spiegazione non collega il contributo a dettagli specifici e rintracciabili nel testo dell’articolo' };
  }

  const articleQuoteNormalized = normalizeWhitespace(articleQuote);
  if (supportedQuotes.some(quote => normalizeWhitespace(quote).includes(articleQuoteNormalized))) {
    return { passed: false, verifiable: true, classification, articleQuote, evidenceQuotes: supportedQuotes,
      reason: 'la citazione usata come prova del contributo è già presente nella fonte e non dimostra un’analisi aggiunta' };
  }

  return { passed: true, verifiable: true, classification, articleQuote, evidenceQuotes: supportedQuotes };
}

/** Convert a failed editorial assessment to the retry contract used by the generator. */
export function editorialOriginalityIssue(result) {
  const articleQuote = result?.articleQuote || '';
  return {
    code: 'editorial_originality',
    claim: articleQuote ? articleQuote.slice(0, 180) : '(contributo editoriale non dimostrato)',
    reason: `Originalità editoriale: ${result?.reason || 'la valutazione non è verificabile'}`,
    severity: 'critical',
    category: 'coerenza',
    fix: 'Rivedi body1–body3: vai oltre la riformulazione della fonte con una spiegazione, un confronto o una relazione concreta verificabile nei fatti citati. Riporta la base e il periodo del confronto. Non inventare cause, conseguenze, consigli fiscali, reportage sul posto, interviste o verifiche umane; attribuisci alla fonte le sue notizie. Se le prove non bastano, restringi il testo ai fatti documentati e non aggiungere un angolo artificiale.',
  };
}
