#!/usr/bin/env bash
# Render and publish one section. The workflow supplies all event and matrix
# state through the environment; keeping the orchestration here prevents the
# workflow scalar from reintroducing GitHub's parser-size failure.
set -euo pipefail
article_ids_file="$RUNNER_TEMP/fast-section-article-ids.json"
missing_page_paths_file="$RUNNER_TEMP/fast-section-missing-page-paths.json"
known_missing_page_paths_file="$RUNNER_TEMP/fast-section-known-missing-page-paths.json"
printf '%s' "$ARTICLE_IDS_JSON" > "$article_ids_file"
printf '%s' "$MISSING_PAGE_PATHS_JSON" > "$missing_page_paths_file"
printf '%s' "$KNOWN_MISSING_PAGE_PATHS_JSON" > "$known_missing_page_paths_file"
coordinated_recovery="${COORDINATED_RECOVERY:-false}"
if [ -n "${SOURCE_COMMIT:-}" ]; then
  if [ -z "${SOURCE_MAIN_COMMIT:-}" ] || ! [[ "$SOURCE_MAIN_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::source_main_commit e' obbligatorio e richiede una SHA completa quando source_commit e' valorizzato"
    exit 1
  fi
  if ! [[ "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::source_commit richiede una SHA completa"
    exit 1
  fi
  if [ "$SOURCE_COMMIT" != "$SOURCE_MAIN_COMMIT" ]; then
    echo "::error::source_commit deve coincidere con source_main_commit nel replay bounded"
    exit 1
  fi
  if [ "$(git rev-parse HEAD)" != "$SOURCE_COMMIT" ]; then
    echo "::error::checkout non coincide con source_commit"
    exit 1
  fi
fi
pinned_replay_main=''
if [ "$EVENT_NAME" = 'workflow_run' ]; then
  pinned_replay_main="$WORKFLOW_RUN_HEAD_SHA"
elif [ "$EVENT_NAME" = 'workflow_dispatch' ] && [ -n "${SOURCE_COMMIT:-}" ]; then
  pinned_replay_main="$SOURCE_MAIN_COMMIT"
fi
if [ -n "$pinned_replay_main" ]; then
  if ! current_main="$(bash scripts/ci/read-main-head.sh)"; then
    echo "::error::impossibile verificare la revisione corrente di main prima degli upload"
    exit 1
  fi
  if ! [[ "$current_main" =~ ^[a-f0-9]{40}$ ]]; then
    echo "::error::revisione corrente di main non valida prima degli upload"
    exit 1
  fi
  if [ "$current_main" != "$pinned_replay_main" ]; then
    runtime_pat="${GITHUB_PAT_NANAKO:-}"
    if [ -z "$runtime_pat" ]; then
      echo "::error::GITHUB_PAT_NANAKO assente: impossibile redispatchare il replay stantio prima degli upload"
      exit 1
    fi
    export GH_TOKEN="$runtime_pat"
    dispatch_nonce="${DISPATCH_NONCE:-}"
    if [ -z "$dispatch_nonce" ]; then
      dispatch_nonce="stale-late-${GITHUB_RUN_ID}-${SECTION}"
    fi
    nonce_seed="$dispatch_nonce"
    nonce_hash="$(printf '%s\0%s\0%s\0%s' "$nonce_seed" "$current_main" "$SECTION" "$coordinated_recovery" | sha256sum | cut -c1-16)"
    dispatch_nonce="stale-late-${current_main:0:12}-${SECTION}-${nonce_hash}"
    if [ "$EVENT_NAME" = 'workflow_run' ]; then
      echo "::notice::replay workflow_run redispatchato prima degli upload: main e' avanzato da $pinned_replay_main a $current_main"
    else
      echo "::notice::replay bounded redispatchato prima degli upload: main e' avanzato da $pinned_replay_main a $current_main"
    fi
    replay_before="${PUSH_BEFORE:-$pinned_replay_main}"
    replay_after=''
    if [ -n "$replay_before" ]; then
      # The replay source is current_main; do not retain the old
      # range head or release selection.
      replay_after="$current_main"
    fi
    api_release_commit=''
    if [ "$EVENT_NAME" = 'workflow_run' ]; then
      if [ "$(git rev-parse --is-shallow-repository)" = 'true' ]; then
        git fetch --no-tags --unshallow origin main
      else
        git fetch --no-tags origin main
      fi
      api_release_commit="$(
        CURRENT_MAIN="$current_main" STALE_API_RELEASE="$pinned_replay_main" node --input-type=module -e '
          import { resolveStaleReplayApiReleaseCommit } from "./scripts/publish-section-pages.mjs";
          process.stdout.write(resolveStaleReplayApiReleaseCommit(
            process.env.CURRENT_MAIN,
            process.env.STALE_API_RELEASE,
          ));
        '
      )"
      if [ "$api_release_commit" = "$current_main" ]; then
        echo "::notice::release API stantia non copre la HEAD corrente; il replay ricalcolera' la release senza override"
        api_release_commit=''
      else
        echo "::notice::replay workflow_run: release API attesa $api_release_commit"
      fi
    fi
    dispatch_title="cover-publish-section / ${SECTION} / nonce=${dispatch_nonce}"
    bash .replay-dispatcher-source/scripts/ci/dispatch-fast-publish-replay.sh "$REPO" "$dispatch_title" --ref main \
      -f section="$SECTION" \
      -f article_ids="$ARTICLE_IDS_JSON" \
      -f missing_page_paths="$MISSING_PAGE_PATHS_JSON" \
      -f known_missing_page_paths="$KNOWN_MISSING_PAGE_PATHS_JSON" \
      -f bootstrap="$BOOTSTRAP" \
      -f remove_stale_canton_rss_feeds="$REMOVE_STALE_CANTON_RSS_FEEDS" \
      -f cleanup_inactive_surface="$CLEANUP_INACTIVE_SURFACE" \
      -f replay_api_after_publish="$REPLAY_API_AFTER_PUBLISH" \
      -f allow_deferred_live_release="$ALLOW_DEFERRED_LIVE_RELEASE" \
      -f api_release_commit="$api_release_commit" \
      -f source_commit="$current_main" \
      -f source_main_commit="$current_main" \
      -f dry_run="$DRY" \
      -f push_before="$replay_before" \
      -f push_after="$replay_after" \
      -f dispatch_nonce="$dispatch_nonce" \
      -f coordinated_recovery="$coordinated_recovery"
    exit 0
  fi
fi
previous_revision="${PUSH_BEFORE:-}"
if [ "$EVENT_NAME" = 'workflow_run' ]; then
  if [ -z "${WORKFLOW_RUN_HEAD_SHA:-}" ] || [ "$(git rev-parse HEAD)" != "$WORKFLOW_RUN_HEAD_SHA" ]; then
    echo "::error::workflow_run head non coincide con il checkout"
    exit 1
  fi
fi
build_publish_args() {
  local dry_mode="$1"
  args=(--section "$SECTION" --out "$RUNNER_TEMP/section-dist" --summary "$RUNNER_TEMP/section-summary.json")
  if [ -n "$previous_revision" ] && [[ ! "$previous_revision" =~ ^0+$ ]]; then
    args+=(--previous-revision "$previous_revision")
  fi
  if [ "$BOOTSTRAP" = "true" ]; then
    args+=(--bootstrap)
  else
    args+=(--ids-file "$article_ids_file")
  fi
  args+=(--missing-pages-file "$missing_page_paths_file")
  args+=(--known-missing-pages-file "$known_missing_page_paths_file")
  if [ "$REMOVE_STALE_CANTON_RSS_FEEDS" = "true" ]; then
    args+=(--remove-stale-canton-rss-feeds)
  fi
  if [ "$CLEANUP_INACTIVE_SURFACE" = "true" ]; then
    args+=(--cleanup-inactive-surface)
  fi
  if [ "$dry_mode" = "true" ]; then
    args+=(--dry-run)
  else
    args+=(--publish)
  fi
}
build_publish_args "$DRY"
if ! [[ "${PREFLIGHT_HEAD:-}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "::error::resolve non ha esportato una SHA preflightata valida"
  exit 1
fi
validated_head="$PREFLIGHT_HEAD"
refresh_live_plan_and_preflight() {
  local plan_before="${PUSH_BEFORE:-}"
  local live_matrix=''
  local live_target=''
  local live_preflight_dir="$RUNNER_TEMP/live-preflight"
  local refresh_scope='true'
  if [ -z "$plan_before" ] || [[ "$plan_before" =~ ^0+$ ]]; then
    plan_before="$(git rev-parse HEAD^)"
  fi
  if [ "$EVENT_NAME" = 'workflow_dispatch' ] \
    && { [ -z "${PUSH_BEFORE:-}" ] || [[ "$PUSH_BEFORE" =~ ^0+$ ]]; }; then
    # Una dispatch senza push_before ha uno scope esplicito: il
    # piano ricalcolato verifica la HEAD ma non amplia gli ID richiesti.
    refresh_scope='false'
  fi
  live_matrix="$(git diff --name-status "$plan_before" HEAD \
    | PUSH_BEFORE="$plan_before" node scripts/ci/fast-publish-section.mjs r2-plan \
    | jq -c 'map(. + {bootstrap: (.bootstrap // false)})')"
  live_target="$(jq -c --arg section "$SECTION" \
    'map(select(.section == $section)) | if length == 1 then .[0] else empty end' \
    <<<"$live_matrix")"
  if [ "$refresh_scope" = 'true' ] && [ -n "$live_target" ]; then
    ARTICLE_IDS_JSON="$(jq -c '.ids // []' <<<"$live_target")"
    BOOTSTRAP="$(jq -r '.bootstrap // false' <<<"$live_target")"
    REMOVE_STALE_CANTON_RSS_FEEDS="$(jq -r '.removeStaleCantonRssFeeds // false' <<<"$live_target")"
    CLEANUP_INACTIVE_SURFACE="$(jq -r '.cleanupInactiveSurface // false' <<<"$live_target")"
    printf '%s' "$ARTICLE_IDS_JSON" > "$article_ids_file"
  elif [ "$refresh_scope" = 'true' ] && [ "$EVENT_NAME" = 'push' ]; then
    echo "::error::il piano live non contiene la sezione $SECTION sulla HEAD $(git rev-parse HEAD)"
    return 1
  else
    echo "::notice::il piano live verifica la HEAD; conservo lo scope esplicito del dispatch"
  fi

  if [ ! -f "$live_preflight_dir/node_modules/esbuild/lib/main.js" ]; then
    local esbuild_pin
    esbuild_pin="$(sed -n 's/^[[:space:]]*ESBUILD_PIN:[[:space:]]*//p' .github/workflows/publish-api.yml | head -n 1)"
    if [[ ! "$esbuild_pin" =~ ^esbuild@[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "::error::publish-api.yml does not expose a valid ESBUILD_PIN for the live retry"
      return 1
    fi
    mkdir -p "$live_preflight_dir"
    printf '{"name":"live-retry-preflight","private":true}\n' > "$live_preflight_dir/package.json"
    (
      cd "$live_preflight_dir"
      bash "$GITHUB_WORKSPACE/scripts/ci/retry-cmd.sh" \
        npm install --no-save --no-audit --no-fund --prefer-offline --loglevel=error "$esbuild_pin"
    )
  fi
  PREFLIGHT_ESBUILD_DIR="$live_preflight_dir" \
    PREFLIGHT_EVENT_NAME="$EVENT_NAME" \
    PREFLIGHT_BASE_REVISION="$plan_before" \
    PREFLIGHT_PUSH_BASE_REVISION="$plan_before" \
    PREFLIGHT_SCAN_MODE=full \
    node scripts/ci/check-blog-body-syntax.mjs
  PREFLIGHT_SCAN_MODE=full \
    node scripts/ci/check-blog-body-links.mjs
}

# A normal push or an unpinned dispatch from main is a live
# publication request, including bootstrap dispatches. If main advances
# during the render, rebase
# onto the live head between attempts instead of retrying the stale
# snapshot. The original push range remains the publication scope,
# but a retry that changes its head reruns the plan and both
# publication preflight gates before rendering that revision. A
# productive staged live release records its rendered SHA so the
# matrix barrier can start the API replay; a dry attempt records no
# release and every other error stays fail-closed.
# workflow_run and bounded replays are redispatched if their pinned
# source goes stale before render, preserving the source/API
# freshness invariant.
normal_dispatch='false'
if { [ "$EVENT_NAME" = 'push' ] \
  || [ "$EVENT_NAME" = 'workflow_dispatch' ]; } \
  && [ "$REF" = 'refs/heads/main' ] \
  && [ -z "${SOURCE_COMMIT:-}" ]; then
  normal_dispatch='true'
fi
dynamic_bootstrap_lock='false'
acquire_dynamic_bootstrap_lock() {
  if [ "$BOOTSTRAP" != 'true' ] || [ "${TARGET_BOOTSTRAP:-false}" = 'true' ] || [ "$dynamic_bootstrap_lock" = 'true' ]; then
    return 0
  fi
  echo "::notice::il piano live è passato a bootstrap; acquisisco il lock R2 prima del render"
  node scripts/ci/section-bootstrap-lock.mjs acquire \
    --section "$SECTION" \
    --commit "$(git rev-parse HEAD)" \
    --wait-ms 3300000 \
    --retry-ms 20000
  dynamic_bootstrap_lock='true'
  echo "dynamic_bootstrap_lock=true" >> "$GITHUB_OUTPUT"
}
if [ "$normal_dispatch" != 'true' ]; then
  # Attraverso il wrapper di retry (issue #98): `npx -y` scarica tsx
  # dal registro a ogni run. Ritentare l'intero comando e' sicuro:
  # il render riscrive lo stesso scratch e gli upload R2 sono PUT
  # idempotenti sulle stesse chiavi.
  attempt_dry="$DRY"
  if [ "$attempt_dry" != 'true' ]; then
    if [ -f .github/FAST_PUBLISH_DISABLED ]; then
      echo "::warning::.github/FAST_PUBLISH_DISABLED present on checkout — running dry"
      attempt_dry=true
    elif [ "${FAST_PUBLISH_ARMED:-}" = "false" ]; then
      echo "::warning::repo variable FAST_PUBLISH_ARMED=false — running dry"
      attempt_dry=true
    fi
  fi
  build_publish_args "$attempt_dry"
  bash scripts/ci/retry-cmd.sh npx -y tsx@4.23.15 scripts/publish-section-pages.mjs "${args[@]}"
  if [ "$attempt_dry" != 'true' ]; then
    echo "rendered_head=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
  else
    echo "::notice::render completato in dry-run: nessuna HEAD produttiva per il replay API"
  fi
  exit 0
fi

while :; do
  for publish_attempt in 1 2 3; do
    git fetch --no-tags origin main
    # `git fetch origin main` aggiorna sempre FETCH_HEAD, ma non
    # necessariamente il ref remoto locale in un checkout Actions.
    # Il retry deve quindi usare esattamente il commit appena letto,
    # altrimenti tre tentativi ripetono la stessa vecchia revisione.
    git checkout --detach FETCH_HEAD
    export EXPECTED_MAIN_HEAD="$(git rev-parse HEAD)"
    export PUSH_AFTER="$EXPECTED_MAIN_HEAD"
    if [ -z "${PUSH_BEFORE:-}" ] || [[ "$PUSH_BEFORE" =~ ^0+$ ]]; then
      previous_revision="$(git rev-parse HEAD^)"
    else
      previous_revision="$PUSH_BEFORE"
    fi
    echo "::notice::normal cover dispatch on main $EXPECTED_MAIN_HEAD (freshness attempt $publish_attempt/3)"

    if [ "$EXPECTED_MAIN_HEAD" != "$validated_head" ]; then
      echo "::notice::HEAD cambiata dopo il preflight ($validated_head -> $EXPECTED_MAIN_HEAD); ricalcolo piano e gate prima del render"
      refresh_live_plan_and_preflight
      validated_head="$EXPECTED_MAIN_HEAD"
    fi

    # main puo' essere avanzata dopo resolve. Rileggi il kill switch
    # dalla revisione appena checkoutata: il dry calcolato da resolve
    # non puo' riarmare una revisione che ora e' disabilitata.
    attempt_dry="$DRY"
    if [ -f .github/FAST_PUBLISH_DISABLED ]; then
      echo "::warning::.github/FAST_PUBLISH_DISABLED present on live checkout — running dry"
      attempt_dry=true
    elif [ "${FAST_PUBLISH_ARMED:-}" = "false" ]; then
      echo "::warning::repo variable FAST_PUBLISH_ARMED=false — running dry"
      attempt_dry=true
    fi
    if [ "$attempt_dry" != 'true' ]; then
      acquire_dynamic_bootstrap_lock
    fi
    build_publish_args "$attempt_dry"

    live_dependency_lock_hash="$(sha256sum package.json package-lock.json | sha256sum | cut -d' ' -f1)"
    if [ "${INSTALLED_DEPENDENCY_LOCK_HASH:-}" != "$live_dependency_lock_hash" ]; then
      echo "::notice::package metadata changed with the live checkout; reinstalling dependencies"
      bash scripts/lib/npm-ci-retry.sh
      export INSTALLED_DEPENDENCY_LOCK_HASH="$live_dependency_lock_hash"
      echo "INSTALLED_DEPENDENCY_LOCK_HASH=$live_dependency_lock_hash" >> "$GITHUB_ENV"
    fi

    if [ "$attempt_dry" != "true" ]; then
      # Il checkout puo' aver cambiato host/constants.ts e quindi il
      # nome dell'asset gtag: riallinea la CDN prima di ogni render.
      bash scripts/ci/retry-cmd.sh npx -y tsx@4.23.15 scripts/ci/ensure-host-shell-assets.mjs
    fi
    # Il wrapper ritenta i blip npm/R2. Un summary deferred e' una
    # staging riuscita: il job deve chiudersi verde per permettere
    # al job successivo di redispatchare publish-api sulla stessa
    # HEAD, mentre ogni altro errore resta fail-closed.
    rm -f "$RUNNER_TEMP/section-summary.json"
    if RETRY_CMD_ATTEMPTS=2 bash scripts/ci/retry-cmd.sh npx -y tsx@4.23.15 scripts/publish-section-pages.mjs "${args[@]}"; then
      if [ "$attempt_dry" != 'true' ]; then
        echo "rendered_head=$EXPECTED_MAIN_HEAD" >> "$GITHUB_OUTPUT"
      else
        echo "::notice::render completato in dry-run sulla HEAD $EXPECTED_MAIN_HEAD: nessuna HEAD produttiva per il replay API"
      fi
      if jq -e '.deferredLiveRelease == true and .published.deferredReason != null' "$RUNNER_TEMP/section-summary.json" >/dev/null 2>&1; then
        echo "::notice::staging live completata sulla HEAD $EXPECTED_MAIN_HEAD; chiudo il job per attivare il replay API"
      fi
      exit 0
    fi
    if ! current_main="$(bash scripts/ci/read-main-head.sh)"; then
      echo "::error::impossibile rileggere la revisione corrente di main dopo un render fallito"
      exit 1
    fi
    if [ "$current_main" = "$EXPECTED_MAIN_HEAD" ]; then
      echo "::error::render fallito senza un avanzamento concorrente di main"
      exit 1
    fi
    echo "::notice::main avanzata durante il render ($EXPECTED_MAIN_HEAD → $current_main); riallineo il checkout"
  done
  if ! handoff_head="$(bash scripts/ci/read-main-head.sh)"; then
    echo "::error::impossibile leggere la HEAD corrente per il replay dopo tre tentativi stale"
    exit 1
  fi
  echo "stale_handoff=true" >> "$GITHUB_OUTPUT"
  echo "stale_handoff_head=$handoff_head" >> "$GITHUB_OUTPUT"
  echo "::notice::tre tentativi stale esauriti: consegno la sezione al coordinatore della matrice sulla HEAD $handoff_head"
  exit 0
done
