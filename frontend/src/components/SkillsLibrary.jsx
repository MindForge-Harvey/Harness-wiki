import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle, Circle, MagnifyingGlass, X } from '@phosphor-icons/react';
import { skillTitle } from '../lib/skill-catalog.mjs';
import './skills-library.css';

export default function SkillsLibrary({ selected, onSelect, onClose }) {
  const dialog = useRef(null);
  const [skills, setSkills] = useState(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); previous?.focus?.(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    fetch('/api/skills', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Skills 暂时无法读取');
      setSkills((await response.json()).skills);
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [retry]);
  const visible = (skills || []).filter(skill => [skillTitle(skill.name), skill.name, skill.description]
    .join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = name => onSelect(selected.includes(name) ? selected.filter(n => n !== name) : [...selected, name]);
  return <dialog ref={dialog} className="skills-library" aria-labelledby="skills-library-title"
    onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === dialog.current) onClose(); }}>
    <header><h2 id="skills-library-title">Skills 库 {skills ? <span>{skills.length}</span> : null}</h2>
      <button type="button" aria-label="关闭 Skills 库" onClick={onClose}><X size={20} /></button></header>
    <label className="skills-search"><MagnifyingGlass size={17} /><input aria-label="搜索 Skills" placeholder="搜索 Skills" value={query} onChange={e => setQuery(e.target.value)} /></label>
    {error ? <p role="alert">{error} <button type="button" onClick={() => setRetry(v => v + 1)}>重试</button></p> : null}
    {!skills && !error ? <p role="status">正在读取 Skills…</p> : null}
    <div className="skills-grid" role="group" aria-label="可选 Skills">
      {visible.map(skill => <button key={skill.name} type="button" className={`skill-choice${selected.includes(skill.name) ? ' is-selected' : ''}`}
        aria-pressed={selected.includes(skill.name)} aria-label={skillTitle(skill.name)} onClick={() => toggle(skill.name)}>
        <div><strong>{skillTitle(skill.name)}</strong>{selected.includes(skill.name) ? <CheckCircle size={18} weight="fill" /> : <Circle size={18} />}</div>
        <code>{skill.name}</code><p>{skill.description}</p>
      </button>)}
    </div>
    {skills && !visible.length ? <p>没有匹配的 Skills。</p> : null}
    <footer><span>已选 {selected.length} 个</span><div>
      {selected.length ? <button type="button" onClick={() => onSelect([])}>清空</button> : null}
      <button type="button" className="skills-apply" onClick={onClose}>应用到对话</button>
    </div></footer>
  </dialog>;
}
