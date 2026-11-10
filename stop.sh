#!/usr/bin/env bash
# 停止 rag-harness 适配层与前端（dsh 子进程随适配层一起退出）
# 用法: ./stop.sh
# 优先按 PID 文件停止；若 PID 文件不存在或进程已死，再按端口兜底清理
# （手动启动的进程没有 PID 文件，只能靠端口找到并杀掉）。

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$HERE/.run"

# 名称 → 监听端口，用于 PID 文件缺失时的兜底清理。
declare -A PORTS=( [server]=3088 [web]=5173 )

# kill_by_port <名称> <端口>
# 通过 lsof/fuser 找到占用端口的进程并优雅终止，最后强制杀。
kill_by_port() {
  local name="$1" port="$2" pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$port" 2>/dev/null | tr '\n' ' ')"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser -n tcp "$port" 2>/dev/null | tr -s ' ' | tr ' ' '\n' | grep -E '^[0-9]+$' | tr '\n' ' ')"
  fi
  [ -z "$pids" ] && return 1
  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    local alive=0
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive=1; done
    [ "$alive" -eq 0 ] && break
    sleep 1
  done
  for pid in $pids; do kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true; done
  echo "🛑 $name 已停止 (端口 $port, pid $pids)"
  return 0
}

for name in web server; do
  pidfile="$RUN_DIR/$name.pid"
  stopped=0
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    pid="$(cat "$pidfile")"
    kill -TERM "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
    echo "🛑 $name 已停止 (pid $pid)"
    stopped=1
  fi
  # 兜底清理：手动启动的进程没有 PID 文件，或主进程死后子进程仍占着端口。
  # 按端口查找并终止，确保端口真正释放。
  if ! kill_by_port "$name" "${PORTS[$name]}"; then
    [ "$stopped" -eq 0 ] && echo "⏭️  $name 未在运行"
  fi
  rm -f "$pidfile"
done
echo "提示: LightRAG 引擎按需停止 → docker stop lightrag-docker-0.6B"
