import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createSkillsStore, parseSkillMarkdown } from '../skills-store.mjs';
import { mountPersonalSkills, personalSkillProvider } from '../dsh/dsh-knowledge/lib/personal-skills.js';
import { bindScopeParent } from '@deepseek-ai/dsh-scope';
import { loadStarterSkills, STARTER_SKILLS_BUNDLE } from '../starter-skills.mjs';

const skill = { title: '测试技能', name: 'contract-skill', description: '在执行契约测试时使用。', content: '只输出测试成功。', enabled: true };
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-skills-'));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('starter skills install once per account and preserve edits, disabled records, deletion and restart', () => {
  const dir = temp();
  try {
    let store = createSkillsStore(dir);
    const defaults = loadStarterSkills();
    assert.deepEqual(defaults.map(item => item.name), ['grill-me', 'knowledge-qa', 'meeting-notes', 'document-compare']);
    assert.ok(defaults.every(item => item.enabled && item.title !== item.name));
    const custom = store.save('alice', { ...defaults[0], content: '用户自己的追问方法', enabled: false });
    const seeded = store.seed('alice', defaults, STARTER_SKILLS_BUNDLE);
    assert.equal(seeded.skills.length, 4);
    assert.deepEqual(seeded.skills.find(item => item.name === 'grill-me'), custom);
    const removed = seeded.skills.find(item => item.name === 'meeting-notes');
    store.remove('alice', removed.id, removed.version);
    const revision = store.list('alice').revision;
    store = createSkillsStore(dir);
    const again = store.seed('alice', defaults, STARTER_SKILLS_BUNDLE);
    assert.equal(again.revision, revision);
    assert.equal(again.skills.some(item => item.name === 'meeting-notes'), false);
    assert.equal(again.skills.find(item => item.name === 'grill-me').enabled, false);
    const bob = store.seed('bob', defaults, STARTER_SKILLS_BUNDLE);
    assert.equal(bob.skills.length, 4);
    assert.ok(bob.skills.every(item => item.enabled && !again.skills.some(other => other.id === item.id)));
    assert.equal(store.list('alice').skills.length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('skills persist per account; stale edits, duplicate names and cross-account operations are rejected', () => {
  const dir = temp();
  try {
    let store = createSkillsStore(dir);
    const a = store.save('alice', skill);
    const b = store.save('bob', { ...skill, content: 'bob private' });
    store = createSkillsStore(dir);
    assert.deepEqual(store.list('alice').skills, [a]);
    assert.deepEqual(store.list('bob').skills, [b]);
    assert.throws(() => store.save('bob', a, a.id), { status: 404 });
    assert.throws(() => store.remove('bob', a.id, a.version), { status: 404 });
    assert.throws(() => store.save('alice', skill), { status: 400 });
    const updated = store.save('alice', { ...a, content: '新指令' }, a.id);
    assert.equal(updated.version, 2);
    assert.throws(() => store.save('alice', a, a.id), { status: 409 });
    assert.throws(() => store.remove('alice', a.id, a.version), { status: 409 });
    store.bindSession('alice', 'session-a');
    assert.equal(store.owner('session-a'), 'alice');
    assert.throws(() => store.bindSession('bob', 'session-a'), /ownership/);
    store.remove('alice', a.id, updated.version);
    assert.deepEqual(store.list('alice').skills, []);
    assert.equal(store.list('bob').skills.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import validates YAML, invocation controls, size and path-like names without executing content', () => {
  const parsed = parseSkillMarkdown('---\nname: test-notes\ndescription: |\n  整理会议纪要。\ntitle: 会议纪要\n---\n# 规则\n\n不补写原文没有的信息。');
  assert.equal(parsed.title, '会议纪要');
  assert.equal(parsed.name, 'test-notes');
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.content, '# 规则\n\n不补写原文没有的信息。');
  for (const raw of ['# no metadata', '---\nname: ../bad\ndescription: demo\n---\ncontent', '---\nname: x\nname: y\ndescription: demo\n---\ncontent', '---\nname: x\ndescription: !!js/function x\n---\ncontent', '---\nname: x\ndescription: test\ndisable-model-invocation: true\n---\ncontent', 'x'.repeat(131073)]) assert.throws(() => parseSkillMarkdown(raw), { status: 400 });
  const dir = temp();
  try {
    const store = createSkillsStore(dir);
    for (const input of [{ ...skill, content: '' }, { ...skill, content: 'x'.repeat(32001) }, { ...skill, enabled: 'yes' }]) assert.throws(() => store.save('alice', input), { status: 400 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native providers read current content and do not load disabled/deleted skills or another account', async () => {
  const dir = temp();
  try {
    const store = createSkillsStore(dir);
    let a = store.save('alice', skill);
    store.save('bob', { ...skill, name: 'bob-only' });
    const provider = personalSkillProvider(store, 'alice');
    const candidates = await provider.list();
    assert.deepEqual(candidates.map(item => item.name), ['contract-skill']);
    a = store.save('alice', { ...a, content: '第二版指令' }, a.id);
    assert.equal((await provider.get(candidates[0])).content, '第二版指令');
    a = store.save('alice', { ...a, enabled: false }, a.id);
    assert.deepEqual(await provider.list(), []);
    assert.equal(await provider.get(candidates[0]), undefined);
    store.remove('alice', a.id, a.version);
    assert.equal(await provider.get(candidates[0]), undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('live agent catalog invalidates after edits and retires previously loaded instructions', async () => {
  const dir = temp();
  const previous = process.env.HARNESS_SKILLS_DIR;
  process.env.HARNESS_SKILLS_DIR = dir;
  try {
    const store = createSkillsStore(dir);
    store.bindSession('alice', 'session-a');
    const handlers = new Map();
    let invalidations = 0, provider;
    const ctx = { on: (name, handler) => handlers.set(name, handler) };
    const history = [];
    const agent = { session: { id: 'session-a', snapshotEvents: () => history }, ctx: { inject: async (_deps, apply) => apply({ skills: { registerProvider: create => { provider = create({ invalidate() { invalidations++; } }); } } }) } };
    mountPersonalSkills(ctx);
    await handlers.get('agent/created')({ agent });
    assert.ok(provider);
    const a = store.save('alice', skill);
    const next = async () => ({ kind: 'accept', messages: [] });
    const run = () => handlers.get('agent/pre-step')({ agent }, next);
    assert.match((await run()).messages[0].content[0].text, /contract-skill/);
    assert.equal(invalidations, 1);
    assert.deepEqual((await run()).messages, []);
    history.push({ type: 'tool/call', data: { name: 'skill', arguments: JSON.stringify({ name: a.name }) } });
    const edited = store.save('alice', { ...a, content: '请使用最新完整指令。' }, a.id);
    const changed = await run();
    assert.equal(changed.messages[1].source.kind, 'personal-skill-refresh');
    assert.match(changed.messages[1].content[0].text, /请使用最新完整指令/);
    store.remove('alice', a.id, edited.version);
    assert.match((await run()).messages[0].content[0].text, /个人技能：无/);
    assert.equal(invalidations, 3);
    const restored = store.save('alice', skill);
    let childProvider, unrelatedProvider;
    const child = { session: { id: 'child-session' }, ctx: { inject: async (_deps, apply) => apply({ skills: { registerProvider: create => { childProvider = create({ invalidate() {} }); } } }) } };
    bindScopeParent(child, agent);
    await handlers.get('agent/created')({ agent: child });
    assert.deepEqual((await childProvider.list()).map(item => item.name), [restored.name]);
    const unrelated = { session: { id: 'unrelated-session' }, ctx: { inject: async () => { unrelatedProvider = true; } } };
    await handlers.get('agent/created')({ agent: unrelated });
    assert.equal(unrelatedProvider, undefined);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_SKILLS_DIR; else process.env.HARNESS_SKILLS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skills HTTP endpoints require a validated identity and keep mutations account-scoped', async () => {
  const dir = temp();
  const portal = http.createServer((req, res) => {
    const uid = req.headers.cookie;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(['alice', 'bob'].includes(uid) ? { authenticated: true, user: { uid, username: uid } } : { authenticated: false }));
  });
  const portalPort = await listen(portal);
  const holder = http.createServer(), port = await listen(holder);
  await new Promise(resolve => holder.close(resolve));
  const child = spawn(process.execPath, [new URL('../index.js', import.meta.url).pathname], {
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), PORTAL_AUTH_URL: `http://127.0.0.1:${portalPort}`,
      DSH_HOME_DIR: dir, DSH_PROFILE: 'nonexistent-test-profile', HARNESS_DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', () => {});
  const call = (uid, method = 'GET', suffix = '', body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/chat/skills${suffix}`, {
    method, headers: { cookie: uid || '', 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    for (let i = 0; i < 120 && !output.includes('适配层就绪'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(output.includes('适配层就绪'), output);
    assert.equal((await call()).status, 401);
    assert.equal((await call('bob', 'GET', '', undefined, { 'X-Portal-User': 'alice' })).status, 401);
    const initialAlice = (await (await call('alice')).json()).skills;
    const initialBob = (await (await call('bob')).json()).skills;
    assert.equal(initialAlice.length, 4);
    assert.ok(initialAlice.every(item => item.enabled));
    assert.equal(initialBob.length, 4);
    assert.ok(initialAlice.every(item => !initialBob.some(other => other.id === item.id)));
    const response = await call('alice', 'POST', '', { ...skill, uid: 'bob' });
    assert.equal(response.status, 201);
    const saved = (await response.json()).skill;
    assert.deepEqual((await (await call('bob')).json()).skills, initialBob);
    assert.equal((await call('bob', 'PUT', '/' + saved.id, saved)).status, 404);
    assert.equal((await call('bob', 'DELETE', '/' + saved.id, saved)).status, 404);
    assert.equal((await call('alice', 'PUT', '/' + saved.id, { ...saved, enabled: false })).status, 200);
    assert.equal((await call('alice', 'DELETE', '/' + saved.id, saved)).status, 409);
    const current = (await (await call('alice')).json()).skills.find(item => item.id === saved.id);
    assert.equal(current.enabled, false);
    assert.equal((await call('alice', 'DELETE', '/' + saved.id, current)).status, 200);
    assert.deepEqual((await (await call('alice')).json()).skills, initialAlice);
    assert.equal((await call('alice', 'POST', '/parse', { markdown: 'invalid' })).status, 400);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => portal.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
