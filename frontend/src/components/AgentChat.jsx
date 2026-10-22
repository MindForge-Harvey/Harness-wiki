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
  CornersOut,
  ArrowClockwise,
  Copy,
  DownloadSimple,
  FileText,
  Files,
  MagnifyingGlass,
  Microphone,
  ListChecks,
  FileArrowUp,
  Paperclip,
  PuzzlePiece,
  SidebarSimple,
  Plus,
  ShareNetwork,
  StackSimple,
  Square,
  Trash,
  UserCircle,
  X,
} from "@phosphor-icons/react";
import { DocumentPreview, DocumentBody, documentFileUrl, previewIcon, useDocumentContent } from "./DocumentPreview";
import { toolLabel, taskProgress, visibleTool, groupTaskMessages, groupConversation, citationSources, citationPlan, linkCitations, stripOwnSourceLine } from "../lib/task-progress.mjs";
import { useVoiceInput } from "../lib/use-voice-input";
import { appUrl } from "../lib/app-url";
import { copyText } from "../lib/copy-text.mjs";
import { useAttachments } from "../lib/use-attachments";
import { hasTransferFiles, transferFiles } from "../lib/attachments.mjs";
import { AttachmentList, AttachmentPreview } from "./ChatAttachments";
import { AnswerVoteButton } from "./AnswerVoteButton";
import { FeedbackFlywheel } from "./FeedbackFlywheel";
import { SkillsManager } from "./SkillsManager";
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
  fetchDocuments,
} from "../lib/api";
import { Markdown } from "../lib/markdown";

const kbAgent = agents[0];

/** 知识库引用文件类型：与右侧预览面板支持的类型一致。 */
const SOURCE_KINDS = { docx: "Word", xlsx: "Excel", xls: "Excel", pdf: "PDF", pptx: "PPT", ppt: "PPT", md: "Markdown", txt: "文本" };

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

/**
 * 从 tool-result 文本里提取 <!--GRAPH_CONTEXT:{json}--> 并解析。
 * 后端 render 以 HTML 注释形式注入图谱结构化数据，模型忽略注释但前端可提取。
 * @returns {{entities:[{id,type,description}], relations:[{source,target,description,weight}]} | null}
 */
function extractGraphContext(text) {
  if (!text) return null;
  const m = text.match(/<!--GRAPH_CONTEXT:(.+?)-->/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    if (Array.isArray(data?.entities) && data.entities.length) return data;
    return null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- 实体类型 → 配色（vis-network 用） */

/** 常见实体类型 → 配色；未知类型自动分配到剩余调色板。 */
const ENTITY_TYPE_PALETTE = {
  concept:    { bg: "#E0F2FE",   border: "#0284C7", label: "#0C4A6E" },   // 天空蓝
  event:      { bg: "#FEF3C7",   border: "#D97706", label: "#78350F" },   // 琥珀黄
  person:     { bg: "#FCE7F3",   border: "#DB2777", label: "#831843" },   // 粉红
  org:        { bg: "#DCFCE7",   border: "#16A34A", label: "#14532D" },   // 翠绿
  company:    { bg: "#DCFCE7",   border: "#16A34A", label: "#14532D" },
  department: { bg: "#DCFCE7",   border: "#16A34A", label: "#14532D" },
  doc:        { bg: "#F3E8FF",   border: "#9333EA", label: "#581C87" },   // 紫罗兰
  document:   { bg: "#F3E8FF",   border: "#9333EA", label: "#581C87" },
  table:      { bg: "#FEF9C3",   border: "#CA8A04", label: "#713F12" },   // 亮黄（表格/技术块）
  personnel:  { bg: "#FCE7F3",   border: "#DB2777", label: "#831843" },
};
const FALLBACK_PALETTE = [
  { bg: "#F1F5F9", border: "#64748B", label: "#1E293B" }, // 灰蓝（通用）
  { bg: "#FFE4E6", border: "#E11D48", label: "#881337" },
  { bg: "#E0E7FF", border: "#4F46E5", label: "#312E81" },
  { bg: "#CCFBF1", border: "#0D9488", label: "#134E4A" },
  { bg: "#FFF7ED", border: "#EA580C", label: "#7C2D12" },
];
function paletteForType(type) {
  const t = String(type || "").toLowerCase();
  return ENTITY_TYPE_PALETTE[t] || FALLBACK_PALETTE[(hashStr(t) % FALLBACK_PALETTE.length)];
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * 图谱卡：用 vis-network 渲染交互式知识关联图。
 * 支持：节点拖拽/缩放/hover 高亮关联边、点击查看实体详情、实体类型自动配色、
 * 关系带方向箭头、度数驱动的节点大小、标签智能截断。
 */
function GraphCard({ entities, relations, truncated }) {
  const containerRef = useRef(null);
  const networkRef = useRef(null);
  const [selectedId, setSelectedId] = useState(null);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [hoverInfo, setHoverInfo] = useState(null); // { nodeId, x, y }

  // vis-network 异步加载（CDN defer），轮询直到 window.vis 可用；10 秒超时后标记失败
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let ticks = 0;
    const MAX_TICKS = 125; // 125 * 80ms = 10 秒
    const tryLoad = () => {
      if (cancelled) return;
      if (window.vis?.Network && window.vis?.DataSet) {
        setReady(true);
        return;
      }
      ticks++;
      if (ticks >= MAX_TICKS) {
        setReady(false);
        setLoadFailed(true);
        return;
      }
      timer = setTimeout(tryLoad, 80);
    };
    tryLoad();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  // vis-network 实例的生命周期：ready 后且 entities 有值时创建
  useEffect(() => {
    if (!ready || !entities?.length || !containerRef.current) return;
    const vis = window.vis;

    // ---- 节点度数（决定节点大小）----
    const degree = new Map();
    for (const e of relations || []) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }

    const nodes = new vis.DataSet(entities.map((n) => {
      const d = degree.get(n.id) || 0;
      const scale = Math.min(20, 10 + d * 1.5); // 10~20
      const p = paletteForType(n.type);
      const label = n.id.length > 8 ? `${n.id.slice(0, 8)}…` : n.id;
      return {
        id: n.id,
        label,
        title: `${n.id}${n.type ? `（${n.type}）` : ""}${n.description ? `\n${n.description}` : ""}`,
        size: scale,
        font: { size: 11, color: p.label, face: "system-ui" },
        color: { background: p.bg, border: p.border, highlight: { background: p.border, border: p.border } },
        borderWidth: 1.5,
        borderWidthSelected: 3,
        shape: "dot",
        shadow: { enabled: false, color: "rgba(15,23,42,0.15)", size: 4, x: 0, y: 2 },
      };
    }));

    const edges = new vis.DataSet((relations || []).map((e, i) => ({
      id: `e${i}`,
      from: e.source,
      to: e.target,
      title: `${e.source} → ${e.target}${e.description ? `\n${e.description}` : ""}`,
      arrows: { to: { enabled: true, scaleFactor: 0.6 } },
      color: { color: "#94A3B8", highlight: "#315efb" },
      width: 1.2,
      smooth: { enabled: true, type: "curvedCW", roundness: 0.15 },
      font: { size: 9, align: "middle", color: "#64748B" },
    })));

    const options = {
      nodes: { chosen: true },
      edges: { chosen: true },
      physics: {
        solver: "forceAtlas2Based",
        forceAtlas2Based: {
          gravitationalConstant: -200,
          centralGravity: 0.005,
          springLength: 120,
          springConstant: 0.06,
          damping: 0.4,
        },
        stabilization: { iterations: 100 },
      },
      interaction: {
        hover: true,
        tooltipDelay: 80,
        hideEdgesOnDrag: false,
        zoomView: true,
        dragView: true,
        multiselect: false,
      },
    };

    const network = new vis.Network(containerRef.current, { nodes, edges }, options);
    networkRef.current = network;

    network.on("click", (params) => {
      if (params.nodes.length) {
        setSelectedId(params.nodes[0]);
        network.focus(params.nodes[0], { animation: true, scale: 1.1 });
      } else {
        setSelectedId(null);
      }
    });
    network.on("hoverNode", (params) => {
      setHoverInfo({ nodeId: params.node, x: params.pointer.DOM.x, y: params.pointer.DOM.y });
    });
    network.on("blurNode", () => setHoverInfo(null));

    // 首次渲染后 fit 一次，让全部节点都在视野内
    setTimeout(() => network.fit({ animation: { duration: 300 } }), 120);

    return () => {
      try { network.destroy(); } catch {}
      networkRef.current = null;
    };
  }, [ready, entities, relations]);

  const sel = selectedId ? entities.find((n) => n.id === selectedId) : null;

  if (!entities?.length) return null;

  return (
    <div className="graph-card">
      <div className="graph-card-header">
        <span className="graph-card-title">知识关联图谱</span>
        <span className="graph-card-stats">
          {entities.length} 个实体 · {(relations || []).length} 条关系
          {truncated ? "（已截断）" : ""}
        </span>
      </div>
      <div className="graph-card-body">
        <div className="graph-canvas-wrap" ref={containerRef} aria-label="知识关联图" />
        {loadFailed && (
          <div className="graph-loading graph-failed">
            图谱组件加载失败，请检查网络后刷新页面重试
          </div>
        )}
        {!ready && !loadFailed && (
          <div className="graph-loading">图谱组件加载中…</div>
        )}
        {sel && (
          <div className="graph-detail-panel">
            <button className="graph-detail-close" type="button" onClick={() => setSelectedId(null)} aria-label="关闭">×</button>
            <h4>{sel.id}</h4>
            {sel.type ? (
              <span className="graph-detail-type" style={{
                background: paletteForType(sel.type).bg,
                color: paletteForType(sel.type).label,
                borderColor: paletteForType(sel.type).border,
              }}>{sel.type}</span>
            ) : null}
            <p>{sel.description ? sel.description : "（此实体暂无描述）"}</p>
            <div className="graph-detail-links">
              {(() => {
                const outgoing = (relations || []).filter((r) => r.source === sel.id);
                const incoming = (relations || []).filter((r) => r.target === sel.id);
                return (
                  <>
                    {outgoing.length > 0 && (
                      <div className="graph-detail-group">
                        <strong>出发（{outgoing.length}）</strong>
                        {outgoing.map((r, i) => (
                          <div key={i} className="graph-detail-link" onClick={() => setSelectedId(r.target)}>
                            → {r.target}
                            {r.description ? <em>{r.description}</em> : null}
                          </div>
                        ))}
                      </div>
                    )}
                    {incoming.length > 0 && (
                      <div className="graph-detail-group">
                        <strong>指向（{incoming.length}）</strong>
                        {incoming.map((r, i) => (
                          <div key={i} className="graph-detail-link" onClick={() => setSelectedId(r.source)}>
                            ← {r.source}
                            {r.description ? <em>{r.description}</em> : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        )}
      </div>
      <div className="graph-card-footer">
        <span>点击节点查看详情 · 拖拽移动 · 滚轮缩放</span>
        {(() => {
          const typeLabels = [...new Set(entities.map((e) => e.type).filter(Boolean))];
          if (!typeLabels.length) return null;
          return (
            <span className="graph-legend">
              {typeLabels.map((t) => {
                const p = paletteForType(t);
                return (
                  <span key={t} className="graph-legend-item">
                    <span className="graph-legend-dot" style={{ background: p.bg, borderColor: p.border }} />
                    {t}
                  </span>
                );
              })}
            </span>
          );
        })()}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 执行过程 */

const formatDuration = ms => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`);

const firstLine = (text, limit = 48) => {
  const line = String(text || "").split("\n").map(part => part.trim()).find(Boolean) || "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};

/** 过程里的单条：推理、旁白、工具阶段、审批或异常，点击展开明细。 */
function ProcessStep({ step }) {
  const [open, setOpen] = useState(false);
  const parts = step.role === "note" ? step.parts : [];
  const narration = parts.findLast(part => part.role === "assistant");
  const tool = step.role === "tool" ? taskProgress(step) : null;
  const status = tool ? tool.status
    : step.role === "error" ? "error"
      : step.role === "compaction" ? (step.status === "running" ? "running" : step.status === "error" ? "error" : "done")
        : step.role === "approval" ? (step.status === "pending" ? "running" : "done") : "done";
  const title = step.role === "note" ? "思考"
    : step.role === "approval" ? `执行审批 · ${toolLabel(step.toolName)}`
      : step.role === "error" ? (step.title || "本轮异常结束")
        : step.role === "compaction" ? "压缩上下文"
          : step.role === "tool" ? tool.title : "处理资料";
  const brief = step.role === "note" ? firstLine(narration?.content || parts.at(-1)?.text, 44)
    : step.role === "approval" ? (step.status === "allowed" ? "已批准" : step.status === "rejected" ? "已拒绝" : "等待你的决定")
      : step.role === "error" ? firstLine(step.message, 44)
        : step.role === "compaction" ? (step.status === "error" ? firstLine(step.message, 44) : "整理较早的对话，保持后续回答可用")
          : tool && tool.status === "error" && step.calls.length > 1 ? `连续 ${step.calls.length} 次未成功`
            : tool && step.calls.length > 1 ? `${tool.brief} 等 ${step.calls.length} 项`
              : tool ? tool.brief || tool.summaries[0] : "";
  const detail = step.role === "note" ? parts.map(part => part.role === "assistant" ? part.content : part.text).join("\n\n")
    : step.role === "approval" ? step.reason
      : step.role === "error" ? step.message
        : step.role === "compaction" ? (step.message || "")
          : tool ? tool.detail : "";
  const references = tool?.references || [];
  const expandable = Boolean(detail) || references.length > 0;

  return (
    <li className={`chat-process-step is-${status}`}>
      <button className="chat-process-step-head" type="button" disabled={!expandable} aria-expanded={expandable ? open : undefined} onClick={() => setOpen(value => !value)}>
        <span className="chat-process-dot" aria-hidden="true">
          {status === "running" ? <React.Fragment><i /><i /><i /></React.Fragment>
            : status === "error" ? <X size={11} /> : status === "done" ? <CheckCircle size={12} weight="fill" /> : <ClockCounterClockwise size={11} />}
        </span>
        <strong>{title}</strong>
        {brief ? <span className="chat-process-brief">{brief}</span> : null}
        {expandable ? <CaretDown size={12} weight="bold" aria-hidden="true" className={open ? "is-down" : ""} /> : null}
      </button>
      {expandable && open ? (
        <div className="chat-process-detail">
          {detail ? <p>{detail}</p> : null}
          {references.length ? (
            <ul className="chat-process-refs">
              {references.map(file => <li key={file}><FileText size={13} aria-hidden="true" /><span>{file}</span></li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** 一轮执行过程：运行中展开显示当前步骤，完成后收成一行摘要。 */
function ProcessBlock({ block, live, activityText }) {
  const [open, setOpen] = useState(Boolean(live));
  const listRef = useRef(null);
  // 运行中自动展开，本轮结束后自动收成一行摘要。
  useEffect(() => { setOpen(Boolean(live)); }, [live]);
  const running = block.running || live;
  const duration = block.end > block.start ? formatDuration(block.end - block.start) : "";
  const summary = running ? (activityText || "正在处理…") : `已完成 ${block.steps.length} 个步骤`;
  // 运行中始终展示最新一步。
  useEffect(() => {
    if (running && open) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [running, open, block.steps.length]);

  return (
    <section className={`chat-process${open ? " is-open" : ""}${running ? " is-running" : ""}`} aria-label="执行过程">
      <button className="chat-process-head" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="chat-process-state" aria-hidden="true">
          {running ? <span className="chat-tool-spin"><i /><i /><i /></span> : <CheckCircle size={15} weight="fill" />}
        </span>
        <span className="chat-process-summary">{summary}</span>
        {!running && duration ? <span className="chat-process-duration">{duration}</span> : null}
        <CaretDown size={13} weight="bold" aria-hidden="true" className={open ? "is-down" : ""} />
      </button>
      {open ? (
        <ol className="chat-process-list" ref={listRef}>
          {block.steps.map((step, index) => <ProcessStep key={step.id || `step-${index}`} step={step} />)}
        </ol>
      ) : null}
    </section>
  );
}

/**
 * 取本轮最终回答要展示的图谱：回答前面最近的执行过程块里，
 * 关系最完整的那次检索结果（lightrag_query_data 的 graphContext，
 * 或模型显式调用 kb_graph_search 返回的 resultJson）。
 * 一轮可能检索多次，取关系最多的一张，避免选到只有孤立点的结果。
 * @param {Array<object>} conversation groupConversation 产出的渲染项
 * @param {number} answerIndex 最终回答在渲染项中的下标
 * @returns {{entities: Array<object>, relations: Array<object>, is_truncated?: boolean} | null}
 */
function graphOfTurn(conversation, answerIndex) {
  for (let i = answerIndex - 1; i >= 0; i -= 1) {
    const item = conversation[i];
    if (item.role === "user") break;
    if (item.role !== "process") continue;
    let best = null;
    for (const step of item.steps || []) {
      if (step.role !== "tool" || step.status !== "done") continue;
      const ctx = step.name === "kb_graph_search"
        ? (step.calls?.find(call => call.resultJson?.entities?.length)?.resultJson || step.resultJson)
        : (step.calls?.findLast?.(call => call.graphContext?.entities?.length)?.graphContext || step.graphContext);
      if (!ctx?.entities?.length) continue;
      if (!best || (ctx.relations?.length || 0) > (best.relations?.length || 0)) best = ctx;
    }
    return best;
  }
  return null;
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

function AssistantMessage({ message, sources = [], graph = null, onFeedback, onOpenSource, onGrow, readOnly = false, pending = false, activityText = "", instant = message.instant }) {
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
  // 模型自写的结尾来源行由自动清单取代；角标编号只覆盖回答真正引用的文件，保证与底部清单一一对应。
  const displayText = useMemo(() => (sources.length ? stripOwnSourceLine(fullText) : fullText), [fullText, sources]);
  const plan = useMemo(() => citationPlan(displayText, sources), [displayText, sources]);

  /** 打字机渐显：仅本轮执行中的新回答逐字展开；历史、错误与切回会话直出。 */
  const [shown, setShown] = useState(() => (instant ? fullText.length : 0));
  const timerRef = useRef(null);
  useEffect(() => {
    if (instant || pending) return undefined;
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
  const growing = shown < displayText.length;
  useEffect(() => {
    if (growing) onGrow?.();
  }, [shown, growing, onGrow]);

  const copyAnswer = async () => {
    setActionStatus(null);
    try {
      // 复制时带上来源清单，粘到外部文档后角标与来源仍然对得上。
      const body = plan.length
        ? `${displayText}\n\n来源：\n${plan.map(source => `[${source.index}] ${source.name}`).join("\n")}`
        : displayText;
      await copyText(body);
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
            <Markdown className={growing ? "is-growing" : ""}>
              {/* 打字机截断可能落在 [[文件名]] 中间，先隐藏未闭合标记避免正文出现半截方括号。 */}
              {linkCitations(growing ? displayText.slice(0, shown).replace(/\[\[[^\]\n]*$/, "") : displayText, plan, message.id)}
            </Markdown>
          )}
        </div>
        {!pending && !growing && graph?.entities?.length ? (
          <GraphCard entities={graph.entities} relations={graph.relations} truncated={graph.is_truncated} />
        ) : null}
        {!pending && plan.length && !growing ? (
          <section className="chat-sources" aria-label="回答来源">
            <h4>来源</h4>
            <ol>
              {plan.map(source => (
                <li key={source.index} id={`cite-${message.id}-${source.index}`}>
                  {onOpenSource ? (
                    <button
                      type="button"
                      className="chat-source-link"
                      title={`在右侧打开 ${source.name}`}
                      onClick={() => onOpenSource(source.file)}
                    >
                      <span className="chat-source-index">[{source.index}]</span>
                      <span className="chat-source-name">{source.name}</span>
                    </button>
                  ) : (
                    <>
                      <span className="chat-source-index">[{source.index}]</span>
                      <span className="chat-source-name" title={source.file}>{source.name}</span>
                    </>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
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

/** 右侧文档分栏：与聊天并排停靠，顶部标签切换多文档，可全屏细看。 */
function DocumentPane({ onClose, sessionId, documents, error, activePath, onSelect, onFullscreen }) {
  const doc = documents.find(item => item.path === activePath) || documents[0] || null;
  const { state, reload } = useDocumentContent(sessionId, doc, true);
  const Icon = doc ? previewIcon(doc.kind) : Files;
  return (
    <section className="chat-doc-pane" aria-label="文档预览">
      <header className="doc-pane-heading">
        <span className={`doc-pane-icon${doc ? ` is-${doc.ext}` : ""}`} aria-hidden="true">
          <Icon size={20} />
        </span>
        <strong className="doc-pane-title" title={doc ? (doc.source ? doc.name : doc.path) : "生成的文档"}>{doc ? doc.name : "生成的文档"}</strong>
        <div className="doc-pane-actions">
          {doc && (
            <a className="doc-pane-action" href={documentFileUrl(sessionId, doc, true)} download={doc.name} title={`下载 ${doc.name}`} aria-label={`下载 ${doc.name}`}>
              <DownloadSimple size={17} />
            </a>
          )}
          {doc && (
            <button className="doc-pane-action" type="button" title="重新加载" aria-label="重新加载预览" onClick={reload}>
              <ArrowClockwise size={17} />
            </button>
          )}
          {doc && (
            <button className="doc-pane-action" type="button" title="全屏查看" aria-label="全屏查看文档" onClick={onFullscreen}>
              <CornersOut size={17} />
            </button>
          )}
          <button className="doc-pane-action" type="button" title="收起面板" aria-label="收起文档面板" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      </header>

      {documents.length > 1 && (
        <nav className="doc-pane-tabs" aria-label="切换文档">
          {documents.map(item => (
            <button
              key={item.path}
              type="button"
              className={item.path === doc?.path ? "is-active" : ""}
              onClick={() => onSelect(item.path)}
              title={item.path}
            >
              {item.name}
            </button>
          ))}
        </nav>
      )}

      <div className="doc-pane-body" aria-live="polite">
        {doc ? (
          <div className="doc-pane-paper">
            <DocumentBody doc={doc} state={state} />
            {(state.status === "download-only" || (state.status === "ready" && (doc.ext === "ppt" || doc.ext === "pptx"))) && (
              <div className="doc-preview-note">
                <p>{doc.ext === "ppt" || doc.ext === "pptx" ? "PPT 暂不支持在线预览" : state.note}</p>
                <p>请使用上方按钮下载后查看。</p>
              </div>
            )}
          </div>
        ) : (
          <p className="documents-empty">{error || "本轮还没有生成文档。让智能体整理成 Word、Excel、PPT 或 Markdown 后会出现在这里。"}</p>
        )}
      </div>
    </section>
  );
}

function clockTime() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

/** 最后一条用户消息之后是否已有最终回答；用于区分「已完成」与「执行结束但没内容」。 */
const ANSWER = "本轮执行已结束，但没有生成最终回答，通常是执行被中断或失败。可以继续追问，或重新发送问题。";
function hasAnswerAfterLastUser(messages) {
  const lastUser = messages.findLastIndex((item) => item.role === "user");
  if (lastUser < 0) return true;
  return messages
    .slice(lastUser + 1)
    .some((item) => item.role === "assistant" && String(item.content || "").trim());
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
  // 会话级运行状态：切换会话时旧会话继续在后台接收，列表用它显示转圈。
  const sessionStates = useRef(new Map());
  const activeSessionRef = useRef(null);
  const controllersRef = useRef(new Map());
  // 主动停止的会话：abort 会触发 onError，这里避免再叠加一条「执行遇到问题：已停止接收」。
  const stoppedRef = useRef(new Set());
  const [backgroundRun, setBackgroundRun] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [documentsError, setDocumentsError] = useState("");
  const [activeDocPath, setActiveDocPath] = useState(null);
  // 点击回答角标来源时打开的知识库原始文件：与生成文档共用右侧面板，作为额外标签。
  const [sourceDoc, setSourceDoc] = useState(null);
  const [docFullscreen, setDocFullscreen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [feedbackVersion, setFeedbackVersion] = useState(0);
  const [timeline, setTimeline] = useState([]);
  const [activityText, setActivityText] = useState("");
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const pendingUserTextRef = useRef(null);
  const historyRequestRef = useRef(0);

  // 后台回复由服务端继续执行，本页只轮询状态；用同一套「工作中」标识告诉用户它在跑。
  const activity = isThinking || backgroundRun ? "working" : attachments.length ? "reading" : "waiting";
  const activityLabel = isThinking ? activityText || "正在执行" : backgroundRun ? "正在后台回复" : attachments.length ? "附件已准备" : "在线，可以开始";
  const hasMessages = messages.length > 0;
  // 一轮里的推理、工具与旁白收进执行过程，正文只留最终回答。
  const conversation = useMemo(() => groupConversation(messages), [messages]);
  // 每条回答对应的检索来源：与本轮 [[文件名]] 角标一一对应。
  const citationMap = useMemo(() => citationSources(messages), [messages]);

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

  // 卸载时断开所有仍在接收的会话流，避免后台请求泄漏。
  useEffect(() => () => {
    for (const stop of controllersRef.current.values()) stop();
    controllersRef.current.clear();
    for (const timer of watchTimersRef.current.values()) clearInterval(timer);
    watchTimersRef.current.clear();
  }, []);

  const documentsCountRef = useRef(0);
  const documentsFreshRef = useRef(false);

  // 文档分栏：会话切换和每轮执行结束后扫描工作区；本轮新生成文档时自动展开并定位到最新一份。
  useEffect(() => {
    if (isThinking) documentsFreshRef.current = true;
  }, [isThinking]);

  useEffect(() => {
    if (!sessionId) {
      documentsCountRef.current = 0;
      documentsFreshRef.current = false;
      setDocuments([]);
      setActiveDocPath(null);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    fetchDocuments(sessionId, controller.signal)
      .then((list) => {
        if (!alive) return;
        const fresh = list.length > documentsCountRef.current;
        documentsCountRef.current = list.length;
        setDocuments(list);
        setDocumentsError("");
        if (fresh && documentsFreshRef.current && list.length) {
          documentsFreshRef.current = false;
          setActiveDocPath(list[0].path);
          setDocumentsOpen(true);
        }
      })
      .catch((error) => { if (alive && error.name !== "AbortError") setDocumentsError(error.message); });
    return () => { alive = false; controller.abort(); };
  }, [sessionId, isThinking]);

  // 引用文件只属于当前会话：切换会话时收起旧来源，避免把上一个会话的知识库文件留在面板里。
  useEffect(() => {
    setSourceDoc(null);
    setDocFullscreen(false);
  }, [sessionId]);

  /** 点击回答来源：把知识库原始文件作为右侧面板的标签打开，与生成文档共用预览能力。 */
  const openSource = useCallback((file) => {
    if (!sessionId) return;
    const name = String(file || "").split(/[\\/]/).pop();
    if (!name) return;
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    const doc = {
      source: true,
      file: name,
      path: `source:${name}`,
      name,
      ext,
      kind: SOURCE_KINDS[ext] || "文件",
    };
    setSourceDoc(doc);
    setActiveDocPath(doc.path);
    setDocumentsOpen(true);
    setPlannerOpen(false);
  }, [sessionId]);

  // 面板文档 = 当前打开的引用文件 + 本会话生成的文档，标签栏可直接来回切换。
  const paneDocuments = useMemo(
    () => (sourceDoc ? [sourceDoc, ...documents.filter(doc => doc.path !== sourceDoc.path)] : documents),
    [sourceDoc, documents],
  );

  const timelineIdRef = useRef(0);
  const timelineCallRef = useRef(new Map());
  const timelineApprovalRef = useRef(new Map());

  useEffect(() => {
    let disposed = false;
    let checking = false;
    const clearAccount = () => {
      accountEpoch.current += 1;
      historyRequestRef.current += 1;
      for (const stop of controllersRef.current.values()) stop();
      controllersRef.current.clear();
      for (const timer of watchTimersRef.current.values()) clearInterval(timer);
      watchTimersRef.current.clear();
      sessionStates.current.clear();
      stoppedRef.current.clear();
      activeSessionRef.current = null;
      setBackgroundRun(false);
      voice.cancel();
      accountRef.current = null;
      setActiveAccount(null);
      setUser(null);
      setFeedbackOpen(false);
      setSkillsOpen(false);
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
      for (const stop of controllersRef.current.values()) stop();
      controllersRef.current.clear();
      setActiveAccount(null);
      window.clearInterval(timer);
      channel?.close();
      window.removeEventListener('focus', check);
      window.removeEventListener('harness-auth-invalid', invalidate);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  const refreshSessions = useCallback(async () => {
    const epoch = accountEpoch.current;
    try {
      const list = await loadSessions();
      if (epoch === accountEpoch.current) setSessions(list);
    } catch (error) { if (epoch === accountEpoch.current) setPageError(error.message); }
  }, []);

  // 有会话在后台执行时轮询列表，让转圈标识和完成状态自动更新。
  const hasRunningSessions = sessions.some(item => item.running);
  useEffect(() => {
    if (!hasRunningSessions && !backgroundRun) return;
    const timer = window.setInterval(() => { void refreshSessions(); }, 3000);
    return () => window.clearInterval(timer);
  }, [hasRunningSessions, backgroundRun, refreshSessions]);


  /** 取得（或创建）某个会话的本地运行状态，供后台流持续写入。 */
  const sessionState = useCallback((sid) => {
    let state = sessionStates.current.get(sid);
    if (!state) {
      state = { messages: [], timeline: [], isThinking: false, activityText: '', queryId: null, userText: '' };
      sessionStates.current.set(sid, state);
    }
    return state;
  }, []);

  /** 只有当前正在查看的会话才同步到界面，后台会话只更新本地状态。 */
  const commitSession = useCallback((sid) => {
    if (!sid || sid !== activeSessionRef.current) return;
    const state = sessionStates.current.get(sid);
    if (!state) return;
    setMessages(state.messages);
    setTimeline(state.timeline);
    setIsThinking(state.isThinking);
    setActivityText(state.activityText);
  }, []);

  /** 追加一条过程项（tool/approval/error），返回条目 id 供后续更新状态。 */
  const pushTimelineItem = useCallback((sid, item) => {
    const id = `tl-${++timelineIdRef.current}`;
    const state = sessionState(sid);
    state.timeline = [...state.timeline.slice(-80), { id, time: clockTime(), ...item }];
    commitSession(sid);
    return id;
  }, [sessionState, commitSession]);

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
    const sid = activeSessionRef.current;
    if (!sid) return;
    const state = sessionState(sid);
    state.messages = state.messages.map((m) => (m.role === "approval" && m.approvalKey === card.approvalKey ? { ...m, status: decision === "allowed-once" ? "allowed" : "rejected" } : m));
    const tlId = timelineApprovalRef.current.get(`${sid}:${card.approvalKey}`);
    if (tlId) {
      state.timeline = state.timeline.map((it) => (it.id === tlId ? { ...it, status: decision === "allowed-once" ? "allowed" : "rejected" } : it));
    }
    commitSession(sid);
  }, [sessionState, commitSession]);

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

  const handleNotification = useCallback((sid, notification) => {
    if (!sid) return;
    const state = sessionState(sid);
    const patch = (fn) => { state.messages = fn(state.messages); commitSession(sid); };
    const patchTimeline = (fn) => { state.timeline = fn(state.timeline); commitSession(sid); };
    const setActivity = (text) => { state.activityText = text; commitSession(sid); };
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
      setActivity("正在分析问题与已有依据");
      return;
    }

    if (event.type === "assistant/message") {
      const blocks = data.message?.content || [];
      const reasoning = blocks
        .filter((b) => b && b.type === "reasoning")
        .map((b) => b.text)
        .join("\n\n");
      if (reasoning) {
        patch((items) => [
          ...items,
          { id: `thinking-${event.seq}`, seq: event.seq, role: "thinking", ts: Date.now(), text: reasoning },
        ]);
      }
      const text = blocks
        .filter((b) => b && b.type === "text")
        .map((b) => b.text)
        .join("");
      setActivity(text ? "正在整理回答" : "正在思考");
      if (!text) return;
      patch((items) => [
        ...items,
        {
          id: `assistant-${event.seq}`,
          seq: event.seq,
          role: "assistant",
          ts: Date.now(),
          time: clockTime(),
          content: text,
          queryId: state.queryId,
          question: state.userText || "",
        },
      ]);
      return;
    }

    if (event.type === "tool/call") {
      let args = {};
      try {
        args = JSON.parse(data.arguments || "{}");
      } catch { /* 模型产生的 arguments 解析失败按空对象展示 */ }
      patch((items) => [
        ...items,
        {
          id: `tool-${data.callId}`,
          role: "tool",
          callId: data.callId,
          name: data.name,
          args,
          argsText: typeof data.arguments === "string" ? data.arguments : JSON.stringify(args),
          status: "running",
          ts: Date.now(),
          time: clockTime(),
        },
      ]);
      const card = { name: data.name, args, status: "running" };
      // 所有工具都更新当前动作，折叠块顶部才能如实说明这一步在做什么。
      setActivity(`正在${taskProgress(card).title}`);
      if (!visibleTool(card)) return;
      const tlId = pushTimelineItem(sid, {
        kind: "tool",
        name: data.name, args, callId: data.callId,
        title: taskProgress(card).title,
        status: "running",
      });
      if (data.callId) timelineCallRef.current.set(`${sid}:${data.callId}`, tlId);
      return;
    }

    if (event.type === "tool/result") {
      const text = resultText(data);
      const block = data.message?.content?.find?.((b) => b?.type === "tool-result");
      const callId = block?.toolCallId;
      const json = resultJsonOf(text);
      const graphCtx = extractGraphContext(text);
      if (callId && json?.query_id) state.queryId = json.query_id;
      const isError = Boolean(data.error || block?.isError);
      patch((items) =>
        items.map((m) =>
          m.role === "tool" && (!callId || m.callId === callId) && m.status === "running"
            ? { ...m, status: isError ? "error" : "done", resultText: text, resultJson: json, graphContext: graphCtx }
            : m,
        ),
      );
      const tlId = callId ? timelineCallRef.current.get(`${sid}:${callId}`) : null;
      if (tlId) {
        patchTimeline((items) =>
          items.map((it) =>
            it.id === tlId ? { ...it, status: isError ? "error" : "done", resultJson: json, resultText: text, graphContext: graphCtx } : it,
          ),
        );
      }
      return;
    }

    if (event.type === "approval/asked") {
      patch((items) => [
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
          ts: Date.now(),
          time: clockTime(),
        },
      ]);
      const apTlId = pushTimelineItem(sid, {
        kind: "approval",
        title: `${toolLabel(data.toolName)} 请求审批`,
        detail: data.reason || "",
        status: "pending",
      });
      timelineApprovalRef.current.set(`${sid}:approval-${event.seq}`, apTlId);
      return;
    }

    if (event.type === "approval/decided") {
      // 决定已由 handleDecide 或其他端写入；把最早仍 pending 的同名审批卡标记完成
      patch((items) => {
        const idx = items.findIndex((m) => m.role === "approval" && m.status === "pending");
        if (idx < 0) return items;
        const next = [...items];
        next[idx] = {
          ...next[idx],
          status: data.outcome === "allowed-once" ? "allowed" : "rejected",
        };
        return next;
      });
      patchTimeline((items) => {
        const idx = items.findIndex((it) => it.kind === "approval" && it.status === "pending");
        if (idx < 0) return items;
        const next = [...items];
        next[idx] = { ...next[idx], status: data.outcome === "allowed-once" ? "allowed" : "rejected" };
        return next;
      });
      return;
    }

    if (event.type === "compaction/start") {
      setActivity("正在压缩上下文");
      patch((items) => [
        ...items,
        { id: `compaction-${event.seq}`, seq: event.seq, role: "compaction", status: "running", ts: Date.now(), time: clockTime() },
      ]);
      return;
    }

    if (event.type === "compaction/end") {
      const message = data.error ? (data.error.message || "压缩上下文失败") : "";
      patch((items) => {
        const idx = items.findLastIndex((item) => item.role === "compaction" && item.status === "running");
        if (idx < 0) return items;
        const next = [...items];
        next[idx] = { ...next[idx], status: message ? "error" : "done", message };
        return next;
      });
      return;
    }

    if (event.type === "turn/end") {
      if (data.reason?.kind === "error") {
        const message = data.reason?.error?.message || "本轮执行失败";
        patch((items) => [
          ...items,
          {
            id: `turn-error-${event.seq}`,
            role: "assistant",
            time: clockTime(),
            content: `执行遇到问题：${message}`,
            instant: true,
          },
        ]);
        pushTimelineItem(sid, { kind: "error", title: "本轮异常结束", detail: message });
      }
    }
  }, [pushTimelineItem, sessionState, commitSession]);

  /** 结束某个会话的流式状态：未完成的工具标为中断，状态落回该会话的本地记录。 */
  const resetTurnState = useCallback((sid) => {
    if (!sid) return;
    const state = sessionState(sid);
    state.isThinking = false;
    state.activityText = '';
    state.messages = state.messages.map(item => item.role === "tool" && item.status === "running" ? { ...item, status: "interrupted" } : item);
    state.timeline = state.timeline.map(item => item.kind === "tool" && item.status === "running" ? { ...item, status: "interrupted" } : item);
    commitSession(sid);
  }, [sessionState, commitSession]);

  const sendMessage = (preset) => {
    const typedContent = (typeof preset === "string" ? preset : draft).trim();
    if (!typedContent && !attachments.length) return;
    if (isThinking || backgroundRun || voice.active || uploads.blocked) return;
    if (!accountRef.current) { setPageError("请登录后开始对话"); return; }
    const epoch = accountEpoch.current;
    const guarded = handlers => Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, (...args) => { if (epoch === accountEpoch.current) handler(...args); }]));
    historyRequestRef.current += 1;

    const content = typedContent || `请处理${attachments.length > 1 ? "这些" : ""}附件：${attachments.map(item => item.name).join("、")}`;
    const timestamp = Date.now();
    // 新会话还没有 id，先用本地键承载这一轮，收到 start 后迁移到真实会话 id。
    let runSid = sessionId || `pending-${timestamp}`;
    activeSessionRef.current = runSid;
    const state = sessionState(runSid);
    state.userText = content;
    state.queryId = null;
    state.messages = [...state.messages, { id: `user-${timestamp}`, role: "user", time: clockTime(), content, attachments }];
    state.timeline = [];
    state.isThinking = true;
    state.activityText = "";
    commitSession(runSid);
    setDraft("");
    uploads.clear();
    timelineCallRef.current.clear();
    timelineApprovalRef.current.clear();

    const attachmentPayload = attachments.length
      ? attachments.map(({ name, data, mimeType }) => ({ name, data, mimeType }))
      : undefined;

    /** 服务端分配会话 id 后，把本地临时状态搬到真实会话名下。 */
    const adoptSession = (id) => {
      if (runSid === id) return;
      const from = sessionStates.current.get(runSid);
      const target = sessionState(id);
      if (from) {
        target.messages = [...target.messages, ...from.messages];
        target.timeline = from.timeline;
        target.isThinking = from.isThinking;
        target.activityText = from.activityText;
        target.queryId = from.queryId;
        target.userText = from.userText;
        sessionStates.current.delete(runSid);
      }
      const control = controllersRef.current.get(runSid);
      if (control) {
        controllersRef.current.delete(runSid);
        controllersRef.current.set(id, control);
      }
      // 用户可能已经切到别的会话：只在仍停留于这轮时才同步视图，避免被强行拉回。
      const viewing = activeSessionRef.current === runSid;
      runSid = id;
      if (viewing) {
        activeSessionRef.current = id;
        setSessionId(id);
        commitSession(id);
      }
    };

    const controller = streamChat(
      { sessionId, message: content, attachments: attachmentPayload },
      guarded({
        onStart: (id, savedAttachments) => {
          adoptSession(id);
          if (savedAttachments?.length) {
            const current = sessionState(id);
            current.messages = current.messages.map(item => item.id === `user-${timestamp}` ? { ...item, attachments: savedAttachments } : item);
            commitSession(id);
          }
          void refreshSessions();
        },
        onRenamed: ({ to, attachments: savedAttachments }) => {
          adoptSession(to);
          if (savedAttachments?.length) {
            const current = sessionState(to);
            current.messages = current.messages.map(item => item.id === `user-${timestamp}` ? { ...item, attachments: savedAttachments } : item);
            commitSession(to);
          }
          void refreshSessions();
          const current = sessionState(to);
          current.messages = [
            ...current.messages,
            {
              id: `renamed-${to}`,
              role: "assistant",
              time: clockTime(),
              content: "服务已重启，本会话已迁移到新会话继续。之前的上下文不会自动延续，如需引用请重新说明。",
            },
          ];
          commitSession(to);
        },
        onNotification: (notification) => handleNotification(runSid, notification),
        onDone: () => {
          controllersRef.current.delete(runSid);
          resetTurnState(runSid);
          const current = sessionState(runSid);
          // 执行结束却没有回答时补一条说明，避免只剩一个「已完成」过程块。
          if (!hasAnswerAfterLastUser(current.messages)) {
            current.messages = [
              ...current.messages,
              { id: `no-answer-${timestamp}`, role: "assistant", time: clockTime(), content: ANSWER, instant: true },
            ];
            commitSession(runSid);
          }
          void refreshSessions();
        },
        onError: (message) => {
          controllersRef.current.delete(runSid);
          resetTurnState(runSid);
          // 用户主动停止时 stopResponse 已写说明，不再追加一条错误。
          if (stoppedRef.current.delete(runSid)) { void refreshSessions(); return; }
          const current = sessionState(runSid);
          current.messages = [
            ...current.messages,
            {
              id: `error-${timestamp}`,
              role: "assistant",
              time: clockTime(),
              content: `执行遇到问题：${message}`,
              instant: true,
            },
          ];
          commitSession(runSid);
          void refreshSessions();
        },
      }),
    );
    controllersRef.current.set(runSid, controller);
  };

  const stopResponse = () => {
    const sid = activeSessionRef.current;
    if (!sid) return;
    stoppedRef.current.add(sid);
    controllersRef.current.get(sid)?.();
    controllersRef.current.delete(sid);
    resetTurnState(sid);
    const state = sessionState(sid);
    state.messages = [
      ...state.messages,
      {
        id: `stopped-${Date.now()}`,
        role: "assistant",
        time: clockTime(),
        content: "已停止接收本轮输出。服务端的执行会自然结束，你可以继续提问。",
      },
    ];
    commitSession(sid);
    void refreshSessions();
  };

  const startNewChat = () => {
    historyRequestRef.current += 1;
    voice.cancel();
    // 不中断后台会话：旧会话继续执行，列表会显示运行标识。
    activeSessionRef.current = null;
    setSessionId(null);
    setMessages([]);
    setDraft("");
    uploads.clear();
    setPreview(null);
    setTimeline([]);
    setIsThinking(false);
    setActivityText("");
    setBackgroundRun(false);
    timelineCallRef.current.clear();
    timelineApprovalRef.current.clear();
    setHistoryOpen(false);
    setPageError("");
    if (sharedId) {
      window.history.replaceState(null, "", appUrl("chat"));
      setSharedId(null);
    }
    void refreshSessions();
  };

  /** 从后端历史恢复某个会话，仅在该会话仍是当前查看的会话时应用。 */
  const loadHistoryInto = useCallback(async (item) => {
    const requestId = ++historyRequestRef.current;
    const [events, votes] = await Promise.all([
      fetchChatHistory(item.sessionId),
      fetchAnswerVotes(item.sessionId).catch(error => {
        if (requestId === historyRequestRef.current) setPageError("反馈状态加载失败：" + error.message);
        return {};
      }),
    ]);
    if (requestId !== historyRequestRef.current || activeSessionRef.current !== item.sessionId) return;
    const state = sessionState(item.sessionId);
    if (!events.length) {
      state.messages = [
        {
          id: `resumed-${item.sessionId}`,
          role: "assistant",
          time: clockTime(),
          content: item.running
            ? "这个会话正在后台执行，完成后会自动刷新并显示回答。"
            : `已切换到会话「${item.title}」，历史消息为空。继续提问即可开始。`,
          instant: true,
        },
      ];
      state.timeline = [];
      state.isThinking = false;
      state.activityText = "";
      commitSession(item.sessionId);
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
            return { id: `h-a-${e.seq}`, seq: e.seq, role: "assistant", ts: e.time, time, content: e.text, feedback: votes[e.seq] || null, instant: true };
          case "thinking":
            return { id: `h-th-${e.seq}`, seq: e.seq, role: "thinking", ts: e.time, time, text: e.text };
          case "tool": {
            let args = {};
            try {
              args = JSON.parse(e.argsText || "{}");
            } catch {
              /* 历史 arguments 解析失败按空对象展示 */
            }
            // graphContext：后端 projectHistory 已从完整 text 中提取；
            // 再从截断后的 resultText 里兜底提一次（极端情况后端没传到）。
            const graphCtx = e.graphContext || extractGraphContext(e.resultText);
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
              graphContext: graphCtx,
              references: e.references || [],
              ts: e.time,
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
              ts: e.time,
              time,
            };
          case "compaction":
            return { id: `h-cp-${e.seq}`, seq: e.seq, role: "compaction", status: e.status || "done", message: e.message || "", ts: e.time, time };
          case "error":
            return { id: `h-e-${e.seq}`, role: "error", ts: e.time, time, message: e.message || "本轮执行失败" };
          default:
            return null;
        }
      }).filter(Boolean);
    const lastUser = restored.findLastIndex(message => message.role === "user");
    const restoredTimeline = restored.slice(lastUser + 1).filter(message => ["tool", "approval"].includes(message.role))
      .map(message => ({ ...message, kind: message.role, title: message.role === "approval" ? "执行审批" : taskProgress(message).title }));
    for (const entry of restoredTimeline) {
      if (entry.kind === "tool" && entry.callId) timelineCallRef.current.set(`${item.sessionId}:${entry.callId}`, entry.id);
      if (entry.kind === "approval" && entry.approvalKey) timelineApprovalRef.current.set(`${item.sessionId}:${entry.approvalKey}`, entry.id);
    }
    // 历史里只有执行过程、没有最终回答时给出说明，避免用户只看到一个「已完成」块。
    if (!item.running && lastUser >= 0 && !hasAnswerAfterLastUser(restored)) {
      restored.push({ id: `h-note-${item.sessionId}`, role: "assistant", time: clockTime(), content: ANSWER, instant: true });
    }
    state.messages = restored;
    state.timeline = restoredTimeline;
    state.isThinking = false;
    state.activityText = "";
    commitSession(item.sessionId);
  }, [sessionState, commitSession]);

  /** 后台会话结束前每 3 秒轮询一次，结束后自动拉取完整历史，避免停在“已完成但没内容”。 */
  const watchTimersRef = useRef(new Map());
  const watchBackgroundSession = useCallback((item) => {
    if (watchTimersRef.current.has(item.sessionId)) return;
    const timer = setInterval(async () => {
      try {
        const list = await loadSessions();
        setSessions(list);
        const current = list.find(entry => entry.sessionId === item.sessionId);
        if (current?.running) return;
        clearInterval(timer);
        watchTimersRef.current.delete(item.sessionId);
        if (activeSessionRef.current !== item.sessionId) return;
        setBackgroundRun(false);
        if (!sessionStates.current.get(item.sessionId)?.isThinking) void loadHistoryInto(item);
      } catch { /* 轮询失败下一轮继续 */ }
    }, 3000);
    watchTimersRef.current.set(item.sessionId, timer);
  }, [loadHistoryInto]);

  const resumeSession = async (item) => {
    historyRequestRef.current += 1;
    voice.cancel();
    activeSessionRef.current = item.sessionId;
    setSessionId(item.sessionId);
    setDraft("");
    uploads.clear();
    setPreview(null);
    setHistoryOpen(false);
    setPageError("");
    timelineCallRef.current.clear();
    timelineApprovalRef.current.clear();
    if (sharedId) {
      window.history.replaceState(null, "", appUrl("chat"));
      setSharedId(null);
    }

    // 本页仍在接收这轮流：本地缓冲就是最完整的实时状态，直接恢复。
    const local = sessionStates.current.get(item.sessionId);
    const streaming = controllersRef.current.has(item.sessionId);
    if (streaming && local) {
      setMessages(local.messages);
      setTimeline(local.timeline);
      setIsThinking(local.isThinking);
      setActivityText(local.activityText);
      setBackgroundRun(false);
      return;
    }
    // 已完成且本地有回答：直接复用本地结果（含停止、报错等未落盘的说明）。
    if (local?.messages.length && !item.running && hasAnswerAfterLastUser(local.messages)) {
      setMessages(local.messages);
      setTimeline(local.timeline);
      setIsThinking(false);
      setActivityText("");
      setBackgroundRun(false);
      return;
    }

    // 页面刚刷新或由别的窗口发起：从持久化历史恢复，执行中则显示后台提示并轮询。
    setMessages([]);
    setTimeline([]);
    setIsThinking(false);
    setActivityText("");
    setBackgroundRun(Boolean(item.running));
    try {
      await loadHistoryInto(item);
    } catch (error) {
      if (activeSessionRef.current === item.sessionId) setPageError("历史加载失败：" + error.message);
    }
    if (item.running) watchBackgroundSession(item);
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
              <>{voice.status === "listening" ? <span className="chat-voice-wave" aria-hidden="true"><i /><i /><i /><i /></span> : <ArrowsClockwise size={16} className="chat-voice-processing" aria-hidden="true" />}{voice.status === "starting" ? voice.message || "正在连接麦克风…" : voice.status === "stopping" ? voice.message || "正在订正语音文字…" : "正在聆听，点击麦克风结束"}</>
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
            disabled={!user || voice.active || backgroundRun || (!isThinking && (uploads.blocked || (!draft.trim() && !attachments.length)))}
            aria-label={backgroundRun ? "会话正在后台回复" : isThinking ? "停止接收" : "发送消息"}
            title={backgroundRun ? "会话正在后台回复，请稍候" : isThinking ? "停止接收" : "发送消息"}
            onClick={isThinking ? stopResponse : () => sendMessage()}
          >
            {isThinking ? <Square size={12} weight="fill" aria-hidden="true" /> : <ArrowUp size={18} weight="bold" aria-hidden="true" />}
          </button>
        </div>
      </div>
      {uploads.error ? <p className="chat-upload-error" role="alert">{uploads.error}<button type="button" aria-label="关闭附件提示" onClick={uploads.dismissError}><X size={14} /></button></p> : null}
      {voice.error ? <p className="chat-voice-error" role="alert">{voice.error}{voice.actionUrl ? <> <a href={voice.actionUrl} target="_blank" rel="noopener noreferrer">打开语音服务</a></> : null}</p> : null}
      {voice.warning ? <p className="chat-voice-error" role="status">{voice.warning}</p> : null}
    </footer>
  );

  return (
    <main className={`chat-page${isThinking ? " is-working" : ""}${messages.length ? " has-conversation" : " is-empty"}`}>
      {preview ? <AttachmentPreview key={preview.id} item={preview} onClose={() => setPreview(null)} /> : null}
      <div className={`chat-workspace${documentsOpen ? " has-doc-pane" : ""}`}>
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
            <a className="chat-sidebar-back" href={`${import.meta.env.BASE_URL}?agent=knowledge-harness`} aria-label="返回智能体首页">
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

          <nav className="chat-sidebar-tools" aria-label="工作区入口" data-active={skillsOpen ? "skills" : feedbackOpen ? "feedback" : !hasMessages && !sharedId ? "new" : "none"}>
            <button type="button" aria-label="新对话" aria-current={!hasMessages && !sharedId && !feedbackOpen && !skillsOpen ? "page" : undefined} onClick={startNewChat}>
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
            <button type="button" aria-label="Skills 配置" aria-haspopup="dialog" aria-expanded={skillsOpen} disabled={!user} onClick={() => { setHistoryOpen(false); setSkillsOpen(true); }}>
              <span className="chat-sidebar-tool-icon" aria-hidden="true">
                <PuzzlePiece size={18} />
              </span>
              <span>
                <strong>Skills 配置</strong>
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
                {item.running ? (
                  <span className="chat-history-spin" role="status" aria-label="正在回复" title="正在回复" />
                ) : null}
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
                  {isThinking || backgroundRun ? activityLabel : "知识问答与运营"}
                </div>
              </div>
            </div>
            <button
              className="chat-planner-shortcut"
              type="button"
              onClick={() => { setPlannerOpen(value => !value); setDocumentsOpen(false); }}
              aria-label={plannerOpen ? "收起任务进展" : "查看任务进展"}
              aria-expanded={plannerOpen}
              title="任务进展"
            >
              <ListChecks size={20} aria-hidden="true" />
            </button>
            <button
              className={`chat-planner-shortcut chat-documents-shortcut${documents.length ? " has-items" : ""}`}
              type="button"
              onClick={() => { setDocumentsOpen(value => !value); setPlannerOpen(false); }}
              aria-label={documentsOpen ? "收起生成的文档" : "查看生成的文档"}
              aria-expanded={documentsOpen}
              title="生成的文档"
            >
              <Files size={20} aria-hidden="true" />
              {documents.length ? <span className="chat-documents-count" aria-hidden="true">{documents.length}</span> : null}
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
                {conversation.map((message, index) => {
                  if (message.role === "user") return <UserMessage key={message.id} message={message} onPreview={setPreview} />;
                  if (message.role === "process") {
                    return (
                      <ProcessBlock
                        key={message.id}
                        block={message}
                        live={isThinking && index === conversation.length - 1}
                        activityText={activityText}
                      />
                    );
                  }
                  if (message.role === "approval") {
                    return <ApprovalCard key={message.id} card={message} onDecide={handleDecide} />;
                  }
                  return (
                    <AssistantMessage
                      key={message.id}
                      message={message}
                      sources={citationMap.get(message.id) || []}
                      graph={graphOfTurn(conversation, index)}
                      // 仅当前执行中的最后一条回答逐字展开；历史、旧回合与切回会话直接显示全文。
                      instant={message.instant || !isThinking || index !== conversation.length - 1}
                      onFeedback={handleFeedback}
                      onOpenSource={sharedId ? undefined : openSource}
                      readOnly={!!sharedId}
                      onGrow={scrollDuringTyping}
                    />
                  );
                })}
                {isThinking && !conversation.at(-1)?.role?.startsWith("process") ? (
                  <AssistantMessage pending activityText={activityText} message={{ id: "pending", time: clockTime() }} />
                ) : null}
                {backgroundRun ? (
                  <div className="chat-background-note" role="status">
                    <span className="chat-history-spin" aria-hidden="true" />
                    <span>
                      <strong>这个会话正在后台回复</strong>
                      <small>完成后会自动刷新并显示完整回答；期间无需停留在此页面。</small>
                    </span>
                  </div>
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

        {documentsOpen && (
          <DocumentPane
            sessionId={sessionId}
            documents={paneDocuments}
            error={documentsError}
            activePath={activeDocPath}
            onSelect={setActiveDocPath}
            onClose={() => { setDocumentsOpen(false); setSourceDoc(null); setActiveDocPath(null); }}
            onFullscreen={() => setDocFullscreen(true)}
          />
        )}
      </div>

      {docFullscreen && paneDocuments.length ? (
        <DocumentPreview
          sessionId={sessionId}
          doc={paneDocuments.find(item => item.path === activeDocPath) || paneDocuments[0]}
          onClose={() => setDocFullscreen(false)}
        />
      ) : null}

      {feedbackOpen && user ? <FeedbackFlywheel key={user.uid} accountUid={user.uid} version={feedbackVersion} onClose={() => setFeedbackOpen(false)} onOpenSession={item => { setFeedbackOpen(false); void resumeSession(item); }} onDeleteRecord={handleDeleteFeedbackRecord} /> : null}
      {skillsOpen && user ? <SkillsManager key={user.uid} onClose={() => setSkillsOpen(false)} /> : null}
    </main>
  );
}
