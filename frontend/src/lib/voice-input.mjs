const errors = {
  'not-allowed': '麦克风访问未获允许，请在浏览器中开启权限后重试。',
  'service-not-allowed': '浏览器的语音服务不可用，请改用文字输入。',
  'audio-capture': '未找到可用的麦克风，请检查设备后重试。',
  'no-speech': '没有听到语音，请再试一次。',
  network: '语音服务连接失败，请检查网络后重试。',
  'language-not-supported': '当前语音服务不支持中文，请改用文字输入。',
};

/** Browser speech recognition is started only by a user action. */
export function createVoiceInput({ environment = globalThis, onState, onTranscript }) {
  let recognition = null, disposed = false;
  const emit = (status, error = '') => { if (!disposed) onState({ status, error }); };
  const detach = instance => {
    instance.onstart = instance.onresult = instance.onerror = instance.onend = null;
  };

  function cancel() {
    const current = recognition;
    recognition = null;
    if (current) {
      detach(current);
      try { current.abort(); } catch { /* Recognition may have ended already. */ }
    }
    emit('idle');
  }

  return {
    start() {
      if (disposed || recognition) return;
      const Recognition = environment.SpeechRecognition || environment.webkitSpeechRecognition;
      if (!Recognition) {
        emit('idle', '当前浏览器不支持语音输入，请使用支持语音识别的浏览器或直接输入文字。');
        return;
      }
      if (environment.isSecureContext === false) {
        emit('idle', '语音输入需要 HTTPS 或本机 localhost 页面。');
        return;
      }
      let current;
      try {
        current = new Recognition();
        recognition = current;
        current.lang = 'zh-CN';
        current.continuous = true;
        current.interimResults = true;
        current.maxAlternatives = 1;
        current.onstart = () => { if (recognition === current) emit('listening'); };
        current.onresult = event => {
          if (recognition !== current || disposed) return;
          // Interim results replace earlier guesses; they must not append duplicates.
          const text = Array.from(event.results, result => result[0]?.transcript || '').join('').trim();
          if (text) onTranscript(text);
        };
        current.onerror = event => {
          if (recognition !== current) return;
          recognition = null;
          detach(current);
          try { current.abort(); } catch { /* Ended recognition needs no cleanup. */ }
          emit('idle', event.error === 'aborted' ? '' : errors[event.error] || '语音识别未完成，请重试或直接输入文字。');
        };
        current.onend = () => {
          if (recognition !== current) return;
          recognition = null;
          detach(current);
          emit('idle');
        };
        emit('starting');
        current.start();
      } catch {
        cancel();
        emit('idle', '无法启动语音输入，请检查麦克风权限后重试。');
      }
    },
    stop() {
      if (!recognition) return;
      emit('stopping');
      try { recognition.stop(); } catch { cancel(); }
    },
    cancel,
    dispose() { disposed = true; cancel(); },
  };
}
