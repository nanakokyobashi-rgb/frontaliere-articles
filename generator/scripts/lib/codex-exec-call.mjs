/**
 * codex-exec-call.mjs — trasporto LOCALE del tier Codex: esegue `codex exec`
 * sulla macchina dell'operatore e rende l'ultimo messaggio del modello.
 *
 * ── PERCHE' ESISTE ─────────────────────────────────────────────────────────
 *
 * La bonifica delle coppie en/de/fr bloccanti (#1084 item 2, #2054) e' ferma
 * perche' i due tier alti della cascata non rispondono: DeepL ha la quota
 * esaurita su entrambe le chiavi e Azure risponde 401001 su entrambe. Il
 * proprietario ha deciso il 2026-10-04 di farla con Codex, modello
 * gpt-5.6-luna a effort massimo, in locale.
 *
 * In CI il tier Codex di `free-translate.mjs` parla con il broker di
 * `.github/actions/setup-claude-haiku-fallback/codex-auth-broker.mjs` via
 * `callLLM`. In locale quel broker non c'e' (vuole CODEX_AUTH_JSON su stdin e
 * un CLI attestato), e il login dell'operatore sta gia' in `~/.codex`. Questo
 * modulo e' la stessa chiamata con l'altro esecutore: stessa forma del prompt
 * di `_codexPrompt()` in `ai-models.mjs` (`codexExecPrompt`, legata da un
 * test che confronta le due funzioni), stesso modello e stesso effort del
 * broker, stesso profilo «function» (istruzioni
 * minime, niente strumenti, niente contesto di ambiente o permessi).
 *
 * ── CONFINI ────────────────────────────────────────────────────────────────
 *
 *   - Solo in locale: con `CI` o `GITHUB_ACTIONS` impostati la creazione
 *     fallisce. In CI la strada e' il broker, che ha budget, deadline e
 *     attestazione del binario che qui non servono e non ci sono.
 *   - L'ambiente del figlio e' una allowlist (PATH, HOME, CODEX_HOME, TMPDIR,
 *     LANG, LC_ALL, TERM), come `childEnv()` del broker: chi lancia la bonifica
 *     dopo `source bin/rc-env.sh` ha nel proprio ambiente i segreti di Remote
 *     Config, e Codex non deve vederli.
 *   - `--sandbox read-only` e una cartella di lavoro temporanea vuota: il
 *     modello traduce un testo, non tocca il checkout.
 *   - Nessun retry qui dentro: un tentativo fallito e' un errore, e la
 *     bonifica salta l'articolo intero invece di cucirne mezzo.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

/** Stessi valori del broker (`CODEX_MODEL`, `CODEX_EFFORT`): un test li lega. */
export const CODEX_EXEC_MODEL = 'gpt-5.6-luna';
export const CODEX_EXEC_EFFORT = 'max';

/** Profilo «function» del broker (`FUNCTION_PROFILE_INSTRUCTIONS`): un test li lega. */
export const CODEX_EXEC_FUNCTION_INSTRUCTIONS = 'You are a stateless text-processing function called by a batch job. Read the request, produce the requested output directly, and never use tools, run commands or ask questions.\n';

/**
 * Gli strumenti dell'agente spenti dal profilo «function». Sottoinsieme della
 * lista del broker: solo i nomi che il CLI locale riconosce (0.160.0) — un
 * `--disable` di una feature sconosciuta interrompe `codex exec`.
 */
export const CODEX_EXEC_DISABLED_FEATURES = Object.freeze([
  'shell_tool', 'unified_exec', 'multi_agent', 'image_generation', 'browser_use',
  'computer_use', 'apps', 'plugins', 'view_image', 'goals',
]);

/** Tetto di una chiamata: un body lungo a effort max sta sotto i 10 minuti. */
export const CODEX_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

const MAX_STDERR_TAIL_CHARS = 4096;

/**
 * I messaggi `{role, content}` resi come il singolo prompt che `codex exec`
 * legge su stdin. Stessa forma di `_codexPrompt()` in `ai-models.mjs` (non
 * esportata, e `ai-models.mjs` e' un gemello `adapted` gia' in deriva dal
 * sito): `generator/tests/codex-exec-translate-engine.test.mjs` estrae quella
 * funzione dal sorgente e confronta le uscite, cosi' le due forme non possono
 * divergere in silenzio. La traduzione non usa la modalita' JSON.
 */
export function codexExecPrompt(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const user = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
  return [
    system ? `System instructions:\n${system}` : '',
    user,
  ].filter(Boolean).join('\n\n');
}

/** `codex exec` in locale non e' la strada della CI: li' c'e' il broker. */
export function assertLocalCodexExec(env = process.env) {
  const ci = String(env.CI ?? '').trim().toLowerCase();
  if ((ci && ci !== '0' && ci !== 'false') || String(env.GITHUB_ACTIONS ?? '').trim()) {
    throw new Error('codex exec e\' un motore locale: in CI il tier Codex passa dal broker (callLLM)');
  }
}

/** Ambiente del figlio: allowlist, mai l'ambiente intero del chiamante. */
export function codexExecChildEnv({ env = process.env, codexBin = 'codex', tmp }) {
  const nodeDir = dirname(process.execPath);
  const binDir = codexBin.includes('/') ? dirname(codexBin) : '';
  const pathParts = [binDir, nodeDir, ...(String(env.PATH || '').split(delimiter)), '/usr/bin', '/bin']
    .filter(Boolean);
  const out = { PATH: [...new Set(pathParts)].join(delimiter), TMPDIR: tmp };
  for (const key of ['HOME', 'CODEX_HOME', 'LANG', 'LC_ALL', 'TERM']) {
    if (env[key]) out[key] = env[key];
  }
  return out;
}

/** Argomenti di `codex exec` nel profilo «function». Puro, per i test. */
export function codexExecArgs({ workdir, outputPath, instructionsPath, model = CODEX_EXEC_MODEL, effort = CODEX_EXEC_EFFORT }) {
  return [
    'exec',
    '--ephemeral',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', workdir,
    '--model', model,
    '-c', `model_reasoning_effort=${effort}`,
    '-c', `model_instructions_file=${JSON.stringify(instructionsPath)}`,
    '-c', 'include_permissions_instructions=false',
    '-c', 'include_environment_context=false',
    '-c', 'web_search="disabled"',
    ...CODEX_EXEC_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '--output-last-message', outputPath,
    '-',
  ];
}

/**
 * Crea una funzione con la firma di `callLLM(messages, opts)` che esegue
 * `codex exec` in locale. E' il `call` di `translateWithCodexEngine`.
 *
 * @param {object} [options]
 * @param {string} [options.codexBin='codex']
 * @param {string} [options.model]
 * @param {string} [options.effort]
 * @param {number} [options.timeoutMs]
 * @param {typeof spawn} [options.spawnImpl]  seam dei test
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(event: {ms: number, ok: boolean, promptChars: number}) => void} [options.onCall]
 */
export function createCodexExecCall({
  codexBin = 'codex',
  model = CODEX_EXEC_MODEL,
  effort = CODEX_EXEC_EFFORT,
  timeoutMs = CODEX_EXEC_TIMEOUT_MS,
  spawnImpl = spawn,
  env = process.env,
  onCall = () => {},
} = {}) {
  assertLocalCodexExec(env);
  return async function codexExecCall(messages /* , opts */) {
    const prompt = codexExecPrompt(messages);
    const root = mkdtempSync(join(tmpdir(), 'codex-exec-translate-'));
    const workdir = join(root, 'workspace');
    const outputPath = join(root, 'last-message.txt');
    const instructionsPath = join(root, 'function-instructions.md');
    const started = Date.now();
    let ok = false;
    try {
      // `--cd` vuole una cartella esistente; vuota, cosi' il modello non ha
      // niente del checkout sotto mano.
      mkdirSync(workdir, { mode: 0o700 });
      writeFileSync(instructionsPath, CODEX_EXEC_FUNCTION_INSTRUCTIONS, { encoding: 'utf8', mode: 0o600 });
      writeFileSync(outputPath, '', { encoding: 'utf8', mode: 0o600 });
      const args = codexExecArgs({ workdir, outputPath, instructionsPath, model, effort });
      await new Promise((resolve, reject) => {
        const child = spawnImpl(codexBin, args, {
          stdio: ['pipe', 'ignore', 'pipe'],
          env: codexExecChildEnv({ env, codexBin, tmp: root }),
          cwd: workdir,
        });
        let stderrTail = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill('SIGKILL'); } catch { /* gia' uscito */ }
          reject(new Error(`codex exec: timeout dopo ${timeoutMs} ms`));
        }, timeoutMs);
        timer.unref?.();
        child.stderr?.setEncoding?.('utf8');
        child.stderr?.on('data', (chunk) => {
          stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_TAIL_CHARS);
        });
        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code === 0) resolve();
          // Solo l'ultima riga di stderr: puo' contenere il motivo, non il prompt.
          else reject(new Error(`codex exec: uscito con codice ${code}: ${stderrTail.trim().split('\n').pop() || ''}`.slice(0, 400)));
        });
        child.stdin?.end(prompt);
      });
      const result = readFileSync(outputPath, 'utf8').trim();
      if (!result) throw new Error('codex exec: ultimo messaggio vuoto');
      ok = true;
      return result;
    } finally {
      onCall({ ms: Date.now() - started, ok, promptChars: prompt.length });
      rmSync(root, { recursive: true, force: true });
    }
  };
}
