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
# Test entrypoints and the actionlint config are not read by the publisher.
# Check the reconcile workflow separately before accepting the revision.
workflow=.github/workflows/reconcile-section-pages.yml
git diff --quiet --no-ext-diff --no-textconv --ignore-submodules=none "$expected" "$current" -- . \
  ':(top,exclude,literal).github/actionlint.yaml' \
  ":(top,exclude,literal)$workflow" \
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
  ':(top,exclude,literal)scripts/ci/canton-generation-admit.mjs' \
  ':(top,exclude,literal)scripts/ci/canton-generation-coverage.mjs' \
  ':(top,exclude,literal)scripts/ci/loop-sync-manifest.json' || exit 1

patch=$(git diff --no-ext-diff --no-textconv --ignore-submodules=none --no-renames \
  --no-color --no-indent-heuristic --diff-algorithm=myers --unified=3 --full-index \
  --src-prefix=a/ --dst-prefix=b/ "$expected" "$current" -- "$workflow") || exit 1
if [ -z "$patch" ]; then
  exit 0
fi

# Match the approved scheduling delta in one direction, including every context line.
normalized=$(printf '%s\n' "$patch" | sed -E \
  's/^index [0-9a-f]{40}[.][.][0-9a-f]{40} 100644$/index 100644/;s/^@@ -[0-9]+(,[0-9]+)? [+][0-9]+(,[0-9]+)? @@.*$/@@/;s/^ $/<empty-context-line>/') || exit 1
approved=$(cat <<'APPROVED_SCHEDULING_DELTA'
diff --git a/.github/workflows/reconcile-section-pages.yml b/.github/workflows/reconcile-section-pages.yml
index 100644
--- a/.github/workflows/reconcile-section-pages.yml
+++ b/.github/workflows/reconcile-section-pages.yml
@@
         default: false
         type: boolean
<empty-context-line>
+# Coalesce runs of the same event while reserving a pending slot for each trigger.
 concurrency:
-  group: reconcile-section-pages
+  group: reconcile-section-pages-${{ github.event_name }}
+  queue: single
   cancel-in-progress: false
<empty-context-line>
 permissions:
@@
<empty-context-line>
 jobs:
   reconcile:
+    concurrency:
+      group: reconcile-section-pages
+      queue: max
+      cancel-in-progress: false
     runs-on: ubuntu-latest
     timeout-minutes: 360
     steps:
APPROVED_SCHEDULING_DELTA
) || exit 1
[ "$normalized" = "$approved" ]
