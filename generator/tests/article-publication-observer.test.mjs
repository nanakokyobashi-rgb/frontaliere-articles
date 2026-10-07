import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OBSERVER_USER_AGENT,
  buildObserverTargets,
  formatObserverReport,
  pageHasCaughtUp,
  classifyPublicationLag,
  observePublicationLag,
  parseChangedBodyLog,
  parsePageObservation,
} from '../../scripts/ci/article-publication-observer.mjs';

const sha = 'a'.repeat(40);
const changedAt = Date.parse('2026-10-05T00:00:00Z');
const nowMs = Date.parse('2026-10-07T12:00:00Z');
const currentDate = '2026-10-06T00:00:00Z';
// Mezzogiorno del giorno prima: senza dubbio precedente al 2026-10-05 in ogni fuso.
const staleDate = '2026-10-04T12:00:00Z';
const ownImage = '/images/blog/article.webp';

function page(date, image = ownImage) {
  return `<meta property="og:image" content="https://frontaliereticino.ch${image}"><meta property="article:modified_time" content="${date}">`;
}

function target() {
  return {
    articleId: 'article',
    section: 'frontaliere',
    changedAt,
    sourceCommit: sha,
    sourceUpdatedAt: '2026-10-05',
    registryImage: ownImage,
  };
}

test('deriva un target per corpo cambiato e conserva il commit più recente', () => {
  const log = [
    `commit ${sha} 1791158400`,
    'content/blog-body-ch/it/costo-vita-svizzera-2026.ts',
    `commit ${'b'.repeat(40)} 1791072000`,
    'content/blog-body-ch/en/costo-vita-svizzera-2026.ts',
    'content/not-an-article.txt',
  ].join('\n');
  const changes = parseChangedBodyLog(log);
  assert.equal(changes.length, 1);
  const prepared = buildObserverTargets({
    changedBodies: changes,
    registrySources: {
      svizzera: "{ id: 'costo-vita-svizzera-2026', updatedAt: '2026-10-04', date: '2026-06-02', image: '/images/blog/costo.webp' },",
    },
    slugSources: { svizzera: "'costo-vita-svizzera-2026': { it: 'costo-vita-svizzera-2026' }," },
  });
  assert.equal(prepared.targets[0].url, 'https://frontaliereticino.ch/articoli-svizzera/costo-vita-svizzera-2026/');
  assert.equal(prepared.targets[0].sourceCommit, sha);
  assert.equal(prepared.targets[0].registryImage, '/images/blog/costo.webp');
});

test('le quattro intersezioni ritardo × degrado hanno verdetti indipendenti', () => {
  const cases = [
    { date: currentDate, image: ownImage, lagging: false, degraded: false },
    { date: staleDate, image: ownImage, lagging: true, degraded: false },
    { date: currentDate, image: '/og-image.png', lagging: false, degraded: true },
    { date: staleDate, image: '/og-image.png', lagging: true, degraded: true },
  ];
  for (const item of cases) {
    const verdict = classifyPublicationLag({ target: target(), page: parsePageObservation(page(item.date, item.image)), nowMs });
    assert.equal(verdict.lagging, item.lagging, JSON.stringify(item));
    assert.equal(verdict.degraded, item.degraded, JSON.stringify(item));
  }
});

test('og:image dichiarata generica non apre il segnale degrado', () => {
  const verdict = classifyPublicationLag({
    target: { ...target(), registryImage: '/og-image.png' },
    page: parsePageObservation(page(currentDate, '/og-image.png')),
    nowMs,
  });
  assert.equal(verdict.lagging, false);
  assert.equal(verdict.degraded, false);
});

test('usa fake HTTP sequenziale e restituisce due liste stabili', async () => {
  const requests = [];
  const userAgents = [];
  const sleeps = [];
  const targets = ['one', 'two', 'three', 'four'].map((articleId) => ({ ...target(), articleId, url: `https://example.test/${articleId}/` }));
  const responses = [
    page(currentDate, ownImage),
    page(staleDate, ownImage),
    page(currentDate, '/og-image.png'),
    page(staleDate, '/og-image.png'),
  ];
  const result = await observePublicationLag({
    targets,
    nowMs,
    minIntervalMs: 500,
    clock: () => 0,
    sleepImpl: async (ms) => sleeps.push(ms),
    fetchImpl: async (url, options) => {
      requests.push(url);
      userAgents.push(options?.headers?.['user-agent']);
      const html = responses[requests.length - 1];
      return { ok: true, status: 200, text: async () => html };
    },
  });
  assert.deepEqual(requests, targets.map((item) => item.url));
  // La produzione risponde 403 allo User-Agent predefinito di Node: senza un
  // nome proprio ogni pagina risulterebbe in ritardo con «HTTP 403».
  assert.deepEqual(userAgents, targets.map(() => OBSERVER_USER_AGENT));
  assert.match(OBSERVER_USER_AGENT, /^frontaliere-publication-observer\//);
  assert.deepEqual(sleeps, [500, 500, 500]);
  assert.deepEqual(result.lagging.map((item) => item.target.articleId), ['two', 'four']);
  assert.deepEqual(result.degraded.map((item) => item.target.articleId), ['three', 'four']);
});

// I casi che seguono vengono dalla prima lettura dal vivo (2026-10-07): con le
// pagine vere l'osservatore riportava in ritardo 400 pagine su 400.

test('una voce senza updatedAt si confronta con la data di pubblicazione, non risulta in ritardo', () => {
  // Registro e pagina reali di `a2-rumore-galbisio`: nessun updatedAt, e il
  // renderer scrive i secondi interi (10.833 → 11).
  const registryOnlyDate = { ...target(), sourceUpdatedAt: null, registryDate: '2026-10-05T03:49:10.833Z' };
  const realPage = parsePageObservation(
    '<meta property="og:image" content="https://cdn.frontaliereticino.ch/images/blog/article.webp">'
      + '<meta property="article:modified_time" content="2026-10-05T03:49:11+00:00">',
  );
  const verdict = classifyPublicationLag({ target: registryOnlyDate, page: realPage, nowMs });
  assert.equal(verdict.lagging, false);
  assert.equal(verdict.reason, 'dateModified current');

  const behind = classifyPublicationLag({
    target: { ...registryOnlyDate, registryDate: '2026-10-06T08:00:00.000Z' },
    page: realPage,
    nowMs,
  });
  assert.equal(behind.lagging, true);
  assert.match(behind.reason, /< date 2026-10-06T08:00:00\.000Z/);
});

test('senza alcuna data nel registro il confronto si salta; senza data nella pagina è un ritardo', () => {
  const undated = { ...target(), sourceUpdatedAt: null, registryDate: null };
  const skipped = classifyPublicationLag({ target: undated, page: parsePageObservation(page(currentDate)), nowMs });
  assert.equal(skipped.lagging, false);
  assert.match(skipped.reason, /confronto saltato/);

  const noPageDate = classifyPublicationLag({
    target: target(),
    page: parsePageObservation('<meta property="og:image" content="https://frontaliereticino.ch/images/blog/article.webp">'),
    nowMs,
  });
  assert.equal(noPageDate.lagging, true);
  assert.equal(noPageDate.reason, 'pagina senza dateModified');
});

test('una data senza ora nel registro è la mezzanotte locale che il renderer scrive', () => {
  // Misurato: updatedAt 2026-09-25 → dateModified 2026-09-25T00:00:00+01:00.
  assert.equal(pageHasCaughtUp('2026-09-25T00:00:00+01:00', '2026-09-25'), true);
  assert.equal(pageHasCaughtUp('2026-09-25T00:00:00+02:00', '2026-09-25'), false);
  assert.equal(pageHasCaughtUp('2026-09-24T12:00:00+02:00', '2026-09-25'), false);
  assert.equal(pageHasCaughtUp('2026-09-26T09:00:00Z', '2026-09-25'), true);
  // Timestamp completi: la pagina porta i secondi interi del registro.
  assert.equal(pageHasCaughtUp('2026-10-05T03:49:10+00:00', '2026-10-05T03:49:10.833Z'), true);
  assert.equal(pageHasCaughtUp('2026-10-05T03:49:09+00:00', '2026-10-05T03:49:10.833Z'), false);
  // Ciò che non si può confrontare non è né vero né falso.
  assert.equal(pageHasCaughtUp('non una data', '2026-09-25'), null);
  assert.equal(pageHasCaughtUp('2026-09-25T00:00:00Z', null), null);
});

test('il tetto di pagine taglia i cambi più vecchi, non la fine dell’alfabeto, e dice quanti ne restano', async () => {
  const log = [
    `commit ${'c'.repeat(40)} 1791300000`,
    'content/blog-body/it/zeta-recente.ts',
    `commit ${'d'.repeat(40)} 1791200000`,
    'content/blog-body/it/alfa-vecchio.ts',
    'content/blog-body/it/beta-vecchio.ts',
  ].join('\n');
  const changes = parseChangedBodyLog(log);
  assert.deepEqual(changes.map((item) => item.articleId), ['zeta-recente', 'alfa-vecchio', 'beta-vecchio']);

  const targets = changes.map((item) => ({ ...target(), ...item, url: `https://example.test/${item.articleId}/` }));
  const read = [];
  const result = await observePublicationLag({
    targets,
    nowMs,
    maxPages: 1,
    minIntervalMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      read.push(url);
      return { ok: true, status: 200, text: async () => page(currentDate) };
    },
  });
  assert.deepEqual(read, ['https://example.test/zeta-recente/']);
  assert.equal(result.capped, true);
  assert.equal(result.unread, 2);
  assert.match(formatObserverReport(result, { nowMs }), /2 più vecchie nella finestra non sono state lette/);
});
