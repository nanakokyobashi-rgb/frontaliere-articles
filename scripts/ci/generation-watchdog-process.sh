#!/usr/bin/env bash
# Gestione del sottoalbero dei processi per il watchdog della generazione.

process_start_identity() {
  local pid="$1" stat start
  local -a fields
  case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
  case "$OSTYPE" in
    linux*)
      stat="$(< "/proc/$pid/stat")" 2>/dev/null || return 1
      [[ "$stat" == *') '* ]] || return 1
      # Dopo l'ultima parentesi il primo campo è il 3 (state).
      read -r -a fields <<< "${stat##*) }"
      start="${fields[19]:-}"
      case "$start" in ''|*[!0-9]*) return 1 ;; esac
      ;;
    darwin*)
      start="$(LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null)" || return 1
      [[ "$start" == *[![:space:]]* ]] || return 1
      ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$start"
}

same_process_identity() {
  local current
  [ -n "$2" ] && current="$(process_start_identity "$1")" && [ "$current" = "$2" ]
}

proc_tree() {
  local root="$1" kid
  for kid in $(ps -A -o pid= -o ppid= | awk -v p="$root" '$2 == p { print $1 }'); do
    proc_tree "$kid"
  done
  printf '%s\n' "$root"
}

kill_tree() {
  local sig="$1" root="$2" identity="${3-}" p
  case "$root" in ''|0|*[!0-9]*) return 0 ;; esac
  if [ "$#" -ge 3 ]; then same_process_identity "$root" "$identity" || return 0; fi
  for p in $(proc_tree "$root"); do
    if [ "$#" -ge 3 ]; then same_process_identity "$root" "$identity" || return 0; fi
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

sample_generation_resources() {
  local root="$1" size="$2" log="$3" p sample
  [ -s "$log" ] || echo "# ts elapsed log_bytes | pid rss_kb cpu% state" > "$log"
  for p in $(create_article_pids "$root"); do
    sample="$(ps -o pid=,rss=,%cpu=,state= -p "$p" 2>/dev/null)" || continue
    echo "$(date -u +%H:%M:%SZ) ${SECONDS}s ${size} | $(tr -s ' ' <<< "$sample")" \
      >> "$log" 2>/dev/null || true
  done
}

generation_capture_root_alive() {
  same_process_identity "$1" "$2" && return 0
  printf '%s\n' 'stack non catturato: identità del wrapper terminata, cambiata o illeggibile' > "$3"
  return 1
}
