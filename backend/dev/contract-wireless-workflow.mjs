import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applySkill } from '@deepseek-ai/dsh-tool-skill'
import { apply } from '../dsh/dsh-wireless/lib/index.js'
import { createWorkorderStore, buildEvidence, evaluateEffect, identifyProblem, windowOf } from '../dsh/dsh-wireless/lib/workflow.js'
import { createMemoryService } from '../dsh/dsh-wireless/lib/compiler.js'
import { echoQuery, echoStatus } from '../dsh/dsh-wireless/lib/echo.js'
import { listProjectSkills, skillDirectories } from '../harness/skills.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const names = ['wireless-workorder-orchestrator', 'wireless-workorder-intake', 'wireless-problem-identification',
  'wireless-case-retrieval', 'wireless-evidence-builder', 'wireless-root-cause-analysis', 'wireless-solution-decision',
  'wireless-parameter-adaptation', 'wireless-effect-evaluation', 'wireless-knowledge-compiler', 'wireless-echo-mem',
  'wireless-data-analysis', 'wireless-memory-engineering']
const window = { start: '2026-10-07T10:00:00+08:00', end: '2026-10-07T11:00:00+08:00' }
const intake = { raw_text: 'LTE 小区 C1 低速率，PRB 高', problem: '低速率', object_id: 'C1', system: '4G',
  vendor: '华为', software_version: 'user-supplied-v1', time_window: window, source_ref: '本次用户工单' }
const metric = { kind: 'kpi', object_id: 'C1', time_window: window, metric: 'PRB 利用率', value: 95,
  unit: '%', definition: '忙时下行 PRB 利用率', sample_count: 1000, source_ref: '用户提供 KPI 表第 1 行',
  good_direction: 'lower', threshold: { operator: 'gt', value: 90, source_ref: '用户声明异常门限' } }
function temporary(t) {
  fs.mkdirSync(path.join(root, '.run'), { recursive: true })
  const directory = fs.mkdtempSync(path.join(root, '.run/wireless-workflow-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('analysis and engineering skills are discoverable and load through the real skill tool', async t => {
  assert.deepEqual((await listProjectSkills(root)).map(row => row.name).sort(), [...names].sort())
  const ctx = new Context(), registry = new SkillRegistry(ctx)
  let provider
  const unregister = registry.registerProvider(control => {
    provider = new FileSystemSkillProvider(ctx, control, { includeDefaultRoots: false, customSkillDirs: skillDirectories(root), watch: false })
    return provider
  })
  t.after(async () => { await provider.dispose(); unregister(); await ctx.fiber.dispose() })
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  applySkill(ctx)
  apply(ctx)
  for (const name of names) {
    const result = await ctx.tools.get('skill').execute({ name }, { signal: new AbortController().signal })
    assert.ok(result.content.length > 0)
    assert.equal(result.resourceBase.path, path.join(root, 'skills', name))
  }
  for (const name of ['wireless_echo_query', 'wireless_workorder', 'wireless_compile_history', 'wireless_memory_query']) assert.ok(ctx.tools.get(name))
})

test('ECHO principles retrieve real frozen protocols/code and distinguish them from executable capabilities', () => {
  assert.equal(echoStatus().source_files, 158)
  const authority = echoQuery({ query: '整单 Pass 可以广播给每个参数吗？', view: 'implementation' })
  assert.ok(authority.guides.some(row => row.id === 'authority'))
  const protocol = authority.passages.find(row => row.reference.source_path.endsWith('evidence_authority_propagation.md'))
  assert.ok(protocol.text.includes('multi-action plan') && protocol.text.includes('single-action'))
  assert.ok(protocol.reference.url.includes(echoStatus().source_commit + '/') && protocol.reference.start_line > 0)
  const read = echoQuery({ source_path: 'pipeline/transition/state.py', start_line: 95 })
  assert.ok(read.passages[0].text.includes('source_type1_type2_label'))
  assert.ok(echoQuery({ query: 'RCA validated 是否证明根因正确？' }).guides.some(row => row.id === 'state'))
  assert.ok(echoQuery({ query: 'LCB 后验可信度怎么算？', view: 'implementation' }).passages.some(row => row.reference.source_path.endsWith('bayesian_score.py')))
  assert.ok(echoQuery({ query: 'Static Adaptive 时序回放如何防泄漏？', limit: 3, view: 'implementation' }).passages
    .every(row => !row.reference.source_path.endsWith('CODEX_RUNBOOK.md')))
  assert.equal(echoQuery({ query: 'FooBeamQuantumXYZ' }).status, 'no_source_match')
  assert.throws(() => echoQuery({ source_path: '../../.env' }), /source_path/)
  assert.throws(() => echoQuery({ source_path: 'README.md', start_line: 99999 }), /start_line/)
  assert.ok(echoStatus().not_connected.some(row => row.includes('网管')))
  // SDK dispatch requires lossless JSON; undefined optional properties fail only at dispatch.
  for (const args of [{ query: '六类记忆', topic: 'compilation' }, { query: '整单 Pass' },
    { query: '' }, { source_path: 'README.md' }]) {
    const output = echoQuery(args)
    assert.deepEqual(JSON.parse(JSON.stringify(output)), output)
  }
})

test('plans and sourced execution feedback remain distinct, immutable, idempotent and recoverable', t => {
  const directory = temporary(t), run = createWorkorderStore({ directory })
  const first = run({ operation: 'intake', input: intake }), id = first.workorder_id
  const proposal = { title: '模拟候选', rationale: '来自本次用户模拟建议，尚无实测效果', source_refs: ['用户模拟输入'],
    actions: [{ parameter: 'Sim.A', current: 0, target: 1, constraints: {
      min: 0, max: 2, step: 1, unit: '模拟编码', constraint_source: '用户模拟声明' } }, { parameter: 'Sim.B' }] }
  const planned = run({ operation: 'save_plan', workorder_id: id, input: proposal })
  const plan = planned.stages.plan
  assert.equal(plan.status, 'draft_needs_data')
  assert.equal(plan.execution_permission, 'not_granted')
  assert.equal(planned.executions, undefined)
  assert.equal(plan.actions[1].constraint_check.current, null)
  assert.equal(run({ operation: 'save_plan', workorder_id: id, input: proposal }).revision, planned.revision)
  assert.throws(() => run({ operation: 'save_plan', workorder_id: id, input: { ...proposal, evidence_ids: ['invented'] } }), /证据 ID/)
  const action = plan.actions[0]
  assert.throws(() => run({ operation: 'record_execution', workorder_id: id, input: { plan_id: plan.plan_id,
    actions: [{ action_id: action.action_id, state: 'executed_success' }] } }), /source_ref/)
  assert.throws(() => run({ operation: 'record_execution', workorder_id: id, input: { plan_id: plan.plan_id,
    source_ref: '用户反馈', actions: [{ action_id: 'invented', state: 'executed_success' }] } }), /动作 ID/)
  assert.throws(() => run({ operation: 'record_execution', workorder_id: id, input: { plan_id: plan.plan_id,
    source_ref: '用户反馈', actions: [{ action_id: action.action_id, state: 'executed_success', executed_at: '2026-02-30T00:00:00+08:00' }] } }), /ISO/)
  const partialInput = { plan_id: plan.plan_id, source_ref: '用户模拟反馈',
    actions: [{ action_id: action.action_id, state: 'executed_success', before: 0 }] }
  const partial = run({ operation: 'record_execution', workorder_id: id, input: partialInput })
  const event = partial.stages.execution
  assert.equal(event.device_operation_performed, false)
  assert.equal(event.scope, 'submitted_bundle')
  assert.equal(event.actions[0].after, undefined)
  assert.ok(event.missing_fields.includes('actions.0.after'))
  assert.equal(event.unreported_action_ids.length, 1)
  assert.equal(run({ operation: 'record_execution', workorder_id: id, input: partialInput }).revision, partial.revision)
  const corrected = run({ operation: 'record_execution', workorder_id: id, input: { ...partialInput,
    supersedes_execution_id: event.execution_id,
    actions: [{ action_id: action.action_id, state: 'executed_success', before: 0, after: 2, executed_at: window.end }] } })
  assert.equal(corrected.executions.length, 2)
  assert.equal(corrected.stages.execution.actions[0].actual_differs_from_plan, true)
  assert.equal(corrected.executions[0].actions[0].after, undefined)
  const evaluated = run({ operation: 'evaluate', workorder_id: id, input: { execution_id: corrected.stages.execution.execution_id } })
  assert.equal(evaluated.stages.evaluation.status, 'not_assessable')
  assert.equal(evaluated.stages.evaluation.attribution_scope, 'submitted_bundle_partial_realization_observational')
  assert.throws(() => run({ operation: 'evaluate', workorder_id: id, input: { execution: { state: 'executed_success' } } }), /execution_id/)
  const history = createWorkorderStore({ directory })({ operation: 'history', workorder_id: id })
  assert.ok(history.events.some(row => row.operation === 'record_execution' && row.input.source_ref && row.result.execution_id))
  assert.equal(history.plans.length, 1)
  assert.equal(history.executions.length, 2)
  const updated = run({ operation: 'intake', workorder_id: id, input: { ...intake, vendor: '中兴' } })
  assert.equal(updated.plans[0].plan_id, plan.plan_id)
  assert.equal(updated.stages.execution, undefined)
  assert.throws(() => run({ operation: 'evaluate', workorder_id: id, input: { execution_id: event.execution_id } }), /旧工单/)
})

test('linked effect uses recorded actual execution and rejects feedback from a rolled-back plan', t => {
  const run = createWorkorderStore({ directory: temporary(t) })
  const first = run({ operation: 'intake', input: intake }), id = first.workorder_id
  const saved = run({ operation: 'save_plan', workorder_id: id, input: { title: '模拟单动作', rationale: '验证输入链',
    source_refs: ['模拟'], actions: [{ parameter: 'Sim.A', current: 0, target: 1,
      constraints: { enum_values: [0, 1], unit: '模拟', constraint_source: '模拟' } }] } })
  const plan = saved.stages.plan, action = plan.actions[0]
  const executed = run({ operation: 'record_execution', workorder_id: id, input: { plan_id: plan.plan_id,
    source_ref: '模拟执行日志', actions: [{ action_id: action.action_id, state: 'executed_success', before: 0, after: 1, executed_at: window.end }] } })
  const before = { ...metric, metric: 'RRC 接通率', definition: 'RRC 成功/请求', value: 95, good_direction: 'higher', threshold: undefined }
  const input = { execution_id: executed.stages.execution.execution_id, before: [before], after: [{ ...before, value: 98,
    time_window: { start: window.end, end: '2026-10-07T12:00:00+08:00' } }],
    evaluation_rule: { min_observation_hours: 1, required_metrics: ['RRC 接通率'], min_absolute_improvement: 2, source_ref: '用户模拟判据' } }
  const evaluated = run({ operation: 'evaluate', workorder_id: id, input })
  assert.equal(evaluated.stages.evaluation.status, 'declared_rule_met')
  assert.equal(evaluated.stages.evaluation.comparisons[0].delta, 3)
  const rolled = run({ operation: 'record_execution', workorder_id: id, input: { plan_id: plan.plan_id,
    source_ref: '模拟回退日志', supersedes_execution_id: executed.stages.execution.execution_id,
    actions: [{ action_id: action.action_id, state: 'rolled_back', before: 0, after: 1, executed_at: window.end,
      rollback_at: '2026-10-07T11:30:00+08:00', rollback_value: 0 }] } })
  assert.equal(rolled.stages.evaluation, undefined)
  assert.throws(() => run({ operation: 'evaluate', workorder_id: id, input }), /更正/)
  assert.equal(run({ operation: 'evaluate', workorder_id: id, input: { ...input,
    execution_id: rolled.stages.execution.execution_id } }).stages.evaluation.status, 'not_assessable')
})

test('stable intake is idempotent, survives reopen and invalidates stale stages on new input', t => {
  const directory = temporary(t), run = createWorkorderStore({ directory })
  const first = run({ operation: 'intake', input: intake })
  assert.equal(first.input.system, 'LTE')
  assert.equal(first.stages.intake.status, 'normalized')
  assert.equal(run({ operation: 'intake', input: intake }).revision, first.revision)
  const evidence = run({ operation: 'build_evidence', workorder_id: first.workorder_id, input: { observations: [metric] } })
  assert.equal(evidence.stages.evidence.current_evidence.length, 1)
  const id = evidence.stages.evidence.current_evidence[0].evidence_id
  const diagnosed = run({ operation: 'diagnose', workorder_id: first.workorder_id, input: { hypotheses: [{
    cause: '负荷压力待验证', supporting_evidence_ids: [id], contradicting_evidence_ids: [], distinguishing_checks: ['检查用户数及吞吐'] }] } })
  assert.equal(diagnosed.stages.diagnosis.hypotheses[0].status, 'current_evidence_supported_hypothesis')
  assert.equal(createWorkorderStore({ directory })({ operation: 'read', workorder_id: first.workorder_id }).revision, diagnosed.revision)
  assert.throws(() => run({ operation: 'identify', workorder_id: first.workorder_id, expected_revision: 0 }), /revision/)
  const classified = run({ operation: 'identify', workorder_id: first.workorder_id })
  assert.ok(classified.stages.identify.candidate_issue_types.some(row => row.issue_type === '低速率'))
  assert.equal(classified.stages.identify.severity, 'unknown')
  const fullDescription = { ...intake, raw_text: intake.raw_text + ' SINR 18 dB，无异常门限。' }
  const classification = identifyProblem(fullDescription, evidence.stages.evidence)
  assert.equal(classification.primary_issue_type, '低速率')
  assert.equal(classification.candidate_issue_types.some(row => row.issue_type === '干扰问题'), false)
  const updated = run({ operation: 'intake', workorder_id: first.workorder_id, input: { ...intake, vendor: '中兴' } })
  assert.equal(updated.stages.diagnosis, undefined)
  assert.equal(updated.stages.evidence, undefined)
  assert.throws(() => run({ operation: 'read', workorder_id: '../private' }), /workorder_id/)
})

test('evidence quarantines cross-object/window, source gaps and conflicting rates; historical IDs remain separate', () => {
  const workorder = { ...intake, time_window: windowOf(window) }
  const result = buildEvidence(workorder, { observations: [metric, metric,
    { ...metric, object_id: 'C2' }, { ...metric, time_window: { ...window, end: '2026-10-07T12:00:00+08:00' } },
    { ...metric, source_ref: '' }, { ...metric, numerator: 5, denominator: 1000 }, { ...metric, value: 200 }],
    historical_case_ids: ['real-low-access-bundle'] })
  assert.equal(result.current_evidence.length, 1)
  assert.equal(result.duplicates.length, 1)
  assert.equal(result.quarantined.length, 5)
  assert.equal(result.historical_references.length, 1)
  assert.equal(result.historical_references[0].outcome.scope, 'ticket_bundle')
  assert.equal(windowOf({ start: '2026-02-30T00:00:00+08:00', end: '2026-03-01T00:00:00+08:00' }), null)
  assert.equal(windowOf({ start: '2026-10-07T10:00:00', end: '2026-10-07T11:00:00' }), null)
})

test('diagnosis rejects nonexistent and quarantined evidence without changing the ledger', t => {
  const run = createWorkorderStore({ directory: temporary(t) })
  const first = run({ operation: 'intake', input: intake })
  assert.throws(() => run({ operation: 'diagnose', workorder_id: first.workorder_id, input: { hypotheses: [{
    cause: '未经验证的归因', supporting_evidence_ids: ['invented'], contradicting_evidence_ids: [] }] } }), /证据 ID/)
  assert.equal(run({ operation: 'read', workorder_id: first.workorder_id }).revision, first.revision)
})

test('effect comparison keeps percentage points, sample sufficiency, maturity, execution and bundle scope distinct', () => {
  const before = { ...metric, metric: 'RRC 接通率', definition: 'RRC 建立成功次数 / 请求次数', value: 95,
    good_direction: 'higher', threshold: undefined, numerator: 950, denominator: 1000 }
  const after = { ...before, value: 98, numerator: 980, time_window: { start: '2026-10-07T11:00:00+08:00', end: '2026-10-07T12:00:00+08:00' } }
  const input = { before: [before], after: [after], execution: { state: 'executed_success', executed_at: window.end,
    actions: [{ parameter: 'A', before: 0, after: 1 }, { parameter: 'B', before: 2, after: 3 }] },
    evaluation_rule: { min_observation_hours: 1, required_metrics: ['RRC 接通率'], min_absolute_improvement: 2, source_ref: '用户声明' } }
  const result = evaluateEffect(intake, input)
  assert.equal(result.status, 'declared_rule_met')
  assert.equal(result.comparisons[0].delta, 3)
  assert.equal(result.comparisons[0].delta_unit, 'percentage_points')
  assert.ok(Math.abs(result.comparisons[0].relative_change_percent - 3 / 95 * 100) < 1e-8)
  assert.equal(result.attribution_scope, 'executed_bundle_observational')
  assert.equal(evaluateEffect(intake, { ...input, evaluation_rule: { ...input.evaluation_rule, min_observation_hours: 7 } }).status, 'observing')
  assert.equal(evaluateEffect(intake, { ...input, execution: { ...input.execution, state: 'execution_failed' } }).status, 'process_failure')
  assert.equal(evaluateEffect(intake, { ...input, after: [{ ...after, object_id: 'C2' }] }).status, 'needs_data')
  assert.equal(evaluateEffect(intake, { ...input, after: [{ ...after, sample_count: undefined }] }).status, 'needs_data')
  assert.equal(evaluateEffect(intake, { ...input, after: [{ ...after, numerator: 1 }] }).status, 'needs_data')
})

test('pinned source compiler creates a demo package, preserves small-sample states and rejects misleading historical inputs', { timeout: 75000 }, async t => {
  const directory = temporary(t)
  const trace = JSON.parse(fs.readFileSync(path.join(root, 'backend/dsh/dsh-wireless/resources/sample-traces.json')))[0]
  const input = path.join(directory, 'input.jsonl')
  fs.writeFileSync(input, JSON.stringify(trace) + '\n' + JSON.stringify(trace) + '\n')
  const service = createMemoryService({ directory, workspace: root })
  const args = { file_path: input, mode: 'demo', as_of: '2026-10-08T00:00:00+08:00' }
  const compiled = await service.compile(args)
  assert.equal(compiled.status, 'compiled_local_package')
  assert.equal(compiled.duplicates_removed, 1)
  const queried = service.query({ package_id: compiled.package_id })
  assert.equal(queried.compiler.mode, 'demo')
  assert.ok(queried.total_matches > 0)
  assert.ok(queried.memories.filter(row => row.memory.memory_type === 'strategy_memory')
    .every(row => row.memory.state === 'unverified'))
  // RCA lifecycle validates structural evidence, not effect or root-cause correctness.
  const rca = queried.memories.find(row => row.memory.memory_type === 'rca_memory')
  assert.equal(rca.memory.metrics.long_eval_pass_count, 0)
  assert.equal(service.search({ query: '切换差' }).total_matches, 0, 'auto discovery excludes demo effect evidence')
  const discovered = service.search({ query: '切换差', include_demo: true })
  assert.ok(discovered.total_matches > 0)
  assert.equal(discovered.by_type.rca_memory.memories[0].package_id, compiled.package_id)
  assert.equal((await service.compile(args)).reused, true)
  assert.equal((await service.compile({ ...args, as_of: '2026-05-02T00:00:00+08:00' })).status, 'needs_data')
  assert.equal((await service.compile({ file_path: input, mode: 'historical', as_of: args.as_of })).status, 'needs_data')
  await assert.rejects(() => service.compile({ ...args, mode: 'historical', evaluation_visible_at_cutoff: true }), /demo traces/)
  const broken = { ...trace, ticket: { ...trace.ticket, state: '冲突' } }
  fs.writeFileSync(input, JSON.stringify(trace) + '\n' + JSON.stringify(broken) + '\n')
  await assert.rejects(() => service.compile(args), /duplicate trace_id/)
  assert.throws(() => service.query({ package_id: '../escape' }), /package_id/)
})
