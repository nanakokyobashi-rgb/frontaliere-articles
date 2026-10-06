#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/delete-cdn-file.sh — cancella UNA chiave R2 del CDN, e solo fra
# quelle che il corpus possiede per le sezioni cantonali.
#
# Fratello di upload-cdn-file.sh, che per contratto e' additivo e non puo'
# cancellare niente. Serve alla pulizia delle release versionate delle sezioni
# cantonali (`edge/sections/_releases/<commit>/…`, vedi
# scripts/publish-section-edge.mjs): ogni publish ne scrive una nuova, e quelle
# non piu' puntate ne' precedenti vanno tolte, o il bucket crescerebbe di una
# release per ogni commit.
#
# ALLOWLIST: solo chiavi sotto `edge/sections/`. Qualunque altra chiave e' un
# errore d'uso (exit 1): questo script non deve poter diventare un `rm`
# generico sul bucket.
#
# rclone: lo riusa se c'e' gia' (PATH, o il binario che upload-cdn-file.sh ha
# installato in $RUNNER_TEMP/rclone-bin nello stesso job), ma sa anche
# installarlo da solo. Le pagine cantonali possono avere una release senza
# hero da caricare: il cleanup non puo' dipendere da un upload precedente.
#
# Stessa postura di upload-cdn-file.sh: ogni fallimento di runtime e' un
# warning ed exit 0; chi vuole sapere se la cancellazione e' avvenuta legge
# "✅ deleted" sullo stdout.
#
# Usage: delete-cdn-file.sh <cdn_key>
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: delete-cdn-file.sh <cdn_key>" >&2
  exit 1
fi
cdn_key="${1#/}"

if ! [[ "$cdn_key" =~ ^edge/sections/[a-z0-9/._-]+$ ]] \
   || [[ "$cdn_key" == *..* ]]; then
  echo "::error::[cdn-delete] chiave fuori allowlist: $cdn_key" >&2
  exit 1
fi

if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] \
   || [ -z "${R2_S3_ENDPOINT:-}" ] || [ -z "${R2_BUCKET:-}" ]; then
  echo "notice: R2_* credentials missing — skipping CDN delete of $cdn_key"
  exit 0
fi

rtmp="${RUNNER_TEMP:-/tmp}"
if [ -x "$rtmp/rclone-bin/rclone" ]; then
  export PATH="$rtmp/rclone-bin:$PATH"
fi
if ! command -v rclone >/dev/null 2>&1; then
  echo "[cdn-delete] rclone non trovato — installo il binario statico…"
  # Come in upload-cdn-file.sh, unzip puo' uscire 1 dopo avere estratto un
  # binario valido: il contratto e' il file verificato, non il solo exit code.
  if curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors --connect-timeout 15 --max-time 120 \
       https://downloads.rclone.org/rclone-current-linux-amd64.zip -o "$rtmp/rclone.zip"; then
    unzip_rc=0
    unzip -q -o -j "$rtmp/rclone.zip" '*/rclone' -d "$rtmp/rclone-bin" || unzip_rc=$?
    if [ "$unzip_rc" -eq 1 ]; then
      echo "::warning::[cdn-delete] archivio rclone estratto con warning (exit 1)"
    elif [ "$unzip_rc" -ge 2 ]; then
      echo "::warning::[cdn-delete] estrazione rclone fallita (unzip exit $unzip_rc)"
    fi
    if [ "$unzip_rc" -lt 2 ] && [ -s "$rtmp/rclone-bin/rclone" ] \
       && chmod +x "$rtmp/rclone-bin/rclone" 2>/dev/null \
       && timeout -k 5 30 "$rtmp/rclone-bin/rclone" version >/dev/null 2>&1; then
      export PATH="$rtmp/rclone-bin:$PATH"
    fi
  fi
  if ! command -v rclone >/dev/null 2>&1; then
    echo "::warning::[cdn-delete] installazione rclone fallita — $cdn_key non cancellata"
    exit 0
  fi
fi

attempt_ok=0
for try in 1 2; do
  out="$(timeout -k 10 120 rclone \
    --s3-provider=Cloudflare \
    --s3-access-key-id="$R2_ACCESS_KEY_ID" \
    --s3-secret-access-key="$R2_SECRET_ACCESS_KEY" \
    --s3-endpoint="$R2_S3_ENDPOINT" \
    --s3-region=auto \
    --s3-no-check-bucket \
    --contimeout=15s --timeout=60s \
    deletefile ":s3:$R2_BUCKET/$cdn_key" 2>&1)"
  rc=$?
  # Una chiave gia' assente e' lo stato voluto, non un errore.
  if [ "$rc" -eq 0 ] || printf '%s' "$out" | grep -qiE 'not found|NoSuchKey|no such key|404|does not exist|doesn.t exist'; then
    attempt_ok=1
    break
  fi
  if [ "$try" -lt 2 ]; then
    echo "::warning::[cdn-delete] tentativo $try/2 fallito per $cdn_key — riprovo fra 3s"
    sleep 3
  fi
done

if [ "$attempt_ok" = 1 ]; then
  echo "✅ deleted $R2_BUCKET/$cdn_key"
else
  echo "::warning::[cdn-delete] cancellazione fallita per $cdn_key dopo 2 tentativi"
fi
exit 0
