/**
 * dsh-knowledge v2 · 意图账本 —— 可靠性内核。
 *
 * 设计（对应 v2 重构 P0-1/P0-2/P0-5：内存队列重启即丢、门控中间态）：
 *  - 所有文档类变更先落盘为"意图"（intents.jsonl，WAL 式追加）再执行；
 *    重启后未完成的意图自动恢复继续跑，不再有"说删了没删"的永久分歧。
 *  - 状态机：pending → issuing → issued → verifying → verified / failed / stuck。
 *    stuck = 重试次数耗尽（收敛不动，需人工/告警介入）。
 *  - 引擎单 worker：执行器串行，同一时刻只有一个意图在跑；
 *    删除前必须等管道空闲（忙时删除被静默丢弃，引擎契约怪癖 2）。
 *  - replace 组合操作 = 先删旧（核验消失）再插新（内容寻址产生新 id），
 *    阶段写进意图记录，崩溃恢复从所处阶段继续。
 *  - 图谱写操作不入账本（引擎同步报错，失败即知），由 service 层直调。
 *
 * 文件字节不入 JSONL：入库前先落到 spool/<intentId>.bin，意图引用该路径；
 * 终态后清盘。恢复时 spool 丢失 → 意图转 failed（要求重新提交）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createAppendLog } from './store.js'
import { isPipelineBusy } from './engine-port.js'

const PRIORITY = { user: 2, batch: 1, reconcile: 0 }

export function createIntentLedger({
  dir,
  engine,
  registry,
  logger = () => {},
  pollMs = 3000,
  trackTimeoutMs = 15 * 60 * 1000,
  maxAttempts = 5,
  verifyDelayMs = 10 * 1000,
  scanMaxPages = 40,
}) {
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'spool'), { recursive: true })
  const logPath = path.join(dir, 'intents.jsonl')
  const log = createAppendLog(logPath)

  // id -> 意图当前记录（内存索引；文件为 WAL）
  const intents = new Map()
  for (const row of log.readAll()) intents.set(row.id, row)

  let nextSeq = 0
  let timer = null
  let inFlight = null // 当前执行的意图 id
  let emit = () => {}

  function appendRow(intent) {
    log.append({ ...intent })
  }

  function transition(intent, patch) {
    Object.assign(intent, patch, { updatedAt: new Date().toISOString() })
    intents.set(intent.id, intent)
    appendRow(intent)
    try { emit({ type: 'kb.intent', intent: { ...intent } }) } catch (e) { /* 监听器异常不阻断 */ }
  }

  /** 压缩：终态意图只保留最近 keep 条，非终态全保留。行数超阈值时触发。 */
  function compactIfLarge(keep = 300, threshold = 4000) {
    if (log.length < threshold) return
    const live = [...intents.values()].filter((i) => !isTerminal(i))
    const dead = [...intents.values()].filter((i) => isTerminal(i))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, keep)
    const keepers = new Set([...live, ...dead].map((i) => i.id))
    const dropped = log.compact({ keyOf: (r) => r.id })
    intents.clear()
    for (const i of keepers) intents.set(i.id, i)
    logger('intent ledger compacted: ' + dropped + ' wal rows, kept ' + keepers.size + ' intents')
  }

  function isTerminal(i) { return i.status === 'verified' || i.status === 'failed' || i.status === 'stuck' }

  // ---- 恢复 ----
  // WAL 里每个状态都已是可续跑的安全重启点：pending = 尚未向引擎发请求，直接重发；
  // issued/verifying = track 与 verifyAt 已持久化，恢复后继续核验——重插同 source 会
  // 409（引擎契约怪癖 1），不能盲目回 pending 重发。

  /** 管道是否空闲（删除/插入前必须检查，怪癖 2/3）。 */
  async function pipelineIdle() {
    try {
      const st = await engine.pipelineStatus()
      return !(st && st.busy)
    } catch (e) {
      return false // 状态未知按忙处理，宁可等
    }
  }

  /** 全库扫描定位 docId 是否仍在引擎里（删除核验）。 */
  async function engineHasDoc(docId) {
    for (let page = 1; page <= scanMaxPages; page++) {
      const lr = await engine.listDocuments({ page, page_size: 100 })
      const docs = (lr && lr.documents) || []
      if (docs.some((d) => d.id === docId)) return true
      const total = lr && lr.pagination ? lr.pagination.total_count : null
      if (total === null || page * 100 >= total) return false
    }
    return true // 扫描上限内未见结束：按仍在处理（不误判）
  }

  /**
   * 全库扫描按 source（file_path）定位引擎文档。用于崩溃窗口恢复：
   * 上传已落地但 'issued' 行未及写盘时，重启后重插会 409 already contains——
   * 此时按 source 找回已插入的文档，转核验而不是报失败。
   */
  async function engineFindDocBySource(source) {
    if (!source) return null
    for (let page = 1; page <= scanMaxPages; page++) {
      const lr = await engine.listDocuments({ page, page_size: 100 })
      const docs = (lr && lr.documents) || []
      const hit = docs.find((d) => d.file_path === source)
      if (hit) return hit
      const total = lr && lr.pagination ? lr.pagination.total_count : null
      if (total === null || page * 100 >= total) return null
    }
    return null
  }

  /** 409 是否为"同 source 已存在"（重插幂等恢复的信号）。 */
  function isAlreadyContains(e) {
    return !!(e && e.status === 409 && /already contains/i.test(String(e && e.message)))
  }

  // ---- 各意图的执行步骤。每 tick 推进一步，可中断可恢复。 ----

  async function stepDelete(intent) {
    if (intent.status === 'pending') {
      if (!(await pipelineIdle())) return // 忙：删除会被静默丢弃，等
      if (!intent.attemptStartedAt) {
        try {
          await engine.deleteDocuments([intent.params.docId])
          transition(intent, { status: 'verifying', verifyAt: Date.now() + verifyDelayMs })
        } catch (e) {
          if (isPipelineBusy(e)) return // 忙：稍后重试
          transition(intent, { status: 'verifying', verifyAt: Date.now() + verifyDelayMs }) // 仍走核验（可能已删）
        }
      }
      return
    }
    if (intent.status === 'verifying') {
      if (Date.now() < (intent.verifyAt || 0)) return
      const still = await engineHasDoc(intent.params.docId)
      if (!still) {
        registry.retireDoc(intent.params.docId, intent.params.actor || 'intent')
        transition(intent, { status: 'verified' })
        compactIfLarge()
        return
      }
      const attempts = (intent.attempts || 0) + 1
      if (attempts >= maxAttempts) {
        transition(intent, { status: 'stuck', attempts, error: '删除后引擎仍存在，重试 ' + attempts + ' 次未收敛' })
        logger('STUCK delete intent ' + intent.id + ' docId=' + intent.params.docId)
        return
      }
      // 重新发出（引擎可能之前静默丢弃了）
      transition(intent, { status: 'pending', attempts, attemptStartedAt: null })
      return
    }
  }

  async function ingestIssue(intent) {
    const p = intent.params
    if (intent.kind === 'ingest_file' || (intent.kind === 'replace' && p.filename)) {
      const spool = path.join(dir, 'spool', intent.id + '.bin')
      if (!fs.existsSync(spool)) {
        transition(intent, { status: 'failed', error: '暂存文件丢失，请重新上传' })
        return null
      }
      const bytes = fs.readFileSync(spool)
      const res = await engine.uploadFile(p.filename, bytes)
      return res
    }
    const res = await engine.insertText(p.text, p.source)
    return res
  }

  async function stepIngest(intent) {
    const p = intent.params
    if (intent.status === 'pending') {
      if (!(await pipelineIdle())) return
      try {
        const res = await ingestIssue(intent)
        if (res === null) return // spool 丢失：ingestIssue 已将意图转 failed
        const trackId = res && res.track_id
        if (!trackId) {
          // 引擎没给 track（怪癖防御）：轮询注册表状态兜底
          const docId = res && res.documents && res.documents[0] ? res.documents[0].id : null
          if (!docId) { transition(intent, { status: 'failed', error: '引擎未返回 track_id 或 doc_id' }); return }
          transition(intent, { status: 'verifying', docId, trackId: null, verifyAt: Date.now() + verifyDelayMs })
          return
        }
        const docId = res.documents && res.documents[0] ? res.documents[0].id : null
        transition(intent, { status: 'issued', trackId, docId, issuedAt: Date.now() })
      } catch (e) {
        if (isPipelineBusy(e)) return // 忙：下一 tick 重试
        if (isAlreadyContains(e)) {
          // 崩溃窗口恢复：上传已落地但 issued 行未写盘——按 source 找回，转核验
          const found = await engineFindDocBySource(p.source)
          if (found) {
            transition(intent, { status: 'verifying', docId: found.id, trackId: null, verifyAt: Date.now() + verifyDelayMs })
            return
          }
        }
        const attempts = (intent.attempts || 0) + 1
        if (attempts >= maxAttempts) transition(intent, { status: 'failed', attempts, error: String(e && e.message ? e.message : e) })
        else transition(intent, { attempts })
        return
      }
      return
    }
    if (intent.status === 'issued') {
      if (Date.now() - (intent.issuedAt || 0) > trackTimeoutMs) {
        transition(intent, { status: 'stuck', error: '处理超时（' + Math.round(trackTimeoutMs / 60000) + ' 分钟）' })
        logger('STUCK ingest intent ' + intent.id + ' track=' + intent.trackId)
        return
      }
      try {
        const tr = await engine.trackStatus(intent.trackId)
        const doc = tr && tr.documents && tr.documents[0]
        const st = doc ? doc.status : null
        if (st === 'processed') {
          registry.ensureDoc({
            docId: doc.id, source: intent.params.source, title: intent.params.title,
            topic: intent.params.topic, actor: intent.params.actor || 'intent',
          })
          registry.touchStatus(doc.id, 'active')
          transition(intent, { status: 'verified', docId: doc.id })
          cleanupSpool(intent)
          compactIfLarge()
        } else if (st === 'failed') {
          registry.ensureDoc({
            docId: doc.id, source: intent.params.source, title: intent.params.title,
            topic: intent.params.topic, actor: intent.params.actor || 'intent',
          })
          registry.touchStatus(doc.id, 'failed', doc.error_msg || '引擎处理失败')
          transition(intent, { status: 'failed', error: doc.error_msg || '引擎处理失败' })
          cleanupSpool(intent)
        }
        // processing：继续等
      } catch (e) {
        const attempts = (intent.attempts || 0) + 1
        if (attempts >= maxAttempts) transition(intent, { status: 'stuck', attempts, error: 'track_status 不可达: ' + (e && e.message) })
        else transition(intent, { attempts })
      }
      return
    }
    if (intent.status === 'verifying') {
      // 无 track 兜底：直接查引擎文档状态
      if (Date.now() < (intent.verifyAt || 0)) return
      try {
        const has = await engineHasDoc(intent.docId)
        if (!has) { transition(intent, { status: 'failed', error: '文档未出现在引擎中' }); cleanupSpool(intent); return }
        const st = await docStatusInEngine(intent.docId)
        if (st === 'processed') {
          registry.ensureDoc({
            docId: intent.docId, source: intent.params.source, title: intent.params.title,
            topic: intent.params.topic, actor: intent.params.actor || 'intent',
          })
          registry.touchStatus(intent.docId, 'active')
          transition(intent, { status: 'verified' })
          cleanupSpool(intent)
        } else if (st === 'failed') {
          registry.ensureDoc({
            docId: intent.docId, source: intent.params.source, title: intent.params.title,
            topic: intent.params.topic, actor: intent.params.actor || 'intent',
          })
          registry.touchStatus(intent.docId, 'failed', '引擎处理失败')
          transition(intent, { status: 'failed', error: '引擎处理失败' })
          cleanupSpool(intent)
        } else if (Date.now() - (intent.verifyAt || 0) > trackTimeoutMs) {
          transition(intent, { status: 'stuck', error: '无 track 处理超时' })
          cleanupSpool(intent)
        } else {
          transition(intent, { verifyAt: Date.now() + verifyDelayMs })
        }
      } catch (e) {
        transition(intent, { status: 'stuck', error: '无 track 核验异常: ' + (e && e.message) })
      }
      return
    }
  }

  async function docStatusInEngine(docId) {
    for (let page = 1; page <= scanMaxPages; page++) {
      const lr = await engine.listDocuments({ page, page_size: 100 })
      const docs = (lr && lr.documents) || []
      const hit = docs.find((d) => d.id === docId)
      if (hit) return hit.status
      const total = lr && lr.pagination ? lr.pagination.total_count : null
      if (total === null || page * 100 >= total) return null
    }
    return null
  }

  /** replace = 阶段机：delete_old → ingest_new → verified（注册表版本链在最后一步提升）。 */
  async function stepReplace(intent) {
    const p = intent.params
    if (!intent.phase || intent.phase === 'delete_old') {
      const sub = intent._delSub || null
      if (!sub) {
        // 旧文档必须先消失（同 source 重插 409，引擎契约怪癖 1）
        const old = registry.getDoc(p.replacesDocId)
        if (!old || old.status === 'retired') {
          transition(intent, { phase: 'ingest_new' })
          return
        }
        registry.touchStatus(p.replacesDocId, 'updating')
        try {
          if (await pipelineIdle()) {
            await engine.deleteDocuments([p.replacesDocId])
            transition(intent, { phase: 'delete_old', _delSub: 'verifying', verifyAt: Date.now() + verifyDelayMs })
          }
        } catch (e) { /* 下一 tick 重试 */ }
        return
      }
      if (sub === 'verifying') {
        if (Date.now() < (intent.verifyAt || 0)) return
        const still = await engineHasDoc(p.replacesDocId)
        if (!still) { transition(intent, { phase: 'ingest_new', _delSub: null }) ; return }
        const attempts = (intent.attempts || 0) + 1
        if (attempts >= maxAttempts) {
          transition(intent, { status: 'stuck', attempts, error: '替换：旧文档删除不收敛' })
          return
        }
        transition(intent, { attempts, _delSub: null })
        return
      }
      return
    }
    if (intent.phase === 'ingest_new') {
      if (!(await pipelineIdle())) return
      try {
        const res = await ingestIssue(intent)
        if (res === null) return
        const trackId = res && res.track_id
        const docId = res && res.documents && res.documents[0] ? res.documents[0].id : null
        // 上传响应可能只给 track_id，doc_id 在 track_status 中才可见。
        if (!trackId && !docId) { transition(intent, { status: 'failed', error: '引擎未返回 track_id 或 doc_id' }); return }
        transition(intent, { phase: 'track_new', trackId, newDocId: docId, issuedAt: Date.now() })
      } catch (e) {
        if (isPipelineBusy(e)) return
        if (isAlreadyContains(e)) {
          // 崩溃窗口恢复：新文档已落地但 track_new 行未写盘——按 source 找回，无 track 轮询
          const found = await engineFindDocBySource(p.source)
          if (found) {
            transition(intent, { phase: 'track_new', trackId: null, newDocId: found.id, issuedAt: Date.now() })
            return
          }
        }
        const attempts = (intent.attempts || 0) + 1
        if (attempts >= maxAttempts) transition(intent, { status: 'failed', attempts, error: String(e && e.message ? e.message : e) })
        else transition(intent, { attempts })
      }
      return
    }
    if (intent.phase === 'track_new') {
      if (Date.now() - (intent.issuedAt || 0) > trackTimeoutMs) {
        transition(intent, { status: 'stuck', error: '替换新文档处理超时' })
        return
      }
      let st = null
      let errMsg = null
      try {
        if (intent.trackId) {
          const tr = await engine.trackStatus(intent.trackId)
          const doc = tr && tr.documents && tr.documents[0]
          if (doc?.id && doc.id !== intent.newDocId) transition(intent, { newDocId: doc.id })
          st = doc ? doc.status : null
          errMsg = doc ? doc.error_msg : null
        } else {
          // 崩溃窗口找回（无 track）：直接轮询引擎文档状态
          st = await docStatusInEngine(intent.newDocId)
        }
        if (st === 'processed') {
          // 注册表版本链提升：文本一般产生新 id；延迟解析的 PDF 可能沿用来源 id。
          registry.replaceDoc({
            docId: p.replacesDocId, newDocId: intent.newDocId, source: p.source, title: p.title,
            topic: p.topic, actor: p.actor || 'intent', reason: p.reason || '内容更新',
          })
          registry.touchStatus(intent.newDocId, 'active')
          transition(intent, { status: 'verified', docId: intent.newDocId })
          cleanupSpool(intent)
          compactIfLarge()
        } else if (st === 'failed') {
          // 新文档失败：回滚注册表（旧文档应仍在——删除在前、且未核验消失不会进 ingest_new）
          const old = registry.getDoc(p.replacesDocId)
          if (old && old.status === 'updating') registry.touchStatus(p.replacesDocId, old.status === 'updating' ? 'active' : old.status)
          transition(intent, { status: 'failed', error: errMsg || '新文档处理失败' })
          cleanupSpool(intent)
        }
      } catch (e) {
        const attempts = (intent.attempts || 0) + 1
        if (attempts >= maxAttempts) transition(intent, { status: 'stuck', attempts, error: 'track_status 不可达: ' + (e && e.message) })
        else transition(intent, { attempts })
      }
      return
    }
  }

  function cleanupSpool(intent) {
    const spool = path.join(dir, 'spool', intent.id + '.bin')
    try { fs.unlinkSync(spool) } catch (e) { /* 已清或从未有 */ }
  }

  // ---- 调度：串行执行，一次一步 ----
  async function tick() {
    if (inFlight !== null) {
      const intent = intents.get(inFlight)
      if (!intent || isTerminal(intent)) { inFlight = null; return }
      try {
        await stepOne(intent)
        const after = intents.get(inFlight)
        if (!after || isTerminal(after)) inFlight = null
      } catch (e) {
        logger('intent tick error ' + inFlight + ': ' + (e && e.message))
        inFlight = null
      }
      return
    }
    // 挑选下一个：优先级降序 + 同级 FIFO
    let pick = null
    for (const intent of intents.values()) {
      if (isTerminal(intent) || intent.status === 'paused') continue
      const pr = PRIORITY[intent.priority] || 0
      if (!pick) { pick = intent; continue }
      const prPick = PRIORITY[pick.priority] || 0
      if (pr > prPick || (pr === prPick && intent.createdAt < pick.createdAt)) pick = intent
    }
    if (!pick) return
    inFlight = pick.id
  }

  async function stepOne(intent) {
    if (intent.kind === 'delete_doc') return stepDelete(intent)
    if (intent.kind === 'ingest_file' || intent.kind === 'ingest_text') return stepIngest(intent)
    if (intent.kind === 'replace') return stepReplace(intent)
  }

  function submit(kind, params, { priority = 'user', actor = 'unknown', origin = 'user' } = {}) {
    const id = 'it-' + crypto.randomBytes(6).toString('hex')
    const intent = {
      id, kind, status: 'pending', priority, actor, origin,
      params, attempts: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    intents.set(id, intent)
    appendRow({ ...intent })
    try { emit({ type: 'kb.intent', intent: { ...intent } }) } catch (e) { /* 同上 */ }
    return intent
  }

  return {
    submit,
    get: (id) => intents.get(id) || null,
    list: ({ status } = {}) => [...intents.values()]
      .filter((i) => !status || i.status === status)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    stats() {
      const by = {}
      for (const i of intents.values()) {
        if (isTerminal(i)) continue
        by[i.status] = (by[i.status] || 0) + 1
      }
      const stuck = [...intents.values()].filter((i) => i.status === 'stuck').length
      return { inFlight: inFlight, byStatus: by, pendingTotal: Object.values(by).reduce((s, n) => s + n, 0), stuckTotal: stuck }
    },
    /** 文件字节先入 spool，再提交意图。 */
    submitFile({ filename, bytes, title, topic, actor, origin, replacesDocId, source }) {
      const id = 'it-' + crypto.randomBytes(6).toString('hex')
      const spoolPath = path.join(dir, 'spool', id + '.bin')
      fs.writeFileSync(spoolPath, bytes)
      const intent = {
        id, kind: replacesDocId ? 'replace' : 'ingest_file', status: 'pending',
        priority: 'user', actor: actor || 'unknown', origin: origin || 'user',
        params: { filename, source: source || filename, title, topic, replacesDocId, reason: replacesDocId ? '内容更新' : undefined },
        attempts: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
      intents.set(id, intent)
      appendRow({ ...intent })
      try { emit({ type: 'kb.intent', intent: { ...intent } }) } catch (e) { /* 同上 */ }
      return intent
    },
    submitText({ text, source, title, topic, actor, origin, replacesDocId }) {
      const kind = replacesDocId ? 'replace' : 'ingest_text'
      return submit(kind, { text, source, title, topic, replacesDocId, reason: replacesDocId ? '内容更新' : undefined },
        { priority: 'user', actor, origin })
    },
    /** 收敛器用：低优先级补删（对账发现的引擎残留）。 */
    submitReconcileDelete({ docId, source, reason }) {
      const existing = [...intents.values()].find((i) => i.kind === 'delete_doc' && i.params.docId === docId && !isTerminal(i)
        || (i.kind === 'replace' && i.params.replacesDocId === docId && !isTerminal(i)))
      if (existing) return existing
      return submit('delete_doc', { docId, source, reason: reason || '对账补删', actor: 'reconciler' }, { priority: 'reconcile', actor: 'reconciler', origin: 'system' })
    },
    onEvent(fn) { emit = fn },
    /** 手动重试 stuck/failed 意图。 */
    retry(id) {
      const intent = intents.get(id)
      if (!intent) throw new Error('意图不存在: ' + id)
      if (intent.status !== 'stuck' && intent.status !== 'failed') throw new Error('仅 stuck/failed 可重试')
      transition(intent, { status: 'pending', attempts: 0, error: null, phase: null, _delSub: null })
      return intent
    },
    start() {
      if (timer) return
      timer = setInterval(() => { tick().catch((e) => logger('intent runner error: ' + (e && e.message))) }, pollMs)
      if (typeof timer.unref === 'function') timer.unref()
    },
    stop() { if (timer) { clearInterval(timer); timer = null } },
    /** 测试/立即推进：执行一个调度步。 */
    tickNow: tick,
    flush: () => { /* JSONL 同步追加，无需 flush */ },
  }
}
