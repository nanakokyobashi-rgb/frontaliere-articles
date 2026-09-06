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
 * Qui si scaricano gli artifact di diagnostica invece dei log. La CARD pesa
 * ~0,5 KB per sezione contro i 300-500 KB di un log di `generate-article.yml`,
 * ma il preventivo onesto e' quello dell'ARTIFACT: `gh run download -p` filtra
 * i nomi degli artifact, non i file, e su una run patologica la stessa cartella
 * porta stack del CDP, `resources.log` e i diagnostic report di Node (#924
 * item 6). Percio' il totale scaricato si MISURA e si stampa, c'e' un tetto
 * (`DEFAULT_MAX_BYTES`) e ogni run viene cancellata appena letta.
 *
 * E il riepilogo porta sempre `runsWithEchoes` accanto ai flip, e la
 * scomposizione delle run senza card accanto al totale, cosi' «non e'
 * successo», «non l'ho visto» e «e' morta prima di scriverlo» restano tre
 * numeri diversi.
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
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RUN_CARD_INSTRUMENTED_SINCE, summariseRunCards } from '../../generator/scripts/lib/run-card.mjs';

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
 * Node, quel peso si paga — misurato, con un tetto e senza accumulo su disco,
 * vedi `DEFAULT_MAX_BYTES`.
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

/**
 * ── «SENZA CARD» NON E' UN NUMERO SOLO (#924 item 4) ───────────────────────
 *
 * Una run puo' non avere card per tre ragioni che non hanno niente in comune,
 * e sommarle rifa' — un livello piu' su — lo zero muto che la card esiste per
 * togliere:
 *
 *   `pre-instrumentation`  e' nata prima del merge della strumentazione
 *                          (`RUN_CARD_INSTRUMENTED_SINCE`). Non poteva
 *                          scriverne una. E' storia, non un difetto.
 *   `pending`              non e' ancora `completed`: l'artifact viene
 *                          caricato a fine job, quindi qui non c'e' ancora
 *                          niente da guardare. E' latenza, non un dato.
 *   `silent`               strumentata, finita, e senza card. Il processo e'
 *                          morto prima di `finalizeRunReport()` — tipicamente
 *                          sotto il `--kill-after` del `timeout` in
 *                          `generate-article.yml`. QUESTA e' la popolazione
 *                          che #625 vuole misurare, ed e' anche la prova che
 *                          il campione delle card e' condizionato all'arrivare
 *                          in fondo: finche' questo numero non e' zero, ogni
 *                          conteggio sulle card e' onesto su META' della
 *                          popolazione, e va detto accanto ai numeri.
 *
 * @param {{createdAt?:string,status?:string}} run una riga di `gh run list`
 * @param {{since?:string}} [opts]
 * @returns {{kind:'pre-instrumentation'|'pending'|'silent',reason:string}}
 */
export function classifyCardlessRun(run, opts = {}) {
  const since = opts.since || process.env.RUN_CARD_SINCE || RUN_CARD_INSTRUMENTED_SINCE;
  const status = run && run.status ? String(run.status) : '';
  // `completed` e' l'unico stato in cui l'artifact e' gia' stato caricato. Uno
  // stato SCONOSCIUTO (un valore nuovo di GitHub) non viene trattato come
  // completato: sarebbe un `silent` inventato, cioe' un allarme dove c'e' solo
  // ignoranza.
  if (status && status !== 'completed') return { kind: 'pending', reason: `run ${status}` };
  const createdAt = run && run.createdAt ? Date.parse(run.createdAt) : NaN;
  const sinceMs = Date.parse(since);
  // Senza data leggibile non si puo' dire da che parte sta: la si conta come
  // pre-strumentazione, che e' la lettura che NON gonfia il numero allarmante.
  if (!Number.isFinite(createdAt) || !Number.isFinite(sinceMs)) {
    return { kind: 'pre-instrumentation', reason: 'data della run non leggibile' };
  }
  if (createdAt < sinceMs) return { kind: 'pre-instrumentation', reason: `precedente a ${since}` };
  return { kind: 'silent', reason: 'strumentata e completata, ma nessuna card scritta' };
}

/**
 * ── IL TETTO SUL DOWNLOAD, E PERCHE' NON E' UN FILTRO (#924 item 6) ────────
 *
 * `gh run download -p` filtra i NOMI degli artifact, non i file: si scarica
 * `generate-article-diagnostics-*` per intero, e su una run patologica quella
 * cartella contiene anche gli stack del CDP, `resources.log` e i diagnostic
 * report di Node — cioe' ordini di grandezza sopra i ~0,5 KB della card. Sono
 * proprio le run che il campionatore va a cercare, quindi il preventivo «195-479
 * byte» vale la card e non l'artifact.
 *
 * Due conseguenze, entrambe gestite qui e non a parole:
 *   1. la cartella di ogni run viene LETTA E CANCELLATA subito (streaming),
 *      quindi il picco su disco e' un artifact solo, non 400;
 *   2. c'e' un tetto sul totale scaricato, e quando morde le run non esaminate
 *      vengono CONTATE e stampate. Un tetto che tronca in silenzio sarebbe
 *      indistinguibile da «il fenomeno non c'e'».
 */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/** Byte occupati da `dir`, ricorsivamente. Usata per il preventivo REALE. */
export function dirBytes(dir) {
  let total = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else {
      const st = statSync(p, { throwIfNoEntry: false });
      if (st) total += st.size;
    }
  }
  return total;
}

/** Byte in forma leggibile, per non stampare `48234567`. */
export function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
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

/**
 * Il riepilogo leggibile. Esportata per essere PINNATA: la scomposizione delle
 * run senza card e l'avviso sul campione condizionato sono l'esito di #924
 * item 4, e un riepilogo che smette di stamparli tornerebbe a essere un
 * numero solo senza far fallire niente.
 */
export function formatSummary(s, meta) {
  const lines = [];
  const cardless = meta.cardless || {};
  lines.push(
    `run esaminate: ${meta.runs}  ·  card lette: ${s.cards}  ·  run senza card: ${meta.missing}`
    + `  ·  download falliti: ${meta.downloadErrors || 0}  ·  card illeggibili: ${meta.unreadable}`,
  );
  // «Senza card» si scompone, o «uccisa dal timeout» e «nata prima della
  // strumentazione» tornano a essere lo stesso numero (#924 item 4).
  if (meta.missing) {
    lines.push(
      `      di cui  pre-strumentazione: ${cardless['pre-instrumentation'] || 0}`
      + `  ·  run non ancora completate: ${cardless.pending || 0}`
      + `  ·  STRUMENTATE MA MUTE: ${cardless.silent || 0}`,
    );
  }
  if (cardless.silent) {
    const denom = cardless.silent + s.cards;
    const pct = denom ? ((s.cards / denom) * 100).toFixed(1) : '?';
    lines.push(
      `⚠️  ${cardless.silent} run completate DOPO il merge della strumentazione non hanno scritto nessuna card:`,
    );
    lines.push('      morte prima di `finalizeRunReport()` (kill duro del `timeout`, SIGKILL, crash del runner).');
    lines.push(
      `      Il campione delle card e' quindi condizionato ad arrivare in fondo: ${pct}% delle run strumentate e`
      + " completate. Se le cascate finiscono male piu' spesso della media, i conteggi sotto le sottostimano.",
    );
  }
  if (meta.budgetSkipped) {
    lines.push(
      `⚠️  ${meta.budgetSkipped} run NON scaricate: tetto di ${humanBytes(meta.maxBytes)} raggiunto`
      + ' (`--max-bytes` per alzarlo). Anche questo rende i conteggi un LIMITE INFERIORE.',
    );
  }
  if (meta.bytes != null) {
    lines.push(`      scaricati ${humanBytes(meta.bytes)} in totale — artifact interi, non solo le card (vedi DEFAULT_MAX_BYTES).`);
  }
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
    if (meta.downloadErrors || meta.budgetSkipped || (meta.cardless && meta.cardless.silent) || s.cards === 0) {
      // Qui lo zero NON e' un'affermazione sul fenomeno: e' l'assenza di
      // osservazione. Dirlo e' l'intero motivo per cui questo strumento esiste.
      lines.push('      → zero campioni utili E lo strumento non ha guardato tutto: questa finestra non dice NIENTE sulla soglia.');
      lines.push('        Riparare prima cio\' che ha impedito di guardare (download falliti, tetto sui byte, run mute), poi rileggere.');
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
  const keep = argv.includes('--keep');
  const dIdx = argv.indexOf('--dir');
  const repoIdx = argv.indexOf('--repo');
  const bIdx = argv.indexOf('--max-bytes');
  const repo = repoIdx >= 0 ? argv[repoIdx + 1] : DEFAULT_REPO;
  const maxBytes = bIdx >= 0 ? Number(argv[bIdx + 1]) || DEFAULT_MAX_BYTES : DEFAULT_MAX_BYTES;

  let dir;
  let scratch = null;
  let runs = 0;
  let downloadErrors = 0;
  let budgetSkipped = 0;
  let bytes = 0;
  const downloadErrorReasons = new Map();
  const cardless = { 'pre-instrumentation': 0, pending: 0, silent: 0 };
  const cards = [];
  let unreadable = 0;

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
    const read = readCards(dir);
    cards.push(...read.cards);
    unreadable = read.unreadable;
  } else {
    const rIdx = argv.indexOf('--runs');
    const limit = rIdx >= 0 ? Number(argv[rIdx + 1]) || 40 : 40;
    dir = mkdtempSync(path.join(tmpdir(), 'run-cards-'));
    scratch = dir;
    // `status` e `createdAt` accanto all'id: senza, una run senza card non e'
    // classificabile e ricade nell'unico secchio indistinto che #924 item 4
    // contesta. Costano zero chiamate in piu' — sono campi della stessa lista.
    const listed = JSON.parse(
      gh(['run', 'list', '--repo', repo, '-w', 'generate-article.yml', '-L', String(limit), '--json', 'databaseId,createdAt,status']),
    );
    runs = listed.length;
    for (const run of listed) {
      const id = String(run.databaseId);
      const target = path.join(dir, id);
      // Il tetto si controlla PRIMA di scaricare, e le run saltate si contano:
      // troncare in silenzio darebbe un campione piu' piccolo del dichiarato.
      if (bytes >= maxBytes) { budgetSkipped += 1; continue; }
      let downloaded = true;
      try {
        // Pattern sul NOME dell'artifact — vedi ARTIFACT_GLOB. La selezione
        // delle card avviene dopo, su disco, con collectCardFiles().
        gh(['run', 'download', id, '--repo', repo, '-p', ARTIFACT_GLOB, '-D', target], { stdio: 'pipe' });
      } catch (e) {
        downloaded = false;
        // Vedi classifyDownloadFailure: «questa run non ha l'artifact» e' un
        // dato, un 403/rate-limit/rete e' un guasto dello strumento e non puo'
        // finire nello stesso numero.
        const { kind, reason } = classifyDownloadFailure(e);
        if (kind === 'no-artifact') {
          const c = classifyCardlessRun(run);
          cardless[c.kind] += 1;
        } else {
          downloadErrors += 1;
          downloadErrorReasons.set(reason, (downloadErrorReasons.get(reason) || 0) + 1);
        }
      }
      if (downloaded) {
        bytes += dirBytes(target);
        const read = readCards(target);
        // L'ARTIFACT C'E' MA LA CARD NO — e prima questa run non finiva in
        // NESSUN secchio: non fra le card, non fra le mancanti. Spariva dal
        // denominatore senza lasciare traccia, che e' la forma peggiore dello
        // zero muto (#924 item 4). Una run uccisa dal `--kill-after` del
        // `timeout` carica l'artifact (`if: always()`) senza la card, quindi
        // e' proprio la popolazione interessante a essere invisibile.
        if (!read.cards.length) {
          const c = classifyCardlessRun(run);
          cardless[c.kind] += 1;
        }
        cards.push(...read.cards);
        unreadable += read.unreadable;
      }
      // Letta e buttata: il picco su disco resta un artifact solo anche su
      // `--runs 400` (#924 item 6).
      if (!keep) rmSync(target, { recursive: true, force: true });
    }
  }

  const summary = summariseRunCards(cards);
  const missing = cardless['pre-instrumentation'] + cardless.pending + cardless.silent;
  const meta = {
    runs: runs < 0 ? cards.length : runs,
    missing,
    cardless,
    downloadErrors,
    downloadErrorReasons: Object.fromEntries(downloadErrorReasons),
    budgetSkipped,
    maxBytes,
    bytes: scratch ? bytes : null,
    unreadable,
    dir,
  };
  if (asJson) console.log(JSON.stringify({ meta, summary }, null, 2));
  else console.log(formatSummary(summary, meta));
  // La cartella di scratch e' vuota (ogni run viene cancellata subito): resta
  // da togliere il guscio, o `--runs 400` lascia 400 directory in `$TMPDIR`.
  if (scratch && !keep) rmSync(scratch, { recursive: true, force: true });
  // Uscire 0 dopo aver letto zero card perche' `gh` non ha funzionato e'
  // l'ultima forma dello stesso difetto: un verde che significa «non ho
  // guardato». Con almeno una card letta il report e' parziale ma dice quanto,
  // e non deve rompere chi lo invoca.
  if ((downloadErrors || budgetSkipped) && cards.length === 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('run-card-report.mjs')) main();
