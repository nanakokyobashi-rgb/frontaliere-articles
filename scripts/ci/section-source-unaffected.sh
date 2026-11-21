#!/usr/bin/env bash
# True only for a verified fast-forward with no changes to publication inputs.
set -euo pipefail

expected="${1:-}"
current="${2:-}"
if [[ "$#" -ne 2 || ! "$expected" =~ ^[a-f0-9]{40}$ || ! "$current" =~ ^[a-f0-9]{40}$ ]]; then
  exit 1
fi
if [ "$expected" = "$current" ]; then
  exit 0
fi

# Fetch the exact observed revision if the remote advanced after checkout.
# Never substitute a second observation of main for the revision we compare.
if ! git cat-file -e "$current^{commit}" 2>/dev/null; then
  timeout 60 git fetch --quiet --no-tags --no-write-fetch-head origin "$current" >&2 || exit 1
fi
git merge-base --is-ancestor "$expected" "$current" || exit 1

# These files record generator attempts, image work and watchdog status,
# or change how future articles are generated without rendering existing pages.
# Test entrypoints are not read by the publisher. The two fixed control files
# for lint and reconciliation do not affect already planned renders.
# Other changes may alter the rendered release.
git diff --quiet --no-ext-diff --no-textconv --ignore-submodules=none "$expected" "$current" -- . \
  ':(top,exclude,literal).github/actionlint.yaml' \
  ':(top,exclude,literal).github/workflows/reconcile-section-pages.yml' \
  ':(top,exclude,literal)data/discovery-attempt-state.json' \
  ':(top,exclude,literal)data/topic-candidates-evergreen-rejected.json' \
  ':(top,exclude,glob)data/sections/*/topic-candidates-evergreen-rejected.json' \
  ':(top,exclude,literal)data/blog-cover-cdn-sync-queue.json' \
  ':(top,exclude,literal)data/image-regeneration-queue.json' \
  ':(top,exclude,literal)data/image-regeneration-queue-pending.jsonl' \
  ':(top,exclude,glob)data/image-regeneration-queue-pending.jsonl.*.pending' \
  ':(top,exclude,glob)generator/tests/**/*.test.mjs' \
  ':(top,exclude,literal)generator/scripts/create-article.mjs' \
  ':(top,exclude,literal)generator/scripts/lib/ai-models.mjs' \
  ':(top,exclude,literal)generator/scripts/lib/free-translate.mjs' \
  ':(top,exclude,literal)generator/scripts/lib/canton-news-sources.mjs' \
  ':(top,exclude,literal)scripts/ci/canton-generation-coverage.mjs'
