import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const createArticle = fs.readFileSync(path.join(ROOT, 'generator', 'scripts', 'create-article.mjs'), 'utf8');
const loadRemoteConfig = fs.readFileSync(path.join(ROOT, 'generator', 'scripts', 'load-rc-env.mjs'), 'utf8');

test('il gate pre-spend usa Decisions API solo dietro flag e conserva il percorso LLM storico', () => {
  assert.match(createArticle, /import \{ classifyWithDecisionsApi \} from '\.\/lib\/decisions-api\.mjs';/);
  assert.match(createArticle, /process\.env\.DECISION_API_ENABLED === '1'/);
  assert.match(createArticle, /tryDecisionsApiClassifier\(prompt, classifierCallTimeout, SECTION_NAME\)/);
  assert.match(createArticle, /timeoutMs,\n\s*\}\);/);
  assert.match(createArticle, /PRESPEND_DECISION_API_FALLBACK/);

  const decisionCall = createArticle.indexOf('return await classifyWithDecisionsApi(');
  const decisionBranch = createArticle.indexOf('const decision = await tryDecisionsApiClassifier(');
  const legacyCall = createArticle.indexOf('text = await _aiCallLLM(', decisionBranch);
  assert.ok(decisionCall >= 0, 'la chiamata Decisions API non è cablata');
  assert.ok(legacyCall > decisionBranch, 'il classifier LLM storico deve restare il fallback');
});

test('Remote Config espone chiave server-only e flag di rollout', () => {
  assert.match(loadRemoteConfig, /DECISION_API_KEY:\s+\['DECISION_API_KEY'\]/);
  assert.match(loadRemoteConfig, /DECISION_API_ENABLED:\s+\['DECISION_API_ENABLED'\]/);
  assert.match(loadRemoteConfig, /'DECISION_API_ENABLED'/);
  assert.doesNotMatch(loadRemoteConfig, /DECISION_API_KEY:\s+\['[^']*VITE_/);
});

const classifierSource = createArticle.match(/^async function _classifyFrontaliereRelevanceUncached\([\s\S]*?^}/m)[0];
const apiWrapperSource = createArticle.match(/^async function tryDecisionsApiClassifier\([\s\S]*?^}/m)[0];

function makeClassifier({
  section = 'canton',
  decisions = [],
  apiElapsedMs = 0,
  text = async () => 'relevant=yes; reason=pertinente',
} = {}) {
  let now = 0;
  const apiCalls = [];
  const textCalls = [];
  const logs = [];
  const classify = new Function('deps', `
    const {
      Date, process, console, SECTION_NAME, IS_CANTON, classifyWithDecisionsApi, _aiCallLLM,
    } = deps;
    const AI_MODELS = { CODEX_CLI_PRIMARY: 'stub' };
    const CANTON_PRESPEND_CLASSIFIER_TIMEOUT_MS = 10_000;
    const IS_FRONTALIERE = false;
    const SECTION_PROFILE = {};
    const classifierSourceHint = () => '';
    const cantonClassifierPrompt = () => 'prompt di prova';
    let _decisionApiCircuitOpen = false;
    let _decisionApiMissingKeyLogged = false;
    ${classifierSource}
    ${apiWrapperSource}
    return _classifyFrontaliereRelevanceUncached;
  `)({
    Date: { now: () => now },
    process: { env: { DECISION_API_ENABLED: '1', DECISION_API_KEY: 'stub' } },
    console: { error: (line) => logs.push(line) },
    SECTION_NAME: section,
    IS_CANTON: section === 'canton',
    classifyWithDecisionsApi: async ({ timeoutMs }) => {
      apiCalls.push(timeoutMs);
      now += apiElapsedMs;
      return decisions[apiCalls.length - 1];
    },
    _aiCallLLM: async (_, options) => {
      textCalls.push(options);
      return text();
    },
  });
  return {
    classify: () => classify('Titolo di prova', '', '', 10_000),
    apiCalls,
    textCalls,
    logs,
  };
}

const uncertainLog = 'PRESPEND_DECISION_API_FALLBACK section=canton code=DECISIONS_API_UNCERTAIN_NEGATIVE';
const negative = (confidence) => ({ relevant: false, parsed: true, reason: 'verdetto API', confidence });

for (const confidence of [0.12, 0.5, null, undefined, 1.01, Infinity, '0.9']) {
  test(`un no cantonale con confidenza ${confidence} può essere ribaltato dal testo`, async () => {
    const { classify, apiCalls, textCalls, logs } = makeClassifier({ decisions: [negative(confidence)] });
    assert.deepEqual(await classify(), { relevant: true, reason: 'pertinente', parsed: true });
    assert.deepEqual(apiCalls, [10_000]);
    assert.equal(textCalls.length, 1);
    assert.deepEqual(logs, [uncertainLog]);
  });
}

test('il no nazionale a bassa confidenza richiede un verdetto testuale esplicito', async () => {
  const decision = negative(0.26);
  for (const response of ['relevant=yes; reason=elezione federale', 'risposta senza verdetto']) {
    const { classify, apiCalls, textCalls, logs } = makeClassifier({
      section: 'svizzera', decisions: [decision], text: async () => response,
    });
    const expected = response.startsWith('relevant=yes')
      ? { relevant: true, reason: 'elezione federale', parsed: true }
      : decision;
    assert.deepEqual(await classify(), expected);
    assert.deepEqual(apiCalls, [10_000]);
    assert.equal(textCalls.length, 1);
    assert.deepEqual(logs, [uncertainLog.replace('section=canton', 'section=svizzera')]);
  }
});

test('il fallback usa il no testuale e i tre secondi rimasti sulla deadline originale', async () => {
  const { classify, apiCalls, textCalls } = makeClassifier({
    decisions: [negative(0.12)],
    apiElapsedMs: 7_000,
    text: async () => 'relevant=FALSE; reason=fuori tema',
  });
  assert.deepEqual(await classify(), { relevant: false, reason: 'fuori tema', parsed: true });
  assert.deepEqual(apiCalls, [10_000]);
  assert.equal(textCalls.length, 1);
  assert.equal(textCalls[0].timeout, 3_000);
  assert.equal(textCalls[0].deadlineMs, 10_000);
});

test('un risultato di riserva irriconoscibile o un errore conserva il no originario', async () => {
  const decision = negative(0.12);
  for (const text of [
    async () => null,
    async () => ({ text: 'relevant=yes' }),
    async () => 'nessun verdetto',
    async () => 'relevant=yesterday',
    async () => 'relevant=nope',
    async () => 'not_relevant=yes',
    async () => 'qualcosa relevant=yes',
    async () => 'relevant=yes\nrelevant=no',
    async () => 'relevant=yes; relevant=no',
    async () => 'relevant=yes; reason=pertinente; RELEVANT = no',
    async () => 'relevant=yes; reason=prima riga\u2028seconda riga',
    async () => { throw new Error('errore di prova'); },
  ]) {
    const { classify, textCalls } = makeClassifier({ decisions: [decision], text });
    assert.equal(await classify(), decision);
    assert.equal(textCalls.length, 1);
  }
});

test('un solo verdetto esplicito può ribaltare il no incerto con o senza motivo', async () => {
  for (const [text, reason] of [
    [' \nrelevant=yes\n ', 'relevant=yes'],
    ['RELEVANT = SÌ ; reason = pertinente; utile al cantone', 'pertinente; utile al cantone'],
  ]) {
    const { classify } = makeClassifier({ decisions: [negative(0.12)], text: async () => text });
    assert.deepEqual(await classify(), { relevant: true, reason, parsed: true });
  }
});

test('con meno di un millisecondo residuo il percorso testuale non parte', async () => {
  const decision = negative(0.12);
  for (const apiElapsedMs of [9_999.5, 10_000]) {
    for (const priorDecision of [decision, null]) {
      const { classify, apiCalls, textCalls } = makeClassifier({ decisions: [priorDecision], apiElapsedMs });
      const result = await classify();
      if (priorDecision) {
        assert.equal(result, priorDecision);
      } else {
        assert.deepEqual(result, { relevant: true, reason: 'classifier-deadline-exceeded', fromError: true });
      }
      assert.deepEqual(apiCalls, [10_000]);
      assert.deepEqual(textCalls, []);
    }
  }
});

test('un verdetto positivo, un no affidabile o un no frontaliere sono conclusivi', async () => {
  for (const [section, decision] of [
    ['canton', negative(0.9)],
    ['canton', negative(1)],
    ['canton', { ...negative(0.12), relevant: true }],
    ['svizzera', negative(0.74)],
    ['frontaliere', negative(0.12)],
  ]) {
    const { classify, apiCalls, textCalls, logs } = makeClassifier({ section, decisions: [decision] });
    assert.equal(await classify(), decision);
    assert.deepEqual(apiCalls, [10_000]);
    assert.deepEqual(textCalls, []);
    assert.deepEqual(logs, []);
  }
});

test('un no incerto lascia Decisions API disponibile per la classificazione successiva', async () => {
  const decision = negative(0.9);
  const { classify, apiCalls, textCalls, logs } = makeClassifier({ decisions: [negative(0.12), decision] });
  assert.equal((await classify()).relevant, true);
  assert.equal(await classify(), decision);
  assert.deepEqual(apiCalls, [10_000, 10_000]);
  assert.equal(textCalls.length, 1);
  assert.deepEqual(logs, [uncertainLog]);
});

test('senza un no precedente, un errore o un testo irriconoscibile mantiene il fail-open', async () => {
  const unrecognized = makeClassifier({ text: async () => 'nessun verdetto' });
  assert.deepEqual(await unrecognized.classify(), { relevant: true, reason: 'nessun verdetto', parsed: false });

  const failed = makeClassifier({ text: async () => { throw new Error('errore di prova'); } });
  assert.deepEqual(await failed.classify(), {
    relevant: true,
    reason: 'classifier-error: errore di prova',
    fromError: true,
  });
});

test('senza un no precedente, il parser storico accetta un verdetto nel testo libero', async () => {
  const { classify } = makeClassifier({ text: async () => 'Verdetto: relevant=no; reason=fuori tema' });
  assert.deepEqual(await classify(), { relevant: false, reason: 'fuori tema', parsed: true });
});
