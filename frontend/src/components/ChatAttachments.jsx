import React, { useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowDown, ArrowSquareOut, File, FilePdf, FileText, ImageSquare, X, WarningCircle } from "@phosphor-icons/react";
import { attachmentKind, formatFileSize } from "../lib/attachments.mjs";
import { appUrl } from "../lib/app-url";

export function attachmentUrl(item) {
  return item.url ? appUrl(item.url) : item.src;
}

function AttachmentStatus({ status, image = false }) {
  return <span className={`chat-attachment-status is-${status}${image ? " is-image-status" : ""}`} aria-hidden={image || undefined}>
    {status === "reading" ? <span className="chat-attachment-loading" aria-hidden="true" /> : <WarningCircle size={12} />}
    {status === "reading" ? "准备中" : "读取失败"}
  </span>;
}

export function AttachmentList({ items, onPreview, onRemove, onRetry, sent = false }) {
  return (
    <ul className={`chat-attachments${sent ? " is-sent" : ""}`} aria-label={sent ? "已发送的附件" : "待发送的附件"}>
      {items.map(item => {
        const kind = attachmentKind(item);
        const Icon = kind === "image" ? ImageSquare : kind === "pdf" ? FilePdf : kind === "text" ? FileText : File;
        const ready = !item.status || item.status === "ready";
        return (
          <li className={`chat-attachment is-${kind}${item.status === "error" ? " is-error" : ""}`} key={item.id}>
            <button type="button" className="chat-attachment-preview" disabled={!ready} onClick={() => onPreview(item)} aria-label={`预览 ${item.name}`} title={`${item.name} · ${formatFileSize(item.size)}${ready ? " · 点击预览" : ""}`}>
              <span className="chat-attachment-visual">
                {kind === "image" && ready ? <img src={attachmentUrl(item)} alt={item.name} /> : <Icon size={26} weight="duotone" />}
                {kind === "image" && ready ? <span className="chat-attachment-zoom"><ArrowSquareOut size={14} /></span> : null}
                {kind === "image" && !ready ? <AttachmentStatus status={item.status} image /> : null}
              </span>
              <span className="chat-attachment-copy">
                <strong title={item.name}>{item.name}</strong>
                {!ready ? <AttachmentStatus status={item.status} /> : <small>{formatFileSize(item.size)}<span aria-hidden="true"> · </span>{kind === "image" ? "图片" : (item.name.split(".").pop() || "文件").toUpperCase()}</small>}
              </span>
            </button>
            {item.status === "error" ? <button type="button" className="chat-attachment-retry" onClick={() => onRetry(item.id)} aria-label={`重试 ${item.name}`}><ArrowClockwise size={15} /></button> : null}
            {onRemove ? <button type="button" className="chat-attachment-remove" onClick={() => onRemove(item.id)} aria-label={`移除 ${item.name}`}><X size={13} weight="bold" /></button> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function AttachmentPreview({ item, onClose }) {
  const dialogRef = useRef(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const kind = attachmentKind(item);
  const src = attachmentUrl(item);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    dialog.querySelector(".chat-preview-close")?.focus();
    return () => dialog.close();
  }, []);
  useEffect(() => {
    if (kind !== "text") return;
    let disposed = false;
    const controller = new AbortController();
    setLoading(true);
    (async () => {
      const blob = item.file ? item.file : await fetch(src, { signal: controller.signal }).then(response => {
        if (!response.ok) throw new Error("附件暂时无法加载");
        return response.blob();
      });
      const content = await blob.slice(0, 100 * 1024).text();
      if (!disposed) setText(content + (blob.size > 100 * 1024 ? "\n\n…预览显示前 100 KB，下载可查看完整内容。" : ""));
    })().catch(e => { if (!disposed) setError(e.message); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [item, kind, src]);
  return (
    <dialog ref={dialogRef} className="chat-preview-dialog" aria-labelledby="attachment-preview-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="chat-preview-panel">
        <header className="chat-preview-header">
          <span className="chat-preview-heading"><strong id="attachment-preview-title">{item.name}</strong><small>{formatFileSize(item.size)} · 附件预览</small></span>
          <a className="chat-preview-download" href={item.url ? src + "?download=1" : src} download={item.name}><ArrowDown size={16} />下载</a>
          <button type="button" className="chat-preview-close" aria-label="关闭附件预览" onClick={onClose} autoFocus><X size={20} /></button>
        </header>
        <div className={`chat-preview-body is-${kind}`}>
          {error ? <p role="alert">{error}</p> : kind === "image" ? <img src={src} alt={item.name} onError={() => setError("图片无法预览，可下载后查看。") } />
            : kind === "pdf" ? <iframe src={src} title={`PDF 预览：${item.name}`} />
            : kind === "text" ? loading ? <p role="status">正在加载预览…</p> : <pre>{text}</pre>
            : <div className="chat-preview-unavailable"><File size={52} weight="duotone" /><strong>{item.name}</strong><p>此格式暂不支持在线预览，可以下载后打开。</p></div>}
        </div>
      </div>
    </dialog>
  );
}
