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
requested_target_matrix="$TARGET_MATRIX"
plan_before="${ORIGINAL_PUSH_BEFORE:-}"
if [ "${MIXED_MATRIX:-false}" = 'true' ]; then
  if [ "$(git rev-parse --is-shallow-repository)" = 'true' ]; then
    git fetch --no-tags --unshallow origin main
  else
    git fetch --no-tags origin main
  fi
  fetched_current_main="$(git rev-parse refs/remotes/origin/main)"
  if [ "$fetched_current_main" != "$CURRENT_MAIN" ]; then
    echo "::error::main e' avanzata durante la preparazione del piano mixed-matrix ($CURRENT_MAIN -> $fetched_current_main); annullo il recovery"
    exit 1
  fi
  git checkout --detach "$CURRENT_MAIN"
  if [ -z "$plan_before" ] || [[ "$plan_before" =~ ^0+$ ]]; then
    # A manual workflow_dispatch carries an explicit section/article scope but
    # no push range. Never replace that request with CURRENT_MAIN^: doing so
    # can silently broaden or empty the recovery matrix.
    target_matrix="$(jq -c 'map(. + {bootstrap: (.bootstrap // false)})' <<<"$target_matrix")"
    echo "::notice::recovery mixed senza base push: conservo lo scope esplicito del workflow_dispatch"
  else
    # Una matrice mista non può riusare il piano risolto prima che main
    # avanzasse: ricostruisci il piano dalla revisione corrente e dalla base
    # della push originaria prima di redispatchare.
    if ! [[ "$plan_before" =~ ^[a-f0-9]{40}$ ]]; then
      echo "::error::base della push non valida per il piano mixed-matrix: $plan_before"
      exit 1
    fi
    target_matrix="$(git diff --name-status "$plan_before" "$CURRENT_MAIN" \
      | PUSH_BEFORE="$plan_before" node scripts/ci/fast-publish-section.mjs r2-plan \
      | jq -c 'map(. + {bootstrap: (.bootstrap // false)})')"
  fi
  if [ -z "$target_matrix" ] || [ "$target_matrix" = '[]' ]; then
    echo "::error::il piano ricalcolato sulla HEAD corrente è vuoto"
    exit 1
  fi
  echo "::notice::piano mixed-matrix ricalcolato sulla HEAD $CURRENT_MAIN dalla base $plan_before"
fi
if ! [[ "$target_matrix" =~ ^\[.*\]$ ]] || ! jq -e 'type == "array" and length > 0' <<<"$target_matrix" >/dev/null 2>&1; then
  echo "::error::piano target non valido o vuoto nel recovery staged"
  exit 1
fi
if ! verified_current_main="$(bash scripts/ci/read-main-head.sh)"; then
  echo "::error::impossibile rileggere main prima del dispatch dei child staged"
  exit 1
fi
if [ "$verified_current_main" != "$CURRENT_MAIN" ]; then
  echo "::error::main e' avanzata dopo la costruzione del piano staged ($CURRENT_MAIN -> $verified_current_main); annullo il recovery"
  exit 1
fi
dispatch_nonce_input="${DISPATCH_NONCE:-}"
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
validate_target_matrix() {
  if ! [[ "$target_matrix" =~ ^\[.*\]$ ]] || ! jq -e 'type == "array" and length > 0' <<<"$target_matrix" >/dev/null 2>&1; then
    echo "::error::piano target non valido o vuoto nel recovery staged"
    return 1
  fi
}

# The stale dispatcher returns as soon as GitHub accepts a dispatch. Capture
# the pre-dispatch run frontier so an older successful run with the same nonce
# cannot satisfy the barrier while the new child is still invisible to the API.
dispatch_children() {
  local dispatch_run_snapshot=''
  if ! dispatch_run_snapshot="$(gh run list --repo "$REPOSITORY" --workflow fast-publish-section.yml --branch main --event workflow_dispatch --limit 100 --json databaseId,displayTitle,status,conclusion)"; then
    echo "::error::impossibile leggere lo stato dei child prima del recovery staged"
    return 1
  fi
  if ! jq -e 'type == "array"' <<<"$dispatch_run_snapshot" >/dev/null 2>&1; then
    echo "::error::gh run list ha restituito uno snapshot child non valido prima del recovery staged"
    return 1
  fi

  dispatched=0
  failed_sections=()
  dispatch_titles=()
  dispatch_sections=()
  dispatch_baseline_ids=()
  dispatch_initial_states=()
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
    return 1
  fi
  if [ "$dispatched" -eq 0 ]; then
    echo "::error::matrix staged vuoto nel recovery stale"
    return 1
  fi
}

rebuild_recovery_for_head() {
  local next_head="$1"
  local fetched_current_main=''
  if ! [[ "$next_head" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::HEAD di handoff non valida per il recovery staged: $next_head"
    return 1
  fi
  if [ "$(git rev-parse --is-shallow-repository)" = 'true' ]; then
    git fetch --no-tags --unshallow origin main
  else
    git fetch --no-tags origin main
  fi
  fetched_current_main="$(git rev-parse refs/remotes/origin/main)"
  if [ "$fetched_current_main" != "$next_head" ]; then
    echo "::error::main e' avanzata durante la ricostruzione del recovery ($next_head -> $fetched_current_main)"
    return 1
  fi
  git checkout --detach "$next_head"
  if [ "${MIXED_MATRIX:-false}" = 'true' ]; then
    if [ -z "$plan_before" ] || [[ "$plan_before" =~ ^0+$ ]]; then
      target_matrix="$(jq -c 'map(. + {bootstrap: (.bootstrap // false)})' <<<"$requested_target_matrix")"
    else
      if ! [[ "$plan_before" =~ ^[a-f0-9]{40}$ ]]; then
        echo "::error::base della push non valida per il piano di recovery: $plan_before"
        return 1
      fi
      target_matrix="$(git diff --name-status "$plan_before" "$next_head" \
        | PUSH_BEFORE="$plan_before" node scripts/ci/fast-publish-section.mjs r2-plan \
        | jq -c 'map(. + {bootstrap: (.bootstrap // false)})')"
    fi
  else
    target_matrix="$(jq -c 'map(. + {bootstrap: (.bootstrap // false)})' <<<"$requested_target_matrix")"
  fi
  CURRENT_MAIN="$next_head"
  validate_target_matrix
  dispatch_children
}

validate_target_matrix
dispatch_children

# The stale dispatcher intentionally returns after GitHub accepts the child
# workflow, not after that child has uploaded its pages.  A mixed matrix must
# therefore have an explicit barrier before the coordinator can replay the
# API: otherwise readiness can observe the old surface and publish a manifest
# while one or more section uploads are still in flight.
# The coordinator job has a 360-minute timeout. Keep an explicit 60-minute
# reserve for checkout, readiness probes and the final publish-api dispatch;
# callers may lower/raise the child budget only with an explicit override.
replay_coordinator_timeout_s="${REPLAY_COORDINATOR_TIMEOUT_S:-21600}"
replay_coordinator_reserve_s="${REPLAY_COORDINATOR_RESERVE_S:-3600}"
if ! [[ "$replay_coordinator_timeout_s" =~ ^[0-9]+$ ]] || [ "$replay_coordinator_timeout_s" -lt 1 ]; then
  echo "::error::REPLAY_COORDINATOR_TIMEOUT_S non valido: $replay_coordinator_timeout_s"
  exit 1
fi
if ! [[ "$replay_coordinator_reserve_s" =~ ^[0-9]+$ ]] || [ "$replay_coordinator_reserve_s" -lt 1 ]; then
  echo "::error::REPLAY_COORDINATOR_RESERVE_S non valido: $replay_coordinator_reserve_s"
  exit 1
fi
if [ -n "${REPLAY_CHILD_WAIT_MAX_S:-}" ]; then
  replay_child_wait_max_s="$REPLAY_CHILD_WAIT_MAX_S"
else
  replay_child_wait_max_s=$((replay_coordinator_timeout_s - replay_coordinator_reserve_s))
fi
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
  local live_main=''
  local all_success=false
  local restarted=false
  local pending_sections_csv=''
  local failed_sections_csv=''
  while (( SECONDS < deadline )); do
    if ! live_main="$(bash scripts/ci/read-main-head.sh)"; then
      echo "::warning::HEAD corrente di main non leggibile durante la barriera; ritento tra ${replay_child_wait_interval_s}s"
      sleep "$replay_child_wait_interval_s"
      continue
    fi
    if [ "$live_main" != "$CURRENT_MAIN" ]; then
      echo "::notice::main e' avanzata durante la barriera ($CURRENT_MAIN -> $live_main); ricostruisco e attendo i child sulla nuova HEAD"
      if ! rebuild_recovery_for_head "$live_main"; then
        return 1
      fi
      continue
    fi
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
    restarted=false
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
      if (( latest_run_id <= baseline_run_id )) && [ "$initial_run_state" != 'success' ]; then
        # A previous pending/failed run is still the newest visible item.  The
        # dispatcher either waits for it or has already accepted a retry; in
        # both cases an unseen newer run must be observed before concluding.
        baseline_state="$(jq -r '
          if length == 0 then "missing"
          elif .[0].status != "completed" then "pending"
          elif .[0].conclusion == "success" then "success"
          else "failed"
          end
        ' <<<"$matching_runs")"
        if [ "$initial_run_state" = 'pending' ] && [ "$baseline_state" = 'success' ]; then
          # The dispatcher legitimately reused the pending run; its success
          # is the accepted child, even though no newer run was created.
          child_state='success'
        else
          child_state='pending'
        fi
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
          if [ "${DRY:-false}" = 'true' ]; then
            echo "::notice::child staged dry-run completato per $section"
          elif verify_child_publish_evidence "$latest_run_id" "$section"; then
            echo "::notice::child staged produttivo verificato per $section"
          else
            evidence_status=$?
            all_success=false
            if [ "$evidence_status" -eq 3 ]; then
              if [ "$evidence_handoff_head" = "$CURRENT_MAIN" ]; then
                echo "::error::handoff stale del child non ha cambiato HEAD: $evidence_handoff_head"
                return 1
              fi
              if ! live_main="$(bash scripts/ci/read-main-head.sh)"; then
                echo "::error::impossibile verificare la HEAD del handoff stale"
                return 1
              fi
              if [ "$live_main" != "$evidence_handoff_head" ]; then
                echo "::error::handoff stale non coincide con la HEAD corrente ($evidence_handoff_head -> $live_main)"
                return 1
              fi
              if ! rebuild_recovery_for_head "$live_main"; then
                return 1
              fi
              restarted=true
              break
            elif [ "$evidence_status" -eq 1 ]; then
              pending_sections_csv+="${section}, "
            else
              failed_sections_csv+="${section}, "
            fi
          fi
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
    if [ "$restarted" = true ]; then
      continue
    fi
    if ! live_main="$(bash scripts/ci/read-main-head.sh)"; then
      echo "::error::impossibile confermare la HEAD corrente prima di superare la barriera"
      return 1
    fi
    if [ "$live_main" != "$CURRENT_MAIN" ]; then
      echo "::notice::main e' avanzata mentre verificavo i child ($CURRENT_MAIN -> $live_main); ricostruisco il recovery"
      if ! rebuild_recovery_for_head "$live_main"; then
        return 1
      fi
      continue
    fi
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

verify_child_publish_evidence() {
  local run_id="$1"
  local section="$2"
  local evidence_dir=''
  local evidence_file=''
  local handoff_head=''
  evidence_handoff_head=''
  if ! evidence_dir="$(mktemp -d "$RUNNER_TEMP/fast-publish-child-evidence.XXXXXX")"; then
    echo "::warning::impossibile creare la directory dell evidence per $section"
    return 1
  fi
  if ! gh run download "$run_id" --repo "$REPOSITORY" --name "fast-publish-result-$section" --dir "$evidence_dir" >/dev/null 2>&1; then
    rm -rf -- "$evidence_dir"
    echo "::warning::artifact publish non ancora leggibile per $section (run $run_id)"
    return 1
  fi
  evidence_file="$(find "$evidence_dir" -type f -name fast-publish-result.json -print -quit)"
  if [ -z "$evidence_file" ] || [ ! -s "$evidence_file" ]; then
    rm -rf -- "$evidence_dir"
    echo "::warning::artifact publish assente per $section (run $run_id)"
    return 1
  fi
  if jq -e --arg section "$section" '.section == $section and .stale_handoff == "true"' "$evidence_file" >/dev/null 2>&1; then
    handoff_head="$(jq -r '.stale_handoff_head // empty' "$evidence_file")"
    rm -rf -- "$evidence_dir"
    if ! [[ "$handoff_head" =~ ^[a-f0-9]{40}$ ]]; then
      echo "::error::artifact stale del child senza una HEAD di handoff valida per $section"
      return 2
    fi
    evidence_handoff_head="$handoff_head"
    echo "::notice::artifact stale del child consegna $section al coordinator sulla HEAD $handoff_head"
    return 3
  fi
  if ! jq -e --arg section "$section" --arg expected_head "$CURRENT_MAIN" '
    .section == $section and
    (.stale_handoff // "false") != "true" and
    .fresh == "true" and
    .rendered_head == $expected_head
  ' "$evidence_file" >/dev/null 2>&1; then
    rm -rf -- "$evidence_dir"
    echo "::error::artifact publish non produttivo per $section: rendered_head/fresh/stale_handoff non certificano $CURRENT_MAIN"
    return 2
  fi
  rm -rf -- "$evidence_dir"
  return 0
}

wait_for_dispatched_children
