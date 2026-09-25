/**
 * topic-gate-local-news-and-verifiers.test.mjs
 *
 * Two owner decisions of 2026-09-25, both from run 36096755072:
 *
 * 1. Local news that touches the commute or work in Ticino is frontaliere
 *    news even when the source does not say "frontalieri". Codex had aborted
 *    all eight news headlines of that run under REGOLA #0 (road closures on
 *    the SS 341 and in the Gambarogno, FFS Cargo job cuts, the cantonal
 *    budget). The three places that judge relevance must agree, or an article
 *    admitted by one is rejected by the next: the pre-spend classifier, the
 *    REGOLA #0 gate in the generation prompt, and point 11 of the fact-check.
 *
 *    Later the same day the owner widened it again: «Fai passare anche queste
 *    notizie: cronaca nera, sport, cultura e incidenti stradali» — local news
 *    of Ticino and of the provinces of Varese, Como and VCO, with or without
 *    a frontaliere angle. The same judges must agree on that too.
 *
 * 2. The fact-check must get an answer it can read. Its verifiers were
 *    gpt-4.1 and gemini-2.5-flash (GitHub Models retired, Gemini quota spent),
 *    so both fell through to the same nemotron model, which answered in prose.
 *
 * create-article.mjs cannot be imported by a test (network call at module
 * scope), so these checks read its source, like prompt-rebracket-prefer-degradata.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AI_MODELS } from '../scripts/lib/ai-models.mjs';
import { isBodyTranslationPending } from '../scripts/lib/free-mt-recovery.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'scripts', 'create-article.mjs'), 'utf8');

function frontaliereGate() {
  const start = SRC.indexOf('const topicalRelevanceGate = IS_FRONTALIERE');
  const end = SRC.indexOf('    : `═══ REGOLA #0', start);
  assert.ok(start !== -1 && end > start, 'REGOLA #0 frontaliere non trovata');
  return SRC.slice(start, end);
}

test('REGOLA #0 counts the commute, work in Ticino and the cantonal budget as a real link', () => {
  const gate = frontaliereGate();
  assert.match(gate, /anche se non nomina i frontalieri/);
  assert.match(gate, /Tragitto casa-lavoro:.*province di Varese, Como e VCO.*chiusure, cantieri, deviazioni/);
  assert.match(gate, /Lavoro in Ticino: licenziamenti, riorganizzazioni, appalti/);
  assert.match(gate, /Canton Ticino: preventivo, deficit, imposte/);
});

test('REGOLA #0 admits local cronaca, sport and culture, only in the area, and still forbids inventing the link', () => {
  // Second owner decision of 2026-09-25: «Fai passare anche queste notizie:
  // cronaca nera, sport, cultura e incidenti stradali».
  const gate = frontaliereGate();
  assert.match(gate, /- Cronaca locale in Ticino e nelle province di Varese, Como e VCO: cronaca nera, incidenti stradali, sport, cultura ed eventi/);
  assert.match(gate, /NON sono nesso reale: cronaca fuori da quest'area, eventi esteri senza impatto su tragitto o lavoro/);
  assert.doesNotMatch(gate, /NON sono nesso reale: cronaca nera, sport, cultura/);
  assert.match(gate, /NON inventare un legame con i frontalieri, quanti ne impiega un'azienda, percorsi alternativi, orari o importi/);
  assert.match(gate, /"abort_topical_relevance": true/);
});

test('the classifier, the headline selector and fact-check point 11 admit the same local news', () => {
  const start = SRC.indexOf('Sei un editor del sito frontaliereticino.ch');
  const classifier = SRC.slice(start, SRC.indexOf('HEADLINE:', start));
  assert.match(classifier, /cronaca locale in Ticino e nelle province di Varese, Como e VCO \(cronaca nera, incidenti stradali, sport, cultura ed eventi\)/);
  assert.match(classifier, /- Cronaca, sport, cultura ed eventi FUORI dal Ticino e dalle province di Varese, Como e VCO/);
  assert.doesNotMatch(classifier, /Eventi culturali, sportivi, festival, gastronomia \(anche se localizzati a Ticino/);
  assert.doesNotMatch(classifier, /Singoli episodi di cronaca \(multe, incidenti, arresti, abbandono rifiuti\)/);
  assert.doesNotMatch(classifier, /focalizzato ESCLUSIVAMENTE sui FRONTALIERI/, 'un editor «solo frontalieri» rigetterebbe la cronaca che la lista ammette');

  assert.match(SRC, /5\. CRONACA LOCALE: cronaca nera, incidenti, sport e cultura vanno bene se avvengono in Ticino o nelle province di Varese, Como e VCO; altrove no/);
  const selectorFront = SRC.slice(SRC.indexOf('5. CRONACA LOCALE:'), SRC.indexOf('${JSON_QUOTE_SAFETY_RULE_IT}', SRC.indexOf('5. CRONACA LOCALE:')));
  assert.doesNotMatch(selectorFront, /NO SPORT/);

  const p11 = SRC.slice(SRC.indexOf('**RILEVANZA TOPICA AL FRONTALIERE TICINO-ITALIA (CRITICO)**'), SRC.indexOf('**RILEVANZA TOPICA NAZIONALE SVIZZERA (CRITICO)**'));
  assert.match(p11, /cronaca locale in Ticino e nelle province di Varese, Como e VCO anche senza nesso con i frontalieri \(cronaca nera, incidenti stradali, sport, cultura ed eventi\)/);
  assert.match(p11, /cronaca, sport e cultura fuori dal Ticino e dalle province di Varese, Como e VCO/);
  assert.doesNotMatch(p11, /eventi sportivi, gossip, cultura locale non-frontaliera/);
  // Padding and a fabricated frontaliere angle still fail the article.
  assert.match(p11, /o con un angolo frontalieri che la fonte non ha, il verdetto è FAIL/);
});

test('the svizzera section keeps excluding cronaca, sport and culture', () => {
  const national = SRC.slice(SRC.indexOf('Sei un editor di un sito che informa CHIUNQUE viva o lavori in Svizzera'));
  assert.match(national.slice(0, 3000), /- Eventi culturali, sportivi, festival, gastronomia/);
  assert.match(SRC, /Esempi che NON sono nesso reale: cronaca nera senza rilevanza politico-economica/);
});

test('the post-generation density abort spares local news without a frontaliere angle', () => {
  assert.match(SRC, /if \(attempt === 1 && IS_FRONTALIERE && !isLocalNewsWithoutFrontaliereAngle\(pageContent\)\) \{/);
  assert.match(SRC, /function isLocalNewsWithoutFrontaliereAngle\(text\) \{\n\s+return isLocalNews\(text\) && checkFrontaliereDensity\(text\)\.hits === 0;/);
});

// Review of PR #1871: past the density bypass, every frontaliere-only demand
// needs a local branch too, or a robbery still gets a salary-calculator CTA
// and a «Tool consigliati» block appended after generation.
function ctaAndLinkEnforcers() {
  const start = SRC.indexOf('const CTA_KEYWORDS_IT = [');
  const end = SRC.indexOf('/** Lazy-loaded set of normalized existing IT blog titles', start);
  assert.ok(start !== -1 && end > start, 'blocco CTA/link interni non trovato');
  // The module-scope names the block reads: the two content helpers are
  // stubbed on the test's own article shape, `isBodyTranslationPending` is the
  // real one from the module create-article.mjs imports it from.
  return new Function(
    'bodyTextForQuality',
    'collectBodySections',
    'isBodyTranslationPending',
    `${SRC.slice(start, end)}\nreturn { validateAndEnforceCTA, enforceStrongInternalLinks };`,
  )(
    (content) => `${content.body1} ${content.body2} ${content.body3}`,
    (content) => ({ body1: content.body1, body2: content.body2, body3: content.body3 }),
    isBodyTranslationPending,
  );
}

function article(localNews) {
  const content = {};
  for (const locale of ['it', 'en', 'de', 'fr']) {
    content[locale] = { title: 'Rapina a Lugano', excerpt: '', body1: 'Fatti.', body2: 'Contesto.', body3: 'Seguito.' };
  }
  const data = { id: 'rapina-lugano', category: 'novita', content };
  Object.defineProperty(data, '_localNewsSource', { value: localNews, configurable: true });
  return data;
}

test('local news gets no frontaliere CTA and no tool block after generation', () => {
  const { validateAndEnforceCTA, enforceStrongInternalLinks } = ctaAndLinkEnforcers();
  const local = enforceStrongInternalLinks(validateAndEnforceCTA(article(true)));
  for (const locale of ['it', 'en', 'de', 'fr']) {
    assert.equal(local.content[locale].body2, 'Contesto.');
    assert.equal(local.content[locale].body3, 'Seguito.');
  }
  // The canton guard snapshot is still taken before the early return.
  assert.equal(typeof local._cantonGuardBodyBeforeCta, 'string');
  const frontaliere = enforceStrongInternalLinks(validateAndEnforceCTA(article(false)));
  assert.match(frontaliere.content.it.body3, /\(nav:[a-z-]+\)/);
  assert.match(frontaliere.content.it.body2, /\(nav:[a-z-]+\)/);
});

test('the flag comes from the same local-news predicate as the prompt, and is dropped after use', () => {
  const step = SRC.slice(SRC.indexOf('// Step 3d: Enforce CTA / internal links (all 4 locales)'));
  assert.match(step.slice(0, 1200), /value: IS_FRONTALIERE && isLocalNewsWithoutFrontaliereAngle\(pageContent\),/);
  assert.match(step.slice(0, 1400), /validateAndEnforceCTA\(data\);\n\s+enforceStrongInternalLinks\(data\);\n\s+delete data\._localNewsSource;/);
  assert.match(SRC, /const localNewsExpansion = IS_FRONTALIERE && isLocalNewsWithoutFrontaliereAngle\(pageContent\);\n\s+data = await expandShortItalianContent\(data, adaptiveMinWords, \{\n\s+boundToText: isStatsBfsSource,\n\s+localNews: localNewsExpansion,/);
});

test('the expansion of a local story speaks as a local reporter', () => {
  // Fifth review of PR #1871: the expansion kept the cross-border finance
  // persona, the voice that adds the procedures the local branch forbids.
  assert.match(SRC, /const expandPersona = localNews\n\s+\? 'Sei un giornalista di cronaca locale in Ticino e nelle province di Varese, Como e VCO\.'/);
  assert.match(SRC, /content: `\$\{localNews \? 'Sei un giornalista di cronaca locale\.' : 'Sei un giornalista finanziario esperto\.'\} Rispondi con il solo testo richiesto/);
});

test('the expansion of a local story passes the fact-check even on the last attempt', () => {
  // Fourth review of PR #1871: the expansion is fact-checked only before the
  // last attempt, and a local story expanded there reached the corpus with no
  // check against invented facts.
  assert.match(SRC, /if \(\(!isLastAttempt \|\| localNewsExpansion\) && expandGateResult\.passed\) \{\n\s+let expandFactOk = true;/);
});

test('the pre-spend classifier admits the same local news', () => {
  const start = SRC.indexOf('Sei un editor del sito frontaliereticino.ch');
  assert.notEqual(start, -1);
  const prompt = SRC.slice(start, SRC.indexOf('HEADLINE:', start));
  assert.match(prompt, /È RILEVANTE anche se non nomina i frontalieri: viabilità del tragitto casa-lavoro/);
  assert.match(prompt, /posti di lavoro in aziende o enti in Ticino/);
  assert.match(prompt, /finanze e politica del Canton Ticino/);
});

test('the fact-check does not fail those articles for topical relevance', () => {
  const start = SRC.indexOf('**RILEVANZA TOPICA AL FRONTALIERE TICINO-ITALIA (CRITICO)**');
  assert.notEqual(start, -1);
  const point11 = SRC.slice(start, start + 1500);
  assert.match(point11, /viabilità del tragitto casa-lavoro/);
  assert.match(point11, /mercato del lavoro ticinese anche quando la fonte non nomina i frontalieri/);
  assert.match(point11, /politica e finanze del Canton Ticino/);
});

test('the fact-check verifiers are models that answer today: two providers when Gemini has quota, two families otherwise', () => {
  const start = SRC.indexOf('const verificationCandidates = [');
  assert.notEqual(start, -1, 'lista dei verificatori non trovata');
  const list = SRC.slice(start, SRC.indexOf('].filter(Boolean);', start));
  const order = ['NV_GEMMA_4_31B', 'GEMINI_FLASH', 'NV_NEMOTRON_ULTRA', 'NV_NEMOTRON_SUPER'];
  const positions = order.map((key) => list.indexOf(`AI_MODELS.${key}`));
  assert.ok(positions.every((p) => p !== -1), `verificatori attesi: ${order.join(', ')}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'ordine dei verificatori cambiato');
  assert.doesNotMatch(list, /GPT_4_1|GPT4O/, 'GitHub Models e\' ritirato: non puo\' essere un verificatore');
  assert.equal(AI_MODELS.NV_GEMMA_4_31B, 'nvidia/google/gemma-4-31b-it');
  assert.equal(AI_MODELS.NV_NEMOTRON_ULTRA, 'nvidia/nvidia/nemotron-3-ultra-550b-a55b');
  assert.match(SRC, /availableVerifiers\.length >= 2 \? availableVerifiers : verificationCandidates/);
});

test('the consensus counts one vote per model that answered, and seeks a second opinion when two collapse', () => {
  // Review of PR #1848: the two verifiers are only starting points of the
  // cascade, so both can be served by one fallback model. Every vote goes
  // through addIndependentVote (unit-tested in fact-check-response.test.mjs).
  const start = SRC.indexOf('const modelsToQuery = verificationModels.slice(0, 2);');
  assert.notEqual(start, -1);
  // Up to the fail-closed block (the Codex fallback included): an anchor that
  // no longer exists would make indexOf return -1 and the slice run to EOF.
  const end = SRC.indexOf('if (modelResults.length === 0 || lacksSecondOpinion) {', start);
  assert.ok(end > start, 'fine del ciclo di consenso non trovata');
  const loop = SRC.slice(start, end);
  assert.doesNotMatch(loop, /modelResults\.push\(/, 'un voto aggiunto senza passare da addIndependentVote');
  assert.match(loop, /addIndependentVote\(modelResults, modelsToQuery\[i\], s\.value\)/);
  assert.match(loop, /_runSingleFactCheck\(next, prompt, \{ isEvergreen, excludeModels: voted \}\)/);
  assert.match(loop, /addIndependentVote\(modelResults, verificationModels\[2\], fallback\)/);
  const line = SRC.split('\n').find((l) => l.includes('buildFactCheckCallOptions({ model,'));
  assert.match(line, /excludeModels: opts\.excludeModels/);
});

test('a lone free vote never decides: collapsed verifiers are retried, and without a second opinion the article fails closed', () => {
  // Second review of PR #1848: after dropping the duplicate, a failed extra
  // call left one vote and the outer loop (which only retried on zero votes)
  // let a single PASS through on the very path meant to guarantee two.
  // Review of PR #1871: the same single PASS got through when one verifier
  // plainly failed. One vote that is not Codex's now fails closed.
  const start = SRC.indexOf('let missingSecondOpinion = false;');
  assert.notEqual(start, -1, 'stato del secondo parere mancante sparito');
  const region = SRC.slice(start, SRC.indexOf('// ── Drop verdicts the source itself refutes ──', start));
  assert.match(region, /fcAttempt <= FACTCHECK_INFRA_RETRIES && \(modelResults\.length === 0 \|\| missingSecondOpinion\)/);
  assert.match(region, /modelResults\.length = 0;\n\s+missingSecondOpinion = false;/, 'ogni tentativo deve ripartire da zero voti');
  assert.match(region, /if \(modelResults\.length < 2\) \{\n\s+missingSecondOpinion = true;/);
  assert.match(region, /const lacksSecondOpinion = modelResults\.length === 1 && modelResults\[0\]\.servedBy !== AI_MODELS\.CODEX_CLI_PRIMARY;/);
  assert.match(region, /if \(modelResults\.length === 0 \|\| lacksSecondOpinion\) \{/, 'un solo voto free deve chiudere come un guasto dei verificatori');
  const failClosed = region.slice(region.indexOf('if (modelResults.length === 0 || lacksSecondOpinion) {'));
  assert.match(failClosed, /passed: false,/);
  assert.match(failClosed, /unverified: true,/);
});

test('the served model survives a cache hit, and the local guard checks it', () => {
  const fn = SRC.slice(SRC.indexOf('async function _runSingleFactCheck('), SRC.indexOf('// assertNoFabricatedStatistics() REMOVED'));
  assert.match(fn, /if \(servedBy === 'cache'\) servedBy = _factCheckServedBy\.get\(servedMemoKey\) \|\| null;/);
  assert.match(fn, /if \(servedBy === AI_MODELS\.LOCAL_FALLBACK\) \{/);
  assert.doesNotMatch(fn, /if \(modelUsedRef\.model === AI_MODELS\.LOCAL_FALLBACK\)/, 'una risposta locale in cache sfuggirebbe alla guardia');
  assert.match(fn, /return \{ verdict, confidence, issues, servedBy \};/);
});

test('the fact-check asks for JSON and reads it with the balanced-object parser', () => {
  const line = SRC.split('\n').find((l) => l.includes('buildFactCheckCallOptions({ model,'));
  assert.ok(line, 'la call del fact-check e\' sparita');
  assert.match(line, /jsonMode: true/);
  assert.match(SRC, /const \{ result, error \} = extractFactCheckJson\(raw\);/);
  assert.doesNotMatch(SRC, /const jsonMatch = raw\.match\(\/\\\{\[\\s\\S\]\*\\\}\/\);/);
});
