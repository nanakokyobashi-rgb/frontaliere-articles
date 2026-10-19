#!/usr/bin/env bash

# This file is sourced by fast-publish-article.yml. Keep the apex verifier out
# of the workflow's `run` scalar: GitHub rejects a single run command above
# 21,000 characters before it creates a job.

# The first purge ran before this step. Check the canonical apex URL against
# the bytes recorded after the push; a 200 with old HTML is not proof that the
# edge is fresh. A cache mismatch is classified as lag only when the canonical
# response was a cache HIT and a second cache-busted request to the same URL
# serves the expected hash. A route/fallback response, operational failure, or
# edge-blocked probe remains fail-closed.
# Edge-blocked probes also skip the post-verification backstop purge below
# because the transport result is not evidence of stale cache.
apex_verify_log="$RUNNER_TEMP/fast-publish-apex-verification.log"
apex_verify_attempt=0
verify_apex() {
  local verify_rc
  apex_verify_attempt=$((apex_verify_attempt + 1))
  : > "$apex_verify_log"
  set +e
  node scripts/ci/verify-served-fingerprint.mjs verify-apex \
    --fingerprints "$RUNNER_TEMP/published-fingerprints.tsv" \
    --run-key "${GITHUB_RUN_ID:-local}.${GITHUB_RUN_ATTEMPT:-1}.${shard}.${apex_verify_attempt}" \
    > "$apex_verify_log" 2>&1
  verify_rc=$?
  set -e
  cat "$apex_verify_log"
  return "$verify_rc"
}

handle_apex_failure() {
  node scripts/ci/verify-served-fingerprint.mjs handle-apex-failure \
    --log "$apex_verify_log" --phase "$1" --verify-exit-code "$2" \
    --github-output "$GITHUB_OUTPUT"
}

if verify_apex; then
  :
else
  verify_rc=$?
  if handle_apex_failure "before retry" "$verify_rc"; then
    :
  else
    apex_failure_rc=$?
    exit "$apex_failure_rc"
  fi
  echo "::warning::the apex served content different from the pushed fingerprints — repeating the targeted purge once"
  bash scripts/ci/retry-cmd.sh node scripts/cf-purge-cache.mjs \
    "--files-from=$RUNNER_TEMP/edge-purge-urls.txt"
  if verify_apex; then
    :
  else
    verify_rc=$?
    if handle_apex_failure "after retry" "$verify_rc"; then
      :
    else
      apex_failure_rc=$?
      exit "$apex_failure_rc"
    fi
    echo "::warning::the apex still served content different from the pushed fingerprints after the retry — continuing with the origin hard gate"
  fi
fi
