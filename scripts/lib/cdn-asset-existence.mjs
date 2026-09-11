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
 *
 * ## IL BUDGET NON COPRIVA LE RICHIESTE IN VOLO (follow-up G31, issue #1219)
 *
 * Il tetto di tempo era controllato solo PRIMA di partire, e ogni richiesta
 * riceveva `AbortSignal.timeout(timeoutMs)` INTERO. Due conseguenze, entrambe
 * dentro il percorso di pubblicazione:
 *
 *   · un asset la cui HEAD risponde 405/501 costava **due** timeout pieni
 *     (HEAD + fallback GET), quindi 16s su un tetto di 30s per UN solo URL;
 *   · l'ultima richiesta ammessa partiva con il timeout pieno anche a budget
 *     quasi esaurito, cioe' `budgetMs + 2 × timeoutMs` nel caso peggiore.
 *
 * Ora ogni richiesta parte con il **residuo**: `min(timeout dell'asset, budget
 * residuo)`, dove il timeout dell'asset e' UNO solo per HEAD+GET (stessa
 * disciplina di `scripts/ci/lib/github-actions-read-client.mjs`, che tiene
 * l'hop del redirect sotto un unico deadline). Il costo peggiore torna a
 * essere `budgetMs`, non un suo multiplo.
 *
 * E un troncamento da budget non si traveste da rumore di rete: se il tempo
 * finisce mentre la richiesta e' in volo — o non ne resta per il fallback GET
 * — l'esito e' `skipped` («non guardato»), non `unknown` («non verificabile»).
 * La distinzione e' l'intero mestiere di questo modulo: un URL che nessuno ha
 * guardato non deve leggersi come un URL guardato e risultato a posto.
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

/** Default per-asset timeout shared by the verifier and its report. */
export const CDN_ASSET_CHECK_TIMEOUT_MS = 8_000;

/**
 * Tetto sul TEMPO complessivo. Le HEAD sono in serie e ciascuna vale
 * `timeoutMs`: senza budget, N URL su un CDN che pende costano N × timeout
 * DENTRO il percorso di pubblicazione, in silenzio. Ogni richiesta parte con
 * il residuo di questo budget (issue #1219), quindi il costo reale e'
 * `budgetMs`, non `budgetMs` piu' le richieste gia' partite.
 */
export const CDN_ASSET_CHECK_BUDGET_MS = 30_000;

/**
 * Millisecondi concessi alla PROSSIMA richiesta, o 0 se non ne restano.
 *
 * Pura e esportata perche' e' l'invariante che la issue #1219 chiedeva: nessuna
 * richiesta puo' durare piu' del budget residuo, e le due richieste di uno
 * stesso asset (HEAD + fallback GET) si dividono UN timeout, non uno ciascuna.
 *
 * @param {object} a
 * @param {number} a.budgetRemainingMs  quanto resta del tetto complessivo
 * @param {number} a.urlRemainingMs     quanto resta del timeout di QUESTO asset
 * @returns {number} ms >= 1, oppure 0 se non resta neppure un millisecondo
 */
export function nextRequestTimeoutMs({ budgetRemainingMs, urlRemainingMs }) {
  const ms = Math.min(Number(budgetRemainingMs), Number(urlRemainingMs));
  if (!Number.isFinite(ms) || ms < 1) return 0;
  return Math.floor(ms);
}

/**
 * Chiude il body di un fallback GET senza trasformare un errore di cleanup in
 * un verdetto sul CDN. Il tempo del cancel resta dentro verifyCdnAssetRefs,
 * quindi il chiamante misura anche il costo reale della risposta.
 *
 * @param {Response|{body?: {cancel?: () => Promise<void>}}|null} response
 */
async function cancelResponseBody(response) {
  if (typeof response?.body?.cancel !== 'function') return;
  try {
    await response.body.cancel();
  } catch {
    // Il controllo è fail-open: un body che non si lascia cancellare non deve
    // cambiare lo stato già determinato dalla risposta HTTP.
  }
}

/**
 * Verifica l'esistenza di ogni URL con una HEAD, entro un tetto complessivo.
 *
 * Gli URL oltre il tetto NON vengono silenziosamente omessi: escono con
 * `state: 'skipped'`, cosi' il report distingue «verificati e presenti» da
 * «non guardati» (la stessa distinzione che questo modulo esiste per fare).
 * Vale anche per il troncamento da budget: cio' che il tempo ha tagliato e'
 * `skipped`, non `unknown` — vedi l'intestazione del modulo.
 *
 * @param {object} a
 * @param {string[]} a.urls
 * @param {typeof fetch} [a.fetchImpl]  iniettabile per i test (default: fetch globale)
 * @param {number} [a.timeoutMs]        timeout per ASSET (condiviso da HEAD e fallback GET)
 * @param {number} [a.maxUrls]          tetto sul numero di URL verificati
 * @param {number} [a.budgetMs]         tetto sul tempo complessivo della verifica
 * @param {() => number} [a.now]        orologio iniettabile per i test
 * @param {(ms: number) => AbortSignal} [a.makeSignal] fabbrica del signal, iniettabile per i test
 * @returns {Promise<Array<{url: string, state: 'present'|'missing'|'unknown'|'skipped', status: number|null, error: string|null}>>}
 */
export async function verifyCdnAssetRefs({
  urls,
  fetchImpl = fetch,
  timeoutMs = CDN_ASSET_CHECK_TIMEOUT_MS,
  maxUrls = CDN_ASSET_CHECK_MAX_URLS,
  budgetMs = CDN_ASSET_CHECK_BUDGET_MS,
  now = Date.now,
  makeSignal = (ms) => AbortSignal.timeout(ms),
}) {
  const results = [];
  const startedAt = now();
  const budgetLeft = () => budgetMs - (now() - startedAt);
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
    // UN timeout per asset, non uno per richiesta: il fallback GET eredita cio'
    // che la HEAD non ha speso, e non puo' raddoppiare il costo dell'asset.
    const urlStartedAt = now();
    const nextTimeout = () =>
      nextRequestTimeoutMs({
        budgetRemainingMs: budgetLeft(),
        urlRemainingMs: timeoutMs - (now() - urlStartedAt),
      });
    try {
      const headTimeout = nextTimeout();
      if (headTimeout === 0) {
        results.push({
          url,
          state: 'skipped',
          status: null,
          error: `nessun millisecondo intero residuo per la HEAD ` +
            `(budget di ${budgetMs}ms, timeout di ${timeoutMs}ms per asset)`,
        });
        continue;
      }
      let res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: makeSignal(headTimeout) });
      // Alcune origin non implementano HEAD (405/501): la domanda è
      // sull'esistenza dell'oggetto, non sul metodo, quindi si ripiega su GET
      // invece di registrare un falso `missing`.
      if (res.status === 405 || res.status === 501) {
        const getTimeout = nextTimeout();
        if (getTimeout === 0) {
          // Senza il GET l'esistenza resta indecisa: dirlo `unknown` la
          // farebbe leggere come rumore di rete, ed e' invece tempo finito.
          results.push({
            url,
            state: 'skipped',
            status: res.status,
            error: `HEAD ${res.status} e nessun tempo residuo per il fallback GET ` +
              `(budget di ${budgetMs}ms, timeout di ${timeoutMs}ms per asset)`,
          });
          continue;
        }
        res = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: makeSignal(getTimeout) });
        await cancelResponseBody(res);
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
      const detail = String((err && err.message) || err);
      if (budgetLeft() <= 0) {
        // Abortita DAL budget: e' la verifica che si e' fermata, non il CDN che
        // non risponde. Contarla fra i «non verificabili» avrebbe nascosto un
        // tetto sistematicamente esaurito dentro il rumore di rete.
        results.push({
          url,
          state: 'skipped',
          status: null,
          error: `budget di ${budgetMs}ms esaurito durante la richiesta (${detail})`,
        });
      } else {
        results.push({ url, state: 'unknown', status: null, error: detail });
      }
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
 * Il MARGINE del passo (issue #1219) si stampa quando il chiamante lo misura:
 * un tetto che non si sa quanto avanza non e' un tetto misurato. Un elapsed
 * oltre `budgetMs + timeoutMs` e' impossibile finche' ogni richiesta parte col
 * residuo, quindi diventa un `::warning::`: e' la firma della regressione.
 *
 * @param {Array<{url: string, state: string, status: number|null, error: string|null}>} results
 * @param {string} [prefix] etichetta del log
 * @param {object} [budget] misura del passo
 * @param {number|null} [budget.elapsedMs] durata reale della verifica
 * @param {number} [budget.budgetMs] tetto complessivo applicato
 * @param {number} [budget.timeoutMs] timeout per asset applicato
 * @returns {string[]}
 */
export function formatCdnAssetReport(
  results,
  prefix = '[cdn-asset-check]',
  { elapsedMs = null, budgetMs = CDN_ASSET_CHECK_BUDGET_MS, timeoutMs = CDN_ASSET_CHECK_TIMEOUT_MS } = {},
) {
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
    // Le ragioni sono piu' d'una (tetto di URL, budget prima della richiesta,
    // budget durante, GET di fallback senza residuo): stamparne una sola
    // avrebbe attribuito al tetto anche cio' che il tempo ha tagliato.
    const reasons = [...new Set(skipped.map((r) => r.error))];
    lines.push(
      `${prefix} verifica fermata prima della fine: ${skipped.length} URL NON guardati ` +
        `(${reasons.join(' ; ')}). Non sono «presenti»: sono ignoti.`,
    );
  }
  lines.push(
    `${prefix} ${results.length - skipped.length} asset CDN distinti verificati ; ` +
      `${results.filter((r) => r.state === 'present').length} presenti ; ${missing.length} mancanti ; ` +
      `${unknown.length} non verificabili` +
      (skipped.length ? ` ; ${skipped.length} non guardati` : ''),
  );
  if (Number.isFinite(elapsedMs)) {
    const margin = budgetMs - elapsedMs;
    lines.push(
      `${prefix} passo di verifica in ${elapsedMs}ms su un tetto di ${budgetMs}ms ` +
        `(margine ${margin}ms ; timeout per asset ${timeoutMs}ms)`,
    );
    if (elapsedMs > budgetMs + timeoutMs) {
      lines.push(
        `::warning::${prefix} la verifica ha superato il tetto di piu' di un timeout per asset ` +
          `(${elapsedMs}ms > ${budgetMs}ms + ${timeoutMs}ms): una richiesta e' partita senza il ` +
          'budget residuo, cioe\' il tetto non sta piu\' limitando il percorso di pubblicazione.',
      );
    }
  }
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
