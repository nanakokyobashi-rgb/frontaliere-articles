/**
 * strip-leaked-title-marker.mjs — la sola riga `TITOLO ARTICOLO: <titolo>` che
 * il prompt di generazione ha lasciato in un body italiano pubblicato.
 *
 * ── PERCHE' ESISTE ─────────────────────────────────────────────────────────
 *
 * `retranslate-blocking-bodies.mjs` non riscrive mai testo pubblicato con
 * un'euristica: sui locali il testo nuovo esce dalla cascata MT. Sull'italiano,
 * che e' il sorgente, la cascata non c'e', e il ramo `it` ripassava il body
 * vecchio da `sanitizeBodyText` (che non conosce lo scaffolding): la guardia lo
 * rivedeva identico, `leaked-prompt-scaffolding` restava `critical` e la pagina
 * non usciva mai dallo stock (site 7682: 39 pagine `it` il 2026-10-04).
 *
 * Il gate stesso prescrive la remediation («Rimuovi il blocco… Non riscrivere
 * l'istruzione in prosa», `lib/article-factuality-gates.mjs`), e il proprietario
 * ha approvato il 2026-10-04 la sola cancellazione di quella riga, senza
 * rigenerare il body con l'LLM. Questo modulo e' QUELLA cancellazione e
 * nient'altro:
 *
 *   - si toglie solo una riga che e', per intero, il token esatto del prompt
 *     (`TITOLO ARTICOLO`, maiuscolo, sensibile alle maiuscole) seguito da `:` e
 *     da un titolo su UNA riga di al massimo 200 caratteri;
 *   - con la riga se ne va il suo solo terminatore (`\n` dopo, oppure prima se
 *     e' l'ultima riga): le righe vuote attorno restano, cosi' il diff riga per
 *     riga e' ESATTAMENTE la riga tolta. Il Markdown fonde le righe vuote
 *     consecutive, quindi la pagina resa non cambia altrove;
 *   - ogni altra forma che contiene il token (intestazione `## TITOLO ARTICOLO`
 *     col titolo sulla riga sotto, etichetta a meta' riga, titolo oltre i 200
 *     caratteri o su un'altra riga) NON si tocca e finisce in `skipped` col
 *     motivo: si risolve a mano in una PR editoriale revisionata.
 *
 * Nessun testo viene generato o riscritto. Funzione pura: zero I/O.
 */

/** Il token esatto del prompt di generazione. */
export const TITLE_MARKER_TOKEN = 'TITOLO ARTICOLO';

/** Lunghezza massima del titolo che segue il marcatore. */
export const TITLE_MARKER_MAX_REST = 200;

// `\S` apre il titolo: un marcatore con il titolo su un'altra riga (resto
// vuoto) non e' questa forma. La regex vede una riga sola (lo split e' su
// `\n`), e `.` non attraversa i terminatori di riga (CR, LS, PS).
const TITLE_MARKER_LINE_RE = new RegExp(
  `^[ \\t]*${TITLE_MARKER_TOKEN}[ \\t]*:[ \\t]*(\\S.{0,${TITLE_MARKER_MAX_REST - 1}})$`,
  'u',
);

/** Motivo per cui una riga che contiene il token non e' rimovibile. */
function skipReason(line) {
  if (new RegExp(`^[ \\t]*#{1,6}[ \\t]*${TITLE_MARKER_TOKEN}`, 'u').test(line)) return 'intestazione';
  const label = new RegExp(`^[ \\t]*${TITLE_MARKER_TOKEN}[ \\t]*:[ \\t]*(.*)$`, 'u').exec(line);
  if (label) {
    if (!label[1].trim()) return 'titolo-su-altra-riga';
    if (label[1].length > TITLE_MARKER_MAX_REST) return `titolo-oltre-${TITLE_MARKER_MAX_REST}-caratteri`;
    return 'caratteri-non-ammessi';
  }
  // A inizio riga ma senza `:` ASCII dopo il token (assente, o preceduto da un
  // carattere non ammesso come NBSP): e' una riga intera, ma non questa forma.
  if (new RegExp(`^[ \\t]*${TITLE_MARKER_TOKEN}`, 'u').test(line)) return 'senza-due-punti';
  return 'non-riga-intera';
}

/**
 * Toglie da `text` le righe `TITOLO ARTICOLO: <titolo>`.
 *
 * @param {string} text campo body decodificato (newline veri)
 * @returns {{ value: string, removed: string[], skipped: string[] }}
 *   `removed`: le righe tolte, verbatim; `skipped`: `<motivo>: <riga>` per
 *   ogni riga col token lasciata intatta.
 */
export function stripLeakedTitleMarkerLine(text) {
  if (typeof text !== 'string' || !text.includes(TITLE_MARKER_TOKEN)) {
    return { value: text, removed: [], skipped: [] };
  }
  const lines = text.split('\n');
  const kept = [];
  const removed = [];
  const skipped = [];
  for (const line of lines) {
    if (TITLE_MARKER_LINE_RE.test(line)) {
      removed.push(line);
      continue;
    }
    if (line.includes(TITLE_MARKER_TOKEN)) skipped.push(`${skipReason(line)}: ${line.slice(0, 80)}`);
    kept.push(line);
  }
  // Togliere un elemento da `split('\n')` e ricongiungere toglie la riga e UN
  // solo terminatore: quello dopo, o quello prima se la riga era l'ultima.
  return { value: removed.length ? kept.join('\n') : text, removed, skipped };
}

/**
 * Vero se `next` e' `old` meno ESATTAMENTE le righe `removed`, nell'ordine,
 * senza nessun altro carattere cambiato. E' la prova che la rimozione non ha
 * toccato altro: la si calcola sul testo che verra' davvero scritto, cioe'
 * dopo ogni altro passaggio (sanificazione, guardia dei fatti chiave).
 *
 * @param {string} old
 * @param {string} next
 * @param {string[]} removed
 */
export function diffIsExactlyRemovedLines(old, next, removed) {
  if (typeof old !== 'string' || typeof next !== 'string') return false;
  const oldLines = old.split('\n');
  const nextLines = next.split('\n');
  const toRemove = Array.isArray(removed) ? removed : [];
  let j = 0;
  let k = 0;
  for (const line of oldLines) {
    if (j < nextLines.length && line === nextLines[j]) {
      j += 1;
      continue;
    }
    if (k < toRemove.length && line === toRemove[k]) {
      k += 1;
      continue;
    }
    return false;
  }
  return j === nextLines.length && k === toRemove.length;
}
