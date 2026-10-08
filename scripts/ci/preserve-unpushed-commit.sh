#!/usr/bin/env bash
# Preserve one generated commit when the article generator cannot push it.
#
# Usage:
#   bash scripts/ci/preserve-unpushed-commit.sh <commit> <output-dir> [reason]

set -euo pipefail

warning() {
  echo "::warning::preserve-unpushed-commit: $1; nessun file scritto."
}

if [ "$#" -lt 2 ]; then
  warning "servono lo SHA del commit prodotto e la cartella di uscita"
  exit 0
fi

input_sha="$1"
output_dir="$2"
reason="${3:-}"

if ! produced_sha="$(git rev-parse --verify "${input_sha}^{commit}" 2>/dev/null)"; then
  warning "${input_sha} non è un commit raggiungibile nel repository"
  exit 0
fi

if [ "$(git cat-file -t "$produced_sha" 2>/dev/null || true)" != "commit" ]; then
  warning "${input_sha} non identifica un commit"
  exit 0
fi

if ! base_sha="$(git rev-parse --verify "${produced_sha}^1" 2>/dev/null)"; then
  warning "il commit ${produced_sha} non ha un genitore"
  exit 0
fi

subject="$(git show -s --format=%s "$produced_sha")"
bundle_ref='refs/unpushed/article'
# Non sovrascrivere un ref eventualmente lasciato da un altro invocatore.
if git show-ref --verify --quiet "$bundle_ref"; then
  bundle_ref="${bundle_ref}-$$"
fi

mkdir -p "$output_dir"
bundle_path="$output_dir/article.bundle"
manifest_path="$output_dir/manifest.json"
replay_path="$output_dir/REPLAY.md"
rm -f "$bundle_path" "$manifest_path" "$replay_path"

files_tmp="$(mktemp "${TMPDIR:-/tmp}/preserve-unpushed-commit.XXXXXX")"
ref_created=false

cleanup() {
  if [ "$ref_created" = true ]; then
    git update-ref -d "$bundle_ref" "$produced_sha" >/dev/null 2>&1 || true
  fi
  rm -f "$files_tmp"
}
trap cleanup EXIT

git update-ref "$bundle_ref" "$produced_sha"
ref_created=true
git bundle create "$bundle_path" "${base_sha}..${bundle_ref}" >/dev/null
git bundle verify "$bundle_path" >/dev/null
git diff-tree --no-commit-id --name-only -r -z "$produced_sha" > "$files_tmp"

file_count="$(
  PRODUCED_SHA="$produced_sha" \
  BASE_SHA="$base_sha" \
  SUBJECT="$subject" \
  REASON="$reason" \
  BUNDLE_REF="$bundle_ref" \
  FILES_PATH="$files_tmp" \
  MANIFEST_PATH="$manifest_path" \
  node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const files = readFileSync(process.env.FILES_PATH)
  .toString('utf8')
  .split('\0')
  .filter((file) => file.length > 0);

const manifest = {
  producedSha: process.env.PRODUCED_SHA,
  baseSha: process.env.BASE_SHA,
  subject: process.env.SUBJECT,
  files,
  reason: process.env.REASON ?? '',
  ref: process.env.BUNDLE_REF,
};

writeFileSync(process.env.MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(String(files.length));
NODE
)"

{
  printf '%s\n' '# Replay del commit prodotto'
  printf '%s\n' ''
  printf '%s\n' "Scarica l'artifact \`unpushed-article-*\` della run e usa il file \`article.bundle\`."
  printf '%s\n' 'Da un clone aggiornato di `main`, il comando generale è:'
  printf '%s\n' ''
  printf '%s\n' '```sh'
  printf '%s\n' 'git fetch <bundle> <ref>'
  printf '%s\n' "git fetch ./article.bundle ${bundle_ref}"
  printf '%s\n' 'git cherry-pick FETCH_HEAD'
  printf '%s\n' 'node scripts/ci/check-post-rebase-uniqueness.mjs --produced HEAD --against HEAD'
  printf '%s\n' '```'
  printf '%s\n' ''
  printf '%s\n' "Il controllo di unicità va rieseguito prima del push. Un'uscita 1 significa un duplicato vero: in quel caso NON si pusha."
  printf '%s\n' 'Solo dopo un controllo riuscito si può fare il push del commit rigiocato.'
} > "$replay_path"

bundle_size="$(wc -c < "$bundle_path" | tr -d '[:space:]')"
printf 'preserve-unpushed-commit: sha=%s files=%s bundle=%s size=%s bytes\n' \
  "$produced_sha" "$file_count" "$bundle_path" "$bundle_size"
