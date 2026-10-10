/** Live routing and persistence checks; all workorder/execution inputs are explicitly simulated. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkorderStore } from '../dsh/dsh-wireless/lib/workflow.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const base = process.env.HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3088'
const stamp = Date.now(), results = []
const directory = path.join(root, '.run/wireless-focus-smoke', String(stamp))
fs.mkdirSync(directory, { recursive: true })
async function chat(name, message) {
  const sessionId = `wireless-focus-${stamp}-${name}`
  const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }), signal: AbortSignal.timeout(240000) })
  assert.equal(response.status, 200)
  const events = (await response.text()).split('\n\n').filter(Boolean).map(block => ({
    event: block.match(/^event: (.+)/)?.[1], data: JSON.parse(block.match(/\ndata: (.+)/)?.[1] || '{}') }))
  assert.ok(!events.some(item => item.event === 'error'), `${name}: SSE error`)
  const done = events.find(item => item.event === 'done'); assert.ok(done)
  const projected = await (await fetch(base + '/api/chat/history?sessionId=' + encodeURIComponent(sessionId))).json()
  assert.ok(!projected.events.some(row => row.kind === 'tool' && row.status === 'error' &&
    String(row.resultText).includes('invalid output')), `${name}: SDK rejected non-JSON tool output`)
  const calls = events.filter(item => item.data?.params?.event?.type === 'tool/call').map(item => item.data.params.event.data)
  const result = { name, calls, answer: done.data.finalResponse }
  results.push(result)
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  console.log(JSON.stringify({ name, tools: calls.map(row => row.name), answer: result.answer }, null, 2))
  return result
}

const discovered = await (await fetch(base + '/api/skills')).json()
assert.equal(discovered.skills.length, 13)
assert.ok(discovered.skills.some(row => row.name === 'wireless-data-analysis'))
assert.ok(discovered.skills.some(row => row.name === 'wireless-memory-engineering'))
assert.ok(discovered.skills.some(row => row.name === 'wireless-echo-mem'))
assert.ok(!discovered.skills.some(row => row.name === 'knowledge-evidence-query'))
const offscope = await chat('scope', '你是做什么的？顺便帮我查一下公司请假制度。')
assert.ok(!offscope.calls.some(row => row.name === 'lightrag_query_data'), 'unrelated company query entered retrieval')
const principles = await chat('principles', '请具体解释 ECHO-Mem 怎么从工单变成记忆：六类记忆分别是什么，整单 Pass 能否摊给每个参数，RCA 的 validated 是否等于根因已证实，Beta-LCB 为什么和原始成功率不同？再说明当前系统能实际执行和记录哪些步骤。要引用项目来源。')
assert.ok(principles.calls.some(row => row.name === 'wireless_echo_query'))
assert.ok(!principles.calls.some(row => row.name === 'lightrag_query_data'))
const feedback = await chat('record', `下面全是模拟输入，用于验证记录功能，不是现场操作。工单外部编号 SIM-RECORD-${stamp}，小区 SIM-RECORD-C1，华为 LTE，软件 sim-v1，低接通；异常窗口 2026-10-07T10:00:00+08:00 到 11:00。用户模拟方案：Sim.TestSwitch 从 0 改到 1，允许枚举 0/1、单位模拟编码，约束与方案均来自本次用户模拟声明，目的仅为验证记录，不声称参数有无线效果。实际模拟反馈：2026-10-07T11:00:00+08:00 执行成功，前值 0、后值 1，来源本次模拟执行日志，无效果指标。请接入工单、保存候选方案、把这份实际模拟执行反馈关联该方案动作记录，再读取历史核对。给出工单、方案、执行 ID，不能把执行成功说成效果成功或真正网管下发。`)
const id = String(feedback.answer).match(/wo_[a-f0-9]{24}/)?.[0]
assert.ok(id)
const read = createWorkorderStore({ directory: path.join(root, 'backend/.runtime/dsh-home/storages/dsh-wireless') })
const record = read({ operation: 'read', workorder_id: id })
assert.equal(record.plans.length, 1)
assert.equal(record.executions.length, 1)
assert.equal(record.plans[0].execution_permission, 'not_granted')
assert.equal(record.executions[0].device_operation_performed, false)
assert.equal(record.executions[0].actions[0].before, 0)
assert.equal(record.executions[0].actions[0].after, 1)
assert.equal(record.stages.evaluation, undefined)
assert.ok(record.history.some(row => row.operation === 'save_plan' && row.result.plan_id))
assert.ok(record.history.some(row => row.operation === 'record_execution' && row.result.execution_id))
console.log(`Wireless focus live checks passed: ${results.length} conversations; workorder ${id}`)
