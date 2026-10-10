/** Identity comes from the portal's signed cookie, not a username in the request body. */
export async function portalIdentity(req, { baseUrl = process.env.PORTAL_AUTH_URL, fetcher = fetch, allowLocal = process.env.NODE_ENV !== 'production' } = {}) {
  if (!baseUrl) {
    if (allowLocal) return { username: 'local' };
    throw Object.assign(new Error('认证服务未配置'), { status: 503 });
  }
  try {
    const response = await fetcher(baseUrl.replace(/\/+$/, '') + '/api/auth/me', {
      headers: { cookie: req.headers.cookie || '' },
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw Object.assign(new Error('认证服务暂不可用'), { status: 503 });
    const identity = await response.json();
    if (identity.authenticated !== true || !identity.user?.username) throw Object.assign(new Error('请登录后再操作'), { status: 401 });
    return identity.user;
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error('认证服务暂不可用'), { status: 503 });
  }
}

/** The existing portal validates its CAS-backed, signed session cookie. */
export async function checkPortalSession(req, res, { baseUrl = process.env.PORTAL_AUTH_URL, fetcher = fetch } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (!baseUrl) { res.writeHead(503); res.end(); return; }
  try {
    await portalIdentity(req, { baseUrl, fetcher, allowLocal: false });
    res.writeHead(204);
    res.end();
  } catch (error) { res.writeHead(error.status || 503); res.end(); }
}
