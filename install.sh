#!/usr/bin/env bash
# SHIPBOSS installer — protocol kit plus offline observer entry.
# No host hooks, network installation or login items.
set -eu

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="./.shipboss"
FORCE=0
OBSERVER_ARGS=(--project "$PWD")
DEST_SET=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --with-observer|--no-start) OBSERVER_ARGS+=("$1"); shift ;;
    --observer-home|--renderer-dist|--electron-binary|--project)
      [ "$#" -ge 2 ] || { echo "缺少参数：$1" >&2; exit 2; }
      OBSERVER_ARGS+=("$1" "$2"); shift 2 ;;
    --help)
      echo 'Usage: bash install.sh [DEST] [--force] [--with-observer] [--observer-home HOME] [--renderer-dist DIR] [--electron-binary FILE] [--no-start] [--project ROOT]'
      exit 0 ;;
    --*) echo "未知选项：$1" >&2; exit 2 ;;
    *) [ "$DEST_SET" -eq 0 ] || { echo '只接受一个安装目录' >&2; exit 2; }
       DEST="$1"; DEST_SET=1; shift ;;
  esac
done

banner() {
  if [ -f "$SRC/docs/welcome.txt" ]; then
    cat "$SRC/docs/welcome.txt"
  else
    echo "SHIPBOSS"
  fi
}

if [ -e "$DEST" ] && [ "$FORCE" -eq 0 ]; then
  echo "目标目录已存在：$DEST"
  echo "如果要覆盖，重新运行：bash install.sh \"$DEST\" --force"
  exit 1
fi

banner
echo
echo "安装到：$DEST"
echo

ENTRY="$SRC/apps/observer/scripts/observer-install.py"
[ -f "$ENTRY" ] || ENTRY="$SRC/scripts/observer-install.py"
exec python3 "$ENTRY" --skill-source "$SRC" --destination "$DEST" "${OBSERVER_ARGS[@]}"

