import { useEffect, useRef, useState } from 'react';
import { createVoiceInput } from './voice-input.mjs';

export function useVoiceInput(onTranscript) {
  const [state, setState] = useState({ status: 'idle', error: '' });
  const controller = useRef(null);
  const callback = useRef(onTranscript);
  callback.current = onTranscript;
  useEffect(() => {
    controller.current = createVoiceInput({
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
