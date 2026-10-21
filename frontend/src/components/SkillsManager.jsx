import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, CheckCircle, Code, FileArrowUp, FileText, MagnifyingGlass, Plus, PuzzlePiece, Trash, X } from '@phosphor-icons/react';
import { fetchSkills, parseSkillFile, saveSkill, deleteSkill, previewSkillArchive, installSkillArchive, discardSkillArchive } from '../lib/api';
import { Markdown } from '../lib/markdown';
import { hasSkillChanges } from '../lib/skills-draft.mjs';
import { SkillArchivePreview, SkillPackageFiles } from './SkillPackage';
import './skills-manager.css';

const emptySkill = { title: '', name: '', description: '', content: '', enabled: true };
const templates = [
  { title: '规范回答格式', name: 'answer-format', description: '用户希望把知识库回答整理成简洁、可核对的结论，或明确要求使用规范回答格式时。', content: '# 回答步骤\n\n1. 先给出直接结论，再说明依据。\n2. 涉及公司知识时先检索知识库，只使用检索到的证据。\n3. 存在多个要点时，使用简短的编号列表。\n4. 在结尾列出来源；证据不足时说明缺少哪些信息。\n\n# 输出格式\n\n## 结论\n用一至两句话回答问题。\n\n## 依据\n列出支持结论的原文要点和来源。\n\n## 待确认\n仅在信息不完整时列出需要补充的内容。' },
  { title: '整理会议纪要', name: 'meeting-notes', description: '用户提供会议记录、讨论原文或转写内容，希望整理纪要、提炼决策和行动项时。', content: '# 工作步骤\n\n1. 阅读用户提供的会议记录，识别议题、结论和行动项。\n2. 区分已经确定的决策与仍在讨论的意见。\n3. 不补写原文中没有的负责人、截止时间或承诺。\n\n# 输出格式\n\n## 会议要点\n按议题概括关键讨论。\n\n## 已确认决策\n列出明确达成共识的结论。\n\n## 行动项\n使用表格列出：事项、负责人、截止时间。未明确的信息标注「待确认」。\n\n## 待讨论问题\n保留尚未解决的分歧和需要补充的信息。' },
];

export function SkillsManager({ onClose }) {
  const dialogRef = useRef(null);
  const fileRef = useRef(null);
  const operationRef = useRef(null);
  const discardCancelRef = useRef(null);
  const importRef = useRef(null);
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [draft, setDraft] = useState(null);
  const [baseline, setBaseline] = useState('null');
  const [tab, setTab] = useState('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const [pendingAction, setPendingAction] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const [importError, setImportError] = useState('');
  const dirty = hasSkillChanges(draft, baseline);
  const confirmingDiscard = !!pendingAction && dirty;
  const enabledCount = skills.filter(skill => skill.enabled).length;
  const visible = useMemo(() => skills.filter(skill => (!onlyEnabled || skill.enabled)
    && `${skill.title}\n${skill.name}\n${skill.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [skills, query, onlyEnabled]);
  const globalMessage = importError ? { kind: 'alert', text: importError }
    : !draft && !importPreview && (error || notice) ? { kind: error ? 'alert' : 'status', text: error || notice } : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement;
    dialog.showModal();
    return () => { operationRef.current?.abort(); if (importRef.current) void discardSkillArchive(importRef.current.id).catch(() => {}); dialog.close(); previous?.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError('');
    fetchSkills({ signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      setSkills(data.skills);
      if (data.skills.length) select(data.skills[0]);
    })
      .catch(cause => { if (!controller.signal.aborted) setLoadError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!dirty) return;
    const leave = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  useEffect(() => {
    if (!confirmingDiscard) return;
    const previous = document.activeElement;
    discardCancelRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [confirmingDiscard]);

  function requestAction(run, close = false) {
    if (busy) return;
    setConfirmDelete(false);
    if (dirty) setPendingAction({ run, close });
    else { setPendingAction(null); run(); }
  }
  function select(skill, isNew = false) {
    if (importRef.current) { void discardSkillArchive(importRef.current.id).catch(() => {}); importRef.current = null; }
    setImportPreview(null);
    setImportError('');
    const next = { ...skill };
    setDraft(next); setBaseline(isNew ? 'null' : JSON.stringify(next));
    setError(''); setConflict(false); setNotice(''); setConfirmDelete(false); setPendingAction(null); setTab('edit');
  }
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setError(''); setNotice(''); setConfirmDelete(false); };
  async function operate(action) {
    const controller = new AbortController();
    operationRef.current = controller;
    setBusy(true); setError(''); setConflict(false); setNotice('');
    try { await action(controller.signal); }
    catch (cause) { if (!controller.signal.aborted) { setError(cause.message); setConflict(cause.status === 409); } }
    finally { if (!controller.signal.aborted) { setBusy(false); operationRef.current = null; } }
  }
  async function save(event) {
    event.preventDefault();
    if (busy || !draft || !dirty) return;
    await operate(async signal => {
      const saved = await saveSkill(draft, signal);
      if (signal.aborted) return;
      setSkills(items => [...items.filter(item => item.id !== saved.id), saved]);
      if (!draft.id) { setQuery(''); setOnlyEnabled(false); }
      select(saved);
      setNotice(saved.enabled ? '已保存并启用，下次提问即可使用' : '已保存，技能处于停用状态');
    });
  }
  async function remove() {
    await operate(async signal => {
      await deleteSkill(draft, signal);
      if (signal.aborted) return;
      setSkills(items => items.filter(item => item.id !== draft.id));
      setDraft(null); setBaseline('null'); setConfirmDelete(false); setNotice('技能已删除，下次提问将不再提供');
    });
  }
  async function importFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImportError('');
    await operate(async signal => {
      try {
        if (/\.zip$/i.test(file.name)) {
          if (file.size > 20 * 1024 * 1024) throw new Error('ZIP 技能包最多 20 MB');
          const preview = await previewSkillArchive(file, signal);
          if (signal.aborted) return;
          if (importRef.current) void discardSkillArchive(importRef.current.id).catch(() => {});
          importRef.current = preview; setImportPreview(preview); setDraft(null); setBaseline('null');
          return;
        }
        if (file.size > 128 * 1024) throw new Error('SKILL.md 文件过大，最多 128 KB');
        const parsed = await parseSkillFile(await file.text(), signal);
        if (!signal.aborted) select(parsed, true);
      } catch (cause) {
        // 导入失败必须醒目：落到全局横幅，而不是旧技能编辑页的 footer。
        if (!signal.aborted) setImportError(cause.message);
      }
    });
  }

  async function installArchive(replacements) {
    await operate(async signal => {
      const installed = await installSkillArchive(importPreview.id, replacements, signal);
      if (signal.aborted) return;
      importRef.current = null;
      setSkills(items => [...items.filter(item => !installed.some(skill => skill.id === item.id)), ...installed]);
      setQuery(''); setOnlyEnabled(false);
      select(installed[0]);
      setNotice(`已导入 ${installed.length} 个技能，脚本和附件已就绪`);
    });
  }
  function cancelArchive() {
    setImportError('');
    if (skills.length) select(skills[0]);
    else { if (importRef.current) void discardSkillArchive(importRef.current.id).catch(() => {}); importRef.current = null; setImportPreview(null); setError(''); }
  }

  async function reloadLatest() {
    await operate(async signal => {
      const data = await fetchSkills({ signal });
      if (signal.aborted) return;
      setSkills(data.skills);
      const latest = data.skills.find(item => item.id === draft?.id);
      if (latest) select(latest);
      else { setDraft(null); setBaseline('null'); setNotice('该技能已在其他窗口删除'); }
    });
  }

  return <dialog ref={dialogRef} className="skills-dialog" aria-labelledby="skills-title" aria-describedby="skills-description"
    onCancel={event => { event.preventDefault(); if (confirmingDiscard) setPendingAction(null); else requestAction(onClose, true); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) requestAction(onClose, true);
    }}>
    <header className="skills-header" inert={confirmingDiscard}>
      <span className="skills-emblem"><PuzzlePiece size={26} weight="duotone" /></span>
      <div><h2 id="skills-title">Skills 配置</h2><p id="skills-description">把常用方法交给助手，让每次协作更合心意。</p></div>
      <button className="skills-icon-button" type="button" aria-label="关闭 Skills 配置" disabled={busy} onClick={() => requestAction(onClose, true)}><X size={20} /></button>
    </header>
    <div className="skills-layout" inert={confirmingDiscard}>
      <aside className="skills-library" aria-label="我的技能">
        <div className="skills-library-heading"><strong>我的技能 <small>{skills.length}</small></strong><button className="skills-icon-button" type="button" title="新建技能" aria-label="新建技能" disabled={busy || loading || !!loadError} onClick={() => requestAction(() => select(emptySkill, true))}><Plus size={19} /></button></div>
        <label className="skills-search"><MagnifyingGlass size={16} /><input type="search" aria-label="搜索技能" placeholder="搜索技能" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <button type="button" className={`skills-filter${onlyEnabled ? ' is-active' : ''}`} aria-pressed={onlyEnabled} onClick={() => setOnlyEnabled(value => !value)}><span className="skills-dot" />已启用 {enabledCount}<span>{onlyEnabled ? '查看全部' : '仅看启用'}</span></button>
        <div className="skills-list" aria-busy={loading}>
          {loading ? <div className="skills-loading" role="status">正在读取技能…<i /><i /><i /></div> : loadError ? <div className="skills-list-empty"><p role="alert">{loadError}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>重新加载</button></div> : visible.length ? visible.map(skill => <button key={skill.id} type="button" disabled={busy} aria-current={draft?.id === skill.id ? 'true' : undefined} className={`skills-list-item${draft?.id === skill.id ? ' is-selected' : ''}`} onClick={() => requestAction(() => select(skill))}>
            <span className="skills-item-top"><FileText size={18} /><strong>{skill.title}</strong><span className={`skills-dot${skill.enabled ? '' : ' is-off'}`} aria-label={skill.enabled ? '已启用' : '已停用'} /></span>
            <span className="skills-item-description">{skill.description}</span><code>/{skill.name}</code>
          </button>) : <div className="skills-list-empty"><PuzzlePiece size={28} weight="light" /><p>{skills.length ? '没有匹配的技能' : '还没有配置技能'}</p><span>{skills.length ? '试试其他关键词或筛选条件' : '新建一个，或导入 ZIP / SKILL.md'}</span></div>}
        </div>
        <button className="skills-import" type="button" disabled={busy || loading || !!loadError} onClick={() => requestAction(() => fileRef.current?.click())}><FileArrowUp size={18} />导入技能包</button>
        <input ref={fileRef} type="file" accept=".zip,.md,application/zip,application/x-zip-compressed,text/markdown,text/plain" hidden onChange={importFile} />
        <p className="skills-library-note">支持 ZIP / SKILL.md<br />包含脚本、参考资料和附件</p>
      </aside>
      {importPreview ? <SkillArchivePreview key={importPreview.id} preview={importPreview} busy={busy} error={error} onInstall={installArchive} onCancel={cancelArchive} /> : draft ? <form className="skills-editor" onSubmit={save} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
        <div className="skills-editor-scroll">
          <div className="skills-editor-heading"><div><span>{draft.id ? '编辑技能' : '新建技能'}</span><h3>{draft.title || '定义你的工作方法'}</h3></div><label className="skills-enable"><span>{draft.enabled ? '启用' : '停用'}</span><input type="checkbox" role="switch" aria-label="启用技能" checked={draft.enabled} disabled={busy} onChange={event => change('enabled', event.target.checked)} /><i /></label></div>
          {draft.modelInvocable === false ? <p className="skills-invocation-note">仅手动调用：在对话中输入 /{draft.name} 使用。</p> : draft.userInvocable === false ? <p className="skills-invocation-note">由助手按需调用，不通过 /技能名 手动指定。</p> : null}
          <div className="skills-field-row">
            <label className="skills-field">技能名称<input required maxLength={60} placeholder="例如：规范回答格式" value={draft.title} disabled={busy} onChange={event => change('title', event.target.value)} /></label>
            <label className="skills-field">调用名称<span className="skills-name-input"><span aria-hidden="true">/</span><input aria-label="调用名称" aria-describedby="skill-name-hint" required maxLength={64} pattern="[A-Za-z0-9]+([ -][A-Za-z0-9]+)*" title="英文、数字、空格和连字符" placeholder="Answer Format" value={draft.name} disabled={busy} onChange={event => change('name', event.target.value)} /></span><small id="skill-name-hint">英文、数字、空格与连字符，保存时统一转为小写（Answer Format → answer-format）</small></label>
          </div>
          <label className="skills-field skills-trigger">何时使用<textarea required rows={2} maxLength={1000} placeholder="描述适用场景，助手会据此判断何时调用这个技能。" value={draft.description} disabled={busy} onChange={event => change('description', event.target.value)} /></label>
          <section className="skills-instructions" aria-labelledby="skill-instructions-label"><div className="skills-instructions-heading"><label id="skill-instructions-label" htmlFor="skill-content">技能指令 <small>Markdown</small></label><div role="group" aria-label="指令显示方式"><button type="button" className={tab === 'edit' ? 'is-active' : ''} aria-pressed={tab === 'edit'} onClick={() => setTab('edit')}>编辑</button><button type="button" className={tab === 'preview' ? 'is-active' : ''} aria-pressed={tab === 'preview'} onClick={() => setTab('preview')}>预览</button></div></div>
            <textarea id="skill-content" className={tab === 'edit' ? '' : 'is-hidden'} required={tab === 'edit'} maxLength={32000} spellCheck={false} aria-label="技能指令" placeholder={'# 工作步骤\n\n写下助手应遵循的方法、输出格式和注意事项。'} value={draft.content} disabled={busy} onChange={event => change('content', event.target.value)} />
            {tab === 'preview' ? <div className="skills-markdown">{draft.content ? <Markdown>{draft.content}</Markdown> : <p className="skills-preview-empty">写下指令后，在这里预览。</p>}</div> : null}
          </section>
          {draft.package ? <SkillPackageFiles key={draft.id + ':' + draft.version} skill={draft} /> : null}
          <p className="skills-runtime-hint"><CheckCircle size={16} />保存后，新对话和当前对话的下一次提问都会使用最新配置。</p>
        </div>
        <footer className="skills-editor-footer">
          {error ? <div className="skills-error" role="alert">{error}{conflict ? <button type="button" disabled={busy} onClick={() => requestAction(reloadLatest)}>加载最新配置</button> : null}</div> : null}
          {confirmDelete ? <div className="skills-confirm" role="alert"><span>删除后，助手将不再调用这个技能。</span><button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button><button className="is-danger" type="button" disabled={busy} onClick={remove}>{busy ? '删除中…' : '确认删除'}</button></div> : <div className="skills-footer-row">
            {draft.id ? <button className="skills-delete" type="button" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash size={16} />删除</button> : null}
            <span className="skills-save-state" role="status">{notice ? <><Check size={15} />{notice}</> : dirty ? '有未保存的修改' : draft.updatedAt ? '所有修改已保存' : ''}</span>
            <button className="skills-save" type="submit" disabled={busy || !dirty}>{busy ? '保存中…' : draft.enabled ? '保存并生效' : '保存配置'}{!busy ? <Check size={17} /> : null}</button>
          </div>}
        </footer>
      </form> : <section className="skills-welcome">
        <div className="skills-welcome-content"><span className="skills-welcome-icon"><PuzzlePiece size={42} weight="duotone" /></span><span className="skills-eyebrow">你的方法，助手来执行</span><h3>把重复的叮嘱，<br />变成一个技能。</h3><p>配置工作步骤、回答风格或输出格式。<br />启用后，助手会在合适的任务中自动调用。</p>
          <button className="skills-create" type="button" disabled={loading || !!loadError} onClick={() => select(emptySkill, true)}><Plus size={18} />新建技能</button>
          <div className="skills-starters"><span>也可以从一个模板开始</span>{templates.map(template => <button key={template.name} type="button" disabled={loading || !!loadError} onClick={() => { const existing = skills.find(skill => skill.name === template.name); select(existing || { ...template, enabled: true }, !existing); }}><span><FileText size={18} />{template.title}</span><ArrowRight size={17} /></button>)}</div>
        </div>
        <div className="skills-welcome-footer"><Code size={17} /><span>在对话中输入 <code>/技能名</code>，也可以直接指定使用。</span></div>
      </section>}
    </div>
    {globalMessage ? <div className={`skills-global-message${globalMessage.kind === 'alert' ? ' skills-error' : ''}`} role={globalMessage.kind}>{globalMessage.text}</div> : null}
    {confirmingDiscard ? <div className="skills-discard-overlay">
      <section className="skills-discard-card" role="alertdialog" aria-modal="true" aria-labelledby="skills-discard-title" aria-describedby="skills-discard-description">
        <h3 id="skills-discard-title">{pendingAction.close ? '放弃修改并关闭？' : '放弃未保存的修改？'}</h3>
        <p id="skills-discard-description">当前技能的修改尚未保存，放弃后将丢失这些内容。</p>
        <div><button ref={discardCancelRef} type="button" onClick={() => setPendingAction(null)}>继续编辑</button><button type="button" onClick={() => { const action = pendingAction; setPendingAction(null); action.run(); }}>{pendingAction.close ? '放弃并关闭' : '放弃并继续'}</button></div>
      </section>
    </div> : null}
  </dialog>;
}
