import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cantonSectionPaths, loadCantonSectionProfiles } from '../scripts/lib/canton-section-profile.mjs';
import { corpusPath } from '../scripts/lib/corpus-paths.mjs';
import { collectCantonGenerationCoverage } from '../../scripts/ci/canton-generation-coverage.mjs';
import { collectCommits, collectMeasurements, evaluateConditions, reconcile } from '../../scripts/ci/scan-generation-health.mjs';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-19T10:00:00Z');
const SECTION = 'canton-ag';
const PATHS = cantonSectionPaths(SECTION);
const LOCALES = ['it', 'en', 'de', 'fr'];
const ENV = { RC_ENV_LOADED: '1', CANTON_ARTICLE_SECTIONS_ENABLED: 'AG' };
const TITLES = [
  'Generation health: cantoni senza articoli recenti',
  'Generation health: lacune nelle lingue cantonali',
];
const date = (time) => new Date(time).toISOString();

function fixture(t, section = SECTION, sharedRoot) {
  const root = sharedRoot ?? mkdtempSync(path.join(os.tmpdir(), 'canton-coverage-'));
  if (!sharedRoot) t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = cantonSectionPaths(section);
  function write(rel, text) {
    const file = path.join(root, corpusPath(rel));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return {
    root,
    registry: (rows) => write(paths.registryFile, `export const CANTON_ARTICLES = [
      ${rows.map(([id, time]) => `{ id: '${id}', date: '${time}' }`).join(',\n')}
    ];`),
    meta: (locale, entries) => write(
      paths.metaFiles.find((file) => file.endsWith(`-${locale}.ts`)),
      `const meta = { ${Object.entries(entries).map(([key, value]) => `"blog.article.${key}": ${JSON.stringify(value)}`).join(',\n')} };`,
    ),
    body: (locale, id) => write(`services/locales/${paths.bodyDir}/${locale}/${id}.ts`, 'export default {};'),
  };
}

function commitHistory(hours, rows = []) {
  return collectCommits('example/corpus', hours, {
    now: () => NOW,
    resolveHead: () => 'a'.repeat(40),
    fetchPage: () => rows.map(([time, subject]) => `${date(time)}\t${subject}`).join('\n'),
  });
}

function measure(root, commits, env = ENV) {
  return collectCantonGenerationCoverage({ repoRoot: root, now: NOW, commits, env });
}

test('dry usa solo le pubblicazioni entro i due estremi della finestra', (t) => {
  const { root } = fixture(t);
  const article = `Generate blog article (${SECTION})`;
  const rows = [
    [NOW + 1, article],
    [NOW, `Record rejected topic candidates (${SECTION} — no article generated)`],
    [NOW - 18 * HOUR - 1, article],
  ];
  const stale = commitHistory(48, rows);
  assert.equal(stale.perCanton[SECTION].rejected, 1);
  assert.equal(stale.perCanton[SECTION].articles, 1);
  assert.equal(measure(root, stale)['canton-dry'].firing, true);
  assert.match(measure(root, commitHistory(48))['canton-dry'].body, /nessun articolo osservato/);
  for (const time of [NOW - 18 * HOUR, NOW]) {
    const verdict = measure(root, commitHistory(18, [[time, article]]))['canton-dry'];
    assert.equal(verdict.firing, false);
    assert.match(verdict.summary, /canton-ag: coperto/);
  }
});

test('dry conserva le prove positive in una finestra corta e richiede misura per chiudere', (t) => {
  const { root } = fixture(t);
  const commits = commitHistory(2, [[NOW, `Generate blog article (${SECTION})`]]);
  assert.equal(measure(root, commits)['canton-dry'].firing, false);
  assert.equal(measure(root, commitHistory(2))['canton-dry'].available, false);
  assert.equal(measure(root, { available: true })['canton-dry'].available, false);
  assert.equal(measure(root, { available: false })['canton-dry'].available, false);
  const partial = measure(root, commits, { ...ENV, CANTON_ARTICLE_SECTIONS_ENABLED: 'AG BE' });
  assert.equal(partial['canton-dry'].available, false);
  assert.match(partial['canton-dry'].summary, /canton-ag: coperto[\s\S]*canton-be: non misurabile/);
  const incomplete = commitHistory(48);
  incomplete.perCanton['canton-be'] = { articles: 1 };
  const gap = measure(root, incomplete, { ...ENV, CANTON_ARTICLE_SECTIONS_ENABLED: 'AG BE' });
  assert.equal(gap['canton-dry'].available, false);
  assert.match(gap['canton-dry'].summary, /canton-ag: articolo assente[\s\S]*canton-be: non misurabile/);
});

test('RC ignoto, gate spento e kill switch rendono indisponibili entrambi i verdetti', (t) => {
  const { root } = fixture(t);
  const profiles = loadCantonSectionProfiles().cantons;
  assert.equal(profiles.length, 24);
  const cases = [
    [{ ...ENV, RC_ENV_LOADED: undefined }, 'non misurabile'],
    [{ ...ENV, CANTON_ARTICLE_SECTIONS_ENABLED: '' }, 'inattivo'],
    [{ ...ENV, CANTON_ARTICLE_SECTIONS_KILL: SECTION }, 'inattivo'],
  ];
  for (const [env, label] of cases) {
    for (const result of Object.values(measure(root, commitHistory(48), env))) {
      assert.equal(result.available, false);
      assert.deepEqual(result.summary.split('\n').map((line) => line.split(':')[0]), profiles.map(({ section }) => `- ${section}`));
      assert.match(result.summary, new RegExp(`canton-ag: ${label}`));
    }
  }
});

test('locale-gap richiede titolo e corpo per lo stesso id nelle quattro lingue', (t) => {
  const f = fixture(t);
  const commits = commitHistory(48);
  assert.equal(measure(f.root, commits)['locale-gap'].available, false);
  f.registry([]);
  for (const locale of LOCALES) f.meta(locale, {});
  const empty = measure(f.root, commits);
  assert.equal(empty['canton-dry'].firing, true);
  assert.match(empty['locale-gap'].body, /it=0, en=0, de=0, fr=0/);

  f.registry([
    ['recent', date(NOW - 48 * HOUR)],
    ['future', date(NOW + 1)],
    ['old', date(NOW - 48 * HOUR - 1)],
    ['invalid', 'invalid'],
    ['../invalid-id', date(NOW)],
  ]);
  for (const locale of LOCALES) {
    f.meta(locale, {
      'recent.title': locale === 'fr' ? ' ' : 'Titolo',
      'future.title': 'Futuro',
      'old.title': 'Vecchio',
      'invalid.title': 'Data non valida',
      '../invalid-id.title': 'Id non valido',
    });
    for (const id of ['future', 'old', 'invalid']) f.body(locale, id);
  }
  f.body('it', 'recent');
  f.body('en', 'recent');
  f.body('fr', 'recent');
  assert.match(measure(f.root, commits)['locale-gap'].body, /it=1, en=1, de=0, fr=0/);

  f.body('de', 'recent');
  f.meta('fr', { 'recent.title': ' \u00a0blog.article.recent.title\t ' });
  assert.match(measure(f.root, commits)['locale-gap'].body, /it=1, en=1, de=1, fr=0/);
  f.meta('fr', { 'recent.title': 'blog.article.recent.title!' });
  assert.equal(measure(f.root, commits)['locale-gap'].firing, false);
  f.meta('fr', { 'recent.title': "L’article d’aujourd’hui" });
  const recovered = measure(f.root, commits)['locale-gap'];
  assert.equal(recovered.firing, false);
  assert.match(recovered.summary, /it=1, en=1, de=1, fr=1/);
  rmSync(path.join(f.root, corpusPath(PATHS.metaFiles[1])));
  const missing = measure(f.root, commits)['locale-gap'];
  assert.equal(missing.available, false);
  assert.match(missing.summary, /en=n\/d/);
});

test('wiring aggrega i gap, rispetta il cap e risolve gli stessi titoli al recupero', async (t) => {
  const f = fixture(t);
  f.registry([]);
  for (const locale of LOCALES) f.meta(locale, {});
  const getVerdicts = async (commits, env) => {
    const { measurements } = await collectMeasurements('example/corpus', {
      now: () => NOW,
      repoRoot: f.root,
      env,
      collectCommitsFn: () => commits,
      collectRunLogsFn: () => ({ available: false }),
      collectCorpusFn: () => ({ available: false }),
      collectCoverQueueFn: () => ({ available: false }),
    });
    return evaluateConditions(measurements).filter(({ title }) => TITLES.includes(title));
  };
  const twoCantons = { ...ENV, CANTON_ARTICLE_SECTIONS_ENABLED: 'AG BE' };
  const commits = commitHistory(48);
  commits.perCanton['canton-be'] = { articles: 1 };
  const partial = await getVerdicts(commits, twoCantons);
  assert.deepEqual(partial.map(({ available, firing }) => [available, firing]), [[false, false], [false, false]]);
  assert.match(measure(f.root, commits, twoCantons)['locale-gap'].summary,
    /canton-ag: articolo assente[\s\S]*canton-be: non misurabile \(registro indisponibile\)/);
  const created = [];
  const routed = [];
  const resolved = [];
  const io = {
    createIssue: async ({ title }) => { created.push(title); return { number: created.length }; },
    routeIssue: (issue, verdict) => routed.push([issue.number, verdict.title]),
    resolveIssue: (title) => resolved.push(title),
    log: () => {},
  };
  await reconcile(partial, io);
  assert.deepEqual({ created, routed, resolved }, { created: [], routed: [], resolved: [] });

  const bern = fixture(t, 'canton-be', f.root);
  bern.registry([]);
  for (const locale of LOCALES) bern.meta(locale, {});
  const verdicts = await getVerdicts(commitHistory(48), twoCantons);
  assert.deepEqual(verdicts.map(({ title, section }) => [title, section]), TITLES.map((title) => [title, null]));
  for (const verdict of verdicts) {
    assert.equal(verdict.firing, true);
    assert.match(verdict.body, /canton-ag: articolo assente[\s\S]*canton-be: articolo assente/);
  }
  assert.equal((await reconcile(verdicts, { ...io, maxIssues: 1 })).capped, 1);
  assert.deepEqual(created, TITLES.slice(0, 1));
  created.length = 0;
  routed.length = 0;
  await reconcile(verdicts, io);
  assert.deepEqual(created, TITLES);
  assert.deepEqual(routed, TITLES.map((title, i) => [i + 1, title]));

  f.registry([['recent', date(NOW)]]);
  for (const locale of LOCALES) {
    f.meta(locale, { 'recent.title': 'Titolo' });
    f.body(locale, 'recent');
  }
  const published = commitHistory(48, [[NOW, `Generate blog article (${SECTION})`]]);
  await reconcile(await getVerdicts(published, { ...ENV, RC_ENV_LOADED: undefined }), io);
  await reconcile(await getVerdicts(published, { ...twoCantons, CANTON_ARTICLE_SECTIONS_KILL: 'BE' }), io);
  assert.deepEqual(resolved, TITLES);
  assert.deepEqual(created, TITLES);
});
