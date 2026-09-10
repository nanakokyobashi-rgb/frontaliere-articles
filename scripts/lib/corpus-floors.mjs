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
import { SEO_ENTRY_WINDOW } from '../../engine/rssFeeds.mjs';

export { SEO_ENTRY_WINDOW };

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
 * La soglia di PREALLARME: advisory, non un gate.
 *
 * PERCHE' ESISTE. `FLOOR_RETENTION` e' tarato sullo scarto osservato UNA volta
 * (99,92% frontaliere, 100% svizzera), ma i due lati del rapporto contano cose
 * diverse — i file di corpo da una parte, le voci dichiarate dall'artefatto
 * dall'altra. Oggi `scripts/retire-article.mjs` li tiene allineati cancellando
 * insieme corpo e voce, ma qualunque flusso che lasci un corpo senza voce
 * (orfani, ritiri a meta', import parziali) sposta il rapporto verso il basso
 * in modo MONOTONO. Nessuno misurava quel rapporto nel tempo: la prima notizia
 * del drift sarebbe stata la pubblicazione BLOCCATA, cioe' il gate che scatta
 * senza preavviso su un corpus sano.
 *
 * 0,97 da' ~7 punti percentuali di anticipo sul 0,90 — l'erosione si vede
 * mentre e' ancora innocua, e chi la vede ha il tempo di capirla invece di
 * scoprirla da una publish rossa.
 *
 * NON e' un gate e non ne sposta uno: `FLOOR_RETENTION` resta 0,9 e resta
 * bloccante (AGENTS.md #1). Questo livello sta SOPRA, e chi lo sfonda esce
 * comunque 0. L'invariante che lo rende raggiungibile — deve stare stretto fra
 * il gate e 1 — e' asserito in
 * `generator/tests/api-floors-derived-from-corpus.test.mjs`: invertirle
 * renderebbe il preallarme irraggiungibile in silenzio, cioe' ricreerebbe
 * esattamente la cecita' che chiude.
 */
export const FLOOR_WARN_RETENTION = 0.97;

/**
 * Il rapporto misurato/atteso, o `null` se non c'e' un riferimento.
 *
 * `null` e non 0 per la stessa ragione per cui `floorFrom(0)` merita un errore
 * nei chiamanti: «il riferimento non c'e'» non e' «il rapporto e' zero», ed e'
 * una condizione che va segnalata come assenza, non come erosione.
 */
export function retentionRatio(declared, source) {
  if (!Number.isFinite(declared) || !Number.isFinite(source) || source <= 0) return null;
  return declared / source;
}

/**
 * La riga di telemetria di un rapporto: cosa vale e quanto margine resta prima
 * del gate, in punti percentuali. Stampata a OGNI run, anche verde — e' il
 * punto: un rapporto che nessuno stampa e' un rapporto che nessuno vede
 * scendere.
 */
export function retentionLine(label, declared, source, retention = FLOOR_RETENTION) {
  const ratio = retentionRatio(declared, source);
  if (ratio === null) return `${label}: nessun riferimento (sorgente ${source})`;
  const margin = (ratio - retention) * 100;
  return (
    `${label}: ${declared}/${source} = ${(ratio * 100).toFixed(2)}% ` +
    `(margine ${margin.toFixed(1)} pp dal gate ${(retention * 100).toFixed(0)}%)`
  );
}

/**
 * Il preallarme di un rapporto, o `null` se non serve.
 *
 * Solo sopra il pavimento intero del gate e sotto il preallarme: sotto quel
 * pavimento non e' un preallarme ma una VIOLAZIONE, che il chiamante emette
 * gia' come errore — raddoppiarla in warning confonderebbe il verdetto invece
 * di anticiparlo. Sul bordo il rapporto grezzo puo' essere appena sotto
 * `retention` per effetto dell'arrotondamento, ma il confronto intero passa.
 */
export function retentionWarning(
  label,
  declared,
  source,
  retention = FLOOR_RETENTION,
  warn = FLOOR_WARN_RETENTION,
) {
  const ratio = retentionRatio(declared, source);
  if (ratio === null || ratio >= warn || declared < floorFrom(source, retention)) return null;
  const margin = Math.max(0, (ratio - retention) * 100);
  return (
    `${label}: rapporto ${(ratio * 100).toFixed(2)}% sotto il preallarme ` +
    `${(warn * 100).toFixed(0)}% — restano ${margin.toFixed(1)} pp ` +
    `prima del gate ${(retention * 100).toFixed(0)}%, che bloccherebbe la pubblicazione`
  );
}

/**
 * Il preallarme sulla popolazione che genera un feed, senza spostare il gate.
 *
 * Un feed emette al massimo `RSS_MAX_ITEMS`, quindi il suo rapporto rispetto
 * a quel cap non vede se i chunk SEO sono passati da migliaia a poche decine.
 * Questa riga confronta invece i chunk con il corpus della sezione: e' solo
 * diagnostica e deve restare visibile anche quando il rapporto e' gia' sotto
 * il gate degli articoli.
 */
export function populationWarning(label, declared, source, warn = FLOOR_WARN_RETENTION) {
  const ratio = retentionRatio(declared, source);
  if (ratio === null || ratio >= warn) return null;
  return (
    `${label}: popolazione ${declared}/${source} = ${(ratio * 100).toFixed(2)}% ` +
    `sotto il preallarme ${(warn * 100).toFixed(0)}% — i chunk SEO stanno erodendo il corpus ` +
    `della sezione`
  );
}

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
  const stat = fs.statSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return 0;
  const files = fs.readdirSync(dir);
  return files.filter((f) => f.endsWith(ext)).length;
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

/**
 * Dove vivono i chunk SEO in QUESTO repo. Il layout del sito e'
 * `services/seo`; `build-api.mjs` passa `seoDir: 'content/seo'` a
 * `buildAllRssFeeds`, ed e' quello il parametro che vale qui.
 */
export const SEO_CHUNK_DIR = path.join('content', 'seo');

/**
 * Le voci di un chunk SEO che diventano davvero `<item>`, aggiunte a `into`.
 *
 * PERCHE' UN CONTEGGIO A PARTE dai file di corpo. Gli `<item>` di un feed non
 * nascono dai corpi: `buildSectionFeeds` li costruisce da `parseSeoBlogs` sui
 * chunk elencati in `RSS_SECTIONS[].seoFiles`. Sono due popolazioni scollegate,
 * e la divergenza e' misurabile oggi (frontaliere: 4728 voci nei chunk contro
 * 3792 corpi). Un pavimento tarato sui corpi non e' «un po' impreciso»: nella
 * direzione peggiore non segnala un feed vecchio e BLOCCA la pubblicazione per
 * un feed legittimamente corto — e la lista dei chunk si e' gia' rivelata
 * capace di muoversi da sola (due su sette letti, feed fermo tre mesi).
 *
 * I criteri ricalcano quelli di `parseSeoBlogs`, che e' il produttore: stesso
 * regex di inizio voce, stessi campi obbligatori e la stessa finestra di
 * riferimento `SEO_ENTRY_WINDOW`. Cosi' il pavimento non puo' contare una voce
 * oltre il limite che il feed non legge. L'insieme e' un Set di articleId perche' la',
 * un livello sopra, le voci finiscono in una Map chiavata per articleId: due
 * chunk che citano lo stesso id producono UN item, non due.
 *
 * Restano un parse in piu' — l'engine non esporta il suo — ma la LISTA dei
 * chunk no: quella si importa da `RSS_SECTIONS` (AGENTS.md #6), ed e' la parte
 * che e' gia' andata alla deriva una volta.
 */
export function collectSeoEntryMetadata(src, into = new Map()) {
  const entryRe = /'blog-([^']+)':\s*\{/g;
  const positions = [];
  let match;
  while ((match = entryRe.exec(src)) !== null) positions.push({ id: match[1], start: match.index });

  for (let i = 0; i < positions.length; i += 1) {
    const { id, start } = positions[i];
    const end = i + 1 < positions.length
      ? positions[i + 1].start
      : start + SEO_ENTRY_WINDOW;
    // Match parseSeoBlogs: a successor is the exact boundary, while the
    // bounded fallback applies only to the final entry in the chunk.
    const block = src.slice(start, end);
    into.set(id, {
      keywords: block.match(/keywords:\s*'((?:[^'\\]|\\.)*)'/)?.[1],
      headline: block.match(/"headline":\s*"((?:[^"\\]|\\.)*)"/)?.[1],
      datePublished: block.match(/"datePublished":\s*"([^"]+)"/)?.[1],
    });
  }
  return into;
}

export function collectSeoEntryIds(src, into = new Set()) {
  for (const [id, metadata] of collectSeoEntryMetadata(src)) {
    // Non-vuoti, come li vuole il produttore: `"headline": ""` e' falsy la', e
    // contarlo qui alzerebbe il pavimento sopra cio' che il feed puo' emettere.
    if (!metadata.headline || !metadata.datePublished) continue;
    into.add(id);
  }
  return into;
}

/**
 * Quante voci datate tengono i chunk SEO di una sezione: la popolazione che
 * GENERA i suoi feed, e quindi il riferimento del loro pavimento.
 *
 * Un chunk assente viene saltato come lo salta `parseSeoBlogs` (`if
 * (!fs.existsSync(filePath)) continue`) — la lista e' condivisa col sito, che
 * puo' tenere chunk non mirrorati qui. Se pero' il totale della sezione e'
 * zero, quello NON e' un pavimento a zero: e' l'assenza del riferimento, e il
 * chiamante deve trattarlo come errore (vedi `missingCorpusMessage`).
 */
export function countSeoEntries(root, seoFiles, seoDir = SEO_CHUNK_DIR) {
  const ids = new Set();
  for (const file of seoFiles) {
    const filePath = path.join(root, seoDir, file);
    if (!fs.existsSync(filePath)) continue;
    collectSeoEntryIds(fs.readFileSync(filePath, 'utf-8'), ids);
  }
  return ids.size;
}
