/** Only the browser projection is filtered; SDK context and persisted events stay intact. */
import { plainAssistantText } from './narrative.mjs'

export function presentNotification(notification) {
  const event = notification.params?.event
  if (event?.type !== 'assistant/message') return notification
  const message = event.data?.message
  if (!message?.content) return notification
  return { ...notification, params: { ...notification.params, event: { ...event,
    data: { ...event.data, message: { ...message,
      content: message.content.filter(block => block?.type !== 'reasoning')
        .map(block => block?.type === 'text' ? { ...block, text: plainAssistantText(block.text) } : block),
    } },
  } } }
}

/** 把会话日志投影为前端可渲染的展示事件（user/assistant/tool/approval/error）。 */
export function projectHistory(events) {
  const toolIndexByCall = new Map()
  const pendingApprovals = []
  const out = []
  const textOf = (blocks) => (blocks || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('')

  for (const e of events) {
    const d = e.data || {}
    switch (e.type) {
      case 'user/message': {
        if (d.source?.kind !== 'user') break
        out.push({ seq: e.seq, time: e.time, kind: 'user', text: textOf(d.content) })
        break
      }
      case 'assistant/message': {
        const blocks = d.message?.content || []
        const text = plainAssistantText(textOf(blocks))
        if (text) out.push({ seq: e.seq, time: e.time, kind: 'assistant', text })
        break
      }
      case 'tool/call': {
        toolIndexByCall.set(d.callId, out.length)
        out.push({ seq: e.seq, time: e.time, kind: 'tool', callId: d.callId, name: d.name || '', argsText: String(d.arguments || ''), status: 'running' })
        break
      }
      case 'tool/result': {
        const block = d.message?.content?.find?.((b) => b && b.type === 'tool-result')
        const idx = block?.toolCallId ? toolIndexByCall.get(block.toolCallId) : undefined
        if (idx === undefined) break
        out[idx].status = block?.isError ? 'error' : 'done'
        const result = textOf(block?.content)
        out[idx].resultText = result.slice(0, 4000)
        try { out[idx].resultJson = JSON.parse(result) } catch { /* 非结构化结果保留文本 */ }
        break
      }
      case 'approval/asked': {
        out.push({ seq: e.seq, time: e.time, kind: 'approval', approvalKey: `approval-${e.seq}`, toolName: d.toolName || '', callId: d.callId || '', reason: d.reason || '', status: 'pending' })
        pendingApprovals.push(out.length - 1)
        break
      }
      case 'approval/decided': {
        const idx = pendingApprovals.shift()
        if (idx !== undefined) out[idx].status = d.outcome === 'allowed-once' ? 'allowed' : 'rejected'
        break
      }
      case 'turn/end': {
        for (const idx of toolIndexByCall.values()) {
          if (out[idx].status === 'running') out[idx].status = 'interrupted'
        }
        if (d.reason?.kind === 'error') {
          out.push({ seq: e.seq, time: e.time, kind: 'error', message: d.reason?.error?.message || '本轮执行失败' })
        }
        break
      }
      default:
        break
    }
  }
  return out
}
