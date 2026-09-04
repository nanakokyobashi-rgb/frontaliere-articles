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

// Deliberately NOT under `.tmp/`, which is gitignored. A run killed mid-write
// leaves its partial writes on disk, and `generate-article.yml` sweeps them
// into a commit with `git add -A` — a lock under `.tmp/` would be the one
// piece of that evidence NOT committed, so the next run (a fresh checkout)
// would inherit the split corpus with nothing left to detect it. Tracked here,
// the registration-in-progress marker travels with the damage it describes.
export const REGISTER_LOCK_FILE = 'generator/data/register-in-progress.json';

export function registerLockPath(projectRoot) {
  return path.join(projectRoot, REGISTER_LOCK_FILE);
}

/**
 * Called before the FIRST of the 9 writes. Throws instead of silently
 * overwriting a lock left by an interrupted registration — the corpus may
 * already be inconsistent, and layering a new registration on top would only
 * add a second interleaving nobody could untangle afterwards.
 *
 * `section` is recorded alongside the id and is NOT optional: the 9 targets
 * are section-scoped (the frontaliere registry, slug map, SEO file and locale
 * chunks are different files from the svizzera ones — the two sections do not
 * share a single target), and `generate-article.yml` alternates the two
 * sections inside the SAME checkout. Resolving the lock against whichever
 * section the NEXT process happens to run as would compare a svizzera id
 * against the frontaliere files, find it in none of them, and clear the lock
 * as "nothing written" over a genuinely split corpus.
 */
export function beginRegisterLock(projectRoot, id, section) {
  if (typeof section !== 'string' || section === '') {
    throw new Error(
      `beginRegisterLock() requires the article section (got ${JSON.stringify(section)}): the ` +
        'registration targets are section-scoped and cannot be cross-checked on a later run without it.',
    );
  }
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
  writeFileSync(
    lockPath,
    JSON.stringify({ id, section, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    'utf-8',
  );
}

/**
 * Called only after the LAST of the 9 writes succeeds — never from a
 * catch/finally, or a kill/throw mid-sequence would clear the very marker
 * meant to survive it for the next invocation to trip on.
 */
export function endRegisterLock(projectRoot) {
  try { unlinkSync(registerLockPath(projectRoot)); } catch { /* already gone */ }
}

/**
 * Reads the lock left by an interrupted registration, or `null` when there
 * isn't one. A lock whose JSON is unreadable is still a lock — it is reported
 * with `id: null`, never swallowed as "clean". `id` and `section` are
 * normalised AFTER the spread, so a malformed value in the file cannot put
 * itself back through `...parsed`.
 */
export function readRegisterLock(projectRoot) {
  const lockPath = registerLockPath(projectRoot);
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8'));
    return {
      ...parsed,
      id: typeof parsed?.id === 'string' ? parsed.id : null,
      section: typeof parsed?.section === 'string' && parsed.section !== '' ? parsed.section : null,
    };
  } catch {
    return { id: null, section: null, unreadable: true };
  }
}

/**
 * Splits the registration targets into the ones that already carry the id and
 * the ones that don't. `needle === null` means "the file's mere existence is
 * the registration" (the per-article body files), everything else is a
 * substring lookup in the file that was appended to.
 */
export function registrationTargetStatus(targets) {
  const present = [];
  const absent = [];
  for (const t of targets) {
    let has = false;
    if (existsSync(t.absPath)) {
      if (t.needle == null) has = true;
      else {
        try { has = readFileSync(t.absPath, 'utf-8').includes(t.needle); } catch { has = false; }
      }
    }
    (has ? present : absent).push(t.label);
  }
  return { present, absent };
}

/**
 * The startup half of the transaction, called once at the top of `main()`.
 *
 * A lock on disk only says a registration *started*; it does not say the
 * corpus is broken. Two of the three possible states are benign and must
 * self-heal, or the generator would brick itself permanently on the first
 * interrupted run and every later run would open a workflow-failure issue for
 * a corpus that is actually fine:
 *
 *  - the id is in NONE of the targets — the kill landed before the first
 *    write, or a later step rolled the article back: nothing to repair;
 *  - the id is in ALL of them — the kill landed after the last write but
 *    before `endRegisterLock()`: the transaction did commit.
 *
 * Only a genuine SPLIT (some targets registered, some not) is the failure
 * this lock exists to catch, and that one throws: continuing would layer a
 * second registration on top of a corpus nobody could untangle afterwards.
 *
 * `buildTargets(id, section)` is supplied by the caller because the 9 paths
 * depend on the `--section` config, which lives in create-article.mjs. It is
 * called with the section RECORDED IN THE LOCK, never with the one the
 * current process was launched with: the two differ every time
 * `generate-article.yml` alternates sections in the same checkout, and
 * comparing an id against the other section's files would classify a split
 * corpus as untouched.
 */
export function resolveRegisterLock(projectRoot, buildTargets) {
  const lock = readRegisterLock(projectRoot);
  if (!lock) return { state: 'clean' };
  if (!lock.id || !lock.section) {
    throw new Error(
      `registration lock at ${REGISTER_LOCK_FILE} is unreadable or missing its ` +
        `${lock.id ? 'section' : 'id'}, so the interrupted registration cannot be located and the ` +
        '9 files cannot be cross-checked. Inspect the corpus by hand and remove the lock file.',
    );
  }
  const { present, absent } = registrationTargetStatus(buildTargets(lock.id, lock.section));
  if (present.length > 0 && absent.length > 0) {
    throw new Error(
      `registration of "${lock.id}" (section "${lock.section}") was interrupted mid-write and left ` +
        `the corpus SPLIT across the ` +
        `registration files: registered in [${present.join(', ')}] but missing from ` +
        `[${absent.join(', ')}]. Refusing to generate on top of an inconsistent corpus — repair the ` +
        `missing entries (or remove the partial ones) by hand, then delete ${REGISTER_LOCK_FILE}.`,
    );
  }
  endRegisterLock(projectRoot);
  return { state: present.length > 0 ? 'committed' : 'nothing-written', id: lock.id, section: lock.section };
}
