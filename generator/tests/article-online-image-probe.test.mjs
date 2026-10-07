import test from 'node:test';
import assert from 'node:assert/strict';
import { filterEntriesByImagePostcondition } from '../../scripts/lib/article-image-postcondition.mjs';
import {
  ONLINE_IMAGE,
  classifyOnlinePage,
  heldArticlesWithoutOnlinePage,
  probeOnlineImage,
  releaseArticlesWithNothingToProtect,
} from '../../scripts/lib/article-online-image-probe.mjs';

const URL_IT = 'https://frontaliereticino.ch/articoli-frontaliere/nuova-regola/';
const OWN = '<meta property="og:image" content="https://frontaliereticino.ch/images/blog/nuova-regola.webp">';
const GENERIC = '<meta property="og:image" content="https://frontaliereticino.ch/og-image.png">';
// La pagina 404 di produzione, letta il 07-10-2026: HTML con og:url della home.
const NOT_FOUND_SHELL = `<meta property="og:url" content="https://frontaliereticino.ch/">${GENERIC}`;

function articlePage(image, { url = URL_IT, identity = 'og:url' } = {}) {
  const own = identity === 'canonical'
    ? `<link rel="canonical" href="${url}">`
    : `<meta property="og:url" content="${url}">`;
  return `<html><head>${own}${image}</head></html>`;
}

function response(status, html = '') {
  return { status, text: async () => html };
}

/** Un fetch finto che risponde in sequenza e ricorda le richieste. */
function scriptedFetch(answers) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetchImpl, calls };
}

const noSleep = async () => {};

test('una risposta 404 o 410 è una pagina assente; ogni altro stato diverso da 200 non è leggibile', () => {
  assert.equal(classifyOnlinePage({ status: 404, url: URL_IT }).state, ONLINE_IMAGE.ABSENT);
  assert.equal(classifyOnlinePage({ status: 410, url: URL_IT }).state, ONLINE_IMAGE.ABSENT);
  for (const status of [0, 301, 302, 403, 429, 500, 503]) {
    assert.equal(classifyOnlinePage({ status, url: URL_IT }).state, ONLINE_IMAGE.UNKNOWN, `HTTP ${status}`);
  }
});

test('la pagina dell’articolo si riconosce da og:url o dal canonical, con o senza barra finale', () => {
  assert.equal(classifyOnlinePage({ status: 200, html: articlePage(OWN), url: URL_IT }).state, ONLINE_IMAGE.OWN);
  assert.equal(
    classifyOnlinePage({ status: 200, html: articlePage(GENERIC, { identity: 'canonical' }), url: URL_IT }).state,
    ONLINE_IMAGE.GENERIC,
  );
  assert.equal(
    classifyOnlinePage({ status: 200, html: articlePage(OWN, { url: URL_IT.replace(/\/$/, '') }), url: URL_IT }).state,
    ONLINE_IMAGE.OWN,
  );
  assert.equal(
    classifyOnlinePage({ status: 200, html: articlePage(OWN, { url: '/articoli-frontaliere/nuova-regola/' }), url: URL_IT }).state,
    ONLINE_IMAGE.OWN,
  );
});

test('un 200 che non è la pagina richiesta non prova nulla: shell del 404, altra pagina, pagina senza og:image', () => {
  assert.equal(classifyOnlinePage({ status: 200, html: NOT_FOUND_SHELL, url: URL_IT }).state, ONLINE_IMAGE.UNKNOWN);
  assert.equal(
    classifyOnlinePage({
      status: 200,
      html: articlePage(OWN, { url: 'https://frontaliereticino.ch/articoli-frontaliere/un-altro/' }),
      url: URL_IT,
    }).state,
    ONLINE_IMAGE.UNKNOWN,
  );
  assert.equal(classifyOnlinePage({ status: 200, html: '<html>verifica in corso</html>', url: URL_IT }).state, ONLINE_IMAGE.UNKNOWN);
  assert.equal(classifyOnlinePage({ status: 200, html: articlePage(''), url: URL_IT }).state, ONLINE_IMAGE.UNKNOWN);
});

test('assente vale solo se letto due volte, con una chiave anti-cache diversa a ogni richiesta', async () => {
  const { fetchImpl, calls } = scriptedFetch([response(404), response(404)]);
  const result = await probeOnlineImage(URL_IT, { fetchImpl, sleep: noSleep });
  assert.equal(result.state, ONLINE_IMAGE.ABSENT);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url.origin + call.url.pathname, URL_IT);
    assert.equal(call.options.redirect, 'manual');
    assert.equal(call.options.headers['cache-control'], 'no-cache');
    // La produzione risponde 403 allo User-Agent predefinito di Node.
    assert.match(call.options.headers['user-agent'], /^frontaliere-corpus-publisher\//);
    assert.ok(call.url.searchParams.get('_fpcb'));
  }
  assert.notEqual(calls[0].url.searchParams.get('_fpcb'), calls[1].url.searchParams.get('_fpcb'));
});

test('un solo 404 non fa uscire un articolo: la seconda lettura trova la pagina con immagine propria', async () => {
  const { fetchImpl, calls } = scriptedFetch([response(404), response(200, articlePage(OWN))]);
  const result = await probeOnlineImage(URL_IT, { fetchImpl, sleep: noSleep });
  assert.equal(result.state, ONLINE_IMAGE.OWN);
  assert.equal(calls.length, 2);
});

test('una pagina con immagine propria o generica è una risposta definitiva alla prima lettura', async () => {
  const own = scriptedFetch([response(200, articlePage(OWN))]);
  assert.equal((await probeOnlineImage(URL_IT, { fetchImpl: own.fetchImpl, sleep: noSleep })).state, ONLINE_IMAGE.OWN);
  assert.equal(own.calls.length, 1);
  const generic = scriptedFetch([response(200, articlePage(GENERIC))]);
  assert.equal((await probeOnlineImage(URL_IT, { fetchImpl: generic.fetchImpl, sleep: noSleep })).state, ONLINE_IMAGE.GENERIC);
  assert.equal(generic.calls.length, 1);
});

test('una lettura fallita non è una prova: errore di rete, 5xx e 404 non confermato restano sconosciuti', async () => {
  const network = scriptedFetch([new Error('ECONNRESET')]);
  const failed = await probeOnlineImage(URL_IT, { fetchImpl: network.fetchImpl, sleep: noSleep });
  assert.equal(failed.state, ONLINE_IMAGE.UNKNOWN);
  assert.match(failed.reason, /ECONNRESET/);
  assert.equal(network.calls.length, 3);

  const server = scriptedFetch([response(503)]);
  assert.equal((await probeOnlineImage(URL_IT, { fetchImpl: server.fetchImpl, sleep: noSleep })).state, ONLINE_IMAGE.UNKNOWN);

  const late = scriptedFetch([response(503), new Error('timeout'), response(404)]);
  const unconfirmed = await probeOnlineImage(URL_IT, { fetchImpl: late.fetchImpl, sleep: noSleep });
  assert.equal(unconfirmed.state, ONLINE_IMAGE.UNKNOWN);
  assert.match(unconfirmed.reason, /non confermato/);

  const shell = scriptedFetch([response(200, NOT_FOUND_SHELL)]);
  assert.equal((await probeOnlineImage(URL_IT, { fetchImpl: shell.fetchImpl, sleep: noSleep })).state, ONLINE_IMAGE.UNKNOWN);
});

test('un URL che non è https non viene richiesto', async () => {
  const { fetchImpl, calls } = scriptedFetch([response(404)]);
  assert.equal((await probeOnlineImage('http://frontaliereticino.ch/x/', { fetchImpl, sleep: noSleep })).state, ONLINE_IMAGE.UNKNOWN);
  assert.equal((await probeOnlineImage('non un url', { fetchImpl, sleep: noSleep })).state, ONLINE_IMAGE.UNKNOWN);
  assert.equal(calls.length, 0);
});

function entry(articleId, locales = ['it', 'de']) {
  const paths = {};
  const flatPaths = {};
  const urls = {};
  for (const locale of locales) {
    const prefix = locale === 'it' ? '' : `${locale}/`;
    paths[locale] = `${prefix}articoli/${articleId}/index.html`;
    flatPaths[locale] = `${prefix}articoli/${articleId}.html`;
    urls[locale] = `https://frontaliereticino.ch/${prefix}articoli/${articleId}/`;
  }
  return { articleId, paths, flatPaths, urls };
}

/** Il risultato della post-condizione per voci in cui `fallen` ricade sul generico. */
function postconditionFor(entries, fallen) {
  const declaredImages = {};
  const htmlByPath = {};
  for (const item of entries) {
    declaredImages[item.articleId] = `/images/blog/${item.articleId}.webp`;
    const image = fallen.includes(item.articleId) ? GENERIC : OWN;
    for (const rel of [...Object.values(item.paths), ...Object.values(item.flatPaths)]) htmlByPath[rel] = image;
  }
  return filterEntriesByImagePostcondition({ entries, declaredImages, htmlByPath });
}

function probeFrom(states) {
  const asked = [];
  const probe = async (url) => {
    asked.push(url);
    const state = states[url] ?? ONLINE_IMAGE.ABSENT;
    return { state, reason: `finto: ${state}` };
  };
  return { probe, asked };
}

test('un articolo senza pagine online esce con l’immagine generica e resta nell’ordine del rendering', async () => {
  const entries = [entry('sano-uno'), entry('nuovo'), entry('sano-due')];
  const postcondition = postconditionFor(entries, ['nuovo']);
  assert.deepEqual(postcondition.entries.map((item) => item.articleId), ['sano-uno', 'sano-due']);

  const { probe, asked } = probeFrom({});
  const result = await releaseArticlesWithNothingToProtect({ entries, postcondition, probe });
  assert.deepEqual(result.entries.map((item) => item.articleId), ['sano-uno', 'nuovo', 'sano-due']);
  assert.deepEqual(result.excludedArticles, []);
  assert.equal(result.excludedPages, 0);
  assert.deepEqual(result.releasedArticles.map((item) => item.articleId), ['nuovo']);
  assert.deepEqual(result.releasedArticles[0].online.map((page) => [page.locale, page.state]), [
    ['it', ONLINE_IMAGE.ABSENT],
    ['de', ONLINE_IMAGE.ABSENT],
  ]);
  assert.deepEqual(asked, [entries[1].urls.it, entries[1].urls.de]);
});

test('una sola lingua online con immagine propria trattiene tutto l’articolo', async () => {
  const entries = [entry('gia-online'), entry('sano')];
  const postcondition = postconditionFor(entries, ['gia-online']);
  const { probe } = probeFrom({ [entries[0].urls.de]: ONLINE_IMAGE.OWN });
  const result = await releaseArticlesWithNothingToProtect({ entries, postcondition, probe });
  assert.deepEqual(result.entries.map((item) => item.articleId), ['sano']);
  assert.deepEqual(result.firstExcludedArticleIds, ['gia-online']);
  assert.equal(result.excludedPages, 4);
  assert.deepEqual(result.releasedArticles, []);
  assert.equal(result.excludedArticles[0].online.find((page) => page.locale === 'de').state, ONLINE_IMAGE.OWN);
});

test('una lettura non conclusiva trattiene; una pagina già generica non ha nulla da perdere', async () => {
  const entries = [entry('illeggibile'), entry('gia-generica'), entry('senza-url')];
  entries[2].urls = {};
  const postcondition = postconditionFor(entries, ['illeggibile', 'gia-generica', 'senza-url']);
  const { probe } = probeFrom({
    [entries[0].urls.it]: ONLINE_IMAGE.UNKNOWN,
    [entries[1].urls.it]: ONLINE_IMAGE.GENERIC,
    [entries[1].urls.de]: ONLINE_IMAGE.ABSENT,
  });
  const result = await releaseArticlesWithNothingToProtect({ entries, postcondition, probe });
  assert.deepEqual(result.entries.map((item) => item.articleId), ['gia-generica']);
  assert.deepEqual(result.excludedArticles.map((item) => item.articleId), ['illeggibile', 'senza-url']);
  assert.deepEqual(result.releasedArticles.map((item) => item.articleId), ['gia-generica']);
  assert.deepEqual(result.firstFallbackPaths.slice(0, 2), [entries[0].paths.it, entries[0].paths.de]);
});

test('senza articoli esclusi non parte nessuna lettura e il risultato è quello della post-condizione', async () => {
  const entries = [entry('sano-uno'), entry('sano-due')];
  const postcondition = postconditionFor(entries, []);
  const { probe, asked } = probeFrom({});
  const result = await releaseArticlesWithNothingToProtect({ entries, postcondition, probe });
  assert.deepEqual(asked, []);
  assert.deepEqual(result.entries, postcondition.entries);
  assert.deepEqual(result.releasedArticles, []);
});

test('un articolo trattenuto con la pagina online non ferma gli archivi', () => {
  // Review della PR: l'archivio elenca anche l'articolo trattenuto. Il link è
  // sbagliato solo dove la pagina non esiste, non ogni volta che un'immagine
  // manca: il 07-10-2026 un rirendering completo tratteneva 7 articoli, tutti
  // con la pagina online.
  const page = (state, locale = 'it') => ({ locale, url: `https://frontaliereticino.ch/${locale}/x/`, state });
  const held = (articleId, ...online) => ({ articleId, online });

  const allOnline = held('online-ovunque', page(ONLINE_IMAGE.OWN, 'it'), page(ONLINE_IMAGE.OWN, 'en'), page(ONLINE_IMAGE.GENERIC, 'de'));
  const oneAbsent = held('una-lingua-assente', page(ONLINE_IMAGE.OWN, 'it'), page(ONLINE_IMAGE.ABSENT, 'fr'));
  const oneUnread = held('una-lettura-fallita', page(ONLINE_IMAGE.OWN, 'it'), page(ONLINE_IMAGE.UNKNOWN, 'en'));
  const noUrls = held('senza-url');
  const notProbed = { articleId: 'mai-letto' };

  assert.deepEqual(heldArticlesWithoutOnlinePage([]), []);
  assert.deepEqual(heldArticlesWithoutOnlinePage([allOnline]), []);
  assert.deepEqual(
    heldArticlesWithoutOnlinePage([allOnline, oneAbsent, oneUnread, noUrls, notProbed]).map((article) => article.articleId),
    ['una-lingua-assente', 'una-lettura-fallita', 'senza-url', 'mai-letto'],
  );
});
