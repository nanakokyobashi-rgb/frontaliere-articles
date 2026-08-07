/**
 * resolve-registry-conflicts.mjs — in-place resolver for rebase conflicts on
 * the generator's append-only dedup caches.
 *
 * Root cause (issue #29): `data/blog-images-used.json` (articleId -> image
 * URL) and `public/data/journalist-image-catalog.json` (array of {path,
 * words}) are rewritten on *every* article the generator or the journalist
 * publisher produces, purely by appending one new entry. Two workflow runs
 * that both append — one queued behind the other, which is routine given
 * the shared `generate-article` concurrency group and the ~8min generation
 * time — both patch "the line(s) after the last existing entry", which git's
 * default 3-way merge always reports as a conflict even though the two
 * appends are logically independent (verified empirically; `merge=union`
 * was also tried and rejected — it recombines the two sides' JSON textually
 * and produces invalid JSON, since neither side's fragment is a syntactically
 * complete document on its own).
 *
 * These two files are pure dedup caches with no live consumer outside the
 * generator itself (unlike the article registries under content/), so a
 * semantic union merge — read both sides as JSON, combine by unique key,
 * write back — is safe: the worst case of getting it wrong is an image
 * being reused once, not a production regression.
 *
 * Deliberately narrow: resolves ONLY the two paths below. Any other
 * conflicted path aborts (exit 1) so the caller falls back to its existing
 * fail-loud behaviour instead of guessing at a merge for files this script
 * was not verified against (the article registries themselves included).
 *
 * Usage (inside an in-progress `git rebase` with conflicts):
 *   node scripts/lib/resolve-registry-conflicts.mjs
 * Exits 0 with all known-safe conflicts staged (`git add`ed), or exits 1
 * without touching anything if a conflicted path isn't recognised.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export const RESOLVABLE_PATHS = new Set([
  'data/blog-images-used.json',
  'public/data/journalist-image-catalog.json',
]);

/** `data/blog-images-used.json`: flat articleId -> imageUrl map, union by key. */
export function mergeImageUsedMap(ours, theirs) {
  return { ...theirs, ...ours };
}

/** `public/data/journalist-image-catalog.json`: array of {path, words}, union by `path`. */
export function mergeImageCatalog(ours, theirs) {
  const byPath = new Map(theirs.map((entry) => [entry.path, entry]));
  for (const entry of ours) byPath.set(entry.path, entry);
  return [...byPath.values()];
}

function mergeForPath(gitPath, ours, theirs) {
  if (gitPath === 'data/blog-images-used.json') return mergeImageUsedMap(ours, theirs);
  if (gitPath === 'public/data/journalist-image-catalog.json') return mergeImageCatalog(ours, theirs);
  throw new Error(`no merge strategy registered for ${gitPath}`);
}

/** Serialize matching the file's own writer, so a clean resolve is a no-op diff next run. */
function serialize(gitPath, merged) {
  if (gitPath === 'data/blog-images-used.json') return JSON.stringify(merged, null, 2) + '\n';
  return JSON.stringify(merged);
}

function conflictedPaths() {
  return execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function readStage(stage, gitPath) {
  return JSON.parse(execFileSync('git', ['show', `:${stage}:${gitPath}`], { encoding: 'utf8' }));
}

export function main() {
  const paths = conflictedPaths();
  if (paths.length === 0) {
    console.error('resolve-registry-conflicts: no conflicted paths found (nothing to do)');
    return 1;
  }
  const unresolvable = paths.filter((p) => !RESOLVABLE_PATHS.has(p));
  if (unresolvable.length > 0) {
    console.error(
      `resolve-registry-conflicts: refusing — conflicted path(s) outside the known-safe allowlist: ${unresolvable.join(', ')}`,
    );
    return 1;
  }
  for (const gitPath of paths) {
    const ours = readStage(2, gitPath);
    const theirs = readStage(3, gitPath);
    const merged = mergeForPath(gitPath, ours, theirs);
    writeFileSync(gitPath, serialize(gitPath, merged));
    execFileSync('git', ['add', gitPath]);
    console.log(`resolve-registry-conflicts: merged ${gitPath} (union of both sides)`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
