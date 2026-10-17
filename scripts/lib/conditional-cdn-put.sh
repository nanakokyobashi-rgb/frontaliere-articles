#!/usr/bin/env bash
# Conditional single-object PUT for the R2 coordination locks.
#
# Unlike upload-cdn-file.sh this helper is intentionally fail-closed and only
# accepts the lock prefix.  `If-None-Match: *` is the atomic acquire operation;
# `If-Match: <etag>` replaces an expired lease or writes its tombstone without
# allowing a concurrent owner to be overwritten.
set -uo pipefail

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  echo "Usage: conditional-cdn-put.sh <local_file> <cdn_key> <condition-header> [cache_control]" >&2
  exit 1
fi

local_file="$1"
cdn_key="${2#/}"
condition="$3"
cache_control="${4:-public,max-age=5}"

if [ ! -f "$local_file" ]; then
  echo "::error::[cdn-conditional-put] file locale assente: $local_file" >&2
  exit 1
fi
if ! [[ "$cdn_key" =~ ^edge/sections/_bootstrap-locks/canton-[a-z]+\.json$ ]]; then
  echo "::error::[cdn-conditional-put] chiave fuori allowlist: $cdn_key" >&2
  exit 1
fi
if ! [[ "$condition" =~ ^If-(None-)?Match:\ .+$ ]]; then
  echo "::error::[cdn-conditional-put] condizione non valida" >&2
  exit 1
fi
if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] \
   || [ -z "${R2_S3_ENDPOINT:-}" ] || [ -z "${R2_BUCKET:-}" ]; then
  echo "::error::[cdn-conditional-put] credenziali R2 mancanti" >&2
  exit 1
fi

rtmp="${RUNNER_TEMP:-/tmp}"
if [ -x "$rtmp/rclone-bin/rclone" ]; then
  export PATH="$rtmp/rclone-bin:$PATH"
fi
if ! command -v rclone >/dev/null 2>&1; then
  mkdir -p "$rtmp/rclone-bin"
  if ! curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors \
       --connect-timeout 15 --max-time 120 \
       https://downloads.rclone.org/rclone-current-linux-amd64.zip \
       -o "$rtmp/rclone.zip"; then
    echo "::error::[cdn-conditional-put] download rclone fallito" >&2
    exit 1
  fi
  unzip_rc=0
  unzip -q -o -j "$rtmp/rclone.zip" '*/rclone' -d "$rtmp/rclone-bin" || unzip_rc=$?
  if [ "$unzip_rc" -ge 2 ] || [ ! -s "$rtmp/rclone-bin/rclone" ] \
     || ! chmod +x "$rtmp/rclone-bin/rclone" \
     || ! timeout -k 5 30 "$rtmp/rclone-bin/rclone" version >/dev/null 2>&1; then
    echo "::error::[cdn-conditional-put] installazione rclone fallita" >&2
    exit 1
  fi
  export PATH="$rtmp/rclone-bin:$PATH"
fi

timeout_s="${R2_TIMEOUT_OBJECT_S:-120}"
if ! [[ "$timeout_s" =~ ^[1-9][0-9]{0,3}$ ]]; then timeout_s=120; fi
target=":s3:$R2_BUCKET/$cdn_key"

for try in 1 2; do
  output=""
  status=0
  output="$(timeout -k 10 "$timeout_s" rclone \
    --s3-provider=Cloudflare \
    --s3-access-key-id="$R2_ACCESS_KEY_ID" \
    --s3-secret-access-key="$R2_SECRET_ACCESS_KEY" \
    --s3-endpoint="$R2_S3_ENDPOINT" \
    --s3-region=auto --s3-no-check-bucket \
    --contimeout=15s --timeout=60s --ignore-times \
    copyto "$local_file" "$target" \
    --header-upload "Content-Type: application/json; charset=utf-8" \
    --header-upload "Cache-Control: $cache_control" \
    --header-upload "$condition" --stats=0 2>&1)" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "✅ conditional uploaded $cdn_key"
    exit 0
  fi
  if printf '%s' "$output" | grep -qiE '412|PreconditionFailed|precondition failed'; then
    echo "⏳ conditional lock busy: $cdn_key"
    exit 2
  fi
  if [ "$try" -lt 2 ]; then sleep 3; fi
done

echo "::error::[cdn-conditional-put] PUT condizionale fallito per $cdn_key" >&2
exit 1
