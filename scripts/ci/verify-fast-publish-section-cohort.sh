#!/usr/bin/env bash
# Verify the complete child cohort before reconcile-section-pages can replay
# publish-api.  A single workflow_run is only a notification; the cohort
# (nonce, expected size, source revision and result artifact) is the barrier.
set -euo pipefail

repository="${REPOSITORY:-}"
expected_source="${EXPECTED_SOURCE_COMMIT:-}"
mode="${MODE:-event}"
child_run_id="${WORKFLOW_RUN_ID:-}"
child_head_sha="${WORKFLOW_RUN_HEAD_SHA:-}"
child_nonce="${CHILD_NONCE:-}"
child_cohort="${CHILD_COHORT:-}"
output_file="${GITHUB_OUTPUT:-}"

write_output() {
  [ -n "$output_file" ] || return 0
  printf '%s\n' "$1" >> "$output_file"
}

not_ready() {
  local reason="$1"
  write_output 'verified=false'
  echo "::notice::coorte child non pronta: $reason"
  exit 0
}

if [ -z "$repository" ]; then
  not_ready 'repository assente'
fi
if ! [[ "$expected_source" =~ ^[a-f0-9]{40}$ ]]; then
  not_ready "source commit non valida: $expected_source"
fi
case "$mode" in
  event|schedule) ;;
  *) not_ready "modalità non riconosciuta: $mode" ;;
esac

if [ "$mode" = 'event' ] && ! [[ "$child_run_id" =~ ^[0-9]+$ ]]; then
  not_ready "run child non valida: $child_run_id"
fi
if [ "$mode" = 'event' ]; then
  if ! [[ "$child_head_sha" =~ ^[a-f0-9]{40}$ ]]; then
    not_ready "HEAD della run child non valida: $child_head_sha"
  fi
  if [ "$child_head_sha" != "$expected_source" ]; then
    not_ready "run child sulla HEAD $child_head_sha, attesa $expected_source"
  fi
fi

runs_json=""
if ! runs_json="$(gh run list \
  --repo "$repository" \
  --workflow fast-publish-section.yml \
  --branch main \
  --event workflow_dispatch \
  --limit 1000 \
  --json databaseId,displayTitle,status,conclusion,headSha,createdAt)"; then
  not_ready 'elenco delle run fast-publish non leggibile'
fi
if ! jq -e '
  type == "array"
  and all(.[];
    (.databaseId | type) == "number"
    and (.displayTitle | type) == "string"
    and (.status | type) == "string"
    and (.conclusion == null or (.conclusion | type) == "string")
    and (.headSha | type) == "string"
    and (.createdAt | type) == "string"
  )
' <<< "$runs_json" >/dev/null; then
  not_ready 'payload delle run fast-publish non interpretabile'
fi

parse_title=" / (?<section>[^/]+) / nonce=(?<nonce>[^ ]+) / dry=(?<dry>[^ ]+) / (?:c|cohort)=(?<cohort>[^ ]+)$"
candidate_json=''

if [ "$mode" = 'event' ]; then
  candidate_json="$(jq -c --arg id "$child_run_id" --arg nonce "$child_nonce" --arg cohort "$child_cohort" --arg source "$expected_source" '
    [
      .[]
      | . as $run
      | select($run.headSha == $source)
      | (try ($run.displayTitle | capture(" / (?<section>[^/]+) / nonce=(?<nonce>[^ ]+) / dry=(?<dry>[^ ]+) / (?:c|cohort)=(?<cohort>[^ ]+)$")) catch null) as $parts
      | select($parts != null)
      | (try ($parts.cohort | capture("^(?<kind>reconcile|stale-staged|stale-late)-[0-9]+-n(?<size>[1-9][0-9]*)$")) catch null) as $cohort_parts
      | select($cohort_parts != null)
      | {cohort: $parts.cohort,
         expectedSize: ($cohort_parts.size | tonumber),
         run: ($run + {nonce: $parts.nonce, section: $parts.section})}
    ] as $parsed
    | ($parsed | map(select(.cohort == $cohort))) as $same
    | if (any($same[]; (.run.databaseId | tostring) == $id
              and .run.nonce == $nonce))
         and ($same | length > 0)
      then {cohort: $cohort,
            expectedSize: (($same | map(.expectedSize) | unique | if length == 1 then .[0] else 0 end)),
            runs: ($same | map(.run))}
      else empty
      end
  ' <<< "$runs_json")"
  [ -n "$candidate_json" ] || not_ready 'run child non correlata a nonce, coorte e dimensione attesi'
else
  # Il cron non ha un workflow_run da cui leggere la coorte. Sceglie l'ultima
  # coorte emessa sulla stessa HEAD; se e' ancora incompleta resta bloccata e
  # il cron successivo la rivaluta, senza inventare una nuova wave.
  candidate_json="$(jq -c --arg source "$expected_source" --arg re "$parse_title" '
    [
      .[]
      | . as $run
      | select($run.headSha == $source)
      | (try ($run.displayTitle | capture($re)) catch null) as $parts
      | select($parts != null
          and ($parts.cohort | test("^(reconcile|stale-staged|stale-late)-[0-9]+-n[1-9][0-9]*$")))
      | {cohort: $parts.cohort,
         expectedSize: (($parts.cohort | capture("^(reconcile|stale-staged|stale-late)-[0-9]+-n(?<size>[1-9][0-9]*)$").size) | tonumber),
         run: ($run + {nonce: $parts.nonce, section: $parts.section})}
    ]
    | group_by(.cohort)
    | map({
        cohort: .[0].cohort,
        expectedSize: (map(.expectedSize) | unique | if length == 1 then .[0] else 0 end),
        runs: map(.run),
        latest: (map(.run.createdAt) | max)
      })
    | sort_by(.latest)
    | last // empty
    | del(.latest)
  ' <<< "$runs_json")"
  [ -n "$candidate_json" ] || not_ready 'nessuna coorte recente sulla HEAD corrente'
fi

expected_size="$(jq -r '.expectedSize' <<< "$candidate_json")"
cohort="$(jq -r '.cohort' <<< "$candidate_json")"
observed_size="$(jq '.runs | length' <<< "$candidate_json")"
if ! [[ "$expected_size" =~ ^[1-9][0-9]*$ ]]; then
  not_ready "dimensione coorte incoerente: $expected_size"
fi
if [ "$observed_size" -ne "$expected_size" ]; then
  not_ready "child osservati $observed_size, attesi $expected_size per $cohort"
fi
if ! jq -e --arg source "$expected_source" --argjson expected "$expected_size" '
  (.runs | length) == $expected
  and ([.runs[].nonce] | length) == ([.runs[].nonce] | unique | length)
  and ([.runs[].section] | length) == ([.runs[].section] | unique | length)
  and all(.runs[];
    .headSha == $source
    and ((.status // "") | ascii_downcase) == "completed"
    and ((.conclusion // "") | ascii_downcase) == "success"
  )
' <<< "$candidate_json" >/dev/null; then
  not_ready "la coorte $cohort non ha conclusioni success e HEAD coerenti"
fi

artifact_root="$RUNNER_TEMP/fast-publish-section-cohort-${cohort//[^A-Za-z0-9._-]/_}"
rm -rf -- "$artifact_root"
mkdir -p "$artifact_root"

while IFS=$'\t' read -r run_id nonce section; do
  [ -n "$run_id" ] || not_ready "run senza id nella coorte $cohort"
  run_dir="$artifact_root/$run_id"
  mkdir -p "$run_dir"
  if ! gh run download "$run_id" --repo "$repository" --pattern 'fast-publish-result-*' --dir "$run_dir"; then
    not_ready "artifact del child $run_id non scaricabile"
  fi
  mapfile -t result_files < <(find "$run_dir" -type f -name fast-publish-result.json -print)
  if [ "${#result_files[@]}" -ne 1 ]; then
    not_ready "artifact fast-publish-result non univoco per il child $run_id"
  fi
  if ! jq -e \
    --arg nonce "$nonce" \
    --arg section "$section" \
    --arg cohort "$cohort" \
    --arg source "$expected_source" \
    'type == "object"
     and .dispatch_nonce == $nonce
     and .section == $section
     and .dispatch_cohort == $cohort
     and .source_commit == $source
     and .source_main_commit == $source
     and .rendered_head == $source
     and .fresh == "true"
     and (.stale_handoff // "false") == "false"
     and .coordinated_recovery == "true"' \
    "${result_files[0]}" >/dev/null; then
    not_ready "artifact child $run_id non coerente con $cohort/$nonce"
  fi
done < <(jq -r '.runs[] | [.databaseId, .nonce, .section] | @tsv' <<< "$candidate_json")

write_output 'verified=true'
write_output "cohort=$cohort"
write_output "expected_size=$expected_size"
write_output "observed_size=$observed_size"
echo "::notice::coorte child verificata: $cohort ($observed_size/$expected_size), HEAD=$expected_source"
