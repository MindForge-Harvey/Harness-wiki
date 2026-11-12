import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowLeft,
  ArrowUp,
  CaretDown,
  CaretRight,
  CheckCircle,
  Circle,
  CircleNotch,
  CirclesThreePlus,
  ClockCounterClockwise,
  Copy,
  FileText,
  MagnifyingGlass,
  Plus,
  ShareNetwork,
  SidebarSimple,
  ListChecks,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash,
  X,
} from "@phosphor-icons/react";
import { toolLabel, taskProgress, visibleTool, groupTaskMessages, latestTaskPlan } from "../lib/task-progress.mjs";
import { agents } from "../data/agents";
import assistantHead from "../assets/assistant-head.webp";
import {
  loadSessions,
  upsertSession,
  removeSession,
  streamChat,
  fetchChatHistory,
  fetchPendingApprovals,
  decideApproval,
  submitFeedback,
  renameSession,
} from "../lib/api";
import { Markdown } from "../lib/markdown";
import SkillsLibrary from './SkillsLibrary';
import { skillTitle } from '../lib/skill-catalog.mjs';
import { assistantDelta, assistantComplete, safeToolDetails, isTruncatedToolResult } from '../lib/chat-stream.mjs';
import { createChatSessions } from '../lib/chat-sessions.mjs';

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
    return layoutGraph(entities, relations || [], 760, 380);
  }, [entities, relations]);

  if (!layout) return null;
  const sel = entities.find((n) => n.id === selected);

  return (
    <div className="kb-graph-wrap is-compact">
      <svg className="kb-graph-svg" viewBox="0 0 760 380" preserveAspectRatio="xMidYMid meet">
        {layout.edges.map((e, i) => {
          const a = layout.pos[e.source];
          const b = layout.pos[e.target];
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const showLabel = (relations || []).length <= 24 && e.description;
          const labelText = e.description.length > 12 ? `${e.description.slice(0, 12)}…` : e.description;
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
              onClick={() => setSelected(selected === n.id ? null : n.id)}
            >
              <circle cx={p.x} cy={p.y} r={6} />
              <text x={p.x} y={p.y + 18} textAnchor="middle">{label}</text>
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
  const json = card.resultJson;
  const expandable = Boolean(card.calls?.length || card.args || card.resultJson || card.resultText);
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
        <span className="chat-tool-brief">{progress.summaries.join("；")}</span>
        {expandable ? <CaretDown size={13} weight="bold" aria-hidden="true" className={open ? "is-down" : ""} /> : null}
      </Head>
      {card.name === "kb_graph_search" && card.status === "done" && json?.entities?.length
        ? <GraphCard entities={json.entities} relations={json.relations} truncated={json.is_truncated} /> : null}
      {expandable && open ? (
        <div className="chat-tool-body">
          {progress.summaries.map(summary => <p key={summary}>{summary}</p>)}
          {(card.calls || [card]).map((call, index) => <div className="chat-tool-detail" key={call.callId || index}>
            <code>{call.name}</code>
            {call.args && Object.keys(call.args).length ? <><p>输入</p><pre>{safeToolDetails(call.args)}</pre></> : null}
            {call.resultJson ? <><p>结果</p><pre>{safeToolDetails(call.resultJson)}</pre></> : null}
            {!call.resultJson && call.resultText ? <><p>结果</p><pre>{String(call.resultText).slice(0, 4000)}</pre></> : null}
          </div>)}
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
    <span
      className={`robot-avatar is-${activity}${compact ? " is-compact" : ""}${hero ? " is-hero" : ""}`}
      aria-hidden="true"
    >
      <span className="robot-avatar-orbit" />
      <span className="robot-avatar-orbit is-inner" />
      <span className="robot-avatar-portrait">
        <img src={assistantHead} alt="" />
        <span className="robot-avatar-eyelids">
          <i />
          <i />
        </span>
      </span>
      <span className="robot-avatar-scan" />
    </span>
  );
}

function AssistantMessage({ message, onFeedback, onGrow, pending = false, activityText = "" }) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const fullText = message.content || "";

  const growing = Boolean(message.streaming);
  useEffect(() => {
    if (growing) onGrow?.();
  }, [fullText, growing, onGrow]);

  const copyAnswer = async () => {
    try {
      await navigator.clipboard?.writeText(fullText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const shareAnswer = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: "无忧侠 回答", text: fullText });
        return;
      }
      await navigator.clipboard?.writeText(fullText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const rate = (value) => {
    const next = feedback === value ? null : value;
    setFeedback(next);
    if (next) onFeedback?.(message, next);
  };

  return (
    <article className={`chat-message-row is-assistant${pending ? " is-pending" : ""}`}>
      <RobotAvatar activity={pending ? "working" : "waiting"} compact />
      <div className="chat-message-stack">
        <div className="chat-message-meta">
          <strong>无忧侠</strong>
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
              </div>
            </div>
          ) : (
            <Markdown className={growing ? "is-growing" : ""}>{fullText}</Markdown>
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
              <Copy size={15} />
            </button>
            <button
              className={feedback === "up" ? "is-active" : ""}
              type="button"
              aria-label="回答有帮助"
              aria-pressed={feedback === "up"}
              title="回答有帮助"
              onClick={() => rate("up")}
            >
              <ThumbsUp size={15} />
            </button>
            <button
              className={feedback === "down" ? "is-active" : ""}
              type="button"
              aria-label="回答需改进"
              aria-pressed={feedback === "down"}
              title="回答需改进"
              onClick={() => rate("down")}
            >
              <ThumbsDown size={15} />
            </button>
            <button type="button" aria-label="分享回答" title="分享回答" onClick={shareAnswer}>
              <ShareNetwork size={15} />
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function UserMessage({ message }) {
  return (
    <article className="chat-message-row is-user">
      <div className="chat-message-stack">
        <div className="chat-message-meta">
          <strong>你</strong>
          <time>{message.time}</time>
        </div>
        <div className="chat-user-content">{message.content}</div>
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------- 执行过程抽屉 */

function TimelineDrawer({ open, onClose, timeline, activity }) {
  const tasks = latestTaskPlan([{ role: 'user' }, ...timeline.map(item => ({ ...item, role: item.kind }))]);
  const steps = groupTaskMessages(timeline.map(item => ({ ...item, role: item.kind === "tool" ? "tool" : item.kind })))
    .map(item => item.kind === "tool" ? { ...item, ...taskProgress(item), detail: taskProgress(item).summaries.join("；") } : item);
  const finished = activity !== "working" && steps.length > 0;
  const completed = steps.filter(item => item.status === "done").length;
  const pending = steps.filter(item => ["needs_data", "warning", "error"].includes(item.status)).length;

  return (
    <aside
      className={`chat-planner-drawer${open ? " is-open" : ""}`}
      aria-label="执行过程"
      aria-hidden={!open}
      inert={!open}
    >
      <header className="planner-heading">
        <div className="planner-heading-main">
          <ListChecks size={18} aria-hidden="true" />
          <div className="planner-heading-copy">
            <h2>分析过程</h2>
          </div>
        </div>
        <button type="button" aria-label="收起执行过程" title="收起" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <section className={`planner-overview is-${activity}`} aria-label="执行概览">
        <div className="planner-overview-copy">
          <span>{finished ? "本轮回答已结束" : activity === "working" ? "正在分析" : "等待新任务"}</span>
          <strong>{steps.length ? `${completed} 次调用已完成${pending ? `，${pending} 项需跟进` : ""}` : activity === "working" ? "正在整理问题与依据" : "发送工单或问题开始分析"}</strong>
        </div>
      </section>

      {tasks.length ? <section className="chat-task-plan" aria-label="任务计划">
        <h3>任务计划</h3>
        <ol>{tasks.map(task => <li key={task.content} className={`is-${task.status}`}>
          <span aria-label={{ completed: '已完成', in_progress: '进行中', pending: '待处理' }[task.status]}>
            {task.status === 'completed' ? <CheckCircle size={15} weight="fill" />
              : task.status === 'in_progress' ? <CircleNotch size={15} /> : <Circle size={15} />}
          </span><span>{task.content}</span>
        </li>)}</ol>
      </section> : null}

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

export default function AgentChat() {
  const [sessions, setSessions] = useState(loadSessions);
  const chatStoreRef = useRef(null);
  if (!chatStoreRef.current) chatStoreRef.current = createChatSessions();
  const chatStore = chatStoreRef.current;
  const { activeKey: conversationKey, views } = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot);
  const { sessionId, messages, draft, attachment, selectedSkills, isThinking, activityText, timeline, historyLoading } = views.get(conversationKey);
  const { setSessionId, setMessages, setDraft, setAttachment, setSelectedSkills, setIsThinking, setActivityText, setTimeline } = chatStore.bind(conversationKey);
  const { abortRef, assistantStreamRef, streamSerialRef, pendingUserTextRef, currentQueryIdRef, currentUserTextRef,
    sessionSeqRef, timelineIdRef, timelineCallRef, timelineApprovalRef, historyRequestRef } = chatStore.refs(conversationKey);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);

  const activity = isThinking ? "working" : attachment ? "reading" : "waiting";
  const activityLabel = isThinking ? activityText || "正在执行" : attachment ? "附件已准备" : "在线，可以开始";

  const quickPrompts = [
    { title: "解读参数", prompt: "QRxLevMin 增大有什么作用？" },
    { title: "查询工单", prompt: "6月的工单都有啥？" },
    { title: "分析网络问题", prompt: "低速率工单应怎样结合历史经验判断根因？" },
    { title: "比较优化方案", prompt: "结合历史工单比较参数调整方案，需要哪些数据？" },
  ];

  const visibleHistory = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    return query ? sessions.filter((item) => item.title.toLowerCase().includes(query)) : sessions;
  }, [sessions, historyQuery]);

  useEffect(() => {
    if (!historyOpen && !plannerOpen) return undefined;
    const closePanels = event => {
      if (event.key === 'Escape') { setHistoryOpen(false); setPlannerOpen(false); }
    };
    window.addEventListener('keydown', closePanels);
    return () => window.removeEventListener('keydown', closePanels);
  }, [historyOpen, plannerOpen]);

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
    document.title = "无忧侠 | 对话工作台";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: messages.some(m => m.streaming) ? "auto" : "smooth", block: "end" });
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
    const nextHeight = Math.min(Math.max(contentHeight, 48), 176);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = contentHeight > 176 ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setHistoryOpen(false);
        setPlannerOpen(false);
        setSkillsOpen(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  useEffect(() => () => chatStore.dispose(), [chatStore]);


  /** 追加一条过程项（tool/approval/error），返回条目 id 供后续更新状态。 */
  const pushTimelineItem = useCallback((item) => {
    const id = `tl-${++timelineIdRef.current}`;
    setTimeline((items) => [...items.slice(-80), { id, time: clockTime(), ...item }]);
    return id;
  }, [conversationKey]);

  /** 审批决定：用 callId 匹配审批桥的 pending 记录再提交。 */
  const handleDecide = useCallback(async (card, decision) => {
    const pending = await fetchPendingApprovals();
    const match =
      pending.find((p) => p.callId && card.callId && p.callId === card.callId) ||
      pending.find((p) => p.toolName === card.toolName);
    if (!match) throw new Error("审批请求已失效");
    await decideApproval(match.id, decision);
    setMessages((items) =>
      items.map((m) => (m.role === "approval" && m.approvalKey === card.approvalKey ? { ...m, status: decision === "allowed-once" ? "allowed" : "rejected" } : m)),
    );
    const tlId = timelineApprovalRef.current.get(card.approvalKey);
    if (tlId) {
      setTimeline((items) =>
        items.map((it) => (it.id === tlId ? { ...it, status: decision === "allowed-once" ? "allowed" : "rejected" } : it)),
      );
    }
  }, [conversationKey]);

  /** 点赞/点踩：带本轮 query_id 落 feedback.jsonl。 */
  const handleFeedback = useCallback((message, rating) => {
    submitFeedback({
      rating,
      ...(message.queryId ? { query_id: message.queryId } : {}),
      question: message.question || "",
      answer: (message.content || "").slice(0, 4000),
    }).catch(() => {
      // 反馈失败不打断对话；静默（按钮状态保留用户意图）
    });
  }, []);

  const handleNotification = useCallback((notification) => {
    if (notification.method === 'agent/assistant-delta') {
      const { kind, text } = notification.params || {};
      if (kind !== 'text' || !text) return;
      assistantStreamRef.current ||= `stream-${sessionSeqRef.current}-${++streamSerialRef.current}`;
      const id = assistantStreamRef.current;
      setActivityText('正在输出分析结果');
      setMessages(items => assistantDelta(items, id, text, { time: clockTime(),
        queryId: currentQueryIdRef.current, question: currentUserTextRef.current || '' }));
      return;
    }
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
      assistantStreamRef.current = null;
      return;
    }

    if (event.type === 'assistant/attempt') {
      const id = assistantStreamRef.current;
      if (id) setMessages(items => items.map(item => item.id === id ? { ...item, streaming: false } : item));
      assistantStreamRef.current = null;
      return;
    }

    if (event.type === "assistant/message") {
      const blocks = data.message?.content || [];
      const text = blocks
        .filter((b) => b && b.type === "text")
        .map((b) => b.text)
        .join("");
      const id = assistantStreamRef.current || `assistant-${event.seq}`;
      assistantStreamRef.current = null;
      if (!text) return;
      setMessages(items => assistantComplete(items, id, text, { time: clockTime(),
        queryId: currentQueryIdRef.current, question: currentUserTextRef.current || '' }));
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
            ? { ...m, status: isError ? "error" : "done", resultText: text, resultJson: json, resultTruncated: isTruncatedToolResult(text) }
            : m,
        ),
      );
      const tlId = callId ? timelineCallRef.current.get(callId) : null;
      if (tlId) {
        setTimeline((items) =>
          items.map((it) =>
            it.id === tlId ? { ...it, status: isError ? "error" : "done", resultJson: json, resultText: text, resultTruncated: isTruncatedToolResult(text) } : it,
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
    setMessages(items => items.map(item => item.role === "tool" && item.status === "running" ? { ...item, status: "interrupted" }
      : item.streaming ? { ...item, streaming: false } : item));
    setTimeline(items => items.map(item => item.kind === "tool" && item.status === "running" ? { ...item, status: "interrupted" } : item));
    abortRef.current = null;
    pendingUserTextRef.current = null;
    currentQueryIdRef.current = null;
    assistantStreamRef.current = null;
  }, [conversationKey]);

  const sendMessage = (preset) => {
    const typedContent = (typeof preset === "string" ? preset : draft).trim();
    if (!typedContent && !attachment) return;
    if (chatStore.get(conversationKey).isThinking || historyLoading) return;

    const content = typedContent || `请处理附件：${attachment.name}`;
    const timestamp = Date.now();

    historyRequestRef.current += 1;
    currentUserTextRef.current = content;
    pendingUserTextRef.current = content;
    currentQueryIdRef.current = null;
    sessionSeqRef.current += 1;

    setMessages((items) => [
      ...items,
      { id: `user-${timestamp}`, role: "user", time: clockTime(), content },
    ]);
    setDraft("");
    setAttachment(null);
    const skillsForTurn = selectedSkills;
    setSelectedSkills([]);
    setIsThinking(true);
    setTimeline([]);
    timelineCallRef.current.clear();
    timelineApprovalRef.current.clear();

    const attachmentPayload = attachment
      ? [{ name: attachment.name, data: attachment.data }]
      : undefined;

    abortRef.current = streamChat(
      { sessionId, message: content, attachments: attachmentPayload, selectedSkills: skillsForTurn },
      {
        onStart: (id) => {
          setSessionId(id);
          setSessions(upsertSession(id, content));
        },
        onProgress: (progress) => setActivityText(progress.text || '正在准备分析'),
        onRenamed: ({ from, to, restored }) => {
          setSessionId(to);
          setSessions(renameSession(from, to));
          setMessages((items) => [
            ...items,
            {
              id: `renamed-${to}`,
              role: "assistant",
              time: clockTime(),
              content: restored ? "会话已恢复，可以沿用之前的工单继续。" : "服务已重启，本会话已迁移，可以继续提问。",
            },
          ]);
        },
        onNotification: handleNotification,
        onDone: (result) => {
          if (result?.instant && result.finalResponse) {
            setMessages((items) => [...items, {
              id: `quick-${timestamp}`, role: "assistant", time: clockTime(),
              content: result.finalResponse, instant: true,
            }]);
          }
          resetTurnState();
        },
        onError: (message) => {
          resetTurnState();
          setMessages((items) => items.at(-1)?.content === `执行遇到问题：${message}` ? items : [
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
      },
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
    chatStore.newChat();
    setHistoryOpen(false);
  };

  const resumeSession = async (item) => {
    const targetKey = chatStore.create(item.sessionId);
    chatStore.activate(targetKey);
    setHistoryOpen(false);
    const target = chatStore.get(targetKey);
    if (target.historyLoaded || target.isThinking || target.historyLoading) return;
    const runtime = chatStore.refs(targetKey);
    const request = ++runtime.historyRequestRef.current;
    chatStore.patch(targetKey, { historyLoading: true });
    const events = await fetchChatHistory(item.sessionId);
    if (runtime.historyRequestRef.current !== request || chatStore.get(targetKey).isThinking) return;
    const wallTime = (ms) =>
      new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
    const restored = events.map((e) => {
        const time = typeof e.time === "number" ? wallTime(e.time) : clockTime();
        switch (e.kind) {
          case "user":
            return { id: `h-u-${e.seq}`, role: "user", time, content: e.text };
          case "assistant":
            return { id: `h-a-${e.seq}`, role: "assistant", time, content: e.text, instant: true };
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
              status: e.status || "done",
              resultText: e.resultText || "",
              resultTruncated: Boolean(e.resultTruncated),
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
    const lastUser = restored.findLastIndex(message => message.role === "user");
    const restoredTimeline = restored.slice(lastUser + 1).filter(message => ["tool", "approval"].includes(message.role))
      .map(message => ({ ...message, kind: message.role, title: message.role === "approval" ? "执行审批" : taskProgress(message).title }));
    for (const message of restoredTimeline) {
      if (message.callId) runtime.timelineCallRef.current.set(message.callId, message.id);
      if (message.approvalKey) runtime.timelineApprovalRef.current.set(message.approvalKey, message.id);
    }
    chatStore.patch(targetKey, { messages: restored, timeline: restoredTimeline, historyLoaded: true, historyLoading: false });
  };

  const deleteSession = (item) => {
    setSessions(removeSession(item.sessionId));
    if (item.sessionId === sessionId) startNewChat();
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  };

  const readAttachment = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAttachment({ name: file.name, data: String(reader.result || "").split(",")[1] || "" });
    reader.readAsDataURL(file);
  };

  const composer = (
    <footer className="chat-composer-shell" aria-label="消息输入">
      <div
        className={`chat-composer${attachment ? " has-attachment" : ""}`}
      >
        <input
          ref={fileInputRef}
          className="chat-file-input"
          type="file"
          onChange={(event) => readAttachment(event.target.files?.[0])}
        />
        {attachment ? (
          <div className="chat-attachment-chip">
            <span className="chat-attachment-icon" aria-hidden="true">
              <FileText size={15} weight="duotone" />
            </span>
            <span>{attachment.name}</span>
            <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachment(null)}>
              <X size={13} />
            </button>
          </div>
        ) : null}
        {selectedSkills.length ? <div className="chat-selected-skills" aria-label="已选 Skills">
          {selectedSkills.map(name => <button type="button" key={name} aria-label={`移除 ${skillTitle(name)}`}
            onClick={() => setSelectedSkills(items => items.filter(n => n !== name))}>{skillTitle(name)}<X size={12} /></button>)}
        </div> : null}
        <textarea
          ref={composerInputRef}
          rows={2}
          value={draft}
          aria-label="输入你的问题"
          aria-describedby="chat-composer-hint"
          placeholder="输入工单号，或按月份查询工单、分析网络问题…"
          disabled={historyLoading}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="chat-composer-controls">
          <button
            className={`chat-composer-tool is-add${attachment ? " is-active" : ""}`}
            type="button"
            aria-label="添加附件"
            title="添加附件（在对话中入库）"
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus size={20} weight="regular" />
          </button>
          <span className="chat-composer-hint" id="chat-composer-hint">Shift + Enter 换行</span>
          <button
            className={`chat-send-button${isThinking ? " is-stopping" : ""}`}
            type="button"
            disabled={historyLoading || (!isThinking && !draft.trim() && !attachment)}
            aria-label={isThinking ? "停止接收" : "发送消息"}
            title={isThinking ? "停止接收" : "发送消息"}
            onClick={isThinking ? stopResponse : () => sendMessage()}
          >
            {isThinking ? <Square size={12} weight="fill" aria-hidden="true" /> : <ArrowUp size={18} weight="bold" aria-hidden="true" />}
          </button>
        </div>
      </div>
    </footer>
  );

  return (
    <main className={`chat-page${isThinking ? " is-working" : ""}${messages.length ? " has-conversation" : " is-empty"}${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}>
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
            <a className="chat-sidebar-back" href="/" aria-label="返回首页">
              <ArrowLeft size={16} aria-hidden="true" />
              <span>无忧侠</span>
            </a>
            <button
              className="chat-sidebar-collapse"
              type="button"
              aria-label="收起侧栏"
              title="收起侧栏"
              onClick={() => {
                if (window.matchMedia('(max-width: 860px)').matches) setHistoryOpen(false);
                else setSidebarCollapsed(true);
              }}
            >
              <SidebarSimple size={18} />
            </button>
          </div>

          <nav className="chat-sidebar-tools" aria-label="工作区入口">
            <button className="chat-new-conversation" type="button" aria-current={!messages.length ? 'page' : undefined} onClick={startNewChat}>
              <span className="chat-sidebar-tool-icon" aria-hidden="true">
                <Plus size={20} weight="bold" />
              </span>
              <span>
                <strong>新对话</strong>
              </span>
              <CaretRight size={15} weight="bold" aria-hidden="true" />
            </button>
            <button type="button" disabled={isThinking} aria-haspopup="dialog" aria-expanded={skillsOpen} onClick={() => { setHistoryOpen(false); setSkillsOpen(true); }}>
              <span className="chat-sidebar-tool-icon" aria-hidden="true">
                <CirclesThreePlus size={18} weight="duotone" />
              </span>
              <span>
                <strong>Skills 库</strong>
              </span>
              <CaretRight size={15} weight="bold" aria-hidden="true" />
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
                data-running={views.get(chatStore.find(item.sessionId))?.isThinking || undefined}
                type="button"
                key={item.sessionId}
                onClick={() => resumeSession(item)}
              >
                <span className="chat-history-icon" aria-hidden="true">
                  <ClockCounterClockwise size={16} />
                </span>
                <span className="chat-history-copy">
                  <strong>{item.title}</strong>
                  {views.get(chatStore.find(item.sessionId))?.isThinking ? <span className="chat-history-running" role="status" aria-label="正在执行"><CircleNotch size={14} /></span> : null}
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
              本地会话
            </span>
            <button
              type="button"
              aria-label="清理历史对话"
              title="清理历史对话"
              onClick={() => {
                for (const item of sessions) removeSession(item.sessionId);
                setSessions([]);
                startNewChat();
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
              aria-label="打开侧栏"
              title="打开侧栏"
              onClick={() => {
                if (window.matchMedia('(max-width: 860px)').matches) setHistoryOpen(true);
                else setSidebarCollapsed(false);
              }}
            >
              <SidebarSimple size={18} />
            </button>
            <div className="chat-agent-identity">
              <div>
                <h1>{kbAgent.name}</h1>
                {isThinking ? <span className="chat-agent-status" role="status">{activityLabel}</span> : null}
              </div>
            </div>
            <button
              className="chat-planner-shortcut"
              type="button"
              aria-expanded={plannerOpen}
              onClick={() => setPlannerOpen(true)}
            >
              <ListChecks size={17} aria-hidden="true" />
              执行过程
            </button>
          </header>

          <div className={`chat-messages${messages.length ? " has-messages" : ""}`}>
            {!messages.length ? (
              <section className="chat-welcome" aria-labelledby="chat-welcome-title">
                <RobotAvatar activity={activity} hero />
                <h2 id="chat-welcome-title">你好，我是无忧侠</h2>
                {composer}
                <div className="chat-starter-grid" aria-label="快捷提问">
                  {quickPrompts.map(({ title, prompt }) => (
                    <button type="button" key={title} onClick={() => sendMessage(prompt)}>
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
                  if (message.role === "user") return <UserMessage key={message.id} message={message} />;
                  if (message.role === "tool") return <ToolCard key={message.id} card={message} />;
                  if (message.role === "approval") {
                    return <ApprovalCard key={message.id} card={message} onDecide={handleDecide} />;
                  }
                  return (
                    <AssistantMessage
                      key={message.id}
                      message={message}
                      onFeedback={handleFeedback}
                      onGrow={scrollDuringTyping}
                    />
                  );
                })}
                {isThinking && !messages.some(message => message.streaming) ? (
                  <AssistantMessage pending activityText={activityText} message={{ id: "pending", time: clockTime() }} />
                ) : null}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {messages.length ? composer : null}
        </section>

        <TimelineDrawer
          open={plannerOpen}
          onClose={() => setPlannerOpen(false)}
          timeline={timeline}
          activity={activity}
        />
      </div>

      {skillsOpen ? <SkillsLibrary selected={selectedSkills} onSelect={setSelectedSkills}
        onClose={() => { setSkillsOpen(false); requestAnimationFrame(() => composerInputRef.current?.focus()); }} /> : null}
    </main>
  );
}
