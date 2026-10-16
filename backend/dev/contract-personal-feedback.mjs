import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createFeedbackLedger } from '../dsh/dsh-knowledge/lib/feedback.js';
import { createSessionStore } from '../session-ownership.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'personal-feedback-'));
const vote = (actor, session, message, rating = 'positive') => ({ actor, session_id: session, message_id: String(message), query: `${actor} 的问题`, answer: `${actor} 的回答`, rating });
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };

test('personal snapshots survive restart, update in place, cancel, and exclude other users before any limit', () => {
  const dir = temp();
  try {
    let ledger = createFeedbackLedger({ dir });
    const saved = ledger.vote(vote('alice', 'session-a', 2));
    ledger.vote(vote('alice', 'session-a', 4, 'negative'));
    for (let i = 0; i < 205; i++) ledger.vote(vote('bob', 'session-b', i));
    ledger = createFeedbackLedger({ dir });
    assert.equal(ledger.answerFeedback({ actor: 'alice' }).length, 2);
    assert.equal(ledger.answerFeedback({ actor: 'bob' }).length, 205);
    assert.deepEqual(ledger.answerFeedback({ actor: 'unknown' }), []);
    assert.throws(() => ledger.answerFeedback({}), { status: 400 });
    ledger.updateAnswerFeedback(saved.feedback_id, { actor: 'alice', session_id: 'session-a', note: '  保留这条依据\n核对第二段  ' });
    assert.throws(() => ledger.updateAnswerFeedback(saved.feedback_id, { actor: 'bob', session_id: 'session-a', note: 'forged' }), { status: 404 });
    assert.throws(() => ledger.removeAnswerFeedback(saved.feedback_id, { actor: 'alice', session_id: 'session-b' }), { status: 404 });
    ledger = createFeedbackLedger({ dir });
    assert.equal(ledger.get(saved.feedback_id).note, '保留这条依据\n核对第二段');
    ledger.vote(vote('alice', 'session-a', 2, 'negative'));
    const changed = ledger.answerFeedback({ actor: 'alice' }).find(row => row.message_id === '2');
    assert.equal(changed.feedback_id, saved.feedback_id);
    assert.equal(changed.rating, 'negative');
    assert.equal(changed.query, 'alice 的问题');
    assert.equal(changed.answer, 'alice 的回答');
    assert.equal(changed.note, '保留这条依据\n核对第二段');
    assert.ok(changed.updated_at);
    ledger.vote(vote('alice', 'session-a', 2, null));
    ledger = createFeedbackLedger({ dir });
    assert.deepEqual(ledger.votes({ actor: 'alice', session_id: 'session-a' }), [{ message_id: '4', rating: 'negative' }]);
    assert.equal(ledger.answerFeedback({ actor: 'alice' }).length, 1);
    assert.equal(ledger.answerFeedback({ actor: 'bob' }).length, 205);
    assert.throws(() => ledger.updateAnswerFeedback(saved.feedback_id, { actor: 'alice', session_id: 'session-a', note: 'revive' }), { status: 404 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('personal feedback HTTP listing uses authenticated identity and active ownership, including older sessions', async () => {
  const dir = temp();
  fs.mkdirSync(path.join(dir, 'feedback'));
  const ledger = createFeedbackLedger({ dir: path.join(dir, 'feedback') });
  const store = await createSessionStore({ sqlitePath: path.join(dir, 'storages/chat-sessions.sqlite'), production: false, databaseUrl: '' });
  const old = await store.create('alice', '最早的对话', 'session-old', 1);
  const deleted = await store.create('alice', '已删除对话', 'session-deleted', 2);
  const b = await store.create('bob', 'bob private', 'session-bob', 3);
  await store.remove('alice', deleted);
  for (let i = 0; i < 201; i++) await store.create('alice', '较新的对话', `session-new-${i}`, i + 10);
  assert.equal((await store.list('alice')).some(item => item.sessionId === old), false);
  ledger.vote(vote('alice', old, 2));
  ledger.vote(vote('alice', old, 4, 'negative'));
  ledger.vote(vote('alice', deleted, 2));
  ledger.vote(vote('alice', b, 2)); // Even a matching actor cannot bypass ownership.
  ledger.vote(vote('alice', 'session-unclaimed', 2));
  ledger.vote(vote('bob', b, 4));
  await store.close();

  const portal = http.createServer((req, res) => {
    const uid = req.headers.cookie;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(['alice', 'bob'].includes(uid) ? { authenticated: true, user: { uid, username: uid } } : { authenticated: false }));
  });
  const plugin = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    try {
      if (url.pathname === '/kb/feedback/answers') return res.end(JSON.stringify({ ok: true, records: ledger.answerFeedback({ actor: url.searchParams.get('actor') }) }));
      const match = url.pathname.match(/^\/kb\/feedback\/answers\/([\w-]+)$/);
      if (match) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString());
        const row = req.method === 'PATCH' ? ledger.updateAnswerFeedback(match[1], input) : ledger.removeAnswerFeedback(match[1], input);
        return res.end(JSON.stringify({ ok: true, note: row.note, updatedAt: row.updated_at }));
      }
      res.statusCode = 404; res.end('{}');
    } catch (error) { res.statusCode = error.status || 500; res.end(JSON.stringify({ ok: false, error: error.message })); }
  });
  const portalPort = await listen(portal), pluginPort = await listen(plugin);
  const holder = http.createServer(), port = await listen(holder);
  await new Promise(resolve => holder.close(resolve));
  const child = spawn(process.execPath, [new URL('../index.js', import.meta.url).pathname], {
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), PORTAL_AUTH_URL: `http://127.0.0.1:${portalPort}`,
      DSH_HOME_DIR: dir, DSH_PROFILE: 'nonexistent-test-profile', DSH_CHILD_HTTP_PORT: String(pluginPort), HARNESS_DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', () => {});
  const call = (user, suffix = '', headers = {}) => fetch(`http://127.0.0.1:${port}/api/chat/feedback/records${suffix}`, { headers: { cookie: user || '', ...headers } });
  const mutate = (user, id, method, body) => fetch(`http://127.0.0.1:${port}/api/chat/feedback/records/${id}`, {
    method, headers: { cookie: user || '', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    for (let i = 0; i < 120 && !output.includes('适配层就绪'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(output.includes('适配层就绪'), output);
    assert.equal((await call()).status, 401);
    assert.equal((await call('bob', '', { 'X-Portal-User': 'alice' })).status, 401);
    const response = await call('alice', '?actor=bob');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const records = (await response.json()).records;
    assert.equal(records.length, 2);
    assert.ok(records.every(row => row.sessionId === old && row.sessionTitle === '最早的对话'));
    assert.deepEqual(new Set(records.map(row => row.rating)), new Set(['up', 'down']));
    assert.ok(records.every(row => row.question === 'alice 的问题' && row.answer === 'alice 的回答'));
    assert.deepEqual((await (await call('bob')).json()).records.map(row => row.sessionId), [b]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/kb/feedback/answers?actor=alice`, { headers: { cookie: 'bob' } })).status, 404);
    const selected = records.find(row => row.messageSeq === 2);
    const bobRecord = ledger.answerFeedback({ actor: 'bob' })[0];
    assert.equal((await mutate('', selected.id, 'PATCH', { sessionId: old, note: 'guest' })).status, 401);
    for (const method of ['PATCH', 'DELETE']) {
      assert.equal((await mutate('bob', selected.id, method, { sessionId: old, note: 'steal' })).status, 404);
      assert.equal((await mutate('bob', selected.id, method, { sessionId: b, actor: 'alice', note: 'steal' })).status, 404);
      assert.equal((await mutate('alice', bobRecord.feedback_id, method, { sessionId: old, actor: 'bob', note: 'steal' })).status, 404);
    }
    for (const note of [null, 12, {}, 'x'.repeat(4001)]) {
      assert.equal((await mutate('alice', selected.id, 'PATCH', { sessionId: old, note })).status, 400);
    }
    const longNote = '备注'.repeat(2000);
    assert.equal((await mutate('alice', selected.id, 'PATCH', { sessionId: old, actor: 'bob', note: longNote })).status, 200);
    assert.equal((await (await call('alice')).json()).records.find(row => row.id === selected.id).note, longNote);
    assert.equal(createFeedbackLedger({ dir: path.join(dir, 'feedback') }).get(selected.id).note, longNote);
    assert.equal((await mutate('alice', selected.id, 'PATCH', { sessionId: old, note: '' })).status, 200);
    assert.equal((await (await call('alice')).json()).records.find(row => row.id === selected.id).note, '');
    assert.equal((await mutate('alice', selected.id, 'DELETE', { sessionId: old })).status, 200);
    assert.deepEqual((await (await call('alice')).json()).records.map(row => row.messageSeq), [4]);
    assert.deepEqual(ledger.votes({ actor: 'alice', session_id: old }), [{ message_id: '4', rating: 'negative' }]);
    assert.equal((await mutate('alice', selected.id, 'PATCH', { sessionId: old, note: 'revive' })).status, 404);
    assert.equal((await mutate('alice', selected.id, 'DELETE', { sessionId: old })).status, 404);
    assert.equal((await (await call('bob')).json()).records.length, 1);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => { const timer = setTimeout(resolve, 3000); timer.unref(); })]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.all([new Promise(resolve => portal.close(resolve)), new Promise(resolve => plugin.close(resolve))]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
