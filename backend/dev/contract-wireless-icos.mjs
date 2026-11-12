import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply } from '../dsh/dsh-wireless/lib/index.js'
import { createIcosService } from '../dsh/dsh-wireless/lib/icos.js'
import { createWorkorderStore } from '../dsh/dsh-wireless/lib/workflow.js'

// Synthetic fixtures exercise real source kernels, never a model or production system.
const input = () => ({ source_ref: 'ICOS contract test fixture',
  order: { taskno: 'CONTRACT-ICOS-1', task_type: '宏站弱覆盖小区', nettype: '4g', vendor: '华为',
    cell_name: 'TEST-CELL', conclusion: '弱覆盖，RSRP为-115dBm', cover_totalverdict: '弱覆盖，RSRP为-115dBm' },
  initial_plans: [
    { execution_id: '1', plan_number: 'P1', type1: '覆盖', type2: '弱覆盖', parachinname: 'TestPower', f_para: '0', b_para: '6' },
    { execution_id: '2', plan_number: 'P2', type1: '覆盖', type2: '弱覆盖', parachinname: 'TestOther', f_para: '0', b_para: '2' },
  ], rules: ['TestPower', 'TestOther'].map(parachinname => ({ type1: '覆盖', type2: '弱覆盖', nettype: '4g', vendor: '华为',
    parachinname, para: '<10', rule_scope: '+2', is_use: '是' })),
  cases: [{ case_id: 'TEST-CASE-1', source_ref: 'synthetic archived case fixture', problem_type: '宏站弱覆盖小区',
    cause1: '覆盖', cause2: '弱覆盖', estimate_result: '改善', actions: [{ parameter: 'TestPower', before: '0', after: '2' }] }],
})
const rootJudgment = { causes: [{ cause: '弱覆盖', category: '覆盖', confidence: 88, evidence: '弱覆盖，RSRP为-115dBm' }], reasoning: '原文有量化证据' }
const alignmentJudgment = { plans: ['P1', 'P2'].map(plan_id => ({ plan_id, relation: '针对根因', causes: ['弱覆盖'], reason: 'test fixture' })), reasoning: 'fixture' }
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-icos-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
async function judge(run, stage, run_id, judgment) {
  const pending = await run(stage, { run_id })
  if (pending.status !== 'needs_judgment') return pending
  assert.ok(pending.judgment_token)
  assert.ok(pending.judgment_requests.every(row => row.prompt.length > 30))
  return run(stage, { run_id, judgment_token: pending.judgment_token,
    ...(stage === 'candidates' ? { judgments: Object.fromEntries(pending.judgment_requests.map(row => [row.key, judgment])) } : { judgment }) })
}
async function prepared(run, fixture = input()) {
  const context = await run('context', { input: fixture })
  const id = context.run_id
  assert.equal((await run('decision', { run_id: id })).status, 'needs_stages')
  await run('objective', { run_id: id })
  await judge(run, 'root_cause', id, rootJudgment)
  await run('cases', { run_id: id })
  if (fixture.retry_times > 0) await run('multi_round', { run_id: id })
  await judge(run, 'candidates', id, { relevant_plans: ['P1'], reasoning: 'P1 targets the fixture root' })
  await judge(run, 'alignment', id, alignmentJudgment)
  const risk = await run('parameter_risk', { run_id: id })
  return { id, risk }
}

test('pinned ICOS files are unmodified and contain no production configuration', () => {
  const root = new URL('../dsh/dsh-wireless/vendor/icos/', import.meta.url)
  const manifest = JSON.parse(fs.readFileSync(new URL('source-manifest.json', root)))
  assert.ok(Object.keys(manifest.files).length > 30)
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(name, root))).digest('hex'), expected)
    assert.ok(!/config\.yml$|common\/llm.py|orders\/workers.py|orders\/push_service.py/.test(name))
  }
})

test('real SDK invokes every ICOS phase, source rules, review and existing workorder integration', async t => {
  const directory = temporary(t), previous = process.env.WIRELESS_DATA_DIR
  process.env.WIRELESS_DATA_DIR = directory
  t.after(() => { if (previous === undefined) delete process.env.WIRELESS_DATA_DIR; else process.env.WIRELESS_DATA_DIR = previous })
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx); apply(ctx)
  let serial = 0
  const used = new Set()
  const invoke = async (name, args) => {
    const result = await ctx.tools.execute({ name, arguments: args, callId: `icos-${++serial}`, signal: new AbortController().signal })
    assert.equal(result.isError, false, JSON.stringify(result))
    used.add(name)
    assert.deepEqual(JSON.parse(JSON.stringify(result.value)), result.value)
    return result.value
  }
  const wo = await invoke('wireless_workorder', { operation: 'intake', input: { raw_text: 'synthetic ICOS fixture', problem: '弱覆盖', source_ref: 'test' } })
  const run = (stage, args) => invoke(`wireless_icos_${stage}`, args)
  const context = await run('context', { input: input(), workorder_id: wo.workorder_id })
  const id = context.run_id
  assert.equal(context.result.initial_plan_count, 2)
  assert.equal((await run('objective', { run_id: id })).result.confirmed, true)
  await judge(run, 'root_cause', id, rootJudgment)
  const cases = await run('cases', { run_id: id })
  assert.equal(cases.result.hit_count, 1)
  assert.ok(cases.shared_history)
  await judge(run, 'candidates', id, { relevant_plans: ['P1'], reasoning: 'P1 is the relevant plan' })
  await judge(run, 'alignment', id, alignmentJudgment)
  const risk = await run('parameter_risk', { run_id: id })
  assert.equal(risk.result['1'].final_b_para, '2')
  const preview = await run('decision', { run_id: id, operation: 'preview' })
  assert.equal(preview.result.rows.find(row => row.execution_id === '1').b_para, '2')
  const review = await judge(run, 'consistency', id, { actions: input().initial_plans.map(row => ({
    execution_id: row.execution_id, parachinname: row.parachinname, relevance: '指标正向', path: 'test', evidence: '规则库事实',
  })), conflicts: [] })
  assert.equal(review.status, 'completed')
  const final = await run('decision', { run_id: id, operation: 'finalize', save_to_workorder: true })
  assert.equal(final.status, 'completed')
  assert.equal(final.device_operation_performed, false)
  assert.equal(final.result.decision.chain.dispatched_after, 1)
  assert.equal(final.result.decision.actions.length, 2)
  assert.ok(final.saved_plan.plan_id)
  const explained = await run('decision', { run_id: id, operation: 'explain' })
  assert.equal(explained.revision, final.revision)
  const rejectedExplanation = explained.result.actions.find(row => row.action_id === '2')
  assert.equal(rejectedExplanation.selected, false)
  assert.equal(rejectedExplanation.consistency.reviewed, true)
  assert.equal(rejectedExplanation.final_reason, final.result.decision.chain.actions.find(row => row.plan_key === '2').reason)
  const reusedRoot = await run('root_cause', { run_id: id })
  assert.equal(reusedRoot.status, 'completed')
  assert.equal(reusedRoot.reused, true)
  assert.equal(reusedRoot.revision, final.revision)
  const restored = await run('context', { operation: 'read', run_id: id })
  assert.equal(restored.stages.decision.response.result.decision.chain.dispatched_after, 1)
  const saved = await invoke('wireless_workorder', { operation: 'read', workorder_id: wo.workorder_id })
  assert.equal(saved.stages.plan.actions[0].target, '2')
  assert.equal(saved.executions, undefined)
  const compact = await run('context', { operation: 'read', run_id: id, view: 'summary' })
  assert.equal(compact.parameter_changes[0].delta, 6)
  assert.equal(compact.input_summary.observation_count, 0)
  assert.equal(compact.input_summary.diagnostic_text_available, true)
  assert.equal(compact.input, undefined)
  assert.ok(compact.stage_summaries.parameter_risk)
  assert.equal((await run('feedback', { run_id: id })).result.short_evaluations.length, 0)
  assert.equal((await run('multi_round', { run_id: id })).status, 'completed')
  assert.equal(used.size, 12) // Eleven ICOS tools and the existing workorder tool.
})

test('stage changes invalidate dependent results, reject stale judgments and survive restart', async t => {
  const directory = temporary(t), run = createIcosService({ directory })
  const { id } = await prepared(run)
  const pending = await run('consistency', { run_id: id })
  assert.equal(pending.status, 'needs_judgment')
  const old = await run('context', { operation: 'read', run_id: id })
  const changed = input(); changed.order.conclusion = '新原文：弱覆盖，RSRP为-115dBm'
  const updated = await run('context', { operation: 'update', run_id: id, input: changed, expected_revision: old.revision })
  assert.ok(updated.workflow.filter(row => row.stage !== 'context').every(row => row.status === 'not_started'))
  const root = await run('root_cause', { run_id: id })
  await assert.rejects(run('root_cause', { run_id: id, judgment: rootJudgment, judgment_token: 'stale' }), /judgment_token/)
  await assert.rejects(run('root_cause', { run_id: id, judgment_token: root.judgment_token,
    judgment: { causes: [{ ...rootJudgment.causes[0], evidence: 'invented evidence' }] } }), /原文/)
  await assert.rejects(run('objective', { run_id: id, expected_revision: old.revision }), /revision/)
  const restored = await createIcosService({ directory })('context', { operation: 'read', run_id: id })
  assert.equal(restored.input.order.conclusion, changed.order.conclusion)
  assert.equal(restored.stages.root_cause.response.status, 'needs_judgment')
})

test('source decision chain drops every conflicting target and review can demote a selected action', async t => {
  const run = createIcosService({ directory: temporary(t) })
  const fixture = input()
  fixture.initial_plans[1] = { ...fixture.initial_plans[1], type2: '过覆盖', parachinname: 'TestPower', b_para: '4' }
  fixture.rules = [{ ...fixture.rules[0], parachinname: 'OtherParameter' }]
  const { id } = await prepared(run, fixture)
  const preview = await run('decision', { run_id: id, operation: 'preview' })
  assert.equal(preview.result.decision.chain.dispatched_after, 0)
  assert.ok(preview.result.decision.chain.actions.every(row => row.dispatched === false))
  const normal = await prepared(run)
  await judge(run, 'consistency', normal.id, { actions: input().initial_plans.map(row => ({
    execution_id: row.execution_id, parachinname: row.parachinname, relevance: '指标存疑', path: 'no proven link', evidence: '规则库事实',
  })), conflicts: [] })
  const final = await run('decision', { run_id: normal.id })
  assert.equal(final.result.decision.chain.dispatched_after, 0)
})

test('original multi-round ladder uses actual receipt and linked adverse evaluation', async t => {
  const run = createIcosService({ directory: temporary(t) }), fixture = input()
  fixture.retry_times = 1
  fixture.initial_plans = [{ ...fixture.initial_plans[0], f_para: '-114', b_para: '-118' }]
  fixture.rules = [{ ...fixture.rules[0], para: '>-140', rule_scope: '-4' }]
  fixture.short_evals = [{ id: 5, short_assess_result: '恶化' }]
  fixture.prior_execution_rows = [{ agent_decision_id: 'prior-1', execution_id: '1', tool: 'TestPower', retry_times: 0,
    f_para: '-110', b_para: '-114', need_call_parameter_platform: '是', exec_feedback: '执行成功', short_result_id: 5,
    llm_solution: { new_chain: { enforced: true, rule: { matched_rule: fixture.rules[0] } } } }]
  const context = await run('context', { input: fixture }), id = context.run_id
  await run('cases', { run_id: id })
  const feedback = await run('feedback', { run_id: id })
  assert.equal(feedback.result.short_evaluations[0].classification, 'deteriorated')
  const steps = await run('multi_round', { run_id: id })
  assert.ok(JSON.stringify(steps.result).includes('-112'))
  const finishRound = async () => {
    await run('objective', { run_id: id })
    await judge(run, 'root_cause', id, rootJudgment)
    await run('candidates', { run_id: id })
    await judge(run, 'alignment', id, { plans: [alignmentJudgment.plans[0]], reasoning: 'fixture' })
    await run('parameter_risk', { run_id: id })
    await judge(run, 'consistency', id, { actions: [{ execution_id: '1', parachinname: 'TestPower',
      relevance: '指标正向', path: 'test', evidence: '规则库事实' }], conflicts: [] })
    return run('decision', { run_id: id })
  }
  const shrinkDecision = await finishRound()
  assert.equal(shrinkDecision.result.rows[0].f_para, '-114')
  assert.equal(shrinkDecision.result.rows[0].b_para, '-112')
  assert.equal(shrinkDecision.result.manual_required, false)
  const rollback = await run('multi_round', { run_id: id, rollback_only: true })
  assert.ok(JSON.stringify(rollback.result).includes('-110'))
  const rollbackDecision = await finishRound()
  assert.equal(rollbackDecision.result.rows[0].b_para, '-110')
  assert.equal(rollbackDecision.result.rollback_only, true)
  assert.equal(rollbackDecision.result.manual_required, true)
  fixture.prior_execution_rows[0].exec_feedback = '执行失败'
  const other = await run('context', { input: fixture })
  await run('cases', { run_id: other.run_id })
  const failed = await run('multi_round', { run_id: other.run_id })
  assert.ok(!JSON.stringify(failed.result).includes('"value":"-112"'))
})

test('input boundaries reject duplicate source identities, foreign tasks and outside-workspace paths', async t => {
  const directory = temporary(t), run = createIcosService({ directory, workspace: directory })
  const duplicate = input(); duplicate.initial_plans[1].execution_id = '1'
  await assert.rejects(run('context', { input: duplicate }), /唯一/)
  const foreign = input(); foreign.initial_plans[0].taskno = 'another-order'
  await assert.rejects(run('context', { input: foreign }), /taskno/)
  await assert.rejects(run('context', { input: { order: { taskno: 'x' } } }), /source_ref/)
  await assert.rejects(run('context', { file_path: '/etc/hosts' }), /工作区/)
  await assert.rejects(run('context', { operation: 'read', run_id: '../../bad' }), /run_id/)
})

test('archived feedback keeps disabled short evaluations, failed actions and contradictory outcome labels separate', async t => {
  const run = createIcosService({ directory: temporary(t) })
  const context = await run('context', { input: input() })
  const result = await run('feedback', { run_id: context.run_id, archived_feedback: {
    source_ref: 'archived-feedback-fixture', actions: [
      { execution_id: '1', parameter: 'TestPower', before: '0', after: '6', exec_state: 'exec_failed', long_eval_result: 'long_eval_unknown' },
      { execution_id: '2', parameter: 'TestOther', before: '0', after: '2', exec_state: 'exec_success',
        short_eval_raw: '评估不通过(短评估未启用,直接进入系统评估)', long_eval_result: 'long_eval_fail', improvement_result: '改善' },
    ],
  } })
  assert.equal(result.result.archived_feedback.actions[0].actual_after, null)
  assert.equal(result.result.archived_feedback.actions[1].actual_after, '2')
  assert.equal(result.result.archived_feedback.actions[1].short_evaluation_classification, null)
  assert.equal(result.result.archived_feedback.outcome_label_conflicts, 1)
  const restored = await run('context', { run_id: context.run_id, operation: 'read' })
  assert.equal(restored.input.archived_feedback, undefined)
  assert.ok(restored.stages.feedback.request.archived_feedback)
  await assert.rejects(run('feedback', { run_id: context.run_id, archived_feedback: {
    source_ref: 'wrong-order', actions: [{ execution_id: 'other-task', exec_state: 'exec_success' }],
  } }), /不属于/)
})

test('linking an existing workorder preserves the input and completed analysis stages', async t => {
  const directory = temporary(t), store = createWorkorderStore({ directory }), run = createIcosService({ directory, workorder: store })
  const context = await run('context', { input: input() })
  await run('objective', { run_id: context.run_id })
  const order = store({ operation: 'intake', input: { problem: '真实归档联调测试', source_ref: 'test' } })
  const linked = await run('context', { operation: 'link_workorder', run_id: context.run_id, workorder_id: order.workorder_id })
  assert.equal(linked.workorder_id, order.workorder_id)
  assert.deepEqual(linked.invalidated_stages, [])
  assert.equal(linked.workflow.find(row => row.stage === 'objective').status, 'completed')
  const restored = await run('context', { operation: 'read', run_id: context.run_id })
  assert.equal(restored.input.order.taskno, input().order.taskno)
  const again = await run('context', { operation: 'link_workorder', run_id: context.run_id, workorder_id: order.workorder_id })
  assert.equal(again.revision, linked.revision)
})
