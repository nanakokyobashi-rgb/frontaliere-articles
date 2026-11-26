#!/usr/bin/env bash
# True only for a verified fast-forward with no changes to publication inputs.
set -euo pipefail

bookkeeping_paths=(
  ':(top,exclude,literal)data/blog-cover-cdn-sync-queue.json'
  ':(top,exclude,literal)data/discovery-attempt-state.json'
  ':(top,exclude,literal)data/topic-candidates-evergreen-rejected.json'
  ':(top,exclude,glob)data/sections/*/topic-candidates-evergreen-rejected.json'
  # Runtime and fixtures for producing future articles, never read by renderers.
  ':(top,exclude,literal)generator/scripts/create-article.mjs'
  ':(top,exclude,glob)generator/tests/**/*.test.mjs'
  # Cross-repo crawler synchronization, separate from the published corpus.
  ':(top,exclude,literal)generator/data/crawler-cross-repo-contract.json'
  ':(top,exclude,literal)scripts/ci/loop-sync-manifest.json'
  ':(top,exclude,literal)scripts/ci/translate-queue-recovery.mjs'
  ':(top,exclude,literal).github/workflows/translate-pending.yml'
)

# A shallow boundary is a conservative lower bound for the replay identity.
last_publication_input() {
  local revision="$1" base
  if ! git cat-file -e "$revision^{commit}" 2>/dev/null; then
    timeout 60 git fetch --quiet --no-tags --no-write-fetch-head origin "$revision" >&2 || return 1
  fi
  base="$(git log -1 --first-parent --full-history --format=%H "$revision" -- . "${bookkeeping_paths[@]}")" || return 1
  [[ "$base" =~ ^[a-f0-9]{40}$ ]] || return 1
  printf '%s\n' "$base"
}

if [ "${1:-}" = '--bookkeeping-revisions' ]; then
  revision="${2:-}"
  [[ "$#" -eq 2 && "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 1
  base="$(last_publication_input "$revision")"
  git rev-list --first-parent "$base..$revision"
  printf '%s\n' "$base"
  exit 0
fi

if [ "${1:-}" = '--replay-nonce' ]; then
  revision="${2:-}"
  section="${3:-}"
  [[ "$#" -ge 4 && "$revision" =~ ^[a-f0-9]{40}$ && "$section" =~ ^canton-[a-z0-9-]+$ ]] || exit 1
  shift 3
  base="$(last_publication_input "$revision")"
  identity_args=()
  for arg in "$@"; do
    case "$arg" in
      "source_commit=$revision"|"source_main_commit=$revision"|"push_after=$revision")
        arg="${arg%%=*}=$base" ;;
    esac
    identity_args+=("$arg")
  done
  hash="$(printf '%s\0' "${identity_args[@]}" | sha256sum | cut -c1-16)"
  printf 'stale-late-%s-%s-%s\n' "${base:0:12}" "$section" "$hash"
  exit 0
fi

bookkeeping_only=false
if [ "${1:-}" = '--bookkeeping-only' ]; then
  bookkeeping_only=true
  shift
fi
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

if [ "$bookkeeping_only" = 'true' ]; then
  git diff --quiet --no-ext-diff --no-textconv --ignore-submodules=none \
    "$expected" "$current" -- . "${bookkeeping_paths[@]}"
  exit
fi

# These files record generator attempts, image work and watchdog status,
# or change how future articles are generated without rendering existing pages.
# Test entrypoints and the actionlint config are not read by the publisher.
# Check both reconcile workflows separately before accepting the revision.
section_workflow=.github/workflows/reconcile-section-pages.yml
shard_workflow=.github/workflows/reconcile-article-shards.yml
git diff --quiet --no-ext-diff --no-textconv --ignore-submodules=none "$expected" "$current" -- . \
  ':(top,exclude,literal).github/actionlint.yaml' \
  ":(top,exclude,literal)$section_workflow" \
  ":(top,exclude,literal)$shard_workflow" \
  "${bookkeeping_paths[@]}" \
  ':(top,exclude,literal)data/image-regeneration-queue.json' \
  ':(top,exclude,literal)data/image-regeneration-queue-pending.jsonl' \
  ':(top,exclude,glob)data/image-regeneration-queue-pending.jsonl.*.pending' \
  ':(top,exclude,literal)generator/scripts/lib/ai-models.mjs' \
  ':(top,exclude,literal)generator/scripts/lib/free-translate.mjs' \
  ':(top,exclude,literal)generator/scripts/lib/canton-news-sources.mjs' \
  ':(top,exclude,literal)scripts/ci/canton-generation-admit.mjs' \
  ':(top,exclude,literal)scripts/ci/canton-generation-coverage.mjs' || exit 1

# Match approved scheduling deltas in one direction, including every context line.
normalized_workflow_diff() {
  local patch
  patch=$(git diff --no-ext-diff --no-textconv --ignore-submodules=none --no-renames \
    --no-color --no-indent-heuristic --diff-algorithm=myers --unified=3 --full-index \
    --src-prefix=a/ --dst-prefix=b/ "$expected" "$current" -- ":(top,literal)$1") || return 1
  printf '%s\n' "$patch" | sed -E \
    's/^index [0-9a-f]{40}[.][.][0-9a-f]{40} 100644$/index 100644/;s/^@@ -[0-9]+(,[0-9]+)? [+][0-9]+(,[0-9]+)? @@.*$/@@/;s/^ $/<empty-context-line>/'
}

approved_section_history=$(cat <<'APPROVED_SCHEDULING_DELTA'
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
approved_section_lanes=$(cat <<'APPROVED_SECTION_LANE_DELTA'
diff --git a/.github/workflows/reconcile-section-pages.yml b/.github/workflows/reconcile-section-pages.yml
index 100644
--- a/.github/workflows/reconcile-section-pages.yml
+++ b/.github/workflows/reconcile-section-pages.yml
@@
         default: false
         type: boolean
<empty-context-line>
-# Coalesce runs of the same event while reserving a pending slot for each trigger.
+# Keep one pending run per trigger, splitting workflow_run by parent event.
+# The shared job group serializes reconciliation across triggers.
 concurrency:
-  group: reconcile-section-pages-${{ github.event_name }}
+  group: reconcile-section-pages-${{ github.event_name == 'workflow_run' && format('workflow_run-{0}', github.event.workflow_run.event) || github.event_name }}
   queue: single
   cancel-in-progress: false
<empty-context-line>
APPROVED_SECTION_LANE_DELTA
) || exit 1

approved_shard_lanes=$(cat <<'APPROVED_SHARD_LANE_DELTA'
diff --git a/.github/workflows/reconcile-article-shards.yml b/.github/workflows/reconcile-article-shards.yml
index 100644
--- a/.github/workflows/reconcile-article-shards.yml
+++ b/.github/workflows/reconcile-article-shards.yml
@@
         required: false
         default: '3'
<empty-context-line>
-# Una riconciliazione alla volta; mai cancellarne una a metà dei dispatch.
+# Uno slot in attesa per trigger, con workflow_run distinto per evento padre.
+# Il gruppo condiviso del job serializza le riconciliazioni.
 concurrency:
-  group: reconcile-article-shards
+  group: reconcile-article-shards-${{ github.event_name == 'workflow_run' && format('workflow_run-{0}', github.event.workflow_run.event) || github.event_name }}
+  queue: single
   cancel-in-progress: false
<empty-context-line>
 permissions:
@@
<empty-context-line>
 jobs:
   reconcile:
+    concurrency:
+      group: reconcile-article-shards
+      queue: max
+      cancel-in-progress: false
     runs-on: ubuntu-latest
     # Fino a 3 backfill sequenziali da ~7-10 min l'uno, più le attese di
     # coda: 50 copre il caso peggiore senza lasciar vivere uno zombie.
APPROVED_SHARD_LANE_DELTA
) || exit 1

section_delta=$(normalized_workflow_diff "$section_workflow") || exit 1
[[ -z "$section_delta" || "$section_delta" = "$approved_section_history" || "$section_delta" = "$approved_section_lanes" ]] || exit 1

shard_delta=$(normalized_workflow_diff "$shard_workflow") || exit 1
[[ -z "$shard_delta" || "$shard_delta" = "$approved_shard_lanes" ]]
