import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPortalSession, portalIdentity } from '../portal-session.mjs';

async function check(result, { cookie = '', baseUrl = 'http://portal-auth:8080' } = {}) {
  const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(status) { this.status = status; }, end() {} };
  const fetcher = async (url, options) => {
    assert.equal(url, 'http://portal-auth:8080/api/auth/me');
    assert.equal(options.headers.cookie, cookie);
    assert.equal(options.redirect, 'error');
    if (result instanceof Error) throw result;
    return { ok: result.ok !== false, json: async () => result };
  };
  await checkPortalSession({ headers: { cookie } }, response, { baseUrl, fetcher });
  assert.equal(response.headers['Cache-Control'], 'no-store');
  return response.status;
}

test('only a portal-validated identity can access the app', async () => {
  assert.equal(await check({ authenticated: false }, { cookie: 'portal_session=forged' }), 401);
  assert.equal(await check({ authenticated: true, user: { username: 'demo', uid: 'user-demo' } }, { cookie: 'portal_session=validated' }), 204);
  assert.equal(await check({ authenticated: true }), 401);
});
test('missing configuration or unavailable authentication fails closed', async () => {
  assert.equal(await check({}, { baseUrl: '' }), 503);
  assert.equal(await check({ ok: false }), 503);
  assert.equal(await check(new Error('timeout')), 503);
});

test('answer votes use the portal identity and cannot accept a caller-supplied username', async () => {
  const user = await portalIdentity({ headers: { cookie: 'validated', 'x-user': 'forged' } }, {
    baseUrl: 'http://portal-auth:8080',
    fetcher: async () => ({ ok: true, json: async () => ({ authenticated: true, user: { username: 'alice', uid: 'user-alice' } }) }),
  });
  assert.equal(user.username, 'alice');
  await assert.rejects(portalIdentity({ headers: {} }, { baseUrl: '', allowLocal: false }), { status: 503 });
});
