import { WebSocket, WebSocketServer } from 'ws';

const PREFIX = '/api/v1/voice';
const RETENTION_MS = 15 * 60 * 1000;

/** Authenticated same-origin bridge; upstream receives no portal cookies. */
export function createVoiceProxy({ baseUrl = process.env.VOICE_API_BASE_URL || 'http://127.0.0.1:8765',
  identify, fetcher = fetch, now = Date.now } = {}) {
  const base = new URL(baseUrl.replace(/\/+$/, '') + '/');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('VOICE_API_BASE_URL 必须是无凭据的 HTTP(S) 服务根地址');
  }
  const upstreamUrl = suffix => new URL('api/v1/voice/' + suffix, base);
  const owners = new Map();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64000, perMessageDeflate: false });
  const prune = () => {
    for (const [id, owner] of owners) if (owner.expires <= now()) owners.delete(id);
  };
  function requireOwner(id, uid) {
    prune();
    if (owners.get(id)?.uid !== uid) throw Object.assign(new Error('语音会话不存在或已过期'), { status: 404 });
  }
  const rejectUpgrade = (socket, status) => {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  return {
    async handle(req, res, pathname) {
      const match = pathname.match(/^\/api\/v1\/voice\/sessions\/([a-f0-9]{32})(\/cancel)?$/);
      const capabilities = pathname === PREFIX + '/capabilities' && req.method === 'GET';
      if (!capabilities && !(match && req.method === (match[2] ? 'POST' : 'GET'))) return false;
      if (match) requireOwner(match[1], req.identity.uid);
      let response;
      try {
        response = await fetcher(upstreamUrl(capabilities ? 'capabilities' : 'sessions/' + match[1] + (match[2] || '')), {
          method: req.method, signal: AbortSignal.timeout(10000), redirect: 'error',
        });
      } catch {
        throw Object.assign(new Error('实时语音服务连接失败，请检查后台服务。'), { status: 503 });
      }
      const body = await response.text();
      res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    },
    async upgrade(req, socket, head) {
      if (new URL(req.url, 'http://localhost').pathname !== PREFIX + '/ws') return rejectUpgrade(socket, 404);
      try {
        // A WebSocket cannot send X-Harness-Request; verify its browser Origin instead.
        const origin = req.headers.origin;
        if ((!origin && process.env.NODE_ENV === 'production') || (origin &&
          (!['http:', 'https:'].includes(new URL(origin).protocol) || new URL(origin).host !== req.headers.host))) {
          return rejectUpgrade(socket, 403);
        }
        const identity = await identify(req);
        if (socket.destroyed) return;
        const url = upstreamUrl('ws');
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const upstream = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
        let client = null, sessionId = null;
        socket.once('close', () => {
          if (!client) upstream.terminate();
        });
        upstream.on('error', () => {
          if (client) client.close(1011, 'Voice service unavailable');
          else rejectUpgrade(socket, 503);
        });
        upstream.once('open', () => {
          if (socket.destroyed) { upstream.terminate(); return; }
          sockets.handleUpgrade(req, socket, head, downstream => {
            client = downstream;
            downstream.on('message', (data, binary) => {
              if (upstream.readyState !== WebSocket.OPEN) return downstream.close(1011);
              if (upstream.bufferedAmount > 1024 * 1024) return downstream.close(1013, 'Audio backlog');
              upstream.send(data, { binary });
            });
            downstream.on('error', () => upstream.close());
            downstream.once('close', () => upstream.close());
          });
        });
        upstream.on('message', (data, binary) => {
          if (!client || client.readyState !== WebSocket.OPEN) return;
          if (!binary) {
            try {
              const event = JSON.parse(data.toString());
              if (event.type === 'ready' && /^[a-f0-9]{32}$/.test(event.session_id)) {
                prune();
                sessionId = event.session_id;
                owners.set(sessionId, { uid: identity.uid, expires: Infinity });
              }
            } catch { /* The client reports malformed upstream messages. */ }
          }
          if (client.bufferedAmount > 1024 * 1024) return client.close(1013, 'Transcript backlog');
          client.send(data, { binary });
        });
        upstream.once('close', (code) => {
          if (sessionId && owners.has(sessionId)) owners.get(sessionId).expires = now() + RETENTION_MS;
          if (client) client.close(code === 1000 ? 1000 : 1011);
          else rejectUpgrade(socket, 503);
        });
      } catch (error) { rejectUpgrade(socket, error.status || 403); }
    },
    close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      owners.clear();
    },
  };
}
