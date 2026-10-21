# Isolated article-source parser runtime

The static article-source readers use the TypeScript compiler API. This package
pins only TypeScript 5.8.3 so lightweight corpus jobs do not need the root
project dependencies.

In GitHub Actions, use
`.github/actions/setup-article-source-runtime`. It copies this manifest and
lockfile to `$RUNNER_TEMP`, installs them there with `npm ci`, sets the absolute
`ARTICLE_SOURCE_TYPESCRIPT` path for later steps, and checks the compiler
version. The smoke check verifies runtime availability only; it does not import
or exercise the article-source parser.

For a local command, use a disposable directory and export the same entry path:

```bash
runtime_dir="${TMPDIR:-/tmp}/frontaliere-article-source-runtime"
mkdir -p "$runtime_dir"
cp scripts/ci/article-source-runtime/package.json "$runtime_dir/package.json"
cp scripts/ci/article-source-runtime/package-lock.json "$runtime_dir/package-lock.json"
(
  cd "$runtime_dir"
  npm ci --ignore-scripts --no-audit --no-fund
)
export ARTICLE_SOURCE_TYPESCRIPT="$runtime_dir/node_modules/typescript/lib/typescript.js"
node scripts/ci/check-article-source-runtime.mjs
```
