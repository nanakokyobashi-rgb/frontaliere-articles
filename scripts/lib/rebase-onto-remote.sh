#!/usr/bin/env bash
# Rebase HEAD onto a remote branch, auto-resolving conflicts that are confined
# to whole-file bookkeeping caches.
#
# Usage:
#   bash scripts/lib/rebase-onto-remote.sh <remote-url> <target-branch> [bookkeeping-path...]
#
# Exit 0 = HEAD is now rebased onto <target-branch> (the caller can retry its
#          push). Exit 1 = the rebase could not be completed safely; the tree is
#          left clean (rebase aborted) and the caller decides what to do.
#
# ── Why this exists (issue #76) ───────────────────────────────────────────────
# The article workflows push to main with a retry loop: push, and on rejection
# `git pull --rebase` before trying again. That loop assumes every rebase
# failure is transient — that another workflow landed a commit and re-applying
# on top of it will work the second time.
#
# For one class of file that assumption is false, and it costs articles.
# `data/topic-candidates-evergreen-rejected.json` is a dedup/backoff cache that
# generate-article.yml rewrites IN FULL on every run, including runs that
# generate nothing. When two runs rewrite it from different bases — routine
# here, since generation takes up to ~40 min while the concurrency queue keeps
# other runs landing — the rebase produces a real textual conflict. Retrying
# re-runs the identical operation against the identical inputs and fails
# identically: measured on the run that opened #76, all 5 attempts failed
# inside the retry window with no other run touching the file. 21 failed runs
# of generate-article.yml since 2026-08-06.
#
# So far that has only hit runs whose commit carried nothing but bookkeeping,
# which is luck, not design. The step's own error message states the stake:
# "push failed after 5 attempts — the article is registered locally but not
# pushed". On a run that did generate, the article is lost.
#
# ── What it does, and why it is safe ─────────────────────────────────────────
# On conflict, the conflicted set is compared against the caller's explicit
# allowlist. If — and only if — every conflicted path is on that list, each one
# is resolved by taking the UPSTREAM copy and the rebase continues. Any other
# path in the set (a content file, a workflow, anything unlisted) aborts the
# rebase and returns 1, so the pre-existing behaviour is unchanged for every
# conflict that isn't this one.
#
# Taking upstream is the correct resolution rather than a convenient one: these
# files are caches of what has already been tried, rebuilt from scratch on the
# next run. Losing one run's update costs one redundant candidate evaluation.
# Losing the commit costs an article.
#
# Note on `--ours` during a rebase: HEAD is the upstream branch being replayed
# ONTO, so `--ours` is the upstream copy and `--theirs` is this run's. That is
# inverted relative to a merge, and it is the single easiest thing to get
# backwards here.
set -euo pipefail

REMOTE="${1:?remote url required}"
TARGET="${2:?target branch required}"
shift 2
ALLOWED=" $* "

# Guard against an empty allowlist: with no paths allowed nothing can ever be
# resolved, and silently degrading to "always abort" would hide a caller bug
# behind behaviour that looks exactly like the old code.
if [ "$ALLOWED" = "  " ]; then
  echo "::error::rebase-onto-remote.sh called with an empty bookkeeping allowlist"
  exit 2
fi

rebase_in_progress() {
  [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]
}

abort_and_fail() {
  git rebase --abort 2>/dev/null || true
  return 1
}

if git pull --rebase "$REMOTE" "$TARGET"; then
  exit 0
fi

if ! rebase_in_progress; then
  # The pull failed before a rebase ever started (network, auth, unrelated
  # refusal). Nothing to resolve and nothing to abort.
  echo "rebase did not start — not a conflict"
  exit 1
fi

# A single pull replays every local commit, and several of them in a row can
# stop with their own conflict on the same bookkeeping file. So the exit status
# of `git rebase --continue` is NOT a verdict: non-zero means "did not reach the
# end", which covers both "the replayed commit is now empty" and "advanced fine
# and stopped on the NEXT conflict". Reading it as only the first is what an
# earlier version of this script did, and it aborted a rebase that was midway
# through succeeding — the second commit, the one carrying the article, was the
# one it dropped.
#
# Hence: nothing below decides anything from an exit status. Every pass
# re-reads the actual repository state and acts on that, and the loop is bounded
# so a state that stops changing ends in an abort rather than a spin.
progress_marker=""
for _pass in $(seq 1 20); do
  rebase_in_progress || { echo "rebase completed"; exit 0; }

  conflicted="$(git diff --name-only --diff-filter=U)"

  if [ -z "$conflicted" ]; then
    # Stopped without conflicts. Either the replayed commit became empty once
    # we took upstream's bookkeeping (nothing of ours left to land — skipping
    # is right, and leaves HEAD equal to upstream so the caller's next push is
    # a no-op success rather than a lost article), or it is simply waiting to
    # be continued.
    if git diff --cached --quiet; then
      GIT_EDITOR=: git rebase --skip >/dev/null 2>&1 || GIT_EDITOR=: git rebase --continue >/dev/null 2>&1 || true
      echo "replayed commit was empty after taking upstream bookkeeping — skipped"
    else
      GIT_EDITOR=: git rebase --continue >/dev/null 2>&1 || true
    fi
  else
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      case "$ALLOWED" in
        *" $f "*) ;;
        *)
          echo "::warning::rebase conflict on '$f', which is not a whole-file bookkeeping cache — aborting, as before"
          abort_and_fail || exit 1
          ;;
      esac
    done <<EOF
$conflicted
EOF

    while IFS= read -r f; do
      [ -n "$f" ] || continue
      # `--ours` is the upstream copy (see the header note). If the file does
      # not exist upstream at all the checkout fails, and dropping it is the
      # same decision: prefer upstream's view of a scratch cache.
      if git checkout --ours -- "$f" 2>/dev/null; then
        git add -- "$f"
      else
        git rm -q -f -- "$f" 2>/dev/null || true
      fi
      echo "resolved bookkeeping conflict by taking upstream: $f"
    done <<EOF
$conflicted
EOF

    GIT_EDITOR=: git rebase --continue >/dev/null 2>&1 || true
  fi

  # Progress check. The marker combines HEAD with how far the rebase has got,
  # so a pass that changed nothing at all is caught immediately instead of
  # burning all 20 and reporting a misleading "too many passes".
  marker="$(git rev-parse HEAD 2>/dev/null || true)|$(cat "$(git rev-parse --git-path rebase-merge/msgnum)" 2>/dev/null || echo -)"
  if [ "$marker" = "$progress_marker" ]; then
    echo "::warning::rebase made no progress after resolving bookkeeping conflicts"
    abort_and_fail || exit 1
  fi
  progress_marker="$marker"
done

echo "::warning::rebase still in progress after 20 conflict passes — aborting"
abort_and_fail || exit 1
