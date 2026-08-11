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
 * ## I due buchi che restavano, e che questo file ora chiude (issue #94)
 *
 * **1. Non tutti gli strip sono uguali, e il rapporto non lo diceva.** Togliere
 * il byte da `<10>Der` lascia «Der», che era gia' la parola giusta: lo strip
 * qui perde un'ancora ma non rompe niente di leggibile. Toglierlo da
 * `comp<16>9tences` lascia **`comp9tences`**, cioe' una parola rotta che va
 * online, la legge il crawler, e da quel momento e' indistinguibile da un
 * refuso. Sono due eventi diversi con conseguenze diverse, e il contatore
 * unico li mescolava: `stripped` poteva salire di venti senza che nessuno dei
 * venti avesse rotto una parola, oppure con tutti e venti che l'avevano rotta.
 * Ora si contano separatamente (`residueCount`) e l'annotazione lo dice.
 *
 * **2. L'evidenza moriva col runner.** `DEFAULT_REPORT_PATH` sta sotto
 * `RUNNER_TEMP`, che GitHub cancella alla fine del job, e **nessun workflow del
 * repo carica quel file come artefatto** (verificato l'11-08-2026: zero
 * riferimenti a `CONTROL_CHAR_REPORT` e a `control-char-strips` fuori da questo
 * modulo). Quindi il contesto che #131 salva — l'unica cosa che rende esatta
 * una riparazione dopo — veniva scritto e buttato via nello stesso minuto. Ora
 * la stessa evidenza viene anche appesa a `GITHUB_STEP_SUMMARY`, che resta
 * attaccato alla run per sempre e non richiede di toccare nessun workflow.
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

const LETTERA = /\p{L}/u;
const CIFRA = /[0-9]/;

let stripped = 0;
let residue = 0;
let files = new Set();

/** Quante occorrenze sono state strippate in questo processo. */
export function strippedCount() {
  return stripped;
}

/** Quante di quelle lasciavano dietro una parola rotta. */
export function residueCount() {
  return residue;
}

/**
 * True se togliere il marker in posizione `at` incolla una cifra a una lettera.
 *
 * E' la firma del difetto, e non e' una euristica su un testo gia' scritto: si
 * guarda cosa il byte tiene separato NEL MOMENTO in cui lo si toglie. Tre
 * forme, tutte osservate nel corpus:
 *
 *     comp<16>9tences   lettera prima, cifra dopo    -> comp9tences
 *     sar<17>0 l'inf    lettera prima, cifra dopo    -> sar0 l'inferno
 *     Il <08>3territor  cifra dopo, lettera dopo     -> Il 3territorio
 *
 * `<10>Der` invece non lascia residuo: prima c'e' uno spazio, dopo una lettera,
 * e senza il byte resta «Der», che e' la parola che ci andava. Perdere l'ancora
 * li' e' un peccato, non un danno leggibile — e distinguere i due casi e' cio'
 * che permette di misurare quanti difetti NUOVI e invisibili ogni run manda
 * online, invece di contare byte che non rompono niente.
 */
export function stripLasciaResiduo(original, at) {
  const prima = original[at - 1] || '';
  const dopo = original[at + 1] || '';
  const poi = original[at + 2] || '';
  if (LETTERA.test(prima) && CIFRA.test(dopo)) return true;
  if (CIFRA.test(prima) && LETTERA.test(dopo)) return true;
  if (CIFRA.test(dopo) && LETTERA.test(poi)) return true;
  return false;
}

/** Quanti file distinti ne sono stati toccati. */
export function strippedFiles() {
  return [...files];
}

/** Azzera i contatori. Solo per i test: in produzione il processo e' monouso. */
export function resetCounters() {
  stripped = 0;
  residue = 0;
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
      // `residuo: true` = togliere questo byte rompe una parola. E' il campo
      // che separa «ho perso un'ancora» da «ho appena pubblicato comp9tences».
      residuo: stripLasciaResiduo(original, at),
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

  const conResiduo = occ.filter((o) => o.residuo);
  stripped += occ.length;
  residue += conResiduo.length;
  files.add(file);

  // `::error::` e non `::warning::`: un warning in un run che ne produce
  // migliaia e' cio' che ha reso questo difetto invisibile per settimane.
  // Il conteggio dei residui va PRIMA del resto: e' il numero che dice quante
  // parole rotte questo run sta mandando online, e l'altro no.
  log(
    `::error::control-char-strip: ${file} portava ${occ.length} control character C0, ` +
    `di cui ${conResiduo.length} che rompono una parola (es. comp<16>9tences -> comp9tences). ` +
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

  appendStepSummary(file, occ, opts);

  return occ.length;
}

/**
 * La stessa evidenza, ma dove sopravvive alla run.
 *
 * `reportPath` sta sotto `RUNNER_TEMP`, che GitHub cancella a fine job, e
 * nessun workflow di questo repo lo carica come artefatto: il contesto che
 * rende riparabile l'occorrenza veniva scritto e cancellato nello stesso
 * minuto. `GITHUB_STEP_SUMMARY` invece resta attaccato alla run, si legge
 * dall'interfaccia e — decisivo qui — **non richiede di modificare nessun
 * workflow**, quindi non puo' essere dimenticato dal prossimo che ne aggiunge
 * uno che scrive in `content/`.
 *
 * I byte C0 non ci vanno crudi: il sommario e' Markdown reso in HTML, e un byte
 * di controllo li' dentro e' esattamente il difetto che questo modulo esiste
 * per non propagare. Si scrivono come `<XX>`, che e' la forma leggibile e la
 * stessa che usa `repair-mangled-chars.mjs` nei suoi rapporti.
 */
function appendStepSummary(file, occ, opts = {}) {
  const dest = opts.summaryPath !== undefined ? opts.summaryPath : process.env.GITHUB_STEP_SUMMARY;
  if (!dest) return;
  const io = opts.fsImpl || fs;
  const visibile = (s) => String(s).replace(C0, (c) => `<${c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}>`);
  const righe = [
    '',
    `### control-char-strip — \`${file}\``,
    '',
    `${occ.length} control character C0 tolti in scrittura, ${occ.filter((o) => o.residuo).length} dei quali rompono una parola.`,
    '',
    '| offset | byte | rompe una parola | contesto (prima dello strip) |',
    '|---|---|---|---|',
    ...occ.map((o) => `| ${o.at} | 0x${o.byte.toString(16).padStart(2, '0')} | ${o.residuo ? 'si' : 'no'} | \`${visibile(o.context).replace(/\|/g, '\\|')}\` |`),
    '',
  ];
  try {
    io.appendFileSync(dest, righe.join('\n'), 'utf-8');
  } catch {
    // Come sopra: l'evidenza e' un di piu', la scrittura del contenuto no.
  }
}

/**
 * Le foglie stringa di una struttura, in ordine di visita, unite da `\n`.
 *
 * Serve a `reportStrippedControlCharsDeep`. `\n` e' 0x0A, che **non** e' nella
 * classe C0 che questo modulo cerca: unire con quello non puo' inventare ne'
 * nascondere un'occorrenza.
 */
function joinStringLeaves(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) joinStringLeaves(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) joinStringLeaves(v, out);
  return out;
}

/**
 * Come `reportStrippedControlChars`, ma per un valore STRUTTURATO che sta per
 * essere serializzato.
 *
 * ## Perche' non basta la versione a stringhe (issue #133)
 *
 * Il richiamo istintivo sarebbe confrontare `JSON.stringify(original)` con
 * `JSON.stringify(clean)`. Non funziona: **`JSON.stringify` escapa i byte C0**
 * in `\u0016`, quindi la forma serializzata non contiene piu' il byte letterale e
 * la regex di `occurrencesIn` non trova nulla. E' la stessa ragione per cui, nel
 * corpus, un grep di byte sui `.json` non vedeva la corruzione mentre i `.ts` la
 * mostravano.
 *
 * Quindi si guardano le foglie stringa **prima** della serializzazione, che e'
 * l'unico momento in cui il byte esiste come byte.
 */
export function reportStrippedControlCharsDeep(file, original, clean, opts = {}) {
  return reportStrippedControlChars(
    file,
    joinStringLeaves(original).join('\n'),
    joinStringLeaves(clean).join('\n'),
    opts,
  );
}
