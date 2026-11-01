export const agents = [
  { id: 'foundation', name: '基础能力', shortName: '基础', color: '#64748b', role: '指标、知识与历史案例', icon: 'database' },
  { id: 'complaint', name: '投诉智能体', shortName: '投诉', color: '#e39339', role: '诉求解析、网络定界与感知关联', icon: 'chat' },
  { id: 'optimization', name: '无线优化智能体', shortName: '网优', color: '#4775ee', role: '根因、方案、参数与效果评估', icon: 'wave' },
  { id: 'region', name: '区域优化智能体', shortName: '区域', color: '#9570d6', role: '区域共性问题与多小区协同', icon: 'circles' },
  { id: 'grid', name: '网格智能体', shortName: '网格', color: '#289b86', role: '网格对象定位与质量画像', icon: 'grid' },
];

const capability = (id, agentId, name, description, dependencies = []) => ({ id, agentId, name, description, dependencies,
  endpoint: `/api/dispatch/providers/${agentId}/tasks`, mode: id === 'optimization.execute' ? 'simulation' : 'local',
  input: ['scope', 'period', 'query', 'upstream'], output: ['summary', 'data', 'sources'],
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
];

export const metrics = [
  { id: 'prb', name: 'PRB 利用率', unit: '%', direction: 'lower', precision: 1 },
  { id: 'dl_rate', name: '下行用户速率', unit: 'Mbps', direction: 'higher', precision: 1 },
  { id: 'rrc_success', name: '无线接通率', unit: '%', direction: 'higher', precision: 2 },
  { id: 'handover_success', name: '切换成功率', unit: '%', direction: 'higher', precision: 2 },
  { id: 'rsrp', name: '平均 RSRP', unit: 'dBm', direction: 'higher', precision: 1 },
  { id: 'sinr', name: '平均 SINR', unit: 'dB', direction: 'higher', precision: 1 },
];

export const intentLabels = { metrics_query: '网络指标查询', knowledge_query: '专业知识问答', complaint_analysis: '投诉问题排查',
  optimization: '无线网络优化', region_analysis: '区域协同分析', grid_analysis: '网格质量分析', closed_loop: '投诉排查与优化闭环', effect_tracking: '优化效果跟踪' };

export const capabilityById = new Map(capabilities.map(item => [item.id, item]));
export const agentById = new Map(agents.map(item => [item.id, item]));
