#!/usr/bin/env bash
# Fetch a push base only when the checkout does not already contain it.
#
# The resolve jobs use actions/checkout with fetch-depth: 2, which already
# includes the direct parent of an ordinary push. An unconditional second
# fetch made every publisher pay for another network process and could leave
# the runner stuck in orphan-process cleanup until the five-minute job cap.
set -euo pipefail

if [ -z "${PUSH_BEFORE:-}" ] || [[ "$PUSH_BEFORE" =~ ^0+$ ]]; then
  exit 0
fi

if git cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null; then
  echo "::notice::push base already present in the checkout: $PUSH_BEFORE"
  exit 0
fi

git fetch --no-tags --depth=1 origin "$PUSH_BEFORE"
