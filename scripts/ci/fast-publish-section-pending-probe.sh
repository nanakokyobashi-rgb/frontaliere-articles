#!/usr/bin/env bash
# Un dispatch non dry ed eleggibile condivide il gruppo `fast-publish-<sezione>`
# (queue: single) con gli stage e i finalize dei push: entrando in coda puo' aver
# sostituito un job pending di un push SULLA STESSA SEZIONE, che nessuno rendera'
# piu'. Stampa `true` solo se si puo' ESCLUDERE che sia successo; in ogni altro
# caso, errore di lettura compreso, stampa `false`: il chiamante allarga il
# render a full-section.
#
# Per sezione (SECTION), non per workflow: un run push conta solo se la sua
# matrix contiene la sezione (job `stage (<sezione>)` / `finalize (<sezione>)`)
# e se
#  - e' ancora vivo e il finalize della sezione non ha ancora finito (o la
#    matrix non e' ancora materializzata: coordinate_api_release non concluso);
#  - oppure e' concluso (anche `failure` per un'ALTRA gamba) ma un suo job della
#    sezione risulta `cancelled` dopo l'inizio del run corrente. Una
#    sostituzione puo' avvenire solo quando il run corrente entra nel gruppo,
#    cioe' dopo il suo avvio; 5 minuti di margine coprono lo sfasamento degli
#    orologi.
set -euo pipefail

: "${REPO:?REPO is required}"
: "${CURRENT_RUN_ID:?CURRENT_RUN_ID is required}"
window_hours="${PENDING_PROBE_WINDOW_HOURS:-8}"
[[ "$window_hours" =~ ^[0-9]+$ ]] || window_hours=8
skew_seconds=300

section="${SECTION:-}"
if ! [[ "$section" =~ ^canton-[a-z0-9-]+$ ]]; then
  echo "::warning::sezione del probe non valida o assente ('$section'): non posso escludere un finalize sostituito, render full-section" >&2
  echo false
  exit 0
fi

since="$(date -u -d "-${window_hours} hours" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v-"${window_hours}"H +%Y-%m-%dT%H:%M:%SZ)"

# JSON valido da `gh api` con 3 tentativi; stampa il documento o fallisce.
fetch_json() {
  local out attempt
  for attempt in 1 2 3; do
    if out="$(gh api -X GET "$@" 2>/dev/null)" && jq -e . >/dev/null 2>&1 <<<"$out"; then
      printf '%s\n' "$out"
      return 0
    fi
    [ "$attempt" -lt 3 ] && sleep $((attempt * ${PENDING_PROBE_RETRY_DELAY:-3}))
  done
  return 1
}

unreadable() {
  echo "::warning::probe dei run push non leggibile ($1): non posso escludere un finalize sostituito, render full-section" >&2
  echo false
  exit 0
}

runs_doc="$(fetch_json "repos/$REPO/actions/workflows/fast-publish-section.yml/runs" \
  -f event=push -f per_page=100 -f "created=>=$since")" || unreadable 'elenco dei run'
jq -e '(.workflow_runs | type) == "array" and ((.total_count // (.workflow_runs | length)) <= (.workflow_runs | length))' \
  >/dev/null 2>&1 <<<"$runs_doc" || unreadable 'elenco dei run non valido o troncato'

current_doc="$(fetch_json "repos/$REPO/actions/runs/$CURRENT_RUN_ID")" || unreadable 'run corrente'
current_start="$(jq -r '.run_started_at // .created_at // empty' <<<"$current_doc")"
[[ "$current_start" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || unreadable 'inizio del run corrente'
floor_epoch="$(jq -rn --arg t "$current_start" --argjson skew "$skew_seconds" '($t | fromdateiso8601) - $skew')"

# Candidati: run push diversi dal corrente, vivi, oppure conclusi con esito non
# pulito e aggiornati dopo l'inizio del run corrente (prima non possono essere
# stati sostituiti da noi). Un run concluso `success` non ha job cancellati.
candidates="$(jq -r --arg current "$CURRENT_RUN_ID" --argjson floor "$floor_epoch" '
  .workflow_runs[]
  | select((.id | tostring) != $current)
  | select(.status != "completed"
      or ((.conclusion // "") as $c | $c != "success" and $c != "skipped" and $c != "neutral"
          and ((.updated_at // "") | (try fromdateiso8601 catch 0)) >= $floor))
  | .id' <<<"$runs_doc")"

suspects=0
while IFS= read -r run_id; do
  [ -n "$run_id" ] || continue
  jobs_doc="$(fetch_json "repos/$REPO/actions/runs/$run_id/jobs" -f per_page=100 -f filter=latest)" \
    || unreadable "job del run $run_id"
  jq -e '(.jobs | type) == "array" and ((.total_count // (.jobs | length)) <= (.jobs | length))' \
    >/dev/null 2>&1 <<<"$jobs_doc" || unreadable "job del run $run_id non validi o troncati"
  run_status="$(jq -r --arg id "$run_id" '.workflow_runs[] | select((.id | tostring) == $id) | .status' <<<"$runs_doc")"
  if jq -e --arg section "$section" --arg runStatus "$run_status" --argjson floor "$floor_epoch" '
      .jobs as $jobs
      | [$jobs[] | select(.name == "stage (" + $section + ")" or .name == "finalize (" + $section + ")")] as $sec
      | [$sec[] | select(.name | startswith("finalize"))] as $fin
      | ([$jobs[] | select(.name == "coordinate_api_release" and .status == "completed")] | length > 0) as $coordinated
      | if $runStatus != "completed" then
          # Vivo: pending se il finalize della sezione non ha finito, o se la
          # matrix non e materializzata e la sezione potrebbe entrarci.
          (($fin | length) > 0 and any($fin[]; .status != "completed"))
          or (($fin | length) == 0 and ($coordinated | not))
        else
          any($sec[]; .conclusion == "cancelled"
            and (((.completed_at // "") | (try fromdateiso8601 catch 0)) >= $floor
                 or (.completed_at == null)))
        end' >/dev/null <<<"$jobs_doc"; then
    suspects=$((suspects + 1))
    echo "::notice::run push $run_id puo' aver lasciato un job pending di $section sostituito dal run corrente" >&2
  fi
done <<<"$candidates"

if [ "$suspects" = '0' ]; then
  echo "::notice::nessun run push con jobs di $section vivi o cancellati dopo l'inizio del run corrente: sostituzione di un finalize pending esclusa" >&2
  echo true
else
  echo "::notice::$suspects run push con jobs di $section da considerare: non escludo la sostituzione di un finalize pending, render full-section" >&2
  echo false
fi
