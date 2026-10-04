/**
 * image-credits-revalidate.test.mjs — the monthly revalidation of the Commons
 * cover credits (P14 C4): `scripts/ci/image-credits-revalidate.mjs` and
 * `.github/workflows/image-credits-revalidate.yml`. Run with `node --test`.
 *
 * The script reads the log of `scripts/backfill-image-credits.mjs --check`, so
 * the cases that matter run the REAL `--build` and `--check` on a miniature
 * corpus and feed the real log to the script: a change of wording on either
 * side turns this file red instead of a month of silence. GitHub is injected
 * (`createIssue`), Commons is a snapshot written by the test: no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ISSUE_LABELS,
  ISSUE_TITLE,
  PROBLEM_KINDS,
  buildIssueBody,
  classifyProblems,
  coverSparsePatterns,
  parseCheckLog,
  runRevalidation,
} from '../../scripts/ci/image-credits-revalidate.mjs';
import { OVERRIDES_FILE, REGISTRY_FILES, SNAPSHOT_FILE, serializeSnapshot } from '../../scripts/backfill-image-credits.mjs';
import { COMMONS_USAGE_MAPS } from '../scripts/lib/commons-credit.mjs';
import { IMAGE_CREDITS_ROOT, SEO_LITERALS_DIR } from '../../scripts/lib/image-credit-records.mjs';
import { relativeImportClosure } from './lib/reachable-source.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BACKFILL = path.join(REPO, 'scripts/backfill-image-credits.mjs');
const WORKFLOW = path.join(REPO, '.github/workflows/image-credits-revalidate.yml');
const PROBE = JSON.parse(fs.readFileSync(new URL('./fixtures/commons-credit/probe-2026-10-04.snapshot.json', import.meta.url), 'utf-8'));

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function webpHeader(width, height) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8X', 8, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

const upload = (title) => `https://upload.wikimedia.org/wikipedia/commons/a/ab/${encodeURIComponent(title.replace(/ /g, '_'))}`;
const row = (id, image) => `  {\n   id: '${id}',\n   category: 'novita',\n   date: '2026-10-01',\n   image: '${image}',\n  },\n`;

/**
 * Two Commons files on three covers, credited by `--build` from a snapshot
 * read on 2026-10-04: «Locarno 1.jpg» (CC BY-SA 3.0, two covers) and «Lugano
 * prokudin.jpg» (public domain, a site-era cover whose size comes from the
 * overrides). Plus a cover that is not Commons and a map entry no row shows.
 */
function creditedTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-revalidate-'));
  write(root, 'content/blog-articles-data.ts', `const RAW_ARTICLES = [\n${[
    row('locarno-uno', '/images/blog/locarno-uno.webp'),
    row('prokudin', '/images/blog/prokudin.webp'),
    row('stock', '/images/blog/stock.webp'),
  ].join('')}];\n`);
  write(root, 'content/swiss-articles-data.ts', `const RAW_SWISS_ARTICLES = [\n${row('ch-locarno', '/images/blog/ch-locarno.webp')}];\n`);
  write(root, 'data/blog-images-used.json', JSON.stringify({
    'locarno-uno': upload('Locarno 1.jpg'),
    'ch-locarno': upload('Locarno 1.jpg'),
    'non-pubblicato': upload('Locarno 1.jpg'),
  }));
  write(root, 'data/blog-images-used-site-legacy.json', JSON.stringify({ prokudin: upload('Lugano prokudin.jpg') }));
  write(root, OVERRIDES_FILE, JSON.stringify({ schema: 1, files: {}, covers: { prokudin: { modified: 'cropped' } } }));
  write(root, 'public/images/blog/locarno-uno.webp', webpHeader(1200, 675));
  write(root, 'public/images/blog/ch-locarno.webp', webpHeader(1200, 900));
  write(root, 'public/images/blog/stock.webp', webpHeader(1280, 720));
  const files = { 'Locarno 1.jpg': PROBE.files['Locarno 1.jpg'], 'Lugano prokudin.jpg': PROBE.files['Lugano prokudin.jpg'] };
  write(root, SNAPSHOT_FILE, serializeSnapshot({ schema: 1, fetchedAt: '2026-10-04', requests: 1, files, aliases: {} }));
  const build = spawnSync(process.execPath, [BACKFILL, '--build', '--root', root], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  return root;
}

/** What next month's `--fetch` would write: the same files, `change` applied, read on 2026-11-07. */
function refetch(root, change = (files) => files) {
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, SNAPSHOT_FILE), 'utf-8'));
  write(root, SNAPSHOT_FILE, serializeSnapshot({ ...snapshot, fetchedAt: '2026-11-07', files: change(structuredClone(snapshot.files)) }));
}

/** The workflow's `--check` step: stdout and stderr in one log. */
function checkLog(root) {
  const result = spawnSync('/bin/sh', ['-c', `"${process.execPath}" "${BACKFILL}" --check --root "${root}" 2>&1`], { encoding: 'utf8' });
  return { status: result.status, log: result.stdout };
}

function fakeGithub(result = { number: 7, url: 'https://github.com/o/r/issues/7', persisted: true }) {
  const calls = [];
  return { calls, createIssue: async (args) => { calls.push(args); return result; } };
}

test('a month in which Commons changed nothing: --check is clean, and nothing is opened', async () => {
  const root = creditedTree();
  try {
    refetch(root);
    const { status, log } = checkLog(root);
    assert.equal(status, 0, `a new fetchedAt alone is not a change:\n${log}`);
    const github = fakeGithub();
    const lines = [];
    assert.equal(await runRevalidation({ root, checkLog: log, createIssue: github.createIssue, log: (l) => lines.push(l) }), 0);
    assert.deepEqual(github.calls, []);
    assert.match(lines.join('\n'), /--check pulito/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a month with changes: ONE issue, stable title, needs-human, every problem under its kind, and the remedy', async () => {
  const root = creditedTree();
  try {
    refetch(root, (files) => {
      const locarno = files['Locarno 1.jpg'];
      locarno.meta = { ...locarno.meta, Artist: 'Mario Rossi', LicenseShortName: 'CC BY-SA 4.0', LicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', License: 'cc-by-sa-4.0' };
      files['Lugano prokudin.jpg'] = { exists: false };
      return files;
    });
    const { status, log } = checkLog(root);
    assert.equal(status, 1, log);
    const github = fakeGithub();
    const runUrl = 'https://github.com/o/r/actions/runs/1';
    assert.equal(await runRevalidation({ root, checkLog: log, runUrl, createIssue: github.createIssue, log: () => {} }), 0);
    assert.equal(github.calls.length, 1, 'one issue, opened or commented by the dedup of github-issue-creator');
    const [call] = github.calls;
    assert.equal(call.title, ISSUE_TITLE);
    assert.deepEqual(call.labels, ['bug', 'automation', 'needs-human']);
    assert.equal(call.priority, 2);
    assert.equal(call.workflow, 'image-credits-revalidate');
    const body = call.description;
    const section = (heading) => body.slice(body.indexOf(`### ${heading}`)).split('\n### ')[0];
    assert.match(section('File cancellati su Commons'), /«Lugano prokudin\.jpg» — copertina `prokudin` — `deleted-on-commons`/);
    assert.match(section('Licenza cambiata'), /«Locarno 1\.jpg» — copertine `ch-locarno`, `locarno-uno` — `licence\.name`, `licence\.url`/);
    assert.match(section('Autore o attribuzione'), /«Locarno 1\.jpg» — copertine `ch-locarno`, `locarno-uno` — `author\.name`, `author\.text`, `author\.url`/);
    assert.doesNotMatch(body, /### Altri problemi/, 'every line was recognised');
    assert.match(body, /\*\*3 problemi\*\* \(2 file Commons, 3 copertine\)/);
    assert.match(body, /^Il 2026-11-07 la rivalidazione mensile/, 'the date of the new read');
    assert.ok(body.includes(runUrl));
    for (const step of ['backfill-image-credits.mjs --fetch', 'data/image-credit-overrides.json', 'backfill-image-credits.mjs --build', 'PR']) {
      assert.ok(body.includes(step), `the remedy names ${step}`);
    }
    for (const line of parseCheckLog(log)) assert.ok(body.includes(line), `the --check line is in the body: ${line}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the title is the dedup key: no date or number, nothing the phrase search drops, within the first 60 characters', () => {
  assert.ok(ISSUE_TITLE.length <= 60, `${ISSUE_TITLE.length} characters`);
  assert.doesNotMatch(ISSUE_TITLE, /\d/);
  assert.doesNotMatch(ISSUE_TITLE, /[/*"]/);
  assert.ok(ISSUE_LABELS.includes('needs-human'), 'curation and owner decisions are not a fixer job');
});

test('a log that did not complete is never read as clean: exit 1, no issue', async () => {
  const crashed = '[backfill] TypeError: boom\n    at checkTree (scripts/backfill-image-credits.mjs:1:1)\n';
  const truncated = '[backfill] needs a human: «A.jpg» (a): restriction:personality\n[backfill] --check: 2 problem(s)\n';
  assert.throws(() => parseCheckLog(crashed), /did not complete/);
  assert.throws(() => parseCheckLog(''), /did not complete/);
  assert.throws(() => parseCheckLog(truncated), /reported 2 problem\(s\), but the log holds 1/);
  for (const checkLog of [crashed, truncated]) {
    const github = fakeGithub();
    assert.equal(await runRevalidation({ root: os.tmpdir(), checkLog, createIssue: github.createIssue, log: () => {} }), 1);
    assert.deepEqual(github.calls, []);
  }
});

test('an issue that GitHub did not record fails the run, so the findings are not lost', async () => {
  const checkLog = '[backfill] needs a human: «A.jpg» (a): deleted-on-commons\n[backfill] --check: 1 problem(s)\n';
  for (const result of [null, { number: 7, persisted: false }]) {
    const github = fakeGithub(result);
    const lines = [];
    assert.equal(await runRevalidation({ root: os.tmpdir(), checkLog, createIssue: github.createIssue, log: (l) => lines.push(l) }), 1);
    assert.equal(github.calls.length, 1);
    assert.ok(lines.join('\n').includes(github.calls[0].description), 'the body stays in the log of the red run');
  }
});

test('--dry-run prints the issue and opens nothing', async () => {
  const checkLog = '[backfill] needs a human: «A.jpg» (a): deleted-on-commons\n[backfill] --check: 1 problem(s)\n';
  const github = fakeGithub();
  const lines = [];
  assert.equal(await runRevalidation({ root: os.tmpdir(), checkLog, dryRun: true, createIssue: github.createIssue, log: (l) => lines.push(l) }), 0);
  assert.deepEqual(github.calls, []);
  assert.match(lines.join('\n'), new RegExp(`dry-run: aprirei o commenterei «${ISSUE_TITLE}»[\\s\\S]*«A\\.jpg»`));
});

test('every kind of --check line lands under its kind, and an unknown one is kept verbatim', () => {
  const problems = [
    'needs a human: «Ritratto.jpg» (uno, due): restriction:personality',
    'needs a human: «Sporco.jpg» (tre): author:artist-not-a-name; licence:OTHER:none',
    'needs a human: «Logo.png» (quattro): non-free',
    'content/image-credits/blog/cinque.json: differs from a rebuild — run --build (commons.revision, modified)',
    'content/image-credits/blog/sei.json: differs from a rebuild — run --build (commons.pageUrl, commons.title)',
    'content/image-credits/blog/sette.json: differs from a rebuild — run --build (restrictions, status)',
    'content/image-credits/blog/otto.json: missing — run --build',
    'needs a human: «(overrides)» (nove): a replacement for a cover whose Commons file is not replaced',
    'a line no version of --check has ever printed',
  ];
  const titles = { cinque: 'Treno.jpg', sei: 'Lago.jpg' };
  const byKind = classifyProblems(problems, { titleOfCover: (key) => titles[key] ?? null });
  const summary = Object.fromEntries(PROBLEM_KINDS.map(([kind]) => [kind, [...byKind.get(kind).values()].map((f) => `${f.title ?? '-'} [${[...f.covers].join(',')}] ${[...f.details].join(',')}`)]));
  assert.deepEqual(summary, {
    deleted: [],
    licence: ['Sporco.jpg [tre] licence:OTHER:none', 'Logo.png [quattro] non-free'],
    author: ['Sporco.jpg [tre] author:artist-not-a-name'],
    restriction: ['Ritratto.jpg [uno,due] restriction:personality', '- [sette] restrictions'],
    revision: ['Treno.jpg [cinque] commons.revision,modified'],
    renamed: ['Lago.jpg [sei] commons.pageUrl,commons.title'],
    other: [
      '- [sette] status',
      '- [] content/image-credits/blog/otto.json: missing — run --build',
      '(overrides) [nove] a replacement for a cover whose Commons file is not replaced',
      '- [] a line no version of --check has ever printed',
    ],
  });
  const body = buildIssueBody({ problems, byKind });
  for (const [, heading] of PROBLEM_KINDS.filter(([kind]) => kind !== 'deleted')) assert.ok(body.includes(`### ${heading}`), heading);
  assert.ok(!body.includes('### File cancellati'), 'an empty kind has no heading');
});

test('--cover-patterns lists the webp of every live Commons cover, and nothing else', () => {
  const root = creditedTree();
  try {
    assert.deepEqual(coverSparsePatterns(root), [
      '/public/images/blog/ch-locarno.webp',
      '/public/images/blog/locarno-uno.webp',
      '/public/images/blog/prokudin.webp', // its size comes from the overrides, but --check may need it once they change
    ], 'not the cover that is not Commons (stock), not a map entry no row shows (non-pubblicato)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── The workflow ──────────────────────────────────────────────────────────────

const YAML = fs.readFileSync(WORKFLOW, 'utf-8');
const code = YAML.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** The sparse-checkout patterns of the first checkout: only `/dir/` and `/file` forms. */
function sparsePatterns() {
  const block = code.match(/sparse-checkout: \|\n((?: {12}\S.*\n)+)/);
  assert.ok(block, 'the checkout declares a sparse-checkout block');
  const patterns = block[1].split('\n').map((l) => l.trim()).filter(Boolean);
  for (const p of patterns) assert.match(p, /^\/[A-Za-z0-9._/-]+$/, `a plain path pattern, so this test reads it as git does: ${p}`);
  return patterns;
}
const covered = (patterns, rel) => patterns.some((p) => (p.endsWith('/') ? `/${rel}`.startsWith(p) : `/${rel}` === p));

test('workflow: monthly and by hand, read-only on contents, issues only, never a commit or a push', () => {
  assert.match(code, /on:\n {2}schedule:\n {4}- cron: '(\d{1,2}) (\d{1,2}) ([1-9]|1\d|2[0-8]) \* \*'\n {2}workflow_dispatch:/, 'one run a month, on a day every month has');
  assert.match(code, /\npermissions:\n {2}contents: read\n {2}issues: write\n\n/, 'exactly contents: read and issues: write');
  assert.doesNotMatch(code, /git (?:push|commit)|contents: write|gh pr create|pull-requests: write/);
  assert.doesNotMatch(code, /npm (?:ci|install)/, 'the scripts are builtins-only');
});

test('workflow: covers, then --fetch, then --check into the log the script reads, then the script', () => {
  const at = (needle) => {
    const index = code.indexOf(needle);
    assert.ok(index >= 0, `the workflow runs: ${needle}`);
    return index;
  };
  const covers = at('node scripts/ci/image-credits-revalidate.mjs --cover-patterns');
  const fetchAt = at('node scripts/backfill-image-credits.mjs --fetch');
  const checkAt = at('node scripts/backfill-image-credits.mjs --check > "$RUNNER_TEMP/image-credits-check.log" 2>&1');
  const scriptAt = at('args=(--check-log "$RUNNER_TEMP/image-credits-check.log")');
  assert.ok(covers < fetchAt && fetchAt < checkAt && checkAt < scriptAt);
  assert.match(code.slice(fetchAt, scriptAt), /set \+e\n\s+node scripts\/backfill-image-credits\.mjs --check/, '--check exits 1 on problems: the step must not stop the job before the script reads the log');
  assert.ok(at('git sparse-checkout add --stdin') > covers, 'the patterns are applied to the checkout');
  assert.match(
    code.slice(covers, fetchAt),
    /xargs -r git ls-files -t -- \| grep -c '\^S '[\s\S]*exit 1/,
    'a tracked cover left out of the checkout stops the run, instead of reaching the issue as a false «size unknown»',
  );
  assert.match(code, /runtime_pat="\$\{GITHUB_PAT_NANAKO:-\}"\n\s+export GH_TOKEN="\$\{runtime_pat:-\$GH_TOKEN\}"/, 'the PAT from the runtime shell (AGENTS.md)');
  assert.ok(at('node generator/scripts/load-rc-env.mjs') > checkAt, 'no secret in the environment of the steps that read Commons');
});

test('workflow: the first checkout holds every module the steps import and every file they read', () => {
  const patterns = sparsePatterns();
  const modules = [
    'scripts/backfill-image-credits.mjs',
    'scripts/ci/image-credits-revalidate.mjs',
    'generator/scripts/load-rc-env.mjs',
  ].flatMap((entry) => relativeImportClosure(path.join(REPO, entry)).map((file) => path.relative(REPO, file)));
  const data = [
    SNAPSHOT_FILE,
    OVERRIDES_FILE,
    ...REGISTRY_FILES,
    ...COMMONS_USAGE_MAPS,
    `${IMAGE_CREDITS_ROOT}/blog/any-cover.json`,
    `${SEO_LITERALS_DIR}/seo-blog-ch.ts`,
  ];
  const missing = [...new Set([...modules, ...data])].filter((rel) => !covered(patterns, rel));
  assert.deepEqual(missing, [], 'a step would fail with ERR_MODULE_NOT_FOUND, or --check would read a partial corpus');
  assert.ok(!patterns.some((p) => p.startsWith('/public/')), 'the covers come from --cover-patterns, not from the whole folder');
});
