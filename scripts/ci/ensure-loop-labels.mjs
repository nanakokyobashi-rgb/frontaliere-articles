#!/usr/bin/env node
/**
 * ensure-loop-labels.mjs — crea, se mancano, le label su cui poggia il ciclo
 * autonomo. Idempotente.
 *
 * ## Perché serve, e perché il difetto era invisibile
 *
 * Il corpus è nato con le sole label di default di GitHub. Le label di
 * ROUTING del ciclo — `agent:fix`, `agent:fix-queued`, `agent:triaged`,
 * `agent:in-progress`, `fu-prio:*` — non esistevano.
 *
 * `gh issue edit --add-label <nome>` NON crea la label: fallisce. E nei
 * workflow quel fallimento è gestito con un warning non bloccante (di
 * proposito: un triage che non riesce a instradare non deve diventare una run
 * rossa). Il risultato sarebbe stato un ciclo che gira, logga, esce 0 — e non
 * instrada niente. Inerte, senza un errore da nessuna parte.
 *
 * `scripts/lib/github-issue-creator.mjs` ha già il suo `ensureLabelsExist` per
 * le label che APPONE lui (`priority:*`, `crawler-transient`), quindi il
 * percorso di apertura delle issue si auto-riparava. Mancava la metà del
 * routing, che è quella che muove la coda.
 *
 * ## Perché non basta crearle una volta a mano
 *
 * Perché una label cancellata per sbaglio ricreerebbe lo stesso stallo
 * silenzioso mesi dopo, e nessuno collegherebbe le due cose. Questo script gira
 * come primo step del triage e del fixer: costa una `gh label list` e crea solo
 * ciò che manca.
 *
 * Uso: node scripts/ci/ensure-loop-labels.mjs [--dry-run]
 * Env: GH_TOKEN, GITHUB_REPOSITORY (o GH_REPO).
 */

import { execFileSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || process.env.GH_REPO || '';

/**
 * Le label del ciclo, col loro significato. La descrizione non è decorazione:
 * `agent:in-progress` in particolare è mutua esclusione, non stato, e chi la
 * trova appesa su una issue ferma deve capire dal tooltip che va rimossa.
 */
export const LABELS = [
  ['agent:triaged', 'ededed', 'Classificata dal triage (label anti-loop)'],
  ['agent:fix', '0e8a16', 'Instradata al fixer. RESTA anche a verdetto dato: toglierla la fa re-instradare'],
  ['agent:fix-queued', 'fbca04', 'In coda: il drainer la promuove a slot libero'],
  ['agent:in-progress', 'd93f0b', 'MUTEX del fixer, non stato: se resta appesa senza run attive, va rimossa o la issue non verra presa'],
  ['fu-prio:high', 'b60205', 'Drenata prima dalla coda'],
  ['fu-prio:low', 'c2e0c6', 'Drenata dopo'],
  ['fu-parked', '5319e7', 'Fuori dalla coda attiva dopo troppi tentativi'],
  ['stale-review', 'f9d0c4', 'Stallo rilevato: la PR non ha segnale a valle'],
  ['collision-risk', 'e99695', 'Modifica file gia toccati da un altra PR aperta'],
  ['needs-human', '7057ff', 'Il fixer ha esaurito i round: serve una mano umana'],
  ['autorebase-reopen-failed', 'b60205', 'close+reopen rotto a meta: NON cancellare l head ref, la PR va riaperta a mano'],
  ['maybe-resolved', 'bfd4f2', 'Il pre-flight la ritiene forse gia risolta: verificare prima di rilanciare il fixer'],
  ['blocked-workflows-scope', 'd4c5f9', 'Il fix richiede .github/workflows ma il token non ha lo scope: serve una mano'],
  ['priority:urgent', 'b60205', ''],
  ['priority:high', 'd93f0b', ''],
  ['priority:medium', 'fbca04', ''],
  ['priority:low', 'c2e0c6', ''],
];

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * GitHub rifiuta le descrizioni oltre i 100 caratteri, e l'errore che
 * restituisce non lo dice: `gh label create` fallisce con un messaggio
 * generico. È già costato una label non creata (`agent:in-progress`, l'unica
 * che davvero serve al mutex) mentre le altre dodici passavano — un fallimento
 * parziale che si nota solo leggendo il conteggio.
 */
export const MAX_DESCRIPTION = 100;

function main() {
  if (!REPO) {
    console.error('[ensure-loop-labels] GITHUB_REPOSITORY non impostato — esco senza fare nulla.');
    return 0;
  }

  let existing = new Map();
  try {
    // JSON diretto, non una concatenazione in jq: un separatore inventato
    // (null byte, tab) o non passa attraverso execFileSync o si scontra col
    // contenuto stesso delle descrizioni.
    const raw = gh(['label', 'list', '--repo', REPO, '--limit', '200', '--json', 'name,description,color']);
    // GitHub tratta i nomi delle label come case-insensitive per l'unicità:
    // creare `Bug` dove esiste `bug` fallisce. Il confronto va fatto uguale.
    for (const l of JSON.parse(raw || '[]')) {
      if (l && l.name) {
        existing.set(String(l.name).toLowerCase(), {
          description: String(l.description || ''),
          color: String(l.color || '').toLowerCase(),
        });
      }
    }
  } catch (e) {
    console.error(`[ensure-loop-labels] impossibile elencare le label (${String(e.message).slice(0, 100)}) — esco senza bloccare.`);
    return 0;
  }

  // Riconcilia le descrizioni divergenti. Senza questo, correggere una
  // descrizione nel codice non la porterebbe MAI sul repo: `gh label create`
  // fallisce se la label esiste, e nessuno aggiorna quella vecchia. Una label
  // che spiega male il proprio significato e' esattamente il tipo di segnale
  // che si smette di leggere.
  // Descrizione E colore: limitarsi alla descrizione lascerebbe aperto per il
  // colore lo stesso stallo silenzioso che questa riconciliazione esiste per
  // chiudere — cambiarlo nel codice non lo porterebbe mai sul repo.
  let fixed = 0;
  for (const [name, color, description] of LABELS) {
    const cur = existing.get(name.toLowerCase());
    if (cur === undefined) continue;
    const args = [];
    if (description && cur.description !== description) args.push('--description', description);
    if (color && cur.color !== String(color).toLowerCase()) args.push('--color', color);
    if (!args.length) continue;
    const what = args.filter((a) => a.startsWith('--')).map((a) => a.slice(2)).join(' + ');
    if (DRY) {
      console.log(`[ensure-loop-labels] (dry-run) aggiornerei ${what} di "${name}"`);
      fixed++;
      continue;
    }
    try {
      gh(['label', 'edit', name, '--repo', REPO, ...args]);
      console.log(`[ensure-loop-labels] ${what} aggiornato: "${name}"`);
      fixed++;
    } catch (e) {
      console.warn(`::warning::[ensure-loop-labels] "${name}" non aggiornata: ${String(e.message).slice(0, 100)}`);
    }
  }

  let created = 0;
  const missing = LABELS.filter(([name]) => !existing.has(name.toLowerCase()));

  if (!missing.length) {
    console.log(`[ensure-loop-labels] tutte le ${LABELS.length} label del ciclo esistono già${fixed ? ` (${fixed} riallineata/e)` : ''}.`);
    return 0;
  }

  for (const [name, color, description] of missing) {
    if (DRY) {
      console.log(`[ensure-loop-labels] (dry-run) creerei "${name}"`);
      created++;
      continue;
    }
    try {
      const args = ['label', 'create', name, '--repo', REPO, '--color', color];
      if (description) args.push('--description', description);
      gh(args);
      console.log(`[ensure-loop-labels] creata "${name}"`);
      created++;
    } catch (e) {
      // Non fatale: una label che non si riesce a creare va segnalata forte,
      // ma non deve far fallire il triage — il warning a valle dirà comunque
      // che il routing non è stato applicato.
      console.warn(`::warning::[ensure-loop-labels] impossibile creare "${name}": ${String(e.message).slice(0, 120)}`);
    }
  }

  console.log(`[ensure-loop-labels] ${created}/${missing.length} label mancanti create.`);
  return 0;
}

// Solo in modalità CLI: senza questa guardia, importare il modulo da un test
// lo ESEGUIREBBE — e questo script scrive sul repo.
if (process.argv[1] && process.argv[1].endsWith('ensure-loop-labels.mjs')) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`[ensure-loop-labels] errore non fatale: ${e && e.stack ? e.stack : e}`);
    process.exit(0);
  }
}
