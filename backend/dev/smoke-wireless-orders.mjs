/** Ordinary user requests; no injected Skill, internal id, file path or prepared analysis. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const base = process.env.HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3088'
const stamp = Date.now(), directory = path.resolve('.run/wireless-orders-live', String(stamp))
fs.mkdirSync(directory, { recursive: true })
const results = []
async function chat(name, sessionId, message) {
  const start = Date.now()
  const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }), signal: AbortSignal.timeout(180000) })
  const events = (await response.text()).split('\n\n').filter(Boolean).map(block => ({
    event: block.match(/^event: (.+)/)?.[1], data: JSON.parse(block.match(/\ndata: (.+)/)?.[1] || '{}'),
  }))
  const calls = events.flatMap(e => e.data.params?.event?.type === 'tool/call' ? [e.data.params.event.data] : [])
  const outputs = events.flatMap(e => e.data.params?.event?.type === 'tool/result' ? e.data.params.event.data.message?.content || [] : [])
  const done = events.find(e => e.event === 'done')
  const r = { name, sessionId: done?.data.sessionId || sessionId, message, elapsed_ms: Date.now() - start,
    answer: done?.data.finalResponse || '', calls, tool_errors: outputs.filter(o => o.type === 'tool-result' && o.isError) }
  results.push(r)
  fs.writeFileSync(path.join(directory, name + '-events.json'), JSON.stringify(events, null, 2))
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ name, seconds: r.elapsed_ms / 1000, tools: calls.map(c => c.name), errors: r.tool_errors.length, answer: r.answer }))
  assert.equal(response.status, 200)
  assert.ok(r.answer, name + ': missing answer')
  assert.ok(!events.some(e => e.event === 'error'), name + ': transport error')
  assert.equal(r.tool_errors.length, 0, name + ': tool error')
  assert.doesNotMatch(r.answer, /生产工单库.{0,10}(?:尚未|未接入|没有接入)/)
  return r
}

const greetingSession = 'order-live-greeting-' + stamp
const greeting = await chat('greeting', greetingSession, '你好')
assert.ok(greeting.elapsed_ms < 1500, 'greeting should not wait for model inference')
assert.equal(greeting.calls.length, 0)
const greetingHistory = await (await fetch(base + '/api/chat/history?sessionId=' + greetingSession)).json()
assert.ok(greetingHistory.events.some(e => e.kind === 'assistant' && e.text.includes('无线网络优化 Harness')))

const parallel = await Promise.allSettled([
  (async () => {
    const r = await chat('june', 'order-live-june-' + stamp, '6月的工单都有啥？')
    assert.ok(r.calls.some(c => c.name === 'wireless_order_query'))
    assert.match(r.answer.replaceAll(',', ''), /6558/)
    assert.match(r.answer, /SN[A-Z0-9]+/)
  })(),
  (async () => {
    const r = await chat('catalog', 'order-live-catalog-' + stamp, '现在都有啥工单？')
    assert.ok(r.calls.some(c => c.name === 'wireless_order_query'))
    assert.match(r.answer, /小区|切换|接通/)
  })(),
  (async () => {
    const r = await chat('ticket', 'order-live-ticket-' + stamp, '查一下工单 SNWNA011260503851110229964')
    assert.ok(r.calls.some(c => c.name === 'wireless_order_query'))
    assert.match(r.answer, /杜家塬|接通低/)
    const summary = await chat('summary-followup', r.sessionId, '进行信息总结')
    assert.match(summary.answer, /杜家塬|SNWNA011260503851110229964/)
    assert.match(summary.answer, /接通低/)
  })(),
  (async () => {
    const r = await chat('identity', 'order-live-identity-' + stamp, '你是谁，能做哪些事情？')
    assert.match(r.answer, /无线网络优化.*Harness/)
    assert.doesNotMatch(r.answer, /主要基于\s*ECHO|以\s*ECHO-Mem.*为(?:核心|基础)/i)
  })(),
])
const failures = parallel.filter(r => r.status === 'rejected')
for (const f of failures) console.error(f.reason)
assert.equal(failures.length, 0, 'ordinary user acceptance checks failed')
console.log(JSON.stringify({ passed: true, turns: results.length, directory }))
