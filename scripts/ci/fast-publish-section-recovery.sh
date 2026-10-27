#!/usr/bin/env bash
# Re-dispatch stale or mixed section releases from the current main revision.
set -euo pipefail
runtime_pat="${GITHUB_PAT_NANAKO:-}"
if [ -z "$runtime_pat" ]; then
  echo "::error::GITHUB_PAT_NANAKO non caricato: recovery staged impossibile"
  exit 1
fi
if ! [[ "$CURRENT_MAIN" =~ ^[a-f0-9]{40}$ ]]; then
  echo "::error::HEAD corrente non valida per il recovery bootstrap: $CURRENT_MAIN"
  exit 1
fi
export GH_TOKEN="$runtime_pat"
target_matrix="$TARGET_MATRIX"
if [ "${MIXED_MATRIX:-false}" = 'true' ]; then
  # Una matrice mista non può riusare il piano risolto prima che
  # main avanzasse: ricostruisci il piano dalla revisione corrente
  # e dalla base della push originaria prima di redispatchare.
  if [ "$(git rev-parse --is-shallow-repository)" = 'true' ]; then
    git fetch --no-tags --unshallow origin main
  else
    git fetch --no-tags origin main
  fi
  plan_before="${ORIGINAL_PUSH_BEFORE:-}"
  if [ -z "$plan_before" ] || [[ "$plan_before" =~ ^0+$ ]]; then
    plan_before="$(git rev-parse "${CURRENT_MAIN}^")"
  fi
  if ! [[ "$plan_before" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::base della push non valida per il piano mixed-matrix: $plan_before"
    exit 1
  fi
  git checkout --detach "$CURRENT_MAIN"
  target_matrix="$(git diff --name-status "$plan_before" "$CURRENT_MAIN" \
    | PUSH_BEFORE="$plan_before" node scripts/ci/fast-publish-section.mjs r2-plan \
    | jq -c 'map(. + {bootstrap: (.bootstrap // false)})')"
  if [ -z "$target_matrix" ] || [ "$target_matrix" = '[]' ]; then
    echo "::error::il piano ricalcolato sulla HEAD corrente è vuoto"
    exit 1
  fi
  echo "::notice::piano mixed-matrix ricalcolato sulla HEAD $CURRENT_MAIN dalla base $plan_before"
fi
dispatch_nonce_input="${DISPATCH_NONCE:-}"
dispatched=0
failed_sections=()
dispatch_titles=()
dispatch_sections=()
dispatch_baseline_ids=()
dispatch_initial_states=()
child_replay_api_after_publish="${REPLAY_API_AFTER_PUBLISH:-false}"
child_allow_deferred_live_release="${ALLOW_DEFERRED_LIVE_RELEASE:-false}"
child_coordinated_recovery=false
if [ "${MIXED_MATRIX:-false}" = 'true' ]; then
  # The coordinator waits for every section child and dispatches publish-api
  # once afterwards. Letting every child arm it would fan out identical API
  # publishes for a mixed matrix. The explicit coordination flag also disables
  # the bootstrap branch inside the child workflow, which otherwise could arm
  # its own publish-api replay independently of this coordinator.
  child_replay_api_after_publish=false
  child_allow_deferred_live_release=true
  child_coordinated_recovery=true
fi
# The stale dispatcher returns as soon as GitHub accepts a dispatch. Capture
# the pre-dispatch run frontier so an older successful run with the same nonce
# cannot satisfy the barrier while the new child is still invisible to the API.
dispatch_run_snapshot=""
if ! dispatch_run_snapshot="$(gh run list --repo "$REPOSITORY" --workflow fast-publish-section.yml --branch main --event workflow_dispatch --limit 100 --json databaseId,displayTitle,status,conclusion)"; then
  echo "::error::impossibile leggere lo stato dei child prima del recovery staged"
  exit 1
fi
if ! jq -e 'type == "array"' <<<"$dispatch_run_snapshot" >/dev/null 2>&1; then
  echo "::error::gh run list ha restituito uno snapshot child non valido prima del recovery staged"
  exit 1
fi
while IFS=$'\t' read -r section article_ids missing_page_paths known_missing_page_paths bootstrap remove_stale cleanup_inactive_surface; do
  [ -n "$section" ] || continue
  nonce_seed="${dispatch_nonce_input:-stale-staged-recovery}"
  nonce_hash="$(printf '%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s' \
    "$nonce_seed" "$CURRENT_MAIN" "$section" "$article_ids" "$missing_page_paths" \
    "$known_missing_page_paths" "$bootstrap" "$remove_stale" "$cleanup_inactive_surface" \
    "$child_replay_api_after_publish" "$child_allow_deferred_live_release" \
    "$child_coordinated_recovery" | sha256sum | cut -c1-16)"
  dispatch_nonce="stale-staged-${CURRENT_MAIN:0:12}-${section}-${nonce_hash}"
  dispatch_title="cover-publish-section / ${section} / nonce=${dispatch_nonce}"
  baseline_run_id="$(jq -r --arg title "$dispatch_title" '
    [.[] | select(
      ((.displayTitle // "") == $title or ((.displayTitle // "") | startswith($title + " / dry=")))
    ) | .databaseId | tonumber] | max // 0
  ' <<<"$dispatch_run_snapshot")"
  initial_run_state="$(jq -r --arg title "$dispatch_title" '
    [.[] | select(
      ((.displayTitle // "") == $title or ((.displayTitle // "") | startswith($title + " / dry=")))
    )]
    | sort_by(.databaseId | tonumber)
    | if length == 0 then "missing"
      elif .[-1].status != "completed" then "pending"
      elif .[-1].conclusion == "success" then "success"
      else "failed"
      end
  ' <<<"$dispatch_run_snapshot")"
  echo "::notice::recovery staged $section sulla HEAD corrente $CURRENT_MAIN"
  if bash .replay-dispatcher-source/scripts/ci/dispatch-fast-publish-replay.sh "$REPOSITORY" "$dispatch_title" --ref main \
    -f section="$section" \
    -f article_ids="$article_ids" \
    -f missing_page_paths="$missing_page_paths" \
    -f known_missing_page_paths="$known_missing_page_paths" \
    -f bootstrap="$bootstrap" \
    -f remove_stale_canton_rss_feeds="$remove_stale" \
    -f cleanup_inactive_surface="$cleanup_inactive_surface" \
    -f source_commit="$CURRENT_MAIN" \
    -f source_main_commit="$CURRENT_MAIN" \
    -f replay_api_after_publish="$child_replay_api_after_publish" \
    -f allow_deferred_live_release="$child_allow_deferred_live_release" \
    -f coordinated_recovery="$child_coordinated_recovery" \
    -f dry_run="$DRY" \
    -f dispatch_nonce="$dispatch_nonce"; then
    dispatched=$((dispatched + 1))
    dispatch_titles+=("$dispatch_title")
    dispatch_sections+=("$section")
    dispatch_baseline_ids+=("$baseline_run_id")
    dispatch_initial_states+=("$initial_run_state")
  else
    echo "::error::recovery staged non accodato per $section sulla HEAD $CURRENT_MAIN"
    failed_sections+=("$section")
  fi
done < <(jq -r '.[] | [.section, ((.ids // []) | tojson), ((.missingPagePaths // []) | tojson), ((.knownMissingPagePaths // []) | tojson), (.bootstrap // false), (.removeStaleCantonRssFeeds // false), (.cleanupInactiveSurface // false)] | @tsv' <<<"$target_matrix")
if (( ${#failed_sections[@]} > 0 )); then
  printf -v failed_sections_csv '%s, ' "${failed_sections[@]}"
  failed_sections_csv="${failed_sections_csv%, }"
  echo "::error::recovery staged non accodato per le sezioni: $failed_sections_csv"
  exit 1
fi
if [ "$dispatched" -eq 0 ]; then
  echo "::error::matrix staged vuoto nel recovery stale"
  exit 1
fi

# The stale dispatcher intentionally returns after GitHub accepts the child
# workflow, not after that child has uploaded its pages.  A mixed matrix must
# therefore have an explicit barrier before the coordinator can replay the
# API: otherwise readiness can observe the old surface and publish a manifest
# while one or more section uploads are still in flight.
replay_child_wait_max_s="${REPLAY_CHILD_WAIT_MAX_S:-21000}"
replay_child_wait_interval_s="${REPLAY_CHILD_WAIT_INTERVAL_S:-15}"
if ! [[ "$replay_child_wait_max_s" =~ ^[0-9]+$ ]] || [ "$replay_child_wait_max_s" -lt 1 ]; then
  echo "::error::REPLAY_CHILD_WAIT_MAX_S non valido: $replay_child_wait_max_s"
  exit 1
fi
if ! [[ "$replay_child_wait_interval_s" =~ ^[0-9]+$ ]] || [ "$replay_child_wait_interval_s" -lt 1 ]; then
  echo "::error::REPLAY_CHILD_WAIT_INTERVAL_S non valido: $replay_child_wait_interval_s"
  exit 1
fi

wait_for_dispatched_children() {
  local deadline=$((SECONDS + replay_child_wait_max_s))
  local runs=''
  local all_success=false
  local pending_sections_csv=''
  local failed_sections_csv=''
  while (( SECONDS < deadline )); do
    if ! runs="$(gh run list --repo "$REPOSITORY" --workflow fast-publish-section.yml --branch main --event workflow_dispatch --limit 100 --json databaseId,displayTitle,status,conclusion)"; then
      echo "::warning::stato dei child staged non leggibile; ritento tra ${replay_child_wait_interval_s}s"
      sleep "$replay_child_wait_interval_s"
      continue
    fi
    if ! jq -e 'type == "array"' <<<"$runs" >/dev/null 2>&1; then
      echo "::warning::gh run list ha restituito uno stato child non valido; ritento tra ${replay_child_wait_interval_s}s"
      sleep "$replay_child_wait_interval_s"
      continue
    fi

    all_success=true
    pending_sections_csv=''
    failed_sections_csv=''
    for dispatch_index in "${!dispatch_titles[@]}"; do
      dispatch_title="${dispatch_titles[$dispatch_index]}"
      section="${dispatch_sections[$dispatch_index]}"
      baseline_run_id="${dispatch_baseline_ids[$dispatch_index]}"
      initial_run_state="${dispatch_initial_states[$dispatch_index]}"
      matching_runs="$(jq -c --arg title "$dispatch_title" '
        [.[] | select(
          ((.displayTitle // "") == $title or ((.displayTitle // "") | startswith($title + " / dry=")))
        )]
        | sort_by(.databaseId | tonumber)
        | if length == 0 then [] else [.[-1]] end
      ' <<<"$runs")"
      latest_run_id="$(jq -r 'if length == 0 then 0 else .[0].databaseId | tonumber end' <<<"$matching_runs")"
      if [ "$initial_run_state" != 'success' ] && (( latest_run_id <= baseline_run_id )); then
        # A previous pending/failed run is still the newest visible item.  The
        # dispatcher either waits for it or has already accepted a retry; in
        # both cases an unseen newer run must be observed before concluding.
        child_state='pending'
      else
        child_state="$(jq -r '
          if length == 0 then "missing"
          elif any(.[]; .status != "completed") then "pending"
          elif any(.[]; .conclusion != "success") then "failed"
          else "success"
          end
        ' <<<"$matching_runs")"
      fi
      case "$child_state" in
        success)
          echo "::notice::child staged completato per $section"
          ;;
        failed)
          all_success=false
          failed_sections_csv+="${section}, "
          ;;
        missing|pending)
          all_success=false
          pending_sections_csv+="${section}, "
          ;;
        *)
          echo "::error::stato child staged inatteso per $section: $child_state"
          return 1
          ;;
      esac
    done
    if [ "$all_success" = true ]; then
      echo "::notice::barriera child staged superata per $dispatched sezioni"
      return 0
    fi
    if [ -n "$failed_sections_csv" ]; then
      failed_sections_csv="${failed_sections_csv%, }"
      echo "::error::child staged fallito per le sezioni: $failed_sections_csv"
      return 1
    fi
    pending_sections_csv="${pending_sections_csv%, }"
    echo "::notice::barriera child staged in attesa per: $pending_sections_csv; ritento tra ${replay_child_wait_interval_s}s"
    sleep "$replay_child_wait_interval_s"
  done
  echo "::error::timeout della barriera child staged dopo ${replay_child_wait_max_s}s"
  return 1
}

wait_for_dispatched_children
