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
history_fetch_timeout_s="${HISTORY_FETCH_TIMEOUT_S:-120}"
fetch_main="${FETCH_MAIN:-false}"
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
if [ "$history_fetch_delay_s" -gt 60 ]; then
  echo "::error::HISTORY_FETCH_DELAY_S supera il cap di 60 secondi: $history_fetch_delay_s"
  exit 1
fi
if ! [[ "$history_fetch_timeout_s" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::HISTORY_FETCH_TIMEOUT_S non valido: $history_fetch_timeout_s"
  exit 1
fi
if [ "$history_fetch_timeout_s" -gt 300 ]; then
  echo "::error::HISTORY_FETCH_TIMEOUT_S supera il cap di 300 secondi: $history_fetch_timeout_s"
  exit 1
fi
case "$fetch_main" in
  true|false) ;;
  *)
    echo "::error::FETCH_MAIN deve essere true o false: $fetch_main"
    exit 1
    ;;
esac

run_fetch_with_timeout() {
  local timeout_s="$1"
  shift
  "$@" &
  local fetch_pid=$!
  local started_at=$SECONDS
  while kill -0 "$fetch_pid" 2>/dev/null; do
    if [ $((SECONDS - started_at)) -ge "$timeout_s" ]; then
      kill "$fetch_pid" 2>/dev/null || true
      wait "$fetch_pid" 2>/dev/null || true
      echo "::warning::fetch Git interrotto dopo ${timeout_s}s per timeout"
      return 124
    fi
    sleep 1
  done
  wait "$fetch_pid"
}

fetch_main_with_retries() {
  local fetch_mode="$1"
  local attempt
  local shallow_state
  for ((attempt = 1; attempt <= history_fetch_attempts; attempt += 1)); do
    if [ "$fetch_mode" = 'unshallow' ]; then
      if run_fetch_with_timeout "$history_fetch_timeout_s" git fetch --no-tags --unshallow origin main; then
        shallow_state="$(git rev-parse --is-shallow-repository 2>/dev/null || true)"
        if [ "$shallow_state" != 'true' ]; then
          echo "::notice::storia Git completa ripristinata prima dei gate (tentativo $attempt)"
          return 0
        fi
        echo "::warning::il fetch della storia Git e' riuscito ma il checkout resta shallow (tentativo $attempt/$history_fetch_attempts)"
      else
        echo "::warning::fetch della storia Git non riuscito (tentativo $attempt/$history_fetch_attempts)"
      fi
    elif run_fetch_with_timeout "$history_fetch_timeout_s" git fetch --no-tags origin main; then
      if git rev-parse --verify FETCH_HEAD >/dev/null 2>&1; then
        echo "::notice::main aggiornata nel checkout prima dei gate (tentativo $attempt)"
        return 0
      fi
      echo "::warning::fetch di main riuscito ma FETCH_HEAD non verificabile (tentativo $attempt/$history_fetch_attempts)"
    else
      echo "::warning::fetch di main non riuscito (tentativo $attempt/$history_fetch_attempts)"
    fi
    if [ "$attempt" -lt "$history_fetch_attempts" ]; then
      sleep "$history_fetch_delay_s"
    fi
  done
  echo "::error::fetch Git non verificabile dopo $history_fetch_attempts tentativi"
  return 1
}

shallow_state="$(git rev-parse --is-shallow-repository 2>/dev/null || true)"
if [ "$shallow_state" = 'true' ]; then
  # actions/checkout is configured with fetch-depth: 0, but a queued replay
  # can still arrive with a shallow worktree (for example after a checkout
  # fallback or a runner-side fetch interruption). The preflight derives a
  # previous corpus high-water from Git history and must never be asked to
  # guess it. Unshallow once, with bounded retries, before any caller can run
  # the history-dependent planner or gate.
  fetch_main_with_retries unshallow
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || true)" = 'true' ]; then
    echo "::error::checkout Git ancora shallow dopo $history_fetch_attempts tentativi: high-water precedente non verificabile"
    exit 1
  fi
fi

# Re-read the state after the recovery: a shallow checkout that has just been
# unshallowed must also pass the regular main-ref verification when requested.
shallow_state="$(git rev-parse --is-shallow-repository 2>/dev/null || true)"
if [ "$fetch_main" = 'true' ] && [ "$shallow_state" != 'true' ]; then
  fetch_main_with_retries regular
fi

if [ -z "${PUSH_BEFORE:-}" ] || [[ "$PUSH_BEFORE" =~ ^0+$ ]]; then
  exit 0
fi

if git cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null; then
  echo "::notice::push base already present in the checkout: $PUSH_BEFORE"
  exit 0
fi

if ! run_fetch_with_timeout "$history_fetch_timeout_s" git fetch --no-tags origin "$PUSH_BEFORE"; then
  echo "::error::push base non recuperabile entro ${history_fetch_timeout_s}s: $PUSH_BEFORE"
  exit 1
fi
if ! git cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null; then
  echo "::error::push base non presente dopo il fetch: $PUSH_BEFORE"
  exit 1
fi
echo "::notice::push base recuperata nel checkout: $PUSH_BEFORE"
