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

/** Maximum time allowed for one cross-repository request, including body use. */
export const CROSS_REPO_FETCH_TIMEOUT_MS = 30_000;

const BODY_METHODS = ['arrayBuffer', 'blob', 'formData', 'json', 'text'];
const RESPONSE_TIMEOUT = Symbol('crossRepoResponseTimeout');
const RESPONSE_ABORT = Symbol('crossRepoResponseAbort');

function timeoutReason() {
  if (typeof DOMException === 'function') {
    return new DOMException('cross-repository request timed out', 'TimeoutError');
  }
  const error = new Error('cross-repository request timed out');
  error.name = 'TimeoutError';
  return error;
}

/**
 * AbortSignal.timeout() intentionally uses an unref'ed timer in Node. That is
 * correct for a real fetch (the socket keeps the event loop alive), but a
 * fetch stub which waits only on the signal can be cancelled before the timer
 * fires. Keep a referenced timer for the same deadline and release it when a
 * response body has been consumed or when the response is discarded.
 */
function createDeadline(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutReason()), timeoutMs);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
  };

  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
    release();
  };
  return { signal: controller.signal, release, abort };
}

function attachResponseDeadline(response, { release, abort }) {
  if (!response || typeof response !== 'object') return response;
  try {
    Object.defineProperty(response, RESPONSE_TIMEOUT, {
      configurable: true,
      value: release,
    });
    Object.defineProperty(response, RESPONSE_ABORT, {
      configurable: true,
      value: abort,
    });
    let hasBodyMethod = false;
    for (const method of BODY_METHODS) {
      if (typeof response[method] !== 'function') continue;
      hasBodyMethod = true;
      const original = response[method].bind(response);
      response[method] = (...args) => Promise.resolve(original(...args)).finally(release);
    }
    if (!hasBodyMethod) release();
  } catch {
    // A native Response may reject an instance property assignment. Its body
    // owns a referenced stream, so the deadline still fires safely; callers
    // can still receive the signal and abort the body.
  }
  return response;
}

function discardResponseDeadline(response) {
  try {
    response?.[RESPONSE_ABORT]?.();
    response?.body?.cancel?.();
  } catch {
    // Cleanup must never mask the original HTTP/error result.
  }
}

/** Vale la pena richiedere in anonimo? Solo se il token era in gioco. */
export function needsAnonymousRetry(status, { authenticated } = {}) {
  return Boolean(authenticated) && TOKEN_SUSPECT_STATUSES.has(status);
}

/**
 * Un fetcher per un repo PUBBLICO di un altro owner. Ritorna la `Response`
 * autorevole: quella anonima quando il token si e' rivelato un ostacolo.
 *
 * `fetchRaw.state` e' osservabile dai report — `tokenRejected` e
 * `tokenAccepted` sono indicizzati per owner/repo, perche' una shard privata
 * non deve squalificare il token verso una shard diversa.
 */
export class CrossRepoRateLimitError extends Error {
  constructor(url, response) {
    super(`GET ${url} → rate limit anonimo (HTTP ${response.status})`);
    this.name = 'CrossRepoRateLimitError';
    this.code = 'CROSS_REPO_RATE_LIMIT';
    this.url = url;
    this.status = response.status;
    this.response = response;
  }
}

function headerValue(response, name) {
  if (typeof response?.headers?.get === 'function') return response.headers.get(name);
  return response?.headers?.[name] ?? response?.headers?.[name.toLowerCase()] ?? null;
}

function isRateLimitResponse(response) {
  return response?.status === 429 || (response?.status === 403 && headerValue(response, 'x-ratelimit-remaining') === '0');
}

function repositoryKey(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return String(url);
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname === 'raw.githubusercontent.com' && parts.length >= 2) return `${parts[0]}/${parts[1]}`.toLowerCase();
  if (parsed.hostname === 'api.github.com' && parts[0] === 'repos' && parts.length >= 3) return `${parts[1]}/${parts[2]}`.toLowerCase();
  return parsed.origin;
}

export function createRawFetcher({
  userAgent,
  token,
  fetchImpl = fetch,
  timeoutMs = CROSS_REPO_FETCH_TIMEOUT_MS,
} = {}) {
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.floor(timeoutMs))
    : CROSS_REPO_FETCH_TIMEOUT_MS;
  const state = {
    authenticated: Boolean(token),
    tokenRejected: new Map(),
    tokenAccepted: new Map(),
    anonymousRetries: 0,
  };

  const attempt = (url, authenticated, extraHeaders) => {
    const headers = { ...extraHeaders };
    if (userAgent) headers['User-Agent'] = userAgent;
    if (authenticated) headers.Authorization = `Bearer ${token}`;
    const deadline = createDeadline(effectiveTimeoutMs);
    return Promise.resolve(fetchImpl(url, {
      headers,
      // The caller may consume text/json/arrayBuffer after this function
      // returns. Keep this signal on the Response so the same deadline covers
      // both the headers and the body, not just connection establishment.
      signal: deadline.signal,
    })).then((response) => {
      return attachResponseDeadline(response, deadline);
    }, (error) => {
      deadline.release();
      throw error;
    });
  };

  const fetchRaw = async (url, extraHeaders) => {
    const repo = repositoryKey(url);
    const authenticated = state.authenticated && !state.tokenRejected.get(repo);
    const res = await attempt(url, authenticated, extraHeaders);
    if (authenticated && res.ok) {
      state.tokenAccepted.set(repo, true);
      return res;
    }
    // Un rate limit sulla richiesta autenticata è un limite reale, non un
    // rifiuto del token da ritentare anonimamente: altrimenti il 429 latcherebbe
    // `tokenRejected` e degraderebbe l'intero repo al rate limit anonimo.
    if (authenticated && isRateLimitResponse(res)) {
      discardResponseDeadline(res);
      throw new CrossRepoRateLimitError(url, res);
    }
    // Dopo un 2xx il token è accettato, quindi non si ritenta in anonimo:
    // un rate limit successivo resta però un limite reale, non un 404 da
    // consegnare al chiamante come se il contenuto mancasse.
    if (isRateLimitResponse(res) && state.tokenAccepted.get(repo)) {
      discardResponseDeadline(res);
      throw new CrossRepoRateLimitError(url, res);
    }
    if (!authenticated && isRateLimitResponse(res)) {
      discardResponseDeadline(res);
      throw new CrossRepoRateLimitError(url, res);
    }
    if (state.tokenAccepted.get(repo) || !needsAnonymousRetry(res.status, { authenticated })) return res;

    state.anonymousRetries += 1;
    discardResponseDeadline(res);
    const anon = await attempt(url, false, extraHeaders);
    if (isRateLimitResponse(anon)) {
      discardResponseDeadline(anon);
      throw new CrossRepoRateLimitError(url, anon);
    }
    // Solo un anonimo che RIESCE dimostra che a rispondere era il token: un
    // 404 confermato e' un'assenza vera, e continuare a mandare il token tiene
    // il rate-limit alto per tutte le altre voci.
    if (anon.ok) state.tokenRejected.set(repo, true);
    return anon;
  };

  fetchRaw.state = state;
  return fetchRaw;
}
