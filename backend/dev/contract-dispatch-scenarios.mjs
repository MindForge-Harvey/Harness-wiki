import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDispatchService } from '../dispatch/service.mjs';
import { createDispatchStore } from '../dispatch/store.mjs';
import { createProviderHandlers } from '../dispatch/providers.mjs';
import { capabilities, capabilityById, metrics } from '../dispatch/catalog.mjs';
import { scenarios, professionalAbilities, domains } from '../dispatch/hierarchy.mjs';
import { resolveActionConflicts } from '../dispatch/extended-providers.mjs';
import { runReleaseFunction } from '../dispatch/release-functions.mjs';

const waitFor = async predicate => {
  const start = Date.now();
  while (Date.now() - start < 10000) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('任务未在10秒内到达终态');
};
function makePlan(ids, { scope = { grid_ids: ['GRID-XJK'], cell_ids: [] }, input = {}, provided = new Set(), scenarioId } = {}) {
  const ordered = [], seen = new Set();
  const add = id => { if (seen.has(id) || provided.has(id)) return; seen.add(id); capabilityById.get(id).dependencies.forEach(add); ordered.push(id); };
  ids.forEach(add);
  const key = id => 'step-' + ordered.indexOf(id);
  return { intent: 'data_analysis', understanding: '按测试目标实际派发专业任务', scope, period: { kind: 'last_days', days: 7 }, metric_ids: [],
    execution_requested: ordered.some(id => capabilityById.get(id).mutating), scenario_id: scenarioId,
    steps: ordered.map(id => ({ id: key(id), capability_id: id, depends_on: capabilityById.get(id).dependencies.filter(dep => ordered.includes(dep)).map(key), input: input[id] || {}, reason: '验证本能力的实际输入、接单和输出' })) };
}
async function fixture(t, buildPlan, { fetcher, mutate } = {}) {
  const store = createDispatchStore(), handlers = createProviderHandlers(store); mutate?.(handlers);
  let service;
  service = createDispatchService({ store, handlers, fetcher, interpret: async run => service.submitPlan(run, buildPlan(run)) });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://test');
    if (await service.handleInternal(req, res, url)) return;
    req.identity = { uid: req.headers['x-test-user'] || 'alice' }; await service.handlePublic(req, res, url);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`; service.bind(base);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); service.close(); });
  const request = async (path, { method = 'GET', body, internal = false, user = 'alice' } = {}) => {
    const response = await fetch(base + '/api/dispatch/' + path, { method, headers: { 'content-type': 'application/json', 'x-test-user': user,
      ...(internal ? { 'x-dispatch-token': service.token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const run = async (previousRunId, message = '分析新街口并安排模拟处理，必要时回退参数') => {
    const created = (await request('runs', { method: 'POST', body: { message, previousRunId } })).data;
    return waitFor(async () => { const current = (await request('runs/' + created.id)).data; return ['completed', 'failed', 'needs_input'].includes(current.status) ? current : null; });
  };
  return { service, store, request, run };
}

test('场景、专业能力和原子工具引用完整，所有工具都有真实处理器', () => {
  const store = createDispatchStore(), handlers = createProviderHandlers(store);
  try {
    assert.equal(capabilities.length, 36); assert.equal(scenarios.length, 14); assert.equal(professionalAbilities.length, 16);
    assert.equal(new Set(capabilities.map(tool => tool.id)).size, capabilities.length);
    for (const group of professionalAbilities) { assert.ok(domains.some(domain => domain.id === group.domainId)); group.toolIds.forEach(id => assert.ok(capabilityById.has(id))); }
    for (const scene of scenarios) {
      scene.abilityIds.forEach(id => assert.ok(professionalAbilities.some(group => group.id === id)));
      scene.suggestedTools.forEach(id => { assert.ok(capabilityById.has(id)); assert.ok(professionalAbilities.some(group => scene.abilityIds.includes(group.id) && group.toolIds.includes(id)), `场景工具缺少专业能力归属 ${scene.id}:${id}`); });
    }
    for (const tool of capabilities) { assert.equal(typeof handlers[tool.id], 'function'); assert.ok(professionalAbilities.some(group => group.toolIds.includes(tool.id))); }
  } finally { store.close(); }
});

for (const tool of capabilities) test(`原子工具实际HTTP可调用：${tool.name}`, async t => {
  const f = await fixture(t, () => makePlan([tool.id]));
  const run = await f.run(undefined, tool.id === 'knowledge.search' ? '检索PRB高负荷与下载慢的专业知识' : '分析新街口并安排模拟处理，必要时回退参数');
  assert.equal(run.status, 'completed', JSON.stringify(run.tasks.filter(task => task.status !== 'completed')));
  const node = run.tasks.find(task => task.capabilityId === tool.id);
  assert.match(node.receipt.providerTaskId, /^JOB-/); assert.equal(node.receipt.transport, 'HTTP');
  assert.ok(node.result.summary); assert.ok(node.result.data); assert.ok(node.result.sources.length);
});

for (const scene of scenarios) test(`业务场景端到端：${scene.name}`, async t => {
  const needsExecution = ['short-review', 'rollback'].includes(scene.id);
  const f = await fixture(t, run => {
    if (needsExecution && !run.previousRunId) return makePlan(['optimization.execute']);
    const scope = ['knowledge-case', 'operations'].includes(scene.id) ? { grid_ids: [], cell_ids: [] }
      : scene.id === 'grid-comparison' ? { grid_ids: ['GRID-XJK', 'GRID-HX'], cell_ids: [] }
      : ['coverage', 'interference', 'six-dimensions'].includes(scene.id) ? { grid_ids: ['GRID-XL'], cell_ids: [] } : undefined;
    return makePlan(scene.suggestedTools, { scope, scenarioId: scene.id, provided: needsExecution ? new Set(['optimization.execute']) : new Set() });
  });
  const previous = needsExecution ? await f.run() : null;
  const run = await f.run(previous?.id);
  assert.equal(run.status, 'completed', JSON.stringify(run.tasks.filter(task => task.status !== 'completed')));
  assert.equal(run.intent.scenarioId, scene.id);
  assert.ok(run.intent.abilityIds.length);
  assert.ok(run.tasks.every(task => task.receipt?.providerTaskId));
  if (scene.id === 'six-dimensions') assert.equal(run.tasks.filter(task => task.capabilityId.startsWith('diagnosis.')).length, 6);
  if (scene.id === 'rule-audit') {
    const audit = run.tasks.find(task => task.capabilityId === 'decision.rule_assess').result.data;
    assert.ok(audit.checks.some(check => check.reason === 'rewritten'));
    assert.equal(audit.actions.find(action => action.parameter === 'load_balance_trigger').target, 80);
  }
  if (scene.id === 'operations') {
    const stats = run.tasks.find(task => task.capabilityId === 'operations.stats').result.data;
    assert.equal(stats.statistics.find(row => row.label === '闭环率').value, 37.5);
  }
});

test('原始规则保持单值、一步改写、反方向拒绝、无硬约束和开区间边界语义', async () => {
  const rows = await runReleaseFunction('constraints', { rows: [
    { id: 'rewrite', before: 85, target: 65, rule: { para: '>50', rule_scope: '-5' } },
    { id: 'opposite', before: 85, target: 90, rule: { para: '>50', rule_scope: '-5' } },
    { id: 'boundary', before: 55, target: 50, rule: { para: '>50', rule_scope: '-5' } },
    { id: 'multi', before: 1, target: 2, rule: { para: '1;2;3', rule_scope: '+1' } },
    { id: 'single', before: 0, target: 1, rule: { para: '1' } },
  ] });
  assert.equal(rows[0].final_b_para, '80'); assert.equal(rows[0].headroom.next_step_fits, true);
  assert.equal(rows[1].dispatch, false); assert.equal(rows[2].dispatch, false);
  assert.equal(rows[3].kind, 'multi'); assert.equal(rows[3].reason, 'passthrough'); assert.equal(rows[4].dispatch, true);
});

test('同参数不同值剔除双方，同值冗余不剔除，不同小区互不混淆', () => {
  const action = (id, cell_id, target) => ({ id, cell_id, parameter: 'p', target, final_ratio: id === 'a' ? 100 : 0 });
  const checked = resolveActionConflicts([action('a', 'cell-1', 1), action('b', 'cell-1', 2), action('c', 'cell-2', 1), action('d', 'cell-2', 1)]);
  assert.deepEqual(checked.dropped, ['a', 'b']); assert.equal(checked.redundancies.length, 1); assert.deepEqual(checked.actions.map(row => row.id), ['c', 'd']);
});

test('MR覆盖率按采样分子分母加权，不取小区覆盖率的算术平均', async t => {
  const f = await fixture(t, () => makePlan(['diagnosis.coverage']));
  f.store.db.exec('DELETE FROM mr_coverage');
  const at = new Date(Date.now() - 3600000).toISOString(), stmt = f.store.db.prepare('INSERT INTO mr_coverage VALUES(?,?,?,?,?)');
  stmt.run('XJK-NR-001', at, 100, 100, '商业中心'); stmt.run('XJK-NR-002', at, 900, 0, '商业中心');
  const run = await f.run(), coverage = run.tasks.find(task => task.capabilityId === 'diagnosis.coverage').result.data;
  assert.equal(coverage.coveragePercent, 10); assert.equal(coverage.totalSamples, 1000);
  assert.equal(coverage.rows.find(row => row.cell_id === 'XJK-NR-003').status, '数据不足');
});

test('排名输入改变实际排序，越界数量和未知输入字段在派发前拒绝', async t => {
  const f = await fixture(t, () => makePlan(['data.rank'], { input: { 'data.rank': { metric_id: 'dl_rate', order: 'asc', limit: 2 } } }));
  const run = await f.run(), data = run.tasks.find(task => task.capabilityId === 'data.rank').result.data;
  assert.equal(data.rows.length, 2); assert.ok(data.rows[0].value <= data.rows[1].value); assert.equal(data.metric, 'dl_rate');
  const raw = { ownerUid: 'alice', message: '查询', previousRunId: null };
  assert.throws(() => f.service.validatePlan(raw, makePlan(['data.rank'], { input: { 'data.rank': { limit: 1000 } } })), /输入/);
  assert.throws(() => f.service.validatePlan(raw, makePlan(['data.rank'], { input: { 'data.rank': { sql: 'DROP TABLE metrics' } } })), /输入/);
});

test('接单响应丢失可幂等重试，已实际接受的任务不重复执行', async t => {
  let lost = false;
  const f = await fixture(t, () => makePlan(['data.metrics']), { fetcher: async (url, options) => {
    const response = await fetch(url, options);
    if (!lost && options.method === 'POST' && url.endsWith('/providers/foundation/tasks')) { lost = true; await response.json(); throw new TypeError('模拟接单响应丢失'); }
    return response;
  } });
  const run = await f.run(); assert.equal(run.status, 'completed'); assert.equal(f.store.jobs.size, 1);
  assert.equal(run.events.filter(event => event.type === 'dispatch.retry').length, 1);
  const job = [...f.store.jobs.values()][0], duplicate = await f.request('providers/foundation/tasks', { method: 'POST', internal: true, body: { run_id: job.runId, step_id: job.stepId, capability_id: job.capabilityId } });
  assert.equal(duplicate.data.providerTaskId, job.id); assert.equal(duplicate.data.duplicate, true);
});

test('缺执行记录不能回退，跨网格前置结果不能复用，已回退记录不能重复执行', async t => {
  let current = 'execute';
  const f = await fixture(t, run => current === 'execute' ? makePlan(['optimization.execute']) : current === 'wrong-window'
    ? { ...makePlan(['optimization.diagnose'], { provided: new Set(['data.metrics']) }), period: { kind: 'yesterday' } }
    : makePlan(['optimization.rollback'], { provided: new Set(['optimization.execute']), scope: current === 'wrong-scope' ? { grid_ids: ['GRID-HX'], cell_ids: [] } : undefined }));
  const first = await f.run(); assert.equal(first.status, 'completed');
  current = 'wrong-scope';
  const wrong = await f.run(first.id); assert.equal(wrong.status, 'failed'); assert.equal(wrong.tasks.length, 0);
  current = 'wrong-window';
  const stale = await f.run(first.id); assert.equal(stale.status, 'failed'); assert.equal(stale.tasks.length, 0); assert.match(stale.error, /data.metrics/);
  current = 'rollback';
  const rolled = await f.run(first.id); assert.equal(rolled.status, 'completed');
  const repeated = await f.run(rolled.id); assert.equal(repeated.status, 'failed');
  assert.match(repeated.tasks.find(task => task.status === 'failed').error, /已经回退/);
});

test('风险等级未供数保持未分级，规则修改后的目标值才进入模拟执行', async t => {
  const f = await fixture(t, () => makePlan(['decision.risk_basis', 'decision.conflicts', 'optimization.execute']));
  const run = await f.run(); assert.equal(run.status, 'completed');
  const risk = run.tasks.find(task => task.capabilityId === 'decision.risk_basis').result.data;
  assert.ok(risk.rows.every(row => row.grade === '未分级'));
  const execution = run.tasks.find(task => task.capabilityId === 'optimization.execute').result.data;
  assert.equal(execution.actions.find(row => row.parameter === 'load_balance_trigger').target, 80);
});

test('能力调用统计按账号隔离，另一账号看不到实际调用次数', async t => {
  const f = await fixture(t, () => makePlan(['data.metrics'])); await f.run();
  const alice = await f.request('catalog'), bob = await f.request('catalog', { user: 'bob' });
  assert.equal(alice.data.usage['data.metrics'].calls, 1); assert.equal(bob.data.usage['data.metrics'], undefined);
});
