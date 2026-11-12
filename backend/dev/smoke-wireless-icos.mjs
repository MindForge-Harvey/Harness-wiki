/** Live model + Harness routing test; uses isolated, synthetic workorder inputs. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const base = process.env.HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3088'
const data = { source_ref: 'ICOS live routing synthetic fixture', retry_times: 1,
  order: { taskno: `TEST-ICOS-LIVE-${Date.now()}`, task_type: '宏站弱覆盖小区', cell_name: 'TEST-CELL',
    nettype: '4g', vendor: '华为', conclusion: '弱覆盖，RSRP为-115dBm', cover_totalverdict: '弱覆盖，RSRP为-115dBm' },
  initial_plans: [
    { execution_id: '1', plan_number: 'P1', type1: '覆盖', type2: '弱覆盖', parachinname: '最低接收电平', f_para: '-110', b_para: '-114' },
    { execution_id: '2', plan_number: 'P2', type1: '覆盖', type2: '弱覆盖', parachinname: '参考信号功率', f_para: '0', b_para: '2' },
  ], rules: [
    { type1: '覆盖', type2: '弱覆盖', nettype: '4g', vendor: '华为', parachinname: '最低接收电平', para: '>-140', rule_scope: '-2', is_use: '是' },
    { type1: '覆盖', type2: '弱覆盖', nettype: '4g', vendor: '华为', parachinname: '参考信号功率', para: '<10', rule_scope: '+2', is_use: '是' },
  ], short_evals: [{ id: 5, short_assess_result: '恶化' }],
  prior_execution_rows: [{ agent_decision_id: 'test-prior-1', execution_id: '1', tool: '最低接收电平',
    f_para: '-106', b_para: '-110', retry_times: 0, need_call_parameter_platform: '是', exec_feedback: '执行成功',
    short_result_id: 5, llm_solution: { new_chain: { enforced: true,
      rule: { matched_rule: { para: '>-140', rule_scope: '-2' } } } } }],
}
const skills = await (await fetch(base + '/api/skills')).json()
assert.equal(skills.skills.length, 19)
const message = '这是本地接口联调的合成 ICOS 工单，所有数值只用于接入验收。请使用已接入的 Skills 与 ICOS 阶段工具完整处理本轮：先核对上轮实际执行回执和短评估，再完成目标确认、根因收敛、案例参考、重推理、初案选择、根因对齐、参数风险、整单一致性和最终综合裁决，保留可恢复分析记录。使用提供的规则快照，不做现场下发，不编译经验；判断由你依据各阶段返回的要求完成。完成后说明本轮候选和保留问题。\n' + JSON.stringify(data)
const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: `icos-live-${Date.now()}`, message }), signal: AbortSignal.timeout(300000) })
assert.equal(response.status, 200)
const events = [], decoder = new TextDecoder()
let buffer = ''
for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true })
  let end
  while ((end = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, end); buffer = buffer.slice(end + 2)
    const event = block.match(/^event: (.+)/)?.[1]
    const raw = block.match(/\ndata: (.+)/)?.[1]
    if (!raw) continue
    const data = JSON.parse(raw)
    events.push({ event, data })
    const call = data.params?.event
    if (call?.type === 'tool/call') console.log(JSON.stringify({ tool: call.data.name, arguments: call.data.name === 'skill' ? call.data.arguments : undefined }))
  }
}
const calls = events.map(row => row.data.params?.event).filter(row => row?.type === 'tool/call')
const tools = calls.map(row => row.data.name)
const loadedSkills = calls.filter(row => row.data.name === 'skill').map(row => {
  const args = typeof row.data.arguments === 'string' ? JSON.parse(row.data.arguments) : row.data.arguments
  return args.name
})
const errors = events.filter(row => row.event === 'error')
const done = events.find(row => row.event === 'done')
const directory = path.join(workspace, '.run/icos-live')
fs.mkdirSync(directory, { recursive: true })
fs.writeFileSync(path.join(directory, 'smoke.json'), JSON.stringify({ tools, loadedSkills, events, answer: done?.data.finalResponse }, null, 2))
assert.deepEqual(errors, [])
assert.ok(done?.data.finalResponse)
for (const suffix of ['context', 'objective', 'root_cause', 'cases', 'candidates', 'alignment', 'parameter_risk', 'consistency', 'decision', 'multi_round', 'feedback']) {
  assert.ok(tools.includes(`wireless_icos_${suffix}`), `model did not invoke ${suffix}`)
}
for (const call of calls.filter(row => row.data.name === 'bash')) {
  const args = typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments
  assert.ok(!/worker\/icos\.py|import\s+.*services\.decision|python.*-c|node.*(?:--eval| -e)/.test(JSON.stringify(args)),
    'model bypassed phase tools with shell')
}
for (const name of ['wireless-workorder-intake', 'wireless-objective-confirmation', 'wireless-root-cause-analysis',
  'wireless-case-retrieval', 'wireless-solution-decision', 'wireless-cause-plan-alignment', 'wireless-parameter-adaptation',
  'wireless-plan-consistency', 'wireless-comprehensive-decision', 'wireless-multi-round-reasoning', 'wireless-effect-evaluation']) {
  assert.ok(loadedSkills.includes(name), `model did not load ${name}`)
}
console.log(JSON.stringify({ status: 'passed', tools, loadedSkills, answer: done.data.finalResponse }))
