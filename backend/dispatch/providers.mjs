import { metrics } from './catalog.mjs';
import { createExtendedHandlers } from './extended-providers.mjs';

const round = value => Number(value.toFixed(2));
const source = '内存演示数据';
const output = (summary, data, sources = [source]) => ({ summary, data, sources });
const fail = message => { throw Object.assign(new Error(message), { status: 422 }); };
const metricIds = new Set(metrics.map(metric => metric.id));

export function resolvePeriod(period = {}, now = new Date()) {
  let start, end;
  const localDay = Math.floor((+now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
  if (period.kind === 'yesterday') { start = localDay - 86400000; end = localDay; }
  else if (period.kind === 'today') { start = localDay; end = +now; }
  else if (period.kind === 'custom') {
    const zoned = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
    if (!zoned(period.start) || !zoned(period.end)) fail('自定义时间需要带时区的起止时间');
    start = Date.parse(period.start); end = Date.parse(period.end);
  } else {
    const days = period.days ?? 7;
    if (!Number.isInteger(days) || days < 1 || days > 14) fail('演示数据支持最近 1 至 14 天');
    end = +now; start = end - days * 86400000;
  }
  if (!(start < end) || end - start > 14 * 86400000) fail('时间窗口无效或超过 14 天');
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    label: period.kind === 'yesterday' ? '昨天' : period.kind === 'today' ? '今天' : period.kind === 'custom' ? '指定时间' : `近 ${period.days ?? 7} 天` };
}

export function createProviderHandlers(store) {
  const selectedCells = context => {
    const cells = store.scopeCells(context.scope);
    if (!cells.length) fail('没有匹配的小区，请明确网格或小区');
    return cells;
  };
  const rowsFor = (table, context) => {
    const ids = selectedCells(context).map(cell => cell.id);
    return store.db.prepare(`SELECT * FROM ${table} WHERE cell_id IN (${ids.map(() => '?').join(',')}) AND at >= ? AND at < ? ORDER BY at DESC`)
      .all(...ids, context.window.start, context.window.end);
  };
  const find = (inputs, id) => inputs.findLast(item => item.capability_id === id)?.result?.data;
  const metricData = context => {
    const cells = selectedCells(context), ids = cells.map(cell => cell.id);
    const selected = context.metric_ids?.length ? context.metric_ids : metrics.map(item => item.id);
    if (selected.some(id => !metricIds.has(id))) fail('存在未接入的指标');
    const args = [...ids, ...selected, context.window.start, context.window.end];
    const where = `cell_id IN (${ids.map(() => '?').join(',')}) AND metric IN (${selected.map(() => '?').join(',')}) AND at >= ? AND at < ?`;
    const rows = store.db.prepare(`SELECT cell_id,metric,avg(value) value,min(value) minimum,max(value) maximum,count(*) samples FROM metrics WHERE ${where} GROUP BY cell_id,metric`).all(...args);
    if (!rows.length) fail('该时间窗口没有指标观测数据');
    const seriesRows = store.db.prepare(`SELECT at,metric,avg(value) value FROM metrics WHERE ${where} GROUP BY at,metric ORDER BY at`).all(...args);
    const series = new Map();
    for (const row of seriesRows) {
      if (!series.has(row.at)) series.set(row.at, { at: row.at, values: {} });
      series.get(row.at).values[row.metric] = round(row.value);
    }
    const samples = rows.reduce((sum, row) => sum + row.samples, 0);
    return { window: context.window, metrics: metrics.filter(item => selected.includes(item.id)), sampleCount: samples,
      series: [...series.values()], cells: cells.map(cell => ({ id: cell.id, name: cell.name, grid_id: cell.grid_id, site_id: cell.site_id,
        lat: cell.lat, lon: cell.lon, metrics: Object.fromEntries(rows.filter(row => row.cell_id === cell.id).map(row => [row.metric, { value: round(row.value), min: round(row.minimum), max: round(row.maximum), samples: row.samples }])) })) };
  };
  const allMetricData = context => metricData({ ...context, metric_ids: [] });
  const diagnose = data => data.cells.map(cell => {
    const m = cell.metrics, findings = [];
    if (m.prb?.value > 75 && m.dl_rate?.value < 20) findings.push({ type: 'capacity', label: '容量受限',
      evidence: [`PRB ${m.prb.value}% > 75%`, `下行速率 ${m.dl_rate.value} Mbps < 20 Mbps`], rule: 'KN-001' });
    if (m.rsrp?.value < -110) findings.push({ type: 'coverage', label: '弱覆盖', evidence: [`RSRP ${m.rsrp.value} dBm < -110 dBm`], rule: 'KN-002' });
    if (m.handover_success?.value < 95) findings.push({ type: 'handover', label: '切换质差', evidence: [`切换成功率 ${m.handover_success.value}% < 95%`], rule: 'KN-003' });
    if (m.sinr?.value < 7 && m.ul_interference?.value > -100) findings.push({ type: 'interference', label: '上行干扰', evidence: [`SINR ${m.sinr.value} dB < 7 dB`, `上行干扰噪声 ${m.ul_interference.value} dBm > -100 dBm`], rule: 'KN-007' });
    if (m.rrc_success?.value < 98 && m.rsrp?.value >= -110) findings.push({ type: 'access', label: '接通质差', evidence: [`接通率 ${m.rrc_success.value}% < 98%`, '覆盖信号未触发弱覆盖判据'], rule: 'KN-008' });
    return { cell_id: cell.id, cell_name: cell.name, site_id: cell.site_id, findings };
  });

  return {
    'data.metrics': async ({ context }, progress) => {
      const data = metricData(context);
      progress(`已读取 ${data.cells.length} 个小区、${data.sampleCount} 条指标观测`);
      return output(`已查询 ${data.cells.length} 个小区的 ${data.metrics.length} 项指标`, data);
    },
    'data.cell_info': async ({ context }) => output('已读取当前工参与参数快照', { cells: selectedCells(context) }),
    'data.alarms': async ({ context }) => {
      const alarms = rowsFor('alarms', context);
      return output(`找到 ${alarms.length} 条告警记录`, { alarms });
    },
    'knowledge.search': async ({ context }) => {
      const query = context.query || '';
      const terms = query.match(/PRB|RSRP|SINR|容量|高负荷|速率|下载|视频|覆盖|信号|室内|切换|掉话|邻区|语音|投诉|套餐|限速|终端|评估|效果|优化|区域|协同|网格/gi) || [];
      const documents = store.db.prepare('SELECT * FROM knowledge').all().map(row => ({ ...row,
        score: terms.filter(term => `${row.title} ${row.text} ${row.tags}`.toLowerCase().includes(term.toLowerCase())).length }))
        .filter(row => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
      return output(documents.length ? `检索到 ${documents.length} 条专业知识` : '演示知识库未命中，未使用其他资料补写结论', { documents }, documents.map(row => `${row.id} · ${row.title}（演示知识）`));
    },
    'history.search': async ({ context }) => {
      const query = context.query || '';
      const problem = /切换|掉话|邻区/.test(query) ? 'handover' : /覆盖|信号|室内/.test(query) ? 'coverage' : /容量|负荷|速率|卡顿/.test(query) ? 'capacity' : null;
      const cases = problem ? store.db.prepare('SELECT * FROM cases WHERE problem=?').all(problem) : store.db.prepare('SELECT * FROM cases').all();
      return output(`召回 ${cases.length} 个演示案例`, { cases }, cases.map(row => `${row.id} · 演示案例`));
    },
    'grid.resolve': async ({ context }) => {
      const cells = selectedCells(context), ids = new Set(cells.map(cell => cell.grid_id));
      const grids = store.grids().filter(grid => ids.has(grid.id));
      return output(`已定位 ${grids.map(grid => grid.name).join('、')}，关联 ${cells.length} 个小区`, { grids, cells });
    },
    'grid.portrait': async ({ context }) => {
      const data = allMetricData(context), complaints = rowsFor('complaints', context), findings = diagnose(data);
      return output(`${data.cells.length} 个小区中 ${findings.filter(row => row.findings.length).length} 个存在质差线索，关联 ${complaints.length} 张投诉`,
        { ...data, findings, complaintCount: complaints.length, cells: data.cells.map(cell => ({ ...cell, complaints: complaints.filter(row => row.cell_id === cell.id).length })) });
    },
    'complaint.extract': async ({ context }) => {
      const complaints = rowsFor('complaints', context);
      return output(`已解析 ${complaints.length} 张投诉的诉求、位置与业务`, { count: complaints.length, complaints,
        phenomena: [...new Set(complaints.map(row => row.phenomenon))] });
    },
    'complaint.locate': async ({ context }) => {
      const complaints = rowsFor('complaints', context), cells = selectedCells(context);
      return output(`已将 ${complaints.length} 张投诉关联到 ${cells.length} 个驻留小区`, { locations: complaints.map(row => {
        const cell = cells.find(item => item.id === row.cell_id);
        return { complaint_id: row.id, address: row.address, cell_id: cell.id, lat: cell.lat, lon: cell.lon, basis: '演示地址与驻留记录匹配' };
      }) });
    },
    'complaint.b_domain': async ({ context }) => {
      const complaints = rowsFor('complaints', context), nonWireless = complaints.filter(row => row.b_reason);
      return output(`已识别 ${nonWireless.length} 张非无线投诉，${complaints.length - nonWireless.length} 张进入网络侧分析`,
        { total: complaints.length, nonWireless, wireless: complaints.filter(row => !row.b_reason), excluded: nonWireless.length });
    },
    'complaint.correlate': async ({ context, upstream }) => {
      const data = allMetricData(context), complaints = rowsFor('complaints', context);
      const scoped = find(upstream, 'complaint.b_domain')?.wireless || complaints.filter(row => !row.b_reason);
      const rows = diagnose(data).map(row => ({ ...row, complaints: scoped.filter(item => item.cell_id === row.cell_id).length }));
      return output(`${scoped.length} 张网络侧投诉已关联指标，${rows.filter(row => row.findings.length).length} 个小区存在匹配的劣化线索`,
        { cells: rows, wirelessCount: scoped.length, excludedCount: complaints.length - scoped.length, basis: '同对象、同时间窗口的关联分析，未证明因果' });
    },
    'region.common_cause': async ({ context }) => {
      const data = allMetricData(context), findings = diagnose(data), groups = [];
      for (const [type, label] of [['capacity', '容量受限'], ['coverage', '弱覆盖'], ['handover', '切换质差']]) {
        const affected = findings.filter(row => row.findings.some(item => item.type === type));
        if (affected.length) groups.push({ type, label, common: affected.length > 1, cell_ids: affected.map(row => row.cell_id), evidence: affected.flatMap(row => row.findings.filter(item => item.type === type).flatMap(item => item.evidence)) });
      }
      return output(groups.some(row => row.common) ? '识别到跨小区共性问题，同时保留局部质差问题' : '已完成区域对比，当前以局部问题为主',
        { groups, findings, affectedCells: findings.filter(row => row.findings.length).length });
    },
    'optimization.evidence': async ({ context }) => {
      const data = allMetricData(context), alarms = rowsFor('alarms', context);
      return output(`已对齐 ${data.cells.length} 个小区的指标、配置及 ${alarms.length} 条告警`,
        { window: context.window, objects: data.cells.map(cell => cell.id), observations: data.sampleCount, alarms,
          evidence: data.cells.flatMap(cell => Object.entries(cell.metrics).map(([metric, row]) => ({ id: `${cell.id}:${metric}`, cell_id: cell.id, metric, value: row.value, samples: row.samples }))) });
    },
    'optimization.diagnose': async ({ context }) => {
      const findings = diagnose(allMetricData(context)), affected = findings.filter(row => row.findings.length);
      return output(`形成 ${affected.length} 个小区的根因假设：${[...new Set(affected.flatMap(row => row.findings.map(item => item.label)))].join('、') || '当前未见演示判据下的异常'}`,
        { findings, ruleSource: ['KN-001', 'KN-002', 'KN-003'], certainty: '基于演示规则的根因假设' });
    },
    'optimization.plan': async ({ context, upstream }) => {
      const findings = find(upstream, 'optimization.diagnose')?.findings;
      if (!findings) fail('缺少根因分析结果，无法生成方案');
      const cells = selectedCells(context), actions = [];
      for (const finding of findings) for (const issue of finding.findings) {
        const cell = cells.find(item => item.id === finding.cell_id);
        const parameter = { capacity: 'load_balance_trigger', coverage: 'electrical_tilt', handover: 'handover_offset', interference: 'ul_power_control', access: 'access_preamble' }[issue.type];
        const current = cell.parameters[parameter];
        actions.push({ id: `ACT-${actions.length + 1}`, cell_id: cell.id, cell_name: cell.name, issue: issue.type, issueLabel: issue.label,
          parameter, label: current.label, before: current.value, target: { capacity: 65, coverage: 6, handover: 2, interference: -1, access: 48 }[issue.type], unit: current.unit,
          constraints: { min: current.min, max: current.max, step: current.step }, reason: issue.evidence.join('；'),
          rollback: current.value, fieldCheck: issue.type === 'coverage', mode: 'simulation' });
      }
      return output(actions.length ? `生成 ${actions.length} 项模拟优化措施，覆盖 ${new Set(actions.map(row => row.cell_id)).size} 个小区` : '当前没有需要调参的异常，未生成变更动作',
        { actions, evaluationRule: 'KN-005', protection: '演示参数范围与步长校验；执行后核验原问题和保护指标', mode: 'simulation' });
    },
    'region.coordinate': async ({ context, upstream }) => {
      const plan = find(upstream, 'optimization.plan');
      if (!plan) fail('缺少待检查的方案');
      const cells = selectedCells(context), keys = new Set(), conflicts = [];
      for (const action of plan.actions) {
        const key = `${action.cell_id}:${action.parameter}`;
        if (keys.has(key)) conflicts.push(key);
        keys.add(key);
      }
      return output(conflicts.length ? `检测到 ${conflicts.length} 项重复参数冲突` : '方案无重复参数冲突，已标记同站与邻区保护对象',
        { passed: !conflicts.length, conflicts, protectedCells: cells.map(cell => ({ id: cell.id, site_id: cell.site_id })), mode: 'simulation' });
    },
    'optimization.validate': async ({ context, upstream }) => {
      const plan = find(upstream, 'optimization.plan');
      if (!plan) fail('没有可校验的方案，请先制定方案');
      const cells = selectedCells(context);
      const actions = find(upstream, 'decision.conflicts')?.actions || find(upstream, 'decision.rule_assess')?.actions || plan.actions;
      const checks = actions.map(action => {
        const parameter = cells.find(cell => cell.id === action.cell_id)?.parameters[action.parameter];
        const reasons = [];
        if (!parameter) reasons.push('当前参数不存在');
        else {
          if (parameter.value !== action.before) reasons.push('方案前值与当前快照不一致');
          if (!Number.isFinite(action.target) || action.target < parameter.min || action.target > parameter.max) reasons.push('目标值超出范围');
          if (Math.abs((action.target - parameter.min) / parameter.step - Math.round((action.target - parameter.min) / parameter.step)) > 1e-8) reasons.push('目标值不满足步长');
          if (action.rollback !== parameter.value) reasons.push('回退值不匹配');
        }
        return { action_id: action.id, passed: !reasons.length, reasons };
      });
      const coordinated = find(upstream, 'region.coordinate');
      const passed = checks.every(row => row.passed) && coordinated?.passed !== false;
      return output(passed ? `${checks.length} 项措施通过演示参数约束校验` : '方案约束校验未通过，禁止模拟执行', { passed, checks, actions, mode: 'simulation' });
    },
    'optimization.execute': async ({ context, upstream }, progress) => {
      const checked = find(upstream, 'optimization.validate');
      if (!checked?.passed) fail('没有通过校验的方案，未执行任何参数变更');
      if (!checked.actions.length) fail('没有通过校验的参数措施，未执行模拟调参');
      const before = allMetricData(context).cells, after = structuredClone(before), executedAt = new Date().toISOString();
      const actions = [];
      for (const action of checked.actions) {
        const cell = after.find(row => row.id === action.cell_id);
        if (!cell) fail('方案对象与当前执行范围不一致');
        if (action.issue === 'capacity') {
          cell.metrics.prb.value = round(Math.min(70, cell.metrics.prb.value * .74));
          cell.metrics.dl_rate.value = round(Math.max(26, cell.metrics.dl_rate.value * 2.3));
        } else if (action.issue === 'handover') cell.metrics.handover_success.value = 98.7;
        else if (action.issue === 'interference') { cell.metrics.sinr.value = 12; cell.metrics.ul_interference.value = -108; }
        else if (action.issue === 'access') cell.metrics.rrc_success.value = 99.2;
        // Coverage retains the observed fault: a remote tilt change cannot remove a feeder fault.
        actions.push({ ...action, state: 'executed', executedAt, actualValue: action.target });
        progress(`${action.cell_id}：${action.label} ${action.before} → ${action.target}${action.unit}`);
        await new Promise(resolve => setImmediate(resolve));
      }
      return output(`模拟执行器已应用 ${actions.length} 项变更并生成独立前后观测快照`,
        { executionId: store.id('EXE'), mode: 'simulation', executedAt, actions, before, after,
          observationWindow: { kind: 'simulated_snapshot', source: '内存模拟执行器', mature: false },
          note: '数值为演示模拟快照，非现网观测或真实观察周期' });
    },
    'optimization.evaluate': async ({ upstream }) => {
      const execution = find(upstream, 'optimization.rollback') || find(upstream, 'optimization.execute');
      if (!execution?.executionId) fail('未找到实际的模拟执行回执，不能生成效果结果');
      const comparisons = execution.actions.map(action => {
        const before = execution.before.find(row => row.id === action.cell_id).metrics;
        const after = execution.after.find(row => row.id === action.cell_id).metrics;
        const metric = { capacity: 'dl_rate', coverage: 'rsrp', handover: 'handover_success', interference: 'sinr', access: 'rrc_success' }[action.issue];
        const descriptor = metrics.find(row => row.id === metric);
        const passed = action.issue === 'capacity' ? after.prb.value <= 75 && after.dl_rate.value >= 20
          : action.issue === 'coverage' ? after.rsrp.value >= -110 : action.issue === 'handover' ? after.handover_success.value >= 95 : action.issue === 'interference' ? after.sinr.value >= 7 && after.ul_interference.value <= -100 : after.rrc_success.value >= 98;
        return { cell_id: action.cell_id, cell_name: action.cell_name, issue: action.issueLabel, metric, metricName: descriptor.name,
          unit: descriptor.unit, before: before[metric].value, after: after[metric].value, delta: round(after[metric].value - before[metric].value), passed,
          nextAction: passed ? '继续观察保护指标' : action.issue === 'coverage' ? '关联天馈告警，转现场排障并持续跟踪' : '复核当前证据与方案，继续观察并按需转人工' };
      });
      const passed = comparisons.filter(row => row.passed).length, pending = comparisons.length - passed;
      return output(`${passed} 项达到演示判据${pending ? `，${pending} 项需继续处理` : ''}；现网观察窗未建立`,
        { executionId: execution.executionId, comparisons, passed, pending, mode: 'simulation', businessOutcome: pending ? 'needs_followup' : 'simulation_target_met',
          observationStatus: '演示快照评估，非现网成效', fieldTasks: comparisons.filter(row => !row.passed).map(row => ({ cell_id: row.cell_id, action: row.nextAction, status: '建议现场处理，未派发现网工单' })) }, [source, 'KN-005 · 演示评估规则']);
    },
    ...createExtendedHandlers(store, { selectedCells, rowsFor, allMetricData, diagnose, find }),
  };
}
