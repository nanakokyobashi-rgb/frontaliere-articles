#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/push-article-shard-incremental.sh — MERGE-aware bounded article
# push into an existing (section, locale) article shard repo.
#
# Sibling of scripts/lib/push-section-shard.sh, NOT a modification of it.
# push-section-shard.sh is FULL-REPLACE by construction (even its "incremental"
# fast path wipes the ENTIRE staged working tree — see its `find ... -exec rm
# -rf {} +` at :156 — then repopulates solely from the caller's COMPLETE dist
# subtree; its only safety net is a >50% file-count shrink heuristic, a COUNT
# check, not a correctness check). Using it to publish ONE freshly-rendered
# article would delete the rest of the shard's content. This script has the
# OPPOSITE contract: touch ONLY the given relpaths, never delete or replace
# anything else — see issue #4837 (near-instant single-article publish) §2.
#
# Mechanism: git plumbing against a `--filter=blob:none --no-checkout` clone —
# no working-tree checkout, no bulk blob download. Verified end-to-end against
# a local bare repo (see the PR description for the transcript):
#   - `git read-tree HEAD`, `git ls-tree HEAD -- <path>` and
#     `git rev-parse HEAD^{tree}` need ONLY tree objects — never fetch a blob.
#   - Plain `git write-tree` is NOT blob-content-agnostic in practice: it
#     eagerly validates (and therefore lazily FETCHES) the blob referenced by
#     EVERY index entry, including paths we never touched — on an 86 MB shard
#     that means silently downloading the whole repo on every single-article
#     push, defeating the entire point of this script. Fix, confirmed to
#     produce the byte-identical tree SHA while fetching zero extra blobs:
#     `git write-tree --missing-ok`.
#   - `git commit-tree` and a non-force `git push` need no blob content either
#     — push only ever transfers objects the remote doesn't already have.
#   - Reading the previous `.shard-filecount` via `git show HEAD:.shard-filecount`
#     DOES lazily fetch that one small blob — acceptable (a few bytes), and
#     more robust than push-section-shard.sh's raw.githubusercontent.com route
#     (:126): no CDN caching/staleness and no unauthenticated 60/hr rate limit,
#     and the object graph we already cloned is authoritative for exactly the
#     HEAD we are about to build on top of. Presence is read from the tree
#     first: a listed marker whose blob fetch fails aborts the attempt instead
#     of restarting the count from 0.
#
# Merge semantics hold BY CONSTRUCTION: the base tree is the remote's current
# tree; only the caller's relpaths are added/replaced in the index before
# `write-tree` runs. No existing path can ever be dropped, so the 50%-shrink
# guard push-section-shard.sh needs does not apply here.
#
# A fast render can legitimately hand this helper thousands of article and
# archive paths. They are published as serialized bounded commits in one
# invocation, rather than one Pages build-sized commit. The bound is expressed
# in destination paths (not article IDs), because the shard push receives the
# paths after one article can expand to an index, bridge and redirect.
#
# `.shard-deploys` is intentionally NEVER incremented by this script. That
# counter drives push-section-shard.sh's 50-deploy flatten-to-orphan history
# cap (SHARD_HISTORY_CAP) — a fast single-article push runs far more often
# than a full deploy and must NOT accelerate that cycle. Do not "fix" this to
# look consistent with push-section-shard.sh; the omission is deliberate.
#
# Usage:
#   push-article-shard-incremental.sh <section> <locale> <scratch_dist_dir> <relpath1> [relpath2 ...]
#     <section>           any key in scripts/lib/section-shard-slugs.json
#                         (today: articolifrontaliere, articolisvizzera)
#     <locale>            ∈ {it, en, de, fr}
#     <scratch_dist_dir>  small scratch dir holding ONLY the file(s) being pushed
#     <relpathN>          path(s) relative to <scratch_dist_dir> that are ALSO
#                         (verified) the exact destination path inside the
#                         shard repo, e.g. articoli-frontaliere/some-slug/index.html
#
# Required env (identical convention to push-section-shard.sh):
#   SHARD_<SECTION_UPPER>_<LOCALE_UPPER>_DEPLOY_KEY — e.g.
#     SHARD_ARTICOLIFRONTALIERE_IT_DEPLOY_KEY. SSH-only write deploy key for
#     frontaliere-<section>-<locale>. Read via indirect expansion.
#     Missing → notice + exit 0 (silent no-op, matches the sibling).
# Optional env:
#   RUNNER_TEMP — scratch dir; falls back to a mktemp dir if unset (logged).
#   ARTICLE_PUSH_BATCH_SIZE — maximum destination paths per serialized commit;
#       defaults to 256. It is a path bound so every caller shares the same
#       Pages safety limit without duplicating it in workflow YAML.
#   ARTICLE_PUSH_BATCH_GROUPS_FILE — optional TSV manifest (`group<TAB>path`)
#       that keeps dependency paths together while the bounded batches are
#       formed. Each supplied path must occur exactly once; a group may appear
#       on multiple non-consecutive lines.
#   ARTICLE_PUSH_STATUS_FILE — optional one-line outcome for the caller:
#       `pushed`, `clean-no-op`, `remote-newer`, or `failed`.
#   ARTICLE_PUSH_FALLBACK_STATE_FILE — optional one-line state for a caller
#       fallback: `safe` means no commit was published, or a published commit
#       was reconciled to its pre-push tree before this invocation failed.
#   ARTICLE_PUSH_COMMIT_FILE — optional one-line candidate record
#       (`parent<TAB>commit`) written before a push. The batch coordinator uses
#       it to reconcile a commit that was pushed before a later gate failed.
#   ARTICLE_PUSH_SKIPPED_PATHS_FILE — optional file receiving one relative path
#       per line when the monotonic guard keeps a newer remote publication;
#       when set, failure to reset or write this metadata fails the push.
#   ARTICLE_PUSH_PAGES_WAIT_SECONDS — total Pages-wait budget shared by the
#       serialized batches in this invocation; defaults to
#       PAGES_BUILD_WAIT_BUDGET_SECONDS, then 600 when run standalone. A
#       reconciliation gets one bounded wait of its own so the safety rollback
#       is not prevented by an exhausted publication budget.
#
# Exit codes:
#   0 — pushed, or a clean no-op (identical content already live, or the
#       deploy-key secret is not provisioned for this section+locale yet)
#   1 — bad usage, a source relpath is missing on disk, the shard repo has no
#       commits on main yet (needs push-section-shard.sh to seed it first), or
#       the push failed after 3 retries
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

fallback_state_file="${ARTICLE_PUSH_FALLBACK_STATE_FILE:-}"
write_fallback_state() {
  [ -n "$fallback_state_file" ] || return 0
  if ! mkdir -p "$(dirname "$fallback_state_file")" 2>/dev/null; then
    echo "::error::unable to create fallback-state directory for $fallback_state_file" >&2
    return 1
  fi
  if ! printf '%s\n' "$1" > "$fallback_state_file"; then
    echo "::error::unable to write fallback state $fallback_state_file" >&2
    return 1
  fi
}

# A failed combined push may be retried with article paths only, but only when
# the combined writer proves that no commit was published or has reconciled its
# published tree to the pre-push parent. Nested bounded invocations inherit
# this marker from their coordinator and must not reset it between batches.
if [ "${ARTICLE_PUSH_BATCHED:-0}" != '1' ] && ! write_fallback_state safe; then
  exit 1
fi

DEFAULT_ARTICLE_PUSH_BATCH_SIZE=256
article_push_batch_size="${ARTICLE_PUSH_BATCH_SIZE:-$DEFAULT_ARTICLE_PUSH_BATCH_SIZE}"
if ! [[ "$article_push_batch_size" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::ARTICLE_PUSH_BATCH_SIZE must be a positive integer" >&2
  exit 1
fi
article_push_pages_wait_seconds="${ARTICLE_PUSH_PAGES_WAIT_SECONDS:-${PAGES_BUILD_WAIT_BUDGET_SECONDS:-600}}"
if ! [[ "$article_push_pages_wait_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::ARTICLE_PUSH_PAGES_WAIT_SECONDS must be a positive integer" >&2
  exit 1
fi
article_push_pages_deadline="${ARTICLE_PUSH_PAGES_DEADLINE:-}"
if [ -z "$article_push_pages_deadline" ]; then
  article_push_pages_now="$(date +%s)" || {
    echo "::error::cannot establish the shared Pages-wait deadline" >&2
    exit 1
  }
  if ! [[ "$article_push_pages_now" =~ ^[0-9]+$ ]]; then
    echo "::error::the shared Pages-wait clock is unreadable" >&2
    exit 1
  fi
  article_push_pages_deadline=$((article_push_pages_now + article_push_pages_wait_seconds))
elif ! [[ "$article_push_pages_deadline" =~ ^[0-9]+$ ]]; then
  echo "::error::ARTICLE_PUSH_PAGES_DEADLINE must be a Unix timestamp" >&2
  exit 1
fi
# Nested bounded invocations are separate Bash processes: exporting an absolute
# wall-clock deadline, rather than `SECONDS`, keeps every child on the same
# budget instead of starting a fresh wait window for every batch.
export ARTICLE_PUSH_PAGES_DEADLINE="$article_push_pages_deadline"
article_push_pages_poll_seconds="${ARTICLE_PUSH_PAGES_POLL_SECONDS:-5}"
if ! [[ "$article_push_pages_poll_seconds" =~ ^[1-9][0-9]*$ ]]; then
  article_push_pages_poll_seconds=5
fi

# shard_pat_push — the shared token-push fallback for a refused deploy key.
source "$(dirname "${BASH_SOURCE[0]}")/shard-git-helpers.sh"

if [ "$#" -lt 4 ]; then
  echo "Usage: push-article-shard-incremental.sh <section> <locale> <scratch_dist_dir> <relpath1> [relpath2 ...]" >&2
  exit 1
fi
section="$1"
loc="$2"
scratch_dist_dir="$3"
shift 3
relpaths=("$@")

case "$loc" in
  it|en|de|fr) ;;
  *) echo "::error::unsupported locale '$loc' (expected it|de|en|fr)" >&2; exit 1 ;;
esac

# Script-relative, not cwd-relative. `$(pwd)` silently resolved
# section-shard-owners.json to nothing when invoked from anywhere but the repo
# root, and jq's `// "valerielinc-ops"` default then sent the push to the WRONG
# OWNER — these shards belong to nanakokyobashi-rgb. Actions happens to run
# with cwd = repo root, so this never bit in CI, but it is one `cd` away from
# doing so. Falls back to the old behaviour if the layout ever moves.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
[ -f "$repo_root/scripts/lib/section-shard-owners.json" ] || repo_root="$(pwd)"
owners_json="$repo_root/scripts/lib/section-shard-owners.json"
SECTION_UPPER="$(echo "$section" | tr a-z A-Z)"
LOC_UPPER="$(echo "$loc" | tr a-z A-Z)"

# Missing source files are a caller bug (stream C rendered/passed the wrong
# path) — fail loudly rather than silently skip, so the mistake surfaces
# immediately instead of quietly publishing nothing.
for rel in "${relpaths[@]}"; do
  if [ ! -f "$scratch_dist_dir/$rel" ]; then
    echo "::error::source file missing: $scratch_dist_dir/$rel" >&2
    exit 1
  fi
done

SHARD_OWNER="$(jq -r --arg s "$section" '.[$s] // "valerielinc-ops"' "$owners_json" 2>/dev/null || echo valerielinc-ops)"
if [ -z "$SHARD_OWNER" ] || [ "$SHARD_OWNER" = "null" ]; then SHARD_OWNER="valerielinc-ops"; fi
SHARD_REPO="git@github.com:$SHARD_OWNER/frontaliere-$section-$loc.git"
if [ -n "${SHARD_REPO_OVERRIDE:-}" ]; then
  SHARD_REPO="$SHARD_REPO_OVERRIDE"
fi

# Select the PAT from the same owner-aware resolver used by the fallback. The
# direct HTTPS path must not silently fall back to the site's GITHUB_PAT for a
# shard owned by nanakokyobashi-rgb.
shard_push_token="$(shard_push_token_for_repo "$SHARD_REPO")"

# Per-section-per-locale deploy key via indirect expansion (mirrors
# push-section-shard.sh). Missing → skip, exit 0 — the caller (the fast-path
# workflow) treats this the same as "fast path not provisioned yet" and lets
# the article ride the next full deploy instead.
key_var="SHARD_${SECTION_UPPER}_${LOC_UPPER}_DEPLOY_KEY"
key_val="${!key_var:-}"

# PAT MODE (issue #4974 item 3). Historically a missing deploy key meant
# "fast path not provisioned" and this script exited 0 — a SILENT no-op that
# the caller reports as success. That was right when the shards belonged to
# another owner and the only write credential was an SSH deploy key.
#
# It is wrong now: scripts/lib/section-shard-owners.json puts both article
# sections under nanakokyobashi-rgb, this repo, and Remote Config's GITHUB_PAT
# token is selected by shard_push_token_for_repo for the canonical shard owner
# (GITHUB_PAT_NANAKO for nanakokyobashi-rgb).
#
# The migration doc's §10.2 says `shard_pat_push`'s "$SHARD_PUSH_PAT, else
# $GITHUB_PAT" fallback already makes the deploy keys irrelevant here. It does
# not: that fallback sits AFTER the retry loop, and the deploy-key gate above
# used to exit 0 long before anything reached it. Measured on run 30813668145 —
# every locale logged "not provisioned", zero HTML reached any shard, and the
# workflow still went green.
#
# So: no deploy key + a usable PAT => push over HTTPS instead of no-op. Only
# when NEITHER credential exists is a skip still the right answer.
pat_mode=0
if [ -z "$key_val" ]; then
  if [ -n "$shard_push_token" ]; then
    pat_mode=1
    echo "no $key_var secret — pushing $loc $section over HTTPS with the PAT instead"
  else
    echo "no $key_var secret and no owner-aware shard PAT — skipping $loc $section article fast-path push (no write credential)"
    if [ -n "${ARTICLE_PUSH_STATUS_FILE:-}" ]; then
      printf '%s\n' 'clean-no-op' > "$ARTICLE_PUSH_STATUS_FILE" || true
    fi
    exit 0
  fi
fi

if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  echo "ℹ️ RUNNER_TEMP unset — using temp dir $RUNNER_TEMP"
fi

# Keep the option array defined, but use the guarded expansion below: Bash 3.2
# still treats an empty array as unset under `set -u`. Empty in deploy-key mode.
GIT_PAT_OPTS=()
keyfile="$RUNNER_TEMP/article-shard_${section}_${loc}_key"
if [ "$pat_mode" = 0 ]; then
  printf '%s\n' "$key_val" > "$keyfile" && chmod 600 "$keyfile"
  export GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o TCPKeepAlive=yes"
else
  # HTTPS remote + the same credential helper shard_pat_push uses: the token is
  # read from $SHARD_PUSH_TOKEN inside the helper, so it never reaches the
  # remote URL, argv, or a `set -x` trace.
  SHARD_PUSH_TOKEN="$shard_push_token"
  export SHARD_PUSH_TOKEN
  echo "::add-mask::$SHARD_PUSH_TOKEN"
  SHARD_REPO="$(shard_https_push_url "$SHARD_REPO")" || {
    echo "::error::cannot derive an HTTPS URL for $SHARD_REPO" >&2; exit 1; }
  GIT_PAT_OPTS=(-c credential.helper= -c "credential.helper=$_SHARD_CRED_HELPER")
fi

stage="$RUNNER_TEMP/article-shard-$section-$loc"
# Incident #4734 was an unfreed-staging-dir class (runner disk exhaustion) —
# a script-level EXIT trap covers every return path (success, retry-exhausted
# failure, bad usage exit above already returned before this point anyway),
# not just the happy path.
trap 'rm -rf "$stage" 2>/dev/null || true; rm -f "$keyfile" 2>/dev/null || true' EXIT

permanent_fail=0
# Set by _attempt once it has a commit to push; read by the PAT fallback after
# the retry loop. Declared here because `set -u` is on.
last_commit=''
last_commit_parent=''
last_push_status=''
last_skipped_newer_count=0
last_skipped_newer_names=''
last_skipped_newer_paths=()
last_commit_skipped_newer_count=0
last_commit_skipped_newer_names=''
last_commit_skipped_newer_paths=()
last_history_warning_count=0

article_content_revision="${ARTICLE_CONTENT_REVISION:-}"
if [ -n "$article_content_revision" ] && ! [[ "$article_content_revision" =~ ^[0-9]+\.[0-9A-Fa-f]{7,40}$ ]]; then
  echo "::error::ARTICLE_CONTENT_REVISION must be <epoch>.<sha> (7–40 hexadecimal characters)" >&2
  exit 1
fi

remote_newer_paths=()

pages_build_commit_matches() {
  local expected="$1" observed="$2"
  local expected_lc observed_lc
  expected_lc="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
  observed_lc="$(printf '%s' "$observed" | tr 'A-F' 'a-f')"
  [ -n "$observed_lc" ] || return 1
  [ "$expected_lc" = "$observed_lc" ] && return 0
  case "$expected_lc" in
    "$observed_lc"*) return 0 ;;
  esac
  case "$observed_lc" in
    "$expected_lc"*) return 0 ;;
  esac
  return 1
}

# GitHub Pages starts a deployment for every push to a shard repository. A
# successful `git push` is therefore only the hand-off, not the end of a
# serialized batch: starting the next push while this build is queued/building
# recreates the very race this helper is meant to remove. Local/file remotes
# have no Pages API and deliberately skip this external wait; production shard
# remotes are GitHub URLs and fail closed when their build cannot be observed.
wait_for_pages_build() {
  local pushed_commit="$1" requested_deadline="${2:-$article_push_pages_deadline}"
  local pages_url pages_repo token body pages_status pages_commit
  local deadline remaining current_epoch request_timeout

  if ! [[ "$requested_deadline" =~ ^[0-9]+$ ]]; then
    echo "::error::cannot wait for Pages build of $pushed_commit: invalid deadline" >&2
    return 1
  fi
  deadline="$requested_deadline"

  if ! pages_url="$(shard_https_push_url "$SHARD_REPO")"; then
    echo "ℹ️ $section-$loc article shard: Pages build wait skipped for non-GitHub remote"
    return 0
  fi
  pages_repo="${pages_url#https://github.com/}"
  pages_repo="${pages_repo%.git}"
  if ! [[ "$pages_repo" =~ ^[^/]+/[^/]+$ ]]; then
    echo "::error::cannot derive the GitHub Pages repository from $SHARD_REPO" >&2
    return 1
  fi
  token="$(shard_push_token_for_repo "$SHARD_REPO")"
  if [ -z "$token" ]; then
    echo "::error::cannot wait for Pages build of $pages_repo: owner-aware shard PAT missing" >&2
    return 1
  fi

  while :; do
    current_epoch="$(date +%s)" || {
      echo "::error::cannot read the shared Pages-wait clock for $pages_repo commit $pushed_commit" >&2
      return 1
    }
    if ! [[ "$current_epoch" =~ ^[0-9]+$ ]]; then
      echo "::error::the shared Pages-wait clock is unreadable for $pages_repo commit $pushed_commit" >&2
      return 1
    fi
    remaining=$((deadline - current_epoch))
    if [ "$remaining" -le 0 ]; then
      echo "::error::timed out waiting for Pages build of $pages_repo commit $pushed_commit before the shared deadline" >&2
      return 1
    fi
    request_timeout=20
    if [ "$remaining" -lt "$request_timeout" ]; then
      request_timeout="$remaining"
    fi
    body=''
    if ! body="$(curl -sS --max-time "$request_timeout" \
      -H "Authorization: Bearer $token" \
      -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$pages_repo/pages/builds/latest" 2>/dev/null)"; then
      body=''
    fi
    pages_status="$(printf '%s' "$body" | jq -r '.status // ""' 2>/dev/null || true)"
    pages_commit="$(printf '%s' "$body" | jq -r '
      if (.commit | type) == "object" then (.commit.sha // "")
      elif (.commit | type) == "string" then .commit
      else (.sha // "") end
    ' 2>/dev/null || true)"

    current_epoch="$(date +%s)" || {
      echo "::error::cannot read the shared Pages-wait clock for $pages_repo commit $pushed_commit" >&2
      return 1
    }
    if ! [[ "$current_epoch" =~ ^[0-9]+$ ]]; then
      echo "::error::the shared Pages-wait clock is unreadable for $pages_repo commit $pushed_commit" >&2
      return 1
    fi
    remaining=$((deadline - current_epoch))
    if [ "$remaining" -le 0 ]; then
      echo "::error::timed out waiting for Pages build of $pages_repo commit $pushed_commit before the shared deadline" >&2
      return 1
    fi
    if pages_build_commit_matches "$pushed_commit" "$pages_commit"; then
      case "$pages_status" in
        built)
          echo "✅ $section-$loc article shard: Pages build for $pushed_commit is built"
          return 0
          ;;
        errored|cancelled|failure|failed)
          echo "::error::Pages build for $pages_repo commit $pushed_commit ended as '$pages_status'" >&2
          return 1
          ;;
      esac
    fi

    echo "⏳ $section-$loc article shard: Pages build for $pushed_commit is '${pages_status:-not visible yet}' (waiting ${remaining}s)"
    if [ "$remaining" -lt "$article_push_pages_poll_seconds" ]; then
      sleep "$remaining"
    else
      sleep "$article_push_pages_poll_seconds"
    fi
  done
}

append_remote_newer_path() {
  local candidate="$1"
  local existing
  if [ "${#remote_newer_paths[@]}" -gt 0 ]; then
    for existing in "${remote_newer_paths[@]}"; do
      [ "$existing" = "$candidate" ] && return 0
    done
  fi
  remote_newer_paths+=("$candidate")
}

# True when the page published from `remote` must be kept over one rendered
# from `own`: a later epoch, or the same second with a different commit. Two
# corpus commits of one second cannot be ordered from here, so the remote one
# is treated as newer. The same commit (one SHA a prefix of the other) is the
# same revision and stays replaceable: that is a re-render of the same content,
# for instance with a newer shell.
remote_revision_wins() {
  local remote="$1" own="$2"
  local remote_epoch="${remote%%.*}" own_epoch="${own%%.*}"
  local remote_sha own_sha
  remote_sha="$(printf '%s' "${remote#*.}" | tr 'A-F' 'a-f')"
  own_sha="$(printf '%s' "${own#*.}" | tr 'A-F' 'a-f')"
  if [ "$remote_epoch" -gt "$own_epoch" ]; then return 0; fi
  if [ "$remote_epoch" -lt "$own_epoch" ]; then return 1; fi
  case "$remote_sha" in "$own_sha"*) return 1 ;; esac
  case "$own_sha" in "$remote_sha"*) return 1 ;; esac
  return 0
}

# A history that cannot be read is not "nothing newer": it is exactly the case
# in which a newer page could be overwritten without anyone noticing. The
# attempt fails before any commit is built, the caller retries, and a history
# that stays unreadable fails the push.
history_unavailable() {
  echo "::warning::monotonic guard: $1; refusing to publish without the shard history" >&2
  last_history_warning_count=$((last_history_warning_count + 1))
  remote_newer_paths=()
  return 1
}

collect_path_scoped_commits() {
  local pathspec_budget=32768
  local pathspec_bytes=0
  local path path_bytes
  local -a pathspec_chunk=()

  # Keep every invocation comfortably below the runner's ARG_MAX. The caller
  # already passed the paths to this process, but a batch can still be large
  # enough for one `git log ... -- path...` invocation to fail. Git has no
  # pathspec-from-file option for log/rev-list, so chunk the exact paths and
  # deduplicate the resulting commit list at the call site.
  for path in "$@"; do
    path_bytes=${#path}
    if [ "${#pathspec_chunk[@]}" -gt 0 ] && [ $((pathspec_bytes + path_bytes + 1)) -gt "$pathspec_budget" ]; then
      git -C "$stage" --literal-pathspecs log --format=%H --full-history HEAD -- "${pathspec_chunk[@]}" || return 1
      pathspec_chunk=()
      pathspec_bytes=0
    fi
    pathspec_chunk+=("$path")
    pathspec_bytes=$((pathspec_bytes + path_bytes + 1))
  done

  if [ "${#pathspec_chunk[@]}" -gt 0 ]; then
    git -C "$stage" --literal-pathspecs log --format=%H --full-history HEAD -- "${pathspec_chunk[@]}" || return 1
  fi
}

# Return every path changed by a commit against every one of its parents.
# Comparing only "$commit^" is insufficient for a merge whose resolved tree
# happens to match the first parent for a requested path: that path can still
# differ from a non-first parent and therefore be part of the newer
# publication. A shallow commit with no readable parents remains unreadable;
# only a genuine root commit is allowed to use --root.
diffTreeMergeParents() {
  local commit="$1"
  local parent_line parent
  parent_line="$(git -C "$stage" rev-list --parents -n 1 "$commit" 2>/dev/null)" || return 1
  [ -n "$parent_line" ] || return 1

  set -- $parent_line
  [ "$1" = "$commit" ] || return 1
  shift
  if [ "$#" -eq 0 ]; then
    if [ -f "$shallow_file" ] && grep -qx "$commit" "$shallow_file" 2>/dev/null; then
      return 1
    fi
    git -C "$stage" diff-tree --root --no-commit-id --name-only -r "$commit" 2>/dev/null
    return $?
  fi

  for parent in "$@"; do
    git -C "$stage" diff-tree --no-commit-id --name-only -r "$parent" "$commit" 2>/dev/null || return 1
  done
}

collect_remote_newer_paths() {
  local own_revision="$1"
  local own_epoch="${own_revision%%.*}"
  local head_epoch boundary commits commit commit_epoch trailer trailer_valid trailer_wins changed_path changed_paths shallow_file requested_path
  remote_newer_paths=()

  head_epoch="$(git -C "$stage" show -s --format=%ct HEAD 2>/dev/null)" || {
    history_unavailable "cannot read the shard HEAD timestamp"
    return 1
  }
  if ! [[ "$head_epoch" =~ ^[0-9]+$ ]]; then
    history_unavailable "the shard HEAD timestamp is unreadable"
    return 1
  fi
  # A commit is never older than the corpus revision it publishes: if the shard
  # head predates this revision, no commit can carry a newer or equal one, and
  # nothing else is read.
  if [ "$head_epoch" -lt "$own_epoch" ]; then return 0; fi

  boundary=$((own_epoch - 3600))
  if ! git -C "$stage" fetch --quiet --filter=blob:none --shallow-since="$boundary" origin main >/dev/null 2>&1; then
    history_unavailable "the shard history fetch failed"
    return 1
  fi
  # The oldest commit of that window comes without its parent, and on a quiet
  # shard that commit IS the newer publication (the one before it is hours
  # old): with nothing to diff it against, its paths would not be recognised
  # and the page would be overwritten. One more level puts the parent on disk.
  # Only while the clone is still shallow: on a history that the window made
  # complete, --deepen would cut it back to one commit.
  if [ "$(git -C "$stage" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
    if ! git -C "$stage" fetch --quiet --filter=blob:none --deepen=1 origin main >/dev/null 2>&1; then
      history_unavailable "the shard history deepen failed"
      return 1
    fi
  fi
  shallow_file="$(git -C "$stage" rev-parse --absolute-git-dir 2>/dev/null)/shallow"
  # The shard can receive many fast-path publications in one hour. Walking
  # every commit in that window and then diffing each tree made the monotonic
  # guard scale with unrelated articles. Git can walk only the paths we are
  # about to replace; the helper keeps each argv chunk below 32 KiB, treats
  # every path literally, and the sort removes commits found in multiple
  # chunks. Keep the subsequent diff-tree check: it still fail-closes on a
  # malformed shallow boundary and proves which requested paths each selected
  # commit touched.
  commits="$(collect_path_scoped_commits "${relpaths[@]}" | LC_ALL=C sort -u)" || {
    history_unavailable "the shard history is unreadable"
    return 1
  }
  while IFS= read -r commit; do
    [ -n "$commit" ] || continue
    commit_epoch="$(git -C "$stage" show -s --format=%ct "$commit" 2>/dev/null)" || {
      history_unavailable "cannot read the timestamp of shard commit $commit"
      return 1
    }
    if ! [[ "$commit_epoch" =~ ^[0-9]+$ ]]; then
      history_unavailable "the timestamp of shard commit $commit is unreadable"
      return 1
    fi
    trailer="$(git -C "$stage" show -s --format='%(trailers:key=Content-Rev,valueonly)' "$commit" 2>/dev/null)" || {
      history_unavailable "cannot inspect shard commit $commit"
      return 1
    }
    trailer_valid=0
    trailer_wins=0
    if [[ "$trailer" =~ ^[0-9]+\.[0-9A-Fa-f]{7,40}$ ]]; then
      trailer_valid=1
      if remote_revision_wins "$trailer" "$own_revision"; then trailer_wins=1; fi
      # A valid older publication cannot protect any requested path and may be
      # the shallow legacy boundary whose parent is deliberately unavailable.
      [ "$trailer_wins" = 1 ] || continue
    elif [ "$commit_epoch" -lt "$own_epoch" ]; then
      # Explicit timestamp-verified legacy boundary: it predates the incoming
      # content and therefore cannot be the newer writer we must preserve.
      continue
    fi
    # Paths decide whether an otherwise invalid recent trailer is relevant. A
    # commit without exactly one valid Content-Rev is not harmless when it
    # touches one of the requested pages: its ordering is unknowable and must
    # fail closed.
    changed_paths="$(diffTreeMergeParents "$commit")" || changed_paths='__unreadable__'
    if [ "$changed_paths" = '__unreadable__' ]; then
      history_unavailable "cannot list the paths of shard commit $commit"
      return 1
    fi
    local -a relevant_paths=()
    while IFS= read -r changed_path; do
      [ -n "$changed_path" ] || continue
      for requested_path in "${relpaths[@]}"; do
        if [ "$changed_path" = "$requested_path" ]; then
          relevant_paths+=("$changed_path")
          break
        fi
      done
    done <<< "$changed_paths"
    [ "${#relevant_paths[@]}" -gt 0 ] || continue
    if [ "$trailer_valid" != 1 ]; then
      history_unavailable "relevant shard commit $commit has a missing or malformed Content-Rev"
      return 1
    fi
    for changed_path in "${relevant_paths[@]}"; do
      append_remote_newer_path "$changed_path"
    done
  done <<< "$commits"
}

write_push_summary() {
  local summary_file="${ARTICLE_PUSH_SUMMARY_FILE:-}"
  [ -n "$summary_file" ] || return 0
  if ! mkdir -p "$(dirname "$summary_file")" 2>/dev/null; then
    echo "::warning::unable to create push summary directory for $summary_file" >&2
    return 0
  fi
  printf '%s\t%s\t%s\t%s\n' \
    "$section-$loc" \
    "$last_skipped_newer_count" \
    "$last_skipped_newer_names" \
    "$last_history_warning_count" > "$summary_file" || true
}

reset_skipped_newer_paths() {
  local skipped_file="${ARTICLE_PUSH_SKIPPED_PATHS_FILE:-}"
  [ -n "$skipped_file" ] || return 0
  if ! mkdir -p "$(dirname "$skipped_file")" 2>/dev/null; then
    echo "::error::unable to create skipped-path directory for $skipped_file" >&2
    return 1
  fi
  if ! : > "$skipped_file"; then
    echo "::error::unable to reset skipped-path file $skipped_file" >&2
    return 1
  fi
}

write_skipped_newer_paths() {
  local skipped_file="${ARTICLE_PUSH_SKIPPED_PATHS_FILE:-}"
  [ -n "$skipped_file" ] || return 0
  if ! mkdir -p "$(dirname "$skipped_file")" 2>/dev/null; then
    echo "::error::unable to create skipped-path directory for $skipped_file" >&2
    return 1
  fi
  if ! : > "$skipped_file"; then
    echo "::error::unable to reset skipped-path file $skipped_file" >&2
    return 1
  fi
  if [ "${#last_skipped_newer_paths[@]}" -gt 0 ] && ! printf '%s\n' "${last_skipped_newer_paths[@]}" > "$skipped_file"; then
    echo "::error::unable to write skipped-path file $skipped_file" >&2
    return 1
  fi
}

restore_last_commit_skipped_newer_paths() {
  last_skipped_newer_count="$last_commit_skipped_newer_count"
  last_skipped_newer_names="$last_commit_skipped_newer_names"
  last_skipped_newer_paths=("${last_commit_skipped_newer_paths[@]}")
  write_skipped_newer_paths
}

write_push_status() {
  local status_file="${ARTICLE_PUSH_STATUS_FILE:-}"
  [ -n "$status_file" ] || return 0
  if ! mkdir -p "$(dirname "$status_file")" 2>/dev/null; then
    echo "::warning::unable to create push status directory for $status_file" >&2
    return 0
  fi
  printf '%s\n' "$1" > "$status_file" || true
}

write_push_commit() {
  local commit_file="${ARTICLE_PUSH_COMMIT_FILE:-}"
  [ -n "$commit_file" ] || return 0
  if ! mkdir -p "$(dirname "$commit_file")" 2>/dev/null; then
    echo "::error::unable to create commit-record directory for $commit_file" >&2
    return 1
  fi
  if ! printf '%s\t%s\n' "$1" "$2" > "$commit_file"; then
    echo "::error::unable to write commit record $commit_file" >&2
    return 1
  fi
}

rollback_serialized_publications() {
  local rollback_root="$1" base_commit="$2"
  shift 2
  local -a candidate_commits=("$@")
  local remote_head rollback_stage base_tree current_tree rollback_tree rollback_commit
  local rollback_content_revision rollback_deadline
  local candidate candidate_found=0 clone_err

  if [ -z "$base_commit" ] || [ "${#candidate_commits[@]}" -eq 0 ]; then
    echo "::error::serialized push failed without a complete rollback base" >&2
    return 1
  fi

  remote_head="$(git ${GIT_PAT_OPTS[@]+"${GIT_PAT_OPTS[@]}"} ls-remote "$SHARD_REPO" refs/heads/main 2>/dev/null | awk 'NR == 1 { print $1 }')"
  if ! [[ "$remote_head" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "::error::cannot read $section-$loc shard HEAD for serialized-push rollback" >&2
    return 1
  fi
  if [ "$remote_head" = "$base_commit" ]; then
    echo "ℹ️ $section-$loc article shard: failed batch left the pre-batch tree live"
    return 0
  fi
  for candidate in "${candidate_commits[@]}"; do
    if [ "$candidate" = "$remote_head" ]; then
      candidate_found=1
      break
    fi
  done
  if [ "$candidate_found" != 1 ]; then
    echo "::error::refusing serialized-push rollback: shard HEAD $remote_head is not one of our batch commits" >&2
    return 1
  fi

  rollback_stage="$rollback_root/rollback-stage"
  rm -rf "$rollback_stage"
  clone_err="$(mktemp)"
  if ! git ${GIT_PAT_OPTS[@]+"${GIT_PAT_OPTS[@]}"} clone -q --depth 1 --filter=blob:none --no-checkout "$SHARD_REPO" "$rollback_stage" 2>"$clone_err"; then
    echo "::error::serialized-push rollback clone failed: $(cat "$clone_err")" >&2
    rm -f "$clone_err"
    return 1
  fi
  rm -f "$clone_err"
  if [ "$(git -C "$rollback_stage" rev-parse HEAD 2>/dev/null)" != "$remote_head" ]; then
    echo "::error::refusing serialized-push rollback: shard moved during reconciliation clone" >&2
    return 1
  fi
  if ! git ${GIT_PAT_OPTS[@]+"${GIT_PAT_OPTS[@]}"} -C "$rollback_stage" fetch --quiet --filter=blob:none --no-tags origin "$base_commit" >/dev/null 2>&1; then
    echo "::error::serialized-push rollback could not fetch the pre-batch commit $base_commit" >&2
    return 1
  fi
  if ! git -C "$rollback_stage" cat-file -e "$base_commit^{commit}" >/dev/null 2>&1 || \
     ! git -C "$rollback_stage" merge-base --is-ancestor "$base_commit" "$remote_head" >/dev/null 2>&1; then
    echo "::error::refusing serialized-push rollback: pre-batch commit $base_commit is not an ancestor of shard HEAD" >&2
    return 1
  fi

  git -C "$rollback_stage" config user.email "${GIT_AUTHOR_EMAIL:-actions@users.noreply.github.com}" || return 1
  git -C "$rollback_stage" config user.name "${GIT_AUTHOR_NAME:-GitHub Actions}" || return 1
  base_tree="$(git -C "$rollback_stage" rev-parse "$base_commit^{tree}")" || return 1
  current_tree="$(git -C "$rollback_stage" rev-parse "$remote_head^{tree}")" || return 1
  if [ "$base_tree" = "$current_tree" ]; then
    echo "ℹ️ $section-$loc article shard: batch commits changed history but not the published tree; no rollback commit needed"
    return 0
  fi
  git -C "$rollback_stage" read-tree "$base_commit" || return 1
  rollback_tree="$(git -C "$rollback_stage" write-tree --missing-ok)" || return 1
  rollback_content_revision="$(git -C "$rollback_stage" show -s --format='%(trailers:key=Content-Rev,valueonly)' "$base_commit" 2>/dev/null || true)"
  if ! [[ "$rollback_content_revision" =~ ^[0-9]+\.[0-9A-Fa-f]{7,40}$ ]]; then
    # A legacy base can have no trailer. The current publication revision is
    # still coherent for the monotonic guard: the restored tree is explicitly
    # the pre-push state of this same publication attempt, so the article-only
    # fallback may replace it instead of treating reconciliation as newer.
    rollback_content_revision="$article_content_revision"
  fi
  if [ -n "$rollback_content_revision" ]; then
    rollback_commit="$(git -C "$rollback_stage" commit-tree "$rollback_tree" -p "$remote_head" \
      -m "$section-$loc article shard publication reconciliation" \
      -m "Restore the pre-push tree after the Pages gate for a published commit failed." \
      -m "Content-Rev: $rollback_content_revision")" || return 1
  else
    rollback_commit="$(git -C "$rollback_stage" commit-tree "$rollback_tree" -p "$remote_head" \
      -m "$section-$loc article shard publication reconciliation" \
      -m "Restore the pre-push tree after the Pages gate for a published commit failed.")" || return 1
  fi
  if ! git ${GIT_PAT_OPTS[@]+"${GIT_PAT_OPTS[@]}"} -C "$rollback_stage" push "$SHARD_REPO" "$rollback_commit":main; then
    echo "::error::serialized-push rollback push failed; the shard may need manual reconciliation" >&2
    return 1
  fi
  # The publication chain may have consumed the shared deadline. Reconciliation
  # is the safety action that restores the complete tree, so give its Pages gate
  # one fresh bounded window instead of letting the expired batch budget make a
  # successful rollback look failed.
  rollback_deadline="$(date +%s)" || return 1
  if ! [[ "$rollback_deadline" =~ ^[0-9]+$ ]]; then
    echo "::error::the reconciliation Pages-wait clock is unreadable" >&2
    return 1
  fi
  rollback_deadline=$((rollback_deadline + article_push_pages_wait_seconds))
  if ! wait_for_pages_build "$rollback_commit" "$rollback_deadline"; then
    echo "::error::serialized-push rollback reached git but its Pages build did not complete" >&2
    return 1
  fi
  echo "✅ $section-$loc article shard: reconciled failed serialized push with rollback commit $rollback_commit"
}

reconcile_failed_publication() {
  local base_commit="$1" failed_commit="$2" rollback_root
  rollback_root="$(mktemp -d "$RUNNER_TEMP/article-shard-reconcile.XXXXXX")" || {
    echo "::error::unable to create the article-shard reconciliation directory" >&2
    return 1
  }
  if rollback_serialized_publications "$rollback_root" "$base_commit" "$failed_commit"; then
    rm -rf "$rollback_root"
    return 0
  fi
  rm -rf "$rollback_root"
  return 1
}

load_serialized_batch_groups() {
  local group_file="${ARTICLE_PUSH_BATCH_GROUPS_FILE:-}"
  local key path found_index index
  local expected_sorted actual_sorted
  serialized_group_keys=()
  serialized_group_paths=()

  if [ -z "$group_file" ]; then
    for index in "${!relpaths[@]}"; do
      serialized_group_keys+=("path-$index")
      serialized_group_paths+=("${relpaths[$index]}")
    done
    return 0
  fi
  if [ ! -f "$group_file" ]; then
    echo "::error::ARTICLE_PUSH_BATCH_GROUPS_FILE is missing: $group_file" >&2
    return 1
  fi

  while IFS=$'\t' read -r key path; do
    [ -z "$key" ] && [ -z "$path" ] && continue
    if [ -z "$key" ] || [ -z "$path" ] || [[ "$path" == *$'\n'* ]] || [[ "$path" == *$'\t'* ]]; then
      echo "::error::invalid serialized batch group row in $group_file" >&2
      return 1
    fi
    found_index=-1
    for index in "${!serialized_group_keys[@]}"; do
      if [ "${serialized_group_keys[$index]}" = "$key" ]; then
        found_index="$index"
        break
      fi
    done
    if [ "$found_index" -lt 0 ]; then
      serialized_group_keys+=("$key")
      serialized_group_paths+=("$path")
    else
      serialized_group_paths[found_index]+=$'\n'"$path"
    fi
  done < "$group_file"

  if [ "${#serialized_group_keys[@]}" -eq 0 ]; then
    echo "::error::ARTICLE_PUSH_BATCH_GROUPS_FILE is empty" >&2
    return 1
  fi
  expected_sorted="$(printf '%s\n' "${relpaths[@]}" | LC_ALL=C sort)"
  actual_sorted=""
  for index in "${!serialized_group_paths[@]}"; do
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      actual_sorted+="$path"$'\n'
    done <<< "${serialized_group_paths[$index]}"
  done
  actual_sorted="$(printf '%s' "$actual_sorted" | LC_ALL=C sort)"
  if [ "$expected_sorted" != "$actual_sorted" ]; then
    echo "::error::serialized batch group manifest does not contain exactly the supplied paths" >&2
    return 1
  fi
}

run_serialized_batches() {
  local batch_root
  local aggregate_status='clean-no-op'
  local aggregate_warning_count=0
  local skipped_path shown_count aggregate_names=''
  local group_size group_path group_index batch_rc
  local batch_number=0 current_batch_count=0
  local -a aggregate_skipped=()
  local -a current_batch=()
  local -a serialized_group_keys=()
  local -a serialized_group_paths=()
  local -a serialized_commits=()
  local serialized_base_commit='' serialized_metadata_ok=1 serialized_chain_ok=1

  batch_root="$(mktemp -d "$RUNNER_TEMP/article-shard-batches.XXXXXX")" || {
    echo "::error::unable to create the serialized article-push batch directory" >&2
    write_push_status 'failed'
    return 1
  }

  echo "$section-$loc article shard: serializing ${#relpaths[@]} path(s) in batches of $article_push_batch_size"
  if ! load_serialized_batch_groups; then
    write_push_status 'failed'
    rm -rf "$batch_root"
    return 1
  fi

  record_serialized_commit() {
    local record_file="$1" record parent commit
    [ -s "$record_file" ] || return 0
    record="$(head -n 1 "$record_file")"
    IFS=$'\t' read -r parent commit <<< "$record"
    if ! [[ "$parent" =~ ^[0-9a-fA-F]{40}$ && "$commit" =~ ^[0-9a-fA-F]{40}$ ]] || [ "$parent" = "$commit" ]; then
      echo "::error::invalid serialized batch commit record: $record_file" >&2
      serialized_metadata_ok=0
      return 1
    fi
    if [ -z "$serialized_base_commit" ]; then
      serialized_base_commit="$parent"
    elif [ "${serialized_commits[${#serialized_commits[@]}-1]:-}" != "$parent" ]; then
      echo "::error::serialized batch chain moved outside this invocation; rollback is not safe" >&2
      serialized_chain_ok=0
    fi
    serialized_commits+=("$commit")
  }

  serialized_batch_failure() {
    local reason="$1"
    echo "::error::$reason" >&2
    if [ "${#serialized_commits[@]}" -gt 0 ]; then
      if [ "$serialized_metadata_ok" != 1 ] || [ "$serialized_chain_ok" != 1 ]; then
        echo "::error::serialized-push rollback skipped because its commit chain could not be proven" >&2
      elif rollback_serialized_publications "$batch_root" "$serialized_base_commit" "${serialized_commits[@]}"; then
        if ! write_fallback_state safe; then
          echo "::error::serialized-push rollback completed but the fallback safety marker could not be written" >&2
        fi
      else
        echo "::error::serialized-push rollback failed; no complete publication can be claimed" >&2
      fi
    fi
    write_push_status 'failed'
    rm -rf "$batch_root"
    return 1
  }

  serialized_batch_deadline_available() {
    local current_epoch remaining
    current_epoch="$(date +%s)" || {
      serialized_batch_failure "cannot read the shared Pages-wait clock before serialized batch $((batch_number + 1))"
      return $?
    }
    if ! [[ "$current_epoch" =~ ^[0-9]+$ ]]; then
      serialized_batch_failure "the shared Pages-wait clock is unreadable before serialized batch $((batch_number + 1))"
      return $?
    fi
    remaining=$((article_push_pages_deadline - current_epoch))
    if [ "$remaining" -le 0 ]; then
      serialized_batch_failure "shared Pages-wait deadline exhausted before serialized batch $((batch_number + 1)); reconciling published batches"
      return $?
    fi
    return 0
  }

  run_one_serialized_batch() {
    local batch_status_file batch_skipped_file batch_summary_file batch_commit_file
    local batch_status_value batch_warning_value
    local -a batch_paths=("$@")
    batch_status_file="$batch_root/status-$batch_number"
    batch_skipped_file="$batch_root/skipped-$batch_number"
    batch_summary_file="$batch_root/summary-$batch_number"
    batch_commit_file="$batch_root/commit-$batch_number"
    rm -f "$batch_status_file" "$batch_skipped_file" "$batch_summary_file" "$batch_commit_file"

    if ! ARTICLE_PUSH_BATCHED=1 \
      ARTICLE_PUSH_PAGES_DEADLINE="$article_push_pages_deadline" \
      ARTICLE_PUSH_STATUS_FILE="$batch_status_file" \
      ARTICLE_PUSH_SKIPPED_PATHS_FILE="$batch_skipped_file" \
      ARTICLE_PUSH_SUMMARY_FILE="$batch_summary_file" \
      ARTICLE_PUSH_COMMIT_FILE="$batch_commit_file" \
      bash "$0" "$section" "$loc" "$scratch_dist_dir" "${batch_paths[@]}"; then
      record_serialized_commit "$batch_commit_file" || true
      return 1
    fi
    record_serialized_commit "$batch_commit_file" || return 1

    if [ ! -s "$batch_status_file" ]; then
      return 2
    fi
    batch_status_value="$(tr -d '\r\n' < "$batch_status_file")"
    case "$batch_status_value" in
      pushed)
        aggregate_status='pushed'
        ;;
      remote-newer)
        if [ "$aggregate_status" = 'clean-no-op' ]; then aggregate_status='remote-newer'; fi
        ;;
      clean-no-op)
        ;;
      *)
        return 3
        ;;
    esac

    if [ -s "$batch_skipped_file" ]; then
      while IFS= read -r skipped_path; do
        [ -n "$skipped_path" ] || continue
        aggregate_skipped+=("$skipped_path")
      done < "$batch_skipped_file"
    fi
    if [ -s "$batch_summary_file" ]; then
      batch_warning_value="$(cut -f4 "$batch_summary_file")"
      if [[ "$batch_warning_value" =~ ^[0-9]+$ ]]; then
        aggregate_warning_count=$((aggregate_warning_count + batch_warning_value))
      fi
    fi
    batch_number=$((batch_number + 1))
    return 0
  }

  for group_index in "${!serialized_group_paths[@]}"; do
    group_size=0
    while IFS= read -r group_path; do
      [ -n "$group_path" ] || continue
      group_size=$((group_size + 1))
    done <<< "${serialized_group_paths[$group_index]}"
    if [ "$group_size" -gt "$article_push_batch_size" ]; then
      serialized_batch_failure "dependency group '${serialized_group_keys[$group_index]}' has $group_size path(s), above ARTICLE_PUSH_BATCH_SIZE=$article_push_batch_size"
      return $?
    fi
    if [ "$current_batch_count" -gt 0 ] && [ $((current_batch_count + group_size)) -gt "$article_push_batch_size" ]; then
      if ! serialized_batch_deadline_available; then return 1; fi
      run_one_serialized_batch "${current_batch[@]}"
      batch_rc=$?
      if [ "$batch_rc" -ne 0 ]; then
        case "$batch_rc" in
          2) serialized_batch_failure "serialized article-push batch $((batch_number + 1)) finished without a status" ;;
          3) serialized_batch_failure "serialized article-push batch $((batch_number + 1)) returned an invalid status" ;;
          *) serialized_batch_failure "serialized article-push batch $((batch_number + 1)) failed for $section-$loc" ;;
        esac
        return $?
      fi
      current_batch=()
      current_batch_count=0
    fi
    while IFS= read -r group_path; do
      [ -n "$group_path" ] || continue
      current_batch+=("$group_path")
    done <<< "${serialized_group_paths[$group_index]}"
    current_batch_count=$((current_batch_count + group_size))
    if [ "$current_batch_count" -ge "$article_push_batch_size" ]; then
      if ! serialized_batch_deadline_available; then return 1; fi
      run_one_serialized_batch "${current_batch[@]}"
      batch_rc=$?
      if [ "$batch_rc" -ne 0 ]; then
        case "$batch_rc" in
          2) serialized_batch_failure "serialized article-push batch $((batch_number + 1)) finished without a status" ;;
          3) serialized_batch_failure "serialized article-push batch $((batch_number + 1)) returned an invalid status" ;;
          *) serialized_batch_failure "serialized article-push batch $((batch_number + 1)) failed for $section-$loc" ;;
        esac
        return $?
      fi
      current_batch=()
      current_batch_count=0
    fi
  done
  if [ "$current_batch_count" -gt 0 ]; then
    if ! serialized_batch_deadline_available; then return 1; fi
    run_one_serialized_batch "${current_batch[@]}"
    batch_rc=$?
    if [ "$batch_rc" -ne 0 ]; then
      case "$batch_rc" in
        2) serialized_batch_failure "serialized article-push batch $((batch_number + 1)) finished without a status" ;;
        3) serialized_batch_failure "serialized article-push batch $((batch_number + 1)) returned an invalid status" ;;
        *) serialized_batch_failure "serialized article-push batch $((batch_number + 1)) failed for $section-$loc" ;;
      esac
      return $?
    fi
    current_batch=()
    current_batch_count=0
  fi

  if [ "${#current_batch[@]}" -gt 0 ]; then
    serialized_batch_failure "serialized article-push batch planning left paths unprocessed"
    return $?
  fi

  if [ -n "${ARTICLE_PUSH_SKIPPED_PATHS_FILE:-}" ]; then
    mkdir -p "$(dirname "$ARTICLE_PUSH_SKIPPED_PATHS_FILE")" || {
      serialized_batch_failure "unable to create skipped-path directory for $ARTICLE_PUSH_SKIPPED_PATHS_FILE"
      return $?
    }
    : > "$ARTICLE_PUSH_SKIPPED_PATHS_FILE" || {
      serialized_batch_failure "unable to reset skipped-path file $ARTICLE_PUSH_SKIPPED_PATHS_FILE"
      return $?
    }
    if [ "${#aggregate_skipped[@]}" -gt 0 ]; then
      printf '%s\n' "${aggregate_skipped[@]}" > "$ARTICLE_PUSH_SKIPPED_PATHS_FILE" || {
        serialized_batch_failure "unable to write skipped-path file $ARTICLE_PUSH_SKIPPED_PATHS_FILE"
        return $?
      }
    fi
  fi

  if [ "${#aggregate_skipped[@]}" -gt 0 ]; then
    shown_count=0
    for skipped_path in "${aggregate_skipped[@]}"; do
      [ "$shown_count" -ge 5 ] && break
      if [ -n "$aggregate_names" ]; then
        aggregate_names="$aggregate_names,$skipped_path"
      else
        aggregate_names="$skipped_path"
      fi
      shown_count=$((shown_count + 1))
    done
  fi
  if [ -n "${ARTICLE_PUSH_SUMMARY_FILE:-}" ]; then
    mkdir -p "$(dirname "$ARTICLE_PUSH_SUMMARY_FILE")" || true
    printf '%s\t%s\t%s\t%s\n' \
      "$section-$loc" \
      "${#aggregate_skipped[@]}" \
      "$aggregate_names" \
      "$aggregate_warning_count" > "$ARTICLE_PUSH_SUMMARY_FILE" || true
  fi
  write_push_status "$aggregate_status"
  rm -rf "$batch_root"
  return 0
}

if [ "${ARTICLE_PUSH_BATCHED:-0}" != '1' ] && [ "${#relpaths[@]}" -gt "$article_push_batch_size" ]; then
  run_serialized_batches
  exit $?
fi

_attempt() {
  rm -rf "$stage"
  if ! reset_skipped_newer_paths; then
    return 1
  fi
  local clone_err
  clone_err="$(mktemp)"
  if ! git ${GIT_PAT_OPTS[@]+"${GIT_PAT_OPTS[@]}"} clone -q --depth 1 --filter=blob:none --no-checkout "$SHARD_REPO" "$stage" 2>"$clone_err"; then
    echo "::warning::clone of $SHARD_REPO failed: $(cat "$clone_err")"
    rm -f "$clone_err"
    return 1
  fi
  rm -f "$clone_err"

  if ! git -C "$stage" rev-parse -q --verify HEAD >/dev/null 2>&1; then
    echo "::error::$SHARD_REPO has no commits on main yet — run push-section-shard.sh (full push) first to seed CNAME/.nojekyll/base structure" >&2
    permanent_fail=1
    return 1
  fi

  # Canonical identity, mirroring push-section-shard.sh:193-194 and
  # push-locale-shard.sh:214-215. NOT optional: `git commit-tree` below fails
  # with `fatal: empty ident name ... not allowed` when no identity is
  # configured, and an Actions runner has none. Without this every fast-publish
  # would die at commit-tree on all three retries — the feature would be inert
  # on merge while the workflow's `|| fail=1` fault-tolerance kept CI from
  # failing loudly. Local runs hide it because developer machines have a global
  # git identity.
  git -C "$stage" config user.email "valerielinc@gmail.com" || return 1
  git -C "$stage" config user.name "Valerie Linc" || return 1

  git -C "$stage" read-tree HEAD || return 1

  local -a eligible_relpaths=()
  local -a skipped_newer_paths=()
  local rel src sha new_count=0
  last_skipped_newer_count=0
  last_skipped_newer_names=''
  last_history_warning_count=0

  if [ -n "$article_content_revision" ]; then
    collect_remote_newer_paths "$article_content_revision" || return 1
  fi
  for rel in "${relpaths[@]}"; do
    local is_newer=0
    if [ -n "$article_content_revision" ]; then
      local newer_path
      if [ "${#remote_newer_paths[@]}" -gt 0 ]; then
        for newer_path in "${remote_newer_paths[@]}"; do
          if [ "$newer_path" = "$rel" ]; then is_newer=1; break; fi
        done
      fi
    fi
    if [ "$is_newer" = 1 ]; then
      skipped_newer_paths+=("$rel")
    else
      eligible_relpaths+=("$rel")
    fi
  done

  last_skipped_newer_count="${#skipped_newer_paths[@]}"
  last_skipped_newer_paths=("${skipped_newer_paths[@]}")
  if ! write_skipped_newer_paths; then
    return 1
  fi
  if [ "$last_skipped_newer_count" -gt 0 ]; then
    local skipped_name shown_count=0
    for skipped_name in "${skipped_newer_paths[@]}"; do
      [ "$shown_count" -ge 5 ] && break
      if [ -n "$last_skipped_newer_names" ]; then
        last_skipped_newer_names="$last_skipped_newer_names,$skipped_name"
      else
        last_skipped_newer_names="$skipped_name"
      fi
      shown_count=$((shown_count + 1))
    done
    echo "monotonic guard: kept remote for $last_skipped_newer_count newer article path(s): $last_skipped_newer_names"
  fi

  if [ "${#eligible_relpaths[@]}" -gt 0 ]; then
    for rel in "${eligible_relpaths[@]}"; do
      src="$scratch_dist_dir/$rel"
      # ls-tree only touches tree objects (never a blob fetch) — used purely to
      # classify rel as "new" vs "replaced" for the .shard-filecount delta below.
      if [ -z "$(git -C "$stage" ls-tree HEAD -- "$rel" 2>/dev/null)" ]; then
        new_count=$((new_count + 1))
      fi
      sha="$(git -C "$stage" hash-object -w --path="$rel" "$src")" || return 1
      git -C "$stage" update-index --add --cacheinfo 100644,"$sha","$rel" || return 1
    done
  fi

  # Previous file-count: read straight from the tree we just cloned (a single
  # small targeted blob fetch — see header comment for why this beats the
  # raw.githubusercontent.com route). Missing/non-numeric → 0, same posture as
  # push-section-shard.sh.
  # The stage is a `--filter=blob:none` clone: the blob arrives on demand, and
  # a failed fetch makes `git show` fail exactly like an absent file. Only the
  # tree (always present) proves absence; a listed but unreadable marker is an
  # error, never a silent 0 that would restart the count from scratch.
  local prev_n
  if [ -n "$(git -C "$stage" ls-tree --name-only HEAD -- .shard-filecount 2>/dev/null)" ]; then
    prev_n="$(git -C "$stage" show HEAD:.shard-filecount)" || {
      echo "::error::.shard-filecount is listed in the shard tree but its blob is unreadable (on-demand fetch failed)" >&2
      return 1
    }
  else
    prev_n=0
  fi
  [[ "$prev_n" =~ ^[0-9]+$ ]] || prev_n=0
  local new_total=$((prev_n + new_count))
  if [ "$new_count" -gt 0 ]; then
    local fc_sha
    fc_sha="$(printf '%s' "$new_total" | git -C "$stage" hash-object -w --stdin --path=.shard-filecount)" || return 1
    git -C "$stage" update-index --add --cacheinfo 100644,"$fc_sha",.shard-filecount || return 1
  fi

  local new_tree head_tree
  new_tree="$(git -C "$stage" write-tree --missing-ok)" || return 1
  # shellcheck disable=SC1083  # HEAD^{tree} is git rev-parse syntax, not a shell brace expansion
  head_tree="$(git -C "$stage" rev-parse HEAD^{tree})"
  if [ "$new_tree" = "$head_tree" ]; then
    if [ "$last_skipped_newer_count" -gt 0 ]; then
      echo "$section-$loc article shard: remote newer publication kept — no content changes vs remote; no local paths eligible for push ($last_skipped_newer_count skipped)"
      last_push_status='remote-newer'
    else
      echo "$section-$loc article shard: no content changes vs remote — clean no-op ($new_count new, prev_n=$prev_n)"
      last_push_status='clean-no-op'
    fi
    return 0
  fi

  local commit commit_parent
  commit_parent="$(git -C "$stage" rev-parse HEAD)" || return 1
  if [ -n "$article_content_revision" ]; then
    commit="$(git -C "$stage" commit-tree "$new_tree" -p HEAD \
      -m "$section-$loc article fast-push (${GITHUB_SHA:-local}) — +$new_count new, ${#eligible_relpaths[@]} path(s) touched" \
      -m "Content-Rev: $article_content_revision")" || return 1
  else
    commit="$(git -C "$stage" commit-tree "$new_tree" -p HEAD \
      -m "$section-$loc article fast-push (${GITHUB_SHA:-local}) — +$new_count new, ${#eligible_relpaths[@]} path(s) touched")" || return 1
  fi
  # Published for the PAT fallback below: it re-pushes THIS commit, so it must
  # outlive the function scope. Keep the exact skipped-path set beside it: a
  # later retry resets the shared metadata file before cloning, and a fallback
  # must restore the set belonging to this commit rather than the later try.
  last_commit="$commit"
  last_commit_parent="$commit_parent"
  last_commit_skipped_newer_count="$last_skipped_newer_count"
  last_commit_skipped_newer_names="$last_skipped_newer_names"
  last_commit_skipped_newer_paths=("${last_skipped_newer_paths[@]}")
  if ! write_push_commit "$commit_parent" "$commit"; then
    return 1
  fi
  if ! write_fallback_state unsafe; then
    permanent_fail=1
    return 1
  fi

  # Never `push -f`: a non-fast-forward here means someone else (the periodic
  # full deploy's push-section-shard.sh, or another fast-path publish) pushed
  # in the meantime. Re-clone onto the new tip and rebuild, don't overwrite it.
  if git ${GIT_PAT_OPTS[@]+"${GIT_PAT_OPTS[@]}"} -C "$stage" push "$SHARD_REPO" "$commit":main; then
    if ! wait_for_pages_build "$commit"; then
      echo "::error::$section-$loc article shard: Pages did not complete for pushed commit $commit; refusing a concurrent retry" >&2
      if [ "${ARTICLE_PUSH_BATCHED:-0}" != '1' ]; then
        if reconcile_failed_publication "$commit_parent" "$commit" && write_fallback_state safe; then
          echo "ℹ️ $section-$loc article shard: reconciled the failed combined push before the caller fallback" >&2
        else
          echo "::error::$section-$loc article shard: could not reconcile the failed combined push; refusing an article-only fallback" >&2
        fi
      fi
      permanent_fail=1
      return 1
    fi
    echo "✅ $section-$loc article shard: pushed $commit ($new_count new file(s), filecount $prev_n -> $new_total)"
    last_push_status='pushed'
    return 0
  fi
  return 1
}

ok=0
delay=5
for try in 1 2 3; do
  if _attempt; then ok=1; break; fi
  if [ "$permanent_fail" = 1 ]; then break; fi
  if [ "$try" -lt 3 ]; then
    echo "::warning::$section-$loc article shard push attempt $try/3 failed — retrying in ${delay}s (re-clone to pick up any concurrent push)"
    sleep "$delay"
    delay=$((delay * 2))
  fi
done

if [ "$ok" != 1 ] && [ "$permanent_fail" != 1 ] && [ -n "$last_commit" ]; then
  # Last resort, same contract as shard_push_with_retry's: a deploy key that is
  # read-only/revoked/shadowed refuses every attempt identically, and an article
  # that misses the fast path waits for the next full deploy. force=0 — a
  # non-fast-forward here still has to FAIL (a concurrent full deploy moved the
  # tip; the tree must be rebuilt on it, never overwritten).
  if restore_last_commit_skipped_newer_paths && write_fallback_state unsafe && \
     shard_pat_push "$stage" "$SHARD_REPO" "$last_commit":main "$section-$loc article shard" 0; then
    if wait_for_pages_build "$last_commit"; then
      ok=1
      last_push_status='pushed'
    else
      echo "::error::$section-$loc article shard: Pages did not complete for PAT-fallback commit $last_commit" >&2
      if [ "${ARTICLE_PUSH_BATCHED:-0}" != '1' ]; then
        if reconcile_failed_publication "$last_commit_parent" "$last_commit" && write_fallback_state safe; then
          echo "ℹ️ $section-$loc article shard: reconciled the failed PAT fallback before the caller fallback" >&2
        else
          echo "::error::$section-$loc article shard: could not reconcile the failed PAT fallback; refusing an article-only fallback" >&2
        fi
      fi
      permanent_fail=1
    fi
  fi
fi

if [ "$ok" != 1 ]; then
  if [ "$permanent_fail" != 1 ]; then
    echo "::error::$section-$loc article shard push failed after 3 attempts (+ PAT fallback)" >&2
  fi
  write_push_status 'failed'
  write_push_summary
  exit 1
fi
write_push_status "${last_push_status:-pushed}"
write_push_summary
exit 0
