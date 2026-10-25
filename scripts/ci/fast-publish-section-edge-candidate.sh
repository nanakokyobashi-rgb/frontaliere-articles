#!/usr/bin/env bash
# Restituisce una release edge intermedia sicura per un replay stale.
set -euo pipefail

source_dir="${1:-}"
expected_commit="${2:-}"
current_commit="${3:-}"
budget_seconds="${4:-0}"
max_attempt_seconds=30

if [ -z "$source_dir" ] || ! [[ "$expected_commit" =~ ^[a-f0-9]{7,40}$ ]] || ! [[ "$current_commit" =~ ^[a-f0-9]{40}$ ]] || ! [[ "$budget_seconds" =~ ^[0-9]+$ ]]; then
  exit 1
fi
if [ "$budget_seconds" -gt "$max_attempt_seconds" ]; then
  budget_seconds="$max_attempt_seconds"
fi
if [ "$budget_seconds" -le 0 ] || ! command -v timeout >/dev/null 2>&1; then
  exit 1
fi

started_at="$(date +%s)"
remaining_budget() {
  local now elapsed remaining
  now="$(date +%s)"
  elapsed=$((now - started_at))
  remaining=$((budget_seconds - elapsed))
  if [ "$remaining" -le 0 ]; then
    return 1
  fi
  printf '%s' "$remaining"
}

edge_commit="$(
  remaining="$(remaining_budget)" || exit 1
  cd "$source_dir" || exit 1
  timeout --signal=TERM --kill-after=1s "${remaining}s" \
    node scripts/ci/fast-publish-section.mjs r2-edge-release-commit
)"
if ! [[ "$edge_commit" =~ ^[a-f0-9]{7,40}$ ]]; then
  exit 1
fi
[ "$edge_commit" != "$expected_commit" ] || exit 1
[ "$edge_commit" != "$current_commit" ] || exit 1

resolved_edge="$(git rev-parse "${edge_commit}^{commit}" 2>/dev/null || true)"
if [ -z "$resolved_edge" ]; then
  fetch_budget="$(remaining_budget)" || exit 1
  timeout --signal=TERM --kill-after=1s "${fetch_budget}s" \
    git fetch --no-tags --depth=1 origin "$edge_commit" >/dev/null 2>&1 || exit 1
  resolved_edge="$(git rev-parse "${edge_commit}^{commit}" 2>/dev/null || true)"
fi
[ -n "$resolved_edge" ] || exit 1
git merge-base --is-ancestor "$resolved_edge" "$current_commit"
git diff --quiet "$resolved_edge" "$current_commit" -- sections/registry.json
echo "::notice::registro edge intermedio $edge_commit coerente con main $current_commit; uso la release pubblicata" >&2
plan_budget="$(remaining_budget)" || exit 1
(
  cd "$source_dir" || exit 1
  timeout --signal=TERM --kill-after=1s "${plan_budget}s" \
    node scripts/ci/fast-publish-section.mjs r2-reconcile-plan "$edge_commit"
) | jq -c 'map(. + {bootstrap: (.bootstrap // false)})'
