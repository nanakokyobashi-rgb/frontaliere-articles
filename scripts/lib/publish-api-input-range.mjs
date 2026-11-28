import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, TextDecoder } from 'node:util';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLISH_API_WORKFLOW = '.github/workflows/publish-api.yml';
const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const CANTON_REGISTRY = 'generator/data/canton-sections.json';
const MAX_GIT_OUTPUT = 1024 * 1024;
const MAX_SOURCE_ONLY_COMMITS = 16;
const PUBLISH_API_BOOKKEEPING_PATHS = new Set([
  'data/blog-cover-cdn-sync-queue.json',
]);

/**
 * Legge i path del trigger API dal suo stesso YAML: il fallback a una release
 * gia' pubblicata non puo' mantenere una lista parallela che invecchia.
 *
 * Il workflow non viene passato a un parser YAML perche' questo modulo gira
 * senza dipendenze npm. Si legge pero' la struttura reale on.push.paths,
 * calcolando l'indentazione dei figli invece di assumere quella di una
 * particolare versione del file.
 */
export function publishApiTriggerPaths({ workflowText = null } = {}) {
  const workflow = workflowText ?? fs.readFileSync(path.join(ROOT_DIR, PUBLISH_API_WORKFLOW), 'utf8');
  const lines = workflow.split(/\r?\n/u);
  const leadingSpaces = (line) => line.match(/^ */u)?.[0].length ?? -1;
  const isIgnorable = (line) => line.trim() === '' || /^\s*#/u.test(line);
  const keyAt = (line, indent, key) => new RegExp('^ {' + indent + '}' + key + ':\\s*(?:#.*)?$', 'u').test(line);

  const onAt = lines.findIndex((line) => keyAt(line, leadingSpaces(line), 'on') && leadingSpaces(line) === 0);
  if (onAt < 0) throw new Error('trigger on assente in ' + PUBLISH_API_WORKFLOW);
  const onIndent = leadingSpaces(lines[onAt]);
  const pushAt = lines.findIndex((line, index) => {
    if (index <= onAt || isIgnorable(line)) return false;
    const indent = leadingSpaces(line);
    if (indent >= 0 && indent <= onIndent) return false;
    return keyAt(line, indent, 'push');
  });
  if (pushAt < 0) throw new Error('trigger push assente in ' + PUBLISH_API_WORKFLOW);
  const pushIndent = leadingSpaces(lines[pushAt]);

  let pathsAt = -1;
  let pathsIndent = -1;
  let pushChildIndent = -1;
  for (let index = pushAt + 1; index < lines.length; index++) {
    const line = lines[index];
    if (isIgnorable(line)) continue;
    const indent = leadingSpaces(line);
    if (indent <= pushIndent) break;
    pushChildIndent = pushChildIndent < 0 ? indent : pushChildIndent;
    if (indent === pushChildIndent && keyAt(line, indent, 'paths')) {
      pathsAt = index;
      pathsIndent = indent;
      break;
    }
  }
  if (pathsAt < 0) throw new Error('trigger push.paths assente in ' + PUBLISH_API_WORKFLOW);

  const paths = [];
  let itemIndent = -1;
  for (let index = pathsAt + 1; index < lines.length; index++) {
    const line = lines[index];
    if (isIgnorable(line)) continue;
    const indent = leadingSpaces(line);
    if (indent <= pathsIndent) break;
    itemIndent = itemIndent < 0 ? indent : itemIndent;
    if (indent !== itemIndent) {
      throw new Error('trigger push.paths malformato in ' + PUBLISH_API_WORKFLOW);
    }
    const item = new RegExp("^ {" + itemIndent + "}-\\s+(['\"])([^'\"]+)\\1\\s*(?:#.*)?$", 'u').exec(line);
    if (!item) throw new Error('voce trigger push.paths malformata in ' + PUBLISH_API_WORKFLOW);
    paths.push(item[2]);
  }
  if (paths.length === 0) throw new Error('trigger paths assenti in ' + PUBLISH_API_WORKFLOW);
  return paths;
}

/**
 * Paths whose changes supersede an active publish run. Bookkeeping commits
 * listed in the trigger still use `[skip ci]`, so they must not invalidate the
 * queued run that is responsible for publishing the accompanying API input.
 */
export function publishApiFreshnessPaths({ triggerPathsImpl = publishApiTriggerPaths } = {}) {
  return triggerPathsImpl()
    .filter((triggerPath) => !PUBLISH_API_BOOKKEEPING_PATHS.has(triggerPath));
}

function validatePaths(paths) {
  if (paths.some((entry) => typeof entry !== 'string' ||
    !/^[\w.*?/-]+$/u.test(entry) ||
    entry.split('/').some((part) => !part || part === '.' || part === '..'))) {
    throw new Error('path non valido per il confronto degli input API');
  }
}

function readGit(exec, args, encoding = 'utf8') {
  try {
    return exec('git', ['-C', ROOT_DIR, ...args], {
      encoding, timeout: 3000, maxBuffer: MAX_GIT_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('lettura Git non verificabile per gli input API (' + args[0] + ')');
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

function parseRegistry(blob) {
  // Preserve a leading BOM so JSON.parse rejects it as the registry consumer does.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(blob);
  const document = JSON.parse(text);
  // JSON.parse can silently collapse duplicate keys and round numeric literals.
  // Check the tokens of the already validated JSON before trusting its shape.
  const objects = [];
  for (const [token, quoted, keySeparator] of text.matchAll(/("(?:[^"\\]|\\[\s\S])*")(\s*:)?|[{}\[\]]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu)) {
    if (token === '{') objects.push(new Set());
    else if (token === '[') objects.push(null);
    else if (token === '}' || token === ']') objects.pop();
    else if (token.startsWith('"') && keySeparator !== undefined) {
      const keys = objects.at(-1);
      const key = JSON.parse(quoted);
      if (keys.has(key)) return null;
      keys.add(key);
    } else if (!token.startsWith('"') && (!Number.isFinite(Number(token)) || String(Number(token)) !== token)) {
      return null;
    }
  }
  if (!isObject(document) || !Array.isArray(document.cantons) || !document.cantons.length) return null;
  const codes = new Set();
  const sections = new Set();
  for (const canton of document.cantons) {
    if (!isObject(canton) || !isNonEmptyString(canton.code) || !isNonEmptyString(canton.section) ||
      codes.has(canton.code.trim()) || sections.has(canton.section.trim()) ||
      typeof canton.enabled !== 'boolean' || !Array.isArray(canton.newsSources) ||
      !canton.newsSources.every((source) => isObject(source) && isNonEmptyString(source.url))) {
      return null;
    }
    codes.add(canton.code.trim());
    sections.add(canton.section.trim());
  }
  return document;
}

function withoutNewsSources(document) {
  return { ...document, cantons: document.cantons.map(({ newsSources, ...canton }) => canton) };
}

function readRegistry(exec, commit) {
  const entry = readGit(exec, ['ls-tree', '-z', commit, '--', CANTON_REGISTRY]);
  const [mode, type, object] = entry.split(/[ \t]/u);
  if ((mode !== '100644' && mode !== '100755') || type !== 'blob' ||
    !FULL_GIT_SHA_RE.test(object ?? '')) return null;
  const blob = readGit(exec, ['cat-file', 'blob', object], 'buffer');
  if (blob.length > MAX_GIT_OUTPUT) return null;
  try {
    const document = parseRegistry(blob);
    return document && { mode, document };
  } catch {
    return null;
  }
}

function diffApiInputs(exec, before, after, paths) {
  const changed = readGit(exec, [
    'diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none',
    before, after, '--', ...paths,
  ]);
  if (changed === '') return 'none';
  if (!paths.includes(CANTON_REGISTRY) || changed !== CANTON_REGISTRY + '\0') return 'api';
  const previous = readRegistry(exec, before);
  const current = readRegistry(exec, after);
  if (!previous || !current || previous.mode !== current.mode) return 'api';
  return !isDeepStrictEqual(previous.document, current.document) &&
    JSON.stringify(withoutNewsSources(previous.document)) === JSON.stringify(withoutNewsSources(current.document))
    ? 'sources' : 'api';
}

/**
 * Compare the two pinned trees after verifying a fast-forward range.
 * Intermediate commits do not affect this guard.
 */
export function apiTriggerInputsDifferBetween(
  { before, after },
  { execFileSyncImpl = execFileSync, triggerPathsImpl = publishApiTriggerPaths } = {},
) {
  if (!FULL_GIT_SHA_RE.test(before ?? '') || !FULL_GIT_SHA_RE.test(after ?? '')) {
    throw new Error('commit non valido per il confronto degli input API');
  }
  const paths = publishApiFreshnessPaths({ triggerPathsImpl });
  if (paths.length === 0) throw new Error('nessun path da confrontare per gli input API');
  validatePaths(paths);
  readGit(execFileSyncImpl, ['merge-base', '--is-ancestor', before, after]);
  return diffApiInputs(execFileSyncImpl, before, after, paths) === 'api';
}

/**
 * Path del trigger che sono DATI: un loro cambio non altera il codice ne' il
 * workflow con cui una run costruisce e pubblica. Tutto cio' che e' nel trigger
 * e non combacia qui e' CODICE (scripts/**, .github/**, generator/scripts/**,
 * engine/**, host/**, articleSections.ts, generator/data/*.mjs, ...): per
 * default un path ignoto vale codice, cosi' una nuova voce del trigger non
 * puo' essere scambiata per un dato.
 */
const PUBLISH_API_DATA_PATH_RES = [
  /^content\//u,
  /^data\//u,
  /^public\/images\//u,
  /^sections\//u,
  /^generator\/data\/[^/]+\.json$/u,
  /^scripts\/ci\/excerpt-completeness-baseline\.json$/u,
];

export function isPublishApiDataPath(file) {
  return PUBLISH_API_DATA_PATH_RES.some((re) => re.test(file));
}

/**
 * True se tra `before` e `after` cambia almeno un path del trigger che e'
 * CODICE (non dato). Serve a decidere se una run non-replay puo' ritargettare
 * la sorgente su main (solo dati cambiati) o deve cedere il posto alla run
 * della nuova push (codice o workflow cambiati).
 */
export function apiTriggerCodeDiffersBetween(
  { before, after },
  { execFileSyncImpl = execFileSync, triggerPathsImpl = publishApiTriggerPaths } = {},
) {
  if (!FULL_GIT_SHA_RE.test(before ?? '') || !FULL_GIT_SHA_RE.test(after ?? '')) {
    throw new Error('commit non valido per il confronto degli input API');
  }
  const paths = publishApiFreshnessPaths({ triggerPathsImpl });
  if (paths.length === 0) throw new Error('nessun path da confrontare per gli input API');
  validatePaths(paths);
  readGit(execFileSyncImpl, ['merge-base', '--is-ancestor', before, after]);
  const changed = readGit(execFileSyncImpl, [
    'diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none',
    before, after, '--', ...paths,
  ]);
  return changed.split('\0').filter(Boolean).some((file) => !isPublishApiDataPath(file));
}

function findApiInput(exec, head, paths, base = null) {
  const revisions = base ? ['^' + base] : [];
  const historyArgs = (start) => ['rev-list', '--max-count=1', start, ...revisions, '--', ...paths];
  if (!paths.includes(CANTON_REGISTRY)) {
    return String(exec('git', ['-C', ROOT_DIR, ...historyArgs(head)], { encoding: 'utf8' }) ?? '').trim() || null;
  }
  validatePaths(paths);
  if (!FULL_GIT_SHA_RE.test(head)) throw new Error('commit publisher non valido');
  let start = head;
  for (let skipped = 0; ; skipped++) {
    // Follow main's first-parent history so a merge that takes a side
    // branch's tree still counts when it changes the inputs on main.
    const candidate = readGit(exec, [
      'rev-list', '--first-parent', '--full-history', '--max-count=1', start, ...revisions, '--', ...paths,
    ]).trim();
    if (!candidate) return null;
    if (!FULL_GIT_SHA_RE.test(candidate)) throw new Error('commit candidato non valido');
    if (skipped === MAX_SOURCE_ONLY_COMMITS) return candidate;
    const [commit, ...parents] = readGit(exec, ['rev-list', '--parents', '--max-count=1', candidate]).trim().split(' ');
    if (commit !== candidate || parents.length !== 1 || !FULL_GIT_SHA_RE.test(parents[0])) return candidate;
    if (diffApiInputs(exec, parents[0], candidate, paths) !== 'sources') return candidate;
    start = parents[0];
  }
}

/**
 * L'ultimo input di publish-api raggiungibile dal commit del publisher.
 */
export function latestApiInputCommit(
  publisherCommit,
  { execFileSyncImpl = execFileSync, triggerPathsImpl = publishApiTriggerPaths } = {},
) {
  const commit = String(publisherCommit ?? '').trim();
  if (!commit) throw new Error('commit publisher assente: impossibile classificare gli input API');
  const triggerPaths = publishApiFreshnessPaths({ triggerPathsImpl });
  if (triggerPaths.length === 0) return null;
  try {
    return findApiInput(execFileSyncImpl, commit, triggerPaths);
  } catch (error) {
    throw new Error(
      'storia Git non verificabile per gli input API raggiungibili da ' + commit + ': ' + (error?.message ?? String(error)),
      { cause: error },
    );
  }
}

/**
 * Indica se l'intervallo della push/run contiene almeno un input di
 * publish-api. Il commit piu' recente nella storia non basta: una push puo'
 * contenere input API e bookkeeping nello stesso intervallo.
 */
export function apiInputChangedInRange(
  { before, after },
  { execFileSyncImpl = execFileSync, triggerPathsImpl = publishApiTriggerPaths } = {},
) {
  const base = String(before ?? '').trim();
  const head = String(after ?? '').trim();
  if (!base || !head) return false;
  if (!FULL_GIT_SHA_RE.test(head)) throw new Error('HEAD della push non valida: ' + head);
  const isCreation = /^0+$/.test(base);
  if (!isCreation && !FULL_GIT_SHA_RE.test(base)) {
    throw new Error('base della push non valida: ' + base);
  }
  const triggerPaths = publishApiFreshnessPaths({ triggerPathsImpl });
  // With no pathspec, rev-list would classify every commit as an API input.
  if (triggerPaths.length === 0) return false;
  try {
    if (!isCreation && triggerPaths.includes(CANTON_REGISTRY)) {
      // A published pin on a merge's side branch can differ from main
      // even when the merge kept its first parent's tree.
      validatePaths(triggerPaths);
      if (diffApiInputs(execFileSyncImpl, base, head, triggerPaths) === 'api') return true;
    }
    return Boolean(findApiInput(execFileSyncImpl, head, triggerPaths, isCreation ? null : base));
  } catch (error) {
    throw new Error(
      'intervallo Git non verificabile per gli input API ' + base + '..' + head + ': ' + (error?.message ?? String(error)),
      { cause: error },
    );
  }
}
