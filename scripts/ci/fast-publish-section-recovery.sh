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
preserve_explicit_scope="${PRESERVE_EXPLICIT_SCOPE:-false}"

ensure_recovery_history() {
  local recovery_base="${ORIGINAL_PUSH_BEFORE:-}"
  if [ -n "$recovery_base" ] && ! [[ "$recovery_base" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::base della push non valida prima del recovery storico: $recovery_base"
    return 1
  fi
  if [ ! -f scripts/ci/fetch-push-base-if-missing.sh ]; then
    echo "::error::guard condiviso della storia Git non presente nel recovery"
    return 1
  fi
  if ! PUSH_BEFORE="$recovery_base" FETCH_MAIN=true \
    bash scripts/ci/fetch-push-base-if-missing.sh; then
    echo "::error::storia Git non verificabile prima del recovery staged"
    return 1
  fi
}

validate_recovery_base_ancestry() {
  local recovery_base="${ORIGINAL_PUSH_BEFORE:-}"
  local ancestry_status=0
  if [ -z "$recovery_base" ] || [[ "$recovery_base" =~ ^0+$ ]]; then
    # A bounded workflow_dispatch may intentionally carry an explicit matrix
    # without a push range. There is no ancestry claim to validate in that path.
    return 0
  fi
  if ! [[ "$recovery_base" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::base della push non valida per la verifica di ancestry: $recovery_base"
    return 1
  fi
  git merge-base --is-ancestor "$recovery_base" "$CURRENT_MAIN" || ancestry_status=$?
  case "$ancestry_status" in
    0)
      return 0
      ;;
    1)
      echo "::error::base della push non antenata di CURRENT_MAIN: force-push o storia non lineare; annullo il recovery"
      return 1
      ;;
    *)
      echo "::error::impossibile verificare l'ancestry della base della push (git merge-base status $ancestry_status)"
      return 1
      ;;
  esac
}

merge_recovery_matrices() {
  local existing="$1"
  local delta="$2"
  jq -cn --argjson existing "$existing" --argjson delta "$delta" '
    def truthy($value): ($value // false) == true;
    def merge_entry($left; $right):
      {
        section: $left.section,
        bootstrap: (truthy($left.bootstrap) or truthy($right.bootstrap)),
        ids: (
          if truthy($left.bootstrap) or truthy($right.bootstrap)
          then []
          else (($left.ids // []) + ($right.ids // []) | unique | sort)
          end
        ),
        missingPagePaths: (($left.missingPagePaths // []) + ($right.missingPagePaths // []) | unique | sort),
        knownMissingPagePaths: (($left.knownMissingPagePaths // []) + ($right.knownMissingPagePaths // []) | unique | sort)
      }
      + (if truthy($left.removeStaleCantonRssFeeds) or truthy($right.removeStaleCantonRssFeeds)
         then {removeStaleCantonRssFeeds: true} else {} end)
      + (if truthy($left.cleanupInactiveSurface) or truthy($right.cleanupInactiveSurface)
         then {cleanupInactiveSurface: true} else {} end);
    reduce ($existing + $delta)[] as $entry ({};
      .[$entry.section] = merge_entry((.[$entry.section] // {section: $entry.section}); $entry)
    )
    | to_entries
    | sort_by(.key)
    | map(.value)
  '
}

if [ "${MIXED_MATRIX:-false}" != 'true' ] && [ "$preserve_explicit_scope" != 'true' ]; then
  # La detection puo' avere calcolato la matrice sulla HEAD A e il job di
  # recovery puo' osservare la HEAD B. In quel caso la matrice ricevuta non
  # contiene gli articoli, le sezioni o i path introdotti da A -> B: ricostruisci
  # il delta sulla HEAD che verra' passata ai child e uniscilo al piano gia'
  # osservato. Lo scope esplicito di un workflow_dispatch manuale e' l'unica
  # eccezione: il proprietario ha chiesto precisamente quella sezione.
  if ! ensure_recovery_history; then
    exit 1
  fi
  if ! validate_recovery_base_ancestry; then
    exit 1
  fi
  fetched_current_main="$(git rev-parse refs/remotes/origin/main)"
  if [ "$fetched_current_main" != "$CURRENT_MAIN" ]; then
    echo "::error::main e' avanzata durante la ricostruzione del piano stale ($CURRENT_MAIN -> $fetched_current_main); annullo il recovery"
    exit 1
  fi
  git checkout --detach "$CURRENT_MAIN"
  plan_before="${ORIGINAL_PUSH_BEFORE:-}"
  if [ -z "$plan_before" ] || [[ "$plan_before" =~ ^0+$ ]]; then
    if ! plan_before="$(git rev-parse "${CURRENT_MAIN}^" 2>/dev/null)"; then
      echo "::error::base precedente non disponibile per ricostruire il piano stale sulla HEAD $CURRENT_MAIN"
      exit 1
    fi
  fi
  if ! [[ "$plan_before" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::base precedente non valida per ricostruire il piano stale: $plan_before"
    exit 1
  fi
  delta_matrix="$(git diff --name-status "$plan_before" "$CURRENT_MAIN" \
    | PUSH_BEFORE="$plan_before" node scripts/ci/fast-publish-section.mjs r2-plan \
    | jq -c 'map(. + {bootstrap: (.bootstrap // false)})')"
  target_matrix="$(merge_recovery_matrices "$target_matrix" "$delta_matrix")"
  echo "::notice::piano stale ricostruito sulla HEAD $CURRENT_MAIN dalla base $plan_before"
elif [ "${MIXED_MATRIX:-false}" = 'true' ]; then
  if ! ensure_recovery_history; then
    exit 1
  fi
  if ! validate_recovery_base_ancestry; then
    exit 1
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
dispatch_cohort_size="$(jq 'length' <<<"$target_matrix")"
if ! [[ "$dispatch_cohort_size" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::dimensione coorte staged non valida: $dispatch_cohort_size"
  exit 1
fi
dispatch_cohort="stale-staged-${GITHUB_RUN_ID}-n${dispatch_cohort_size}"
# Ogni child di questa coorte e' coordinato dal reconcile event-driven: il
# replay API locale resta spento anche quando il parent lo aveva ereditato.
child_replay_api_after_publish=false
child_allow_deferred_live_release="${ALLOW_DEFERRED_LIVE_RELEASE:-false}"
child_coordinated_recovery=true
if [ "${MIXED_MATRIX:-false}" = 'true' ]; then
  # Mixed recovery children must not arm publish-api individually. Their
  # successful workflow_run events reopen reconcile-section-pages, which owns
  # the single readiness check and API replay for the complete surface.
  child_allow_deferred_live_release=true
fi

dispatch_children_wave() {
  local nonce_seed=''
  local nonce_hash=''
  local dispatch_nonce=''
  local dispatch_title=''
  local section=''
  local article_ids=''
  local missing_page_paths=''
  local known_missing_page_paths=''
  local bootstrap=''
  local remove_stale=''
  local cleanup_inactive_surface=''

  dispatched=0
  failed_sections=()

  while IFS=$'\t' read -r section article_ids missing_page_paths known_missing_page_paths bootstrap remove_stale cleanup_inactive_surface; do
    [ -n "$section" ] || continue
    nonce_seed="${dispatch_nonce_input:-stale-staged-recovery}"
    nonce_hash="$(printf '%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s' \
      "$nonce_seed" "$CURRENT_MAIN" "$section" "$article_ids" "$missing_page_paths" \
      "$known_missing_page_paths" "$bootstrap" "$remove_stale" "$cleanup_inactive_surface" \
      "$child_replay_api_after_publish" "$child_allow_deferred_live_release" \
      "$child_coordinated_recovery" | sha256sum | cut -c1-16)"
    dispatch_nonce="stale-staged-${CURRENT_MAIN:0:12}-${section}-${nonce_hash}"
    dispatch_title="cover-publish-section / ${section} / nonce=${dispatch_nonce}"
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
      -f dispatch_cohort="$dispatch_cohort" \
      -f dry_run="$DRY" \
      -f dispatch_nonce="$dispatch_nonce"; then
      dispatched=$((dispatched + 1))
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

dispatch_children_wave

# The recovery is a dispatcher, not a coordinator. Child completion events
# reopen reconcile-section-pages, which verifies the whole R2 surface and
# owns the single API replay. Holding this runner for a child barrier caused
# queued section publishers to starve the very children being awaited.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'recovery_head=%s\n' "$CURRENT_MAIN" >> "$GITHUB_OUTPUT"
  printf 'recovery_cohort=%s\n' "$dispatch_cohort" >> "$GITHUB_OUTPUT"
  printf 'recovery_cohort_size=%s\n' "$dispatch_cohort_size" >> "$GITHUB_OUTPUT"
fi
echo "::notice::recovery staged accodato sulla HEAD $CURRENT_MAIN; la readiness verra' verificata dal reconcile event-driven"
exit 0
