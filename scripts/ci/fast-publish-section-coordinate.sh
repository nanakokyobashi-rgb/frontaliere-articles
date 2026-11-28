#!/usr/bin/env bash
# Coordinate stage -> API dispatch/readiness without holding a section slot.
set -euo pipefail

: "${API_ACTION:?API_ACTION is required}"
: "${STAGE_MATRIX:?STAGE_MATRIX is required}"
: "${FINAL_MATRIX:?FINAL_MATRIX is required}"
: "${EVENT_NAME:?EVENT_NAME is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${ARTIFACTS_DIR:?ARTIFACTS_DIR is required}"

read_latest_main() {
  local head=''
  head="$(bash scripts/ci/read-main-head.sh)"
  [[ "$head" =~ ^[a-f0-9]{40}$ ]] || {
    echo "::error::HEAD main non valida al coordinator: $head" >&2
    return 1
  }
  if ! git cat-file -e "$head^{commit}" 2>/dev/null; then git fetch --quiet --no-tags origin "$head"; fi
  git checkout --detach "$head" >/dev/null
  printf '%s\n' "$head"
}

section_list() {
  jq -c '[.[].section] | unique | sort' <<<"$1"
}

# Il download degli stage artifact ha esaurito i tentativi. Se il run ha artifact
# di stage il fallimento e' reale e va dichiarato: trattarlo come «nessuna gamba
# ha prodotto uno stage» scarterebbe tutte le sezioni in silenzio. Se invece non
# ce n'e' nessuno (tutte le gambe fallite/sostituite) si procede senza. I
# marcatori `fast-publish-stage-failed-*` non sono stage: non entrano nel conteggio.
if [ "${STAGE_DOWNLOAD_FAILED:-false}" = 'true' ]; then
  : "${REPO:?REPO is required to verify a failed stage download}"
  : "${RUN_ID:?RUN_ID is required to verify a failed stage download}"
  if ! listed="$(gh api -X GET "repos/$REPO/actions/runs/$RUN_ID/artifacts" -f per_page=100 \
      --jq '[.artifacts[] | select((.name | startswith("fast-publish-stage-")) and ((.name | startswith("fast-publish-stage-failed-")) | not))] | length' 2>/dev/null)" \
    || ! [[ "$listed" =~ ^[0-9]+$ ]]; then
    echo '::error::download degli stage artifact fallito 3 volte e l elenco degli artifact del run non e leggibile: nessuna sezione scartata, release non decisa' >&2
    exit 1
  fi
  if [ "$listed" != '0' ]; then
    echo "::error::download degli stage artifact fallito 3 volte ma il run ne ha $listed: nessuna sezione scartata, release non decisa (il reconciler riprende da qui)" >&2
    exit 1
  fi
  echo '::notice::nessun artifact di stage nel run: nessuna gamba ha prodotto uno stage'
fi

requested_stage_sections="$(section_list "$STAGE_MATRIX")"
# Nessuna barriera tutto-o-niente: una gamba di stage fallita, cancellata o
# sostituita dal pending piu' recente non ha artifact. Il coordinator procede
# con le sezioni che hanno staged; le altre restano a chi le possiede.
stage_sections='[]'
artifact_files=()
if [ "$requested_stage_sections" != '[]' ]; then
  while IFS= read -r section; do
    [[ "$section" =~ ^canton-[a-z0-9-]+$ ]] || { echo "::error::section stage non valida: $section" >&2; exit 1; }
    artifact="$ARTIFACTS_DIR/fast-publish-stage-$section.json"
    if [ -s "$artifact" ]; then
      artifact_files+=("$artifact")
      stage_sections="$(jq -c --arg section "$section" '. + [$section] | unique | sort' <<<"$stage_sections")"
    else
      echo "::warning::stage di $section assente (fallito, cancellato o sostituito): la sezione esce da questa release e resta alla run che la possiede"
    fi
  done < <(jq -r '.[]' <<<"$requested_stage_sections")
fi
dropped_sections="$(jq -cn --argjson requested "$requested_stage_sections" --argjson staged "$stage_sections" '$requested - $staged')"
# Fra le scartate, quelle con un marcatore di gamba FALLITA non hanno nessun
# proprietario (le sostituite/cancellate restano alla run che le possiede): escono
# dalla release API e ricevono un replay full-section dal workflow.
failed_sections='[]'
while IFS= read -r section; do
  [ -n "$section" ] || continue
  marker="$ARTIFACTS_DIR/fast-publish-stage-failed-$section.json"
  if [ -s "$marker" ] && jq -e --arg section "$section" '.failed == true and .section == $section' "$marker" >/dev/null 2>&1; then
    failed_sections="$(jq -c --arg section "$section" '. + [$section] | unique | sort' <<<"$failed_sections")"
    echo "::warning::gamba di stage FALLITA per $section: esce dalla release API e riceve un replay full-section"
  fi
done < <(jq -r '.[]' <<<"$dropped_sections")
# La matrix finale perde le sezioni di stage senza artifact.
final_matrix="$(jq -c --argjson dropped "$dropped_sections" 'map(select(.section as $s | $dropped | index($s) | not))' <<<"$FINAL_MATRIX")"
final_sections="$(section_list "$final_matrix")"

staged_sources='{}'
if [ "${#artifact_files[@]}" -gt 0 ]; then
  artifacts_json="$(jq -s -ce '
    if all(.[]; (.staged == true) and (.section | type == "string") and (.sourceCommit | test("^[a-f0-9]{40}$")))
      and ([.[].section] | unique | length == length)
    then .
    else error("artifact stage non valido o duplicato")
    end
  ' "${artifact_files[@]}")"
  artifact_sections="$(jq -c '[.[].section] | unique | sort' <<<"$artifacts_json")"
  [ "$artifact_sections" = "$stage_sections" ] || {
    echo "::error::artifact stage incompleti: attesi $stage_sections, ricevuti $artifact_sections" >&2
    exit 1
  }
  staged_sources="$(jq -c 'map({key: .section, value: .sourceCommit}) | from_entries' <<<"$artifacts_json")"
fi

latest="$(read_latest_main)"
new_api_changed=false
new_api_targets='[]'
api_baseline=''
if [ "$EVENT_NAME" = 'push' ] && [[ "${PUSH_AFTER:-}" =~ ^[a-f0-9]{40}$ ]]; then
  api_baseline="$PUSH_AFTER"
elif [ "$EVENT_NAME" = 'workflow_run' ] && [[ "${API_WAIT_COMMIT:-}" =~ ^[a-f0-9]{40}$ ]]; then
  api_baseline="$API_WAIT_COMMIT"
elif [ "$API_ACTION" = 'wait' ] && [[ "${API_WAIT_COMMIT:-}" =~ ^[a-f0-9]{40}$ ]]; then
  api_baseline="$API_WAIT_COMMIT"
fi
if [ -n "$api_baseline" ] && [ "$latest" != "$api_baseline" ]; then
  new_api_changed="$(node scripts/ci/fast-publish-section.mjs r2-api-data-range "$api_baseline" "$latest")"
  if [ "$new_api_changed" = 'true' ]; then
    new_api_targets="$(node scripts/ci/fast-publish-section.mjs r2-api-stage-plan-range "$PUSH_AFTER" "$latest")"
  fi
fi
new_api_sections="$(jq -c --argjson failed "$failed_sections" '[.[].section] | unique | sort | . - $failed' <<<"$new_api_targets")"
unaffected_sections='[]'
while IFS= read -r section; do
  source="$(jq -r --arg section "$section" '.[$section] // empty' <<<"$staged_sources")"
  [ -n "$source" ] || continue
  if bash scripts/ci/section-source-unaffected.sh --section "$section" "$source" "$latest"; then
    unaffected_sections="$(jq -c --arg section "$section" '. + [$section] | unique | sort' <<<"$unaffected_sections")"
  fi
done < <(jq -r '.[]' <<<"$stage_sections")

# Recheck once immediately before choosing a release. A changed observation
# invalidates this decision; do not dispatch against an older source.
verified_latest="$(bash scripts/ci/read-main-head.sh)"
if [ "$verified_latest" != "$latest" ]; then
  latest="$verified_latest"
  [[ "$latest" =~ ^[a-f0-9]{40}$ ]] || { echo '::error::HEAD main non valida alla barriera API' >&2; exit 1; }
  if ! git cat-file -e "$latest^{commit}" 2>/dev/null; then git fetch --quiet --no-tags origin "$latest"; fi
  git checkout --detach "$latest" >/dev/null
  new_api_changed=false
  new_api_targets='[]'
  if [ -n "$api_baseline" ] && [ "$latest" != "$api_baseline" ]; then
    new_api_changed="$(node scripts/ci/fast-publish-section.mjs r2-api-data-range "$api_baseline" "$latest")"
    if [ "$new_api_changed" = 'true' ]; then
      new_api_targets="$(node scripts/ci/fast-publish-section.mjs r2-api-stage-plan-range "$PUSH_AFTER" "$latest")"
    fi
  fi
  new_api_sections="$(jq -c --argjson failed "$failed_sections" '[.[].section] | unique | sort | . - $failed' <<<"$new_api_targets")"
  unaffected_sections='[]'
  while IFS= read -r section; do
    source="$(jq -r --arg section "$section" '.[$section] // empty' <<<"$staged_sources")"
    [ -n "$source" ] || continue
    if bash scripts/ci/section-source-unaffected.sh --section "$section" "$source" "$latest"; then
      unaffected_sections="$(jq -c --arg section "$section" '. + [$section] | unique | sort' <<<"$unaffected_sections")"
    fi
  done < <(jq -r '.[]' <<<"$stage_sections")
  last_observation="$(bash scripts/ci/read-main-head.sh)"
  [ "$last_observation" = "$latest" ] || {
    echo '::error::main avanza ripetutamente durante la barriera API; nessun dispatch stale consentito' >&2
    exit 1
  }
fi

decision_json="$(jq -cn \
  --argjson stageTargets "$stage_sections" \
  --argjson newApiTargets "$new_api_sections" \
  --argjson stagedSources "$staged_sources" \
  --arg latestCommit "$latest" \
  --argjson newApiDataChanged "$new_api_changed" \
  --argjson unaffectedSections "$unaffected_sections" \
  '{stageTargets:$stageTargets,newApiTargets:$newApiTargets,stagedSources:$stagedSources,latestCommit:$latestCommit,newApiDataChanged:$newApiDataChanged,unaffectedSections:$unaffectedSections}')"
# Tutte le gambe richieste sono fallite e nessun'altra sezione partecipa: non c'e'
# niente da rilasciare ne' da attendere; il replay full-section rifa' il lavoro.
nothing_to_release=false
if [ "$stage_sections" = '[]' ] && [ "$failed_sections" != '[]' ] \
  && [ "$new_api_sections" = '[]' ] && [ "$final_sections" = '[]' ]; then
  nothing_to_release=true
  echo '::warning::nessuna sezione con stage valido: nessun rilascio API da questa run'
  decision='{"canDispatchApi":false,"waitForLatestApi":false,"staleStageSections":[],"notStagedAtLatest":[]}'
else
  decision="$(node scripts/ci/fast-publish-section.mjs r2-api-stage-barrier <<<"$decision_json")"
fi
can_dispatch="$(jq -r '.canDispatchApi' <<<"$decision")"
wait_latest="$(jq -r '.waitForLatestApi' <<<"$decision")"
api_commit=''
sections_json='[]'
action='none'
wait_api=false
defer_api_wait=false

defer_to_finalize_if_target_is_unstaged() {
  local stale_sections not_staged_sections should_defer
  stale_sections="$(jq -c '.staleStageSections' <<<"$decision")"
  not_staged_sections="$(jq -c '.notStagedAtLatest' <<<"$decision")"
  should_defer="$(jq -cn \
    --argjson final "$final_sections" \
    --argjson stale "$stale_sections" \
    --argjson notStaged "$not_staged_sections" \
    '{finalTargets:$final,staleStageSections:$stale,notStagedAtLatest:$notStaged}' \
    | node scripts/ci/fast-publish-section.mjs r2-api-wait-defer)"
  if [ "$should_defer" = 'true' ]; then
    defer_api_wait=true
    echo '::notice::readiness differita al finalize: un target della matrix finale non è ancora staged su latest'
  else
    wait_api=true
  fi
}

if [ "$nothing_to_release" = 'true' ]; then
  :
elif [ "$API_ACTION" = 'dispatch' ]; then
  if [ "$can_dispatch" = 'true' ]; then
    action=dispatch
    wait_api=true
    api_commit="$latest"
    sections_json="$(jq -cn --argjson stage "$stage_sections" --argjson new "$new_api_sections" --argjson final "$final_sections" '$stage + $new + $final | unique | sort')"
  elif [ "$wait_latest" = 'true' ]; then
    action=wait
    api_commit="$latest"
    if ! [[ "$api_commit" =~ ^[a-f0-9]{40}$ ]]; then
      echo '::error::owner API latest non determinabile per la readiness HTTP' >&2
      exit 1
    fi
    defer_to_finalize_if_target_is_unstaged
    sections_json="$(jq -cn --argjson stage "$stage_sections" --argjson new "$new_api_sections" --argjson final "$final_sections" '$stage + $new + $final | unique | sort')"
  else
    echo '::error::la barriera non puo dispatchare latest e non e presente un owner API successivo da attendere' >&2
    exit 1
  fi
elif [ "$API_ACTION" = 'wait' ]; then
  action=wait
  api_commit="${API_WAIT_COMMIT:-}"
  if [ "$new_api_changed" = 'true' ] && [ -n "$api_baseline" ]; then
    api_commit="$latest"
  fi
  if ! [[ "$api_commit" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::commit API atteso non valido: $api_commit" >&2
    exit 1
  fi
  if [ "$wait_latest" = 'true' ]; then
    defer_to_finalize_if_target_is_unstaged
  else
    wait_api=true
  fi
  sections_json="$(jq -cn --argjson stage "$stage_sections" --argjson new "$new_api_sections" --argjson final "$final_sections" '$stage + $new + $final | unique | sort')"
fi
if [ "$wait_api" = 'true' ] && [ "$sections_json" = '[]' ]; then
  echo '::error::nessuna sezione R2 da verificare dopo il flip API' >&2
  exit 1
fi

echo "final_matrix=$final_matrix" >> "$GITHUB_OUTPUT"
echo "staged_sections=$stage_sections" >> "$GITHUB_OUTPUT"
echo "failed_sections=$failed_sections" >> "$GITHUB_OUTPUT"
echo "action=$action" >> "$GITHUB_OUTPUT"
echo "api_commit=$api_commit" >> "$GITHUB_OUTPUT"
echo "api_baseline=$api_baseline" >> "$GITHUB_OUTPUT"
echo "wait_api=$wait_api" >> "$GITHUB_OUTPUT"
echo "defer_api_wait=$defer_api_wait" >> "$GITHUB_OUTPUT"
echo "sections_json=$sections_json" >> "$GITHUB_OUTPUT"
echo "observed_main=$latest" >> "$GITHUB_OUTPUT"
echo "::notice::decisione API Fast Publish: action=$action source=$api_commit sections=$sections_json stale_stage=$(jq -c '.staleStageSections' <<<"$decision")"
