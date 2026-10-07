/**
 * Vista pura dei path `mode: identical` del manifest.
 *
 * Il manifest e' il dato; questo modulo non legge file, non fa rete e non
 * conosce il repository. I consumer che devono fidarsi della politica devono
 * materializzare sia questo modulo sia il manifest da `main` prima di
 * invocarlo.
 */

export const READ_ONLY_MODE = 'identical';

function manifestFiles(manifest) {
  return Array.isArray(manifest?.files)
    ? manifest.files.filter((entry) => typeof entry?.path === 'string' && entry.path.length > 0)
    : [];
}
/** Restituisce le sole voci `identical`, preservando l'ordine del manifest. */
export function identicalEntries(manifest) {
  return manifestFiles(manifest).filter((entry) => entry.mode === READ_ONLY_MODE);
}

/** Restituisce l'insieme dei path del corpus che i fixer non possono scrivere. */
export function identicalPaths(manifest) {
  return new Set(identicalEntries(manifest).map((entry) => entry.path));
}

/** Mappa path del corpus → path del sito per i gemelli `identical`. */
export function identicalSitePaths(manifest) {
  return new Map(identicalEntries(manifest).map((entry) => [entry.path, entry.sitePath || entry.path]));
}

/**
 * Divide un elenco di path in due insiemi disgiunti.
 *
 * L'ordine della prima occorrenza viene mantenuto e i duplicati vengono
 * scartati: questo rende l'output adatto sia ai commenti sia a `git restore`.
 */
export function partitionPaths(manifest, paths) {
  const readOnly = identicalPaths(manifest);
  const seen = new Set();
  const writable = [];
  const locked = [];
  for (const value of paths || []) {
    const rel = String(value || '');
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    (readOnly.has(rel) ? locked : writable).push(rel);
  }
  return { writable, readOnly: locked };
}
