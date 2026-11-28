#!/usr/bin/env bash
# Resolve the fast-publish matrix outside workflow YAML. Keeping this long
# resolver in a checked-in script avoids GitHub's 21k run-expression limit.
set -euo pipefail
MATERIALIZED_RESOLVE_PATHS=(
  scripts/ci/fast-publish-section-resolve.sh
  scripts/ci/read-main-head.sh
  scripts/ci/fast-publish-section-edge-candidate.sh
  scripts/ci/fast-publish-section-preflight.sh
  scripts/ci/fetch-push-base-if-missing.sh
)
restore_materialized_resolve_paths() {
  local runtime_path=''
  for runtime_path in "${MATERIALIZED_RESOLVE_PATHS[@]}"; do
    if git cat-file -e "HEAD:$runtime_path" 2>/dev/null; then
      git restore --source=HEAD --worktree -- "$runtime_path" || return 1
    elif [ -e "$runtime_path" ] || [ -L "$runtime_path" ]; then
      # Un helper introdotto dopo la revisione pinnata e' un file non
      # tracciato in quella HEAD: toglie solo il target materializzato noto.
      rm -f -- "$runtime_path" || return 1
    fi
  done
}
# Un replay richiesto come produttivo non può diventare un dry-run
# silenzioso: il nome della run riflette l'input, quindi falliamo
# prima di risolvere o redispatchare se il kill switch lo disarma.
if [ "$EVENT_NAME" = 'workflow_dispatch' ] && [ "$DRY_RUN_INPUT" = 'false' ] \
  && { [ -f .github/FAST_PUBLISH_DISABLED ] || [ "${FAST_PUBLISH_ARMED:-}" = 'false' ]; }; then
  echo "::error::replay richiesto con dry_run=false ma il publisher è disarmato; nessuna pubblicazione è stata eseguita"
  exit 1
fi
reconcile_edge_matrix() {
  local expected_commit="${1:-}"
  local fallback_commit="${2:-}"
  local source_dir="${3:-$PWD}"
  local deadline=$(( SECONDS + 8 * 60 ))
  local attempt=0
  local matrix=''
  local remaining=0
  local attempt_timeout=0
  local delay=0
  local max_attempt_seconds=30
  if ! command -v timeout >/dev/null 2>&1; then
    echo "::error::timeout command unavailable; refusing an unbounded edge reconciliation" >&2
    return 1
  fi
  reconcile_edge_attempt() {
    local candidate="${1:-}"
    local budget_seconds="${2:-0}"
    local candidate_timeout="$budget_seconds"
    if [ "$candidate_timeout" -gt "$max_attempt_seconds" ]; then
      candidate_timeout="$max_attempt_seconds"
    fi
    if [ "$candidate_timeout" -le 0 ]; then
      return 124
    fi
    (
      cd "$source_dir"
      timeout --signal=TERM --kill-after=1s "${candidate_timeout}s" \
        node scripts/ci/fast-publish-section.mjs r2-reconcile-plan "$candidate"
    ) \
      | jq -c 'map(. + {bootstrap: (.bootstrap // false)})'
  }
  while (( SECONDS < deadline )); do
    remaining=$(( deadline - SECONDS ))
    if [ "$remaining" -le 0 ]; then break; fi
    attempt=$((attempt + 1))
    attempt_timeout="$remaining"
    if [ "$attempt_timeout" -gt "$max_attempt_seconds" ]; then
      attempt_timeout="$max_attempt_seconds"
    fi
    if matrix="$(reconcile_edge_attempt "$expected_commit" "$attempt_timeout")"; then
      printf '%s' "$matrix"
      return 0
    fi
    remaining=$(( deadline - SECONDS ))
    if [ -n "$fallback_commit" ] && matrix="$(bash scripts/ci/fast-publish-section-edge-candidate.sh "$source_dir" "$expected_commit" "$fallback_commit" "$remaining")"; then
      printf %s "$matrix"
      return
    fi
    remaining=$(( deadline - SECONDS ))
    if [ "$remaining" -gt 0 ] && [ -n "$fallback_commit" ] && [ "$fallback_commit" != "$expected_commit" ]; then
      attempt=$((attempt + 1))
      attempt_timeout="$remaining"
      if [ "$attempt_timeout" -gt "$max_attempt_seconds" ]; then
        attempt_timeout="$max_attempt_seconds"
      fi
      if matrix="$(reconcile_edge_attempt "$fallback_commit" "$attempt_timeout")"; then
        echo "::notice::registro edge coerente sulla release $fallback_commit dopo il tentativo $attempt" >&2
        printf '%s' "$matrix"
        return 0
      fi
    fi
    remaining=$(( deadline - SECONDS ))
    if [ "$remaining" -le 0 ]; then break; fi
    delay=5
    if [ "$remaining" -lt "$delay" ]; then delay="$remaining"; fi
    echo "::notice::registro edge in transizione; ritento il piano di riconciliazione tra ${delay} secondi (tentativo $attempt, budget residuo ${remaining}s)" >&2
    sleep "$delay"
  done
  echo "::error::registro edge non coerente dopo $attempt tentativi; nessun replay verra' accodato" >&2
  return 1
}
range_has_api_data() {
  local before_ref="${1:-}" after_ref="${2:-}" before_sha='' after_sha='' result=''
  if [ -z "$before_ref" ] || [[ "$before_ref" =~ ^0+$ ]]; then before_ref=HEAD~1; fi
  if [ -z "$after_ref" ]; then after_ref=HEAD; fi
  before_sha="$(git rev-parse "$before_ref^{commit}")" || return 1
  after_sha="$(git rev-parse "$after_ref^{commit}")" || return 1
  result="$(node scripts/ci/fast-publish-section.mjs r2-api-data-range "$before_sha" "$after_sha")" || return 1
  case "$result" in
    true|false) printf '%s\n' "$result" ;;
    *) echo "::error::esito API data non valido per $before_sha..$after_sha" >&2; return 1 ;;
  esac
}
full_section_matrix() {
  jq -c 'map(if .cleanupInactiveSurface == true then . else . + {ids: [], bootstrap: true} end)'
}
if [ "$EVENT_NAME" = 'push' ] || { [ "$EVENT_NAME" = 'workflow_run' ] && [ "$WORKFLOW_RUN_EVENT" = 'push' ]; }; then
  cover_drain_message="${COVER_DRAIN_COMMIT_MESSAGE:-}"
  if [ "$EVENT_NAME" = 'workflow_run' ]; then
    cover_drain_message="${WORKFLOW_RUN_COVER_DRAIN_COMMIT_MESSAGE:-}"
  fi
  export COVER_DRAIN_COMMIT_MESSAGE="$cover_drain_message"
  cover_drain_marker="$(node scripts/ci/cover-drain-commit.mjs is-cover-drain)"
  if [ "$cover_drain_marker" = 'true' ]; then
    echo 'cover-drain push is handled by the explicit publisher outbox dispatch; skipping automatic section publishing'
    {
      echo 'matrix=[]'
      echo 'any=false'
      echo 'dry=false'
      echo 'stage_matrix=[]'
      echo 'stage_any=false'
      echo 'api_action=none'
      echo 'api_wait_commit='
      echo 'replay_api_after_publish=false'
      echo 'allow_deferred_live_release=false'
    } >> "$GITHUB_OUTPUT"
    exit 0
  fi
fi
if [ "$EVENT_NAME" = 'workflow_run' ] && [ "$WORKFLOW_RUN_EVENT" = 'workflow_dispatch' ] \
  && [ "${WORKFLOW_RUN_RANGE_SOURCE:-}" = 'fast-publish-range-title' ]; then
  echo "::notice::workflow_run del dispatch API gia' coperto dal push Fast Publish; nessuna seconda matrix"
  {
    echo 'matrix=[]'
    echo 'any=false'
    echo 'dry=false'
    echo 'stage_matrix=[]'
    echo 'stage_any=false'
    echo 'api_action=none'
    echo 'api_wait_commit='
    echo 'replay_api_after_publish=false'
    echo 'allow_deferred_live_release=false'
    echo "before=$PUSH_BEFORE"
    echo "after=$PUSH_AFTER"
    echo 'source_commit='
    echo "api_release_commit=${API_RELEASE_COMMIT_INPUT:-}"
  } >> "$GITHUB_OUTPUT"
  exit 0
fi
pinned_source=''
if [ "$EVENT_NAME" = 'workflow_dispatch' ] && [ -n "${SOURCE_COMMIT_INPUT:-}" ]; then
  pinned_source="${SOURCE_MAIN_COMMIT_INPUT:-$SOURCE_COMMIT_INPUT}"
fi
if [ -n "$pinned_source" ]; then
  if ! current_main="$(bash scripts/ci/read-main-head.sh)"; then
    echo "::error::impossibile verificare la revisione corrente di main prima del piano"
    exit 1
  fi
  if ! [[ "$current_main" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::revisione corrente di main non valida prima del piano"
    exit 1
  fi
  # Use the same publication-input check as the publish job. Cover queue
  # bookkeeping and generator-only commits must not force a new edge plan.
  if [ "$current_main" != "$pinned_source" ] \
    && ! bash .replay-dispatcher-source/scripts/ci/section-source-unaffected.sh "$pinned_source" "$current_main"; then
    echo "::notice::replay stantio saltato nel resolve: main e' avanzata da $pinned_source a $current_main"
    # A stale resolve is replanned in this run below. It must not redispatch a
    # child and then return matrix=[], because the coordinator waits for the
    # parent's fast-publish-result artifact.
    replay_dry=false
    replay_api_after_publish=false
    allow_deferred_live_release=false
    replay_before="${PUSH_BEFORE:-}"
    replay_after=''
    replay_matrix='[]'
    if ! PUSH_BEFORE='' FETCH_MAIN=true bash scripts/ci/fetch-push-base-if-missing.sh; then
      echo "::error::impossibile aggiornare main tramite il guard bounded per il piano stale"
      exit 1
    fi
    fetched_current_main="$(git rev-parse refs/remotes/origin/main)"
    if [ "$fetched_current_main" != "$current_main" ]; then
      echo "::error::main e' avanzata durante la preparazione del piano stale ($current_main -> $fetched_current_main)"
      exit 1
    fi
    if [ "$EVENT_NAME" = 'workflow_dispatch' ]; then
      replay_dry="${DRY_RUN_INPUT:-true}"
      replay_api_after_publish="${REPLAY_API_INPUT:-false}"
      allow_deferred_live_release="${ALLOW_DEFERRED_LIVE_RELEASE_INPUT:-false}"
      # The source checkout is current_main. Keep a push range only
      # when it has a base, and always end that range at current_main
      # so a stale head cannot select an older API release.
      if [ -n "$replay_before" ]; then
        replay_after="$current_main"
      fi
      [ -n "${SECTION_INPUT:-}" ] || {
        echo '::error::section obbligatoria per un replay bounded stantio'
        exit 1
      }
      ids_json='[]'
      if [ -n "${ARTICLE_IDS_INPUT:-}" ]; then
        ids_json="$(printf '%s' "$ARTICLE_IDS_INPUT" | jq -ce '
          if type == "array" and all(.[]; type == "string" and length > 0)
          then unique
          else error("article_ids must be a JSON array of article ids")
          end
        ')"
      fi
      validate_page_paths() {
        local option="$1"
        jq -ce --arg option "$option" '
          if type == "array" and all(.[]; type == "string" and test("^/[a-z0-9/-]+/$") and (contains("//") | not))
          then unique
          else error($option + " must be a JSON array of canonical paths")
          end
        '
      }
      missing_pages_json="$(printf '%s' "${MISSING_PAGE_PATHS_INPUT:-[]}" | validate_page_paths missing_page_paths)"
      known_missing_pages_json="$(printf '%s' "${KNOWN_MISSING_PAGE_PATHS_INPUT:-[]}" | validate_page_paths known_missing_page_paths)"
      bootstrap=false
      [ "${BOOTSTRAP_INPUT:-false}" = 'true' ] && bootstrap=true
      remove_stale=false
      [ "${REMOVE_STALE_INPUT:-false}" = 'true' ] && remove_stale=true
      cleanup_inactive_surface=false
      [ "${CLEANUP_INACTIVE_SURFACE_INPUT:-false}" = 'true' ] && cleanup_inactive_surface=true
      [ "$cleanup_inactive_surface" = 'true' ] && remove_stale=true
      if [ "$bootstrap" = 'true' ] && [ "$ids_json" != '[]' ]; then
        echo '::error::bootstrap rende tutti gli articoli: non si combina con article_ids'
        exit 1
      fi
      replay_matrix="$(jq -cn \
        --arg s "$SECTION_INPUT" \
        --argjson ids "$ids_json" \
        --argjson missing "$missing_pages_json" \
        --argjson knownMissing "$known_missing_pages_json" \
        --argjson b "$bootstrap" \
        --argjson r "$remove_stale" \
        --argjson c "$cleanup_inactive_surface" \
        '[{section: $s, ids: $ids, missingPagePaths: $missing, knownMissingPagePaths: $knownMissing, bootstrap: $b, removeStaleCantonRssFeeds: $r, cleanupInactiveSurface: $c}]')"
    else
      if [ -n "$replay_before" ]; then
        replay_after="$current_main"
      fi
      # The edge candidate may be pinned to the stale run, but the
      # matrix shape must come from current main so new or activated
      # sections are included in the replay.
      current_main_source="$RUNNER_TEMP/fast-publish-section-current-main-${GITHUB_RUN_ID}"
      cleanup_current_main_source() {
        if [ -e "$current_main_source" ]; then
          rm -rf -- "$current_main_source"
        fi
      }
      trap cleanup_current_main_source EXIT
      if [ -e "$current_main_source" ]; then
        echo "::error::snapshot temporaneo gia' esistente: $current_main_source"
        exit 1
      fi
      if ! mkdir "$current_main_source"; then
        echo "::error::impossibile preparare lo snapshot della HEAD corrente per il piano stale"
        exit 1
      fi
      if ! git archive --format=tar "$current_main" -- \
        engine host generator/data/canton-sections.json generator/scripts/lib \
        scripts/ci/fast-publish-section.mjs scripts/lib \
        | tar -x -C "$current_main_source"; then
        echo "::error::impossibile materializzare il codice della HEAD corrente per il piano stale"
        exit 1
      fi
      replay_matrix="$(reconcile_edge_matrix "$pinned_source" "$current_main" "$current_main_source")"
    fi
    if [ -f .github/FAST_PUBLISH_DISABLED ]; then
      echo '::warning::.github/FAST_PUBLISH_DISABLED present — running stale replan dry'
      replay_dry=true
    elif [ "${FAST_PUBLISH_ARMED:-}" = 'false' ]; then
      echo '::warning::repo variable FAST_PUBLISH_ARMED=false — running stale replan dry'
      replay_dry=true
    fi
    if [ "$EVENT_NAME" = 'workflow_dispatch' ] && [ "${DRY_RUN_INPUT:-true}" = 'false' ] && [ "$replay_dry" = 'true' ]; then
      echo '::error::replay richiesto con dry_run=false ma il publisher è disarmato; nessuna pubblicazione è stata eseguita'
      exit 1
    fi
    # Il workflow materializza questi helper dalla propria revisione dentro il
    # checkout pinnato (uno come symlink). Se main avanza e uno degli helper e'
    # cambiato, Git rifiuta il checkout per non sovrascrivere la modifica
    # locale. Sono file di runtime, non output del corpus: riportali prima ai
    # byte tracciati della revisione pinnata, poi riallinea l'intero checkout.
    if ! restore_materialized_resolve_paths; then
      echo '::error::impossibile ripristinare gli helper materializzati prima del replan stale'
      exit 1
    fi
    if ! git checkout --detach "$current_main"; then
      echo "::error::impossibile riallineare il resolve alla HEAD corrente $current_main"
      exit 1
    fi
    if [ "$(git rev-parse HEAD)" != "$current_main" ]; then
      echo '::error::checkout stale replan non coincide con la HEAD corrente'
      exit 1
    fi
    # Classify the original API push; render the current head for those targets.
    if [ "$EVENT_NAME" = 'workflow_dispatch' ] && [ -n "${SOURCE_COMMIT_INPUT:-}" ]; then
      replay_matrix="$(printf '%s\n' "$replay_matrix" | full_section_matrix)"
    fi
    any=false
    [ "$(printf '%s' "$replay_matrix" | jq 'length')" -gt 0 ] && any=true
    bootstrap=false
    [ "$(printf '%s' "$replay_matrix" | jq 'any(.[]; .bootstrap == true)')" = 'true' ] && bootstrap=true
    # Slot di concorrenza: dry-run e target non eleggibili fuori dal gruppo reale.
    replay_matrix="$(printf '%s' "$replay_matrix" | node scripts/ci/fast-publish-section.mjs r2-annotate-slots "$replay_dry")"
    {
      echo "matrix=$replay_matrix"
      echo "any=$any"
      echo "dry=$replay_dry"
      echo "bootstrap=$bootstrap"
      stage_matrix='[]'
      stage_any=false
      api_action=none
      if [ "$any" = 'true' ] && { [ "$bootstrap" = 'true' ] || [ "$replay_api_after_publish" = 'true' ]; }; then
        stage_matrix="$(printf '%s\n' "$replay_matrix" | full_section_matrix)"
        stage_any=true
        api_action=dispatch
      fi
      echo "stage_matrix=$stage_matrix"
      echo "stage_any=$stage_any"
      echo "api_action=$api_action"
      echo 'api_wait_commit='
      echo "replay_api_after_publish=$replay_api_after_publish"
      echo "allow_deferred_live_release=$allow_deferred_live_release"
      echo "source_commit=$current_main"
      echo 'api_release_commit='
      echo "before=$replay_before"
      echo "after=$replay_after"
    } >> "$GITHUB_OUTPUT"
    echo "::notice::replay stantio ripianificato sulla HEAD $current_main con matrix=$replay_matrix"
    exit 0
  fi
fi
before="${PUSH_BEFORE:-}"
after="${PUSH_AFTER:-}"
replay_api_after_publish=false
api_data_changed=false
if [ "$EVENT_NAME" = 'workflow_run' ]; then
  if [ -z "${WORKFLOW_RUN_HEAD_SHA:-}" ] || [ "$(git rev-parse HEAD)" != "$WORKFLOW_RUN_HEAD_SHA" ]; then
    echo "::error::workflow_run head non coincide con il checkout"
    exit 1
  fi
fi
if [ "$EVENT_NAME" = "workflow_dispatch" ]; then
  dry=true
  [ "$DRY_RUN_INPUT" = "false" ] && dry=false
  ids_json='[]'
  if [ -n "$ARTICLE_IDS_INPUT" ]; then
    ids_json="$(printf '%s' "$ARTICLE_IDS_INPUT" | jq -ce '
      if type == "array" and all(.[]; type == "string" and length > 0)
      then unique
      else error("article_ids must be a JSON array of article ids")
      end
    ')"
  fi
  validate_page_paths() {
    local option="$1"
    jq -ce --arg option "$option" '
      if type == "array" and all(.[]; type == "string" and test("^/[a-z0-9/-]+/$") and (contains("//") | not))
      then unique
      else error($option + " must be a JSON array of canonical paths")
      end
    '
  }
  missing_pages_json="$(printf '%s' "${MISSING_PAGE_PATHS_INPUT:-[]}" | validate_page_paths missing_page_paths)"
  known_missing_pages_json="$(printf '%s' "${KNOWN_MISSING_PAGE_PATHS_INPUT:-[]}" | validate_page_paths known_missing_page_paths)"
  bootstrap=false
  [ "$BOOTSTRAP_INPUT" = "true" ] && bootstrap=true
  remove_stale=false
  [ "$REMOVE_STALE_INPUT" = "true" ] && remove_stale=true
  [ "$REPLAY_API_INPUT" = "true" ] && replay_api_after_publish=true
  allow_deferred_live_release=false
  if [ "$REPLAY_API_INPUT" = "true" ] || [ "$ALLOW_DEFERRED_LIVE_RELEASE_INPUT" = "true" ]; then
    allow_deferred_live_release=true
  fi
  if [ "$bootstrap" = "true" ] && [ "$ids_json" != "[]" ]; then
    echo "::error::bootstrap rende tutti gli articoli: non si combina con article_ids"
    exit 1
  fi
  cleanup_inactive_surface=false
  [ "${CLEANUP_INACTIVE_SURFACE_INPUT:-false}" = "true" ] && cleanup_inactive_surface=true
  [ "$cleanup_inactive_surface" = "true" ] && remove_stale=true
  matrix="$(jq -cn --arg s "$SECTION_INPUT" --argjson ids "$ids_json" --argjson missing "$missing_pages_json" --argjson knownMissing "$known_missing_pages_json" --argjson b "$bootstrap" --argjson r "$remove_stale" --argjson c "$cleanup_inactive_surface" \
    '[{section: $s, ids: $ids, missingPagePaths: $missing, knownMissingPagePaths: $knownMissing, bootstrap: $b, removeStaleCantonRssFeeds: $r, cleanupInactiveSurface: $c}]')"
else
  dry=false
  allow_deferred_live_release=false
  if [ "$EVENT_NAME" = 'workflow_run' ]; then
    if [ "$WORKFLOW_RUN_EVENT" = 'push' ]; then
      if [ -z "$before" ] || [[ "$before" =~ ^0+$ ]]; then before=HEAD~1; fi
      api_data_changed="$(range_has_api_data "$before" "${after:-$WORKFLOW_RUN_HEAD_SHA}")"
      if [ "$api_data_changed" = 'true' ]; then
        diff_matrix="$(node scripts/ci/fast-publish-section.mjs r2-plan-range "$before" "${after:-$WORKFLOW_RUN_HEAD_SHA}")"
        if [ "$(jq 'length' <<< "$diff_matrix")" -gt 0 ]; then
          # The push trigger owns the direct stage/finalize path for these R2 inputs.
          matrix='[]'
        else
          # API-only ranges keep the post-publish live reconciliation path.
          edge_matrix="$(reconcile_edge_matrix "$WORKFLOW_RUN_HEAD_SHA")"
          matrix="$(printf '%s\n%s\n' "$diff_matrix" "$edge_matrix" \
            | node scripts/ci/fast-publish-section.mjs r2-api-push-plan)"
        fi
      else
        # Render-code-only commits were handled by the direct push trigger.
        matrix='[]'
      fi
    else
      # Schedule e dispatch espliciti restano riconciliazioni edge complete.
      matrix="$(reconcile_edge_matrix "$WORKFLOW_RUN_HEAD_SHA")"
    fi
  else
    if [ -z "$before" ] || [[ "$before" =~ ^0+$ ]]; then before=HEAD~1; fi
    matrix="$(node scripts/ci/fast-publish-section.mjs r2-plan-range "$before" "${after:-HEAD}")"
    if [ "$EVENT_NAME" = 'push' ]; then
      api_data_changed="$(range_has_api_data "$before" "${after:-HEAD}")"
      matrix="$(printf '%s\n' "$matrix" | full_section_matrix)"
      if [ "$api_data_changed" = 'true' ]; then
        replay_api_after_publish=true
        allow_deferred_live_release=true
      else
        replay_api_after_publish=false
        allow_deferred_live_release=false
      fi
    fi
  fi
fi
# Applica i kill switch anche ai workflow_dispatch, inclusi i replay
# stantii: l'input dry_run=false non può riarmare il publisher.
if [ -f .github/FAST_PUBLISH_DISABLED ]; then
  echo "::warning::.github/FAST_PUBLISH_DISABLED present — running dry"
  dry=true
elif [ "${FAST_PUBLISH_ARMED:-}" = "false" ]; then
  echo "::warning::repo variable FAST_PUBLISH_ARMED=false — running dry"
  dry=true
fi
if [ "$EVENT_NAME" = 'workflow_dispatch' ] && [ "$DRY_RUN_INPUT" = 'false' ] && [ "$dry" = 'true' ]; then
  echo "::error::replay richiesto con dry_run=false ma il publisher è disarmato; nessuna pubblicazione è stata eseguita"
  exit 1
fi
any=false
[ "$(printf '%s' "$matrix" | jq 'length')" -gt 0 ] && any=true
bootstrap=false
if [ "$(printf '%s' "$matrix" | jq 'any(.[]; .bootstrap == true)')" = "true" ]; then
  bootstrap=true
fi
stage_matrix='[]'
api_action=none
api_wait_commit=''
if [ "$EVENT_NAME" = 'push' ] && [ "$api_data_changed" = 'true' ] && [ "$any" = 'true' ]; then
  stage_matrix="$(node scripts/ci/fast-publish-section.mjs r2-api-stage-plan-range "$before" "${after:-HEAD}")"
  publish_api_push_owner="$(node scripts/ci/fast-publish-api-only-decision.mjs \
    --push-trigger "$before" "${after:-HEAD}" .github/workflows/publish-api.yml)"
  if [ "$publish_api_push_owner" = 'true' ]; then
    # publish-api already owns this push through its paths filter. Stage
    # before observing its release, then finalize without a duplicate run.
    api_action=wait
    api_wait_commit="${after:-$(git rev-parse HEAD)}"
  else
    # Local R2 inputs outside publish-api's push filter still need one API
    # publish after every requested section has staged.
    api_action=dispatch
  fi
elif [ "$EVENT_NAME" = 'workflow_run' ] && [ "$any" = 'true' ]; then
  api_action=wait
  api_wait_commit="$WORKFLOW_RUN_HEAD_SHA"
elif [ "$EVENT_NAME" = 'workflow_dispatch' ] && [ "$any" = 'true' ] \
  && [ -n "${API_RELEASE_COMMIT_INPUT:-}" ]; then
  if ! [[ "$API_RELEASE_COMMIT_INPUT" =~ ^[a-f0-9]{40}$ ]]; then
    echo '::error::api_release_commit deve essere una SHA completa'
    exit 1
  fi
  api_action=wait
  api_wait_commit="$API_RELEASE_COMMIT_INPUT"
elif [ "$EVENT_NAME" = 'workflow_dispatch' ] && [ "$any" = 'true' ] \
  && { [ "$bootstrap" = 'true' ] || [ "$replay_api_after_publish" = 'true' ]; }; then
  stage_matrix="$(printf '%s\n' "$matrix" | full_section_matrix)"
  api_action=dispatch
fi
# Slot di concorrenza: dry-run e target non eleggibili non devono sostituire
# il pending reale di un push (queue: single).
matrix="$(printf '%s' "$matrix" | node scripts/ci/fast-publish-section.mjs r2-annotate-slots "$dry")"
stage_matrix="$(printf '%s' "$stage_matrix" | node scripts/ci/fast-publish-section.mjs r2-annotate-slots "$dry")"
stage_any=false
[ "$(jq 'length' <<< "$stage_matrix")" -gt 0 ] && stage_any=true
{
  echo "matrix=$matrix"
  echo "any=$any"
  echo "dry=$dry"
  echo "bootstrap=$bootstrap"
  echo "stage_matrix=$stage_matrix"
  echo "stage_any=$stage_any"
  echo "api_action=$api_action"
  echo "api_wait_commit=$api_wait_commit"
  echo "replay_api_after_publish=$replay_api_after_publish"
  echo "allow_deferred_live_release=$allow_deferred_live_release"
  echo "before=$before"
  echo "after=$after"
  echo 'source_commit='
  echo "api_release_commit=${API_RELEASE_COMMIT_INPUT:-}"
} >> "$GITHUB_OUTPUT"
echo "resolved matrix=$matrix dry=$dry"

      # Tieni l'arming del replay fuori dal run monolitico di resolve: GitHub
      # rifiuta workflow con espressioni oltre 21.000 caratteri. I valori
      # calcolati da plan restano la base per dispatch, bootstrap e replay.
