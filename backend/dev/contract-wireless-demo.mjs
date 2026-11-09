import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { analyzeObservations, readObservations } from '../dsh/dsh-wireless/lib/analytics.js'
import { createDemoService, demoCatalog, demoScenario } from '../dsh/dsh-wireless/lib/demo.js'
import { createMemoryService } from '../dsh/dsh-wireless/lib/compiler.js'
import { createDecisionService } from '../dsh/dsh-wireless/lib/decision.js'
import { createWorkorderStore } from '../dsh/dsh-wireless/lib/workflow.js'
import { apply } from '../dsh/dsh-wireless/lib/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wireless-demo-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, demo: createDemoService({ directory: path.join(directory, 'demo'), workspace: root }) }
}

test('rich scenario inputs are synthetic, sourced and do not reveal target outcomes', () => {
  const catalog = demoCatalog()
  assert.equal(catalog.counts.history_traces, 188)
  assert.equal(catalog.counts.scenarios, 12)
  assert.equal(catalog.counts.issue_families, 8)
  assert.equal(catalog.counts.time_series_observations, 3456)
  assert.ok(catalog.synthetic && !catalog.device_operation_performed)
  const timeSeries = readObservations(demoScenario('demo-capacity').series_file, root)
  for (const row of catalog.scenarios) {
    const scenario = demoScenario(row.scenario_id)
    assert.ok(scenario.intake.raw_text.length > 150)
    assert.ok(scenario.observations.length >= 9)
    assert.ok(scenario.observations.every(row => row.source_ref.startsWith('synthetic://')))
    assert.equal(scenario.feedback, undefined)
    assert.equal(scenario.by_parameter, undefined)
    assert.equal(scenario.evaluation_visible_at, undefined)
    for (const current of scenario.observations.slice(0, 3)) {
      const hour = timeSeries.find(row => row.object_id === current.object_id && row.metric === current.metric && row.time_window.start === current.time_window.start)
      assert.ok(hour, 'current snapshot has a matching time-series window')
      assert.equal(hour.value, current.value, 'same-window snapshot and time series must agree')
    }
  }
  assert.equal(demoScenario('demo-handover-window-mismatch').evidence_check.quarantined.length, 1)
  assert.throws(() => demoScenario('../../feedback.private.json'), /未知/)
})

test('real calculations distinguish baseline change, aligned peers, correlations and illegal evidence', () => {
  const scene = demoScenario('demo-capacity')
  const all = readObservations(scene.series_file, root)
  const result = analyzeObservations({ ...scene.analysis_arguments, observations: all })
  assert.equal(result.status, 'analyzed')
  assert.equal(result.series_count, 4)
  assert.equal(result.scoped_count, 288)
  assert.equal(result.quarantined.length, 0)
  const throughput = result.series.find(row => row.object_id === scene.intake.object_id && row.unit === 'Mbps')
  assert.ok(throughput.change_from_baseline.absolute < -10)
  assert.ok(throughput.declared_threshold_breaches > 0)
  assert.equal(throughput.baseline.observations, 48)
  assert.ok(throughput.recent.time_window.start.startsWith('2026-11-08T00:00:00'))
  assert.ok(throughput.recent.time_window.start.endsWith('+08:00'))
  assert.equal(result.peer_comparisons[0].aligned_windows, 72)
  assert.ok(result.peer_comparisons[0].mean_difference < -1)
  assert.ok(result.correlations.length >= 1)
  const row = all.find(r => r.unit === '%' && r.value < 90)
  const dirty = analyzeObservations({ observations: [row, { ...row, value: 101 }, { ...row, value: row.value + 1 }], baseline_points: 2 })
  assert.equal(dirty.status, 'needs_data', 'both sides of conflicting observations are removed')
  assert.equal(dirty.quarantined.length, 3)
  const offsetRow = { ...row, time_window: { start: '2026-11-06T00:00:00+08:00', end: '2026-11-06T01:00:00+08:00' } }
  const duplicate = analyzeObservations({ observations: [offsetRow, { ...offsetRow }], baseline_points: 2 })
  assert.equal(duplicate.usable_count, 1)
  assert.equal(duplicate.quarantined.length, 0)
  assert.deepEqual(duplicate.duplicate_rows, [1])
  assert.throws(() => readObservations('/etc/hosts', root), /工作区/)
})

test('all six memory types compile from traces and actual ECHO consumers respect missing snapshots and manufacturer mismatch', { timeout: 75000 }, async t => {
  const { demo, directory } = fixture(t)
  const prepared = await demo({ operation: 'prepare_memory' })
  for (const type of ['case_memory', 'rca_memory', 'strategy_memory', 'playbook_memory', 'risk_memory', 'counter_evidence_memory']) {
    assert.ok(prepared.memory_type_counts[type] > 0, type)
  }
  for (const scenario_id of ['demo-access', 'demo-handover', 'demo-coverage', 'demo-interference', 'demo-capacity', 'demo-throughput', 'demo-drop', 'demo-alarm']) {
    const compared = await demo({ operation: 'compare_candidates', scenario_id })
    assert.equal(compared.candidates.length, 2, scenario_id)
    assert.ok(compared.counter_evidence.length > 0)
    assert.ok(compared.candidates.every(row => row.adaptation.target === 60 && row.adaptation.status === 'adapted_value_candidate'))
    assert.equal(compared.calibrated_gate_loaded, false)
    assert.equal(compared.field_effect_statistics, false)
  }
  const missing = await demo({ operation: 'compare_candidates', scenario_id: 'demo-access-missing-snapshot' })
  assert.ok(missing.candidates.every(row => row.adaptation.status === 'needs_data' && row.adaptation.target === null))
  const cannotFreeze = await demo({ operation: 'select_candidate', scenario_id: 'demo-access-missing-snapshot', candidate_id: missing.candidates[0].candidate_id })
  assert.equal(cannotFreeze.status, 'needs_data')
  const mismatch = await demo({ operation: 'compare_candidates', scenario_id: 'demo-coverage-cross-vendor' })
  assert.equal(mismatch.status, 'no_candidates')
  const ordinaryMemory = createMemoryService({ directory: path.join(directory, 'demo'), workspace: root })
  const production = createDecisionService({ memory: ordinaryMemory })
  const compared = await demo({ operation: 'compare_candidates', scenario_id: 'demo-capacity' })
  const ref = compared.candidates[0]
  await assert.rejects(production({ operation: 'rank_candidates', candidate_refs: [{ package_id: ref.package_id, memory_id: ref.memory_id }] }), /演示包/)
  const ordinarySearch = ordinaryMemory.search({ query: '资源分配', include_demo: true, as_of: prepared.simulated_clock })
  assert.equal(ordinarySearch.candidate_pools.positive_candidates.length, 0)
  assert.equal(createMemoryService({ directory }).search({ query: '资源分配' }).total_matches, 0, 'parent production namespace never auto-discovers demo subdirectories')
})

test('freeze -> reveal -> ledger export -> source compile -> reuse changes evidence exactly once and survives restart', { timeout: 75000 }, async t => {
  const { demo, directory } = fixture(t)
  await assert.rejects(demo({ operation: 'reveal_feedback', decision_id: 'invented' }), /冻结/)
  const before = await demo({ operation: 'compare_candidates', scenario_id: 'demo-capacity' })
  const choice = before.candidates[0]
  const frozen = await demo({ operation: 'select_candidate', scenario_id: before.scenario_id, candidate_id: choice.candidate_id })
  assert.equal(frozen.status, 'demo_decision_frozen')
  assert.equal(frozen.feedback, undefined)
  await assert.rejects(demo({ operation: 'learn', decision_id: frozen.decision_id }), /先揭示/)
  const feedback = await demo({ operation: 'reveal_feedback', decision_id: frozen.decision_id })
  assert.equal(feedback.evaluation.status, 'declared_rule_met')
  assert.ok(Date.parse(feedback.executed_at) > Date.parse(frozen.frozen_at))
  const learned = await demo({ operation: 'learn', decision_id: frozen.decision_id })
  assert.equal(learned.trace_count, 189)
  assert.notEqual(learned.package_id, before.package_id)
  assert.ok(Date.parse(learned.simulated_clock) > Date.parse(feedback.evaluation_visible_at))
  const after = await demo({ operation: 'compare_candidates', scenario_id: before.scenario_id })
  const updated = after.candidates.find(row => row.memory_id === choice.memory_id)
  assert.ok(updated, 'source identity stays stable across compilation')
  assert.equal(updated.metrics.long_eval_pass_count, choice.metrics.long_eval_pass_count + 1)
  assert.ok(updated.source_trace_ids.includes(learned.trace_id))
  assert.ok(fs.existsSync(path.join(directory, 'demo/packages', before.package_id, 'manifest.json')), 'prior version stays available')
  const reopened = createDemoService({ directory: path.join(directory, 'demo'), workspace: root })
  const repeated = await reopened({ operation: 'learn', decision_id: frozen.decision_id })
  assert.equal(repeated.package_id, learned.package_id)
  assert.equal(repeated.reused, true)
  const store = createWorkorderStore({ directory: path.join(directory, 'demo') })
  assert.throws(() => store({ operation: 'export_trace', workorder_id: frozen.workorder_id, input: { execution_id: feedback.execution_id, mode: 'historical' } }), /合成/)
  assert.throws(() => store({ operation: 'export_trace', workorder_id: frozen.workorder_id, input: { execution_id: feedback.execution_id, mode: 'demo', long_eval_result: 'long_eval_pass' } }), /来源/)
  const exported = store({ operation: 'export_trace', workorder_id: frozen.workorder_id, input: { execution_id: feedback.execution_id, mode: 'demo' } })
  assert.equal(exported.trace.actions[0].after_value, '60')
  assert.equal(exported.trace.actions[0].long_eval_result, 'long_eval_unknown', 'descriptive KPI changes do not automatically become source long-evaluation labels')
})

test('adverse feedback is learned as a failure, never rewritten into an improvement', { timeout: 75000 }, async t => {
  const { demo } = fixture(t)
  const compared = await demo({ operation: 'compare_candidates', scenario_id: 'demo-capacity-quality-conflict' })
  const candidate = compared.candidates.find(row => row.parameter === 'Demo.LoadBalanceOffset')
  const frozen = await demo({ operation: 'select_candidate', scenario_id: compared.scenario_id, candidate_id: candidate.candidate_id })
  const feedback = await demo({ operation: 'reveal_feedback', decision_id: frozen.decision_id })
  assert.equal(feedback.evaluation.status, 'declared_rule_not_met')
  const learned = await demo({ operation: 'learn', decision_id: frozen.decision_id })
  assert.equal(learned.trace_count, 189)
  const after = await demo({ operation: 'compare_candidates', scenario_id: compared.scenario_id })
  const updated = after.candidates.find(row => row.memory_id === candidate.memory_id)
  assert.equal(updated.metrics.long_eval_fail_count, candidate.metrics.long_eval_fail_count + 1)
  assert.ok(updated.score <= candidate.score)
})

test('real SDK exposes both new tools, executes scoped statistics and preserves structured output', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wireless-sdk-output-'))
  const oldDirectory = process.env.WIRELESS_DATA_DIR
  process.env.WIRELESS_DATA_DIR = temporary
  t.after(() => { if (oldDirectory === undefined) delete process.env.WIRELESS_DATA_DIR; else process.env.WIRELESS_DATA_DIR = oldDirectory
    fs.rmSync(temporary, { recursive: true, force: true }) })
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx); apply(ctx)
  const execution = { signal: new AbortController().signal }
  let serial = 0
  async function invoke(name, args) {
    const result = await ctx.tools.execute({ ...execution, callId: `real-sdk-${++serial}`, name, arguments: args })
    assert.equal(result.isError, false, JSON.stringify(result))
    return result.value
  }
  const data = await invoke('wireless_demo', { operation: 'read_case', scenario_id: 'demo-capacity' })
  const result = await invoke('wireless_data_analyze', data.analysis_arguments)
  assert.equal(result.series_count, 4)
  assert.equal(result.peer_comparisons.length, 1)
  const compared = await invoke('wireless_demo', { operation: 'compare_candidates', scenario_id: 'demo-capacity' })
  const memories = await invoke('wireless_demo', { operation: 'memory' })
  assert.ok(memories.memory_types.risk_memory.total_matches > 0)
  const selected = await invoke('wireless_demo', { operation: 'select_candidate', scenario_id: 'demo-capacity', candidate_id: compared.candidates[0].candidate_id })
  await invoke('wireless_demo', { operation: 'reveal_feedback', decision_id: selected.decision_id })
  const learned = await invoke('wireless_demo', { operation: 'learn', decision_id: selected.decision_id })
  assert.equal(learned.status, 'demo_memory_learned')
  await invoke('wireless_demo', { operation: 'learn', decision_id: selected.decision_id })
  const invalid = await ctx.tools.execute({ ...execution, callId: 'invalid-input', name: 'wireless_data_analyze', arguments: { file_path: data.series_file, observations: [] } })
  assert.equal(invalid.isError, true)
})
