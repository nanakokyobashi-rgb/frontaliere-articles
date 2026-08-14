#!/usr/bin/env node
/**
 * ticker-shadow-alert.mjs — apre/richiude un alert quando `manifest.json`
 * riporta `counts.tickerArticlesShadowed > 0` (issue #302, follow-up a #293
 * e #166).
 *
 * #293 ha reso il rischio VISIBILE (log + `counts.tickerArticlesShadowed` in
 * `dist/api/manifest.json`, via `findShadowedTickerArticles` — vedi
 * `scripts/lib/ticker-shadow-check.mjs`) ma deliberatamente NON l'ha
 * trasformato in un gate: `news-ticker-live.json` resta pubblicato
 * unfiltered, perché filtrare solo qui divergerebbe dal secondo produttore
 * dello stesso payload sul sito (il commento sopra la chiamata a
 * `findShadowedTickerArticles` in `scripts/build-api.mjs` argomenta il
 * perché per esteso). Quella decisione non cambia qui.
 *
 * Ciò che restava aperto in #293 (`## Non implementato`) e nell'adversarial
 * check del reviewer: il conteggio può smettere di essere 0/5 senza che
 * nessuno se ne accorga, perché il solo canale era il log di build e un
 * campo in un JSON che nessuno legge a mano ogni pubblicazione. Questo
 * script aggiunge il canale di notifica — un'alert issue, dedup'd sul
 * titolo, che si autochiude alla prima pubblicazione in cui il conteggio
 * torna a 0 — senza toccare la scelta detect-only.
 *
 * Apertura e chiusura sono la STESSA valutazione, sullo stesso titolo
 * stabile, per lo stesso motivo di `scan-generation-health.mjs`: una
 * condizione senza un percorso di chiusura proprio resterebbe accesa per
 * sempre col dedup sul titolo.
 *
 * Uso:
 *   node scripts/ci/ticker-shadow-alert.mjs [--manifest <path>] [--dry-run]
 * Env:
 *   GH_TOKEN            il PAT (`GITHUB_PAT_NANAKO`), non il GITHUB_TOKEN —
 *                       una issue aperta dal GITHUB_TOKEN non emette
 *                       `issues: opened` e nasce fuori dal triage
 *                       event-driven (lo sweep periodico la recupera
 *                       comunque: degrado morbido, non silenzioso).
 *   GITHUB_REPOSITORY   owner/repo (auto in Actions).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';

// STABILE — mai un numero dentro: è la chiave di deduplica di
// `createGithubIssue` (primi 60 caratteri) ED è la chiave con cui
// `resolveGithubIssue` richiude. Un titolo che porta il conteggio sarebbe
// una issue nuova a ogni pubblicazione con un numero diverso.
export const TITLE = 'Watchdog news-ticker: articoli shadowed da canonical-override';

/**
 * Legge `counts.tickerArticlesShadowed`/`counts.tickerArticles` da un
 * manifest già parsato. Fail-safe come le condizioni di
 * `scan-generation-health.mjs`: un manifest senza quel campo (formato
 * vecchio, scrittura troncata) è `available: false`, mai `firing: false` —
 * "non ho misurato" non deve essere letto come "sta bene", perché
 * richiuderebbe un alert aperto su una misura che restava valida.
 *
 * @param {any} manifest
 * @returns {{available: false} | {available: true, firing: boolean, shadowed: number, total: number|null}}
 */
export function evaluateTickerShadow(manifest) {
  const shadowed = Number(manifest?.counts?.tickerArticlesShadowed);
  if (!Number.isFinite(shadowed)) return { available: false };
  const total = Number(manifest?.counts?.tickerArticles);
  return {
    available: true,
    firing: shadowed > 0,
    shadowed,
    total: Number.isFinite(total) ? total : null,
  };
}

/** Corpo dell'issue/commento quando la condizione è accesa. */
export function buildAlertBody(manifest, { shadowed, total }) {
  return [
    `**${shadowed}${total !== null ? ` su ${total}` : ''}** articoli del news-ticker` +
      ' (`news-ticker-live.json`) hanno lo slug IT correntemente shadowed da un',
    'canonical-override — rilevato ma NON filtrato, per scelta deliberata (vedi il',
    "commento sopra la chiamata a `findShadowedTickerArticles` in `scripts/build-api.mjs`):",
    'filtrare solo qui divergerebbe dal secondo produttore dello stesso payload sul sito.',
    '',
    `- commit: \`${manifest?.commit || '?'}\``,
    `- generato: ${manifest?.generatedAt || '?'}`,
    '',
    '## Suggested action',
    '',
    'Questo è un segnale, non un blocco — la pubblicazione è proseguita comunque. Verificare',
    "se il canonical-override appena deciso va esteso al filtro del news-ticker (lato SITE,",
    '`packages/articles/engine/newsTickerDataPlugin.ts` — questo repo ne riceve solo una',
    'copia mirrorata) o se è un episodio isolato dentro la finestra di ~2h del ticker.',
    '',
    'Si chiude da sola alla prossima pubblicazione in cui il conteggio torna a 0 — vedi',
    '`scripts/ci/ticker-shadow-alert.mjs`.',
  ].join('\n');
}

function readManifest(manifestPath) {
  const resolved = path.resolve(manifestPath);
  if (!fs.existsSync(resolved)) {
    console.error(`[ticker-shadow-alert] ${resolved} non trovato — esco senza fare nulla (best-effort).`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  } catch (err) {
    console.error(`[ticker-shadow-alert] ${resolved} non è JSON valido: ${err.message}`);
    return null;
  }
}

const ARGV = process.argv.slice(2);
const val = (n, d) => {
  const i = ARGV.indexOf(n);
  return i !== -1 && ARGV[i + 1] ? ARGV[i + 1] : d;
};

async function main() {
  const manifestPath = val('--manifest', 'dist/api/manifest.json');
  const dryRun = ARGV.includes('--dry-run');

  const manifest = readManifest(manifestPath);
  if (!manifest) return 0;

  const verdict = evaluateTickerShadow(manifest);
  if (!verdict.available) {
    console.warn('::warning::[ticker-shadow-alert] counts.tickerArticlesShadowed assente o non numerico — condizione non misurabile, nessuna apertura né chiusura.');
    return 0;
  }

  if (!verdict.firing) {
    console.log(`[ticker-shadow-alert] 0${verdict.total !== null ? `/${verdict.total}` : ''} shadowed — richiudo un eventuale alert aperto.`);
    if (!dryRun) resolveGithubIssue(TITLE, { workflow: 'publish-api' });
    return 0;
  }

  console.log(`[ticker-shadow-alert] ${verdict.shadowed}${verdict.total !== null ? `/${verdict.total}` : ''} shadowed — alerting.`);
  const description = buildAlertBody(manifest, verdict);
  if (dryRun) {
    console.log(`[ticker-shadow-alert] dry-run — aprirei/commenterei "${TITLE}":\n${description}`);
    return 0;
  }
  await createGithubIssue({
    title: TITLE,
    description,
    priority: 4,
    labels: ['follow-up'],
    workflow: 'publish-api',
  });
  return 0;
}

// Solo in modalità CLI: senza la guardia, importare questo modulo da un test
// lo eseguirebbe — e questo script apre issue sul repo.
if (process.argv[1] && process.argv[1].endsWith('ticker-shadow-alert.mjs')) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      // PROCEED-SAFE, come gli altri watchdog: un alert rotto non deve far
      // fallire la pubblicazione, altrimenti diventa esso stesso il guasto.
      console.error(`[ticker-shadow-alert] errore non fatale: ${e && e.stack ? e.stack : e}`);
      process.exit(0);
    },
  );
}
