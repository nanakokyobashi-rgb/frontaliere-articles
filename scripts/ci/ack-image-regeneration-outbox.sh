#!/usr/bin/env bash
# Remove only the article ids that this publisher run rendered successfully.
# The outbox stays durable until this script has both finished publishing and
# pushed the exact acknowledgement back to main.
set -euo pipefail

SECTION="${1:?section required}"
ARTICLE_IDS_JSON="${2:?article ids JSON required}"
REQUEST_ID="${3:?publisher request id required}"
OUTBOX_FILE='data/image-regeneration-publish-outbox.json'

if [ -z "${GITHUB_PAT_NANAKO:-}" ]; then
  echo "::error::GITHUB_PAT_NANAKO missing — refusing to acknowledge the publisher outbox"
  exit 1
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
remote="https://github.com/${GITHUB_REPOSITORY}.git"
auth="$(printf 'x-access-token:%s' "$GITHUB_PAT_NANAKO" | base64 -w 0)"
git config --local http.https://github.com/.extraheader "AUTHORIZATION: basic $auth"
git remote set-url origin "$remote"

for attempt in 1 2 3 4 5; do
  node scripts/ci/ack-image-regeneration-outbox.mjs \
    --section "$SECTION" \
    --article-ids "$ARTICLE_IDS_JSON" \
    --request-id "$REQUEST_ID"

  if git diff --quiet -- "$OUTBOX_FILE"; then
    echo "publisher outbox already acknowledged for $REQUEST_ID"
    exit 0
  fi

  git add "$OUTBOX_FILE"
  git commit -m "chore(generator): acknowledge queued cover publishers ($REQUEST_ID)"
  if git -c pack.window=0 -c pack.threads=1 push --no-thin --no-verify origin HEAD:main; then
    echo "publisher outbox acknowledged for $REQUEST_ID"
    exit 0
  fi

  if [ "$attempt" -eq 5 ]; then break; fi
  echo "outbox acknowledgement push attempt $attempt failed; retrying on latest main"
  sleep $((attempt * 3))
  git fetch --no-tags origin main
  # This runner has only the acknowledgement commit. Re-start it from the
  # latest main so the next pass removes the exact ids from the latest outbox,
  # preserving concurrent acknowledgements and newly appended entries.
  git reset --hard origin/main
done

echo "::error::publisher outbox acknowledgement could not be pushed; it remains durable on main for the next drain"
exit 1
