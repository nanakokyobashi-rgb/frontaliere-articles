#!/usr/bin/env bash
set -euo pipefail
runtime_pat="${GITHUB_PAT_NANAKO:-}"
if [ -z "$runtime_pat" ]; then
  echo "::error::GITHUB_PAT_NANAKO assente: impossibile redispatchare il replay stantio"
  exit 1
fi
export GH_TOKEN="$runtime_pat"
child_replay_api_after_publish=false
child_coordinated_recovery=true
replay_before="${ORIGINAL_PUSH_BEFORE:-$STALE_HEAD}"
replay_after=''
if [ -n "$replay_before" ]; then
  # The redispatch checks out CURRENT_MAIN; an old push_after would
  # make release resolution inspect the stale replay range.
  replay_after="$CURRENT_MAIN"
fi
api_release_commit=''
if [ -n "${STALE_HEAD:-}" ]; then
  if ! [[ "$STALE_HEAD" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::head API stantia non valida per il recovery workflow_run"
    exit 1
  fi
  PUSH_BEFORE="${ORIGINAL_PUSH_BEFORE:-}" FETCH_MAIN=true \
    bash scripts/ci/fetch-push-base-if-missing.sh
  fetched_current_main="$(git rev-parse refs/remotes/origin/main)"
  if [ "$fetched_current_main" != "$CURRENT_MAIN" ]; then
    echo "::error::main e' avanzata durante il recupero della release API stantia ($CURRENT_MAIN -> $fetched_current_main)"
    exit 1
  fi
  api_release_commit="$(
    CURRENT_MAIN="$CURRENT_MAIN" STALE_API_RELEASE="$STALE_HEAD" node --input-type=module -e '
      import { resolveStaleReplayApiReleaseCommit } from "./scripts/publish-section-pages.mjs";
      process.stdout.write(resolveStaleReplayApiReleaseCommit(
        process.env.CURRENT_MAIN,
        process.env.STALE_API_RELEASE,
      ));
    '
  )"
  if [ "$api_release_commit" = "$CURRENT_MAIN" ]; then
    echo "::notice::release API stantia non copre la HEAD corrente; il replay ricalcolera' la release senza override"
    api_release_commit=''
  else
    echo "::notice::replay stantio: release API attesa $api_release_commit"
  fi
else
  # Un bounded dispatch deve ripartire senza la release osservata:
  # il publisher ricalcola quella compatibile con la HEAD corrente.
  echo "::notice::replay bounded stantio: ricalcolo la release API sulla HEAD $CURRENT_MAIN"
fi
replay_args=(
  -f section="$SECTION"
  -f article_ids="$ARTICLE_IDS_JSON"
  -f missing_page_paths="$MISSING_PAGE_PATHS_JSON"
  -f known_missing_page_paths="$KNOWN_MISSING_PAGE_PATHS_JSON"
  -f bootstrap="$BOOTSTRAP"
  -f remove_stale_canton_rss_feeds="$REMOVE_STALE_CANTON_RSS_FEEDS"
  -f cleanup_inactive_surface="$CLEANUP_INACTIVE_SURFACE"
  -f replay_api_after_publish="$child_replay_api_after_publish"
  -f allow_deferred_live_release="$ALLOW_DEFERRED_LIVE_RELEASE"
  -f api_release_commit="$api_release_commit"
  -f source_commit="$CURRENT_MAIN"
  -f source_main_commit="$CURRENT_MAIN"
  -f dry_run="$DRY"
  -f push_before="$replay_before"
  -f push_after="$replay_after"
  -f coordinated_recovery="$child_coordinated_recovery"
)
# Normalize identity while keeping the exact source revision in the dispatch.
dispatch_nonce="$(bash .replay-dispatcher-source/scripts/ci/section-source-unaffected.sh \
  --replay-nonce "$CURRENT_MAIN" "$SECTION" "${replay_args[@]}")"
dispatch_cohort="stale-late-${GITHUB_RUN_ID}-${SECTION}-n1"
dispatch_title="cover-publish-section / ${SECTION} / nonce=${dispatch_nonce}"
bash .replay-dispatcher-source/scripts/ci/dispatch-fast-publish-replay.sh "$REPO" "$dispatch_title" --ref main \
  "${replay_args[@]}" -f dispatch_nonce="$dispatch_nonce" -f dispatch_cohort="$dispatch_cohort"
