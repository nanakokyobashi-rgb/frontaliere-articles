#!/usr/bin/env bash
# Gestione del sottoalbero dei processi per il watchdog della generazione.

proc_tree() {
  local root="$1" kid
  for kid in $(ps -A -o pid= -o ppid= | awk -v p="$root" '$2 == p { print $1 }'); do
    proc_tree "$kid"
  done
  printf '%s\n' "$root"
}

kill_tree() {
  local sig="$1" root="$2" p
  case "$root" in ''|0|*[!0-9]*) return 0 ;; esac
  for p in $(proc_tree "$root"); do
    kill "-$sig" "$p" 2>/dev/null || true
  done
}

create_article_pids() {
  local root="$1" p comm args arg out=""
  for p in $(proc_tree "$root"); do
    comm="$(ps -ww -o comm= -p "$p" 2>/dev/null)" || continue
    case "${comm##*/}" in
      node|nodejs) ;;
      *) continue ;;
    esac
    args="$(ps -ww -o args= -p "$p" 2>/dev/null)" || continue
    [[ "$args" =~ (^|[[:space:]])generator/scripts/create-article\.mjs([[:space:]]|$) ]] || continue
    # Su Linux ps appiattisce argv: verifica i confini NUL effettivi.
    if [ -d /proc/self ]; then
      while IFS= read -r -d '' arg; do
        if [ "$arg" = generator/scripts/create-article.mjs ]; then
          out="$out $p"
          break
        fi
      done 2>/dev/null < "/proc/$p/cmdline" || true
    else
      out="$out $p"
    fi
  done
  printf '%s' "$out"
}
