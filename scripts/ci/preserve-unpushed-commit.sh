#!/usr/bin/env bash
# Preserve generated corpus output when the producer cannot push it.
#
# Usage:
#   bash scripts/ci/preserve-unpushed-commit.sh <commit> <output-dir> [reason]
#   bash scripts/ci/preserve-unpushed-commit.sh --worktree <output-dir> [reason]

set -euo pipefail

warning() {
  echo "::warning::preserve-unpushed-commit: $1; nessun file scritto."
}

source_kind='commit'
input_sha=''
output_dir=''
reason=''
produced_sha=''
base_sha=''
bundle_ref=''
files_tmp=''
temp_index=''
ref_created=false

cleanup() {
  if [ "$ref_created" = true ]; then
    git update-ref -d "$bundle_ref" "$produced_sha" >/dev/null 2>&1 || true
  fi
  if [ -n "$files_tmp" ]; then
    rm -f "$files_tmp"
  fi
  if [ -n "$temp_index" ]; then
    rm -f "$temp_index"
  fi
}

# This helper is deliberately fail-open: a preservation failure must not hide
# the original producer/push failure or make the runner report a second cause.
on_exit() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    warning "errore inatteso durante la conservazione (exit $status)"
  fi
  cleanup
  exit 0
}
trap on_exit EXIT

if [ "$#" -lt 2 ]; then
  warning "servono lo SHA del commit prodotto e la cartella di uscita, oppure --worktree e la cartella di uscita"
  exit 0
fi

if [ "$1" = '--worktree' ]; then
  source_kind='worktree'
  output_dir="$2"
  reason="${3:-}"
else
  input_sha="$1"
  output_dir="$2"
  reason="${3:-}"
fi

if [ "$source_kind" = 'worktree' ]; then
  base_sha="$(git rev-parse --verify 'HEAD^{commit}')"
  head_tree="$(git rev-parse --verify 'HEAD^{tree}')"
  temp_index="$(mktemp "${TMPDIR:-/tmp}/preserve-unpushed-index.XXXXXX")"
  rm -f "$temp_index"
  GIT_INDEX_FILE="$temp_index" git read-tree HEAD
  GIT_INDEX_FILE="$temp_index" git add -A
  # --missing-ok: on a clone without blobs a plain write-tree first downloads
  # every blob the index names, and this runs after a failure, on a job that is
  # already ending. The objects `git add` just wrote are local either way.
  worktree_tree="$(GIT_INDEX_FILE="$temp_index" git write-tree --missing-ok)"
  if [ "$worktree_tree" = "$head_tree" ]; then
    warning 'lo stato del worktree non contiene differenze rispetto a HEAD'
    exit 0
  fi

  commit_subject='Preserve unpushed worktree'
  if [ -n "$reason" ]; then
    commit_subject="$commit_subject: $reason"
  fi
  author_name="${GIT_AUTHOR_NAME:-frontaliere-articles[bot]}"
  author_email="${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
  committer_name="${GIT_COMMITTER_NAME:-frontaliere-articles[bot]}"
  committer_email="${GIT_COMMITTER_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
  produced_sha="$(printf '%s\n\n%s\n' \
    "$commit_subject" \
    'Commit creato dallo script di conservazione a partire dal worktree non committato.' \
    | GIT_AUTHOR_NAME="$author_name" \
      GIT_AUTHOR_EMAIL="$author_email" \
      GIT_COMMITTER_NAME="$committer_name" \
      GIT_COMMITTER_EMAIL="$committer_email" \
      git commit-tree "$worktree_tree" -p "$base_sha")"
  subject="$(git show -s --format=%s "$produced_sha")"
else
  if ! produced_sha="$(git rev-parse --verify "${input_sha}^{commit}" 2>/dev/null)"; then
    warning "${input_sha} non è un commit raggiungibile nel repository"
    exit 0
  fi

  if [ "$(git cat-file -t "$produced_sha" 2>/dev/null || true)" != 'commit' ]; then
    warning "${input_sha} non identifica un commit"
    exit 0
  fi

  if ! base_sha="$(git rev-parse --verify "${produced_sha}^1" 2>/dev/null)"; then
    warning "il commit ${produced_sha} non ha un genitore"
    exit 0
  fi
  subject="$(git show -s --format=%s "$produced_sha")"
fi

# Always use a per-invocation ref. This also handles an artifact directory being
# reused while a stale refs/unpushed/article is still present.
bundle_ref="refs/unpushed/article-$$-${RANDOM}-$(date -u +%s)"
while git show-ref --verify --quiet "$bundle_ref"; do
  bundle_ref="refs/unpushed/article-$$-${RANDOM}-$(date -u +%s)"
done

mkdir -p "$output_dir"
bundle_path="$output_dir/article.bundle"
manifest_path="$output_dir/manifest.json"
replay_path="$output_dir/REPLAY.md"
rm -f "$bundle_path" "$manifest_path" "$replay_path"

files_tmp="$(mktemp "${TMPDIR:-/tmp}/preserve-unpushed-files.XXXXXX")"
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
  SOURCE_KIND="$source_kind" \
  BUNDLE_REF="$bundle_ref" \
  FILES_PATH="$files_tmp" \
  MANIFEST_PATH="$manifest_path" \
  node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const raw = readFileSync(process.env.FILES_PATH);
const files = [];
let start = 0;
for (let end = 0; end <= raw.length; end += 1) {
  if (end !== raw.length && raw[end] !== 0) continue;
  if (end > start) files.push(raw.subarray(start, end).toString('utf8'));
  start = end + 1;
}

const manifest = {
  producedSha: process.env.PRODUCED_SHA,
  baseSha: process.env.BASE_SHA,
  subject: process.env.SUBJECT,
  source: process.env.SOURCE_KIND,
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
  printf '%s\n' "Scarica l'artifact \`unpushed-*\` della run e usa il file \`article.bundle\`."
  printf '%s\n' 'Il commit di base richiesto dal bundle è `baseSha` nel manifest.'
  printf '%s\n' 'Se il clone è shallow e non contiene `baseSha`, recuperalo prima:'
  printf '%s\n' ''
  printf '%s\n' '```sh'
  printf '%s\n' "git fetch origin ${base_sha}"
  printf '%s\n' "git checkout --detach ${base_sha}"
  printf '%s\n' 'git fetch <bundle> <ref>'
  printf '%s\n' "git fetch ./article.bundle ${bundle_ref}"
  printf '%s\n' 'git cherry-pick FETCH_HEAD'
  if [ "$source_kind" = 'worktree' ]; then
    printf '%s\n' '```'
    printf '%s\n' ''
    printf '%s\n' 'Il commit è stato creato dallo script di conservazione dal worktree, non dal generatore.'
    printf '%s\n' 'I controlli del passo di commit — unicità dopo il rebase e i registri delle immagini — NON sono stati eseguiti: ripetili prima del push.'
  else
    printf '%s\n' "node scripts/ci/check-post-rebase-uniqueness.mjs --produced ${produced_sha} --against HEAD"
    printf '%s\n' '```'
    printf '%s\n' ''
    printf '%s\n' 'Il commit è stato creato dal generatore; il controllo di unicità va rieseguito prima del push.'
  fi
  printf '%s\n' 'Se il cherry-pick va in conflitto, usa scripts/lib/rebase-onto-remote.sh con le sue liste --merge-registry per non perdere i registri append-only.'
  printf '%s\n' "Un'uscita 1 significa un duplicato vero: in quel caso NON si pusha."
  printf '%s\n' 'Solo dopo i controlli riusciti si può fare il push del commit rigiocato.'
} > "$replay_path"

bundle_size="$(wc -c < "$bundle_path" | tr -d '[:space:]')"
printf 'preserve-unpushed-commit: source=%s sha=%s files=%s bundle=%s size=%s bytes\n' \
  "$source_kind" "$produced_sha" "$file_count" "$bundle_path" "$bundle_size"
