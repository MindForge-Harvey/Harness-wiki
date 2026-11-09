import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, X } from '@phosphor-icons/react';
import './demo-scenarios.css';

export default function DemoScenarios({ onClose, onStart }) {
  const dialog = useRef(null);
  const [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState('');
  const [scenario, setScenario] = useState(null);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previous?.focus?.(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    fetch('/api/wireless/demo/catalog', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('演示数据暂时无法读取');
      const result = await response.json(); setCatalog(result);
      setSelected(current => current || result.scenarios[0]?.scenario_id || '');
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController(); setScenario(null); setError('');
    fetch(`/api/wireless/demo/scenarios/${encodeURIComponent(selected)}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('场景详情暂时无法读取');
      setScenario(await response.json());
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [selected, retry]);
  const visible = catalog?.scenarios.filter(row => filter === 'all' || row.issue_type === filter) || [];
  const start = full => {
    if (!scenario) return;
    const prompt = full
      ? `请全程用简体中文，用内置合成数据完整演示「${scenario.title}」，场景 ID：${scenario.scenario_id}。先分析时序、同群对照和当前证据，再比较历史候选与反证，选择适用候选并冻结方案；然后揭示模拟执行反馈、评估效果、沉淀新版经验，再用新版本复盘候选、样本与评分的变化。请真实调用各项分析和记忆能力，保留数据缺口，不预设学习一定提升。`
      : `请全程用简体中文，分析内置合成演示场景「${scenario.title}」，场景 ID：${scenario.scenario_id}。分析时序变化、同群对照、当前证据和历史反证，比较根因假设与参数候选，说明方案适用条件和验证方法。本次只做决策前分析，暂不揭示模拟执行反馈。`;
    onClose(); onStart(prompt);
  };
  return <dialog ref={dialog} className="demo-dialog" aria-labelledby="demo-title" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === dialog.current) onClose(); }}>
    <div className="demo-dialog-content">
      <header className="demo-header"><div><span className="demo-badge">合成数据</span><h2 id="demo-title">演示场景</h2></div>
        <button type="button" className="demo-close" aria-label="关闭演示场景" onClick={onClose}><X size={20} /></button></header>
      {catalog ? <div className="demo-stats">
        <div><strong>{catalog.counts.history_traces}</strong><span>历史工单</span></div>
        <div><strong>{catalog.counts.scenarios}</strong><span>当前场景</span></div>
        <div><strong>{catalog.counts.time_series_observations.toLocaleString()}</strong><span>时序观测</span></div>
      </div> : null}
      {error ? <div className="demo-error" role="alert">{error}<button type="button" onClick={() => setRetry(r => r + 1)}>重试</button></div> : null}
      {!catalog && !error ? <p role="status">正在读取演示数据…</p> : null}
      {catalog ? <div className="demo-body">
        <div className="demo-picker">
          <select aria-label="筛选问题类型" value={filter} onChange={e => { const value = e.target.value; setFilter(value);
            const next = catalog.scenarios.find(s => value === 'all' || s.issue_type === value); if (next) setSelected(next.scenario_id); }}>
            <option value="all">全部问题</option>{[...new Set(catalog.scenarios.map(s => s.issue_type))].map(type => <option key={type}>{type}</option>)}
          </select>
          <div className="demo-case-list" role="list" aria-label="演示场景列表">{visible.map(row => <div role="listitem" key={row.scenario_id}><button type="button"
            aria-pressed={selected === row.scenario_id} className={selected === row.scenario_id ? 'is-selected' : ''} onClick={() => setSelected(row.scenario_id)}>
            <strong>{row.title}</strong><span>{row.vendor} · {row.system}</span>
          </button></div>)}</div>
        </div>
        <section className="demo-detail" aria-live="polite">
          {scenario ? <><span className="demo-issue">{scenario.issue_type}</span><h3>{scenario.title}</h3>
            <p className="demo-object">{scenario.intake.object_id} · {scenario.intake.vendor} · {scenario.intake.system} {scenario.intake.band}</p>
            <table><caption>当前观测</caption><thead><tr><th>指标</th><th>观测值</th></tr></thead><tbody>
              {scenario.observations.slice(0, 4).map(row => <tr key={row.id}><td>{row.metric}</td><td>{row.value} <span>{row.unit}</span></td></tr>)}
            </tbody></table>
            {scenario.evidence_check.quarantined.length ? <p className="demo-data-note">包含 {scenario.evidence_check.quarantined.length} 条待隔离的问题观测</p> : null}
          </> : <p role="status">正在读取场景…</p>}
        </section>
      </div> : null}
      <footer className="demo-footer"><span>模拟参数与反馈 · 不连接现场</span><div>
        <button type="button" disabled={!scenario} className="demo-secondary" onClick={() => start(false)}>分析场景</button>
        <button type="button" disabled={!scenario} className="demo-primary" onClick={() => start(true)}>演示记忆闭环<ArrowUpRight size={16} /></button>
      </div></footer>
    </div>
  </dialog>;
}
