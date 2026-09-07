/**
 * Il token di QUESTO repo non decide se un file esiste su un ALTRO repo.
 *
 * Il difetto (issue #982): gli osservatori del ciclo mandavano `GH_TOKEN` /
 * `GITHUB_PAT` come `Bearer` a `raw.githubusercontent.com` per
 * `valerielinc-ops/frontaliere-si-o-no`, che e' di un altro owner. Nessuno
 * aveva verificato cosa risponde raw a una credenziale valida ma non
 * autorizzata, e le due risposte plausibili sono entrambe rovinose: un 401
 * fa lanciare il chiamante (49 voci `unobserved`, schedule rosso per un
 * difetto del client), un 404 non lancia affatto e traveste il mancato accesso
 * da `absent` — cioe' da «il sito ha rimosso quel file».
 *
 * Il repo del sito e' pubblico: e' la richiesta ANONIMA a dire la verita'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRawFetcher,
  needsAnonymousRetry,
  TOKEN_SUSPECT_STATUSES,
} from '../../scripts/lib/cross-repo-raw-fetch.mjs';

/** Un finto `fetch` che registra ogni chiamata e risponde da una tabella. */
function fakeFetch(plan) {
  const calls = [];
  const impl = async (url, init) => {
    const authenticated = Boolean(init?.headers?.Authorization);
    calls.push({ url, authenticated, headers: init?.headers || {} });
    const next = plan.shift();
    assert.ok(next, `fetch non pianificato: ${url} (auth=${authenticated})`);
    return { status: next.status, ok: next.status >= 200 && next.status < 300, body: next.body };
  };
  return { impl, calls };
}

test('401 sulla richiesta autenticata: risponde la lettura anonima', async () => {
  const { impl, calls } = fakeFetch([{ status: 401 }, { status: 200, body: 'ok' }]);
  const fetchRaw = createRawFetcher({ userAgent: 'ua', token: 'tok', fetchImpl: impl });

  const res = await fetchRaw('https://raw.githubusercontent.com/other/repo/main/a.yml');

  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authenticated, true);
  assert.equal(calls[1].authenticated, false);
  assert.equal(fetchRaw.state.tokenRejected, true);
});

test('403 e 404 autenticati sono ugualmente sospetti: il 404 mascherava un `absent` falso', () => {
  for (const status of [401, 403, 404]) {
    assert.equal(needsAnonymousRetry(status, { authenticated: true }), true, String(status));
    assert.ok(TOKEN_SUSPECT_STATUSES.has(status));
  }
  // Senza token non c'e' niente da ritentare: la risposta e' gia' quella
  // autorevole, e un secondo fetch brucerebbe rate-limit per nulla.
  for (const status of [401, 403, 404]) {
    assert.equal(needsAnonymousRetry(status, { authenticated: false }), false, String(status));
  }
  // Un 500 non e' un problema di credenziali: ritentarlo in anonimo non lo
  // rende ne' piu' vero ne' piu' falso.
  assert.equal(needsAnonymousRetry(500, { authenticated: true }), false);
});

test('un 404 confermato anche in anonimo resta un\'assenza vera, e il token resta in uso', async () => {
  const { impl, calls } = fakeFetch([
    { status: 404 },
    { status: 404 },
    { status: 200, body: 'ok' },
  ]);
  const fetchRaw = createRawFetcher({ userAgent: 'ua', token: 'tok', fetchImpl: impl });

  const missing = await fetchRaw('https://raw.githubusercontent.com/other/repo/main/gone.yml');
  assert.equal(missing.status, 404);
  assert.equal(fetchRaw.state.tokenRejected, false);

  const next = await fetchRaw('https://raw.githubusercontent.com/other/repo/main/there.yml');
  assert.equal(next.status, 200);
  assert.equal(calls[2].authenticated, true, 'un\'assenza vera non squalifica il token');
});

test('il verdetto sul token e` appiccicoso: la doppia richiesta si paga una volta sola', async () => {
  // La ragione per cui non basta ritentare ogni volta: 49 voci diventerebbero
  // ~98 richieste contro i 60/ora anonimi per IP, condivisi fra tutti i runner.
  const { impl, calls } = fakeFetch([
    { status: 404 },
    { status: 200 },
    { status: 200 },
    { status: 200 },
  ]);
  const fetchRaw = createRawFetcher({ userAgent: 'ua', token: 'tok', fetchImpl: impl });

  await fetchRaw('https://x/1');
  await fetchRaw('https://x/2');
  await fetchRaw('https://x/3');

  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => c.authenticated), [true, false, false, false]);
  assert.equal(fetchRaw.state.anonymousRetries, 1);
});

test('senza token si parte anonimi e non si ritenta mai', async () => {
  const { impl, calls } = fakeFetch([{ status: 404 }]);
  const fetchRaw = createRawFetcher({ userAgent: 'ua', fetchImpl: impl });

  const res = await fetchRaw('https://x/1');

  assert.equal(res.status, 404);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authenticated, false);
  assert.equal(calls[0].headers['User-Agent'], 'ua');
  assert.equal(fetchRaw.state.authenticated, false);
});

test('i due chiamanti cross-repo passano dal fetcher, non da `fetch` nudo', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
  for (const rel of [
    'scripts/ci/verify-crawler-contract-provenance.mjs',
    'scripts/refresh-hub-landing.mjs',
  ]) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.match(src, /createRawFetcher/, `${rel} non usa il fetcher condiviso`);
    // L'antipattern esatto: `Authorization` costruito a mano accanto a un URL
    // di raw.githubusercontent. Se ricompare, ricompare anche il bug.
    assert.doesNotMatch(
      src,
      /headers\.Authorization\s*=/,
      `${rel} rimette l'Authorization a mano su una lettura cross-repo`,
    );
  }
});
