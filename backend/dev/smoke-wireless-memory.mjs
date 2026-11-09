/** Live model orchestration check. All simulated feedback stays in the demo namespace. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const base = process.env.HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3088'
const stamp = Date.now(), output = path.join(root, '.run/wireless-memory-smoke', String(stamp))
fs.mkdirSync(output, { recursive: true })
const skills = await (await fetch(base + '/api/skills')).json()
assert.ok(skills.skills.some(row => row.name === 'wireless-demo-analysis'))
const catalog = await (await fetch(base + '/api/wireless/demo/catalog')).json()
assert.equal(catalog.counts.scenarios, 12)
async function chat(name, message) {
  const sessionId = `wireless-memory-${stamp}-${name}`
  const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }), signal: AbortSignal.timeout(300000) })
  assert.equal(response.status, 200)
  const events = (await response.text()).split('\n\n').filter(Boolean).map(block => ({
    event: block.match(/^event: (.+)/)?.[1], data: JSON.parse(block.match(/\ndata: (.+)/)?.[1] || '{}') }))
  fs.writeFileSync(path.join(output, name + '-events.json'), JSON.stringify(events, null, 2))
  assert.ok(!events.some(e => e.event === 'error'), 'model/SDK stream failed')
  const done = events.find(e => e.event === 'done'); assert.ok(done, 'missing final model answer')
  const history = await (await fetch(base + '/api/chat/history?sessionId=' + encodeURIComponent(sessionId))).json()
  fs.writeFileSync(path.join(output, name + '-history.json'), JSON.stringify(history, null, 2))
  const calls = history.events.filter(row => row.kind === 'tool')
  const demoCalls = calls.filter(row => row.name === 'wireless_demo').map(row => ({ ...row, args: JSON.parse(row.argsText) }))
  const result = { name, sessionId, answer: done.data.finalResponse, calls, demoCalls }
  fs.writeFileSync(path.join(output, name + '-result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ name, tools: calls.map(row => row.name), operations: demoCalls.map(row => row.args.operation), answer: result.answer.slice(0, 180), output }))
  return result
}
const cycle = await chat('cycle', '请用内置合成场景 demo-capacity 完整演示 agentic memory。先读取决策前数据，实际计算时序、基线和同群对照，再实际比较历史候选与反证，选择适用候选冻结方案；随后揭示模拟执行反馈、评价效果、学习生成新经验版本，再比较新旧版本计数和评分。所有现场操作均为模拟，允许推进模拟时钟，无需等待现实日期。不要预读反馈文件，不用预设数字替代工具，按真实状态报告结果。')
for (const op of ['read_case', 'compare_candidates', 'select_candidate', 'reveal_feedback', 'learn']) assert.ok(cycle.demoCalls.some(row => row.args.operation === op), 'model skipped ' + op)
assert.ok(cycle.calls.some(row => row.name === 'wireless_data_analyze' && row.resultJson?.status === 'analyzed'))
assert.ok(cycle.demoCalls.findIndex(row => row.args.operation === 'select_candidate') < cycle.demoCalls.findIndex(row => row.args.operation === 'reveal_feedback'))
assert.ok(cycle.demoCalls.some(row => row.resultJson?.status === 'demo_memory_learned'))
assert.ok(!cycle.calls.some(row => row.status === 'error'), 'model made a failed tool call')
const missing = await chat('missing-current-value', '只做内置合成演示场景 demo-access-missing-snapshot 的决策前分析。读取当前数据，实际分析时序并比较历史候选。当前参数值缺失时给出能完成的判断与精确补数需求，不编造参数目标；本次不选择、不揭示反馈、不学习。')
assert.ok(missing.calls.some(row => row.name === 'wireless_data_analyze'))
assert.ok(missing.demoCalls.some(row => row.args.operation === 'compare_candidates' && row.resultJson?.candidates.every(c => c.adaptation.target === null)))
assert.ok(!missing.demoCalls.some(row => ['select_candidate', 'reveal_feedback', 'learn'].includes(row.args.operation)))
console.log(JSON.stringify({ status: 'passed', conversations: 2, output }))
