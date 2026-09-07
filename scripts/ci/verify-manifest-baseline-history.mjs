#!/usr/bin/env node
/**
 * verify-manifest-baseline-history.mjs — riconfronta OGNI `baseline.corpus` di
 * `scripts/ci/loop-sync-manifest.json` con la storia REALE di quel path, dalla
 * git history locale: offline, senza cap, senza rete (issue #978, item 4;
 * follow-up della #954).
 *
 * ## Il buco che chiude
 *
 * Le 13 baseline della #954 sono state ricalcolate FUORI BANDA (`git log`
 * locale per il corpus, API + raw per il sito) e committate. Dentro il repo
 * non le riconfrontava niente:
 *
 *   - `checkBaselineProvenance()` (dentro `loop-drift-check.mjs`) le vede solo
 *     al cron SUCCESSIVO, cioe' a merge avvenuto, e per giunta via rete e con
 *     un cap sulla storia esaminata: oltre il cap il mancato match resta
 *     silenzioso, per non produrre falsi rossi;
 *   - `loop-baseline-pr-gate.mjs` (#956) e' **diff-scoped** per costruzione —
 *     guarda le sole voci il cui `baseline` e' cambiato NELLA PR. E' la scelta
 *     giusta per il suo mestiere (zero rete di norma), ma significa che ogni
 *     baseline gia' nel manifest quando quel gate e' nato non e' mai passata da
 *     nessuna verifica, e non ci passera' mai piu'.
 *
 * Quella seconda finestra non e' teorica: `scripts/ci/check-stale-issue-dispatch.mjs`
 * e' entrato nel manifest con `baseline.corpus` `0d449baad16a4280` sette ore
 * PRIMA che il gate esistesse, il path ha una sola revisione in tutta la storia,
 * e quell'hex non e' mai stato l'hash di quel blob. Un solo esadecimale
 * plausibile scritto a mano ricrea la classe `ghost-baseline`, e il verdetto a
 * tre vie di `classify()` su quella voce e' privo di significato finche' nessuno
 * la guarda: confronta `now` contro un `base` che non e' mai esistito e produce
 * comunque una classe plausibile.
 *
 * ## Perche' locale, e perche' solo il lato corpus
 *
 * Il lato corpus e' QUESTO repo: la storia e' nel checkout, quindi la verifica
 * e' deterministica, gratuita e integrale — tutte le revisioni del path, non le
 * prime N. Il lato sito vive in un altro repo e offline non e' risolvibile:
 * resta coperto da `checkBaselineProvenance()` del cron e dal gate in PR.
 *
 * Serve pero' una storia COMPLETA: con un checkout shallow lo script **esce 1**
 * invece di dichiarare verificato cio' che non ha potuto leggere. Un checker di
 * baseline che fail-open sulla propria sorgente sarebbe la stessa forma di bug
 * che sta cercando.
 *
 * Uso:
 *   node scripts/ci/verify-manifest-baseline-history.mjs           # exit 1 se ghost
 *   node scripts/ci/verify-manifest-baseline-history.mjs --json
 *
 * Rimedio quando fallisce: `--init --only <path>` scrive la baseline REALE
 * della sola voce indicata (issue #653), oppure si registra a mano l'hash del
 * blob a cui quel lato era davvero allineato ad `alignedAt`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256 } from './loop-drift-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_REL = 'scripts/ci/loop-sync-manifest.json';
const JSON_OUT = process.argv.includes('--json');

/**
 * Il verdetto, PURO: niente disco, niente git, niente rete — e' questo a
 * renderlo testabile offline come `ghostVerdict` e `classify`.
 *
 * @param {object} a
 * @param {Array<object>} a.files        le voci del manifest.
 * @param {Map<string, Set<string>>|object} a.blobsByPath  per ogni path, gli
 *   hash (sha256/16) di TUTTI i blob mai esistiti a quel path nella storia.
 *   Un path assente = nessuna revisione conosciuta.
 * @returns {{checked: number, verified: number, skipped: number,
 *            ghosts: Array<{path: string, side: 'corpus', hash: string, revisions: number}>,
 *            ok: boolean}}
 */
export function baselineHistoryVerdict({ files, blobsByPath }) {
  const lookup = (p) => {
    const v = blobsByPath instanceof Map ? blobsByPath.get(p) : blobsByPath?.[p];
    if (!v) return null;
    return v instanceof Set ? v : new Set(v);
  };
  const ghosts = [];
  let checked = 0;
  let skipped = 0;
  for (const entry of files || []) {
    const hash = entry?.baseline?.corpus;
    // `null` non e' un dato da verificare: la voce dichiara di non avere una
    // baseline su questo lato (`not-ported`), non un hash sbagliato.
    if (hash == null) {
      skipped += 1;
      continue;
    }
    checked += 1;
    const seen = lookup(entry.path);
    if (seen && seen.has(hash)) continue;
    // Zero revisioni note e' un ghost quanto un hash che non combacia: in
    // entrambi i casi il manifest dichiara come vero un blob che la storia del
    // path non ha mai contenuto. `revisions` distingue i due nel report.
    ghosts.push({ path: entry.path, side: 'corpus', hash, revisions: seen ? seen.size : 0 });
  }
  return { checked, verified: checked - ghosts.length, skipped, ghosts, ok: ghosts.length === 0 };
}

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28, ...opts }).toString();

/** true se il checkout non ha la storia intera: la verifica non sarebbe integrale. */
function isShallow() {
  try {
    return git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch {
    return true;
  }
}

/**
 * Gli hash di tutti i blob mai comparsi ai path dati, dalla storia locale.
 *
 * `rev-list --all --objects -- <paths>` enumera in UNA passata gli oggetti di
 * tutti i path insieme (ogni riga: `<oid> <path>`), e `cat-file --batch` ne
 * legge il contenuto in un solo processo: 330 voci e ~1800 blob stanno in poco
 * piu' di un secondo, contro le centinaia di richieste HTTP che costerebbe la
 * stessa domanda via API.
 *
 * @returns {Map<string, Set<string>>}
 */
function blobsByPathFromHistory(paths) {
  const byPath = new Map();
  if (paths.length === 0) return byPath;
  const want = new Set(paths);
  const listing = git(['rev-list', '--all', '--objects', '--', ...paths]);
  const oidToPaths = new Map();
  for (const line of listing.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const oid = line.slice(0, sp);
    const rel = line.slice(sp + 1);
    // `--objects` porta anche gli alberi dei path intermedi: si tengono solo
    // le righe che sono davvero uno dei file chiesti.
    if (!want.has(rel)) continue;
    if (!oidToPaths.has(oid)) oidToPaths.set(oid, new Set());
    oidToPaths.get(oid).add(rel);
  }
  if (oidToPaths.size === 0) return byPath;
  const res = spawnSync('git', ['cat-file', '--batch'], {
    cwd: ROOT,
    input: `${[...oidToPaths.keys()].join('\n')}\n`,
    maxBuffer: 1 << 30,
  });
  if (res.status !== 0) throw new Error(`git cat-file --batch: ${res.stderr?.toString() || res.status}`);
  const buf = res.stdout;
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(10, off);
    if (nl < 0) break;
    const [oid, , sizeStr] = buf.slice(off, nl).toString().split(' ');
    const size = Number(sizeStr);
    if (!Number.isFinite(size)) break;
    const hash = sha256(buf.slice(nl + 1, nl + 1 + size));
    for (const rel of oidToPaths.get(oid) || []) {
      if (!byPath.has(rel)) byPath.set(rel, new Set());
      byPath.get(rel).add(hash);
    }
    off = nl + 1 + size + 1; // header \n contenuto \n
  }
  return byPath;
}

/**
 * Seconda passata sulle sole voci che non hanno combaciato: `--follow` segue i
 * rinomini, che `rev-list -- <path>` per costruzione non vede. E' il solo caso
 * legittimo di mancato match, ed e' raro — quindi si paga un `git log` per voce
 * sospetta, non per tutte e 330.
 */
function blobsFollowingRenames(rel) {
  const hashes = new Set();
  let commits;
  try {
    commits = git(['log', '--follow', '--format=%H', '--', rel]).split('\n').filter(Boolean);
  } catch {
    return hashes;
  }
  for (const sha of commits) {
    const r = spawnSync('git', ['cat-file', 'blob', `${sha}:${rel}`], { cwd: ROOT, maxBuffer: 1 << 28 });
    if (r.status === 0) hashes.add(sha256(r.stdout));
  }
  return hashes;
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const files = manifest.files || [];
  if (isShallow()) {
    const msg =
      `${MANIFEST_REL}: storia non integrale (checkout shallow). ` +
      'La verifica delle baseline richiede `fetch-depth: 0`; senza, dichiarerebbe ' +
      'verificato cio\' che non ha letto.';
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, shallow: true, error: msg }, null, 2));
    else console.error(`❌ ${msg}`);
    process.exit(1);
  }

  const paths = files.filter((e) => e?.baseline?.corpus != null).map((e) => e.path);
  const blobsByPath = blobsByPathFromHistory(paths);
  let verdict = baselineHistoryVerdict({ files, blobsByPath });
  // I rinomini si pagano solo sui sospetti.
  for (const ghost of verdict.ghosts) {
    const extra = blobsFollowingRenames(ghost.path);
    if (extra.size === 0) continue;
    const merged = new Set([...(blobsByPath.get(ghost.path) || []), ...extra]);
    blobsByPath.set(ghost.path, merged);
  }
  verdict = baselineHistoryVerdict({ files, blobsByPath });

  if (JSON_OUT) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    console.log(
      `Baseline corpus verificate contro la storia locale: ${verdict.verified}/${verdict.checked} ` +
        `(${verdict.skipped} voci senza baseline.corpus).`
    );
    for (const g of verdict.ghosts) {
      console.error(
        `❌ ghost-baseline ${g.path}: \`baseline.corpus\` ${g.hash} non combacia con nessuna ` +
          `delle ${g.revisions} revisioni note di quel path.\n` +
          `   Rimedio: node scripts/ci/loop-drift-check.mjs --init --only ${g.path}, ` +
          'oppure registra l\'hash del blob reale ad `alignedAt`.'
      );
    }
  }
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
