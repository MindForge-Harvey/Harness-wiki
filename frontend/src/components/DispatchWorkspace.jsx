import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, ArrowsClockwise, Broadcast, CaretDown, CaretRight, Check, CheckCircle, ChatCircleDots, CircleNotch,
  Clock, Database, FlowArrow, GridFour, Lightning, MagnifyingGlass, Network, Plus, PuzzlePiece, Radio, Square, Target, WarningCircle, X } from '@phosphor-icons/react';
import { fetchIdentity, setActiveAccount, fetchDispatchCatalog, fetchDispatchRuns, fetchDispatchRun, createDispatchRun, cancelDispatchRun } from '../lib/api';
import '../dispatch-workspace.css';
import CapabilityCenter from './CapabilityCenter';

const active = run => run && ['interpreting', 'dispatching', 'running'].includes(run.status);
const statusLabels = { interpreting: '理解中', dispatching: '派发中', running: '执行中', completed: '已完成', failed: '需关注', cancelled: '已停止', needs_input: '待补充', queued: '待派发', blocked: '受阻' };
const iconOf = { foundation: Database, complaint: ChatCircleDots, optimization: Broadcast, region: Network, grid: GridFour };
const examples = [
  { icon: FlowArrow, title: '投诉排查与闭环', prompt: '排查新街口商圈近7天投诉集中的原因，结合网络指标制定优化方案，安排处理并跟踪效果。', text: '从投诉定位，到方案派发与效果跟踪' },
  { icon: Broadcast, title: '查网络指标', prompt: '查一下新街口商圈昨天的PRB利用率和下行用户速率。', text: '新街口商圈昨天的负荷和速率怎么样？' },
  { icon: GridFour, title: '看网格质量', prompt: '分析河西商务区近7天的网络质量，找出需要重点关注的小区，只分析不要下发。', text: '识别质差小区与区域共性问题' },
  { icon: MagnifyingGlass, title: '查专业知识', prompt: 'PRB利用率高和下载慢有什么关系？应该如何排查？', text: '结合知识与案例，理解网络问题' },
];
const time = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) : '—';
const number = value => typeof value === 'number' ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value) : value ?? '—';
const elapsed = task => task.finishedAt && task.startedAt ? `${Math.max(0, (new Date(task.finishedAt) - new Date(task.startedAt)) / 1000).toFixed(2)} s` : null;
const rememberRun = id => {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('task', id); else url.searchParams.delete('task');
  window.history.replaceState(null, '', url.pathname + url.search);
};

function StatusIcon({ status, size = 17 }) {
  if (['running', 'dispatching', 'interpreting'].includes(status)) return <CircleNotch size={size} className="dispatch-spin" />;
  if (status === 'completed') return <CheckCircle size={size} weight="fill" />;
  if (['failed', 'blocked'].includes(status)) return <WarningCircle size={size} weight="fill" />;
  if (status === 'cancelled') return <Square size={size} />;
  return <span className="dispatch-pending-dot" />;
}

function MetricResult({ data }) {
  const [metricId, setMetricId] = useState(data.metrics[0]?.id);
  const metric = data.metrics.find(row => row.id === metricId) || data.metrics[0];
  if (!metric) return null;
  const values = data.series.map(row => row.values[metric.id]).filter(value => Number.isFinite(value));
  const minimum = Math.min(...values), maximum = Math.max(...values), span = maximum - minimum || 1;
  const points = values.map((value, index) => `${24 + index / Math.max(values.length - 1, 1) * 652},${138 - (value - minimum) / span * 98}`).join(' ');
  return <div className="dispatch-metric-result">
    <div className="dispatch-metric-picker">{data.metrics.map(row => <button key={row.id} className={row.id === metric.id ? 'selected' : ''} onClick={() => setMetricId(row.id)}>{row.name}</button>)}</div>
    <div className="dispatch-chart-head"><strong>{metric.name}</strong><span>{metric.unit} · {data.window.label} · {number(data.sampleCount)} 条观测</span></div>
    <svg className="dispatch-chart" viewBox="0 0 720 174" role="img" aria-label={`${metric.name}时间趋势，单位${metric.unit}`}>
      {[42, 90, 138].map(y => <line key={y} x1="24" y1={y} x2="676" y2={y} stroke="#e9edf3" strokeDasharray="3 5" />)}
      <polygon points={`24,146 ${points} 676,146`} fill="url(#metric-fill)" />
      <defs><linearGradient id="metric-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6286ed" stopOpacity=".15" /><stop offset="100%" stopColor="#6286ed" stopOpacity=".01" /></linearGradient></defs>
      <polyline points={points} fill="none" stroke="#527bec" strokeWidth="2.3" strokeLinejoin="round" />
      <text x="688" y="46">{number(maximum)}</text><text x="688" y="142">{number(minimum)}</text>
      <text x="24" y="168">{data.series[0]?.at.slice(5, 10)}</text><text x="632" y="168">{data.series.at(-1)?.at.slice(5, 10)}</text>
    </svg>
    <div className="dispatch-table-wrap"><table><thead><tr><th>小区</th>{data.metrics.map(row => <th key={row.id}>{row.name}<small>{row.unit}</small></th>)}</tr></thead>
      <tbody>{data.cells.map(cell => <tr key={cell.id}><td><strong>{cell.name}</strong><small>{cell.id}</small></td>{data.metrics.map(row => <td key={row.id}>{number(cell.metrics[row.id]?.value)}</td>)}</tr>)}</tbody></table></div>
  </div>;
}

function DiagnosisResult({ data }) {
  return <div className="dispatch-findings">{data.findings.map(cell => <div className="dispatch-finding" key={cell.cell_id}>
    <div><strong>{cell.cell_name}</strong><small>{cell.cell_id}</small></div>
    <div>{cell.findings.length ? cell.findings.map((finding, index) => <div key={index}><span className="dispatch-issue">{finding.label}</span><p>{finding.evidence.join('，')}</p><small>{finding.rule} · 演示研判规则</small></div>) : <span className="dispatch-muted">当前演示判据下未发现异常</span>}</div>
  </div>)}</div>;
}

function PlanResult({ data }) {
  return <><div className="dispatch-table-wrap"><table><thead><tr><th>对象与问题</th><th>模拟优化措施</th><th>当前值</th><th>目标值</th></tr></thead><tbody>
    {data.actions.map(action => <tr key={action.id}><td><strong>{action.cell_id}</strong><small>{action.issueLabel}</small></td><td>{action.label}{action.fieldCheck && <small>同时建议核查天馈故障</small>}</td><td>{action.before}{action.unit}</td><td className="dispatch-target">{action.target}{action.unit}</td></tr>)}
    {!data.actions.length && <tr><td colSpan="4">没有需要调整的异常参数。</td></tr>}
  </tbody></table></div><p className="dispatch-result-note">演示参数方案 · 通过独立约束校验后方可交给模拟执行器</p></>;
}

function EvaluationResult({ data }) {
  return <><div className="dispatch-evaluation-head"><span><strong>{data.passed}</strong> 项达到演示判据</span><span className={data.pending ? 'attention' : ''}><strong>{data.pending}</strong> 项继续处理</span></div>
    <div className="dispatch-table-wrap"><table><thead><tr><th>小区 / 指标</th><th>执行前</th><th>模拟执行后</th><th>结果</th></tr></thead><tbody>
      {data.comparisons.map(row => <tr key={`${row.cell_id}-${row.metric}`}><td><strong>{row.cell_id}</strong><small>{row.metricName}</small></td><td>{number(row.before)} {row.unit}</td><td>{number(row.after)} {row.unit}</td><td><span className={`dispatch-outcome ${row.passed ? 'pass' : 'attention'}`}>{row.passed ? '达到判据' : '需继续处理'}</span></td></tr>)}
    </tbody></table></div>
    {data.fieldTasks?.map(row => <div className="dispatch-followup" key={row.cell_id}><ArrowsClockwise size={18} /><span><strong>{row.cell_id}</strong>{row.action}</span></div>)}
    <p className="dispatch-result-note">{data.observationStatus} · 回执 {data.executionId}</p>
  </>;
}

function OutputView({ output, compact = false }) {
  if (!output) return null;
  const data = output.data, id = output.capabilityId;
  if (data.columns && data.rows) return <div className="dispatch-analysis-result">
    {data.statistics && <div className="dispatch-analysis-statistics">{data.statistics.map(item => <div key={item.label}><strong>{number(item.value)}<small>{item.unit}</small></strong><span>{item.label}</span></div>)}</div>}
    {data.runtime && <p className="dispatch-runtime-summary">当前账号实际调度：{data.runtime.runs} 个任务，{data.runtime.acceptedJobs} 次专业接单，{data.runtime.completedJobs} 项完成</p>}
    <div className="dispatch-table-wrap"><table><thead><tr>{data.columns.map(column => <th key={column.key}>{column.label}{column.unit && <small>{column.unit}</small>}</th>)}</tr></thead><tbody>{data.rows.map((row, index) => <tr key={index}>{data.columns.map(column => <td key={column.key}>{Array.isArray(row[column.key]) ? row[column.key].join('、') : typeof row[column.key] === 'boolean' ? row[column.key] ? '是' : '否' : number(row[column.key])}</td>)}</tr>)}{!data.rows.length && <tr><td colSpan={data.columns.length}>本次未发现匹配项</td></tr>}</tbody></table></div>
    {data.notes?.map((note, index) => <p className="dispatch-result-note" key={index}>{note}</p>)}
    {data.hourly && <details className="dispatch-json"><summary>查看小时趋势</summary><div className="dispatch-hourly-trend">{data.hourly.map(row => <div key={row.hour}><span>{row.hour} 时</span><strong>{number(row.value)} {data.unit}</strong></div>)}</div></details>}
    {data.executionId && <p className="dispatch-result-note">执行回执 {data.executionId}</p>}
  </div>;
  if (id === 'data.metrics') return <MetricResult data={data} />;
  if (id === 'optimization.diagnose') return <DiagnosisResult data={data} />;
  if (id === 'optimization.plan') return <PlanResult data={data} />;
  if (id === 'optimization.evaluate') return <EvaluationResult data={data} />;
  if (id === 'knowledge.search') return <div className="dispatch-knowledge">{data.documents.length ? data.documents.map(row => <article key={row.id}><span>{row.id}</span><h4>{row.title}</h4><p>{row.text}</p></article>) : <p>当前演示知识库没有匹配条目。</p>}</div>;
  if (id === 'complaint.b_domain') return <div className="dispatch-b-domain"><div><strong>{data.total}</strong><span>投诉总数</span></div><div><strong>{data.excluded}</strong><span>非无线问题</span></div><div><strong>{data.wireless.length}</strong><span>进入网络分析</span></div></div>;
  if (id === 'region.common_cause') return <div className="dispatch-region-results">{data.groups.map(group => <article key={group.type}><strong>{group.label}</strong><span>{group.common ? '区域共性问题' : '局部问题'}</span><p>{group.cell_ids.join('、')}</p></article>)}</div>;
  if (id === 'grid.portrait') return <><div className="dispatch-b-domain"><div><strong>{data.cells.length}</strong><span>关联小区</span></div><div><strong>{data.complaintCount}</strong><span>投诉工单</span></div><div><strong>{data.findings.filter(row => row.findings.length).length}</strong><span>质差小区</span></div></div><DiagnosisResult data={data} /></>;
  if (id === 'history.search') return <div className="dispatch-knowledge">{data.cases.map(row => <article key={row.id}><span>{row.id} · 演示案例</span><h4>{row.title}</h4><p>{row.action}</p><p>{row.result}</p></article>)}</div>;
  return <details className="dispatch-json" open={compact}><summary>查看结构化结果</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>;
}

function RunResults({ run, catalog }) {
  const outputs = run.result?.outputs || [];
  const preferred = [
    ['optimization.short_review', '短评估复核'], ['optimization.rollback', '回退回执'], ['operations.stats', '闭环运营'], ['data.rank', '指标排名'], ['data.trend', '忙时趋势'], ['data.compare', '网格对比'],
    ['decision.rule_assess', '取值审核'], ['decision.risk_basis', '风险依据'], ['decision.conflicts', '冲突检查'],
    ['optimization.evaluate', '效果反馈'], ['optimization.plan', '优化方案'], ['optimization.diagnose', '分析结论'],
    ['region.common_cause', '区域问题'], ['grid.portrait', '网格画像'], ['data.metrics', '指标数据'],
    ['complaint.b_domain', '投诉定界'], ['knowledge.search', '专业知识'], ['history.search', '历史案例'],
  ];
  const available = [...preferred, ...outputs.filter(output => !preferred.some(([id]) => id === output.capabilityId)).map(output => [output.capabilityId, catalog.capabilities.find(tool => tool.id === output.capabilityId)?.name || output.capabilityId])]
    .filter(([id], index, rows) => outputs.some(output => output.capabilityId === id) && rows.findIndex(row => row[0] === id) === index);
  const [tab, setTab] = useState(null);
  const selected = available.some(([id]) => id === tab) ? tab : available[0]?.[0];
  if (!run.result) return null;
  return <section className="dispatch-results"><div className={`dispatch-result-summary ${run.status === 'failed' ? 'has-errors' : ''}`}>{run.status === 'failed' ? <WarningCircle size={21} weight="fill" /> : <CheckCircle size={21} weight="fill" />}<p>{run.summary}</p></div>
    <div className="dispatch-result-tabs" role="tablist" aria-label="任务结果">{available.map(([id, label]) => <button key={id} role="tab" aria-selected={selected === id} className={selected === id ? 'selected' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
    {selected ? <OutputView output={outputs.find(output => output.capabilityId === selected)} /> : outputs.map((output, index) => <div key={index}><h4>{output.summary}</h4><OutputView output={output} /></div>)}
  </section>;
}

function TaskDetail({ task, run, catalog, onClose }) {
  const agent = catalog.agents.find(item => item.id === task.agentId), Icon = iconOf[task.agentId];
  return <div className="dispatch-task-detail"><div className="dispatch-rail-title"><h3>任务详情</h3><button onClick={onClose} aria-label="关闭任务详情"><X size={17} /></button></div>
    <div className="dispatch-detail-agent" style={{ '--agent-color': agent.color }}><Icon size={22} /><span>{agent.name}</span><span className={`dispatch-state ${task.status}`}>{statusLabels[task.status]}</span></div>
    <h2>{task.name}</h2><p className="dispatch-detail-reason">{task.reason}</p>
    <dl className="dispatch-detail-spec"><dt>执行范围</dt><dd>{task.scope?.cell_ids?.join('、') || run.intent.scopeLabel}</dd><dt>能力</dt><dd className="mono">{task.capabilityId}</dd></dl>
    {task.receipt && <section className="dispatch-receipt"><h4><CheckCircle size={16} weight="fill" /> 已收到接单回执</h4><dl><dt>任务编号</dt><dd>{task.receipt.providerTaskId}</dd><dt>接单时间</dt><dd>{time(task.receipt.acceptedAt)}</dd><dt>调用方式</dt><dd>HTTP POST · 202 Accepted</dd>{elapsed(task) && <><dt>端到端耗时</dt><dd>{elapsed(task)}</dd></>}</dl><code>{catalog.capabilities.find(row => row.id === task.capabilityId)?.endpoint}</code></section>}
    {task.error && <p className="dispatch-error" role="alert">{task.error}</p>}
    {task.result && <div className="dispatch-detail-result"><h4>执行结果</h4><p>{task.result.summary}</p><details><summary>输入与返回数据</summary><pre>{JSON.stringify({ input: { scope: task.scope || run.intent.scope, window: run.intent.window, parameters: task.input || {}, dependencies: task.dependsOn }, result: task.result }, null, 2)}</pre></details></div>}
    {task.mode === 'simulation' && <p className="dispatch-result-note">隔离模拟执行，未连接现网参数平台</p>}
  </div>;
}

function Supervision({ run, catalog }) {
  const events = run.events.filter(event => !['provider.progress', 'dispatch.requested'].includes(event.type));
  return <><div className="dispatch-rail-title"><h3>流程监督</h3><span className={`dispatch-state ${run.status}`}>{statusLabels[run.status]}</span></div>
    <div className="dispatch-provider-list">{catalog.agents.map(agent => {
      const Icon = iconOf[agent.id], tasks = run.tasks.filter(task => task.agentId === agent.id), receipts = tasks.filter(task => task.receipt).length;
      return <div key={agent.id} className={tasks.length ? 'involved' : ''} style={{ '--agent-color': agent.color }}><span className="dispatch-provider-icon"><Icon size={19} /></span><span>{agent.name}</span><small>{receipts ? `${receipts} 项已接单` : tasks.length ? '待接单' : '待命'}</small></div>;
    })}</div>
    <div className="dispatch-event-heading"><h4>调度记录</h4><span>{run.events.filter(event => event.type === 'dispatch.accepted').length} 次接单</span></div>
    <ol className="dispatch-events">{[...events].reverse().slice(0, 35).map(event => <li key={event.seq} className={event.type.startsWith('supervision') ? 'feedback' : event.type.includes('failed') ? 'error' : ''}><span className="dispatch-event-dot" /><div><p>{event.message}</p>{event.providerTaskId && <code>{event.providerTaskId}</code>}<time>{time(event.at)}</time></div></li>)}</ol>
  </>;
}

export default function DispatchWorkspace() {
  const [user, setUser] = useState(null), [catalog, setCatalog] = useState(null), [runs, setRuns] = useState([]), [run, setRun] = useState(null);
  const [view, setView] = useState(() => new URLSearchParams(window.location.search).get('view') === 'capabilities' ? 'capabilities' : 'workspace'), [draft, setDraft] = useState(''), [error, setError] = useState(''), [submitting, setSubmitting] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState(null), [booting, setBooting] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const selectedId = useRef(null), requestVersion = useRef(0), textarea = useRef(null), bottom = useRef(null);
  const refreshRuns = useCallback(async () => { const items = await fetchDispatchRuns(); setRuns(items); return items; }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === 'capabilities') url.searchParams.set('view', 'capabilities'); else url.searchParams.delete('view');
    window.history.replaceState(null, '', url.pathname + url.search);
  }, [view]);
  useEffect(() => {
    let disposed = false;
    document.title = '无线网络调度智能体 · Harness';
    (async () => {
      try {
        const identity = await fetchIdentity();
        if (disposed) return;
        if (!identity) throw new Error('请从统一门户登录后进入调度工作台。');
        setActiveAccount(identity.uid); setUser(identity);
        const [data, items] = await Promise.all([fetchDispatchCatalog(), fetchDispatchRuns()]);
        if (!disposed) {
          setCatalog(data); setRuns(items);
          const savedId = new URLSearchParams(window.location.search).get('task');
          if (savedId) {
            try { const saved = await fetchDispatchRun(savedId); if (!disposed) { selectedId.current = saved.id; setRun(saved); } }
            catch { if (!disposed) rememberRun(null); }
          }
        }
      } catch (cause) { if (!disposed) setError(cause.message); }
      finally { if (!disposed) setBooting(false); }
    })();
    const invalid = () => { setUser(null); setCatalog(null); setRuns([]); setRun(null); setActiveAccount(null); selectedId.current = null; requestVersion.current++; setError('登录已失效，请刷新并重新登录。'); };
    window.addEventListener('harness-auth-invalid', invalid);
    return () => { disposed = true; window.removeEventListener('harness-auth-invalid', invalid); };
  }, []);
  useEffect(() => {
    if (!run || !active(run)) return;
    const controller = new AbortController(), id = run.id;
    let timer;
    const poll = async () => {
      try {
        const value = await fetchDispatchRun(id, { signal: controller.signal });
        if (controller.signal.aborted || selectedId.current !== id) return;
        setRun(value); setRuns(items => items.map(item => item.id === value.id ? { ...item, ...value } : item));
        if (active(value)) timer = setTimeout(poll, 450);
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause.status === 404) { selectedId.current = null; rememberRun(null); setRun(null); void refreshRuns(); setError('演示服务已重启或任务已清理，请重新发起任务。'); }
          else { setError(cause.message); timer = setTimeout(poll, 2000); }
        }
      }
    };
    timer = setTimeout(poll, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [run?.id, active(run)]);
  useEffect(() => {
    if (!runs.some(item => active(item))) return;
    const timer = setInterval(() => { refreshRuns().catch(() => {}); }, 2500);
    return () => clearInterval(timer);
  }, [runs.some(item => active(item)), refreshRuns]);
  useEffect(() => { if (draft === '' && textarea.current) textarea.current.style.height = ''; }, [draft]);

  const selectRun = useCallback(async id => {
    const version = ++requestVersion.current;
    selectedId.current = id; rememberRun(id); setSelectedTaskId(null); setView('workspace'); setError('');
    try { const value = await fetchDispatchRun(id); if (version === requestVersion.current) setRun(value); }
    catch (cause) { if (version === requestVersion.current) setError(cause.message); }
  }, []);
  const newTask = () => { requestVersion.current++; selectedId.current = null; rememberRun(null); setRun(null); setView('workspace'); setSelectedTaskId(null); setDraft(''); setError(''); setTimeout(() => textarea.current?.focus(), 0); };
  useEffect(() => {
    const shortcut = event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newTask(); } };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const submit = useCallback(async (message, scenarioId) => {
    const text = typeof message === 'string' ? message.trim() : draft.trim();
    if (!text || submitting || active(run)) return;
    setSubmitting(true); setError('');
    const version = ++requestVersion.current;
    try {
      const next = await createDispatchRun(text, run?.id, scenarioId);
      if (version !== requestVersion.current) { await refreshRuns(); return; }
      selectedId.current = next.id; rememberRun(next.id); setRun(next); setDraft(''); setView('workspace'); setSelectedTaskId(null); setExpanded(false);
      await refreshRuns();
    } catch (cause) { if (version === requestVersion.current) setError(cause.message); }
    finally { setSubmitting(false); }
  }, [draft, submitting, run, refreshRuns]);
  const stop = async () => {
    const id = run.id;
    try { const next = await cancelDispatchRun(id); if (selectedId.current === id) setRun(next); await refreshRuns(); }
    catch (cause) { setError(cause.message); }
  };
  const selectedTask = run?.tasks.find(task => task.id === selectedTaskId);
  const receiptCount = run?.tasks.filter(task => task.receipt).length || 0;
  const completedCount = run?.tasks.filter(task => task.status === 'completed').length || 0;
  const busy = submitting || active(run);
  const availableAgents = useMemo(() => catalog?.agents.filter(agent => agent.id !== 'foundation') || [], [catalog]);
  const previewTasks = useMemo(() => {
    const seen = new Set();
    return (run?.tasks || []).filter(task => { if (seen.has(task.agentId)) return false; seen.add(task.agentId); return true; });
  }, [run]);
  const shownTasks = expanded ? run?.tasks || [] : previewTasks;

  const composer = <form className={`dispatch-composer ${run ? 'is-followup' : ''}`} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <textarea ref={textarea} aria-label="输入调度任务" value={draft} maxLength={4000} disabled={!catalog || submitting} rows={run ? 1 : 2}
      placeholder={run ? run.status === 'needs_input' ? '补充信息，继续刚才的任务…' : '继续提问，或下达下一步指令…' : '描述你的目标，让调度智能体选择能力并执行…'}
      onChange={event => { setDraft(event.target.value); event.target.style.height = 'auto'; event.target.style.height = Math.min(event.target.scrollHeight, 160) + 'px'; }}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
    <div className="dispatch-composer-bottom"><span><Lightning size={15} weight="fill" />Harness</span>{active(run) ? <button type="button" className="dispatch-stop" onClick={stop}><Square size={13} weight="fill" />停止调度</button> : <button type="submit" className="dispatch-send" disabled={!draft.trim() || busy || !catalog} aria-label="识别意图并派发任务"><span>{submitting ? '提交中' : run ? '发送' : '识别并调度'}</span><ArrowUp size={18} weight="bold" /></button>}</div>
  </form>;

  return <div className="dispatch-app">
    <aside className="dispatch-sidebar"><button className="dispatch-brand" onClick={newTask}><span><Radio size={25} weight="bold" /></span><div>无线网络<strong>调度智能体</strong></div></button>
      <button className="dispatch-new" onClick={newTask}><Plus size={18} />新任务<span>⌘ K</span></button>
      <nav aria-label="工作区"><button className={view === 'workspace' ? 'selected' : ''} onClick={() => setView('workspace')}><FlowArrow size={19} />调度工作台</button><button className={view === 'capabilities' ? 'selected' : ''} onClick={() => setView('capabilities')}><PuzzlePiece size={19} />能力中心<span>{catalog?.scenarios.length || '—'}</span></button></nav>
      <div className="dispatch-history-title">任务记录<span>{runs.length}</span></div>
      <div className="dispatch-history">{runs.map(item => <button key={item.id} className={run?.id === item.id && view === 'workspace' ? 'selected' : ''} onClick={() => selectRun(item.id)}><span className={`dispatch-history-status ${item.status}`} /><div><strong>{item.intent?.label || item.message}</strong><small>{item.message}</small></div>{active(item) && <CircleNotch size={13} className="dispatch-spin" />}</button>)}{!runs.length && <p>发起任务后，在这里查看进展</p>}</div>
      <div className="dispatch-sidebar-bottom"><div className="dispatch-user"><span>{(user?.username || 'H').slice(0, 1).toUpperCase()}</span><div>{user?.username === 'local' ? '演示工作区' : user?.username || '连接中'}<small>Harness Workspace</small></div><i /></div></div>
    </aside>
    <main className={`dispatch-main ${run && view === 'workspace' ? 'has-run' : ''}`}>
      <header className="dispatch-header"><div><span>{view === 'capabilities' ? '能力中心' : '调度工作台'}</span>{run && view === 'workspace' && <><CaretRight size={13} /><span className="dispatch-header-id">{run.id}</span></>}</div><span className="dispatch-environment"><i />演示环境</span></header>
      {booting ? <div className="dispatch-boot"><CircleNotch size={24} className="dispatch-spin" /><p>正在连接调度工作台</p></div> : !catalog ? <div className="dispatch-boot"><WarningCircle size={30} /><p role="alert">{error}</p><button onClick={() => window.location.reload()}>重新连接</button></div> : view === 'capabilities' ? <CapabilityCenter catalog={catalog} onLaunch={submit} busy={busy} hasExecution={Boolean(run?.tasks.some(task => ['optimization.execute', 'optimization.evaluate', 'optimization.short_review'].includes(task.capabilityId) && task.status === 'completed' && task.result?.data.executionId))} /> : <>
        <div className="dispatch-conversation">
          {!run ? <div className="dispatch-welcome"><div className="dispatch-hero-icon"><Radio size={38} weight="light" /><span /></div><h1>今天，要处理哪个网络问题？</h1>
            {composer}<div className="dispatch-examples">{examples.map(example => <button key={example.title} onClick={() => submit(example.prompt)} disabled={submitting}><example.icon size={21} /><div><strong>{example.title}</strong><span>{example.text}</span></div><ArrowUpRight size={17} /></button>)}</div>
            <div className="dispatch-connected"><span>已接入</span>{availableAgents.map(agent => { const Icon = iconOf[agent.id]; return <span key={agent.id} style={{ '--agent-color': agent.color }}><Icon size={16} />{agent.name}</span>; })}</div>
          </div> : <div className="dispatch-run-content">
            {run.previousRunId && <button className="dispatch-parent-link" onClick={() => selectRun(run.previousRunId)}><Clock size={14} />承接上一任务<CaretRight size={13} /></button>}
            <div className="dispatch-user-message"><span>你</span><p>{run.message}</p></div>
            <section className="dispatch-understanding"><div className="dispatch-section-heading"><span className="dispatch-assistant-icon"><Radio size={19} /></span><h2>意图理解</h2><span className="dispatch-engine">Harness</span><span className={`dispatch-state ${run.status}`}><StatusIcon status={run.status} size={14} />{statusLabels[run.status]}</span></div>
              {run.intent ? <><h3>{run.intent.label}</h3><p>{run.intent.understanding}</p><div className="dispatch-intent-scope"><span><Target size={15} />{run.intent.scopeLabel}</span><span><Clock size={15} />{run.intent.window.label}</span>{run.intent.metricNames.length > 0 && <span><Broadcast size={15} />{run.intent.metricNames.join('、')}</span>}</div></> : run.status === 'interpreting' ? <div className="dispatch-understanding-pending"><span className="dispatch-thinking-dots"><i /><i /><i /></span><p>{run.events.at(-1)?.message || '正在理解目标、识别对象与时间…'}</p></div> : null}
              {run.clarification && <p className="dispatch-clarification">{run.clarification}</p>}{run.error && <p className="dispatch-error" role="alert">{run.error}</p>}
            </section>
            {run.tasks.length > 0 && <section className="dispatch-plan"><button className="dispatch-plan-heading" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}><FlowArrow size={18} /><h2>任务派发</h2><span>{receiptCount} 项已接单 · {completedCount}/{run.tasks.length} 完成</span><CaretDown size={15} className={expanded ? '' : 'collapsed'} /></button>
              <ol>{shownTasks.map(task => { const agent = catalog.agents.find(item => item.id === task.agentId), Icon = iconOf[task.agentId], index = run.tasks.indexOf(task); return <li key={task.id} className={`${task.status} ${selectedTaskId === task.id ? 'selected' : ''}`}><button onClick={() => setSelectedTaskId(task.id)}><span className="dispatch-task-number">{String(index + 1).padStart(2, '0')}</span><span className="dispatch-task-title"><strong>{task.name}{task.feedback && <i>反馈触发</i>}</strong><small>{task.reason}</small></span><span className="dispatch-task-agent" style={{ '--agent-color': agent.color }}><Icon size={15} />{agent.shortName}</span><span className={`dispatch-task-state ${task.status}`}><StatusIcon status={task.status} size={16} /><span>{statusLabels[task.status]}</span></span><CaretRight size={14} /></button>{task.receipt && <div className="dispatch-task-receipt"><span>POST</span><code>{task.receipt.providerTaskId}</code><span>{time(task.receipt.acceptedAt)} 接单</span>{elapsed(task) && <span>{elapsed(task)}</span>}</div>}</li>; })}</ol>
              {run.tasks.length > previewTasks.length && <button className="dispatch-expand-tasks" onClick={() => setExpanded(value => !value)}>{expanded ? '收起任务明细' : `查看全部 ${run.tasks.length} 项任务与回执`}<CaretDown size={12} className={expanded ? 'expanded' : ''} /></button>}
            </section>}
            <RunResults run={run} catalog={catalog} />
            {run.status === 'cancelled' && <p className="dispatch-cancelled">本次调度已停止，已产生的任务回执与结果仍可查看。</p>}
            <div ref={bottom} />
          </div>}
        </div>
        {run && <div className="dispatch-bottom-composer">{composer}<div className="dispatch-data-note"><i />内存演示数据 · 参数变更通过模拟执行器完成</div></div>}
        {!run && <div className="dispatch-welcome-foot"><span><i />{catalog.data.cells} 个小区 · {catalog.data.complaints} 张投诉 · {number(catalog.data.observations)} 条观测</span><span>演示数据随服务启动载入</span></div>}
      </>}
      {error && catalog && <div className="dispatch-toast" role="alert"><WarningCircle size={17} />{error}<button aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>}
    </main>
    {run && catalog && view === 'workspace' && <aside className="dispatch-right-rail">{selectedTask ? <TaskDetail task={selectedTask} run={run} catalog={catalog} onClose={() => setSelectedTaskId(null)} /> : <Supervision run={run} catalog={catalog} />}</aside>}
  </div>;
}
