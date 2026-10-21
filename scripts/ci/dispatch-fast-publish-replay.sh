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
list_matching_runs() {
  local runs
  runs="$(gh run list --repo "$repository" --workflow fast-publish-section.yml --branch main --event workflow_dispatch --limit 100 --json databaseId,displayTitle,status,conclusion)" || return 1
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
  jq -r --arg after "$after_id" '
    [.[] | select($after == "" or ((.databaseId | tonumber) > ($after | tonumber)))] as $after_runs
    | [$after_runs[] | select((.displayTitle // "") | endswith(" / dry=false"))] as $publishing_runs
    | if any($publishing_runs[]; .status == "queued" or .status == "in_progress" or .status == "waiting" or .status == "pending" or .status == "requested" or (.status == "completed" and .conclusion == "success")) then "accepted"
      elif any($publishing_runs[]; .status == "completed" and .conclusion != "success") then "failed"
      elif any($after_runs[]; (.displayTitle // "") | endswith(" / dry=true")) then "dry"
      elif ($after_runs | length) == 0 then "missing"
      else "ambiguous"
      end
  ' <<< "$runs"
}

latest_run_id() {
  jq -r '[.[] | .databaseId | tonumber] | max // 0' <<< "$1"
}

for attempt in 1 2; do
  existing_runs="$(list_matching_runs)" || {
    echo "::error::impossibile leggere lo stato del replay $display_title"
    exit 1
  }
  state="$(query_state "$existing_runs")"
  if [ "$state" = 'accepted' ]; then
    echo "::notice::replay gia' accodato o completato con successo: $display_title"
    exit 0
  fi
  baseline_run_id="$(latest_run_id "$existing_runs")"
  if [ "$state" = 'failed' ]; then
    echo "::notice::ultimo replay fallito; riaccodo il tentativo $attempt: $display_title"
  fi

  if gh workflow run fast-publish-section.yml --repo "$repository" "$@"; then
    echo "::notice::dispatch del replay accettata; attendo la visibilita' della run: $display_title"
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
  done
  echo "::warning::replay assente o ambiguo dopo il tentativo $attempt: $display_title"
done

echo "::error::replay non accodato con certezza dopo due tentativi: $display_title"
exit 1
