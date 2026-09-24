/**
 * haiku-lane-disabled.test.mjs — la lane Claude Haiku e' spenta NEL CODICE.
 *
 * Decisione del proprietario del 2026-09-24: «Disattiva haiku! Voglio solo
 * codex». Il kill-switch di Remote Config (ENABLE_HAIKU_ARTICLE_FALLBACK) non
 * basta: e' anche il gate storico della lane Codex, quindi in produzione vale
 * `true`, e il token Claude esiste nei secret del repo. Questo file pinna che
 * `claude-cli/haiku` non esce MAI, con flag, gate e token tutti presenti, da
 * nessuna delle porte da cui un modello entra in una chiamata: disponibilita',
 * `prefer` per-chiamata, `AI_MODELS_PREFER`, `model`/`chain` espliciti. E che
 * nel frattempo Codex resta disponibile alle stesse condizioni.
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AI_MODELS,
  callLLM,
  getPreferredModel,
  isModelAvailable,
  resetState,
} from '../scripts/lib/ai-models.mjs';

const HAIKU = AI_MODELS.CLAUDE_CLI_HAIKU;
const CODEX = AI_MODELS.CODEX_CLI_PRIMARY;
const RIVALE = 'nvidia/meta/llama-3.1-8b-instruct';

const ENV_KEYS = [
  'CODEX_ARTICLE_LANE_GATE',
  'ENABLE_HAIKU_ARTICLE_FALLBACK',
  'ENABLE_CODEX_ARTICLE_FALLBACK',
  'CODEX_AUTH_BROKER_SOCKET',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CLI_BIN',
  'AI_MODELS_PREFER',
  'AI_MODELS_FORCE_CHAIN',
  'NVIDIA_API_KEY',
];
let envBackup = {};
let tempDir = '';
let marker = '';

beforeEach(() => {
  envBackup = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  resetState();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haiku-lane-disabled-'));
  marker = path.join(tempDir, 'claude-ran');
  const cli = path.join(tempDir, 'claude');
  // Una CLI Claude "funzionante": se qualcuno la lanciasse, lascerebbe il marker.
  fs.writeFileSync(cli, `#!/bin/sh\necho ran > '${marker}'\necho '{"type":"result","result":"{}"}'\n`, { mode: 0o755 });
  // Tutto cio' che prima rendeva Haiku disponibile, come in produzione.
  process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = 'true';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'haiku-disabled-test-token';
  process.env.CLAUDE_CLI_BIN = cli;
  // E cio' che rende disponibile Codex: lane aperta + socket del broker.
  process.env.ENABLE_CODEX_ARTICLE_FALLBACK = '1';
  process.env.CODEX_AUTH_BROKER_SOCKET = path.join(tempDir, 'auth.sock');
  process.env.NVIDIA_API_KEY = 'dummy-per-test';
  delete process.env.CODEX_ARTICLE_LANE_GATE;
  delete process.env.AI_MODELS_PREFER;
  delete process.env.AI_MODELS_FORCE_CHAIN;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
  resetState();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('lane Claude Haiku spenta nel codice, Codex unica lane CLI', () => {
  it('con flag, gate e token Haiku non e\' disponibile, Codex si', () => {
    assert.equal(isModelAvailable(HAIKU), false);
    assert.equal(isModelAvailable(CODEX), true);
  });

  it('nessuna preferenza lo riporta in testa', () => {
    assert.equal(getPreferredModel({ chain: [HAIKU, RIVALE], prefer: [HAIKU] }), RIVALE);
    assert.equal(getPreferredModel({ chain: [RIVALE, HAIKU], prefer: `${HAIKU}` }), RIVALE);
    process.env.AI_MODELS_PREFER = HAIKU;
    assert.equal(getPreferredModel({ chain: [HAIKU, RIVALE] }), RIVALE);
    assert.equal(getPreferredModel({ chain: [RIVALE, HAIKU], prefer: [HAIKU, CODEX] }), CODEX);
  });

  it('callLLM con Haiku come model, chain e prefer non lancia la CLI Claude', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network disabled in test'); };
    try {
      await assert.rejects(
        callLLM([{ role: 'user', content: 'ping' }], {
          model: HAIKU,
          chain: [HAIKU],
          prefer: [HAIKU],
          recordScore: false,
        }),
        (error) => error?.code === 'ALL_MODELS_EXHAUSTED'
          && /claude-cli\/haiku: skipped — no API key for provider claude_cli/.test(error.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(fs.existsSync(marker), false, 'la CLI Claude e\' stata lanciata');
  });
});

// ── Il flag Haiku non governa piu' Codex ────────────────────────────────────
//
// Fino al 2026-09-24 la lane Codex derivava il gate da
// ENABLE_HAIKU_ARTICLE_FALLBACK: il proprietario che mettesse quel flag a 0 per
// «spegnere Haiku» avrebbe spento anche Codex. Ora conta solo
// ENABLE_CODEX_ARTICLE_FALLBACK (acceso quando non e' impostato), sia qui in
// ai-models.mjs sia nel gate bash della setup action, che il test ESEGUE.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACTION = fs.readFileSync(path.join(ROOT, '.github/actions/setup-claude-haiku-fallback/action.yml'), 'utf8');

function gateStepScript() {
  const start = ACTION.indexOf('    - name: Resolve Codex article lane gate');
  assert.ok(start !== -1, 'step del gate non trovato');
  const run = ACTION.indexOf('      run: |\n', start);
  const end = ACTION.indexOf('\n\n', run);
  return ACTION.slice(run + '      run: |\n'.length, end)
    .split('\n')
    .map((line) => line.replace(/^ {8}/, ''))
    .join('\n');
}

function runGateStep(env) {
  const githubEnv = path.join(tempDir, 'github-env');
  fs.writeFileSync(githubEnv, '');
  const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', gateStepScript()], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', GITHUB_ENV: githubEnv, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(
    fs.readFileSync(githubEnv, 'utf8').trim().split('\n').map((line) => line.split('=')),
  );
}

describe('la lane Codex ha un solo interruttore, e non e\' il flag Haiku', () => {
  it('ai-models: Haiku a 0 non spegne Codex; ENABLE_CODEX_ARTICLE_FALLBACK a 0 si', () => {
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '0';
    delete process.env.ENABLE_CODEX_ARTICLE_FALLBACK;
    assert.equal(isModelAvailable(CODEX), true, 'interruttore Codex non impostato: la lane deve restare accesa');
    process.env.ENABLE_CODEX_ARTICLE_FALLBACK = 'true';
    assert.equal(isModelAvailable(CODEX), true);
    for (const off of ['0', 'false', 'OFF', 'no']) {
      process.env.ENABLE_CODEX_ARTICLE_FALLBACK = off;
      assert.equal(isModelAvailable(CODEX), false, `ENABLE_CODEX_ARTICLE_FALLBACK=${off} deve spegnere Codex`);
    }
    process.env.ENABLE_CODEX_ARTICLE_FALLBACK = '1';
    delete process.env.CODEX_AUTH_BROKER_SOCKET;
    assert.equal(isModelAvailable(CODEX), false, 'senza il socket del broker Codex non e\' disponibile');
  });

  it('il gate della setup action ignora ENABLE_HAIKU_ARTICLE_FALLBACK', () => {
    for (const haiku of ['0', 'false', 'true', '']) {
      const env = runGateStep({ ENABLE_HAIKU_ARTICLE_FALLBACK: haiku });
      assert.equal(env.CODEX_ARTICLE_LANE_GATE, '1', `Haiku=${JSON.stringify(haiku)} ha cambiato il gate Codex`);
      assert.equal(env.ENABLE_CODEX_ARTICLE_FALLBACK, '1');
      assert.equal(env.ENABLE_HAIKU_ARTICLE_FALLBACK, undefined, 'l\'action non deve piu\' scrivere il flag Haiku');
    }
    for (const off of ['0', 'false', 'Off']) {
      const env = runGateStep({ ENABLE_CODEX_ARTICLE_FALLBACK: off, ENABLE_HAIKU_ARTICLE_FALLBACK: 'true' });
      assert.equal(env.CODEX_ARTICLE_LANE_GATE, '0', `ENABLE_CODEX_ARTICLE_FALLBACK=${off} non spegne la lane`);
      assert.equal(env.ENABLE_CODEX_ARTICLE_FALLBACK, '0');
    }
    assert.equal(runGateStep({ ENABLE_CODEX_ARTICLE_FALLBACK: 'true' }).CODEX_ARTICLE_LANE_GATE, '1');
  });

  it('nessuno step dell\'action legge o scrive piu\' il gate Haiku', () => {
    const steps = ACTION.slice(ACTION.indexOf('\nruns:'));
    assert.doesNotMatch(steps, /HAIKU_FALLBACK_GATE/);
    const writes = steps.split('\n').filter((line) => /ENABLE_HAIKU_ARTICLE_FALLBACK=/.test(line) && !/<unset>/.test(line));
    assert.deepEqual(writes, [], 'l\'action scrive ancora il flag Haiku');
    assert.doesNotMatch(steps, /\$\{ENABLE_HAIKU_ARTICLE_FALLBACK:-[^<]/, 'l\'action deriva ancora qualcosa dal flag Haiku');
  });
});
