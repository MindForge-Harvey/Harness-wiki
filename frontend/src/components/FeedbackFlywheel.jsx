import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, MagnifyingGlass, ThumbsDown, ThumbsUp, X } from "@phosphor-icons/react";
import { fetchFeedbackRecords } from "../lib/api";
import { FeedbackRecord } from "./FeedbackRecord";

const filters = [
  { value: "all", label: "全部" },
  { value: "up", label: "有帮助", icon: ThumbsUp },
  { value: "down", label: "待改进", icon: ThumbsDown },
];
export function FeedbackFlywheel({ accountUid, version, onClose, onOpenSession, onDeleteRecord }) {
  const dialogRef = useRef(null);
  const [records, setRecords] = useState([]);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); previousFocus?.focus(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetchFeedbackRecords({ signal: controller.signal })
      .then(items => { if (!controller.signal.aborted) setRecords(items); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [accountUid, version, refresh]);

  const counts = useMemo(() => ({ all: records.length, up: records.filter(item => item.rating === "up").length, down: records.filter(item => item.rating === "down").length }), [records]);
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return records.filter(item => (filter === "all" || item.rating === filter)
      && (!search || `${item.question}\n${item.answer}\n${item.sessionTitle}\n${item.note || ""}`.toLocaleLowerCase().includes(search)));
  }, [records, filter, query]);

  const removeRecord = record => {
    setRecords(items => items.filter(item => item.id !== record.id));
    window.requestAnimationFrame(() => dialogRef.current?.querySelector('.chat-feedback-filters .is-active')?.focus());
  };

  return (
    <dialog
      ref={dialogRef}
      className="chat-feedback-dialog"
      aria-labelledby="feedback-dialog-title"
      aria-describedby="feedback-dialog-description"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
    >
      <header className="chat-feedback-header">
        <span className="chat-feedback-emblem" aria-hidden="true"><ArrowsClockwise size={25} weight="duotone" /></span>
        <div><span className="chat-feedback-eyebrow">我的回答反馈</span><h2 id="feedback-dialog-title">数据飞轮</h2></div>
        <button className="chat-feedback-close" type="button" aria-label="关闭数据飞轮" onClick={onClose}><X size={19} /></button>
      </header>

      <div className="chat-feedback-controls">
        <p id="feedback-dialog-description">留下有帮助的回答，也记下值得改进的地方。</p>
        <div className="chat-feedback-filter-row">
          <div className="chat-feedback-filters" role="group" aria-label="筛选反馈">
            {filters.map(({ value, label, icon: Icon }) => (
              <button key={value} type="button" className={filter === value ? "is-active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {Icon ? <Icon size={14} aria-hidden="true" /> : null}<span>{label}</span><small>{loading ? "—" : counts[value]}</small>
              </button>
            ))}
          </div>
          <label className="chat-feedback-search"><MagnifyingGlass size={16} aria-hidden="true" /><input type="search" aria-label="搜索反馈" placeholder="搜索问题、回答或备注" value={query} onChange={event => setQuery(event.target.value)} /></label>
        </div>
      </div>

      <div className="chat-feedback-body" aria-busy={loading}>
        {loading ? (
          <div className="chat-feedback-loading" role="status"><span className="sr-only">正在加载反馈记录</span>{[0, 1, 2].map(index => <div key={index} aria-hidden="true"><i /><i /><i /></div>)}</div>
        ) : error ? (
          <div className="chat-feedback-empty"><ArrowsClockwise size={30} aria-hidden="true" /><h3>反馈暂时没能加载</h3><p role="alert">{error}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>重新加载</button></div>
        ) : !visible.length ? (
          <div className="chat-feedback-empty">
            <span className="chat-feedback-empty-icon" aria-hidden="true">{records.length ? <MagnifyingGlass size={28} /> : <ThumbsUp size={30} weight="duotone" />}</span>
            <h3>{records.length ? "没有找到匹配的反馈" : "你的反馈，从这里积累"}</h3>
            <p>{records.length ? "换个关键词，或查看全部反馈。" : "在回答下方点赞或点踩，问答会保存在这里。"}</p>
            {records.length ? <button type="button" onClick={() => { setFilter("all"); setQuery(""); }}>查看全部反馈</button> : <button type="button" onClick={onClose}>回到对话</button>}
          </div>
        ) : (
          <div className="chat-feedback-records">
            {visible.map(record => <FeedbackRecord key={record.id} record={record} onUpdated={updated => setRecords(items => items.map(item => item.id === updated.id ? updated : item))} onRemoved={removeRecord} onOpenSession={onOpenSession} onDeleteRecord={onDeleteRecord} />)}
          </div>
        )}
      </div>
      <footer className="chat-feedback-footer"><span className="chat-feedback-saved-dot" aria-hidden="true" /><span>{loading ? "正在读取你的反馈" : error ? "反馈保留在原处，可稍后重试" : `${records.length} 条反馈，随时回来查看`}</span><span>仅自己可见</span></footer>
    </dialog>
  );
}
