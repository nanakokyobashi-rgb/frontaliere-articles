#!/usr/bin/env bash
# After a coalesced finalize restages latest, wait for its automatic API owner
# or dispatch only when the exact release is still missing from HTTP.
set -euo pipefail

: "${SECTION:?SECTION is required}"
: "${STAGED_HEAD:?STAGED_HEAD is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${REPOSITORY:?REPOSITORY is required}"
[[ "$SECTION" =~ ^canton-[a-z0-9-]+$ ]] || { echo "::error::sezione non valida: $SECTION"; exit 1; }
[[ "$STAGED_HEAD" =~ ^[a-f0-9]{40}$ ]] || { echo '::error::HEAD staged non valida'; exit 1; }

baseline="${API_BASELINE_COMMIT:-}"
if ! [[ "$baseline" =~ ^[a-f0-9]{40}$ ]]; then baseline="${STAGE_BASELINE_COMMIT:-}"; fi
if ! [[ "$baseline" =~ ^[a-f0-9]{40}$ ]]; then
  echo '::error::baseline API/stage non disponibile per la recovery latest'
  exit 1
fi
if ! git cat-file -e "$baseline^{commit}" 2>/dev/null; then git fetch --quiet --no-tags origin "$baseline"; fi
if ! git cat-file -e "$STAGED_HEAD^{commit}" 2>/dev/null; then git fetch --quiet --no-tags origin "$STAGED_HEAD"; fi

api_inputs_changed="$(node scripts/ci/fast-publish-section.mjs r2-api-data-range "$baseline" "$STAGED_HEAD")"
action=none
wait_api=false
api_commit="${COORDINATOR_API_COMMIT:-}"
sections_json="$(jq -cn --arg section "$SECTION" '[$section]')"

if [ "$api_inputs_changed" = 'true' ]; then
  # publish-api binds its HTTP manifest/edge release to the source HEAD it
  # publishes, which may be newer than the last API-data commit in this range.
  api_commit="$STAGED_HEAD"
  auto_owner="$(node scripts/ci/fast-publish-api-only-decision.mjs \
    --push-trigger "$baseline" "$STAGED_HEAD" .github/workflows/publish-api.yml)"
  probe="$(EXPECTED_API_COMMIT="$api_commit" SECTIONS_JSON="$sections_json" \
    node scripts/ci/wait-fast-publish-api-readiness.mjs --probe-once)"
  ready="$(jq -r '.ready // empty' <<<"$probe")"
  case "$ready" in
    true|false) ;;
    *) echo '::error::probe readiness non valido'; exit 1 ;;
  esac
  decision="$(jq -cn \
    --argjson apiInputsChanged true \
    --argjson readinessReady "$ready" \
    --argjson automaticPublisherOwner "$auto_owner" \
    '{apiInputsChanged:$apiInputsChanged,readinessReady:$readinessReady,automaticPublisherOwner:$automaticPublisherOwner}' \
    | node scripts/ci/fast-publish-section.mjs r2-late-api-recovery)"
  action="$(jq -r '.action' <<<"$decision")"
  wait_api="$(jq -r '.waitApi' <<<"$decision")"

  if [ "$action" = 'dispatch' ]; then
    runtime_pat="${GITHUB_PAT_NANAKO:-}"
    if [ -z "$runtime_pat" ]; then
      echo '::error::GITHUB_PAT_NANAKO non caricato: impossibile dispatchare la release API mancante'
      exit 1
    fi
    before="$(git rev-parse "$api_commit^1")"
    export GH_TOKEN="$runtime_pat"
    gh workflow run publish-api.yml --repo "$REPOSITORY" --ref main \
      -f "source_commit=$api_commit" \
      -f "bing_seo_nonce=fast-publish-range-${before}-${api_commit}"
  elif [ "$action" = 'wait' ]; then
    echo "::notice::attendo l owner publish-api automatico per $api_commit"
  else
    echo "::notice::release API $api_commit gia' pronta; nessun dispatch duplicato"
  fi
fi

echo "action=$action" >> "$GITHUB_OUTPUT"
echo "wait_api=$wait_api" >> "$GITHUB_OUTPUT"
echo "api_commit=$api_commit" >> "$GITHUB_OUTPUT"
echo "sections_json=$sections_json" >> "$GITHUB_OUTPUT"
echo "::notice::recovery API late: action=$action commit=$api_commit wait=$wait_api section=$SECTION"
