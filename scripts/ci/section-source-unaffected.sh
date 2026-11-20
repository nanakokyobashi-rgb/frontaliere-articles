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

# These files record generator attempts, failed image work and watchdog status.
# Keep this list explicit: any other change may alter the rendered release.
git diff --quiet --no-ext-diff --no-textconv --ignore-submodules=none "$expected" "$current" -- . \
  ':(top,exclude,literal)data/discovery-attempt-state.json' \
  ':(top,exclude,literal)data/topic-candidates-evergreen-rejected.json' \
  ':(top,exclude,glob)data/sections/*/topic-candidates-evergreen-rejected.json' \
  ':(top,exclude,literal)data/image-regeneration-queue.json' \
  ':(top,exclude,literal)data/image-regeneration-queue-pending.jsonl' \
  ':(top,exclude,glob)data/image-regeneration-queue-pending.jsonl.*.pending' \
  ':(top,exclude,literal)generator/tests/canton-generation-coverage.test.mjs' \
  ':(top,exclude,literal)scripts/ci/canton-generation-coverage.mjs'
