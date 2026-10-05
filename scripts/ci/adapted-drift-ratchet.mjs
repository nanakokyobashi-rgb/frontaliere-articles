#!/usr/bin/env node
/**
 * adapted-drift-ratchet.mjs — il gate `adapted-drift-budget`: il numero di
 * gemelli `adapted` in drift non puo' crescere (issue #339).
 *
 * Legge il report JSON che `loop-drift-check.mjs` ha GIA' prodotto nello stesso
 * job (`LOOP_DRIFT_REPORT_JSON`): nessuna lettura del sito in piu', nessuna
 * chiamata REST. Il confronto con l'elenco registrato e la regola sono in
 * `lib/adapted-drift.mjs`.
 *
 * Uso (in `.github/workflows/loop-drift-check.yml`):
 *   node scripts/ci/adapted-drift-ratchet.mjs --report <file> [--enforce] [--base-ref <ref>]
 *
 *   --enforce         un path in drift fuori dal ratchet, o un report illeggibile,
 *                     e' un exit 1 (schedule e dispatch con `report_issue`). Senza,
 *                     solo avviso: in PR la crescita la fa il sito, non chi ha
 *                     aperto la PR.
 *   --base-ref <ref>  in PR: il ratchet non puo' AGGIUNGERE path rispetto a
 *                     `<ref>`. Questo e' sempre un exit 1: l'elenco della PR e'
 *                     interamente nelle mani di chi l'ha aperta.
 *
 * Titolo del fallimento: «adapted-3way: N gemelli adapted in drift oltre il ratchet».
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ADAPTED_DRIFT_RATCHET_PATH,
  driftFromReport,
  parseRatchet,
  ratchetShrinkVerdict,
  ratchetVerdict,
  readRatchetFile,
} from './lib/adapted-drift.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = 'adapted-drift-ratchet';

function argValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function summary(lines) {
  const text = lines.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

/** Il ratchet della base, o null se alla base il file non esiste ancora. */
function baseRatchetPaths(ref) {
  const res = spawnSync('git', ['show', `${ref}:${ADAPTED_DRIFT_RATCHET_PATH}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) return null;
  return parseRatchet(res.stdout).paths;
}

export function main(argv) {
  const enforce = argv.includes('--enforce');
  const reportPath = argValue(argv, 'report');
  const baseRef = argValue(argv, 'base-ref');
  const ratchet = readRatchetFile(ROOT);
  if (!ratchet) {
    console.log(`::error title=${TOOL}::${ADAPTED_DRIFT_RATCHET_PATH} assente: il gate non ha una soglia.`);
    return 1;
  }
  let failed = false;

  if (baseRef) {
    const shrink = ratchetShrinkVerdict({ before: baseRatchetPaths(baseRef), after: ratchet.paths });
    if (!shrink.ok) {
      failed = true;
      console.log(
        `::error title=${TOOL}: il ratchet non si alza::${shrink.added.length} path aggiunti a ${ADAPTED_DRIFT_RATCHET_PATH} rispetto a ${baseRef}: ` +
          `${shrink.added.join(', ')}. Un drift nuovo si riconcilia (PR con \`Realign-adapted:\`), non si registra come debito.`,
      );
    }
  }

  let report = null;
  try {
    report = reportPath ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
  } catch (error) {
    console.log(`::warning title=${TOOL}::report di loop-drift-check illeggibile (${String(error?.message || error).slice(0, 120)})`);
  }
  if (!report) {
    const msg = 'nessun report di loop-drift-check da confrontare: ratchet non verificato.';
    console.log(enforce ? `::error title=${TOOL}::${msg}` : `::warning title=${TOOL}::${msg}`);
    return enforce || failed ? 1 : 0;
  }

  const { drift, unknown, adapted } = driftFromReport(report);
  const verdict = ratchetVerdict({ drift, unknown, ratchetPaths: ratchet.paths });
  const lines = [
    '## Ratchet dei gemelli `adapted` in drift',
    '',
    `Gemelli \`adapted\` nel report: ${adapted}. In drift: **${verdict.count}**. Registrati nel ratchet: ${verdict.recorded}.`,
    ...(unknown.length ? ['', `Hash illeggibili (non giudicati): ${unknown.map((p) => `\`${p}\``).join(', ')}`] : []),
    '',
  ];
  if (verdict.fresh.length) {
    lines.push(`### Nuovi in drift, fuori dal ratchet (${verdict.fresh.length})`, ...verdict.fresh.map((p) => `- \`${p}\``), '');
  }
  if (verdict.stale.length) {
    lines.push(
      `### Registrati ma non piu' in drift (${verdict.stale.length}): da potare`,
      ...verdict.stale.map((p) => `- \`${p}\``),
      '',
      '`node scripts/ci/adapted-drift-register.mjs --site-dir <clone del sito> --write-ratchet` li toglie; il job `realign-adapted` lo fa da solo per i path che riattesta.',
      '',
    );
  }
  summary(lines);

  if (!verdict.ok) {
    const title = `adapted-3way: ${verdict.fresh.length} gemelli adapted in drift oltre il ratchet`;
    const detail = `${verdict.fresh.join(', ')}. Riconcilia il file con una PR del corpus che dichiara \`Realign-adapted: <path> site-prs=#N\`, oppure riattesta la baseline se il cambiamento del sito non riguarda il corpus.`;
    if (enforce) {
      failed = true;
      console.log(`::error title=${title}::${detail}`);
    } else {
      console.log(`::warning title=${title}::${detail} (solo avviso: in PR la crescita viene dal sito, non dalla PR).`);
    }
  }
  if (verdict.stale.length) {
    console.log(`::notice title=${TOOL}: ratchet da potare::${verdict.stale.length} path registrati non sono piu' in drift.`);
  }
  return failed ? 1 : 0;
}

const isDirectRun = (() => {
  try {
    return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) process.exit(main(process.argv.slice(2)));
