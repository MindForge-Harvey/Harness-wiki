import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVoiceConnection } from '../src/lib/voice-auth.mjs';

function fixture({ publicPath = '/speech-recognition', users = [], onFrame, configStatus = 200 } = {}) {
  const requests = [], frames = [];
  const abort = new AbortController();
  const environment = {
    location: { href: 'https://www.agent-show.com/harness-wiki/chat' },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: url.endsWith('/config') ? configStatus === 200 : true, status: configStatus,
        json: async () => url.endsWith('/config') ? { public_base_path: publicPath, uid: 'alice' } :
          users.shift() || { authenticated: false } };
    },
    document: {
      createElement: () => ({ remove() { this.removed = true; } }),
      body: { appendChild(frame) { frames.push(frame); onFrame?.(frame, abort); } },
    },
  };
  const resolve = () => resolveVoiceConnection({ environment, signal: abort.signal,
    apiBase: '/harness-wiki/api/v1/voice/', configUrl: '/harness-wiki/api/v1/voice/config', authReturnPath: '/harness-wiki/api/health' });
  return { environment, abort, resolve, requests, frames };
}
const alice = { authenticated: true, user: { uid: 'alice' } };

test('local mode keeps the authenticated harness proxy and does not open a login frame', async () => {
  const f = fixture({ publicPath: '' }), result = await f.resolve();
  assert.equal(result.base.href, 'https://www.agent-show.com/harness-wiki/api/v1/voice/');
  assert.equal(f.requests.length, 1); assert.equal(f.frames.length, 0);
});

test('production uses the speech subpath with its own Cookie and CSRF header', async () => {
  const f = fixture({ users: [alice] }), result = await f.resolve();
  assert.equal(result.base.href, 'https://www.agent-show.com/speech-recognition/api/v1/voice/');
  assert.equal(result.headers['X-Speech-Request'], '1');
  assert.equal(f.requests[1].url, '/speech-recognition/api/auth/me');
  assert.equal(f.requests[1].options.credentials, 'same-origin');
  assert.equal(f.frames.length, 0);
});

test('CAS bootstrap preserves the page and draft, uses the fixed callback flow, and removes its frame', async () => {
  const f = fixture({ users: [{ authenticated: false }, alice] });
  const result = await f.resolve();
  assert.equal(result.base.pathname, '/speech-recognition/api/v1/voice/');
  assert.equal(f.frames[0].hidden, true);
  const login = new URL(f.frames[0].src);
  assert.equal(login.pathname, '/speech-recognition/api/auth/sso/login');
  assert.equal(login.searchParams.get('return_to'), '/harness-wiki/api/health');
  assert.ok(f.frames[0].removed);
});

test('an account mismatch cannot start transcription or silently switch identities', async () => {
  const f = fixture({ users: [{ authenticated: true, user: { uid: 'bob' } }] });
  await assert.rejects(f.resolve(), error => error.message.includes('账号不一致') && error.actionUrl === '/speech-recognition/');
  assert.equal(f.frames.length, 0);
});

test('account mismatch after CAS login is rejected and releases the frame', async () => {
  const f = fixture({ users: [{ authenticated: false }, { authenticated: true, user: { uid: 'bob' } }] });
  await assert.rejects(f.resolve(), /账号不一致/);
  assert.ok(f.frames[0].removed);
});

test('editing or changing chats while CAS is pending aborts the login frame', async () => {
  const f = fixture({ onFrame: (_frame, abort) => queueMicrotask(() => abort.abort()) });
  await assert.rejects(f.resolve(), { name: 'AbortError' });
  assert.ok(f.frames[0].removed);
});

test('untrusted endpoints and expired portal logins fail before speech authentication', async () => {
  for (const publicPath of ['//evil.example', 'https://evil.example', '/speech-recognition/../other']) {
    const f = fixture({ publicPath });
    await assert.rejects(f.resolve(), /配置无效/); assert.equal(f.requests.length, 1);
  }
  await assert.rejects(fixture({ configStatus: 401 }).resolve(), /登录已过期/);
});
