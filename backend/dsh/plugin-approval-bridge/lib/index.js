/**
 * kb-approval-bridge · host entry。
 *
 * 职责：把 harness 审批栈的 `'approval/request'` 瀑布请求桥接到聊天界面。
 * 审批语义不变——决定（allowed-once / rejected）仍由 ApprovalService 记账
 * （approval/asked + approval/decided 落会话日志），本插件只提供"人"的入口：
 *
 *  - `'approval/request'` 监听器：为每个请求建 pending 记录并等待决定
 *  - `GET /approvals/pending`：待决定清单（前端在回合进行中轮询）
 *  - `POST /approvals/:id/decision`：用户决定，allowed-once / rejected
 *
 * 无决定或超时（KB_APPROVAL_TIMEOUT_MS，默认 120000）→ next() 委托默认链
 * （fail-closed：无后续 answerer 时即 'unavailable'）；abort → 'cancelled'。
 */

import crypto from 'node:crypto'

export const name = 'kb-approval-bridge'
export const inject = ['webServer']

const DECISION_TIMEOUT_MS = () => {
  const n = Number(process.env.KB_APPROVAL_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : 120_000
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function readJsonBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) { const e = new Error('请求体过大'); e.status = 413; throw e }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { const e = new Error('请求体不是合法 JSON'); e.status = 400; throw e }
}

export function apply(ctx) {
  const webServer = ctx.webServer
  const logger = (msg) => { try { ctx.logger.info('[kb-approval-bridge] ' + msg) } catch { /* 宿主无 logger */ } }

  /** pending id → { id, toolName, callId, reason, createdAt, settle } */
  const pending = new Map()

  function settle(id, outcome) {
    const row = pending.get(id)
    if (!row) return false
    pending.delete(id)
    if (row.timer) clearTimeout(row.timer)
    if (row.onAbort) row.req.signal?.removeEventListener('abort', row.onAbort)
    row.settle(outcome)
    return true
  }

  ctx.on('approval/request', async (req, next) => {
    if (req.signal?.aborted) return 'cancelled'
    const id = 'apr-' + crypto.randomBytes(6).toString('hex')
    const entry = {
      id,
      toolName: req.toolName,
      callId: req.callId ?? null,
      reason: req.reason ?? null,
      createdAt: new Date().toISOString(),
      req,
      settle: undefined,
      timer: null,
      onAbort: null,
    }
    const promise = new Promise((resolve) => { entry.settle = resolve })
    pending.set(id, entry)
    logger('审批等待决定: ' + id + ' tool=' + req.toolName)

    entry.timer = setTimeout(() => {
      if (settle(id, undefined)) logger('审批超时，交回默认链: ' + id)
    }, DECISION_TIMEOUT_MS())
    entry.onAbort = () => { settle(id, 'cancelled') }
    req.signal?.addEventListener('abort', entry.onAbort, { once: true })

    const outcome = await promise
    // 有决定 → 短路回答；超时（undefined）→ 委托后续 answerer（fail-closed）
    return outcome === undefined ? next() : outcome
  })

  function handlePending(req, res) {
    json(res, 200, {
      ok: true,
      pending: [...pending.values()].map((e) => ({
        id: e.id, toolName: e.toolName, callId: e.callId, reason: e.reason, createdAt: e.createdAt,
      })),
    })
  }

  async function handleDecision(req, res, id) {
    const body = await readJsonBody(req, 16 * 1024).catch((e) => { json(res, e.status || 400, { ok: false, error: e.message }); return null })
    if (body === null) return
    const decision = body.decision
    if (decision !== 'allowed-once' && decision !== 'rejected') {
      json(res, 400, { ok: false, error: 'decision 必须是 allowed-once 或 rejected' })
      return
    }
    if (!pending.has(id)) {
      json(res, 404, { ok: false, error: '审批不存在或已结束: ' + id })
      return
    }
    settle(id, decision)
    logger('审批已决定: ' + id + ' → ' + decision)
    json(res, 200, { ok: true, id, decision })
  }

  const ROUTES = [
    ['GET', /^\/approvals\/pending$/, handlePending],
    ['POST', /^\/approvals\/([^/]+)\/decision$/, handleDecision],
  ]

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/approvals',
    handler: (req, res) => {
      const pathname = new URL(req.url || '/', 'http://x').pathname
      const method = req.method || 'GET'
      for (const [m, re, handler] of ROUTES) {
        if (method !== m) continue
        const match = re.exec(pathname)
        if (match) { handler(req, res, match[1]); return }
      }
      json(res, 404, { ok: false, error: 'not found' })
    },
  }))

  ctx.effect(() => () => {
    // 插件卸载：所有未决定请求交回默认链，不留悬挂 promise
    for (const id of [...pending.keys()]) settle(id, undefined)
  })
}
