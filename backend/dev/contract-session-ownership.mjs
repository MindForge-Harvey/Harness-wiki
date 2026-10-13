import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSessionStore, ownedApprovals } from '../session-ownership.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ownership-'));

test('ownership survives restart; foreign users cannot read, delete or claim a session', async () => {
  const dir = temp();
  const options = { sqlitePath: path.join(dir, 'sessions.sqlite'), production: false, databaseUrl: '' };
  let store = await createSessionStore(options);
  try {
    const a = await store.create('alice', 'alice private');
    const b = await store.create('bob', 'bob private');
    assert.deepEqual((await store.list('alice')).map(s => s.sessionId), [a]);
    await assert.rejects(store.require('bob', a), { status: 404 });
    await assert.rejects(store.remove('bob', a), { status: 404 });
    await assert.rejects(store.create('bob', 'claim', a));
    await assert.rejects(store.require('alice', '../escape'), { status: 400 });
    await store.close();
    store = await createSessionStore(options);
    assert.equal((await store.require('alice', a)).title, 'alice private');
    const calls = new Map([['a-call', { uid: 'alice', sessionId: a }], ['b-call', { uid: 'bob', sessionId: b }]]);
    const pending = [{ id: 'a-approval', callId: 'a-call' }, { id: 'b-approval', callId: 'b-call' }, { id: 'unknown', callId: 'unknown' }];
    assert.deepEqual((await ownedApprovals(store, 'alice', pending, calls)).map(p => p.id), ['a-approval']);
    await store.clear('alice');
    await assert.rejects(store.require('alice', a), { status: 404 });
    assert.equal((await store.list('bob')).length, 1);
    assert.deepEqual(await ownedApprovals(store, 'alice', pending, calls), []);
    await assert.rejects(store.create('bob', 'revive deleted', a));
  } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('production requires a database and does not silently share local history', async () => {
  await assert.rejects(createSessionStore({ production: true, databaseUrl: '' }), /HARNESS_DATABASE_URL/);
});

test('actual HTTP routes authorize before history, inference, feedback, sharing and deletion', async () => {
  const dir = temp();
  const sqlitePath = path.join(dir, 'storages', 'chat-sessions.sqlite');
  const store = await createSessionStore({ sqlitePath, production: false, databaseUrl: '' });
  const a = await store.create('alice', 'alice private');
  const b = await store.create('bob', 'bob private');
  await store.close();
  const logDir = path.join(dir, 'sessions', 'fixture-workspace', a);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'session.v3.jsonl'), JSON.stringify({ type: 'user/message', seq: 1, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'alice secret' }] } }) + '\n');
  const portal = http.createServer((req, res) => {
    const uid = req.headers.cookie;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(['alice', 'bob'].includes(uid) ? { authenticated: true, user: { uid, username: uid } } : { authenticated: false }));
  });
  portal.listen(0, '127.0.0.1'); await once(portal, 'listening');
  const portHolder = http.createServer(); portHolder.listen(0, '127.0.0.1'); await once(portHolder, 'listening');
  const port = portHolder.address().port; await new Promise(resolve => portHolder.close(resolve));
  const child = spawn(process.execPath, [new URL('../index.js', import.meta.url).pathname], {
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), PORTAL_AUTH_URL: `http://127.0.0.1:${portal.address().port}`,
      DSH_HOME_DIR: dir, DSH_PROFILE: 'nonexistent-test-profile', HARNESS_DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', () => {});
  const call = (route, user, method = 'GET', data, extraHeaders = {}) => fetch(`http://127.0.0.1:${port}/api/${route}`, {
    method, headers: { cookie: user || '', 'Content-Type': 'application/json', 'X-Harness-Request': '1', ...extraHeaders },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  try {
    for (let i = 0; i < 100 && !output.includes('适配层就绪'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(output.includes('适配层就绪'));
    assert.equal((await call('chat/sessions')).status, 401);
    assert.equal((await call('chat/sessions', 'bob', 'GET', null, { 'X-Portal-User': 'alice' })).status, 401);
    assert.deepEqual((await (await call('chat/sessions', 'bob')).json()).sessions.map(s => s.sessionId), [b]);
    assert.equal((await (await call(`chat/history?sessionId=${a}`, 'alice')).json()).events[0].text, 'alice secret');
    for (const [route, method, body] of [
      [`chat/history?sessionId=${a}`, 'GET'], [`chat/feedback?sessionId=${a}`, 'GET'],
      ['chat/stream', 'POST', { sessionId: a, message: 'steal' }], ['chat/feedback', 'POST', { sessionId: a, messageSeq: 1, rating: 'up' }],
      ['chat/shares', 'POST', { sessionId: a, messageSeq: 1 }], [`chat/sessions/${a}`, 'DELETE'],
      ['chat/stream', 'POST', { sessionId: 'unassigned-legacy', message: 'claim' }],
    ]) assert.equal((await call(route, 'bob', method, body)).status, 404, route);
    assert.equal((await call('chat/sessions', 'alice', 'DELETE')).status, 200);
    assert.equal((await call(`chat/history?sessionId=${a}`, 'alice')).status, 404);
    assert.equal((await (await call('chat/sessions', 'bob')).json()).sessions.length, 1);
  } finally {
    child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    portal.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
