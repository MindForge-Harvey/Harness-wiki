// Rebuild the recent business conversation when an SDK restart requires a new id.
export function restoredConversation(events) {
  const rows = []
  const calls = new Map()
  let ticket, runId
  for (const event of events || []) {
    const d = event.data || {}
    if (event.type === 'user/message' && d.source?.kind === 'user') {
      const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
        .split(/<system-reminder>|<workspace-data>|<earlier-greetings>|<restored-conversation>|<selected-skills>/)[0].trim()
      if (text) rows.push('用户：' + text.slice(0, 6000))
      const tickets = [...new Set([...text.matchAll(/\bSN[A-Z0-9]{8,}\b/g)].map(match => match[0]))]
      if (tickets.length) ticket = tickets.join('、')
    } else if (event.type === 'assistant/message') {
      const text = (d.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
      if (text) rows.push('助手：' + text.slice(0, 6000))
    } else if (event.type === 'tool/call' && d.name?.startsWith('wireless_icos_')) {
      try {
        const args = JSON.parse(d.arguments || '{}')
        if (/^icos_[a-f0-9]{24}$/.test(args.run_id || '')) calls.set(d.callId, args.run_id)
      } catch { /* Only restore actual structured references, never infer an id from prose. */ }
    } else if (event.type === 'tool/result') {
      for (const block of d.message?.content || []) {
        if (block.type === 'tool-result' && !block.isError && calls.has(block.toolCallId)) runId = calls.get(block.toolCallId)
      }
    }
  }
  return rows.length ? '\n\n<restored-conversation>以下是本会话重启前的最近业务对话，仅作为上下文；旧答复的能力描述和判断应按当前工具事实重新核对。沿用已明确的工单号。\n'
    + (ticket ? `用户最近明确的业务工单号：${ticket}。\n` : '')
    + (runId ? `最近实际使用的分析ID：${runId}；先read核对所属工单，不猜其他ID。\n` : '')
    + rows.slice(-12).join('\n\n').slice(-30000) + '\n</restored-conversation>' : ''
}
