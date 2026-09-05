/**
 * corpus-floors.mjs — i pavimenti anti-troncamento, DERIVATI dal corpus.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `manifest.json` esiste per «rifiutare un set troncato *prima* di usarlo»
 * (AGENTS.md), e il gate `Verify artifact` di `publish-api.yml` e' il lato che
 * quel rifiuto lo esegue prima della pubblicazione. Ma il suo pavimento era una
 * costante scritta a mano: `counts.articles -lt 100`.
 *
 * Misurato il 2026-09-05 sul corpus reale: `counts.articles` = **3782**. Il
 * pavimento era al **2,6%** del valore atteso, cioe' una perdita del 97% del
 * corpus passava il gate e andava live — e il sito non ribuilda, quindi ci va
 * subito. `counts.swissArticles` (1850) non aveva pavimento affatto.
 *
 * La root cause non e' il numero 100: e' che il numero e' ASSOLUTO. Un
 * pavimento assoluto viene tarato una volta contro il corpus di quel giorno e
 * poi non si muove piu', mentre il corpus cresce di due ordini di grandezza. Il
 * gate non «si rompe»: si svuota, restando verde. Alzarlo a 3500 comprerebbe
 * qualche mese e ricreerebbe lo stesso difetto.
 *
 * Qui il pavimento e' RELATIVO a una verita' di terra che sta su disco accanto
 * all'artefatto — i file sorgente del corpus — quindi scala da solo per sempre
 * e non ha una taratura da rivedere.
 *
 * Solo builtin Node, per la regola di `scripts/ci/**`: eseguibile senza
 * `npm ci`.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Quanta parte del corpus sorgente deve sopravvivere fino all'artefatto.
 *
 * MISURATO 2026-09-05, non scelto: `content/blog-body/it` tiene 3785 file e
 * `counts.articles` ne dichiara 3782 (99,92%); lato svizzera i due numeri
 * coincidono (1850/1850). Lo scarto reale e' dello 0,08%, quindi il 10% di
 * tolleranza e' ~125x il divario osservato — largo abbastanza da non fallire su
 * un orfano o una voce ritirata, stretto abbastanza da fermare qualunque
 * troncamento che meriti quel nome (un parse a meta', uno shard set letto
 * parzialmente, un filtro applicato per sbaglio all'intero registro).
 *
 * A differenza di un pavimento assoluto, questa non e' una taratura che scade:
 * e' una frazione, e il valore atteso viene ricontato a ogni run.
 */
export const FLOOR_RETENTION = 0.9;

/**
 * Il pavimento per un valore atteso. Mai negativo, e 0 atteso ⇒ 0.
 *
 * ATTENZIONE, ed e' il punto piu' delicato di questo modulo: `floorFrom(0)` e'
 * 0, e un pavimento a 0 non e' un pavimento — `x < 0` e' falso per qualunque
 * `x`, quindi il gate SPARISCE invece di scattare. Un pavimento derivato ha
 * questo modo di fallire che quello assoluto non aveva: la costante `100` era
 * sbagliata ma incondizionata, il derivato e' giusto solo finche' il suo
 * riferimento esiste. Ogni chiamante deve percio' distinguere «il corpus dice
 * zero» da «il corpus non c'e'», e trattare il secondo come un ERRORE — vedi
 * `missingCorpusMessage`, `sectionFloor` e `floorViolations`.
 */
export function floorFrom(expected, retention = FLOOR_RETENTION) {
  if (!Number.isFinite(expected) || expected <= 0) return 0;
  return Math.floor(expected * retention);
}

/**
 * Il messaggio unico per «il riferimento del pavimento non c'e'».
 *
 * Vive qui e non nei due chiamanti perche' la REGOLA e' una sola: un corpus
 * sorgente assente o vuoto non e' un pavimento a zero, e' l'assenza del
 * riferimento contro cui il pavimento si misura. Un checkout parziale, un
 * symlink del corpus non risolto (la stessa condizione gia' vista in
 * `fast-publish-article.yml`, «the corpus symlinks were missing») azzera
 * insieme sorgente e artefatto, e senza questa regola il gate resterebbe verde
 * pubblicando il vuoto sopra il buono.
 */
export function missingCorpusMessage(what, rel) {
  return (
    `riferimento del pavimento assente: ${rel} e' assente o vuota, ` +
    `quindi il pavimento di ${what} sarebbe 0 — cioe' nessun gate. ` +
    "Un corpus sorgente vuoto non e' un pavimento a zero: e' l'assenza del riferimento."
  );
}

/**
 * Dove vive il corpo di un articolo, per sezione. E' un file per articolo, ed e'
 * l'artefatto sorgente piu' vicino alla cardinalita' che il manifest dichiara:
 * il registro TS che `build-api.mjs` legge e' UN file solo, quindi contarne le
 * voci significherebbe fidarsi dello stesso parse che il gate deve sorvegliare.
 */
export const SECTION_BODY_DIRS = {
  frontaliere: path.join('content', 'blog-body', 'it'),
  svizzera: path.join('content', 'blog-body-ch', 'it'),
};

/** Quante immagini hero questo repo tiene davvero (sorgente di `images-manifest.json`). */
export const IMAGE_SOURCE_DIR = path.join('public', 'images', 'blog');

function countFiles(dir, ext) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).length;
}

/** Quanti articoli sorgente ha la sezione, contati sui file di corpo. */
export function countSourceArticles(root, section) {
  const rel = SECTION_BODY_DIRS[section];
  if (!rel) throw new Error(`unknown corpus section: ${section}`);
  return countFiles(path.join(root, rel), '.ts');
}

/** Quante immagini hero ci sono in sorgente. */
export function countSourceImages(root) {
  return countFiles(path.join(root, IMAGE_SOURCE_DIR), '.webp');
}

/**
 * Il pavimento di una sezione, derivato dal corpus su disco.
 *
 * LANCIA se il corpus sorgente della sezione e' assente o vuoto, invece di
 * restituire 0: con `sectionFloor` a 0 il confronto `entries.length < 0` e'
 * sempre falso e chi lo usa pubblica un indice VUOTO sopra quello live, che e'
 * peggio della costante che questo modulo sostituisce (`MIN_ENTRIES = 50`
 * quel caso lo rifiutava incondizionatamente). Le due sorgenti — registro e
 * corpi — stanno entrambe sotto `content/`, quindi si azzerano INSIEME: e'
 * esattamente il caso in cui il pavimento serve.
 */
export function sectionFloor(root, section, retention = FLOOR_RETENTION) {
  const source = countSourceArticles(root, section);
  if (source === 0) {
    throw new Error(missingCorpusMessage(section, path.join(root, SECTION_BODY_DIRS[section])));
  }
  return floorFrom(source, retention);
}

// ── I locali del corpus, e il pavimento a specchio che se ne deriva ─────────

/**
 * I quattro locali che ogni radice di corpi tiene, in mirror.
 *
 * Non e' una taratura come `minFiles: 3000`: e' la cardinalita' dei locali, che
 * non cresce col corpus. La differenza e' il punto — una costante che invecchia
 * col corpus si svuota da sola, una che descrive la FORMA del corpus no.
 *
 * Sorgente unica di fatto: `RSS_LOCALES` in `engine/rssFeeds.mjs`. Non e'
 * importabile qui (questo modulo e' sincrono e senza dipendenze, ed e' letto da
 * `scripts/ci/**`), quindi il legame e' coperto da un test —
 * `generator/tests/blog-body-floor-derived.test.mjs`, stesso schema di
 * `ci-check-name.test.mjs` (AGENTS.md #6).
 */
export const CORPUS_LOCALES = ['it', 'en', 'de', 'fr'];

/** Conta ricorsivamente i file con estensione `ext` sotto `dir`. Assente -> 0. */
function countFilesDeep(dir, ext) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  let n = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) n += countFilesDeep(full, ext);
    else if (entry.isFile() && full.endsWith(ext)) n += 1;
  }
  return n;
}

/** Quanti corpi tiene ciascun locale di una radice. `{ it: n, en: n, … }`. */
export function countBodiesByLocale(root, rel, locales = CORPUS_LOCALES) {
  const out = {};
  for (const locale of locales) out[locale] = countFilesDeep(path.join(root, rel, locale), '.ts');
  return out;
}

/**
 * Quanti file una radice di corpi DEVE tenere, derivato dalla radice stessa.
 *
 * PERCHE' NON UNA COSTANTE. `minFiles: 3000` (e `MIN_FILES_TOTAL = 3000`) erano
 * l'antipattern che #910 dichiarava di aver spazzato: tarati una volta contro il
 * corpus di quel giorno, mentre `content/blog-body` oggi ne tiene 15k. Il gate
 * non si rompe, si svuota restando verde — e alzarli comprerebbe qualche mese e
 * ricreerebbe lo stesso difetto.
 *
 * IL RIFERIMENTO. Un corpus di corpi e' MIRRORATO sui locali: lo stesso insieme
 * di articoli esiste quattro volte. Il locale piu' popolato e' quindi la verita'
 * di terra per gli altri tre, e l'atteso della radice e' `max × |locali|`. E'
 * derivato (scala col corpus per sempre, nessuna taratura da rivedere) e in piu'
 * e' STRETTAMENTE piu' forte della soglia assoluta: un locale mezzo
 * materializzato — cartella rinominata, checkout sparse su una sola lingua —
 * lasciava `3000` ampiamente soddisfatto ed e' esattamente la forma del buco del
 * 2026-07-29, `blog-body-ch` mai guardata.
 *
 * `0` significa radice assente o vuota, che NON e' un pavimento a zero: il
 * chiamante deve trattarlo come assenza del riferimento (vedi
 * `missingCorpusMessage`).
 */
export function mirrorExpectation(byLocale, locales = CORPUS_LOCALES) {
  const counts = locales.map((l) => byLocale[l] ?? 0);
  const max = counts.reduce((a, b) => (b > a ? b : a), 0);
  return max * locales.length;
}

// ── La popolazione che genera i feed ───────────────────────────────────────

/** Dove vivono i chunk SEO in QUESTO repo (il sito li tiene sotto `services/seo`). */
export const SEO_DIR = path.join('content', 'seo');

/**
 * Il pattern di inizio-voce dei chunk SEO.
 *
 * COPIA DICHIARATA di `entryRe` in `parseSeoBlogs` (`engine/rssFeeds.mjs`), che
 * non e' esportata — e `engine/` e' mirrorato dal sito, quindi non si modifica
 * da qui (AGENTS.md #3). Il legame e' coperto da
 * `generator/tests/feed-floor-population.test.mjs`, che rilegge il sorgente
 * dell'engine e confronta le due regex: se l'engine cambia parser, il test
 * cade invece di lasciare il pavimento tarato su una popolazione fantasma.
 */
export const SEO_ENTRY_RE = /'blog-([^']+)':\s*\{/g;

/** Quante voci tengono, in totale, i chunk SEO passati. */
export function countSeoEntries(root, seoFiles, seoDir = SEO_DIR) {
  let n = 0;
  for (const file of seoFiles) {
    let src;
    try {
      src = fs.readFileSync(path.join(root, seoDir, file), 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') continue; // stesso ramo di parseSeoBlogs: chunk assente = zero voci
      throw err;
    }
    n += (src.match(SEO_ENTRY_RE) || []).length;
  }
  return n;
}

/** I chunk `seo-blog*.ts` che stanno DAVVERO su disco. */
export function listSeoChunks(root, seoDir = SEO_DIR) {
  try {
    return fs
      .readdirSync(path.join(root, seoDir))
      .filter((f) => /^seo-blog.*\.ts$/.test(f))
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// ── Il margine, e la sorveglianza del rapporto ─────────────────────────────

/**
 * Quanto sopra il pavimento il rapporto osservato e' gia' degno di un allarme.
 *
 * `FLOOR_RETENTION = 0.9` e' misurato su un rapporto che NON e' stazionario: i
 * due lati contano cose diverse (i file di corpo `it` da una parte, le voci del
 * registro dall'altra), e oggi restano allineati solo perche'
 * `scripts/retire-article.mjs` cancella corpo e voce insieme. Qualunque flusso
 * che lasci un corpo senza voce — orfani, ritiri a meta', import parziali —
 * sposta il rapporto verso il basso in modo MONOTONO, e al -10% il gate comincia
 * a rifiutare una pubblicazione sana.
 *
 * Una deriva monotona ha una proprieta' utile: attraversa la banda prima del
 * muro. Questa e' la banda. Non allarga il pavimento — non muove nessuna
 * decisione di pass/fail — rende solo visibile l'avvicinamento, che oggi non
 * misura nessuno.
 */
export const WARN_MARGIN = 0.05;

/**
 * Il rapporto osservato fra cio' che l'artefatto dichiara e cio' che il corpus
 * tiene. `null` quando l'atteso non e' un riferimento valido: un rapporto su
 * zero non e' «infinito», e' assenza di misura.
 */
export function retentionOf(declared, expected) {
  if (!Number.isFinite(expected) || expected <= 0) return null;
  if (!Number.isFinite(declared)) return null;
  return declared / expected;
}

/**
 * Il rapporto e' ancora sopra il pavimento ma dentro la banda di margine?
 * `false` anche quando non c'e' misura: un avviso su un riferimento assente
 * duplicherebbe la violazione che il chiamante emette gia'.
 */
export function withinWarnBand(declared, expected, retention = FLOOR_RETENTION, margin = WARN_MARGIN) {
  const ratio = retentionOf(declared, expected);
  if (ratio === null) return false;
  return ratio >= retention && ratio < retention + margin;
}
