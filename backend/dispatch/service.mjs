import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createDispatchStore } from './store.mjs';
import { createProviderHandlers, resolvePeriod } from './providers.mjs';
import { agents, capabilities, capabilityById, intentLabels, metrics } from './catalog.mjs';
import { hierarchyCatalog, professionalAbilities, scenarios } from './hierarchy.mjs';

const error = (message, status = 422) => Object.assign(new Error(message), { status });
const terminal = new Set(['completed', 'failed', 'cancelled', 'needs_input']);
function validatedInput(value = {}, capability) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('工具输入必须是对象');
  const properties = capability.parameters.properties;
  for (const [key, input] of Object.entries(value)) {
    const spec = Object.hasOwn(properties, key) ? properties[key] : null;
    if (!spec || spec.type === 'integer' && (!Number.isInteger(input) || input < spec.minimum || input > spec.maximum) || spec.type === 'string' && (typeof input !== 'string' || spec.enum && !spec.enum.includes(input))) throw error(`${capability.name} 的输入 ${key} 无效`);
  }
  return value;
}
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
async function bodyOf(req) {
  let body = '', bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw error('请求体过大', 413); body += chunk; }
  let bodyValue;
  try { bodyValue = JSON.parse(body || '{}'); } catch { throw error('请求体不是合法 JSON', 400); }
  if (!bodyValue || typeof bodyValue !== 'object' || Array.isArray(bodyValue)) throw error('请求体必须是对象', 400);
  return bodyValue;
}

export function createDispatchService({ interpret, store = createDispatchStore(), handlers = createProviderHandlers(store), fetcher = fetch, interpretationTimeout = 90000, jobTimeout = 15000 } = {}) {
  const token = randomBytes(32).toString('hex');
  let baseUrl, closing = false;
  const controllers = new Map();
  const summaries = run => ({ id: run.id, message: run.message, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
    intent: run.intent, summary: run.summary, taskCount: run.tasks.length, completedCount: run.tasks.filter(task => task.status === 'completed').length });
  const publicRun = run => ({ ...summaries(run), previousRunId: run.previousRunId, engine: run.engine, clarification: run.clarification,
    error: run.error, tasks: run.tasks, events: run.events, result: run.result });
  const requireRun = (id, uid) => {
    const run = store.runs.get(id);
    if (!run || (uid !== undefined && run.ownerUid !== uid)) throw error('任务不存在', 404);
    return run;
  };
  const requireSession = sessionId => {
    const run = [...store.runs.values()].find(item => item.harnessSession === sessionId);
    if (!run || run.status !== 'interpreting') throw error('当前理解请求已结束或不存在', 409);
    return run;
  };
  const save = run => { run.updatedAt = new Date().toISOString(); store.saveRun(run); };
  const event = (run, type, detail) => { save(run); return store.event(run, type, detail); };
  const previousOutputs = (run, scope, window) => {
    const records = [], seen = new Set();
    let previousId = run.previousRunId;
    while (previousId && records.length < 8 && !seen.has(previousId)) {
      seen.add(previousId);
      const previous = requireRun(previousId, run.ownerUid);
      records.unshift(previous); previousId = previous.previousRunId;
    }
    const currentCells = scope ? store.scopeCells(scope).map(cell => cell.id).sort().join(',') : null;
    return records.flatMap(item => item.tasks.filter(task => {
      if (task.status !== 'completed' || currentCells !== null && store.scopeCells(task.scope || item.intent.scope).map(cell => cell.id).sort().join(',') !== currentCells) return false;
      const observation = /^(data\.|diagnosis\.|complaint\.)/.test(task.capabilityId) || ['optimization.diagnose', 'optimization.evidence', 'grid.portrait', 'region.common_cause'].includes(task.capabilityId);
      if (window && observation && (Math.abs(Date.parse(window.start) - Date.parse(item.intent.window.start)) > 60000 || Math.abs(Date.parse(window.end) - Date.parse(item.intent.window.end)) > 60000)) return false;
      return true;
    })
      .map(task => ({ step_id: task.id, capability_id: task.capabilityId, result: task.result })));
  };
  const contextFor = run => {
    const previous = run.previousRunId ? requireRun(run.previousRunId, run.ownerUid) : null;
    return { currentTime: new Date().toISOString(), timezone: 'Asia/Shanghai', message: run.message,
      scopes: { grids: store.grids().map(({ id, name, aliases }) => ({ id, name, aliases })), cells: store.cells().map(({ id, name, grid_id }) => ({ id, name, grid_id })) },
      metrics, ...hierarchyCatalog(), requestedScenario: scenarios.find(scene => scene.id === run.requestedScenarioId) || null, dataWindow: { start: store.dataStart, end: store.dataEnd },
      previous: previous ? { id: previous.id, message: previous.message, intent: previous.intent, summary: previous.summary,
        tasks: previous.tasks.map(task => ({ capability: task.capabilityId, status: task.status, summary: task.result?.summary })),
        hasPlan: previousOutputs(run).some(row => row.capability_id === 'optimization.plan'),
        hasExecution: previousOutputs(run).some(row => row.capability_id === 'optimization.execute'), hasRollback: previousOutputs(run).some(row => row.capability_id === 'optimization.rollback') } : null };
  };

  function validatePlan(run, plan) {
    if (!plan || !intentLabels[plan.intent] || typeof plan.understanding !== 'string' || !plan.understanding.trim() || plan.understanding.length > 1200) throw error('需要明确的意图类别和任务理解');
    if (typeof plan.execution_requested !== 'boolean') throw error('必须明确是否请求模拟执行');
    const rawScope = plan.scope || {}, scope = { grid_ids: rawScope.grid_ids || [], cell_ids: rawScope.cell_ids || [] };
    if (!Array.isArray(scope.grid_ids) || !Array.isArray(scope.cell_ids)) throw error('范围必须使用网格或小区 ID 数组');
    scope.grid_ids = [...new Set(scope.grid_ids)]; scope.cell_ids = [...new Set(scope.cell_ids)];
    if (scope.grid_ids.some(id => !store.grids().some(grid => grid.id === id)) || scope.cell_ids.some(id => !store.cells().some(cell => cell.id === id))) throw error('对象不在演示数据中，请澄清具体网格或小区');
    if (scope.grid_ids.length && scope.cell_ids.length && store.scopeCells(scope).some(cell => !scope.grid_ids.includes(cell.grid_id))) throw error('小区与网格范围不一致');
    const selectedMetrics = plan.metric_ids || [];
    if (!Array.isArray(selectedMetrics) || selectedMetrics.some(id => !metrics.some(metric => metric.id === id))) throw error('指标 ID 不在接入目录中');
    if (!Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 24) throw error('任务计划需要 1 至 24 个能力步骤');
    const window = resolvePeriod(plan.period || {});
    const ids = new Set(), selected = new Map(), previous = previousOutputs(run, scope, window);
    const tasks = plan.steps.map(step => {
      if (typeof step.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(step.id) || ids.has(step.id)) throw error('步骤 ID 必须唯一');
      ids.add(step.id);
      const ability = capabilityById.get(step.capability_id);
      if (!ability || !handlers[ability.id] || selected.has(ability.id)) throw error('计划包含未知能力或重复能力');
      if (!Array.isArray(step.depends_on) || step.depends_on.some(id => typeof id !== 'string') || typeof step.reason !== 'string' || step.reason.length > 600) throw error('每个步骤需要依赖列表及选择理由');
      if (ability.scopeRequired && !store.scopeCells(scope).length) throw error('缺少执行对象，请先澄清网格或小区');
      selected.set(ability.id, step.id);
      return { id: step.id, capabilityId: ability.id, agentId: ability.agentId, name: ability.name, reason: step.reason,
        dependsOn: [...new Set(step.depends_on)], input: validatedInput(step.input, ability), status: 'queued', mode: ability.mode };
    });
    const negatedExecution = /(?:不要|不必|别|禁止|无需|不需要).{0,10}(?:执行|下发|调参|修改)|只(?:做|要|需)?(?:分析|查询|建议|诊断)/.test(run.message);
    const mutating = tasks.filter(task => capabilityById.get(task.capabilityId).mutating);
    if (mutating.length && !plan.execution_requested || tasks.some(task => task.capabilityId === 'optimization.execute') && negatedExecution
      || tasks.some(task => task.capabilityId === 'optimization.rollback') && /(?:不要|不必|别|禁止|无需).{0,8}回退|只(?:分析|查询|建议|诊断)/.test(run.message)) throw error('本轮未授权模拟执行或回退，请移除执行步骤');
    if (tasks.some(task => task.capabilityId === 'optimization.evaluate') && !selected.has('optimization.execute') && !previous.some(row => row.capability_id === 'optimization.execute')) throw error('效果评估需要实际执行回执，当前只有方案时不能评估效果');
    for (const task of tasks) {
      for (const prerequisite of capabilityById.get(task.capabilityId).dependencies) {
        const dependency = selected.get(prerequisite);
        if (dependency) { if (!task.dependsOn.includes(dependency)) task.dependsOn.push(dependency); }
        else if (!previous.some(row => row.capability_id === prerequisite)) throw error(`${task.name} 需要先调用 ${prerequisite}，或复用上一任务已完成的结果`);
      }
      if (task.capabilityId === 'optimization.execute' && selected.has('region.coordinate')) task.dependsOn.push(selected.get('region.coordinate'));
      if (task.capabilityId === 'optimization.validate') for (const id of ['decision.rule_assess', 'decision.conflicts', 'decision.risk_basis']) if (selected.has(id)) task.dependsOn.push(selected.get(id));
      if (task.capabilityId === 'decision.conflicts' && selected.has('decision.rule_assess')) task.dependsOn.push(selected.get('decision.rule_assess'));
      if (task.capabilityId === 'optimization.evaluate' && selected.has('optimization.rollback')) task.dependsOn.push(selected.get('optimization.rollback'));
      task.dependsOn = [...new Set(task.dependsOn)];
      if (task.dependsOn.some(id => !ids.has(id) || id === task.id)) throw error('步骤依赖不存在或引用自身');
    }
    const visited = new Set(), visiting = new Set();
    const visit = id => {
      if (visiting.has(id)) throw error('任务计划存在循环依赖');
      if (visited.has(id)) return;
      visiting.add(id); tasks.find(task => task.id === id).dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
    };
    tasks.forEach(task => visit(task.id));
    const cells = store.scopeCells(scope), gridNames = store.grids().filter(grid => scope.grid_ids.includes(grid.id)).map(grid => grid.name);
    const entireGrid = gridNames.length && store.scopeCells({ grid_ids: scope.grid_ids }).length === cells.length;
    const sceneId = plan.scenario_id || run.requestedScenarioId;
    if (sceneId && !scenarios.some(scene => scene.id === sceneId)) throw error('业务场景不存在');
    return { intent: { type: plan.intent, label: intentLabels[plan.intent], understanding: plan.understanding.trim(), scope,
      scopeLabel: entireGrid ? `${gridNames.join('、')} · ${cells.length} 个小区` : scope.cell_ids.length ? cells.map(cell => cell.name).join('、') : gridNames.join('、') || (tasks.some(task => task.capabilityId.startsWith('operations.')) ? '全网演示工单' : '无线专业知识'),
      period: plan.period || { kind: 'last_days', days: 7 }, window, metric_ids: selectedMetrics,
      metricNames: metrics.filter(metric => selectedMetrics.includes(metric.id)).map(metric => metric.name), executionRequested: plan.execution_requested,
      scenarioId: sceneId || null, scenarioName: scenarios.find(scene => scene.id === sceneId)?.name || null,
      abilityIds: professionalAbilities.filter(group => tasks.some(task => group.toolIds.includes(task.capabilityId))).map(group => group.id),
      selectedAgents: [...new Set(tasks.map(task => task.agentId))] }, tasks };
  }

  async function request(url, { method = 'GET', body, signal, onRetry } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetcher(baseUrl + url, { method, headers: { 'content-type': 'application/json', 'x-dispatch-token': token },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(jobTimeout)]) : AbortSignal.timeout(jobTimeout) });
        const value = await response.json();
        if (!response.ok) throw error(value.error || `专业服务请求失败 ${response.status}`, response.status);
        return value;
      } catch (cause) {
        if (signal?.aborted || attempt === 2 || cause.status && cause.status < 500 || ['AbortError', 'TimeoutError'].includes(cause.name)) throw cause;
        onRetry?.(attempt + 1);
        await new Promise(resolve => setTimeout(resolve, 60 * (attempt + 1)));
      }
    }
  }

  async function dispatchTask(run, task, signal) {
    if (signal.aborted || run.status === 'cancelled') return;
    const ability = capabilityById.get(task.capabilityId);
    task.status = 'dispatching'; task.startedAt = new Date().toISOString();
    event(run, 'dispatch.requested', { taskId: task.id, agentId: task.agentId, message: `向${agents.find(agent => agent.id === task.agentId).name}派发「${task.name}」`, method: 'POST', endpoint: ability.endpoint });
    try {
      const receipt = await request(ability.endpoint, { method: 'POST', body: { run_id: run.id, step_id: task.id, capability_id: ability.id }, signal,
        onRetry: attempt => event(run, 'dispatch.retry', { taskId: task.id, agentId: task.agentId, message: `${task.name}接单连接重试 ${attempt}/2，沿用原任务标识` }),
      });
      if (signal.aborted) return;
      task.receipt = receipt; task.status = 'running';
      event(run, 'dispatch.accepted', { taskId: task.id, agentId: task.agentId, message: `${task.name}已接单`, providerTaskId: receipt.providerTaskId, endpoint: ability.endpoint });
      const deadline = Date.now() + jobTimeout;
      while (!signal.aborted && Date.now() < deadline) {
        const job = await request(`${ability.endpoint}/${receipt.providerTaskId}`, { signal });
        if (job.status === 'completed') {
          task.result = job.result; task.status = 'completed'; task.finishedAt = job.finishedAt;
          event(run, 'task.completed', { taskId: task.id, agentId: task.agentId, message: job.result.summary, providerTaskId: job.id });
          return;
        }
        if (job.status === 'failed' || job.status === 'cancelled') throw error(job.error || '专业任务执行失败');
        await new Promise(resolve => { const timer = setTimeout(resolve, 60); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      }
      if (!signal.aborted) throw error('专业任务超时，未收到完成回执', 504);
    } catch (cause) {
      if (signal.aborted || run.status === 'cancelled') return;
      task.status = 'failed'; task.error = cause.message; task.finishedAt = new Date().toISOString();
      event(run, 'task.failed', { taskId: task.id, agentId: task.agentId, message: cause.message });
    }
  }

  function finishRun(run) {
    const failed = run.tasks.filter(task => ['failed', 'blocked'].includes(task.status));
    const results = run.tasks.filter(task => task.status === 'completed').map(task => ({ capabilityId: task.capabilityId, agentId: task.agentId, ...task.result }));
    const evaluation = results.find(row => row.capabilityId === 'optimization.evaluate')?.data;
    const diagnostic = results.find(row => row.capabilityId === 'optimization.diagnose')?.data;
    const plan = results.find(row => row.capabilityId === 'optimization.plan')?.data;
    const rollback = results.find(row => row.capabilityId === 'optimization.rollback')?.data;
    run.status = failed.length ? 'failed' : 'completed';
    run.result = { outputs: results, businessOutcome: rollback ? 'rollback_completed' : evaluation?.businessOutcome || (plan ? 'proposal_ready' : diagnostic ? 'analysis_ready' : 'query_completed'), dataSource: '内存演示数据' };
    run.summary = failed.length ? `${results.length} 项完成，${failed.length} 项失败或受阻，请查看具体节点。`
      : rollback ? `已回退 ${rollback.actions.length} 项模拟参数，回执 ${rollback.executionId}。`
      : evaluation ? `${evaluation.passed} 项达到演示判据，${evaluation.pending} 项需继续处理。${evaluation.pending ? '已自动派发告警复查与根因复核。' : ''}评估依据为模拟快照。`
      : plan ? `已形成 ${plan.actions.length} 项优化建议${run.tasks.some(task => task.capabilityId === 'optimization.execute') ? '并完成模拟执行' : '，等待后续处理指令'}。`
      : results.at(-1)?.summary || '任务已完成';
    event(run, failed.length ? 'run.failed' : 'run.completed', { message: run.summary });
  }

  async function execute(run) {
    if (closing || run.status === 'cancelled') return;
    const controller = new AbortController(); controllers.set(run.id, controller);
    run.status = 'running'; save(run);
    try {
      while (!controller.signal.aborted) {
        const unfinished = run.tasks.filter(task => task.status === 'queued');
        if (!unfinished.length) break;
        for (const task of unfinished) if (task.dependsOn.some(id => ['failed', 'blocked', 'cancelled'].includes(run.tasks.find(item => item.id === id)?.status))) {
          task.status = 'blocked'; task.error = '前置任务未成功，未派发该能力';
          event(run, 'task.blocked', { taskId: task.id, message: task.error });
        }
        const ready = unfinished.filter(task => task.status === 'queued' && task.dependsOn.every(id => run.tasks.find(item => item.id === id)?.status === 'completed')).slice(0, 4);
        if (!ready.length) {
          for (const task of run.tasks.filter(item => item.status === 'queued')) { task.status = 'blocked'; task.error = '依赖条件未满足，未派发'; }
          break;
        }
        await Promise.all(ready.map(task => dispatchTask(run, task, controller.signal)));
        const evaluation = run.tasks.find(task => task.capabilityId === 'optimization.evaluate' && task.status === 'completed');
        if (evaluation?.result.data.pending && !run.followupScheduled && !controller.signal.aborted) {
          run.followupScheduled = true;
          const scope = { grid_ids: [], cell_ids: evaluation.result.data.comparisons.filter(row => !row.passed).map(row => row.cell_id) };
          run.tasks.push({ id: 'feedback-alarms', capabilityId: 'data.alarms', agentId: 'foundation', name: '反馈复查 · 基站告警', reason: '演示评估未达标，自动补查未达标小区的告警', dependsOn: [evaluation.id], scope, status: 'queued', mode: 'local', feedback: true },
            { id: 'feedback-diagnose', capabilityId: 'optimization.diagnose', agentId: 'optimization', name: '反馈复查 · 根因复核', reason: '依据未达标结果重新核验问题，形成后续处置建议', dependsOn: ['feedback-alarms'], scope, status: 'queued', mode: 'local', feedback: true });
          event(run, 'supervision.followup', { message: '效果存在未达标项，自动追加告警复查和根因复核任务' });
        }
      }
      if (!controller.signal.aborted) finishRun(run);
    } catch (cause) {
      if (!controller.signal.aborted) { run.status = 'failed'; run.error = cause.message; event(run, 'run.failed', { message: cause.message }); }
    } finally { controllers.delete(run.id); }
  }

  function submitPlan(run, plan) {
    if (run.status !== 'interpreting') throw error('该任务已有计划或已终止，不得重复派发', 409);
    const validated = validatePlan(run, plan);
    run.intent = validated.intent; run.tasks = validated.tasks; run.status = 'dispatching';
    event(run, 'intent.recognized', { message: run.intent.understanding, label: run.intent.label });
    event(run, 'plan.created', { message: `选择 ${run.tasks.length} 项能力，交由 ${run.intent.selectedAgents.length} 个能力提供方执行` });
    setImmediate(() => { void execute(run); });
    return { accepted: true, runId: run.id, intent: run.intent.label, tasks: run.tasks.map(task => ({ id: task.id, capability: task.capabilityId, agent: task.agentId })), message: '计划已提交真实调度器，任务状态以接口回执为准。停止调用计划工具。' };
  }

  async function understand(run) {
    const timeout = setTimeout(() => {
      if (run.status === 'interpreting') { run.status = 'failed'; run.error = '意图理解超时，未派发任何任务。请重试。'; event(run, 'interpretation.failed', { message: run.error }); }
    }, interpretationTimeout);
    try {
      if (!interpret) throw error('Harness 意图理解服务未配置', 503);
      await interpret(run, contextFor(run));
      if (run.status === 'interpreting') { run.status = 'needs_input'; run.clarification = '尚未得到可执行的调度计划。请明确要查询或处理的网格、小区和目标。'; event(run, 'intent.clarification', { message: run.clarification }); }
    } catch (cause) {
      if (run.status === 'interpreting') { run.status = 'failed'; run.error = `意图理解失败，未派发任务：${cause.message}`; event(run, 'interpretation.failed', { message: run.error }); }
    } finally { clearTimeout(timeout); }
  }

  function createRun(uid, message, previousRunId, scenarioId) {
    if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw error('请输入 1 至 4000 字的任务', 400);
    if (previousRunId) requireRun(previousRunId, uid);
    if (scenarioId && !scenarios.some(scene => scene.id === scenarioId)) throw error('业务场景不存在', 400);
    if ([...store.runs.values()].filter(run => run.ownerUid === uid && !terminal.has(run.status)).length >= 4) throw error('已有 4 个任务正在执行，请等待或停止后再试', 429);
    const at = new Date().toISOString();
    const run = { id: store.id('RUN'), ownerUid: uid, message: message.trim(), previousRunId: previousRunId || null,
      requestedScenarioId: scenarioId || null, harnessSession: randomUUID(), engine: 'Harness', status: 'interpreting', createdAt: at, updatedAt: at, tasks: [], events: [] };
    store.saveRun(run); event(run, 'intent.started', { message: 'Harness 正在理解目标、识别对象与时间，并选择可调用能力' });
    setImmediate(() => { void understand(run); });
    return publicRun(run);
  }

  function cancel(run) {
    if (terminal.has(run.status)) return publicRun(run);
    run.status = 'cancelled'; controllers.get(run.id)?.abort();
    run.tasks.filter(task => ['queued', 'dispatching', 'running'].includes(task.status)).forEach(task => { task.status = 'cancelled'; });
    for (const job of store.jobs.values()) if (job.runId === run.id && ['queued', 'running'].includes(job.status)) { job.status = 'cancelled'; store.saveJob(job); }
    event(run, 'run.cancelled', { message: '调度已停止，未开始的任务不再派发' });
    return publicRun(run);
  }

  async function acceptJob(agentId, input) {
    const run = requireRun(input.run_id), task = run.tasks.find(item => item.id === input.step_id);
    const capability = capabilityById.get(input.capability_id);
    if (!capability || capability.agentId !== agentId || task?.capabilityId !== capability.id) throw error('能力与派发任务不匹配');
    const existing = [...store.jobs.values()].find(job => job.runId === run.id && job.stepId === task.id);
    if (existing) return { providerTaskId: existing.id, acceptedAt: existing.acceptedAt, agentId, capabilityId: capability.id, status: existing.status, transport: 'HTTP', duplicate: true };
    if (!['dispatching', 'running'].includes(run.status) || !['dispatching', 'running'].includes(task.status)) throw error('任务当前状态不允许接单', 409);
    const job = { id: store.id('JOB'), runId: run.id, stepId: task.id, agentId, capabilityId: capability.id, status: 'queued', acceptedAt: new Date().toISOString() };
    store.saveJob(job);
    setImmediate(async () => {
      if (run.status === 'cancelled' || job.status === 'cancelled') return;
      job.status = 'running'; job.startedAt = new Date().toISOString(); store.saveJob(job);
      try {
        const upstream = [...previousOutputs(run, task.scope || run.intent.scope, run.intent.window), ...run.tasks.filter(item => item.status === 'completed').map(item => ({ step_id: item.id, capability_id: item.capabilityId, result: item.result }))];
        const result = await handlers[capability.id]({ context: { scope: task.scope || run.intent.scope, window: run.intent.window,
          metric_ids: run.intent.metric_ids, input: task.input || {}, ownerUid: run.ownerUid, query: run.message, intent: run.intent.type }, upstream, signal: controllers.get(run.id)?.signal }, message => {
          if (run.status !== 'cancelled') event(run, 'provider.progress', { taskId: task.id, agentId, message });
        });
        if (run.status === 'cancelled' || job.status === 'cancelled') return;
        job.result = result; job.status = 'completed';
      } catch (cause) { if (run.status === 'cancelled') return; job.status = 'failed'; job.error = cause.message; }
      job.finishedAt = new Date().toISOString(); store.saveJob(job);
    });
    return { providerTaskId: job.id, acceptedAt: job.acceptedAt, agentId, capabilityId: capability.id, status: 'accepted', transport: 'HTTP' };
  }

  async function handleInternal(req, res, url) {
    if (!url.pathname.startsWith('/api/dispatch/internal/') && !url.pathname.startsWith('/api/dispatch/providers/')) return false;
    const incoming = Buffer.from(String(req.headers['x-dispatch-token'] || ''));
    const expected = Buffer.from(token);
    if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) { json(res, 403, { error: '专业接口只接受调度器的已认证请求' }); return true; }
    try {
      const pathname = url.pathname;
      if (pathname === '/api/dispatch/internal/context' && req.method === 'POST') {
        const input = await bodyOf(req), run = requireSession(input.session_id);
        event(run, 'catalog.read', { message: `已读取 ${capabilities.length} 项能力及演示对象目录` });
        json(res, 200, contextFor(run)); return true;
      }
      if (pathname === '/api/dispatch/internal/plan' && req.method === 'POST') {
        const input = await bodyOf(req); json(res, 202, submitPlan(requireSession(input.session_id), input.plan)); return true;
      }
      if (pathname === '/api/dispatch/internal/clarify' && req.method === 'POST') {
        const input = await bodyOf(req), run = requireSession(input.session_id);
        if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 600) throw error('请给出简洁的澄清问题');
        run.status = 'needs_input'; run.clarification = input.question;
        event(run, 'intent.clarification', { message: input.question }); json(res, 200, { accepted: true }); return true;
      }
      const provider = pathname.match(/^\/api\/dispatch\/providers\/([a-z]+)\/tasks(?:\/([\w-]+))?$/);
      if (provider && req.method === 'POST' && !provider[2]) { json(res, 202, await acceptJob(provider[1], await bodyOf(req))); return true; }
      if (provider && req.method === 'GET' && provider[2]) {
        const job = store.jobs.get(provider[2]);
        if (!job || job.agentId !== provider[1]) throw error('专业任务不存在', 404);
        json(res, 200, job); return true;
      }
      json(res, 404, { error: '接口不存在' });
    } catch (cause) { json(res, cause.status || 500, { error: cause.message }); }
    return true;
  }

  async function handlePublic(req, res, url) {
    if (!url.pathname.startsWith('/api/dispatch/')) return false;
    try {
      const uid = req.identity.uid;
      if (url.pathname === '/api/dispatch/catalog' && req.method === 'GET') {
        const own = new Set([...store.runs.values()].filter(run => run.ownerUid === uid).map(run => run.id));
        const usage = {};
        for (const job of store.jobs.values()) if (own.has(job.runId)) {
          const item = usage[job.capabilityId] ||= { calls: 0, completed: 0, failed: 0 };
          item.calls++; if (job.status === 'completed') item.completed++; if (job.status === 'failed') item.failed++;
          if (!item.lastUsed || job.acceptedAt >= item.lastUsed) { item.lastUsed = job.acceptedAt; item.lastStatus = job.status; }
        }
        json(res, 200, { ...store.overview(), usage }); return true;
      }
      if (url.pathname === '/api/dispatch/runs' && req.method === 'GET') {
        json(res, 200, { runs: [...store.runs.values()].filter(run => run.ownerUid === uid).reverse().slice(0, 100).map(summaries) }); return true;
      }
      if (url.pathname === '/api/dispatch/runs' && req.method === 'POST') {
        const input = await bodyOf(req); json(res, 202, createRun(uid, input.message, input.previousRunId, input.scenarioId)); return true;
      }
      const match = url.pathname.match(/^\/api\/dispatch\/runs\/([\w-]+)(\/cancel)?$/);
      if (match && req.method === 'GET' && !match[2]) { json(res, 200, publicRun(requireRun(match[1], uid))); return true; }
      if (match && req.method === 'POST' && match[2]) { json(res, 200, cancel(requireRun(match[1], uid))); return true; }
      json(res, 404, { error: '调度接口不存在' });
    } catch (cause) { json(res, cause.status || 500, { error: cause.message }); }
    return true;
  }

  return { store, token, bind(url) { baseUrl = url; }, handleInternal, handlePublic, createRun, publicRun, validatePlan, submitPlan,
    close() {
      closing = true;
      for (const run of store.runs.values()) if (!terminal.has(run.status)) run.status = 'cancelled';
      controllers.forEach(controller => controller.abort()); store.close();
    } };
}
