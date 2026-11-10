#!/usr/bin/env bash
# run_docgen.sh — 文档生成的 bash 层安全防护（可选）。
# 当模型自己写了 Python 脚本需要跑时，用这个脚本代替裸 bash 执行，
# 自动修正 python→python3、拦截 rm 危险操作、失败时给出清晰诊断。
# 正常走三步走（generate_document.py）时不需要这个脚本。
#
# 用法：bash backend/scripts/run_docgen.sh python gen_salary_training.py
#       bash backend/scripts/run_docgen.sh ./gen_report.py
set -o pipefail
# 诊断信息一律走 stderr，stdout 只留给被调脚本的输出（模型依赖它拿到文件路径）。
log() { printf '[run_docgen] %s\n' "$*" >&2; }
err() { printf '[run_docgen][ERR] %s\n' "$*" >&2; }

# ---- 拦截 rm 危险操作 ----
args=("$@")
joined="$*"
if echo "$joined" | grep -qE 'rm\s+(-[a-z]*[rfRf][a-z]*\s+)?-?\$\{?[A-Z_]'; then
  err "检测到 rm 危险操作（变量展开路径），已拦截。"
  exit 2
fi
if echo "$joined" | grep -qE 'rm\s+-[a-zA-Z]*rf'; then
  err "检测到 rm -rf 危险操作，已拦截。"
  exit 2
fi

# ---- 自动修正 python → python3 ----
if [ "${args[0]}" = "python" ] && command -v python3 >/dev/null 2>&1; then
  log "自动把 python 替换成 python3"
  args[0]="python3"
elif [ "${args[0]}" = "python" ]; then
  err "系统没有 python3，裸 python 也找不到。"
  exit 3
fi

# ---- 执行 ----
log "执行：${args[*]}"
"${args[@]}"
rc=$?

if [ "$rc" -ne 0 ]; then
  err "脚本执行失败（exit=$rc）。如果是 reportlab 生成 PDF，记得先注册 STSong-Light CID 字体。"
fi
exit $rc
