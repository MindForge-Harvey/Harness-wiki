export const agents = [
  { id: 'foundation', name: '基础能力', shortName: '基础', color: '#64748b', role: '指标、知识与历史案例', icon: 'database' },
  { id: 'complaint', name: '投诉智能体', shortName: '投诉', color: '#e39339', role: '诉求解析、网络定界与感知关联', icon: 'chat' },
  { id: 'optimization', name: '无线优化智能体', shortName: '网优', color: '#4775ee', role: '根因、方案、参数与效果评估', icon: 'wave' },
  { id: 'region', name: '区域优化智能体', shortName: '区域', color: '#9570d6', role: '区域共性问题与多小区协同', icon: 'circles' },
  { id: 'grid', name: '网格智能体', shortName: '网格', color: '#289b86', role: '网格对象定位与质量画像', icon: 'grid' },
];

const capability = (id, agentId, name, description, dependencies = [], options = {}) => ({ id, agentId, name, description, dependencies,
  endpoint: `/api/dispatch/providers/${agentId}/tasks`, mode: ['optimization.execute', 'optimization.rollback'].includes(id) ? 'simulation' : 'local',
  scopeRequired: !['knowledge.search', 'history.search', 'operations.orders', 'operations.stats'].includes(id),
  mutating: ['optimization.execute', 'optimization.rollback'].includes(id),
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  input: ['scope', 'period', 'query', 'upstream'], output: ['summary', 'data', 'sources'],
  ...options,
});

export const capabilities = [
  capability('data.metrics', 'foundation', '网络指标查询', '按小区、网格和时间查询 PRB、下载速率、接通率、切换成功率、RSRP、SINR。'),
  capability('data.cell_info', 'foundation', '工参与配置查询', '查询小区工参、厂家制式和当前参数。'),
  capability('data.alarms', 'foundation', '基站告警查询', '查询指定对象、时间范围内的告警。'),
  capability('knowledge.search', 'foundation', '专业知识检索', '检索覆盖、容量、干扰、切换相关的知识和演示评估规则，无需指定网格。'),
  capability('history.search', 'foundation', '历史案例检索', '检索相关历史处置案例，保留演示来源与适用条件。'),
  capability('grid.resolve', 'grid', '网格对象定位', '解析网格包含的小区和空间范围。'),
  capability('grid.portrait', 'grid', '网格质量画像', '汇总网格指标、投诉和质差小区分布。'),
  capability('complaint.extract', 'complaint', '投诉诉求解析', '提取选定范围的投诉时间、位置、业务和现象。'),
  capability('complaint.locate', 'complaint', '投诉位置校准', '用投诉位置和驻留记录关联实际小区。'),
  capability('complaint.b_domain', 'complaint', '非无线问题甄别', '区分套餐限速、终端和无线网络问题。'),
  capability('complaint.correlate', 'complaint', '投诉与感知关联', '关联投诉热点、时间和小区感知劣化。', ['data.metrics']),
  capability('region.common_cause', 'region', '区域共性问题分析', '比较多小区现象，识别区域共性问题和局部问题。', ['data.metrics']),
  capability('region.coordinate', 'region', '区域协同方案检查', '检查多个小区的方案是否冲突，识别协同保护对象。', ['optimization.plan']),
  capability('optimization.evidence', 'optimization', '网络证据对齐', '对齐指标、告警、配置和投诉的对象与时间窗口。', ['data.metrics']),
  capability('optimization.diagnose', 'optimization', '无线根因研判', '根据当前指标与演示判据识别容量、覆盖、切换等根因假设。', ['data.metrics']),
  capability('optimization.plan', 'optimization', '优化方案制定', '根据当前根因生成具备前值、目标值和评估条件的演示方案。', ['optimization.diagnose']),
  capability('optimization.validate', 'optimization', '参数约束校验', '独立检查候选参数的范围、步长、当前值和保护条件。', ['optimization.plan']),
  capability('optimization.execute', 'optimization', '模拟参数执行', '在隔离的内存演示环境应用已校验方案，产生实际执行回执，不连接现网。', ['optimization.validate']),
  capability('optimization.evaluate', 'optimization', '优化效果评估', '读取本任务或上一任务的模拟执行记录，比较前后指标并给出后续处理意见。', ['optimization.execute']),
  capability('data.rank', 'foundation', '指标 TOP N 排名', '按指定指标对小区排名，保留数值、单位、排序方向与统计窗口。', ['data.metrics'], { parameters: { type: 'object', properties: {
    metric_id: { type: 'string', enum: ['prb', 'dl_rate', 'rrc_success', 'handover_success', 'rsrp', 'sinr', 'ul_interference', 'drop_rate'] },
    limit: { type: 'integer', minimum: 1, maximum: 12 }, order: { type: 'string', enum: ['asc', 'desc'] },
  }, additionalProperties: false } }),
  capability('data.trend', 'foundation', '忙时与日趋势分析', '按日和小时聚合，识别忙时波动、最差小时和指标变化。', ['data.metrics']),
  capability('data.compare', 'foundation', '多网格指标对比', '同一窗口对比多个网格，单网格时比较前后半窗；指标单位与窗口一致。', ['data.metrics']),
  capability('data.poor_cells', 'foundation', '质差小区筛选', '按覆盖、容量、干扰、切换和接通演示判据筛选问题对象。', ['data.metrics']),
  capability('diagnosis.coverage', 'optimization', '覆盖专题诊断', '结合 MR 覆盖采样、RSRP 和天馈告警分析弱覆盖；不以平均信号推算覆盖采样比例。', ['data.metrics']),
  capability('diagnosis.neighbor', 'optimization', '邻区与切换诊断', '关联切换成功率、邻区关系和配置提示，形成待核验的切换问题。', ['data.metrics']),
  capability('diagnosis.parameter', 'optimization', '参数基线核查', '核查当前参数是否满足演示范围、步长与参考基线，区分偏离基线与越界。', ['data.cell_info']),
  capability('diagnosis.interference', 'optimization', '干扰专题诊断', '联合 SINR 和上行干扰噪声分析，区分弱覆盖与干扰线索。', ['data.metrics']),
  capability('diagnosis.alarm', 'optimization', '告警故障关联', '聚合选定对象的告警，与质差现象关联并给出现场核查方向。', ['data.alarms']),
  capability('diagnosis.resource', 'optimization', '资源与容量诊断', '关联 PRB、速率、忙时和同站余量，识别容量受限。', ['data.metrics']),
  capability('decision.rule_assess', 'optimization', '规则取值约束判定', '实际执行发布包原始纯函数，按 para 与 rule_scope 计算一步目标值，保留源建议和独立执行校验边界。', ['optimization.plan']),
  capability('decision.conflicts', 'region', '方案参数冲突剔除', '同一小区同参数出现不同目标值时剔除冲突各方；同值仅记冗余，不按历史 final_ratio 选胜者。', ['optimization.plan']),
  capability('decision.risk_basis', 'optimization', '参数风险依据分析', '区分硬约束内、余量不足一步、有规则无硬约束、规则无匹配；不虚构源代码尚未提供的风险等级。', ['decision.rule_assess']),
  capability('optimization.short_review', 'optimization', '短评估结论复核', '复用发布包原始词表与指标趋势函数，核对执行回执和改善/恶化/缺失结论，缺数不计成功。', ['optimization.evaluate']),
  capability('optimization.rollback', 'optimization', '模拟方案回退', '依据已有模拟执行回执恢复该次执行前的快照，生成独立回退回执，不重复调参。', ['optimization.execute']),
  capability('operations.orders', 'foundation', '优化工单查询', '按范围、时间和状态查询内存中的演示优化工单，返回完整匹配数量。', [], { parameters: { type: 'object', properties: {
    status: { type: 'string', enum: ['all', 'Received', 'Succeed', 'WaitingEval', 'ReasoningFailed', 'LinkFailed', 'TimeoutFailed'] }, limit: { type: 'integer', minimum: 1, maximum: 100 },
  }, additionalProperties: false } }),
  capability('operations.stats', 'foundation', '闭环运营统计', '按同一范围和时间计算演示工单闭环率、状态分布、处理时长，同时统计当前账号真实调度回执。'),
];

export const metrics = [
  { id: 'prb', name: 'PRB 利用率', unit: '%', direction: 'lower', precision: 1 },
  { id: 'dl_rate', name: '下行用户速率', unit: 'Mbps', direction: 'higher', precision: 1 },
  { id: 'rrc_success', name: '无线接通率', unit: '%', direction: 'higher', precision: 2 },
  { id: 'handover_success', name: '切换成功率', unit: '%', direction: 'higher', precision: 2 },
  { id: 'rsrp', name: '平均 RSRP', unit: 'dBm', direction: 'higher', precision: 1 },
  { id: 'sinr', name: '平均 SINR', unit: 'dB', direction: 'higher', precision: 1 },
  { id: 'ul_interference', name: '上行干扰噪声', unit: 'dBm', direction: 'lower', precision: 1 },
  { id: 'drop_rate', name: '无线掉线率', unit: '%', direction: 'lower', precision: 2 },
];

export const intentLabels = { metrics_query: '网络指标查询', knowledge_query: '专业知识问答', complaint_analysis: '投诉问题排查',
  optimization: '无线网络优化', region_analysis: '区域协同分析', grid_analysis: '网格质量分析', closed_loop: '投诉排查与优化闭环', effect_tracking: '优化效果跟踪',
  data_analysis: '网络数据分析', specialized_diagnosis: '网络专题诊断', decision_review: '方案规则与风险审核', rollback: '模拟方案回退', operations: '优化运营分析' };

export const capabilityById = new Map(capabilities.map(item => [item.id, item]));
export const agentById = new Map(agents.map(item => [item.id, item]));
