import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDispatchService } from '../dispatch/service.mjs';
import { createDispatchStore } from '../dispatch/store.mjs';
import { createProviderHandlers } from '../dispatch/providers.mjs';

const step = (id, capability_id, depends_on = []) => ({ id, capability_id, depends_on, reason: `测试调用 ${capability_id}` });
const plan = steps => ({ intent: 'metrics_query', understanding: '查询新街口网格指标', scope: { grid_ids: ['GRID-XJK'], cell_ids: [] },
  period: { kind: 'last_days', days: 7 }, metric_ids: [], execution_requested: false, steps });
const waitFor = async (predicate, timeout = 7000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('等待任务状态超时');
};
async function fixture(t, { buildPlan, customInterpret, mutateHandlers } = {}) {
  const store = createDispatchStore(), handlers = createProviderHandlers(store);
  mutateHandlers?.(handlers);
  let service;
  service = createDispatchService({ store, handlers, interpret: customInterpret || (async run => service.submitPlan(run, buildPlan(run))), interpretationTimeout: 5000 });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (await service.handleInternal(req, res, url)) return;
    req.identity = { uid: req.headers['x-test-user'] || 'alice' };
    await service.handlePublic(req, res, url);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  service.bind(base);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); service.close(); });
  const request = async (path, { method = 'GET', body, user = 'alice', internal = false } = {}) => {
    const response = await fetch(base + '/api/dispatch/' + path, { method, headers: { 'content-type': 'application/json', 'x-test-user': user,
      ...(internal ? { 'x-dispatch-token': service.token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const create = async (message = '查新街口指标', previousRunId) => (await request('runs', { method: 'POST', body: { message, previousRunId } })).data;
  const finished = async id => waitFor(async () => { const value = (await request('runs/' + id)).data; return ['completed', 'failed', 'cancelled', 'needs_input'].includes(value.status) ? value : null; });
  return { service, store, request, create, finished };
}

test('启动装载内存数据；单查询只派发所选能力，并保存 HTTP 接单和实际观测', async t => {
  const f = await fixture(t, { buildPlan: () => ({ ...plan([step('metrics', 'data.metrics')]), metric_ids: ['prb'] }) });
  const catalog = await f.request('catalog');
  assert.equal(catalog.data.data.cells, 12); assert.equal(catalog.data.data.observations, 24192);
  const run = await f.create(), result = await f.finished(run.id);
  assert.equal(result.status, 'completed'); assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].receipt.transport, 'HTTP'); assert.match(result.tasks[0].receipt.providerTaskId, /^JOB-/);
  assert.equal(result.tasks[0].result.data.metrics[0].id, 'prb'); assert.equal(result.tasks[0].result.data.cells.length, 4);
  assert.ok(result.tasks[0].result.data.sampleCount > 0);
  assert.equal(result.events.filter(event => event.type === 'dispatch.accepted').length, 1);
  assert.equal(f.store.jobs.size, 1);
});

test('闭环 DAG 通过专业接口执行并从未达标结果真实追加复查任务', async t => {
  const f = await fixture(t, { buildPlan: () => ({ ...plan([
    step('grid', 'grid.resolve'), step('extract', 'complaint.extract'), step('boundary', 'complaint.b_domain', ['extract']),
    step('metrics', 'data.metrics', ['grid']), step('alarm', 'data.alarms', ['grid']), step('knowledge', 'knowledge.search'),
    step('correlate', 'complaint.correlate', ['boundary', 'metrics']), step('region', 'region.common_cause', ['correlate']),
    step('diagnose', 'optimization.diagnose', ['region', 'alarm']), step('plan', 'optimization.plan', ['diagnose', 'knowledge']),
    step('validate', 'optimization.validate', ['plan']), step('execute', 'optimization.execute', ['validate']), step('evaluate', 'optimization.evaluate', ['execute']),
  ]), intent: 'closed_loop', execution_requested: true }) });
  const run = await f.create('排查新街口投诉，安排处理并跟踪效果'), result = await f.finished(run.id);
  assert.equal(result.status, 'completed'); assert.equal(result.tasks.length, 15);
  assert.ok(result.tasks.every(task => task.receipt?.providerTaskId && task.status === 'completed'));
  assert.equal(new Set(result.tasks.map(task => task.receipt.providerTaskId)).size, 15);
  const execution = result.tasks.find(task => task.capabilityId === 'optimization.execute').result.data;
  const evaluation = result.tasks.find(task => task.capabilityId === 'optimization.evaluate').result.data;
  assert.equal(execution.actions.length, 4); assert.equal(evaluation.executionId, execution.executionId);
  assert.equal(evaluation.passed, 3); assert.equal(evaluation.pending, 1);
  assert.equal(result.result.businessOutcome, 'needs_followup');
  assert.equal(result.events.filter(event => event.type === 'supervision.followup').length, 1);
  assert.equal(result.tasks.filter(task => task.feedback).length, 2);
});

test('前置查询失败时依赖任务受阻，不产生虚假接单或执行回执', async t => {
  const f = await fixture(t, { buildPlan: () => plan([step('metrics', 'data.metrics'), step('diagnose', 'optimization.diagnose', ['metrics'])]),
    mutateHandlers: handlers => { handlers['data.metrics'] = async () => { throw new Error('测试数据服务不可用'); }; } });
  const run = await f.create(), result = await f.finished(run.id);
  assert.equal(result.status, 'failed'); assert.equal(result.tasks[0].status, 'failed');
  assert.equal(result.tasks[1].status, 'blocked'); assert.equal(result.tasks[1].receipt, undefined);
  assert.equal(f.store.jobs.size, 1);
});

test('计划边界：未知对象、循环依赖、缺少前提、未授权执行都被拒绝', async t => {
  const f = await fixture(t, { customInterpret: async () => {} });
  const raw = { ownerUid: 'alice', message: '只分析不要下发', previousRunId: null };
  assert.throws(() => f.service.validatePlan(raw, { ...plan([step('a', 'data.metrics')]), scope: { grid_ids: ['unknown'] } }), /对象不在/);
  assert.throws(() => f.service.validatePlan(raw, plan([step('a', 'data.metrics', ['b']), step('b', 'data.alarms', ['a'])])), /循环依赖/);
  assert.throws(() => f.service.validatePlan(raw, plan([step('a', 'optimization.plan')])), /需要先调用/);
  assert.throws(() => f.service.validatePlan(raw, { ...plan([step('a', 'optimization.execute')]), execution_requested: true }), /未授权/);
  assert.throws(() => f.service.validatePlan(raw, plan([step('a', 'optimization.evaluate')])), /实际执行回执/);
});

test('账号隔离、内部接单鉴权与取消理解中的任务', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { customInterpret: async run => { await gate; f.service.submitPlan(run, plan([step('metrics', 'data.metrics')])); } });
  const run = await f.create();
  assert.equal((await f.request('runs/' + run.id, { user: 'bob' })).status, 404);
  assert.equal((await f.request('runs', { method: 'POST', user: 'bob', body: { message: '继续', previousRunId: run.id } })).status, 404);
  assert.equal((await f.request('providers/foundation/tasks', { method: 'POST', body: {} })).status, 403);
  const cancelled = await f.request('runs/' + run.id + '/cancel', { method: 'POST' });
  assert.equal(cancelled.data.status, 'cancelled'); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.jobs.size, 0);
});

test('后续效果追问复用真实执行结果，不重复下发参数', async t => {
  let first = true;
  const f = await fixture(t, { buildPlan: () => {
    if (!first) return { ...plan([step('evaluate', 'optimization.evaluate')]), intent: 'effect_tracking' };
    first = false;
    return { ...plan([step('metrics', 'data.metrics'), step('diagnose', 'optimization.diagnose'), step('plan', 'optimization.plan'), step('validate', 'optimization.validate'), step('execute', 'optimization.execute')]), intent: 'optimization', execution_requested: true };
  } });
  const firstRun = await f.create('制定优化方案并执行'), firstResult = await f.finished(firstRun.id);
  assert.equal(firstResult.status, 'completed');
  const next = await f.create('看看效果', firstRun.id), result = await f.finished(next.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.tasks.filter(task => task.capabilityId === 'optimization.execute').length, 0);
  assert.equal(result.tasks[0].result.data.executionId, firstResult.tasks.at(-1).result.data.executionId);
});
