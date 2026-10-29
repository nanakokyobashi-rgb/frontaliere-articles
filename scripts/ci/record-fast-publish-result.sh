#!/usr/bin/env bash
set -euo pipefail

result_file="$RUNNER_TEMP/fast-publish-result.json"
jq -cn \
  --arg section "$SECTION" \
  --arg rendered_head "${RENDERED_HEAD:-}" \
  --arg stale_handoff "${STALE_HANDOFF:-}" \
  --arg stale_handoff_head "${STALE_HANDOFF_HEAD:-}" \
  --arg stale_handoff_nonce "${STALE_HANDOFF_NONCE:-}" \
  --arg stale_handoff_title "${STALE_HANDOFF_TITLE:-}" \
  --arg fresh "${FRESH:-}" \
  --arg dispatch_nonce "${DISPATCH_NONCE:-}" \
  --arg dispatch_cohort "${DISPATCH_COHORT:-}" \
  --arg coordinated_recovery "${COORDINATED_RECOVERY:-false}" \
  --arg source_commit "${SOURCE_COMMIT:-}" \
  --arg source_main_commit "${SOURCE_MAIN_COMMIT:-}" \
  '{section: $section, rendered_head: $rendered_head, stale_handoff: $stale_handoff, stale_handoff_head: $stale_handoff_head, stale_handoff_nonce: $stale_handoff_nonce, stale_handoff_title: $stale_handoff_title, fresh: $fresh, dispatch_nonce: $dispatch_nonce, dispatch_cohort: $dispatch_cohort, coordinated_recovery: $coordinated_recovery, source_commit: $source_commit, source_main_commit: $source_main_commit}' \
  > "$result_file"
