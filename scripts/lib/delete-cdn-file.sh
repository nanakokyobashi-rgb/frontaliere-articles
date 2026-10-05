#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/delete-cdn-file.sh — cancella UNA chiave R2 del CDN, e solo fra
# quelle che il corpus possiede per le sezioni cantonali.
#
# Fratello di upload-cdn-file.sh, che per contratto e' additivo e non puo'
# cancellare niente. Serve a un caso solo, scritto nel Worker del sito
# (`corpusEdgeFileForPath` in infra/cloudflare-worker/locale-router.js): quando
# nessuna sezione cantonale e' piu' live, `edge/sitemap-cantons.xml` non va
# riscritto vuoto (un `<sitemapindex>` senza `<sitemap>` viola lo schema) ma
# tolto, cosi' il Worker risponde 404 come prima che esistesse. Lasciare la
# copia vecchia significherebbe annunciare in robots.txt sitemap che il Worker
# non serve piu'.
#
# ALLOWLIST: solo `edge/sitemap-cantons.xml`, `edge/sitemap-articles-canton-<x>.xml`
# e `edge/sections/**`. Qualunque altra chiave e' un errore d'uso (exit 1):
# questo script non deve poter diventare un `rm` generico sul bucket.
#
# rclone: lo riusa se c'e' gia' (PATH, o il binario che upload-cdn-file.sh ha
# installato in $RUNNER_TEMP/rclone-bin nello stesso job) e NON lo installa —
# il chiamante (scripts/publish-section-edge.mjs) carica sempre almeno un file
# prima di cancellare. Senza rclone: warning ed exit 0, come il fratello.
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

if ! [[ "$cdn_key" =~ ^edge/(sitemap-cantons\.xml|sitemap-articles-canton-[a-z]+\.xml|sections/[a-z0-9/._-]+)$ ]] \
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
  echo "::warning::[cdn-delete] rclone assente — $cdn_key non cancellata"
  exit 0
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
