import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OBSERVER_USER_AGENT,
  buildObserverTargets,
  formatObserverReport,
  pageHasCaughtUp,
  classifyPublicationLag,
  observePublicationLag,
  parseChangedBodyLog,
  parsePageObservation,
  runObserver,
} from '../../scripts/ci/article-publication-observer.mjs';
import { renderDegradationLedger } from '../../scripts/lib/article-image-degradation-ledger.mjs';

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

test('ordina il ledger durevole dopo i cambi recenti e non include exhausted', () => {
  const prepared = buildObserverTargets({
    changedBodies: [{ section: 'frontaliere', articleId: 'recent', changedAt: Date.parse('2026-10-07T00:00:00Z'), commit: sha }],
    ledgerItems: [
      { section: 'frontaliere', articleId: 'old', firstSeenAt: '2026-09-01T00:00:00Z', status: 'pending' },
      { section: 'frontaliere', articleId: 'dead', firstSeenAt: '2026-09-02T00:00:00Z', status: 'exhausted' },
    ],
    registrySources: {
      frontaliere: [
        "{ id: 'recent', date: '2026-10-07', image: '/images/blog/recent.webp' },",
        "{ id: 'old', date: '2026-09-01', image: '/images/blog/old.webp' },",
      ].join('\n'),
    },
    slugSources: {
      frontaliere: "'recent': { it: 'recent' }, 'old': { it: 'old' },",
    },
  });
  assert.deepEqual(prepared.targets.map((entry) => entry.articleId), ['recent', 'old']);
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

function observerRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'article-publication-observer-run-'));
  const sources = {
    'content/blog-articles-data.ts': [
      "{ id: 'alpha', date: '2026-09-01', image: '/images/blog/alpha.webp' },",
      "{ id: 'zeta', date: '2026-09-01', image: '/images/blog/zeta.webp' },",
      "{ id: 'missing-image', date: '2026-09-01', image: '/images/blog/missing-image.webp' },",
    ].join('\n'),
    'content/swiss-articles-data.ts': '',
    'content/routerBlogData.ts': [
      "'alpha': { it: 'alpha' },",
      "'zeta': { it: 'zeta' },",
      "'missing-image': { it: 'missing-image' },",
    ].join('\n'),
    'content/routerSwissData.ts': '',
  };
  for (const [rel, source] of Object.entries(sources)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
  }
  return root;
}

function issueClient({ issue = null, dispatchResult = { runId: 'run-1' } } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      findOpenIssue: async () => issue,
      createIssue: async (description) => {
        issue = { number: 9001, body: description };
        calls.push({ type: 'create', description });
        return issue;
      },
      editIssue: async (number, body) => {
        issue = { ...issue, number, body };
        calls.push({ type: 'edit', number, body });
      },
      dispatch: async (args) => {
        calls.push({ type: 'dispatch', args });
        return dispatchResult;
      },
      resolveIssue: async () => {
        calls.push({ type: 'resolve' });
        return issue;
      },
    },
  };
}

function genericPage() {
  return '<meta property="og:image" content="https://frontaliereticino.ch/og-image.png"><meta property="article:modified_time" content="2026-09-02T00:00:00Z">';
}

function ownPage(image = ownImage) {
  return `<meta property="og:image" content="https://frontaliereticino.ch${image}"><meta property="article:modified_time" content="2026-09-02T00:00:00Z">`;
}

test('il ledger sopravvive alla finestra, viene letto per primo e il cap produce un solo dispatch', async () => {
  const rootDir = observerRoot();
  const oldItems = [
    {
      section: 'frontaliere', articleId: 'zeta', url: 'https://frontaliereticino.ch/zeta/',
      registryImage: '/images/blog/zeta.webp', firstSeenAt: '2026-08-01T00:00:00.000Z',
    },
    {
      section: 'frontaliere', articleId: 'alpha', url: 'https://frontaliereticino.ch/alpha/',
      registryImage: '/images/blog/alpha.webp', firstSeenAt: '2026-08-01T00:00:00.000Z',
    },
  ];
  const github = issueClient({ issue: { number: 2448, body: renderDegradationLedger(oldItems) } });
  const read = [];
  const proven = [];
  try {
    const result = await runObserver({
      rootDir,
      days: 1,
      nowMs: Date.parse('2026-10-08T00:00:00Z'),
      gitLogImpl: () => '',
      githubClient: github.client,
      repairCap: 1,
      fetchImpl: async (url) => {
        read.push(url);
        return { ok: true, status: 200, text: async () => genericPage() };
      },
      fetchDeclaredImageImpl: async ({ imagePath }) => {
        proven.push(imagePath);
        return { bytes: 5, contentType: 'image/webp' };
      },
    });
    assert.deepEqual(read.map((url) => url.split('/').at(-2)), ['alpha', 'zeta']);
    assert.deepEqual(proven, ['/images/blog/alpha.webp', '/images/blog/zeta.webp']);
    assert.deepEqual(result.dispatched, [{ section: 'frontaliere', ids: ['alpha'], runId: 'run-1' }]);
    assert.deepEqual(result.ledger.map((item) => [item.articleId, item.status]), [['alpha', 'in-flight'], ['zeta', 'pending']]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('un dispatch senza run id lascia il candidato pending e quindi riconciliabile per retry', async () => {
  const rootDir = observerRoot();
  const github = issueClient({
    issue: {
      number: 2448,
      body: renderDegradationLedger([{
        section: 'frontaliere', articleId: 'alpha', url: 'https://frontaliereticino.ch/alpha/',
        registryImage: '/images/blog/alpha.webp', firstSeenAt: '2026-08-01T00:00:00.000Z',
      }]),
    },
    dispatchResult: { runId: null },
  });
  try {
    const result = await runObserver({
      rootDir,
      days: 1,
      nowMs: Date.parse('2026-10-08T00:00:00Z'),
      gitLogImpl: () => '',
      githubClient: github.client,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => genericPage() }),
      fetchDeclaredImageImpl: async () => ({ bytes: 5, contentType: 'image/webp' }),
    });
    assert.deepEqual(result.dispatched, [{ section: 'frontaliere', ids: ['alpha'], runId: null }]);
    assert.deepEqual(result.ledger.map((item) => [item.articleId, item.status, item.runId]), [['alpha', 'pending', null]]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('immagine ancora assente: il degrado entra nel ledger ma non parte alcun dispatch', async () => {
  const rootDir = observerRoot();
  const github = issueClient();
  const log = `commit ${'e'.repeat(40)} 1791417600\ncontent/blog-body/it/missing-image.ts\n`;
  try {
    const result = await runObserver({
      rootDir,
      nowMs: Date.parse('2026-10-08T00:00:00Z'),
      gitLogImpl: () => log,
      githubClient: github.client,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => genericPage() }),
      fetchDeclaredImageImpl: async () => { throw new Error('HTTP 404'); },
    });
    assert.equal(result.dispatched.length, 0);
    assert.deepEqual(result.ledger.map((item) => [item.articleId, item.status]), [['missing-image', 'pending']]);
    assert.ok(github.calls.some((call) => call.type === 'create'));
    assert.ok(github.calls.some((call) => call.type === 'edit' && call.body.includes('ARTICLE_IMAGE_DEGRADATION_LEDGER')));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('una lettura sana rimuove il degradato durevole e risolve l issue senza dispatch', async () => {
  const rootDir = observerRoot();
  const github = issueClient({
    issue: {
      number: 2448,
      body: renderDegradationLedger([{
        section: 'frontaliere', articleId: 'alpha', url: 'https://frontaliereticino.ch/alpha/',
        registryImage: '/images/blog/alpha.webp', firstSeenAt: '2026-08-01T00:00:00.000Z',
      }]),
    },
  });
  try {
    const result = await runObserver({
      rootDir,
      days: 1,
      nowMs: Date.parse('2026-10-08T00:00:00Z'),
      gitLogImpl: () => '',
      githubClient: github.client,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => ownPage('/images/blog/alpha.webp') }),
    });
    assert.deepEqual(result.ledger, []);
    assert.deepEqual(result.dispatched, []);
    assert.ok(github.calls.some((call) => call.type === 'resolve'));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('una og:image propria ma diversa dal registro non rimuove il degradato', async () => {
  const rootDir = observerRoot();
  const github = issueClient({
    issue: {
      number: 2448,
      body: renderDegradationLedger([{
        section: 'frontaliere', articleId: 'alpha', url: 'https://frontaliereticino.ch/alpha/',
        registryImage: '/images/blog/alpha.webp', firstSeenAt: '2026-10-01T00:00:00.000Z',
      }]),
    },
  });
  try {
    const result = await runObserver({
      rootDir,
      days: 1,
      nowMs: Date.parse('2026-10-08T00:00:00Z'),
      gitLogImpl: () => '',
      githubClient: github.client,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => ownPage('/images/blog/old-alpha.webp'),
      }),
    });
    assert.deepEqual(result.ledger.map((item) => item.articleId), ['alpha']);
    assert.equal(github.calls.some((call) => call.type === 'resolve'), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
