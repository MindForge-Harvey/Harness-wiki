/** Read the recorded code decisions; this projection never reruns or changes a decision. */
export function explainRecordedDecision(state) {
  const stages = state.stages, final = stages.decision?.response.result
  if (stages.decision?.response.status !== 'completed' || final.preview) return {
    status: 'needs_stages', missing_stages: ['decision'], next_tools: ['wireless_icos_decision'],
    interpretation: '还没有本轮最终裁决；需要先完成必要阶段并 finalize，不能根据初案猜最终去留。',
  }
  const alignment = stages.alignment?.response.result?.plans || []
  const risks = stages.parameter_risk?.response.result || {}
  const review = stages.consistency?.response.result?.review || {}
  return { status: 'completed', operation: 'explain', read_only: true, reused: true,
    result: { verdict: final.decision.verdict,
      actions: final.decision.chain.actions.map(action => {
        const row = final.rows.find(row => String(row.execution_id) === action.plan_key) || {}
        const risk = risks[action.plan_key]
        return { action_id: action.plan_key, parameter: action.parachinname, plan_number: action.plan_number,
          current: row.f_para ?? null, proposed: row.org_b_para ?? null,
          selected: action.dispatched, selected_target: action.dispatched ? action.value : null,
          final_stage: action.stage, final_reason: action.reason, detail: action.detail || '',
          alignment: alignment.filter(item => item.keys?.includes(action.plan_key)).map(item => ({
            relation: item.relation, association: item.association, causes: item.causes, reason: item.reason })),
          rule_check: risk ? { verdict: risk.verdict, shape: risk.shape, checked_target: risk.final_b_para,
            para: risk.rule_row?.para ?? null, rule_scope: risk.rule_row?.rule_scope ?? null,
            explanation: risk.basis_step?.distance_explanation || '', case_steps: risk.case_steps?.summary || '' } : null,
          consistency: { reviewed: Boolean(review.listed_keys?.includes(action.plan_key)),
            result: review.relevance?.[action.plan_key] || null },
        }
      }),
      method_contract: {
        matching_keys: ['type1', 'type2', 'nettype', 'vendor', 'parachinname'],
        tie_breakers: ['execute_number', 'band'],
        para: '取值约束。单值约束要求目标等于指定值；不能把 rule_scope 的 !=X 说成 para。',
        rule_scope: '数值区间使用带符号步长；单值类的 !=X 不参与取值判定。',
        numeric_policy: '按现值加规则步长计算并核对方向、边界；不满足即拒绝，不做夹边或格点吸附。',
        final_filter: '最终去留及决定环节以 final_stage/final_reason 为准；独立规则可行或复核正向不等于最终采用。reviewed 按原记录返回，不能凭早期剔除猜未复核。',
      },
    } }
}
