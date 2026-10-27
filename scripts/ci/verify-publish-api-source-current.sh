#!/usr/bin/env bash
# Fail closed unless the artifact that is about to be published still belongs
# to the current main revision. Keep this check in one bounded helper so every
# irreversible publisher phase uses the same freshness contract.
set -euo pipefail

context="${VERIFY_CONTEXT:-publish-api phase}"
repository="${REPOSITORY:-}"
published_source="${PUBLISH_API_SOURCE_COMMIT:-${PUBLISHED_SOURCE_COMMIT:-}}"

if [ -z "$repository" ]; then
  echo "::error::repository assente: impossibile verificare la sorgente prima di $context"
  exit 1
fi
if ! current_main="$(timeout --kill-after=1s 60s gh api "repos/$repository/git/ref/heads/main" --jq '.object.sha')"; then
  echo "::error::impossibile verificare la HEAD corrente di main prima di $context"
  exit 1
fi
if ! [[ "$current_main" =~ ^[a-f0-9]{40}$ ]] || ! [[ "$published_source" =~ ^[a-f0-9]{40}$ ]]; then
  echo "::error::identita' della sorgente non verificabile prima di $context (source=$published_source main=$current_main)"
  exit 1
fi
if [ "$current_main" != "$published_source" ]; then
  echo "::error::publish superato prima di $context: source=$published_source main=$current_main; il run successivo deve riallineare la superficie"
  exit 1
fi
echo "sorgente ancora corrente prima di $context: $published_source"
