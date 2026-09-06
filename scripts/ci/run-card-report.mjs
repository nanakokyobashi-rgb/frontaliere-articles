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

/**
 * Il pattern di `gh run download -p`, e la trappola che ci sta sotto.
 *
 * `-p` filtra i NOMI DEGLI ARTIFACT, non i file al loro interno («Download
 * artifacts that match a glob pattern»). Un pattern sui file — `run-card-*.json`
 * — non matcha nessun artifact, `gh` esce non-zero e OGNI run risulta senza
 * artifact: il report stamperebbe per sempre `card lette: 0`, cioe' un altro
 * zero che non distingue «non e' successo» da «non l'ho visto», che e'
 * letteralmente il difetto che questo strumento esiste per chiudere.
 *
 * Quindi si filtra per NOME dell'artifact e si seleziona il file DOPO, con
 * `collectCardFiles()`, che gia' fa quel lavoro. Conseguenza dichiarata: si
 * scarica l'artifact intero, card piu' eventuali diagnostiche di wedge. Sulla
 * stragrande maggioranza delle run quelle sono assenti per costruzione (il log
 * del tentativo viene rimosso quando l'articolo c'e'), quindi in pratica
 * l'artifact e' la card; ma quando una run ha lasciato uno stack o un report di
 * Node, quel peso si paga.
 */
export const ARTIFACT_GLOB = 'generate-article-diagnostics-*';

/**
 * ── «NESSUN ARTIFACT» NON E' «NON SONO RIUSCITO A GUARDARE» (#924 item 3) ───
 *
 * `gh run download` esce non-zero per cause che non hanno niente in comune:
 * la run non ha quell'artifact (un DATO: le run precedenti al merge della
 * strumentazione stanno tutte qui), oppure la retention e' scaduta, il token e'
 * scaduto, il rate-limit ha morso, la rete e' caduta (un GUASTO DELLO
 * STRUMENTO). Contarle insieme come `missing` produce la frase piu' pericolosa
 * che questo report possa stampare: «run senza artifact: 40 · card lette: 0»
 * seguita da «non e' "la soglia non cambierebbe niente": e' "il fenomeno non
 * c'e'"» — cioe' lo zero muto che lo strumento esiste per togliere, spostato di
 * un livello e per giunta accompagnato dalla sua interpretazione sbagliata.
 *
 * La classificazione e' sul TESTO di `gh`, e la direzione del dubbio e' quella
 * del resto del ciclo: solo un messaggio che dice esplicitamente «non ci sono
 * artifact» vale `missing`; tutto il resto e' un errore dello strumento, che va
 * contato a parte e mostrato con la sua causa.
 *
 * @param {any} err l'errore di `execFileSync`
 * @returns {{kind:'no-artifact'|'error',reason:string}}
 */
export function classifyDownloadFailure(err) {
  const text = [
    err && err.stderr, err && err.stdout, err && err.message,
  ].map((x) => (x == null ? '' : String(x))).join('\n');
  if (/no artifact|no valid artifacts|no artifacts found|artifact not found/i.test(text)) {
    return { kind: 'no-artifact', reason: 'nessun artifact corrispondente' };
  }
  if (err && err.code === 'ENOENT') return { kind: 'error', reason: '`gh` non installato (ENOENT)' };
  const firstLine = text.split('\n').map((l) => l.trim()).filter(Boolean)[0] || 'causa non riportata da gh';
  return { kind: 'error', reason: firstLine.slice(0, 160) };
}

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
  lines.push(
    `run esaminate: ${meta.runs}  ·  card lette: ${s.cards}  ·  run senza artifact: ${meta.missing}`
    + `  ·  download falliti: ${meta.downloadErrors || 0}  ·  card illeggibili: ${meta.unreadable}`,
  );
  // I download falliti NON sono «run senza card»: sono run che nessuno ha
  // guardato. Vanno stampati PRIMA dei numeri, perche' ogni zero qui sotto si
  // legge solo con questo accanto (#924 item 3).
  if (meta.downloadErrors) {
    lines.push(`⚠️  ${meta.downloadErrors} run NON esaminate: \`gh\` e' fallito per una causa diversa da «nessun artifact».`);
    for (const [reason, n] of Object.entries(meta.downloadErrorReasons || {})) {
      lines.push(`      ${n}×  ${reason}`);
    }
    lines.push('      Finche\' questo numero non e\' zero, ogni conteggio sotto e\' un LIMITE INFERIORE, non una misura.');
  }
  if (s.unknownSchema) lines.push(`⚠️  card con schema sconosciuto: ${s.unknownSchema} — un produttore piu' nuovo di questo lettore.`);
  lines.push('');
  lines.push(`#621  [prompt-rebracket]: ${s.rebracketViaFallbackUnsat} viaFallbackUnsat su ${s.rebracketCalls} ri-bracketing eseguiti`);
  lines.push(`#804  cascate di esaurimento con breakdown: ${s.deferralCascades}  ·  differimenti accettati: ${s.deferralAccepted}  ·  vetate su input cap: ${s.inputCapVetoed}`);
  if (s.shares.length) {
    const sorted = [...s.shares].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    lines.push(`      share transitorio — min ${(sorted[0] * 100).toFixed(1)}%  mediana ${(med * 100).toFixed(1)}%  max ${(sorted[sorted.length - 1] * 100).toFixed(1)}%  (soglia 50,0%)`);
  }
  lines.push(`#832  cascate CON echi dichiarati: ${s.runsWithEchoes}  ·  con echi DAVVERO sottratti dal tally: ${s.echoesSubtracted}`);
  // Le due soglie `>` contro `>=` sono due, e si tagliano su popolazioni
  // diverse: il guardrail di eco-dominanza (`providerCooldownSkips > total`) e
  // il voto di maggioranza (`wins(netTransient, netPersistent)`). Un numero
  // solo ne descriverebbe una e verrebbe letto per l'altra.
  lines.push(`      vicine alla parita' del guardrail (|echi netti - totale netto| <= 1): ${s.nearParity}`);
  lines.push(`      vicine al pareggio del voto (|transitorio netto - persistente netto| <= 1): ${s.nearMajorityTie}`);
  if (s.cascadesWithoutTally) {
    lines.push(`      ⚠️  ${s.cascadesWithoutTally} cascate senza \`share\` numerica: card di un produttore precedente, escluse dai due conteggi sopra.`);
  }
  if (!s.echoesSubtracted) {
    if (meta.downloadErrors || s.cards === 0) {
      // Qui lo zero NON e' un'affermazione sul fenomeno: e' l'assenza di
      // osservazione. Dirlo e' l'intero motivo per cui questo strumento esiste.
      lines.push('      → zero campioni utili E lo strumento non ha guardato tutto: questa finestra non dice NIENTE sulla soglia.');
      lines.push('        Riparare prima i download falliti (token, retention, rate-limit), poi rileggere.');
    } else {
      lines.push('      → zero campioni utili: la soglia `>` contro `>=` NON e\' misurabile su questa finestra.');
      lines.push('        Non e\' «la soglia non cambierebbe niente»: e\' «il fenomeno non c\'e\'». Allargare --runs o riprovare dopo una notte di quota vera con un provider in cooldown.');
    }
  }
  for (const x of s.samples.slice(0, 10)) {
    lines.push(
      `      campione run ${x.runId} (${x.section || '?'}): echi dichiarati ${x.echoes} · sottratti ${x.netEchoes}`
      + ` · netto ${x.netTransient} vs ${x.netPersistent} su ${x.remaining} (lorde ${x.grossTotal})`
      + ` — verdetto ${x.verdict ? 'differito' : 'rosso'}${x.inputCapVeto ? ', VETATO su input cap' : ''}`,
    );
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
  let downloadErrors = 0;
  const downloadErrorReasons = new Map();

  if (dIdx >= 0) {
    dir = argv[dIdx + 1];
    // `.isDirectory()` e non la sola esistenza: con un FILE il guard passerebbe,
    // `collectCardFiles()` fallirebbe il `readdirSync` e il report direbbe
    // «0 card» invece di «argomento sbagliato» — la stessa classe di zero muto
    // che questo strumento esiste per togliere.
    const st = dir ? statSync(dir, { throwIfNoEntry: false }) : null;
    if (!st || !st.isDirectory()) {
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
        // Pattern sul NOME dell'artifact — vedi ARTIFACT_GLOB. La selezione
        // delle card avviene dopo, su disco, con collectCardFiles().
        gh(['run', 'download', String(id), '--repo', repo, '-p', ARTIFACT_GLOB, '-D', path.join(dir, String(id))], { stdio: 'pipe' });
      } catch (e) {
        // Vedi classifyDownloadFailure: «questa run non ha l'artifact» e' un
        // dato (le run precedenti al merge della strumentazione stanno tutte
        // li'), un 403/rate-limit/rete e' un guasto dello strumento e non puo'
        // finire nello stesso numero.
        const { kind, reason } = classifyDownloadFailure(e);
        if (kind === 'no-artifact') missing += 1;
        else {
          downloadErrors += 1;
          downloadErrorReasons.set(reason, (downloadErrorReasons.get(reason) || 0) + 1);
        }
      }
    }
  }

  const { cards, unreadable } = readCards(dir);
  const summary = summariseRunCards(cards);
  const meta = {
    runs: runs < 0 ? cards.length : runs,
    missing,
    downloadErrors,
    downloadErrorReasons: Object.fromEntries(downloadErrorReasons),
    unreadable,
    dir,
  };
  if (asJson) console.log(JSON.stringify({ meta, summary }, null, 2));
  else console.log(formatSummary(summary, meta));
  // Uscire 0 dopo aver letto zero card perche' `gh` non ha funzionato e'
  // l'ultima forma dello stesso difetto: un verde che significa «non ho
  // guardato». Con almeno una card lette il report e' parziale ma dice quanto,
  // e non deve rompere chi lo invoca.
  if (meta.downloadErrors && cards.length === 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('run-card-report.mjs')) main();
