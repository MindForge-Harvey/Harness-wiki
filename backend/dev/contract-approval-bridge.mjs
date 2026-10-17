import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { apply } from '../dsh/plugin-approval-bridge/lib/index.js';

function bridge(t, timeout = 1000) {
  const previous = process.env.KB_APPROVAL_TIMEOUT_MS;
  process.env.KB_APPROVAL_TIMEOUT_MS = String(timeout);
  let requestApproval, route;
  const cleanups = [];
  const ctx = {
    logger: { info() {} },
    on(event, handler) { assert.equal(event, 'approval/request'); requestApproval = handler; },
    effect(setup) { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); },
    webServer: { register({ handler }) { route = handler; return () => {}; } },
  };
  apply(ctx);
  const dispose = () => { while (cleanups.length) cleanups.pop()(); };
  t.after(() => {
    dispose();
    if (previous === undefined) delete process.env.KB_APPROVAL_TIMEOUT_MS;
    else process.env.KB_APPROVAL_TIMEOUT_MS = previous;
  });
  const request = (method, url, body) => new Promise(resolve => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url });
    let status;
    route(req, { writeHead(code) { status = code; }, end(payload) { resolve({ status, ...JSON.parse(payload) }); } });
  });
  return { requestApproval: (...args) => requestApproval(...args), request, dispose };
}

test('explicit decisions settle once, remove pending requests and detach abort listeners', async t => {
  const app = bridge(t);
  for (const decision of ['allowed-once', 'rejected']) {
    const controller = new AbortController();
    let fallback = 0;
    const result = app.requestApproval({ toolName: 'kb_update', callId: 'call-test', signal: controller.signal }, () => { fallback++; return 'unavailable'; });
    const pending = (await app.request('GET', '/approvals/pending')).pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].callId, 'call-test');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    assert.equal((await app.request('POST', `/approvals/${pending[0].id}/decision`, { decision })).status, 200);
    assert.equal(await result, decision);
    assert.equal(fallback, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal((await app.request('GET', '/approvals/pending')).pending.length, 0);
    assert.equal((await app.request('POST', `/approvals/${pending[0].id}/decision`, { decision })).status, 404);
    controller.abort();
  }
});

test('timeout delegates to the default fail-closed chain without crashing the runtime', async t => {
  const app = bridge(t, 20);
  const controller = new AbortController();
  let fallback = 0;
  const result = app.requestApproval({ toolName: 'bash', signal: controller.signal }, () => { fallback++; return 'unavailable'; });
  const [{ id }] = (await app.request('GET', '/approvals/pending')).pending;
  assert.equal(await result, 'unavailable');
  assert.equal(fallback, 1);
  assert.equal((await app.request('GET', '/approvals/pending')).pending.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal((await app.request('POST', `/approvals/${id}/decision`, { decision: 'allowed-once' })).status, 404);
  controller.abort();
});

test('abort cancels a waiting approval and already-aborted requests never become pending', async t => {
  const app = bridge(t);
  const controller = new AbortController();
  let fallback = 0;
  const next = () => { fallback++; return 'unavailable'; };
  const result = app.requestApproval({ toolName: 'kb_update', signal: controller.signal }, next);
  controller.abort();
  assert.equal(await result, 'cancelled');
  assert.equal((await app.request('GET', '/approvals/pending')).pending.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(await app.requestApproval({ toolName: 'kb_update', signal: controller.signal }, next), 'cancelled');
  assert.equal(fallback, 0);
});

test('plugin disposal releases all pending approvals and abort listeners', async t => {
  const app = bridge(t);
  const controllers = [new AbortController(), new AbortController()];
  const results = controllers.map(controller => app.requestApproval({ toolName: 'kb_update', signal: controller.signal }, () => 'unavailable'));
  app.dispose();
  assert.deepEqual(await Promise.all(results), ['unavailable', 'unavailable']);
  assert.equal((await app.request('GET', '/approvals/pending')).pending.length, 0);
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
