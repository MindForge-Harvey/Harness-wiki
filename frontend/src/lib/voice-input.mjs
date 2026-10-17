import { resolveVoiceConnection } from './voice-auth.mjs';

const microphoneErrors = {
  NotAllowedError: '麦克风访问未获允许，请在浏览器中开启权限后重试。',
  NotFoundError: '未找到可用的麦克风，请检查设备后重试。',
  NotReadableError: '麦克风无法使用，请检查是否被其他程序占用。',
};

/** One user action owns one capture session, including its final rewrite. */
export function createVoiceInput({ environment = globalThis, apiBase = '/api/v1/voice/', configUrl, authReturnPath,
  workletUrl = new URL('./pcm-capture-worklet.js', import.meta.url).href, onState, onTranscript }) {
  let session = null, disposed = false, silent = false;
  const current = s => !disposed && session === s;
  const emit = (status, error = '', message = '', warning = '', actionUrl = '') => {
    if (!disposed && !silent) onState({ status, error, message, warning, actionUrl });
  };
  const base = new URL(apiBase.replace(/\/?$/, '/'), environment.location?.href || 'http://localhost/');
  const endpoint = (s, path) => new URL(path, s.connection?.base || base).href;

  function releaseAudio(s) {
    s.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    s.stream = null;
    s.source?.disconnect();
    s.processor?.disconnect();
    if (s.processor) s.processor.port.onmessage = null;
    s.source = s.processor = null;
    const context = s.context;
    s.context = null;
    return context && context.state !== 'closed' ? context.close().catch(() => {}) : Promise.resolve();
  }

  function detachSocket(s) {
    const socket = s.socket;
    s.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
  }

  async function request(s, path, options = {}) {
    const response = await environment.fetch(endpoint(s, path), {
      ...options, credentials: 'same-origin', cache: 'no-store', headers: s.connection.headers,
      signal: AbortSignal.any([s.abort.signal, AbortSignal.timeout(5000)]),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : data.detail || '语音服务暂不可用，请稍后重试。'), { status: response.status });
    return data;
  }

  function finish(s, error = '', warning = '', actionUrl = '') {
    if (!current(s)) return;
    session = null;
    s.abort.abort();
    clearTimeout(s.timer);
    clearTimeout(s.pollTimer);
    s.rejectPending?.(new Error('cancelled'));
    s.resolveFlush?.();
    detachSocket(s);
    void releaseAudio(s);
    emit('idle', error, '', warning, actionUrl);
  }

  function result(s, data) {
    if (!current(s)) return;
    if (data.text) onTranscript(data.text);
    const warnings = (data.warnings || []).filter(value => typeof value === 'string');
    if (['fallback', 'partial'].includes(data.rewrite?.status)) warnings.unshift('语音已转写，文字订正未完整完成。');
    finish(s, '', [...new Set(warnings)].join(' '));
  }

  async function recover(s) {
    if (!current(s) || s.recovering) return;
    if (!s.stopSent || !s.id) {
      finish(s, '实时语音连接已中断，已收到的文字仍可编辑。请重新开始录音。');
      return;
    }
    s.recovering = true;
    detachSocket(s);
    const poll = async () => {
      if (!current(s)) return;
      try {
        const data = await request(s, 'sessions/' + s.id);
        if (!current(s)) return;
        if (data.state === 'completed') return result(s, data);
        if (['failed', 'cancelled', 'listening'].includes(data.state)) {
          return finish(s, data.error?.message || '语音处理未完成，已收到的文字仍可编辑。');
        }
        emit('stopping', '', data.message || '正在等待语音订正…');
      } catch (error) {
        if (!current(s)) return;
        if ([401, 403, 404].includes(error.status)) return finish(s, error.message);
      }
      s.pollTimer = setTimeout(poll, 1000);
    };
    await poll();
  }

  function cancel() {
    const s = session;
    if (!s) { emit('idle'); return; }
    if (s.id && s.stopSent) {
      // A recording socket's close already discards its audio. After stop, the
      // queued rewrite survives disconnect and needs an explicit HTTP cancel.
      void environment.fetch(endpoint(s, 'sessions/' + s.id + '/cancel'), {
        method: 'POST', credentials: 'same-origin', headers: s.connection.headers, signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    if (s.socket?.readyState === 1) s.socket.send(JSON.stringify({ type: 'cancel' }));
    finish(s);
  }

  return {
    async start() {
      if (disposed || session) return;
      const AudioContext = environment.AudioContext || environment.webkitAudioContext;
      if (environment.isSecureContext === false) return emit('idle', '语音输入需要 HTTPS 或本机 localhost 页面。');
      if (!environment.navigator?.mediaDevices?.getUserMedia || !AudioContext || !environment.AudioWorkletNode || !environment.WebSocket) {
        return emit('idle', '当前浏览器无法采集实时语音，请使用较新版本的浏览器或直接输入文字。');
      }
      const s = { abort: new AbortController(), status: 'starting' };
      session = s;
      emit('starting');
      try {
        // Resume within the click gesture, before any network request.
        s.context = new AudioContext({ sampleRate: 16000 });
        await s.context.resume();
        if (!current(s)) return;
        s.connection = await resolveVoiceConnection({ environment, apiBase, configUrl, authReturnPath,
          signal: s.abort.signal, onStatus: message => { if (current(s)) emit('starting', '', message); } });
        if (!current(s)) return;
        const caps = await request(s, 'capabilities');
        if (!current(s)) return;
        if (caps.protocol_version !== 1 || caps.audio?.encoding !== 'pcm_s16le' || caps.audio?.sample_rate !== 16000 || caps.audio?.channels !== 1) {
          throw new Error('语音服务协议不兼容，请检查服务配置。');
        }
        if (!caps.ready) throw new Error('实时语音服务尚未就绪，请稍后重试。');
        const stream = await environment.navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
        });
        if (!current(s)) { stream.getTracks().forEach(track => track.stop()); return; }
        s.stream = stream;
        await s.context.audioWorklet.addModule(workletUrl);
        if (!current(s)) return;
        s.processor = new environment.AudioWorkletNode(s.context, 'pcm-capture');
        const socketUrl = new URL('ws', s.connection.base);
        socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = s.socket = new environment.WebSocket(socketUrl.href);
        await new Promise((resolve, reject) => {
          s.rejectPending = reject;
          s.timer = setTimeout(() => reject(new Error('实时语音服务连接超时，请检查后台服务。')), 15000);
          socket.onopen = () => {
            if (current(s)) socket.send(JSON.stringify({ type: 'start', sample_rate: 16000, channels: 1, encoding: 'pcm_s16le' }));
          };
          socket.onmessage = event => {
            if (!current(s)) return;
            let data;
            try { data = JSON.parse(event.data); } catch { finish(s, '语音服务返回了无效消息，请重试。'); return; }
            if (data.type === 'ready' && !s.id) {
              if (!/^[a-f0-9]{32}$/.test(data.session_id)) return finish(s, '语音服务返回了无效会话，请重试。');
              s.id = data.session_id;
              clearTimeout(s.timer);
              s.rejectPending = null;
              resolve();
            } else if (data.type === 'transcript') {
              if (data.text) onTranscript(data.text); // Cumulative previews replace previous guesses.
            } else if (data.type === 'result') {
              result(s, data);
            } else if (data.type === 'error') {
              if (data.fatal === false && s.stopSent) void recover(s);
              else finish(s, data.error?.message || data.message || '语音识别未完成，请重试。');
            } else if (data.type === 'state' && data.ui_state === 'rewriting') {
              emit('stopping', '', data.message || '正在订正语音文字…');
            } else if (data.type === 'state' && data.state === 'cancelled') {
              finish(s);
            }
          };
          socket.onerror = socket.onclose = () => { if (current(s)) void recover(s); };
        });
        if (!current(s)) return;
        s.processor.port.onmessage = event => {
          if (!current(s)) return;
          if (event.data.type === 'audio' && socket.readyState === 1) {
            if (socket.bufferedAmount > 1024 * 1024) return finish(s, '音频传输积压，请检查网络后重新录音。');
            socket.send(event.data.pcm);
          } else if (event.data.type === 'flushed') s.resolveFlush?.();
        };
        s.source = s.context.createMediaStreamSource(s.stream);
        s.source.connect(s.processor);
        s.processor.connect(s.context.destination);
        s.stream.getTracks().forEach(track => { track.onended = () => { if (current(s)) void this.stop(); }; });
        s.status = 'listening';
        emit('listening');
      } catch (error) {
        if (current(s)) finish(s, microphoneErrors[error.name] || (error.name === 'TypeError' ? '实时语音服务连接失败，请检查后台服务。' : error.message), '', error.actionUrl);
      }
    },
    async stop() {
      const s = session;
      if (!s || s.status === 'stopping') return;
      if (s.status === 'starting') { cancel(); return; }
      s.status = 'stopping';
      emit('stopping', '', '正在结束听录…');
      try {
        s.source.disconnect();
        await new Promise((resolve, reject) => {
          s.rejectPending = reject;
          s.timer = setTimeout(() => reject(new Error('麦克风未能及时结束，已收到的文字仍可编辑。')), 3000);
          s.resolveFlush = () => { clearTimeout(s.timer); s.rejectPending = null; resolve(); };
          s.processor.port.postMessage({ type: 'flush' });
        });
        if (!current(s)) return;
        await releaseAudio(s);
        if (!current(s)) return;
        if (s.socket?.readyState !== 1) throw new Error('实时语音连接已中断，已收到的文字仍可编辑。');
        s.stopSent = true;
        s.socket.send(JSON.stringify({ type: 'stop' }));
        s.timer = setTimeout(() => {
          if (!current(s)) return;
          cancel();
          emit('idle', '等待语音订正超时，已收到的文字仍可编辑。');
        }, 120000);
      } catch (error) { if (current(s)) finish(s, error.message); }
    },
    cancel,
    dispose() { silent = true; cancel(); disposed = true; },
  };
}
