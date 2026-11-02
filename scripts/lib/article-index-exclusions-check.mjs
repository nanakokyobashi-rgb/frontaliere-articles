/**
 * Una riga del ledger che non corrisponde a nessun articolo non fa niente, e non lo
 * dice: un refuso nell'id lascerebbe l'articolo in sitemap, in RSS e indicizzato.
 * Il publisher rifiuta il ledger invece di ignorare la riga. `retire-article.mjs`
 * toglie la riga insieme all'articolo, quindi un ritiro non blocca la pubblicazione.
 *
 * @param {Iterable<string>} excludedKeys chiavi `sezione|id` del ledger
 * @param {Iterable<string>} articleKeys chiavi `sezione|id` dei registri pubblicati
 * @param {ReadonlySet<string>} publishedSections sezioni di cui il chiamante ha i registri
 * @param {ReadonlySet<string>} knownSections tutte le sezioni del core, attive o no
 * @returns {string[]} chiavi sconosciute. Una sezione nota ma non attiva non si
 *   giudica: il suo registro non e' fra quelli letti.
 */
export function unknownIndexExclusionKeys(excludedKeys, articleKeys, publishedSections, knownSections) {
  const known = new Set(articleKeys);
  return [...excludedKeys].filter((key) => {
    const section = key.slice(0, key.indexOf('|'));
    if (!knownSections.has(section)) return true;
    return publishedSections.has(section) && !known.has(key);
  });
}
