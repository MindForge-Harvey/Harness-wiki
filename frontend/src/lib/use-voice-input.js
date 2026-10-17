import { useEffect, useRef, useState } from 'react';
import { createVoiceInput } from './voice-input.mjs';
import { appUrl } from './app-url';

export function useVoiceInput(onTranscript) {
  const [state, setState] = useState({ status: 'idle', error: '', message: '', warning: '' });
  const controller = useRef(null);
  const callback = useRef(onTranscript);
  callback.current = onTranscript;
  useEffect(() => {
    controller.current = createVoiceInput({
      apiBase: appUrl('api/v1/voice/'),
      configUrl: appUrl('api/v1/voice/config'),
      authReturnPath: appUrl('api/health'),
      onState: setState,
      onTranscript: text => callback.current(text),
    });
    return () => { controller.current.dispose(); controller.current = null; };
  }, []);
  return {
    ...state,
    active: state.status !== 'idle',
    start: () => controller.current?.start(),
    stop: () => controller.current?.stop(),
    cancel: () => controller.current?.cancel(),
  };
}
