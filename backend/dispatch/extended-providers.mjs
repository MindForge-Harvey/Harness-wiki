import { metrics } from './catalog.mjs';
import { runReleaseFunction } from './release-functions.mjs';

const rounded = value => Number(value.toFixed(2));
const result = (summary, data, sources = ['内存演示数据', '发布包 v1.3.2 场景适配']) => ({ summary, data, sources });
const column = (key, label, unit) => ({ key, label, unit });
const sourceRules = {
  load_balance_trigger: { para: '>50', rule_scope: '-5' }, electrical_tilt: { para: '>2', rule_scope: '-1' },
  handover_offset: { para: '<=6', rule_scope: '+1' }, ul_power_control: { para: '>-3', rule_scope: '-1' }, access_preamble: { para: '<=64', rule_scope: '+16' },
};

export function resolveActionConflicts(actions) {
  const groups = new Map();
  for (const action of actions) {
    const key = `${action.cell_id}:${action.parameter}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(action);
  }
  const conflicts = [], redundancies = [];
  for (const [parameter, members] of groups) {
    const values = [...new Set(members.map(row => String(row.target).trim().toLowerCase()))];
    if (values.length > 1) conflicts.push({ parameter, values, actionIds: members.map(row => row.id), rule: 'drop_all' });
    else if (members.length > 1) redundancies.push({ parameter, actionIds: members.map(row => row.id) });
  }
  const dropped = new Set(conflicts.flatMap(row => row.actionIds));
  return { conflicts, redundancies, actions: actions.filter(row => !dropped.has(row.id)), dropped: [...dropped] };
}

export function createExtendedHandlers(store, helpers) {
  const { selectedCells, rowsFor, allMetricData, diagnose, find } = helpers;
  const dataOf = context => allMetricData(context);
  const table = (title, columns, rows, notes = []) => ({ title, columns, rows, notes });
  const requireResult = (upstream, id) => { const data = find(upstream, id); if (!data) throw new Error('缺少前置能力结果：' + id); return data; };
  const metricDefinition = context => metrics.find(metric => metric.id === (context.input?.metric_id || context.metric_ids?.[0] || 'prb')) || metrics[0];
  const dimensionTable = (context, dimension) => {
    const data = dataOf(context), findings = diagnose(data);
    const rows = data.cells.map(cell => {
      const matches = findings.find(item => item.cell_id === cell.id).findings.filter(item => ({ coverage: 'coverage', neighbor: 'handover', interference: 'interference', resource: 'capacity' }[dimension]) === item.type);
      return { cell_id: cell.id, cell_name: cell.name, status: matches.length ? '发现质差线索' : '当前判据下未检出', evidence: matches.map(row => row.evidence.join('；')).join('；') || '指标未触发本专题的演示判据' };
    });
    return table({ neighbor: '邻区与切换', interference: '上行干扰', resource: '容量与资源' }[dimension],
      [column('cell_id', '小区'), column('status', '研判'), column('evidence', '当前证据')], rows, ['当前结论为演示判据下的诊断线索，需要结合现场测量核验。']);
  };
  const orderRows = context => {
    const cells = store.scopeCells(context.scope), ids = cells.map(cell => cell.id);
    return store.db.prepare(`SELECT * FROM demo_orders WHERE created_at >= ? AND created_at < ?${ids.length ? ` AND cell_id IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY created_at DESC`)
      .all(context.window.start, context.window.end, ...ids);
  };
  return {
    'data.rank': async ({ context }) => {
      const data = dataOf(context), metric = metricDefinition(context), order = context.input?.order || (metric.direction === 'higher' ? 'asc' : 'desc');
      const limit = context.input?.limit ?? 5;
      const sorted = data.cells.filter(cell => Number.isFinite(cell.metrics[metric.id]?.value)).sort((a, b) => {
        const delta = a.metrics[metric.id].value - b.metrics[metric.id].value;
        return (order === 'asc' ? delta : -delta) || a.id.localeCompare(b.id);
      });
      return result(`已按${metric.name}${order === 'asc' ? '从低到高' : '从高到低'}列出 ${Math.min(limit, sorted.length)} 个小区`, {
        ...table(`${metric.name} TOP ${limit}`, [column('rank', '排名'), column('cell_id', '小区'), column('cell_name', '名称'), column('value', metric.name, metric.unit)], sorted.slice(0, limit).map((cell, i) => ({ rank: i + 1, cell_id: cell.id, cell_name: cell.name, value: cell.metrics[metric.id].value }))),
        metric: metric.id, order, matchedCount: sorted.length, window: context.window,
      });
    },
    'data.poor_cells': async ({ context }) => {
      const findings = diagnose(dataOf(context));
      const rows = findings.filter(cell => cell.findings.length).map(cell => ({ cell_id: cell.cell_id, cell_name: cell.cell_name,
        issues: cell.findings.map(issue => issue.label).join('、'), evidence: cell.findings.flatMap(issue => issue.evidence).join('；') }));
      return result(`筛出 ${rows.length} 个质差小区，保留每项判据与证据`, table('质差小区清单', [column('cell_id', '小区'), column('issues', '问题类型'), column('evidence', '证据')], rows));
    },
    'data.trend': async ({ context }) => {
      const metric = metricDefinition(context), data = dataOf(context), hours = new Map(), days = new Map();
      for (const row of data.series) {
        const value = row.values[metric.id]; if (!Number.isFinite(value)) continue;
        const date = new Date(Date.parse(row.at) + 8 * 3600000), hour = date.getUTCHours(), day = date.toISOString().slice(0, 10);
        for (const [map, key] of [[hours, hour], [days, day]]) { if (!map.has(key)) map.set(key, []); map.get(key).push(value); }
      }
      const hourly = [...hours].sort((a, b) => a[0] - b[0]).map(([hour, values]) => ({ hour, value: rounded(values.reduce((sum, value) => sum + value, 0) / values.length), samples: values.length }));
      const daily = [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([day, values]) => ({ day, value: rounded(values.reduce((sum, value) => sum + value, 0) / values.length), points: values.length }));
      const worst = [...hourly].sort((a, b) => metric.direction === 'higher' ? a.value - b.value : b.value - a.value)[0];
      return result(`${metric.name}最差小时为 ${worst?.hour ?? '未知'} 时，已保留按日及按小时统计`, {
        ...table('日趋势', [column('day', '日期'), column('value', metric.name, metric.unit), column('points', '小时观测点')], daily), hourly, worstHour: worst?.hour, metric: metric.id, unit: metric.unit,
      });
    },
    'data.compare': async ({ context }) => {
      const cells = selectedCells(context), gridIds = [...new Set(cells.map(cell => cell.grid_id))];
      let scopes;
      if (gridIds.length > 1) scopes = gridIds.map(id => ({ label: store.grids().find(grid => grid.id === id).name, scope: { grid_ids: [id], cell_ids: [] }, window: context.window }));
      else {
        const mid = new Date((Date.parse(context.window.start) + Date.parse(context.window.end)) / 2).toISOString();
        scopes = [{ label: '前半窗口', scope: context.scope, window: { ...context.window, end: mid } }, { label: '后半窗口', scope: context.scope, window: { ...context.window, start: mid } }];
      }
      const selected = context.metric_ids?.length ? metrics.filter(metric => context.metric_ids.includes(metric.id)) : metrics.slice(0, 6);
      const rows = scopes.map(scope => {
        const data = dataOf({ ...context, ...scope });
        const row = { label: scope.label, cells: data.cells.length, window: scope.window };
        selected.forEach(metric => { const values = data.cells.map(cell => cell.metrics[metric.id]); const denominator = values.reduce((sum, item) => sum + item.samples, 0); row[metric.id] = denominator ? rounded(values.reduce((sum, item) => sum + item.value * item.samples, 0) / denominator) : null; });
        return row;
      });
      return result(`已在可比口径下完成 ${rows.length} 组对比`, table('网络指标对比', [column('label', '范围 / 时段'), column('cells', '小区数'), ...selected.map(metric => column(metric.id, metric.name, metric.unit))], rows,
        ['均值按实际观测样本数加权；前后差异用于描述，不据此推断优化因果。']));
    },
    'diagnosis.coverage': async ({ context }) => {
      const cells = selectedCells(context), rows = cells.map(cell => {
        const sample = store.db.prepare('SELECT sum(samples) total,sum(good_samples) good,group_concat(DISTINCT scene) scenes FROM mr_coverage WHERE cell_id=? AND at>=? AND at<?').get(cell.id, context.window.start, context.window.end);
        const ratio = sample.total ? rounded(sample.good / sample.total * 100) : null;
        return { cell_id: cell.id, scene: sample.scenes || '无采样', samples: sample.total || 0, good_samples: sample.good || 0, coverage_pct: ratio,
          status: ratio === null ? '数据不足' : ratio < 90 ? '弱覆盖线索' : '当前判据下未检出' };
      });
      const total = rows.reduce((sum, row) => sum + row.samples, 0), good = rows.reduce((sum, row) => sum + row.good_samples, 0);
      return result(`${rows.filter(row => row.status === '弱覆盖线索').length} 个小区存在覆盖采样质差线索`, {
        ...table('MR 覆盖诊断', [column('cell_id', '小区'), column('scene', '覆盖场景'), column('samples', '上报采样数'), column('good_samples', '好覆盖采样数'), column('coverage_pct', '覆盖率', '%'), column('status', '研判')], rows,
          ['覆盖率 = 好覆盖采样数 / 上报采样数；90%为演示判据，未使用平均RSRP反推覆盖采样比例。']),
        totalSamples: total, goodSamples: good, coveragePercent: total ? rounded(good / total * 100) : null,
      });
    },
    'diagnosis.neighbor': async ({ context }) => {
      const data = dimensionTable(context, 'neighbor');
      data.rows = data.rows.map(row => {
        const neighbors = store.db.prepare('SELECT * FROM neighbors WHERE source_id=?').all(row.cell_id);
        const disabled = neighbors.filter(item => !item.enabled).length;
        return { ...row, neighborCount: neighbors.length, disabled, evidence: `${row.evidence}；${neighbors.length} 条邻区关系，${disabled} 条待核查` };
      });
      return result('已完成切换指标与邻区关系核查', data);
    },
    'diagnosis.interference': async ({ context }) => result('已联合 SINR 与上行干扰噪声完成专题研判', dimensionTable(context, 'interference')),
    'diagnosis.resource': async ({ context }) => result('已完成 PRB 与用户速率联合容量研判', dimensionTable(context, 'resource')),
    'diagnosis.parameter': async ({ context }) => {
      const rows = selectedCells(context).flatMap(cell => Object.entries(cell.parameters).map(([parameter, spec]) => ({ cell_id: cell.id, parameter: spec.label,
        current: spec.value, min: spec.min, max: spec.max, step: spec.step, unit: spec.unit,
        status: Number.isFinite(spec.value) && spec.value >= spec.min && spec.value <= spec.max && Math.abs((spec.value - spec.min) / spec.step - Math.round((spec.value - spec.min) / spec.step)) < 1e-8 ? '满足演示基线' : '参数越界或步长异常' })));
      return result(`已核查 ${rows.length} 项参数基线，异常 ${rows.filter(row => row.status !== '满足演示基线').length} 项`, table('参数基线', [column('cell_id', '小区'), column('parameter', '参数'), column('current', '当前值'), column('min', '最小值'), column('max', '最大值'), column('step', '步长'), column('status', '结果')], rows));
    },
    'diagnosis.alarm': async ({ context }) => {
      const alarms = rowsFor('alarms', context);
      return result(`已关联 ${alarms.length} 条故障告警`, table('告警故障关联', [column('cell_id', '小区'), column('name', '告警'), column('severity', '级别'), column('at', '时间')], alarms,
        ['天馈异常优先安排现场核验；没有告警不等于没有故障。']));
    },
    'decision.rule_assess': async ({ context, upstream, signal }) => {
      const plan = requireResult(upstream, 'optimization.plan'), cells = selectedCells(context);
      const checks = await runReleaseFunction('constraints', { rows: plan.actions.map(action => ({ id: action.id, before: action.before, target: action.target, rule: sourceRules[action.parameter] || {} })) }, signal);
      const actions = [], rows = checks.map(check => {
        const original = plan.actions.find(action => action.id === check.id), spec = cells.find(cell => cell.id === original.cell_id)?.parameters[original.parameter];
        const target = Number(check.final_b_para), hard = ['single', 'interval'].includes(check.kind);
        const allowed = hard && check.dispatch && spec && Number.isFinite(target) && target >= spec.min && target <= spec.max && Math.abs((target - spec.min) / spec.step - Math.round((target - spec.min) / spec.step)) < 1e-8;
        if (allowed) actions.push({ ...original, originalTarget: original.target, target, ruleEvidence: check });
        return { action_id: check.id, cell_id: original.cell_id, parameter: original.label, before: original.before, proposed: original.target, target: allowed ? target : null,
          decision: allowed ? check.reason === 'rewritten' ? '按源规则改写' : '满足源规则' : '不具备模拟执行条件', sourceDecision: check.summary, hardConstraint: hard };
      });
      return result(`源规则函数已审核 ${checks.length} 项参数，${actions.length} 项可进入独立校验`, {
        ...table('规则取值审核', [column('cell_id', '小区'), column('parameter', '参数'), column('before', '当前值'), column('proposed', '原建议值'), column('target', '规则后值'), column('decision', '判定')], rows),
        checks, actions, rejected: checks.length - actions.length, sourceVersion: '1.3.2',
      }, ['发布包原代码：services/compliance/rule_constraint.py', '演示规则映射与参数快照']);
    },
    'decision.conflicts': async ({ upstream }) => {
      const plan = find(upstream, 'decision.rule_assess') || requireResult(upstream, 'optimization.plan');
      const checked = resolveActionConflicts(plan.actions);
      return result(`发现 ${checked.conflicts.length} 组目标值冲突，剔除 ${checked.dropped.length} 项；同值冗余 ${checked.redundancies.length} 组`, {
        ...table('方案冲突检查', [column('parameter', '对象与参数'), column('values', '不同目标值'), column('decision', '处理')], checked.conflicts.map(row => ({ ...row, values: row.values.join('、'), decision: '冲突各方全部剔除' }))), ...checked, rows: checked.conflicts.map(row => ({ ...row, values: row.values.join('、'), decision: '冲突各方全部剔除' })),
      });
    },
    'decision.risk_basis': async ({ upstream }) => {
      const assessed = requireResult(upstream, 'decision.rule_assess');
      const rows = assessed.actions.map(action => {
        const evidence = action.ruleEvidence;
        const basis = !evidence ? '规则库无匹配' : !['single', 'interval'].includes(evidence.kind) ? '有规则无硬约束'
          : evidence.headroom?.next_step_fits === false ? '余量不足一步' : '硬约束内';
        return { cell_id: action.cell_id, parameter: action.label, basis, parameter_level: '未供数', grade: '未分级', decision: '仍需独立执行校验' };
      });
      return result(`已归档 ${rows.length} 项可执行候选的风险依据，源风险等级未供数`, table('参数风险依据', [column('cell_id', '小区'), column('parameter', '参数'), column('basis', '风险依据'), column('grade', '风险等级')], rows,
        [`另有 ${assessed.rejected} 项未进入可执行候选；不以风险依据档冒充风险等级。`]));
    },
    'optimization.short_review': async ({ upstream, signal }) => {
      const evaluation = requireResult(upstream, 'optimization.evaluate'), executed = find(upstream, 'optimization.rollback') || requireResult(upstream, 'optimization.execute');
      const assessment = !evaluation.comparisons.length ? '缺失' : evaluation.pending ? '不通过' : '通过';
      const reviewed = await runReleaseFunction('short_review', { assessment, execution_feedback: executed.actions.every(action => action.state === 'executed') ? '执行成功' : '执行失败',
        changes: evaluation.comparisons.map(row => ({ ...row, direction: metrics.find(metric => metric.id === row.metric)?.direction || 'higher' })) }, signal);
      return result(`短评估复核：${assessment}；已核对执行回执 ${evaluation.executionId}`, {
        ...table('短评估复核', [column('metric', '指标'), column('trend', '源函数趋势判定')], reviewed.changes), ...reviewed, assessment, executionId: evaluation.executionId,
        notes: ['按是否达到声明判据复核为通过/不通过，未达标不等同于指标恶化；模拟快照不替代现网观察窗。'],
      }, ['发布包原代码：services/decision/prior_round.py', '已完成的模拟执行与评估回执']);
    },
    'optimization.rollback': async ({ upstream }) => {
      const original = requireResult(upstream, 'optimization.execute');
      const previous = find(upstream, 'optimization.rollback');
      if (previous?.originalExecutionId === original.executionId) throw new Error('这次模拟执行已经回退，未重复执行');
      const executionId = store.id('ROLLBACK'), executedAt = new Date().toISOString();
      const actions = original.actions.map(action => ({ ...action, before: action.actualValue, target: action.before, actualValue: action.before, state: 'executed', executedAt }));
      return result(`已按原执行前值回退 ${actions.length} 项模拟参数，生成独立回执`, {
        ...table('模拟回退回执', [column('cell_id', '小区'), column('label', '参数'), column('before', '回退前'), column('actualValue', '恢复值'), column('state', '执行状态')], actions),
        executionId, originalExecutionId: original.executionId, executedAt, mode: 'simulation', actions, before: original.after, after: original.before,
      });
    },
    'operations.orders': async ({ context }) => {
      const all = orderRows(context), status = context.input?.status || 'all', filtered = all.filter(row => status === 'all' || row.status === status), limit = context.input?.limit || 30;
      return result(`匹配 ${filtered.length} 张演示优化工单，返回 ${Math.min(limit, filtered.length)} 张`, {
        ...table('优化工单', [column('taskno', '工单号'), column('cell_id', '小区'), column('problem', '问题'), column('status', '状态'), column('created_at', '受理时间')], filtered.slice(0, limit)), matchedCount: filtered.length, returnedCount: Math.min(limit, filtered.length),
      });
    },
    'operations.stats': async ({ context }) => {
      const orders = orderRows(context), passed = orders.filter(row => row.status === 'Succeed').length;
      const closed = orders.filter(row => row.closed_at), meanMinutes = closed.length ? rounded(closed.reduce((sum, row) => sum + (Date.parse(row.closed_at) - Date.parse(row.created_at)) / 60000, 0) / closed.length) : null;
      const own = [...store.runs.values()].filter(run => run.ownerUid === context.ownerUid && run.createdAt >= context.window.start && run.createdAt < context.window.end);
      const runIds = new Set(own.map(run => run.id)), jobs = [...store.jobs.values()].filter(job => runIds.has(job.runId));
      const counts = Object.entries(orders.reduce((state, row) => { state[row.status] = (state[row.status] || 0) + 1; return state; }, {}));
      const rate = orders.length ? rounded(passed / orders.length * 100) : null;
      return result(`${orders.length} 张演示工单中 ${passed} 张成功闭环，闭环率 ${rate ?? '暂无'}%`, {
        ...table('工单状态分布', [column('status', '状态'), column('count', '工单数')], counts.map(([status, count]) => ({ status, count }))),
        statistics: [{ label: '演示工单', value: orders.length }, { label: '成功闭环', value: passed }, { label: '闭环率', value: rate, unit: '%' }, { label: '已结束工单平均处理时长', value: meanMinutes, unit: '分钟' }],
        runtime: { runs: own.length, acceptedJobs: jobs.length, completedJobs: jobs.filter(job => job.status === 'completed').length },
        notes: ['闭环率 = Succeed 工单数 / 同范围同时间受理工单数；演示工单与当前账号真实调度回执分开统计。'],
      });
    },
  };
}
