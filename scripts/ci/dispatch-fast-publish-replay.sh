#!/usr/bin/env bash
set -euo pipefail

repository="${1:-}"
display_title="${2:-}"
if [ "$#" -lt 3 ] || [ -z "$repository" ] || [ -z "$display_title" ]; then
  echo "usage: $0 <repository> <display-title> --ref <ref> [workflow-dispatch arguments...]" >&2
  exit 2
fi
shift 2

current_run_id="${GITHUB_RUN_ID:-}"
pending_poll_limit="${REPLAY_PENDING_POLL_LIMIT:-10}"
pending_poll_delay_seconds="${REPLAY_PENDING_POLL_DELAY_SECONDS:-2}"
if ! [[ "$pending_poll_limit" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::REPLAY_PENDING_POLL_LIMIT non valido" >&2
  exit 2
fi
if ! [[ "$pending_poll_delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "::error::REPLAY_PENDING_POLL_DELAY_SECONDS non valido" >&2
  exit 2
fi

# Stale recovery callers already have a unique nonce and have just proved that
# no matching replay is running.  GitHub's workflow-dispatch endpoint returns
# success before the new run becomes visible to `gh run list`; waiting for that
# read-after-write makes a valid dispatch look ambiguous (#2422) and, when a
# matrix is replayed serially, consumes the whole recovery job timeout (#3035).
# Treat the successful dispatch response as the acceptance boundary for these
# nonce-scoped recoveries.  Normal callers keep the stricter visibility poll.
async_stale_dispatch=false
if [ "${REPLAY_DISPATCH_ASYNC:-false}" = 'true' ] \
  || [[ "$display_title" == *" / nonce=stale-"* ]]; then
  async_stale_dispatch=true
fi

# A stale resolve can fan out one dispatcher per section.  The callers share a
# short-lived snapshot so those workers do not each spend an API request on the
# same `gh run list` poll.  The cache is opt-in because callers outside that
# fan-out are sequential and should keep the original fail-closed observation.
run_state_cache_file="${REPLAY_RUN_LIST_CACHE_FILE:-}"
run_state_cache_lock="${REPLAY_RUN_LIST_CACHE_LOCK:-${run_state_cache_file}.lock}"
run_state_cache_ttl_seconds="${REPLAY_RUN_LIST_CACHE_TTL_SECONDS:-2}"

read_run_list() {
  local runs
  if [ -z "$run_state_cache_file" ]; then
    gh run list --repo "$repository" --workflow fast-publish-section.yml --branch main --event workflow_dispatch --limit 100 --json databaseId,displayTitle,status,conclusion
    return
  fi

  if ! [[ "$run_state_cache_ttl_seconds" =~ ^[0-9]+$ ]]; then
    echo "::error::REPLAY_RUN_LIST_CACHE_TTL_SECONDS non valido" >&2
    return 1
  fi
  if ! command -v flock >/dev/null 2>&1; then
    echo "::error::flock non disponibile: impossibile condividere lo stato delle run" >&2
    return 1
  fi

  local cache_fd
  if ! exec {cache_fd}>"$run_state_cache_lock"; then
    echo "::error::impossibile aprire il lock dello stato delle run" >&2
    return 1
  fi
  if ! flock "$cache_fd"; then
    eval "exec ${cache_fd}>&-"
    echo "::error::impossibile acquisire il lock dello stato delle run" >&2
    return 1
  fi

  local cache_fresh=false
  local cache_mtime=0
  local now_epoch=0
  if [ -s "$run_state_cache_file" ] && jq -e 'type == "array"' "$run_state_cache_file" >/dev/null 2>&1; then
    cache_mtime="$(stat -c %Y -- "$run_state_cache_file" 2>/dev/null || printf '0')"
    now_epoch="$(date +%s)"
    if [[ "$cache_mtime" =~ ^[0-9]+$ ]] && [[ "$now_epoch" =~ ^[0-9]+$ ]] \
      && (( now_epoch - cache_mtime < run_state_cache_ttl_seconds )); then
      cache_fresh=true
    fi
  fi

  if [ "$cache_fresh" = true ]; then
    runs="$(<"$run_state_cache_file")"
  else
    if ! runs="$(gh run list --repo "$repository" --workflow fast-publish-section.yml --branch main --event workflow_dispatch --limit 100 --json databaseId,displayTitle,status,conclusion)"; then
      flock -u "$cache_fd" || true
      eval "exec ${cache_fd}>&-"
      return 1
    fi
    if ! jq -e 'type == "array"' <<< "$runs" >/dev/null 2>&1; then
      echo "::error::gh run list ha restituito uno stato non valido" >&2
      flock -u "$cache_fd" || true
      eval "exec ${cache_fd}>&-"
      return 1
    fi
    if ! printf '%s\n' "$runs" > "$run_state_cache_file"; then
      echo "::error::impossibile aggiornare lo snapshot dello stato delle run" >&2
      flock -u "$cache_fd" || true
      eval "exec ${cache_fd}>&-"
      return 1
    fi
  fi

  flock -u "$cache_fd" || true
  eval "exec ${cache_fd}>&-"
  printf '%s\n' "$runs"
}

list_matching_runs() {
  local runs
  runs="$(read_run_list)" || return 1
  jq -c --arg title "$display_title" --arg current "$current_run_id" '
    [.[] | select(
      ((.displayTitle // "") == $title or ((.displayTitle // "") | startswith($title + " / dry=")))
      and ((.databaseId | tostring) != $current)
    )]
  ' <<< "$runs"
}

query_state() {
  local runs="$1"
  local after_id="${2:-}"
  jq -r --arg after "$after_id" --arg title "$display_title" '
    [.[] | select($after == "" or ((.databaseId | tonumber) > ($after | tonumber)))] as $after_runs
    | [$after_runs[] | select((.displayTitle // "") | test(" / dry=false(?: / c=[^/]+)?$"))] as $publishing_runs
    | [$after_runs[] | select((.displayTitle // "") == $title)] as $legacy_runs
    | if any($publishing_runs[]; .status != "completed") or any($legacy_runs[]; .status != "completed") then "pending"
      elif any($publishing_runs[]; .status == "completed" and .conclusion == "success") then "accepted"
      elif any($legacy_runs[]; .status == "completed") then "ambiguous"
      elif any($publishing_runs[]; .status == "completed" and .conclusion != "success") then "failed"
      elif any($after_runs[]; (.displayTitle // "") | test(" / dry=true(?: / c=[^/]+)?$")) then "dry"
      elif ($after_runs | length) == 0 then "missing"
      else "ambiguous"
      end
  ' <<< "$runs"
}

latest_run_id() {
  jq -r '[.[] | .databaseId | tonumber] | max // 0' <<< "$1"
}

earliest_pending_run_id() {
  jq -r --arg title "$display_title" '[.[] | select(((.displayTitle // "") == $title or ((.displayTitle // "") | test(" / dry=false(?: / c=[^/]+)?$"))) and .status != "completed") | .databaseId | tonumber] | min // 0' <<< "$1"
}

for attempt in 1 2; do
  existing_runs="$(list_matching_runs)" || {
    echo "::error::impossibile leggere lo stato del replay $display_title"
    exit 1
  }
  state="$(query_state "$existing_runs")"
  if [ "$state" = 'accepted' ]; then
    echo "::notice::replay completato con successo: $display_title"
    exit 0
  fi
  if [ "$state" = 'ambiguous' ]; then
    echo "::error::run del replay senza modalità verificabile; non invio un dispatch duplicato: $display_title"
    exit 1
  fi
  if [ "$state" = 'pending' ]; then
    pending_run_id="$(earliest_pending_run_id "$existing_runs")"
    pending_after_id=$((pending_run_id - 1))
    echo "::notice::replay ancora in corso; verifico l'esito prima di inviare un altro dispatch: $display_title"
    pending_read_ok=false
    for ((poll = 1; poll <= pending_poll_limit; poll += 1)); do
      sleep "$pending_poll_delay_seconds"
      if ! existing_runs="$(list_matching_runs)"; then
        echo "::warning::esito del replay in corso temporaneamente non leggibile (verifica $poll/$pending_poll_limit)"
        continue
      fi
      pending_read_ok=true
      state="$(query_state "$existing_runs" "$pending_after_id")"
      if [ "$state" = 'accepted' ]; then
        echo "::notice::replay visibile e completato con successo: $display_title"
        exit 0
      fi
      if [ "$state" = 'failed' ]; then
        echo "::warning::il replay gia' in corso e' fallito; preparo un nuovo tentativo: $display_title"
        break
      fi
      if [ "$state" = 'dry' ]; then
        echo "::error::il replay $display_title e' stato forzato in dry-run e non ha pubblicato la superficie"
        exit 1
      fi
      if [ "$state" = 'ambiguous' ]; then
        echo "::error::esito della run legacy non verificabile; non invio un dispatch duplicato: $display_title"
        exit 1
      fi
      if [ "$state" = 'missing' ]; then
        echo "::error::run replay pendente non più osservabile; non invio un dispatch duplicato: $display_title"
        exit 1
      fi
    done
    if [ "$state" = 'failed' ]; then
      : # il replay è terminato male: il ciclo esterno prepara un solo retry.
    elif [ "$pending_read_ok" != true ] || [ "$state" != 'pending' ]; then
      # `pending` è delegabile solo se l'ultima lettura della finestra ha
      # osservato davvero la run ancora in corso. Un errore di lettura lascia
      # lo stato precedente in memoria, ma non costituisce una prova di
      # ownership; nemmeno una run scomparsa (`missing`) è delegabile.
      echo "::error::stato finale del replay pendente non verificato; non invio un dispatch duplicato: $display_title"
      exit 1
    else
      # The equivalent replay still owns this surface. A second dispatch would
      # race it and can publish a mixed section; its own result/observer will
      # report a later failure if it does not complete. Returning success here
      # means "delegated", not "published".
      echo "::notice::replay gia' in corso non ancora concluso; delego la superficie alla run attiva e non invio un dispatch duplicato: $display_title"
      exit 0
    fi
  fi
  baseline_run_id="$(latest_run_id "$existing_runs")"
  if [ "$state" = 'failed' ]; then
    echo "::notice::ultimo replay fallito; riaccodo il tentativo $attempt: $display_title"
  fi

  if gh workflow run fast-publish-section.yml --repo "$repository" "$@"; then
    echo "::notice::dispatch del replay accettata; attendo la visibilita' della run: $display_title"
    if [ "$async_stale_dispatch" = true ]; then
      echo "::notice::replay stale accettato dall'API; la run verra' osservata dal workflow figlio: $display_title"
      exit 0
    fi
  else
    echo "::warning::gh workflow run ha segnalato un errore; verifico se GitHub ha accettato il replay: $display_title"
  fi

  for poll in {1..10}; do
    sleep 2
    existing_runs="$(list_matching_runs)" || {
      echo "::warning::stato del replay temporaneamente non leggibile (verifica $poll/10)"
      continue
    }
    state="$(query_state "$existing_runs" "$baseline_run_id")"
    if [ "$state" = 'accepted' ]; then
      echo "::notice::replay visibile e accettato: $display_title"
      exit 0
    fi
    if [ "$state" = 'failed' ]; then
      echo "::warning::il replay e' visibile ma e' gia' fallito: $display_title"
      break
    fi
    if [ "$state" = 'dry' ]; then
      echo "::error::il replay $display_title e' stato forzato in dry-run e non ha pubblicato la superficie"
      exit 1
    fi
    if [ "$state" = 'ambiguous' ]; then
      echo "::error::run del replay senza modalità verificabile; non invio un dispatch duplicato: $display_title"
      exit 1
    fi
  done
  echo "::warning::replay assente o ambiguo dopo il tentativo $attempt: $display_title"
done

echo "::error::replay non completato con successo dopo due tentativi: $display_title"
exit 1
