/**
 * mentions-id.mjs — «l'id compare ancora COME id?», in un posto solo.
 *
 * La regola serve a due chiamanti che devono dare la STESSA risposta:
 * la verifica finale di `scripts/retire-article.mjs` (passo 12, esce 1 su
 * `RIMOZIONE PARZIALE`) e il gate di PR `generator/tests/retired-articles-fully-removed.test.mjs`,
 * che rilegge le stesse superfici su ogni voce di `data/retired-articles.json`.
 * Una seconda copia della regola è il modo garantito per farle divergere —
 * e la divergenza qui non è teorica: il gate è in
 * `scripts/ci/list-pr-gate-tests.mjs`, quindi un suo falso residuo non grida
 * su un run manuale, rende ROSSA ogni PR e blocca la coda di merge.
 * Da qui il modulo condiviso (AGENTS.md #6: un valore condiviso ha UNA sorgente).
 */

/**
 * L'id compare ancora nel testo COME id, e non solo come sottostringa di un id
 * più lungo?
 *
 * Gli id si annidano: basta un suffisso d'anno o una qualificazione perché uno
 * diventi prefisso — o infisso — di un altro. Nel corpus è già così
 * (`frontalieri-disoccupazione-svizzera-2026` contiene
 * `disoccupazione-svizzera-2026`), quindi un `includes(id)` nudo sulla verifica
 * finale grida `RIMOZIONE PARZIALE` su una rimozione in realtà completa, esce
 * 1 dopo aver già scritto tutto, e apre una issue di workflow su un corpus
 * sano. Stessa classe del needle nudo di `registerLockTargets()` in
 * `generator/scripts/create-article.mjs`, con l'esito opposto: là il falso
 * `present` NASCONDE uno split, qui il falso leftover ne inventa uno.
 *
 * La verifica resta larga di proposito — scandisce ogni superficie e non solo
 * la forma che lo script ha rimosso — perché a servire è proprio il residuo
 * che non ci si aspetta. Ciò che scarta è solo l'occorrenza che NON è l'id:
 * si prende la sequenza kebab massimale attorno a ogni occorrenza e la si
 * accetta se è esattamente l'id, o `blog-<id>` (la chiave delle voci SEO).
 * Ogni altra forma su queste superfici — `'<id>'`, `"<id>"`,
 * `blog.article.<id>.…` — è già delimitata da un carattere non-kebab e passa.
 *
 * Unica eccezione: il percorso di una copertina, `/images/blog/<id>.<ext>`
 * (anche in coda a un URL CDN). Nomina un FILE, non l'articolo: un altro
 * articolo pubblicato può dichiarare quella copertina nel proprio `image` o
 * nel proprio blocco SEO (oggi 10 copertine sono condivise, es.
 * `a2-giornico-cantiere-disagi-frontalieri` riusata da `laccordo-…`), e
 * `scripts/retire-article.mjs` la conserva apposta. Contarla come residuo
 * farebbe uscire 1 un ritiro completo, e rossa ogni PR col gate. Il blocco
 * dell'articolo ritirato porta comunque anche `id: '<id>'` e `'blog-<id>'`,
 * quindi un suo residuo vero resta visto.
 *
 * @param {string} text contenuto della superficie, letto da disco
 * @param {string} id id dell'articolo ritirato
 * @returns {boolean}
 */
/** Cartella delle copertine: `<COVER_DIR><chiave>.<ext>` è un file, non un id. */
const COVER_DIR = '/images/blog/';

/**
 * La menzione è una chiave di file cover, non un id articolo, solo quando è
 * immediatamente dentro `/images/blog/` e seguita dall'estensione. Il prefisso
 * `blog-` è una chiave SEO valida anche senza un path e quindi va escluso solo
 * in questa forma di percorso.
 */
export function isCoverPathMention(text, id, index, mention) {
  if (typeof text !== 'string' || typeof id !== 'string' || !Number.isInteger(index)) return false;
  if (mention !== id && mention !== `blog-${id}`) return false;
  if (index < COVER_DIR.length) return false;
  return text.slice(index - COVER_DIR.length, index) === COVER_DIR
    && text[index + mention.length] === '.';
}

export function mentionsId(text, id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  const re = new RegExp(`[a-z0-9-]*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-z0-9-]*`, 'g');
  for (const m of text.matchAll(re)) {
    if (isCoverPathMention(text, id, m.index, m[0])) continue;
    if (m[0] === `blog-${id}`) return true;
    if (m[0] !== id) continue;
    return true;
  }
  return false;
}
