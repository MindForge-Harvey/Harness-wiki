// Field adaptation only. Business judgments stay in the pinned project kernels.
const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''))
const nettype = value => ({ LTE: '4g', NR: '5g', '4G': '4g', '5G': '5g' }[value] || value)

export function archiveRules(record) {
  return record.actions.filter(action => action.value_rule && action.adjustment_rule
    && action.root_cause_l1 && action.root_cause_l2 && (action.param_cn_name || action.param_en_name))
    .map(action => compact({ type1: action.root_cause_l1, type2: action.root_cause_l2,
      nettype: nettype(record.ticket.system), vendor: record.ticket.vendor, band: record.ticket.band,
      parachinname: action.param_cn_name || action.param_en_name, execute_number: action.exec_id || action.action_id,
      para: action.value_rule, rule_scope: action.adjustment_rule, is_use: '是',
      source_ref: record.source_ref + ':' + action.action_id, rule_origin: 'archived_action_contract',
    }))
}

export function orderAnalysisInput(record, { caseRecords = [], networkData, analysisSelection } = {}) {
  if (record?.status !== 'found' || !record.ticket) throw new Error('未找到工单，无法创建分析上下文')
  const ticket = record.ticket
  const initial_plans = record.actions.map(action => compact({
    execution_id: String(action.action_id), plan_number: action.scheme_id, execute_number: action.exec_id,
    parachinname: action.param_cn_name || action.param_en_name,
    f_para: networkData?.parameters?.[action.param_en_name] ?? action.before_value,
    b_para: action.recorded_target, type1: action.root_cause_l1, type2: action.root_cause_l2,
    band: ticket.band, operation_summary: action.operation_summary, operation_detail: action.operation_detail,
  }))
  const cases = []
  for (const previous of caseRecords) {
    if (previous.ticket.id === ticket.id || !previous.actions.length || previous.actions.some(action => action.exec_state !== 'exec_success')) continue
    const outcomes = new Set(previous.actions.map(action => action.long_eval_result))
    if (outcomes.size !== 1 || !['long_eval_pass', 'long_eval_fail'].includes([...outcomes][0])) continue
    const group = new Map()
    for (const action of previous.actions) {
      const key = JSON.stringify([action.root_cause_l1, action.root_cause_l2])
      if (!group.has(key)) group.set(key, [])
      group.get(key).push(action)
    }
    for (const actions of group.values()) cases.push(compact({
      case_id: `${previous.trace_id}:${cases.length}`, source_ref: previous.source_ref,
      taskno: previous.ticket.id, problem_type: previous.ticket.primary_issue_type,
      cause1: actions[0].root_cause_l1, cause2: actions[0].root_cause_l2,
      estimate_result: outcomes.has('long_eval_pass') ? '改善' : '恶化',
      created: previous.ticket.issued_at, vendor: previous.ticket.vendor,
      nettype: nettype(previous.ticket.system), city: previous.ticket.region,
      outcome_scope: 'archived_successfully_executed_bundle',
      actions: actions.map(action => compact({ parameter: action.param_cn_name || action.param_en_name,
        before: action.before_value, after: action.actual_after })),
    }))
  }
  return {
    source_ref: networkData ? networkData.source_ref + ' | archive:' + record.source_ref : record.source_ref,
    order: compact({ taskno: ticket.id, task_type: ticket.primary_issue_type, cell_name: ticket.cell_name,
      cgi: ticket.cell_id, eci: ticket.eci, nettype: nettype(ticket.system), vendor: ticket.vendor,
      city: ticket.region, band: ticket.band, cover_area: ticket.cover_area, createtime: ticket.issued_at,
      ...Object.fromEntries(['conclusion', 'smart_conclusion', 'cover_totalverdict', 'adj_totalverdict',
        'param_totalverdict', 'interfere_totalverdict', 'alarm_totalverdict', 'resource_totalverdict'].map(key => [key, ticket[key]])),
      ...(networkData?.order_patch || {}),
    }),
    initial_plans, cases: cases.slice(0, 500),
    ...(networkData?.rules?.length || archiveRules(record).length ? { rules: networkData?.rules?.length ? networkData.rules : archiveRules(record) } : {}),
    ...(networkData ? { observations: networkData.observations,
      network_context: { version: networkData.version, snapshot_date: networkData.snapshot_date,
        source_ref: networkData.source_ref, provenance: networkData.provenance,
        analysis_window: networkData.analysis_window, parameters: networkData.parameters,
        neighbors: networkData.neighbors, alarms: networkData.alarms, evaluation_policy: networkData.evaluation_policy } } : {}),
    archive_context: { trace_id: record.trace_id, proposal_scope: 'recorded_historical_proposal',
      analysis_selection: analysisSelection || networkData?.analysis_selection || record.analysis_selection,
      cases_scope: 'bounded_earlier_same_issue_vendor_system_archive_snapshot',
      case_records_examined: caseRecords.length, evaluation_visibility_at_original_decision: 'not_verified',
      rule_source: archiveRules(record).length ? 'archived_action_contract' : 'bundled_project_rules',
      missing_fields: record.archive_missing_fields || record.missing_fields },
  }
}
