/** Identity comes from the portal's signed cookie, not a username in the request body. */
export async function portalIdentity(req, { baseUrl = process.env.PORTAL_AUTH_URL, fetcher = fetch, allowLocal = process.env.NODE_ENV !== 'production' } = {}) {
  // 内网免认证部署（DISABLE_PORTAL_AUTH=1）：所有请求统一视为本地账号，不校验门户会话。
  if (process.env.DISABLE_PORTAL_AUTH === '1') return { username: 'local', uid: 'local' };
  if (!baseUrl) {
    if (allowLocal) return { username: 'local', uid: 'local' };
    throw Object.assign(new Error('认证服务未配置'), { status: 503 });
  }
  try {
    const response = await fetcher(baseUrl.replace(/\/+$/, '') + '/api/auth/me', {
      headers: { cookie: req.headers.cookie || '' },
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw Object.assign(new Error('认证服务暂不可用'), { status: 503 });
    const identity = await response.json();
    if (identity.authenticated !== true || !identity.user?.username || !identity.user?.uid) throw Object.assign(new Error('请登录后再操作'), { status: 401 });
    if (req.headers['x-portal-user'] && req.headers['x-portal-user'] !== identity.user.uid) throw Object.assign(new Error('登录账号已切换，请刷新后继续'), { status: 401 });
    return identity.user;
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error('认证服务暂不可用'), { status: 503 });
  }
}

/** The existing portal validates its CAS-backed, signed session cookie. */
export async function checkPortalSession(req, res, { baseUrl = process.env.PORTAL_AUTH_URL, fetcher = fetch } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  // 内网免认证部署：登录态检查直接视为已登录。
  if (process.env.DISABLE_PORTAL_AUTH === '1') { res.writeHead(204); res.end(); return; }
  if (!baseUrl) { res.writeHead(503); res.end(); return; }
  try {
    await portalIdentity(req, { baseUrl, fetcher, allowLocal: false });
    res.writeHead(204);
    res.end();
  } catch (error) { res.writeHead(error.status || 503); res.end(); }
}
