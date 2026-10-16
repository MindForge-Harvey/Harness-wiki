import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CaretDown, NotePencil, ThumbsDown, ThumbsUp, Trash } from "@phosphor-icons/react";
import { updateFeedbackNote } from "../lib/api";
import { Markdown } from "../lib/markdown";

const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const previewText = text => String(text || "").replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#*`>~]/g, "").replace(/\s+/g, " ").trim();

export function FeedbackRecord({ record, onUpdated, onRemoved, onOpenSession, onDeleteRecord }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(record.note || "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(null);
  const [status, setStatus] = useState(null);
  const requestRef = useRef(null);
  const Icon = record.rating === "up" ? ThumbsUp : ThumbsDown;

  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (!status || status.error) return undefined;
    const timer = window.setTimeout(() => setStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const saveNote = async event => {
    event.preventDefault();
    if (busy || note.trim() === (record.note || "")) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy("save");
    setStatus(null);
    try {
      const saved = await updateFeedbackNote(record, note, { signal: controller.signal });
      if (controller.signal.aborted) return;
      onUpdated({ ...record, note: saved.note, updatedAt: saved.updatedAt });
      setEditing(false);
      setStatus({ text: "备注已保存" });
    } catch (error) {
      if (!controller.signal.aborted) setStatus({ error: true, text: error.message });
    } finally { if (!controller.signal.aborted) setBusy(null); }
  };

  const remove = async () => {
    if (busy) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy("delete");
    setStatus(null);
    try {
      await onDeleteRecord(record);
      if (!controller.signal.aborted) onRemoved(record);
    } catch (error) {
      if (!controller.signal.aborted) setStatus({ error: true, text: error.message });
    } finally { if (!controller.signal.aborted) setBusy(null); }
  };

  const cancelEditing = () => { if (!busy) { setEditing(false); setNote(record.note || ""); setStatus(null); } };

  return (
    <article className={`chat-feedback-record is-${record.rating}`}>
      <div className="chat-feedback-record-meta">
        <span className="chat-feedback-rating"><Icon size={13} weight="fill" aria-hidden="true" />{record.rating === "up" ? "有帮助" : "待改进"}</span>
        <time dateTime={record.updatedAt}>{dateFormat.format(new Date(record.updatedAt))}</time>
      </div>
      <details>
        <summary>
          <h3>{record.question || "这条回答"}</h3>
          <p className="chat-feedback-preview">{previewText(record.answer)}</p>
          <span className="chat-feedback-expand"><span className="when-closed">展开回答</span><span className="when-open">收起回答</span><CaretDown size={13} aria-hidden="true" /></span>
        </summary>
        <Markdown className="chat-feedback-answer">{record.answer}</Markdown>
      </details>

      {editing ? (
        <form className="chat-feedback-note-editor" onSubmit={saveNote} onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelEditing(); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.requestSubmit(); }
        }}>
          <label htmlFor={`feedback-note-${record.id}`}>我的备注</label>
          <textarea id={`feedback-note-${record.id}`} value={note} maxLength={4000} rows={3} autoFocus disabled={!!busy} placeholder="记下有用的地方，或具体哪里需要改进…" onChange={event => setNote(event.target.value)} />
          <div className="chat-feedback-note-editor-actions">
            <small>{note.length} / 4000</small>
            <button type="button" disabled={!!busy} onClick={cancelEditing}>取消编辑</button>
            <button className="is-primary" type="submit" disabled={!!busy || note.trim() === (record.note || "")}>{busy === "save" ? "保存中…" : "保存备注"}</button>
          </div>
        </form>
      ) : record.note ? (
        <div className="chat-feedback-note"><span><NotePencil size={14} aria-hidden="true" />我的备注</span><p>{record.note}</p></div>
      ) : null}

      {confirming ? (
        <div className="chat-feedback-delete-prompt" role="group" aria-label="删除反馈确认" onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) { setConfirming(false); setStatus(null); } }
        }}>
          <div><strong>删除这条反馈？</strong><p>将同步取消赞踩，原对话会保留。</p></div>
          <button type="button" autoFocus disabled={!!busy} onClick={() => { setConfirming(false); setStatus(null); }}>取消删除</button>
          <button className="is-danger" type="button" disabled={!!busy} onClick={remove}>{busy === "delete" ? "删除中…" : "确认删除"}</button>
        </div>
      ) : null}
      {status ? <p className={`chat-feedback-record-status${status.error ? " is-error" : ""}`} role={status.error ? "alert" : "status"}>{status.text}</p> : null}

      <footer>
        <span title={record.sessionTitle}>来自「{record.sessionTitle}」</span>
        <div className="chat-feedback-record-actions">
          <button type="button" disabled={!!busy || confirming || editing} onClick={() => { setNote(record.note || ""); setEditing(true); setStatus(null); }}><NotePencil size={13} aria-hidden="true" />{record.note ? "编辑备注" : "添加备注"}</button>
          <button className="is-delete" type="button" disabled={!!busy || editing || confirming} onClick={() => { setConfirming(true); setStatus(null); }}><Trash size={13} aria-hidden="true" />删除反馈</button>
          <button type="button" disabled={!!busy} onClick={() => onOpenSession({ sessionId: record.sessionId, title: record.sessionTitle })}>回到对话<ArrowUpRight size={13} aria-hidden="true" /></button>
        </div>
      </footer>
    </article>
  );
}
