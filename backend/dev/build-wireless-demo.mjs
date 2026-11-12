/** Reproducible, entirely synthetic inputs. Never label these as production evidence. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dsh/dsh-wireless/resources/demo')
fs.mkdirSync(root, { recursive: true })
const families = [
  ['access', '低接通', '园区晚高峰接入失败', '华为', 'LTE', 'B3', '接入资源与重传', 'AccessMargin', 'Msg3Retries', 'AdmissionExpansion', 'RRC 接通率', '%', 'higher', 99.2, 92.5, 97, 'lt'],
  ['handover', '切换异常', '高铁沿线切换失败', '中兴', 'NR', 'n78', '移动性与邻区配置', 'HandoverMargin', 'TimeToTrigger', 'AggressiveHandover', '切换成功率', '%', 'higher', 98.6, 87.4, 95, 'lt'],
  ['coverage', '覆盖异常', '城郊弱覆盖投诉', '华为', 'LTE', 'B8', '覆盖边界与天线配置', 'ElectricalTilt', 'CoverageOffset', 'PowerExpansion', '弱覆盖采样占比', '%', 'lower', 4.5, 24.6, 10, 'gt'],
  ['interference', '干扰问题', '工业园上行干扰', '中兴', 'NR', 'n78', '上行干扰与频域分布', 'InterferenceControl', 'PuschOffset', 'WidebandBoost', '上行噪声抬升', 'dB', 'lower', 2.1, 11.8, 6, 'gt'],
  ['capacity', '负荷或容量异常', '商圈忙时拥塞低速率', '华为', 'LTE', 'B3', '忙时负荷与资源分配', 'LoadBalanceOffset', 'SchedulerWeight', 'AdmissionLimit', '下行用户平均吞吐', 'Mbps', 'higher', 28.4, 4.2, 10, 'lt'],
  ['throughput', '低速率', '校园视频卡顿', '中兴', 'NR', 'n41', '链路质量与调度', 'SchedulerWindow', 'LinkAdaptation', 'ConservativeMcs', '下行用户平均吞吐', 'Mbps', 'higher', 52.3, 8.7, 20, 'lt'],
  ['drop', '高掉线', '住宅区晚间掉线', '华为', 'LTE', 'B3', '异常释放与无线链路', 'RlfTimer', 'RecoveryTimer', 'AggressiveRelease', '异常释放率', '%', 'lower', 0.4, 4.8, 2, 'gt'],
  ['alarm', '告警影响', '交通枢纽间歇退服', '中兴', 'NR', 'n78', '设备告警与可用性', 'RecoveryGuard', 'AvailabilityGuard', 'RestartThreshold', '小区可用率', '%', 'higher', 99.9, 86.2, 98, 'lt'],
].map(row => { const [id, issue, title, vendor, system, band, cause, primary, alternate, risky, metric, unit, good, normal, abnormal, threshold, operator] = row
  return { id, issue, title, vendor, system, band, cause, primary, alternate, risky, metric, unit, good, normal, abnormal, threshold, operator } })
const baselineCutoff = '2026-11-01T00:00:00+08:00'
const decisionAt = '2026-11-09T00:00:00+08:00'
const feedbackAt = '2026-11-10T00:00:00+08:00'
const learningAt = '2026-11-19T00:00:00+08:00'
const synthetic = { synthetic: true, dataset: 'harness_demo_synthetic_v1', generator: 'build-wireless-demo.mjs', seed: 20261109 }
const parameterNames = {
  AccessMargin: '接入边界偏置', Msg3Retries: 'Msg3 重传次数', AdmissionExpansion: '接入范围扩张',
  HandoverMargin: '切换迟滞', TimeToTrigger: '切换触发时长', AggressiveHandover: '激进切换偏置',
  ElectricalTilt: '电下倾编码', CoverageOffset: '覆盖偏置', PowerExpansion: '覆盖功率扩张',
  InterferenceControl: '上行干扰抑制', PuschOffset: 'PUSCH 偏置', WidebandBoost: '宽带功率增强',
  LoadBalanceOffset: '负荷均衡偏置', SchedulerWeight: '调度权重', AdmissionLimit: '接纳上限',
  SchedulerWindow: '调度窗口', LinkAdaptation: '链路自适应偏置', ConservativeMcs: '保守调制编码偏置',
  RlfTimer: '无线链路失败计时器', RecoveryTimer: '恢复计时器', AggressiveRelease: '激进释放门限',
  RecoveryGuard: '恢复保护门限', AvailabilityGuard: '可用性保护门限', RestartThreshold: '重启触发门限',
}
const contexts = {
  access: ['园区下班与餐饮客流在 18:00—22:00 汇聚，用户报告扫码与语音发起等待。异常前两天同一人群接入表现稳定。', '区分接入资源不足、随机接入重传异常、覆盖边缘以及设备告警；先看失败阶段分布，不能只凭接通率下降认定参数不当。'],
  handover: ['交通沿线连续三个小区覆盖同一移动路线，投诉集中在进站与出站过程，驻留静止用户影响较小。', '区分邻区缺失、切换触发不合适、覆盖断点和目标侧资源问题；结合准备/执行阶段失败与移动方向核对。'],
  coverage: ['新建住宅与城郊道路的边缘采样变差，投诉人群在室外和楼宇边缘分布，邻近对照小区没有同步恶化。', '比较弱覆盖、重叠覆盖、遮挡变化和采样人群变化；优化覆盖要同时观察干扰与切换保护指标。'],
  interference: ['工业园生产时段上行质量恶化，夜间部分恢复；问题与下行业务负荷不完全同步。', '比较外部干扰、同频干扰、设备异常和负荷增长，按频域、时段与空间范围补证，不能用单点噪声直接定位干扰源。'],
  capacity: ['商圈客流增大后视频与下载变慢，忙时 PRB 与活跃用户升高，对照小区用户吞吐基本稳定。', '同时考虑资源拥塞、质量下降、调度限制与业务组成变化；吞吐按用户平均统计，不能与小区总吞吐混算。'],
  throughput: ['校园晚间视频体验下降，主要出现在活动区和宿舍交界，吞吐下降与业务高峰部分重叠。', '并列核对负荷、SINR/MCS、覆盖、回传和应用因素，不能把低速率统一归因为容量不足。'],
  drop: ['住宅区晚间通话和数据会话异常释放增加，部分用户移动时掉线，存在恢复后再次掉线的描述。', '比较覆盖、切换、无线链路计时、设备告警和异常释放原因；保护接入与移动性，不能只降低释放触发频率。'],
  alarm: ['交通枢纽小区出现间歇退服，自动恢复后仍有短时不可用，用户影响集中在告警活动窗口。', '先对齐告警与可用率、恢复事件，再区分设备、供电、传输和维护影响；时间对应不等于已证实故障因果。'],
}
const iso = ms => new Date(ms).toISOString()
const window = (start, hours = 1) => ({ start: iso(start), end: iso(start + hours * 3600000) })
const round = value => Math.round(value * 1000) / 1000
const traces = []
for (const [index, family] of families.entries()) {
  for (let n = 0; n < 24; n++) {
    if (n === 23 && index % 2 === 0) continue
    const trace_id = `synthetic-${family.id}-${String(n + 1).padStart(3, '0')}`
    const type = n < 9 ? 'primary' : n < 15 ? 'alternate' : n < 18 ? 'risky' : n < 20 ? 'bundle' : n === 20 ? 'failed' : n === 21 ? 'unknown' : n === 22 ? 'constraint_failed' : 'constraint_unknown'
    const noEvaluation = ['failed', 'unknown', 'constraint_failed', 'constraint_unknown'].includes(type)
    const failedExecution = ['failed', 'constraint_failed'].includes(type)
    const passed = type === 'primary' ? n < 8 : type === 'alternate' ? n < 14 : type === 'bundle'
    const time = Date.parse('2026-09-01T09:00:00+08:00') + (index * 2 + n) * 86400000
    const names = type === 'bundle' ? [family.primary, family.alternate] : [type === 'alternate' ? family.alternate : type === 'risky' ? family.risky : family.primary]
    const actions = names.map((name, i) => ({
      action_id: `a_${i}`, exec_id: `${trace_id}-exec`, param_exec_id: `${trace_id}-${i}`,
      param_object: 'Demo', param_en_name: `Demo.${name}`, param_cn_name: parameterNames[name] || name,
      before_value: '40', after_value: type === 'risky' ? '65' : '45', value_rule: '[0..100];step 1',
      scheme_id: type.startsWith('constraint_') ? 'policy-config-conflict' : `policy-${family.id}-${type === 'failed' || type === 'unknown' ? 'primary' : type}`,
      scheme_group: family.cause, root_cause_l1: family.issue, root_cause_l2: family.cause,
      root_cause_key: `${family.issue} / ${family.cause}`, param_kind: family.issue,
      scheme_desc: '[0..100];step 1', verbal_desc: '候选动作以参数约束表为依据，适用条件需结合当前证据核对。',
      issued_state: '下发成功', issued_at: iso(time),
      exec_state: failedExecution ? 'exec_failed' : 'exec_success', exec_at: iso(time + 300000),
      exec_failure_reason: failedExecution ? '参数取值与同组配置互斥，业务校验拒绝执行' : null,
      rollback_state: type === 'risky' && !passed ? 'rolled_back' : null,
      rollback_at: type === 'risky' && !passed ? iso(time + 7200000) : null,
      long_eval_result: noEvaluation ? 'long_eval_unknown' : passed ? 'long_eval_pass' : 'long_eval_fail',
      raw_row_index: traces.length,
    }))
    traces.push({ trace_id, source: { ...synthetic, ingested_at: iso(time + 8 * 86400000), row_offsets: [traces.length] },
      ticket: { id: trace_id, issued_at: iso(time), state: '闭环', primary_issue_type: family.issue,
        vendor: family.vendor, system: family.system, band: family.band, region: '城区',
        cell_id: `SIM-H-${index}-${n}`, cell_name: `${family.title}${n + 1}`, cover_area: family.title, is_indoor: '室外' }, actions,
      aggregate: { action_count: actions.length, ticket_outcome: failedExecution ? 'exec_failed' : noEvaluation ? 'long_eval_unknown' : passed ? 'long_eval_pass' : 'long_eval_fail' } })
  }
}
function metric(family, object_id, time_window, value, suffix = '') {
  return { id: `${object_id}-${family.metric}-${time_window.start}${suffix}`, kind: 'kpi', object_id, time_window,
    metric: family.metric, value: round(value), unit: family.unit, definition: `${family.metric}，按小区、固定人群与等长窗口统计`,
    cohort: 'synthetic-fixed-cohort', sample_count: 2400, good_direction: family.good,
    source_ref: `synthetic://demo/${object_id}/metrics${suffix}`,
    threshold: { operator: family.operator, value: family.threshold, source_ref: '业务评价规则 v1' } }
}
const scenarios = [], observations = [], feedback = {}
const variants = [
  ...families.map(f => [f, 'standard']),
  [families[4], 'quality_conflict'], [families[1], 'window_mismatch'],
  [families[0], 'missing_snapshot'], [families[2], 'cross_vendor'],
]
for (const [index, [family, variant]] of variants.entries()) {
  const scenario_id = `demo-${family.id}${variant === 'standard' ? '' : `-${variant.replaceAll('_', '-')}`}`
  const object_id = `SIM-CELL-${String(index + 1).padStart(3, '0')}`
  const time_window = window(Date.parse(decisionAt) - 3 * 3600000)
  const current = metric(family, object_id, time_window, family.abnormal)
  const quality = { ...current, id: `${object_id}-SINR`, metric: '下行 SINR', unit: 'dB', value: variant === 'quality_conflict' ? -2.5 : 15.2,
    definition: '固定采样人群下行 SINR 均值', good_direction: 'higher', threshold: { operator: 'lt', value: 3, source_ref: '业务评价规则 v1' } }
  const load = { ...current, id: `${object_id}-PRB`, metric: '下行 PRB 利用率', unit: '%', value: ['capacity', 'throughput'].includes(family.id) ? 96.3 : 57.6,
    definition: '小区下行已使用 PRB / 可用 PRB，按小时平均', good_direction: 'lower', threshold: { operator: 'gt', value: 90, source_ref: '业务评价规则 v1' } }
  const users = { ...current, id: `${object_id}-users`, metric: '活跃用户数', unit: '人', value: family.id === 'capacity' ? 328 : 91,
    definition: '小区小时内活跃用户去重数', good_direction: 'lower' }
  delete users.threshold
  const rsrp = { ...quality, id: `${object_id}-RSRP`, kind: 'mr', metric: 'RSRP 第十分位', unit: 'dBm',
    value: family.id === 'coverage' ? -118 : -96, definition: '固定区域、固定终端人群 RSRP 第十分位',
    threshold: { operator: 'lt', value: -110, source_ref: '业务评价规则 v1' } }
  const stall = { ...quality, id: `${object_id}-stall`, kind: 'kqi', metric: '视频卡顿会话占比', unit: '%',
    value: ['throughput', 'capacity'].includes(family.id) ? 18.7 : 3.2, good_direction: 'lower', definition: '固定视频业务人群卡顿会话数 / 总会话数',
    threshold: { operator: 'gt', value: 8, source_ref: '业务评价规则 v1' } }
  const fact = (kind, value) => ({ id: `${object_id}-${kind}`, kind, object_id, time_window, value, source_ref: `synthetic://demo/${scenario_id}/${kind}` })
  const evidence = [current, quality, load, users, rsrp, stall,
    fact('alarm', family.id === 'alarm' ? '射频链路告警覆盖异常窗口；维护变更记录待核对' : '告警清单未见同期重大告警；仅限本次清单范围'),
    fact('neighbor', family.id === 'handover' ? '邻区关系已配置；个别目标小区切换执行失败增加，需核对目标侧资源' : '一阶邻区清单完整；未以此证明配置正确'),
    fact('context', contexts[family.id][0])]
  if (variant === 'window_mismatch') evidence.push({ ...current, id: `${object_id}-bad-window`, time_window: window(Date.parse(decisionAt) - 6 * 3600000), value: 99 })
  const peers = []
  for (let hour = 0; hour < 72; hour++) {
    const start = Date.parse(decisionAt) - (72 - hour) * 3600000
    const localHour = new Date(start + 8 * 3600000).getUTCHours()
    const busy = localHour >= 18 && localHour <= 22
    const degradation = hour >= 48 ? (busy ? 1 : 0.45) : 0
    const noise = Math.sin((hour + index) * 1.7) * Math.abs(family.normal - family.abnormal) * 0.025
    const isCurrentWindow = iso(start) === time_window.start
    const value = isCurrentWindow ? family.abnormal : family.normal + (family.abnormal - family.normal) * degradation + noise
    observations.push(metric(family, object_id, window(start), Math.max(0, family.unit === '%' ? Math.min(100, value) : value)))
    const busyLoad = ['capacity', 'throughput'].includes(family.id) ? 48 + (busy ? 25 : 0) + degradation * 22 : 49 + (busy ? 8 : 0) + degradation * 3
    observations.push({ ...load, id: `${object_id}-load-${hour}`, time_window: window(start), value: isCurrentWindow ? load.value : round(busyLoad) })
    observations.push({ ...quality, id: `${object_id}-quality-${hour}`, time_window: window(start), value: isCurrentWindow ? quality.value : round(15 + Math.sin(hour) * 2 - (variant === 'quality_conflict' ? degradation * 18 : 0)) })
    const peerValue = family.normal + noise * 0.5
    const peer = metric(family, `${object_id}-PEER`, window(start), family.unit === '%' ? Math.min(100, Math.max(0, peerValue)) : peerValue, '/peer')
    observations.push(peer)
    if (hour === 71) peers.push(peer)
  }
  const snapshots = Object.fromEntries([family.primary, family.alternate, family.risky].map(name => [`Demo.${name}`, {
    parameter: `Demo.${name}`, current_value: 55, min: 0, max: 100, step: 1, step_base: 0,
    unit: '编码值', source_ref: `synthetic://demo/${scenario_id}/snapshot`, constraint_source: '参数约束表 v1（0..100，步长 1）', description: parameterNames[name] }]))
  if (variant === 'missing_snapshot') for (const s of Object.values(snapshots)) delete s.current_value
  const variantNames = { quality_conflict: ' · 负荷与质量反证', window_mismatch: ' · 跨时窗脏数据', missing_snapshot: ' · 缺少当前参数', cross_vendor: ' · 厂家不匹配' }
  const vendor = variant === 'cross_vendor' ? '中兴' : family.vendor
  const raw_text = `${family.title}${variantNames[variant] || ''}。${object_id}，${vendor} ${family.system} ${family.band}，最近忙时${family.issue}。${contexts[family.id][0]}${contexts[family.id][1]}请核对同口径观测，比较历史支持与反证，提出可验证的根因假设和候选方案；不要把历史成功率当作本单成功概率。`
  scenarios.push({ scenario_id, title: family.title + (variantNames[variant] || ''), issue_type: family.issue,
    synthetic: true, variant, decision_at: decisionAt, learning_at: learningAt,
    intake: { external_id: scenario_id, raw_text, problem: family.issue, object_id, vendor, system: family.system,
      band: family.band, region: '城区', software_version: 'SIM-v1', time_window, source_ref: `synthetic://demo/${scenario_id}` },
    observations: evidence, peer_observations: peers, snapshots,
    investigation_questions: [contexts[family.id][1], '异常是持续存在还是集中在特定时段？对照小区是否同步变化？', '哪些证据支持或反对历史根因，哪些当前数据仍有缺口？', '候选历史样本、反证与当前参数范围是否足以给出具体目标值？'],
    topology: { scene: contexts[family.id][0], serving_cell: object_id, peer_cell: `${object_id}-PEER`, peer_scope: '同制式、同业务人群、同时间窗口对照；用于描述性比较' },
    context: { issue_type: family.issue, vendor, system: family.system, band: family.band, region: '城区' },
    root_clues: { root_cause_key: `${family.issue} / ${family.cause}`, root_cause_l2: family.cause },
    evaluation_rule: { min_observation_hours: 24, required_metrics: [family.metric], min_absolute_improvement: family.unit === 'Mbps' ? 5 : 1,
      source_ref: `synthetic://demo/${scenario_id}/evaluation-policy-v1` },
    demo_goals: variant === 'standard' ? ['时序异常与同群对照', '历史支持与反证', '候选排序和当前值适配', '反馈评价与记忆增量'] : [variantNames[variant].slice(3), '缺口与复核路径'],
  })
  const before = metric(family, object_id, window(Date.parse(feedbackAt) - 24 * 3600000, 24), family.abnormal)
  feedback[scenario_id] = { synthetic: true, executed_at: feedbackAt, evaluation_visible_at: '2026-11-18T00:00:00+08:00',
    before: [before], by_parameter: Object.fromEntries([family.primary, family.alternate, family.risky].map((name, j) => {
      const adverse = j === 2 || (variant === 'quality_conflict' && j === 0)
      const improvement = adverse ? -Math.abs(family.abnormal - family.normal) * 0.3 : Math.abs(family.abnormal - family.normal) * (j === 0 ? 0.72 : 0.5)
      const next = family.abnormal + (family.good === 'higher' ? improvement : -improvement)
      return [`Demo.${name}`, { after: [metric(family, object_id, window(Date.parse(feedbackAt), 24), next)],
        long_eval_result: adverse ? 'long_eval_fail' : 'long_eval_pass',
        long_eval_source_ref: `synthetic://demo/${scenario_id}/${name}/declared-long-evaluation`,
        note: adverse ? '效果未达到评价判据；需复核当前条件与历史经验的适用差异' : '效果达到评价判据' }]
    })) }
}
const write = (name, value) => fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
write('history.jsonl', lines(traces)); write('observations.jsonl', lines(observations))
write('scenarios.json', scenarios); write('feedback.private.json', feedback)
const files = Object.fromEntries(['history.jsonl', 'observations.jsonl', 'scenarios.json', 'feedback.private.json'].map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]))
write('manifest.json', { ...synthetic, source_commit: 'e734ac032a7dc671878d05cd40d2b31b68d156fc',
  baseline_cutoff: baselineCutoff, decision_at: decisionAt, learning_at: learningAt,
  counts: { history_traces: traces.length, historical_actions: traces.reduce((n, t) => n + t.actions.length, 0),
    scenarios: scenarios.length, time_series_observations: observations.length, issue_families: families.length },
  files, boundaries: ['全部为人工合成；不证明现网收益', '参数和范围属于合成样本约束', '反馈工具在方案冻结后才揭示结果', '未连接网管、校准 gate 或线上发布'] })
const cards = ['# 网优场景数据卡', '', '由 `node backend/dev/build-wireless-demo.mjs` 确定性生成。数据来源：所有对象、指标、参数、阈值和反馈为人工构造的合成样本。每个场景有 72 个小时窗口、48 小时基线、24 小时近期数据，以及同窗口对照小区；输入中的阈值来自本数据集的业务评价规则。', '',
  ...scenarios.flatMap(scene => [
    `## ${scene.title}`, '', `场景 ID：\`${scene.scenario_id}\`。对象：\`${scene.intake.object_id}\`；${scene.intake.vendor} / ${scene.intake.system} / ${scene.intake.band}；决策前时点：${scene.decision_at}。`, '',
    scene.intake.raw_text, '', '| 当前观测 | 值 | 单位 / 口径 |', '| --- | --- | --- |',
    ...scene.observations.map(row => `| ${row.metric || row.kind} | ${row.value} | ${row.unit || '场景事实'}${row.definition ? `；${row.definition}` : ''} |`), '',
    '**分析重点**', '', ...scene.investigation_questions.map(question => `- ${question}`), '',
    '**可用输入**', '', `- 时序对象：\`${scene.intake.object_id}\` 与 \`${scene.topology.peer_cell}\`；每个对象的指标、定义、时间窗、样本数和来源单独保留。`,
    '- 当前参数快照：' + Object.values(scene.snapshots).map(s => `\`${s.parameter}\` 当前 ${s.current_value ?? '未知'}，范围 ${s.min}—${s.max}，步长 ${s.step}`).join('；') + '。这些范围采用编码值。',
    `- 评价判据：观察 ${scene.evaluation_rule.min_observation_hours} 小时，比较 ${scene.evaluation_rule.required_metrics.join('、')}，改善量至少 ${scene.evaluation_rule.min_absolute_improvement} 个原单位；百分率使用百分点。`,
    '- 决策前不提供执行后结果；只有冻结方案后，反馈工具才读取所选候选的结果。', '',
    '**可直接使用的问法**', '', `> 请分析「${scene.title}」：对照时序与邻近小区，核对当前证据，比较历史候选和反证，给出方案条件与验证方法，暂不读取执行后反馈。`, '',
  ])]
const docsDir = path.resolve(root, '../../../../../docs/wireless-network-optimization')
fs.mkdirSync(docsDir, { recursive: true })
fs.writeFileSync(path.join(docsDir, 'demo-scenario-cards.md'), cards.join('\n').trimEnd() + '\n')
console.log(JSON.stringify({ output: root, traces: traces.length, scenarios: scenarios.length, observations: observations.length }))
