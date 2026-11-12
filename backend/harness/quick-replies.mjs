import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Only a complete greeting is handled here. Business requests always enter Harness.
export function greetingReply(message, hasAttachments = false) {
  if (hasAttachments || !/^(?:你好(?:呀|啊|！|!)?|您好|嗨|哈喽|hello|hi|在吗|早上好|下午好|晚上好)[\s！!。.?？]*$/i.test(message.trim())) return null
  return '你好，我是无忧侠。可以帮你查询和总结工单、分析根因、生成优化方案、评估效果、总结历史经验。'
}

export function createQuickReplyHistory(home) {
  const directory = path.join(home, 'storages', 'quick-replies')
  const fileFor = id => path.join(directory, crypto.createHash('sha256').update(id).digest('hex') + '.json')
  function read(id) {
    const file = fileFor(id)
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
  }
  return {
    read,
    append(id, message, answer) {
      fs.mkdirSync(directory, { recursive: true })
      const rows = read(id), time = Date.now()
      rows.push({ time, kind: 'user', text: message }, { time: time + 1, kind: 'assistant', text: answer })
      const file = fileFor(id), temporary = file + '.tmp'
      fs.writeFileSync(temporary, JSON.stringify(rows) + '\n', { mode: 0o600 })
      fs.renameSync(temporary, file)
    },
    merge(id, rows) {
      return [...read(id), ...rows].sort((a, b) => a.time - b.time).map((row, index) => ({ ...row, seq: index + 1 }))
    },
    context(id) {
      const rows = read(id).slice(-6)
      return rows.length ? '\n\n<earlier-greetings>此前本会话的即时问候记录：\n' + rows.map(row => `${row.kind === 'user' ? '用户' : '助手'}：${row.text}`).join('\n') + '\n</earlier-greetings>' : ''
    },
  }
}
