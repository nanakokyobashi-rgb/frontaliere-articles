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
 *   - Nessun retry qui dentro: il trasporto classifica un tentativo fallito;
 *     il retry bounded vive nell'adattatore per campo, che conosce il budget
 *     della bonifica e può contarlo nel report.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

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
const MAX_STDOUT_TAIL_CHARS = 4096;
export const CODEX_DIAGNOSTIC_MAX_CHARS = 160;

const CODEX_AUTH_RE = /\b(?:401|403|auth(?:entication|orization)?|credential|login|logged[-_ ]?in|unauthori[sz]ed|forbidden|invalid[-_ ]+(?:api[-_ ])?key|token[-_ ]+(?:expired|invalid))\b/iu;
const CODEX_QUOTA_RE = /\b(?:quota|usage[-_ ]+limit(?:[-_ ]+(?:reached|exceeded))?|daily[-_ ]+limit(?:[-_ ]+(?:reached|exceeded))?|monthly[-_ ]+limit(?:[-_ ]+(?:reached|exceeded))?|resource[-_]exhausted)\b/iu;
const CODEX_RATE_LIMIT_RE = /\b(?:at[-_ ]+capacity|rate[-_ ]+limit(?:ed|[-_ ]+(?:reached|exceeded))?|too[-_ ]+many[-_ ]+requests|429|overloaded)\b/iu;
const CODEX_TIMEOUT_RE = /\b(?:timeout|timed\s+out|time\s+out|deadline)\b/iu;
const CODEX_TRANSIENT_RE = /\b(?:temporar(?:y|ily)|try[-_ ]+again|service[-_ ]+unavailable|connection[-_ ]+reset|econnreset|eai_again|etimedout|network[-_ ]+error|internal[-_ ]+server[-_ ]+error|5\d\d)\b/iu;
const CODEX_PROMPT_RE = /(?:System instructions:|You are a professional translator|BEGIN_TEXT_[A-Z0-9]+|END_TEXT_[A-Z0-9]+)/u;

/** A diagnostic may be shown in a report: keep it one line and secret-free. */
export function sanitizeCodexDiagnostic(value, fallback = 'errore del provider') {
  const raw = String(value ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!raw) return fallback;
  if (CODEX_PROMPT_RE.test(raw)) return 'diagnostica Codex contenente il prompt (omessa)';
  const masked = raw
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/giu, '[secret redacted]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [secret redacted]')
    .replace(/\b(?:token|api[-_ ]?key|secret|password|authorization)\s*[:=]\s*(?:\[[^\]]+\]|\S+)/giu, '[secret redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9][\w-]{6,}|AIza[0-9A-Za-z_-]{20,}|ghp_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|AKIA[0-9A-Z]{16})\b/gu, '[secret redacted]');
  return (masked || fallback).slice(0, CODEX_DIAGNOSTIC_MAX_CHARS).trimEnd();
}

function classifyCodexStreamText(text) {
  const value = String(text ?? '');
  if (CODEX_AUTH_RE.test(value)) return { reason: 'auth', retryable: false };
  if (CODEX_QUOTA_RE.test(value)) return { reason: 'quota', retryable: false };
  if (CODEX_RATE_LIMIT_RE.test(value)) return { reason: 'rate-limit', retryable: true };
  if (CODEX_TIMEOUT_RE.test(value)) return { reason: 'timeout', retryable: true };
  if (CODEX_TRANSIENT_RE.test(value)) return { reason: 'transient', retryable: true };
  return null;
}

function streamDiagnostic(stderr, stdout, fallback) {
  const lines = [String(stderr ?? ''), String(stdout ?? '')]
    .join('\n')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const preferred = lines.find((line) => classifyCodexStreamText(line)?.reason !== undefined)
    || lines.at(-1)
    || '';
  return sanitizeCodexDiagnostic(preferred, fallback);
}

/** Classify one local `codex exec` termination without retaining its payload. */
export function classifyCodexFailure({
  code = null,
  signal = null,
  timedOut = false,
  spawnError = null,
  outputEmpty = false,
  invalidOutput = false,
  stdout = '',
  stderr = '',
  durationMs = null,
  timeoutMs = null,
} = {}) {
  const streamText = `${stderr}\n${stdout}`;
  const streamClass = classifyCodexStreamText(streamText);
  if (timedOut) {
    const duration = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : '?';
    const limit = Number.isFinite(timeoutMs) ? Math.max(0, Math.round(timeoutMs)) : '?';
    return {
      reason: 'timeout',
      retryable: true,
      diagnostic: `timeout dopo ${duration} ms (limite ${limit} ms)`,
    };
  }
  if (streamClass && streamClass.reason !== 'transient') {
    return {
      ...streamClass,
      diagnostic: streamDiagnostic(stderr, stdout, `Codex: ${streamClass.reason}`),
    };
  }
  if (invalidOutput) {
    return { reason: 'invalid-output', retryable: false, diagnostic: 'output JSON non valido' };
  }
  if (outputEmpty) {
    return { reason: 'empty-output', retryable: false, diagnostic: 'uscita vuota' };
  }
  if (spawnError) {
    return {
      reason: 'spawn-error',
      retryable: false,
      diagnostic: sanitizeCodexDiagnostic(spawnError.message, 'avvio di Codex fallito'),
    };
  }
  if (signal) {
    return {
      reason: `signal-${signal}`,
      retryable: Boolean(streamClass?.reason === 'transient'),
      diagnostic: streamDiagnostic(stderr, stdout, `segnale ${signal}`),
    };
  }
  if (Number.isInteger(code) && code !== 0) {
    return {
      reason: `exit-${code}`,
      retryable: Boolean(streamClass?.reason === 'transient'),
      diagnostic: streamDiagnostic(stderr, stdout, `uscita Codex: exit-${code}`),
    };
  }
  if (streamClass?.reason === 'transient') {
    return {
      reason: 'provider-error',
      retryable: true,
      diagnostic: streamDiagnostic(stderr, stdout, 'errore transitorio del provider'),
    };
  }
  return {
    reason: 'provider-error',
    retryable: false,
    diagnostic: streamDiagnostic(stderr, stdout, 'errore del provider'),
  };
}

/** Normalize an error from an injected/future Codex transport. */
export function classifyCodexError(error) {
  if (error?.reason) {
    return {
      reason: String(error.reason),
      retryable: error.retryable === true,
      diagnostic: sanitizeCodexDiagnostic(error.diagnostic, error.message || 'errore del provider'),
    };
  }
  const message = String(error?.message ?? '');
  return classifyCodexFailure({
    timedOut: error?.timedOut === true || CODEX_TIMEOUT_RE.test(message),
    code: Number.isInteger(error?.exitCode) ? error.exitCode : null,
    signal: error?.signal || null,
    stdout: error?.stdout || '',
    stderr: error?.stderr || message,
  });
}

export class CodexExecError extends Error {
  constructor({
    reason = 'provider-error',
    diagnostic = 'errore del provider',
    retryable = false,
    durationMs = null,
    timeoutMs = null,
    exitCode = null,
    signal = null,
  } = {}) {
    const safeDiagnostic = sanitizeCodexDiagnostic(diagnostic);
    super(`${reason}: ${safeDiagnostic}`);
    this.name = 'CodexExecError';
    this.reason = reason;
    this.retryable = retryable === true;
    this.diagnostic = safeDiagnostic;
    if (durationMs !== null) this.durationMs = durationMs;
    if (timeoutMs !== null) this.timeoutMs = timeoutMs;
    if (exitCode !== null) this.exitCode = exitCode;
    if (signal !== null) this.signal = signal;
  }
}

function makeCodexExecError(details) {
  const classified = classifyCodexFailure(details);
  return new CodexExecError({
    ...classified,
    durationMs: details.durationMs,
    timeoutMs: details.timeoutMs,
    exitCode: details.code,
    signal: details.signal,
  });
}

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
  // Solo voci assolute: il figlio parte con `cwd` nella cartella temporanea,
  // dove una voce relativa del PATH del chiamante indicherebbe un'altra cosa.
  const pathParts = [binDir, nodeDir, ...(String(env.PATH || '').split(delimiter)), '/usr/bin', '/bin']
    .filter((part) => isAbsolute(part));
  const out = { PATH: [...new Set(pathParts)].join(delimiter), TMPDIR: tmp };
  for (const key of ['HOME', 'CODEX_HOME', 'LANG', 'LC_ALL', 'TERM']) {
    if (!env[key]) continue;
    // HOME e CODEX_HOME dicono dove sta il login: relativi, cambierebbero
    // significato con la `cwd` temporanea, quindi si risolvono qui.
    out[key] = key === 'HOME' || key === 'CODEX_HOME' ? resolvePath(env[key]) : env[key];
  }
  return out;
}

/** SIGKILL al gruppo del figlio; ricade sul solo figlio se il gruppo non c'e'. */
export function killProcessGroup(child, killImpl = process.kill) {
  if (child?.pid && process.platform !== 'win32') {
    try { killImpl(-child.pid, 'SIGKILL'); return; } catch { /* gruppo gia' uscito */ }
  }
  try { child?.kill?.('SIGKILL'); } catch { /* gia' uscito */ }
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
 * @param {(event: {ms: number, ok: boolean, promptChars: number, reason?: string, diagnostic?: string}) => void} [options.onCall]
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
  return async function codexExecCall(messages, opts = {}) {
    const prompt = codexExecPrompt(messages);
    const root = mkdtempSync(join(tmpdir(), 'codex-exec-translate-'));
    const workdir = join(root, 'workspace');
    const outputPath = join(root, 'last-message.txt');
    const instructionsPath = join(root, 'function-instructions.md');
    const started = Date.now();
    let ok = false;
    let failure = null;
    let stderrTail = '';
    let stdoutTail = '';
    try {
      // `--cd` vuole una cartella esistente; vuota, cosi' il modello non ha
      // niente del checkout sotto mano.
      mkdirSync(workdir, { mode: 0o700 });
      writeFileSync(instructionsPath, CODEX_EXEC_FUNCTION_INSTRUCTIONS, { encoding: 'utf8', mode: 0o600 });
      writeFileSync(outputPath, '', { encoding: 'utf8', mode: 0o600 });
      const args = codexExecArgs({ workdir, outputPath, instructionsPath, model, effort });
      await new Promise((resolve, reject) => {
        // `codexBin` relativo si risolve rispetto alla cartella di chi lancia,
        // non a quella temporanea in cui parte il figlio.
        const bin = codexBin.includes('/') ? resolvePath(codexBin) : codexBin;
        // Gruppo di processi proprio (`detached`): al timeout si uccide il
        // gruppo intero, non solo il processo diretto, come fa il broker.
        const child = spawnImpl(bin, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: codexExecChildEnv({ env, codexBin: bin, tmp: root }),
          cwd: workdir,
          detached: process.platform !== 'win32',
        });
        let settled = false;
        let watchdogKilled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          watchdogKilled = true;
          settled = true;
          killProcessGroup(child);
          failure = makeCodexExecError({
            timedOut: watchdogKilled,
            durationMs: Date.now() - started,
            timeoutMs,
            stdout: stdoutTail,
            stderr: stderrTail,
          });
          reject(failure);
        }, timeoutMs);
        // Keep the deadline referenced: a transport/fake child without its
        // own active handle must still settle this pending Promise.
        child.stderr?.setEncoding?.('utf8');
        child.stderr?.on('data', (chunk) => {
          stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_TAIL_CHARS);
        });
        child.stdout?.setEncoding?.('utf8');
        child.stdout?.on('data', (chunk) => {
          stdoutTail = (stdoutTail + chunk).slice(-MAX_STDOUT_TAIL_CHARS);
        });
        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          failure = makeCodexExecError({
            spawnError: err,
            stdout: stdoutTail,
            stderr: stderrTail,
          });
          reject(failure);
        });
        child.on('exit', () => {
          if (settled) return;
          // `close` follows `exit` after the stdio streams have closed. The
          // deadline must stop at `exit`, or a process already gone can be
          // reported as timeout while the empty output is being classified.
          clearTimeout(timer);
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code === 0) resolve();
          else {
            failure = makeCodexExecError({
              code,
              signal,
              stdout: stdoutTail,
              stderr: stderrTail,
            });
            reject(failure);
          }
        });
        child.stdin?.end(prompt);
      });
      let result;
      try {
        result = readFileSync(outputPath, 'utf8').trim();
      } catch {
        failure = makeCodexExecError({ invalidOutput: true, stdout: stdoutTail, stderr: stderrTail });
        throw failure;
      }
      if (!result) {
        failure = makeCodexExecError({
          outputEmpty: true,
          stdout: stdoutTail,
          stderr: stderrTail,
        });
        throw failure;
      }
      if (opts?.jsonMode || opts?.jsonSchema) {
        try {
          JSON.parse(result);
        } catch {
          failure = makeCodexExecError({
            invalidOutput: true,
            stdout: stdoutTail,
            stderr: stderrTail,
          });
          throw failure;
        }
      }
      ok = true;
      return result;
    } catch (error) {
      failure ??= error;
      throw error;
    } finally {
      onCall({
        ms: Date.now() - started,
        ok,
        promptChars: prompt.length,
        ...(failure ? { reason: failure.reason || 'provider-error', diagnostic: failure.diagnostic } : {}),
      });
      rmSync(root, { recursive: true, force: true });
    }
  };
}
