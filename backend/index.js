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
import { createSessionStore, validSessionId, ownedApprovals } from './session-ownership.mjs'
import { selectAnswer, createAnswerShareStore } from './answer-actions.mjs'
import { createChatAttachmentStore, validateAttachments } from './chat-attachments.mjs'
import { createSkillsStore, parseSkillMarkdown } from './skills-store.mjs'
import { loadStarterSkills, STARTER_SKILLS_BUNDLE } from './starter-skills.mjs'
import { parseSkillArchive, SKILL_ARCHIVE_LIMITS } from './skill-archive.mjs'
import { createVoiceProxy } from './voice-proxy.mjs'
import { createDocumentStore } from './documents.mjs'
import { createKbSourceStore } from './kb-sources.mjs'

const execFileAsync = promisify(execFile)

const here = path.dirname(fileURLToPath(import.meta.url))

// 统一环境配置：backend/.env（模板 .env.example）。启动时注入 process.env 并随子进程透传；
// 已存在的同名环境变量优先（process.loadEnvFile 不覆盖既有值）。
try { process.loadEnvFile(path.join(here, '.env')) } catch { /* 缺 backend/.env：沿用下方内置默认值 */ }

const PORT = Number(process.env.PORT) || 3088
const voiceProxy = createVoiceProxy({ identify: portalIdentity })
const HOST = process.env.HOST || '127.0.0.1'
const CHILD_HTTP = `http://127.0.0.1:${process.env.DSH_CHILD_HTTP_PORT || 3090}`
const PROFILE = process.env.DSH_PROFILE || 'rag-kb'
const WORKSPACE_CWD = path.resolve(here, '..') // 工作区根：kb_ingest file_path 边界与 {{cwd}}
const SPOOL_DIR = path.join(here, '.spool')
const chatAttachments = createChatAttachmentStore(SPOOL_DIR)
const DSH_HOME = path.resolve(here, process.env.DSH_HOME_DIR || 'dsh/home') // settings/profiles/sessions
const answerShares = createAnswerShareStore(path.join(DSH_HOME, 'storages', 'answer-shares'))
const SKILLS_DIR = path.join(DSH_HOME, 'storages', 'personal-skills')
const skillsStore = createSkillsStore(SKILLS_DIR)
const starterSkills = loadStarterSkills()
const documents = createDocumentStore(WORKSPACE_CWD)
// 引用文件来自 LightRAG 原料区，按引用名定位原始文档，供右侧面板直接预览。
const kbSources = createKbSourceStore(process.env.KB_LIGHTRAG_INPUTS_DIR)

/** 内联预览按扩展名返回内容类型，HTML 演示文稿才能正常渲染并加载其图片。 */
const PREVIEW_MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
}

const sessionStore = await createSessionStore({ sqlitePath: path.join(DSH_HOME, 'storages', 'chat-sessions.sqlite') })
const approvalCalls = new Map()

/**
 * 历史文档归属回填：只为尚未登记的文档按生成时间找会话，已有归属保持不变。
 * 没有归属的旧文档会在升级后从文档面板消失，因此启动时补齐一次。
 */
async function backfillDocumentOwnership() {
  const sessions = await sessionStore.sessions()
  if (!sessions.length) return
  const known = new Set(await sessionStore.documentPaths())
  let owned = 0
  for (const doc of documents.list(0)) {
    if (known.has(doc.path)) continue
    // 优先落在生成时间所属的会话窗口内，否则退回归档时间之前最近创建的会话。
    const owner = sessions
      .filter((s) => doc.mtime >= s.createdAt - 5000 && doc.mtime <= s.updatedAt + 30 * 60 * 1000)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
      ?? sessions.filter((s) => doc.mtime >= s.createdAt - 5000).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!owner) continue
    await sessionStore.recordDocuments(owner.sessionId, [doc])
    known.add(doc.path)
    owned += 1
  }
  if (owned) log(`已回填 ${owned} 份历史文档的会话归属`)
}

function log(msg) { console.log('[rag-kb-server] ' + msg) }
await backfillDocumentOwnership()

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
      model: process.env.LLM_MODEL || 'qwen3.8-flash',
      // 与宿主 GUI 的 agent-default-model.reasoningEffort 保持一致：没有它模型不回传思考（reasoning 块）
      // off=关闭思考（最快），high=开启思考；档位需在 settings.yaml 对应模型的 reasoningEfforts 中声明
      reasoningEffort: process.env.LLM_REASONING_EFFORT || 'off',
      env: {
        ...process.env,
        KB_ALLOWED_PATHS: SPOOL_DIR,
        HARNESS_SKILLS_DIR: SKILLS_DIR,
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

function json(res, code, data, headers = {}) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers })
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

async function handleChatStream(req, res) {
  let body
  try {
    body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
  } catch (e) {
    return json(res, e.status || 400, { ok: false, error: e.status === 413 ? '请求体过大' : '请求体不是合法 JSON' })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: '请求体必须是对象' })
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return json(res, 400, { ok: false, error: 'message 不能为空' })
  validateAttachments(body.attachments)
  const uid = req.identity.uid
  const sessionId = body.sessionId || await sessionStore.create(uid, message)
  await sessionStore.require(uid, sessionId)
  await sessionStore.touch(uid, sessionId)
  if (activeRuns.has(sessionId)) return json(res, 409, { ok: false, error: '该会话正在处理上一条消息，请稍候' })
  let attachmentTurn = chatAttachments.save(sessionId, message, body.attachments)
  activeRuns.add(sessionId)

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
    activeRuns.delete(sessionId)
    send('error', { message: 'dsh 子进程启动失败：' + (e && e.message ? e.message : e) })
    return res.end()
  }
  send('start', { sessionId, attachments: attachmentTurn.attachments })

  let closed = false
  res.on('close', () => { closed = true })

  const runOnce = async (handle, id) => {
    skillsStore.seed(uid, starterSkills, STARTER_SKILLS_BUNDLE)
    skillsStore.bindSession(uid, id)
    // 只登记本轮真正新增或改写的文档，文档面板按会话隔离展示。
    const before = documents.snapshot()
    const result = await handle.run(attachmentTurn.content, {
      onNotification: (n) => {
        const event = n.params?.event
        if (event?.type === 'tool/call' && event.data?.callId) approvalCalls.set(event.data.callId, { uid, sessionId: id })
        // token 级增量（SDK 补丁转发的 agent/assistant-delta）：走专用 SSE 事件，
        // 并按 sessionId 精确匹配本轮，排除子代理与后台会话的流
        if (n.method === 'agent/assistant-delta') {
          const text = n.params?.text
          if (!closed && n.params?.sessionId === id && typeof text === 'string' && text) {
            send('delta', { sessionId: id, kind: n.params.kind === 'reasoning' ? 'reasoning' : 'text', text })
          }
          return
        }
        if (!closed) send('notification', n)
      },
    })
    try {
      await sessionStore.recordDocuments(id, documents.changedSince(before))
      await sessionStore.touch(uid, id)
    } catch (error) {
      log('文档归属登记失败 ' + id + '：' + (error && error.message ? error.message : error))
    }
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
      const previous = await sessionStore.require(uid, sessionId)
      const newId = await sessionStore.create(uid, previous.title)
      sessions.delete(sessionId)
      sessionAlias.set(sessionId, newId)
      try {
        const migrated = await getSession(newId)
        attachmentTurn = chatAttachments.save(newId, message, body.attachments)
        send('renamed', { from: sessionId, to: newId, attachments: attachmentTurn.attachments })
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
    for (const [callId, run] of approvalCalls) if (run.uid === uid && (run.sessionId === sessionId || run.sessionId === sessionAlias.get(sessionId))) approvalCalls.delete(callId)
    res.end()
  }
}

// ---------------------------------------------------------------- 路由

/** 在 backend/dsh/home/sessions 的工作区目录下定位会话日志（工作区哈希目录名不猜测，全量扫描）。 */
function findSessionFile(sessionId) {
  validSessionId(sessionId)
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
function projectHistory(events, sessionId) {
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
        // 图谱结构化数据：GRAPH_CONTEXT HTML 注释注入在 render 文本末尾，
        // 需要从完整 resultText（截断前）提取，避免 4000 字符截断丢数据。
        const gcMatch = resultText.match(/<!--GRAPH_CONTEXT:(.+?)-->/)
        if (gcMatch) {
          try { out[idx].graphContext = JSON.parse(gcMatch[1]) } catch { /* 解析失败静默跳过 */ }
        }
        if (out[idx].name === 'lightrag_query_data' && !block?.isError) {
          try { out[idx].queryId = JSON.parse(resultText).query_id || null } catch {
            out[idx].queryId = resultText.match(/查询\s*id[：:]\s*([\w-]+)/i)?.[1] || null
          }
          // 引用行在长文本末尾，先于截断从完整结果里取出来，历史回放才能展示检索来源。
          const rendered = resultText.match(/(?:^|\n)引用[：:]\s*([^\n]+)/)?.[1]
          out[idx].references = rendered ? rendered.split('、').map((file) => file.trim()).filter(Boolean) : []
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
      case 'compaction/start': {
        out.push({ seq: e.seq, time: e.time, kind: 'compaction', status: 'running', message: '' })
        break
      }
      case 'compaction/end': {
        const idx = out.findLastIndex((item) => item.kind === 'compaction' && item.status === 'running')
        if (idx < 0) break
        const message = typeof d.error === 'string' ? d.error : d.error?.message || ''
        out[idx].status = message ? 'error' : 'done'
        out[idx].message = message
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
  return sessionId ? chatAttachments.project(sessionId, out) : out
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x')
  const p = url.pathname
  try {
    if (req.method === 'GET' && p === '/api/auth/check') return await checkPortalSession(req, res)
    if (p.startsWith('/api/') && p !== '/api/health') {
      req.identity = await portalIdentity(req)
      res.setHeader('Cache-Control', 'no-store')
      if (!['GET', 'HEAD'].includes(req.method) && process.env.NODE_ENV === 'production' && req.headers['x-harness-request'] !== '1') return json(res, 403, { ok: false, error: '请求来源无效' })
    }
    if (p === '/api/auth/me' && req.method === 'GET') return json(res, 200, { authenticated: true, user: req.identity })
    if (await voiceProxy.handle(req, res, p)) return
    if (p === '/api/chat/skills' && req.method === 'GET') return json(res, 200, { ok: true, ...skillsStore.seed(req.identity.uid, starterSkills, STARTER_SKILLS_BUNDLE) })
    if (p === '/api/chat/skills/imports' && req.method === 'POST') {
      const archive = await parseSkillArchive(await readBody(req, SKILL_ARCHIVE_LIMITS.compressed), parseSkillMarkdown)
      return json(res, 201, { ok: true, preview: skillsStore.stageImport(req.identity.uid, archive, url.searchParams.get('name') || 'skills.zip') })
    }
    const importMatch = p.match(/^\/api\/chat\/skills\/imports\/([a-f0-9-]{36})$/)
    if (importMatch && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'))
      return json(res, 200, { ok: true, skills: skillsStore.installImport(req.identity.uid, importMatch[1], body?.replacements) })
    }
    if (importMatch && req.method === 'DELETE') {
      skillsStore.discardImport(req.identity.uid, importMatch[1])
      return json(res, 200, { ok: true })
    }
    const skillFilesMatch = p.match(/^\/api\/chat\/skills\/([a-f0-9-]{36})\/(files|file)$/)
    if (skillFilesMatch && req.method === 'GET') {
      if (skillFilesMatch[2] === 'files') return json(res, 200, { ok: true, files: skillsStore.files(req.identity.uid, skillFilesMatch[1]) })
      const file = skillsStore.file(req.identity.uid, skillFilesMatch[1], url.searchParams.get('path'))
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' })
      const stream = fs.createReadStream(file.path)
      stream.on('error', () => res.destroy())
      return stream.pipe(res)
    }
    if (p === '/api/chat/skills/parse' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 160 * 1024)).toString('utf8'))
      return json(res, 200, { ok: true, skill: parseSkillMarkdown(body?.markdown) })
    }
    if (p === '/api/chat/skills' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 160 * 1024)).toString('utf8'))
      return json(res, 201, { ok: true, skill: skillsStore.save(req.identity.uid, body) })
    }
    const skillMatch = p.match(/^\/api\/chat\/skills\/([a-f0-9-]{36})$/)
    if (skillMatch && ['PUT', 'DELETE'].includes(req.method)) {
      const body = JSON.parse((await readBody(req, 160 * 1024)).toString('utf8'))
      if (req.method === 'PUT') return json(res, 200, { ok: true, skill: skillsStore.save(req.identity.uid, body, skillMatch[1]) })
      skillsStore.remove(req.identity.uid, skillMatch[1], body?.version)
      return json(res, 200, { ok: true })
    }
    if (p === '/api/chat/sessions' && req.method === 'GET') {
      // running 让会话列表能标出后台仍在执行的会话，切走再切回也看得见。
      const sessions = (await sessionStore.list(req.identity.uid)).map((item) => ({ ...item, running: activeRuns.has(item.sessionId) }))
      return json(res, 200, { ok: true, sessions })
    }
    if (p === '/api/chat/sessions' && req.method === 'DELETE') {
      await sessionStore.clear(req.identity.uid)
      return json(res, 200, { ok: true })
    }
    if (p.startsWith('/api/chat/sessions/') && req.method === 'DELETE') {
      await sessionStore.remove(req.identity.uid, decodeURIComponent(p.slice('/api/chat/sessions/'.length)))
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && p === '/api/chat/stream') return await handleChatStream(req, res)

    if (p === '/api/chat/documents' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') || ''
      if (!sessionId) return json(res, 400, { ok: false, error: '缺少会话标识' })
      await sessionStore.require(req.identity.uid, sessionId)
      // 只列登记到本会话的文档，其他会话生成的文件不会串进来。
      const listed = []
      for (const row of await sessionStore.listDocuments(sessionId)) {
        try {
          documents.resolve(row.path)
        } catch {
          continue // 文件已被删除或移出工作区，跳过失效记录。
        }
        listed.push({ ...row, ext: path.extname(row.path).slice(1).toLowerCase() })
      }
      return json(res, 200, { ok: true, documents: listed }, { 'cache-control': 'no-store' })
    }

    if (p === '/api/chat/documents/file' && req.method === 'GET') {
      await sessionStore.require(req.identity.uid, url.searchParams.get('sessionId') || '')
      const file = documents.resolve(url.searchParams.get('path') || '')
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': file.size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      })
      const stream = fs.createReadStream(file.path)
      stream.on('error', () => res.destroy())
      return stream.pipe(res)
    }

    // 内联预览：会话标识放在路径里，HTML 引用的同目录图片/样式才会按相对路径命中同一路由。
    const viewMatch = p.match(/^\/api\/chat\/doc-view\/([^/]+)\/(.+)$/)
    if (req.method === 'GET' && viewMatch) {
      await sessionStore.require(req.identity.uid, decodeURIComponent(viewMatch[1]))
      const file = documents.resolveAsset(decodeURIComponent(viewMatch[2]))
      res.writeHead(200, {
        'content-type': PREVIEW_MIME[path.extname(file.name).slice(1).toLowerCase()] || 'application/octet-stream',
        'content-length': file.size,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      })
      const stream = fs.createReadStream(file.path)
      stream.on('error', () => res.destroy())
      return stream.pipe(res)
    }

    if (p === '/api/chat/source/file' && req.method === 'GET') {
      await sessionStore.require(req.identity.uid, url.searchParams.get('sessionId') || '')
      const requested = url.searchParams.get('file') || ''
      const file = kbSources.resolve(requested)
      // 生产排查「个别引用文件打不开」的关键证据：记下定位失败时的原始引用名。
      if (!file) log(`引用文件定位失败：${JSON.stringify(requested)}`)
      if (!file) return json(res, 404, { ok: false, error: '知识库中没有找到该引用文件' })
      const download = url.searchParams.get('download') === '1'
      res.writeHead(200, {
        'content-type': kbSources.mime(file.ext),
        'content-length': file.size,
        ...(download
          ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` }
          : {}),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      })
      const stream = fs.createReadStream(file.path)
      stream.on('error', () => res.destroy())
      return stream.pipe(res)
    }

    if (req.method === 'GET' && /^\/api\/chat\/attachments\/([^/]+)\/([^/]+)$/.test(p)) {
      const [, sessionId, id] = p.match(/^\/api\/chat\/attachments\/([^/]+)\/([^/]+)$/)
      await sessionStore.require(req.identity.uid, sessionId)
      const item = chatAttachments.file(sessionId, id)
      const download = url.searchParams.get('download') === '1'
      res.writeHead(200, {
        'content-type': download ? 'application/octet-stream' : item.contentType,
        'content-length': item.size,
        'content-disposition': `${download || !item.inline ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
        'x-content-type-options': 'nosniff',
        ...(!item.inline ? { 'content-security-policy': "sandbox" } : {}),
      })
      const stream = fs.createReadStream(item.path)
      stream.on('error', () => res.destroy())
      return stream.pipe(res)
    }

    if (p === '/api/chat/feedback/records' && req.method === 'GET') {
      const qs = new URLSearchParams({ actor: req.identity.username })
      const [r, owned] = await Promise.all([
        proxy('/kb/feedback/answers?' + qs, req, null),
        sessionStore.list(req.identity.uid, { all: true }),
      ])
      const data = JSON.parse(r.body.toString('utf8'))
      if (r.status !== 200 || data.ok !== true) return json(res, r.status, data)
      const titles = new Map(owned.map(item => [item.sessionId, item.title]))
      const records = data.records
        .filter(row => titles.has(row.session_id) && Number.isSafeInteger(Number(row.message_id)))
        .map(row => ({ id: row.feedback_id, sessionId: row.session_id, messageSeq: Number(row.message_id),
          sessionTitle: titles.get(row.session_id), question: row.query, answer: row.answer,
          rating: row.rating === 'positive' ? 'up' : 'down', note: row.note || '', createdAt: row.created_at,
          updatedAt: row.updated_at || row.created_at }))
      return json(res, 200, { ok: true, records })
    }

    const feedbackRecord = p.match(/^\/api\/chat\/feedback\/records\/([\w-]{1,200})$/)
    if (feedbackRecord && ['PATCH', 'DELETE'].includes(req.method)) {
      let body
      try { body = JSON.parse((await readBody(req, 32 * 1024)).toString('utf8')) } catch (error) {
        return json(res, error.status || 400, { ok: false, error: '请求体不是合法 JSON' })
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: '请求体必须是对象' })
      await sessionStore.require(req.identity.uid, body.sessionId)
      if (req.method === 'PATCH' && (typeof body.note !== 'string' || body.note.length > 4000)) {
        return json(res, 400, { ok: false, error: '备注须为不超过 4000 字的文本' })
      }
      const payload = Buffer.from(JSON.stringify({ actor: req.identity.username, session_id: body.sessionId,
        ...(req.method === 'PATCH' ? { note: body.note } : {}) }))
      const r = await proxy('/kb/feedback/answers/' + feedbackRecord[1], req, payload)
      return json(res, r.status, JSON.parse(r.body.toString('utf8')))
    }

    if (p === '/api/chat/feedback' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      const actor = req.identity.username
      const sessionId = url.searchParams.get('sessionId') || ''
      if (!/^[\w-]{1,200}$/.test(sessionId)) return json(res, 400, { ok: false, error: '会话标识无效' })
      await sessionStore.require(req.identity.uid, sessionId)
      const qs = new URLSearchParams({ session_id: sessionId, actor })
      const r = await proxy('/kb/feedback/votes?' + qs, req, null)
      return json(res, r.status, JSON.parse(r.body.toString('utf8')))
    }

    if (req.method === 'POST' && (p === '/api/chat/feedback' || p === '/api/chat/shares')) {
      const actor = req.identity.username
      let body
      try { body = JSON.parse((await readBody(req, 8192)).toString('utf8')) } catch (error) {
        return json(res, error.status || 400, { ok: false, error: '请求体不是合法 JSON' })
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: '请求体必须是对象' })
      if (!/^[\w-]{1,200}$/.test(body.sessionId || '')) return json(res, 400, { ok: false, error: '会话标识无效' })
      await sessionStore.require(req.identity.uid, body.sessionId)
      const history = await readSessionEvents(body.sessionId)
      const answer = selectAnswer(history ? projectHistory(history, body.sessionId) : [], body.sessionId, body.messageSeq)
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
      res.setHeader('Cache-Control', 'no-store')
      return json(res, 200, { ok: true, share: answerShares.get(p.slice('/api/chat/shares/'.length)) })
    }

    if (req.method === 'GET' && p === '/api/chat/history') {
      const sessionId = String(url.searchParams.get('sessionId') || '')
      if (!sessionId) return json(res, 400, { ok: false, error: 'sessionId 必填' })
      await sessionStore.require(req.identity.uid, sessionId)
      const events = await readSessionEvents(sessionId)
      return json(res, 200, { sessionId, events: events ? projectHistory(events, sessionId) : [] })
    }

    if (p === '/api/approvals/pending' && req.method === 'GET') {
      const r = await proxy('/approvals/pending', req, null)
      const data = JSON.parse(r.body.toString('utf8') || '{}')
      data.pending = await ownedApprovals(sessionStore, req.identity.uid, data.pending || [], approvalCalls)
      return json(res, r.status, data)
    }

    if (req.method === 'POST' && /^\/api\/approvals\/([^/]+)\/decision$/.test(p)) {
      const id = p.split('/')[3]
      const pendingResponse = await proxy('/approvals/pending', { method: 'GET' }, null)
      if (pendingResponse.status !== 200) return json(res, 503, { ok: false, error: '审批服务暂不可用' })
      const pending = JSON.parse(pendingResponse.body.toString('utf8')).pending || []
      const owned = await ownedApprovals(sessionStore, req.identity.uid, pending, approvalCalls)
      if (!owned.some(item => item.id === id)) return json(res, 404, { ok: false, error: '审批不存在' })
      const body = await readBody(req, 8192)
      const r = await proxy('/approvals/' + encodeURIComponent(id) + '/decision', req, body)
      return json(res, r.status, JSON.parse(r.body.toString('utf8') || '{}'))
    }

    // User identity for answer votes must be established by the adapter above.
    if (/^\/api\/kb\/feedback(?:\/|$)/.test(p)) return json(res, 404, { ok: false, error: 'not found' })
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
    if (!res.headersSent) json(res, e instanceof SyntaxError ? 400 : e && e.status ? e.status : 502, { ok: false, error: e instanceof SyntaxError ? '请求体不是合法 JSON' : String(e && e.message ? e.message : e) })
    else res.end()
  }
})

server.on('upgrade', (req, socket, head) => { void voiceProxy.upgrade(req, socket, head) })

server.listen(PORT, HOST, () => {
  log('适配层就绪 http://' + HOST + ':' + PORT + '（子进程 HTTP ' + CHILD_HTTP + '，工作区 ' + WORKSPACE_CWD + '）')
  // 预热子进程：3090 通道（/kb/* 与 /approvals/*）常在，聊天首条消息不再等 spawn
  getHarness().catch((e) => log('子进程预热失败（聊天时重试）: ' + (e && e.message ? e.message : e)))
})

async function shutdown() {
  log('关闭中…')
  voiceProxy.close()
  server.close()
  try { if (harnessPromise) await (await harnessPromise).close() } catch (e) { log('子进程关闭异常: ' + (e && e.message)) }
  await sessionStore.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
