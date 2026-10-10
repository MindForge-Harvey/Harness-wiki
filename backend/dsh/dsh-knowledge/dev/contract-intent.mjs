/**
 * 契约测试 · 意图账本（v2 可靠性内核）。
 *
 * 覆盖：文本/文件摄入全链路、异步删除核验、忙时静默丢弃后的自动补发（怪癖 2）、
 * 替换阶段机（先删旧再插新 + 版本链 v1→v2）、stuck 判定与手动重试、
 * WAL 重启恢复（pending/issued/verifying/崩溃窗口 409 already contains）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { makeStack, makeRunner, ok, eq, throws, sleep } from './harness.mjs'

const { check, finish } = makeRunner('contract-intent')

await check('ingest_text：pending → issued → processed → verified + 注册表 active', async () => {
  const s = await makeStack()
  const it = s.intents.submitText({ text: '正文甲', source: 'text:a', title: '甲', topic: 'T' })
  eq(it.status, 'pending')
  await s.intents.tickNow() // 选中
  await s.intents.tickNow() // 发出 insertText
  const mid = s.intents.get(it.id)
  eq(mid.status, 'issued', 'should be issued, got ' + mid.status)
  ok(mid.trackId, 'must carry trackId')
  ok(mid.docId, 'must carry docId')
  s.engine.advanceTicks() // track → processed
  await s.intents.tickNow() // 核验
  const fin = s.intents.get(it.id)
  eq(fin.status, 'verified', 'final: ' + fin.status)
  const doc = s.registry.getDoc(fin.docId)
  ok(doc && doc.status === 'active', 'registry must be active')
  ok(s.engine._state.docs.has(fin.docId), 'engine must have doc')
})

await check('ingest_file：spool 落盘 → 终态后清理', async () => {
  const s = await makeStack()
  const it = s.intents.submitFile({ filename: 'f.md', bytes: Buffer.from('文件内容'), title: 'F', source: 'f.md' })
  const spool = path.join(s.dir, 'intents', 'spool', it.id + '.bin')
  ok(fs.existsSync(spool), 'spool must exist while pending')
  await s.intents.tickNow(); await s.intents.tickNow()
  s.engine.advanceTicks()
  await s.intents.tickNow()
  eq(s.intents.get(it.id).status, 'verified')
  ok(!fs.existsSync(spool), 'spool must be cleaned after terminal')
})

await check('ingest_file：spool 丢失 → failed（要求重新提交）', async () => {
  const s = await makeStack()
  const it = s.intents.submitFile({ filename: 'g.md', bytes: Buffer.from('x'), title: 'G', source: 'g.md' })
  fs.rmSync(path.join(s.dir, 'intents', 'spool', it.id + '.bin'))
  await s.intents.tickNow(); await s.intents.tickNow()
  eq(s.intents.get(it.id).status, 'failed')
  ok(/暂存文件丢失/.test(s.intents.get(it.id).error || ''), 'error must name missing spool')
})

await check('track 处理失败 → 注册表 failed + 意图 failed', async () => {
  const s = await makeStack()
  s.engine.failNextUpload('trackFailed')
  const it = s.intents.submitFile({ filename: 'bad.md', bytes: Buffer.from('b'), title: 'B', source: 'bad.md' })
  await s.intents.tickNow(); await s.intents.tickNow()
  s.engine.advanceTicks() // track → failed
  await s.intents.tickNow()
  const fin = s.intents.get(it.id)
  eq(fin.status, 'failed')
  eq(s.registry.getDoc(fin.docId).status, 'failed', 'registry must record failed')
})

await check('删除：异步核验 → verified + 注册表 retired（service 单一入口）', async () => {
  const s = await makeStack()
  const r = await s.engine.insertText('内容一', 'src:1')
  s.engine.advanceTicks()
  const d1 = r.documents[0].id
  s.registry.ensureDoc({ docId: d1, source: 'src:1', title: '一' })
  s.registry.touchStatus(d1, 'active')
  const out = await s.kb.deleteDoc({ docId: d1, actor: 'test' })
  ok(out.ok && out.intent_id)
  eq(s.registry.getDoc(d1).status, 'retired', 'service retires immediately (intent is the promise)')
  await s.intents.tickNow() // 选中
  await s.intents.tickNow() // 发出删除 → verifying
  s.engine.advanceTicks() // 删除落地
  await sleep(20) // verifyDelayMs=10
  await s.intents.tickNow() // 核验消失
  eq(s.intents.get(out.intent_id).status, 'verified')
  ok(!s.engine._state.docs.has(d1), 'engine must not have doc')
})

await check('怪癖2 主线：忙时删除被静默丢弃 → 账本自动补发直至收敛', async () => {
  const s = await makeStack()
  const r = await s.engine.insertText('内容二', 'src:2')
  s.engine.advanceTicks()
  const d1 = r.documents[0].id
  s.registry.ensureDoc({ docId: d1, source: 'src:2', title: '二' })
  s.registry.touchStatus(d1, 'active')
  const it = s.intents.submit('delete_doc', { docId: d1, source: 'src:2', reason: '测试删除', actor: 't' }, { priority: 'user', actor: 't' })
  await s.intents.tickNow(); await s.intents.tickNow() // 发出删除
  // 落地时刻管道忙：200 已返回但引擎丢弃（怪癖 2）
  s.engine.setBusy(true)
  s.engine.advanceTicks()
  eq(s.engine._state.droppedDeletes, 1, 'quirk must be simulated')
  await sleep(20)
  await s.intents.tickNow() // verifying：仍存在 → attempts=1 → pending
  let cur = s.intents.get(it.id)
  eq(cur.status, 'pending', 'must re-queue for re-issue, got ' + cur.status)
  eq(cur.attempts, 1)
  await s.intents.tickNow() // pending 但管道忙 → 等待
  eq(s.intents.get(it.id).status, 'pending', 'must wait while busy')
  s.engine.setBusy(false)
  await s.intents.tickNow() // 重新发出删除
  eq(s.intents.get(it.id).status, 'verifying')
  s.engine.advanceTicks() // 这次落地
  await sleep(20)
  await s.intents.tickNow() // 核验消失 → verified
  cur = s.intents.get(it.id)
  eq(cur.status, 'verified', 'converged: ' + cur.status)
  ok(!s.engine._state.docs.has(d1))
  eq(s.registry.getDoc(d1).status, 'retired')
})

await check('删除不收敛：重试耗尽 → stuck（可见、不静默）+ retry 可恢复', async () => {
  const s = await makeStack()
  const r = await s.engine.insertText('内容三', 'src:3')
  s.engine.advanceTicks()
  const d1 = r.documents[0].id
  s.registry.ensureDoc({ docId: d1, source: 'src:3', title: '三' })
  const it = s.intents.submit('delete_doc', { docId: d1, reason: 'x', actor: 't' }, { priority: 'user', actor: 't' })
  await s.intents.tickNow(); await s.intents.tickNow() // 选中、发出删除 → verifying
  // 每轮：落地时刻忙 → 丢弃；核验仍在 → attempts++；attempts≥3（maxAttempts）→ stuck
  for (let round = 0; round < 5; round++) {
    s.engine.setBusy(true)
    s.engine.advanceTicks() // 丢弃
    await sleep(20)
    await s.intents.tickNow() // 核验失败
    const cur = s.intents.get(it.id)
    if (cur.status === 'stuck') break
    eq(cur.status, 'pending', 'round ' + round + ' should re-queue')
    s.engine.setBusy(false)
    await s.intents.tickNow() // 重新发出
  }
  const st = s.intents.get(it.id)
  eq(st.status, 'stuck', 'must be stuck after maxAttempts, got ' + st.status)
  eq(st.attempts, 3, 'attempts must be recorded')
  eq(s.intents.stats().stuckTotal, 1)
  // 手动重试：恢复后收敛
  s.engine.setBusy(false)
  const rec = s.intents.retry(it.id)
  eq(rec.status, 'pending')
  await s.intents.tickNow(); await s.intents.tickNow()
  s.engine.advanceTicks()
  await sleep(20)
  await s.intents.tickNow()
  eq(s.intents.get(it.id).status, 'verified')
  ok(!s.engine._state.docs.has(d1))
})

await check('替换：先删旧（核验消失）→ 插新（内容寻址新 id）→ 版本链 v1→v2', async () => {
  const s = await makeStack()
  const r = await s.engine.insertText('旧内容', 'src:r')
  s.engine.advanceTicks()
  const d1 = r.documents[0].id
  s.registry.ensureDoc({ docId: d1, source: 'src:r', title: 'R', topic: 'T' })
  s.registry.touchStatus(d1, 'active')
  const out = await s.kb.replaceText({ docId: d1, title: 'R', text: '全新内容', actor: 't' })
  ok(out.intent_id)
  eq(s.registry.getDoc(d1).status, 'updating')
  await s.intents.tickNow() // 选中
  await s.intents.tickNow() // phase delete_old：发出删除
  s.engine.advanceTicks() // 旧文档消失
  await sleep(20)
  await s.intents.tickNow() // _delSub verifying → 消失 → phase ingest_new
  eq(s.intents.get(out.intent_id).phase, 'ingest_new')
  await s.intents.tickNow() // 插入新文本
  eq(s.intents.get(out.intent_id).phase, 'track_new')
  const newDocId = s.intents.get(out.intent_id).newDocId
  ok(newDocId && newDocId !== d1, 'content addressing must yield new id')
  s.engine.advanceTicks() // 新文档 processed
  await s.intents.tickNow() // track_new → verified + replaceDoc
  eq(s.intents.get(out.intent_id).status, 'verified')
  const old = s.registry.getDoc(d1)
  const fresh = s.registry.getDoc(newDocId)
  eq(old.status, 'outdated', 'old must be outdated')
  eq(old.superseded_by, newDocId)
  eq(fresh.status, 'active')
  eq(fresh.version, 2, 'version chain must advance')
  eq(fresh.source, 'src:r', 'source preserved')
  ok(s.engine._state.docs.has(newDocId) && !s.engine._state.docs.has(d1), 'engine has only new doc')
})

await check('文件替换：multipart 上传只返回 track_id，后续从 track 找回新 doc_id', async () => {
  const s = await makeStack()
  const original = await s.engine.uploadFile('replace.md', Buffer.from('旧文件内容'))
  s.engine.advanceTicks()
  const oldId = original.documents[0].id
  s.registry.ensureDoc({ docId: oldId, source: 'replace.md', title: '文件替换' })
  s.registry.touchStatus(oldId, 'active')
  const uploadFile = s.engine.uploadFile.bind(s.engine)
  let uploads = 0
  s.engine.uploadFile = async (...args) => {
    uploads++
    const result = await uploadFile(...args)
    return { track_id: result.track_id }
  }
  const result = await s.kb.replaceFile({ docId: oldId, filename: 'replace.md', bytes: Buffer.from('新文件内容'), actor: 'test' })
  for (let i = 0; i < 15; i++) {
    await s.intents.tickNow()
    s.engine.advanceTicks()
    await sleep(20)
    if (s.intents.get(result.intent_id).status === 'verified') break
  }
  const finished = s.intents.get(result.intent_id)
  eq(finished.status, 'verified', JSON.stringify(finished))
  eq(uploads, 1, '文件替换必须走 uploadFile')
  ok(finished.docId && finished.docId !== oldId, '应从 track_status 获取新文档 id')
  eq(s.registry.getDoc(finished.docId).status, 'active')
  ok(!s.engine._state.docs.has(oldId), '旧文档已删除')
})

await check('替换：新文档处理失败 → 注册表回滚旧文档 active', async () => {
  const s = await makeStack()
  const r = await s.engine.insertText('旧内容', 'src:rf')
  s.engine.advanceTicks()
  const d1 = r.documents[0].id
  s.registry.ensureDoc({ docId: d1, source: 'src:rf', title: 'R' })
  s.registry.touchStatus(d1, 'active')
  await s.kb.replaceText({ docId: d1, title: 'R', text: '坏内容', actor: 't' })
  await s.intents.tickNow(); await s.intents.tickNow() // delete_old 发出
  s.engine.advanceTicks()
  await sleep(20)
  await s.intents.tickNow() // → ingest_new
  // 让新文档失败：直接对引擎挂失败钩子不可行（insertText 无钩子）——
  // 用 track 阶段强制失败：取 newDocId，把引擎侧文档置 failed
  await s.intents.tickNow() // 插入新文本 → track_new
  const newDocId = s.intents.list()[0].newDocId
  const nd = s.engine._state.docs.get(newDocId)
  nd.status = 'failed'; nd.error_msg = '注入失败'
  for (const [tid, t] of s.engine._state.tracks.entries()) {
    if (t.docId === newDocId) { t.status = 'failed'; t.error_msg = '注入失败' }
  }
  await s.intents.tickNow() // track_new → failed → 回滚注册表
  const it = s.intents.list()[0]
  eq(it.status, 'failed', 'intent must fail, got ' + it.status)
  eq(s.registry.getDoc(d1).status, 'active', 'old doc must be restored to active')
})

await check('重启恢复：issued（track 已知）→ 保持 issued 继续核验，不重插', async () => {
  const s = await makeStack()
  const it = s.intents.submitText({ text: '正文乙', source: 'text:b', title: '乙' })
  await s.intents.tickNow(); await s.intents.tickNow() // issued（上传已落地）
  // 崩溃：track 尚未 processed；同盘重建（同引擎同目录）
  const s2 = await makeStack({ dir: s.dir, engine: s.engine })
  const rec = s2.intents.get(it.id)
  eq(rec.status, 'issued', 'recovery must keep issued, got ' + rec.status)
  ok(rec.trackId, 'trackId must survive restart')
  s2.engine.advanceTicks()
  await s2.intents.tickNow() // 选中（重启后 inFlight 为空）
  await s2.intents.tickNow() // issued：trackStatus → processed → verified
  eq(s2.intents.get(it.id).status, 'verified')
  ok(s2.registry.getDoc(rec.docId), 'registry must have doc after restart-verify')
})

await check('重启恢复：verifying 删除 → 到期继续核验直至 verified', async () => {
  const s = await makeStack()
  const r = await s.engine.insertText('内容丙', 'src:c')
  s.engine.advanceTicks()
  const d1 = r.documents[0].id
  s.registry.ensureDoc({ docId: d1, source: 'src:c', title: '丙' })
  const it = s.intents.submit('delete_doc', { docId: d1, reason: 'x', actor: 't' }, { priority: 'user', actor: 't' })
  await s.intents.tickNow(); await s.intents.tickNow() // verifying（已发出删除）
  s.engine.advanceTicks() // 落地
  s.registry.flushSync() // 模拟正常关机：防抖写盘落定
  const s2 = await makeStack({ dir: s.dir, engine: s.engine })
  eq(s2.intents.get(it.id).status, 'verifying')
  await sleep(20)
  await s2.intents.tickNow() // 选中
  await s2.intents.tickNow() // verifying 到期 → 核验消失 → verified
  eq(s2.intents.get(it.id).status, 'verified')
  eq(s2.registry.getDoc(d1).status, 'retired')
})

await check('崩溃窗口：上传已落地但 WAL 仍 pending → 409 already contains → 按 source 找回核验', async () => {
  const s = await makeStack()
  // 直接向引擎插入（模拟"步骤执行到一半崩溃"：上传成功、'issued' 行未写盘）
  const r = await s.engine.insertText('正文丁', 'text:d')
  const landed = r.documents[0].id
  const it = s.intents.submitText({ text: '正文丁', source: 'text:d', title: '丁' })
  await s.intents.tickNow() // 选中
  await s.intents.tickNow() // 重插 → 409 already contains → 按 source 找回 → verifying
  const mid = s.intents.get(it.id)
  eq(mid.status, 'verifying', 'must recover to verifying, got ' + mid.status)
  eq(mid.docId, landed, 'must adopt the landed doc id')
  s.engine.advanceTicks() // 处理完成
  await sleep(20)
  await s.intents.tickNow() // 核验 processed → verified
  eq(s.intents.get(it.id).status, 'verified')
  ok(s.registry.getDoc(landed), 'registry must record the recovered doc')
})

await check('崩溃窗口（replace）：ingest_new 重插 409 → 找回新文档继续 track_new', async () => {
  const s = await makeStack()
  const r = await s.engine.insertText('旧', 'src:rr')
  s.engine.advanceTicks()
  const d1 = r.documents[0].id
  s.registry.ensureDoc({ docId: d1, source: 'src:rr', title: 'R' })
  s.registry.touchStatus(d1, 'active')
  // 旧文档已删、新文本已直接落引擎（崩溃窗口：phase 停在 ingest_new）
  await s.engine.deleteDocuments([d1])
  s.engine.advanceTicks()
  const rn = await s.engine.insertText('新内容', 'src:rr') // 新内容已落地
  const d2 = rn.documents[0].id
  const it = s.intents.submitText({ text: '新内容', source: 'src:rr', title: 'R', replacesDocId: d1 })
  // 直接把 WAL 上的相位改成 ingest_new（模拟崩溃点）
  const cur = s.intents.get(it.id)
  cur.phase = 'ingest_new'
  await s.intents.tickNow() // 选中
  await s.intents.tickNow() // ingest_new：重插 → 409 → 找回 → track_new（无 track）
  const mid = s.intents.get(it.id)
  eq(mid.phase, 'track_new', 'must enter track_new, got ' + mid.phase)
  eq(mid.newDocId, d2)
  ok(!mid.trackId, 'recovered path has no track')
  s.engine.advanceTicks() // d2 processed
  await s.intents.tickNow() // 无 track 轮询 → processed → replaceDoc + verified
  eq(s.intents.get(it.id).status, 'verified')
  eq(s.registry.getDoc(d2).status, 'active')
  eq(s.registry.getDoc(d1).status, 'outdated')
})

await check('优先级：user 先于 reconcile；同优先级 FIFO', async () => {
  const s = await makeStack()
  const rec = s.intents.submit('delete_doc', { docId: 'doc-x', reason: '对账补删', actor: 'reconciler' }, { priority: 'reconcile', actor: 'reconciler', origin: 'system' })
  const usr = s.intents.submitText({ text: 't', source: 'text:u', title: 'u' })
  await s.intents.tickNow() // 选中：user 优先
  eq(s.intents.stats().inFlight, usr.id, 'user intent must be picked first')
  await s.intents.tickNow() // 步进 user 意图（发出）
  eq(s.intents.stats().inFlight, usr.id, 'serial executor keeps inFlight until terminal')
  s.engine.advanceTicks()
  await s.intents.tickNow() // verified → 释放
  await s.intents.tickNow() // 选中 reconcile 删除
  eq(s.intents.stats().inFlight, rec.id)
  // submitReconcileDelete 幂等：已有进行中同文档意图 → 返回既有
  const again = s.intents.submitReconcileDelete({ docId: 'doc-x', source: '', reason: '再补删' })
  eq(again.id, rec.id, 'reconcile delete must dedupe')
})

await check('stats/list：终态不入 pending 统计；list 按 status 过滤', async () => {
  const s = await makeStack()
  const a = s.intents.submitText({ text: 'a', source: 'text:sa', title: 'a' })
  const b = s.intents.submitText({ text: 'b', source: 'text:sb', title: 'b' })
  eq(s.intents.stats().pendingTotal, 2)
  await s.intents.tickNow(); await s.intents.tickNow() // 选中 a、发出 a
  s.engine.advanceTicks()
  await s.intents.tickNow() // a verified
  eq(s.intents.stats().pendingTotal, 1, 'verified intent must leave pending stats')
  eq(s.intents.list({ status: 'verified' }).length, 1)
  eq(s.intents.list({ status: 'verified' })[0].id, a.id, 'FIFO: first-created runs first')
  eq(s.intents.list({ status: 'pending' })[0].id, b.id)
})

const failed = finish()
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) process.exit(failed ? 1 : 0)
