/** Live model smoke with explicitly simulated observations and demo compilation. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const base = process.env.HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3088'
const stamp = Date.now(), results = []
const directory = path.join(root, '.run/wireless-workflow-smoke', String(stamp))
fs.mkdirSync(directory, { recursive: true })
const traces = JSON.parse(fs.readFileSync(path.join(root, 'backend/dsh/dsh-wireless/resources/sample-traces.json')))
const source = path.join(directory, 'demo-traces.jsonl')
fs.writeFileSync(source, traces.map(row => JSON.stringify(row)).join('\n') + '\n')
async function chat(name, message, expected) {
  const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: `wireless-workflow-smoke-${stamp}-${name}`, message }), signal: AbortSignal.timeout(240000) })
  assert.equal(response.status, 200)
  const events = (await response.text()).split('\n\n').filter(Boolean).map(block => ({
    event: block.match(/^event: (.+)/)?.[1], data: JSON.parse(block.match(/\ndata: (.+)/)?.[1] || '{}') }))
  assert.ok(!events.some(item => item.event === 'error'), `${name}: SSE error`)
  const done = events.find(item => item.event === 'done')
  assert.ok(done)
  const calls = events.filter(item => item.data?.params?.event?.type === 'tool/call').map(item => item.data.params.event.data)
  const result = { name, calls, answer: done.data.finalResponse }
  results.push(result)
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  console.log(JSON.stringify({ name, tools: calls.map(row => row.name), answer: result.answer }, null, 2))
  for (const tool of expected) assert.ok(calls.some(row => row.name === tool), `${name} did not call ${tool}`)
  return result.answer
}

const skills = await (await fetch(base + '/api/skills')).json()
assert.equal(skills.skills.length, 13)
const answer = await chat('diagnosis', '以下为模拟工单，仅用于功能验证。小区 SIM-C1，华为 LTE，软件版本 sim-v1，室外。2026-10-07 10:00 到 11:00（+08:00）下载低速率。模拟指标：下行 PRB 利用率 95%，定义为该窗口下行占用 PRB/可用 PRB，1000 个样本；用户测试判据 >90% 为异常。下行用户吞吐 3 Mbps，定义为同窗口用户平均下行吞吐，1000 个样本，无已知异常门限。SINR 18 dB，定义为同窗口测量平均 SINR，1000 个样本，无已知异常门限。三项都来自本次模拟输入、同小区同窗口。请接入工单、分型、构建证据、给出有依据和区分检查的根因假设，再比对历史，给条件建议。最后明确列出保存的工单 ID；不要虚构参数当前值或 KPI 改善幅度。', ['skill', 'wireless_workorder', 'wireless_history_search'])
const workorderId = String(answer).match(/wo_[a-f0-9]{24}/)?.[0]
assert.ok(workorderId, 'missing persisted workorder ID')
await chat('effect', `对已保存工单 ${workorderId} 做模拟效果评估。实际模拟执行时间为 2026-10-07T11:00:00+08:00，执行成功，动作组合 A 从 0 到 1、B 从 2 到 3，均为模拟配置。对 SIM-C1 比较 RRC 接通率，口径 RRC 建立成功次数/请求次数、单位 %、higher 越高越好、同一用户人群。前窗 2026-10-07T10:00:00+08:00 至 11:00，950/1000=95%，样本数 1000；后窗 11:00 至 12:00，980/1000=98%，样本数 1000。均为本次模拟输入。用户测试判据：观察至少 1 小时，必评指标 RRC 接通率，绝对改善至少 2 个百分点。请调用效果评估，区分百分点和相对变化，并说明能否归因于每个参数。`, ['skill', 'wireless_workorder'])
await chat('compile', `这是明确的演示编译验证：把工作区文件 ${source} 按 demo 模式、截止时间 2026-10-08T00:00:00+08:00 编译为本地记忆包，然后读取这个包的 strategy_memory。给出包 ID、类型数量、策略状态和来源，不把演示统计说成现场效果。`, ['skill', 'wireless_compile_history', 'wireless_memory_query'])
console.log(`Live workflow smoke passed: ${results.length} conversations; ${skills.skills.length} discovered skills`)
