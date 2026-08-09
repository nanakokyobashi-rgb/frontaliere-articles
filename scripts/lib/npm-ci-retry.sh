#!/usr/bin/env bash
# `npm ci` with retries. Drop-in replacement for a bare `run: npm ci` step —
# every argument is forwarded, so `--no-audit --no-fund --ignore-scripts` and
# friends keep working.
#
#   run: bash scripts/lib/npm-ci-retry.sh
#   run: bash scripts/lib/npm-ci-retry.sh --no-audit --no-fund
#
# ── Why (issue #77, and #39 before it) ───────────────────────────────────────
# Install failures here are network fluctuations, not code, and they cost
# articles. The install pulls `@huggingface/transformers`, whose
# `onnxruntime-node` dependency downloads a native binary in its postinstall
# script — from OUTSIDE the npm registry, with no retry of its own. A transient
# `ETIMEDOUT` (measured against 150.171.109.146:443, with `ENETUNREACH` on the
# matching IPv6) therefore fails the whole job.
#
# Measured cost: that is what left the 2026-08-09 05:49 Bollettino without a
# page, and the same class of failure produced the 8 August ghost article that
# stayed 404 for 8h57m. It also failed a PR check the same evening.
#
# ── Why retrying is safe here ────────────────────────────────────────────────
# `npm ci` deletes `node_modules` itself before each run, by design — a half
# finished attempt cannot leave state that poisons the next one. That is what
# makes a blind retry correct for THIS command specifically; it would not be for
# `npm install`, which mutates the lockfile.
#
# ── What this does NOT fix ───────────────────────────────────────────────────
# A retry shortens the odds, it does not remove the dependency on a third-party
# download succeeding during a CI run. The steps that need only Node builtins
# should stop installing at all, and the ones that need the transformers stack
# would be better served by a warm cache. Both are larger changes; this is the
# cheap mitigation that stops single blips from costing articles today.
set -euo pipefail

ATTEMPTS="${NPM_CI_RETRY_ATTEMPTS:-3}"
# Linear backoff. Kept short on purpose: these jobs sit in a concurrency queue
# where a long sleep costs more than another attempt.
BACKOFF_STEP="${NPM_CI_RETRY_BACKOFF:-10}"

attempt=1
while true; do
  if npm ci "$@"; then
    [ "$attempt" -gt 1 ] && echo "npm ci succeeded on attempt $attempt/$ATTEMPTS"
    exit 0
  fi

  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "::error::npm ci failed after $ATTEMPTS attempts. If the log shows ETIMEDOUT/ENETUNREACH against a host that is not the npm registry, it is the onnxruntime-node postinstall download (see this script's header) — a re-run usually clears it."
    exit 1
  fi

  delay=$(( attempt * BACKOFF_STEP ))
  echo "::warning::npm ci failed (attempt $attempt/$ATTEMPTS) — retrying in ${delay}s"
  sleep "$delay"
  attempt=$(( attempt + 1 ))
done
