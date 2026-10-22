#!/usr/bin/env bash
# Fetch a push base only when the checkout does not already contain it.
#
# Resolve jobs use a full-history checkout for corpus high-water checks. Keep a
# guarded fallback for other callers, older queued checkouts, or non-linear
# histories where the requested base is not present.
set -euo pipefail

if [ -z "${PUSH_BEFORE:-}" ] || [[ "$PUSH_BEFORE" =~ ^0+$ ]]; then
  exit 0
fi

if git cat-file -e "${PUSH_BEFORE}^{commit}" 2>/dev/null; then
  echo "::notice::push base already present in the checkout: $PUSH_BEFORE"
  exit 0
fi

git fetch --no-tags --depth=1 origin "$PUSH_BEFORE"
