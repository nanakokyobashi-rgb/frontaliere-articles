#!/usr/bin/env bash
# Un dispatch non dry ed eleggibile condivide il gruppo `fast-publish-<sezione>`
# (queue: single) con i finalize dei push: entrando in coda puo' aver sostituito
# un finalize pending di un push, che nessuno rendera' piu'. Stampa `true` solo
# se si puo' ESCLUDERE che sia successo (nessun run push recente ancora vivo o
# cancellato); in ogni altro caso, errore di lettura compreso, stampa `false`:
# il chiamante allarga il render a full-section.
set -euo pipefail

: "${REPO:?REPO is required}"
: "${CURRENT_RUN_ID:?CURRENT_RUN_ID is required}"
window_hours="${PENDING_PROBE_WINDOW_HOURS:-8}"
[[ "$window_hours" =~ ^[0-9]+$ ]] || window_hours=8

since="$(date -u -d "-${window_hours} hours" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v-"${window_hours}"H +%Y-%m-%dT%H:%M:%SZ)"

runs=''
for attempt in 1 2 3; do
  if runs="$(gh api -X GET "repos/$REPO/actions/workflows/fast-publish-section.yml/runs" \
      -f event=push -f per_page=100 -f created=">=$since" --jq '.workflow_runs' 2>/dev/null)" \
    && jq -e 'type == "array"' >/dev/null 2>&1 <<<"$runs"; then
    break
  fi
  runs=''
  [ "$attempt" -lt 3 ] && sleep $((attempt * ${PENDING_PROBE_RETRY_DELAY:-3}))
done
if [ -z "$runs" ]; then
  echo "::warning::probe dei run push non leggibile: non posso escludere un finalize sostituito, render full-section" >&2
  echo false
  exit 0
fi

# Un run push ancora vivo puo' avere un finalize pending; uno cancellato puo'
# essere stato sostituito. Il run corrente non conta.
suspects="$(jq -r --arg current "$CURRENT_RUN_ID" \
  '[.[] | select((.id | tostring) != $current) | select(.status != "completed" or .conclusion == "cancelled")] | length' <<<"$runs")"
if [ "$suspects" = '0' ]; then
  echo "::notice::nessun run push vivo o cancellato nelle ultime ${window_hours}h: sostituzione di un finalize pending esclusa" >&2
  echo true
else
  echo "::notice::$suspects run push vivi o cancellati nelle ultime ${window_hours}h: non escludo la sostituzione di un finalize pending, render full-section" >&2
  echo false
fi
