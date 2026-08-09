/**
 * control-char-write-report.mjs — rende RUMOROSO e RECUPERABILE lo strip dei
 * control character in scrittura.
 *
 * ## Perche' esiste (issue #95)
 *
 * I sette choke point di scrittura portati da #75 risolvono «il byte non entra»
 * cancellandolo, e lo annunciano cosi':
 *
 *     console.error(`  ⚠️  write(${rel}): stripped N invalid C0 ...`);
 *
 * Nessun exit code diverso da 0, nessun contatore, nessun artefatto. Una riga
 * dentro un run che ne produce migliaia. Il rubinetto a monte (#66) non e'
 * chiuso — il body di #75 lo dichiara: «Pinpointing the exact upstream step
 * that mangles the accented character... not done» — quindi ogni articolo
 * nuovo puo' portare il difetto e nessuno lo sa.
 *
 * ## Il danno vero non e' lo strip: e' la perdita dell'ANCORA
 *
 * Il byte C0 non era il difetto, era il suo MARKER. La corruzione e' che un
 * carattere non-ASCII e' stato sostituito da `(byte C0 + cifra)`: togliere il
 * byte lascia la cifra dentro la parola — `compétences` diventa `comp9tences`
 * — e a quel punto il difetto e' indistinguibile da un refuso.
 *
 * Misurato il 2026-08-09: finche' il byte e' nel corpus la riparazione e'
 * ancorata ed esatta (`repair-mangled-chars.mjs` ne ha riparate 303 su 582
 * proprio cosi'). Dieci occorrenze erano gia' irrecuperabili perche' il
 * generatore aveva riscritto tre `content/blog-meta-*.ts` e questo guard
 * aveva tolto il byte lasciando la cifra orfana: `Il "territorio poroso"` e'
 * diventato `Il 3territorio poroso3`, e non c'e' piu' modo di sapere che li'
 * andava una virgoletta.
 *
 * Quindi il rimedio non e' «non strippare» — sanificare in uscita e' giusto e
 * resta — ma **conservare cio' che si sta per distruggere**, prima di
 * distruggerlo.
 *
 * ## Cosa NON fa, di proposito
 *
 * Non fa fallire la generazione. Il rubinetto e' aperto e bloccare qui
 * fermerebbe la produzione di articoli per un difetto che riguarda una
 * manciata di caratteri: sarebbe la cura peggiore della malattia, ed e' la
 * forma di guasto che questo repo chiama «un rimedio che si auto-limita in
 * silenzio», al contrario. Emette `::error::` — che l'annotazione di GitHub
 * mostra nel sommario della run e che `scan-failed-runs.mjs` sa leggere — e
 * lascia sul disco l'evidenza. La decisione di bloccare, se mai servira', si
 * prende sui dati che questo file produce, non prima di averli.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Dove finisce l'evidenza. Sovrascrivibile per i test. */
export const DEFAULT_REPORT_PATH = process.env.CONTROL_CHAR_REPORT
  || path.join(process.env.RUNNER_TEMP || process.env.TMPDIR || '/tmp', 'control-char-strips.jsonl');

/**
 * La finestra di contesto attorno a un marker, in caratteri.
 *
 * Serve a rendere la riparazione possibile DOPO: con il solo offset non si
 * ricostruisce la parola, e con la sola parola non si sa dove rimetterla.
 * Venti caratteri per lato coprono il token piu' lungo osservato nel corpus
 * (`provincia-di-varese-investe...`) senza trasformare il report in una copia
 * del contenuto.
 */
export const CONTEXT_CHARS = 20;

const C0 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

let stripped = 0;
let files = new Set();

/** Quante occorrenze sono state strippate in questo processo. */
export function strippedCount() {
  return stripped;
}

/** Quanti file distinti ne sono stati toccati. */
export function strippedFiles() {
  return [...files];
}

/** Azzera i contatori. Solo per i test: in produzione il processo e' monouso. */
export function resetCounters() {
  stripped = 0;
  files = new Set();
}

/**
 * Le occorrenze da registrare, con il contesto che le rende riparabili.
 * Pura: nessun I/O, cosi' i test la esercitano senza toccare il disco.
 */
export function occurrencesIn(original, { contextChars = CONTEXT_CHARS } = {}) {
  const out = [];
  if (typeof original !== 'string') return out;
  C0.lastIndex = 0;
  for (const m of original.matchAll(C0)) {
    const at = m.index;
    out.push({
      at,
      byte: original.charCodeAt(at),
      // Il contesto e' PRIMA dello strip: e' l'unico momento in cui la coppia
      // (byte, carattere seguente) esiste ancora, ed e' quella coppia a dire
      // quale carattere e' andato perso.
      context: original.slice(Math.max(0, at - contextChars), at + contextChars + 1),
    });
  }
  return out;
}

/**
 * Registra uno strip e lo annuncia. Chiamare PRIMA di scrivere il file pulito.
 *
 * @param {string} file  path del file che si sta per scrivere
 * @param {string} original  contenuto com'era, coi marker ancora dentro
 * @param {string} clean  contenuto sanificato
 * @param {{reportPath?: string, log?: (s: string) => void, fsImpl?: typeof fs}} [opts]
 * @returns {number} quante occorrenze sono state registrate
 */
export function reportStrippedControlChars(file, original, clean, opts = {}) {
  if (typeof original !== 'string' || original === clean) return 0;
  const occ = occurrencesIn(original);
  if (occ.length === 0) return 0;

  const log = opts.log || ((s) => console.error(s));
  const io = opts.fsImpl || fs;
  const reportPath = opts.reportPath || DEFAULT_REPORT_PATH;

  stripped += occ.length;
  files.add(file);

  // `::error::` e non `::warning::`: un warning in un run che ne produce
  // migliaia e' cio' che ha reso questo difetto invisibile per settimane.
  log(
    `::error::control-char-strip: ${file} portava ${occ.length} control character C0. ` +
    'Sono stati tolti prima di scrivere, MA il marker che rende esatta la riparazione ' +
    'e\' andato perso: il carattere accentato originale non e\' piu\' ricostruibile da ' +
    'questo file. Evidenza in ' + reportPath + ' (issue #95, causa a monte #66).',
  );

  try {
    io.mkdirSync(path.dirname(reportPath), { recursive: true });
    const lines = occ.map((o) => JSON.stringify({ file, ...o })).join('\n') + '\n';
    io.appendFileSync(reportPath, lines, 'utf-8');
  } catch (err) {
    // L'evidenza e' un di piu': se il disco non collabora, l'annotazione sopra
    // e' gia' stata emessa e la scrittura del contenuto non deve fallire per
    // questo.
    log(`::warning::control-char-strip: impossibile scrivere ${reportPath}: ${err.message}`);
  }

  return occ.length;
}
