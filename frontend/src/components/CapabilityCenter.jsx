import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowUpRight, CaretDown, CaretRight, Code, StackSimple as Layers, MagnifyingGlass, Play, PuzzlePiece, X } from '@phosphor-icons/react';
import { fetchDispatchCatalog } from '../lib/api';
import '../capability-center.css';

const implementationLabels = { 'original-function': '原代码复用', 'release-adapter': '发布包场景适配', 'local-demo': '本地演示能力' };
const stateLabels = { completed: '已完成', failed: '失败', running: '运行中', queued: '排队中', cancelled: '已停止' };
function ToolDetails({ tool, catalog, onClose }) {
  const usage = catalog.usage?.[tool.id], agent = catalog.agents.find(item => item.id === tool.agentId);
  return <aside className="capability-inspector"><header><span>原子工具</span><button onClick={onClose} aria-label="关闭工具详情"><X size={18} /></button></header>
    <h2>{tool.name}</h2><code>{tool.id}</code><p>{tool.description}</p>
    <dl><dt>提供方</dt><dd>{agent.name}</dd><dt>实现方式</dt><dd>{implementationLabels[tool.implementation]}</dd><dt>执行方式</dt><dd>{tool.mode === 'simulation' ? '隔离模拟执行' : '本地真实计算与接单'}</dd><dt>调用次数</dt><dd>{usage?.calls || 0} 次</dd>{usage?.lastStatus && <><dt>最近状态</dt><dd>{stateLabels[usage.lastStatus] || usage.lastStatus}</dd></>}</dl>
    <section><h3>调用条件</h3>{tool.dependencies.length ? <ul>{tool.dependencies.map(id => <li key={id}>{catalog.capabilities.find(row => row.id === id)?.name}</li>)}</ul> : <p>可独立调用</p>}</section>
    <section><h3>输入与输出</h3><p>{tool.scopeRequired ? '需要明确网格或小区、时间窗口' : '可不指定网格范围'}</p>{Object.keys(tool.parameters.properties).length > 0 && <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>}<p>返回分析摘要、结构化数据及来源依据。</p></section>
    <section><h3>实际派发接口</h3><code>POST {tool.endpoint}</code></section>
    {tool.sourcePaths.length > 0 && <section><h3>来源</h3>{tool.sourcePaths.map(path => <code className="capability-source" key={path}>{path}</code>)}<p>发布包 v{catalog.releaseSource.version} · 数据与外部系统采用本地演示适配</p></section>}
  </aside>;
}

export default function CapabilityCenter({ catalog: initial, onLaunch, busy, hasExecution }) {
  const [catalog, setCatalog] = useState(initial), [domain, setDomain] = useState('all'), [layer, setLayer] = useState('scenarios');
  const [query, setQuery] = useState(''), [selectedScene, setSelectedScene] = useState(null), [selectedTool, setSelectedTool] = useState(null), [prompt, setPrompt] = useState('');
  const [expanded, setExpanded] = useState({ data: true, diagnosis: true, decision: true, loop: true });
  useEffect(() => { const controller = new AbortController(); fetchDispatchCatalog({ signal: controller.signal }).then(setCatalog).catch(() => {}); return () => controller.abort(); }, []);
  const groups = catalog.professionalAbilities || [], scenes = catalog.scenarios || [], domains = catalog.domains || [];
  const q = query.trim().toLowerCase();
  const domainMatches = item => domain === 'all' || item.domainId === domain;
  const toolText = id => { const tool = catalog.capabilities.find(item => item.id === id); return `${tool.name} ${tool.id} ${tool.description} ${catalog.agents.find(agent => agent.id === tool.agentId)?.name}`; };
  const matchingScenes = useMemo(() => scenes.filter(scene => domainMatches(scene) && `${scene.name} ${scene.description} ${scene.abilityIds.map(id => groups.find(group => group.id === id)?.name).join(' ')} ${scene.suggestedTools.map(toolText).join(' ')}`.toLowerCase().includes(q)), [catalog, domain, q]);
  const matchingGroups = groups.filter(group => domainMatches(group) && `${group.name} ${group.toolIds.map(toolText).join(' ')}`.toLowerCase().includes(q));
  const matchingTools = catalog.capabilities.filter(tool => {
    const inDomain = domain === 'all' || groups.some(group => group.domainId === domain && group.toolIds.includes(tool.id));
    return inDomain && `${toolText(tool.id)} ${groups.filter(group => group.toolIds.includes(tool.id)).map(group => group.name).join(' ')}`.toLowerCase().includes(q);
  });
  const chooseDomain = id => { setDomain(id); setSelectedScene(null); setSelectedTool(null); };
  const chooseScene = scene => { setSelectedScene(scene); setPrompt(scene.prompt); setSelectedTool(null); };
  const launch = () => { if (prompt.trim() && !busy) onLaunch(prompt.trim(), selectedScene.id); };
  const needsPrevious = selectedScene && ['short-review', 'rollback'].includes(selectedScene.id) && !hasExecution;
  const toolsForScene = selectedScene ? catalog.capabilities.filter(tool => selectedScene.suggestedTools.includes(tool.id)) : [];
  const renderTool = tool => <button className={`capability-tool-row ${selectedTool?.id === tool.id ? 'selected' : ''}`} key={tool.id} onClick={() => setSelectedTool(tool)}>
    <span className="capability-tool-icon"><Code size={17} /></span><span><strong>{tool.name}</strong><small>{tool.id}</small></span><span className="capability-tool-provider">{catalog.agents.find(agent => agent.id === tool.agentId)?.shortName}</span><span className="capability-tool-usage">{catalog.usage?.[tool.id]?.calls || 0} 次调用</span><CaretRight size={13} />
  </button>;
  return <div className="capability-center">
    <div className="capability-center-heading"><div><h1>能力中心</h1><p><span>{scenes.length} 个业务场景</span><i /><span>{groups.length} 项专业能力</span><i /><span>{catalog.capabilities.length} 个原子工具</span></p></div><label className="capability-search"><MagnifyingGlass size={17} /><input aria-label="搜索场景、能力或工具" placeholder="搜索场景、能力或工具" value={query} onChange={event => { setQuery(event.target.value); setSelectedScene(null); }} /></label></div>
    <div className="capability-layout"><nav className="capability-tree" aria-label="能力分类"><button className={domain === 'all' ? 'selected' : ''} onClick={() => chooseDomain('all')}><Layers size={17} />全部场景与能力</button>
      {domains.map(item => <div className="capability-tree-domain" key={item.id}><div><button className="capability-tree-expand" aria-label={`${expanded[item.id] ? '收起' : '展开'}${item.name}`} onClick={() => setExpanded(value => ({ ...value, [item.id]: !value[item.id] }))}><CaretDown size={12} className={expanded[item.id] ? '' : 'collapsed'} /></button><button className={domain === item.id ? 'selected' : ''} onClick={() => chooseDomain(item.id)}>{item.name}<small>{scenes.filter(scene => scene.domainId === item.id).length}</small></button></div>
        {expanded[item.id] && groups.filter(group => group.domainId === item.id).map(group => <button key={group.id} className="capability-tree-ability" onClick={() => { chooseDomain(item.id); setLayer('abilities'); setQuery(group.name); }}><span />{group.name}<small>{group.toolIds.length}</small></button>)}</div>)}
      <div className="capability-tree-source">发布包 v{catalog.releaseSource.version}<span>按原代码职责拆分与适配</span></div>
    </nav>
      <div className="capability-main"><div className="capability-layer-tabs" role="tablist" aria-label="能力层级">{[['scenarios', '业务场景', scenes.length], ['abilities', '专业能力', groups.length], ['tools', '原子工具', catalog.capabilities.length]].map(([id, name, count]) => <button role="tab" aria-selected={layer === id} key={id} className={layer === id ? 'selected' : ''} onClick={() => { setLayer(id); setSelectedScene(null); setSelectedTool(null); }} >{name}<span>{count}</span></button>)}</div>
        {selectedScene ? <div className="capability-scene-detail"><button className="capability-back" onClick={() => { setSelectedScene(null); setSelectedTool(null); }}><ArrowLeft size={14} />全部场景</button><div className="capability-breadcrumb">业务场景<CaretRight size={11} />{domains.find(row => row.id === selectedScene.domainId)?.name}</div><h2>{selectedScene.name}</h2><p>{selectedScene.description}</p>
          <section className="capability-launch"><label htmlFor="scene-prompt">任务目标</label><textarea id="scene-prompt" aria-label="场景任务目标" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={4000} rows={3} /><div>{needsPrevious ? <span>需先完成一次模拟执行，再选择该执行任务进行复核或回退。</span> : <span>交给 Harness 理解目标并选择实际调用步骤</span>}<button onClick={launch} disabled={busy || !prompt.trim() || needsPrevious}><Play size={14} weight="fill" />发起场景任务</button></div></section>
          <h3 className="capability-detail-label"><PuzzlePiece size={16} />专业能力</h3><div className="capability-ability-links">{selectedScene.abilityIds.map(id => { const group = groups.find(row => row.id === id); return <button key={id} onClick={() => { setSelectedScene(null); setLayer('abilities'); setQuery(group.name); setDomain('all'); }}>{group.name}<CaretRight size={12} /></button>; })}</div>
          <h3 className="capability-detail-label"><Code size={16} />可调度原子工具<span>{toolsForScene.length}</span></h3><div className="capability-tool-list">{toolsForScene.map(renderTool)}</div>
        </div> : layer === 'scenarios' ? <div className="capability-scenes">{matchingScenes.map(scene => <button className="capability-scene" key={scene.id} onClick={() => chooseScene(scene)}><span className="capability-scene-domain">{domains.find(item => item.id === scene.domainId)?.name}</span><h3>{scene.name}<ArrowUpRight size={15} /></h3><p>{scene.description}</p><div><span>{scene.abilityIds.length} 项专业能力</span><i />{scene.suggestedTools.length} 个可选工具</div></button>)}</div>
          : layer === 'abilities' ? <div className="capability-abilities">{matchingGroups.map(group => <section key={group.id}><header><span><PuzzlePiece size={17} /><strong>{group.name}</strong></span><small>{domains.find(item => item.id === group.domainId)?.name} · {group.toolIds.length} 个原子工具</small></header><div>{group.toolIds.map(id => renderTool(catalog.capabilities.find(tool => tool.id === id)))}</div></section>)}</div>
          : <div className="capability-tool-list">{matchingTools.map(renderTool)}</div>}
        {!selectedScene && !(layer === 'scenarios' ? matchingScenes : layer === 'abilities' ? matchingGroups : matchingTools).length && <div className="capability-empty">当前分类下没有匹配项<button onClick={() => { setQuery(''); setDomain('all'); }}>查看全部</button></div>}
      </div>
      {selectedTool && <ToolDetails tool={selectedTool} catalog={catalog} onClose={() => setSelectedTool(null)} />}
    </div>
  </div>;
}
