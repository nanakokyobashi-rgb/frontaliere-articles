#!/usr/bin/env bash
# Fail closed unless the artifact that is about to be published still belongs
# to the current main revision. A later main commit is safe to adopt only when
# the workflow's declared API inputs did not change; the artifact source marker
# remains immutable because it is also the commit recorded in manifest.json and
# sent to downstream consumers. Keep this check in one bounded helper so every
# irreversible publisher phase uses the same freshness contract.
set -euo pipefail

context="${VERIFY_CONTEXT:-publish-api phase}"
repository="${REPOSITORY:-${GITHUB_REPOSITORY:-}}"
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
  authoritative_main="$current_main"
  if ! git fetch --no-tags origin main; then
    echo "::error::impossibile scaricare main per classificare l'avanzamento prima di $context"
    exit 1
  fi
  if ! current_main="$(git rev-parse FETCH_HEAD)"; then
    echo "::error::impossibile leggere la snapshot di main appena scaricata prima di $context"
    exit 1
  fi
  if ! [[ "$current_main" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::snapshot di main appena scaricata non valida prima di $context: $current_main"
    exit 1
  fi
  if ! git merge-base --is-ancestor "$authoritative_main" "$current_main"; then
    echo "::error::snapshot di main scaricata piu' vecchia o non riconciliabile prima di $context: autorevole=$authoritative_main fetch=$current_main"
    exit 1
  fi
  if ! git merge-base --is-ancestor "$published_source" "$current_main"; then
    echo "::error::avanzamento non riconciliabile prima di $context: source=$published_source main=$current_main"
    exit 1
  fi
  if ! api_input_changed="$(
    SOURCE_COMMIT="$published_source" CURRENT_MAIN="$current_main" node --input-type=module -e '
      import { apiInputChangedInRange } from "./scripts/lib/publish-api-input-range.mjs";
      process.stdout.write(String(apiInputChangedInRange({
        before: process.env.SOURCE_COMMIT,
        after: process.env.CURRENT_MAIN,
      })));
    '
  )"; then
    echo "::error::impossibile classificare l'avanzamento prima di $context"
    exit 1
  fi
  if [ "$api_input_changed" = 'true' ]; then
    echo "::error::publish stantio prima di $context: main=$current_main contiene input API piu' recenti di source=$published_source; il run della nuova push deve pubblicare quella release"
    exit 1
  fi
  echo "::notice::publish autorizzato prima di $context: main=$current_main e' avanzato da source=$published_source solo con bookkeeping; il commit dell'artifact resta $published_source"
  exit 0
fi
echo "sorgente ancora corrente prima di $context: $published_source"
