#!/usr/bin/env node
/**
 * Byte-for-byte parity runner for the transported generator (issue #4974
 * item 3, §5.4).
 *
 * Runs every probe in probes.mjs against a generator-scripts root and prints a
 * canonical JSON report. Because the report is a deterministic function of the
 * code under it, two roots agreeing byte-for-byte means the transported modules
 * behave identically to the ones they were copied from.
 *
 *   # this repo's tree, compared against the committed golden
 *   node generator/tests/parity/run.mjs --check
 *
 *   # re-record the golden after an INTENDED behaviour change
 *   node generator/tests/parity/run.mjs --write
 *
 *   # the actual cross-repo comparison, run from a checkout that has both:
 *   node generator/tests/parity/run.mjs --root ../frontaliere-si-o-no/scripts > /tmp/main.json
 *   node generator/tests/parity/run.mjs > /tmp/nanako.json
 *   diff /tmp/main.json /tmp/nanako.json && echo "byte-identical"
 *
 * `--root` is what makes this usable against main: the probes name modules
 * relative to the generator scripts root, which is `scripts/` there and
 * `generator/scripts/` here, so the same probe list drives both trees.
 *
 * CI only ever runs `--check`, since main is not checked out there. The golden
 * is therefore a standing record of "what main produced at transport time",
 * and a diff against it is a regression in the transported copy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBES, HISTORY_FIXTURE, HISTORY_PROBES } from './probes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const GOLDEN = path.join(HERE, 'golden.json');

const argv = process.argv.slice(2);
const rootArg = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : null;
const SCRIPTS_ROOT = rootArg
  ? path.resolve(rootArg)
  : path.join(REPO_ROOT, 'generator', 'scripts');
const CHECK = argv.includes('--check');
const WRITE = argv.includes('--write');

/**
 * Canonical JSON: object keys sorted at every level, so a report never differs
 * for reasons that are not behavioural. `undefined` and non-finite numbers are
 * tagged rather than dropped — losing the distinction between `undefined` and
 * `null` would hide exactly the kind of drift this is looking for.
 */
function canonical(value) {
  if (value === undefined) return { __undefined: true };
  if (typeof value === 'number' && !Number.isFinite(value)) return { __number: String(value) };
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Set) return { __set: [...value].map(canonical) };
  if (value instanceof Map) {
    return { __map: [...value.entries()].map(([k, v]) => [canonical(k), canonical(v)]).sort() };
  }
  if (Array.isArray(value)) return value.map(canonical);
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
  return out;
}

async function callProbe(mod, fn, args) {
  const target = mod[fn];
  if (typeof target !== 'function') {
    return { error: `export '${fn}' is not a function (got ${typeof target})` };
  }
  try {
    return { value: canonical(await target(...args)) };
  } catch (err) {
    // A thrown error is a legitimate observation, and one main and nanako must
    // agree on — only the message is compared, never the stack (paths differ).
    return { threw: `${err?.constructor?.name ?? 'Error'}: ${err?.message ?? err}` };
  }
}

const report = { scriptsRoot: path.relative(REPO_ROOT, SCRIPTS_ROOT) || '.', probes: {} };

for (const { module: rel, calls } of PROBES) {
  const abs = path.join(SCRIPTS_ROOT, rel);
  if (!fs.existsSync(abs)) {
    report.probes[rel] = { error: 'module not found' };
    continue;
  }
  let mod;
  try {
    mod = await import(`file://${abs}`);
  } catch (err) {
    report.probes[rel] = { error: `import failed: ${err.message}` };
    continue;
  }
  const results = {};
  for (const { fn, args } of calls) {
    results[`${fn}(${JSON.stringify(args)})`] = await callProbe(mod, fn, args);
  }
  report.probes[rel] = results;
}

// ── Filesystem-backed probes ────────────────────────────────────────
// aggregateCrossingStats() reads a history DIRECTORY, so the fixture is
// materialised into a temp dir. Same bytes on both sides, so any difference is
// in the aggregation, not the data.
{
  const rel = 'lib/border-wait-ranking.mjs';
  const abs = path.join(SCRIPTS_ROOT, rel);
  if (fs.existsSync(abs)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-history-'));
    for (const [name, doc] of Object.entries(HISTORY_FIXTURE)) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(doc, null, 2));
    }
    const mod = await import(`file://${abs}`);
    const results = {};
    for (const { fn, args } of HISTORY_PROBES) {
      results[`${fn}(<fixture>,${JSON.stringify(args)})`] = await callProbe(mod, fn, [dir, ...args]);
    }
    report.probes[`${rel}#history`] = results;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// `scriptsRoot` is dropped from what gets compared: it is metadata about WHERE
// the probes ran, and it necessarily differs between main and this repo. Only
// behaviour is compared.
const comparable = `${JSON.stringify(canonical(report.probes), null, 2)}\n`;

if (WRITE) {
  fs.writeFileSync(GOLDEN, comparable);
  console.log(`[parity] wrote golden: ${path.relative(REPO_ROOT, GOLDEN)}`);
  process.exit(0);
}

if (CHECK) {
  if (!fs.existsSync(GOLDEN)) {
    console.error('::error::[parity] no golden.json — run with --write first');
    process.exit(1);
  }
  const expected = fs.readFileSync(GOLDEN, 'utf-8');
  if (expected === comparable) {
    const n = Object.keys(report.probes).length;
    console.log(`[parity] ${n} probe module(s) byte-identical to golden`);
    process.exit(0);
  }
  console.error('::error::[parity] output differs from golden.json');
  const a = expected.split('\n');
  const b = comparable.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.error(`  first difference at line ${i + 1}:`);
      console.error(`    golden:  ${a[i] ?? '<eof>'}`);
      console.error(`    current: ${b[i] ?? '<eof>'}`);
      break;
    }
  }
  process.exit(1);
}

process.stdout.write(comparable);
