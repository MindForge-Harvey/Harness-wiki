#!/usr/bin/env bash
# 一键启动 rag-harness 适配层(3088) + 前端 dev(5173)
# 用法: ./start.sh（backend/.env 配置阿里云服务；日志 .run/，停止用 ./stop.sh）

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$HERE/.run"
mkdir -p "$RUN_DIR"

NODE_BIN="${NODE_BIN:-$(command -v node)}"
if ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null; then
  if [ -x /opt/homebrew/bin/node ]; then NODE_BIN=/opt/homebrew/bin/node; fi
fi
if ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null; then
  echo "❌ 需要 Node >=22.19；可设置 NODE_BIN 或使用 Docker Compose"; exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"

# 首次运行准备：适配层依赖 + profile 插件链接（幂等）
if [ ! -d "$HERE/backend/node_modules/@deepseek-ai/dsh-sdk-client" ]; then
  echo "▶️  安装适配层依赖 (npm ci) ..."
  (cd "$HERE/backend" && npm ci --no-fund --no-audit) || exit 1
fi
if [ ! -d "$HERE/frontend/node_modules/vite" ]; then
  (cd "$HERE/frontend" && npm ci --no-fund --no-audit) || exit 1
fi
[ -f "$HERE/backend/.env" ] || { echo "❌ 缺少 backend/.env，请复制 backend/.env.example 并填写配置"; exit 1; }

wait_ready() { # wait_ready <名称> <url> <pid> <超时秒>
  local name="$1" url="$2" pid="$3" timeout="${4:-60}" i=0
  while [ "$i" -lt "$timeout" ]; do
    curl --noproxy '*' -fs -m 2 -o /dev/null "$url" && { echo "✅ $name 就绪 ($url)"; return 0; }
    [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null && { echo "❌ $name 进程退出，日志: $RUN_DIR/$name.log"; return 1; }
    sleep 1; i=$((i + 1))
  done
  echo "⚠️  $name ${timeout}s 内未就绪，请看日志: $RUN_DIR/$name.log"; return 1
}

start_one() { # start_one <名称> <探测URL> <工作目录> <启动命令...>
  local name="$1" url="$2" dir="$3"; shift 3
  local pidfile="$RUN_DIR/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "⏭️  $name 已在运行 (pid $(cat "$pidfile"))，跳过"; return 0
  fi
  if curl --noproxy '*' -fs -m 2 -o /dev/null "$url"; then
    echo "⏭️  $name 端口已被占用（可能是手动启动的进程），跳过启动"; rm -f "$pidfile"; return 0
  fi
  echo "▶️  启动 $name ..."
  (cd "$dir" && nohup "$@" >"$RUN_DIR/$name.log" 2>&1 & echo $! >"$pidfile")
}

start_one server http://127.0.0.1:3088/api/health "$HERE/backend" "$NODE_BIN" index.js
start_one web http://localhost:5173 "$HERE/frontend" npm run dev

ok=0
wait_ready server http://127.0.0.1:3088/api/health "$(cat "$RUN_DIR/server.pid" 2>/dev/null)" 90 || ok=1
wait_ready web http://localhost:5173 "$(cat "$RUN_DIR/web.pid" 2>/dev/null)" 60 || ok=1

if [ "$ok" -eq 0 ]; then
  echo "🎉 全部就绪，浏览器打开 http://localhost:5173 → 「进入工作台」；服务检查 /api/integrations/health"
else
  echo "部分服务未就绪，查看 $RUN_DIR/ 下日志"
  exit 1
fi
