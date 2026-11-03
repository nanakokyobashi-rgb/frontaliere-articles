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
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256 } from './loop-drift-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_REL = 'scripts/ci/loop-sync-manifest.json';
const JSON_OUT = process.argv.includes('--json');
export const CANONICAL_HISTORY_REF = 'origin/main';
export const CURRENT_HISTORY_REF = 'HEAD';
// La storia dei path produce oltre un gigabyte di blob nel checkout completo.
// Il protocollo batch resta un'unica sessione Git e il parser consuma stdout a
// chunk: nessun processo riparte per ogni gruppo e nessun buffer deve
// contenere l'intera risposta.
const CAT_FILE_STDERR_MAX_BYTES = 1 << 20;
const CAT_FILE_STREAM_CHUNK_BYTES = 1 << 20;

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

/** true se git deve poter chiedere blob mancanti al promisor remoto. */
export function isPartialClone(cwd = ROOT) {
  for (const args of [
    ['config', '--get', 'extensions.partialclone'],
    ['config', '--get-regexp', '^remote\\..*\\.promisor$'],
  ]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status === 0 && String(result.stdout || '').trim()) return true;
  }
  return false;
}

/** Associa ogni commit del log `--follow` al path che aveva in quel commit. */
export function parseFollowHistory(output) {
  const entries = [];
  let sha = null;
  for (const line of String(output).split(/\r?\n/)) {
    if (!line) continue;
    if (/^[0-9a-f]{40}$/i.test(line)) {
      sha = line;
      continue;
    }
    if (!sha) continue;
    entries.push({ sha, path: line });
  }
  return entries;
}

/** true solo per un path che non esisteva ancora in quel commit storico. */
export function isExpectedMissingHistoricalPath(stderr) {
  return /path '.+' (?:does not exist in|exists on disk, but not in) '.+'/.test(String(stderr));
}

/** true per un oggetto che git non ha potuto leggere dal promisor. */
export function isLazyFetchFailure(stderr) {
  return /(?:\boid\s+missing\b|\bpromisor\b|\blazy[- ]?fetch\b|\b(?:could not|unable to)\s+(?:fetch|read)\b|\bnot a valid object name\b)/i.test(
    String(stderr),
  );
}

/**
 * Decodifica l'output di `git cat-file --batch` senza trasformare una lettura
 * interrotta in una mappa parziale. Un output `missing`, `ambiguous` o
 * troncato e' un errore del verificatore, non una storia senza revisioni. In
 * un clone partial/promisor, pero', `missing` puo' significare che il
 * lazy-fetch non ha consegnato il blob: con `allowMissing` la lettura torna
 * inconclusiva e il chiamante non la trasforma in un ghost.
 *
 * @param {Buffer} buf
 * @param {Map<string, Set<string>>} oidToPaths
 * @param {{allowMissing?: boolean}} [options]
 * @returns {Map<string, Set<string>>|null} null = lettura inconclusiva.
 */
function parseCatFileBatchHeader(header, oidToPaths, allowMissing) {
  const [oid, type, sizeStr] = header.split(' ');
  if (type === 'missing') {
    if (allowMissing) return null;
    throw new Error(`git cat-file --batch: ${header}`);
  }
  if (type === 'ambiguous') {
    throw new Error(`git cat-file --batch: ${header}`);
  }
  if (type !== 'blob' || !/^\d+$/.test(sizeStr || '')) {
    throw new Error(`git cat-file --batch: header non parsabile: ${header || '(vuoto)'}`);
  }
  if (!oidToPaths.has(oid)) {
    throw new Error(`git cat-file --batch: oid inatteso: ${oid}`);
  }
  const size = Number(sizeStr);
  if (!Number.isSafeInteger(size)) {
    throw new Error(`git cat-file --batch: dimensione non parsabile per ${oid}: ${sizeStr}`);
  }
  return { oid, size };
}

function addCatFileHash(byPath, oidToPaths, oid, hash) {
  for (const rel of oidToPaths.get(oid) || []) {
    if (!byPath.has(rel)) byPath.set(rel, new Set());
    byPath.get(rel).add(hash);
  }
}

export function parseCatFileBatchOutput(buf, oidToPaths, { allowMissing = false } = {}) {
  const byPath = new Map();
  if (!oidToPaths || oidToPaths.size === 0) return byPath;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new Error('git cat-file --batch: stdout troncato o vuoto');
  }

  let off = 0;
  const seenOids = new Set();
  while (off < buf.length) {
    const nl = buf.indexOf(10, off);
    if (nl < 0) throw new Error('git cat-file --batch: stdout troncato (header senza newline)');
    const header = buf.slice(off, nl).toString();
    const parsed = parseCatFileBatchHeader(header, oidToPaths, allowMissing);
    if (parsed === null) return null;
    const { oid, size } = parsed;
    const contentStart = nl + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= buf.length || buf[contentEnd] !== 10) {
      throw new Error(`git cat-file --batch: contenuto troncato per ${oid}`);
    }
    seenOids.add(oid);
    addCatFileHash(byPath, oidToPaths, oid, sha256(buf.slice(contentStart, contentEnd)));
    off = contentEnd + 1;
  }
  if (seenOids.size !== oidToPaths.size) {
    const missing = [...oidToPaths.keys()].filter((oid) => !seenOids.has(oid));
    throw new Error(`git cat-file --batch: stdout troncato; nessuna risposta per ${missing.join(', ')}`);
  }
  return byPath;
}

/**
 * La stessa decodifica, ma senza pretendere che stdout sia contenibile in un
 * Buffer. `git cat-file --batch` può restituire oltre un gigabyte per questo
 * manifest; il parser incrementale conserva i confini del protocollo e fa
 * l'hash di ogni blob mentre arriva.
 *
 * @param {AsyncIterable<Buffer|string>} chunks stdout del processo Git.
 * @param {Map<string, Set<string>>} oidToPaths
 * @param {{allowMissing?: boolean}} [options]
 * @returns {Promise<Map<string, Set<string>>|null>} null = lettura inconclusiva.
 */
export async function parseCatFileBatchStream(chunks, oidToPaths, { allowMissing = false } = {}) {
  const byPath = new Map();
  if (!oidToPaths || oidToPaths.size === 0) return byPath;

  const seenOids = new Set();
  let mode = 'header';
  let header = '';
  let currentOid = null;
  let remaining = 0;
  let hash = null;

  for await (const rawChunk of chunks) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let off = 0;
    while (off < chunk.length) {
      if (mode === 'header') {
        const nl = chunk.indexOf(10, off);
        if (nl < 0) {
          header += chunk.subarray(off).toString();
          if (header.length > 4096) {
            throw new Error('git cat-file --batch: header senza newline');
          }
          break;
        }
        header += chunk.subarray(off, nl).toString();
        off = nl + 1;
        const parsed = parseCatFileBatchHeader(header, oidToPaths, allowMissing);
        if (parsed === null) return null;
        currentOid = parsed.oid;
        remaining = parsed.size;
        hash = createHash('sha256');
        header = '';
        mode = remaining === 0 ? 'separator' : 'content';
        continue;
      }

      if (mode === 'content') {
        const take = Math.min(remaining, chunk.length - off);
        hash.update(chunk.subarray(off, off + take));
        off += take;
        remaining -= take;
        if (remaining === 0) mode = 'separator';
        continue;
      }

      if (chunk[off] !== 10) {
        throw new Error(`git cat-file --batch: contenuto troncato per ${currentOid}`);
      }
      off += 1;
      seenOids.add(currentOid);
      addCatFileHash(byPath, oidToPaths, currentOid, hash.digest('hex').slice(0, 16));
      currentOid = null;
      hash = null;
      mode = 'header';
    }
  }

  if (mode !== 'header' || header) {
    throw new Error('git cat-file --batch: stdout troncato');
  }
  if (seenOids.size === 0) {
    throw new Error('git cat-file --batch: stdout troncato o vuoto');
  }
  if (seenOids.size !== oidToPaths.size) {
    const missing = [...oidToPaths.keys()].filter((oid) => !seenOids.has(oid));
    throw new Error(`git cat-file --batch: stdout troncato; nessuna risposta per ${missing.join(', ')}`);
  }
  return byPath;
}

/**
 * I commit raggiungibili da HEAD ma non da `origin/main`: i commit propri del
 * branch. Su `main` (HEAD == origin/main) l'insieme e' vuoto.
 *
 * Esistono solo finche' la PR e' aperta: lo squash li sostituisce con UN
 * commit il cui albero e' quello di HEAD. Un blob che vive soltanto in uno di
 * loro non arriva mai su `main`, quindi non puo' attestare una baseline
 * (issue 1610: la PR 2090 ha attestato `reconcile-conflict-handoffs.mjs` sul
 * blob di un commit intermedio, verde sulla PR e `ghost-baseline` su main).
 */
export function branchOnlyCommits({ cwd = ROOT } = {}) {
  return new Set(
    git(['rev-list', `${CANONICAL_HISTORY_REF}..${CURRENT_HISTORY_REF}`], { cwd })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function catFileBatch(oidToPaths, { cwd, partialClone }) {
  const child = spawn('git', ['-c', 'core.quotePath=false', 'cat-file', '--batch'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (stderr.length < CAT_FILE_STDERR_MAX_BYTES) {
      stderr += chunk.slice(0, CAT_FILE_STDERR_MAX_BYTES - stderr.length);
    }
  });
  // A process that exits before consuming all input can close stdin while the
  // request is being written. The exit result below remains the authority for
  // the actual diagnostic; this listener prevents an unhandled stream error.
  child.stdin.on('error', () => {});

  const exit = new Promise((resolve) => {
    let settled = false;
    child.once('error', (error) => {
      settled = true;
      resolve({ error });
    });
    child.once('close', (code, signal) => {
      if (!settled) resolve({ code, signal });
    });
  });

  child.stdin.end(`${[...oidToPaths.keys()].join('\n')}\n`);
  let parsed;
  try {
    parsed = await parseCatFileBatchStream(child.stdout, oidToPaths, { allowMissing: partialClone });
  } catch (error) {
    if (!child.killed) child.kill();
    await exit;
    throw error;
  }

  if (parsed === null) {
    if (!child.killed) child.kill();
    await exit;
    return null;
  }

  const result = await exit;
  const diagnostic = [
    stderr.trim(),
    result.error?.message || '',
    result.signal ? `signal ${result.signal}` : '',
  ].filter(Boolean).join('; ');
  if (result.error || result.code !== 0) {
    if (partialClone && isLazyFetchFailure(diagnostic)) return null;
    throw new Error(`git cat-file --batch: ${diagnostic || result.code}`);
  }
  return parsed;
}

/**
 * Gli hash dei blob che `main` avra' contenuto ai path dati DOPO il merge:
 * l'intera storia di `origin/main` piu' l'albero FINALE di HEAD.
 *
 * Non la storia di HEAD: sulla PR conterrebbe anche i commit intermedi del
 * branch, che lo squash scarta. Prima della issue 1610 qui c'era
 * `rev-list HEAD origin/main`, e il verdetto della PR differiva da quello di
 * `main` proprio sulle baseline attestate a meta' PR. Su `main` (HEAD ==
 * origin/main) l'insieme e' identico a prima.
 *
 * @returns {Map<string, Set<string>>|null} null = lettura inconclusiva.
 */
export async function blobsByPathFromHistory(paths, { cwd = ROOT, partialClone = isPartialClone(cwd) } = {}) {
  if (paths.length === 0) return new Map();
  const want = new Set(paths);
  const oidToPaths = new Map();
  const remember = (oid, rel) => {
    // `--objects` porta anche gli alberi dei path intermedi: si tengono solo
    // le righe che sono davvero uno dei file chiesti.
    if (!want.has(rel)) return;
    if (!oidToPaths.has(oid)) oidToPaths.set(oid, new Set());
    oidToPaths.get(oid).add(rel);
  };
  const listing = git([
    '-c', 'core.quotePath=false', 'rev-list', '--full-history',
    CANONICAL_HISTORY_REF, '--objects', '--', ...paths,
  ], { cwd });
  for (const line of listing.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    remember(line.slice(0, sp), line.slice(sp + 1));
  }
  // L'albero di HEAD e' cio' che lo squash porta su `main`: basta il tree, il
  // blob si legge sotto con lo stesso `cat-file --batch`.
  const tree = git([
    '-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', CURRENT_HISTORY_REF, '--', ...paths,
  ], { cwd });
  for (const record of tree.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [, type, oid] = record.slice(0, tab).split(' ');
    if (type !== 'blob') continue;
    remember(oid, record.slice(tab + 1));
  }
  if (oidToPaths.size === 0) return new Map();
  return catFileBatch(oidToPaths, { cwd, partialClone });
}

/**
 * Seconda passata sulle sole voci che non hanno combaciato: `--follow` segue i
 * rinomini, che `rev-list -- <path>` per costruzione non vede. E' il solo caso
 * legittimo di mancato match, ed e' raro — quindi si paga un `git log` per voce
 * sospetta, non per tutte e 330.
 */
export function blobsFollowingRenames(rel, { cwd = ROOT, partialClone = isPartialClone(cwd) } = {}) {
  const hashes = new Set();
  const seen = new Set();
  // HEAD si segue ancora, perche' su una PR che rinomina e' l'unica storia
  // che conosce il nome nuovo; ma i commit propri del branch si scartano per
  // la stessa ragione di `blobsByPathFromHistory` — l'albero finale di HEAD
  // e' gia' stato letto dalla prima passata.
  const branchOnly = branchOnlyCommits({ cwd });
  for (const ref of new Set([CURRENT_HISTORY_REF, CANONICAL_HISTORY_REF])) {
    let commits;
    try {
      commits = parseFollowHistory(
        git(['-c', 'core.quotePath=false', 'log', '--follow', '--format=%H', '--name-only', ref, '--', rel], { cwd }),
      );
    } catch (error) {
      const diagnostic = error?.stderr ?? error?.message ?? '';
      if (partialClone && isLazyFetchFailure(diagnostic)) return null;
      continue;
    }
    for (const { sha, path: historicalPath } of commits) {
      if (branchOnly.has(sha)) continue;
      const key = `${sha}\0${historicalPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = spawnSync(
        'git',
        ['-c', 'core.quotePath=false', 'cat-file', 'blob', `${sha}:${historicalPath}`],
        { cwd, maxBuffer: 1 << 28 },
      );
      if (r.status === 0) hashes.add(sha256(r.stdout));
      else if (isExpectedMissingHistoricalPath(r.stderr)) continue;
      else if (partialClone && isLazyFetchFailure(r.stderr)) return null;
      else {
        throw new Error(`git cat-file blob ${sha}:${historicalPath}: ${r.stderr?.toString() || r.status}`);
      }
    }
  }
  return hashes;
}

function reportInconclusive(message) {
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: false, inconclusive: true, reason: message }, null, 2));
  } else {
    console.error(`⚠️ ${message}`);
  }
  // Un lazy-fetch non consegnato non e' una verifica verde: il workflow deve
  // fermarsi prima di trattare una baseline non letta come attestata.
  process.exitCode = 1;
}

async function main() {
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
  const partialClone = isPartialClone();
  const blobsByPath = await blobsByPathFromHistory(paths, { partialClone });
  if (blobsByPath === null) {
    reportInconclusive(
      `${MANIFEST_REL}: lettura inconclusiva in clone partial/promisor: un lazy-fetch di un blob storico non ha risposto; ` +
      'nessuna baseline viene classificata come ghost.',
    );
    return;
  }
  let verdict = baselineHistoryVerdict({ files, blobsByPath });
  // I rinomini si pagano solo sui sospetti.
  for (const ghost of verdict.ghosts) {
    const extra = blobsFollowingRenames(ghost.path, { partialClone });
    if (extra === null) {
      reportInconclusive(
        `${MANIFEST_REL}: lettura inconclusiva in clone partial/promisor durante la passata sui rinomini; ` +
        'nessuna baseline viene classificata come ghost.',
      );
      return;
    }
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
