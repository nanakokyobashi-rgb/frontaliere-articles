import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLISH_API_WORKFLOW = '.github/workflows/publish-api.yml';
const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
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

function publishApiInputPaths(triggerPathsImpl) {
  return triggerPathsImpl()
    .filter((triggerPath) => !PUBLISH_API_BOOKKEEPING_PATHS.has(triggerPath));
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
  const triggerPaths = publishApiInputPaths(triggerPathsImpl);
  if (triggerPaths.length === 0) return null;
  try {
    const latest = execFileSyncImpl(
      'git',
      ['-C', ROOT_DIR, 'rev-list', '--max-count=1', commit, '--', ...triggerPaths],
      { encoding: 'utf8' },
    );
    return String(latest ?? '').trim() || null;
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
  if (!/^0+$/.test(base) && !FULL_GIT_SHA_RE.test(base)) {
    throw new Error('base della push non valida: ' + base);
  }
  const triggerPaths = publishApiInputPaths(triggerPathsImpl);
  // With no pathspec, rev-list would classify every commit as an API input.
  if (triggerPaths.length === 0) return false;
  const args = ['-C', ROOT_DIR, 'rev-list', '--max-count=1', head];
  if (!/^0+$/.test(base)) args.push('^' + base);
  args.push('--', ...triggerPaths);
  try {
    const latest = execFileSyncImpl('git', args, { encoding: 'utf8' });
    return Boolean(String(latest ?? '').trim());
  } catch (error) {
    throw new Error(
      'intervallo Git non verificabile per gli input API ' + base + '..' + head + ': ' + (error?.message ?? String(error)),
      { cause: error },
    );
  }
}
