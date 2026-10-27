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
child_replay_api_after_publish="${REPLAY_API_AFTER_PUBLISH:-false}"
if [ "${MIXED_MATRIX:-false}" = 'true' ]; then
  # The coordinator waits for every section child and dispatches publish-api
  # once afterwards. Letting every child arm it would fan out identical API
  # publishes for a mixed matrix.
  child_replay_api_after_publish=false
fi
while IFS=$'\t' read -r section article_ids missing_page_paths known_missing_page_paths bootstrap remove_stale cleanup_inactive_surface; do
  [ -n "$section" ] || continue
  nonce_seed="${dispatch_nonce_input:-stale-staged-recovery}"
  nonce_hash="$(printf '%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s' \
    "$nonce_seed" "$CURRENT_MAIN" "$section" "$article_ids" "$missing_page_paths" \
    "$known_missing_page_paths" "$bootstrap" "$remove_stale" "$cleanup_inactive_surface" \
    "$child_replay_api_after_publish" | sha256sum | cut -c1-16)"
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
    -f allow_deferred_live_release="$ALLOW_DEFERRED_LIVE_RELEASE" \
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
  exit 1
fi
if [ "$dispatched" -eq 0 ]; then
  echo "::error::matrix staged vuoto nel recovery stale"
  exit 1
fi
