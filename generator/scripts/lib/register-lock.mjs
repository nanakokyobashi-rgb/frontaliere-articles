/**
 * The multi-file registration lock for `registerArticleFiles()` (issue #562).
 *
 * ## Why the writes need it
 *
 * Registering an article touches 9 files (router, blog list, i18n, three
 * locale files, SEO service, sitemap, sitemap-news), each written
 * independently via `create-article.mjs`'s `write()`. `write()` itself is
 * atomic per-target (issue #561, temp+rename), but nothing stopped a kill —
 * or any other failure — from landing BETWEEN two of the nine calls: the
 * corpus would end up with an id registered in some files and not others,
 * and nothing checked the 9 files against each other on the next run to
 * catch it.
 *
 * ## Why this is its own module and not a private function in create-article.mjs
 *
 * That file is 15k+ lines and imports `jsdom` statically, so nothing inside
 * it is reachable by `node --test` without `node_modules` (absent here by
 * default — see AGENTS.md). Pulled out here, the lock mechanism itself is
 * directly testable (`generator/tests/register-lock.test.mjs`) without
 * touching the rest of create-article.mjs.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const REGISTER_LOCK_FILE = '.tmp/register-in-progress.json';

export function registerLockPath(projectRoot) {
  return path.join(projectRoot, REGISTER_LOCK_FILE);
}

/**
 * Called before the FIRST of the 9 writes. Throws instead of silently
 * overwriting a lock left by an interrupted registration — the corpus may
 * already be inconsistent, and layering a new registration on top would only
 * add a second interleaving nobody could untangle afterwards.
 */
export function beginRegisterLock(projectRoot, id) {
  const lockPath = registerLockPath(projectRoot);
  if (existsSync(lockPath)) {
    let stale = lockPath;
    try { stale = readFileSync(lockPath, 'utf-8'); } catch { /* keep path */ }
    throw new Error(
      `registration lock still present at ${REGISTER_LOCK_FILE} — a previous registration ` +
        `was interrupted mid-write and the corpus may have an id registered in some of the 9 ` +
        `files but not others (${stale}). Refusing to start a new registration until the ` +
        'partial write is inspected by hand and the lock file removed.',
    );
  }
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ id, pid: process.pid, startedAt: new Date().toISOString() }, null, 2), 'utf-8');
}

/**
 * Called only after the LAST of the 9 writes succeeds — never from a
 * catch/finally, or a kill/throw mid-sequence would clear the very marker
 * meant to survive it for the next invocation to trip on.
 */
export function endRegisterLock(projectRoot) {
  try { unlinkSync(registerLockPath(projectRoot)); } catch { /* already gone */ }
}
