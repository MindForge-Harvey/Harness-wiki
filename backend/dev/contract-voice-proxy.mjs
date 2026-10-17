import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createVoiceProxy } from '../voice-proxy.mjs';

const id = 'b'.repeat(32);
async function fixture(t, options = {}) {
  const upstreamRequests = [], audio = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push(req);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/capabilities') ? { ready: true, protocol_version: 1 } : { session_id: id, state: 'completed', text: '最终文字' }));
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (socket, req) => {
    upstreamRequests.push(req);
    socket.on('message', (buffer, binary) => {
      if (binary) { audio.push(buffer); return; }
      const control = JSON.parse(buffer);
      if (control.type === 'start') socket.send(JSON.stringify({ type: 'ready', session_id: id }));
      if (control.type === 'stop') {
        socket.send(JSON.stringify({ type: 'result', state: 'completed', text: '最终文字' }));
        socket.close(1000);
      }
    });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const identify = async req => {
    const uid = req.headers.cookie?.match(/user=(\w+)/)?.[1];
    if (!uid) throw Object.assign(new Error('请登录'), { status: 401 });
    return { uid };
  };
  const proxy = createVoiceProxy({ baseUrl: `http://127.0.0.1:${upstream.address().port}/speech/`, identify, ...options });
  const server = http.createServer(async (req, res) => {
    try {
      req.identity = await identify(req);
      if (!await proxy.handle(req, res, new URL(req.url, 'http://localhost').pathname)) { res.writeHead(404); res.end(); }
    } catch (error) { res.writeHead(error.status || 502); res.end(JSON.stringify({ error: error.message })); }
  });
  server.on('upgrade', (req, socket, head) => { void proxy.upgrade(req, socket, head); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, uid = 'alice', method = 'GET') => fetch(base + '/api/v1/voice/' + path, { method, headers: { cookie: 'user=' + uid } });
  async function connect() {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/v1/voice/ws', { origin: base, headers: { cookie: 'user=alice' } });
    await once(socket, 'open');
    const ready = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'start', sample_rate: 16000, channels: 1, encoding: 'pcm_s16le' }));
    assert.equal(JSON.parse((await ready)[0]).type, 'ready');
    return socket;
  }
  t.after(async () => {
    proxy.close();
    for (const socket of wss.clients) socket.terminate();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => wss.close(resolve))]);
    await new Promise(resolve => upstream.close(resolve));
  });
  return { request, connect, base, upstreamRequests, audio };
}

test('same-origin authenticated socket relays raw PCM and final results without forwarding credentials', async t => {
  const f = await fixture(t);
  const caps = await f.request('capabilities'); assert.equal((await caps.json()).ready, true);
  assert.equal(f.upstreamRequests[0].url, '/speech/api/v1/voice/capabilities');
  const socket = await f.connect();
  socket.send(Buffer.from([1, 0, 2, 0]));
  const result = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'stop' }));
  assert.equal(JSON.parse((await result)[0]).text, '最终文字');
  assert.deepEqual([...f.audio[0]], [1, 0, 2, 0]);
  for (const req of f.upstreamRequests) {
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.origin, undefined);
  }
  assert.equal((await f.request('sessions/' + id)).status, 200);
  assert.equal((await f.request('sessions/' + id + '/cancel', 'alice', 'POST')).status, 200);
});

test('voice session results and cancellation are scoped to the authenticated owner', async t => {
  const f = await fixture(t), socket = await f.connect();
  assert.equal((await f.request('sessions/' + id, 'bob')).status, 404);
  assert.equal((await f.request('sessions/' + id + '/cancel', 'bob', 'POST')).status, 404);
  assert.equal((await f.request('sessions/' + 'c'.repeat(32))).status, 404);
  assert.equal((await f.request('capabilities', '')).status, 401);
  socket.close();
});

test('cross-origin and unauthenticated upgrades fail before touching the speech service', async t => {
  const f = await fixture(t);
  for (const options of [{ origin: 'https://evil.example', headers: { cookie: 'user=alice' } }, { origin: f.base }]) {
    const socket = new WebSocket(f.base.replace('http:', 'ws:') + '/api/v1/voice/ws', options);
    socket.on('error', () => {});
    const response = await new Promise(resolve => socket.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); socket.terminate(); }));
    assert.equal(response, options.headers ? 403 : 401);
  }
  assert.equal(f.upstreamRequests.length, 0);
});

test('expired bridge sessions fail closed and invalid service URLs are rejected', async t => {
  let time = 0;
  const f = await fixture(t, { now: () => time }), socket = await f.connect();
  const closed = once(socket, 'close'); socket.send(JSON.stringify({ type: 'stop' })); await closed;
  assert.equal((await f.request('sessions/' + id)).status, 200);
  time = 16 * 60 * 1000;
  assert.equal((await f.request('sessions/' + id)).status, 404);
  for (const baseUrl of ['file:///tmp/service', 'http://user:password@example.com', 'https://example.com/?key=value']) {
    assert.throws(() => createVoiceProxy({ baseUrl }));
  }
});

test('unavailable upstream returns an actionable service error', async t => {
  const f = await fixture(t, { fetcher: async () => { throw new TypeError('fetch failed'); } });
  const response = await f.request('capabilities');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, '实时语音服务连接失败，请检查后台服务。');
});
