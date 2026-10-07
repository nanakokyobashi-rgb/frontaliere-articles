import { describe, test } from 'node:test';
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

describe('article publication observer', () => {
  test('derives one target per changed article body and keeps the latest commit', () => {
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
      registrySources: { svizzera: "{ id: 'costo-vita-svizzera-2026', updatedAt: '2026-10-04', date: '2026-06-02' }," },
      slugSources: { svizzera: "'costo-vita-svizzera-2026': { it: 'costo-vita-svizzera-2026' }," },
    });
    assert.equal(prepared.targets[0].url, 'https://frontaliereticino.ch/articoli-svizzera/costo-vita-svizzera-2026/');
    assert.equal(prepared.targets[0].sourceRevision, '1791158400.aaaaaaaaaaaa');
  });

  test('classifies a stale revision and a current revision after the grace window', () => {
    const target = {
      changedAt,
      sourceRevision: `1759622400.${sha.slice(0, 12)}`,
      sourceUpdatedAt: '2026-10-05',
    };
    assert.equal(classifyPublicationLag({
      target,
      page: parsePageObservation('<meta name="ft:content-rev" content="1759000000.bbbbbbb">'),
      nowMs,
    }).lagging, true);
    assert.equal(classifyPublicationLag({
      target,
      page: parsePageObservation('<meta name="ft:content-rev" content="1759622400.aaaaaaaaaaaa">'),
      nowMs,
    }).lagging, false);
  });

  test('falls back to dateModified when a legacy page has no stamp', () => {
    const target = {
      changedAt,
      sourceRevision: `1759622400.${sha.slice(0, 12)}`,
      sourceUpdatedAt: '2026-10-05',
    };
    const stale = classifyPublicationLag({
      target,
      page: parsePageObservation('<meta property="article:modified_time" content="2026-10-04T23:59:00Z">'),
      nowMs,
    });
    const current = classifyPublicationLag({
      target,
      page: parsePageObservation('<script type="application/ld+json">{"dateModified":"2026-10-06T00:00:00Z"}</script>'),
      nowMs,
    });
    assert.equal(stale.lagging, true);
    assert.equal(current.lagging, false);
  });

  test('uses fake HTTP responses sequentially and caps the courtesy rate', async () => {
    const requests = [];
    const sleeps = [];
    const targets = ['one', 'two'].map((articleId) => ({
      articleId,
      section: 'frontaliere',
      url: `https://example.test/${articleId}/`,
      changedAt,
      sourceRevision: `1759622400.${sha.slice(0, 12)}`,
      sourceUpdatedAt: '2026-10-05',
    }));
    const result = await observePublicationLag({
      targets,
      nowMs,
      minIntervalMs: 500,
      clock: () => 0,
      sleepImpl: async (ms) => sleeps.push(ms),
      fetchImpl: async (url) => {
        requests.push(url);
        return { ok: true, status: 200, text: async () => '<meta name="ft:content-rev" content="1759622400.aaaaaaaaaaaa">' };
      },
    });
    assert.deepEqual(requests, ['https://example.test/one/', 'https://example.test/two/']);
    assert.deepEqual(sleeps, [500]);
    assert.equal(result.lagging.length, 0);
  });
});
