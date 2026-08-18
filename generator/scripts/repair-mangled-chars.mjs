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
 * indistinguibile da un refuso e nessuna scansione di byte la trova piu'.
 * E' gia' successo: i tre `content/blog-meta-*.ts` avevano 10 occorrenze
 * l'08-08 e sul main del 09-08 hanno la cifra orfana senza piu' l'ancora.
 * Per quelle serve un ingresso che parta dal RESIDUO invece che dal marker:
 * e' il blocco «IL RESIDUO» piu' sotto, e non e' un quarto modo di indovinare
 * — la prova resta il testimone, che e' l'unica che non ha bisogno di sapere
 * quale byte c'era.
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
 * LE TRE PROVE, TUTTE ANCORATE AL CORPUS
 *
 *   testimone — la STESSA FRASE, pulita, altrove nel corpus.  Si prendono 16
 *             caratteri prima del marker e 24 dopo (saltando la coda) e si
 *             cerca quella coppia di ancore nei file senza marker: cio' che i
 *             testimoni hanno in mezzo e' il carattere perduto.  Vedi il blocco
 *             «IL CANALE TESTIMONE» piu' sotto per il perche' accetta solo UNA
 *             LETTERA e per il caso in cui accettare altro fabbrica il difetto.
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
 * LE DUE SPELLING DELLO STESSO DIFETTO
 *
 * Il byte C0 non e' l'unico modo in cui questo difetto sta scritto su disco.
 * Dentro un blob `.faq` — JSON dentro un letterale TS — lo stesso control
 * character e' scritto `\\u0016` / `\\b` / `\\f`, senza un byte C0 da nessuna
 * parte, e arriva intatto dentro il `FAQPage` ld+json della pagina.  Fino a
 * #345 questo script guardava solo il byte, quindi su quelle occorrenze
 * riportava zero — la stessa classe di falso negativo che #336 ha chiuso
 * sull'oracolo.  Il blocco «LA SPELLING ESCAPATA» piu' sotto le vede, e le
 * ripara con la SOLA prova del testimone unanime cross-locale: li' il lessico
 * non e' una prova, e il perche' e' misurato in quel blocco.
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

import { stripLasciaResiduo } from './lib/control-char-write-report.mjs';
// L'oracolo della spelling escapata, non una seconda definizione: e' lo stesso
// `ESCAPED_C0_RX` che conta le occorrenze in `find-dirty-content-ids.mjs`
// (#336, #338).  Se quella regex cambia — le forme brevi `\b`/`\f` sono state
// aggiunte dopo — questo riparatore la segue senza saperlo.  Riscriverla qui
// sarebbe il modo esatto in cui le due spelling sono divergute la prima volta.
import { findEscapedControlChars } from '../../scripts/find-dirty-content-ids.mjs';

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

Uscita: 0 tutto risolto, 2 restano rifiuti (byte C0 o spelling escapata),
        1 errore d'uso.
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
// IL CANALE TESTIMONE — la stessa frase, pulita, altrove nel corpus
// ---------------------------------------------------------------------------
//
// PERCHE' SERVE.  Il lessico sa solo dire se una PAROLA esiste.  Non puo' dire
// niente dove la parola ricostruita non e' nel corpus («scénarios» storpiato in
// `sc<00>f<16>9narios` non e' una parola con un marker dentro: sono due marker e
// una lettera di troppo), ne' dove la stessa forma esiste in due lingue
// («Municipalité» / «Municipalità»).  Al 2026-08-11 restavano 234 occorrenze e
// 116 di quelle avevano come motivo esattamente «nessuna ricostruzione di una
// lettera sola esiste nel corpus».  Il canale che mancava non e' un dizionario
// esterno: e' il corpus stesso, letto come TESTO invece che come elenco di
// parole.  Lo stesso articolo, o un altro articolo che dice la stessa frase,
// spesso e' pulito.
//
// COME FUNZIONA.  Per un marker in posizione i si prendono
//   P = i 16 caratteri prima  (devono essere puliti)
//   Q = i 24 caratteri dopo il marker e la sua coda  (devono essere puliti)
// e si cercano P e Q, adiacenti, nei file del corpus SENZA marker.  Cio' che il
// testimone ha fra P e Q e' il carattere che manca.  Le due ancore sono 40
// caratteri esatti: un allineamento sbagliato non e' improbabile, e' escluso.
//
// PERCHE' ACCETTA SOLO UNA LETTERA, ed e' la parte da non allentare.
//
// I testimoni sono ALTRE GENERAZIONI dello stesso testo, e due generazioni
// concordano sulle parole ma NON sulla punteggiatura ne' sull'impaginazione.
// Misurato su `content/blog-body/it/lavena-ponte-tresa-territorio-poroso.ts`
// contro il suo gemello pulito `content/blog-body/de/...` (che porta lo stesso
// testo italiano, non tradotto):
//
//   sporco    'due paesi<08>3. Questo'      gemello  'due paesi." Questo'
//   sporco    'nella zona. <08>3Il turismo' gemello  'nella zona. \n\n"Il turismo'
//   sporco    'svizzeri<08>3. Il sindaco'   gemello  'svizzeri. Il sindaco'
//
// Il primo sposta la virgoletta dall'altra parte del punto, il secondo apre un
// paragrafo che nel file sporco non c'e', il terzo non mette niente.  Una
// versione precedente di questo canale — che accettava qualunque cosa i
// testimoni avessero in mezzo — proponeva tutte e tre, cioe' 22 «riparazioni»
// su quel file: nessuna delle tre ripara un carattere, tutte e tre importano
// l'impaginazione di un'altra generazione, e la terza butta via l'ancora.
// Accettando solo UNA LETTERA quelle 22 spariscono e restano 8 occorrenze che
// sono davvero una lettera accentata perduta.  E' lo stesso fail-closed del
// resto dello script: meglio un residuo dichiarato di una correzione inventata.
//
// PERCHE' 16 E NON 24 CARATTERI DI ANCORA A SINISTRA.  Misurato sui 234 marker
// di a96290fb: con 24 il canale ne risolve 4, con 16 ne risolve 8, con 12 ne
// risolve 8 — cioe' fra 12 e 16 il risultato e' lo stesso ed e' 24 a essere
// troppo stretto.  Il caso che 24 perde e' `seo/seo-blog-4.ts`, dove la frase
// e' preceduta da `title: '` mentre il testimone la fa precedere da `body3': '`:
// il testo e' identico, la chiave che lo contiene no.

/** Ancora a sinistra del marker, in caratteri. */
const TESTIMONE_PRIMA = 16;
/** Ancora a destra, dopo la coda. Piu' lunga: e' quella che esclude gli omonimi. */
const TESTIMONE_DOPO = 24;
/** Quanti caratteri il marker si puo' portare via oltre a se stesso. */
const TESTIMONE_CODA_MAX = 3;
/** Tetto sui riscontri esaminati per una singola ancora. */
const TESTIMONE_RISCONTRI_MAX = 500;
/** Quante volte si ripassa: una riparazione puo' ripulire l'ancora di un'altra. */
const TESTIMONE_GIRI_MAX = 4;

const LETTERA = /\p{L}/u;

/**
 * I file senza un solo marker: sono gli unici che possono fare da testimone.
 *
 * «Senza un solo marker» vuol dire in NESSUNA DELLE DUE SPELLING.  Un file che
 * porta `imparzialit a1` non ha un byte C0 addosso — `MARKER.test` su di
 * lui e' falso — ma e' sporco esattamente come gli altri, e finche' passava
 * questo filtro faceva da testimone e da voce di lessico.  Il danno non e'
 * teorico: `TOKEN_G` non contiene il backslash, quindi quel token si spezza in
 * `imparzialit` + `u0000a1` e il lessico impara `imparzialit` come se fosse una
 * parola del corpus pulito — cioe' la PAROLA MUTILATA diventa la prova con cui
 * si confermano le ricostruzioni altrove.  Misurato su `content/` al
 * 2026-08-14: 22 file, 45 occorrenze, tutte dentro un blob `.faq`.
 */
function costruisciTestimoni(file, testi) {
  const fuori = [];
  for (const f of file) {
    const testo = testi.get(f.percorso);
    if (testo === undefined || MARKER.test(testo) || haEscapate(testo)) continue;
    fuori.push({ percorso: f.percorso, testo });
  }
  return fuori;
}

/**
 * Dove il prefisso compare nei testimoni.  In cache: la stessa frase si ripete
 * — `lavena-ponte-tresa` ha 22 marker su una manciata di frasi distinte — e una
 * scansione del corpus costa 168 milioni di caratteri.
 */
function riscontriPrefisso(prefisso, testimoni, cache) {
  const gia = cache.get(prefisso);
  if (gia) return gia;
  const fuori = [];
  for (const t of testimoni) {
    let da = t.testo.indexOf(prefisso);
    while (da !== -1) {
      fuori.push({ percorso: t.percorso, testo: t.testo, dopo: da + prefisso.length });
      if (fuori.length >= TESTIMONE_RISCONTRI_MAX) break;
      da = t.testo.indexOf(prefisso, da + 1);
    }
    if (fuori.length >= TESTIMONE_RISCONTRI_MAX) break;
  }
  cache.set(prefisso, fuori);
  return fuori;
}

/**
 * Risolve il marker in posizione `i` col canale testimone.
 * Ritorna { coda, carattere, testimoni } oppure { motivo }.
 */
function risolviConTestimone(testo, i, testimoni, cache) {
  const P = testo.slice(Math.max(0, i - TESTIMONE_PRIMA), i);
  if (P.length < TESTIMONE_PRIMA || MARKER.test(P)) {
    return { motivo: 'testimone: l\'ancora prima del marker e\' corta o sporca' };
  }
  const riscontri = riscontriPrefisso(P, testimoni, cache);
  if (riscontri.length === 0) {
    return { motivo: 'testimone: la frase non compare in nessun file pulito' };
  }
  for (let coda = 0; coda <= TESTIMONE_CODA_MAX; coda += 1) {
    const inizioQ = i + 1 + coda;
    const Q = testo.slice(inizioQ, inizioQ + TESTIMONE_DOPO);
    // La coda PUO' contenere altri marker (`<00>f<16>9` sta al posto di una sola
    // é), l'ancora Q no: e' lei a dire dove ricomincia il testo buono.
    if (Q.length < TESTIMONE_DOPO || MARKER.test(Q)) continue;
    const proposte = new Map();
    for (const r of riscontri) {
      const carattere = r.testo[r.dopo];
      if (carattere === undefined || !LETTERA.test(carattere)) continue;
      if (!r.testo.startsWith(Q, r.dopo + 1)) continue;
      const elenco = proposte.get(carattere) || [];
      elenco.push(r.percorso);
      proposte.set(carattere, elenco);
    }
    if (proposte.size === 1) {
      const [carattere, percorsi] = [...proposte][0];
      return { coda, carattere, testimoni: [...new Set(percorsi)] };
    }
    if (proposte.size > 1) {
      return { motivo: `testimone: ${proposte.size} lettere diverse nello stesso punto (${[...proposte.keys()].join(' ')})` };
    }
  }
  return { motivo: 'testimone: nessun testimone mette UNA LETTERA in quel punto' };
}

/**
 * Passa tutto il file col canale testimone, fino a punto fisso.
 * Ritorna { testo, riparazioni } — le riparazioni hanno la stessa forma di
 * quelle di `riparaTesto`, cosi' il rapporto e' uno solo.
 */
function riparaConTestimoni(testo, testimoni, cache) {
  const riparazioni = [];
  let corrente = testo;
  for (let giro = 0; giro < TESTIMONE_GIRI_MAX; giro += 1) {
    let fatto = false;
    for (const m of [...corrente.matchAll(MARKER_G)]) {
      const i = m.index;
      const esito = risolviConTestimone(corrente, i, testimoni, cache);
      if (!esito.carattere) continue;
      const prima = corrente.slice(i, i + 1 + esito.coda);
      riparazioni.push({
        offset: i,
        prima,
        dopo: esito.carattere,
        canale: 'testimone',
        freq: esito.testimoni.length,
        dettagli: [...prima].filter((c) => MARKER.test(c)).map((c, k) => ({
          byte: c.charCodeAt(0),
          coda: k === 0 ? prima.slice(1) : '',
          carattere: k === 0 ? esito.carattere : '',
        })),
        testimoni: esito.testimoni.slice(0, 3),
      });
      corrente = corrente.slice(0, i) + esito.carattere + corrente.slice(i + 1 + esito.coda);
      fatto = true;
      break; // gli offset sono cambiati: si ricomincia la scansione
    }
    if (!fatto) break;
  }
  return { testo: corrente, riparazioni };
}

// ---------------------------------------------------------------------------
// LA SPELLING ESCAPATA — lo stesso difetto, scritto `\u00XX` / `\b` / `\f`
// ---------------------------------------------------------------------------
//
// COS'E'.  Il campo `.faq` di un corpo articolo e' JSON dentro un letterale TS,
// e `JSON.stringify` scrive i C0 come `\u00XX` (o `\b`/`\f` per 0x08 e 0x0C).
// Il backslash del JSON e' poi escapato dal letterale TS, quindi sul disco si
// legge `\\u0016`.  La catena e' lossless: il control character c'e', arriva
// alla pagina dentro il `FAQPage` ld+json, e il crawler lo legge.  Quello che
// non c'e' e' il BYTE — quindi tutto cio' che sta sopra, che parte da
// `MARKER.test`, non vedeva niente.  Misurato su `content/` al 2026-08-14: 45
// occorrenze in 22 file, e il rapporto di questo script diceva zero.
//
// COME LA SI VEDE.  Si decodifica il testo — ogni spelling escapata diventa il
// carattere che denota — e si tiene una mappa verso il testo ORIGINALE, che e'
// l'unico che si riscrive.  Cosi' il canale testimone lavora sul testo come lo
// legge un lettore, senza sapere in quale spelling il difetto fosse scritto, e
// nessun byte C0 finisce mai su disco.
//
// PERCHE' SOLO IL TESTIMONE, E PERCHE' UNANIME E CROSS-LOCALE.
//
// Il canale del lessico qui non e' una prova, ed e' il corpus a dirlo.  Queste
// 45 occorrenze non sono 45 caratteri perduti in 45 lingue: sono un difetto
// nato nell'ITALIANO e poi PROPAGATO VERBATIM dal traduttore, che ha trattato
// il marker come un token intraducibile.  Misurato sulle quattro copie della
// stessa FAQ (`salario-minimo-per-il-controprogetto-la-strada-e-in-discesa`):
//
//   it  `Il salario minimo sociale \b5 una proposta`   -> «è»
//   de  `Der soziale Mindestlohn \b5 ein Vorschlag`    -> «ist»
//   en  `The social minimum wage \b5 a proposal`       -> «is»
//   fr  `Le salaire minimum social \b5 une proposition` -> «est»
//
// La STESSA coppia (0x08,'5') sta al posto di quattro cose diverse, e tre di
// esse non sono nemmeno un carattere: sono una parola.  Una prova che guarda la
// parola ricostruita — il lessico, l'esadecimale, la legge del nibble — su
// questa famiglia non sta deducendo, sta traducendo a occhio.  E' la forma
// esatta del difetto che in un giro precedente ha DISTRUTTO i titoli: un
// detector che sbagliava un terzo delle volte e poi «riparava» partendo dalla
// lingua sbagliata, fabbricando parte del guasto invece di subirlo.
//
// Quindi qui la sola prova ammessa e' il testimone, con due strette in piu'
// rispetto al canale dei byte:
//
//   UNANIME     — `risolviConTestimone` accetta gia' solo il caso in cui TUTTI
//                 i riscontri mettono la STESSA UNICA LETTERA in quel punto
//                 (`proposte.size === 1`); due lettere diverse sono un rifiuto.
//   CROSS-LOCALE — almeno un testimone deve stare in un locale DIVERSO da
//                 quello del file sporco.  Un testimone nello stesso locale e'
//                 quasi sempre un'altra generazione della stessa pipeline, che
//                 ha visto lo stesso testo italiano corrotto: conferma la
//                 propagazione, non il carattere.  Un locale diverso e' un
//                 ramo di traduzione indipendente.
//
// COSA COSTA, DICHIARATO.  Su `content/` al 2026-08-14 questa precondizione
// ripara ZERO occorrenze su 45: 14 perche' la frase non compare in nessun file
// pulito (il testo di una FAQ e' per-articolo, i suoi gemelli sono tradotti),
// 26 perche' nessun testimone mette UNA LETTERA in quel punto, 5 perche'
// l'ancora a sinistra e' corta o sporca.  Zero riparazioni non e' un canale che
// non funziona: e' il canale che si ferma dove si fermerebbe un umano onesto.
// Le 45 restano col loro marker — cioe' con la loro ancora — e ora sono
// CONTATE nel rapporto e nel codice d'uscita, che e' la differenza fra un
// residuo dichiarato e un residuo invisibile.

/** I locali del corpus.  Serve a leggere il locale da un percorso, niente piu'. */
const LOCALI = new Set(['it', 'en', 'de', 'fr']);

/**
 * Il locale di un file di `content/`, o `null` se il percorso non lo dice.
 * Due forme: `content/blog-body/<loc>/<slug>.ts` e `content/blog-meta-<loc>.ts`.
 */
function localeDi(percorso) {
  const cartella = /(?:^|\/)([a-z]{2})\/[^/]+$/.exec(percorso);
  if (cartella && LOCALI.has(cartella[1])) return cartella[1];
  const suffisso = /-([a-z]{2})\.[A-Za-z]+$/.exec(percorso);
  return suffisso && LOCALI.has(suffisso[1]) ? suffisso[1] : null;
}

/** Il file porta almeno un C0 in forma escapata? */
function haEscapate(testo) {
  return findEscapedControlChars(testo).length > 0;
}

/**
 * `testo` con ogni spelling escapata sostituita dal carattere che denota, piu'
 * la mappa verso l'originale: per ogni carattere decodificato `inizioIn` e
 * `fineIn` dicono quale tratto dell'originale lo produce, e `daEscape` se
 * quel carattere e' uno dei marker che si stanno cercando.
 * `null` se nel testo non c'e' nessuna spelling escapata.
 */
function decodificaEscapate(testo) {
  const occorrenze = findEscapedControlChars(testo);
  if (occorrenze.length === 0) return null;
  let fuori = '';
  const inizioIn = [];
  const fineIn = [];
  const daEscape = [];
  const aggiungi = (a, b, escapato) => { inizioIn.push(a); fineIn.push(b); daEscape.push(escapato); };
  let cursore = 0;
  for (const o of occorrenze) {
    for (let k = cursore; k < o.index; k += 1) { fuori += testo[k]; aggiungi(k, k + 1, false); }
    fuori += String.fromCharCode(o.code);
    aggiungi(o.index, o.index + o.spelling.length, true);
    cursore = o.index + o.spelling.length;
  }
  for (let k = cursore; k < testo.length; k += 1) { fuori += testo[k]; aggiungi(k, k + 1, false); }
  return { testo: fuori, inizioIn, fineIn, daEscape };
}

/**
 * Un giro di sola VALUTAZIONE: cosa si potrebbe riparare in `testo` e cosa no.
 * Non applica niente, e continua a raccogliere i rifiuti anche dopo aver
 * trovato la prima riparazione possibile — cosi' `lasciate` e' completo a ogni
 * giro, tetto dei giri compreso.  Un elenco di residui che si accorcia perche'
 * il ciclo si e' fermato sarebbe la peggiore delle uscite: dichiarerebbe pulito
 * cio' che nessuno ha guardato.
 *
 * Per la stessa ragione le risolvibili che NON vengono scelte in questa passata
 * escono in `rinviate` (issue #366).  Se ne applica una per giro, quindi le
 * altre normalmente tornano al giro dopo — ma «normalmente» non e' «sempre»: al
 * tetto di `TESTIMONE_GIRI_MAX` il giro dopo non c'e', e finche' questa
 * funzione ritornava solo `{lasciate, scelta}` quelle occorrenze non stavano
 * in nessuno dei due elenchi.  Restavano sul disco, non contate e senza toccare
 * il codice d'uscita: sparite in silenzio, che e' esattamente cio' che il
 * commento qui sopra promette non possa succedere.
 */
function valutaEscapate(mio, testo, testimoni, cache) {
  const d = decodificaEscapate(testo);
  if (!d) return { lasciate: [], scelta: null, rinviate: [] };
  const lasciate = [];
  const rinviate = [];
  let scelta = null;
  for (let i = 0; i < d.daEscape.length; i += 1) {
    if (!d.daEscape[i]) continue;
    const a = d.inizioIn[i];
    const spelling = testo.slice(a, d.fineIn[i]);
    // L'estrazione, calcolata QUI e non nel rapporto: `testo` e' il testo su cui
    // l'offset e' valido: ogni riparazione applicata prima sposta tutto.
    const estratto = { marker: etichettaMarker(d.testo.charCodeAt(i)), contesto: contestoDi(testo, a, d.fineIn[i]) };
    const esito = risolviConTestimone(d.testo, i, testimoni, cache);
    if (!esito.carattere) {
      lasciate.push({ offset: a, spelling, ...estratto, motivo: esito.motivo });
      continue;
    }
    const locali = [...new Set(esito.testimoni.map(localeDi))];
    if (!locali.some((l) => l && l !== mio)) {
      lasciate.push({
        offset: a,
        spelling,
        ...estratto,
        motivo: `testimone: nessun testimone fuori dal locale ${JSON.stringify(mio)} (${locali.map((l) => JSON.stringify(l)).join(' ')})`,
      });
      continue;
    }
    // La coda e' contata in caratteri DECODIFICATI: il tratto di originale da
    // sostituire finisce dove finisce l'ultimo di essi, che NON e' `a + coda`
    // — un carattere della coda puo' essere a sua volta una spelling escapata,
    // cioe' sette caratteri di file per uno solo di testo.
    const ultimo = i + esito.coda;
    if (ultimo >= d.fineIn.length) {
      lasciate.push({ offset: a, spelling, ...estratto, motivo: 'testimone: la coda esce dal file' });
      continue;
    }
    const risolvibile = {
      offset: a,
      spelling,
      ...estratto,
      fine: d.fineIn[ultimo],
      prima: testo.slice(a, d.fineIn[ultimo]),
      dopo: esito.carattere,
      canale: 'escapata (testimone unanime cross-locale)',
      freq: esito.testimoni.length,
      testimoni: esito.testimoni.slice(0, 3),
      locali: locali.filter(Boolean),
    };
    if (!scelta) scelta = risolvibile;
    else rinviate.push(risolvibile);
  }
  return { lasciate, scelta, rinviate };
}

/**
 * Passa il file sulla spelling escapata, fino a punto fisso.  Ritorna il testo
 * ORIGINALE con le sole occorrenze provate dal testimone unanime cross-locale
 * sostituite, piu' l'elenco di cio' che si e' lasciato e perche'.  Si applica
 * una riparazione per giro perche' ognuna sposta tutti gli offset, e perche'
 * una riparazione puo' ripulire l'ancora della successiva.
 *
 * IL TETTO DEI GIRI NON E' UN PERMESSO A FAR SPARIRE NIENTE (issue #366).  Un
 * file con piu' di `TESTIMONE_GIRI_MAX` occorrenze risolvibili esce dal ciclo
 * con `scelta` ancora piena e, dietro di lei, le `rinviate` di quell'ultima
 * passata: sono ancora sul disco, con la loro spelling, e vanno dichiarate.
 * Finiscono in `lasciate` col motivo che dice perche' — cosi' contano nel
 * rapporto e nel codice d'uscita, come ogni altra occorrenza non riparata, e un
 * secondo giro dello script le ripara davvero invece di ignorarle.
 */
function riparaEscapate(percorso, testo, testimoni, cache) {
  const riparazioni = [];
  const mio = localeDi(percorso);
  let corrente = testo;
  let esito = valutaEscapate(mio, corrente, testimoni, cache);
  for (let giro = 0; giro < TESTIMONE_GIRI_MAX && esito.scelta; giro += 1) {
    const s = esito.scelta;
    corrente = corrente.slice(0, s.offset) + s.dopo + corrente.slice(s.fine);
    riparazioni.push(s);
    esito = valutaEscapate(mio, corrente, testimoni, cache);
  }
  const lasciate = [...esito.lasciate];
  if (esito.scelta) {
    const motivo = `testimone: risolvibile, non applicata — tetto di ${TESTIMONE_GIRI_MAX} riparazioni per file raggiunto (rilanciare lo script)`;
    for (const r of [esito.scelta, ...esito.rinviate]) {
      lasciate.push({ offset: r.offset, spelling: r.spelling, marker: r.marker, contesto: r.contesto, motivo });
    }
  }
  lasciate.sort((a, b) => a.offset - b.offset);
  return { testo: corrente, riparazioni, lasciate };
}

// ---------------------------------------------------------------------------
// IL RESIDUO — l'ingresso per le occorrenze che il marker non ce l'hanno piu'
// ---------------------------------------------------------------------------
//
// PERCHE' SERVE UN INGRESSO DIVERSO.  Tutto cio' che sta sopra parte dal byte
// C0: e' lui a dire DOVE guardare.  Ma il sanificatore di #65 toglie il byte e
// lascia la coda dentro la parola, e da quel momento l'occorrenza e' invisibile
// a qualunque scansione di byte — il byte non c'e' piu'.  E' il caso di
// `content/blog-meta-it.ts`, che porta `Intesa o sar0 l'inferno` dove il corpus
// dice `sarò`, e che `meta-it.json` pubblica come TITOLO dell'articolo
// `trump-intesa-o-inferno`: user-facing, e dentro i dati strutturati.
//
// COME SI RICONOSCE.  La firma di cio' che lo strip lascia dietro e' gia'
// scritta e ha gia' un nome: `stripLasciaResiduo`, in
// `lib/control-char-write-report.mjs`.  Quella funzione guarda il testo PRIMA
// dello strip e dice se togliere il marker incolla una cifra a una lettera.
// Qui la si interroga dal lato opposto del tempo — il marker non c'e' piu' —
// ricostruendo la finestra minima che legge, con un marker finto davanti alla
// cifra.  Stessa domanda, stessa risposta, e una sola definizione di «residuo»
// nel repo: se quella cambia, cambia anche questo canale.
//
// PERCHE' IL LESSICO QUI NON PUO' ESSERE UNA PROVA, E LO DICONO I NUMERI.
// Misurato su `content/` al 2026-08-11 (15.520 file): la forma «cifra incollata
// a una lettera» compare in **189.124 posizioni**.  Non sono 189.124 difetti:
// sono targhe di autostrada, sigle di treni, date ISO, slug di URL.  Di quelle,
// **46** hanno almeno una ricostruzione di UNA LETTERA che il corpus pulito
// conosce gia' — ed e' li' che si vede quanto sarebbe distruttivo prendere il
// lessico per una prova, perche' quasi tutte e 46 sono TESTO GIUSTO:
//
//     13a AVS                        il lessico proponerebbe «ça AVS»      ×3
//     l\'A2, l\'A9  (le autostrade)   «l'à», «l'è»                          ×4
//     user_polizia_pi1[newsId]       «user_polizia_più[newsId]»            ×12
//     il bus notturno 'N1'           «'Né'»                                ×3
//     il treno 'S5'                  «'Sì'»                                ×3
//     il terzo pilastro 3a           «ça»                                  ×3
//     %22il dentro uno slug          «œil»                                 ×4
//     ...-und-13tes-avs (dreizehntes) «êtes»                               ×1
//     ...-dal-5-all11-maggio (URL)   «all’1»                               ×4
//     d-c3-a9s-c3-a9quilibre (rotta) «équilibre»                           ×1
//
// Undici famiglie, dieci delle quali sono danni — e sei sono dentro URL o
// chiavi di rotta, dove una lettera al posto di una cifra non e' un refuso: e'
// un link morto.  Quindi il lessico qui fa due mestieri, e nessuno dei due e'
// «decidere»:
//
//   PREFILTRO — dove nessuna ricostruzione di una lettera esiste nel corpus non
//     c'e' niente da provare, e le posizioni da esaminare scendono da 189.124 a
//     46.  E' cio' che rende il canale eseguibile: la ricerca del testimone
//     costa una scansione di 168 milioni di caratteri per ancora distinta.
//     Essendo un prefiltro, e' anche un LIMITE dichiarato di richiamo — un
//     residuo la cui parola riparata non e' da nessuna altra parte nel corpus
//     non viene nemmeno guardato.
//   CONFERMA — la lettera che il testimone propone deve fare una parola che il
//     corpus pulito gia' conosce (>= `--min-freq`).  E' la seconda prova, ed e'
//     qui che serve piu' che nel canale dei marker: li' il byte C0 diceva gia'
//     che QUALCOSA era rotto, qui invece l'ingresso da solo non lo dice.
//
// L'ANCORA A SINISTRA DA SOLA, e perche' non e' un allentamento.
// Il canale dei marker usa 16 caratteri prima e 24 dopo — 40 di ancora.  Il
// residuo pero' capita anche in FONDO a un valore, e li' i 24 dopo non sono piu'
// testo: sono il contenitore.  Misurato sul secondo residuo dello stesso titolo,
// `spostato a marted8`: quattro riscontri nel corpus, tutti e quattro con `ì`,
// e nessuno che combaci a destra perche' `blog-meta-it.ts` continua con
// `',\n 'blog.article...` mentre i testimoni continuano con `',\n ogDescription:`
// e con `\n\nL'ultimatum`.  E' l'immagine speculare della ragione per cui #218
// ha scelto 16 e non 24 a sinistra (`title: '` contro `body3': '`): il testo e'
// identico, il contenitore no.  Quindi il budget di 40 caratteri resta, e dove
// il lato destro non puo' portarne si spostano tutti a sinistra — 40 e 0 — con
// la conferma del lessico obbligatoria (che nel modo stretto e' un di piu' e
// qui e' l'unica cosa che sostituisce l'ancora mancante).
//
// COSA NON FA.  Non accetta un rimpiazzo che non sia UNA LETTERA: e' lo stesso
// vincolo del canale dei marker e per la stessa ragione misurata li'.  Costa
// `dell6educazione` — `dell’educazione` esiste 40 volte nel corpus — e va bene
// cosi': un apostrofo tipografico e' punteggiatura, e sulla punteggiatura due
// generazioni dello stesso testo non concordano.  Resta dichiarato nel rapporto.

/**
 * Il marker finto con cui si interroga `stripLasciaResiduo` su un testo da cui
 * il marker vero e' gia' stato tolto.  Non finisce mai in un file: serve solo a
 * ricomporre la finestra di quattro caratteri che quella funzione legge.
 */
const MARKER_FINTO = String.fromCharCode(0x16);

/** L'ancora a sinistra quando quella a destra non esiste (vedi sopra). */
const RESIDUO_PRIMA_SOLA = 40;
/** Quanti caratteri puo' occupare il residuo: la coda che il marker si e' portato dietro. */
const RESIDUO_SPAN_MAX = 3;
/** Quante volte si ripassa: una riparazione puo' ripulire l'ancora di un'altra. */
const RESIDUO_GIRI_MAX = 4;

const CIFRA = /[0-9]/;
const ESADECIMALE = /^[0-9a-fA-F]$/;

/**
 * Le posizioni che hanno la forma di un residuo: una cifra che, se davanti le
 * si rimettesse il marker, `stripLasciaResiduo` direbbe che togliendolo si
 * rompe una parola.  I token che hanno ANCORA il marker dentro non entrano:
 * quelli li risolvono i canali ancorati, che hanno piu' informazione.
 */
function residuiDi(testo) {
  const token = [];
  for (const m of testo.matchAll(TOKEN_G)) token.push({ a: m.index, b: m.index + m[0].length, testo: m[0] });
  const fuori = [];
  let k = 0;
  for (let j = 0; j < testo.length; j += 1) {
    if (!CIFRA.test(testo[j])) continue;
    const finestra = `${testo[j - 1] || ''}${MARKER_FINTO}${testo[j]}${testo[j + 1] || ''}`;
    if (!stripLasciaResiduo(finestra, 1)) continue;
    while (k < token.length && token[k].b <= j) k += 1;
    const t = k < token.length && token[k].a <= j ? token[k] : null;
    if (!t || MARKER.test(t.testo)) continue;
    fuori.push({ j, token: t });
  }
  return fuori;
}

/**
 * Gli inizi possibili del residuo, dal piu' corto: la cifra da sola, poi la
 * cifra con uno o due caratteri esadecimali davanti — la coda di `d<00>e9lais`
 * dopo lo strip e' `e9`, non `9`.  Non si esce mai dal token.
 *
 * I caratteri davanti alla cifra devono essere esadecimali MINUSCOLI, ed e' la
 * stessa asimmetria (e la stessa misura) di `unitaPossibili`: una A-F maiuscola
 * non e' quasi mai una coda, e' l'iniziale di una parola vera.  Qui costa ancora
 * piu' caro che li', perche' il residuo non ha piu' il marker a dire dove
 * comincia il guasto: misurato in dry-run su `content/` prima di scrivere una
 * riga, senza questa riga il canale prendeva `l\'A2` (l'autostrada) per una
 * coda `A2` e proponeva `l\'A`, con la benedizione del lessico — che conosce
 * «A» da solo 7.029 volte.
 */
function inizioResiduo(testo, j, token) {
  const fuori = [j];
  for (let k = 1; k < RESIDUO_SPAN_MAX; k += 1) {
    const s = j - k;
    if (s < token.a) break;
    const c = testo[s];
    if (!ESADECIMALE.test(c) || c !== c.toLowerCase()) break;
    fuori.push(s);
  }
  return fuori;
}

/**
 * La parola che esce rimettendo `carattere` al posto del residuo `[s, j]`,
 * ritagliata come la ritaglia il lessico.  `null` se non c'e' abbastanza
 * contesto o se il carattere rimesso non sopravvive al ritaglio — senza
 * quest'ultimo controllo un apostrofo di bordo si vedrebbe «confermato» da una
 * parola che non lo contiene (e' lo stesso di `sostituzioniDentro`, e senza di
 * lui 82 code di timestamp `...138Z'` si confermavano come «Z»).
 */
function parolaDalResiduo(token, s, j, carattere) {
  const prima = token.testo.slice(0, s - token.a);
  const dopo = token.testo.slice(j + 1 - token.a);
  if (prima.length + dopo.length < CONTESTO_MINIMO) return null;
  const intero = prima + carattere + dopo;
  const ritagliato = ritaglia(intero);
  const spostamento = intero.indexOf(ritagliato);
  if (prima.length < spostamento || prima.length >= spostamento + ritagliato.length) return null;
  return ritagliato;
}

/**
 * Cosa dicono i testimoni sul residuo `[s, j]`, con le ancore date.
 * `dopo === 0` e' il modo ad ancora sinistra sola: `startsWith('')` e' sempre
 * vero, quindi lo stesso codice serve i due modi senza un ramo in piu'.
 */
function risolviResiduoConTestimone(testo, s, j, testimoni, cache, prima, dopo) {
  const P = testo.slice(Math.max(0, s - prima), s);
  if (P.length < prima || MARKER.test(P)) {
    return { motivo: `testimone: l'ancora prima del residuo e' corta o sporca (${prima})` };
  }
  const Q = testo.slice(j + 1, j + 1 + dopo);
  if (Q.length < dopo || MARKER.test(Q)) {
    return { motivo: `testimone: l'ancora dopo il residuo e' corta o sporca (${dopo})` };
  }
  const riscontri = riscontriPrefisso(P, testimoni, cache);
  if (riscontri.length === 0) return { motivo: 'testimone: la frase non compare in nessun file pulito' };
  const proposte = new Map();
  for (const r of riscontri) {
    const carattere = r.testo[r.dopo];
    if (carattere === undefined || !LETTERA.test(carattere)) continue;
    if (!r.testo.startsWith(Q, r.dopo + 1)) continue;
    const elenco = proposte.get(carattere) || [];
    elenco.push(r.percorso);
    proposte.set(carattere, elenco);
  }
  if (proposte.size === 1) {
    const [carattere, percorsi] = [...proposte][0];
    return { carattere, testimoni: [...new Set(percorsi)] };
  }
  if (proposte.size > 1) {
    return { motivo: `testimone: ${proposte.size} lettere diverse nello stesso punto (${[...proposte.keys()].join(' ')})` };
  }
  return { motivo: 'testimone: nessun testimone mette UNA LETTERA in quel punto' };
}

/**
 * Quanto un motivo dice.  Si prova piu' di un'ancora per occorrenza, e l'ultima
 * provata e' quasi sempre la meno interessante — «l'ancora e' corta» copre
 * «nessun testimone mette una lettera», che e' l'informazione vera.  Il rapporto
 * tiene il motivo piu' specifico fra quelli incontrati, non l'ultimo.
 */
function pesoMotivo(motivo) {
  if (/non conosce/.test(motivo)) return 5;
  if (/lettere diverse/.test(motivo)) return 4;
  if (/UNA LETTERA/.test(motivo)) return 3;
  if (/non compare in nessun file pulito/.test(motivo)) return 2;
  if (/ancora/.test(motivo)) return 1;
  return 0;
}

/**
 * Un giro sul testo: cosa si ripara e cosa si lascia.  Non scrive: decide.
 * Le due prove sono richieste ENTRAMBE, e in quest'ordine — il testimone dice
 * quale lettera, il lessico conferma che ne esce una parola.  Se il testimone
 * parla e il lessico lo smentisce non si prova un'altra ancora: si rifiuta.
 * Cercare l'ancora che va d'accordo col lessico sarebbe scegliere la prova in
 * base al risultato.
 */
function valutaResidui(testo, testimoni, cache, lessico, freqMinima) {
  const riparazioni = [];
  const lasciate = [];
  let prefiltrate = 0;
  for (const { j, token } of residuiDi(testo)) {
    const inizi = inizioResiduo(testo, j, token);
    // PREFILTRO: esiste almeno una ricostruzione di una lettera che il corpus
    // conosce?  Se no, non c'e' niente da provare e non si scomoda il testimone.
    let qualcosaDaProvare = false;
    for (const s of inizi) {
      for (const c of ALFABETO) {
        const parola = parolaDalResiduo(token, s, j, c);
        if (parola && (lessico.get(parola) || 0) >= freqMinima) { qualcosaDaProvare = true; break; }
      }
      if (qualcosaDaProvare) break;
    }
    if (!qualcosaDaProvare) { prefiltrate += 1; continue; }

    let motivo = 'nessuna ancora utilizzabile';
    let riparato = false;
    let parlato = false; // un testimone ha proposto una lettera: non si cercano altre ancore
    for (const s of inizi) {
      if (parlato) break;
      for (const [prima, dopo] of [[TESTIMONE_PRIMA, TESTIMONE_DOPO], [RESIDUO_PRIMA_SOLA, 0]]) {
        // Senza ancora a destra NIENTE dice dove finisce il residuo, quindi il
        // residuo puo' essere solo la cifra: un carattere via, un carattere
        // dentro, lunghezza invariata.  Misurato in dry-run: con lo span lungo
        // ammesso qui, `l\'A2` trovava se stesso come testimone, leggeva la «A»
        // come il rimpiazzo dell'intera coda `A2` e cancellava il «2».  L'ancora
        // a destra e' proprio la cosa che, nel modo stretto, lo impedisce.
        if (dopo === 0 && s !== j) continue;
        const esito = risolviResiduoConTestimone(testo, s, j, testimoni, cache, prima, dopo);
        if (!esito.carattere) {
          if (pesoMotivo(esito.motivo) >= pesoMotivo(motivo)) motivo = esito.motivo;
          continue;
        }
        parlato = true;
        const parola = parolaDalResiduo(token, s, j, esito.carattere);
        const freq = parola ? (lessico.get(parola) || 0) : 0;
        if (!parola || freq < freqMinima) {
          motivo = `il testimone propone ${JSON.stringify(esito.carattere)} ma il corpus non conosce ${JSON.stringify(parola || '')}`;
          break;
        }
        riparato = true;
        riparazioni.push({
          offset: s,
          fine: j,
          prima: testo.slice(s, j + 1),
          dopo: esito.carattere,
          token: token.testo,
          parola,
          canale: dopo === 0 ? 'residuo (testimone a sinistra + lessico)' : 'residuo (testimone + lessico)',
          freq,
          testimoni: esito.testimoni.slice(0, 3),
          dettagli: [{ byte: null, coda: testo.slice(s, j + 1), carattere: esito.carattere }],
        });
        break;
      }
    }
    if (!riparato) {
      // Il marker qui non esiste piu': l'unica cosa che dice DOVE stava e' la
      // cifra rimasta, quindi e' lei a essere delimitata. Senza, `"22il"` non
      // dice quale delle due cifre ha preso il posto del carattere perduto.
      lasciate.push({
        offset: j,
        token: token.testo,
        marker: etichettaMarker(null),
        coda: testo[j],
        contesto: contestoDi(testo, j, j + 1),
        motivo,
      });
    }
  }
  return { riparazioni, lasciate, prefiltrate };
}

/**
 * Passa tutto il file, fino a punto fisso.  Le riparazioni si applicano da
 * destra a sinistra perche' cambiano la lunghezza del testo, e si ripassa
 * perche' una riparazione puo' ripulire l'ancora di un'altra.
 */
function riparaResidui(testo, testimoni, cache, lessico, freqMinima) {
  let corrente = testo;
  const riparazioni = [];
  let lasciate = [];
  let prefiltrate = 0;
  for (let giro = 0; giro < RESIDUO_GIRI_MAX; giro += 1) {
    const esito = valutaResidui(corrente, testimoni, cache, lessico, freqMinima);
    lasciate = esito.lasciate;
    prefiltrate = esito.prefiltrate;
    if (esito.riparazioni.length === 0) break;
    for (const r of [...esito.riparazioni].reverse()) {
      corrente = corrente.slice(0, r.offset) + r.dopo + corrente.slice(r.fine + 1);
    }
    riparazioni.push(...esito.riparazioni);
  }
  return { testo: corrente, riparazioni, lasciate, prefiltrate };
}

// ---------------------------------------------------------------------------
// lessico: solo dai file che NON hanno marker
// ---------------------------------------------------------------------------

function costruisciLessico(file, testi) {
  const lessico = new Map();
  let puliti = 0;
  for (const f of file) {
    const testo = testi.get(f.percorso);
    // Stessa esclusione dei testimoni, e per la ragione scritta li': un file
    // con la sola spelling escapata insegna al lessico la parola mutilata.
    if (testo === undefined || MARKER.test(testo) || haEscapate(testo)) continue;
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
  //
  // Solo MINUSCOLA, e l'asimmetria con la coda lunga qui sopra e' voluta: due
  // caratteri esadecimali di fila dentro una parola sono gia' di per se' una
  // forma anomala, mentre UNA lettera A-F maiuscola subito dopo il marker e'
  // quasi sempre una maiuscola vera, cioe' l'iniziale della parola che il
  // marker precede.  Misurato sui 279 marker di a6cb7e10: le sole 4 occorrenze
  // con A-F maiuscola dopo il marker sono `<10>Der`, `<01>Eureka` e
  // `<00>Alain` — tre iniziali di parola, zero code.  Accettare A-F sblocca
  // **0** riparazioni (45 -> 45, misurato) e metterebbe a rischio quelle tre,
  // quindi l'asimmetria e' fail-closed a costo zero.
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
 * gia' provate dal lessico la rispettano e quante la smentiscono.
 *
 * Quanto sia stretta la soglia si misura: su a6cb7e10 NESSUNO dei 29 file
 * sporchi la raggiunge — il massimo e' 2 pro / 0 contro in
 * `svincolo-a2-sigirino-ritardo.ts` e 1 pro / 0 contro in
 * `bellinzona-2025-consuntivo-risultati.ts` — quindi oggi la legge non si
 * applica da nessuna parte e nessuna delle riparazioni passa da qui.  Il ramo
 * resta per i giri futuri, dove il residuo puo' presentarsi con altre forme.
 * Ed e' proprio in `bellinzona` che si vede cosa costerebbe assumerla senza
 * verifica: i suoi 18 marker residui stanno in tre token `<0F>9<0F>9<0F>9`, e
 * 0x0F+'9' = 0xF9 = ù, cioe' «ùùù».
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
  //     Vale la STESSA guardia del punto 2, e qui serve anche di piu'.
  //     `leggeNibble` e' una prova sul FILE — tre sostituzioni gia' confermate
  //     dal lessico la rispettano e nessuna la smentisce — ma non dice niente
  //     sul TOKEN isolato: in un file dove la legge regge, `0x0F+'4'` da solo
  //     si leggerebbe ô e finirebbe scritto senza che una sola parola del
  //     corpus lo confermi.  E' esattamente l'argomento del punto 2 per
  //     `<00>e2`: la lettura da sola non basta, il carattere ricostruito
  //     dev'essere una PAROLA che il corpus usa da sola.  «à» lo e', «ô» no.
  if (nibbleTesto && confermate.size === 0) {
    const contesto = token.length - nibbleScelte.reduce((s, x) => s + x.unita.lunghezza, 0);
    const freq = lessico.get(nibbleTesto) || 0;
    if (contesto === 0 && freq >= freqMinima) return dettaglia(nibbleScelte, 'nibble', freq);
  }
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
  // Il `false` finale non e' un dettaglio: `mappaAppresa` si riempie SOLO qui,
  // dove la legge del nibble e' spenta, quindi nessuna riparazione del canale
  // `nibble` puo' entrarci e propagarsi ai token fitti di marker della seconda
  // passata.  La mappa impara solo da cio' che lessico ed hex hanno confermato.
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
        rifiuti.push({
          offset: t.inizio,
          token: t.testo,
          marker: etichettaMarker((t.testo.match(MARKER_G) || [])[k]?.charCodeAt(0)),
          contesto: contestoDi(testo, t.inizio, t.inizio + t.testo.length),
          motivo: r ? r.motivo : 'non analizzato',
          candidati: r ? r.candidati : [],
        });
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

// ---------------------------------------------------------------------------
// L'ESTRAZIONE DEL MARKER — perche' l'occorrenza da sola non basta (issue #94)
// ---------------------------------------------------------------------------
//
// Le tre grafie del difetto NON arrivavano al rapporto con la stessa quantita'
// di contesto, e la differenza non e' cosmetica: decide quante occorrenze si
// possono classificare leggendo il rapporto invece di riaprire i file a mano.
//
//   byte grezzo        `"d<0E>9penses"`  — la parola intera, il marker al suo
//                      posto: si legge, si classifica, si ripara.
//   spelling escapata  `"\\u0010"`        — il marker E BASTA. Quale parola?
//                      quale frase?  Il rapporto non lo diceva.
//   residuo            `"22il"`          — il marker non c'e' piu' e NIENTE
//                      dice quale delle due cifre ne ha preso il posto.
//
// Misurato su `origin/main` il 2026-08-18: delle occorrenze stampate dal
// rapporto, **91 (45 escapate + 46 residui) uscivano senza un solo carattere
// di contesto attorno**, e chi conduce la campagna di riparazione ha dovuto
// riestrarle dai file una per una. Le altre 103 no, perche' il loro token
// porta gia' il marker in forma `<XX>`.
//
// `contestoDi` da' a tutte e tre la stessa finestra ANCORATA: il tratto esatto
// dell'occorrenza fra `[[` e `]]`, i byte C0 resi `<XX>` come ovunque nel
// rapporto, e `CONTESTO_INTORNO` caratteri per lato. E' la stessa ancora che
// usa il canale testimone (16 prima / 24 dopo), presa larga: chi legge il
// rapporto deve poter riconoscere la frase, non solo il token.
//
// Il tratto delimitato NON e' una proposta di riparazione: dice dove guardare,
// non cosa scrivere. L'unica cosa autorizzata a scrivere resta il testimone.
const CONTESTO_INTORNO = 32;

/**
 * `visibile`, piu' i tre caratteri di controllo che `MARKER` NON considera
 * marker perche' sono legali: a capo, ritorno e TAB.  Se restano grezzi, un
 * contesto che ne contiene uno si spezza su piu' righe del rapporto e smette di
 * essere una riga per occorrenza — misurato: 27 delle 314 occorrenze del corpus
 * hanno un a capo dentro la finestra.  Il TAB in piu' e' la terza grafia del
 * marker (7 occorrenze in 7 file, decisione del proprietario del 2026-08-15:
 * si correggono a mano): renderlo visibile e' il minimo perche' si veda che c'e'.
 */
function leggibile(s) {
  return visibile(s).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function contestoDi(testo, inizio, fine) {
  const a = Math.max(0, inizio - CONTESTO_INTORNO);
  const b = Math.min(testo.length, fine + CONTESTO_INTORNO);
  const puntiPrima = a > 0 ? '...' : '';
  const puntiDopo = b < testo.length ? '...' : '';
  return `${puntiPrima}${leggibile(testo.slice(a, inizio))}[[${leggibile(testo.slice(inizio, fine))}]]${leggibile(testo.slice(fine, b))}${puntiDopo}`;
}

/**
 * `0x0E` per il byte C0 che si sta guardando, `strippato` per il residuo, dove
 * il byte non esiste piu'. Il campo c'e' sempre: un rapporto in cui il marker
 * manca perche' la famiglia non lo espone e' esattamente cio' che ha costretto
 * a riestrarre 91 occorrenze dai file.
 */
function etichettaMarker(code) {
  return code === null || code === undefined
    ? 'strippato'
    : `0x${code.toString(16).padStart(2, '0').toUpperCase()}`;
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
  const testimoni = costruisciTestimoni(file, testi);
  const cacheTestimoni = new Map();

  const perFile = [];
  const perCoppia = new Map();
  const motivi = new Map();
  let riparate = 0;
  let rifiutate = 0;
  let occorrenze = 0;
  const rifiutiElenco = [];
  const riparazioniElenco = [];
  // Il canale del residuo ha una contabilita' SUA, e separata di proposito: cio'
  // che lascia non e' un'occorrenza rifiutata ma, quasi sempre, testo giusto —
  // `l'A9`, `pilastro 3a`, uno slug.  Sommarlo ai rifiuti dei marker
  // renderebbe l'uscita 2 permanente e toglierebbe significato al numero che
  // conta davvero, che e' quanti byte C0 restano nel corpus.
  const residuiLasciati = [];
  const residuiPerFile = [];
  let residuiRiparati = 0;
  let residuiPrefiltrati = 0;
  // La spelling escapata, contata a parte dai byte grezzi ma con lo stesso
  // peso: `escapateLasciate` entra nel codice d'uscita.  E' la differenza col
  // canale del residuo, e non e' arbitraria — un residuo lasciato e' quasi
  // sempre testo giusto (`l'A9`, uno slug), mentre ognuna di queste 45 e' un
  // control character che arriva davvero dentro il `FAQPage` ld+json.
  const escapateElenco = [];
  const escapatePerFile = [];
  let escapateOccorrenze = 0;
  let escapateRiparate = 0;

  for (const f of file) {
    const testo = testi.get(f.percorso);
    if (testo === undefined) continue;
    let corrente = testo;
    let nRip = 0;
    // I canali ancorati al marker girano solo dove un marker c'e' ancora.
    if (MARKER.test(testo)) {
      const n = (testo.match(MARKER_G) || []).length;
      occorrenze += n;
      // Prima il canale testimone, che lavora sul TESTO e non sui token, poi le
      // prove per token su cio' che resta: un marker gia' risolto dal testimone
      // non arriva mai al lessico, e un token che il testimone non tocca resta
      // esattamente com'era.
      const w = riparaConTestimoni(testo, testimoni, cacheTestimoni);
      const r = riparaTesto(w.testo, lessico, opz.freqMinima);
      corrente = r.testo;
      for (const rip of [...w.riparazioni, ...r.riparazioni]) {
        nRip += rip.dettagli.length;
        riparazioniElenco.push({
          file: f.percorso, offset: rip.offset, prima: visibile(rip.prima), dopo: rip.dopo,
          canale: rip.canale, freqNelCorpus: rip.freq,
          ...(rip.testimoni ? { testimoni: rip.testimoni } : {}),
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
    }
    // La spelling ESCAPATA, prima del residuo: una riparazione qui puo'
    // ripulire l'ancora di un residuo, e il residuo non ha ancora da restituire.
    const nEscapate = findEscapedControlChars(corrente).length;
    if (nEscapate > 0) {
      escapateOccorrenze += nEscapate;
      const esc = riparaEscapate(f.percorso, corrente, testimoni, cacheTestimoni);
      corrente = esc.testo;
      escapateRiparate += esc.riparazioni.length;
      for (const rip of esc.riparazioni) {
        riparazioniElenco.push({
          file: f.percorso, offset: rip.offset, prima: rip.prima, dopo: rip.dopo,
          canale: rip.canale, freqNelCorpus: rip.freq,
          testimoni: rip.testimoni, localiTestimoni: rip.locali,
        });
      }
      for (const l of esc.lasciate) escapateElenco.push({ file: f.percorso, ...l });
      escapatePerFile.push({
        file: f.percorso, occorrenze: nEscapate, riparate: esc.riparazioni.length, lasciate: esc.lasciate.length,
      });
    }
    // Il canale del residuo gira SU TUTTI I FILE, e non e' un dettaglio: il file
    // che porta il difetto di questo giro — `content/blog-meta-it.ts` — non ha
    // un solo byte C0, ed e' esattamente per questo che nessuno lo trovava.
    const res = riparaResidui(corrente, testimoni, cacheTestimoni, lessico, opz.freqMinima);
    corrente = res.testo;
    residuiPrefiltrati += res.prefiltrate;
    residuiRiparati += res.riparazioni.length;
    for (const rip of res.riparazioni) {
      riparazioniElenco.push({
        file: f.percorso, offset: rip.offset, prima: rip.prima, dopo: rip.dopo,
        token: rip.token, parola: rip.parola, canale: rip.canale, freqNelCorpus: rip.freq,
        testimoni: rip.testimoni,
      });
    }
    for (const l of res.lasciate) residuiLasciati.push({ file: f.percorso, ...l });
    if (res.riparazioni.length || res.lasciate.length) {
      residuiPerFile.push({ file: f.percorso, riparati: res.riparazioni.length, lasciati: res.lasciate.length });
    }
    if (opz.scrivi && corrente !== testo) {
      const dest = path.join(opz.radice, f.percorso);
      fs.writeFileSync(dest, Buffer.from(corrente, 'utf8'));
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
    // La spelling escapata (#345 item 1), contata a parte dai byte grezzi ma
    // con lo stesso peso sul codice d'uscita.
    escapate: {
      occorrenze: escapateOccorrenze,
      riparate: escapateRiparate,
      lasciate: escapateElenco.length,
      perFile: escapatePerFile,
      elenco: escapateElenco,
    },
    // Il canale del residuo, contato a parte: `lasciate` NON entra in
    // `rifiutate` e non tocca il codice d'uscita — vedi il commento sopra.
    residui: {
      riparati: residuiRiparati,
      lasciati: residuiLasciati.length,
      prefiltrati: residuiPrefiltrati,
      perFile: residuiPerFile,
      lasciate: residuiLasciati,
    },
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
    r.push('   spelling escapata (\\u00XX, \\b, \\f — nessun byte C0 sul disco):');
    r.push(`     occorrenze: ${escapateOccorrenze}   in ${escapatePerFile.length} file`);
    r.push(`     riparate:   ${escapateRiparate}   (solo testimone unanime cross-locale)`);
    r.push(`     lasciate:   ${escapateElenco.length}   (contano nel codice d'uscita: sono difetti, non testo giusto)`);
    for (const x of escapateElenco.slice(0, opz.maxRifiutiMostrati)) {
      r.push(`     ${x.file}:${x.offset}  ${JSON.stringify(x.spelling)}  ${x.marker}  ${x.motivo}`);
      r.push(`            ${x.contesto}`);
    }
    r.push('');
    r.push('   residuo (cifra orfana, marker gia\' strippato):');
    r.push(`     riparati:  ${residuiRiparati}`);
    r.push(`     lasciati:  ${residuiLasciati.length}   (non sono rifiuti: quasi tutti sono testo giusto)`);
    r.push(`     scartati dal prefiltro del lessico: ${residuiPrefiltrati}`);
    for (const x of residuiLasciati.slice(0, opz.maxRifiutiMostrati)) {
      r.push(`     ${x.file}:${x.offset}  ${JSON.stringify(x.token)}  ${x.marker}  ${x.motivo}`);
      r.push(`            ${x.contesto}`);
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

  // `process.exitCode` e NON `process.exit()`.  Su una pipe la scrittura di
  // stdout e' asincrona, e `process.exit()` la tronca a meta': misurato su
  // `content/` il 2026-08-18, `--json | ...` consegnava **65.536 byte** (un
  // buffer di pipe esatto) dei 124.385 del rapporto, cioe' un JSON che non si
  // apre — mentre `--json > file` era completo e `--json | head` sembrava
  // giusto.  Uno strumento che dichiara 314 occorrenze e ne consegna meta' a
  // chi lo mette in pipeline e' la stessa forma di guasto dell'estrazione
  // mancante: la misura c'e', chi deve usarla non la riceve.
  // Il codice d'uscita resta identico — 2 se resta qualcosa, 0 se no.
  process.exitCode = rifiutate > 0 || escapateElenco.length > 0 ? 2 : 0;
}

// Guardia CLI: importare questo file da un test non deve eseguirlo.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export {
  riparaTesto, risolviToken, costruisciLessico, ritaglia,
  riparaResidui, residuiDi, costruisciTestimoni,
  riparaEscapate, decodificaEscapate, localeDi, haEscapate,
  MARKER, MARKER_G, TOKEN_G, ALFABETO,
};
