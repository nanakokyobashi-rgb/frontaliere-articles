#!/usr/bin/env bash
# Resolve the exact remote main head without spending the GitHub REST quota.
#
# The fast publishers use this value only as a freshness guard. Git transport
# is the right read path here: the REST installation bucket is shared by the
# repository's workflows, while `git ls-remote` reads the same ref without
# consuming that API quota. An unreadable ref remains fail-closed.
set -euo pipefail

remote="${1:-origin}"
ref="${2:-refs/heads/main}"
if [ "$#" -gt 2 ]; then
  echo "usage: $0 [remote] [ref]" >&2
  exit 2
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "::error::timeout command unavailable; cannot resolve $ref via git transport" >&2
  exit 1
fi

main_head=''
for attempt in 1 2 3; do
  ls_remote_out=''
  if ls_remote_out="$(timeout 60 git ls-remote --refs "$remote" "$ref" 2>/dev/null)"; then
    main_head="$(printf '%s\n' "$ls_remote_out" | awk -v wanted="$ref" '$2 == wanted { print $1; exit }')"
  fi
  if [[ "$main_head" =~ ^[a-f0-9]{40}$ ]]; then
    printf '%s\n' "$main_head"
    exit 0
  fi
  main_head=''
  if [ "$attempt" -lt 3 ]; then
    echo "::warning::punta di $ref non risolvibile via git ls-remote (tentativo ${attempt}/3); ritento" >&2
    sleep "$((attempt * 5))"
  fi
done

echo "::error::punta di $ref non risolvibile via git ls-remote; nessuna verifica di freschezza puo' procedere" >&2
exit 1
