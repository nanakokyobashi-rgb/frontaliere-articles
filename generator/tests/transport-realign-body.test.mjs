/**
 * transport-realign-body.test.mjs — il formato delle righe `(site sha256 ...)`
 * scritte dal trasporto e rilette dal realign post-merge (issue #1784).
 *
 * FU-2026-09-21-010 (valerielinc-ops/frontaliere-si-o-no#9443): il parser
 * leggeva il path con `([^`\n]+)`, quindi un path Git con un backtick spariva
 * dal match e il realign falliva con un falso «il body non cita tutti i file».
 * Il produttore, dal canto suo, lo scriveva fra singoli backtick: un code span
 * rotto. Ora entrambi passano da `scripts/ci/transport-realign-body.mjs`.
 *
 * FU-2026-09-21-011: la politica sui bullet duplicati c'era (stessa hash
 * accettata, hash diverse in errore) ma nessun test la vincolava.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_PATH,
  decodeCodeSpanContent,
  markdownCodeSpan,
  parseTransportBullets,
  planTransportRealign,
  transportBulletLine,
} from '../../scripts/ci/transport-realign-body.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/ci/transport-realign-body.mjs');
const HASH16 = '3495d7994fa50d84';
const HASH64 = '3495D7994FA50D84'.padEnd(64, 'A');

const TRICKY_PATHS = [
  'scripts/ci/plain.mjs',
  'scripts/ci/with`tick.mjs',
  'scripts/ci/double``tick.mjs',
  '`leading.mjs',
  'trailing.mjs`',
  ' spaced .mjs ',
];

function manifestFor(paths, mode = 'identical') {
  return { files: paths.map((p) => ({ path: p, mode })) };
}

test('markdownCodeSpan è reversibile anche con backtick e spazi ai bordi', () => {
  for (const value of TRICKY_PATHS) {
    const span = markdownCodeSpan(value);
    const fence = span.match(/^`+/)[0];
    assert.ok(span.endsWith(fence), `delimitatore asimmetrico per ${value}`);
    const inner = span.slice(fence.length, span.length - fence.length);
    const longestInner = Math.max(0, ...(value.match(/`+/g) || []).map((run) => run.length));
    assert.ok(fence.length > longestInner, `delimitatore non piu' lungo delle run interne per ${value}`);
    assert.equal(decodeCodeSpanContent(inner), value, `round-trip fallito per ${JSON.stringify(value)}`);
  }
  assert.equal(markdownCodeSpan('scripts/ci/plain.mjs'), '`scripts/ci/plain.mjs`', 'il caso comune resta il body storico');
  assert.throws(() => markdownCodeSpan('a\nb'), /non rappresentabile/);
});

test('ogni riga scritta dal produttore viene riletta con lo stesso path (FU-010)', () => {
  for (const value of TRICKY_PATHS) {
    const line = transportBulletLine({ path: value, sitePath: `site/${value}`, to: HASH16 });
    assert.deepEqual(parseTransportBullets(line), [{ path: value, siteHash: HASH16 }], line);
  }
});

test('un path con backtick non diventa un falso «non cita tutti i file» (FU-010)', () => {
  const filePath = 'scripts/ci/with`tick.mjs';
  const body = ['## Implementato', transportBulletLine({ path: filePath, sitePath: filePath, to: HASH16 }), ''].join('\n');
  // Il parser precedente (`([^`\n]+)`) non vedeva la riga: e' il difetto.
  const legacy = /^- `([^`\n]+)` .*?\((?:site )?sha256 `([0-9a-fA-F]{16}|[0-9a-fA-F]{64})`\)\s*$/gm;
  assert.equal([...body.matchAll(legacy)].length, 0);
  const plan = planTransportRealign({
    body,
    changedFiles: [filePath, MANIFEST_PATH],
    manifest: manifestFor([filePath]),
  });
  assert.deepEqual(plan.rows, [`${filePath}\t${HASH16}`]);
});

test('i body storici col singolo backtick restano validi', () => {
  const body = [
    `- \`scripts/a.mjs\` ← sito (sha256 \`${HASH16}\`)`,
    `- \`scripts/b.mjs\` ← \`scripts/b.mjs\` del sito (site sha256 \`${HASH64}\`)`,
  ].join('\n');
  assert.deepEqual(parseTransportBullets(body), [
    { path: 'scripts/a.mjs', siteHash: HASH16 },
    { path: 'scripts/b.mjs', siteHash: HASH16 },
  ]);
});

test('bullet duplicati con la stessa hash sono una sola attestazione (FU-011)', () => {
  const filePath = 'scripts/ci/dup.mjs';
  const body = [
    '## Implementato',
    `- \`${filePath}\` ← sito (site sha256 \`${HASH16}\`)`,
    '## Non implementato (ancora)',
    // Stessa provenienza scritta in forma lunga e maiuscola: stessa hash.
    `- \`${filePath}\` ← sito (sha256 \`${HASH64}\`)`,
  ].join('\n');
  const plan = planTransportRealign({ body, changedFiles: [filePath], manifest: manifestFor([filePath]) });
  assert.deepEqual(plan.rows, [`${filePath}\t${HASH16}`]);
});

test('lo stesso path con hash diverse è un errore, prima di scrivere il TSV (FU-011)', () => {
  const filePath = 'scripts/ci/dup.mjs';
  const body = [
    `- \`${filePath}\` ← sito (site sha256 \`${HASH16}\`)`,
    `- \`${filePath}\` ← sito (site sha256 \`${'0'.repeat(16)}\`)`,
  ].join('\n');
  assert.throws(
    () => planTransportRealign({ body, changedFiles: [filePath], manifest: manifestFor([filePath]) }),
    /stesso path con site hash diverse: scripts\/ci\/dup\.mjs/,
  );

  // Stesso contratto dalla CLI del workflow: rosso, e nessun TSV scritto.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-realign-body-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts/ci'), { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_PATH), JSON.stringify(manifestFor([filePath])));
    fs.writeFileSync(path.join(dir, 'body.md'), body);
    fs.writeFileSync(path.join(dir, 'files.txt'), `${filePath}\n`);
    const res = spawnSync(process.execPath, [SCRIPT, 'body.md', 'files.txt', 'out.tsv'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /site hash diverse/);
    assert.equal(fs.existsSync(path.join(dir, 'out.tsv')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('le altre garanzie del realign restano: path estranei, non dichiarati, mancanti', () => {
  const identicalPath = 'scripts/ci/id.mjs';
  const adaptedPath = 'scripts/ci/adapted.mjs';
  const manifest = { files: [{ path: identicalPath, mode: 'identical' }, { path: adaptedPath, mode: 'adapted' }] };
  const line = (p) => transportBulletLine({ path: p, sitePath: p, to: HASH16 });
  assert.throws(
    () => planTransportRealign({ body: line(identicalPath), changedFiles: [identicalPath, 'x.mjs'], manifest }),
    /non dichiarati nel manifest: x\.mjs/,
  );
  assert.throws(
    () => planTransportRealign({ body: line('scripts/ci/other.mjs'), changedFiles: [identicalPath], manifest }),
    /path non presente nei file della PR/,
  );
  assert.throws(
    () => planTransportRealign({ body: '', changedFiles: [identicalPath], manifest }),
    /non cita tutti i file trasportati e modificati dalla PR: scripts\/ci\/id\.mjs/,
  );
  const plan = planTransportRealign({
    body: [line(identicalPath), line(adaptedPath)].join('\n'),
    changedFiles: [identicalPath, adaptedPath, MANIFEST_PATH],
    manifest,
  });
  assert.deepEqual(plan.rows, [`${identicalPath}\t${HASH16}`]);
  assert.deepEqual(plan.excluded, [adaptedPath]);
});

test('la CLI scrive il TSV letto dallo step di realign', () => {
  const filePath = 'scripts/ci/with`tick.mjs';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-realign-body-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts/ci'), { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_PATH), JSON.stringify(manifestFor([filePath])));
    fs.writeFileSync(path.join(dir, 'body.md'), transportBulletLine({ path: filePath, sitePath: filePath, to: HASH64 }));
    fs.writeFileSync(path.join(dir, 'files.txt'), `${filePath}\n${MANIFEST_PATH}\n`);
    execFileSync(process.execPath, [SCRIPT, 'body.md', 'files.txt', 'out.tsv'], { cwd: dir, encoding: 'utf8' });
    assert.equal(fs.readFileSync(path.join(dir, 'out.tsv'), 'utf8'), `${filePath}\t${HASH16}\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('produttore e consumatore importano lo stesso modulo', () => {
  const producer = fs.readFileSync(path.join(ROOT, '.github/workflows/transport-identical-twins.yml'), 'utf8');
  const consumer = fs.readFileSync(path.join(ROOT, '.github/workflows/transport-identical-twins-realign.yml'), 'utf8');
  assert.match(producer, /node --input-type=module -e '\s+import fs from "node:fs";\s+import \{ markdownCodeSpan, transportBulletLine \} from "\.\/scripts\/ci\/transport-realign-body\.mjs";/);
  assert.match(producer, /r\.transported\.map\(\(t\) => transportBulletLine\(t\)\)/);
  assert.doesNotMatch(producer, /"- `" \+ t\.path \+ "`/, 'il produttore non deve piu\' scrivere il code span a mano');
  assert.match(consumer, /node scripts\/ci\/transport-realign-body\.mjs/);
  assert.doesNotMatch(consumer, /const re = \/\^- `\(\[\^`/, 'nessun secondo parser inline nel workflow');

  // La forma d'invocazione del produttore risolve l'import dal checkout.
  const out = execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    'import { transportBulletLine } from "./scripts/ci/transport-realign-body.mjs"; console.log(transportBulletLine({ path: "a`b", sitePath: "a`b", to: "' + HASH16 + '" }));',
  ], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(out, '- ``a`b`` ← ``a`b`` del sito (site sha256 `' + HASH16 + '`)');
});
