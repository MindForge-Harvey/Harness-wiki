/**
 * Feedback ledger for KnowledgeCore.
 *
 * Feedback is a signal for diagnosis, not a fact to publish. The ledger keeps
 * one append-only row per user report and derives the current report state in
 * memory. It deliberately stores references and identifiers supplied by the
 * caller without treating them as trusted evidence.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { createAppendLog } from './store.js'

export const ISSUE_TYPES = Object.freeze([
  'wrong_source',
  'incomplete_citation',
  'wrong_entity',
  'wrong_relation',
  'missing_content',
  'outdated_content',
  'answer_style',
  'other',
])

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max)
}

function rowFrom(input = {}) {
  if (input.rating !== 'positive' && input.rating !== 'negative') {
    throw Object.assign(new Error('rating 只能是 positive 或 negative'), { status: 400 })
  }
  const rating = input.rating
  if (input.issue_type !== undefined && input.issue_type !== null && !ISSUE_TYPES.includes(input.issue_type)) {
    throw Object.assign(new Error('未知反馈类型: ' + input.issue_type), { status: 400 })
  }
  const issueType = input.issue_type || null
  const note = clean(input.note, 4000)
  if (rating === 'negative' && !issueType && !note) {
    throw Object.assign(new Error('负反馈请至少选择问题类型或填写说明'), { status: 400 })
  }
  return {
    feedback_id: input.feedback_id || 'fb-' + crypto.randomBytes(6).toString('hex'),
    query_id: clean(input.query_id, 120) || null,
    session_id: clean(input.session_id, 200) || null,
    message_id: clean(input.message_id, 200) || null,
    actor: clean(input.actor, 200) || null,
    query: clean(input.query, 4000),
    answer: clean(input.answer, 12000),
    references: Array.isArray(input.references) ? input.references.slice(0, 20).map((r) => ({
      file: clean(r && (r.file || r.file_path), 500),
      chunk: clean(r && r.chunk, 2000),
    })) : [],
    rating,
    issue_type: issueType,
    note,
    status: 'open',
    created_at: input.created_at || new Date().toISOString(),
  }
}

export function createFeedbackLedger({ dir, logger = () => {} } = {}) {
  const log = createAppendLog(path.join(dir, 'feedback.jsonl'))
  const rows = new Map()
  for (const row of log.readAll()) {
    if (row && row.feedback_id) rows.set(row.feedback_id, row)
  }

  function append(row) {
    log.append(row)
    rows.set(row.feedback_id, row)
    return row
  }

  function record(input) {
    const row = rowFrom(input)
    if (!row.query && !row.message_id) throw Object.assign(new Error('反馈必须关联问题或消息'), { status: 400 })
    if (row.query_id) {
      const duplicate = [...rows.values()].find((r) => r.query_id === row.query_id && r.rating === row.rating && r.issue_type === row.issue_type && r.status === 'open')
      if (duplicate) return { ...duplicate, duplicate: true }
    }
    return append(row)
  }

  function list({ rating, status = 'open', issue_type: issueType, since, limit = 50 } = {}) {
    return [...rows.values()]
      .filter((r) => r.status !== 'deleted')
      .filter((r) => !rating || r.rating === rating)
      .filter((r) => !status || r.status === status)
      .filter((r) => !issueType || r.issue_type === issueType)
      .filter((r) => !since || r.created_at >= since)
      .sort((a, b) => a.created_at < b.created_at ? 1 : -1)
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
  }

  /** One current vote per authenticated user and answer, including real cancellation. */
  function vote(input) {
    const actor = clean(input.actor, 200);
    const session = clean(input.session_id, 200);
    const message = clean(input.message_id, 200);
    if (!actor || !session || !message) throw Object.assign(new Error('反馈必须关联用户、会话和回答'), { status: 400 });
    if (![null, 'positive', 'negative'].includes(input.rating)) throw Object.assign(new Error('反馈选项无效'), { status: 400 });
    const current = [...rows.values()].find(r => r.actor === actor && r.session_id === session && r.message_id === message && r.status !== 'deleted');
    if (input.rating === null) {
      if (current) remove(current.feedback_id);
      return null;
    }
    if (current?.rating === input.rating) return current;
    const row = rowFrom({ ...input, actor, session_id: session, message_id: message,
      issue_type: input.rating === 'negative' ? 'other' : null,
      ...(current ? { feedback_id: current.feedback_id, created_at: current.created_at } : {}),
    });
    return append({ ...row, ...(current ? { updated_at: new Date().toISOString() } : {}) });
  }

  function votes({ actor, session_id }) {
    return [...rows.values()].filter(r => r.actor === actor && r.session_id === session_id && r.status !== 'deleted')
      .map(r => ({ message_id: r.message_id, rating: r.rating }));
  }

  function updateStatus(id, status, extra = {}) {
    const current = rows.get(id)
    if (!current) throw Object.assign(new Error('反馈不存在: ' + id), { status: 404 })
    return append({ ...current, ...extra, status, updated_at: new Date().toISOString() })
  }

  /**
   * 手动修正一条反馈（工作台入口）：可改问题类型与说明，也可改状态
   * （open ↔ reviewed，误处理的反馈可重新纳入诊断）。append 新行生效。
   */
  function update(id, { issue_type: issueType, note, status } = {}) {
    const current = rows.get(id)
    if (!current) throw Object.assign(new Error('反馈不存在: ' + id), { status: 404 })
    if (current.status === 'deleted') throw Object.assign(new Error('反馈已删除: ' + id), { status: 409 })
    if (issueType !== undefined && issueType !== null && !ISSUE_TYPES.includes(issueType)) {
      throw Object.assign(new Error('未知反馈类型: ' + issueType), { status: 400 })
    }
    if (status !== undefined && status !== null && !['open', 'reviewed'].includes(status)) {
      throw Object.assign(new Error('状态只能是 open 或 reviewed'), { status: 400 })
    }
    return append({
      ...current,
      ...issueType !== undefined && issueType !== null ? { issue_type: issueType } : {},
      ...note !== undefined ? { note: clean(note, 4000) } : {},
      ...status !== undefined && status !== null ? { status } : {},
      updated_at: new Date().toISOString(),
    })
  }

  /** 手动删除一条反馈（墓碑行，append-only 账本保留痕迹；list 一律排除）。 */
  function remove(id) {
    const current = rows.get(id)
    if (!current) throw Object.assign(new Error('反馈不存在: ' + id), { status: 404 })
    return append({ ...current, status: 'deleted', updated_at: new Date().toISOString() })
  }

  /** 统计：total 排除墓碑行（删除的反馈不计入），与 list 口径一致。 */
  function stats() {
    let total = 0
    let open = 0
    for (const r of rows.values()) {
      if (r.status === 'deleted') continue
      total++
      if (r.status === 'open') open++
    }
    return { total, open }
  }
  return { record, list, vote, votes, get: (id) => rows.get(id) || null, updateStatus, update, remove, stats }
}
