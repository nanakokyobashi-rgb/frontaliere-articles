#!/usr/bin/env node
/**
 * scan-runtime-token-handoff.mjs — gate strutturale sul confine GITHUB_ENV /
 * contesto `env.*` dei workflow.
 *
 * `load-rc-env.mjs` scrive `GITHUB_PAT_NANAKO` in `$GITHUB_ENV`. Lo step
 * successivo vede quel valore nella SHELL (`$GITHUB_PAT_NANAKO`). Le
 * espressioni `${{ env.GITHUB_PAT_NANAKO }}` e `if: env.GITHUB_PAT_NANAKO != ''`
 * possono restare vuote: GitHub valuta il contesto `env` prima che il file
 * GITHUB_ENV sia visibile a quelle interpolazioni. Un `PUSH_TOKEN` o un
 * `GH_TOKEN` interpolati da lì consegnano la sonda / `gh` senza credenziale,
 * oppure ricadono in silenzio su `secrets.GITHUB_TOKEN` — che non emette
 * `issues: opened`, non ha lo scope `workflow`, e per anti-ricorsione non fa
 * scattare `publish-api.yml`.
 *
 * La PR #1547 ha spostato i consumer del loop sulla shell. Il test che lo
 * copriva elencava otto file: un reviewer poteva reintrodurre
 * `PUSH_TOKEN: ${{ env.GITHUB_PAT_NANAKO }}` in qualunque altro workflow e
 * restare verde. Questo scanner cammina TUTTI i workflow sotto
 * `.github/workflows/` e rende quella forma rossa. Gli input dell'action Codex
 * (`github_token`, `codex_github_token` e i gemelli `codex_*`) restano fuori:
 * l'action ha un fallback runtime proprio, pinnato da
 * `codex-primary-safety.test.mjs`.
 *
 * Uso:  node scripts/ci/scan-runtime-token-handoff.mjs
 *       (esce 1 elencando file:riga; importare il modulo è gratis)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Pavimento sul numero di workflow scansionati. Al 2026-09-18 l'albero ne ha
 * ~70 (crawler-group compresi). 40 lascia spazio a una potatura e intercetta
 * una lista collassata che concluderebbe «pulito» senza aver guardato.
 */
export const MIN_SCANNED_WORKFLOWS = 40;

/** Chiavi YAML il cui valore operativo non può arrivare da `env.GITHUB_PAT*`. */
export const OPERATIONAL_TOKEN_KEYS = Object.freeze([
  'GH_TOKEN', 'PUSH_TOKEN', 'PAT', 'ROUTING_TOKEN', 'SITE_TOKEN',
]);

const KEY_ALT = OPERATIONAL_TOKEN_KEYS.join('|');
const TOKEN_ENV_ALT = 'APP_TOKEN|GITHUB_PAT(?:_NANAKO)?';

/**
 * `if:` che decide la presenza del token dal contesto `env`.
 * `(?<![A-Z_])` su PAT evita di agganciarsi a `GITHUB_PAT:` come chiave.
 */
export const IF_ENV_TOKEN_RE = new RegExp(
  String.raw`if:\s*[^\n]*env\.(?:${TOKEN_ENV_ALT})\b`,
);

/**
 * Handoff interpolato: `GH_TOKEN: ${{ env.GITHUB_PAT_NANAKO }}` e anche la
 * forma con fallback `|| secrets.GITHUB_TOKEN`, che è il degrado silenzioso
 * quando il contesto `env` è vuoto. Lookbehind: non matchare `GITHUB_PAT:`.
 */
export const ENV_CONTEXT_HANDOFF_RE = new RegExp(
  String.raw`(?<![A-Z_])(?:${KEY_ALT}):\s*\$\{\{\s*env\.(?:${TOKEN_ENV_ALT})`,
);

/** `PUSH_TOKEN: ${{ env.* }}` passato alla sonda come mapping `env:` dello step. */
export const PROBE_ENV_PUSH_TOKEN_RE = new RegExp(
  String.raw`PUSH_TOKEN:\s*\$\{\{[^}\n]*env\.(?:${TOKEN_ENV_ALT})`,
);

/** Forma runtime che la sonda accetta: variabile di shell, non espressione YAML. */
export const PROBE_SHELL_PUSH_TOKEN_RE =
  /PUSH_TOKEN="\$\{?(?:GITHUB_PAT_NANAKO|GITHUB_PAT|APP_TOKEN|runtime_pat|push_token|workflow_pat)/;

export const PROBE_SCRIPT = 'probe-workflow-scope.mjs';

/**
 * Toglie le righe il cui primo token non-spazio è `#`. Le espressioni vietate
 * stanno su chiavi YAML attive; un commento che le cita come anti-pattern
 * (il caso di `transport-identical-twins.yml`) non deve far rosso il gate.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFullLineComments(text) {
  return String(text || '')
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');
}

/**
 * Return the shell text of each YAML `run:` value. Block scalars are kept
 * together until the next key at the same (or smaller) indentation; an
 * inline `run:` owns only its line. This is deliberately a small YAML shape
 * parser: the scanner needs the boundary between shell commands, not a full
 * workflow evaluator.
 *
 * @param {string} text
 * @returns {{ text: string, line: number }[]}
 */
function runBlocks(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^([ \t]*)(?:-\s*)?run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const runIndent = match[1].length;
    const scalar = match[2].trim();
    const blockScalar = scalar === '' || /^[|>][-+0-9]*$/.test(scalar);
    const body = [match[2]];
    if (blockScalar) {
      let next = i + 1;
      while (next < lines.length) {
        const line = lines[next];
        if (line.trim() && line.match(/^[ \t]*/)[0].length <= runIndent) break;
        body.push(line);
        next++;
      }
      i = next - 1;
    }
    blocks.push({ text: body.join('\n'), line: i + 1 - (blockScalar ? body.length - 1 : 0) });
  }
  return blocks;
}

/**
 * @param {string} text
 * @param {string} [file]
 * @returns {{ file: string, line: number, kind: string, text: string }[]}
 */
export function findViolations(text, file = '-') {
  const active = stripFullLineComments(text);
  const lines = active.split('\n');
  /** @type {{ file: string, line: number, kind: string, text: string }[]} */
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (IF_ENV_TOKEN_RE.test(line)) {
      findings.push({ file, line: i + 1, kind: 'if-env-token', text: line.trim() });
    }
    if (ENV_CONTEXT_HANDOFF_RE.test(line)) {
      findings.push({ file, line: i + 1, kind: 'env-context-handoff', text: line.trim() });
    }
    if (PROBE_ENV_PUSH_TOKEN_RE.test(line)) {
      findings.push({ file, line: i + 1, kind: 'probe-env-push-token', text: line.trim() });
    }
  }
  for (const block of runBlocks(active)) {
    if (!block.text.includes(PROBE_SCRIPT)) continue;
    if (!PROBE_SHELL_PUSH_TOKEN_RE.test(block.text)) {
      findings.push({
        file,
        line: block.line,
        kind: 'probe-missing-shell-token',
        text: `${PROBE_SCRIPT} invocata senza PUSH_TOKEN dalla shell nello stesso blocco run`,
      });
    }
  }
  return findings;
}

/**
 * Workflow YAML sotto `.github/workflows/`, ricorsivo. Non alza sui path
 * assenti (checkout sparso): `scanRepo` conta solo i file letti.
 *
 * @param {string} [root]
 * @returns {string[]} path relativi alla root
 */
export function listWorkflowFiles(root = ROOT) {
  const dir = path.join(root, '.github', 'workflows');
  /** @type {string[]} */
  const out = [];
  function walk(abs, rel) {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (ent.isFile() && /\.ya?ml$/.test(ent.name)) {
        out.push(`.github/workflows/${childRel}`);
      }
    }
  }
  walk(dir, '');
  return out.sort();
}

/**
 * @param {string} [root]
 * @returns {{ findings: ReturnType<typeof findViolations>, scanned: number, files: string[] }}
 */
export function scanRepo(root = ROOT) {
  const files = listWorkflowFiles(root);
  /** @type {ReturnType<typeof findViolations>} */
  const findings = [];
  let scanned = 0;
  for (const rel of files) {
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    scanned++;
    findings.push(...findViolations(fs.readFileSync(abs, 'utf8'), rel));
  }
  if (scanned < MIN_SCANNED_WORKFLOWS) {
    throw new Error(
      `scansionerei ${scanned} workflow, sotto il pavimento di ${MIN_SCANNED_WORKFLOWS}: `
      + 'una lista collassata concluderebbe «pulito» senza aver guardato niente.',
    );
  }
  return { findings, scanned, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = scanRepo();
  } catch (err) {
    process.stderr.write(`[scan-runtime-token-handoff] NON ho scansionato: ${err.message}\n`);
    process.exit(2);
  }
  const { findings, scanned } = result;
  if (findings.length) {
    process.stderr.write(
      `[scan-runtime-token-handoff] ${findings.length} handoff env.* su ${scanned} workflow:\n`
      + findings.map((f) => `  ${f.file}:${f.line} [${f.kind}] ${f.text}`).join('\n')
      + '\n\nIl PAT di Remote Config arriva in GITHUB_ENV: passalo dalla shell'
      + ' (`GH_TOKEN="$GITHUB_PAT_NANAKO"` / `PUSH_TOKEN="$GITHUB_PAT_NANAKO"`),'
      + ' non da `${{ env.GITHUB_PAT_NANAKO }}`. Vedi AGENTS.md § Credenziali.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`[scan-runtime-token-handoff] ${scanned} workflow, nessun handoff env.*\n`);
}
