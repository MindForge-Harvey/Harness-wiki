import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { caseSearch, parameterCheck } from './catalog.js'

const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex').slice(0, 24)
const present = value => value !== undefined && value !== null && value !== ''
const number = value => typeof value === 'number' && Number.isFinite(value)
const unique = values => [...new Set(values)]
const isoOf = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  const window = windowOf({ start: value, end: new Date(Date.parse(value) + 1000).toISOString() })
  return window?.start || null
}
export const wirelessDataDir = () => process.env.WIRELESS_DATA_DIR || path.join(
  process.env.DSH_HOME || path.join(process.cwd(), '.runtime/dsh-home'), 'storages/dsh-wireless')

export function windowOf(value) {
  if (!value || typeof value !== 'object') return null
  const valid = date => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(date)) return false
    const [year, month, day] = date.slice(0, 10).split('-').map(Number)
    return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && Number.isFinite(Date.parse(date))
  }
  if (!valid(value.start) || !valid(value.end) || Date.parse(value.start) >= Date.parse(value.end)) return null
  return { start: new Date(value.start).toISOString(), end: new Date(value.end).toISOString() }
}

function observationsOf(input) {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 128) throw new Error('observations 必须为最多 128 条的数组')
  return input
}

export function buildEvidence(workorder, input = {}) {
  const observations = observationsOf(input.observations)
  const accepted = [], quarantined = [], duplicates = [], fingerprints = new Set()
  const idCounts = new Map()
  for (const row of observations) if (row?.id) idCounts.set(row.id, (idCounts.get(row.id) || 0) + 1)
  for (const row of observations) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('每条 observation 必须为对象')
    const id = row.id || `ev_${hash(row)}`
    const fingerprint = hash({ ...row, id: undefined })
    if (fingerprints.has(fingerprint)) { duplicates.push(id); continue }
    fingerprints.add(fingerprint)
    const issues = []
    if (row.id && idCounts.get(row.id) > 1) issues.push('duplicate_id_requires_resolution')
    const window = windowOf(row.time_window)
    if (!workorder.object_id || row.object_id !== workorder.object_id) issues.push('object_missing_or_mismatch')
    if (!window || !workorder.time_window || canonical(window) !== canonical(workorder.time_window)) issues.push('time_window_missing_or_mismatch')
    if (!row.source_ref) issues.push('source_ref_missing')
    if (!['kpi', 'mr', 'kqi', 'alarm', 'parameter', 'neighbor', 'context'].includes(row.kind)) issues.push('unknown_evidence_kind')
    if (!present(row.value)) issues.push('value_missing')
    if (['kpi', 'mr', 'kqi'].includes(row.kind)) {
      if (!row.metric || !row.unit || !row.definition) issues.push('metric_unit_or_definition_missing')
      if (!number(row.value)) issues.push('nonfinite_metric_value')
      if ((row.unit === '%' && number(row.value) && (row.value < 0 || row.value > 100)) ||
        (row.unit === 'ratio' && number(row.value) && (row.value < 0 || row.value > 1))) issues.push('rate_out_of_range')
      if (present(row.sample_count) && (!Number.isInteger(row.sample_count) || row.sample_count <= 0)) issues.push('invalid_sample_count')
      if (present(row.numerator) || present(row.denominator)) {
        if (!number(row.numerator) || !number(row.denominator) || row.denominator <= 0 || row.numerator < 0 || row.numerator > row.denominator) issues.push('invalid_rate_counts')
        else if (['%', 'ratio'].includes(row.unit) && number(row.value)) {
          const expected = row.numerator / row.denominator * (row.unit === '%' ? 100 : 1)
          if (Math.abs(expected - row.value) > 1e-6) issues.push('rate_value_counts_conflict')
        }
      }
    }
    let abnormal = null
    if (row.threshold) {
      const operators = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b }
      if (!number(row.value) || !number(row.threshold.value) || !operators[row.threshold.operator] || !row.threshold.source_ref) issues.push('invalid_or_unsourced_threshold')
      else abnormal = operators[row.threshold.operator](row.value, row.threshold.value)
    }
    if (issues.length) quarantined.push({ evidence_id: id, issues, observation: row })
    else accepted.push({ evidence_id: id, authority: 'user_supplied_observation', observation: { ...row, time_window: window },
      abnormal_under_declared_threshold: abnormal })
  }
  const caseIds = unique(input.historical_case_ids || [])
  const knownCases = new Map(caseSearch({ limit: 12 }).cases.map(row => [row.case_id, row]))
  if (caseIds.some(id => !knownCases.has(id))) throw new Error('historical_case_ids 包含未检索到的案例身份')
  return { status: accepted.length ? 'evidence_available' : 'needs_data', current_evidence: accepted,
    quarantined, duplicates, historical_references: caseIds.map(id => knownCases.get(id)),
    missing_fields: accepted.length ? [] : ['同对象、同窗口且具有来源与口径的当前观测'],
    interpretation: '观测来自用户提供，尚未核验采集源；阈值只采用明确声明。历史案例不转成当前指标，异常观测也不等于根因确证。' }
}

const issueRules = [
  ['低接通', /低接通|接通差|接入失败|rrc.*(?:失败|成功率)/i, ['接入阶段失败分布', 'RRC/ERAB 接通指标', '当前接入参数']],
  ['切换异常', /切换差|切换失败|切换异常|handover/i, ['切换准备/执行失败分布', '邻区配置', '移动性参数与告警']],
  ['覆盖异常', /弱覆盖|过覆盖|重叠覆盖|rsrp|覆盖/i, ['MR/路测 RSRP 与位置分布', '天线与覆盖参数']],
  ['干扰问题', /干扰|噪声|sinr/i, ['上行噪声与频域/时段分布', '负荷和覆盖对照']],
  ['负荷或容量异常', /高负荷|容量|拥塞|prb/i, ['忙时 PRB 与用户数', '吞吐与质量分布', '资源失败原因']],
  ['低速率', /速率慢|低速率|吞吐低|下载慢/i, ['吞吐/KQI', 'PRB 与活跃用户', 'SINR/MCS 与覆盖']],
  ['高掉线', /掉线|掉话|rlf/i, ['RLF 与异常释放', '切换明细', '覆盖、告警与邻区']],
  ['告警影响', /告警|退服|断站/i, ['告警起止与受影响对象', '同期 KPI 与恢复事件']],
]

export function identifyProblem(workorder, evidence) {
  const problem = workorder.problem || workorder.raw_text || ''
  const anomalous = (evidence?.current_evidence || []).filter(row => row.abnormal_under_declared_threshold === true)
    .map(row => row.observation.metric).join(' ')
  // A metric mentioned in raw input is not an anomaly. Prefer the actual reported symptom,
  // then add types suggested by aligned measurements with explicit abnormality criteria.
  const selected = [...issueRules.filter(([, pattern]) => pattern.test(problem)),
    ...issueRules.filter(([, pattern]) => pattern.test(anomalous))]
  const candidates = [...new Map(selected.map(row => [row[0], row])).values()].map(([type, , required]) => ({
    issue_type: type, basis: '工单现象或声明阈值下异常指标的分型线索', required_followup_data: required }))
  return { status: candidates.length ? 'preliminary_classification' : 'needs_data',
    primary_issue_type: candidates[0]?.issue_type || null, candidate_issue_types: candidates,
    severity: workorder.severity || 'unknown', priority: workorder.priority || 'unknown',
    interpretation: '问题分型为初步症状分类；严重度没有用户口径时保持未知，不将速率慢直接判定为容量根因。' }
}

export function checkDiagnosis(evidence, input = {}) {
  const hypotheses = input.hypotheses || []
  if (!Array.isArray(hypotheses) || hypotheses.length > 12) throw new Error('hypotheses 必须是最多 12 项的数组')
  const allowed = new Map((evidence?.current_evidence || []).map(row => [row.evidence_id, row]))
  const result = hypotheses.map(row => {
    if (!row.cause || !Array.isArray(row.supporting_evidence_ids) || !Array.isArray(row.contradicting_evidence_ids)) throw new Error('根因假设必须有 cause、supporting_evidence_ids、contradicting_evidence_ids')
    const support = unique(row.supporting_evidence_ids), counter = unique(row.contradicting_evidence_ids)
    if ([...support, ...counter].some(id => !allowed.has(id))) throw new Error('假设引用了不存在或被隔离的当前证据 ID')
    if (support.some(id => counter.includes(id))) throw new Error('同一证据不能同时记为支持与反对；应另行说明证据冲突')
    return { hypothesis_id: row.hypothesis_id || `hyp_${hash(row)}`, cause: row.cause,
      supporting_evidence_ids: support, contradicting_evidence_ids: counter,
      distinguishing_checks: row.distinguishing_checks || [],
      source_refs: Array.isArray(row.source_refs) ? row.source_refs : [],
      status: counter.length ? 'counter_evidence_present' : support.length ? 'current_evidence_supported_hypothesis' : 'unverified_hypothesis',
      confidence: 'not_causally_calibrated' }
  })
  return { status: result.length ? 'hypotheses_recorded' : 'needs_data', hypotheses: result,
    interpretation: '工具验证引用关系，不自动证明因果。历史长评 Pass 不用于给根因正确率评分；有支持观测仍保留假设及区分检查。' }
}

export function evaluateEffect(workorder, input = {}) {
  const execution = input.execution || {}
  const before = observationsOf(input.before), after = observationsOf(input.after)
  const missing = [], comparisons = [], incomparable = []
  if (!['executed_success', 'execution_failed', 'not_executed', 'unknown'].includes(execution.state)) missing.push('execution.state')
  const executedAt = typeof execution.executed_at === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(execution.executed_at) ? Date.parse(execution.executed_at) : NaN
  if (!Number.isFinite(executedAt)) missing.push('execution.executed_at_with_timezone')
  if (!Array.isArray(execution.actions) || !execution.actions.length) missing.push('execution.actions')
  const rule = input.evaluation_rule || {}
  if (!number(rule.min_observation_hours) || rule.min_observation_hours <= 0 || !rule.source_ref) missing.push('evaluation_rule_window_and_source')
  const key = row => canonical([row.object_id, row.metric, row.unit, row.definition, row.cohort || ''])
  const beforeMap = new Map()
  for (const row of before) {
    const id = key(row)
    if (beforeMap.has(id)) beforeMap.set(id, null)
    else beforeMap.set(id, row)
  }
  const afterCounts = new Map()
  for (const row of after) afterCounts.set(key(row), (afterCounts.get(key(row)) || 0) + 1)
  for (const next of after) {
    const previous = beforeMap.get(key(next))
    const oldWindow = windowOf(previous?.time_window), newWindow = windowOf(next.time_window)
    const problems = []
    if (!previous || afterCounts.get(key(next)) > 1) problems.push('missing_or_duplicate_pair')
    if (!next.metric || !next.unit || !next.definition || !next.source_ref || !previous?.source_ref) problems.push('metric_definition_unit_or_source_missing')
    if (next.object_id !== workorder.object_id || !workorder.object_id) problems.push('object_mismatch')
    if (!number(next.value) || !number(previous?.value)) problems.push('nonfinite_value')
    for (const row of [previous, next].filter(Boolean)) {
      const checked = buildEvidence({ ...workorder, time_window: windowOf(row.time_window) }, { observations: [row] })
      if (checked.quarantined.length) problems.push(...checked.quarantined[0].issues)
    }
    if (!oldWindow || !newWindow) problems.push('invalid_window')
    else {
      if (Date.parse(newWindow.start) < Date.parse(oldWindow.end)) problems.push('overlapping_or_reversed_windows')
      if (Number.isFinite(executedAt) && (Date.parse(oldWindow.end) > executedAt || Date.parse(newWindow.start) < executedAt)) problems.push('window_crosses_execution')
      if (Date.parse(oldWindow.end) - Date.parse(oldWindow.start) !== Date.parse(newWindow.end) - Date.parse(newWindow.start)) problems.push('unequal_window_duration')
    }
    if (problems.length) { incomparable.push({ metric: next.metric || null, issues: problems }); continue }
    const delta = next.value - previous.value
    const direction = next.good_direction || previous.good_direction
    const improvement = direction === 'higher' ? delta : direction === 'lower' ? -delta : null
    const duration = (Date.parse(newWindow.end) - Date.parse(newWindow.start)) / 3600000
    const sufficientSamples = [previous.sample_count, next.sample_count].every(count => Number.isInteger(count) && count > 0)
    comparisons.push({ metric: next.metric, unit: next.unit, definition: next.definition,
      before: previous.value, after: next.value, delta,
      delta_unit: next.unit === '%' ? 'percentage_points' : next.unit,
      relative_change_percent: previous.value !== 0 ? delta / Math.abs(previous.value) * 100 : null,
      improvement, direction: direction || null, observation_hours: duration,
      meets_declared_window: number(rule.min_observation_hours) ? duration >= rule.min_observation_hours : null,
      samples_sufficient_for_descriptive_comparison: sufficientSamples,
      before_source: previous.source_ref, after_source: next.source_ref })
  }
  if (!comparisons.length) missing.push('comparable_before_after_observations')
  if (comparisons.some(row => !row.direction)) missing.push('metric_good_direction')
  if (comparisons.some(row => !row.samples_sufficient_for_descriptive_comparison)) missing.push('sample_counts')
  if (incomparable.length) missing.push('resolve_incomparable_observations')
  const mature = comparisons.length > 0 && comparisons.every(row => row.meets_declared_window === true)
  const expected = rule.required_metrics || []
  if (!expected.length || expected.some(metric => !comparisons.some(row => row.metric === metric))) missing.push('evaluation_rule.required_metrics_and_coverage')
  if (!number(rule.min_absolute_improvement) || rule.min_absolute_improvement < 0) missing.push('evaluation_rule.min_absolute_improvement')
  const selected = comparisons.filter(row => expected.includes(row.metric))
  const passes = selected.length > 0 && selected.every(row => row.improvement !== null && row.improvement >= rule.min_absolute_improvement)
  const failedExecution = execution.state === 'execution_failed'
  return { status: failedExecution ? 'process_failure' : execution.state !== 'executed_success' ? 'not_assessable'
    : missing.length ? 'needs_data' : !mature ? 'observing' : passes ? 'declared_rule_met' : 'declared_rule_not_met',
    comparisons, incomparable, missing_fields: unique(missing), maturity: mature ? 'declared_window_met' : 'not_established',
    attribution_scope: execution.submitted_action_count > execution.actions?.length
      ? 'submitted_bundle_partial_realization_observational'
      : execution.actions?.length === 1 ? 'single_action_observational' : 'executed_bundle_observational',
    interpretation: '前后差异及用户声明评估规则不构成因果证明或论文 long_eval 标签。执行失败是流程结果；多动作效果保留在组合级。百分比差值用百分点，不与相对变化百分比混用。' }
}

function planOf(record, input) {
  if (!input.title || !input.rationale || !Array.isArray(input.source_refs) || !input.source_refs.length ||
    input.source_refs.some(row => typeof row !== 'string' || !row.trim())) throw new Error('方案需要 title、rationale 和 source_refs 来源')
  if (!Array.isArray(input.actions) || !input.actions.length || input.actions.length > 32) throw new Error('方案 actions 必须为 1 至 32 项')
  const evidenceIds = unique(input.evidence_ids || [])
  const current = new Set((record.stages.evidence?.current_evidence || []).map(row => row.evidence_id))
  if (evidenceIds.some(id => !current.has(id))) throw new Error('方案引用了不存在或被隔离的当前证据 ID')
  const caseIds = unique(input.historical_case_ids || [])
  const cases = new Set(caseSearch({ limit: 12 }).cases.map(row => row.case_id))
  if (caseIds.some(id => !cases.has(id))) throw new Error('方案历史案例 ID 不存在')
  const missing = []
  if (!record.input.object_id) missing.push('object_id')
  const actions = input.actions.map((row, index) => {
    if (!row || typeof row.parameter !== 'string' || !row.parameter.trim()) throw new Error('每个方案动作必须有 parameter')
    if (row.object_id && row.object_id !== record.input.object_id) throw new Error('方案动作对象与工单不一致')
    const constraints = row.constraints || {}
    const check = parameterCheck({ ...constraints, parameter: row.parameter, current: row.current, target: row.target })
    missing.push(...check.missing_fields.map(field => `actions.${index}.${field}`))
    return { ...row, object_id: record.input.object_id || null, action_id: `pa_${hash({ index, row })}`,
      constraint_check: check, rollback_reference: check.rollback_reference }
  })
  const plan = { plan_id: `pl_${hash({ intake_hash: record.input_hash, input })}`, title: input.title,
    rationale: input.rationale, object_id: record.input.object_id || null, input_revision: record.revision,
    intake_hash: record.input_hash, evidence_ids: evidenceIds, historical_case_ids: caseIds,
    source_refs: input.source_refs, actions, preconditions: input.preconditions || [],
    evaluation_rule: input.evaluation_rule || null, status: actions.some(row => row.constraint_check.status === 'blocked')
      ? 'draft_blocked' : missing.length ? 'draft_needs_data' : 'candidate_constraints_checked',
    missing_fields: missing, execution_permission: 'not_granted',
    interpretation: '保存的是候选方案及声明约束检查，不表示已审批、已下发或有效；现场执行与效果需要独立来源反馈。' }
  return plan
}

function executionOf(record, input) {
  const plan = (record.plans || []).find(row => row.plan_id === input.plan_id)
  if (!plan) throw new Error('plan_id 必须来自该工单已保存方案')
  if (!plan.object_id || plan.object_id !== record.input.object_id) throw new Error('执行反馈对象与方案/当前工单不一致')
  if (typeof input.source_ref !== 'string' || !input.source_ref.trim()) throw new Error('执行反馈必须有 source_ref，不能用建议冒充实际执行')
  if (!Array.isArray(input.actions) || !input.actions.length || input.actions.length > 32) throw new Error('执行反馈 actions 必须为 1 至 32 项')
  const planned = new Map(plan.actions.map(row => [row.action_id, row]))
  const ids = input.actions.map(row => row.action_id)
  if (unique(ids).length !== ids.length || ids.some(id => !planned.has(id))) throw new Error('执行反馈动作 ID 重复或不属于方案')
  if (input.supersedes_execution_id && !(record.executions || []).some(row => row.execution_id === input.supersedes_execution_id && row.plan_id === plan.plan_id)) {
    throw new Error('执行更正必须指向同方案已有 execution_id')
  }
  const missing = []
  const actions = input.actions.map((row, index) => {
    if (!['executed_success', 'execution_failed', 'not_executed', 'unknown', 'rolled_back'].includes(row.state)) throw new Error('未知执行反馈 state')
    const known = planned.get(row.action_id)
    if (row.parameter && row.parameter !== known.parameter) throw new Error('执行反馈参数身份与方案不一致')
    for (const field of ['executed_at', 'rollback_at']) {
      if (present(row[field]) && !isoOf(row[field])) throw new Error(`${field} 必须为有效的带时区 ISO 时间`)
    }
    if (['executed_success', 'rolled_back'].includes(row.state)) {
      for (const field of ['before', 'after', 'executed_at']) if (!present(row[field])) missing.push(`actions.${index}.${field}`)
    }
    if (row.state === 'rolled_back') {
      for (const field of ['rollback_at', 'rollback_value']) if (!present(row[field])) missing.push(`actions.${index}.${field}`)
      if (row.executed_at && row.rollback_at && Date.parse(row.rollback_at) < Date.parse(row.executed_at)) throw new Error('回退时间不能早于执行时间')
    }
    return { ...row, parameter: known.parameter, object_id: known.object_id,
      executed_at: row.executed_at ? isoOf(row.executed_at) : null, rollback_at: row.rollback_at ? isoOf(row.rollback_at) : null,
      actual_differs_from_plan: present(row.after) && present(known.target) ? canonical(row.after) !== canonical(known.target) : null }
  })
  const missingActions = plan.actions.filter(row => !ids.includes(row.action_id)).map(row => row.action_id)
  const state = actions.every(row => row.state === 'executed_success') && !missingActions.length ? 'executed_success'
    : actions.every(row => row.state === 'not_executed') && !missingActions.length ? 'not_executed'
    : actions.every(row => row.state === 'execution_failed') && !missingActions.length ? 'execution_failed'
    : actions.every(row => row.state === 'rolled_back') && !missingActions.length ? 'rolled_back' : 'partial_or_unknown'
  return { execution_id: `ex_${hash(input)}`, plan_id: plan.plan_id, source_ref: input.source_ref,
    supersedes_execution_id: input.supersedes_execution_id || null,
    status: missing.length || missingActions.length ? 'feedback_recorded_with_gaps' : 'feedback_recorded',
    state, actions, missing_fields: missing, unreported_action_ids: missingActions,
    submitted_action_count: plan.actions.length, intake_hash: plan.intake_hash,
    scope: plan.actions.length === 1 ? 'single_submitted_action' : 'submitted_bundle',
    authority: 'user_supplied_execution_feedback', device_operation_performed: false,
    interpretation: '工具保存用户反馈，未调用网管。执行/回退成功、观察到效果与效果归因分别记录；部分执行不缩窄提交方案的归因作用域。' }
}

export function createWorkorderStore({ directory = wirelessDataDir() } = {}) {
  const workorders = path.join(directory, 'workorders')
  const fileFor = id => {
    if (!/^wo_[a-f0-9]{24}$/.test(id || '')) throw new Error('workorder_id 必须使用 intake 返回的稳定 ID')
    return path.join(workorders, `${id}.json`)
  }
  const load = id => JSON.parse(fs.readFileSync(fileFor(id), 'utf8'))
  const save = record => {
    fs.mkdirSync(workorders, { recursive: true })
    const target = fileFor(record.workorder_id), temporary = `${target}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
    fs.renameSync(temporary, target)
  }
  return function run({ operation, workorder_id, expected_revision, input = {} } = {}) {
    if (canonical(input).length > 512000) throw new Error('input 超过 512 KB，请拆分输入')
    if (operation === 'read') return load(workorder_id)
    if (operation === 'history') {
      const record = load(workorder_id), limit = input.limit ?? 20
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('history limit 必须为 1 至 100')
      return { workorder_id, revision: record.revision, total_events: record.history.length,
        events: record.history.slice(-limit), plans: record.plans || [], executions: record.executions || [],
        interpretation: '早期只包含 operation/revision/at 的事件没有原始快照；后续事件保存输入与实际阶段结果。' }
    }
    if (!['intake', 'identify', 'build_evidence', 'diagnose', 'save_plan', 'record_execution', 'evaluate'].includes(operation)) throw new Error('未知工单 operation')
    let record
    if (operation === 'intake') {
      if (!input.raw_text && !input.problem) throw new Error('至少提供原始工单描述或 problem')
      const identity = input.external_id ? { external_id: input.external_id, source_system: input.source_system || 'user_submission' }
        : { raw_text: input.raw_text || '', object_id: input.object_id || null, problem: input.problem || null }
      const id = workorder_id || `wo_${hash(identity)}`
      const target = fileFor(id)
      record = fs.existsSync(target) ? load(id) : { workorder_id: id, revision: 0, stages: {}, history: [] }
      if (present(expected_revision) && expected_revision !== record.revision) throw new Error('工单 revision 冲突，请先读取最新版本')
      if (record.input_hash === hash(input)) return record
      const timeWindow = windowOf(input.time_window)
      const missing = ['object_id', 'problem', 'system', 'vendor', 'software_version'].filter(key => !present(input[key]))
      if (!timeWindow) missing.push('time_window_with_timezone')
      record.input = { ...input, time_window: timeWindow, original_time_window: input.time_window || null,
        system: ({ '4G': 'LTE', '5G': 'NR' }[String(input.system).toUpperCase()] || input.system || null),
        provenance: '用户提供或模型从用户工单提取；原始文本与引用保留，尚未核验采集源。' }
      record.input_hash = hash(input)
      record.stages = { intake: { status: missing.length ? 'needs_data' : 'normalized', missing_fields: missing } }
    } else {
      record = load(workorder_id)
      if (present(expected_revision) && expected_revision !== record.revision) throw new Error('工单 revision 冲突，请先读取最新版本')
      if (operation === 'identify') record.stages.identify = identifyProblem(record.input, record.stages.evidence)
      if (operation === 'build_evidence') {
        record.stages.evidence = buildEvidence(record.input, input)
        delete record.stages.diagnosis
        // Classification may consume current anomalies: mark it stale after evidence changes.
        delete record.stages.identify
      }
      if (operation === 'diagnose') record.stages.diagnosis = checkDiagnosis(record.stages.evidence, input)
      if (operation === 'save_plan') {
        const plan = planOf(record, input)
        record.plans ||= []
        if (record.plans.some(row => row.plan_id === plan.plan_id)) return record
        record.plans.push(plan)
        record.stages.plan = plan
      }
      if (operation === 'record_execution') {
        const execution = executionOf(record, input)
        record.executions ||= []
        if (record.executions.some(row => row.execution_id === execution.execution_id)) return record
        record.executions.push(execution)
        if (execution.intake_hash === record.input_hash) {
          record.stages.execution = execution
          delete record.stages.evaluation
        }
      }
      if (operation === 'evaluate') {
        let evaluationInput = input
        if (input.execution_id) {
          const execution = (record.executions || []).find(row => row.execution_id === input.execution_id)
          if (!execution || execution.intake_hash !== record.input_hash) throw new Error('execution_id 不存在或属于旧工单输入版本')
          if (record.executions.some(row => row.supersedes_execution_id === input.execution_id)) throw new Error('execution_id 已被后续反馈更正，请读取最新记录')
          const actions = execution.actions.filter(row => row.state === 'executed_success')
          const times = unique(actions.map(row => row.executed_at).filter(Boolean))
          evaluationInput = { ...input, execution: { state: execution.state === 'executed_success' && !execution.missing_fields.length
            ? 'executed_success' : execution.state === 'execution_failed' ? 'execution_failed' : 'unknown',
            executed_at: times.length === 1 ? times[0] : null, actions,
            submitted_action_count: execution.submitted_action_count } }
        } else if (record.stages.execution) {
          throw new Error('该工单已有执行反馈，请用 execution_id 关联评估，不能另造 execution 覆盖它')
        }
        record.stages.evaluation = { ...evaluateEffect(record.input, evaluationInput),
          execution_id: input.execution_id || null, input: evaluationInput }
      }
    }
    record.revision++
    record.updated_at = new Date().toISOString()
    const stage = { intake: 'intake', identify: 'identify', build_evidence: 'evidence', diagnose: 'diagnosis',
      save_plan: 'plan', record_execution: 'execution', evaluate: 'evaluation' }[operation]
    record.history.push({ operation, revision: record.revision, at: record.updated_at, input_hash: record.input_hash,
      input: structuredClone(input), result: structuredClone(operation === 'record_execution'
        ? record.executions.at(-1) : record.stages[stage]) })
    save(record)
    return record
  }
}
