#!/usr/bin/env bash
# 停止 rag-harness 适配层与前端（dsh 子进程随适配层一起退出）
# 用法: ./stop.sh

set -u
RUN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.run"

for name in web server; do
  pidfile="$RUN_DIR/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    pid="$(cat "$pidfile")"
    kill -TERM "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
    echo "🛑 $name 已停止 (pid $pid)"
  else
    echo "⏭️  $name 未在运行"
  fi
  rm -f "$pidfile"
done
echo "阿里云 LightRAG / MinerU 独立运行。"
