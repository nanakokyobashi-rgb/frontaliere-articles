/**
 * Effort di Codex scelto per tier (trasporto adattato del sito #9301).
 *
 * Il tier cambiava solo lo SCOPE della review mentre l'action passava sempre
 * `model_reasoning_effort=max`. Ora `tests.yml` emette un `effort` per tier e
 * lo passa all'action, che lo valida contro un insieme chiuso.
 *
 * Il rischio che questi test sorvegliano non e' «la riga e' cambiata»: e'
 * che i TRE punti del contratto divergano fra loro. La mappa tier→effort vive
 * in bash dentro lo YAML, l'insieme ammesso vive due volte (un `case` in
 * `action.yml` e `CODEX_ALLOWED_EFFORTS` in `claude-codex-fallback.mjs`), e il
 * review gate rifiuta l'evidenza se l'effort non e' nell'insieme JS. Se il
 * `case` si allarga senza che l'insieme JS lo segua, la review gira con un
 * effort che il gate poi scarta: run spesa, verdetto buttato. Per questo la
 * mappa viene ESEGUITA e i due insiemi confrontati, non cercati con un grep.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CODEX_ALLOWED_EFFORTS,
  CODEX_FALLBACK_EFFORT,
  FALLBACK_STATUS,
  FALLBACK_TRIGGER,
  formatCodexFallbackEvidence,
  parseCodexFallbackEvidence,
} from '../../scripts/ci/claude-codex-fallback.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WORKFLOW = '.github/workflows/tests.yml';
const ACTION = '.github/actions/claude-codex-fallback/action.yml';

/** Estrae il corpo della funzione `set_tier` cosi' com'e' scritto nello YAML. */
function extractSetTier(text) {
  const start = text.indexOf('          set_tier() {');
  assert.notEqual(start, -1, `${WORKFLOW}: funzione set_tier non trovata nello step tier`);
  const end = text.indexOf('\n          }\n', start);
  assert.notEqual(end, -1, `${WORKFLOW}: chiusura di set_tier non trovata`);
  return text
    .slice(start, end + '\n          }'.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

test('la mappa tier→effort di tests.yml, ESEGUITA, da max solo ai tier alti', () => {
  const setTier = extractSetTier(read(WORKFLOW));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-tier-'));
  try {
    const expected = {
      high: 'max',
      'high-mega': 'max',
      normal: 'high',
      minimal: 'high',
      incremental: 'high',
      'incremental-high': 'high',
      'tests-only': 'high',
    };
    for (const [tier, effort] of Object.entries(expected)) {
      const outFile = path.join(dir, `out-${tier}`);
      fs.writeFileSync(outFile, '');
      const script = `set -euo pipefail\nGITHUB_OUTPUT=${JSON.stringify(outFile)}\n${setTier}\nset_tier ${JSON.stringify(tier)} gpt-5.6-luna 35\n`;
      execFileSync('bash', ['-c', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      const out = fs.readFileSync(outFile, 'utf8');
      assert.match(out, new RegExp(`^tier=${tier.replace(/[-]/g, '\\-')}$`, 'm'), `tier ${tier}: output tier assente`);
      assert.match(out, new RegExp(`^effort=${effort}$`, 'm'),
        `tier ${tier}: atteso effort=${effort}, output:\n${out}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ogni effort emesso dal tier e\' ammesso dall\'insieme chiuso condiviso', () => {
  const setTier = extractSetTier(read(WORKFLOW));
  const emitted = new Set(['max', 'high']);
  for (const value of emitted) {
    assert.ok(CODEX_ALLOWED_EFFORTS.includes(value),
      `set_tier puo' emettere effort=${value}, ma CODEX_ALLOWED_EFFORTS non lo ammette: l'evidenza sarebbe invalida e il gate scarterebbe la review`);
  }
  // Il `case` dell'action e l'insieme JS devono coincidere: se uno dei due si
  // allarga da solo, la run gira con un effort che l'altro rifiuta.
  const action = read(ACTION);
  const arm = /^\s*(.+?)\)\s*;;\s*$/mu.exec(
    action.split('case "$codex_reasoning_effort" in')[1]?.split('esac')[0] ?? '',
  );
  assert.ok(arm, `${ACTION}: case di validazione dell'effort non trovato`);
  const shellAllowed = arm[1].split('|').map((value) => value.trim()).sort();
  assert.deepEqual(shellAllowed, [...CODEX_ALLOWED_EFFORTS].sort(),
    'il case bash di action.yml e CODEX_ALLOWED_EFFORTS devono ammettere lo stesso insieme');
  // Il default deve restare `max`: un output mancante non puo' ABBASSARE
  // l'effort di una review funnel-critical.
  assert.match(action, /model_reasoning_effort=\$codex_reasoning_effort/u,
    `${ACTION}: l'effort non e' piu' parametrico`);
  assert.match(action, /codex_reasoning_effort="\$\{CODEX_REASONING_EFFORT:-max\}"/u,
    `${ACTION}: il default dell'effort non e' max`);
  assert.match(action, /reasoning_effort:\n\s+description:[\s\S]*?\n\s+default: "max"/u,
    `${ACTION}: l'input reasoning_effort non ha default "max"`);
  assert.match(action, /EVIDENCE_EFFORT="\$\{CODEX_REASONING_EFFORT:-max\}"/u,
    `${ACTION}: l'effort non viene registrato nell'evidenza strutturata`);
});

test('tests.yml passa l\'effort del tier e ricade su max quando lo step non lo emette', () => {
  const workflow = read(WORKFLOW);
  assert.match(workflow, /reasoning_effort: \$\{\{ steps\.tier\.outputs\.effort \|\| 'max' \}\}/u,
    `${WORKFLOW}: la review non passa l'effort del tier con fallback a max`);
});

test('l\'evidenza sintetica del ramo max-turns registra l\'effort REALE', () => {
  // Il percorso `max_turns` pubblica la review e poi fabbrica l'evidenza da
  // solo. Senza EVIDENCE_EFFORT scriveva il default `max` anche su una run
  // girata a `high`: telemetria falsa esattamente sul percorso in cui si
  // vuole capire se l'effort ridotto ha causato la morte al cap.
  const workflow = read(WORKFLOW);
  assert.match(workflow, /REVIEW_EFFORT: \$\{\{ steps\.tier\.outputs\.effort \}\}/u,
    `${WORKFLOW}: lo step di classificazione non riceve l'effort del tier`);
  assert.match(workflow, /EVIDENCE_EFFORT="\$\{REVIEW_EFFORT:-max\}"/u,
    `${WORKFLOW}: l'evidenza sintetica non registra l'effort reale della run`);
});

test('nessun altro chiamante dell\'action abbassa l\'effort', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const callers = fs.readdirSync(dir)
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((name) => `.github/workflows/${name}`)
    .filter((rel) => /uses:\s*\.\/\.github\/actions\/claude-codex-fallback\s*$/mu.test(read(rel)));
  assert.ok(callers.includes(WORKFLOW), 'tests.yml deve risultare fra i chiamanti dell\'action');
  for (const rel of callers) {
    if (rel === WORKFLOW) continue;
    assert.ok(!/^\s*reasoning_effort:/mu.test(read(rel)),
      `${rel}: questo chiamante non ha una misura che giustifichi un effort ridotto, deve restare sul default max`);
  }
});

test('l\'evidenza registra l\'effort e rifiuta un valore fuori insieme', () => {
  const high = formatCodexFallbackEvidence({
    trigger: FALLBACK_TRIGGER.PREFLIGHT_QUOTA,
    status: FALLBACK_STATUS.SUCCESS,
    effort: 'high',
  });
  assert.equal(parseCodexFallbackEvidence(high)?.effort, 'high');
  assert.equal(parseCodexFallbackEvidence(high.replace('"effort":"high"', '"effort":"low"')), null);
  assert.throws(() => formatCodexFallbackEvidence({
    trigger: FALLBACK_TRIGGER.PREFLIGHT_QUOTA,
    status: FALLBACK_STATUS.SUCCESS,
    effort: 'medium',
  }), /effort/u);
  const byDefault = formatCodexFallbackEvidence({
    trigger: FALLBACK_TRIGGER.PREFLIGHT_QUOTA,
    status: FALLBACK_STATUS.SUCCESS,
  });
  assert.equal(parseCodexFallbackEvidence(byDefault)?.effort, CODEX_FALLBACK_EFFORT);
  assert.equal(CODEX_FALLBACK_EFFORT, 'max');
});
