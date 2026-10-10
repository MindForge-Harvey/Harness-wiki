import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceInput } from '../src/lib/voice-input.mjs';

function fixture(environment = {}) {
  const instances = [], states = [], texts = [];
  class Recognition {
    constructor() { instances.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
  }
  const controller = createVoiceInput({
    environment: { SpeechRecognition: Recognition, isSecureContext: true, ...environment },
    onState: state => states.push(state), onTranscript: text => texts.push(text),
  });
  return { controller, instances, states, texts };
}

test('microphone starts only on demand and uses Chinese interim recognition', () => {
  const f = fixture();
  assert.equal(f.instances.length, 0);
  f.controller.start();
  f.controller.start();
  assert.equal(f.instances.length, 1);
  assert.equal(f.instances[0].lang, 'zh-CN');
  assert.equal(f.instances[0].interimResults, true);
  assert.equal(f.states.at(-1).status, 'starting');
  f.instances[0].onstart();
  assert.equal(f.states.at(-1).status, 'listening');
});

test('revised partial transcripts replace guesses instead of duplicating words', () => {
  const f = fixture(); f.controller.start();
  const recognition = f.instances[0];
  recognition.onresult({ results: [[{ transcript: '报销需' }]] });
  recognition.onresult({ results: [[{ transcript: '报销需要审批。' }], [{ transcript: '请查询制度。' }]] });
  assert.deepEqual(f.texts, ['报销需', '报销需要审批。请查询制度。']);
});

test('finishing listening keeps the final transcript until the recognition ends', () => {
  const f = fixture(); f.controller.start();
  f.controller.stop();
  assert.equal(f.states.at(-1).status, 'stopping');
  assert.equal(f.instances[0].stopped, true);
  f.instances[0].onresult({ results: [[{ transcript: '最终识别文字' }]] });
  f.instances[0].onend();
  assert.equal(f.texts.at(-1), '最终识别文字');
  assert.equal(f.states.at(-1).status, 'idle');
  f.controller.start();
  assert.equal(f.instances.length, 2);
});

test('manual editing or switching chats cancels late microphone results', () => {
  const f = fixture(); f.controller.start();
  const late = f.instances[0].onresult;
  f.controller.cancel();
  late({ results: [[{ transcript: '旧会话迟到的结果' }]] });
  assert.equal(f.instances[0].aborted, true);
  assert.equal(f.texts.length, 0);
});

test('permission and network failures are actionable and allow retry', () => {
  const f = fixture();
  for (const error of ['not-allowed', 'network', 'no-speech']) {
    f.controller.start();
    f.instances.at(-1).onerror({ error });
    assert.equal(f.states.at(-1).status, 'idle');
    assert.ok(f.states.at(-1).error.length > 0);
  }
  assert.equal(f.instances.length, 3);
});

test('unsupported browsers and insecure pages keep typing available', () => {
  for (const env of [{ SpeechRecognition: null }, { isSecureContext: false }]) {
    const f = fixture(env); f.controller.start();
    assert.equal(f.instances.length, 0);
    assert.equal(f.states.at(-1).status, 'idle');
    assert.ok(f.states.at(-1).error);
  }
});

test('prefixed recognition works and disposal detaches all callbacks', () => {
  const states = [];
  let recognition;
  class WebkitRecognition {
    constructor() { recognition = this; }
    start() {}
    abort() { this.aborted = true; }
  }
  const controller = createVoiceInput({ environment: { webkitSpeechRecognition: WebkitRecognition }, onState: state => states.push(state), onTranscript() {} });
  controller.start(); controller.dispose(); controller.start();
  assert.equal(recognition.aborted, true);
  assert.equal(recognition.onresult, null);
  assert.equal(states.at(-1).status, 'starting'); // Disposal never updates unmounted UI.
});
