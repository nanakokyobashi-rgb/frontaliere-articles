/**
 * source-url-ledger.mjs — la forma delle voci dei due ledger URL→id, e la
 * finestra oltre la quale una voce smette di bloccare la PROPRIA sezione.
 *
 * ## Il difetto che chiude
 *
 * `data/article-source-urls.json` e `data/swiss-article-source-urls.json`
 * mappano l'URL normalizzato della fonte sull'id dell'articolo che ne è nato.
 * `saveSourceUrls` dichiara una finestra — `entries.slice(-500)` — ma è una
 * FIFO **non ancora ingaggiata** (137/500 e 268/500 il 2026-08-18) e senza
 * alcun criterio temporale: di fatto il ledger cresce di +1 per articolo, per
 * sempre. Le fonti invece riservono gli stessi URL a ogni giro, quindi
 * l'insieme scansionabile resta fisso mentre l'insieme dei bloccati sale.
 *
 * MISURATO il 2026-08-18 sulle 49 fonti `frontaliere`, scansione reale:
 * 1.791 URL normalizzati visti, **45 già nel ledger della stessa sezione**.
 * È da lì che viene il collo di bottiglia `📋 Post-filtro URL: 19/51` — non
 * dal ramo Jaccard (`url_slug_match`), che sugli stessi run pesa 2 scarti su 37.
 *
 * ## Perché la finestra è 5 giorni e non 90
 *
 * La scheda proponeva 90 giorni «per coerenza con `TOPIC_COVERAGE_WINDOW_DAYS`».
 * Rimisurato prima di scrivere il codice, 90 **non scade niente**, e non è un
 * fatto transitorio:
 *
 *  · età delle 45 voci che bloccano oggi (data di primo commit del file, git):
 *    p50 4,6 giorni, p90 8,9, **max 11,6**. Recupero per finestra —
 *    90d: 0/45 · 30d: 0/45 · 14d: 0/45 · 7d: 5/45 · **5d: 19/45** · 3d: 27/45.
 *  · a regime la FIFO da 500 voci, al ritmo misurato di ~9 registrazioni al
 *    giorno per sezione, sfratta da sola tutto ciò che supera i ~55 giorni.
 *    Una finestra a 90 giorni sta quindi SEMPRE dietro al cap: sarebbe codice
 *    che non può eseguirsi.
 *
 * Cinque giorni è l'unico valore che tiene insieme le due cose:
 *
 *  1. **> `MAX_ARTICLE_AGE_DAYS` (3)**, ed è l'invariante che rende la finestra
 *     sicura. Una headline DATATA più vecchia di 3 giorni è già scartata dal
 *     filtro di recency, prima ancora del ledger; una più recente di 3 giorni
 *     non può essere scaduta qui, perché la finestra si apre solo al quinto.
 *     Ne segue che la scadenza può riammettere **solo headline UNDATED** —
 *     esattamente il secchio in cui il ledger sovra-blocca — e mai riaprire un
 *     documento di fonte ancora fresco. Il test
 *     `generator/tests/source-url-ledger-ttl.test.mjs` lo verifica.
 *  2. **< l'orizzonte della FIFO** (~55 giorni), quindi la finestra morde
 *     davvero invece di essere ombreggiata dal cap.
 *
 * ## Cosa NON scade, e perché
 *
 *  · **Il ramo cross-sezione resta permanente.** La garanzia comprata
 *    dall'incidente #251 — una fonte non produce un articolo in due sezioni —
 *    non ha una rete equivalente a valle, mentre il riuso DENTRO la sezione ha
 *    ancora `preFlightHeadlineCheck`, `checkForDuplicates` e
 *    `checkSemanticNearDuplicate`. La scadenza è quindi applicata alla sola
 *    vista della sezione attiva, e `cross-section-dedup.mjs` (`mode: identical`)
 *    non viene toccato: riceve mappe URL→id di stringhe come sempre.
 *  · **Una voce senza `ts` è permanente, non scaduta.** I due file oggi
 *    contengono stringhe nude: leggerle come «senza data quindi vecchie»
 *    azzererebbe entrambi i ledger al primo deploy. Il `ts` compare solo sulle
 *    voci scritte da qui in avanti, quindi la finestra comincia a mordere dopo
 *    `SOURCE_URL_TTL_DAYS` giorni di esercizio.
 *
 * Il modulo è puro (i ledger arrivano come argomento) perché
 * `create-article.mjs` non è importabile in test senza `node_modules` — stessa
 * ragione di `cross-section-dedup.mjs`.
 */

/**
 * Giorni dopo i quali una voce DATATA smette di bloccare la propria sezione.
 * Deve restare `> MAX_ARTICLE_AGE_DAYS` (3) e `<` l'orizzonte della FIFO da
 * 500 voci (~55 giorni al ritmo misurato). Vedi il blocco sopra.
 */
export const SOURCE_URL_TTL_DAYS = 5;

/**
 * Normalizza il valore di una voce del ledger, in entrambe le forme.
 *
 * @param {unknown} value stringa (forma storica) oppure `{articleId, ts}`.
 * @returns {{articleId: string, ts: string|null}|null} `null` se la voce non
 *          porta un id utilizzabile.
 */
export function readLedgerEntry(value) {
  if (typeof value === 'string') return value ? { articleId: value, ts: null } : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const articleId = typeof value.articleId === 'string' ? value.articleId : '';
  if (!articleId) return null;
  const ts = typeof value.ts === 'string' && value.ts ? value.ts : null;
  return { articleId, ts };
}

/** L'id di articolo di una voce, in entrambe le forme; `''` se non ce n'è uno. */
export function ledgerArticleId(value) {
  return readLedgerEntry(value)?.articleId ?? '';
}

/** La voce da scrivere per una registrazione nuova: id + istante, sempre datata. */
export function makeLedgerEntry(articleId, now = Date.now()) {
  return { articleId: String(articleId), ts: new Date(now).toISOString() };
}

/**
 * Una voce datata è oltre la finestra?
 *
 * Senza `ts` la risposta è **sempre** `false` (voce storica → permanente).
 * Un `ts` illeggibile è trattato come assente, per la stessa ragione: un
 * timestamp rotto non deve poter sbloccare una fonte.
 */
export function isLedgerEntryExpired(value, { maxAgeDays = SOURCE_URL_TTL_DAYS, now = Date.now() } = {}) {
  const entry = readLedgerEntry(value);
  if (!entry || !entry.ts) return false;
  const at = Date.parse(entry.ts);
  if (!Number.isFinite(at)) return false;
  return now - at > maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * La vista URL→id (valori STRINGA) di un ledger di forma mista.
 *
 * È la forma che `findCrossSectionSourceDuplicate` e `listCrossSectionDuplicates`
 * sanno leggere, e la ragione per cui `cross-section-dedup.mjs` non cambia.
 *
 * @param {Record<string, unknown>} map
 * @param {{maxAgeDays?: number|null, now?: number}} [opts] con `maxAgeDays`
 *        numerico le voci datate oltre la finestra vengono OMESSE; con `null`
 *        (default) la vista è completa, cioè permanente.
 */
export function ledgerArticleIds(map, { maxAgeDays = null, now = Date.now() } = {}) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [url, value] of Object.entries(map)) {
    const articleId = ledgerArticleId(value);
    if (!articleId) continue;
    if (maxAgeDays != null && isLedgerEntryExpired(value, { maxAgeDays, now })) continue;
    out[url] = articleId;
  }
  return out;
}

/**
 * Le viste da passare a `findCrossSectionSourceDuplicate`: la sezione attiva
 * con la finestra applicata, tutte le altre permanenti.
 *
 * @param {Record<string, Record<string, unknown>>} ledgersBySection
 * @param {string} activeSection
 */
export function ledgerViewsForLookup(ledgersBySection, activeSection, { maxAgeDays = SOURCE_URL_TTL_DAYS, now = Date.now() } = {}) {
  const src = ledgersBySection && typeof ledgersBySection === 'object' ? ledgersBySection : {};
  const out = {};
  for (const [section, map] of Object.entries(src)) {
    out[section] = section === activeSection
      ? ledgerArticleIds(map, { maxAgeDays, now })
      : ledgerArticleIds(map);
  }
  return out;
}
