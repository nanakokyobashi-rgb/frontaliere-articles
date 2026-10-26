#!/usr/bin/env bash
# The section workflow keeps this gate in a script so the YAML parser only
# carries the environment contract, not the full shell implementation.
set -euo pipefail
changed_files="$RUNNER_TEMP/fast-publish-section-changed-bodies.txt"
: > "$changed_files"
scan_mode=full
# Keep this dependency closure identical to publish-api.yml. A mixed
# push that changes a body and its gate must scan the full corpus.
gate_input_paths=(
  .github/workflows/fast-publish-section.yml
  .github/workflows/publish-api.yml
  engine/articleSeoFallback.ts
  engine/ogPagesPlugin.ts
  engine/rssFeeds.mjs
  engine/shared/articleSectionCore.mjs
  engine/shared/cantonArticleSectionCore.generated.mjs
  engine/shared/normalizeArticleMarkdown.ts
  engine/shared/articleReaderSource.mjs
  engine/shared/articleArchiveConfig.mjs
  engine/shared/articleRouteOwnership.mjs
  engine/shared/articleStaticSource.mjs
  engine/shared/seo-entry.mjs
  engine/shared/staticSourceAst.mjs
  engine/shared/ts-literals.mjs
  engine/shared/tsStringEscapes.ts
  generator/data/canton-url-slugs.json
  generator/data/canton-sections.json
  generator/scripts/lib/corpus-paths.mjs
  host/cantonSectionsBootstrap.mjs
  scripts/ci/check-blog-body-links.mjs
  scripts/ci/check-blog-body-syntax.mjs
  scripts/lib/article-link-contract.mjs
  scripts/lib/typescript-expression-scanner.mjs
  scripts/lib/rss-feed-body-adapter.mjs
  scripts/lib/corpus-floors.mjs
  scripts/lib/corpus-sections.mjs
  scripts/lib/seo-entry.mjs
  scripts/lib/article-registry-reader.mjs
  scripts/lib/ts-literals.mjs
  generator/scripts/lib/article-meta-block.mjs
  generator/scripts/lib/article-excerpt.mjs
  generator/scripts/lib/daily-brief-content.mjs
  generator/scripts/lib/daily-brief-data.mjs
  generator/scripts/lib/daily-brief-insights.mjs
  generator/scripts/lib/localized-toponyms.mjs
)
# A bounded workflow_dispatch can carry an explicit article scope
# together with a push range; only push events may derive changed
# mode so dispatch targets remain in both preflight gates.
if [ "$EVENT_NAME" = 'push' ] \
  && [[ "${BEFORE:-}" =~ ^[a-f0-9]{40}$ ]] \
  && [[ "${AFTER:-}" =~ ^[a-f0-9]{40}$ ]] \
  && [ "$BEFORE" != '0000000000000000000000000000000000000000' ] \
  && git cat-file -e "${BEFORE}^{commit}" 2>/dev/null \
  && git cat-file -e "${AFTER}^{commit}" 2>/dev/null; then
  if git diff --quiet "$BEFORE" "$AFTER" -- "${gate_input_paths[@]}" 2>/dev/null; then
    git diff --name-only "$BEFORE" "$AFTER" -- content > "$changed_files"
    if [ -s "$changed_files" ]; then scan_mode=changed; fi
  fi
fi
preflight_env=(
  "PREFLIGHT_ESBUILD_DIR=$RUNNER_TEMP/preflight"
  "PREFLIGHT_SCAN_MODE=$scan_mode"
  "PREFLIGHT_CHANGED_FILES_FILE=$changed_files"
)
if [ -n "${BEFORE:-}" ]; then
  preflight_env+=("PREFLIGHT_BASE_REVISION=$BEFORE")
fi
if [ "$EVENT_NAME" = 'workflow_dispatch' ]; then
  preflight_env+=("PREFLIGHT_ARTICLE_IDS=${ARTICLE_IDS_INPUT:-}")
  preflight_env+=("PREFLIGHT_SECTION=${SECTION_INPUT:-}")
fi
env "${preflight_env[@]}" node scripts/ci/check-blog-body-syntax.mjs
PREFLIGHT_SCAN_MODE="$scan_mode" \
  PREFLIGHT_ARTICLE_IDS="${ARTICLE_IDS_INPUT:-}" \
  PREFLIGHT_SECTION="${SECTION_INPUT:-}" \
  PREFLIGHT_CHANGED_FILES_FILE="$changed_files" \
  node scripts/ci/check-blog-body-links.mjs
