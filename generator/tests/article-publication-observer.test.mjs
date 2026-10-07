import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildObserverTargets,
  classifyPublicationLag,
  observePublicationLag,
  parseChangedBodyLog,
  parsePageObservation,
} from '../../scripts/ci/article-publication-observer.mjs';

const sha = 'a'.repeat(40);
const changedAt = Date.parse('2026-10-05T00:00:00Z');
const nowMs = Date.parse('2026-10-07T12:00:00Z');
const currentDate = '2026-10-06T00:00:00Z';
const staleDate = '2026-10-04T23:59:00Z';
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
    fetchImpl: async (url) => {
      requests.push(url);
      const html = responses[requests.length - 1];
      return { ok: true, status: 200, text: async () => html };
    },
  });
  assert.deepEqual(requests, targets.map((item) => item.url));
  assert.deepEqual(sleeps, [500, 500, 500]);
  assert.deepEqual(result.lagging.map((item) => item.target.articleId), ['two', 'four']);
  assert.deepEqual(result.degraded.map((item) => item.target.articleId), ['three', 'four']);
});
