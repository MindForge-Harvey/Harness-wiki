const headers = { 'X-Harness-Request': '1', 'X-Speech-Request': '1' };

/** Production speech owns its CAS cookie, scoped to /speech-recognition/. */
export async function resolveVoiceConnection({ environment = globalThis, apiBase, configUrl, authReturnPath,
  signal, onStatus = () => {} }) {
  const origin = new URL(environment.location?.href || 'http://localhost/');
  let base = new URL(apiBase.replace(/\/?$/, '/'), origin);
  if (!configUrl) return { base, headers };
  const read = async (url, requestSignal = signal) => {
    const response = await environment.fetch(url, {
      credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(5000)]),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请刷新页面重新登录。' : '语音接入配置暂不可用，请稍后重试。');
    return data;
  };
  const config = await read(configUrl);
  if (!config.public_base_path) return { base, headers };
  if (!/^\/[A-Za-z0-9/_-]+$/.test(config.public_base_path) || config.public_base_path.startsWith('//') || !config.uid) {
    throw new Error('语音接入配置无效，请检查服务配置。');
  }
  const root = config.public_base_path.replace(/\/+$/, '');
  const entry = root + '/';
  const failure = message => Object.assign(new Error(message), { actionUrl: entry });
  const check = async requestSignal => {
    const data = await read(root + '/api/auth/me', requestSignal);
    if (!data.authenticated) return false;
    if (data.user?.uid !== config.uid) throw failure('语音服务与当前门户登录账号不一致，请重新登录语音服务后重试。');
    return true;
  };
  if (!await check(signal)) {
    onStatus('正在连接语音服务…');
    // Existing CAS login can finish in a same-origin frame without leaving the draft.
    // Never copy, mint or expose either application's signed session cookie.
    const login = new URL(root + '/api/auth/sso/login', origin);
    const returnTo = new URL(authReturnPath || '/api/health', origin);
    if (returnTo.origin !== origin.origin) throw new Error('语音登录回跳地址无效。');
    login.searchParams.set('return_to', returnTo.pathname);
    const frame = environment.document.createElement('iframe');
    frame.hidden = true;
    frame.title = '语音服务登录';
    frame.src = login.href;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    await new Promise((resolve, reject) => {
      let timer, ended = false;
      const finish = error => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        bounded.removeEventListener('abort', abort);
        frame.remove();
        error ? reject(error) : resolve();
      };
      const abort = () => finish(signal.aborted ? new DOMException('已取消', 'AbortError') :
        failure('语音服务登录未完成，请打开语音服务登录后重试。'));
      const poll = async () => {
        try { if (await check(bounded)) return finish(); }
        catch (error) { if (!ended && error.actionUrl) return finish(error); }
        if (!ended) timer = setTimeout(poll, 500);
      };
      bounded.addEventListener('abort', abort, { once: true });
      if (bounded.aborted) return abort();
      environment.document.body.appendChild(frame);
      void poll();
    });
  }
  base = new URL(root + '/api/v1/voice/', origin);
  return { base, headers };
}
