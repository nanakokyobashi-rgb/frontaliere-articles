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

/** Esegue il corpo di un passo con bash, nell'ambiente dato. */
function runStep(step, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonifica-wf-'));
  const output = path.join(dir, 'output');
  fs.writeFileSync(output, '');
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

  const url = 'https://github.com/valerielinc-ops/frontaliere-si-o-no/issues/7683#issuecomment-123456';
  const cases = [
    { CODE: '', SAMPLE_URL: '', status: 1 },
    { CODE: 'translation-false-friend', SAMPLE_URL: '', status: 1 },
    { CODE: 'translation-false-friend', SAMPLE_URL: 'https://example.com/x', status: 1 },
    { CODE: 'translation-false-friend', SAMPLE_URL: url.replace('7683', '7682'), status: 1 },
    { CODE: 'translation-false-friend', SAMPLE_URL: url, status: 0 },
    { CODE: '', SAMPLE_URL: url, status: 0 },
    { CODE: 'leaked-prompt-scaffolding', SAMPLE_URL: '', status: 0 },
  ];
  for (const c of cases) {
    const res = runStep(gate, { CODE: c.CODE, SAMPLE_URL: c.SAMPLE_URL });
    assert.equal(res.status, c.status, `CODE=${c.CODE || '(vuoto)'} URL=${c.SAMPLE_URL || '(vuoto)'}: ${res.stdout}${res.stderr}`);
    if (c.status === 1) assert.match(res.stdout, /::error::campione #7683 non pubblicato/);
  }
});

test('la rete del commit ferma le scritture false-friend senza campione, prima di ogni git', () => {
  const pr = STEPS.find((s) => /gh pr create/.test(s.run));
  // `git` sostituito da un comando che fallisce in modo riconoscibile: se la
  // rete non esce prima, il test lo vede.
  const blocked = runStep(pr, {
    FALSE_FRIEND_WRITTEN: '2',
    SAMPLE_URL_VALID: 'false',
    WRITTEN: '3',
    GITHUB_PAT_NANAKO: 'x',
    PATH: `${process.env.PATH}`,
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /::error::campione #7683 non pubblicato: 2 coppie false-friend/);
  const gateOrder = pr.run.indexOf('FALSE_FRIEND_WRITTEN');
  assert.ok(gateOrder >= 0 && gateOrder < pr.run.indexOf('git '), 'la rete sta dopo un comando git');
  assert.match(pr.env.SAMPLE_URL_VALID || '', /steps\.sample_gate\.outputs\.sample_url_valid/);
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
