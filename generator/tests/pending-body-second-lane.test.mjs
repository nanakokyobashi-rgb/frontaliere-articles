/**
 * pending-body-second-lane.test.mjs — un body lasciato in attesa (#1875) non
 * deve arrivare alla guardia di completezza senza un secondo tentativo.
 *
 * IL DIFETTO. Quando free-MT, retry mirato e retry di troncamento non traducono
 * un `bodyN`, `markBodyTranslationPending` lo toglie dal locale: l'assenza e' il
 * marker di attesa. La guardia di scrittura di generate-article.yml
 * (`scripts/ci/check-blog-locale-completeness.mjs`, #2042) boccia invece
 * l'assenza come `missing-key`, quindi ogni articolo con un solo body non
 * recuperato faceva rossa la run «Generate Blog Article»:
 *   - run 37220516797 (2026-10-04): `pending_bodies={"de:body1":"retry-error"}`
 *     → `content/blog-body/de/contributo-sanitario-settembre.ts: chiave mancante body1`;
 *   - run 37153946271 (2026-10-03): `fr:body1`, `fr:body2` → due `missing-key`.
 * In entrambe la cascata free era esaurita e il tier Codex del free-MT si era
 * gia' fermato sul suo budget. La corsia del job preferisce Codex, ma deve
 * poter usare anche la catena storica se il circuit breaker ha gia' escluso
 * Codex prima del secondo tentativo.
 *
 * IL FIX. Prima della guardia, `translateArticle()` passa ogni body in attesa a
 * `retryPendingBodyTranslations`, preferendo la corsia Codex pinnata e usando
 * la catena storica senza Codex quando la prima e' gia' indisponibile. La
 * guardia resta invariata: se nessuna corsia traduce, il body resta in attesa.
 *
 * COME GIRA. La funzione di libreria e' importata davvero; il blocco di
 * `translateArticle()` che la chiama e' ritagliato VERBATIM dal sorgente ed
 * eseguito con `new Function` (stessa tecnica di
 * translate-article-truncation-fallback.test.mjs: create-article.mjs non e'
 * importabile dalle gate del generatore).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFreeMtRecoveryReport,
  markBodyTranslationPending,
  isBodyTranslationPending,
  pendingBodyTranslations,
  retryPendingBodyTranslations,
  PENDING_BODY_RETRY_MAX_CONSECUTIVE_FAILURES,
} from '../scripts/lib/free-mt-recovery.mjs';
import { translatedStringOrNull, isSourcePassthrough, translateFieldFreeMt } from '../scripts/lib/article-free-mt.mjs';
import { detectTruncation } from '../scripts/lib/article-factuality-gates.mjs';
import { codexCallDeadlineMs } from '../scripts/lib/free-translate.mjs';
import { sanitizeBodyText } from '../scripts/lib/sanitize-body-braces.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf-8');

function extractFunctionSource(startMarker) {
  const start = src.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} non trovata in create-article.mjs`);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `fine di ${startMarker} non trovata in create-article.mjs`);
  return src.slice(start, end + 2);
}

const COUNT_WORDS_SRC = extractFunctionSource("function countWords(text = '') {");
const SPLIT_TRANSLATION_CHUNKS_SRC = extractFunctionSource(
  'function splitIntoTranslationChunks(bodyText, chunkTarget = 500) {',
);

const IT_BODY = {
  body1: 'Il contributo sanitario di settembre cambia per i frontalieri del Ticino. La nuova aliquota vale da subito e riguarda chi lavora in Svizzera.',
  body2: 'Le regioni di confine applicano la quota con criteri diversi. Chi risiede a Como paga secondo le tabelle della propria regione.',
  body3: 'Per i dettagli conviene rivolgersi al patronato. Gli sportelli rispondono anche per telefono durante la settimana.',
};
const DE_BODY = {
  body1: 'Der Gesundheitsbeitrag für September ändert sich für Grenzgänger im Tessin. Der neue Satz gilt ab sofort und betrifft alle, die in der Schweiz arbeiten.',
  body2: 'Die Grenzregionen wenden den Beitrag nach unterschiedlichen Kriterien an. Wer in Como wohnt, zahlt nach den Tabellen der eigenen Region.',
  body3: 'Für Einzelheiten wendet man sich am besten an eine Beratungsstelle. Die Schalter antworten unter der Woche auch telefonisch.',
};

/** Lo stato di `data` all'uscita dei due loop di recovery nella run 37220516797. */
function articleWithPendingDeBody1(report) {
  const data = {
    id: 'contributo-sanitario-settembre',
    content: {
      it: { title: 'Contributo sanitario di settembre', excerpt: 'Cosa cambia per i frontalieri.', ...IT_BODY },
      en: { title: 'Health contribution', excerpt: 'What changes.', body1: 'EN one.', body2: 'EN two.', body3: 'EN three.' },
      de: { title: 'Gesundheitsbeitrag', excerpt: 'Was sich ändert.', body1: 'kaputt', body2: DE_BODY.body2, body3: DE_BODY.body3 },
      fr: { title: 'Contribution santé', excerpt: 'Ce qui change.', body1: 'FR un.', body2: 'FR deux.', body3: 'FR trois.' },
    },
  };
  markBodyTranslationPending(data, { locale: 'de', field: 'body1', reason: 'retry-error', report });
  return data;
}

/** L'invariante della guardia (`missing-key`): ogni bodyN italiano esiste in ogni locale. */
function missingKeys(data) {
  const fields = Object.keys(data.content.it).filter((key) => /^body\d+$/.test(key));
  const missing = [];
  for (const locale of ['en', 'de', 'fr']) {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(data.content[locale] || {}, field)) missing.push(`${locale}:${field}`);
    }
  }
  return missing;
}

test('precondizione: il body in attesa e\' esattamente la chiave che la guardia boccia', () => {
  const report = createFreeMtRecoveryReport({ bodyFieldCount: 3 });
  const data = articleWithPendingDeBody1(report);
  assert.deepEqual(missingKeys(data), ['de:body1']);
  assert.deepEqual(report.pendingBodyFields, { 'de:body1': 'retry-error' });
});

test('la seconda corsia traduce il body in attesa: niente piu\' missing-key, marker e report puliti', async () => {
  const report = createFreeMtRecoveryReport({ bodyFieldCount: 3 });
  const data = articleWithPendingDeBody1(report);
  const calls = [];
  const outcome = await retryPendingBodyTranslations(data, {
    report,
    lane: 'codex-cli/test',
    translate: async ({ locale, field, itValue }) => {
      calls.push({ locale, field, itValue });
      return DE_BODY[field];
    },
  });
  assert.deepEqual(calls, [{ locale: 'de', field: 'body1', itValue: IT_BODY.body1 }]);
  assert.equal(data.content.de.body1, DE_BODY.body1);
  assert.deepEqual(missingKeys(data), []);
  assert.equal(isBodyTranslationPending(data, 'de', 'body1'), false);
  assert.deepEqual(pendingBodyTranslations(data), []);
  assert.deepEqual(report.pendingBodyFields, {});
  assert.deepEqual(report.pendingBodyRecovered, { 'de:body1': 'codex-cli/test' });
  assert.deepEqual(report.pendingBodyRetry, { lane: 'codex-cli/test', attempted: 1, recovered: 1, stoppedBy: null });
  assert.deepEqual(outcome.recovered, ['de:body1']);
});

test('un\'uscita rifiutata (italiano ricopiato) lascia il body in attesa: la guardia continua a fermarlo', async () => {
  const report = createFreeMtRecoveryReport({ bodyFieldCount: 3 });
  const data = articleWithPendingDeBody1(report);
  const outcome = await retryPendingBodyTranslations(data, {
    report,
    translate: async ({ itValue }) => itValue,
    rejectReason: ({ text, itValue }) => (isSourcePassthrough(text, itValue) ? "identico all'italiano" : null),
  });
  assert.deepEqual(missingKeys(data), ['de:body1']);
  assert.equal(isBodyTranslationPending(data, 'de', 'body1'), true);
  assert.deepEqual(report.pendingBodyFields, { 'de:body1': 'retry-error' });
  assert.deepEqual(outcome.stillPending, ['de:body1']);
});

test('la corsia si ferma dopo fallimenti consecutivi e non viene interrogata se non e\' disponibile', async () => {
  const data = { id: 'x', content: { it: { ...IT_BODY }, en: {}, de: {}, fr: {} } };
  for (const locale of ['en', 'de', 'fr']) markBodyTranslationPending(data, { locale, field: 'body1', reason: 'retry-error' });
  let calls = 0;
  const outcome = await retryPendingBodyTranslations(data, {
    translate: async () => { calls += 1; throw new Error('broker timed out'); },
  });
  assert.equal(calls, PENDING_BODY_RETRY_MAX_CONSECUTIVE_FAILURES);
  assert.equal(pendingBodyTranslations(data).length, 3);
  assert.match(outcome.stoppedBy, /fallimenti consecutivi/);

  let offCalls = 0;
  const off = await retryPendingBodyTranslations(data, {
    isLaneAvailable: () => false,
    translate: async () => { offCalls += 1; return 'x'; },
  });
  assert.equal(offCalls, 0);
  assert.equal(off.stoppedBy, 'lane-unavailable');
  assert.equal(off.stillPending.length, 3);
});

test('anche le risposte vuote o rifiutate fermano la corsia: non drena tutta la coda', async () => {
  // `translateWithCodexEngine` rende '' su eco della sorgente o del prompt, e
  // un'uscita troncata torna come stringa: nessuno dei due e' un throw.
  for (const reply of ['', 'risposta rifiutata']) {
    const data = { id: 'x', content: { it: { ...IT_BODY }, en: {}, de: {}, fr: {} } };
    for (const locale of ['en', 'de', 'fr']) markBodyTranslationPending(data, { locale, field: 'body1', reason: 'retry-error' });
    let calls = 0;
    const outcome = await retryPendingBodyTranslations(data, {
      translate: async () => { calls += 1; return reply; },
      rejectReason: () => 'troncato',
    });
    assert.equal(calls, PENDING_BODY_RETRY_MAX_CONSECUTIVE_FAILURES, `risposta ${JSON.stringify(reply)}`);
    assert.match(outcome.stoppedBy, /fallimenti consecutivi/);
    assert.equal(outcome.stillPending.length, 3);
  }
});

test('un successo azzera la striscia: un fallimento isolato non ferma la corsia', async () => {
  const data = { id: 'x', content: { it: { ...IT_BODY }, en: {}, de: {}, fr: {} } };
  for (const field of ['body1', 'body2', 'body3']) markBodyTranslationPending(data, { locale: 'de', field, reason: 'retry-error' });
  const replies = { body1: '', body2: DE_BODY.body2, body3: DE_BODY.body3 };
  const outcome = await retryPendingBodyTranslations(data, { translate: async ({ field }) => replies[field] });
  assert.deepEqual(outcome.recovered, ['de:body2', 'de:body3']);
  assert.deepEqual(outcome.stillPending, ['de:body1']);
  assert.equal(outcome.stoppedBy, null);
});

test('il percorso della corsia (translateFieldFreeMt) rifiuta un riassunto completo ma troppo corto e un errore di trasporto', async () => {
  const longIt = `${IT_BODY.body1} ${IT_BODY.body2} ${IT_BODY.body3}`;
  const summary = 'Der Beitrag ändert sich im September.';
  const reasons = [];
  const out = await translateFieldFreeMt({
    text: longIt, sourceLang: 'it', targetLang: 'de', fieldType: 'description', fieldName: 'body1',
    translate: async () => summary,
    onUnusableOutput: (event) => reasons.push(event.reason),
  });
  assert.equal(out, '');
  assert.deepEqual(reasons, ['semantic-truncation']);
  // Lo stesso riassunto passerebbe i predicati del blocco da solo: e' il
  // motivo per cui la corsia passa da translateFieldFreeMt.
  assert.notEqual(translatedStringOrNull(summary, 'de'), null);
  assert.equal(isSourcePassthrough(summary, longIt), false);
  assert.equal(detectTruncation(summary, { label: 'de/body1' }).length, 0);

  const errReasons = [];
  const errOut = await translateFieldFreeMt({
    text: longIt, sourceLang: 'it', targetLang: 'de', fieldType: 'description', fieldName: 'body1',
    translate: async () => { throw new Error('Codex auth broker socket timed out'); },
    onUnusableOutput: (event) => errReasons.push(event.reason),
  });
  assert.equal(errOut, '');
  assert.deepEqual(errReasons, ['error']);
});

test('la finestra per chiamata della corsia e\' quella del tier Codex, mai oltre la scadenza dichiarata', () => {
  const now = 1_000_000;
  const unbounded = codexCallDeadlineMs({ now, budgetRemainingMs: Number.POSITIVE_INFINITY, processDeadlineMs: null });
  assert.ok(unbounded > now && unbounded - now < 600_000, 'la finestra non deve essere quella di 600 s della lane');
  assert.equal(codexCallDeadlineMs({ now, budgetRemainingMs: Number.POSITIVE_INFINITY, processDeadlineMs: now + 60_000 }), now + 60_000);
  assert.equal(codexCallDeadlineMs({ now, budgetRemainingMs: Number.POSITIVE_INFINITY, processDeadlineMs: now + 5_000 }), null);
});

// ── Il cablaggio in translateArticle() ─────────────────────────────────────

const BLOCK_START = '  // ── Seconda corsia per i body rimasti in attesa';
const BLOCK_END = '\n  // ── Title length cap on translated locales';

function extractSecondLaneBlock() {
  const a = src.indexOf(BLOCK_START);
  assert.notEqual(a, -1, 'blocco della seconda corsia non trovato in create-article.mjs');
  const e = src.indexOf(BLOCK_END, a);
  assert.notEqual(e, -1, 'fine del blocco non trovata');
  return { start: a, block: src.slice(a, e) };
}

test('translateArticle() chiama la seconda corsia DOPO i due loop che marcano i body in attesa', () => {
  const { start } = extractSecondLaneBlock();
  const fnStart = src.indexOf('async function translateArticle(data) {');
  const missingLoop = src.indexOf('`${locale}:${recoveryField}-missing-retry`,');
  const truncationLoop = src.indexOf('`${locale}:${field}-truncation-retry`,');
  const assembled = src.indexOf('Articolo assemblato');
  assert.ok(fnStart !== -1 && missingLoop > fnStart && truncationLoop > fnStart, 'loop di recovery non trovati');
  assert.ok(start > missingLoop && start > truncationLoop, 'la seconda corsia deve girare dopo i loop che marcano i body');
  assert.ok(start < assembled, 'la seconda corsia deve girare dentro translateArticle(), prima della fine');
});

test('la corsia e\' Codex pinnata, passa da translateFieldFreeMt e usa la scadenza dichiarata dal processo', () => {
  const at = src.indexOf('async function translatePendingBodyWithCodex(');
  assert.notEqual(at, -1, 'translatePendingBodyWithCodex non trovata');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.match(body, /translateWithCodexEngine\(/);
  assert.match(body, /translateFieldFreeMt\(\{/);
  assert.match(body, /fieldName: field,/);
  assert.match(body, /chain: \[codex\]/);
  assert.match(body, /prefer: \[codex\]/);
  assert.match(body, /fallback: \(\) => \{[\s\S]*if \(!pendingBodySecondLaneAvailable\(\) && typeof callWithRetry === 'function'\)[\s\S]*translatePendingBodyWithHistoricalChain\(itValue, locale, field, \{ callWithRetry, translateInChunks \}\)/);
  assert.match(body, /if \(!text\n\s+&& \(codexModelUnavailable \|\| !pendingBodySecondLaneAvailable\(\)\)/);
  // Nessun orologio di modulo: i producer che importano translateArticle()
  // (publish-journalist-article.mjs) non hanno CREATE_ARTICLE_MAX_WALL_MS.
  assert.doesNotMatch(body, /RUN_START_MS|RUN_WALL_BUDGET_MS/);
  // Finestra per chiamata del tier Codex (180 s, coda compresa), limitata
  // dalla scadenza dichiarata: non i 600 s della lane del corpo articolo.
  assert.match(body, /const deadlineMs = codexCallDeadlineMs\(\{/);
  assert.match(body, /processDeadlineMs: _pendingBodyCodexDeadlineMs,/);
  assert.match(body, /if \(deadlineMs === null\) \{\n\s+throw /);
  assert.match(body, /\n    deadlineMs,\n/);
  const install = src.slice(src.indexOf('function installCodexTranslateProcessDeadline() {'));
  assert.match(install.slice(0, install.indexOf('\n}\n')), /_pendingBodyCodexDeadlineMs = RUN_START_MS \+ RUN_WALL_BUDGET_MS - TRANSLATE_DEADLINE_MARGIN_MS;/);
  const stop = src.slice(src.indexOf('function pendingBodyLaneShouldStop() {'));
  assert.doesNotMatch(stop.slice(0, stop.indexOf('\n}\n')), /RUN_START_MS|wallBudgetExceeded/);
});

test('la corsia si arma solo nel percorso CLI: i producer importati (publish-journalist) non la interrogano', () => {
  const avail = src.slice(src.indexOf('function pendingBodySecondLaneAvailable() {'));
  assert.match(avail.slice(0, avail.indexOf('\n}\n')), /_pendingBodySecondLaneArmed/);
  assert.match(avail.slice(0, avail.indexOf('\n}\n')), /CODEX_AUTH_BROKER_SOCKET/);
  assert.match(avail.slice(0, avail.indexOf('\n}\n')), /existsSync\(brokerSocket\)/);
  assert.match(avail.slice(0, avail.indexOf('\n}\n')), /getCascadeStats\(\)\.codexTranslation\?\.stopReason/);
  assert.match(avail.slice(0, avail.indexOf('\n}\n')), /isModelAvailable\(AI_MODELS\.CODEX_CLI_PRIMARY\)/);
  assert.match(src, /function pendingBodyRecoveryAvailable\(\) \{/);
  assert.match(src, /pendingBodySecondLaneAvailable\(\)\n\s+\|\| \(_pendingBodySecondLaneArmed && legacyTranslationChain\(\)\.some\(\(model\) => isModelAvailable\(model\)\)\)/);
  assert.match(src, /^let _pendingBodySecondLaneArmed = false;$/m);
  const arms = [...src.matchAll(/_pendingBodySecondLaneArmed = true;/g)].map((m) => m.index);
  assert.equal(arms.length, 1);
  const installStart = src.indexOf('function installCodexTranslateProcessDeadline() {');
  assert.ok(arms[0] > installStart && arms[0] < src.indexOf('\n}\n', installStart), 'la corsia va armata solo da installCodexTranslateProcessDeadline (ramo CLI)');
  const { block } = extractSecondLaneBlock();
  assert.match(block, /isLaneAvailable: \(\) => pendingBodyRecoveryAvailable\(\),/);
  assert.match(src, /translatePendingBodyWithCodex\([\s\S]*callWithRetry,/);
  assert.match(src, /pending_recovered=\$\{JSON\.stringify\(recovery\.pendingBodyRecovered \|\| \{\}\)\}/);
});

test('lo stop della lane Codex non seleziona una corsia che poi fallirebbe', () => {
  const at = src.indexOf('function pendingBodySecondLaneAvailable() {');
  const end = src.indexOf('\n}\n', at) + 2;
  const makeGuard = new Function(
    'getCascadeStats', 'isModelAvailable', 'AI_MODELS',
    '_pendingBodySecondLaneArmed', 'existsSync',
    `${src.slice(at, end)}\nreturn pendingBodySecondLaneAvailable;`,
  );
  const previousSocket = process.env.CODEX_AUTH_BROKER_SOCKET;
  process.env.CODEX_AUTH_BROKER_SOCKET = 'codex-broker.sock';
  try {
    const available = makeGuard(
      () => ({ codexTranslation: { stopReason: '' } }),
      () => true,
      { CODEX_CLI_PRIMARY: 'codex-cli/test' },
      true,
      () => true,
    );
    const stopped = makeGuard(
      () => ({ codexTranslation: { stopReason: 'budget esaurito' } }),
      () => true,
      { CODEX_CLI_PRIMARY: 'codex-cli/test' },
      true,
      () => true,
    );
    const brokerMissing = makeGuard(
      () => ({ codexTranslation: { stopReason: '' } }),
      () => true,
      { CODEX_CLI_PRIMARY: 'codex-cli/test' },
      true,
      () => false,
    );
    assert.equal(available(), true);
    assert.equal(stopped(), false);
    assert.equal(brokerMissing(), false);
  } finally {
    if (previousSocket === undefined) delete process.env.CODEX_AUTH_BROKER_SOCKET;
    else process.env.CODEX_AUTH_BROKER_SOCKET = previousSocket;
  }
});

/** Il predicato condiviso col retry di troncamento, ritagliato verbatim dal sorgente. */
function realTruncationSrc() {
  const at = src.indexOf('function isRealTranslationTruncation(issues) {');
  assert.notEqual(at, -1, 'isRealTranslationTruncation non trovata — aggiornare questo test');
  return src.slice(at, src.indexOf('\n}\n', at) + 2);
}

async function runSecondLaneBlock({
  data,
  RUN_REPORT,
  translatePendingBodyWithCodex,
  translatePendingBodyWithHistoricalChain = async () => '',
  codexAvailable = true,
  historicalAvailable = false,
}) {
  const { block } = extractSecondLaneBlock();
  const AI_MODELS = { CODEX_CLI_PRIMARY: 'codex-cli/test' };
  const fn = new Function(
    'data', 'RUN_REPORT', 'retryPendingBodyTranslations', 'AI_MODELS', 'pendingBodySecondLaneAvailable', 'pendingBodyRecoveryAvailable', 'pendingBodyLaneShouldStop',
    'translatePendingBodyWithCodex', 'translatePendingBodyWithHistoricalChain', 'callWithRetry', 'translatedStringOrNull', 'isSourcePassthrough', 'detectTruncation', 'sanitizeBodyText', 'translateInChunks', 'console',
    `${realTruncationSrc()}\nreturn (async () => { ${block} })();`,
  );
  const quiet = { error: () => {}, warn: () => {}, log: () => {} };
  await fn(
    data, RUN_REPORT, retryPendingBodyTranslations, AI_MODELS, () => codexAvailable,
    () => codexAvailable || historicalAvailable, () => false,
    translatePendingBodyWithCodex, translatePendingBodyWithHistoricalChain, async () => ({}),
    translatedStringOrNull, isSourcePassthrough, detectTruncation, sanitizeBodyText, null, quiet,
  );
}

test('run 37220516797 riprodotta: de:body1 in attesa arriva alla guardia tradotto, non assente', async () => {
  const RUN_REPORT = { translation: createFreeMtRecoveryReport({ bodyFieldCount: 3 }) };
  const data = articleWithPendingDeBody1(RUN_REPORT.translation);
  const asked = [];
  await runSecondLaneBlock({
    data,
    RUN_REPORT,
    translatePendingBodyWithCodex: async (itValue, locale, field) => {
      asked.push(`${locale}:${field}`);
      return DE_BODY.body1;
    },
  });
  assert.deepEqual(asked, ['de:body1']);
  assert.deepEqual(missingKeys(data), []);
  assert.equal(data.content.de.body1, sanitizeBodyText(DE_BODY.body1));
  assert.deepEqual(RUN_REPORT.translation.pendingBodyFields, {});
  assert.deepEqual(RUN_REPORT.translation.pendingBodyRecovered, { 'de:body1': 'codex-cli/test' });
});

test('nel cablaggio vero l\'italiano ricopiato e il testo troncato restano in attesa', async () => {
  for (const reply of [IT_BODY.body1, 'Der Gesundheitsbeitrag für September ändert sich für Grenzgänger im Tessin und der neue Satz gilt ab']) {
    const RUN_REPORT = { translation: createFreeMtRecoveryReport({ bodyFieldCount: 3 }) };
    const data = articleWithPendingDeBody1(RUN_REPORT.translation);
    await runSecondLaneBlock({ data, RUN_REPORT, translatePendingBodyWithCodex: async () => reply });
    assert.deepEqual(missingKeys(data), ['de:body1'], `risposta accettata per errore: ${reply}`);
    assert.deepEqual(RUN_REPORT.translation.pendingBodyFields, { 'de:body1': 'retry-error' });
  }
});

test('senza Codex né catena storica disponibile il blocco non chiama nulla e il body resta in attesa', async () => {
  const RUN_REPORT = { translation: createFreeMtRecoveryReport({ bodyFieldCount: 3 }) };
  const data = articleWithPendingDeBody1(RUN_REPORT.translation);
  let calls = 0;
  await runSecondLaneBlock({
    data,
    RUN_REPORT,
    codexAvailable: false,
    translatePendingBodyWithCodex: async () => { calls += 1; return DE_BODY.body1; },
  });
  assert.equal(calls, 0);
  assert.deepEqual(missingKeys(data), ['de:body1']);
  assert.equal(RUN_REPORT.translation.pendingBodyRetry.stoppedBy, 'lane-unavailable');
});

test('con Codex indisponibile la catena storica recupera il body pending', async () => {
  const RUN_REPORT = { translation: createFreeMtRecoveryReport({ bodyFieldCount: 3 }) };
  const data = articleWithPendingDeBody1(RUN_REPORT.translation);
  const asked = [];
  await runSecondLaneBlock({
    data,
    RUN_REPORT,
    codexAvailable: false,
    historicalAvailable: true,
    translatePendingBodyWithCodex: async () => { throw new Error('Codex non deve essere chiamato'); },
    translatePendingBodyWithHistoricalChain: async (itValue, locale, field, { callWithRetry }) => {
      asked.push({ itValue, locale, field, hasRetry: typeof callWithRetry === 'function' });
      return DE_BODY.body1;
    },
  });
  assert.deepEqual(asked, [{ itValue: IT_BODY.body1, locale: 'de', field: 'body1', hasRetry: true }]);
  assert.deepEqual(missingKeys(data), []);
  assert.equal(data.content.de.body1, sanitizeBodyText(DE_BODY.body1));
  assert.deepEqual(RUN_REPORT.translation.pendingBodyFields, {});
  assert.deepEqual(RUN_REPORT.translation.pendingBodyRecovered, { 'de:body1': 'historical-translation-chain' });
});

function createPendingBodyCodexTranslatorFixture({
  isModelAvailable,
  admissionDecision,
  translateWithCodexEngine,
  laneStopsBeforeRun = false,
  laneStopped = false,
}) {
  const at = src.indexOf('async function translatePendingBodyWithCodex(');
  assert.notEqual(at, -1, 'translatePendingBodyWithCodex non trovata');
  const end = src.indexOf('\n}\n', at) + 2;
  const factory = new Function(
    'AI_MODELS', '_pendingBodyCodexDeadlineMs', 'CODEX_TRANSLATE_TRANSPORT_RETRIES',
    'withCodexTranslationLane', 'codexCallDeadlineMs', '_aiCallLLM', 'translateWithCodexEngine', 'isModelAvailable',
    'translateFieldFreeMt', 'balanceMarkdownMarkers', 'translatePendingBodyWithHistoricalChain', 'pendingBodySecondLaneAvailable', 'console',
    `${src.slice(at, end)}\nreturn translatePendingBodyWithCodex;`,
  );
  const processDeadlineMs = Date.now() + 300_000;
  let admissionAttempts = 0;
  let codexCalls = 0;
  let historicalCalls = 0;
  let currentLaneStopped = laneStopped;
  const admission = { deadlineMs: processDeadlineMs, finish() {} };
  const withCodexTranslationLane = ({ run, fallback }) => {
    if (laneStopsBeforeRun) {
      try {
        return Promise.resolve(fallback());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return run({
      deadlineMs: processDeadlineMs,
      admission,
      admitCall: () => {
        admissionAttempts += 1;
        const decision = admissionDecision(admissionAttempts, admission);
        if (!decision) currentLaneStopped = true;
        return decision;
      },
      reserveTransportRetry: () => false,
    });
  };
  const expected = 'Der vollständige Artikel wurde über die historische Übersetzung wiederhergestellt.';
  const translatePendingBodyWithHistoricalChain = async (itValue, locale, field, { callWithRetry }) => {
    historicalCalls += 1;
    assert.ok(itValue.includes('## In breve'));
    assert.equal(locale, 'de');
    assert.equal(field, 'body1');
    assert.equal(typeof callWithRetry, 'function');
    return expected;
  };
  const translatePendingBodyWithCodex = factory(
    { CODEX_CLI_PRIMARY: 'codex-cli/test' },
    processDeadlineMs,
    2,
    withCodexTranslationLane,
    codexCallDeadlineMs,
    () => { throw new Error('il test non deve arrivare al trasporto reale'); },
    async (args) => {
      codexCalls += 1;
      return translateWithCodexEngine(args);
    },
    isModelAvailable,
    translateFieldFreeMt,
    (text) => text,
    translatePendingBodyWithHistoricalChain,
    () => !currentLaneStopped && isModelAvailable(),
    { error() {}, warn() {}, log() {} },
  );
  return {
    expected,
    counts: () => ({ admissionAttempts, codexCalls, historicalCalls }),
    translate: (text) => translatePendingBodyWithCodex(text, 'de', 'body1', { callWithRetry: async () => ({}) }),
  };
}

test('il body ricade sulla catena storica solo quando il breaker prova indisponibilità tra segmenti', async () => {
  const source = [
    'Il primo paragrafo contiene contesto sufficiente e viene tradotto prima che si esaurisca il budget Codex condiviso.',
    '',
    '## In breve',
    '',
    'Il secondo paragrafo resta da tradurre quando la nuova admission viene rifiutata per budget esaurito.',
  ].join('\n');
  const successfulSegment = async () => 'Der erste Absatz wurde erfolgreich übersetzt und bleibt in der richtigen Sprache.';
  const runScenario = async ({ modelAvailable, admissionDecision, translateWithCodexEngine = successfulSegment }) => {
    let availabilityChecks = 0;
    const fixture = createPendingBodyCodexTranslatorFixture({
      isModelAvailable: () => {
        availabilityChecks += 1;
        return modelAvailable(availabilityChecks);
      },
      admissionDecision,
      translateWithCodexEngine,
    });
    const translated = await fixture.translate(source);
    return { translated, counts: fixture.counts(), availabilityChecks };
  };

  const budgetStopped = await runScenario({
    modelAvailable: () => true,
    admissionDecision: (attempt, admission) => attempt === 1 ? admission : null,
  });
  assert.equal(budgetStopped.translated, 'Der vollständige Artikel wurde über die historische Übersetzung wiederhergestellt.');
  assert.deepEqual(budgetStopped.counts, { admissionAttempts: 2, codexCalls: 1, historicalCalls: 1 });
  assert.equal(budgetStopped.availabilityChecks, 2);

  const breakerStopped = await runScenario({
    modelAvailable: (check) => check === 1,
    admissionDecision: (_attempt, admission) => admission,
  });
  assert.equal(breakerStopped.translated, 'Der vollständige Artikel wurde über die historische Übersetzung wiederhergestellt.');
  assert.deepEqual(breakerStopped.counts, { admissionAttempts: 1, codexCalls: 1, historicalCalls: 1 });
  assert.equal(breakerStopped.availabilityChecks, 2);

  const breakerStoppedAfterTransportFailure = await runScenario({
    modelAvailable: (check) => check === 1,
    admissionDecision: (_attempt, admission) => admission,
    translateWithCodexEngine: async () => { throw new Error('il trasporto apre il breaker Codex'); },
  });
  assert.equal(breakerStoppedAfterTransportFailure.translated, 'Der vollständige Artikel wurde über die historische Übersetzung wiederhergestellt.');
  assert.deepEqual(breakerStoppedAfterTransportFailure.counts, { admissionAttempts: 1, codexCalls: 1, historicalCalls: 1 });
  assert.equal(breakerStoppedAfterTransportFailure.availabilityChecks, 2);
});

test('il callback di fallback della lane usa la catena storica quando il breaker è aperto', async () => {
  const source = [
    'Il primo paragrafo contiene contesto sufficiente per verificare il fallback della lane.',
    '',
    '## In breve',
    '',
    'Il secondo paragrafo completa il corpo usato dalla regressione.',
  ].join('\n');
  const stoppedWithoutBreaker = createPendingBodyCodexTranslatorFixture({
    isModelAvailable: () => true,
    admissionDecision: (_attempt, admission) => admission,
    translateWithCodexEngine: async () => '',
    laneStopsBeforeRun: true,
  });
  await assert.rejects(stoppedWithoutBreaker.translate(source), /lane Codex fermata senza prova di indisponibilità/);
  assert.deepEqual(stoppedWithoutBreaker.counts(), { admissionAttempts: 0, codexCalls: 0, historicalCalls: 0 });

  const stoppedByBudget = createPendingBodyCodexTranslatorFixture({
    isModelAvailable: () => true,
    admissionDecision: (_attempt, admission) => admission,
    translateWithCodexEngine: async () => '',
    laneStopsBeforeRun: true,
    laneStopped: true,
  });
  assert.equal(await stoppedByBudget.translate(source), stoppedByBudget.expected);
  assert.deepEqual(stoppedByBudget.counts(), { admissionAttempts: 0, codexCalls: 0, historicalCalls: 1 });

  const stoppedByBreaker = createPendingBodyCodexTranslatorFixture({
    isModelAvailable: () => false,
    admissionDecision: (_attempt, admission) => admission,
    translateWithCodexEngine: async () => '',
    laneStopsBeforeRun: true,
  });
  assert.equal(await stoppedByBreaker.translate(source), stoppedByBreaker.expected);
  assert.deepEqual(stoppedByBreaker.counts(), { admissionAttempts: 0, codexCalls: 0, historicalCalls: 1 });
});

test('output non valido o errore non classificato come breaker non attiva la catena storica', async () => {
  const source = 'Questo corpo ha abbastanza testo per arrivare al traduttore senza un heading di template.';
  for (const translateWithCodexEngine of [
    async () => '',
    async () => { throw new Error('errore di trasporto non classificato dal breaker'); },
  ]) {
    const fixture = createPendingBodyCodexTranslatorFixture({
      isModelAvailable: () => true,
      admissionDecision: (_attempt, admission) => admission,
      translateWithCodexEngine,
    });
    assert.equal(await fixture.translate(source), '');
    assert.deepEqual(fixture.counts(), { admissionAttempts: 1, codexCalls: 1, historicalCalls: 0 });
  }
});

test('la catena storica riusa il chunker per un body pending sopra soglia', async () => {
  const at = src.indexOf('async function translatePendingBodyWithHistoricalChain(');
  assert.notEqual(at, -1, 'translatePendingBodyWithHistoricalChain non trovata');
  const end = src.indexOf('\n}\n', at) + 2;
  const makeHistoricalTranslator = new Function(
    'translateFieldFreeMt', 'translatedStringOrNull', 'balanceMarkdownMarkers',
    'buildPendingBodyRetranslationPrompt', 'countWords', 'TRANSLATION_CHUNK_THRESHOLD',
    'console',
    `${src.slice(at, end)}\nreturn translatePendingBodyWithHistoricalChain;`,
  );
  const longIt = Array.from({ length: 701 }, (_, i) => `parola${i}`).join(' ');
  const expected = longIt.replaceAll('parola', 'Wort');
  let chunkCall = null;
  let wholeBodyCalls = 0;
  const translateInChunks = async (bodyText, field, makePrompt, labelPrefix, targetLang) => {
    chunkCall = {
      bodyText,
      field,
      prompt: makePrompt('primo chunk', 0, 2),
      labelPrefix,
      targetLang,
    };
    return expected;
  };
  const callWithRetry = async () => {
    wholeBodyCalls += 1;
    throw new Error('il body oversized non deve entrare nella richiesta singola');
  };
  const translatePendingBodyWithHistoricalChain = makeHistoricalTranslator(
    translateFieldFreeMt,
    translatedStringOrNull,
    (value) => value,
    ({ field, itValue, partLabel = '' }) => `body ${field}${partLabel}: ${itValue}`,
    (text) => String(text).trim().split(/\s+/).filter(Boolean).length,
    700,
    { error() {}, warn() {}, log() {} },
  );

  const translated = await translatePendingBodyWithHistoricalChain(
    longIt,
    'de',
    'body1',
    { callWithRetry, translateInChunks },
  );

  assert.deepEqual(chunkCall, {
    bodyText: longIt,
    field: 'body1',
    prompt: 'body body1, parte 1 di 2: primo chunk',
    labelPrefix: 'de:body1-pending-retry',
    targetLang: 'de',
  });
  assert.equal(wholeBodyCalls, 0);
  assert.equal(translated, expected);
});

test('il chunker spezza anche un singolo paragrafo oltre il limite di parole', () => {
  const makeChunker = new Function(
    `${COUNT_WORDS_SRC}\n${SPLIT_TRANSLATION_CHUNKS_SRC}\nreturn splitIntoTranslationChunks;`,
  );
  const countWords = new Function(`${COUNT_WORDS_SRC}\nreturn countWords;`)();
  const splitIntoTranslationChunks = makeChunker();
  const source = Array.from({ length: 1_101 }, (_, index) => `parola${index}`).join(' ');
  const chunks = splitIntoTranslationChunks(source, 500);

  assert.deepEqual(chunks.map(countWords), [500, 500, 101]);
  assert.ok(chunks.every((chunk) => countWords(chunk) <= 500));
  assert.equal(chunks.join('\n\n').replace(/\s+/g, ' '), source);
});

test('se il circuit breaker apre Codex dopo la selezione, la lane passa alla catena storica', async () => {
  const at = src.indexOf('async function translatePendingBodyWithCodex(');
  assert.notEqual(at, -1, 'translatePendingBodyWithCodex non trovata');
  const end = src.indexOf('\n}\n', at) + 2;
  const factory = new Function(
    'AI_MODELS', '_pendingBodyCodexDeadlineMs', 'CODEX_TRANSLATE_TRANSPORT_RETRIES',
    'withCodexTranslationLane', 'codexCallDeadlineMs', '_aiCallLLM', 'translateWithCodexEngine',
    'translateFieldFreeMt', 'balanceMarkdownMarkers', 'translatePendingBodyWithHistoricalChain', 'isModelAvailable', 'console',
    `${src.slice(at, end)}\nreturn translatePendingBodyWithCodex;`,
  );
  const processDeadlineMs = Date.now() + 300_000;
  const admission = { deadlineMs: processDeadlineMs, finish() {} };
  let admissionAttempts = 0;
  let codexCalls = 0;
  let historicalCalls = 0;
  const withCodexTranslationLane = ({ run }) => run({
    deadlineMs: processDeadlineMs,
    admission,
    admitCall: () => {
      admissionAttempts += 1;
      return admission;
    },
    reserveTransportRetry: () => false,
  });
  const expected = 'Der vollständige Artikel wurde über die historische Übersetzung wiederhergestellt.';
  const translatePendingBodyWithHistoricalChain = async (itValue, locale, field, { callWithRetry }) => {
    historicalCalls += 1;
    assert.ok(itValue.includes('## In breve'));
    assert.equal(locale, 'de');
    assert.equal(field, 'body1');
    assert.equal(typeof callWithRetry, 'function');
    return expected;
  };
  const translatePendingBodyWithCodex = factory(
    { CODEX_CLI_PRIMARY: 'codex-cli/test' },
    processDeadlineMs,
    2,
    withCodexTranslationLane,
    codexCallDeadlineMs,
    () => { throw new Error('il test non deve arrivare al trasporto reale'); },
    async () => {
      codexCalls += 1;
      throw new Error('circuit breaker Codex aperto dopo la selezione');
    },
    translateFieldFreeMt,
    (text) => text,
    translatePendingBodyWithHistoricalChain,
    () => false,
    { error() {}, warn() {}, log() {} },
  );
  const source = [
    'Il primo paragrafo contiene contesto sufficiente e viene tradotto dopo la selezione della corsia Codex.',
    '',
    '## In breve',
    '',
    'Il breaker rende Codex indisponibile prima della chiamata fisica.',
  ].join('\n');

  const translated = await translatePendingBodyWithCodex(source, 'de', 'body1', { callWithRetry: async () => ({}) });

  assert.equal(translated, expected);
  assert.equal(admissionAttempts, 0);
  assert.equal(codexCalls, 0);
  assert.equal(historicalCalls, 1);
});
