import { capabilities } from './catalog.mjs';

export const domains = [
  { id: 'data', name: '数据自服务' }, { id: 'diagnosis', name: '网络诊断' }, { id: 'decision', name: '方案决策' }, { id: 'loop', name: '运维闭环' },
];
const ability = (id, domainId, name, tools, sourcePath) => ({ id, domainId, name, toolIds: tools, sourcePath });
export const professionalAbilities = [
  ability('metrics', 'data', '指标分析', ['data.metrics', 'data.rank', 'data.trend', 'data.compare', 'data.poor_cells'], 'network-qa-assistant/backend/services/data_self_service/'),
  ability('objects', 'data', '对象与工参', ['data.cell_info', 'grid.resolve', 'grid.portrait'], 'network-qa-assistant/backend/services/data_self_service/cell_resolver.py'),
  ability('knowledge', 'data', '专业知识与案例', ['knowledge.search', 'history.search'], 'network-qa-assistant/backend/services/rag/'),
  ability('complaint', 'diagnosis', '投诉定界', ['complaint.extract', 'complaint.locate', 'complaint.b_domain', 'complaint.correlate']),
  ability('coverage', 'diagnosis', '覆盖分析', ['diagnosis.coverage'], 'network-ops-loop-v3/services/decision/cause_dimensions.py'),
  ability('neighbor', 'diagnosis', '邻区分析', ['diagnosis.neighbor'], 'network-ops-loop-v3/services/decision/cause_dimensions.py'),
  ability('parameter', 'diagnosis', '参数分析', ['diagnosis.parameter'], 'network-ops-loop-v3/services/decision/cause_dimensions.py'),
  ability('interference', 'diagnosis', '干扰分析', ['diagnosis.interference'], 'network-ops-loop-v3/services/decision/cause_dimensions.py'),
  ability('alarm', 'diagnosis', '告警分析', ['data.alarms', 'diagnosis.alarm'], 'network-ops-loop-v3/services/decision/cause_dimensions.py'),
  ability('resource', 'diagnosis', '资源分析', ['diagnosis.resource'], 'network-ops-loop-v3/services/decision/cause_dimensions.py'),
  ability('root', 'diagnosis', '证据与根因', ['optimization.evidence', 'optimization.diagnose', 'region.common_cause']),
  ability('solution', 'decision', '方案制定', ['optimization.plan', 'region.coordinate']),
  ability('rules', 'decision', '规则约束与风险依据', ['decision.rule_assess', 'decision.risk_basis', 'optimization.validate'], 'network-ops-loop-v3/services/compliance/rule_constraint.py'),
  ability('conflicts', 'decision', '方案冲突检查', ['decision.conflicts'], 'network-ops-loop-v3/services/decision/arbitration.py'),
  ability('execution', 'loop', '执行、评估与回退', ['optimization.execute', 'optimization.evaluate', 'optimization.short_review', 'optimization.rollback'], 'network-ops-loop-v3/services/decision/prior_round.py'),
  ability('operations', 'loop', '工单与闭环运营', ['operations.orders', 'operations.stats'], 'network-ops-loop-v3/services/orders/status.py'),
];
const scenario = (id, domainId, name, description, preferredAbilities, suggestedTools, prompt) => {
  // The tool relationships are authoritative; author hints only control display order.
  const related = professionalAbilities.filter(group => suggestedTools.some(tool => group.toolIds.includes(tool))).map(group => group.id);
  const abilityIds = [...new Set([...preferredAbilities.filter(id => related.includes(id)), ...related])];
  return { id, domainId, name, description, abilityIds, suggestedTools, prompt };
};
export const scenarios = [
  scenario('metric-ranking', 'data', '质差 TOP N 排查', '按指定指标找到最需关注的小区', ['metrics'], ['data.metrics', 'data.rank', 'data.poor_cells'], '查询新街口商圈近7天下行用户速率最低的前3个小区，列出指标和质差原因。'),
  scenario('busy-hour', 'data', '忙时容量与趋势', '区分持续性高负荷与忙时波动', ['metrics', 'resource'], ['data.metrics', 'data.trend', 'diagnosis.resource'], '分析新街口商圈近7天的忙时负荷和速率趋势，找出容量瓶颈，只分析不下发。'),
  scenario('grid-comparison', 'data', '多网格质量对比', '在同一窗口比较网络短板', ['metrics', 'objects'], ['data.metrics', 'data.compare', 'grid.portrait'], '对比新街口商圈和河西商务区近7天的PRB、速率和覆盖指标，说明各自短板。'),
  scenario('knowledge-case', 'data', '知识与案例溯源', '解释专业问题并对照处置经验', ['knowledge'], ['knowledge.search', 'history.search'], '解释高负荷导致下载慢的排查方法，并检索相似的历史优化案例。'),
  scenario('coverage', 'diagnosis', '弱覆盖专题', '结合采样、信号与告警核验覆盖问题', ['coverage', 'alarm', 'objects'], ['data.metrics', 'data.alarms', 'diagnosis.coverage', 'diagnosis.alarm'], '排查仙林大学城近7天的弱覆盖问题，结合MR采样和告警给出证据，不要执行。'),
  scenario('interference', 'diagnosis', '上行干扰专题', '联合 SINR 与干扰噪声定位线索', ['interference', 'metrics'], ['data.metrics', 'diagnosis.interference'], '分析仙林大学城近7天是否存在上行干扰，区分干扰与弱覆盖，不要调参。'),
  scenario('handover', 'diagnosis', '邻区与切换专题', '核查移动过程中的切换质差', ['neighbor', 'parameter'], ['data.metrics', 'data.cell_info', 'diagnosis.neighbor', 'diagnosis.parameter'], '排查新街口商圈地铁口小区的切换成功率低问题，核查邻区和参数，不要下发。'),
  scenario('six-dimensions', 'diagnosis', '六维综合诊断', '覆盖、邻区、参数、干扰、告警、资源逐维留证', ['coverage', 'neighbor', 'parameter', 'interference', 'alarm', 'resource', 'root'], ['data.metrics', 'data.cell_info', 'data.alarms', 'diagnosis.coverage', 'diagnosis.neighbor', 'diagnosis.parameter', 'diagnosis.interference', 'diagnosis.alarm', 'diagnosis.resource', 'optimization.diagnose'], '对仙林大学城近7天做覆盖、邻区、参数、干扰、告警、资源六维诊断，保留正常项和待核验项，只分析。'),
  scenario('complaint', 'diagnosis', '投诉定位与定界', '先排除非无线问题，再关联网络证据', ['complaint', 'objects', 'root'], ['grid.resolve', 'complaint.extract', 'complaint.locate', 'complaint.b_domain', 'data.metrics', 'complaint.correlate', 'optimization.diagnose'], '分析新街口商圈近7天投诉集中原因，校准位置并排除套餐与终端问题，只给分析建议。'),
  scenario('rule-audit', 'decision', '方案规则与风险审核', '查看一步改写、约束依据与冲突剔除', ['root', 'solution', 'rules', 'conflicts'], ['data.metrics', 'optimization.diagnose', 'optimization.plan', 'decision.rule_assess', 'decision.risk_basis', 'decision.conflicts', 'optimization.validate'], '为新街口商圈生成优化建议，按规则库检查取值、步长、冲突和风险依据，不执行。'),
  scenario('optimization-loop', 'loop', '投诉排查与优化闭环', '实际派发本地任务并根据效果追加复查', ['complaint', 'root', 'solution', 'rules', 'execution'], ['grid.resolve', 'complaint.extract', 'complaint.b_domain', 'data.metrics', 'complaint.correlate', 'region.common_cause', 'optimization.diagnose', 'optimization.plan', 'decision.rule_assess', 'optimization.validate', 'optimization.execute', 'optimization.evaluate'], '排查新街口商圈近7天投诉原因，制定方案、完成规则校验，安排模拟处理并跟踪效果。'),
  scenario('short-review', 'loop', '短评估与回执复核', '复用已有执行，不把缺失评价计为成功', ['execution'], ['optimization.evaluate', 'optimization.short_review'], '复核刚才模拟处理的执行回执和短评估结论，不要重复执行。'),
  scenario('rollback', 'loop', '模拟回退', '按执行前值恢复并保留独立回退回执', ['execution'], ['optimization.rollback'], '将刚才的模拟参数方案回退到执行前的状态，给出回退回执。'),
  scenario('operations', 'loop', '闭环运营与工单统计', '查看状态、处理时长与闭环统计口径', ['operations'], ['operations.orders', 'operations.stats'], '统计近7天全网演示优化工单的闭环率、状态分布和处理时长，列出尚未闭环的工单。'),
];

export function hierarchyCatalog() {
  return { domains, professionalAbilities, scenarios, capabilities: capabilities.map(tool => ({ ...tool,
    abilityIds: professionalAbilities.filter(group => group.toolIds.includes(tool.id)).map(group => group.id),
    scenarioIds: scenarios.filter(scene => scene.suggestedTools.includes(tool.id)).map(scene => scene.id),
    sourcePaths: [...new Set(professionalAbilities.filter(group => group.toolIds.includes(tool.id) && group.sourcePath).map(group => group.sourcePath))],
    implementation: ['decision.rule_assess', 'optimization.short_review'].includes(tool.id) ? 'original-function' : /^(diagnosis\.|decision\.|operations\.|data\.(rank|trend|compare|poor_cells))/.test(tool.id) || tool.id === 'optimization.rollback' ? 'release-adapter' : 'local-demo',
  })) };
}
