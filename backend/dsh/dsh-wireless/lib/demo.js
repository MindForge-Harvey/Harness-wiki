import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createMemoryService } from './compiler.js'
import { createDecisionService } from './decision.js'
import { createWorkorderStore, wirelessDataDir, buildEvidence } from './workflow.js'
import { exportWorkorderTrace } from './trace.js'

const resources = fileURLToPath(new URL('../resources/demo/', import.meta.url))
const project = path.resolve(resources, '../../../../..')
const read = name => JSON.parse(fs.readFileSync(path.join(resources, name), 'utf8'))
const manifest = read('manifest.json')
const datasetVersion = crypto.createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex').slice(0, 12)
for (const [name, expected] of Object.entries(manifest.files)) {
  if (crypto.createHash('sha256').update(fs.readFileSync(path.join(resources, name))).digest('hex') !== expected) throw new Error('演示数据校验失败：' + name)
}
const scenarios = read('scenarios.json')
const synthetic = { synthetic: true, data_scope: 'synthetic_demo_only', device_operation_performed: false, field_effect_statistics: false }
const chinaISO = ms => new Date(ms + 8 * 3600000).toISOString().replace('Z', '+08:00')
export function demoCatalog() {
  return { ...synthetic, dataset_version: datasetVersion, counts: manifest.counts, baseline_cutoff: manifest.baseline_cutoff,
    decision_at: manifest.decision_at, learning_at: manifest.learning_at, source_commit: manifest.source_commit,
    scenarios: scenarios.map(({ scenario_id, title, issue_type, intake, demo_goals }) => ({ scenario_id, title, issue_type,
      vendor: intake.vendor, system: intake.system, demo_goals })), boundaries: manifest.boundaries }
}
export function demoScenario(id) {
  const scenario = scenarios.find(row => row.scenario_id === id)
  if (!scenario) throw new Error('未知演示场景，请先列出演示数据')
  return { ...structuredClone(scenario), ...synthetic, series_file: path.join(resources, 'observations.jsonl'),
    series_object_id: scenario.intake.object_id, baseline_points: 48,
    analysis_arguments: { file_path: path.join(resources, 'observations.jsonl'), object_ids: [scenario.intake.object_id, scenario.topology.peer_cell], baseline_points: 48 },
    evidence_check: buildEvidence(scenario.intake, { observations: scenario.observations }),
    feedback_visibility: '方案冻结后才可通过 reveal_feedback 读取模拟结果；当前只返回决策前数据。' }
}
const compact = row => ({ candidate_id: row.candidate_id, package_id: row.package_id, memory_id: row.memory.memory_id,
  title: row.memory.title, state: row.memory.state, memory_type: row.memory.memory_type,
  parameter: row.memory.content?.param_en_name || null, metrics: row.memory.metrics,
  score: row.score, score_breakdown: row.score_breakdown, source_trace_ids: row.memory.trace_ids,
  attribution_scope: row.memory.content?.maximum_attribution_scope || 'bundle_direct' })

export function createDemoService({ directory = path.join(wirelessDataDir(), 'demo-sandbox', datasetVersion), workspace = project, python } = {}) {
  const memory = createMemoryService({ directory, workspace, python, demoSandbox: true })
  const decision = createDecisionService({ memory, python, demoSandbox: true })
  const workorder = createWorkorderStore({ directory })
  const stateFile = path.join(directory, 'demo-state.json')
  const load = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : { learned: {}, decisions: {} }
  const save = state => { fs.mkdirSync(directory, { recursive: true }); const tmp = stateFile + '.' + crypto.randomUUID()
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, stateFile) }
  let queue = Promise.resolve()
  async function prepare(execution) {
    const state = load()
    if (state.baseline_package_id) return state
    const result = await memory.compile({ file_path: path.join(resources, 'history.jsonl'), as_of: manifest.baseline_cutoff, mode: 'demo' }, execution)
    if (!result.package_id) throw new Error('合成历史编译未生成经验包')
    state.baseline_package_id = result.package_id; state.active_package_id = result.package_id
    state.clock = manifest.decision_at; state.baseline_summary = { trace_count: result.trace_count,
      memory_count: result.memory_count, memory_type_counts: result.memory_type_counts, state_counts: result.state_counts }
    save(state); return state
  }
  async function compare(scenario, state, execution) {
    const historical = memory.search({ query: scenario.root_clues.root_cause_l2, vendor: scenario.context.vendor, system: scenario.context.system,
      include_demo: true, as_of: state.clock, package_ids: [state.active_package_id], limit: 12 })
    const refs = historical.candidate_pools.positive_candidates.map(row => ({ package_id: row.package_id, memory_id: row.memory.memory_id }))
    const ranked = await decision({ operation: 'rank_candidates', candidate_refs: refs, context: scenario.context,
      root: scenario.root_clues, as_of: state.clock }, execution)
    const candidates = []
    for (const row of ranked.candidates || []) {
      const item = compact(row), snapshot = scenario.snapshots[item.parameter]
      if (row.memory.memory_type === 'strategy_memory' && snapshot) {
        const adapted = await decision({ operation: 'adapt_value', candidate_ref: { package_id: row.package_id, memory_id: row.memory.memory_id },
          current_snapshot: snapshot, context: scenario.context, as_of: state.clock }, execution)
        item.adaptation = { status: adapted.status, target: adapted.target ?? null, missing_fields: adapted.missing_fields,
          current_snapshot: snapshot, constraint_check: adapted.constraint_check, algorithm: adapted.algorithm }
      }
      candidates.push(item)
    }
    return { ...synthetic, status: candidates.length ? 'demo_candidates_compared' : 'no_candidates', scenario_id: scenario.scenario_id,
      package_id: state.active_package_id, simulated_clock: state.clock, candidates,
      review_evidence: historical.candidate_pools.review_evidence.map(compact),
      counter_evidence: historical.candidate_pools.counter_evidence.map(compact),
      memory_type_counts: Object.fromEntries(Object.entries(historical.by_type).map(([key, group]) => [key, group.total_matches])),
      algorithm: ranked.algorithm, calibrated_gate_loaded: false,
      interpretation: '在独立演示空间实际运行 ECHO 源排序和值选择；分数、计数和反馈均来自合成数据，不表示现网成功率。尚未选择或执行任何动作。' }
  }
  async function run(args = {}, execution = {}) {
    const { operation = 'catalog', scenario_id, decision_id } = args
    if (operation === 'catalog') return demoCatalog()
    if (operation === 'read_case') return demoScenario(scenario_id)
    const state = await prepare(execution)
    if (operation === 'prepare_memory') return { ...synthetic, status: 'demo_memory_prepared', package_id: state.active_package_id,
      baseline_package_id: state.baseline_package_id, ...state.baseline_summary, simulated_clock: state.clock }
    if (operation === 'memory') {
      const types = ['case_memory', 'rca_memory', 'strategy_memory', 'playbook_memory', 'risk_memory', 'counter_evidence_memory']
      return { ...synthetic, status: 'demo_memory_read', package_id: state.active_package_id, simulated_clock: state.clock,
        memory_types: Object.fromEntries(types.map(type => { const group = memory.query({ package_id: state.active_package_id, query: args.query || '', memory_type: type, limit: 6 })
          return [type, { total_matches: group.total_matches, memories: group.memories.map(row => compact({ ...row, package_id: state.active_package_id })) }] })) }
    }
    if (operation === 'compare_candidates') return compare(demoScenario(scenario_id), state, execution)
    if (operation === 'select_candidate') {
      const scenario = demoScenario(scenario_id), compared = await compare(scenario, state, execution)
      const selected = compared.candidates.find(row => row.candidate_id === args.candidate_id)
      if (!selected) throw new Error('必须从当前场景实际返回的候选 ID 中选择')
      if (selected.adaptation?.status !== 'adapted_value_candidate') return { ...synthetic, status: 'needs_data',
        missing_fields: selected.adaptation?.missing_fields || ['usable_single_parameter_snapshot'], interpretation: '缺当前值或有效数值时不冻结执行方案。' }
      const chosen = await decision({ operation: 'select_candidate', candidate_refs: [{ package_id: selected.package_id, memory_id: selected.memory_id }],
        selected_candidate_id: selected.candidate_id, context: scenario.context, as_of: state.clock }, execution)
      const id = 'dd_' + crypto.createHash('sha256').update(JSON.stringify([scenario_id, args.candidate_id, state.clock])).digest('hex').slice(0, 24)
      if (state.decisions[id]) return { ...synthetic, status: 'demo_decision_frozen', ...state.decisions[id], feedback: undefined }
      const snapshot = selected.adaptation.current_snapshot
      let record = workorder({ operation: 'intake', input: { ...scenario.intake, synthetic: true, external_id: id } })
      record = workorder({ operation: 'build_evidence', workorder_id: record.workorder_id, input: { observations: scenario.observations } })
      record = workorder({ operation: 'save_plan', workorder_id: record.workorder_id, input: { title: `演示候选：${selected.parameter}`,
        rationale: '基于决策前合成历史候选及当前模拟快照；待揭示模拟反馈', source_refs: [`synthetic://demo/${id}`, selected.candidate_id],
        actions: [{ parameter: selected.parameter, param_object: 'Demo', param_cn_name: chosen.action_pattern.param_cn_name, current: snapshot.current_value,
          target: selected.adaptation.target, constraints: { min: snapshot.min, max: snapshot.max, step: snapshot.step,
            step_base: snapshot.step_base, unit: snapshot.unit, constraint_source: snapshot.constraint_source } }], evaluation_rule: scenario.evaluation_rule } })
      const frozen = { decision_id: id, scenario_id, candidate_id: selected.candidate_id, package_id: selected.package_id,
        selected, source_pattern: chosen.action_pattern, frozen_at: state.clock,
        workorder_id: record.workorder_id, plan_id: record.stages.plan.plan_id, stage: 'frozen' }
      state.decisions[id] = frozen; save(state)
      return { ...synthetic, status: 'demo_decision_frozen', ...frozen, interpretation: '已冻结候选、目标值和依据版本；尚未揭示模拟结果。' }
    }
    const frozen = state.decisions[decision_id]
    if (!frozen) throw new Error('需要 select_candidate 返回的 decision_id；不能在方案冻结前揭示结果或学习')
    const scenario = demoScenario(frozen.scenario_id)
    if (operation === 'reveal_feedback') {
      if (frozen.stage !== 'frozen') return { ...synthetic, status: 'demo_feedback_revealed', decision_id, ...frozen.feedback }
      const hidden = read('feedback.private.json')[frozen.scenario_id]
      const outcome = hidden.by_parameter[frozen.selected.parameter]
      if (!outcome) throw new Error('所选参数没有预置模拟反馈，不能制造执行结果')
      // A new demonstration round advances the synthetic clock. The outcomes stay
      // synthetic fixtures; they are never backdated into the decision's past.
      const shift = Math.max(0, Date.parse(frozen.frozen_at) - Date.parse(scenario.decision_at))
      const shifted = rows => rows.map(row => ({ ...row, time_window: {
        start: new Date(Date.parse(row.time_window.start) + shift).toISOString(),
        end: new Date(Date.parse(row.time_window.end) + shift).toISOString() } }))
      const executed_at = chinaISO(Date.parse(hidden.executed_at) + shift)
      const evaluation_visible_at = chinaISO(Date.parse(hidden.evaluation_visible_at) + shift)
      let record = workorder({ operation: 'read', workorder_id: frozen.workorder_id })
      const planned = record.plans.find(row => row.plan_id === frozen.plan_id)
      record = workorder({ operation: 'record_execution', workorder_id: record.workorder_id, input: { plan_id: planned.plan_id,
        source_ref: `synthetic://feedback/${decision_id}`, actions: [{ action_id: planned.actions[0].action_id,
          state: 'executed_success', before: frozen.selected.adaptation.current_snapshot.current_value,
          after: frozen.selected.adaptation.target, issued_state: '下发成功',
          issued_at: chinaISO(Date.parse(executed_at) - 300000), executed_at }] } })
      const execution_id = record.stages.execution.execution_id
      record = workorder({ operation: 'evaluate', workorder_id: record.workorder_id, input: { execution_id,
        before: shifted(hidden.before), after: shifted(outcome.after), evaluation_rule: scenario.evaluation_rule } })
      frozen.feedback = { execution_id, executed_at, evaluation_visible_at,
        evaluation: record.stages.evaluation, note: outcome.note,
        long_eval_result: outcome.long_eval_result, long_eval_source_ref: outcome.long_eval_source_ref }
      frozen.stage = 'revealed'; save(state)
      return { ...synthetic, status: 'demo_feedback_revealed', decision_id, ...frozen.feedback,
        interpretation: '已把预置合成反馈写入独立工单账本，并实际计算同口径前后效果。未调用网管。' }
    }
    if (operation === 'learn') {
      if (frozen.stage === 'frozen') throw new Error('必须先揭示反馈并完成评价，再编译经验')
      if (state.learned[decision_id]) return { ...synthetic, status: 'demo_memory_learned', reused: true, ...state.learned[decision_id] }
      const record = workorder({ operation: 'read', workorder_id: frozen.workorder_id })
      const status = frozen.feedback.evaluation.status
      if (!['declared_rule_met', 'declared_rule_not_met'].includes(status)) return { ...synthetic, status: 'needs_data', missing_fields: ['completed_comparable_evaluation'] }
      const exported = exportWorkorderTrace(record, { execution_id: frozen.feedback.execution_id, mode: 'demo',
        long_eval_result: frozen.feedback.long_eval_result,
        long_eval_source_ref: frozen.feedback.long_eval_source_ref,
        evaluation_visible_at: frozen.feedback.evaluation_visible_at, root_cause_label: scenario.root_clues.root_cause_l2,
        scheme_id: frozen.source_pattern.scheme_id, scheme_group: frozen.source_pattern.scheme_group || scenario.root_clues.root_cause_l2 }, workspace)
      const learned = Object.values(state.learned).map(row => row.trace)
      const all = fs.readFileSync(path.join(resources, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      const byId = new Map([...all, ...learned, exported.trace].map(row => [row.trace_id, row]))
      if (byId.size > 200) throw new Error('演示单批最多 200 条历史，请另建演示空间继续')
      const inputs = path.join(workspace, '.run/wireless-demo-inputs'); fs.mkdirSync(inputs, { recursive: true })
      const input = path.join(inputs, `${decision_id}.jsonl`)
      fs.writeFileSync(input, [...byId.values()].map(row => JSON.stringify(row)).join('\n') + '\n')
      const learning_at = chinaISO(Math.max(Date.parse(manifest.learning_at), Date.parse(frozen.feedback.evaluation_visible_at) + 86400000, Date.parse(state.clock)))
      const compiled = await memory.compile({ file_path: input, as_of: learning_at, mode: 'demo' }, execution)
      const previous_package_id = state.active_package_id
      if (!compiled.package_id) throw new Error('新增经验未形成版本包')
      state.active_package_id = compiled.package_id; state.clock = learning_at
      const result = { decision_id, previous_package_id, package_id: compiled.package_id, trace_id: exported.trace_id,
        trace_count: compiled.trace_count, memory_type_counts: compiled.memory_type_counts, state_counts: compiled.state_counts,
        simulated_clock: state.clock, trace: exported.trace }
      state.learned[decision_id] = result; frozen.stage = 'learned'; save(state)
      return { ...synthetic, status: 'demo_memory_learned', ...result, trace: undefined,
        interpretation: '冻结决策后揭示反馈，等待模拟评价可见与七天成熟边界，再用真实 ECHO 编译器生成新演示版本。旧包保留；再次比较会读取新包。不是完整论文时序回放。' }
    }
    throw new Error('未知演示操作')
  }
  return (args, execution) => {
    const next = queue.then(async () => JSON.parse(JSON.stringify(await run(args, execution), (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('演示结果含有非有限数值，不能作为分析输出')
      return value
    })))
    queue = next.catch(() => {}); return next
  }
}
