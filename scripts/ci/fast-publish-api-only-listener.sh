#!/usr/bin/env bash
# Dispatch one Fast Publish workflow_dispatch per API-only R2 reconciliation target.
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${REPO:?REPO is required}"
: "${WORKFLOW_RUN_EVENT:?WORKFLOW_RUN_EVENT is required}"
: "${WORKFLOW_RUN_HEAD_SHA:?WORKFLOW_RUN_HEAD_SHA is required}"
: "${WORKFLOW_RUN_DISPLAY_TITLE:?WORKFLOW_RUN_DISPLAY_TITLE is required}"

if ! [[ "$WORKFLOW_RUN_HEAD_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  echo '::error::HEAD API workflow_run non valida'
  exit 1
fi
if ! git cat-file -e "$WORKFLOW_RUN_HEAD_SHA^{commit}" 2>/dev/null; then
  git fetch --quiet --no-tags origin "$WORKFLOW_RUN_HEAD_SHA"
fi
git checkout --detach "$WORKFLOW_RUN_HEAD_SHA" >/dev/null

marked='false'
if WORKFLOW_RUN_DISPLAY_TITLE="$WORKFLOW_RUN_DISPLAY_TITLE" \
  node scripts/ci/resolve-workflow-run-push-range.mjs --fast-publish-range >/dev/null 2>&1; then
  marked='true'
fi
if [ "$WORKFLOW_RUN_EVENT" != 'push' ]; then
  if [ "$marked" = 'true' ]; then
    echo '::notice::Fast Publish listener salta il workflow_dispatch API correlato a un push Fast'
  else
    echo "::notice::Fast Publish listener ignora il workflow API non-push: $WORKFLOW_RUN_EVENT"
  fi
  echo 'dispatch_count=0' >> "$GITHUB_OUTPUT"
  exit 0
fi

is_push='false'
before=''
after="$WORKFLOW_RUN_HEAD_SHA"
fast_push_owner='false'
api_local_targets='[]'
if [ "$WORKFLOW_RUN_EVENT" = 'push' ]; then
  is_push='true'
  range_output="$(
    REPO="$REPO" \
    GH_TOKEN="${GH_TOKEN:-}" \
    WORKFLOW_RUN_HEAD_SHA="$WORKFLOW_RUN_HEAD_SHA" \
    WORKFLOW_RUN_ID="${WORKFLOW_RUN_ID:-}" \
      node scripts/ci/resolve-workflow-run-push-range.mjs
  )"
  while IFS='=' read -r key value; do
    case "$key" in
      before) before="$value" ;;
      after) after="$value" ;;
    esac
  done <<< "$range_output"
  if [ "$after" != "$WORKFLOW_RUN_HEAD_SHA" ]; then
    echo '::error::range push non coincide con la HEAD API'
    exit 1
  fi
  fast_push_owner="$(node scripts/ci/fast-publish-api-only-decision.mjs \
    --fast-push-trigger "$before" "$after" .github/workflows/fast-publish-section.yml)"
  api_local_targets="$(node scripts/ci/fast-publish-section.mjs r2-api-stage-plan-range "$before" "$after")"
fi

reconciliation_targets="$(node scripts/ci/fast-publish-section.mjs r2-reconcile-plan "$WORKFLOW_RUN_HEAD_SHA")"
decision_input="$(jq -cn \
  --argjson isPush "$is_push" \
  --argjson fastPushOwner "$fast_push_owner" \
  --argjson markedFastPublishRange "$marked" \
  --argjson apiLocalTargets "$api_local_targets" \
  --argjson reconciliationTargets "$reconciliation_targets" \
  '{isPush:$isPush,fastPushOwner:$fastPushOwner,markedFastPublishRange:$markedFastPublishRange,apiLocalTargets:$apiLocalTargets,reconciliationTargets:$reconciliationTargets}')"
decision="$(node scripts/ci/fast-publish-api-only-decision.mjs <<<"$decision_input")"
targets="$(jq -c '.targets' <<<"$decision")"
reason="$(jq -r '.reason' <<<"$decision")"
if [ "$(jq -r '.skip' <<<"$decision")" = 'true' ]; then
  echo "::notice::Fast Publish listener salta il range $WORKFLOW_RUN_HEAD_SHA: $reason"
  echo 'dispatch_count=0' >> "$GITHUB_OUTPUT"
  exit 0
fi

runtime_pat="${GITHUB_PAT_NANAKO:-}"
if [ -z "$runtime_pat" ]; then
  echo '::error::GITHUB_PAT_NANAKO non caricato da Remote Config'
  exit 1
fi
export GH_TOKEN="$runtime_pat"
count="$(jq 'length' <<<"$targets")"
if [ "$count" = '0' ]; then
  echo '::notice::nessun target cantonale richiede riconciliazione API-only'
  echo 'dispatch_count=0' >> "$GITHUB_OUTPUT"
  exit 0
fi
cohort="api-only-${GITHUB_RUN_ID}-n${count}"
while IFS= read -r target; do
  section="$(jq -r '.section' <<<"$target")"
  ids="$(jq -c '.ids // []' <<<"$target")"
  missing="$(jq -c '.missingPagePaths // []' <<<"$target")"
  known_missing="$(jq -c '.knownMissingPagePaths // []' <<<"$target")"
  bootstrap="$(jq -r '.bootstrap // false' <<<"$target")"
  remove_stale="$(jq -r '.removeStaleCantonRssFeeds // false' <<<"$target")"
  cleanup="$(jq -r '.cleanupInactiveSurface // false' <<<"$target")"
  nonce="api-only-${GITHUB_RUN_ID}-${section}"
  gh workflow run fast-publish-section.yml --repo "$REPO" --ref main \
    -f "section=$section" \
    -f "article_ids=$ids" \
    -f "missing_page_paths=$missing" \
    -f "known_missing_page_paths=$known_missing" \
    -f "bootstrap=$bootstrap" \
    -f "remove_stale_canton_rss_feeds=$remove_stale" \
    -f "cleanup_inactive_surface=$cleanup" \
    -f 'dry_run=false' \
    -f 'replay_api_after_publish=false' \
    -f 'coordinated_recovery=false' \
    -f "api_release_commit=$WORKFLOW_RUN_HEAD_SHA" \
    -f "dispatch_nonce=$nonce" \
    -f "dispatch_cohort=$cohort"
done < <(jq -c '.[]' <<<"$targets")
echo "dispatch_count=$count" >> "$GITHUB_OUTPUT"
echo "::notice::dispatchate $count sezioni API-only sulla release $WORKFLOW_RUN_HEAD_SHA"
