const labels = {
  wireless_echo_query: '梳理经验复用机制',
  wireless_knowledge_query: '核对参数含义与经验',
  wireless_case_search: '查找可参考的历史案例',
  wireless_history_search: '检索历史工单与已沉淀经验',
  wireless_parameter_check: '核对参数调整约束',
  wireless_compile_history: '沉淀历史优化经验',
  wireless_memory_query: '读取已沉淀的经验',
  wireless_echo_decision: '比对历史候选与当前适配',
  lightrag_query_data: '查阅网优资料',
  kb_ingest: '收录网优资料', kb_update: '更新网优资料',
  kb_status: '检查资料服务', kb_analyze: '检查资料质量',
  kb_report: '整理资料报告', kb_graph_search: '查找关联知识',
  kb_feedback_inbox: '查看反馈', kb_feedback_context: '核对反馈依据',
  kb_diagnosis_submit: '保存诊断结果',
};
const operations = {
  intake: ['接入工单', 'intake'], identify: ['识别问题类型', 'identify'],
  build_evidence: ['对齐当前分析证据', 'evidence'], diagnose: ['核对根因假设', 'diagnosis'],
  save_plan: ['保存优化候选方案', 'plan'], record_execution: ['记录执行反馈', 'execution'],
  evaluate: ['比较调整前后效果', 'evaluation'], read: ['读取工单进展'], history: ['核对工单历史'],
};
export const toolLabel = name => labels[name] || (name === 'wireless_workorder' ? '处理网优工单' : '处理分析资料');
export function visibleTool(card) {
  // Loading instructions and reading files are internal operations, not completed business tasks.
  return Boolean(labels[card.name] || card.name === 'wireless_workorder' || card.status === 'error');
}
export function stageKey(card) {
  return [card.name, card.args?.operation || '', card.args?.workorder_id || ''].join(':');
}
const count = value => Array.isArray(value) ? value.length : 0;
function outcome(card) {
  const j = card.resultJson || {}, args = card.args || {};
  if (card.status === 'running') return { status: 'running', summary: '正在处理这一阶段…' };
  if (card.status === 'error') return { status: 'error', summary: '这一步未成功，尚未得到可用结果。' };
  if (card.status === 'interrupted') return { status: 'error', summary: '任务已中断，这一阶段尚未完成。' };
  const done = summary => ({ status: 'done', summary });
  const pending = summary => ({ status: 'needs_data', summary });
  if (card.name === 'wireless_echo_decision') {
    if (j.status === 'ranked_candidates') return done(`已按 ECHO 方法比较 ${count(j.candidates)} 个历史候选；仍需核对反证与当前条件。`);
    if (j.status === 'historical_candidate_selected') return done('已从历史候选中选择动作模式；尚未下发。');
    if (j.status === 'adapted_value_candidate') return done('已结合当前快照适配候选值并检查声明约束。');
    if (j.status === 'no_candidates') return done('未找到可用于择优的历史候选，保留有依据的条件性方向。');
    return pending(j.status === 'blocked' ? '候选值违反声明约束，需调整或复核。' : '当前快照或有效历史评价不足，尚未生成目标值。');
  }
  if (card.name === 'wireless_history_search') {
    const cases = count(j.cases), memories = Object.values(j.memories || {}).reduce((n, group) => n + count(group.memories), 0);
    const connector = j.sources?.production_workorder_connector?.status === 'not_connected' ? '；完整生产工单库尚未接入' : '';
    if (j.status === 'search_incomplete') return { status: 'warning', summary: `部分历史来源读取失败，已保留可用结果${connector}` };
    if (j.status === 'no_history_match') return done(`历史检索已完成，未找到匹配工单或记忆${connector}`);
    if (j.status === 'history_match') return done(`历史已查：${cases} 条案例、${memories} 条记忆，需与当前条件比对${connector}`);
    return pending('尚未取得有效的历史检索结果');
  }
  if (card.name === 'wireless_echo_query') {
    return count(j.guides) ? done(`已核对：${j.guides.map(g => g.title).join('、')}`)
      : count(j.passages) ? done('已核对所请求的实现依据')
        : pending('当前资料未找到对应机制，需要补充问题或资料');
  }
  if (card.name === 'wireless_case_search') return count(j.cases)
    ? done(`找到 ${count(j.cases)} 条参考案例，适用条件仍需与当前工单比对`)
    : pending('当前案例中未找到匹配条目');
  if (card.name === 'wireless_knowledge_query') {
    const parameters = count(j.results?.parameters), applications = count(j.results?.case_applications);
    if (parameters) return done(applications ? `参数含义已核对，找到 ${applications} 条相关应用案例` : '参数含义已核对，当前材料暂无相关案例');
    if (applications) return done(`找到 ${applications} 条相关应用案例，参数说明仍需核对`);
    return count(j.results?.lessons) ? done('已查到相关经验结论') : pending('当前资料中未找到匹配的参数或经验');
  }
  if (card.name === 'wireless_parameter_check') return j.status === 'needs_data'
    ? pending('参数信息尚不完整，需补齐当前值或约束依据')
    : j.status === 'blocked' ? { status: 'warning', summary: '候选调整未通过声明约束，需修改方案' }
      : j.status === 'constraints_pass' ? done('候选值通过所声明的约束检查，尚未执行调整')
        : pending('已收到检查结果，仍需核对调整条件');
  if (card.name === 'wireless_workorder') {
    const op = args.operation, stage = j.stages?.[operations[op]?.[1]];
    if (op === 'read') return done('已读取当前工单记录');
    if (op === 'history') return done(`已读取 ${count(j.events)} 条阶段记录`);
    if (!stage) return pending('尚未取得这个阶段的有效记录');
    switch (op) {
      case 'intake': return stage.status === 'needs_data' ? pending('工单已保存，分析必需信息尚待补齐') : done('已整理工单对象、问题和异常时段');
      case 'identify': return stage.primary_issue_type ? done(`已初步识别：${stage.primary_issue_type}，根因仍需验证`) : pending('现有描述不足以识别问题类型');
      case 'build_evidence': return count(stage.current_evidence) ? done(`已对齐 ${count(stage.current_evidence)} 条当前观测${count(stage.quarantined) ? `，另有 ${count(stage.quarantined)} 条暂不可用` : ''}`) : pending('尚无可用于分析的同口径观测');
      case 'diagnose': return count(stage.hypotheses) ? done(`已核对 ${count(stage.hypotheses)} 个根因假设的支持与反对依据，尚未确证因果`) : pending('尚无可核对的根因假设');
      case 'save_plan': return stage.status === 'draft_needs_data' ? pending('候选方案已保存，参数信息仍待补齐') : stage.status === 'draft_blocked'
        ? { status: 'warning', summary: '候选方案已保存，但存在约束冲突' } : done('候选方案已保存，尚未下发执行');
      case 'record_execution': return stage.status === 'feedback_recorded_with_gaps' ? pending('执行反馈已记录，实际值或执行时间仍待补齐') : done('已记录用户提供的执行反馈，效果需另行评估');
      case 'evaluate': {
        const summary = { declared_rule_met: '前后效果比较完成，达到所声明的评价标准', declared_rule_not_met: '前后效果比较完成，未达到所声明的评价标准', process_failure: '执行失败已记录，不能判定优化效果', observing: '尚未达到所声明的观察时长', not_assessable: '当前执行或观测条件不足，暂不能评估效果', needs_data: '效果评价所需数据或判据尚待补齐' }[stage.status];
        return ['declared_rule_met', 'declared_rule_not_met'].includes(stage.status) ? done(summary) : pending(summary || '尚未得到完整的效果评价');
      }
    }
  }
  if (card.name === 'wireless_compile_history') return j.status === 'needs_data' ? pending('历史经验编译所需记录尚待补齐') : j.package_id
    ? done(args.mode === 'demo' ? '已生成演示经验包，不能作为现场效果结论' : '已生成可追溯的本地经验包') : pending('尚未取得可用的经验包');
  if (card.name === 'wireless_memory_query') return count(j.memories) ? done(`读到 ${count(j.memories)} 条经验及其支持、反对依据`) : pending('所选经验包中未找到匹配条目');
  if (card.name === 'lightrag_query_data') return count(j.data?.chunks || j.chunks) ? done(`找到 ${count(j.data?.chunks || j.chunks)} 段相关资料`) : pending('本次查询未返回可引用的资料片段');
  return done('已收到处理结果');
}
export function taskProgress(card) {
  const calls = card.calls || [card], results = calls.map(outcome);
  const status = ['running', 'error', 'warning', 'needs_data', 'done'].find(s => results.some(r => r.status === s));
  return { title: card.name === 'wireless_workorder' ? operations[card.args?.operation]?.[0] || toolLabel(card.name) : toolLabel(card.name),
    status, summaries: [...new Set(results.map(r => r.summary))] };
}
export function groupTaskMessages(messages) {
  const out = [], groups = new Map();
  for (const message of messages) {
    if (message.role === 'thinking') continue; // Defensive support for earlier API versions.
    if (message.role === 'user') groups.clear();
    if (message.role !== 'tool') { out.push(message); continue; }
    if (!visibleTool(message)) continue;
    const key = stageKey(message), existing = groups.get(key);
    if (existing) existing.calls.push(message);
    else { const group = { ...message, calls: [message] }; out.push(group); groups.set(key, group); }
  }
  return out;
}
