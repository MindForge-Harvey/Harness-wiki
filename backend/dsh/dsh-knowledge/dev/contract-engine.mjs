/**
 * 契约测试 · 引擎契约（假引擎锁定 LightRAG v1.5.6 全部怪癖 + engine-port 纯函数）。
 *
 * 假引擎与真实引擎同接口（lib/engine-port.js）；本文件锁定的怪癖清单一旦
 * 假引擎与真实引擎行为漂移，应先改这里再改上层。
 */
import { makeRunner, ok, eq, throws } from './harness.mjs'
import http from 'node:http'

const { check, finish } = makeRunner('contract-engine')
const { createFakeEngine } = await import('../lib/fake-engine.js')
const { createLightRagEngine, isPipelineBusy, flattenGraphArrays, engineStatusToRegistry, fileSetOf, clipQueryData } = await import('../lib/engine-port.js')

// 真实 HTTP 边界：验证鉴权不会在 GET、JSON、文件上传或流式请求中丢失。
async function withHttpEngine(apiKey, run) {
  const previousKey = process.env.LIGHTRAG_API_KEY
  if (apiKey) process.env.LIGHTRAG_API_KEY = apiKey
  else delete process.env.LIGHTRAG_API_KEY
  const requests = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() })
    if (apiKey && req.headers['x-api-key'] !== apiKey) {
      res.writeHead(403, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ detail: 'API Key required' }))
    }
    if (req.url === '/query/stream') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      return res.end(JSON.stringify({ response: '已检索' }) + '\n' + JSON.stringify({ references: ['制度.md'] }) + '\n')
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status_counts: { processed: 1 }, data: { chunks: [{ content: '制度依据' }] }, status: 'success' }))
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await run(createLightRagEngine(`http://127.0.0.1:${server.address().port}`), requests)
  } finally {
    if (previousKey === undefined) delete process.env.LIGHTRAG_API_KEY
    else process.env.LIGHTRAG_API_KEY = previousKey
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

await check('API Key 鉴权：GET、JSON、multipart 与流式请求均可通过受保护引擎', async () => {
  await withHttpEngine('contract-only-key', async (engine, requests) => {
    eq((await engine.statusCounts()).status_counts.processed, 1)
    eq((await engine.queryData({ query: '报销要求' })).data.chunks[0].content, '制度依据')
    await engine.uploadFile('fixture.md', Buffer.from('上传资料'))
    const lines = []
    await engine.queryStream({ query: '报销要求' }, line => lines.push(line))
    eq(lines.length, 2)
    eq(lines[1].references[0], '制度.md')
    eq(requests.length, 4)
    eq(requests[0].method, 'GET')
    eq(requests[1].headers['content-type'], 'application/json')
    eq(JSON.parse(requests[1].body).query, '报销要求')
    ok(requests[2].headers['content-type'].startsWith('multipart/form-data; boundary='), '上传必须保留自动生成的 multipart 边界')
    ok(requests[2].body.includes('上传资料'), '文件内容必须保留')
    eq(requests[3].headers['content-type'], 'application/json')
    ok(requests.every(request => request.headers['x-api-key'] === 'contract-only-key'))
  })
})

await check('未配置 API Key：普通与流式请求继续兼容无鉴权的本地引擎', async () => {
  await withHttpEngine(null, async (engine, requests) => {
    await engine.statusCounts()
    const lines = []
    await engine.queryStream({ query: '本地检索' }, line => lines.push(line))
    eq(lines.length, 2)
    ok(requests.every(request => request.headers['x-api-key'] === undefined), '未配置时不发送空密钥')
  })
})

// ---------------------------------------------------------------- 怪癖 1：同 source 重插 409

await check('怪癖1：同 source 重插 → 409 already contains（text 与 file 同罪）', async () => {
  const e = createFakeEngine()
  await e.insertText('内容', 's1.md')
  await throws(() => e.insertText('内容2', 's1.md'), /already contains/)
  await e.uploadFile('s2.md', Buffer.from('x'))
  await throws(() => e.uploadFile('s2.md', Buffer.from('y')), /already contains/)
})

await check('怪癖4：内容寻址——同内容不同 source 得到相同 doc_id', async () => {
  const e = createFakeEngine()
  const a = await e.insertText('同一段内容', 'a.md')
  const b = await e.insertText('同一段内容', 'b.md')
  eq(a.documents[0].id, b.documents[0].id, 'same content must map to same doc id')
  const c = await e.insertText('另一段内容', 'c.md')
  ok(a.documents[0].id !== c.documents[0].id, 'different content must differ')
})

// ---------------------------------------------------------------- 怪癖 2：异步删除 + 忙时静默丢弃

await check('怪癖2：删除先 200；落地在 tick；忙时落地被静默丢弃', async () => {
  const e = createFakeEngine()
  const r = await e.insertText('内容', 'd1.md')
  const id = r.documents[0].id
  const del = await e.deleteDocuments([id])
  eq(del.status, 'deletion_started', 'delete must ack 200 immediately')
  ok(e._state.docs.has(id), 'doc must remain before tick (async delete)')
  e.advanceTicks()
  ok(!e._state.docs.has(id), 'doc must be gone after tick')
})

await check('怪癖2b：落地时刻忙 → 200 已返回但删除被丢弃', async () => {
  const e = createFakeEngine()
  const r = await e.insertText('内容', 'd2.md')
  const id = r.documents[0].id
  await e.deleteDocuments([id])
  e.setBusy(true)
  e.advanceTicks() // 落地时刻忙：丢弃
  ok(e._state.docs.has(id), 'delete must be silently dropped when busy')
  eq(e._state.droppedDeletes || 0, 1)
})

// ---------------------------------------------------------------- 怪癖 3：忙时写 409

await check('怪癖3：管道忙时 插入/上传/图谱写 → 409 Pipeline is busy', async () => {
  const e = createFakeEngine()
  e.setBusy(true)
  const err1 = await throws(() => e.insertText('x', 'b1.md'), /Pipeline is busy/)
  eq(err1.status, 409)
  const err2 = await throws(() => e.uploadFile('b2.md', Buffer.from('x')), /busy/)
  eq(err2.status, 409)
  const err3 = await throws(() => e.entityCreate('E', { description: 'd' }), /busy/)
  eq(err3.status, 409)
  eq((await e.pipelineStatus()).busy, true)
})

// ---------------------------------------------------------------- 怪癖 5：图数据数组值 → 500

await check('怪癖5：图写含数组值 → 500 GraphML 不支持 list', async () => {
  const e = createFakeEngine()
  await e.entityCreate('E', { description: '正常' })
  const err = await throws(() => e.entityEdit('E', { description: ['a', 'b'] }), /GraphML/)
  eq(err.status, 500)
})

// ---------------------------------------------------------------- 怪癖 6：track_status 形状

await check('怪癖6：trackStatus 返回 {track_id, status, documents:[{id,status,error_msg}]}', async () => {
  const e = createFakeEngine()
  const r = await e.insertText('内容', 't1.md')
  const tr = await e.trackStatus(r.track_id)
  eq(tr.track_id, r.track_id)
  ok(Array.isArray(tr.documents) && tr.documents.length === 1)
  eq(tr.documents[0].id, r.documents[0].id)
  eq(tr.documents[0].status, 'processing')
  e.advanceTicks()
  eq((await e.trackStatus(r.track_id)).documents[0].status, 'processed')
  await throws(() => e.trackStatus('track-不存在'), /.*/, '404')
})

// ---------------------------------------------------------------- 怪癖 7：分页下限 / graphs 必填 label

await check('怪癖7：page_size 下限 10；graphs 必填 label', async () => {
  const e = createFakeEngine()
  await e.insertText('a', 'p1.md')
  await e.insertText('b', 'p2.md')
  const lr = await e.listDocuments({ page: 1, page_size: 3 })
  eq(lr.pagination.page_size, 10, 'page_size floor is 10')
  await throws(() => e.graphs({}), /label is required/)
  await e.entityCreate('L', { description: 'd' })
  const g = await e.graphs({ label: 'L' })
  ok(Array.isArray(g.nodes) && g.nodes.length === 1)
})

// ---------------------------------------------------------------- 图谱语义

await check('图谱：entity 级联删除关系；merge 重挂关系', async () => {
  const e = createFakeEngine()
  await e.entityCreate('A', { description: 'a' })
  await e.entityCreate('B', { description: 'b' })
  await e.entityCreate('C', { description: 'c' })
  await e.relationCreate('A', 'B', { description: 'r1' })
  await e.relationCreate('B', 'C', { description: 'r2' })
  await e.entityDelete('B') // 级联删 A→B、B→C
  eq((await e.graphs({ label: 'A' })).edges.length, 0, 'relations touching B must cascade')
  await e.relationCreate('A', 'C', { description: 'r3' })
  await e.entityCreate('D', { description: 'd' })
  await e.relationCreate('D', 'A', { description: 'r4' })
  await e.entityMerge(['D'], 'A') // D→A 重挂到 A→A？D→A 关系变 A→A
  const g = await e.graphs({ label: 'A' })
  ok(g.edges.some((x) => x.source === 'A' && x.target === 'A'), 'D→A relation must re-hang to A→A')
  eq((await e.labelList()).length, 2, 'D must be merged away')
})

await check('reprocessFailed：只重试显式 id 的失败文档', async () => {
  const e = createFakeEngine({ processAfterPolls: 1 })
  const r1 = await e.uploadFile('f1.md', Buffer.from('x'))
  const r2 = await e.uploadFile('f2.md', Buffer.from('y'))
  e.failNextUpload('trackFailed')
  await e.uploadFile('f3.md', Buffer.from('z'))
  e.advanceTicks() // f3 failed
  const res = await e.reprocessFailed([r1.documents[0].id]) // f1 并不 failed
  eq(res.count, 0, 'non-failed doc must not be reprocessed')
  const failedId = [...e._state.docs.values()].find((d) => d.status === 'failed').id
  const res2 = await e.reprocessFailed([failedId])
  eq(res2.count, 1)
  ok(![...e._state.docs.values()].some((d) => d.id === failedId && d.status === 'failed'), 'must be processing again')
  ok(r2.documents[0], 'r2 untouched')
})

// ---------------------------------------------------------------- engine-port 纯函数

await check('isPipelineBusy：409 + busy 语义匹配；其他不误判', async () => {
  ok(isPipelineBusy({ status: 409, message: 'Pipeline is busy with another operation' }))
  ok(isPipelineBusy({ status: 409, message: 'Pipeline is clearing' }))
  ok(!isPipelineBusy({ status: 409, message: 'Document storage already contains a document' }), 'already-contains is NOT busy')
  ok(!isPipelineBusy({ status: 500, message: 'Pipeline is busy' }), 'non-409 is not busy')
  ok(!isPipelineBusy(null))
})

await check('flattenGraphArrays：任意深度数组拍平为顿号串', async () => {
  eq(flattenGraphArrays(['a', 'b']), 'a，b')
  eq(JSON.stringify(flattenGraphArrays({ description: ['x', 'y'], meta: { tags: ['p', 'q'] } })), JSON.stringify({ description: 'x，y', meta: { tags: 'p，q' } }))
  eq(flattenGraphArrays('s'), 's')
  eq(flattenGraphArrays(3), 3)
})

await check('engineStatusToRegistry：引擎状态映射', async () => {
  eq(engineStatusToRegistry('processed'), 'active')
  eq(engineStatusToRegistry('preprocessed'), 'active')
  eq(engineStatusToRegistry('failed'), 'failed')
  eq(engineStatusToRegistry('processing'), 'processing')
  eq(engineStatusToRegistry('pending'), 'pending')
})

await check('fileSetOf：references/chunks/entities 的 file_path 取 basename 去重', async () => {
  const set = fileSetOf({
    references: [{ file_path: '/a/b/base.md' }],
    chunks: [{ file_path: 'x.md' }, { file_path: 'x.md' }, { no: 1 }],
    entities: [{ entity_name: 'E' }],
  })
  eq(set.size, 2)
  ok(set.has('base.md') && set.has('x.md'))
})

await check('clipQueryData：诊断快照限额裁剪（5 chunks × 3000 字 / 20 实体 / 30 关系）', async () => {
  const long = 'x'.repeat(5000)
  const data = {
    chunks: Array.from({ length: 7 }, (_, i) => ({ reference_id: 'c-' + i, chunk_id: 'doc-abc-chunk-00' + i, file_path: 'f' + i + '.md', content: i === 0 ? long : 'short' })),
    entities: Array.from({ length: 25 }, (_, i) => ({ entity_id: 'e' + i, entity_name: 'E' + i, description: long, source_id: 's', file_path: 'f.md', extra: 'dropped' })),
    relationships: Array.from({ length: 33 }, (_, i) => ({ src_id: 'e' + i, tgt_id: 'e' + i, description: 'r', weight: 0.5 })),
    references: Array.from({ length: 9 }, (_, i) => ({ file_path: 'f' + i + '.md', reference_id: 'c-' + i, score: 0.1 })),
  }
  const snap = clipQueryData(data)
  eq(snap.chunks.length, 5, 'chunks capped at 5')
  eq(snap.chunks[0].content.length, 3000, 'chunk content capped at 3000 chars')
  eq(snap.entities.length, 20, 'entities capped at 20')
  eq(snap.entities[0].description.length, 500, 'entity description capped at 500 chars')
  ok(snap.entities[0].extra === undefined, 'non-diagnostic fields dropped')
  eq(snap.relationships.length, 30, 'relationships capped at 30')
  eq(snap.references.length, 5, 'references follow chunk cap')
  ok(snap.truncated, 'truncated flag set when any list overflows')
  const tiny = clipQueryData({ chunks: [{ reference_id: 'c', file_path: 'f', content: 'ok' }] })
  eq(tiny.chunks.length, 1)
  ok(tiny.chunks[0].chunk_id === undefined || tiny.chunks[0].chunk_id === null, '缺失 chunk_id 容忍为 null')
  ok(snap.chunks[0].chunk_id === 'doc-abc-chunk-000', '引擎完整 chunk_id 保留（mm 反查依赖）')
  ok(!tiny.truncated, 'no truncation flag under limits')
  const nothing = clipQueryData(null)
  eq(nothing.chunks.length, 0, 'null data tolerated')
})

const failed = finish()
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) process.exit(failed ? 1 : 0)
