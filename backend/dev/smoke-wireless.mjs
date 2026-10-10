/** Optional live smoke: uses the running Harness/model; all wireless tools are read-only. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const base = process.env.HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3088'
const stamp = Date.now()
const results = []
const questions = [
  ['meaning', 'QRxLevMin 是什么意思？增大它会改变什么？引用已接入的参数材料。', ['skill', 'wireless_history_search']],
  ['history', '查低接通用户占比高小区的历史参数调整案例，给出实际调整前后值和效果记录。有没有 KPI 改善幅度？', ['skill', 'wireless_history_search']],
  ['constraints', '按我声明的约束检查 CELLSEL.QRxLevMin：当前 -64，目标 -62，源编码单位，范围 -156 到 -44，步长 2，约束来源为本次用户声明。检查是否通过，并给出回退参考。', ['skill', 'wireless_parameter_check']],
  ['workorder', '有一张 LTE 低接通用户占比高小区工单，厂家与软件版本待核对，当前参数和 KPI 还没给。请比对已有历史案例，给我条件性优化建议与验证思路，不要虚构当前值或改善幅度。', ['skill', 'wireless_history_search']],
  ['unknown', 'FooBeamQuantumXYZ 参数是什么，是否能从当前无线资料查到？', ['skill', 'wireless_history_search']],
  ['root-cause', 'LTE 小区忙时下载慢，可能是什么原因？当前没有厂家版本和 KPI，请结合已有历史经验分析，不要保存工单。', ['skill', 'wireless_history_search']],
  ['data', 'LTE 小区下载慢，下行 PRB 利用率 95%、平均吞吐 3 Mbps，这些仅是用户提供的观测，暂无阈值和原始计数。请结合历史工单分析数据说明了什么，不要创建工单。', ['skill', 'wireless_history_search']],
  ['bounded-choice', '已有诊断是华为 LTE 容量受限，不需要重新分析根因。以下仅为模拟候选表，不是实测历史库：A-capacity 是容量调度策略，方向保持表内定义，模拟有效评价 100 Pass/20 Fail；B-handover 是切换惩罚策略，模拟评价 1 Pass/0 Fail。请从这张表选择更贴合问题的方案，给出选中的候选 ID 和比较理由、证据边界。', ['skill', 'wireless_history_search']],
]

for (const [name, message, expected] of questions.filter(([name]) => !process.env.HARNESS_TEST_CASE || process.env.HARNESS_TEST_CASE.split(',').includes(name))) {
  const sessionId = `wireless-smoke-${stamp}-${name}`
  const response = await fetch(base + '/api/chat/stream', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }), signal: AbortSignal.timeout(180000),
  })
  assert.equal(response.status, 200)
  const stream = await response.text()
  const events = stream.split('\n\n').filter(Boolean).map(block => ({
    event: block.match(/^event: (.+)/)?.[1],
    data: JSON.parse(block.match(/\ndata: (.+)/)?.[1] || '{}'),
  }))
  assert.ok(!events.some(item => item.event === 'error'), `SSE error in ${name}`)
  const done = events.find(item => item.event === 'done')
  assert.ok(done, `missing completion in ${name}`)
  const tools = events.filter(item => item.data?.params?.event?.type === 'tool/call')
    .map(item => item.data.params.event.data.name)
  const result = { name, sessionId, tools, answer: done.data.finalResponse }
  assert.ok(String(result.answer || '').trim().length > 0, `${name}: completed without an answer`)
  results.push(result)
  const directory = path.join(workspace, '.run', 'wireless-smoke')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, `${stamp}.json`), JSON.stringify(results, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  for (const tool of expected) assert.ok(tools.includes(tool), `${name} did not call ${tool}`)
  if (name === 'unknown') {
    assert.ok(!tools.some(tool => ['kb_diagnosis_submit', 'kb_feedback_inbox', 'kb_feedback_context', 'kb_graph_search'].includes(tool)), 'no match triggered unrelated knowledge governance')
    assert.ok(!/知识不存在|不是任何已知厂家|不是任何.*3GPP/.test(result.answer), 'no match became an unsupported global nonexistence claim')
  }
  if (name === 'bounded-choice') {
    assert.ok(result.answer.includes('A-capacity'), 'did not preserve the supplied selected candidate ID')
    assert.ok(!tools.includes('wireless_echo_decision'), 'invented local package references for an external candidate table')
  }
  if (['meaning', 'history', 'workorder', 'unknown', 'root-cause', 'data', 'bounded-choice'].includes(name)) {
    assert.ok(!tools.includes('wireless_workorder'), `${name}: analysis entered workorder engineering without a record request`)
  }
}
console.log(`Live smoke passed: ${results.length} conversations`)
