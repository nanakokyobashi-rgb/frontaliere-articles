#!/usr/bin/env bash
# Dopo un `readiness-timeout` del finalize, accoda UNA recovery della stessa
# sezione con la release API attesa. Il listener API-only scarta i push che
# attribuisce a Fast Publish: senza questo step, una publish-api rimasta in
# coda oltre il tetto lascerebbe R2 stantia senza nessun proprietario.
set -euo pipefail

: "${SECTION:?SECTION is required}"
: "${REPOSITORY:?REPOSITORY is required}"
: "${API_COMMIT:?API_COMMIT is required}"
[[ "$SECTION" =~ ^canton-[a-z0-9-]+$ ]] || { echo "::error::sezione non valida: $SECTION"; exit 1; }
[[ "$API_COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "::error::commit API atteso non valido: $API_COMMIT"; exit 1; }

# Generazione della recovery: la run originaria e' la 0, ogni recovery ha il
# prefisso `readiness-recovery-g<N>-`. Tetto a 3: una coda che non si smaltisce
# non produce una catena infinita di dispatch (ogni giro attende 90 minuti).
max_generation=3
generation=0
if [[ "${PARENT_NONCE:-}" =~ ^readiness-recovery-g([0-9]+)- ]]; then
  generation="${BASH_REMATCH[1]}"
fi
next=$((generation + 1))
if [ "$next" -gt "$max_generation" ]; then
  echo "::warning::readiness-timeout alla generazione $generation: nessuna ulteriore recovery per $SECTION; la riprende il reconciler"
  exit 0
fi

runtime_pat="${GITHUB_PAT_NANAKO:-}"
if [ -z "$runtime_pat" ]; then
  echo '::error::GITHUB_PAT_NANAKO non caricato: impossibile accodare la recovery'
  exit 1
fi
export GH_TOKEN="$runtime_pat"

nonce="readiness-recovery-g${next}-${GITHUB_RUN_ID:-0}-${SECTION}"
title="cover-publish-section / ${SECTION} / nonce=${nonce}"
bash scripts/ci/dispatch-fast-publish-replay.sh "$REPOSITORY" "$title" --ref main \
  -f "section=$SECTION" \
  -f "article_ids=${TARGET_IDS_JSON:-[]}" \
  -f "missing_page_paths=${TARGET_MISSING_PAGE_PATHS_JSON:-[]}" \
  -f "known_missing_page_paths=${TARGET_KNOWN_MISSING_PAGE_PATHS_JSON:-[]}" \
  -f "bootstrap=${TARGET_BOOTSTRAP:-false}" \
  -f "remove_stale_canton_rss_feeds=${TARGET_REMOVE_STALE:-false}" \
  -f "cleanup_inactive_surface=${TARGET_CLEANUP:-false}" \
  -f 'dry_run=false' \
  -f 'replay_api_after_publish=false' \
  -f 'coordinated_recovery=false' \
  -f "api_release_commit=$API_COMMIT" \
  -f "dispatch_nonce=$nonce"
echo "::notice::recovery readiness-timeout accodata per $SECTION (generazione $next, release API $API_COMMIT)"
