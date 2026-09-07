#!/usr/bin/env node
/**
 * manifest-pinned-issues.mjs — le issue che il manifest tiene APERTE, e che
 * quindi nessun auto-closer del ciclo puo' chiudere.
 *
 * ## Il difetto, misurato su #986
 *
 * Una voce `corpus-only-pending` di `scripts/ci/loop-sync-manifest.json` non e'
 * un errore: e' un promemoria che il gemello sul sito **manca e dovrebbe
 * esserci**, e punta al lavoro che lo tracciera' via `trackingIssue`. Il
 * contratto di quel campo e' scritto in due posti indipendenti e dice la stessa
 * cosa:
 *
 *   · `loop-sync-manifest-scope.test.mjs` — «L'URL deve puntare a una issue
 *     APERTA: una issue chiusa senza che il gemello sia mai atterrato e' lavoro
 *     abbandonato che nessuno ha retrocesso a `corpus-only`» — ed e' un test,
 *     `censimento: ogni trackingIssue di corpus-only-pending e' ancora aperta`;
 *   · `loop-drift-check.mjs`, che su quella voce stampa `corpus-only-pending`
 *     e la promuove a `-landed` solo quando il gemello arriva. Con la issue
 *     chiusa la voce resta pending **per sempre**, dicendo «in lavorazione» su
 *     un lavoro che nessuno sta piu' facendo: la forma esatta del punto cieco
 *     di `alert-pat-down.mjs` (#45), un segnale la cui condizione di chiusura
 *     non viene mai verificata.
 *
 * Nessuno dei closer del ciclo leggeva quel contratto. Misurato il 2026-09-07
 * su #986 — il `trackingIssue` della voce `scripts/ci/detect-aggregate.mjs` —
 * la chiusura era raggiungibile da almeno due percorsi indipendenti:
 *
 *   · `handoff-to-site.mjs`: il ramo `blocked-*` di `handoffDecision()`
 *     restituisce `close: true` appena la diagnosi cita un path spedibile, e
 *     `.github/workflows/issue-fix.yml` (`adapted`) lo e'. Cioe' il solo canale
 *     che puo' far avanzare #986 la distruggeva consegnandola;
 *   · `reconcile-followups.mjs`: `closeEligible = ... && !isAggregate` e #986
 *     non e' aggregata, quindi il token-match sulla PR #1154 — che il lavoro
 *     lo ha fatto DA QUESTO LATO, lasciando aperto solo il porting — la rende
 *     auto-chiudibile.
 *
 * In entrambi i casi la issue sparisce mentre la voce del manifest continua a
 * puntarla: la sorgente e la sua guardia divergono in silenzio.
 *
 * ## Perche' vive qui e non in ogni closer
 *
 * AGENTS.md #6: un valore condiviso ha UNA sorgente. La domanda «questa issue e'
 * tenuta aperta dal manifest?» ha una risposta sola, e viene dal manifest — non
 * da una lista di numeri ricopiata in quattro script, che diverge appena una
 * voce cambia `trackingIssue`. Letta dalla sorgente, la decisione segue il
 * manifest gratis.
 *
 * Nessuna rete e nessuna dipendenza: solo builtin, come tutto `scripts/ci/**`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MANIFEST_PATH = fileURLToPath(new URL('./loop-sync-manifest.json', import.meta.url));

/**
 * I `mode` che portano un `trackingIssue` vivo. Oggi solo `corpus-only-pending`,
 * ed e' il manifest stesso a dirlo: `loop-sync-manifest-scope.test.mjs` fallisce
 * se `trackingIssue` compare su un mode diverso («altrove e' un campo morto»).
 * La costante esiste per rendere l'estensione una riga invece di una caccia.
 */
export const PINNING_MODES = new Set(['corpus-only-pending']);

const ISSUE_URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/;

/**
 * Le issue che il manifest tiene aperte, come mappa **`owner/repo#numero` →
 * path della voce che le pinna**. Pura.
 *
 * La chiave porta il repo perche' un `trackingIssue` puo' puntare al sito: un
 * closer che gira qui non deve rifiutarsi di chiudere la propria #986 solo
 * perche' il numero coincide con una issue pinnata di la'.
 *
 * Manifest illeggibile o malformato → mappa vuota, cioe' nessun pin: il
 * fallimento sicuro e' il comportamento di prima. Un pin fantasma bloccherebbe
 * per sempre una chiusura legittima, e sarebbe invisibile.
 */
export function manifestPinnedIssues(manifestPath = MANIFEST_PATH) {
  const out = new Map();
  let man;
  try {
    man = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return out;
  }
  for (const f of man?.files || []) {
    if (!PINNING_MODES.has(f?.mode)) continue;
    const m = ISSUE_URL_RE.exec(String(f?.trackingIssue || ''));
    if (!m) continue;
    out.set(`${m[1]}#${Number(m[2])}`, f.path);
  }
  return out;
}

/**
 * La voce di manifest che tiene aperta questa issue, o `null` se nessuna. Pura.
 *
 * `repo` in forma `owner/nome`. Senza `repo` la domanda non e' rispondibile —
 * un numero nudo non identifica una issue — e la risposta e' `null`, cioe'
 * «chiudi pure»: la direzione sicura, come sopra.
 *
 * @returns {string|null} il `path` della voce che pinna, utile a scrivere il
 *          motivo nel commento invece di un «non posso» senza causa.
 */
export function pinnedBy(issueNumber, repo, pinned = manifestPinnedIssues()) {
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || !repo) return null;
  return pinned.get(`${repo}#${n}`) ?? null;
}
