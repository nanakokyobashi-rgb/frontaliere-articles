#!/usr/bin/env bash
# Conditional single-object PUT for the R2 coordination locks.
#
# AWS CLI serializes and signs If-None-Match / If-Match as S3 PutObject
# preconditions. rclone's S3 backend does not forward arbitrary upload headers,
# so using --header-upload here would silently turn this lock into an
# unconditional overwrite.
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

condition_args=()
case "$condition" in
  "If-None-Match: *")
    condition_args=(--if-none-match '*')
    ;;
  "If-Match: "*)
    etag="${condition#If-Match: }"
    if [ -z "$etag" ] || [[ "$etag" == *$'\n'* ]] || [[ "$etag" == *$'\r'* ]]; then
      echo "::error::[cdn-conditional-put] etag If-Match non valido" >&2
      exit 1
    fi
    condition_args=(--if-match "$etag")
    ;;
  *)
    echo "::error::[cdn-conditional-put] condizione non valida" >&2
    exit 1
    ;;
esac

if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] \
   || [ -z "${R2_S3_ENDPOINT:-}" ] || [ -z "${R2_BUCKET:-}" ]; then
  echo "::error::[cdn-conditional-put] credenziali R2 mancanti" >&2
  exit 1
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "::error::[cdn-conditional-put] AWS CLI non disponibile sul runner" >&2
  exit 1
fi

timeout_s="${R2_TIMEOUT_OBJECT_S:-120}"
if ! [[ "$timeout_s" =~ ^[1-9][0-9]{0,3}$ ]]; then timeout_s=120; fi

for try in 1 2; do
  output=""
  status=0
  output="$(AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true \
    timeout -k 10 "$timeout_s" aws s3api put-object \
      --endpoint-url "$R2_S3_ENDPOINT" \
      --region auto \
      --bucket "$R2_BUCKET" \
      --key "$cdn_key" \
      --body "$local_file" \
      --content-type 'application/json; charset=utf-8' \
      --cache-control "$cache_control" \
      --no-cli-pager \
      "${condition_args[@]}" 2>&1)" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "✅ conditional uploaded $cdn_key"
    exit 0
  fi
  if printf '%s' "$output" | grep -qiE 'PreconditionFailed|ConditionalRequestConflict|status code: 412|status code: 409'; then
    echo "⏳ conditional lock busy: $cdn_key"
    exit 2
  fi
  if [ "$try" -lt 2 ]; then sleep 3; fi
done

echo "::error::[cdn-conditional-put] PUT condizionale fallito per $cdn_key" >&2
exit 1
