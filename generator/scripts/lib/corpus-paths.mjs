/**
 * Translate the generator's repo-relative paths from the layout they were
 * written against (frontaliere-si-o-no, "main") to this repository's layout.
 *
 * The generator was transported verbatim (issue #4974 item 3, step 2) so its
 * diff against main stays reviewable. That means it still says
 * `services/locales/blog-body/it/foo.ts` everywhere, which is main's path.
 * Here the corpus is a flat `content/` tree. Rather than rewrite ~30 literals
 * across an 8800-line script — and re-do it on every future transport — the
 * mapping lives here and the scripts route their ONE path-resolution helper
 * through it.
 *
 * ── Why `resolve-git-add-path.mjs` was deliberately NOT transported ─────────
 *
 * In main, `services/locales/blog-body{,-ch}` and `services/locales/blog-meta-*.ts`
 * are OS symlinks into `packages/articles/content/` (the Fase 6 package
 * migration, #4881/#4919). `git add` refuses a pathspec that walks through a
 * symlinked directory ("fatal: pathspec ... is beyond a symbolic link") and
 * silently no-ops when the pathspec IS a file symlink whose target changed, so
 * main needs a `realpath` pass before every `git add`.
 *
 * This repository has no symlinks at all (verified: `find . -type l` is empty)
 * — `content/` IS the real tree. Porting the symlink resolver would have been
 * porting a workaround for a problem that does not exist here, and worse, its
 * `realpathSync` fallback would silently rewrite paths for reasons that no
 * longer apply. So the git-add helpers below are the same API with the symlink
 * logic removed and the layout mapping put in its place: callers keep calling
 * `resolveGitAddPaths(root, files)` and get paths that are correct HERE.
 *
 * ── Why an explicit table and not a prefix rewrite ──────────────────────────
 *
 * `data/` is NOT blanket-mapped. Main's `data/` holds two corpus registries
 * (`blog-articles-data.ts`, `swiss-articles-data.ts`) that belong in `content/`
 * here, but it ALSO holds generator state the generator owns and writes in
 * place — `article-source-quotas.json`, `article-source-urls.json`,
 * `topic-candidates-consumed.json` (§3 of the migration doc: these MOVE with
 * the generator). A `data/ → content/` prefix rule would quietly relocate the
 * generator's own scratch files into the published corpus. Same reasoning for
 * `services/`: two router modules map, the rest are ordinary library imports.
 *
 * Anything with no rule is returned unchanged, which is the correct default for
 * `public/…`, `scripts/…` and the generator's own state files.
 */

/** Root of the published corpus in this repository. */
export const CORPUS_ROOT = 'content';

/** Exact-path rewrites (main path → this repo's path). */
const EXACT = new Map([
  ['data/blog-articles-data.ts', 'content/blog-articles-data.ts'],
  ['data/swiss-articles-data.ts', 'content/swiss-articles-data.ts'],
  ['services/routerBlogData.ts', 'content/routerBlogData.ts'],
  ['services/routerSwissData.ts', 'content/routerSwissData.ts'],
  ['services/articleSections.ts', 'content/articleSections.ts'],
]);

/**
 * Prefix rewrites, longest-first. `services/seo/` must be tested before any
 * shorter `services/` rule would be, hence the explicit ordering rather than a
 * plain object.
 */
const PREFIXES = [
  ['packages/articles/content/', 'content/'],
  ['services/locales/', 'content/'],
  ['services/seo/', 'content/seo/'],
];

/**
 * Map one repo-relative path from main's layout to this repository's.
 * Idempotent: a path already expressed in this repo's layout is returned as-is,
 * so it is safe to call on a value that may have been mapped already.
 *
 * @param {string} rel Repo-relative path, optionally with a trailing slash.
 * @returns {string}
 */
export function corpusPath(rel) {
  if (typeof rel !== 'string' || rel === '') return rel;

  const trailingSlash = rel.endsWith('/');
  const bare = trailingSlash ? rel.slice(0, -1) : rel;

  const exact = EXACT.get(bare);
  if (exact) return trailingSlash ? `${exact}/` : exact;

  for (const [from, to] of PREFIXES) {
    if (bare.startsWith(from)) {
      const mapped = `${to}${bare.slice(from.length)}`;
      return trailingSlash ? `${mapped}/` : mapped;
    }
  }

  return rel;
}

/**
 * Drop-in replacement for main's `resolve-git-add-path.mjs` export of the same
 * name. Maps the path into this repo's layout; no symlink resolution, because
 * there are no symlinks here (see the header). `repoRoot` is accepted and
 * ignored so call sites need no edit.
 *
 * @param {string} _repoRoot Unused; kept for signature compatibility.
 * @param {string} relPath
 * @returns {string}
 */
export function resolveGitAddPath(_repoRoot, relPath) {
  return corpusPath(relPath);
}

/**
 * @param {string} _repoRoot Unused; kept for signature compatibility.
 * @param {string[]} relPaths
 * @returns {string[]}
 */
export function resolveGitAddPaths(_repoRoot, relPaths) {
  return relPaths.map((p) => corpusPath(p));
}
