#!/usr/bin/env node
/**
 * Ripara i caratteri non-ASCII che la catena LLM ha sostituito con
 * (byte di controllo C0 + una coda ASCII) dentro `content/**`.  Issue #94.
 *
 * IL DIFETTO
 *
 * Un carattere non-ASCII e' stato sostituito da un byte C0 seguito da una coda
 * che, in una parte dei casi, e' l'esadecimale Latin-1 del carattere perduto.
 * Qui sotto `<00>` sta per il byte 0x00 GREZZO nel file: nel corpus e' un byte,
 * non questi quattro caratteri — scriverlo per esteso renderebbe binario per
 * `grep` questo stesso sorgente, che e' il file che si va a rileggere quando lo
 * script rifiuta qualcosa.
 *
 *     content/blog-body/fr/svincolo-a2-sigirino-ritardo.ts
 *       'Proc<00>9dure et d<00>e9lais'      -> «Procédure et délais»
 *       'int<00>e9ress<00>e9es <00>e0 suivre' -> «intéressées à suivre»
 *
 * Il sanificatore introdotto da #65 toglie il byte C0 e LASCIA la coda dentro
 * la parola: la pagina live mostra `d9lais`, `comp9tences`, `con7ues`.  Finche'
 * il byte C0 e' nel corpus la riparazione e' ANCORATA — (byte, coda) sta al
 * posto esatto del carattere perduto.  Quando il byte sparisce resta una cifra
 * indistinguibile da un refuso e non si sa piu' quale carattere rimettere.
 * E' gia' successo: i tre `content/blog-meta-*.ts` avevano 10 occorrenze
 * l'08-08 e sul main del 09-08 hanno la cifra orfana senza piu' l'ancora.
 *
 * PERCHE' NON C'E' UNA TABELLA HARDCODED
 *
 * Perche' non esiste.  Misurato sui 29 file sporchi di `origin/main`: la stessa
 * é e' scritta `<0E>9` in `bellinzona-2025-consuntivo-risultati.ts`,
 * `<16>9` in `nestle-200-posti-lombardia.ts`, `<00>9` e `<00>e9` in
 * `svincolo-a2-sigirino-ritardo.ts`; e la stessa coppia (0x07,'9') sta al posto
 * di tre lettere diverse (F di Feuerwehr, S di Standardisierte, E di
 * Erstellung) nello stesso file.  Una tabella (byte,cifra)->carattere
 * scritta a mano sarebbe una lista di indovinelli con la faccia di un dato.
 *
 * LE DUE PROVE, ENTRAMBE ANCORATE AL CORPUS
 *
 *   lessico — si ricostruisce la parola provando ogni carattere dell'alfabeto e
 *             si tiene SOLO se esattamente una ricostruzione e' una parola che
 *             esiste gia' nei file di `content/` SENZA marker (15.139 file,
 *             226.875 token distinti al 2026-08-09).  Due ricostruzioni = ambiguo =
 *             rifiuto: `Municipalit<0E>` e' sia «Municipalité» sia
 *             «Municipalità» e non si indovina.
 *   hex     — se la coda e' l'esadecimale di una lettera Latin-1 (0xC0-0xFF),
 *             il carattere e' quello e basta.  Vale anche dove il lessico non
 *             puo' parlare (`<00>e0` isolato = «à»).  Se il lessico PUO'
 *             parlare e smentisce, vince il lessico: `<00>c1usbildung` darebbe
 *             «Áusbildung», che nel corpus non esiste, quindi si rifiuta.
 *
 * IL MARKER PARASSITA — dove non c'e' NIENTE da indovinare
 *
 * In una parte delle occorrenze il carattere non-ASCII e' ancora al suo posto e
 * il byte C0 gli sta davanti: `d<0E>épenses`, `Contr<0F>ôle`, `Comunit<00>à`.
 * Le due letture possibili — «byte parassita davanti alla é» oppure «(byte + é)
 * e' la codifica della é» — portano alla STESSA parola, quindi qui non si
 * sceglie fra due ricostruzioni: si toglie un byte e basta.  Solo in questo
 * caso, e solo se il lessico conferma la parola che ne esce, la cancellazione
 * del marker entra fra i candidati.  Dove la lettera che segue e' ASCII la
 * cancellazione resta vietata — `<10>Der` senza il marker fa «Der», che e'
 * tedesco corrente, e buttare l'ancora per una virgoletta persa e' proprio cio'
 * che questo script non fa.
 *
 * Attenzione: parassita vuol dire che la cancellazione e' AMMESSA fra i
 * candidati, non che vinca.  In `s<0E>él<0E>èvent` entrambi i marker sono
 * parassiti, ma il lessico conosce «s’élèvent» e non «sélèvent»: il primo
 * marker diventa l'apostrofo, il secondo sparisce.
 *
 * FAIL-CLOSED
 *
 * Ogni occorrenza che nessuna delle due prove risolve resta INTATTA — col suo
 * byte C0 — e finisce nell'elenco dei rifiuti, e il processo esce 2.  Lasciare
 * il marker non e' una resa: e' l'unica cosa che tiene viva l'ancora per una
 * riparazione successiva.  Una sostituzione sbagliata invece e' definitiva.
 *
 * USO
 *
 *   node generator/scripts/repair-mangled-chars.mjs                  # dry-run (default)
 *   node generator/scripts/repair-mangled-chars.mjs --ref origin/main --json
 *   node generator/scripts/repair-mangled-chars.mjs --write          # scrive davvero
 *
 * Uscita: 0 nessun marker o tutto risolto, 2 restano occorrenze rifiutate,
 * 1 errore d'uso.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const QUI = path.dirname(fileURLToPath(import.meta.url));
const RADICE_DEFAULT = path.resolve(QUI, '..', '..');

/** I C0 che non compaiono mai legittimamente in un sorgente: TAB/LF/CR esclusi. */
const MARKER_CLASSE = '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F';
const MARKER = new RegExp(`[${MARKER_CLASSE}]`);
const MARKER_G = new RegExp(`[${MARKER_CLASSE}]`, 'g');
/** Un token e' una parola: lettere, cifre, apostrofi, e i marker che ci stanno dentro. */
const TOKEN_G = new RegExp(`[\\p{L}\\p{N}'’${MARKER_CLASSE}]+`, 'gu');
const APICI = "'’‘";

/**
 * I caratteri che un carattere perduto puo' essere.  Chiuso di proposito: e' il
 * solo pregiudizio del programma, e allargarlo allarga anche le ambiguita'.
 */
const ALFABETO = [
  'à', 'á', 'â', 'ã', 'ä', 'å', 'è', 'é', 'ê', 'ë', 'ì', 'í', 'î', 'ï',
  'ò', 'ó', 'ô', 'õ', 'ö', 'ù', 'ú', 'û', 'ü', 'ç', 'ñ', 'ý', 'ÿ', 'ß', 'œ', 'æ',
  'À', 'Á', 'Â', 'Ã', 'Ä', 'Å', 'È', 'É', 'Ê', 'Ë', 'Ì', 'Í', 'Î', 'Ï',
  'Ò', 'Ó', 'Ô', 'Õ', 'Ö', 'Ù', 'Ú', 'Û', 'Ü', 'Ç', 'Ñ', 'Œ', 'Æ', '’',
];

/** Quante lettere di contesto servono perche' il lessico possa dire qualcosa. */
const CONTESTO_MINIMO = 2;
/** Oltre questo numero di marker in un token la ricerca esaustiva non si fa. */
const MARKER_PER_TOKEN_ESAUSTIVO = 2;
/** Tetto sul prodotto cartesiano, per non far esplodere un token patologico. */
const COMBINAZIONI_MAX = 200000;

// ---------------------------------------------------------------------------
// argomenti
// ---------------------------------------------------------------------------

function leggiArgomenti(argv) {
  const opz = {
    radice: RADICE_DEFAULT,
    cartella: 'content',
    ref: null,
    scrivi: false,
    json: false,
    freqMinima: 2,
    maxRifiutiMostrati: 60,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      stampaAiuto();
      process.exit(0);
    // `--apply` e' il nome che usano gli script di riparazione una-tantum del
    // sito (scripts/repair-blog-key-marker-corruption.mjs): stesso alias qui,
    // cosi' chi arriva da li' non scrive un dry-run credendo di aver applicato.
    } else if (a === '--write' || a === '--apply') opz.scrivi = true;
    else if (a === '--dry-run') opz.scrivi = false;
    else if (a === '--json') opz.json = true;
    else if (a === '--root') opz.radice = path.resolve(argv[i += 1]);
    else if (a === '--content-dir') opz.cartella = argv[i += 1];
    else if (a === '--ref') opz.ref = argv[i += 1];
    else if (a === '--min-freq') opz.freqMinima = Number(argv[i += 1]);
    else if (a === '--max-refusals-shown') opz.maxRifiutiMostrati = Number(argv[i += 1]);
    else {
      process.stderr.write(`argomento sconosciuto: ${a}\n`);
      process.exit(1);
    }
  }
  if (opz.scrivi && opz.ref) {
    process.stderr.write('--write e --ref insieme non hanno senso: un ref git non e\' scrivibile.\n');
    process.exit(1);
  }
  if (!Number.isFinite(opz.freqMinima) || opz.freqMinima < 1) {
    process.stderr.write('--min-freq vuole un intero >= 1\n');
    process.exit(1);
  }
  return opz;
}

function stampaAiuto() {
  process.stdout.write(`repair-mangled-chars — ripara (byte C0 + coda) -> carattere in content/  [issue #94]

  --root <dir>        radice del repo            (default: ${RADICE_DEFAULT})
  --content-dir <d>   cartella da riparare       (default: content)
  --ref <git-ref>     legge i file da un ref git invece che dal disco; implica dry-run
  --write, --apply    scrive davvero             (default: DRY-RUN, non scrive nulla)
  --dry-run           esplicita il default
  --min-freq <n>      quante volte la parola ricostruita deve gia' esistere nel
                      corpus pulito perche' valga come prova   (default: 2)
  --json              rapporto in JSON invece che a righe
  --max-refusals-shown <n>   quanti rifiuti elencare  (default: 60)

Uscita: 0 tutto risolto, 2 restano rifiuti, 1 errore d'uso.
`);
}

// ---------------------------------------------------------------------------
// sorgente dei file: disco oppure un ref git
// ---------------------------------------------------------------------------

function elencaFileDisco(radice, cartella) {
  const base = path.join(radice, cartella);
  const fuori = [];
  const giu = (dir) => {
    for (const v of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, v.name);
      if (v.isDirectory()) giu(p);
      else if (v.isFile() && /\.(ts|tsx|json|mjs|js)$/.test(v.name)) fuori.push(p);
    }
  };
  if (!fs.existsSync(base)) {
    process.stderr.write(`cartella inesistente: ${base}\n`);
    process.exit(1);
  }
  giu(base);
  return fuori.sort().map((p) => ({
    percorso: path.relative(radice, p).split(path.sep).join('/'),
    leggi: () => fs.readFileSync(p),
  }));
}

function elencaFileGit(radice, cartella, ref) {
  const elenco = execFileSync(
    'git', ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', ref, '--', `${cartella}/`],
    { cwd: radice, maxBuffer: 1 << 28 },
  ).toString('utf8').split('\n').filter(Boolean)
    .filter((p) => /\.(ts|tsx|json|mjs|js)$/.test(p));
  // Un solo `git cat-file --batch` per tutti i blob: 15k `git show` non finirebbero mai.
  const richiesta = elenco.map((p) => `${ref}:${p}`).join('\n') + '\n';
  const flusso = execFileSync('git', ['cat-file', '--batch'], {
    cwd: radice, input: richiesta, maxBuffer: 1 << 30,
  });
  const contenuti = new Map();
  let pos = 0;
  for (const p of elenco) {
    const aCapo = flusso.indexOf(0x0a, pos);
    const testata = flusso.toString('utf8', pos, aCapo).split(' ');
    if (testata[1] !== 'blob') throw new Error(`oggetto non blob per ${p}: ${testata.join(' ')}`);
    const dim = Number(testata[2]);
    contenuti.set(p, flusso.subarray(aCapo + 1, aCapo + 1 + dim));
    pos = aCapo + 1 + dim + 1;
  }
  return elenco.map((p) => ({ percorso: p, leggi: () => contenuti.get(p) }));
}

// ---------------------------------------------------------------------------
// lessico: solo dai file che NON hanno marker
// ---------------------------------------------------------------------------

function costruisciLessico(file, testi) {
  const lessico = new Map();
  let puliti = 0;
  for (const f of file) {
    const testo = testi.get(f.percorso);
    if (testo === undefined || MARKER.test(testo)) continue;
    puliti += 1;
    for (const m of testo.matchAll(TOKEN_G)) {
      const t = ritaglia(m[0]);
      if (t) lessico.set(t, (lessico.get(t) || 0) + 1);
    }
  }
  return { lessico, puliti };
}

function ritaglia(token) {
  let a = 0;
  let b = token.length;
  while (a < b && APICI.includes(token[a])) a += 1;
  while (b > a && APICI.includes(token[b - 1])) b -= 1;
  return token.slice(a, b);
}

// ---------------------------------------------------------------------------
// risoluzione di un token
// ---------------------------------------------------------------------------

const HEX = /^[0-9a-fA-F]$/;

/** Le lettere Latin-1: × (0xD7) e ÷ (0xF7) non sono lettere e non entrano. */
function letteraLatin1(valore) {
  if (valore < 0xc0 || valore > 0xff) return null;
  if (valore === 0xd7 || valore === 0xf7) return null;
  return String.fromCharCode(valore);
}

/**
 * Le unita' che un marker in posizione `i` puo' occupare, dalla piu' lunga.
 * `coda` e' cio' che il marker si porta via oltre a se stesso: serve solo al
 * rapporto, per far vedere la forma esatta che e' stata sostituita.
 */
function unitaPossibili(token, i) {
  const unita = [];
  const c1 = token[i + 1];
  const c2 = token[i + 2];
  if (c1 && c2 && HEX.test(c1) && HEX.test(c2)) {
    const valore = parseInt(c1 + c2, 16);
    unita.push({ lunghezza: 3, coda: c1 + c2, hex: letteraLatin1(valore) });
  }
  // La coda di una unita' corta e' una CIFRA ESADECIMALE, non una cifra decimale:
  // in `co<0F>bt` la coda e' 'b' e 0x0F*16+0xb = 0xFB = û, che il lessico conferma
  // con «coût» (2.726 occorrenze).  Fermarsi a [0-9] lasciava fuori a-f, cioe' i
  // sei caratteri Latin-1 per riga della tabella: â, ê, î, ô, û e le loro
  // compagne.  La coda resta comunque solo un CANDIDATO: se il lessico non
  // conferma la ricostruzione, l'occorrenza e' rifiutata come prima.
  if (c1 && HEX.test(c1) && c1 === c1.toLowerCase()) unita.push({ lunghezza: 2, coda: c1, hex: null });
  unita.push({ lunghezza: 1, coda: '', hex: null });
  return unita;
}

/**
 * Un marker e' PARASSITA quando il carattere che lo segue e' gia' una lettera
 * non-ASCII: in `d<0E>épenses` la é e' al suo posto e il byte C0 e' un residuo
 * davanti a lei.  Le due letture possibili — «byte parassita davanti alla é»
 * oppure «(byte + é) e' la codifica della é» — danno la STESSA ricostruzione,
 * `dépenses`, quindi qui non si sceglie fra due parole: si toglie un byte.
 * E' l'unico posto in cui la cancellazione del marker e' una ricostruzione
 * ammessa, e vale comunque solo se il lessico conferma la parola che ne esce.
 */
function markerParassita(token, i) {
  const c = token[i + 1];
  return Boolean(c) && c.charCodeAt(0) > 127 && /\p{L}/u.test(c);
}

/** Quante lettere del token NON sono marker ne' coda consumata. */
function lettereDiContesto(token, marker, scelte) {
  let consumati = 0;
  for (let k = 0; k < marker.length; k += 1) consumati += scelte[k].unita.lunghezza;
  return token.length - consumati;
}

/** Ogni carattere rimesso cade dentro [inizio, inizio+lunghezza) della ricostruzione? */
function sostituzioniDentro(testo, marker, scelte, inizio, lunghezza) {
  void testo;
  let posizione = 0;
  let cursoreOriginale = 0;
  for (let k = 0; k < marker.length; k += 1) {
    posizione += marker[k] - cursoreOriginale;
    // Una cancellazione (marker parassita) non rimette nessun carattere: non c'e'
    // niente da contenere nel ritaglio, e avanzare di 1 sposterebbe le posizioni
    // dei marker successivi.
    const lungo = scelte[k].carattere.length;
    if (lungo > 0 && (posizione < inizio || posizione >= inizio + lunghezza)) return false;
    posizione += lungo;
    cursoreOriginale = marker[k] + scelte[k].unita.lunghezza;
  }
  return true;
}

function ricostruisci(token, marker, scelte) {
  let fuori = '';
  let cursore = 0;
  for (let k = 0; k < marker.length; k += 1) {
    fuori += token.slice(cursore, marker[k]);
    fuori += scelte[k].carattere;
    cursore = marker[k] + scelte[k].unita.lunghezza;
  }
  fuori += token.slice(cursore);
  return fuori;
}

/**
 * Risolve un token.  Ritorna { esito: 'riparato', testo, dettagli[] } oppure
 * { esito: 'rifiutato', motivo, candidati }.
 */
/**
 * La «legge del nibble»: in alcuni file la coda e' la cifra bassa del codice
 * Latin-1 del carattere e il byte C0 e' la cifra alta — 0x0E+'9' = 0xE9 = é,
 * 0x0F+'4' = 0xF4 = ô.  Non e' un'ipotesi da applicare ovunque: e' una legge
 * che va VERIFICATA nel file in cui la si usa, contando quante sostituzioni
 * gia' provate dal lessico la rispettano e quante la smentiscono.  In
 * `bellinzona-2025-consuntivo-risultati.ts` la rispettano é, è, â, ô; in
 * `nestle-200-posti-lombardia.ts` la stessa é si scrive 0x16+'9' e la legge
 * cade subito.  Senza questa verifica per file, «### 0x0F+9 0x0F+9 0x0F+9»
 * diventerebbe «ùùù».
 */
function caratteredaNibble(byte, coda) {
  if (coda.length !== 1 || !HEX.test(coda)) return null;
  return letteraLatin1(byte * 16 + parseInt(coda, 16));
}

function risolviToken(token, lessico, freqMinima, mappaAppresa, leggeNibble) {
  const marker = [];
  for (let i = 0; i < token.length; i += 1) if (MARKER.test(token[i])) marker.push(i);
  if (marker.length === 0) return null;

  const opzioniPerMarker = marker.map((i) => {
    const unita = unitaPossibili(token, i);
    if (marker.length > MARKER_PER_TOKEN_ESAUSTIVO) {
      // Troppi marker per la ricerca esaustiva: si usa solo cio' che questo
      // stesso file ha gia' dimostrato altrove (seconda passata).
      const scelte = [];
      for (const u of unita) {
        const firma = `${token.charCodeAt(i)}|${u.coda}`;
        const appreso = mappaAppresa.get(firma);
        if (appreso) scelte.push({ unita: u, carattere: appreso });
      }
      return scelte;
    }
    const scelte = [];
    for (const u of unita) for (const c of ALFABETO) scelte.push({ unita: u, carattere: c });
    // La cancellazione entra fra i candidati SOLO dove il marker e' parassita,
    // cioe' dove la lettera non-ASCII e' gia' li'.  Altrove togliere il marker
    // significherebbe buttare via l'ancora senza rimettere niente.
    if (markerParassita(token, i)) scelte.push({ unita: unita[unita.length - 1], carattere: '' });
    return scelte;
  });

  let combinazioni = 1;
  for (const o of opzioniPerMarker) combinazioni *= o.length;
  if (combinazioni === 0) {
    return { esito: 'rifiutato', motivo: 'nessun candidato (troppi marker nel token)', candidati: [] };
  }
  if (combinazioni > COMBINAZIONI_MAX) {
    return { esito: 'rifiutato', motivo: 'token troppo intricato', candidati: [] };
  }

  // prova «hex»: definita solo se OGNI marker ha una coda esadecimale valida.
  let hexScelte = [];
  for (let k = 0; k < marker.length; k += 1) {
    const u = unitaPossibili(token, marker[k])[0];
    if (u && u.lunghezza === 3 && u.hex) hexScelte.push({ unita: u, carattere: u.hex });
    else { hexScelte = null; break; }
  }
  const hexTesto = hexScelte ? ricostruisci(token, marker, hexScelte) : null;

  // prova «lessico»: ricostruzioni che il corpus pulito conferma.
  const confermate = new Map();
  const indici = new Array(marker.length).fill(0);
  for (let n = 0; n < combinazioni; n += 1) {
    const scelte = indici.map((idx, k) => opzioniPerMarker[k][idx]);
    if (lettereDiContesto(token, marker, scelte) >= CONTESTO_MINIMO) {
      const testo = ricostruisci(token, marker, scelte);
      // Il lessico e' costruito su token con gli apici di bordo gia' tolti (nel
      // sorgente .ts l'apostrofo arriva come `\'`), quindi si confronta la forma
      // ritagliata — ma solo se il carattere rimesso sopravvive al ritaglio.
      // Senza questa seconda condizione «’territorio» passerebbe perche'
      // ritagliato diventa «territorio», che nel corpus c'e': l'apostrofo di
      // bordo si vedrebbe confermato da una parola che non lo contiene.
      const ritagliato = ritaglia(testo);
      const spostamento = testo.indexOf(ritagliato);
      if (sostituzioniDentro(testo, marker, scelte, spostamento, ritagliato.length)) {
        const freq = lessico.get(ritagliato) || 0;
        if (freq >= freqMinima && !confermate.has(testo)) confermate.set(testo, { scelte, freq });
      }
    }
    for (let k = marker.length - 1; k >= 0; k -= 1) {
      indici[k] += 1;
      if (indici[k] < opzioniPerMarker[k].length) break;
      indici[k] = 0;
    }
  }

  // prova di CANCELLAZIONE: se togliendo il solo marker resta una parola che il
  // corpus conosce gia', al suo posto non c'era una lettera — c'era una
  // virgoletta, un trattino, un simbolo.  `<10>Der` cancellato fa «Der», che e'
  // tedesco corrente: mettere Þ perche' "De" si legge 0xDE sarebbe un disastro
  // silenzioso.  Qui si rifiuta e il marker resta al suo posto.
  // Il controllo vale solo se cio' che resta e' una PAROLA: `0x0E+'0'` isolato
  // cancellato fa «0», che nel corpus c'e' a migliaia perche' e' un numero, e
  // non dice niente su cosa ci fosse prima.
  // Non vale dove OGNI marker del token e' parassita: li' la cancellazione non e'
  // il segno di una lettera perduta, e' la ricostruzione — e passa comunque dal
  // lessico come tutte le altre, qualche riga piu' sotto.
  const cancellato = ricostruisci(token, marker, marker.map(() => ({ unita: { lunghezza: 1, coda: '', hex: null }, carattere: '' })));
  const cancellatoRitagliato = ritaglia(cancellato);
  const tuttiParassiti = marker.every((i) => markerParassita(token, i));
  if (!tuttiParassiti && /\p{L}/u.test(cancellatoRitagliato) && (lessico.get(cancellatoRitagliato) || 0) >= freqMinima) {
    return {
      esito: 'rifiutato',
      motivo: 'il marker sostituiva un carattere che non e\' una lettera (senza di lui la parola esiste gia\')',
      candidati: [cancellatoRitagliato],
    };
  }

  const dettaglia = (scelte, canale, freq) => ({
    esito: 'riparato',
    testo: ricostruisci(token, marker, scelte),
    canale: scelte.some((s) => s.carattere === '') ? `${canale} (parassita)` : canale,
    freq,
    dettagli: marker.map((i, k) => ({
      byte: token.charCodeAt(i),
      coda: scelte[k].unita.coda,
      carattere: scelte[k].carattere,
    })),
  });

  // prova «nibble», solo dove la legge e' stata verificata su questo file.
  let nibbleScelte = [];
  if (leggeNibble && marker.length <= MARKER_PER_TOKEN_ESAUSTIVO) {
    for (let k = 0; k < marker.length; k += 1) {
      const u = unitaPossibili(token, marker[k]).find((x) => x.lunghezza === 2);
      const c = u ? caratteredaNibble(token.charCodeAt(marker[k]), u.coda) : null;
      if (c) nibbleScelte.push({ unita: u, carattere: c });
      else { nibbleScelte = null; break; }
    }
  } else nibbleScelte = null;
  const nibbleTesto = nibbleScelte && nibbleScelte.length ? ricostruisci(token, marker, nibbleScelte) : null;

  // 1. il lessico conferma proprio la lettura esadecimale: la prova piu' forte.
  if (hexTesto && confermate.has(hexTesto)) {
    return dettaglia(hexScelte, 'hex+lessico', confermate.get(hexTesto).freq);
  }
  // 1b. idem per la legge del nibble: la legge sceglie, il lessico conferma.
  if (nibbleTesto && confermate.has(nibbleTesto)) {
    return dettaglia(nibbleScelte, 'nibble+lessico', confermate.get(nibbleTesto).freq);
  }
  // 2. il lessico non ha NIENTE su cui pronunciarsi — il token e' fatto solo di
  //    marker e code — ma l'esadecimale si'.  E' il caso di ` e0` isolato, che
  //    e' la preposizione «à».  La soglia e' zero lettere di contesto, non
  //    «poche»: con anche una sola lettera intorno il lessico ha voce e va
  //    ascoltato, altrimenti ` Der` diventa «Þr».
  //    Anche qui pero' il corpus ha l'ultima parola: il carattere da solo deve
  //    essere una PAROLA che il corpus usa da sola.  «à» lo e' (migliaia di
  //    volte), «â» no — e la differenza non e' un dettaglio, perche' 0xE2 in
  //    questo corpus e' anche il primo byte UTF-8 di « — » e di « “ ».  In
  //    `svincolo-a2-sigirino-ritardo.ts` il token `<00>e2` apre una riga prima
  //    di «Il est important de noter»: li' non c'era una â, c'era un segno di
  //    cui e' rimasta solo la testa della sequenza UTF-8.  Senza questa riga la
  //    lettura esadecimale ci scriverebbe «â» e l'ancora sparirebbe.
  if (hexTesto && confermate.size === 0) {
    const contesto = token.length - hexScelte.reduce((s, x) => s + x.unita.lunghezza, 0);
    if (contesto === 0 && (lessico.get(hexTesto) || 0) >= freqMinima) {
      return dettaglia(hexScelte, 'hex', lessico.get(hexTesto) || 0);
    }
  }
  // 2b. il lessico non ha confermato niente e la legge del nibble regge in
  //     questo file: e' il caso di `0x0E+'0'` da solo, che e' la preposizione «à».
  if (nibbleTesto && confermate.size === 0) return dettaglia(nibbleScelte, 'nibble', 0);
  // 3. una sola ricostruzione confermata.
  if (confermate.size === 1) {
    const [testo, { scelte, freq }] = [...confermate][0];
    void testo;
    return dettaglia(scelte, 'lessico', freq);
  }
  // 4. piu' ricostruzioni che differiscono SOLO per il maiuscolo/minuscolo del
  //    carattere rimesso, e nessun marker a inizio token: a meta' parola una
  //    maiuscola accentata non esiste, quindi si tiene la minuscola.
  if (confermate.size > 1 && !marker.includes(0)) {
    const forme = [...confermate.keys()];
    if (new Set(forme.map((f) => f.toLowerCase())).size === 1) {
      for (const [testo, { scelte, freq }] of confermate) {
        if (scelte.every((s) => s.carattere === s.carattere.toLowerCase())) {
          void testo;
          return dettaglia(scelte, 'lessico (solo il caso era in dubbio)', freq);
        }
      }
    }
  }
  if (confermate.size > 1) {
    return {
      esito: 'rifiutato',
      motivo: `ambiguo: ${confermate.size} ricostruzioni esistono nel corpus`,
      candidati: [...confermate.keys()].slice(0, 6),
    };
  }
  return { esito: 'rifiutato', motivo: 'nessuna prova: nessuna ricostruzione esiste nel corpus', candidati: [] };
}

// ---------------------------------------------------------------------------
// riparazione di un file
// ---------------------------------------------------------------------------

function riparaTesto(testo, lessico, freqMinima) {
  const riparazioni = [];
  const rifiuti = [];
  const mappaAppresa = new Map();

  const tokenConMarker = [];
  for (const m of testo.matchAll(TOKEN_G)) {
    if (MARKER.test(m[0])) tokenConMarker.push({ inizio: m.index, testo: m[0] });
  }

  // Prima passata: i token che la ricerca esaustiva puo' affrontare, con le sole
  // prove che non hanno bisogno di sapere niente sul file — lessico ed hex.
  // Ogni riparazione accettata insegna una firma (byte, coda) -> carattere e
  // porta una prova a favore o contro la legge del nibble.
  const risultati = new Map();
  let proNibble = 0;
  let controNibble = 0;
  for (const t of tokenConMarker) {
    const n = (t.testo.match(MARKER_G) || []).length;
    if (n > MARKER_PER_TOKEN_ESAUSTIVO) continue;
    const r = risolviToken(t.testo, lessico, freqMinima, mappaAppresa, false);
    risultati.set(t.inizio, r);
    if (r && r.esito === 'riparato') {
      for (const d of r.dettagli) {
        const firma = `${d.byte}|${d.coda}`;
        if (mappaAppresa.has(firma) && mappaAppresa.get(firma) !== d.carattere) {
          mappaAppresa.set(firma, null); // in conflitto: inutilizzabile
        } else if (!mappaAppresa.has(firma)) {
          mappaAppresa.set(firma, d.carattere);
        }
        const previsto = caratteredaNibble(d.byte, d.coda);
        if (d.coda.length === 1 && HEX.test(d.coda)) {
          if (previsto === d.carattere) proNibble += 1; else controNibble += 1;
        }
      }
    }
  }
  for (const [k, v] of [...mappaAppresa]) if (v === null) mappaAppresa.delete(k);
  // Tre conferme indipendenti e nessuna smentita: sotto questa soglia la legge
  // non si usa.  E' la differenza fra dedurre e indovinare.
  const leggeNibble = proNibble >= 3 && controNibble === 0;

  // Seconda passata: i token fitti di marker (con le sole firme gia' dimostrate
  // qui) e quelli che la prima passata ha rifiutato, ora che la legge del
  // nibble e' stata verificata o esclusa.
  for (const t of tokenConMarker) {
    const gia = risultati.get(t.inizio);
    if (gia && gia.esito === 'riparato') continue;
    if (gia && !leggeNibble) continue;
    risultati.set(t.inizio, risolviToken(t.testo, lessico, freqMinima, mappaAppresa, leggeNibble));
  }

  // Applicazione, in ordine, ricostruendo il testo.
  let fuori = '';
  let cursore = 0;
  for (const t of tokenConMarker) {
    const r = risultati.get(t.inizio);
    fuori += testo.slice(cursore, t.inizio);
    if (r && r.esito === 'riparato') {
      fuori += r.testo;
      riparazioni.push({ offset: t.inizio, prima: t.testo, dopo: r.testo, canale: r.canale, freq: r.freq, dettagli: r.dettagli });
    } else {
      fuori += t.testo;
      const n = (t.testo.match(MARKER_G) || []).length;
      for (let k = 0; k < n; k += 1) {
        rifiuti.push({ offset: t.inizio, token: t.testo, motivo: r ? r.motivo : 'non analizzato', candidati: r ? r.candidati : [] });
      }
    }
    cursore = t.inizio + t.testo.length;
  }
  fuori += testo.slice(cursore);

  // Nota: non serve un ramo per «marker fuori da ogni parola».  La classe di
  // TOKEN_G contiene i marker, quindi un marker isolato fra due spazi — la
  // virgoletta tipografica, il trattino — e' gia' un token per conto suo, con
  // zero lettere di contesto: passa da risolviToken e ne esce rifiutato per
  // mancanza di prove, che e' esattamente il trattamento giusto.

  return { testo: fuori, riparazioni, rifiuti, leggeNibble, proNibble, controNibble };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function visibile(s) {
  return s.replace(MARKER_G, (c) => `<${c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}>`);
}

function main() {
  const opz = leggiArgomenti(process.argv.slice(2));
  const file = opz.ref
    ? elencaFileGit(opz.radice, opz.cartella, opz.ref)
    : elencaFileDisco(opz.radice, opz.cartella);

  // Decodifica UTF-8 con controllo di ritorno: se un file non e' UTF-8 valido
  // riscriverlo lo distruggerebbe, quindi si esclude e lo si dichiara.
  const testi = new Map();
  const nonUtf8 = [];
  for (const f of file) {
    const grezzo = f.leggi();
    const testo = grezzo.toString('utf8');
    if (!Buffer.from(testo, 'utf8').equals(grezzo)) { nonUtf8.push(f.percorso); continue; }
    testi.set(f.percorso, testo);
  }

  const { lessico, puliti } = costruisciLessico(file, testi);

  const perFile = [];
  const perCoppia = new Map();
  const motivi = new Map();
  let riparate = 0;
  let rifiutate = 0;
  let occorrenze = 0;
  const rifiutiElenco = [];
  const riparazioniElenco = [];

  for (const f of file) {
    const testo = testi.get(f.percorso);
    if (testo === undefined || !MARKER.test(testo)) continue;
    const n = (testo.match(MARKER_G) || []).length;
    occorrenze += n;
    const r = riparaTesto(testo, lessico, opz.freqMinima);
    let nRip = 0;
    for (const rip of r.riparazioni) {
      nRip += rip.dettagli.length;
      riparazioniElenco.push({
        file: f.percorso, offset: rip.offset, prima: visibile(rip.prima), dopo: rip.dopo,
        canale: rip.canale, freqNelCorpus: rip.freq,
      });
      for (const d of rip.dettagli) {
        const chiave = `0x${d.byte.toString(16).padStart(2, '0').toUpperCase()}+${JSON.stringify(d.coda)} -> ${JSON.stringify(d.carattere)}`;
        const voce = perCoppia.get(chiave) || { n: 0, esempio: `${visibile(rip.prima)} -> ${rip.dopo}`, canale: rip.canale };
        voce.n += 1;
        perCoppia.set(chiave, voce);
      }
    }
    for (const rif of r.rifiuti) {
      motivi.set(rif.motivo, (motivi.get(rif.motivo) || 0) + 1);
      if (rifiutiElenco.length < 100000) rifiutiElenco.push({ file: f.percorso, ...rif });
    }
    riparate += nRip;
    rifiutate += r.rifiuti.length;
    perFile.push({
      file: f.percorso, marker: n, riparate: nRip, rifiutate: r.rifiuti.length,
      leggeNibble: r.leggeNibble, nibblePro: r.proNibble, nibbleContro: r.controNibble,
    });
    if (opz.scrivi && nRip > 0) {
      const dest = path.join(opz.radice, f.percorso);
      fs.writeFileSync(dest, Buffer.from(r.testo, 'utf8'));
    }
  }

  const rapporto = {
    modalita: opz.scrivi ? 'SCRITTURA' : 'dry-run',
    sorgente: opz.ref ? `git ${opz.ref}` : path.join(opz.radice, opz.cartella),
    fileTotali: file.length,
    fileNonUtf8: nonUtf8,
    lessico: { filePuliti: puliti, tokenDistinti: lessico.size, freqMinima: opz.freqMinima },
    fileConMarker: perFile.length,
    occorrenze,
    riparate,
    rifiutate,
    perCoppia: [...perCoppia].map(([k, v]) => ({ coppia: k, n: v.n, canale: v.canale, esempio: v.esempio })).sort((a, b) => b.n - a.n),
    motiviRifiuto: [...motivi].map(([k, v]) => ({ motivo: k, n: v })).sort((a, b) => b.n - a.n),
    perFile: perFile.sort((a, b) => b.marker - a.marker),
    // L'elenco completo delle sostituzioni: la issue #94 chiede che il diff
    // venga riletto a mano prima del commit, e questo e' il diff.
    riparazioni: riparazioniElenco,
    rifiuti: rifiutiElenco,
  };

  if (opz.json) {
    process.stdout.write(`${JSON.stringify(rapporto, null, 1)}\n`);
  } else {
    const r = [];
    r.push(`== repair-mangled-chars — ${rapporto.modalita}`);
    r.push(`   sorgente: ${rapporto.sorgente}`);
    r.push(`   lessico:  ${puliti} file senza marker, ${lessico.size} token distinti, soglia freq ${opz.freqMinima}`);
    if (nonUtf8.length) r.push(`   ESCLUSI (non UTF-8 validi): ${nonUtf8.join(', ')}`);
    r.push('');
    r.push(`   file con marker: ${perFile.length}   occorrenze: ${occorrenze}`);
    r.push(`   riparate:  ${riparate}`);
    r.push(`   rifiutate: ${rifiutate}`);
    r.push('');
    r.push('   (byte C0 + coda) -> carattere            n   canale            esempio');
    for (const c of rapporto.perCoppia) {
      r.push(`     ${c.coppia.padEnd(28)} ${String(c.n).padStart(4)}   ${c.canale.padEnd(16)} ${c.esempio}`);
    }
    r.push('');
    r.push('   motivi di rifiuto:');
    for (const m of rapporto.motiviRifiuto) r.push(`     ${String(m.n).padStart(4)}  ${m.motivo}`);
    r.push('');
    r.push('   per file:');
    for (const f of rapporto.perFile) {
      const legge = f.leggeNibble ? `nibble ON (${f.nibblePro} pro / ${f.nibbleContro} contro)` : `nibble off (${f.nibblePro}/${f.nibbleContro})`;
      r.push(`     ${String(f.marker).padStart(4)} marker  ${String(f.riparate).padStart(4)} riparati  ${String(f.rifiutate).padStart(4)} rifiutati  ${legge.padEnd(30)} ${f.file}`);
    }
    if (rifiutiElenco.length) {
      r.push('');
      r.push(`   rifiuti (primi ${Math.min(opz.maxRifiutiMostrati, rifiutiElenco.length)} di ${rifiutiElenco.length}):`);
      const visti = new Set();
      let mostrati = 0;
      for (const x of rifiutiElenco) {
        const chiave = `${x.file}|${x.token}|${x.motivo}`;
        if (visti.has(chiave)) continue;
        visti.add(chiave);
        mostrati += 1;
        if (mostrati > opz.maxRifiutiMostrati) break;
        const cand = x.candidati && x.candidati.length ? `  [${x.candidati.join(' | ')}]` : '';
        r.push(`     ${x.file}:${x.offset}  ${JSON.stringify(visibile(x.token))}  ${x.motivo}${cand}`);
      }
    }
    r.push('');
    if (!opz.scrivi) r.push('   DRY-RUN: nessun file e\' stato toccato. Per scrivere: --write');
    process.stdout.write(`${r.join('\n')}\n`);
  }

  process.exit(rifiutate > 0 ? 2 : 0);
}

// Guardia CLI: importare questo file da un test non deve eseguirlo.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { riparaTesto, risolviToken, costruisciLessico, ritaglia, MARKER, MARKER_G, TOKEN_G, ALFABETO };
