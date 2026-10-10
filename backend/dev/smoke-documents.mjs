// Live smoke test: creates only uniquely named test documents and cleans them up.
// Run with Node >=22: node backend/dev/smoke-documents.mjs
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const base = process.env.WIKI_API_BASE || 'http://127.0.0.1:3088'
const source = 'llm-wiki-smoke-' + Date.now()
const code = source + '-729'
const created = new Set()

async function request(route, method = 'GET', body, raw = false) {
  const response = await fetch(base + '/api/kb' + route, {
    method, headers: raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  })
  const value = await response.json()
  assert(response.ok && value.ok !== false, route + ': ' + JSON.stringify(value))
  return value
}

async function waitIntent(id) {
  const until = Date.now() + 12 * 60 * 1000
  let previous
  while (Date.now() < until) {
    const data = await request('/intents?limit=200')
    const intent = data.intents.find((item) => item.id === id)
    assert(intent, '意图不存在: ' + id)
    if (intent.status !== previous) {
      console.log('intent', intent.kind, intent.status)
      previous = intent.status
    }
    if (intent.status === 'verified') return intent
    assert(!['failed', 'stuck'].includes(intent.status), JSON.stringify(intent))
    await delay(3000)
  }
  throw new Error('文档处理超时: ' + id)
}

// One-page PDF with selectable text and exact xref offsets; no external fixture.
function pdf(text) {
  const lines = ['LLM WIKI Integration Check', 'Knowledge base: LightRAG on Aliyun.', 'Document parser: MinerU on Aliyun.', text]
  const stream = 'BT /F1 14 Tf 50 740 Td ' + lines.map((line, i) => (i ? '0 -28 Td ' : '') + '(' + line + ') Tj').join(' ') + ' ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream',
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += (i + 1) + ' 0 obj\n' + object + '\nendobj\n'
  }
  const xref = Buffer.byteLength(output)
  output += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  return Buffer.from(output + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n')
}

try {
  const upload = await request('/documents/upload?filename=' + source + '.pdf', 'POST', pdf('Verification code: ' + code), true)
  const inserted = await waitIntent(upload.intent_id)
  const docId = inserted.docId || inserted.newDocId
  assert(docId, '未返回文档 id: ' + JSON.stringify(inserted))
  created.add(docId)
  console.log('PASS PDF -> remote MinerU -> LightRAG:', docId)

  const query = await request('/query', 'POST', { query: 'What is the verification code in ' + source + '.pdf? Answer only the code.', mode: 'mix' })
  assert(query.response.includes(code), '未检索到测试验证码: ' + query.response)
  console.log('PASS retrieval with references:', query.references.length)

  const replacement = await request('/documents/' + docId + '/replace?filename=' + source + '.pdf', 'POST', pdf('Updated verification code: ' + code + '-v2'), true)
  const replaced = await waitIntent(replacement.intent_id)
  const newDocId = replaced.newDocId || replaced.docId
  // Deferred PDF parsing can retain a source-addressed id; verify the content and version.
  assert(newDocId, '替换未返回文档 id: ' + JSON.stringify(replaced))
  created.delete(docId)
  created.add(newDocId)
  const updatedDocs = await request('/documents?page_size=100')
  assert.equal(updatedDocs.items.find((doc) => doc.id === newDocId)?.version, 2, '替换未提升版本')
  const updatedQuery = await request('/query', 'POST', { query: 'What is the updated verification code in ' + source + '.pdf? Answer only the updated code.', mode: 'mix' })
  assert(updatedQuery.response.includes(code + '-v2'), '替换后检索到旧内容: ' + updatedQuery.response)
  console.log('PASS document replace:', newDocId)
} finally {
  // If a failure happened before its id was observed, locate only this test source.
  const docs = await request('/documents?page_size=100&include_retired=1')
  for (const doc of docs.items || []) {
    if (doc.source === source + '.pdf' && !doc.intent && !['retired', 'outdated'].includes(doc.status)) created.add(doc.id)
  }
  for (const id of created) {
    const deletion = await request('/documents/' + id + '?reason=integration-smoke-cleanup', 'DELETE')
    await waitIntent(deletion.intent_id)
    console.log('PASS document delete verified:', id)
  }
}
console.log('PASS all document integration checks')
