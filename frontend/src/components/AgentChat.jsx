import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowUp,
  CaretDown,
  CaretRight,
  CheckCircle,
  ArrowsClockwise,
  ClockCounterClockwise,
  Copy,
  FileText,
  MagnifyingGlass,
  Microphone,
  ListChecks,
  FileArrowUp,
  Paperclip,
  SidebarSimple,
  Plus,
  ShareNetwork,
  StackSimple,
  Square,
  Trash,
  UserCircle,
  X,
} from "@phosphor-icons/react";
import { toolLabel, taskProgress, visibleTool, groupTaskMessages } from "../lib/task-progress.mjs";
import { useVoiceInput } from "../lib/use-voice-input";
import { appUrl } from "../lib/app-url";
import { copyText } from "../lib/copy-text.mjs";
import { useAttachments } from "../lib/use-attachments";
import { hasTransferFiles, transferFiles } from "../lib/attachments.mjs";
import { AttachmentList, AttachmentPreview } from "./ChatAttachments";
import { AnswerVoteButton } from "./AnswerVoteButton";
import { FeedbackFlywheel } from "./FeedbackFlywheel";
import assistantHead from "../assets/assistant-head.webp";
import knowledgeBook from "../assets/knowledge-book.png";
import { agents } from "../data/agents";
import {
  loadSessions,
  clearSessions,
  fetchIdentity,
  setActiveAccount,
  removeSession,
  streamChat,
  fetchChatHistory,
  fetchPendingApprovals,
  decideApproval,
  fetchAnswerVotes,
  voteOnAnswer,
  deleteFeedbackRecord,
  fetchSharedAnswer,
} from "../lib/api";
import { Markdown } from "../lib/markdown";

const kbAgent = agents[0];

/* ---------------------------------------------------------------- 工具链路辅助 */

/** tool/result 的 message.content 里取纯文本；文本在 tool-result 块的内层 content。 */
function resultText(event) {
  const blocks = event?.message?.content;
  if (!Array.isArray(blocks)) return "";
  const out = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") {
      out.push(b.text);
      continue;
    }
    if (b.type === "tool-result" && Array.isArray(b.content)) {
      for (const ib of b.content) {
        if (ib && ib.type === "text" && typeof ib.text === "string") out.push(ib.text);
      }
    }
  }
  return out.join("\n");
}

/** 尝试把工具结果文本解析为 JSON（dsh-knowledge 工具结果多为 JSON）。 */
function resultJsonOf(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- 图谱布局（移植自 dsh-knowledge client） */

function layoutGraph(entities, relations, width, height) {
  const ids = entities.map((n) => n.id);
  const idx = {};
  ids.forEach((id, i) => { idx[id] = i });
  const pos = {};
  ids.forEach((id) => {
    pos[id] = { x: width / 2 + (Math.random() - 0.5) * 240, y: height / 2 + (Math.random() - 0.5) * 240 };
  });
  const edges = (relations || []).filter(
    (r) => idx[r.source] !== undefined && idx[r.target] !== undefined && r.source !== r.target,
  );
  const K = 140;
  for (let iter = 0; iter < 150; iter++) {
    const fx = new Array(ids.length).fill(0);
    const fy = new Array(ids.length).fill(0);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        let dx = pos[ids[i]].x - pos[ids[j]].x;
        let dy = pos[ids[i]].y - pos[ids[j]].y;
        let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        if (d > 800) d = 800;
        const f = (K * K) / d;
        const ux = dx / d;
        const uy = dy / d;
        fx[i] += ux * f; fy[i] += uy * f;
        fx[j] -= ux * f; fy[j] -= uy * f;
      }
    }
    for (const e of edges) {
      const a = idx[e.source];
      const b = idx[e.target];
      const dx = pos[e.source].x - pos[e.target].x;
      const dy = pos[e.source].y - pos[e.target].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d * d) / K;
      const ux = dx / d;
      const uy = dy / d;
      fx[a] -= ux * f; fy[a] -= uy * f;
      fx[b] += ux * f; fy[b] += uy * f;
    }
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      fx[i] += (width / 2 - pos[id].x) * 0.008;
      fy[i] += (height / 2 - pos[id].y) * 0.008;
      pos[id].x += fx[i] * 0.05;
      pos[id].y += fy[i] * 0.05;
      pos[id].x = Math.max(30, Math.min(width - 30, pos[id].x));
      pos[id].y = Math.max(24, Math.min(height - 24, pos[id].y));
    }
  }
  return { pos, edges };
}

/** 工具结果里的图谱卡：kb_graph_search 的 entities/relations 渲染为 SVG 关联网络。 */
function GraphCard({ entities, relations, truncated }) {
  const [selected, setSelected] = useState(null);
  const layout = useMemo(() => {
    if (!entities?.length) return null;
    return layoutGraph(entities, relations || [], 760, 320);
  }, [entities, relations]);

  if (!layout) return null;
  const sel = entities.find((n) => n.id === selected);

  return (
    <div className="kb-graph-wrap is-compact">
      <svg className="kb-graph-svg" viewBox="0 0 760 320" preserveAspectRatio="xMidYMid meet" aria-label="知识关联图">
        {layout.edges.map((e, i) => {
          const a = layout.pos[e.source];
          const b = layout.pos[e.target];
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const description = String(e.description || "");
          const showLabel = (relations || []).length <= 24 && description;
          const labelText = description.length > 12 ? `${description.slice(0, 12)}…` : description;
          return (
            <g key={`e${i}`}>
              <line className="kb-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              <title>{`${e.source} → ${e.target}：${e.description || "（无描述）"}`}</title>
              {showLabel ? (
                <text className="kb-edge-label" x={mx} y={my - 4} textAnchor="middle">{labelText}</text>
              ) : null}
            </g>
          );
        })}
        {entities.map((n) => {
          const p = layout.pos[n.id];
          if (!p) return null;
          const label = n.id.length > 10 ? `${n.id.slice(0, 10)}…` : n.id;
          return (
            <g
              key={n.id}
              className={`kb-node${selected === n.id ? " sel" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`查看实体：${n.id}`}
              aria-pressed={selected === n.id}
              onClick={() => setSelected(selected === n.id ? null : n.id)}
              onKeyDown={event => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelected(selected === n.id ? null : n.id);
                }
              }}
            >
              <circle cx={p.x} cy={p.y} r={7} />
              <text x={p.x} y={p.y + 24} textAnchor="middle">{label}</text>
            </g>
          );
        })}
      </svg>
      <div className="kb-graph-meta">
        <span>{entities.length} 实体 · {(relations || []).length} 关系{truncated ? "（已截断）" : ""}</span>
        {sel ? (
          <span className="kb-graph-detail">
            <strong>{sel.id}</strong>
            {sel.type ? <em>{sel.type}</em> : null}
            <p>{sel.description ? sel.description.slice(0, 240) : "（此实体暂无描述）"}</p>
          </span>
        ) : (
          <span className="kb-graph-detail is-hint">点击节点查看实体描述</span>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 任务阶段 */

function ToolCard({ card }) {
  const [open, setOpen] = useState(false);
  const progress = taskProgress(card);
  const running = progress.status === "running";
  const graphCall = (card.calls || [card]).findLast(call => call.status === "done" && call.resultJson?.entities?.length);
  const json = graphCall?.resultJson || card.resultJson;
  const graphText = card.name === "kb_graph_search" && !json && card.resultText;
  const expandable = progress.summaries.length > 1 || Boolean(graphText);
  const briefs = progress.summaries.map(summary => progress.references.length ? summary.replace(/；引用：.*$/, "") : summary);
  const Head = expandable ? "button" : "div";
  return (
    <article className={`chat-tool-card is-${progress.status}${expandable && open ? " is-open" : ""}`}>
      <Head className="chat-tool-head" {...(expandable ? { type: "button", onClick: () => setOpen(v => !v), "aria-expanded": open } : {})}>
        <span className="chat-tool-spin" aria-hidden="true">
          {running ? <React.Fragment><i /><i /><i /></React.Fragment>
            : progress.status === "done" ? <CheckCircle size={14} weight="fill" />
              : progress.status === "error" ? <X size={14} /> : <ClockCounterClockwise size={14} />}
        </span>
        <strong>{progress.title}</strong>
        <span className="chat-tool-brief">{briefs.join("；")}</span>
        {expandable ? <CaretDown size={13} weight="bold" aria-hidden="true" className={open ? "is-down" : ""} /> : null}
      </Head>
      {progress.references.length ? (
        <section className="chat-source-strip" aria-label="检索来源">
          <span className="chat-source-label">检索来源 <small>{progress.references.length} 份</small></span>
          <ul>
            {progress.references.map(file => (
              <li key={file} title={file}>
                <FileText size={15} aria-hidden="true" />
                <span>{file}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {card.name === "kb_graph_search" && card.status === "done" && json?.entities?.length
        ? <GraphCard entities={json.entities} relations={json.relations} truncated={json.is_truncated} /> : null}
      {expandable && open ? (
        <div className="chat-tool-body">
          {progress.summaries.map(summary => <p key={summary}>{summary}</p>)}
          {graphText ? <p className="chat-tool-graph-text">{graphText}</p> : null}
        </div>
      ) : null}
    </article>
  );
}

/* ---------------------------------------------------------------- 审批卡 */

function ApprovalCard({ card, onDecide }) {
  const [busy, setBusy] = useState(false);
  const decided = card.status !== "pending";

  const decide = async (decision) => {
    setBusy(true);
    try {
      await onDecide(card, decision);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`chat-approval-card is-${card.status}`}>
      <div className="chat-approval-head">
        <span className="chat-approval-badge" aria-hidden="true">
          <CheckCircle size={14} weight="fill" />
        </span>
        <div>
          <strong>{decided ? (card.status === "allowed" ? "已批准" : "已拒绝") : "需要你的批准"}</strong>
          <small>{toolLabel(card.toolName)} 请求执行写操作</small>
        </div>
      </div>
      {card.reason ? <p className="chat-approval-reason">{card.reason.slice(0, 400)}</p> : null}
      {!decided ? (
        <div className="chat-approval-actions">
          <button type="button" className="is-allow" disabled={busy} onClick={() => decide("allowed-once")}>
            {busy ? "提交中…" : "批准执行"}
          </button>
          <button type="button" className="is-deny" disabled={busy} onClick={() => decide("rejected")}>
            拒绝
          </button>
        </div>
      ) : null}
    </article>
  );
}

/* ---------------------------------------------------------------- 消息气泡 */

function RobotAvatar({ activity = "waiting", compact = false, hero = false }) {
  return (
    <span className={`robot-avatar is-${activity}${compact ? " is-compact" : ""}${hero ? " is-hero" : ""}`} aria-hidden="true">
      <span className="robot-avatar-orbit" />
      <span className="robot-avatar-orbit is-inner" />
      <span className="robot-avatar-portrait">
        <img src={assistantHead} alt="" />
        <span className="robot-avatar-eyelids"><i /><i /></span>
      </span>
      <span className="robot-avatar-scan" />
    </span>
  );
}

function AssistantMessage({ message, onFeedback, onGrow, readOnly = false, pending = false, activityText = "" }) {
  const [copied, setCopied] = useState(false);
  const feedback = message.feedback || null;
  const [actionBusy, setActionBusy] = useState(null);
  const [actionStatus, setActionStatus] = useState(null);
  const [reaction, setReaction] = useState(null);
  const reactionIdRef = useRef(0);
  const reactionTimerRef = useRef(null);
  const statusTimerRef = useRef(null);
  const canAct = Number.isSafeInteger(message.seq);

  const fullText = message.content || "";

  /** 打字机渐显：新回答整段到达后逐字展开（历史/错误消息 instant 直出）。 */
  const [shown, setShown] = useState(() => (message.instant ? fullText.length : 0));
  const timerRef = useRef(null);
  useEffect(() => {
    if (message.instant || pending) return undefined;
    let cancelled = false;
    let current = 0;
    const total = fullText.length;
    const tick = () => {
      if (cancelled) return;
      current = Math.min(total, current + Math.max(2, Math.ceil((total - current) / 90)));
      setShown(current);
      if (current < total) {
        timerRef.current = window.setTimeout(tick, 16);
      }
    };
    timerRef.current = window.setTimeout(tick, 16);
    return () => {
      cancelled = true;
      window.clearTimeout(timerRef.current);
    };
    // 仅挂载时启动一次：整条消息的 content 到达后不会再变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => {
    window.clearTimeout(timerRef.current);
    window.clearTimeout(statusTimerRef.current);
    window.clearTimeout(reactionTimerRef.current);
  }, []);
  useEffect(() => {
    if (!actionStatus || actionStatus.error) return undefined;
    const timeout = window.setTimeout(() => setActionStatus(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [actionStatus]);
  const growing = shown < fullText.length;
  useEffect(() => {
    if (growing) onGrow?.();
  }, [shown, growing, onGrow]);

  const copyAnswer = async () => {
    setActionStatus(null);
    try {
      await copyText(fullText);
      setCopied(true);
      setActionStatus({ text: "回答已复制" });
      window.clearTimeout(statusTimerRef.current);
      statusTimerRef.current = window.setTimeout(() => setCopied(false), 2400);
    } catch (error) {
      setCopied(false);
      setActionStatus({ error: true, text: error.message });
    }
  };

  const rate = async (value) => {
    const next = feedback === value ? null : value;
    setActionStatus(null);
    setReaction(null);
    window.clearTimeout(reactionTimerRef.current);
    setActionBusy("feedback");
    try {
      await onFeedback(message, next);
      if (next) {
        setReaction({ value: next, id: ++reactionIdRef.current });
        reactionTimerRef.current = window.setTimeout(() => setReaction(null), 1000);
      }
      setActionStatus({ text: next === null ? "反馈已取消" : next === "up" ? "已点赞，收进数据飞轮" : "已标记待改进，收进数据飞轮" });
    } catch (error) { setActionStatus({ error: true, text: error.message }); }
    finally { setActionBusy(null); }
  };

  return (
    <article className={`chat-message-row is-assistant${pending ? " is-pending" : ""}`}>
      <RobotAvatar activity={pending ? "working" : "waiting"} compact />
      <div className="chat-message-stack">
        <div className="chat-message-meta">
          <strong>知识库助手</strong>
          <time>{message.time}</time>
        </div>
        <div className="chat-assistant-content">
          {pending ? (
            <div className="chat-thinking" role="status" aria-live="polite">
              <span className="chat-thinking-bars" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <div>
                <strong>{activityText || "正在分析问题与已有依据"}</strong>
                <span>分析阶段与依据实时更新</span>
              </div>
            </div>
          ) : (
            <Markdown className={growing ? "is-growing" : ""}>{fullText.slice(0, shown)}</Markdown>
          )}
        </div>
        {!pending && fullText && !growing ? (
          <div className="chat-message-actions" aria-label="消息操作">
            <button
              type="button"
              aria-label={copied ? "回答已复制" : "复制回答"}
              title={copied ? "已复制" : "复制回答"}
              onClick={copyAnswer}
            >
              {copied ? <CheckCircle size={15} weight="fill" /> : <Copy size={15} />}
            </button>
            {!readOnly && ["up", "down"].map(value => <AnswerVoteButton key={value} value={value} feedback={feedback} reaction={reaction} disabled={!!actionBusy || !canAct} onClick={() => rate(value)} />)}
          </div>
        ) : null}
        {actionStatus ? <p className={`chat-action-status${actionStatus.error ? " is-error" : ""}`} role={actionStatus.error ? "alert" : "status"}>{actionStatus.text}</p> : null}
      </div>
    </article>
  );
}

function UserMessage({ message, onPreview }) {
  return (
    <article className="chat-message-row is-user">
      <div className="chat-message-stack">
        <div className="chat-message-meta">
          <strong>你</strong>
          <time>{message.time}</time>
        </div>
        <div className="chat-user-content">{message.content}</div>
        {message.attachments?.length ? <AttachmentList items={message.attachments} onPreview={onPreview} sent /> : null}
      </div>
      <span className="chat-user-avatar" aria-hidden="true">
        <UserCircle size={26} weight="duotone" />
      </span>
    </article>
  );
}

/* ---------------------------------------------------------------- 任务进展抽屉 */

function TimelineDrawer({ open, onClose, timeline, activity }) {
  const steps = groupTaskMessages(timeline.map(item => ({ ...item, role: item.kind === "tool" ? "tool" : item.kind })))
    .map(item => item.kind === "tool" ? { ...item, ...taskProgress(item), detail: taskProgress(item).summaries.join("；") } : item);
  const finished = activity !== "working" && steps.length > 0;
  const completed = steps.filter(item => item.status === "done").length;
  const pending = steps.filter(item => ["pending", "warning", "error"].includes(item.status)).length;

  return (
    <aside
      className={`chat-planner-drawer${open ? " is-open" : ""}`}
      aria-label="任务进展"
      aria-hidden={!open}
      inert={!open}
    >
      <header className="planner-heading">
        <div className="planner-heading-main">
          <ListChecks size={19} aria-hidden="true" />
          <h2>任务进展</h2>
        </div>
        <button type="button" aria-label="收起任务进展" title="收起" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <section className={`planner-overview is-${activity}`} aria-label="执行概览">
        <div className="planner-overview-copy">
          <span>{finished ? "本轮回答已结束" : activity === "working" ? "正在分析" : "等待新任务"}</span>
          <strong>{steps.length ? `${completed} 个阶段已完成${pending ? `，${pending} 个阶段待确认` : ""}` : activity === "working" ? "正在整理问题与依据" : "发送问题或上传文档开始"}</strong>
        </div>
      </section>

      <ol className="chat-timeline" aria-label="执行时间线">
        {steps.length ? (
          steps.map((item) => (
            <li key={item.id} className={`chat-timeline-item is-${item.kind} is-${item.status || "info"}`}>
              <span className="chat-timeline-dot" aria-hidden="true" />
              <div className="chat-timeline-body">
                <strong>{item.title}</strong>
                {item.detail ? <p className="chat-timeline-detail">{item.detail}</p> : null}
              </div>
            </li>
          ))
        ) : (
          <li className="chat-timeline-item is-empty">这里将展示实际分析阶段、得到的结果与待补信息。</li>
        )}
      </ol>

      <footer className="planner-footer">
        <span className={`planner-live is-${activity}`} aria-hidden="true" />
        <span>{activity === "working" ? "分析结果实时更新" : "等待下一条消息"}</span>
      </footer>
    </aside>
  );
}

function clockTime() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

/* ---------------------------------------------------------------- 主组件 */

export default function AgentChat() {
  const [sessions, setSessions] = useState([]);
  const [user, setUser] = useState(null);
  const accountRef = useRef(null);
  const accountEpoch = useRef(0);
  const [sharedId, setSharedId] = useState(() => new URLSearchParams(window.location.search).get("share"));
  const [sharedLoading, setSharedLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const voiceBaseRef = useRef("");
  const voice = useVoiceInput(text => {
    const base = voiceBaseRef.current;
    setDraft(base + (base && !/\s$/.test(base) ? "\n" : "") + text);
  });
  const [historyQuery, setHistoryQuery] = useState("");
  const uploads = useAttachments();
  const { attachments } = uploads;
  const [preview, setPreview] = useState(null);
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const [isThinking, setIsThinking] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackVersion, setFeedbackVersion] = useState(0);
  const [timeline, setTimeline] = useState([]);
  const [activityText, setActivityText] = useState("");
  const messagesEndRef = useRef(null);
  const abortRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const pendingUserTextRef = useRef(null);
  const currentQueryIdRef = useRef(null);
  const currentUserTextRef = useRef(null);
  const sessionSeqRef = useRef(0);
  const historyRequestRef = useRef(0);

  const activity = isThinking ? "working" : attachments.length ? "reading" : "waiting";
  const activityLabel = isThinking ? activityText || "正在执行" : attachments.length ? "附件已准备" : "在线，可以开始";
  const hasMessages = messages.length > 0;

  const quickPrompts = [
    { title: "检索知识", icon: MagnifyingGlass, prompt: "知识库里有哪些关于报销的制度？" },
    { title: "知识库体检", icon: CheckCircle, prompt: "做一次知识库体检，看看有什么问题" },
    { title: "查看知识图谱", icon: ShareNetwork, prompt: "帮我看看「报销」相关的知识图谱" },
  ];

  const visibleHistory = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    return query ? sessions.filter((item) => item.title.toLowerCase().includes(query)) : sessions;
  }, [sessions, historyQuery]);

  useLayoutEffect(() => {
    document.documentElement.classList.add("chat-view");
    document.body.classList.add("chat-view");
    return () => {
      document.documentElement.classList.remove("chat-view");
      document.body.classList.remove("chat-view");
    };
  }, []);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "知识库助手 | 对话工作台";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    if (!sharedId || !user) return;
    let cancelled = false;
    setSharedLoading(true);
    setPageError("");
    fetchSharedAnswer(sharedId).then(share => {
      if (cancelled) return;
      setMessages([
        ...(share.question ? [{ id: "shared-question", role: "user", content: share.question }] : []),
        { id: "shared-answer", role: "assistant", content: share.answer, instant: true },
      ]);
    }).catch(error => { if (!cancelled) setPageError(error.message); })
      .finally(() => { if (!cancelled) setSharedLoading(false); });
    return () => { cancelled = true; };
  }, [sharedId, user?.uid]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isThinking]);

  /** 打字机展开期间的跟随滚动（auto 平滑无效化，避免高频 smooth 抖动）。 */
  const scrollDuringTyping = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, []);

  useLayoutEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;

    input.style.height = "0px";
    const contentHeight = input.scrollHeight;
    const nextHeight = Math.min(Math.max(contentHeight, 60), 176);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = contentHeight > 176 ? "auto" : "hidden";
  }, [draft, hasMessages]);

  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setHistoryOpen(false);
        setPlannerOpen(false);
        setFeedbackOpen(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  useEffect(() => () => abortRef.current?.(), []);

  const timelineIdRef = useRef(0);
  const timelineCallRef = useRef(new Map());
  const timelineApprovalRef = useRef(new Map());

  useEffect(() => {
    let disposed = false;
    let checking = false;
    const clearAccount = () => {
      accountEpoch.current += 1;
      historyRequestRef.current += 1;
      abortRef.current?.();
      abortRef.current = null;
      voice.cancel();
      accountRef.current = null;
      setActiveAccount(null);
      setUser(null);
      setFeedbackOpen(false);
      setFeedbackVersion(0);
      setSessions([]);
      setSessionId(null);
      setMessages([]);
      setDraft('');
      uploads.clear();
      setPreview(null);
      setTimeline([]);
      setIsThinking(false);
      setActivityText('');
      setHistoryQuery('');
      pendingUserTextRef.current = null;
      currentUserTextRef.current = null;
      currentQueryIdRef.current = null;
      timelineCallRef.current.clear();
      timelineApprovalRef.current.clear();
    };
    const check = async () => {
      if (disposed || checking) return;
      checking = true;
      const checkEpoch = accountEpoch.current;
      try {
        const next = await fetchIdentity();
        if (disposed || checkEpoch !== accountEpoch.current) return;
        if (next?.uid !== accountRef.current || !next) {
          clearAccount();
          if (!next) { setPageError('请登录后开始对话'); return; }
          accountRef.current = next.uid;
          setActiveAccount(next.uid);
          setUser(next);
          setPageError('');
          const epoch = accountEpoch.current;
          try {
            const list = await loadSessions();
            if (!disposed && epoch === accountEpoch.current) setSessions(list);
          } catch (error) { if (!disposed && epoch === accountEpoch.current) setPageError(error.message); }
        }
      } catch (error) {
        if (!disposed && checkEpoch === accountEpoch.current) { clearAccount(); setPageError(error.message); }
      } finally { checking = false; }
    };
    const invalidate = () => { clearAccount(); setPageError('正在更新登录状态…'); void check(); };
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('agent-showcase-auth') : null;
    if (channel) channel.onmessage = invalidate;
    window.addEventListener('focus', check);
    window.addEventListener('harness-auth-invalid', invalidate);
    document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(check, 10000);
    void check();
    return () => {
      disposed = true;
      abortRef.current?.();
      setActiveAccount(null);
      window.clearInterval(timer);
      channel?.close();
      window.removeEventListener('focus', check);
      window.removeEventListener('harness-auth-invalid', invalidate);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  const refreshSessions = async () => {
    const epoch = accountEpoch.current;
    try {
      const list = await loadSessions();
      if (epoch === accountEpoch.current) setSessions(list);
    } catch (error) { if (epoch === accountEpoch.current) setPageError(error.message); }
  };


  /** 追加一条过程项（tool/approval/error），返回条目 id 供后续更新状态。 */
  const pushTimelineItem = useCallback((item) => {
    const id = `tl-${++timelineIdRef.current}`;
    setTimeline((items) => [...items.slice(-80), { id, time: clockTime(), ...item }]);
    return id;
  }, []);

  /** 审批决定：用 callId 匹配审批桥的 pending 记录再提交。 */
  const handleDecide = useCallback(async (card, decision) => {
    const epoch = accountEpoch.current;
    const pending = await fetchPendingApprovals();
    const match =
      pending.find((p) => p.callId && card.callId && p.callId === card.callId) ||
      pending.find((p) => p.toolName === card.toolName);
    if (!match) throw new Error("审批请求已失效");
    await decideApproval(match.id, decision);
    if (epoch !== accountEpoch.current) return;
    setMessages((items) =>
      items.map((m) => (m.role === "approval" && m.approvalKey === card.approvalKey ? { ...m, status: decision === "allowed-once" ? "allowed" : "rejected" } : m)),
    );
    const tlId = timelineApprovalRef.current.get(card.approvalKey);
    if (tlId) {
      setTimeline((items) =>
        items.map((it) => (it.id === tlId ? { ...it, status: decision === "allowed-once" ? "allowed" : "rejected" } : it)),
      );
    }
  }, []);

  /** The server binds votes to the persisted answer and authenticated user. */
  const handleFeedback = useCallback(async (message, rating) => {
    const epoch = accountEpoch.current;
    const requestId = historyRequestRef.current;
    const savedRating = await voteOnAnswer({ sessionId, messageSeq: message.seq, rating });
    if (epoch !== accountEpoch.current) return;
    setFeedbackVersion(value => value + 1);
    if (requestId === historyRequestRef.current) setMessages(items => items.map(item => item.id === message.id ? { ...item, feedback: savedRating } : item));
  }, [sessionId]);

  const handleDeleteFeedbackRecord = useCallback(async record => {
    const epoch = accountEpoch.current;
    const requestId = historyRequestRef.current;
    await deleteFeedbackRecord(record);
    if (epoch !== accountEpoch.current || requestId !== historyRequestRef.current || record.sessionId !== sessionId) return;
    setMessages(items => items.map(item => item.role === 'assistant' && item.seq === record.messageSeq ? { ...item, feedback: null } : item));
  }, [sessionId]);

  const handleNotification = useCallback((notification) => {
    if (notification.method === "session.status") {
      return;
    }
    const event = notification.params?.event;
    if (!event || typeof event.type !== "string") return;
    const data = event.data || {};

    if (event.type === "user/message" && data.source?.kind === "user") {
      if (pendingUserTextRef.current) pendingUserTextRef.current = null;
      return;
    }

    if (event.type === "step/start") {
      setActivityText("正在分析问题与已有依据");
      return;
    }

    if (event.type === "assistant/message") {
      const blocks = data.message?.content || [];
      const text = blocks
        .filter((b) => b && b.type === "text")
        .map((b) => b.text)
        .join("");
      if (!text) return;
      setMessages((items) => [
        ...items,
        {
          id: `assistant-${event.seq}`,
          seq: event.seq,
          role: "assistant",
          time: clockTime(),
          content: text,
          queryId: currentQueryIdRef.current,
          question: currentUserTextRef.current || "",
        },
      ]);
      return;
    }

    if (event.type === "tool/call") {
      let args = {};
      try {
        args = JSON.parse(data.arguments || "{}");
      } catch { /* 模型产生的 arguments 解析失败按空对象展示 */ }
      setMessages((items) => [
        ...items,
        {
          id: `tool-${data.callId}`,
          role: "tool",
          callId: data.callId,
          name: data.name,
          args,
          argsText: typeof data.arguments === "string" ? data.arguments : JSON.stringify(args),
          status: "running",
          time: clockTime(),
        },
      ]);
      const card = { name: data.name, args, status: "running" };
      if (!visibleTool(card)) return;
      setActivityText(`正在${taskProgress(card).title}`);
      const tlId = pushTimelineItem({
        kind: "tool",
        name: data.name, args, callId: data.callId,
        title: taskProgress(card).title,
        status: "running",
      });
      if (data.callId) timelineCallRef.current.set(data.callId, tlId);
      return;
    }

    if (event.type === "tool/result") {
      const text = resultText(data);
      const block = data.message?.content?.find?.((b) => b?.type === "tool-result");
      const callId = block?.toolCallId;
      const json = resultJsonOf(text);
      if (callId && json?.query_id) currentQueryIdRef.current = json.query_id;
      const isError = Boolean(data.error || block?.isError);
      setMessages((items) =>
        items.map((m) =>
          m.role === "tool" && (!callId || m.callId === callId) && m.status === "running"
            ? { ...m, status: isError ? "error" : "done", resultText: text, resultJson: json }
            : m,
        ),
      );
      const tlId = callId ? timelineCallRef.current.get(callId) : null;
      if (tlId) {
        setTimeline((items) =>
          items.map((it) =>
            it.id === tlId ? { ...it, status: isError ? "error" : "done", resultJson: json, resultText: text } : it,
          ),
        );
      }
      return;
    }

    if (event.type === "approval/asked") {
      setMessages((items) => [
        ...items,
        {
          id: `approval-${event.seq}`,
          approvalKey: `approval-${event.seq}`,
          role: "approval",
          approvalId: data.id,
          toolName: data.toolName || "",
          callId: data.callId || "",
          reason: data.reason || "",
          status: "pending",
          time: clockTime(),
        },
      ]);
      const apTlId = pushTimelineItem({
        kind: "approval",
        title: `${toolLabel(data.toolName)} 请求审批`,
        detail: data.reason || "",
        status: "pending",
      });
      timelineApprovalRef.current.set(`approval-${event.seq}`, apTlId);
      return;
    }

    if (event.type === "approval/decided") {
      // 决定已由 handleDecide 或其他端写入；把最早仍 pending 的同名审批卡标记完成
      setMessages((items) => {
        const idx = items.findIndex((m) => m.role === "approval" && m.status === "pending");
        if (idx < 0) return items;
        const next = [...items];
        next[idx] = {
          ...next[idx],
          status: data.outcome === "allowed-once" ? "allowed" : "rejected",
        };
        return next;
      });
      setTimeline((items) => {
        const idx = items.findIndex((it) => it.kind === "approval" && it.status === "pending");
        if (idx < 0) return items;
        const next = [...items];
        next[idx] = { ...next[idx], status: data.outcome === "allowed-once" ? "allowed" : "rejected" };
        return next;
      });
      return;
    }

    if (event.type === "turn/end") {
      if (data.reason?.kind === "error") {
        const message = data.reason?.error?.message || "本轮执行失败";
        setMessages((items) => [
          ...items,
          {
            id: `turn-error-${event.seq}`,
            role: "assistant",
            time: clockTime(),
            content: `执行遇到问题：${message}`,
            instant: true,
          },
        ]);
        pushTimelineItem({ kind: "error", title: "本轮异常结束", detail: message });
      }
    }
  }, [pushTimelineItem]);

  const resetTurnState = useCallback(() => {
    setIsThinking(false);
    setActivityText("");
    setMessages(items => items.map(item => item.role === "tool" && item.status === "running" ? { ...item, status: "interrupted" } : item));
    setTimeline(items => items.map(item => item.kind === "tool" && item.status === "running" ? { ...item, status: "interrupted" } : item));
    abortRef.current = null;
    pendingUserTextRef.current = null;
    currentQueryIdRef.current = null;
  }, []);

  const sendMessage = (preset) => {
    const typedContent = (typeof preset === "string" ? preset : draft).trim();
    if (!typedContent && !attachments.length) return;
    if (isThinking || voice.active || uploads.blocked) return;
    if (!accountRef.current) { setPageError("请登录后开始对话"); return; }
    const epoch = accountEpoch.current;
    const guarded = handlers => Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, (...args) => { if (epoch === accountEpoch.current) handler(...args); }]));
    historyRequestRef.current += 1;

    const content = typedContent || `请处理${attachments.length > 1 ? "这些" : ""}附件：${attachments.map(item => item.name).join("、")}`;
    const timestamp = Date.now();

    currentUserTextRef.current = content;
    pendingUserTextRef.current = content;
    currentQueryIdRef.current = null;
    sessionSeqRef.current += 1;

    setMessages((items) => [
      ...items,
      { id: `user-${timestamp}`, role: "user", time: clockTime(), content, attachments },
    ]);
    setDraft("");
    uploads.clear();
    setIsThinking(true);
    setTimeline([]);
    timelineCallRef.current.clear();
    timelineApprovalRef.current.clear();

    const attachmentPayload = attachments.length
      ? attachments.map(({ name, data, mimeType }) => ({ name, data, mimeType }))
      : undefined;

    abortRef.current = streamChat(
      { sessionId, message: content, attachments: attachmentPayload },
      guarded({
        onStart: (id, savedAttachments) => {
          setSessionId(id);
          if (savedAttachments?.length) setMessages(items => items.map(item => item.id === `user-${timestamp}` ? { ...item, attachments: savedAttachments } : item));
          void refreshSessions();
        },
        onRenamed: ({ from, to, attachments: savedAttachments }) => {
          setSessionId(to);
          if (savedAttachments?.length) setMessages(items => items.map(item => item.id === `user-${timestamp}` ? { ...item, attachments: savedAttachments } : item));
          void refreshSessions();
          setMessages((items) => [
            ...items,
            {
              id: `renamed-${to}`,
              role: "assistant",
              time: clockTime(),
              content: "服务已重启，本会话已迁移到新会话继续。之前的上下文不会自动延续，如需引用请重新说明。",
            },
          ]);
        },
        onNotification: handleNotification,
        onDone: () => { resetTurnState(); void refreshSessions(); },
        onError: (message) => {
          resetTurnState();
          setMessages((items) => [
            ...items,
            {
              id: `error-${timestamp}`,
              role: "assistant",
              time: clockTime(),
              content: `执行遇到问题：${message}`,
              instant: true,
            },
          ]);
        },
      }),
    );
  };

  const stopResponse = () => {
    abortRef.current?.();
    resetTurnState();
    setMessages((items) => [
      ...items,
      {
        id: `stopped-${Date.now()}`,
        role: "assistant",
        time: clockTime(),
        content: "已停止接收本轮输出。服务端的执行会自然结束，你可以继续提问。",
      },
    ]);
  };

  const startNewChat = () => {
    historyRequestRef.current += 1;
    voice.cancel();
    stopResponseSilently();
    setSessionId(null);
    setMessages([]);
    setDraft("");
    uploads.clear();
    setPreview(null);
    setTimeline([]);
    timelineCallRef.current.clear();
    timelineApprovalRef.current.clear();
    setHistoryOpen(false);
    setPageError("");
    if (sharedId) {
      window.history.replaceState(null, "", appUrl("chat"));
      setSharedId(null);
    }
  };

  const stopResponseSilently = () => {
    abortRef.current?.();
    resetTurnState();
  };

  const resumeSession = async (item) => {
    const requestId = ++historyRequestRef.current;
    voice.cancel();
    stopResponseSilently();
    setSessionId(item.sessionId);
    setMessages([]);
    setDraft("");
    uploads.clear();
    setPreview(null);
    setTimeline([]);
    setHistoryOpen(false);
    setPageError("");
    if (sharedId) {
      window.history.replaceState(null, "", appUrl("chat"));
      setSharedId(null);
    }
    timelineCallRef.current.clear();
    timelineApprovalRef.current.clear();
    const [events, votes] = await Promise.all([
      fetchChatHistory(item.sessionId),
      fetchAnswerVotes(item.sessionId).catch(error => {
        if (requestId === historyRequestRef.current) setPageError("反馈状态加载失败：" + error.message);
        return {};
      }),
    ]);
    if (requestId !== historyRequestRef.current) return;
    if (!events.length) {
      setMessages([
        {
          id: `resumed-${item.sessionId}`,
          role: "assistant",
          time: clockTime(),
          content: `已切换到会话「${item.title}」，历史消息为空。继续提问即可开始。`,
          instant: true,
        },
      ]);
      return;
    }
    const wallTime = (ms) =>
      new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
    const restored = events.map((e) => {
        const time = typeof e.time === "number" ? wallTime(e.time) : clockTime();
        switch (e.kind) {
          case "user":
            return { id: `h-u-${e.seq}`, role: "user", time, content: e.text, attachments: e.attachments };
          case "assistant":
            return { id: `h-a-${e.seq}`, seq: e.seq, role: "assistant", time, content: e.text, feedback: votes[e.seq] || null, instant: true };
          case "thinking":
            return null;
          case "tool": {
            let args = {};
            try {
              args = JSON.parse(e.argsText || "{}");
            } catch {
              /* 历史 arguments 解析失败按空对象展示 */
            }
            return {
              id: `h-tool-${e.seq}`,
              role: "tool",
              callId: e.callId,
              name: e.name,
              args,
              argsText: e.argsText,
              status: e.status === "running" ? "interrupted" : e.status || "done",
              resultText: e.resultText || "",
              resultJson: e.resultJson || resultJsonOf(e.resultText),
              time,
            };
          }
          case "approval":
            return {
              id: `h-ap-${e.seq}`,
              approvalKey: e.approvalKey,
              role: "approval",
              toolName: e.toolName,
              callId: e.callId || "",
              reason: e.reason || "",
              status: e.status || "rejected",
              time,
            };
          case "error":
            return { id: `h-e-${e.seq}`, role: "assistant", time, content: `执行遇到问题：${e.message}` };
          default:
            return null;
        }
      }).filter(Boolean);
    setMessages(restored);
    const lastUser = restored.findLastIndex(message => message.role === "user");
    const restoredTimeline = restored.slice(lastUser + 1).filter(message => ["tool", "approval"].includes(message.role))
      .map(message => ({ ...message, kind: message.role, title: message.role === "approval" ? "执行审批" : taskProgress(message).title }));
    for (const item of restoredTimeline) {
      if (item.kind === "tool" && item.callId) timelineCallRef.current.set(item.callId, item.id);
      if (item.kind === "approval" && item.approvalKey) timelineApprovalRef.current.set(item.approvalKey, item.id);
    }
    setTimeline(restoredTimeline);
  };

  const deleteSession = async (item) => {
    const epoch = accountEpoch.current;
    try {
      const list = await removeSession(item.sessionId);
      if (epoch !== accountEpoch.current) return;
      setSessions(list);
      if (item.sessionId === sessionId) startNewChat();
    } catch (error) { if (epoch === accountEpoch.current) setPageError(error.message); }
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (voice.active) voice.stop();
      else sendMessage();
    }
  };

  const addFiles = files => {
    uploads.add(files);
    composerInputRef.current?.focus();
  };

  const handlePaste = event => {
    const files = transferFiles(event.clipboardData);
    if (!files.length) {
      if (/^file:\/\//m.test(event.clipboardData.getData("text/uri-list"))) {
        event.preventDefault();
        uploads.reportError("浏览器无法读取剪贴板中的本地文件路径，请将文件拖入，或点击附件按钮选择。");
      }
      return;
    }
    event.preventDefault();
    addFiles(files);
    // Preserve text included with files, while ordinary text paste keeps native behavior.
    const text = event.clipboardData.getData("text/plain");
    if (text) {
      voice.cancel();
      const input = composerInputRef.current;
      const start = input.selectionStart, end = input.selectionEnd;
      setDraft(current => current.slice(0, start) + text + current.slice(end));
      requestAnimationFrame(() => input.setSelectionRange(start + text.length, start + text.length));
    }
  };

  const composer = (
    <footer className="chat-composer-shell" aria-label="消息输入" onPaste={handlePaste}
      onDragEnter={event => {
        if (!hasTransferFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragging(true);
      }}
      onDragOver={event => { if (hasTransferFiles(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={event => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setDragging(false);
      }}
      onDrop={event => {
        if (!hasTransferFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragging(false);
        addFiles(transferFiles(event.dataTransfer));
      }}>
      <div
        className={`chat-composer${attachments.length ? " has-attachment" : ""}${dragging ? " is-dragging" : ""}${voice.active ? " is-recording" : ""}`}
      >
        <input
          ref={fileInputRef}
          className="chat-file-input"
          type="file"
          multiple
          onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; }}
        />
        {dragging ? <div className="chat-drop-overlay"><FileArrowUp size={32} weight="duotone" /><strong>松开即可添加附件</strong><span>图片、文档和其他文件 · 最多 8 个</span></div> : null}
        {attachments.length ? (
          <div className="chat-attachment-tray">
            <AttachmentList items={attachments} onPreview={setPreview} onRemove={uploads.remove} onRetry={uploads.retry} />
            {attachments.length > 1 ? <button type="button" className="chat-attachments-clear" aria-label="全部移除附件" title="全部移除附件" onClick={uploads.clear}><X size={14} /><span>全部移除</span></button> : null}
          </div>
        ) : null}
        <textarea
          ref={composerInputRef}
          rows={2}
          value={draft}
          aria-label="输入你的问题"
          aria-describedby="chat-composer-hint"
          placeholder="向知识库提问，或上传一份资料…"
          onChange={(event) => { voice.cancel(); setDraft(event.target.value); }}
          onKeyDown={handleKeyDown}
        />
        <div className="chat-composer-controls">
          <button
            className={`chat-composer-tool is-add${attachments.length ? " is-active" : ""}`}
            type="button"
            aria-label="添加附件"
            title="添加图片或文件，也可直接粘贴或拖入"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={20} weight="regular" />
          </button>
          <span className="chat-composer-hint" id="chat-composer-hint" role="status">
            {voice.active ? (
              <><span className="chat-voice-wave" aria-hidden="true"><i /><i /><i /><i /></span>{voice.status === "starting" ? "正在连接麦克风…" : voice.status === "stopping" ? "正在整理语音…" : "正在聆听，点击麦克风结束"}</>
            ) : uploads.blocked ? "附件正在准备，请等待或移除失败项" : <><span className="chat-upload-hint">{attachments.length ? `${attachments.length} 个附件` : "粘贴或拖入附件"}<span aria-hidden="true"> · </span></span>Shift + Enter 换行</>}
          </span>
          <button
            className={`chat-composer-tool is-voice${voice.active ? " is-listening" : ""}`}
            type="button"
            disabled={isThinking || voice.status === "stopping"}
            aria-label={voice.active ? "完成语音输入" : "语音输入"}
            aria-pressed={voice.active}
            title={voice.active ? "完成语音输入" : "语音输入"}
            onClick={() => {
              if (voice.active) voice.stop();
              else { voiceBaseRef.current = draft; voice.start(); }
            }}
          >
            {voice.active ? <Square size={12} weight="fill" /> : <Microphone size={19} />}
          </button>
          <button
            className={`chat-send-button${isThinking ? " is-stopping" : ""}`}
            type="button"
            disabled={!user || voice.active || (!isThinking && (uploads.blocked || (!draft.trim() && !attachments.length)))}
            aria-label={isThinking ? "停止接收" : "发送消息"}
            title={isThinking ? "停止接收" : "发送消息"}
            onClick={isThinking ? stopResponse : () => sendMessage()}
          >
            {isThinking ? <Square size={12} weight="fill" aria-hidden="true" /> : <ArrowUp size={18} weight="bold" aria-hidden="true" />}
          </button>
        </div>
      </div>
      {uploads.error ? <p className="chat-upload-error" role="alert">{uploads.error}<button type="button" aria-label="关闭附件提示" onClick={uploads.dismissError}><X size={14} /></button></p> : null}
      {voice.error ? <p className="chat-voice-error" role="alert">{voice.error}</p> : null}
    </footer>
  );

  return (
    <main className={`chat-page${isThinking ? " is-working" : ""}${messages.length ? " has-conversation" : " is-empty"}`}>
      {preview ? <AttachmentPreview key={preview.id} item={preview} onClose={() => setPreview(null)} /> : null}
      <div className="chat-workspace">
        <button
          className={`chat-drawer-backdrop${historyOpen || plannerOpen ? " is-visible" : ""}`}
          type="button"
          aria-label="关闭侧栏"
          onClick={() => {
            setHistoryOpen(false);
            setPlannerOpen(false);
          }}
        />

        <aside className={`chat-history${historyOpen ? " is-open" : ""}`} aria-label="历史对话">
          <div className="chat-sidebar-top">
            <a className="chat-sidebar-back" href="/?agent=knowledge-harness" aria-label="返回智能体首页">
              <ArrowLeft size={16} aria-hidden="true" />
              <span>返回首页</span>
            </a>
            <button
              className="chat-panel-close"
              type="button"
              aria-label="关闭历史对话"
              onClick={() => setHistoryOpen(false)}
            >
              <X size={17} />
            </button>
          </div>

          <nav className="chat-sidebar-tools" aria-label="工作区入口" data-active={feedbackOpen ? "feedback" : attachments.length ? "upload" : !hasMessages && !sharedId ? "new" : "none"}>
            <button type="button" aria-label="新对话" aria-current={!hasMessages && !sharedId && !feedbackOpen && !attachments.length ? "page" : undefined} onClick={startNewChat}>
              <span className="chat-sidebar-tool-icon" aria-hidden="true">
                <Plus size={18} />
              </span>
              <span>
                <strong>新对话</strong>
              </span>
              <CaretRight size={15} weight="bold" aria-hidden="true" />
            </button>
            <button type="button" aria-label="数据飞轮" aria-haspopup="dialog" aria-expanded={feedbackOpen} disabled={!user} onClick={() => { setHistoryOpen(false); setFeedbackOpen(true); }}>
              <span className="chat-sidebar-tool-icon" aria-hidden="true">
                <ArrowsClockwise size={18} />
              </span>
              <span>
                <strong>数据飞轮</strong>
              </span>
              <CaretRight size={15} weight="bold" aria-hidden="true" />
            </button>
            <button type="button" aria-label="上传文档" aria-pressed={!feedbackOpen && attachments.length > 0} onClick={() => { setHistoryOpen(false); fileInputRef.current?.click(); }}>
              <span className="chat-sidebar-tool-icon" aria-hidden="true">
                <FileArrowUp size={18} />
              </span>
              <span>
                <strong>上传文档</strong>
              </span>
            </button>
          </nav>

          <div className="chat-history-heading">
            <span>历史对话</span>
            <small>{sessions.length} 项</small>
          </div>
          <label className="chat-history-search">
            <MagnifyingGlass size={16} aria-hidden="true" />
            <span className="sr-only">搜索历史对话</span>
            <input
              type="search"
              placeholder="搜索对话"
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
            />
          </label>
          <nav className="chat-history-list" aria-label="最近的对话">
            {visibleHistory.map((item) => (
              <button
                className={item.sessionId === sessionId ? "is-active" : ""}
                aria-current={item.sessionId === sessionId ? "page" : undefined}
                type="button"
                key={item.sessionId}
                onClick={() => resumeSession(item)}
              >
                <span className="chat-history-icon" aria-hidden="true">
                  <ClockCounterClockwise size={16} />
                </span>
                <span className="chat-history-copy">
                  <strong>{item.title}</strong>
                  <small>{new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(item.time)}</small>
                </span>
                <Trash
                  size={15}
                  aria-hidden="true"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteSession(item);
                  }}
                />
              </button>
            ))}
            {!visibleHistory.length ? <p className="chat-history-empty">还没有历史对话。</p> : null}
          </nav>
          <div className="chat-history-footer">
            <span>
              <FileText size={16} weight="duotone" aria-hidden="true" />
              {user ? `${user.username} 的对话` : "个人对话"}
            </span>
            <button
              type="button"
              aria-label="清理历史对话"
              title="清理历史对话"
              onClick={async () => {
                const epoch = accountEpoch.current;
                try {
                  await clearSessions();
                  if (epoch !== accountEpoch.current) return;
                  setSessions([]);
                  startNewChat();
                } catch (error) { if (epoch === accountEpoch.current) setPageError(error.message); }
              }}
            >
              <Trash size={16} />
            </button>
          </div>
        </aside>

        <section className="chat-main" aria-label="智能体对话内容">
          <header className="chat-agent-header">
            <button
              className="chat-mobile-menu"
              type="button"
              aria-label="打开历史对话"
              onClick={() => setHistoryOpen(true)}
            >
              <SidebarSimple size={20} />
            </button>
            <div className="chat-agent-identity">
              <img className="chat-agent-mark" src={knowledgeBook} alt="" aria-hidden="true" draggable="false" width="46" height="46" />
              <div>
                <h1>{sharedId ? "分享的回答" : kbAgent.short}</h1>
                <div className={`chat-agent-status is-${activity}`} aria-live="polite">
                  {isThinking ? activityLabel : "知识问答与运营"}
                </div>
              </div>
            </div>
            <button
              className="chat-planner-shortcut"
              type="button"
              onClick={() => setPlannerOpen(value => !value)}
              aria-label={plannerOpen ? "收起任务进展" : "查看任务进展"}
              aria-expanded={plannerOpen}
              title="任务进展"
            >
              <ListChecks size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={`chat-messages${messages.length ? " has-messages" : ""}`}>
            {pageError && (messages.length || sharedId) ? <p className="chat-page-error" role="alert">{pageError}</p> : null}
            {sharedId ? <div className="chat-shared-notice"><span>{sharedLoading ? "正在加载分享的回答…" : "这是一条分享的问答"}</span><button type="button" onClick={startNewChat}>开始新对话</button></div> : null}
            {!messages.length && !sharedId ? (
              <section className="chat-welcome" aria-labelledby="chat-welcome-title">
                <div className="chat-welcome-heading">
                  <h2 id="chat-welcome-title">今天想了解什么？</h2>
                  <p>查阅知识，整理资料，或从图谱中找到关联。</p>
                </div>
                {pageError ? <p className="chat-page-error" role="alert">{pageError}</p> : null}
                {composer}
                <div className="chat-starter-grid" aria-label="快捷提问">
                  {quickPrompts.map(({ title, icon: Icon, prompt }) => (
                    <button type="button" key={title} onClick={() => sendMessage(prompt)} disabled={voice.active}>
                      <Icon size={17} aria-hidden="true" />
                      <span>{title}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : (
              <div className="chat-thread">
                <div className="chat-date-separator">
                  <span>今天</span>
                </div>
                {groupTaskMessages(messages).map((message) => {
                  if (message.role === "user") return <UserMessage key={message.id} message={message} onPreview={setPreview} />;
                  if (message.role === "tool") return <ToolCard key={message.id} card={message} />;
                  if (message.role === "approval") {
                    return <ApprovalCard key={message.id} card={message} onDecide={handleDecide} />;
                  }
                  return (
                    <AssistantMessage
                      key={message.id}
                      message={message}
                      onFeedback={handleFeedback}
                      readOnly={!!sharedId}
                      onGrow={scrollDuringTyping}
                    />
                  );
                })}
                {isThinking ? (
                  <AssistantMessage pending activityText={activityText} message={{ id: "pending", time: clockTime() }} />
                ) : null}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {messages.length > 0 && !sharedId ? composer : null}
        </section>

        <TimelineDrawer
          open={plannerOpen}
          onClose={() => setPlannerOpen(false)}
          timeline={timeline}
          activity={activity}
        />
      </div>

      {feedbackOpen && user ? <FeedbackFlywheel key={user.uid} accountUid={user.uid} version={feedbackVersion} onClose={() => setFeedbackOpen(false)} onOpenSession={item => { setFeedbackOpen(false); void resumeSession(item); }} onDeleteRecord={handleDeleteFeedbackRecord} /> : null}
    </main>
  );
}
