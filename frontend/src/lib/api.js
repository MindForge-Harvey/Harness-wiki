/**
 * 适配层客户端：SSE 聊天、审批决定、kb 反馈，以及 localStorage 会话列表。
 * 适配层地址走 vite 代理（/api → 127.0.0.1:3088）。
 */

import { appUrl } from "./app-url";

const SESSIONS_KEY = "rag-kb-sessions";

/** ---------------------------------------------------------------- 会话列表（localStorage） */

export function loadSessions() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveSessions(list) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, 50)));
}

/** 记录/刷新一个会话（title 取首条用户消息）。 */
export function upsertSession(sessionId, title) {
  const list = loadSessions().filter((s) => s.sessionId !== sessionId);
  const existing = loadSessions().find((s) => s.sessionId === sessionId);
  list.unshift({
    sessionId,
    title: title || existing?.title || "新对话",
    time: Date.now(),
  });
  saveSessions(list);
  return list;
}

export function removeSession(sessionId) {
  saveSessions(loadSessions().filter((s) => s.sessionId !== sessionId));
  return loadSessions();
}

/** 服务端会话迁移后，把本地会话表里的旧 id 原地改成新 id（保留标题与时间）。 */
export function renameSession(fromId, toId) {
  const list = loadSessions();
  const hit = list.find((s) => s.sessionId === fromId);
  if (!hit) return upsertSession(toId, "新对话");
  return saveSessions([
    ...list.filter((s) => s.sessionId !== fromId && s.sessionId !== toId),
    { ...hit, sessionId: toId },
  ]) || loadSessions();
}

/** ---------------------------------------------------------------- SSE 聊天 */

/**
 * 发送一条消息并消费 SSE 流。
 * @param {object} opts - { sessionId?, message, attachments? }
 * @param {object} handlers - { onStart, onNotification, onRenamed, onDone, onError }
 * @returns {() => void} abort 函数（断开流；服务端回合继续但本端停止接收）。
 */
export function streamChat({ sessionId, message, attachments }, handlers) {
  const controller = new AbortController();

  (async () => {
    let response
    try {
      response = await fetch(appUrl("api/chat/stream"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(sessionId ? { sessionId } : {}),
          message,
          ...(attachments && attachments.length ? { attachments } : {}),
        }),
        signal: controller.signal,
      });
    } catch (e) {
      handlers.onError?.(e.name === "AbortError" ? "已停止接收" : "连接适配层失败：" + e.message);
      return;
    }

    if (!response.ok || !response.body) {
      let detail = "";
      try {
        detail = (await response.json())?.error || "";
      } catch { /* 非 JSON 响应 */ }
      handlers.onError?.(detail || `请求失败（HTTP ${response.status}）`);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleBlock = (block) => {
      const lines = block.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!eventLine || !dataLine) return;
      const event = eventLine.slice(7).trim();
      let data;
      try {
        data = JSON.parse(dataLine.slice(6));
      } catch {
        return;
      }
      if (event === "start") handlers.onStart?.(data.sessionId);
      else if (event === "notification") handlers.onNotification?.(data);
      else if (event === "renamed") handlers.onRenamed?.(data);
      else if (event === "done") handlers.onDone?.(data);
      else if (event === "error") handlers.onError?.(data.message || "未知错误");
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          handleBlock(buffer.slice(0, idx).trim());
          buffer = buffer.slice(idx + 2);
        }
      }
      if (buffer.trim()) handleBlock(buffer.trim());
    } catch (e) {
      if (e.name !== "AbortError") handlers.onError?.("流中断：" + e.message);
    }
  })();

  return () => controller.abort();
}

/** ---------------------------------------------------------------- 审批与反馈（转发适配层） */

/** 拉取会话历史（适配层读会话日志投影成展示事件）。失败返回空数组。 */
export async function fetchChatHistory(sessionId) {
  try {
    const res = await fetch(appUrl(`api/chat/history?sessionId=${encodeURIComponent(sessionId)}`));
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.events) ? data.events : [];
  } catch {
    return [];
  }
}

export async function fetchPendingApprovals() {
  const r = await fetch(appUrl("api/approvals/pending"));
  if (!r.ok) return [];
  const data = await r.json();
  return Array.isArray(data.pending) ? data.pending : [];
}

export async function decideApproval(id, decision) {
  const r = await fetch(appUrl(`api/approvals/${encodeURIComponent(id)}/decision`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!r.ok) throw new Error("审批提交失败（HTTP " + r.status + "）");
  return r.json();
}

/**
 * 提交回答反馈（点赞/点踩），按 query_id 关联检索证据。
 * dsh-knowledge 的 feedback 接口：rating 取 positive|negative；
 * 必须携带 query（问题文本）或 message_id；负反馈需 issue_type 或 note。
 * @param {object} body - { rating: 'up'|'down', query_id?, question?, answer?, note? }
 */
export async function submitFeedback(body) {
  const rating = body.rating === "down" ? "negative" : "positive";
  const payload = {
    ...body,
    rating,
    query: body.question || "",
    issue_type: rating === "negative" && !body.note ? "other" : body.issue_type,
  };
  delete payload.question;
  const r = await fetch(appUrl("api/kb/feedback"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("反馈提交失败（HTTP " + r.status + "）");
  return r.json();
}

async function answerRequest(path, options = {}) {
  const response = await fetch(appUrl(path), { cache: 'no-store', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) throw new Error(body.error || `操作失败（HTTP ${response.status}）`);
  return body;
}

export async function fetchAnswerVotes(sessionId) {
  const body = await answerRequest(`api/chat/feedback?sessionId=${encodeURIComponent(sessionId)}`);
  return Object.fromEntries(body.votes.map(vote => [vote.message_id, vote.rating === 'negative' ? 'down' : 'up']));
}

export async function voteOnAnswer({ sessionId, messageSeq, rating }) {
  const body = await answerRequest('api/chat/feedback', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, messageSeq, rating }),
  });
  return body.rating === 'negative' ? 'down' : body.rating === 'positive' ? 'up' : null;
}

export async function shareAnswer({ sessionId, messageSeq }) {
  const body = await answerRequest('api/chat/shares', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, messageSeq }),
  });
  return new URL(appUrl(`chat?share=${body.share.id}`), window.location.origin).href;
}

export async function fetchSharedAnswer(id) {
  return (await answerRequest(`api/chat/shares/${encodeURIComponent(id)}`)).share;
}
