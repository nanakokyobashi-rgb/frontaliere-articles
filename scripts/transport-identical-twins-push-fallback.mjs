#!/usr/bin/env node
/**
 * Piccolo helper corpus-only per il push del trasporto dei gemelli.
 *
 * Il preflight dello scope `workflows` e' solo un'indicazione: il push GitHub
 * resta l'autorita' finale. Se GitHub rifiuta esplicitamente un workflow per
 * permessi mancanti, il chiamante puo' togliere dal commit tutti i workflow e
 * lasciare gli altri gemelli nella stessa PR.
 */
import fs from 'node:fs';

const WORKFLOW_PREFIX = '.github/workflows/';
const ANSI_ESCAPE_RE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const WORKFLOW_REFUSAL_RE = /refusing\s+to\s+allow\s+a\s+GitHub\s+App\s+to\s+create\s+or\s+update\s+workflow\s+(?:(?<quote>[`'\"])(?<quotedPath>\.github\/workflows\/(?:\\[^\r\n]|(?!\k<quote>)[^\\\r\n])+)\k<quote>|(?<barePath>\.github\/workflows\/[^\s`'\"]+))\s+without\s+[`'\"]?workflows[`'\"]?\s+permission/gi;

const C_STYLE_ESCAPES = Object.freeze({
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  '"': '"',
  "'": "'",
});

/** Decode the C-style path quoting emitted by Git for unusual pathnames. */
function decodeGitQuotedPath(value) {
  const bytes = [];
  for (let index = 0; index < value.length;) {
    if (value[index] !== '\\') {
      const codePoint = value.codePointAt(index);
      const character = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(character));
      index += character.length;
      continue;
    }

    const rest = value.slice(index + 1);
    const octal = /^[0-7]{1,3}/.exec(rest)?.[0];
    if (octal) {
      const byte = Number.parseInt(octal, 8);
      if (byte > 0xff) return null;
      bytes.push(byte);
      index += 1 + octal.length;
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === undefined) return null;
    if (escaped && Object.prototype.hasOwnProperty.call(C_STYLE_ESCAPES, escaped)) {
      bytes.push(...Buffer.from(C_STYLE_ESCAPES[escaped]));
      index += 2;
      continue;
    }
    if (escaped === 'x' && /^[0-9a-f]{2}/i.test(rest.slice(1))) {
      bytes.push(Number.parseInt(rest.slice(1, 3), 16));
      index += 4;
      continue;
    }

    return null;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

export function isWorkflowPath(rel) {
  return typeof rel === 'string' && rel.startsWith(WORKFLOW_PREFIX) && rel.length > WORKFLOW_PREFIX.length;
}

function sortedUnique(paths) {
  return [...new Set(paths)].sort();
}

function hasUnrelatedRemoteError(output) {
  const text = String(output ?? '');
  const canonicalRanges = [...text.matchAll(WORKFLOW_REFUSAL_RE)].map((match) => {
    const end = (match.index ?? 0) + match[0].length;
    return [text.lastIndexOf('\n', match.index ?? 0) + 1, end];
  });
  return [...text.matchAll(/^\s*remote:\s*(?:error|fatal):/gim)].some((line) => {
    const start = line.index ?? 0;
    return !canonicalRanges.some(([from, to]) => start >= from && start < to);
  });
}

/** Classifica solo il rifiuto GitHub osservato; ogni altro errore resta rosso. */
export function classifyWorkflowPushFailure(output) {
  // Git may color remote errors. Remove terminal controls before matching while
  // preserving the acceptance call below for the canonical refusal signature.
  output = String(output ?? '').replace(ANSI_ESCAPE_RE, '');
  // A workflow-permission refusal is recoverable only when it is the sole
  // remote error. A mixed push log must stay fail-closed: falling back would
  // hide the second rejection and could publish an incomplete transport.
  if (hasUnrelatedRemoteError(output)) {
    return { kind: 'other', fallback: false, rejectedPaths: [] };
  }
  const rejectedPaths = [];
  for (const match of String(output ?? '').matchAll(WORKFLOW_REFUSAL_RE)) {
    const rawPath = match.groups?.quotedPath;
    const rel = rawPath === undefined
      ? match.groups?.barePath
      : decodeGitQuotedPath(rawPath);
    if (isWorkflowPath(rel)) rejectedPaths.push(rel);
  }
  const paths = sortedUnique(rejectedPaths);
  return paths.length
    ? { kind: 'workflow-permission', fallback: true, rejectedPaths: paths }
    : { kind: 'other', fallback: false, rejectedPaths: [] };
}

/**
 * Seleziona tutti i workflow presenti nel commit, non solo quello citato dal
 * primo rifiuto: con un token privo di quello scope il push li rifiuterebbe
 * uno alla volta. Un path rifiutato fuori dal commit invalida il fallback.
 */
export function selectWorkflowFallbackPaths(classification, committedPaths) {
  if (!classification?.fallback) return [];

  const commitPaths = sortedUnique(committedPaths);
  const workflowPaths = commitPaths.filter(isWorkflowPath);
  const rejectedPaths = sortedUnique(classification.rejectedPaths || []);
  if (!rejectedPaths.length) throw new Error('rifiuto workflow senza path esplicito');
  if (!workflowPaths.length) throw new Error('rifiuto workflow ma il commit non contiene workflow');

  const missing = rejectedPaths.filter((rel) => !workflowPaths.includes(rel));
  if (missing.length) {
    throw new Error(`path workflow rifiutati assenti dal commit: ${missing.join(', ')}`);
  }
  return workflowPaths;
}

function clone(value) {
  return structuredClone(value);
}

function assertManifestFiles(files, label) {
  if (!Array.isArray(files)) throw new Error(`manifest ${label} senza array files`);
  const seen = new Set();
  for (const [index, entry] of files.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error(`manifest ${label} con entry non-oggetto/path non valido all'indice ${index}`);
    }
    if (seen.has(entry.path)) {
      throw new Error(`manifest ${label} con voce duplicata per ${entry.path}`);
    }
    seen.add(entry.path);
  }
}

function restoreProperty(target, source, key) {
  if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = clone(source[key]);
  else delete target[key];
}

/**
 * Ripristina baseline/couplingSnapshot e appartenenza al manifest dei workflow
 * indicati, così il commit resta identico al parent anche per file nuovi o
 * rimossi, conservando l'ordine precedente relativo alle altre voci presenti.
 */
export function restoreWorkflowSnapshots(currentManifest, previousManifest, paths) {
  const workflowPaths = sortedUnique(paths);
  const invalid = workflowPaths.filter((rel) => !isWorkflowPath(rel));
  if (invalid.length) throw new Error(`fallback non autorizzato per path non workflow: ${invalid.join(', ')}`);

  const current = clone(currentManifest);
  assertManifestFiles(current?.files, 'corrente');
  assertManifestFiles(previousManifest?.files, 'precedente');
  const currentFiles = current.files;
  const previousFiles = previousManifest.files;
  const missingPreviousEntries = [];
  for (const rel of workflowPaths) {
    const nowEntries = currentFiles.filter((entry) => entry?.path === rel);
    const oldEntries = previousFiles.filter((entry) => entry?.path === rel);
    if (nowEntries.length > 1 || oldEntries.length > 1) {
      throw new Error(`manifest con voce workflow duplicata per ${rel}`);
    }
    if (!nowEntries.length && !oldEntries.length) {
      throw new Error(`manifest senza voce corrente/precedente per ${rel}`);
    }
    if (!nowEntries.length) {
      missingPreviousEntries.push({
        entry: oldEntries[0],
        index: previousFiles.indexOf(oldEntries[0]),
      });
      continue;
    }
    if (!oldEntries.length) {
      for (let index = currentFiles.length - 1; index >= 0; index -= 1) {
        if (currentFiles[index]?.path === rel) currentFiles.splice(index, 1);
      }
      continue;
    }
    restoreProperty(nowEntries[0], oldEntries[0], 'baseline');
    restoreProperty(nowEntries[0], oldEntries[0], 'couplingSnapshot');
  }

  missingPreviousEntries.sort((left, right) => left.index - right.index);
  for (const { entry, index } of missingPreviousEntries) {
    const nextExisting = previousFiles
      .slice(index + 1)
      .find((previousEntry) => currentFiles.some(({ path }) => path === previousEntry.path));
    let insertionIndex = nextExisting
      ? currentFiles.findIndex(({ path }) => path === nextExisting.path)
      : -1;

    if (insertionIndex < 0) {
      const previousExisting = previousFiles
        .slice(0, index)
        .reverse()
        .find((previousEntry) => currentFiles.some(({ path }) => path === previousEntry.path));
      insertionIndex = previousExisting
        ? currentFiles.findIndex(({ path }) => path === previousExisting.path) + 1
        : Math.min(index, currentFiles.length);
    }
    currentFiles.splice(insertionIndex, 0, clone(entry));
  }
  return current;
}

/** Toglie dal report solo i workflow rimossi dal commit e li rende espliciti. */
export function removeWorkflowPathsFromReport(report, paths) {
  const workflowPaths = sortedUnique(paths);
  const invalid = workflowPaths.filter((rel) => !isWorkflowPath(rel));
  if (invalid.length) throw new Error(`report fallback non autorizzato per path non workflow: ${invalid.join(', ')}`);
  const excluded = new Set(report.workflowExcluded || []);
  for (const rel of workflowPaths) excluded.add(rel);
  const excludedSet = new Set(workflowPaths);
  return {
    ...clone(report),
    transported: (report.transported || []).filter((item) => !excludedSet.has(item.path)),
    workflowExcluded: sortedUnique([...excluded]),
  };
}

function requiredArg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`manca --${name}=...`);
  return value;
}

export function readLines(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      if (!(line.startsWith('"') && line.endsWith('"'))) return line;
      const decoded = decodeGitQuotedPath(line.slice(1, -1));
      if (decoded === null) throw new Error(`pathname Git C-quotata non decodificabile: ${line}`);
      return decoded;
    });
}

function writeJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function prepareFallback() {
  const classification = classifyWorkflowPushFailure(fs.readFileSync(requiredArg('push-log'), 'utf8'));
  if (!classification.fallback) {
    console.log(JSON.stringify(classification, null, 2));
    return 2;
  }

  const commitPaths = readLines(requiredArg('commit-paths'));
  const workflowPaths = selectWorkflowFallbackPaths(classification, commitPaths);
  const manifestFile = requiredArg('manifest');
  const previousManifestFile = requiredArg('previous-manifest');
  const reportFile = requiredArg('report');
  const currentManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const previousManifest = JSON.parse(fs.readFileSync(previousManifestFile, 'utf8'));
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const restoredManifest = restoreWorkflowSnapshots(currentManifest, previousManifest, workflowPaths);
  const updatedReport = removeWorkflowPathsFromReport(report, workflowPaths);

  writeJson(manifestFile, restoredManifest);
  writeJson(reportFile, updatedReport);
  console.log(JSON.stringify({ ...classification, excludedPaths: workflowPaths }, null, 2));
  return 0;
}

if (process.argv[1]?.endsWith('transport-identical-twins-push-fallback.mjs')) {
  try {
    process.exit(prepareFallback());
  } catch (error) {
    console.error(`transport-identical-twins-push-fallback fallito: ${error?.stack || error}`);
    process.exit(1);
  }
}
