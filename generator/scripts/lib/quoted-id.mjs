/**
 * quoted-id.mjs — «questo file cita ancora l'articolo <id>?», senza il falso
 * positivo del prefisso.
 *
 * ## Il difetto che questo modulo esiste per chiudere
 *
 * Cercare un article id con `src.includes(id)` — l'id nudo — significa cercarne
 * una SOTTOSTRINGA: ogni id più lungo che comincia (o finisce) con quello lo
 * contiene. Con `frontalieri-imposta-2026-ticino` nel corpus,
 * `frontalieri-imposta-2026` risulta «presente» in ogni superficie, anche
 * quando non c'è.
 *
 * Nei due chiamanti la conseguenza è la stessa, un arresto duro su un corpus
 * sano: `scripts/retire-article.mjs` dichiara «RIMOZIONE PARZIALE» ed esce 1 su
 * un ritiro completato — e quel `exit 1` è proprio ciò che dovrebbe segnalare
 * il caso in cui la pubblicazione si blocca — mentre
 * `generator/tests/retired-articles-fully-removed.test.mjs` diventa rosso sullo
 * stesso corpus. Il gemello sul lato scrittura vive in `registerLockTargets()`
 * (create-article.mjs), dove i needle del lock di registrazione sono ancorati
 * ai delimitatori che ogni `modifyXxx()` emette davvero.
 *
 * ## Perché il confine è un insieme di caratteri e non `\b`
 *
 * Gli id sono `[a-z0-9-]`, quindi `\b` non separa `imposta-2026` da
 * `frontalieri-imposta-2026`: il trattino è un confine di parola. I caratteri
 * che nel corpus delimitano DAVVERO un id sono soltanto quattro, e coprono
 * tutte le superfici che i chiamanti rileggono:
 *
 *   - `'` e `"` → mappa slug (`'<id>':`), registro (`id: '<id>'`), union
 *     (`| '<id>'`), ledger JSON (`"<id>"`);
 *   - `.` → chiavi i18n dei file meta (`'blog.article.<id>.title'`);
 *   - `/` → path dei corpi (`blog-body/it/<id>.ts`).
 *
 * L'unico prefisso legittimo è quello del file SEO (`'blog-<id>':`), ammesso
 * per nome. Ammettere un prefisso generico `[a-z0-9-]*-` avrebbe reintrodotto
 * lo stesso difetto dal lato opposto: `imposta-2026` combacerebbe dentro
 * `frontalieri-imposta-2026`, che è un ALTRO articolo.
 */

/** Gli id sono `[a-z0-9-]`, ma l'escape resta perché la fonte è un file dati. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * La regex che riconosce `id` come token delimitato. Nuova a ogni chiamata: una
 * regex condivisa con `g` porterebbe `lastIndex` da un file all'altro.
 *
 * @param {string} id article id
 * @returns {RegExp}
 */
export function quotedIdRegex(id) {
  const e = escapeRegex(id);
  return new RegExp(`(?:['"./]|['"]blog-)${e}(?=['"./])`);
}

/**
 * `true` se `text` cita `id` come token delimitato (vedi l'intestazione).
 *
 * @param {string} text contenuto del file
 * @param {string} id article id
 * @returns {boolean}
 */
export function containsQuotedId(text, id) {
  return quotedIdRegex(id).test(text);
}
