#!/usr/bin/env bash
# Ensure the checkout can answer history-dependent gates, then fetch a push
# base only when the checkout does not already contain it.
#
# Resolve jobs use a full-history checkout for corpus high-water checks. Keep a
# guarded fallback for other callers, older queued checkouts, or non-linear
# histories where the requested base is not present.
set -euo pipefail

history_fetch_attempts="${HISTORY_FETCH_ATTEMPTS:-3}"
history_fetch_delay_s="${HISTORY_FETCH_DELAY_S:-5}"
if ! [[ "$history_fetch_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::HISTORY_FETCH_ATTEMPTS non valido: $history_fetch_attempts"
  exit 1
fi
if [ "$history_fetch_attempts" -gt 5 ]; then
  echo "::error::HISTORY_FETCH_ATTEMPTS supera il cap di 5: $history_fetch_attempts"
  exit 1
fi
if ! [[ "$history_fetch_delay_s" =~ ^[0-9]+$ ]]; then
  echo "::error::HISTORY_FETCH_DELAY_S non valido: $history_fetch_delay_s"
  exit 1
fi

shallow_state="$(git rev-parse --is-shallow-repository 2>/dev/null || true)"
if [ "$shallow_state" = 'true' ]; then
  # actions/checkout is configured with fetch-depth: 0, but a queued replay
  # can still arrive with a shallow worktree (for example after a checkout
  # fallback or a runner-side fetch interruption). The preflight derives a
  # previous corpus high-water from Git history and must never be asked to
  # guess it. Unshallow once, with bounded retries, before any caller can run
  # the history-dependent planner or gate.
  for ((attempt = 1; attempt <= history_fetch_attempts; attempt += 1)); do
    if git fetch --no-tags --unshallow origin main; then
      shallow_state="$(git rev-parse --is-shallow-repository 2>/dev/null || true)"
      if [ "$shallow_state" != 'true' ]; then
        echo "::notice::storia Git completa ripristinata prima dei gate (tentativo $attempt)"
        break
      fi
      echo "::warning::il fetch della storia Git e' riuscito ma il checkout resta shallow (tentativo $attempt/$history_fetch_attempts)"
    else
      echo "::warning::fetch della storia Git non riuscito (tentativo $attempt/$history_fetch_attempts)"
    fi
    if [ "$attempt" -lt "$history_fetch_attempts" ]; then
      sleep "$history_fetch_delay_s"
    fi
  done
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || true)" = 'true' ]; then
    echo "::error::checkout Git ancora shallow dopo $history_fetch_attempts tentativi: high-water precedente non verificabile"
    exit 1
  fi
fi

if [ -z "${PUSH_BEFORE:-}" ] || [[ "$PUSH_BEFORE" =~ ^0+$ ]]; then
  exit 0
fi

if git cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null; then
  echo "::notice::push base already present in the checkout: $PUSH_BEFORE"
  exit 0
fi

git fetch --no-tags origin "$PUSH_BEFORE"
if ! git cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null; then
  echo "::error::push base non presente dopo il fetch: $PUSH_BEFORE"
  exit 1
fi
echo "::notice::push base recuperata nel checkout: $PUSH_BEFORE"
