#!/usr/bin/env node
/**
 * run-card-report.mjs — legge le card di run invece dei log.
 *
 * ## Perche' esiste, e perche' non e' un altro parser di log
 *
 * `exhaustion-reason-report.mjs` legge i log, ed e' giusto cosi' per cio' che
 * misura: righe frequenti, presenti in ogni run. Su un evento RARO lo stesso
 * metodo si rompe, e si e' rotto in modo istruttivo il 2026-09-05 su #832:
 * `--deferral-verdicts --runs 400` ha rispose «28 cascate confrontabili, flip
 * 0/28». Quello zero sembrava il verdetto che la issue aspettava e non lo era —
 * tutte e 28 le cascate avevano `providerCooldownSkips = 0`, cioe' NESSUNA era
 * il caso su cui la soglia si taglia. Il campione non conteneva il fenomeno, e
 * il report non aveva modo di dirlo.
 *
 * Questo lettore parte dall'altro capo: `create-article.mjs` scrive una card
 * (`generator/scripts/lib/run-card.mjs`) nel momento in cui l'evento accade, e
 * l'artifact di diagnostica — `if: always()`, gia' esistente — la porta fuori.
 * Qui si scaricano le card, non i log: ~0,5 KB per sezione contro i 300-500 KB
 * di un log di `generate-article.yml`, cioe' tre ordini di grandezza. E il
 * riepilogo porta sempre `runsWithEchoes` accanto ai flip, cosi' «non e'
 * successo» e «non l'ho visto» restano due numeri diversi.
 *
 * Zero rete verso i provider, zero Claude, zero quota: solo `gh` e file JSON.
 * Nessuna dipendenza npm — gira anche prima di `npm ci`.
 *
 * Uso:
 *   node scripts/ci/run-card-report.mjs --runs 40
 *   node scripts/ci/run-card-report.mjs --dir <cartella di card gia' scaricate>
 *   node scripts/ci/run-card-report.mjs --runs 40 --json
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { summariseRunCards } from '../../generator/scripts/lib/run-card.mjs';

/** Esplicito e non dedotto dal cwd: questo script si lancia anche da un worktree. */
export const DEFAULT_REPO = process.env.RUN_CARD_REPO || 'nanakokyobashi-rgb/frontaliere-articles';

/** Il pattern che `gh run download -p` usa per tirare giu' SOLO le card. */
export const CARD_GLOB = 'run-card-*.json';

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

/** Tutti i `run-card-*.json` sotto `dir`, ricorsivamente. */
export function collectCardFiles(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectCardFiles(p));
    else if (/^run-card-.*\.json$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Le card leggibili sotto `dir`. Una card illeggibile viene CONTATA come tale e
 * non fatta sparire: un file corrotto che sparisce in silenzio ricrea lo stesso
 * difetto — un denominatore che non dice cosa non ha visto.
 */
export function readCards(dir) {
  const cards = [];
  let unreadable = 0;
  for (const f of collectCardFiles(dir)) {
    try { cards.push(JSON.parse(readFileSync(f, 'utf8'))); } catch { unreadable += 1; }
  }
  return { cards, unreadable };
}

function formatSummary(s, meta) {
  const lines = [];
  lines.push(`run esaminate: ${meta.runs}  ·  card lette: ${s.cards}  ·  run senza artifact: ${meta.missing}  ·  card illeggibili: ${meta.unreadable}`);
  if (s.unknownSchema) lines.push(`⚠️  card con schema sconosciuto: ${s.unknownSchema} — un produttore piu' nuovo di questo lettore.`);
  lines.push('');
  lines.push(`#621  [prompt-rebracket]: ${s.rebracketViaFallbackUnsat} viaFallbackUnsat su ${s.rebracketCalls} ri-bracketing eseguiti`);
  lines.push(`#804  cascate di esaurimento con breakdown: ${s.deferralCascades}  ·  differimenti accettati: ${s.deferralAccepted}`);
  if (s.shares.length) {
    const sorted = [...s.shares].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    lines.push(`      share transitorio — min ${(sorted[0] * 100).toFixed(1)}%  mediana ${(med * 100).toFixed(1)}%  max ${(sorted[sorted.length - 1] * 100).toFixed(1)}%  (soglia 50,0%)`);
  }
  lines.push(`#832  cascate CON echi di cooldown: ${s.runsWithEchoes}  ·  di cui vicine alla parita' (|echi - rimaste| <= 1): ${s.nearParity}`);
  if (!s.runsWithEchoes) {
    lines.push('      → zero campioni utili: la soglia `>` contro `>=` NON e\' misurabile su questa finestra.');
    lines.push('        Non e\' «la soglia non cambierebbe niente»: e\' «il fenomeno non c\'e\'». Allargare --runs o riprovare dopo una notte di quota vera con un provider in cooldown.');
  }
  for (const x of s.samples.slice(0, 10)) {
    lines.push(`      campione run ${x.runId} (${x.section || '?'}): echi ${x.echoes} vs rimaste ${x.remaining} su ${x.grossTotal} lorde — verdetto ${x.verdict ? 'differito' : 'rosso'}`);
  }
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const dIdx = argv.indexOf('--dir');
  const repoIdx = argv.indexOf('--repo');
  const repo = repoIdx >= 0 ? argv[repoIdx + 1] : DEFAULT_REPO;

  let dir;
  let runs = 0;
  let missing = 0;

  if (dIdx >= 0) {
    dir = argv[dIdx + 1];
    if (!dir || !statSync(dir, { throwIfNoEntry: false })) {
      console.error(`--dir richiede una cartella esistente (ricevuto: ${dir || '(niente)'})`);
      process.exit(2);
    }
    runs = -1;
  } else {
    const rIdx = argv.indexOf('--runs');
    const limit = rIdx >= 0 ? Number(argv[rIdx + 1]) || 40 : 40;
    dir = mkdtempSync(path.join(tmpdir(), 'run-cards-'));
    const ids = JSON.parse(
      gh(['run', 'list', '--repo', repo, '-w', 'generate-article.yml', '-L', String(limit), '--json', 'databaseId']),
    ).map((r) => r.databaseId);
    runs = ids.length;
    for (const id of ids) {
      try {
        // `-p` scarica SOLO le card: il resto dell'artifact (report di Node,
        // log del tentativo) puo' pesare megabyte e qui non serve.
        gh(['run', 'download', String(id), '--repo', repo, '-p', CARD_GLOB, '-D', path.join(dir, String(id))], { stdio: 'pipe' });
      } catch {
        // Nessun artifact, o nessuna card dentro: e' un dato, non un errore.
        // Le run precedenti al merge della strumentazione stanno tutte qui.
        missing += 1;
      }
    }
  }

  const { cards, unreadable } = readCards(dir);
  const summary = summariseRunCards(cards);
  const meta = { runs: runs < 0 ? cards.length : runs, missing, unreadable, dir };
  if (asJson) console.log(JSON.stringify({ meta, summary }, null, 2));
  else console.log(formatSummary(summary, meta));
}

if (process.argv[1] && process.argv[1].endsWith('run-card-report.mjs')) main();
