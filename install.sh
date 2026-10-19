#!/usr/bin/env bash
# SHIPBOSS installer — copies the protocol kit into ./.shipboss/
# It never edits your project. It only creates one directory.
set -eu

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-./.shipboss}"
FORCE=0
[ "${2:-}" = "--force" ] && FORCE=1
[ "${1:-}" = "--force" ] && { FORCE=1; DEST="./.shipboss"; }

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

mkdir -p "$DEST"
copied=0
copy() {
  [ -e "$SRC/$1" ] || return 0
  mkdir -p "$DEST/$(dirname "$1")"
  cp -R "$SRC/$1" "$DEST/$1"
  copied=$((copied+1))
}

echo "[1/3] 复制协议主体 ..."
for f in PROTOCOL.md PROTOCOL.zh-CN.md; do copy "$f"; done

echo "[2/3] 复制平台适配与模板 ..."
for d in platforms references; do [ -d "$SRC/$d" ] && copy "$d"; done
copy docs

echo "[3/3] 复制 README 与许可证 ..."
for f in README.md README.zh-CN.md LICENSE verify.sh .gitignore; do copy "$f"; done

echo
echo "完成。共复制 $copied 项到 $DEST"
echo
echo "下一步：把 $DEST/PROTOCOL.md 交给你的 agent，"
echo "然后告诉它你要做什么。剩下的它会按协议办。"
echo
echo "自检：bash \"$DEST/verify.sh\""
