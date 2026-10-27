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
  plan_before="${ORIGINAL_PUSH_BEFORE:-}"
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

capture_dispatch_snapshot() {
  # The stale dispatcher returns as soon as GitHub accepts a dispatch. Capture
  # the pre-dispatch run frontier so an older successful run with the same
  # nonce cannot satisfy the barrier while the new child is still invisible.
  dispatch_run_snapshot=""
  if ! dispatch_run_snapshot="$(gh run list --repo "$REPOSITORY" --workflow fast-publish-section.yml --branch main --event workflow_dispatch --limit 100 --json databaseId,displayTitle,status,conclusion)"; then
    echo "::error::impossibile leggere lo stato dei child prima del recovery staged"
    return 1
  fi
  if ! jq -e 'type == "array"' <<<"$dispatch_run_snapshot" >/dev/null 2>&1; then
    echo "::error::gh run list ha restituito uno snapshot child non valido prima del recovery staged"
    return 1
  fi
}

dispatch_children_wave() {
  local handoff_section="${1:-}"
  local handoff_title="${2:-}"
  local wave_generation="${3:-0}"
  local handoff_seen=false
  local nonce_seed=''
  local nonce_hash=''
  local dispatch_nonce=''
  local dispatch_title=''
  local baseline_run_id=''
  local initial_run_state=''
  local section=''
  local article_ids=''
  local missing_page_paths=''
  local known_missing_page_paths=''
  local bootstrap=''
  local remove_stale=''
  local cleanup_inactive_surface=''

  dispatched=0
  failed_sections=()
  dispatch_titles=()
  dispatch_sections=()
  dispatch_baseline_ids=()
  dispatch_initial_states=()
  capture_dispatch_snapshot || return 1

  while IFS=$'\t' read -r section article_ids missing_page_paths known_missing_page_paths bootstrap remove_stale cleanup_inactive_surface; do
    [ -n "$section" ] || continue
    if [ -n "$handoff_section" ] && [ "$section" = "$handoff_section" ]; then
      dispatch_title="$handoff_title"
      handoff_seen=true
    else
      nonce_seed="${dispatch_nonce_input:-stale-staged-recovery}"
      if [ "$wave_generation" -gt 0 ]; then
        nonce_seed="${nonce_seed}-wave-${wave_generation}"
      fi
      nonce_hash="$(printf '%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s' \
        "$nonce_seed" "$CURRENT_MAIN" "$section" "$article_ids" "$missing_page_paths" \
        "$known_missing_page_paths" "$bootstrap" "$remove_stale" "$cleanup_inactive_surface" \
        "$child_replay_api_after_publish" "$child_allow_deferred_live_release" \
        "$child_coordinated_recovery" | sha256sum | cut -c1-16)"
      dispatch_nonce="stale-staged-${CURRENT_MAIN:0:12}-${section}-${nonce_hash}"
      dispatch_title="cover-publish-section / ${section} / nonce=${dispatch_nonce}"
    fi
    if [ -n "$handoff_section" ] && [ "$section" = "$handoff_section" ]; then
      case "$dispatch_title" in
        "cover-publish-section / ${section} / nonce="*) ;;
        *)
          echo "::error::handoff title non appartiene alla sezione $section: $dispatch_title"
          return 1
          ;;
      esac
    fi
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
    if [ -n "$handoff_section" ] && [ "$section" = "$handoff_section" ]; then
      echo "::notice::seguo il child stale gia' redispatchato: $dispatch_title"
      dispatched=$((dispatched + 1))
      dispatch_titles+=("$dispatch_title")
      dispatch_sections+=("$section")
      dispatch_baseline_ids+=("$baseline_run_id")
      dispatch_initial_states+=("$initial_run_state")
      continue
    fi
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
  if [ -n "$handoff_section" ] && [ "$handoff_seen" != true ]; then
    echo "::error::il piano corrente non contiene la sezione del handoff stale: $handoff_section"
    return 1
  fi
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

rebuild_recovery_head() {
  local next_head="$1"
  local plan_before=''
  local fetched_current_main=''
  if ! [[ "$next_head" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::HEAD handoff non valida: $next_head"
    return 1
  fi
  if [ "$(git rev-parse --is-shallow-repository)" = 'true' ]; then
    git fetch --no-tags --unshallow origin main
  else
    git fetch --no-tags origin main
  fi
  fetched_current_main="$(git rev-parse refs/remotes/origin/main)"
  if [ "$fetched_current_main" != "$next_head" ]; then
    echo "::error::main e' avanzata durante il rebuild del recovery ($next_head -> $fetched_current_main)"
    return 1
  fi
  git checkout --detach "$next_head"
  CURRENT_MAIN="$next_head"
  export CURRENT_MAIN
  plan_before="${ORIGINAL_PUSH_BEFORE:-}"
  if [ -n "$plan_before" ] && [[ ! "$plan_before" =~ ^0+$ ]]; then
    if ! [[ "$plan_before" =~ ^[a-f0-9]{40}$ ]]; then
      echo "::error::base della push non valida nel rebuild del recovery: $plan_before"
      return 1
    fi
    target_matrix="$(git diff --name-status "$plan_before" "$CURRENT_MAIN" \
      | PUSH_BEFORE="$plan_before" node scripts/ci/fast-publish-section.mjs r2-plan \
      | jq -c 'map(. + {bootstrap: (.bootstrap // false)})')"
  else
    # A manual bounded dispatch carries an explicit scope. Preserve it while
    # moving the exact checkout high-water mark forward.
    target_matrix="$(jq -c 'map(. + {bootstrap: (.bootstrap // false)})' <<<"$target_matrix")"
  fi
  if [ -z "$target_matrix" ] || ! jq -e 'type == "array" and length > 0' <<<"$target_matrix" >/dev/null 2>&1; then
    echo "::error::il piano ricalcolato sulla HEAD handoff è vuoto"
    return 1
  fi
  echo "::notice::recovery ricostruito sulla nuova HEAD corrente $CURRENT_MAIN"
}

dispatch_children_wave

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
stale_handoff_waves=0
max_stale_handoff_waves=3

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
    wave_replaced=false
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
            if [ "$evidence_status" -eq 3 ]; then
              if [ "$stale_handoff_waves" -ge "$max_stale_handoff_waves" ]; then
                echo "::error::troppi handoff stale consecutivi per $section; il recovery non puo' convergere sulla HEAD corrente"
                return 1
              fi
              if [ -z "${VERIFY_STALE_HANDOFF_TITLE:-}" ] || [ -z "${VERIFY_STALE_HANDOFF_HEAD:-}" ]; then
                echo "::error::handoff stale incompleto per $section: title/head assenti"
                return 1
              fi
              stale_handoff_waves=$((stale_handoff_waves + 1))
              echo "::notice::child $section ha consegnato il recovery a ${VERIFY_STALE_HANDOFF_TITLE} sulla HEAD ${VERIFY_STALE_HANDOFF_HEAD}; ricostruisco e sostituisco l'intera wave"
              if ! rebuild_recovery_head "$VERIFY_STALE_HANDOFF_HEAD"; then
                return 1
              fi
              if ! dispatch_children_wave "$section" "$VERIFY_STALE_HANDOFF_TITLE" "$stale_handoff_waves"; then
                return 1
              fi
              wave_replaced=true
              break
            fi
            all_success=false
            if [ "$evidence_status" -eq 1 ]; then
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
    if [ "$wave_replaced" = true ]; then
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
  local handoff_title_nonce=''
  VERIFY_STALE_HANDOFF_TITLE=''
  VERIFY_STALE_HANDOFF_HEAD=''
  VERIFY_STALE_HANDOFF_NONCE=''
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
    VERIFY_STALE_HANDOFF_TITLE="$(jq -r '.stale_handoff_title // empty' "$evidence_file")"
    VERIFY_STALE_HANDOFF_HEAD="$(jq -r '.stale_handoff_head // empty' "$evidence_file")"
    VERIFY_STALE_HANDOFF_NONCE="$(jq -r '.stale_handoff_nonce // empty' "$evidence_file")"
    if ! [[ "$VERIFY_STALE_HANDOFF_HEAD" =~ ^[a-f0-9]{40}$ ]]; then
      rm -rf -- "$evidence_dir"
      echo "::error::artifact publish con handoff stale senza una HEAD valida per $section"
      return 2
    fi
    case "$VERIFY_STALE_HANDOFF_TITLE" in
      "cover-publish-section / ${section} / nonce="*) ;;
      *)
        rm -rf -- "$evidence_dir"
        echo "::error::artifact publish con handoff stale senza un titolo verificabile per $section"
        return 2
        ;;
    esac
    handoff_title_nonce="${VERIFY_STALE_HANDOFF_TITLE#*nonce=}"
    if [ -z "$handoff_title_nonce" ] || [ -z "$VERIFY_STALE_HANDOFF_NONCE" ] || [ "$handoff_title_nonce" != "$VERIFY_STALE_HANDOFF_NONCE" ]; then
      rm -rf -- "$evidence_dir"
      echo "::error::artifact publish con handoff stale con nonce incoerente per $section"
      return 2
    fi
    rm -rf -- "$evidence_dir"
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
