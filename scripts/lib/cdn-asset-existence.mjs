/**
 * cdn-asset-existence.mjs — l'asset riscritto sul CDN esiste davvero?
 *
 * ## IL DIFETTO (follow-up di #764, issue #788)
 *
 * `scripts/offload-generated-images-cdn.mjs` riscrive OGNI `/assets/<file>`
 * same-origin trovato nell'HTML in `${CDN_BASE}/assets/<file>`, senza che
 * nessuno verifichi che l'oggetto esista dall'altra parte. Per le altre fasi
 * dell'offload l'esistenza è garantita dall'ORDINE: og, data, images e
 * job-canon vengono spinti sul CDN dal deploy PRIMA che lo script giri, quindi
 * riscrivere ciò che si è appena caricati è sicuro per costruzione.
 *
 * `/assets/` non ha quella garanzia, e in questo repo non può averla: il
 * fast-publish non builda né spinge nulla sotto `dist/assets` — quei
 * riferimenti sono chrome HTML che punta al bundle dell'ULTIMO deploy del sito.
 * Finché il file è emesso dal sito e caricato sul CDN va tutto bene; ma il
 * contratto ora trasporta anche riferimenti ad asset che questo repo non emette
 * e sul cui ciclo di vita non ha voce: `partnerizeTagSnippet` (#764) punta a
 * `/assets/partnerize-tag.js`, scritto da `staticScriptsPlugin.ts` del SITO. Se
 * quell'oggetto non è (ancora) sul CDN, ogni pagina fast-published lo riscrive
 * su un URL che 404a: nessuna eccezione, nessun gate rosso, zero tracking
 * affiliato — e il ciclo di pubblicazione non se ne accorge, perché il rewrite
 * è andato a buon fine. L'unica guardia finora era la review umana, che si è
 * consumata col merge.
 *
 * ## PERCHÉ UN AVVISO E NON UN GATE
 *
 * Due strade erano sbarrate, e vale la pena scriverlo:
 *
 *   · **gating sull'esistenza LOCALE** (`fs.existsSync(dist/assets/<file>)`) è
 *     l'antipattern che l'offload documenta già per le dir og/images (#3475):
 *     i dist shard non contengono quelle cartelle pur avendo i byte sul CDN, e
 *     gatare il rewrite le lasciava same-origin → 301 o 404. Qui sarebbe anche
 *     peggio: `dist/assets` non esiste MAI nel fast-publish, quindi ogni
 *     rewrite verrebbe soppresso e ogni pagina uscirebbe senza CSS né bundle
 *     (esattamente il danno della #5270).
 *   · **far fallire la pubblicazione** su un 404 significa non pubblicare
 *     l'articolo perché uno script di tracking affiliato manca. Il rapporto fra
 *     i due danni è chiaro, e questo repo pubblica su una superficie che il
 *     sito non ribuilda: il percorso di pubblicazione non si rompe per una
 *     verifica accessoria (stessa regola che l'offload si dà: NON-FATAL).
 *
 * Resta la terza: VERIFICARE e DIRLO. Una HEAD per URL distinto (una manciata
 * per run, deduplicata sull'intero dist) trasforma un 404 silenzioso e
 * indefinito in una riga `::warning::` nel log del workflow, che è la
 * differenza fra un difetto che si scopre e uno che non si scopre.
 *
 * Fail-open su ogni errore di rete/timeout: un DNS che flappa non deve
 * produrre un avviso che accusa il CDN di non avere un file che ha.
 *
 * ## DUE COSE CHE «NON ESPLODONO» (follow-up di #790, issue #817)
 *
 *   · **offload fallito vs niente da riscrivere.** L'offload e' NON-FATAL per
 *     costruzione: su un guard leak, un `CDN_BASE` assente o QUALSIASI errore
 *     lascia `dist` intatto ed esce 0. In quel caso qui non si trova nessun URL
 *     CDN — esattamente come nel caso sano in cui non c'era nulla da riscrivere.
 *     Il segnale piu' interessante era quello che il log presentava come
 *     normale. La discriminante e' l'HTML stesso: se i `/assets/` sono rimasti
 *     SAME-ORIGIN, il rewrite non e' avvenuto (vedi
 *     {@link formatOffloadCoverageReport}).
 *   · **budget sulle HEAD.** La verifica e' in serie dentro il percorso di
 *     pubblicazione: senza un tetto, il costo peggiore cresce linearmente col
 *     numero di URL distinti e un CDN che pende allunga la run senza far
 *     fallire niente. {@link verifyCdnAssetRefs} si ferma al tetto e LO DICE
 *     (`state: 'skipped'`) invece di scomparire dentro un totale piu' basso.
 */

import { ASSET_EXT_ALTERNATION, ASSETS_SAME_ORIGIN_RX } from '../../host/shared/cdnAssetOffloadRx.mjs';

/**
 * Estrae gli URL `${cdnBase}/assets/<file>` distinti da un testo HTML.
 *
 * Applicato DOPO l'offload, quindi cerca l'URL già riscritto: è ciò che la
 * pagina servirà davvero, e la domanda utile è su quello.
 *
 * @param {string} html      il contenuto del file
 * @param {string} cdnBase   base senza slash finale (es. https://cdn.frontaliereticino.ch)
 * @returns {string[]} URL distinti, in ordine di apparizione
 */
export function collectCdnAssetRefs(html, cdnBase) {
  const base = String(cdnBase || '').replace(/\/+$/, '');
  if (!base) return [];
  // Stesso alfabeto di estensioni dell'offload — importato, non ricopiato
  // (AGENTS.md #6): tutto ciò che il rewrite
  // può aver prodotto, e nient'altro. Tenuta deliberatamente conservativa —
  // un URL che non matcha qui semplicemente non viene verificato.
  const re = new RegExp(
    base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      // `(?![A-Za-z0-9])` chiude l'estensione: senza, il ramo `js`
      // dell'alternanza matcha il prefisso di `f.json` e la HEAD partirebbe
      // verso `f.js` — un URL che nessuno serve, cioe' un falso `missing`.
      `/assets/([^\"'\\s)?]+?\\.(?:${ASSET_EXT_ALTERNATION})(?![A-Za-z0-9]))`,
    'g',
  );
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(re)) {
    const url = `${base}/assets/${m[1]}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Tetto sul NUMERO di URL verificati in una run. Oggi i riferimenti distinti
 * sono una manciata; il tetto non serve a limitarli, serve a pinnare il costo
 * peggiore perche' non cresca con l'HTML senza che nessuno se ne accorga.
 */
export const CDN_ASSET_CHECK_MAX_URLS = 24;

/**
 * Tetto sul TEMPO complessivo. Le HEAD sono in serie e ciascuna vale
 * `timeoutMs`: senza budget, N URL su un CDN che pende costano N × timeout
 * DENTRO il percorso di pubblicazione, in silenzio. Controllato PRIMA di ogni
 * richiesta, quindi il costo reale e' `budgetMs` + l'ultima richiesta in volo.
 */
export const CDN_ASSET_CHECK_BUDGET_MS = 30_000;

/**
 * Verifica l'esistenza di ogni URL con una HEAD, entro un tetto complessivo.
 *
 * Gli URL oltre il tetto NON vengono silenziosamente omessi: escono con
 * `state: 'skipped'`, cosi' il report distingue «verificati e presenti» da
 * «non guardati» (la stessa distinzione che questo modulo esiste per fare).
 *
 * @param {object} a
 * @param {string[]} a.urls
 * @param {typeof fetch} [a.fetchImpl]  iniettabile per i test (default: fetch globale)
 * @param {number} [a.timeoutMs]        timeout per richiesta
 * @param {number} [a.maxUrls]          tetto sul numero di URL verificati
 * @param {number} [a.budgetMs]         tetto sul tempo complessivo della verifica
 * @param {() => number} [a.now]        orologio iniettabile per i test
 * @returns {Promise<Array<{url: string, state: 'present'|'missing'|'unknown'|'skipped', status: number|null, error: string|null}>>}
 */
export async function verifyCdnAssetRefs({
  urls,
  fetchImpl = fetch,
  timeoutMs = 8000,
  maxUrls = CDN_ASSET_CHECK_MAX_URLS,
  budgetMs = CDN_ASSET_CHECK_BUDGET_MS,
  now = Date.now,
}) {
  const results = [];
  const startedAt = now();
  let checked = 0;
  for (const url of urls) {
    if (checked >= maxUrls) {
      results.push({ url, state: 'skipped', status: null, error: `tetto di ${maxUrls} URL raggiunto` });
      continue;
    }
    const elapsed = now() - startedAt;
    if (elapsed >= budgetMs) {
      results.push({ url, state: 'skipped', status: null, error: `budget di ${budgetMs}ms esaurito (${elapsed}ms)` });
      continue;
    }
    checked += 1;
    try {
      let res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      // Alcune origin non implementano HEAD (405/501): la domanda è
      // sull'esistenza dell'oggetto, non sul metodo, quindi si ripiega su GET
      // invece di registrare un falso `missing`.
      if (res.status === 405 || res.status === 501) {
        res = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      }
      if (res.ok) {
        results.push({ url, state: 'present', status: res.status, error: null });
      } else if (res.status >= 400 && res.status < 500) {
        // 4xx è una risposta del CDN sull'oggetto: l'oggetto non c'è.
        results.push({ url, state: 'missing', status: res.status, error: null });
      } else {
        // 5xx è uno stato del CDN, non dell'oggetto: fail-open.
        results.push({ url, state: 'unknown', status: res.status, error: null });
      }
    } catch (err) {
      results.push({ url, state: 'unknown', status: null, error: String((err && err.message) || err) });
    }
  }
  return results;
}

/**
 * Righe da stampare per un insieme di verdetti. Pura: il chiamante stampa.
 *
 * Solo i `missing` diventano `::warning::` — un `unknown` è rumore di rete e un
 * avviso che si ripete senza essere azionabile è il modo in cui gli avvisi
 * smettono di essere letti. Uno `skipped` non è né rumore né un difetto del
 * CDN: è la verifica che si è fermata al tetto, e va detto perché il riepilogo
 * non si legga come «tutto verificato».
 *
 * @param {Array<{url: string, state: string, status: number|null, error: string|null}>} results
 * @param {string} [prefix] etichetta del log
 * @returns {string[]}
 */
export function formatCdnAssetReport(results, prefix = '[cdn-asset-check]') {
  const lines = [];
  const missing = results.filter((r) => r.state === 'missing');
  const unknown = results.filter((r) => r.state === 'unknown');
  for (const r of missing) {
    lines.push(
      `::warning::${prefix} ${r.url} risponde ${r.status}: il riferimento e' stato riscritto sul CDN ` +
        "ma l'oggetto non c'e'. Ogni pagina pubblicata da questa run lo carichera' a vuoto " +
        '(se e\' partnerize-tag.js: zero tracking affiliato) finche\' il sito non lo pubblica.',
    );
  }
  if (unknown.length) {
    lines.push(
      `${prefix} ${unknown.length} URL non verificabili (rete/5xx, fail-open): ` +
        unknown.map((r) => `${r.url} (${r.status ?? r.error})`).join(', '),
    );
  }
  const skipped = results.filter((r) => r.state === 'skipped');
  if (skipped.length) {
    lines.push(
      `${prefix} verifica fermata al tetto: ${skipped.length} URL NON guardati ` +
        `(${skipped[0].error}). Non sono «presenti»: sono ignoti.`,
    );
  }
  lines.push(
    `${prefix} ${results.length - skipped.length} asset CDN distinti verificati ; ` +
      `${results.filter((r) => r.state === 'present').length} presenti ; ${missing.length} mancanti ; ` +
      `${unknown.length} non verificabili` +
      (skipped.length ? ` ; ${skipped.length} non guardati (tetto)` : ''),
  );
  return lines;
}

/**
 * L'HTML pubblicato contiene ancora un riferimento `/assets/` SAME-ORIGIN?
 *
 * È la discriminante fra «l'offload non ha riscritto niente» e «non c'era
 * niente da riscrivere»: l'offload sostituisce OGNI `/assets/` same-origin con
 * `${cdnBase}/assets/`, quindi un same-origin superstite dopo l'offload
 * significa che il rewrite non è avvenuto — su questo repo `dist/assets` non
 * esiste, quindi quel riferimento non è servibile da nessuno.
 *
 * Usa lo stesso matcher del gate di deploy (`ASSETS_SAME_ORIGIN_RX`), non una
 * copia: se l'alfabeto cambia lì, cambia qui (AGENTS.md #6).
 *
 * @param {string} html
 * @returns {boolean}
 */
export function hasSameOriginAssetRef(html) {
  return ASSETS_SAME_ORIGIN_RX.test(String(html || ''));
}

/**
 * Righe di copertura dell'offload: che cosa significa non aver trovato URL CDN.
 *
 * Tre esiti distinti dove prima ce n'era uno solo (issue #817, item 1):
 *
 *   · `sameOriginFiles` non vuoto → **l'offload non ha riscritto.** È un
 *     `::warning::`: lo script è NON-FATAL e su qualunque errore lascia `dist`
 *     intatto ed esce 0, quindi questo è l'UNICO punto in cui il guasto è
 *     osservabile. Le pagine di questa run servono `/assets/` same-origin, che
 *     su questo repo non esiste.
 *   · nessun same-origin e nessun URL CDN → non c'era davvero niente da
 *     riscrivere. Riga informativa, e ora lo dice per esteso.
 *   · URL CDN presenti → nessuna riga di copertura: parla il report delle HEAD.
 *
 * @param {object} a
 * @param {number} a.cdnRefCount            URL `${cdnBase}/assets/…` distinti trovati
 * @param {string[]} a.sameOriginFiles      path (relativi) con un `/assets/` same-origin superstite
 * @param {string} [a.prefix]               etichetta del log
 * @returns {string[]}
 */
export function formatOffloadCoverageReport({ cdnRefCount, sameOriginFiles, prefix = '[cdn-asset-check]' }) {
  const stragglers = sameOriginFiles || [];
  if (stragglers.length) {
    const sample = stragglers.slice(0, 5).join(', ');
    const more = stragglers.length > 5 ? ` (+${stragglers.length - 5} altri)` : '';
    return [
      `::warning::${prefix} ${stragglers.length} file HTML hanno ancora riferimenti /assets/ ` +
        `SAME-ORIGIN dopo l'offload: ${sample}${more}. L'offload NON ha riscritto — e' non-fatale e ` +
        "esce 0 lasciando dist intatto su CDN_BASE assente, guard leak o errore interno, quindi " +
        "questo e' l'unico segnale. Non e' «niente da riscrivere»: dist/assets non esiste in questo " +
        'repo, quindi quei riferimenti non sono servibili da nessuno.',
    ];
  }
  if (!cdnRefCount) {
    return [
      `${prefix} nessun riferimento /assets/ nell'HTML pubblicato: ne' riscritto sul CDN ne' rimasto ` +
        "same-origin, quindi non c'era davvero niente da riscrivere ne' da verificare",
    ];
  }
  return [];
}
