import { useEffect, useState } from 'react';
import { DownloadSimple, FileText, FileZip, FolderSimple, Check, Warning } from '@phosphor-icons/react';
import { fetchSkillFiles, skillFileUrl } from '../lib/api';

export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SkillPackageFiles({ skill }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    fetchSkillFiles(skill.id, controller.signal).then(data => { if (!controller.signal.aborted) setFiles(data); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [skill.id, skill.version, refresh]);
  return <details className="skills-package-files"><summary><FolderSimple size={17} /><span>包内文件</span><small>{skill.package.fileCount} 个</small></summary>
    <p>脚本、参考资料和附件会随技能提供给助手，目录结构保持不变。</p>
    {loading ? <p role="status">正在读取文件…</p> : error ? <div className="skills-error" role="alert">{error}<button type="button" onClick={() => setRefresh(value => value + 1)}>重试</button></div> : <ul>{files.map(file => <li key={file.path}><FileText size={15} /><code>{file.path}</code><small>{fileSize(file.size)}</small><a href={skillFileUrl(skill.id, file.path)} download aria-label={`下载 ${file.path}`}><DownloadSimple size={16} /></a></li>)}</ul>}
  </details>;
}

export function SkillArchivePreview({ preview, busy, error, onInstall, onCancel }) {
  const [replace, setReplace] = useState(false);
  const conflicts = preview.skills.filter(skill => skill.existing);
  const invalid = preview.invalid || [];
  const shared = preview.fileCount - preview.skills.reduce((sum, skill) => sum + skill.files.length, 0);
  const installable = preview.skills.length;
  const install = () => onInstall(Object.fromEntries(conflicts.map(skill => [skill.name, { id: skill.existing.id, version: skill.existing.version }])));
  return <section className="skills-archive-preview" aria-labelledby="skills-archive-title">
    <div className="skills-archive-scroll"><div className="skills-archive-heading"><span><FileZip size={25} /></span><div><small>导入预览</small><h3 id="skills-archive-title">{preview.filename}</h3></div></div>
      <p className="skills-archive-summary">识别到 <strong>{installable} 个技能</strong> · {preview.fileCount} 个文件 · {fileSize(preview.totalBytes)}{invalid.length ? <strong className="skills-archive-issue">，其中 {invalid.length} 个无法导入</strong> : null}</p>
      <p className="skills-archive-description">确认后会保存完整技能包，并启用其中的技能。脚本、资料、图片等文件会一起保留。{invalid.length ? '标记为「无法导入」的技能存在格式问题，修正后重新打包导入即可。' : ''}</p>
      <div className="skills-archive-items">{preview.skills.map(skill => <details key={skill.name} open={preview.skills.length === 1}>
        <summary><FolderSimple size={19} /><span><strong>{skill.title}</strong><code>/{skill.name}</code></span><small>{skill.files.length} 个文件{skill.existing ? ' · 将替换' : ''}</small></summary>
        <p>{skill.description}</p>{skill.modelInvocable === false ? <p className="skills-invocation-note">该技能仅通过 /{skill.name} 手动调用。</p> : null}
        <ul>{skill.files.map(file => <li key={file.path}><FileText size={14} /><code>{file.path}</code><small>{fileSize(file.size)}</small></li>)}</ul>
      </details>)}
        {invalid.map(item => <details key={item.path} className="skills-archive-invalid" open={installable === 0}>
          <summary><Warning size={19} /><span><strong>{item.extracted?.title || item.extracted?.name || item.path}</strong><code>{item.path}</code></span><small>无法导入</small></summary>
          <p className="skills-archive-issue">{item.error}</p>
          {item.extracted?.description ? <p>{item.extracted.description}</p> : null}
        </details>)}
      </div>
      {shared > 0 ? <p className="skills-archive-description">另有 {shared} 个共享文件也会保留，技能之间的相对路径引用可以继续使用。</p> : null}
      {conflicts.length ? <label className="skills-archive-replace"><input type="checkbox" checked={replace} disabled={busy} onChange={event => setReplace(event.target.checked)} /><span>替换 {conflicts.length} 个已有的同名技能<small>将更新指令和包内文件，其他技能不受影响。</small></span></label> : null}
    </div>
    <footer className="skills-editor-footer">{error ? <div className="skills-error" role="alert">{error}</div> : null}<div className="skills-footer-row"><button className="skills-archive-cancel" type="button" disabled={busy} onClick={onCancel}>取消导入</button><span className="skills-save-state">{installable === 0 ? '没有可导入的技能' : conflicts.length && !replace ? '请确认是否替换同名技能' : invalid.length ? `${invalid.length} 个技能需修正后重新导入` : '仅对当前账号生效'}</span><button className="skills-save" type="button" disabled={busy || installable === 0 || (conflicts.length > 0 && !replace)} onClick={install}>{busy ? '正在导入…' : installable === 0 ? '无可导入的技能' : `导入并启用 ${installable} 个技能`}{!busy && installable > 0 ? <Check size={16} /> : null}</button></div></footer>
  </section>;
}
