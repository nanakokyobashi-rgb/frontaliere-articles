/**
 * registry-api-entry.mjs — la voce di registry che `dist/api/articles.json` e
 * `swiss-articles.json` pubblicano, proiettata su un'ALLOWLIST esplicita.
 *
 * PERCHE' ESISTE
 * ──────────────
 * Il confine sito-corpus e' HTTP: il sito consuma questi due file, quindi la
 * forma della voce e' un contratto. `build-api.mjs` copiava la voce del
 * registry con uno spread (`{ ...article, commit }`): qualunque campo aggiunto
 * a `content/blog-articles-data.ts` per uso interno del corpus — per primo
 * `articleType`/`verifiedAt`, letti solo dall'audit evergreen — finiva
 * nell'API per caso, senza che nessuno decidesse di estendere il contratto.
 * Lo stesso vale per `canton` (D13 sezioni cantonali), letto dagli hub
 * cantonali dentro il corpus.
 *
 * COME
 * ────
 * `PUBLIC_REGISTRY_FIELDS` sono esattamente i campi che l'API esponeva prima
 * di quel cambio, misurati il 2026-10-04 su `articles.json` (4125 voci) e
 * `swiss-articles.json` (2552) pubblicati al commit 50e046f4e: `id`,
 * `category`, `date`, `updatedAt` (solo dove presente), `image`,
 * `hasCalculator`, `authorSlug`, `authorName`, piu' il marker `commit` che
 * `build-api.mjs` aggiunge a ogni riga. Esporre un campo nuovo richiede di
 * modificare questa lista: e' il cambio di contratto esplicito, da fare
 * insieme ai consumatori del sito.
 *
 * L'ordine delle chiavi segue la voce sorgente (come faceva lo spread), quindi
 * per i campi pubblici l'output resta byte-identico a prima; un campo assente
 * o `undefined` resta assente.
 *
 * Solo builtin: lo importa `build-api.mjs` e il gate `node --test` senza
 * `npm ci` (`generator/tests/registry-api-entry.test.mjs`).
 */

export const PUBLIC_REGISTRY_FIELDS = Object.freeze([
  'id',
  'category',
  'date',
  'updatedAt',
  'image',
  'hasCalculator',
  'authorSlug',
  'authorName',
]);

const PUBLIC = new Set(PUBLIC_REGISTRY_FIELDS);

/**
 * @param {Record<string, unknown>} article voce del registry (puo' contenere campi interni)
 * @param {string} commit marker di release per-riga
 * @returns {Record<string, unknown>} la voce pubblica: solo campi in allowlist + `commit`
 */
export function toPublicRegistryEntry(article, commit) {
  const entry = {};
  for (const key of Object.keys(article)) {
    if (!PUBLIC.has(key)) continue;
    if (article[key] === undefined) continue;
    entry[key] = article[key];
  }
  entry.commit = commit;
  return entry;
}
