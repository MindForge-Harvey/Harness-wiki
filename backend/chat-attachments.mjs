import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', csv: 'text/plain', json: 'text/plain' }
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const safeSession = sessionId => {
  if (typeof sessionId !== 'string' || !/^[\w-]{1,200}$/.test(sessionId)) fail('会话标识无效')
  return sessionId
}

export function validateAttachments(input) {
  if (input == null) return []
  if (!Array.isArray(input)) fail('附件列表无效')
  if (input.length > 8) fail('每条消息最多添加 8 个附件')
  let total = 0
  return input.map(item => {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255) fail('附件名称无效')
    if (typeof item.data !== 'string' || !item.data || item.data.length > Math.ceil(20 * 1024 * 1024 / 3) * 4) fail('附件为空或超过 20 MB', 413)
    const bytes = Buffer.from(item.data, 'base64')
    if (bytes.toString('base64') !== item.data) fail('附件编码无效')
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) fail('附件为空或超过 20 MB', 413)
    total += bytes.length
    if (total > 40 * 1024 * 1024) fail('附件总大小不能超过 40 MB', 413)
    const name = item.name.replace(/[\x00-\x1f\x7f/\\]/g, '_')
    const mimeType = MIME_BY_EXT[name.split('.').pop().toLowerCase()] || (/^[\w.+-]+\/[\w.+-]+$/.test(item.mimeType || '') ? item.mimeType : 'application/octet-stream')
    return { name, mimeType, bytes, data: item.data }
  })
}

export function createChatAttachmentStore(root) {
  const directory = sessionId => path.join(root, safeSession(sessionId))
  const publicItem = (sessionId, item) => ({ id: item.id, name: item.name, size: item.size, mimeType: item.mimeType, url: `api/chat/attachments/${sessionId}/${item.id}` })
  const records = sessionId => {
    const dir = directory(sessionId)
    let entries
    try { entries = fs.readdirSync(dir) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    return entries.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
  }
  return {
    save(sessionId, message, input) {
      const files = validateAttachments(input)
      if (!files.length) return { prompt: message, attachments: [], content: [{ type: 'text', text: message }] }
      const dir = directory(sessionId)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const attachments = files.map(file => {
        const id = randomUUID()
        const extension = path.extname(file.name).toLowerCase()
        const filename = id + (/^\.[a-z0-9]{1,16}$/.test(extension) ? extension : '.bin')
        fs.writeFileSync(path.join(dir, filename), file.bytes, { mode: 0o600 })
        return { id, filename, name: file.name, size: file.bytes.length, mimeType: file.mimeType }
      })
      const prompt = message + '\n\n（用户随消息上传了 ' + attachments.length + ' 个文件，已保存到本地：' + attachments.map(item => `${item.name}（${path.join(dir, item.filename)}）`).join('；') + '。若用户想将其加入知识库，请用 kb_ingest 处理。）'
      const record = { message, prompt, attachments }
      const recordPath = path.join(dir, randomUUID() + '.json')
      fs.writeFileSync(recordPath + '.tmp', JSON.stringify(record), { mode: 0o600 })
      fs.renameSync(recordPath + '.tmp', recordPath)
      return {
        prompt,
        attachments: attachments.map(item => publicItem(sessionId, item)),
        content: [{ type: 'text', text: prompt }, ...files.filter(file => IMAGE_TYPES.has(file.mimeType)).map(file => ({ type: 'image', data: file.data, mimeType: file.mimeType }))],
      }
    },
    project(sessionId, events) {
      const turns = new Map(records(sessionId).map(record => [record.prompt, record]))
      return events.map(event => {
        const record = event.kind === 'user' && turns.get(event.text)
        return record ? { ...event, text: record.message, attachments: record.attachments.map(item => publicItem(sessionId, item)) } : event
      })
    },
    file(sessionId, id) {
      if (!/^[a-f0-9-]{36}$/.test(id)) fail('附件不存在', 404)
      const item = records(sessionId).flatMap(record => record.attachments).find(item => item.id === id)
      if (!item || path.basename(item.filename) !== item.filename) fail('附件不存在', 404)
      const filePath = path.join(directory(sessionId), item.filename)
      if (!fs.existsSync(filePath)) fail('附件不存在', 404)
      const inline = IMAGE_TYPES.has(item.mimeType) || ['image/avif', 'image/bmp', 'application/pdf'].includes(item.mimeType)
      return { ...item, path: filePath, contentType: inline ? item.mimeType : 'text/plain; charset=utf-8', inline }
    },
  }
}
