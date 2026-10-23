#!/usr/bin/env node
/**
 * node_modules 补丁：dsh-sdk-jsonrpc-server 增发 agent/assistant-delta 通知。
 *
 * 内核 agent-loop 的 agent/assistant-stream（token 级 transient 帧）未被 SDK stdio 协议
 * 转发，适配层只能拿到整条 assistant/message（假流式）。本补丁在 SDK server 的 ctx 层
 * 订阅该事件，把 text/reasoning 增量转发为新的 JSON-RPC 通知 agent/assistant-delta；
 * sdk-client 对未知通知无白名单、原样广播给订阅者，适配层与 SDK 客户端无需其他改动。
 *
 * 幂等：已打过补丁则跳过；npm ci 重建 node_modules 后由 postinstall 自动重放。
 * 锚点不存在时以非零码失败（依赖版本漂移必须显式暴露，不允许静默装出假流式）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js')

const MARK = 'agent/assistant-delta'
const ANCHOR = `\t\tthis.disposers.push(ctx.on("agent/status", ({ agent, status }) => {
\t\t\tthis.transport.notify("session.status", {
\t\t\t\tsessionId: String(agent.session.id),
\t\t\t\tstatus
\t\t\t});
\t\t}));`
const INSERT = ANCHOR + `
\t\tthis.disposers.push(ctx.on("agent/assistant-stream", ({ agent, frame }) => {
\t\t\tif (frame.type !== "chunk") return;
\t\t\tconst chunk = frame.chunk;
\t\t\tif (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") return;
\t\t\tif (typeof chunk.text !== "string" || chunk.text === "") return;
\t\t\tthis.transport.notify("agent/assistant-delta", {
\t\t\t\tsessionId: String(agent.session.id),
\t\t\t\tkind: chunk.type === "text-delta" ? "text" : "reasoning",
\t\t\t\ttext: chunk.text
\t\t\t});
\t\t}));`

let source
try {
  source = readFileSync(target, 'utf8')
} catch (error) {
  console.error('[patches] 未找到 ' + target + '：' + error.message + '（先执行 npm install）')
  process.exit(1)
}
if (source.includes(MARK)) {
  console.log('[patches] dsh-sdk-jsonrpc-server 已含 assistant-delta 补丁，跳过')
  process.exit(0)
}
if (!source.includes(ANCHOR)) {
  console.error('[patches] 锚点不存在：dsh-sdk-jsonrpc-server 版本可能不兼容，补丁未应用')
  process.exit(1)
}
writeFileSync(target, source.replace(ANCHOR, INSERT))
console.log('[patches] dsh-sdk-jsonrpc-server：agent/assistant-delta 通知已启用')
