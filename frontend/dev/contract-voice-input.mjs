import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createVoiceInput } from '../src/lib/voice-input.mjs';

const caps = { protocol_version: 1, ready: true, audio: { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le' } };
const id = 'a'.repeat(32);
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}, options = {}) {
  const sockets = [], states = [], texts = [], tracks = [], contexts = [], processors = [], requests = [];
  const stream = () => {
    const track = { stop() { this.stopped = true; } };
    tracks.push(track);
    return { getTracks: () => [track] };
  };
  class AudioContext {
    constructor(options) {
      this.options = options; this.state = 'running'; contexts.push(this);
      this.audioWorklet = { addModule: async url => { this.module = url; } };
    }
    async resume() {}
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class AudioWorkletNode {
    constructor() {
      processors.push(this);
      this.port = { postMessage: () => queueMicrotask(() => {
        this.port.onmessage?.({ data: { type: 'audio', pcm: new Uint8Array([1, 0]).buffer } });
        this.port.onmessage?.({ data: { type: 'flushed' } });
      }) };
    }
    connect() {}
    disconnect() {}
  }
  class WebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(data); }
    close() { this.closed = true; this.readyState = 3; }
    open() { this.readyState = 1; this.onopen(); }
    receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  const controller = createVoiceInput({ environment: {
    isSecureContext: true, location: { href: 'http://localhost:5173/chat' }, AudioContext, AudioWorkletNode, WebSocket,
    navigator: { mediaDevices: { getUserMedia: async () => stream() } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => url.endsWith('/capabilities') ? caps : { state: 'completed', text: '恢复的最终文字', rewrite: { status: 'completed' } } };
    }, ...overrides,
  }, ...options, onState: state => states.push(state), onTranscript: text => texts.push(text) });
  async function begin() {
    const starting = controller.start();
    await tick();
    const socket = sockets.at(-1);
    assert.ok(socket);
    socket.open(); socket.receive({ type: 'ready', session_id: id });
    await starting;
    return socket;
  }
  return { controller, sockets, states, texts, tracks, contexts, processors, requests, stream, begin };
}

test('capture starts on demand, checks readiness and negotiates Voice v1 PCM', async () => {
  const f = fixture(); assert.equal(f.contexts.length, 0);
  const socket = await f.begin(); await f.controller.start();
  assert.equal(f.sockets.length, 1);
  assert.equal(socket.url, 'ws://localhost:5173/api/v1/voice/ws');
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'start', sample_rate: 16000, channels: 1, encoding: 'pcm_s16le' });
  assert.equal(f.contexts[0].options.sampleRate, 16000);
  assert.equal(f.states.at(-1).status, 'listening');
  f.controller.dispose();
});

test('cumulative previews replace guesses and final rewriting replaces the preview', async () => {
  const f = fixture(), socket = await f.begin();
  socket.receive({ type: 'transcript', text: '报销需' });
  socket.receive({ type: 'transcript', text: '报销需要审批。' });
  await f.controller.stop();
  socket.receive({ type: 'state', ui_state: 'rewriting', message: '正在订正文字' });
  assert.equal(f.states.at(-1).status, 'stopping');
  assert.equal(f.states.at(-1).message, '正在订正文字');
  socket.receive({ type: 'result', text: '报销需要审批，请查询制度。', rewrite: { status: 'completed' } });
  assert.deepEqual(f.texts, ['报销需', '报销需要审批。', '报销需要审批，请查询制度。']);
  assert.equal(f.states.at(-1).status, 'idle');
  assert.ok(socket.closed);
});

test('stop flushes the last PCM bytes and releases the microphone before sending stop', async () => {
  const f = fixture(), socket = await f.begin();
  const send = socket.send.bind(socket);
  socket.send = data => {
    if (typeof data === 'string' && JSON.parse(data).type === 'stop') assert.ok(f.tracks[0].stopped);
    send(data);
  };
  await f.controller.stop(); await f.controller.stop();
  assert.ok(socket.sent[1] instanceof ArrayBuffer);
  assert.equal(JSON.parse(socket.sent[2]).type, 'stop');
  assert.equal(socket.closed, undefined);
  assert.equal(f.contexts[0].state, 'closed');
  f.controller.dispose();
});

test('editing or changing chats cancels processing and ignores late events', async () => {
  const f = fixture(), socket = await f.begin();
  const late = socket.onmessage;
  await f.controller.stop(); f.controller.cancel();
  late({ data: JSON.stringify({ type: 'result', text: '迟到结果' }) });
  assert.equal(f.texts.length, 0);
  assert.ok(f.requests.some(r => r.url.endsWith('/cancel') && r.options.method === 'POST'));
  assert.equal(f.states.at(-1).status, 'idle');
  await f.begin();
  late({ data: JSON.stringify({ type: 'transcript', text: '上一会话' }) });
  assert.equal(f.texts.length, 0);
  f.controller.dispose();
});

test('cancelling a recording closes capture without querying a discarded session', async () => {
  const f = fixture(), socket = await f.begin();
  f.controller.cancel();
  assert.ok(socket.closed); assert.ok(f.tracks[0].stopped);
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 0);
  assert.equal(f.states.at(-1).status, 'idle');
});

test('permission denial and service readiness fail cleanly before any socket is opened', async () => {
  for (const overrides of [
    { navigator: { mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } } } },
    { fetch: async () => ({ ok: true, json: async () => ({ ...caps, ready: false }) }) },
    { fetch: async () => { throw new TypeError('connection refused'); } },
    { isSecureContext: false }, { AudioWorkletNode: null },
  ]) {
    const f = fixture(overrides); await f.controller.start();
    assert.equal(f.sockets.length, 0); assert.equal(f.states.at(-1).status, 'idle'); assert.ok(f.states.at(-1).error);
    assert.ok(f.contexts.every(c => c.state === 'closed'));
  }
});

test('cancelling a permission prompt releases its eventual stream without affecting a new recording', async () => {
  let resolveStream;
  const f = fixture({ navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveStream = resolve; }) } } });
  const starting = f.controller.start(); await tick(); f.controller.cancel();
  const pending = resolveStream;
  const next = f.controller.start(); await tick();
  resolveStream(f.stream()); await tick();
  const socket = f.sockets[0]; socket.open(); socket.receive({ type: 'ready', session_id: id }); await next;
  pending(f.stream()); await starting;
  assert.equal(f.tracks[0].stopped, undefined); assert.equal(f.tracks[1].stopped, true);
  assert.equal(f.states.at(-1).status, 'listening'); f.controller.dispose();
});

test('stop during connection aborts startup and disposal never updates unmounted UI', async () => {
  const f = fixture(), starting = f.controller.start(); await tick();
  await f.controller.stop(); await starting;
  assert.equal(f.states.at(-1).status, 'idle'); assert.ok(f.tracks[0].stopped);
  await f.begin(); const count = f.states.length; f.controller.dispose(); await f.controller.start();
  assert.equal(f.states.length, count);
});

test('after stop, a lost socket recovers the final text over the session endpoint', async () => {
  const f = fixture(), socket = await f.begin(); await f.controller.stop();
  socket.onclose(); await tick();
  assert.equal(f.texts.at(-1), '恢复的最终文字'); assert.equal(f.states.at(-1).status, 'idle');
});

test('a lost recording socket keeps received text and allows retry; rewrite fallback stays visible', async () => {
  const f = fixture(), socket = await f.begin(); socket.receive({ type: 'transcript', text: '已有文字' });
  socket.onclose(); assert.ok(f.states.at(-1).error); assert.equal(f.texts.at(-1), '已有文字');
  const next = await f.begin();
  next.receive({ type: 'result', text: '保留转写', rewrite: { status: 'fallback' }, warnings: ['订正服务暂不可用'] });
  assert.equal(f.texts.at(-1), '保留转写'); assert.ok(f.states.at(-1).warning.includes('订正服务暂不可用'));
  assert.equal(f.states.at(-1).error, '');
});

test('deployed subpath uses secure WebSocket and the same API prefix', async () => {
  const f = fixture({ location: { href: 'https://example.com/harness-wiki/chat' } }, { apiBase: '/harness-wiki/api/v1/voice/' });
  const socket = await f.begin();
  assert.equal(socket.url, 'wss://example.com/harness-wiki/api/v1/voice/ws');
  assert.equal(f.requests[0].url, 'https://example.com/harness-wiki/api/v1/voice/capabilities');
  f.controller.dispose();
});

test('silence keeps the existing draft intact and shows the server warning', async () => {
  const f = fixture(), socket = await f.begin();
  socket.receive({ type: 'transcript', text: '' });
  socket.receive({ type: 'result', text: '', warnings: ['未检测到可识别的语音。'], rewrite: { status: 'completed' } });
  assert.equal(f.texts.length, 0);
  assert.equal(f.states.at(-1).status, 'idle');
  assert.equal(f.states.at(-1).warning, '未检测到可识别的语音。');
});

function capture(rate) {
  let Processor;
  class Base { constructor() { this.messages = []; this.port = { postMessage: data => this.messages.push(data) }; } }
  vm.runInNewContext(fs.readFileSync(new URL('../src/lib/pcm-capture-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: Base, sampleRate: rate, registerProcessor: (_name, cls) => { Processor = cls; },
  });
  return new Processor();
}

test('worklet resamples 16/44.1/48 kHz, chunks at 600 ms, flushes the tail and emits little-endian PCM', () => {
  for (const rate of [16000, 44100, 48000]) {
    const p = capture(rate), input = new Float32Array(rate * 0.63).fill(0.25);
    for (let start = 0; start < input.length; start += 128) p.process([[input.subarray(start, start + 128)]]);
    p.port.onmessage({ data: { type: 'flush' } });
    const audio = p.messages.filter(m => m.type === 'audio');
    assert.equal(audio[0].pcm.byteLength, 19200);
    assert.equal(audio.reduce((sum, m) => sum + m.pcm.byteLength, 0), 10080 * 2);
    assert.equal(new DataView(audio[0].pcm).getInt16(0, true), 8192);
    assert.equal(p.messages.at(-1).type, 'flushed'); assert.equal(p.process([]), false);
  }
});

test('worklet downmixes stereo and clips PCM values', () => {
  const p = capture(16000);
  p.process([[new Float32Array([2, -2, 1]), new Float32Array([2, -2, -1])]]);
  p.port.onmessage({ data: { type: 'flush' } });
  const view = new DataView(p.messages[0].pcm);
  assert.deepEqual([0, 2, 4].map(i => view.getInt16(i, true)), [32767, -32768, 0]);
});
