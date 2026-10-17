/**
 * 适配层客户端：SSE 聊天、审批决定、kb 反馈，以及按账号保存的服务端会话列表。
 * 适配层地址走 vite 代理（/api → 127.0.0.1:3088）。
 */

import { appUrl } from "./app-url";

let activeAccount = null;
export const setActiveAccount = uid => { activeAccount = uid; };
export async function fetchIdentity() {
  const unavailable = import.meta.env.DEV
    ? '本地后端未就绪，请运行 ./start.sh 后重试'
    : '登录服务暂不可用，请稍后重试';
  let response;
  try { response = await fetch(appUrl('api/auth/me'), { cache: 'no-store' }); }
  catch { throw new Error(unavailable); }
  if (response.status === 401) return null;
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || unavailable);
  }
  const data = await response.json();
  return data.authenticated && data.user?.uid ? data.user : null;
}

async function personalFetch(url, options = {}) {
  const uid = activeAccount;
  if (!uid) throw new Error('请先登录');
  const response = await fetch(url, { ...options, cache: 'no-store', headers: {
    ...options.headers, 'X-Portal-User': uid, 'X-Harness-Request': '1',
  } });
  if (uid !== activeAccount) throw new DOMException('登录账号已切换', 'AbortError');
  if (response.status === 401) window.dispatchEvent(new Event('harness-auth-invalid'));
  return response;
}

async function skillsRequest(endpoint = '', { method = 'GET', body, signal } = {}) {
  const response = await personalFetch(appUrl('api/chat/skills' + endpoint), {
    method, signal, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || '技能配置操作失败，请重试'), { status: response.status });
  return data;
}
export const fetchSkills = options => skillsRequest('', options);
export const parseSkillFile = (markdown, signal) => skillsRequest('/parse', { method: 'POST', body: { markdown }, signal }).then(data => data.skill);
export const saveSkill = (skill, signal) => skillsRequest(skill.id ? '/' + skill.id : '', { method: skill.id ? 'PUT' : 'POST', body: skill, signal }).then(data => data.skill);
export const deleteSkill = (skill, signal) => skillsRequest('/' + skill.id, { method: 'DELETE', body: { version: skill.version }, signal });

export async function loadSessions() {
  const response = await personalFetch(appUrl('api/chat/sessions'));
  if (!response.ok) throw new Error('历史对话加载失败');
  return (await response.json()).sessions;
}
export const upsertSession = () => loadSessions();
export const renameSession = () => loadSessions();
export async function removeSession(id) {
  const response = await personalFetch(appUrl('api/chat/sessions/' + encodeURIComponent(id)), { method: 'DELETE' });
  if (!response.ok) throw new Error('删除对话失败');
  return loadSessions();
}
export async function clearSessions() {
  const response = await personalFetch(appUrl('api/chat/sessions'), { method: 'DELETE' });
  if (!response.ok) throw new Error('清理对话失败');
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
      response = await personalFetch(appUrl("api/chat/stream"), {
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
      if (event === "start") handlers.onStart?.(data.sessionId, data.attachments);
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
    const res = await personalFetch(appUrl(`api/chat/history?sessionId=${encodeURIComponent(sessionId)}`));
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.events) ? data.events : [];
  } catch {
    return [];
  }
}

export async function fetchPendingApprovals() {
  const r = await personalFetch(appUrl("api/approvals/pending"));
  if (!r.ok) return [];
  const data = await r.json();
  return Array.isArray(data.pending) ? data.pending : [];
}

export async function decideApproval(id, decision) {
  const r = await personalFetch(appUrl(`api/approvals/${encodeURIComponent(id)}/decision`), {
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
  const r = await personalFetch(appUrl("api/kb/feedback"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("反馈提交失败（HTTP " + r.status + "）");
  return r.json();
}

async function answerRequest(path, options = {}) {
  const response = await personalFetch(appUrl(path), { cache: 'no-store', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) throw new Error(body.error || `操作失败（HTTP ${response.status}）`);
  return body;
}

export async function fetchAnswerVotes(sessionId) {
  const body = await answerRequest(`api/chat/feedback?sessionId=${encodeURIComponent(sessionId)}`);
  return Object.fromEntries(body.votes.map(vote => [vote.message_id, vote.rating === 'negative' ? 'down' : 'up']));
}

export async function fetchFeedbackRecords({ signal } = {}) {
  return (await answerRequest('api/chat/feedback/records', { signal })).records;
}

export async function updateFeedbackNote(record, note, { signal } = {}) {
  return answerRequest(`api/chat/feedback/records/${encodeURIComponent(record.id)}`, {
    method: 'PATCH', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: record.sessionId, note }),
  });
}

export async function deleteFeedbackRecord(record, { signal } = {}) {
  return answerRequest(`api/chat/feedback/records/${encodeURIComponent(record.id)}`, {
    method: 'DELETE', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: record.sessionId }),
  });
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
