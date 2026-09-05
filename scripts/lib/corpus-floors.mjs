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

/** Il pavimento per un valore atteso. Mai negativo, e 0 atteso ⇒ 0. */
export function floorFrom(expected, retention = FLOOR_RETENTION) {
  if (!Number.isFinite(expected) || expected <= 0) return 0;
  return Math.floor(expected * retention);
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
 * Un corpus sorgente vuoto restituisce 0 e non un pavimento negativo: la
 * sezione svizzera puo' legittimamente non esistere in un checkout parziale, e
 * quel caso e' gia' coperto dai controlli di presenza del gate.
 */
export function sectionFloor(root, section, retention = FLOOR_RETENTION) {
  return floorFrom(countSourceArticles(root, section), retention);
}
