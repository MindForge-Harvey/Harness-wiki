import { skillTitle } from './skill-catalog.mjs';

const labels = {
  todo_write: '任务拆解与进度',
  skill: '加载 Skill',
  wireless_icos_context: '读取工单分析上下文',
  wireless_icos_root_cause: '分析根因与证据',
  wireless_icos_objective: '确认优化目标',
  wireless_icos_cases: '对照同类历史工单',
  wireless_icos_candidates: '组织与比较候选方案',
  wireless_icos_alignment: '核对方案与根因的对应关系',
  wireless_icos_parameter_risk: '检查参数取值与风险',
  wireless_icos_consistency: '复核整单方案一致性',
  wireless_icos_decision: '形成综合决策',
  wireless_icos_multi_round: '分析下一轮优化方向',
  wireless_icos_feedback: '核对执行与评价反馈',
  wireless_order_query: '查询工单与整理信息',
  wireless_network_query: '读取指标、参数和规则',
  wireless_echo_query: '梳理经验复用机制',
  wireless_knowledge_query: '核对参数含义与经验',
  wireless_case_search: '查找可参考的历史案例',
  wireless_history_search: '检索历史工单与已沉淀经验',
  wireless_parameter_check: '核对参数调整约束',
  wireless_compile_history: '沉淀历史优化经验',
  wireless_memory_query: '读取已沉淀的经验',
  wireless_echo_decision: '比对历史候选与当前适配',
  wireless_data_analyze: '计算指标变化与时段特征',
  wireless_demo: '分析场景与复用经验',
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
  export_trace: ['导出有来源的历史记录'],
};
export const toolLabel = name => labels[name] || (name === 'wireless_workorder' ? '处理网优工单' : '处理分析资料');
export function visibleTool(card) {
  return Boolean(card.name);
}
export function stageKey(card) {
  return card.callId ? `call:${card.callId}` : [card.name, card.args?.operation || '', card.args?.workorder_id || ''].join(':');
}
const count = value => Array.isArray(value) ? value.length : 0;
function outcome(card) {
  const j = card.resultJson || {}, args = card.args || {};
  if (card.status === 'running') return { status: 'running', summary: '正在处理这一阶段…' };
  if (card.status === 'error') return { status: 'error', summary: '这一步未成功，尚未得到可用结果。' };
  if (card.status === 'interrupted') return { status: 'error', summary: '任务已中断，这一阶段尚未完成。' };
  const done = summary => ({ status: 'done', summary });
  const pending = summary => ({ status: 'needs_data', summary });
  if (card.name.startsWith('wireless_') && !card.resultJson && card.resultText) {
    return done(card.resultTruncated ? '资料已返回，完整结果已转存，可结合后续读取查看' : '资料已返回，可展开查看结果');
  }
  if (card.name === 'todo_write') {
    const tasks = j.todos || args.todos || [];
    const complete = tasks.filter(task => task.status === 'completed').length;
    const active = tasks.find(task => task.status === 'in_progress');
    return done(`已完成 ${complete}/${tasks.length} 项${active ? `，正在${active.content}` : ''}`);
  }
  if (card.name === 'skill') return done(`已加载「${skillTitle(args.name)}」`);
  if (card.name.startsWith('wireless_icos_')) {
    if (card.name === 'wireless_icos_context' && j.analysis_selection?.selected_date) {
      const selection = j.analysis_selection;
      return done(`已读取工单资料，分析日期 ${selection.selected_date}${selection.cross_period ? '，与原工单分期分析' : ''}`);
    }
    if (j.read_only && j.operation === 'explain') return done('已读取逐动作的实际规则、复核与最终去留');
    if (j.status === 'needs_stages') return pending(`需要先完成：${(j.missing_stages || []).join('、')}`);
    if (j.status === 'needs_judgment') return pending('已取得分析要求，正在核对依据与判断');
    if (j.status === 'needs_data') return pending('本阶段所需信息尚不完整');
    if (j.status === 'completed') return done(j.result?.status === 'not_called' ? '已核对输入，本阶段缺少可判断的证据' : '本阶段已完成，依据和结果可展开查看');
    return done(j.reused ? '已复用本轮有效分析记录' : '已读取当前阶段记录');
  }
  if (card.name === 'wireless_order_query') {
    if (j.status === 'found' && j.ticket) return done(`已读取工单 ${j.ticket.id} 的小区、动作与处理记录`);
    if (j.status === 'found' || j.status === 'no_matches') return done(`查询到 ${j.total || 0} 张工单，本页展示 ${count(j.tickets)} 张`);
    if (j.status === 'available') return done(`工单库已收录 ${j.total_tickets} 张工单`);
    if (j.status === 'not_found') return done('未找到这个工单号，可核对编号后继续查询');
    return pending('工单索引正在准备');
  }
  if (card.name === 'wireless_network_query') return j.status === 'found'
    ? done(j.total !== undefined ? `已读取 ${j.total} 条指标观测` : `已读取 ${j.snapshot_date} 的指标、诊断与 ${j.rule_count || 0} 条参数规则`)
    : j.status === 'available' ? done(`已有 ${count(j.snapshots)} 份小区数据快照`)
      : pending(j.analysis_selection?.selected_date ? `未匹配 ${j.analysis_selection.selected_date} 的快照，其他日期未带入` : '当前查询条件下尚无已入库快照');
  if (card.name === 'wireless_data_analyze') return j.status === 'analyzed'
    ? done(`已计算 ${j.series_count} 组指标的基线与变化${count(j.quarantined) ? `，隔离 ${count(j.quarantined)} 条问题观测` : ''}`)
    : pending('尚无可比较的有效观测');
  if (card.name === 'wireless_demo') {
    const summary = { demo_memory_prepared: '历史经验已准备', demo_candidates_compared: `已比较 ${count(j.candidates)} 个历史候选及其反证`,
      demo_decision_frozen: '方案与依据版本已冻结', demo_feedback_revealed: '已读取方案反馈并比较前后效果',
      demo_memory_learned: '已生成新的经验版本，保留旧版', demo_memory_read: '已读取当前版本的六类经验', no_candidates: '该场景没有兼容的历史候选' }[j.status];
    if (j.status === 'needs_data') return pending('当前快照或评价尚不完整');
    return done(summary || (j.scenario_id ? '已读取场景的决策前数据' : `已读取 ${j.counts?.scenarios || 0} 个场景`));
  }
  if (card.name === 'wireless_echo_decision') {
    if (j.status === 'ranked_candidates') return done(`已按 ECHO 方法比较 ${count(j.candidates)} 个历史候选；仍需核对反证与当前条件。`);
    if (j.status === 'historical_candidate_selected') return done('已从历史候选中选择动作模式；尚未下发。');
    if (j.status === 'adapted_value_candidate') return done('已结合当前快照适配候选值并检查声明约束。');
    if (j.status === 'no_candidates') return done('未找到可用于择优的历史候选，保留有依据的条件性方向。');
    return pending(j.status === 'blocked' ? '候选值违反声明约束，需调整或复核。' : '当前快照或有效历史评价不足，尚未生成目标值。');
  }
  if (card.name === 'wireless_history_search') {
    const cases = count(j.cases), memories = Object.values(j.memories || {}).reduce((n, group) => n + count(group.memories), 0);
    const connector = '';
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
    if (op === 'export_trace') return j.status === 'trace_exported' ? done('已按执行账本导出有来源的历史记录') : pending('历史记录导出尚未完成');
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
    ? done(args.mode === 'demo' ? '已生成本地经验包' : '已生成可追溯的本地经验包') : pending('尚未取得可用的经验包');
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

export function latestTaskPlan(messages) {
  const start = messages.findLastIndex(message => message.role === 'user');
  const last = messages.slice(start + 1).findLast(message => message.role === 'tool'
    && message.name === 'todo_write' && message.status === 'done');
  return last?.resultJson?.todos || [];
}
