#!/usr/bin/env bash
# Ensure the checkout can answer history-dependent gates, then fetch a push
# base and/or the current main ref when a caller needs them.
#
# Resolve jobs use a full-history checkout for corpus high-water checks. Keep a
# guarded fallback for other callers, older queued checkouts, or non-linear
# histories where the requested base is not present.
set -euo pipefail

history_fetch_attempts="${HISTORY_FETCH_ATTEMPTS:-3}"
history_fetch_delay_s="${HISTORY_FETCH_DELAY_S:-5}"
history_fetch_timeout_s="${HISTORY_FETCH_TIMEOUT_S:-120}"
history_fetch_delay_cap_s=30
history_fetch_timeout_cap_s=300
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
if [ "$history_fetch_delay_s" -gt "$history_fetch_delay_cap_s" ]; then
  echo "::error::HISTORY_FETCH_DELAY_S supera il cap di ${history_fetch_delay_cap_s}s: $history_fetch_delay_s"
  exit 1
fi
if ! [[ "$history_fetch_timeout_s" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::HISTORY_FETCH_TIMEOUT_S non valido: $history_fetch_timeout_s"
  exit 1
fi
if [ "$history_fetch_timeout_s" -gt "$history_fetch_timeout_cap_s" ]; then
  echo "::error::HISTORY_FETCH_TIMEOUT_S supera il cap di ${history_fetch_timeout_cap_s}s: $history_fetch_timeout_s"
  exit 1
fi

fetch_main="${FETCH_MAIN:-false}"
origin_main_refspec='main:refs/remotes/origin/main'
case "$fetch_main" in
  true|false) ;;
  *)
    echo "::error::FETCH_MAIN deve essere true o false: $fetch_main"
    exit 1
    ;;
esac

require_full_history="${REQUIRE_FULL_HISTORY:-true}"
case "$require_full_history" in
  true|false) ;;
  *)
    echo "::error::REQUIRE_FULL_HISTORY deve essere true o false: $require_full_history"
    exit 1
    ;;
esac

if ! command -v timeout >/dev/null 2>&1 && ! command -v perl >/dev/null 2>&1; then
  echo "::error::nessun runner per il timeout bounded dei fetch Git (servono timeout o perl)"
  exit 1
fi

bounded_git_fetch() {
  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=TERM --kill-after=5s "${history_fetch_timeout_s}s" git fetch "$@"
  else
    # macOS does not ship GNU timeout. Perl's alarm survives the exec and
    # therefore still bounds the actual git process without adding a package.
    perl -e 'alarm shift; exec @ARGV' "$history_fetch_timeout_s" git fetch "$@"
  fi
}

fetch_ref_with_retries() {
  local label="$1"
  shift
  local attempt
  for ((attempt = 1; attempt <= history_fetch_attempts; attempt += 1)); do
    if bounded_git_fetch "$@"; then
      return 0
    fi
    echo "::warning::fetch Git non riuscito per $label (tentativo $attempt/$history_fetch_attempts)"
    if [ "$attempt" -lt "$history_fetch_attempts" ]; then
      sleep "$history_fetch_delay_s"
    fi
  done
  echo "::error::fetch Git esaurito per $label dopo $history_fetch_attempts tentativi"
  return 1
}

shallow_state="$(git rev-parse --is-shallow-repository 2>/dev/null || true)"
main_ref_fetched=false
if [ "$shallow_state" = 'true' ] && [ "$require_full_history" = 'true' ]; then
  # actions/checkout is configured with fetch-depth: 0, but a queued replay
  # can still arrive with a shallow worktree (for example after a checkout
  # fallback or a runner-side fetch interruption). The preflight derives a
  # previous corpus high-water from Git history and must never be asked to
  # guess it. Unshallow once, with bounded retries, before any caller can run
  # the history-dependent planner or gate.
  for ((attempt = 1; attempt <= history_fetch_attempts; attempt += 1)); do
    if bounded_git_fetch --no-tags --unshallow origin "$origin_main_refspec"; then
      shallow_state="$(git rev-parse --is-shallow-repository 2>/dev/null || true)"
      if [ "$shallow_state" != 'true' ]; then
        main_ref_fetched=true
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
elif [ "$shallow_state" = 'true' ]; then
  # Some release handoffs only need the exact remote main ref. Requiring the
  # entire corpus history in that path turns a small bounded fetch into an
  # unbounded transfer and can strand the staged release before the API replay.
  echo '::notice::checkout Git shallow mantenuto: il chiamante richiede solo la punta remota, non la storia completa'
fi

if [ "$fetch_main" = 'true' ]; then
  if [ "$main_ref_fetched" != 'true' ] && ! fetch_ref_with_retries 'refs/remotes/origin/main' --no-tags origin "$origin_main_refspec"; then
    exit 1
  fi
  fetched_main="$(git rev-parse refs/remotes/origin/main 2>/dev/null || true)"
  fetched_main_head="$(git rev-parse FETCH_HEAD 2>/dev/null || true)"
  if ! [[ "$fetched_main" =~ ^[a-f0-9]{40}$ ]] || [ "$fetched_main" != "$fetched_main_head" ]; then
    echo "::error::refs/remotes/origin/main non coincide con FETCH_HEAD dopo il fetch: remote=$fetched_main fetch_head=$fetched_main_head"
    exit 1
  fi
  echo "::notice::punta origin/main aggiornata e verificata: $fetched_main"
fi

if [ -z "${PUSH_BEFORE:-}" ] || [[ "$PUSH_BEFORE" =~ ^0+$ ]]; then
  exit 0
fi

if git cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null; then
  echo "::notice::push base already present in the checkout: $PUSH_BEFORE"
  exit 0
fi

if ! fetch_ref_with_retries "push base $PUSH_BEFORE" --no-tags origin "$PUSH_BEFORE"; then
  exit 1
fi
if ! git cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null; then
  echo "::error::push base non presente dopo il fetch: $PUSH_BEFORE"
  exit 1
fi
echo "::notice::push base recuperata nel checkout: $PUSH_BEFORE"
