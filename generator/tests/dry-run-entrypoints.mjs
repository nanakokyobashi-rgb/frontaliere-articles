#!/usr/bin/env node
/**
 * Load every generator entry point with writes disabled (issue #4974 item 3,
 * §5.4 — "dry-run nanako's generator with writes disabled").
 *
 * WHAT THIS PROVES
 *
 * That the transported code LOADS in this repository. That sounds trivial and
 * is not: a static `import` of a module that was never copied throws before the
 * script's first statement, so a file can be perfectly correct and still be
 * dead on arrival. Six of them were, and the only way to find out was to run
 * them — which had never happened, because the transport was a file copy.
 *
 * Each entry point is spawned in a child process with `--help`, which every one
 * of them handles before doing any work. The child either reaches its argument
 * parsing (pass) or dies on a module-resolution/syntax error (fail). A non-zero
 * exit for a REASON OTHER than a load failure is not counted against it — some
 * of these legitimately refuse to run without credentials, and that refusal is
 * the script working.
 *
 * WHAT IT DOES NOT PROVE
 *
 * That a full generation run produces correct articles. That needs the LLM
 * credentials, live sources and a writable corpus this job deliberately does
 * not have. Behavioural equivalence with main is covered separately, and
 * deterministically, by tests/parity/run.mjs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'scripts');
const REPO_ROOT = path.resolve(HERE, '..', '..');

const ENTRY_POINTS = [
  'create-article.mjs',
  'batch-add-faq-to-articles.mjs',
  'fix-faq-locales.mjs',
  'generate-border-wait-ranking-article.mjs',
  'generate-daily-brief-article.mjs',
  'generate-events-digest-article.mjs',
  'refresh-daily-brief-data.mjs',
  'publish-journalist-article.mjs',
  'generate-journalist-image-catalog.mjs',
  'refresh-border-wait-averages.mjs',
  'refresh-border-wait-window.mjs',
];

/**
 * Errors that mean "this file could not be loaded". Anything else is the script
 * running and then declining to proceed, which is a pass for our purposes.
 */
const LOAD_FAILURE = [
  /ERR_MODULE_NOT_FOUND/,
  /Cannot find module/,
  /Cannot find package/,
  /SyntaxError/,
  /ERR_UNSUPPORTED_DIR_IMPORT/,
  /ERR_UNKNOWN_FILE_EXTENSION/,
];

/**
 * `DRY_RUN=1` is the generator's own convention, documented in the usage header
 * of the scripts that do real work ("plan only, no writes"). `--help` alone is
 * NOT enough and assuming it was is how this harness first ran: three entry
 * points ignore it and went straight to work, and
 * generate-border-wait-ranking-article.mjs rewrote four corpus body files
 * before the check that was supposed to be verifying it had not.
 */
function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, file), '--help'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DRY_RUN: '1', CI: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    // A script that blocks on network or stdin has still LOADED, which is what
    // is under test — so a timeout is a pass, not a hang.
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/**
 * `git status --porcelain` as a Map of path → status code. Paths with spaces or
 * renames are normalised to the destination path, which is the one that exists.
 */
function parseStatus(raw) {
  const map = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let rel = line.slice(3);
    if (rel.includes(' -> ')) rel = rel.split(' -> ')[1];
    map.set(rel.replace(/^"|"$/g, ''), code);
  }
  return map;
}

let failed = 0;
const before = parseStatus(
  await new Promise((resolve) => {
    const g = spawn('git', ['status', '--porcelain'], { cwd: REPO_ROOT });
    let o = '';
    g.stdout.on('data', (d) => (o += d));
    g.on('close', () => resolve(o));
  }),
);

for (const file of ENTRY_POINTS) {
  if (!fs.existsSync(path.join(SCRIPTS, file))) {
    console.error(`::error::[dry-run] ${file} does not exist`);
    failed += 1;
    continue;
  }
  const { code, out } = await run(file);
  const loadError = LOAD_FAILURE.find((rx) => rx.test(out));
  if (loadError) {
    const line = out.split('\n').find((l) => loadError.test(l)) ?? out.slice(0, 200);
    console.error(`::error::[dry-run] ${file} failed to LOAD: ${line.trim()}`);
    failed += 1;
  } else {
    console.log(`[dry-run] ${file}: loaded (exit ${code})`);
  }
}

// ── The "writes disabled" half of the claim ─────────────────────────
//
// Measured as a BEFORE/AFTER delta of `git status --porcelain`, over the whole
// tree — not an absolute "is the tree clean" check.
//
// Whole tree, because watching only content/ missed the more interesting
// failure: generate-events-digest-article.mjs still built its output path from
// main's `services/locales/blog-body/...`, so instead of touching the corpus it
// silently created a phantom `services/` tree at the repo root and wrote four
// body files into it. A check scoped to content/ reported success.
//
// A delta, because this has to be usable while someone has work in progress. An
// absolute check would fail on any dirty tree, which in practice means it gets
// ignored. Only paths that appear or change DURING the run are attributed to
// the run — and only those are reverted, so a developer's uncommitted work is
// never collateral.
async function gitStatus() {
  return new Promise((resolve) => {
    const g = spawn('git', ['status', '--porcelain'], { cwd: REPO_ROOT });
    let o = '';
    g.stdout.on('data', (d) => (o += d));
    g.on('close', () => resolve(o));
  });
}

const after = parseStatus(await gitStatus());
const introduced = [...after].filter(([p, code]) => before.get(p) !== code);

if (introduced.length) {
  for (const [rel] of introduced) {
    const abs = path.join(REPO_ROOT, rel);
    // Untracked → remove; tracked-and-modified → restore from HEAD.
    if (before.has(rel)) {
      await new Promise((r) => spawn('git', ['checkout', '--', rel], { cwd: REPO_ROOT }).on('close', r));
    } else if (fs.existsSync(abs)) {
      fs.rmSync(abs, { recursive: true, force: true });
    } else {
      await new Promise((r) => spawn('git', ['checkout', '--', rel], { cwd: REPO_ROOT }).on('close', r));
    }
  }
  console.error(
    '::error::[dry-run] an entry point wrote despite DRY_RUN=1 (reverted). ' +
      'The script needs a dry-run branch, or its output path is still main-relative:\n  ' +
      introduced.map(([p, c]) => `${c} ${p}`).join('\n  '),
  );
  failed += 1;
}

if (failed) {
  console.error(`::error::[dry-run] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`[dry-run] all ${ENTRY_POINTS.length} entry points load, corpus untouched`);
