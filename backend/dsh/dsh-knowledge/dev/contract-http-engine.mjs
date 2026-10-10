import assert from 'node:assert/strict'
import http from 'node:http'
import { createLightRagEngine } from '../lib/engine-port.js'

const originalKey = process.env.LIGHTRAG_API_KEY
process.env.LIGHTRAG_API_KEY = 'test-service-key'
const observed = []
const server = http.createServer(async (req, res) => {
  const body = []
  for await (const chunk of req) body.push(chunk)
  observed.push({ path: req.url, key: req.headers['x-api-key'], type: req.headers['content-type'], body: Buffer.concat(body).toString() })
  if (req.headers['x-api-key'] !== 'test-service-key') { res.writeHead(403); res.end('{"detail":"API Key required"}'); return }
  res.setHeader('content-type', 'application/json')
  if (req.url === '/query/stream') res.end('{"response":"stream works"}\n')
  else res.end('{"status":"ok"}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const engine = createLightRagEngine('http://127.0.0.1:' + server.address().port + '/remote')
  await engine.health()
  await engine.queryData({ query: 'test' })
  await engine.uploadFile('test.txt', Buffer.from('uploaded text'))
  // Use a non-prefix instance for the streaming fixture response.
  const lines = []
  await createLightRagEngine('http://127.0.0.1:' + server.address().port).queryStream({ query: 'test' }, (line) => lines.push(line))
  assert.equal(observed.length, 4)
  assert(observed.every((request) => request.key === 'test-service-key'))
  assert.equal(observed[0].path, '/remote/health')
  assert.match(observed[2].type, /^multipart\/form-data; boundary=/)
  assert.match(observed[2].body, /uploaded text/)
  assert.equal(lines[0].response, 'stream works')
  console.log('PASS HTTP auth: GET / JSON / multipart / streaming + remote prefix')
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  if (originalKey === undefined) delete process.env.LIGHTRAG_API_KEY
  else process.env.LIGHTRAG_API_KEY = originalKey
}
