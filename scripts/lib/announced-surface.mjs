/**
 * announced-surface.mjs — contratto condiviso per leggere la superficie API
 * pubblicata come uno snapshot di release.
 *
 * `reconcile-article-shards.mjs` e `find-dirty-content-ids.mjs` leggono gli
 * stessi quattro documenti. Se uno dei due controlla solo counts mentre
 * l'altro controlla anche la release, una pubblicazione Pages non atomica può
 * portare i due detector a verdetti diversi. Qui vivono il marker di release
 * e il budget di lettura, così non possono divergere fra i gemelli.
 */

const SURFACE_FETCH_MAX_ATTEMPTS = 3;
const SURFACE_FETCH_TIMEOUT_MS = 30_000;
const SURFACE_FETCH_BACKOFF_MS = (attempt) => 2_000 * attempt;

export const ANNOUNCED_SURFACE_FILES = Object.freeze([
  'manifest.json',
  'slugs.json',
  'articles.json',
  'swiss-articles.json',
]);
export const ANNOUNCED_SURFACE_MAX_ATTEMPTS = 10;
export const ANNOUNCED_SURFACE_RETRY_DELAY_MS = 15_000;
export const ANNOUNCED_SURFACE_MAX_DURATION_MS = 180_000;
export const RELEASE_MARKER_CONTRACT_FIELD = 'releaseMarkerContractVersion';
export const RELEASE_MARKER_CONTRACT_VERSION = 1;

export class AnnouncedSurfaceDeadlineError extends Error {
  constructor() {
    super('budget wall-clock della superficie annunciata esaurito');
    this.name = 'AnnouncedSurfaceDeadlineError';
  }
}

export class AnnouncedSurfaceIncoherentError extends Error {
  constructor(surfaceErrors) {
    super(`superficie annunciata incoerente: ${surfaceErrors.join('; ')}`);
    this.name = 'AnnouncedSurfaceIncoherentError';
    this.surfaceErrors = surfaceErrors;
  }
}

/**
 * Valida il legame fra manifest e documenti della stessa release.
 *
 * Un manifest con `releaseMarkerContractVersion` attiva esplicitamente il
 * contratto dei marker. Un manifest senza quel campo resta leggibile come
 * superficie legacy; appena compare un marker laterale, però, il contratto
 * diventa completo e fail-closed. Il producer può usare `requireMarkers: true`
 * per verificare la propria emissione prima di pubblicare.
 */
export function validateReleaseMarkers(
  { manifest, slugs, articles, swissArticles } = {},
  { requireMarkers = false } = {},
) {
  const errors = [];
  const releaseCommit = manifest?.commit;
  if (typeof releaseCommit !== 'string' || releaseCommit.trim() === '') {
    errors.push('manifest.json senza commit di release verificabile');
    return errors;
  }

  const manifestDeclaresMarkerContract = Boolean(
    manifest && typeof manifest === 'object' &&
      Object.hasOwn(manifest, RELEASE_MARKER_CONTRACT_FIELD),
  );
  if (
    manifestDeclaresMarkerContract &&
    manifest[RELEASE_MARKER_CONTRACT_FIELD] !== RELEASE_MARKER_CONTRACT_VERSION
  ) {
    errors.push(
      `manifest.json dichiara ${RELEASE_MARKER_CONTRACT_FIELD} non supportato ` +
        `(${manifest[RELEASE_MARKER_CONTRACT_FIELD]})`,
    );
  }

  const markerContractActive = Boolean(
    requireMarkers ||
      manifestDeclaresMarkerContract ||
      (slugs && typeof slugs === 'object' && Object.hasOwn(slugs, 'commit')) ||
      [articles, swissArticles].some((registry) =>
        Array.isArray(registry) && registry.some(
          (article) => article && typeof article === 'object' && Object.hasOwn(article, 'commit'),
        ),
      ),
  );
  if (!markerContractActive) return errors;

  if (typeof slugs?.commit !== 'string' || slugs.commit.trim() === '') {
    errors.push('slugs.json senza commit di release verificabile');
  } else if (slugs.commit !== releaseCommit) {
    errors.push(
      `slugs.json appartiene al commit ${slugs.commit}, ma manifest.json annuncia ${releaseCommit}`,
    );
  }

  for (const [label, registry] of [
    ['articles.json', articles],
    ['swiss-articles.json', swissArticles],
  ]) {
    if (!Array.isArray(registry)) {
      errors.push(`${label} senza righe su cui verificare il commit di release`);
      continue;
    }
    const missingCommit = registry.filter(
      (article) => typeof article?.commit !== 'string' || article.commit.trim() === '',
    );
    if (missingCommit.length) {
      errors.push(`${label} senza commit di release verificabile su ${missingCommit.length} voci`);
    }
    const mismatched = registry
      .filter((article) => typeof article?.commit === 'string' && article.commit !== releaseCommit)
      .map((article) => article?.id)
      .filter((id) => id != null);
    if (mismatched.length) {
      errors.push(
        `${label} appartiene a un commit diverso da manifest.json ` +
          `(id: ${mismatched.slice(0, 5).join(', ')})`,
      );
    }
  }
  return errors;
}

function cacheBustedSurfaceUrl(apiBase, file, cacheBust) {
  const url = new URL(`${apiBase}/${file}`);
  url.searchParams.set('reconcile', cacheBust);
  return url.href;
}

async function fetchJson(url, { deadline = Number.POSITIVE_INFINITY, now = Date.now } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= SURFACE_FETCH_MAX_ATTEMPTS; attempt++) {
    const remaining = Number.isFinite(deadline) ? deadline - now() : Number.POSITIVE_INFINITY;
    if (remaining <= 0) {
      lastErr = new AnnouncedSurfaceDeadlineError();
      break;
    }
    const timeoutMs = Number.isFinite(remaining)
      ? Math.max(1, Math.min(SURFACE_FETCH_TIMEOUT_MS, Math.floor(remaining)))
      : SURFACE_FETCH_TIMEOUT_MS;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < SURFACE_FETCH_MAX_ATTEMPTS) {
        const remainingForBackoff = Number.isFinite(deadline)
          ? deadline - now()
          : Number.POSITIVE_INFINITY;
        if (remainingForBackoff <= 0) {
          lastErr = new AnnouncedSurfaceDeadlineError();
          break;
        }
        await new Promise((resolve) => setTimeout(
          resolve,
          Math.min(SURFACE_FETCH_BACKOFF_MS(attempt), remainingForBackoff),
        ));
      }
    }
  }
  throw new Error(`fetch di ${url} fallito dopo ${SURFACE_FETCH_MAX_ATTEMPTS} tentativi: ${lastErr}`);
}

/**
 * Legge tutti i documenti con lo stesso cache-bust e una deadline condivisa.
 * `validateSnapshot` è il gate specifico del chiamante; entrambi i reader lo
 * usano dopo aver raccolto l'intera osservazione, mai su dati parziali.
 */
export async function fetchAnnouncedSurfaceSnapshot(
  apiBase,
  {
    validateSnapshot,
    fetchJsonImpl = fetchJson,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    maxAttempts = ANNOUNCED_SURFACE_MAX_ATTEMPTS,
    retryDelayMs = ANNOUNCED_SURFACE_RETRY_DELAY_MS,
    maxDurationMs,
    surfaceBudgetMs,
    onRetry,
  } = {},
) {
  if (typeof validateSnapshot !== 'function') {
    throw new TypeError('fetchAnnouncedSurfaceSnapshot richiede validateSnapshot');
  }

  let lastFailure;
  let attemptsUsed = 0;
  const attempts = Number.isInteger(maxAttempts) && maxAttempts > 0
    ? maxAttempts
    : ANNOUNCED_SURFACE_MAX_ATTEMPTS;
  const configuredDuration = surfaceBudgetMs ?? maxDurationMs ?? ANNOUNCED_SURFACE_MAX_DURATION_MS;
  const duration = Number.isFinite(Number(configuredDuration)) && Number(configuredDuration) > 0
    ? Number(configuredDuration)
    : ANNOUNCED_SURFACE_MAX_DURATION_MS;
  const deadline = now() + duration;

  const readJson = (url) => {
    const remaining = deadline - now();
    if (remaining <= 0) return Promise.reject(new AnnouncedSurfaceDeadlineError());

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new AnnouncedSurfaceDeadlineError()),
        Math.max(1, Math.ceil(remaining)),
      );
    });
    const pending = Promise.resolve().then(() => fetchJsonImpl(url, { deadline, now }));
    return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
  };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    attemptsUsed = attempt;
    let retryContext;
    try {
      const cacheBust = `${now()}-${attempt}`;
      const manifest = await readJson(
        cacheBustedSurfaceUrl(apiBase, ANNOUNCED_SURFACE_FILES[0], cacheBust),
      );
      const [slugs, articles, swissArticles] = await Promise.all(
        ANNOUNCED_SURFACE_FILES.slice(1).map((file) => readJson(
          cacheBustedSurfaceUrl(apiBase, file, cacheBust),
        )),
      );
      const surface = { manifest, slugs, articles, swissArticles };
      const surfaceErrors = validateSnapshot(surface);
      if (surfaceErrors.length === 0) return surface;
      lastFailure = new AnnouncedSurfaceIncoherentError(surfaceErrors);
      retryContext = { errors: surfaceErrors };
    } catch (error) {
      lastFailure = error;
      retryContext = { error };
    }

    if (attempt >= attempts || deadline - now() <= 0) break;
    onRetry?.({ attempt, maxAttempts: attempts, ...retryContext });
    const remainingBeforeWait = deadline - now();
    if (remainingBeforeWait <= 0) break;
    await wait(Math.min(retryDelayMs, remainingBeforeWait));
  }

  if (lastFailure instanceof AnnouncedSurfaceIncoherentError) throw lastFailure;
  throw new Error(
    `lettura della superficie annunciata fallita dopo ${attemptsUsed} tentativi ` +
      `(budget ${duration}ms): ${lastFailure}`,
    { cause: lastFailure },
  );
}
