/**
 * cross-repo-raw-fetch.mjs — il token di QUESTO repo non decide se un file
 * ESISTE su un altro repo.
 *
 * ## Il buco che chiude (issue #982)
 *
 * Gli osservatori del ciclo leggono i byte del sito da
 * `raw.githubusercontent.com` e, se `GH_TOKEN`/`GITHUB_PAT` c'e', lo mandano
 * come `Bearer`. In CI quel token e' il `GITHUB_TOKEN` di QUESTO repo:
 * un'installation token valida, ma senza alcun permesso su
 * `valerielinc-ops/frontaliere-si-o-no`, che e' di un altro owner. Cosa
 * risponde raw a una credenziale legittima ma non autorizzata non e' mai stato
 * verificato, e le due risposte plausibili sono entrambe rovinose:
 *
 *   · **401/403** — il chiamante lancia, e tutte le voci escono `unobserved`.
 *     Il verificatore della provenienza esce rosso con `unobserved=49` alla
 *     prima notte, per un difetto del client e non del contratto.
 *   · **404** — molto peggio, perche' NON lancia: raw usa 404 anche per «non
 *     autorizzato», quindi l'assenza fabbricata dal token si traveste da
 *     osservazione. `absent` significa «il sito ha rimosso quel file» e manda
 *     il fixer a rigenerare artifact sanissimi.
 *
 * Il repo del sito e' PUBBLICO: la richiesta anonima e' quella che risponde la
 * verita'. Quindi il token e' un'ottimizzazione di rate-limit, mai una
 * precondizione — e quando la risposta autenticata puzza di rifiuto, la parola
 * definitiva ce l'ha il tentativo SENZA credenziali.
 *
 * ## Perche' il verdetto sul token e' appiccicoso
 *
 * Ritentare in anonimo ogni 404 raddoppierebbe i fetch proprio nel caso in cui
 * il token e' inutile: 49 voci diventerebbero ~98 richieste contro i 60/ora
 * anonimi per IP, condivisi fra tutti i runner GitHub. Quindi la prima volta
 * che l'anonimo RIESCE dove l'autenticato aveva fallito il token e' provato
 * rifiutato e non viene piu' mandato: la doppia richiesta si paga una volta,
 * non una per file. Un 404 confermato anche in anonimo, invece, non prova
 * niente sul token e lo lascia in uso.
 */

/**
 * Gli status che, su una richiesta AUTENTICATA, possono essere prodotti dal
 * token invece che dal contenuto. Il 404 e' qui apposta: e' la risposta di raw
 * a chi non ha accesso, e senza controprova e' indistinguibile da un'assenza
 * vera.
 */
export const TOKEN_SUSPECT_STATUSES = new Set([401, 403, 404]);

/** Vale la pena richiedere in anonimo? Solo se il token era in gioco. */
export function needsAnonymousRetry(status, { authenticated } = {}) {
  return Boolean(authenticated) && TOKEN_SUSPECT_STATUSES.has(status);
}

/**
 * Un fetcher per un repo PUBBLICO di un altro owner. Ritorna la `Response`
 * autorevole: quella anonima quando il token si e' rivelato un ostacolo.
 *
 * `fetchRaw.state` e' osservabile dai report — `tokenRejected` e' esattamente
 * la diagnosi che mancava quando un rosso arrivava dal client.
 */
export function createRawFetcher({ userAgent, token, fetchImpl = fetch } = {}) {
  const state = { authenticated: Boolean(token), tokenRejected: false, anonymousRetries: 0 };

  const attempt = (url, authenticated, extraHeaders) => {
    const headers = { ...extraHeaders };
    if (userAgent) headers['User-Agent'] = userAgent;
    if (authenticated) headers.Authorization = `Bearer ${token}`;
    return fetchImpl(url, { headers });
  };

  const fetchRaw = async (url, extraHeaders) => {
    const authenticated = state.authenticated && !state.tokenRejected;
    const res = await attempt(url, authenticated, extraHeaders);
    if (!needsAnonymousRetry(res.status, { authenticated })) return res;

    state.anonymousRetries += 1;
    const anon = await attempt(url, false, extraHeaders);
    // Solo un anonimo che RIESCE dimostra che a rispondere era il token: un
    // 404 confermato e' un'assenza vera, e continuare a mandare il token tiene
    // il rate-limit alto per tutte le altre voci.
    if (anon.ok) state.tokenRejected = true;
    return anon;
  };

  fetchRaw.state = state;
  return fetchRaw;
}
