#!/usr/bin/env bash
# 一键启动 rag-harness 适配层(3088) + 前端 dev(5173)
# 用法: ./start.sh   （日志在 rag-harness-sdk/.run/，停止用 ./stop.sh）

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$HERE/.run"
mkdir -p "$RUN_DIR"

# The local session store and harness SDK require a recent Node runtime.
supports_node() {
  [ -x "$1" ] && "$1" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
    require("node:sqlite");
  ' >/dev/null 2>&1
}
if [ -n "${NODE_BIN:-}" ]; then
  if ! supports_node "$NODE_BIN"; then
    echo "❌ NODE_BIN 需要指向支持 SQLite 的 Node.js 22.19 以上版本，建议使用 Node.js 24。"
    exit 1
  fi
else
  NODE_BIN=""
  for candidate in "$(command -v node || true)" \
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
    /opt/homebrew/bin/node /usr/local/bin/node; do
    if supports_node "$candidate"; then NODE_BIN="$candidate"; break; fi
  done
  if [ -z "$NODE_BIN" ]; then
    echo "❌ 未找到 Node.js 22.19 以上版本。请安装 Node.js 24，或通过 NODE_BIN 指定可用路径。"
    exit 1
  fi
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "▶️  使用 Node.js $("$NODE_BIN" --version)"

# 首次运行准备：适配层依赖 + profile 插件链接（幂等）
if [ ! -d "$HERE/backend/node_modules/@deepseek-ai/dsh-sdk-client" ] || [ ! -d "$HERE/backend/node_modules/pg" ] || [ ! -d "$HERE/backend/node_modules/yaml" ] || [ ! -d "$HERE/backend/node_modules/yauzl" ]; then
  echo "▶️  安装适配层依赖 (npm ci) ..."
  (cd "$HERE/backend" && npm ci --no-fund --no-audit)
fi
PROFILE_NM="$HERE/backend/dsh/home/profiles/rag-kb/node_modules"
mkdir -p "$PROFILE_NM"
ln -sfn ../../../../dsh-knowledge "$PROFILE_NM/dsh-knowledge"
ln -sfn ../../../../plugin-approval-bridge "$PROFILE_NM/kb-approval-bridge"
[ -f "$HERE/backend/.env" ] || echo "⚠️  缺少 backend/.env（复制 backend/.env.example 填入密钥与知识库路径），模型与知识库功能不可用"

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
  echo "🎉 全部就绪，浏览器打开 http://localhost:5173/chat"
else
  echo "部分服务未就绪，查看 $RUN_DIR/ 下日志"
  exit 1
fi
