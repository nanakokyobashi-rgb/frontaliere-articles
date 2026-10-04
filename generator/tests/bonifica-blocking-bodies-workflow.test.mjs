/**
 * bonifica-blocking-bodies-workflow.test.mjs — l'esecutore della bonifica dei
 * body bloccanti resta un esecutore a lotti, una PR alla volta, con il
 * campione da giudicare PRIMA di ogni scrittura.
 *
 * Rosso se qualcuno mette `--apply` fisso, aggiunge un cron, toglie il guard
 * di una PR alla volta, toglie il cancello del campione della issue 7683 del
 * sito o sposta il campione dopo la scrittura. Il cancello e la rete del
 * commit si ESEGUONO con bash, non si leggono soltanto: un guard che non puo'
 * fallire per la ragione giusta e' decorativo.
 *
 * Legge il YAML come testo (nessuna dipendenza, nessuna rete).
 *
 * Run with `node --test generator/tests/bonifica-blocking-bodies-workflow.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSample, renderSampleMarkdown, localeOfKey, markdownCell } from '../scripts/bonifica-sample.mjs';
import { buildPrBody, renderSummary, statsLines, summarizeReport } from '../scripts/bonifica-report.mjs';
import { evaluateBodyContract } from '../../scripts/lib/pr-body-contract-eval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = path.join(ROOT, '.github', 'workflows', 'bonifica-blocking-bodies.yml');
const SRC = fs.readFileSync(WF, 'utf8');
const LINES = SRC.split('\n');

/** Solo le righe eseguibili: i commenti citano i difetti che il test vieta. */
const active = LINES.filter((l) => !l.trim().startsWith('#')).join('\n');

/** I passi del job, in ordine, con `if:`, `env:` e il corpo di `run: |`. */
function parseSteps() {
  const steps = [];
  let current = null;
  let inRun = false;
  let inEnv = false;
  for (const line of LINES) {
    const start = line.match(/^ {6}- name: (.+)$/);
    if (start) {
      current = { name: start[1].trim(), if: '', env: {}, run: '', uses: '' };
      steps.push(current);
      inRun = false;
      inEnv = false;
      continue;
    }
    if (!current) continue;
    if (inRun) {
      if (line.trim() === '' || line.startsWith(' '.repeat(10))) {
        current.run += `${line.slice(10)}\n`;
        continue;
      }
      inRun = false;
    }
    if (inEnv) {
      const kv = line.match(/^ {10}([A-Z_]+): (.*)$/);
      if (kv) {
        current.env[kv[1]] = kv[2];
        continue;
      }
      inEnv = false;
    }
    const ifLine = line.match(/^ {8}if: (.+)$/);
    if (ifLine) current.if = ifLine[1];
    if (/^ {8}env:\s*$/.test(line)) inEnv = true;
    if (/^ {8}run: \|\s*$/.test(line)) inRun = true;
    const single = line.match(/^ {8}run: (?!\|)(.+)$/);
    if (single) current.run += `${single[1]}\n`;
    const uses = line.match(/^ {8}uses: (.+)$/);
    if (uses) current.uses = uses[1];
  }
  return steps;
}

const STEPS = parseSteps();
const stepIndex = (pred) => STEPS.findIndex(pred);
const RETRANSLATE = /retranslate-blocking-bodies\.mjs/;

/**
 * Esegue il corpo di un passo con bash, nell'ambiente dato. `files` finisce
 * nella directory di lavoro (il checkout finto: path relativo → contenuto).
 */
function runStep(step, env, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonifica-wf-'));
  const output = path.join(dir, 'output');
  fs.writeFileSync(output, '');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  try {
    const res = spawnSync('bash', ['-c', step.run], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, GITHUB_OUTPUT: output, ...env },
      encoding: 'utf8',
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, output: fs.readFileSync(output, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('il parser vede i passi del workflow', () => {
  assert.ok(STEPS.length >= 8, `letti solo ${STEPS.length} passi: parser rotto, non il workflow`);
  assert.ok(STEPS.some((s) => RETRANSLATE.test(s.run)), 'nessun passo invoca retranslate-blocking-bodies.mjs');
});

test('il workflow invoca retranslate-blocking-bodies.mjs con --scan', () => {
  const invocations = STEPS.filter((s) => RETRANSLATE.test(s.run));
  assert.ok(invocations.length >= 1);
  assert.ok(invocations.some((s) => /--scan\b/.test(s.run)), 'nessuna invocazione usa --scan');
  // La conta prima e dopo: e' la metrica che il lotto deve far scendere.
  assert.ok(invocations.filter((s) => /--scan --count-only/.test(s.run)).length >= 2, 'manca lo stock prima o dopo');
});

test('--apply compare solo nel ramo condizionato a inputs.apply', () => {
  const applyLines = active.split('\n').filter((l) => /--apply\b/.test(l));
  assert.ok(applyLines.length >= 1, 'il workflow non puo\' piu\' scrivere: il test non guarda niente');
  for (const line of applyLines) {
    assert.match(
      line,
      /^\s*if \[ "\$APPLY" = "true" \]; then ARGS\+=\(--apply\); fi\s*$/,
      `--apply fuori dal ramo condizionato: ${line.trim()}`,
    );
  }
  // APPLY viene SOLO da inputs.apply, e nessun passo lo ridefinisce.
  const applyDefs = active.split('\n').filter((l) => /^\s*APPLY[:=]/.test(l) || /\bAPPLY=/.test(l));
  assert.deepEqual(applyDefs.map((l) => l.trim()), ['APPLY: ${{ inputs.apply }}']);
  // L'input e' booleano e falso di default.
  assert.match(SRC, /\n {6}apply:\n(?: {8}.+\n)*? {8}default: false\n(?: {8}.+\n)*? {8}type: boolean\n/);
});

test('trigger solo workflow_dispatch, nessuno schedule, concurrency senza cancellazione', () => {
  const on = SRC.match(/\non:\n([\s\S]*?)\n(?=\S)/);
  assert.ok(on, 'blocco on: non trovato');
  const triggers = on[1].split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().replace(/:.*$/, ''));
  assert.deepEqual(triggers, ['workflow_dispatch']);
  assert.doesNotMatch(active, /\bschedule:/);
  assert.doesNotMatch(active, /\bcron:/);
  assert.match(SRC, /\nconcurrency:\n {2}group: bonifica-blocking-bodies\n {2}cancel-in-progress: false\n/);
});

test('guard di una PR alla volta sul prefisso bonifica/blocking-bodies, e tutti i passi lo rispettano', () => {
  const g = stepIndex((s) => /^Guard/.test(s.name));
  assert.ok(g >= 0, 'guard assente');
  const guard = STEPS[g];
  assert.match(guard.run, /gh api --paginate/);
  assert.match(guard.run, /grep -c '\^bonifica\/blocking-bodies'/);
  assert.match(guard.run, /open_bonifiche=/);
  // Il guard sta prima di qualunque lavoro, e ogni passo successivo lo legge.
  for (const step of STEPS.slice(g + 1)) {
    assert.match(step.if, /steps\.guard\.outputs\.open_bonifiche == '0'/, `${step.name} ignora il guard`);
  }
  assert.ok(g < stepIndex((s) => RETRANSLATE.test(s.run)), 'il guard sta dopo la ri-traduzione');
});

test('il branch della PR ha il prefisso del guard e il push usa GITHUB_PAT_NANAKO', () => {
  const pr = STEPS.find((s) => /gh pr create/.test(s.run));
  assert.ok(pr, 'nessun passo apre la PR');
  assert.match(pr.run, /BRANCH="bonifica\/blocking-bodies-\$\{GITHUB_RUN_ID\}"/);
  assert.match(pr.run, /runtime_pat="\$\{GITHUB_PAT_NANAKO:-\}"/);
  assert.match(pr.run, /x-access-token:\$\{runtime_pat\}@github\.com/);
  assert.match(pr.run, /git push origin "\$BRANCH"/);
  assert.doesNotMatch(pr.run, /HEAD:/, 'la bonifica non pusha mai sul branch su cui gira');
  assert.ok(!Object.values(pr.env).some((v) => /GITHUB_TOKEN/.test(v)), 'il passo del push riceve il GITHUB_TOKEN');
  // Stessa condizione del passo che scrive: niente scrittura senza commit.
  assert.match(pr.if, /inputs\.apply == true/);
  assert.match(SRC, /persist-credentials: false/);
});

test('cancello BONIFICA_FALSE_FRIEND_SAMPLE_URL: exit 1 nel ramo apply + translation-false-friend', () => {
  const gate = STEPS.find((s) => /BONIFICA_FALSE_FRIEND_SAMPLE_URL/.test(Object.values(s.env).join(' ')));
  assert.ok(gate, 'cancello assente');
  assert.match(gate.if, /inputs\.apply == true/);
  assert.match(gate.run, /translation-false-friend/);
  assert.match(gate.run, /exit 1/);

  // Senza URL nella forma giusta il cancello non chiama neanche l'API.
  const url = 'https://github.com/valerielinc-ops/frontaliere-si-o-no/issues/7683#issuecomment-123456';
  const shapes = [
    { CODE: '', SAMPLE_URL: '', status: 1 },
    { CODE: 'translation-false-friend', SAMPLE_URL: '', status: 1 },
    { CODE: 'translation-false-friend', SAMPLE_URL: 'https://example.com/x', status: 1 },
    { CODE: 'translation-false-friend', SAMPLE_URL: url.replace('7683', '7682'), status: 1 },
    { CODE: 'leaked-prompt-scaffolding', SAMPLE_URL: '', status: 0 },
  ];
  for (const c of shapes) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bonifica-out-'));
    fs.writeFileSync(path.join(out, 'sample.md'), 'campione\n');
    const bin = fakeBin({ gh: 'exit 1' });
    try {
      const res = runStep(gate, { CODE: c.CODE, SAMPLE_URL: c.SAMPLE_URL, OUT_DIR: out, PATH: bin.PATH });
      assert.equal(res.status, c.status, `CODE=${c.CODE || '(vuoto)'} URL=${c.SAMPLE_URL || '(vuoto)'}: ${res.stdout}${res.stderr}`);
      if (c.status === 1) assert.match(res.stdout, /::error::campione #7683 non pubblicato/);
      assert.match(res.output, /^sample_verified=false$/m);
    } finally {
      bin.cleanup();
      fs.rmSync(out, { recursive: true, force: true });
    }
  }
});

/**
 * Il cancello del campione con un commento servito da un `gh` finto: il file
 * `comment` e' l'output di `gh api …/issues/comments/<id> --jq` (prima riga
 * `issue_url`, poi il body). Se manca, `gh` esce 1 come per un 404.
 */
function runSampleGate(gate, { CODE = 'translation-false-friend', SAMPLE_URL, sample = 'campione\n', comment }) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bonifica-out-'));
  fs.writeFileSync(path.join(out, 'sample.md'), sample);
  const commentFile = path.join(out, 'served-comment');
  if (comment !== undefined) fs.writeFileSync(commentFile, comment);
  const bin = fakeBin({ gh: `case "$*" in *issues/comments/123456*) cat '${commentFile}' || exit 1 ;; *) exit 1 ;; esac` });
  try {
    return { ...runStep(gate, { CODE, SAMPLE_URL, OUT_DIR: out, PATH: bin.PATH }), calls: bin.calls() };
  } finally {
    bin.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test('cancello 7683: il commento esiste, sta sulla issue 7683, cita l\'impronta del campione di QUESTA run e il tasso', () => {
  const gate = STEPS.find((s) => /BONIFICA_FALSE_FRIEND_SAMPLE_URL/.test(Object.values(s.env).join(' ')));
  assert.ok(gate, 'cancello assente');
  const url = 'https://github.com/valerielinc-ops/frontaliere-si-o-no/issues/7683#issuecomment-123456';
  const sample = '### translation-false-friend — 30 su 139\n| key | locale |\n';
  const fp = createHash('sha256').update(sample).digest('hex');
  const other = createHash('sha256').update('un altro stock\n').digest('hex');
  const on7683 = 'https://api.github.com/repos/valerielinc-ops/frontaliere-si-o-no/issues/7683';
  const judged = `Campione giudicato: impronta ${fp}\nTasso di falsi positivi: 2/30 (6,7%)\n`;
  const cases = [
    { label: 'commento inesistente (404)', comment: undefined, status: 1, why: /non leggibile/ },
    { label: 'commento su un\'altra issue', comment: `${on7683.replace('7683', '7682')}\n${judged}`, status: 1, why: /non sta sulla issue 7683/ },
    { label: 'senza impronta', comment: `${on7683}\nTasso di falsi positivi: 2/30\n`, status: 1, why: /impronta/ },
    { label: 'impronta di un altro campione', comment: `${on7683}\nimpronta ${other}\nTasso di falsi positivi: 2/30\n`, status: 1, why: /impronta/ },
    { label: 'senza tasso', comment: `${on7683}\nimpronta ${fp}\nverdetti: tutti veri\n`, status: 1, why: /tasso di falsi positivi/ },
    { label: 'campione giudicato', comment: `${on7683}\n${judged}`, status: 0 },
    { label: 'tutti i codici, campione giudicato', CODE: '', comment: `${on7683}\n${judged}`, status: 0 },
  ];
  for (const c of cases) {
    const res = runSampleGate(gate, { CODE: c.CODE ?? 'translation-false-friend', SAMPLE_URL: url, sample, comment: c.comment });
    assert.equal(res.status, c.status, `${c.label}: ${res.stdout}${res.stderr}`);
    assert.ok(res.calls.includes('gh api repos/valerielinc-ops/frontaliere-si-o-no/issues/comments/123456 --jq .issue_url, .body'), `${c.label}: ${res.calls.join('\n')}`);
    if (c.status === 1) {
      assert.match(res.stdout, /::error::campione #7683 non pubblicato/, c.label);
      assert.match(res.stdout, c.why, c.label);
      assert.match(res.output, /^sample_verified=false$/m, c.label);
    } else {
      assert.match(res.output, /^sample_verified=true$/m, c.label);
    }
  }
  // Forme deboli della stessa classe: il tasso e' `N/M` interi, 0 <= N <= M,
  // M = righe false-friend del `sample.md` di questa run; un solo valore;
  // l'impronta intera, come token a se'.
  const sample40 = '## Campione da giudicare\n\n### translation-false-friend — 40 su 139\n\n| key | locale |\n';
  const fp40 = createHash('sha256').update(sample40).digest('hex');
  const rate = (line) => `${on7683}\nimpronta ${fp40}\n${line}\n`;
  const weak = [
    { label: '«vedi issue 7683»', comment: rate('Tasso di falsi positivi: vedi issue 7683'), status: 1, why: /tasso di falsi positivi/ },
    { label: '3/40', comment: rate('Tasso di falsi positivi: 3/40 (7,5%)'), status: 0 },
    { label: 'grassetto Markdown, 0/40', comment: rate('**Tasso di falsi positivi:** 0/40'), status: 0 },
    { label: '41/40', comment: rate('Tasso di falsi positivi: 41/40'), status: 1, why: /41\/40/ },
    { label: '3/0', comment: rate('Tasso di falsi positivi: 3/0'), status: 1, why: /3\/0/ },
    { label: '«3 / quaranta»', comment: rate('Tasso di falsi positivi: 3 / quaranta'), status: 1, why: /tasso di falsi positivi/ },
    { label: 'M diverso dal campione', comment: rate('Tasso di falsi positivi: 3/30'), status: 1, why: /M=30[\s\S]*40/ },
    { label: 'cifra dopo il tasso ma non N/M', comment: rate('Tasso di falsi positivi: 7,5%'), status: 1, why: /tasso di falsi positivi/ },
    { label: 'tasso ripetuto con valori diversi', comment: rate('Tasso di falsi positivi: 3/40\nTasso di falsi positivi: 1/40'), status: 1, why: /valori diversi/ },
    { label: 'tasso ripetuto uguale', comment: rate('Tasso di falsi positivi: 3/40\n> Tasso di falsi positivi: 3/40'), status: 0 },
    { label: 'tasso valido e una riga malformata', comment: rate('Tasso di falsi positivi: 3/40\nTasso di falsi positivi: circa 3'), status: 1, why: /tasso di falsi positivi/ },
    { label: 'impronta citata in parte', comment: `${on7683}\nimpronta ${fp40.slice(0, 12)}\nTasso di falsi positivi: 3/40\n`, status: 1, why: /impronta/ },
    { label: 'impronta dentro un esadecimale piu\' lungo', comment: `${on7683}\nimpronta ab${fp40}cd\nTasso di falsi positivi: 3/40\n`, status: 1, why: /impronta/ },
  ];
  for (const c of weak) {
    const res = runSampleGate(gate, { SAMPLE_URL: url, sample: sample40, comment: c.comment });
    assert.equal(res.status, c.status, `${c.label}: ${res.stdout}${res.stderr}`);
    if (c.status === 1) {
      assert.match(res.stdout, /::error::campione #7683 non pubblicato/, c.label);
      assert.match(res.stdout, c.why, c.label);
    } else {
      assert.match(res.output, /^sample_verified=true$/m, c.label);
    }
  }
  // Senza sezione false-friend nel campione M non e' ricavabile: si ferma.
  const noSection = '## Campione da giudicare\n\n### leaked-prompt-scaffolding — 30 su 45\n';
  const fpNo = createHash('sha256').update(noSection).digest('hex');
  const res = runSampleGate(gate, { CODE: '', SAMPLE_URL: url, sample: noSection, comment: `${on7683}\nimpronta ${fpNo}\nTasso di falsi positivi: 3/30\n` });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /sezione translation-false-friend/);

  // Lotto di un altro codice: il cancello non lo ferma, ma un commento non
  // verificato resta `false` per la rete del commit.
  const other7682 = runSampleGate(gate, { CODE: 'leaked-prompt-scaffolding', SAMPLE_URL: url, sample, comment: `${on7683}\nTasso di falsi positivi: 2/30\n` });
  assert.equal(other7682.status, 0, other7682.stdout + other7682.stderr);
  assert.match(other7682.output, /^sample_verified=false$/m);
});

test('la rete del commit ferma le scritture false-friend senza campione, prima di ogni git', () => {
  const pr = STEPS.find((s) => /gh pr create/.test(s.run));
  // `git` sostituito da un comando che fallisce in modo riconoscibile: se la
  // rete non esce prima, il test lo vede.
  const blocked = runStep(pr, {
    FALSE_FRIEND_WRITTEN: '2',
    SAMPLE_VERIFIED: 'false',
    WRITTEN: '3',
    GITHUB_PAT_NANAKO: 'x',
    PATH: `${process.env.PATH}`,
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /::error::campione #7683 non pubblicato: 2 coppie false-friend/);
  const gateOrder = pr.run.indexOf('FALSE_FRIEND_WRITTEN');
  assert.ok(gateOrder >= 0 && gateOrder < pr.run.indexOf('git '), 'la rete sta dopo un comando git');
  assert.match(pr.env.SAMPLE_VERIFIED || '', /steps\.sample_gate\.outputs\.sample_verified/);
});

/**
 * Comandi finti (`git`, `node`, `gh`) che registrano ogni invocazione in un
 * file: `git diff --cached --name-only` stampa `staged` righe. Il chiamante
 * mette `bin` in testa al PATH e legge `calls()` dopo il passo.
 */
function fakeBin({ staged = 0, gh = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonifica-bin-'));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  const files = Array.from({ length: staged }, (_, i) => `content/x-${i}.json`).join('\\n');
  const script = (name, body = '') => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> '${log}'\n${body}\nexit 0\n`);
    fs.chmodSync(file, 0o755);
  };
  script('git', `if [ "$1" = diff ]; then [ -n "${files}" ] && printf '${files}\\n'; fi`);
  script('node');
  script('gh', gh);
  return {
    PATH: `${dir}:${process.env.PATH}`,
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('la rete del commit esce 1 se i file in stage non sono le coppie scritte, prima di git commit', () => {
  const pr = STEPS.find((s) => /gh pr create/.test(s.run));
  const base = { FALSE_FRIEND_WRITTEN: '0', SAMPLE_VERIFIED: 'false', GITHUB_PAT_NANAKO: 'x', GITHUB_RUN_ID: '1', REPO: 'o/r', OUT_DIR: '/tmp/x', LOCALE: 'en', RUN_URL: 'https://github.com/o/r/actions/runs/1' };
  const mismatch = fakeBin({ staged: 1 });
  try {
    const res = runStep(pr, { ...base, WRITTEN: '2', PATH: mismatch.PATH });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /::error::il report dice 2 coppie scritte ma sotto content\/ sono cambiati 1 file/);
    assert.ok(!mismatch.calls().some((c) => /^git (commit|push)\b/.test(c)), mismatch.calls().join('\n'));
    assert.ok(!mismatch.calls().some((c) => /^gh /.test(c)));
  } finally {
    mismatch.cleanup();
  }
  // Controprova: con i conti giusti il passo arriva a commit, push e PR.
  const match = fakeBin({ staged: 2 });
  try {
    const res = runStep(pr, { ...base, WRITTEN: '2', PATH: match.PATH });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const calls = match.calls();
    assert.ok(calls.some((c) => /^git commit\b/.test(c)), calls.join('\n'));
    assert.ok(calls.some((c) => c === 'git push origin bonifica/blocking-bodies-1'), calls.join('\n'));
    assert.ok(calls.some((c) => /^gh pr create\b/.test(c)), calls.join('\n'));
  } finally {
    match.cleanup();
  }
});

test('selettori che tratterebbero 0 coppie: slugs+code o code a lista escono 1 prima dello strumento', () => {
  const step = STEPS.find((s) => s.run.includes('ARGS+=(--apply)'));
  assert.ok(step, 'passo della ri-traduzione assente');
  const base = { LOCALE: 'en,de,fr', LIMIT: '20', APPLY: 'false', OUT_DIR: '/tmp/x' };
  const cases = [
    { SLUGS: 'a,b', CODE: 'translation-false-friend', status: 1, error: /slugs e code non si combinano/ },
    { SLUGS: '', CODE: 'translation-false-friend,leaked-prompt-scaffolding', status: 1, error: /code accetta un solo codice/ },
    { SLUGS: '', CODE: 'translation-false-friend', status: 0, args: /--scan --code translation-false-friend --locale en,de,fr --limit 20 --stratify/ },
    { SLUGS: 'a,b', CODE: '', status: 0, args: /--slug a,b --locale en,de,fr/ },
  ];
  for (const c of cases) {
    const bin = fakeBin();
    try {
      const res = runStep(step, { ...base, SLUGS: c.SLUGS, CODE: c.CODE, PATH: bin.PATH });
      const label = `SLUGS=${c.SLUGS || '(vuoto)'} CODE=${c.CODE || '(vuoto)'}`;
      assert.equal(res.status, c.status, `${label}: ${res.stdout}${res.stderr}`);
      const tool = bin.calls().filter((l) => RETRANSLATE.test(l));
      if (c.error) {
        assert.match(res.stdout, c.error, label);
        assert.deepEqual(tool, [], `${label}: lo strumento e' partito`);
      } else {
        assert.equal(tool.length, 1, label);
        assert.match(tool[0], c.args, label);
      }
    } finally {
      bin.cleanup();
    }
  }
});

const TOOL = 'generator/scripts/retranslate-blocking-bodies.mjs';
const GATES = 'generator/scripts/lib/article-factuality-gates.mjs';
const WITH_NX_S2 = "import { stripLeakedTitleMarker } from './lib/strip-leaked-title-marker.mjs';\n";
const WITH_MARKER = 'export const LOCALIZED_TITLE_MARKER = /x/;\n';

/**
 * Il cancello dello scaffolding con `main` servito da un `gh` finto (raw dei
 * contents) e il checkout come file nella directory di lavoro. `main: null`
 * simula l'API giu'.
 */
function runScaffoldingGate(step, { CODE = 'leaked-prompt-scaffolding', LOCALE, local, main }) {
  const served = fs.mkdtempSync(path.join(os.tmpdir(), 'bonifica-main-'));
  for (const [rel, content] of Object.entries(main || {})) {
    fs.writeFileSync(path.join(served, path.basename(rel)), content);
  }
  const gh = main === null
    ? 'exit 1'
    : `case "$*" in *contents/${TOOL}?ref=main*) cat '${served}/retranslate-blocking-bodies.mjs' || exit 1 ;; *contents/${GATES}?ref=main*) cat '${served}/article-factuality-gates.mjs' || exit 1 ;; *) exit 1 ;; esac`;
  const bin = fakeBin({ gh });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bonifica-out-'));
  try {
    return { ...runStep(step, { CODE, LOCALE, REPO: 'o/r', OUT_DIR: out, PATH: bin.PATH }, local), calls: bin.calls() };
  } finally {
    bin.cleanup();
    fs.rmSync(served, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test('cancello scaffolding 7682: NX-S2 e LOCALIZED_TITLE_MARKER dimostrati nel checkout E su main, o niente scrittura', () => {
  const g = stepIndex((s) => /LOCALIZED_TITLE_MARKER/.test(s.run));
  assert.ok(g >= 0, 'cancello dello scaffolding assente: i locali non-it possono scrivere senza il gate dei marcatori tradotti');
  const step = STEPS[g];
  assert.equal(step.if, "steps.guard.outputs.open_bonifiche == '0' && inputs.apply == true");
  assert.ok(g < stepIndex((s) => /--apply\b/.test(s.run)), 'il cancello sta dopo la scrittura');

  const all = { [TOOL]: WITH_NX_S2, [GATES]: WITH_MARKER };
  const noMarker = { [TOOL]: WITH_NX_S2, [GATES]: 'export const OTHER = 1;\n' };
  const noNxS2 = { [TOOL]: 'const x = 1;\n', [GATES]: WITH_MARKER };
  const cases = [
    { label: 'en,de,fr: gate senza marcatore su main', LOCALE: 'en,de,fr', local: all, main: noMarker, status: 1, why: /LOCALIZED_TITLE_MARKER[\s\S]*main/ },
    { label: 'en: marcatore su main ma non nel checkout', LOCALE: 'en', local: noMarker, main: all, status: 1, why: /LOCALIZED_TITLE_MARKER[\s\S]*checkout/ },
    { label: 'en: NX-S2 assente su main', LOCALE: 'en', local: all, main: noNxS2, status: 1, why: /NX-S2[\s\S]*main/ },
    { label: 'en: NX-S2 assente nel checkout', LOCALE: 'en', local: noNxS2, main: all, status: 1, why: /NX-S2[\s\S]*checkout/ },
    { label: 'en: API giu\'', LOCALE: 'en', local: all, main: null, status: 1, why: /non leggibile/ },
    { label: 'it: NX-S2 assente', LOCALE: 'it', local: noNxS2, main: noNxS2, status: 1, why: /NX-S2/ },
    { label: '"it, en": lo spazio non nasconde un locale non-it', LOCALE: 'it, en', local: noMarker, main: noMarker, status: 1, why: /LOCALIZED_TITLE_MARKER/ },
    { label: 'locale vuoto: non dimostrato italiano', LOCALE: '', local: noMarker, main: noMarker, status: 1, why: /LOCALIZED_TITLE_MARKER/ },
    { label: 'tutti i codici, en, marcatore assente', CODE: '', LOCALE: 'en', local: noMarker, main: noMarker, status: 1, why: /LOCALIZED_TITLE_MARKER/ },
    { label: 'it con NX-S2, marcatore non richiesto', LOCALE: 'it', local: noMarker, main: noMarker, status: 0 },
    { label: 'en,de,fr con entrambi', LOCALE: 'en,de,fr', local: all, main: all, status: 0 },
  ];
  for (const c of cases) {
    const res = runScaffoldingGate(step, { CODE: c.CODE ?? 'leaked-prompt-scaffolding', LOCALE: c.LOCALE, local: c.local, main: c.main });
    assert.equal(res.status, c.status, `${c.label}: ${res.stdout}${res.stderr}`);
    if (c.why) {
      assert.match(res.stdout, /::error::scaffolding/, c.label);
      assert.match(res.stdout, c.why, c.label);
    }
  }
  // Un lotto false-friend non e' toccato dal cancello, e non chiama l'API.
  const ff = runScaffoldingGate(step, { CODE: 'translation-false-friend', LOCALE: 'en', local: {}, main: null });
  assert.equal(ff.status, 0, ff.stdout + ff.stderr);
  assert.deepEqual(ff.calls.filter((l) => /^gh /.test(l)), []);
});

test('la ri-traduzione non scrive se un cancello non e\' passato, e LIMIT ha un tetto di 20 con apply', () => {
  const step = STEPS.find((s) => s.run.includes('ARGS+=(--apply)'));
  assert.ok(step, 'passo della ri-traduzione assente');
  // I cancelli arrivano al passo che scrive come esito, non come promessa.
  assert.match(step.env.SAMPLE_GATE || '', /steps\.sample_gate\.outcome/);
  assert.match(step.env.SCAFFOLDING_GATE || '', /steps\.scaffolding_gate\.outcome/);
  const ok = { SAMPLE_GATE: 'success', SCAFFOLDING_GATE: 'success' };
  const base = { LOCALE: 'en', SLUGS: '', CODE: 'translation-false-friend', OUT_DIR: '/tmp/x' };
  const cases = [
    { label: 'apply, limit 1000', APPLY: 'true', LIMIT: '1000', ...ok, status: 1, error: /limit=1000 oltre il tetto di 20/ },
    { label: 'apply, limit 21', APPLY: 'true', LIMIT: '21', ...ok, status: 1, error: /limit=21 oltre il tetto di 20/ },
    { label: 'apply, limit enorme', APPLY: 'true', LIMIT: '99999999999999999999999', ...ok, status: 1, error: /oltre il tetto di 20/ },
    { label: 'limit non intero', APPLY: 'true', LIMIT: '1e3', ...ok, status: 1, error: /intero positivo/ },
    { label: 'limit vuoto', APPLY: 'false', LIMIT: '', ...ok, status: 1, error: /intero positivo/ },
    { label: 'limit zero', APPLY: 'true', LIMIT: '0', ...ok, status: 1, error: /intero positivo/ },
    { label: 'apply, cancello del campione fallito', APPLY: 'true', LIMIT: '20', SAMPLE_GATE: 'failure', SCAFFOLDING_GATE: 'success', status: 1, error: /cancelli non superati/ },
    { label: 'apply, cancello scaffolding saltato', APPLY: 'true', LIMIT: '20', SAMPLE_GATE: 'success', SCAFFOLDING_GATE: 'skipped', status: 1, error: /cancelli non superati/ },
    { label: 'apply, cancelli assenti', APPLY: 'true', LIMIT: '20', SAMPLE_GATE: '', SCAFFOLDING_GATE: '', status: 1, error: /cancelli non superati/ },
    { label: 'apply, limit 20, cancelli passati', APPLY: 'true', LIMIT: '20', ...ok, status: 0, args: /--limit 20 --stratify .*--apply/ },
    { label: 'dry-run, limit 1000: nessuna scrittura', APPLY: 'false', LIMIT: '1000', SAMPLE_GATE: '', SCAFFOLDING_GATE: '', status: 0, args: /--limit 1000 --stratify/ },
  ];
  for (const c of cases) {
    const bin = fakeBin();
    try {
      const { label, status, error, args, ...env } = c;
      const res = runStep(step, { ...base, ...env, PATH: bin.PATH });
      assert.equal(res.status, status, `${label}: ${res.stdout}${res.stderr}`);
      const tool = bin.calls().filter((l) => RETRANSLATE.test(l));
      if (error) {
        assert.match(res.stdout, error, label);
        assert.deepEqual(tool, [], `${label}: lo strumento e' partito`);
      } else {
        assert.equal(tool.length, 1, label);
        assert.match(tool[0], args, label);
        if (env.APPLY !== 'true') assert.doesNotMatch(tool[0], /--apply/, label);
      }
    } finally {
      bin.cleanup();
    }
  }
});

test('il campione scrive sample.md ed e\' PRIMA del passo che puo\' passare --apply', () => {
  const sample = stepIndex((s) => /bonifica-sample\.mjs/.test(s.run));
  const write = stepIndex((s) => /--apply\b/.test(s.run));
  const gate = stepIndex((s) => /BONIFICA_FALSE_FRIEND_SAMPLE_URL/.test(Object.values(s.env).join(' ')));
  assert.ok(sample >= 0, 'passo del campione assente');
  assert.match(STEPS[sample].run, /--out "\$OUT_DIR\/sample\.md"/);
  assert.match(STEPS[sample].run, /--min 30/);
  assert.ok(sample < write, 'il campione sta dopo la scrittura');
  assert.ok(gate < write, 'il cancello sta dopo la scrittura');
  // Il campione arriva nel summary e nell'artifact anche se il cancello ferma la run.
  const summary = STEPS.find((s) => /bonifica-report\.mjs summary/.test(s.run));
  assert.ok(summary && /^always\(\)/.test(summary.if), 'il riepilogo non gira quando il cancello ferma la run');
  assert.match(summary.run, /--sample "\$OUT_DIR\/sample\.md"/);
  const upload = STEPS.find((s) => /upload-artifact/.test(s.uses));
  assert.ok(upload && /^always\(\)/.test(upload.if));
  assert.match(SRC, /retention-days: 30/);
});

test('gli input non sono interpolati dentro un run:', () => {
  for (const step of STEPS) {
    assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./, `${step.name}: input interpolato nel run`);
    assert.doesNotMatch(step.run, /\$\{\{\s*github\.event\.inputs\./, `${step.name}: input interpolato nel run`);
  }
});

test('permessi, timeout e niente npm ci nudo', () => {
  assert.match(SRC, /\npermissions:\n {2}contents: write\n {2}pull-requests: write\n {2}issues: read\n/);
  assert.match(SRC, /timeout-minutes: 90/);
  assert.match(active, /bash scripts\/lib\/npm-ci-retry\.sh/);
});

// ── buildSample ────────────────────────────────────────────────────────────

const DIR = 'services/locales/blog' + '-body';
function syntheticRows() {
  const rows = [];
  const add = (locale, n) => {
    for (let i = 0; i < n; i++) {
      const id = `art-${String(i).padStart(3, '0')}`;
      rows.push({
        key: `${DIR}/${locale}/${id}`,
        codes: ['translation-false-friend'],
        evidence: [{ code: 'translation-false-friend', excerpt: `border guards ${locale} ${i}` }],
      });
    }
  };
  add('en', 90);
  add('fr', 8);
  add('de', 2);
  // Ordine d'ingresso mescolato: il campione non deve dipenderne.
  return rows.reverse();
}

test('buildSample: 100 righe (en 90, fr 8, de 2) danno almeno 30 righe con tutti i locali, sempre le stesse', () => {
  const rows = syntheticRows();
  const [section] = buildSample(rows, { codes: ['translation-false-friend'], min: 30 });
  assert.equal(section.total, rows.length);
  assert.ok(section.rows.length >= 30, `campione di ${section.rows.length}`);
  assert.deepEqual([...new Set(section.rows.map((r) => r.locale))].sort(), ['de', 'en', 'fr']);
  // Proporzionale: l'inglese domina, ma non si mangia gli altri.
  const en = section.rows.filter((r) => r.locale === 'en').length;
  assert.ok(en > section.rows.length / 2);
  // Deterministico, anche con l'input in un altro ordine.
  assert.deepEqual(buildSample(rows, { codes: ['translation-false-friend'] }), [section]);
  assert.deepEqual(buildSample([...rows].reverse(), { codes: ['translation-false-friend'] }), [section]);
  // Ordinato per key, nessun doppione, estratto del codice giusto.
  const keys = section.rows.map((r) => r.key);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(section.rows.every((r) => r.excerpt.startsWith('border guards')));
});

test('buildSample: con meno righe del minimo le restituisce tutte', () => {
  const rows = syntheticRows().slice(0, 12);
  const [section] = buildSample(rows, { codes: ['translation-false-friend'], min: 30 });
  assert.equal(section.rows.length, 12);
  assert.equal(section.total, 12);
});

test('buildSample: codici vuoti = tutti i codici presenti; filtro per locale', () => {
  const rows = [
    { key: `${DIR}/en/a`, codes: ['leaked-prompt-scaffolding', 'translation-false-friend'], evidence: [{ code: 'leaked-prompt-scaffolding', excerpt: 'TITOLO ARTICOLO:' }] },
    { key: `${DIR}/it/b`, codes: ['leaked-prompt-scaffolding'], evidence: [] },
  ];
  const all = buildSample(rows, {});
  assert.deepEqual(all.map((s) => s.code), ['leaked-prompt-scaffolding', 'translation-false-friend']);
  const onlyEn = buildSample(rows, { codes: ['leaked-prompt-scaffolding'], locales: ['en'] });
  assert.deepEqual(onlyEn[0].rows.map((r) => r.key), [`${DIR}/en/a`]);
  assert.equal(onlyEn[0].rows[0].excerpt, 'TITOLO ARTICOLO:');
  assert.equal(localeOfKey(`${DIR}/fr/x`), 'fr');
});

test('renderSampleMarkdown: tabella con colonna verdetto vuota, celle che non rompono la tabella', () => {
  const md = renderSampleMarkdown(buildSample(syntheticRows(), { codes: ['translation-false-friend'] }));
  assert.match(md, /\| key \| locale \| estratto \| verdetto \(vero\/falso\) \| nota \|/);
  const dataRows = md.split('\n').filter((l) => l.startsWith(`| ${DIR}/`));
  assert.ok(dataRows.length >= 30);
  assert.ok(dataRows.every((l) => l.endsWith('|  |  |')));
  assert.equal(markdownCell('a | b\n<script>'), 'a \\| b &lt;script&gt;');
});

test('CLI del campione: JSONL in, Markdown out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonifica-sample-'));
  try {
    const input = path.join(dir, 'stock.jsonl');
    const out = path.join(dir, 'sample.md');
    fs.writeFileSync(input, `${syntheticRows().map((r) => JSON.stringify(r)).join('\n')}\n`);
    const res = spawnSync(process.execPath, [
      path.join(ROOT, 'generator/scripts/bonifica-sample.mjs'),
      '--in', input, '--code', 'translation-false-friend', '--locale', 'en,de,fr', '--out', out,
    ], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(fs.readFileSync(out, 'utf8'), /### translation-false-friend — 30 su 100/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── report, summary, body della PR ─────────────────────────────────────────

const pair = (id, extra) => ({ id, locale: 'en', dir: DIR, codes: ['translation-false-friend'], oldCodes: ['translation-false-friend'], newCodes: [], ...extra });

test('summary: una run tutta campo-vuoto lo dice in prima riga', () => {
  const report = { mode: 'apply', total: 2, results: [
    pair('a', { written: false, reason: 'campo-vuoto-dalla-cascata', missingField: 'body1' }),
    pair('b', { written: false, reason: 'campo-vuoto-dalla-cascata', missingField: 'body2' }),
  ] };
  assert.equal(summarizeReport(report).allEmpty, true);
  assert.ok(statsLines(report).includes('all_empty=true'));
  const text = renderSummary({ report, sample: '## Campione da giudicare\n' });
  assert.match(text.split('\n')[0], /Run informativa, non un successo/);
  assert.match(text, /## Campione da giudicare/);
  // Senza report (cancello) il riepilogo esce lo stesso, col campione.
  assert.match(renderSummary({ sample: '## Campione da giudicare\n' }), /Report della ri-traduzione assente[\s\S]*Campione da giudicare/);
});

test('body della PR: rispetta il contratto del corpus e conta le scritture false-friend', () => {
  const report = { mode: 'apply', total: 4, results: [
    pair('a', { written: true, reason: 'pulita' }),
    pair('b', { written: false, reason: 'ri-fallita: translation-false-friend', newCodes: ['translation-false-friend'] }),
    pair('c', { written: false, reason: 'campo-vuoto-dalla-cascata' }),
    pair('d', { written: false, reason: 'vecchia-gia-pulita', oldCodes: [] }),
  ] };
  assert.ok(statsLines(report).includes('false_friend_written=1'));
  assert.ok(statsLines(report).includes('written=1'));
  const before = { scanned: 10, byCode: { 'translation-false-friend': { it: 0, en: 3, de: 0, fr: 0, total: 3 } } };
  const after = { scanned: 10, byCode: { 'translation-false-friend': { it: 0, en: 2, de: 0, fr: 0, total: 2 } } };
  const body = buildPrBody({ report, before, after, runUrl: 'https://github.com/o/r/actions/runs/1' });
  const verdict = evaluateBodyContract(body);
  assert.equal(verdict.blocking, 0, JSON.stringify(verdict, null, 2));
  assert.match(body, /`services\/locales\/blog-body\/en\/a`: codici translation-false-friend → nessuno/);
  assert.match(body, /`services\/locales\/blog-body\/en\/b` \(translation-false-friend\) — blocked: la ri-traduzione ripete/);
  assert.match(body, /\| translation-false-friend \| 3 \| 2 \|/);
  assert.match(body, /^Addresses valerielinc-ops\/frontaliere-si-o-no#7683$/m);
  assert.doesNotMatch(body, /\b(?:Closes|Fixes|Resolves)\b/i);
});

test('body della PR: tutte scritte → Non implementato con lo stato by construction', () => {
  const body = buildPrBody({ report: { mode: 'apply', total: 1, results: [pair('a', { written: true, reason: 'pulita' })] } });
  assert.equal(evaluateBodyContract(body).blocking, 0);
  assert.match(body, /## Non implementato \(ancora\)\n\n- Nessuno\. \*\(by construction\)\*/);
});
