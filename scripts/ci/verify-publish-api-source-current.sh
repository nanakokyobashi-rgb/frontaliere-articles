#!/usr/bin/env bash
# Fail closed unless the artifact that is about to be published still belongs
# to current main. A later main commit is safe to adopt only when the workflow's
# declared API inputs did not change; otherwise mark the remaining workflow
# steps to skip. The artifact source marker remains immutable because it is also
# recorded in manifest.json and sent downstream. Keep this bounded helper so
# every irreversible phase uses the same freshness contract.
#
# VERIFY_API_ADVANCE=adopt (set by the publisher job for non-replay runs) turns
# the "newer API input on main" outcome from skip into adopt: a run that already
# passed the preflight finishes publishing its own, self-consistent snapshot and
# leaves the delta to the next FIFO run. Runs are serialised and each starts from
# the then-current main, so the published commit only moves forward. Under a
# continuous stream of commits "skip" lets every run be superseded before its
# end and nothing is ever published. An explicit bounded replay keeps "skip": it
# pins an older commit and must never overwrite a newer surface.
set -euo pipefail

context="${VERIFY_CONTEXT:-publish-api phase}"
repository="${REPOSITORY:-${GITHUB_REPOSITORY:-}}"
published_source="${PUBLISH_API_SOURCE_COMMIT:-${PUBLISHED_SOURCE_COMMIT:-}}"
advance_policy="${VERIFY_API_ADVANCE:-skip}"
skip_marker="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/publish-api-skip"

if [ -f "$skip_marker" ]; then
  exit 0
fi

if [ -z "$repository" ]; then
  echo "::error::repository assente: impossibile verificare la sorgente prima di $context"
  exit 1
fi
if ! current_main="$(timeout --kill-after=1s 60s gh api "repos/$repository/git/ref/heads/main" --jq '.object.sha')"; then
  echo "::warning::verifica REST di main indisponibile prima di $context; provo il riferimento remoto Git"
  if ! remote_main="$(GIT_TERMINAL_PROMPT=0 timeout --kill-after=1s 60s git ls-remote --exit-code --refs origin refs/heads/main)" ||
    ! [[ "$remote_main" =~ ^([a-f0-9]{40})$'\t'refs/heads/main$ ]]; then
    echo "::error::impossibile verificare la HEAD corrente di main prima di $context"
    exit 1
  fi
  current_main="${BASH_REMATCH[1]}"
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
    if [ "$advance_policy" = 'adopt' ]; then
      echo "::notice::publish-api prosegue prima di $context: main=$current_main contiene input API piu' recenti di source=$published_source; questa run pubblica la sorgente gia' costruita e la run della nuova push pubblichera' il delta"
      exit 0
    fi
    if [ -n "${GITHUB_ENV:-}" ]; then
      echo 'PUBLISH_API_SKIP=true' >> "$GITHUB_ENV"
      printf 'true\n' > "$skip_marker"
      echo "::notice::publish-api saltato prima di $context: main=$current_main contiene input API piu' recenti di source=$published_source; le fasi successive restano disattivate"
      exit 0
    fi
    echo "::error::publish stantio prima di $context: main=$current_main contiene input API piu' recenti di source=$published_source; il run della nuova push deve pubblicare quella release"
    exit 1
  fi
  echo "::notice::publish autorizzato prima di $context: main=$current_main e' avanzato da source=$published_source con gli input API invariati; il commit dell'artifact resta $published_source"
  exit 0
fi
echo "sorgente ancora corrente prima di $context: $published_source"
