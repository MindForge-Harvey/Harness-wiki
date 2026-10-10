/**
 * rag-kb 适配层：浏览器与 dsh 子进程（profile rag-kb）之间的桥。
 *
 * 一个 dsh 子进程两个通道：
 *  - stdio JSON-RPC（@deepseek-ai/dsh-sdk-client）：聊天（agent loop + 模型工具）
 *  - HTTP 127.0.0.1:3090：/kb/*（dsh-knowledge）与 /approvals/*（审批桥接）
 *
 * 路由：
 *  - POST /api/chat/stream        SSE 聊天（session 事件原样转发，idle 结束）
 *  - POST /api/approvals/:id/decision  审批决定转发到子进程
 *  - ALL  /api/kb/*               透传子进程 /kb/* REST（反馈/健康/图片等）
 *  - GET  /api/health             适配层自身健康
 *
 * 运行：node backend/index.js。端口/profile/模型/知识库路径统一在 backend/.env 配置。
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { checkPortalSession, portalIdentity } from './portal-session.mjs'
import { selectAnswer, createAnswerShareStore } from './answer-actions.mjs'

const execFileAsync = promisify(execFile)

const here = path.dirname(fileURLToPath(import.meta.url))

// 统一环境配置：backend/.env（模板 .env.example）。启动时注入 process.env 并随子进程透传；
// 已存在的同名环境变量优先（process.loadEnvFile 不覆盖既有值）。
try { process.loadEnvFile(path.join(here, '.env')) } catch { /* 缺 backend/.env：沿用下方内置默认值 */ }

const PORT = Number(process.env.PORT) || 3088
const HOST = '127.0.0.1'
const CHILD_HTTP = `http://127.0.0.1:${process.env.DSH_CHILD_HTTP_PORT || 3090}`
const PROFILE = process.env.DSH_PROFILE || 'rag-kb'
const WORKSPACE_CWD = path.resolve(here, '..') // 工作区根：kb_ingest file_path 边界与 {{cwd}}
const SPOOL_DIR = path.join(here, '.spool')
const DSH_HOME = path.resolve(here, process.env.DSH_HOME_DIR || 'dsh/home') // settings/profiles/sessions
const answerShares = createAnswerShareStore(path.join(DSH_HOME, 'storages', 'answer-shares'))

function log(msg) { console.log('[rag-kb-server] ' + msg) }

// ---------------------------------------------------------------- harness 单例与会话表

let harnessPromise = null

function getHarness() {
  harnessPromise ??= (async () => {
    const harness = new DeepSeekHarness({
      profile: PROFILE,
      cwd: WORKSPACE_CWD,
      // backend/.env 由适配层加载并透传；避免 CLI 再从该目录读取启动变量。
      processCwd: WORKSPACE_CWD,
      dshHome: DSH_HOME,
      // 模型路由与 key 均来自 backend/.env（provider 对应 dsh/home/settings.yaml 的 providers 项）
      provider: process.env.LLM_PROVIDER || 'qwen-token-plan',
      model: process.env.LLM_MODEL || 'glm-5.2',
      // 与宿主 GUI 的 agent-default-model.reasoningEffort 保持一致：没有它模型不回传思考（reasoning 块）
      reasoningEffort: process.env.LLM_REASONING_EFFORT || 'max',
      env: {
        ...process.env,
        KB_ALLOWED_PATHS: SPOOL_DIR,
      },
    })
    await harness.start()
    log('dsh 子进程就绪（profile ' + PROFILE + '）')
    return harness
  })().catch((e) => {
    harnessPromise = null // 失败可重试
    throw e
  })
  return harnessPromise
}

/** sessionId → HarnessSession。resume 用同一 id 重建轻量 handle。 */
const sessions = new Map()
/** 旧会话 id → 迁移后的新 id。子进程重启后磁盘日志已存在同名会话，create 撞车时迁移。 */
const sessionAlias = new Map()
const activeRuns = new Set()

async function getSession(sessionId) {
  const harness = await getHarness()
  const target = sessionAlias.get(sessionId) ?? sessionId
  if (!sessions.has(target)) sessions.set(target, harness.session(target))
  return sessions.get(target)
}

// ---------------------------------------------------------------- HTTP 基础

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 转发请求到子进程 HTTP（/kb/*、/approvals/*），原样回传状态与响应体。子进程未监听时先拉起再重试一次。 */
function proxy(childPath, req, bodyBuffer) {
  const attempt = () => new Promise((resolve, reject) => {
    const upstream = new URL(CHILD_HTTP + childPath)
    const r = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      path: upstream.pathname + upstream.search,
      method: req.method,
      headers: { 'content-type': 'application/json', 'content-length': bodyBuffer ? bodyBuffer.length : 0 },
    }, (resp) => {
      const chunks = []
      resp.on('data', (c) => chunks.push(c))
      resp.on('end', () => resolve({ status: resp.statusCode, contentType: resp.headers['content-type'] || 'application/json', body: Buffer.concat(chunks) }))
    })
    r.on('error', reject)
    if (bodyBuffer && bodyBuffer.length) r.write(bodyBuffer)
    r.end()
  })
  return attempt().catch(async (e) => {
    if (!/ECONNREFUSED/i.test(String(e && e.code || e))) throw e
    await getHarness()
    return attempt()
  })
}

// ---------------------------------------------------------------- SSE 聊天

/** 附件落 spool，返回给模型看的路径说明（kb_ingest file_path 走审批）。 */
function saveAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return []
  fs.mkdirSync(SPOOL_DIR, { recursive: true })
  return attachments.map((a) => {
    const safe = String(a.name || 'attachment').replace(/[/\\]/g, '_')
    const filePath = path.join(SPOOL_DIR, Date.now() + '-' + safe)
    fs.writeFileSync(filePath, Buffer.from(a.data || '', 'base64'))
    return filePath
  })
}

async function handleChatStream(req, res) {
  let body
  try {
    body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
  } catch (e) {
    return json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
  }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return json(res, 400, { ok: false, error: 'message 不能为空' })
  const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : `session-${crypto.randomUUID().replaceAll('-', '')}`
  if (activeRuns.has(sessionId)) return json(res, 409, { ok: false, error: '该会话正在处理上一条消息，请稍候' })

  const attachmentPaths = saveAttachments(body.attachments)
  const prompt = attachmentPaths.length
    ? message + '\n\n（用户随消息上传了 ' + attachmentPaths.length + ' 个文件，已保存到本地：'
      + attachmentPaths.join('；') + '。若用户想将其加入知识库，请用 kb_ingest 处理。）'
    : message

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const send = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')

  let session
  try {
    session = await getSession(sessionId)
  } catch (e) {
    return send('error', { message: 'dsh 子进程启动失败：' + (e && e.message ? e.message : e) })
  }
  send('start', { sessionId })

  activeRuns.add(sessionId)
  let closed = false
  req.on('close', () => { closed = true })

  const runOnce = async (handle, id) => {
    const result = await handle.run(prompt, {
      onNotification: (n) => {
        if (!closed) send('notification', n)
      },
    })
    if (!closed) send('done', { sessionId: id, finalResponse: result.finalResponse })
    log('run 完成 ' + id + '（' + result.events.length + ' 事件）')
  }

  try {
    await runOnce(session, sessionId)
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    // 适配层/子进程重启后，旧会话日志已在磁盘上，create 同名 id 直接撞车。
    // 兜底：迁移到全新 id 重跑，并通过 renamed 事件让前端同步本地会话表（上下文重新开始）。
    if (!closed && msg.includes('already exists')) {
      const newId = `session-${crypto.randomUUID().replaceAll('-', '')}`
      sessions.delete(sessionId)
      sessionAlias.set(sessionId, newId)
      try {
        const migrated = await getSession(newId)
        send('renamed', { from: sessionId, to: newId })
        log('会话迁移 ' + sessionId + ' → ' + newId)
        await runOnce(migrated, newId)
      } catch (e2) {
        if (!closed) send('error', { message: String(e2 && e2.message ? e2.message : e2) })
        log('run 失败（迁移后）' + newId + ': ' + (e2 && e2.message ? e2.message : e2))
      }
    } else {
      if (!closed) send('error', { message: msg })
      log('run 失败 ' + sessionId + ': ' + msg)
    }
  } finally {
    activeRuns.delete(sessionId)
    res.end()
  }
}

// ---------------------------------------------------------------- 路由

/** 在 backend/dsh/home/sessions 的工作区目录下定位会话日志（工作区哈希目录名不猜测，全量扫描）。 */
function findSessionFile(sessionId) {
  const root = path.join(DSH_HOME, 'sessions')
  let workspaces
  try {
    workspaces = fs.readdirSync(root)
  } catch {
    return null
  }
  for (const ws of workspaces) {
    const dir = path.join(root, ws, sessionId)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const zstd = path.join(dir, 'session.v3.jsonl.zstd')
    if (fs.existsSync(zstd)) return zstd
    const plain = path.join(dir, 'session.v3.jsonl')
    if (fs.existsSync(plain)) return plain
  }
  return null
}

/** 读取并解析会话日志（zstd 多帧由系统 zstd CLI 解压）。 */
async function readSessionEvents(sessionId) {
  const file = findSessionFile(sessionId)
  if (!file) return null
  let text
  if (file.endsWith('.zstd')) {
    text = (await execFileAsync('zstd', ['-dc', file], { maxBuffer: 128 * 1024 * 1024 })).stdout.toString('utf8')
  } else {
    text = fs.readFileSync(file, 'utf8')
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** 把会话日志投影为前端可渲染的展示事件（user/assistant/thinking/tool/approval/error）。 */
function projectHistory(events) {
  const toolIndexByCall = new Map()
  const pendingApprovals = []
  const out = []
  const textOf = (blocks) => (blocks || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('')

  for (const e of events) {
    const d = e.data || {}
    switch (e.type) {
      case 'user/message': {
        if (d.source?.kind !== 'user') break
        out.push({ seq: e.seq, time: e.time, kind: 'user', text: textOf(d.content) })
        break
      }
      case 'assistant/message': {
        const blocks = d.message?.content || []
        const reasoning = blocks.filter((b) => b && b.type === 'reasoning').map((b) => b.text).join('\n\n')
        const text = textOf(blocks)
        if (reasoning) out.push({ seq: e.seq, time: e.time, kind: 'thinking', text: reasoning })
        if (text) out.push({ seq: e.seq, time: e.time, kind: 'assistant', text })
        break
      }
      case 'tool/call': {
        toolIndexByCall.set(d.callId, out.length)
        out.push({ seq: e.seq, time: e.time, kind: 'tool', callId: d.callId, name: d.name || '', argsText: String(d.arguments || ''), status: 'running' })
        break
      }
      case 'tool/result': {
        const block = d.message?.content?.find?.((b) => b && b.type === 'tool-result')
        const idx = block?.toolCallId ? toolIndexByCall.get(block.toolCallId) : undefined
        if (idx === undefined) break
        out[idx].status = block?.isError ? 'error' : 'done'
        const resultText = textOf(block?.content)
        out[idx].resultText = resultText.slice(0, 4000)
        if (out[idx].name === 'lightrag_query_data' && !block?.isError) {
          try { out[idx].queryId = JSON.parse(resultText).query_id || null } catch {
            out[idx].queryId = resultText.match(/查询\s*id[：:]\s*([\w-]+)/i)?.[1] || null
          }
        }
        break
      }
      case 'approval/asked': {
        out.push({ seq: e.seq, time: e.time, kind: 'approval', approvalKey: `approval-${e.seq}`, toolName: d.toolName || '', callId: d.callId || '', reason: d.reason || '', status: 'pending' })
        pendingApprovals.push(out.length - 1)
        break
      }
      case 'approval/decided': {
        const idx = pendingApprovals.shift()
        if (idx !== undefined) out[idx].status = d.outcome === 'allowed-once' ? 'allowed' : 'rejected'
        break
      }
      case 'turn/end': {
        if (d.reason?.kind === 'error') {
          out.push({ seq: e.seq, time: e.time, kind: 'error', message: d.reason?.error?.message || '本轮执行失败' })
        }
        break
      }
      default:
        break
    }
  }
  return out
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x')
  const p = url.pathname
  try {
    if (req.method === 'GET' && p === '/api/auth/check') return await checkPortalSession(req, res)
    if (req.method === 'POST' && p === '/api/chat/stream') return await handleChatStream(req, res)

    if (p === '/api/chat/feedback' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      const actor = (await portalIdentity(req)).username
      const sessionId = url.searchParams.get('sessionId') || ''
      if (!/^[\w-]{1,200}$/.test(sessionId)) return json(res, 400, { ok: false, error: '会话标识无效' })
      const qs = new URLSearchParams({ session_id: sessionId, actor })
      const r = await proxy('/kb/feedback/votes?' + qs, req, null)
      return json(res, r.status, JSON.parse(r.body.toString('utf8')))
    }

    if (req.method === 'POST' && (p === '/api/chat/feedback' || p === '/api/chat/shares')) {
      const actor = (await portalIdentity(req)).username
      let body
      try { body = JSON.parse((await readBody(req, 8192)).toString('utf8')) } catch (error) {
        return json(res, error.status || 400, { ok: false, error: '请求体不是合法 JSON' })
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: '请求体必须是对象' })
      if (!/^[\w-]{1,200}$/.test(body.sessionId || '')) return json(res, 400, { ok: false, error: '会话标识无效' })
      const history = await readSessionEvents(body.sessionId)
      const answer = selectAnswer(history ? projectHistory(history) : [], body.sessionId, body.messageSeq)
      res.setHeader('Cache-Control', 'no-store')
      if (p === '/api/chat/shares') return json(res, 201, { ok: true, share: answerShares.create(answer) })
      if (![null, 'up', 'down'].includes(body.rating)) return json(res, 400, { ok: false, error: '反馈选项无效' })
      const payload = Buffer.from(JSON.stringify({ actor, session_id: answer.sessionId, message_id: String(answer.messageSeq),
        query_id: answer.queryId, query: answer.question, answer: answer.answer,
        rating: body.rating === null ? null : body.rating === 'up' ? 'positive' : 'negative' }))
      const r = await proxy('/kb/feedback/vote', { method: 'POST' }, payload)
      return json(res, r.status, JSON.parse(r.body.toString('utf8')))
    }

    if (req.method === 'GET' && p.startsWith('/api/chat/shares/')) {
      await portalIdentity(req)
      res.setHeader('Cache-Control', 'no-store')
      return json(res, 200, { ok: true, share: answerShares.get(p.slice('/api/chat/shares/'.length)) })
    }

    if (req.method === 'GET' && p === '/api/chat/history') {
      const sessionId = String(url.searchParams.get('sessionId') || '')
      if (!sessionId) return json(res, 400, { ok: false, error: 'sessionId 必填' })
      const events = await readSessionEvents(sessionId)
      return json(res, 200, { sessionId, events: events ? projectHistory(events) : [] })
    }

    if (p === '/api/approvals/pending' && req.method === 'GET') {
      const r = await proxy('/approvals/pending', req, null)
      return json(res, r.status, JSON.parse(r.body.toString('utf8') || '{}'))
    }

    if (req.method === 'POST' && /^\/api\/approvals\/([^/]+)\/decision$/.test(p)) {
      const id = p.split('/')[3]
      const body = await readBody(req)
      const r = await proxy('/approvals/' + encodeURIComponent(id) + '/decision', req, body)
      return json(res, r.status, JSON.parse(r.body.toString('utf8') || '{}'))
    }

    // User identity for answer votes must be established by the adapter above.
    if (/^\/api\/kb\/feedback\/votes?$/.test(p)) return json(res, 404, { ok: false, error: 'not found' })
    if (p.startsWith('/api/kb/')) {
      const body = ['GET', 'HEAD'].includes(req.method) ? null : await readBody(req)
      const qs = url.search
      const r = await proxy('/kb/' + p.slice('/api/kb/'.length) + qs, req, body)
      res.writeHead(r.status, { 'content-type': r.contentType })
      return res.end(r.body)
    }

    if (req.method === 'GET' && p === '/api/health') {
      return json(res, 200, { ok: true, child: activeRuns.size + ' active / ' + sessions.size + ' sessions' })
    }

    json(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    log('请求失败 ' + req.method + ' ' + p + ': ' + (e && e.message ? e.message : e))
    if (!res.headersSent) json(res, e && e.status ? e.status : 502, { ok: false, error: String(e && e.message ? e.message : e) })
    else res.end()
  }
})

server.listen(PORT, HOST, () => {
  log('适配层就绪 http://' + HOST + ':' + PORT + '（子进程 HTTP ' + CHILD_HTTP + '，工作区 ' + WORKSPACE_CWD + '）')
  // 预热子进程：3090 通道（/kb/* 与 /approvals/*）常在，聊天首条消息不再等 spawn
  getHarness().catch((e) => log('子进程预热失败（聊天时重试）: ' + (e && e.message ? e.message : e)))
})

async function shutdown() {
  log('关闭中…')
  server.close()
  try { if (harnessPromise) await (await harnessPromise).close() } catch (e) { log('子进程关闭异常: ' + (e && e.message)) }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
