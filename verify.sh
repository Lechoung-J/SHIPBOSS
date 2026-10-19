#!/usr/bin/env bash
# verify.sh — 公开发布自检脚本
# 用途：确认仓库完整（必需文件、平台文档小节、协议违反检查表、相对链接、许可证）。
# 用法：在仓库根目录运行 `bash verify.sh`；全部通过时退出码 0，否则非 0。
# 依赖：仅 bash / grep / awk；不联网、不安装任何东西。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || { echo "FAIL  无法进入脚本所在目录"; exit 1; }

failures=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }
skip() { printf 'SKIP  %s\n' "$*"; }

echo "== 公开发布自检 =="
echo

# ---------- 1. 必需文件 ----------
echo "-- 必需文件 --"
check_file() {
  local f="$1"
  if [ -s "$f" ]; then
    pass "$f 存在且非空"
  else
    fail "$f 缺失或为空"
  fi
}

for f in \
  README.md \
  PROTOCOL.md \
  LICENSE \
  .gitignore \
  platforms/dsh.md \
  platforms/claude-code.md \
  platforms/codex.md \
  references/spec-template.md \
  references/verification-brief.md \
  references/report-template.md \
  references/verification-scripts.md \
  references/handoff.md \
  references/pm-handoff.md \
  references/backlog.md
do
  check_file "$f"
done

# 双语 README 为可选附件：存在则必须非空；主 README 引用它时缺失才判失败。
if [ -s README.zh-CN.md ]; then
  pass "README.zh-CN.md 存在且非空"
elif [ -e README.zh-CN.md ]; then
  fail "README.zh-CN.md 存在但为空"
elif grep -qF 'README.zh-CN.md' README.md 2>/dev/null; then
  fail "README.zh-CN.md 缺失（README.md 已引用该文件）"
else
  skip "README.zh-CN.md 本发布未提供（可选双语版本）"
fi

# ---------- 2. 平台文件结构 ----------
echo
echo "-- 平台文件（各 4 个 H2） --"
PLATFORM_FILES=(platforms/dsh.md platforms/claude-code.md platforms/codex.md)
EXPECTED_H2=('## Dispatch' '## Waiting and Resuming' '## Context Budget' '## Known Unsupported Capabilities')
EXPECTED_H2_ZH=('## 派发' '## 等待与接回' '## 上下文余量' '## 已知不支持的能力')
for p in "${PLATFORM_FILES[@]}"; do
  if [ ! -s "$p" ]; then
    fail "$p 缺失或为空，无法检查小节"
    continue
  fi
  h2_total="$(grep -c '^## ' "$p")"
  h2_bad=""
  for h in "${EXPECTED_H2[@]}"; do
    n="$(grep -cxF -- "$h" "$p")"
    [ "$n" -eq 1 ] || h2_bad="$h2_bad [$h x$n]"
  done
  zh="${p%.md}.zh-CN.md"
  zh_bad=""
  if [ -s "$zh" ]; then
    zh_total="$(grep -c '^## ' "$zh")"
    for h in "${EXPECTED_H2_ZH[@]}"; do
      n="$(grep -cxF -- "$h" "$zh")"
      [ "$n" -eq 1 ] || zh_bad="$zh_bad [$h x$n]"
    done
    [ "$zh_total" -eq 4 ] || zh_bad="$zh_bad [H2总数=$zh_total]"
  else
    zh_bad=" [中文副本缺失]"
  fi
  if [ "$h2_total" -eq 4 ] && [ -z "$h2_bad" ] && [ -z "$zh_bad" ]; then
    pass "$p 与 $zh 各恰好 4 个 H2，标题齐全"
  else
    fail "$p 或中文副本 H2 不合规（英文:${h2_bad:- 无} 中文:${zh_bad:- 无}）"
  fi
done

# ---------- 3. 协议违反检查表 ----------
echo
echo "-- 协议条目 --"
v_bad=""
grep -q '^| *V-1 *|' PROTOCOL.md 2>/dev/null || v_bad="$v_bad V-1"
grep -q '^| *V-16 *|' PROTOCOL.md 2>/dev/null || v_bad="$v_bad V-16"
if [ -z "$v_bad" ]; then
  pass "PROTOCOL.md 含 V-1 与 V-16 两条违反检查项"
else
  fail "PROTOCOL.md 缺少违反检查项:$v_bad"
fi

# ---------- 4. Markdown 相对链接 ----------
echo
echo "-- 相对链接 --"
MD_FILES=(*.md platforms/*.md references/*.md)
link_total=0
link_bad=0
link_files_checked=0
link_check_skipped=0
if ! command -v awk >/dev/null 2>&1; then
  skip "链接检查已跳过：未找到 awk"
  link_check_skipped=1
else
  for md in "${MD_FILES[@]}"; do
    [ -f "$md" ] || continue
    [ -s "$md" ] || continue
    dir=${md%/*}
    [ "$dir" = "$md" ] && dir="."
    # 先把 awk 的提取结果收进变量，才能判断 awk 是否真的执行成功；
    # 绝不能在提取失败时把 0 条当作“全部可解析”。
    if ! targets="$(awk '
      /^[[:space:]]*```/ { fence = !fence; next }
      fence { next }
      {
        s = $0
        gsub(/`[^`]*`/, "", s)
        while (match(s, /\]\([^)]*\)/)) {
          t = substr(s, RSTART + 2, RLENGTH - 3)
          sub(/^[[:space:]]+/, "", t)
          sub(/[[:space:]]+$/, "", t)
          if (t ~ /^</) {
            sub(/^</, "", t)
            sub(/>.*/, "", t)
          } else {
            sub(/[[:space:]]+"[^"]*"[[:space:]]*$/, "", t)
          }
          if (t != "") print t
          s = substr(s, RSTART + RLENGTH)
        }
      }
    ' "$md")"; then
      skip "无法检查 ${md}（awk 执行失败），链接检查已跳过"
      link_check_skipped=1
      continue
    fi
    link_files_checked=$((link_files_checked + 1))
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      case "$target" in
        '<'*'>') target=${target#<}; target=${target%>} ;;
      esac
      case "$target" in
        ''|'#'*|'http://'*|'https://'*|'mailto:'*|'data:'*|'//'*) continue ;;
      esac
      target=${target%%#*}
      target=${target%%\?*}
      target=${target//%20/ }
      [ -n "$target" ] || continue
      case "$target" in
        /*)
          # ${target} 必须带花括号：bash 3.2 会把紧跟变量的中文首字节并入变量名。
          fail "链接不可解析: ${md} -> ${target}（绝对路径）"
          link_bad=$((link_bad + 1))
          continue
          ;;
      esac
      link_total=$((link_total + 1))
      if [ ! -e "$dir/$target" ]; then
        fail "链接不可解析: ${md} -> ${target}"
        link_bad=$((link_bad + 1))
      fi
    done <<< "$targets"
  done
  if [ "$link_files_checked" -eq 0 ]; then
    if [ "$link_check_skipped" -eq 0 ]; then
      skip "链接检查已跳过：没有可检查的 Markdown 文件"
    fi
    link_check_skipped=1
  elif [ "$link_check_skipped" -eq 0 ] && [ "$link_bad" -eq 0 ]; then
    pass "Markdown 相对链接全部可解析（共 ${link_total} 条）"
  fi
fi

# ---------- 5. 许可证 ----------
echo
echo "-- 许可证 --"
if grep -qF 'MIT' LICENSE 2>/dev/null; then
  pass "LICENSE 含 MIT 标识"
else
  fail "LICENSE 未找到 MIT 标识"
fi

# ---------- 汇总 ----------
echo
echo "== summary =="
if [ "$link_check_skipped" -ne 0 ]; then
  echo "NOTE  链接检查已跳过：本次未校验全部 Markdown 链接（不计入失败）"
fi
if [ "$failures" -ne 0 ]; then
  printf 'FAILED (%d 项失败)\n' "$failures"
  exit 1
fi
echo "ALL GREEN (exit 0)"
exit 0
