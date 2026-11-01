// Explicit live integration check: uses the configured Harness model and actual HTTP providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base = process.env.DISPATCH_TEST_URL || 'http://127.0.0.1:3088';
const reportPath = process.env.DISPATCH_TEST_REPORT || '.run/expanded-live-evaluation.json';
const report = { startedAt: new Date().toISOString(), engine: 'configured Harness model', cases: [] };
async function request(path, body) {
  const response = await fetch(base + '/api/dispatch/' + path, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-request': '1' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
}
async function runCase(item, previousRunId) {
  const started = Date.now();
  const row = { name: item.name, prompt: item.prompt }; report.cases.push(row);
  try {
    const created = await request('runs', { message: item.prompt, previousRunId }); row.runId = created.id;
    let run;
    while (Date.now() - started < 105000) {
      run = await request('runs/' + created.id);
      if (!['interpreting', 'dispatching', 'running'].includes(run.status)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    row.status = run.status; row.error = run.error; row.clarification = run.clarification;
    row.tools = run.tasks.map(task => task.capabilityId); row.receipts = run.tasks.filter(task => task.receipt).length;
    row.durationMs = Date.now() - started;
    assert.equal(run.status, item.status || 'completed', run.error || run.clarification || JSON.stringify(run.tasks.filter(task => task.error)));
    for (const id of item.required || []) assert.ok(row.tools.includes(id), `未调用所需能力 ${id}`);
    for (const id of item.forbidden || ['optimization.execute', 'optimization.rollback']) assert.ok(!row.tools.includes(id), `不应调用 ${id}`);
    if (run.status === 'completed') assert.ok(run.tasks.every(task => task.status === 'completed' && task.receipt?.transport === 'HTTP'));
    if (run.status === 'needs_input') assert.equal(run.tasks.length, 0);
    item.check?.(run);
    row.pass = true;
  } catch (cause) { row.pass = false; row.failure = cause.message; row.durationMs = Date.now() - started; }
  fs.mkdirSync(new URL('../../.run/', import.meta.url), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`${row.pass ? 'PASS' : 'FAIL'} ${row.name} ${Math.round(row.durationMs / 1000)}s ${row.runId || ''}${row.failure ? ' ' + row.failure : ''}`);
  return row;
}
const cases = [
  { name: '指标TOP3的方向与数量', prompt: '查询新街口商圈近7天下行用户速率最低的前3个小区。', required: ['data.rank'], check(run) { const data = run.tasks.find(task => task.capabilityId === 'data.rank').result.data; assert.equal(data.metric, 'dl_rate'); assert.equal(data.order, 'asc'); assert.equal(data.rows.length, 3); } },
  { name: '忙时趋势与容量', prompt: '分析新街口商圈近7天的忙时负荷趋势，并做资源容量诊断，只分析不下发。', required: ['data.trend', 'diagnosis.resource'] },
  { name: '多网格对比', prompt: '对比新街口商圈和河西商务区近7天的PRB与速率，给出同窗口对比表。', required: ['data.compare'], check(run) { assert.equal(run.tasks.find(task => task.capabilityId === 'data.compare').result.data.rows.length, 2); } },
  { name: 'MR采样与覆盖', prompt: '排查仙林大学城近7天的弱覆盖问题，结合MR采样和天馈告警，不要调参。', required: ['diagnosis.coverage', 'data.alarms'] },
  { name: '干扰专题', prompt: '分析仙林大学城近7天的上行干扰，用SINR和上行噪声区分弱覆盖，只分析。', required: ['diagnosis.interference'] },
  { name: '六维诊断全部实际调用', prompt: '对仙林大学城近7天做覆盖、邻区、参数、干扰、告警、资源六维诊断，逐维给出证据，只分析。', required: ['diagnosis.coverage', 'diagnosis.neighbor', 'diagnosis.parameter', 'diagnosis.interference', 'diagnosis.alarm', 'diagnosis.resource'] },
  { name: '方案规则风险冲突审核', prompt: '给新街口商圈生成优化方案，用规则取值审核、风险依据分析和参数冲突剔除检查方案，最后独立校验参数，但不要执行。', required: ['decision.rule_assess', 'decision.risk_basis', 'decision.conflicts', 'optimization.validate'] },
  { name: '全网运营不追问网格', prompt: '统计近7天全网演示优化工单的闭环率、状态和处理时长，并列出LinkFailed工单。', required: ['operations.orders', 'operations.stats'] },
  { name: '简单知识不走诊断流程', prompt: 'PRB利用率高是什么意思？', required: ['knowledge.search'], check(run) { assert.equal(run.tasks.length, 1); } },
  { name: '未知对象先澄清', prompt: '分析浦东世纪大道网格的投诉原因。', status: 'needs_input' },
];
let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => { while (next < cases.length) { const item = cases[next++]; await runCase(item); } }));
const loop = await runCase({ name: '源规则到真实派发闭环', prompt: '排查新街口商圈近7天投诉，制定优化方案并通过源规则审核与独立参数校验，安排模拟执行并评估效果。', required: ['decision.rule_assess', 'optimization.execute', 'optimization.evaluate'], forbidden: ['optimization.rollback'] });
if (loop.pass) {
  await runCase({ name: '后续短评估不重复执行', prompt: '复核刚才的执行回执和短评估结论，不要重复执行。', required: ['optimization.short_review'] }, loop.runId);
  const rolled = await runCase({ name: '独立模拟回退回执', prompt: '将刚才的模拟参数方案回退到执行前状态，给出回退回执，不要重新执行优化方案。', required: ['optimization.rollback'], forbidden: ['optimization.execute'] }, loop.runId);
  if (rolled.pass) await runCase({ name: '重复回退不重复派发', prompt: '再回退一次刚才的方案。', status: 'needs_input' }, rolled.runId);
}
report.finishedAt = new Date().toISOString(); report.passed = report.cases.filter(row => row.pass).length; report.total = report.cases.length;
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`Live Harness checks: ${report.passed}/${report.total}`);
if (report.passed !== report.total) process.exitCode = 1;
