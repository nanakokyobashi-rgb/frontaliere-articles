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
 */

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
  // Stessa coda-di-file dell'offload (ASSET_FILE): tutto ciò che il rewrite
  // può aver prodotto, e nient'altro. Tenuta deliberatamente conservativa —
  // un URL che non matcha qui semplicemente non viene verificato.
  const re = new RegExp(
    base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      "/assets/([^\"'\\s)?]+?\\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|webp|avif|gif|svg|ico|json))",
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
 * Verifica l'esistenza di ogni URL con una HEAD.
 *
 * @param {object} a
 * @param {string[]} a.urls
 * @param {typeof fetch} [a.fetchImpl]  iniettabile per i test (default: fetch globale)
 * @param {number} [a.timeoutMs]        timeout per richiesta
 * @returns {Promise<Array<{url: string, state: 'present'|'missing'|'unknown', status: number|null, error: string|null}>>}
 */
export async function verifyCdnAssetRefs({ urls, fetchImpl = fetch, timeoutMs = 8000 }) {
  const results = [];
  for (const url of urls) {
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
 * smettono di essere letti.
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
  lines.push(
    `${prefix} ${results.length} asset CDN distinti verificati ; ` +
      `${results.filter((r) => r.state === 'present').length} presenti ; ${missing.length} mancanti ; ` +
      `${unknown.length} non verificabili`,
  );
  return lines;
}
