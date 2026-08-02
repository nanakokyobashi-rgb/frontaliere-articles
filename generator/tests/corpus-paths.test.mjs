/**
 * The main→nanako layout mapping (issue #4974 item 3). Run with `node --test`.
 *
 * This is the module that replaced main's `resolve-git-add-path.mjs`, so the
 * cases below are as much about what it must NOT do (relocate the generator's
 * own state files, resolve symlinks that do not exist here) as what it must.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corpusPath, resolveGitAddPath, resolveGitAddPaths } from '../scripts/lib/corpus-paths.mjs';

test('maps the per-locale body dirs into content/', () => {
  assert.equal(corpusPath('services/locales/blog-body/it/foo.ts'), 'content/blog-body/it/foo.ts');
  assert.equal(
    corpusPath('services/locales/blog-body-ch/de/bar.ts'),
    'content/blog-body-ch/de/bar.ts',
  );
});

test('maps the meta chunks into content/', () => {
  assert.equal(corpusPath('services/locales/blog-meta-it.ts'), 'content/blog-meta-it.ts');
  assert.equal(corpusPath('services/locales/blog-meta-ch-fr.ts'), 'content/blog-meta-ch-fr.ts');
});

test('maps the registries, routers and seo files', () => {
  assert.equal(corpusPath('data/blog-articles-data.ts'), 'content/blog-articles-data.ts');
  assert.equal(corpusPath('data/swiss-articles-data.ts'), 'content/swiss-articles-data.ts');
  assert.equal(corpusPath('services/routerBlogData.ts'), 'content/routerBlogData.ts');
  assert.equal(corpusPath('services/routerSwissData.ts'), 'content/routerSwissData.ts');
  assert.equal(corpusPath('services/seo/seo-blog-5.ts'), 'content/seo/seo-blog-5.ts');
  assert.equal(corpusPath('services/seo/seo-blog-ch.ts'), 'content/seo/seo-blog-ch.ts');
});

test('maps main’s packages/articles/content/ prefix', () => {
  assert.equal(corpusPath('packages/articles/content/blogArticleIds.ts'), 'content/blogArticleIds.ts');
});

test('preserves a trailing slash, because git-add pathspecs carry one', () => {
  assert.equal(corpusPath('services/locales/blog-body-ch/'), 'content/blog-body-ch/');
  assert.equal(corpusPath('services/locales/blog-body/'), 'content/blog-body/');
});

test('leaves the generator’s own state files under data/ alone', () => {
  // The whole reason the mapping is an explicit table rather than a
  // `data/ -> content/` prefix rule: these MOVE with the generator (§3) and
  // must not be relocated into the published corpus.
  for (const p of [
    'data/article-source-quotas.json',
    'data/article-source-urls.json',
    'data/article-source-quotas-swiss.json',
    'data/topic-candidates-consumed.json',
  ]) {
    assert.equal(corpusPath(p), p, `${p} must not be remapped`);
  }
});

test('leaves unrelated paths untouched', () => {
  for (const p of ['public/sitemap-news.xml', 'public/images/blog/x.webp', 'scripts/foo.mjs']) {
    assert.equal(corpusPath(p), p);
  }
});

test('is idempotent — mapping an already-mapped path is a no-op', () => {
  const once = corpusPath('services/locales/blog-body/it/foo.ts');
  assert.equal(corpusPath(once), once);
});

test('resolveGitAddPaths maps every entry and ignores repoRoot', () => {
  const files = [
    'services/locales/blog-meta-it.ts',
    'data/blog-articles-data.ts',
    'public/sitemap-news.xml',
  ];
  assert.deepEqual(resolveGitAddPaths('/anywhere', files), [
    'content/blog-meta-it.ts',
    'content/blog-articles-data.ts',
    'public/sitemap-news.xml',
  ]);
  assert.equal(resolveGitAddPath('/anywhere', files[0]), 'content/blog-meta-it.ts');
});

test('every mapped corpus target actually exists in this repo', async () => {
  // Guards the mapping against this repo's layout drifting under it — a rule
  // that points at a directory nobody has is worse than no rule, because the
  // generator would create it and publish nothing.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
  for (const rel of [
    'content/blog-body',
    'content/blog-body-ch',
    'content/blog-meta-it.ts',
    'content/blog-articles-data.ts',
    'content/swiss-articles-data.ts',
    'content/routerBlogData.ts',
    'content/routerSwissData.ts',
    'content/seo/seo-blog-5.ts',
    'content/seo/seo-blog-ch.ts',
    'content/blogArticleIds.ts',
  ]) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `missing corpus target: ${rel}`);
  }
});

test('no source file builds a corpus path without going through corpusPath()', async () => {
  // The gate for the bug the dry-run harness could NOT catch. Under DRY_RUN=1
  // the writing scripts do not write, so a main-relative output path stays
  // invisible until a real run — at which point
  // generate-events-digest-article.mjs created a phantom `services/` tree at
  // the repo root and wrote four body files into it, while `content/` sat
  // untouched and every runtime check reported success.
  //
  // The thing that is actually wrong is joining a main-relative corpus path
  // DIRECTLY onto the repo root, which bypasses the mapping:
  //   path.join(repoRoot, 'services', 'locales', 'blog-body', locale)   // BUG
  //   path.join(repoRoot, `services/locales/${dir}`)                    // BUG
  //
  // A bare `services/locales/...` string is NOT a bug on its own — most of
  // create-article.mjs is written that way on purpose, and those strings reach
  // `resolve()`/`read()`/`write()`/`resolveGitAddPath()`, every one of which
  // maps. Flagging them would flag the design. So the pattern below is anchored
  // on the join-to-root, which is the step that skips the sink.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const scriptsRoot = path.resolve(
    path.dirname(url.fileURLToPath(import.meta.url)),
    '..',
    'scripts',
  );

  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.mjs')) files.push(p);
    }
  })(scriptsRoot);

  // join(<root>, …) where the next argument starts a main-relative corpus path,
  // in either the segment spelling or the template-literal one.
  const ROOT_VAR = '(?:repoRoot|REPO_ROOT|ROOT|PROJECT_ROOT|projectRoot)';
  const CORPUS_HEAD = `(?:['"\`](?:services\\/locales|services\\/seo|packages\\/articles)|['"]services['"]\\s*,\\s*['"]locales['"]|['"\`]data\\/(?:blog|swiss)-articles-data)`;
  const JOIN_TO_ROOT = new RegExp(`join\\(\\s*${ROOT_VAR}\\s*,\\s*${CORPUS_HEAD}`);

  const offenders = [];
  for (const file of files) {
    if (file.endsWith('corpus-paths.mjs')) continue; // the mapping itself
    const src = fs.readFileSync(file, 'utf-8');
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (!JOIN_TO_ROOT.test(code)) return;
      if (code.includes('corpusPath')) return; // already routed through the map
      offenders.push(`${path.relative(scriptsRoot, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `main-relative corpus paths not routed through corpusPath():\n  ${offenders.join('\n  ')}`,
  );
});

test('this repo has no symlinks, which is why the resolver was dropped', async () => {
  // If this ever fails, main's realpath-based resolve-git-add-path.mjs becomes
  // relevant again and corpus-paths.mjs's header is no longer true.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) found.push(path.relative(repoRoot, p));
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(path.join(repoRoot, 'content'));
  assert.deepEqual(found, []);
});
