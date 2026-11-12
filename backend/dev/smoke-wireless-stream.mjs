/** Verify live SSE arrival and user-selected Skills against the configured real model. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const base = process.env.HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3088'
const directory = path.resolve('.run/wireless-stream-live', String(Date.now()))
fs.mkdirSync(directory, { recursive: true })
const invalid = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: '查询工单', selectedSkills: ['nonexistent-skill'] }) })
assert.equal(invalid.status, 400)

async function run(name, message, selectedSkills) {
  const started = Date.now(), sessionId = `stream-check-${Date.now()}-${name}`
  const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message, selectedSkills }), signal: AbortSignal.timeout(240000) })
  assert.equal(response.status, 200)
  const events = [], decoder = new TextDecoder()
  let buffer = '', firstDelta, firstCall, firstProgress, deltas = 0
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true })
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2)
      const raw = block.match(/\ndata: (.+)/)?.[1]
      if (!raw) continue
      const e = { event: block.match(/^event: (.+)/)?.[1], data: JSON.parse(raw), elapsed_ms: Date.now() - started }
      events.push(e)
      if (e.event === 'progress') firstProgress ??= e.elapsed_ms
      if (e.data.method === 'agent/assistant-delta') {
        assert.equal(e.data.params.kind, 'text')
        firstDelta ??= e.elapsed_ms; deltas++
      }
      if (e.data.params?.event?.type === 'tool/call') firstCall ??= e.elapsed_ms
    }
  }
  const calls = events.flatMap(e => e.data.params?.event?.type === 'tool/call' ? [e.data.params.event.data] : [])
  const loaded = calls.filter(c => c.name === 'skill').map(c => JSON.parse(c.arguments).name)
  const done = events.find(e => e.event === 'done')
  fs.writeFileSync(path.join(directory, name + '-events.json'), JSON.stringify(events, null, 2))
  assert.ok(done?.data.finalResponse)
  assert.ok(deltas > 1 && firstDelta < done.elapsed_ms - 10, 'text must arrive incrementally before completion')
  assert.ok(firstProgress !== undefined && firstProgress < firstCall)
  for (const selected of selectedSkills) assert.ok(loaded.includes(selected), `${selected} was not loaded`)
  assert.ok(calls.some(c => c.name === 'wireless_order_query'))
  assert.ok(!events.some(e => e.event === 'error'))
  const errors = events.flatMap(e => e.data.params?.event?.type === 'tool/result'
    ? e.data.params.event.data.message?.content?.filter(b => b.type === 'tool-result' && b.isError) || [] : [])
  assert.equal(errors.length, 0)
  const result = { name, first_progress_ms: firstProgress, first_tool_ms: firstCall, first_text_ms: firstDelta,
    completed_ms: done.elapsed_ms, text_chunks: deltas, selectedSkills, loaded, tools: calls.map(c => c.name), answer: done.data.finalResponse }
  fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result, answer: result.answer.slice(0, 160) }))
}

await run('single', '查询2026年6月的工单，汇总总量并列3张工单。', ['wireless-workorder-intake'])
await run('combined', '读取工单 SNWNA011260503851110229964，总结工单信息并查找相关历史案例。只比较资料，不生成新方案。',
  ['wireless-workorder-intake', 'wireless-case-retrieval'])
console.log(JSON.stringify({ passed: true, directory }))
