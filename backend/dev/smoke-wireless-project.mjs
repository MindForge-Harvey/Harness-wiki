/** Natural business requests must route through the original project kernels and native Harness planning. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const base = process.env.HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3088'
const directory = path.resolve('.run/wireless-project-live', String(Date.now()))
fs.mkdirSync(directory, { recursive: true })
const sessionId = `project-flow-${Date.now()}`
async function run(name, message, conversation = sessionId) {
  const start = Date.now(), events = []
  const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: conversation, message }), signal: AbortSignal.timeout(360000) })
  assert.equal(response.status, 200)
  const decoder = new TextDecoder(); let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2)
      const data = block.match(/\ndata: (.+)/)?.[1]
      if (data) events.push({ event: block.match(/^event: (.+)/)?.[1], data: JSON.parse(data), elapsed_ms: Date.now() - start })
    }
  }
  fs.writeFileSync(path.join(directory, name + '-events.json'), JSON.stringify(events, null, 2))
  const calls = events.flatMap(event => event.data.params?.event?.type === 'tool/call' ? [event.data.params.event.data] : [])
  const results = events.flatMap(event => event.data.params?.event?.type === 'tool/result'
    ? event.data.params.event.data.message?.content?.filter(block => block.type === 'tool-result') || [] : [])
  const done = events.find(event => event.event === 'done')
  const result = { message, elapsed_ms: Date.now() - start, tools: calls.map(call => call.name),
    loaded: calls.filter(call => call.name === 'skill').map(call => JSON.parse(call.arguments).name),
    plans: calls.filter(call => call.name === 'todo_write').map(call => JSON.parse(call.arguments).todos),
    answer: done?.data.finalResponse }
  fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ name, ...result, answer: result.answer?.slice(0, 250) }))
  assert.ok(done?.data.finalResponse)
  assert.equal(events.some(event => event.event === 'error'), false)
  assert.equal(results.some(result => result.isError), false)
  const values = results.flatMap(block => (block.content || []).filter(item => item.type === 'text').flatMap(item => { try { return [JSON.parse(item.text)] } catch { return [] } }));
  return { calls, result, values }
}
if (process.env.PROJECT_FLOW_CASE !== 'direct') {
  const root = await run('root', '定位工单 SNWNA011260503851110229964 的小区，明确按2026年11月1日的数据重新做根因分析。')
  assert.ok(root.calls.some(call => call.name === 'wireless_icos_context' && JSON.parse(call.arguments).ticket_id === 'SNWNA011260503851110229964'))
  assert.ok(root.result.tools.includes('wireless_icos_root_cause'))
  assert.ok(!root.result.tools.includes('wireless_icos_decision'))
  const plan = await run('plan', '为这张工单生成优化方案。')
  for (const name of ['todo_write', 'wireless_icos_candidates', 'wireless_icos_parameter_risk', 'wireless_icos_consistency', 'wireless_icos_decision']) {
    assert.ok(plan.result.tools.includes(name), `${name} was not called`)
  }
  assert.ok(plan.result.plans.some(todos => todos.length > 1))
  assert.ok(!plan.result.tools.includes('wireless_icos_feedback'))
}
const directTicket = process.env.PROJECT_TEST_TICKET_ID || 'SNXIA512260630163682851377932320';
const direct = await run('direct-plan', `为工单 ${directTicket} 对应小区明确按2026年11月1日的数据重新生成优化方案。`, sessionId + '-direct');
for (const name of ['todo_write', 'wireless_icos_context', 'wireless_icos_decision']) assert.ok(direct.result.tools.includes(name), `${name} was not called`);
for (const stage of ['candidates', 'parameter_risk', 'consistency']) assert.ok(direct.result.tools.includes('wireless_icos_' + stage) || direct.values.some(value => value.workflow?.some(row => row.stage === stage && row.status === 'completed')), `${stage} was neither called nor validly reused`);
const analysisIndex = direct.result.tools.findIndex(name => /^wireless_icos_(?!context)/.test(name));
assert.ok(direct.result.tools.indexOf('todo_write') < analysisIndex, 'Plan must precede stage analysis');
assert.ok(direct.result.plans.some(todos => todos.length > 1));
console.log(JSON.stringify({ passed: true, directory }))
