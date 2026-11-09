import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** Loss-conscious ledger -> source TraceRecord adapter. Evaluation labels are explicitly supplied. */
export function exportWorkorderTrace(record, input = {}, workspace = process.cwd()) {
  const execution = (record.executions || []).find(row => row.execution_id === input.execution_id)
  if (!execution || execution.intake_hash !== record.input_hash) throw new Error('需要当前工单版本的 execution_id')
  if (record.executions.some(row => row.supersedes_execution_id === execution.execution_id)) throw new Error('执行反馈已被更正')
  const plan = record.plans.find(row => row.plan_id === execution.plan_id)
  if (!plan) throw new Error('执行反馈缺少关联方案')
  if (!record.input.problem) throw new Error('导出源 Trace 前需补齐工单 problem；不能把未知问题补成诊断结论')
  const synthetic = record.input.synthetic === true || String(record.input.source_ref || '').startsWith('synthetic://')
  const mode = input.mode || 'historical'
  if (!['historical', 'demo'].includes(mode) || (synthetic && mode !== 'demo')) throw new Error('合成工单只能导出为 demo')
  const result = input.long_eval_result || 'long_eval_unknown'
  if (!['long_eval_pass', 'long_eval_fail', 'long_eval_unknown'].includes(result)) throw new Error('未知 long_eval_result')
  if (result !== 'long_eval_unknown' && (!input.long_eval_source_ref || !input.evaluation_visible_at ||
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.evaluation_visible_at) || !Number.isFinite(Date.parse(input.evaluation_visible_at)))) {
    throw new Error('长期评价标签必须明确提供来源和带时区的评价可见时间，不从描述性差值推定')
  }
  const actual = new Map(execution.actions.map(row => [row.action_id, row]))
  const root = input.root_cause_label || null
  const actions = plan.actions.map((action, index) => {
    const row = actual.get(action.action_id)
    const success = ['executed_success', 'rolled_back'].includes(row?.state)
    return { action_id: action.action_id, exec_id: execution.execution_id, param_exec_id: `${execution.execution_id}-${index}`,
      param_object: action.param_object || null, param_en_name: action.parameter, param_cn_name: action.param_cn_name || action.parameter,
      before_value: row?.before == null ? null : String(row.before), after_value: row?.after == null ? null : String(row.after),
      value_rule: Number.isFinite(action.constraints?.min) && Number.isFinite(action.constraints?.max)
        ? `[${action.constraints.min}..${action.constraints.max}]${action.constraints.step ? `;step ${action.constraints.step}` : ''}` : null,
      scheme_id: input.scheme_id || plan.plan_id, scheme_group: input.scheme_group || plan.title,
      root_cause_l1: root ? record.input.problem : null, root_cause_l2: root, root_cause_key: root ? `${record.input.problem} / ${root}` : null,
      issued_at: row?.issued_at || null, issued_state: row?.issued_state || null,
      exec_state: success ? 'exec_success' : row?.state === 'execution_failed' ? 'exec_failed' : row?.state === 'not_executed' ? 'no_exec_needed' : 'unknown',
      exec_at: row?.executed_at || null, exec_failure_reason: row?.failure_reason || null,
      rollback_state: row?.state === 'rolled_back' ? 'rolled_back' : null, rollback_at: row?.rollback_at || null,
      rollback_detail: row?.rollback_value === undefined ? null : `恢复到 ${row.rollback_value}`,
      long_eval_result: success ? result : 'long_eval_unknown',
    }
  })
  const trace_id = `harness-${record.workorder_id}-${execution.execution_id}`
  const trace = { trace_id, source: { dataset: mode === 'demo' ? 'harness_demo_synthetic_feedback_v1' : 'harness_workorder_feedback',
    synthetic: synthetic || mode === 'demo', ingested_at: input.evaluation_visible_at || execution.actions.find(row => row.executed_at)?.executed_at || record.updated_at,
    evaluation_visible_at: input.evaluation_visible_at || null,
    source_ref: execution.source_ref, long_eval_source_ref: input.long_eval_source_ref || null,
    workorder_id: record.workorder_id, revision: record.revision, plan_id: plan.plan_id, execution_id: execution.execution_id },
    ticket: { id: record.workorder_id, issued_at: record.input.time_window?.start || null,
      primary_issue_type: record.input.problem, cell_id: record.input.object_id, vendor: record.input.vendor || null,
      system: record.input.system || null, region: record.input.region || null, band: record.input.band || null }, actions,
    aggregate: { action_count: actions.length, ticket_outcome: execution.state === 'execution_failed' ? 'exec_failed'
      : execution.state !== 'executed_success' ? 'long_eval_unknown' : result },
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(trace)).digest('hex').slice(0, 24)
  const directory = path.join(workspace, '.run/wireless-traces')
  fs.mkdirSync(directory, { recursive: true })
  const file_path = path.join(directory, `${digest}.json`)
  if (!fs.existsSync(file_path)) fs.writeFileSync(file_path, JSON.stringify([trace], null, 2) + '\n', { flag: 'wx' })
  return { status: 'trace_exported', mode, synthetic: trace.source.synthetic, trace_id, file_path, trace,
    interpretation: '只导出已记录的实际反馈；缺失执行值保持空值。长期评价是明确声明的标签，前后差值不自动变成长期 Pass/Fail。' }
}
