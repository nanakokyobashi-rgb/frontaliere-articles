#!/usr/bin/env bash
# Crea un worktree sparse basato sul main remoto appena aggiornato.
#
#   scripts/dev/fast-worktree.sh <nome> [--add <path>]...
#
# content/, data/, dist/ e public/ restano fuori per default. Usa --add per
# includere i path specifici richiesti dal task.
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_ROOT" worktree list --porcelain | sed -n 's/^worktree //p' | sed -n '1p')"
[ -n "$REPO_ROOT" ] || { echo "impossibile individuare il worktree principale del repository" >&2; exit 1; }
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

NAME=""
ADDS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --add)
      [ $# -ge 2 ] || { echo "--add richiede un path" >&2; exit 2; }
      ADD_PATH="$2"
      case "$ADD_PATH" in ./*) ADD_PATH="${ADD_PATH#./}" ;; esac
      while [[ "$ADD_PATH" == */ ]]; do ADD_PATH="${ADD_PATH%/}"; done
      case "$ADD_PATH" in
        ""|/*|.|..|../*|*/../*|*/..|*//*|*/./*|*/.)
          echo "path --add non valido: $2" >&2
          exit 2
          ;;
      esac
      ADDS="${ADDS}${ADDS:+$'\n'}$ADD_PATH"
      shift 2
      ;;
    --help|-h)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) echo "opzione sconosciuta: $1" >&2; exit 2 ;;
    *)
      [ -z "$NAME" ] || { echo "specifica un solo nome worktree" >&2; exit 2; }
      NAME="$1"
      shift
      ;;
  esac
done

case "$NAME" in
  ""|.|..|*[!A-Za-z0-9._-]*)
    echo "uso: $0 <nome-semplice> [--add <path>]..." >&2
    exit 2
    ;;
esac

WT_DIR="$REPO_ROOT/.claude/worktrees/$NAME"
[ ! -e "$WT_DIR" ] || { echo "esiste già: $WT_DIR" >&2; exit 1; }

START=$(date +%s)
node "$SCRIPT_ROOT/scripts/dev/fetch-origin-main.mjs" "$REPO_ROOT"

# --no-checkout evita di materializzare l'albero intero prima della sparsità.
mkdir -p "$(dirname "$WT_DIR")"
git -C "$REPO_ROOT" worktree add --no-checkout -b "$NAME" "$WT_DIR" origin/main >/dev/null

PATTERNS=$'/*\n!/content\n!/data\n!/dist\n!/public'
ADD_DIRS=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  rest="$path"
  prefix=""
  while [[ "$rest" == */* ]]; do
    component="${rest%%/*}"
    rest="${rest#*/}"
    prefix="${prefix:+$prefix/}$component"
    case "$prefix" in
      content|data|dist|public|content/*|data/*|dist/*|public/*)
        REQUESTED_ANCESTOR=0
        while IFS= read -r requested; do
          case "$prefix" in "$requested"|"$requested"/*) REQUESTED_ANCESTOR=1 ;; esac
        done <<< "$ADDS"
        if [ "$REQUESTED_ANCESTOR" -eq 0 ]; then
          ADD_DIRS="${ADD_DIRS}${ADD_DIRS:+$'\n'}$prefix"
        fi
        ;;
    esac
  done
done <<< "$ADDS"

if [ -n "$ADD_DIRS" ]; then
  while IFS= read -r path; do
    PATTERNS="${PATTERNS}"$'\n'"/${path}/"$'\n'"!/${path}/*"
  done < <(printf '%s\n' "$ADD_DIRS" | LC_ALL=C sort -u)
fi

while IFS= read -r path; do
  case "$path" in
    content|content/*|data|data/*|dist|dist/*|public|public/*)
      PATTERNS="${PATTERNS}"$'\n'"/${path}"
      ;;
  esac
done <<< "$ADDS"

cd "$WT_DIR"
printf '%s\n' "$PATTERNS" | git sparse-checkout set --no-cone --stdin
git checkout --quiet

FAILED=""
for d in content data dist public; do
  REQUESTED=0
  while IFS= read -r path; do
    case "$path" in "$d"|"$d"/*) REQUESTED=1 ;; esac
  done <<< "$ADDS"
  [ "$REQUESTED" -eq 1 ] && continue
  [ -e "$d" ] && FAILED="$FAILED $d"
done
if [ -n "$FAILED" ]; then
  echo "⚠️  la sparsità non è stata applicata: materializzato$FAILED" >&2
  echo "    il worktree resta, ma contiene directory pesanti." >&2
  exit 1
fi

MISSING=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  [ -e "$WT_DIR/$path" ] || MISSING="$MISSING $path"
done <<< "$ADDS"
if [ -n "$MISSING" ]; then
  echo "❌ path --add non materializzati:$MISSING" >&2
  exit 1
fi

SIZE=$(du -sh . 2>/dev/null | cut -f1)
FILES=$(find . -path ./.git -prune -o -type f -print 2>/dev/null | wc -l | tr -d ' ')
echo "✅ .claude/worktrees/$NAME — $SIZE, $FILES file, $(($(date +%s) - START))s"
echo "   branch $NAME da origin/main"
echo "   manca un percorso? git sparse-checkout add <path>   (non serve ricreare il worktree)"
