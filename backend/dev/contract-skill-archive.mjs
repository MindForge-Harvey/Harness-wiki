import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import { parseSkillArchive, SKILL_ARCHIVE_LIMITS } from '../skill-archive.mjs';
import { parseSkillMarkdown, createSkillsStore } from '../skills-store.mjs';
import { personalSkillProvider } from '../dsh/dsh-knowledge/lib/personal-skills.js';

const markdown = (name = 'package-probe', extra = '') => `---\nname: ${name}\ndescription: 在用户要求校验技能包时使用。\n${extra}---\n读取 references/message.txt，然后运行 scripts/probe.py，将 assets/样本.bin 作为附件保留。`;
const archive = files => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, typeof value === 'string' ? strToU8(value) : value]))));
const parse = bytes => parseSkillArchive(bytes, parseSkillMarkdown);
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-skill-zip-'));
const fixture = () => archive({ 'package-probe/SKILL.md': '\uFEFF' + markdown('package-probe', 'license: MIT\nmetadata:\n  source: zip-test\n'), 'package-probe/scripts/probe.py': [strToU8('from pathlib import Path\nprint((Path(__file__).parents[1] / "references/message.txt").read_text())\n'), { os: 3, attrs: (0o100755 << 16) >>> 0 }], 'package-probe/references/message.txt': '技能脚本运行成功', 'package-probe/assets/样本.bin': new Uint8Array([0, 128, 255, 42]) });
const centralOffset = bytes => bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));

test('single and multi-skill ZIPs retain directories, binary attachments, executable flags and shared resources', async () => {
  const one = await parse(fixture());
  assert.deepEqual(one.skills.map(item => item.name), ['package-probe']);
  assert.equal(one.files.find(file => file.path.endsWith('probe.py')).executable, true);
  assert.deepEqual(one.files.find(file => file.path.endsWith('.bin')).bytes, Buffer.from([0, 128, 255, 42]));
  const many = await parse(archive({ 'repo-main/skills/a/SKILL.md': markdown('skill-a'), 'repo-main/skills/b/SKILL.md': markdown('skill-b', 'disable-model-invocation: true\n'), 'repo-main/shared/reference.md': '共享资料', '__MACOSX/._file': 'ignored', '.DS_Store': 'ignored' }));
  assert.deepEqual(many.skills.map(item => item.name), ['skill-a', 'skill-b']);
  assert.equal(many.skills[1].modelInvocable, false);
  assert.equal(many.files.length, 3);
  const nested = await parse(archive({ 'examples/demo/SKILL.md': markdown('example-only'), 'SKILL.md': markdown('root-skill') }));
  assert.deepEqual(nested.skills.map(item => item.name), ['root-skill']);
});

test('invalid, traversing, linked, encrypted, corrupt and over-budget archives do not reach storage', async () => {
  for (const files of [{ '../outside': 'bad', 'SKILL.md': markdown() }, { '/absolute': 'bad' }, { 'C:/drive': 'bad' }, { 'dir\\escape': 'bad' }, { 'SKILL.md': markdown(), 'skill.md': 'case collision' }, { 'SKILL.md': markdown(), foo: 'file', 'foo/bar': 'child' }, { 'readme.txt': 'no skill' }]) await assert.rejects(parse(archive(files)), { status: 400 });
  const linked = archive({ 'SKILL.md': markdown(), link: [strToU8('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] });
  await assert.rejects(parse(linked), { status: 400 });
  await assert.rejects(parse(Buffer.from('not a zip')), { status: 400 });
  const corrupt = archive({ 'SKILL.md': markdown() });
  corrupt.writeUInt32LE(123, centralOffset(corrupt) + 16);
  await assert.rejects(parse(corrupt), { status: 400 });
  const encrypted = archive({ 'SKILL.md': markdown() });
  const at = centralOffset(encrypted);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(at + 8) | 1, at + 8);
  await assert.rejects(parse(encrypted), { status: 400 });
  const oversized = archive({ 'SKILL.md': markdown() });
  oversized.writeUInt32LE(SKILL_ARCHIVE_LIMITS.file + 1, centralOffset(oversized) + 24);
  await assert.rejects(parse(oversized), { status: 413 });
  await assert.rejects(parse(Buffer.alloc(SKILL_ARCHIVE_LIMITS.compressed + 1)), { status: 413 });
});

test('a broken skill does not sink the archive: invalid entries carry path, reason and extracted metadata', async () => {
  const mixed = await parse(archive({
    'good/SKILL.md': markdown('good-skill'),
    'bad-yaml/SKILL.md': '---\nname: [unclosed\n---\n内容',
    'no-desc/SKILL.md': '---\nname: no-desc-skill\n---\n缺少描述',
    'bad-name/SKILL.md': '---\nname: 页面生成\ntitle: 命名不合规\ndescription: 调用名称含中文。\n---\n内容',
    'dup/SKILL.md': markdown('good-skill'),
    'raw/SKILL.md': new Uint8Array([0xff]),
  }));
  assert.deepEqual(mixed.skills.map(skill => skill.name), ['good-skill']);
  assert.equal(mixed.invalid.length, 5);
  assert.equal(mixed.invalid.find(item => item.path === 'no-desc/SKILL.md').error, '请填写何时使用');
  const named = mixed.invalid.find(item => item.path === 'bad-name/SKILL.md');
  assert.equal(named.error, '调用名称仅支持英文、数字、空格和连字符，例如 Answer Format');
  assert.equal(named.extracted.name, '页面生成');
  assert.equal(named.extracted.title, '命名不合规');
  const dup = mixed.invalid.find(item => item.path === 'dup/SKILL.md');
  assert.match(dup.error, /与 good\/SKILL\.md 重复/);
  assert.equal(dup.extracted.name, 'good-skill');
  assert.match(mixed.invalid.find(item => item.path === 'raw/SKILL.md').error, /UTF-8/);
  const dir = temp();
  try {
    const store = createSkillsStore(dir);
    const preview = store.stageImport('alice', mixed, 'mixed.zip');
    assert.equal(preview.skills.length, 1);
    assert.equal(preview.invalid.length, 5);
    const [installed] = store.installImport('alice', preview.id);
    assert.equal(installed.name, 'good-skill');
    assert.deepEqual(store.list('alice').skills.map(skill => skill.name), ['good-skill']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('uppercase and spaced invocation names normalize to the kebab-case the kernel requires', async () => {
  const parsed = await parse(archive({
    'ppt/SKILL.md': '---\nname: PPT-Page\ntitle: PPT 生成\ndescription: 生成 PPT 时使用。\n---\n内容',
  }));
  assert.deepEqual(parsed.skills.map(skill => skill.name), ['ppt-page']);
  assert.equal(parsed.invalid.length, 0);
  const dir = temp();
  try {
    const store = createSkillsStore(dir);
    const saved = store.save('alice', { title: '规范回答', name: 'Answer Format', description: '需要规范回答时使用。', content: '步骤', enabled: true });
    assert.equal(saved.name, 'answer-format');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installed packages expose working script paths; edits, account isolation, conflicts and deletion preserve resources', async () => {
  const dir = temp();
  try {
    let store = createSkillsStore(dir);
    const parsed = await parse(fixture());
    const preview = store.stageImport('alice', parsed, '技能包.zip');
    assert.equal(store.list('alice').skills.length, 0);
    assert.throws(() => store.installImport('bob', preview.id), { status: 404 });
    assert.throws(() => store.discardImport('bob', preview.id), { status: 404 });
    let [saved] = store.installImport('alice', preview.id);
    const provider = personalSkillProvider(store, 'alice');
    const candidate = (await provider.list())[0];
    const loaded = await provider.get(candidate);
    assert.equal(loaded.resourceBase.kind, 'directory');
    assert.match(execFileSync('python3', ['scripts/probe.py'], { cwd: loaded.resourceBase.path, encoding: 'utf8' }), /技能脚本运行成功/);
    const binary = store.file('alice', saved.id, 'assets/样本.bin');
    assert.deepEqual(fs.readFileSync(binary.path), Buffer.from([0, 128, 255, 42]));
    fs.renameSync(binary.path, binary.path + '.original');
    fs.symlinkSync(binary.path + '.original', binary.path);
    assert.throws(() => store.file('alice', saved.id, 'assets/样本.bin'), { status: 404 });
    fs.unlinkSync(binary.path); fs.renameSync(binary.path + '.original', binary.path);
    const assets = path.dirname(binary.path);
    fs.renameSync(assets, assets + '.original'); fs.symlinkSync(assets + '.original', assets);
    assert.throws(() => store.file('alice', saved.id, 'assets/样本.bin'), { status: 404 });
    fs.unlinkSync(assets); fs.renameSync(assets + '.original', assets);
    assert.throws(() => store.file('bob', saved.id, 'assets/样本.bin'), { status: 404 });
    assert.throws(() => store.file('alice', saved.id, '../../outside'), { status: 400 });
    store = createSkillsStore(dir);
    saved = store.save('alice', { ...saved, title: '编辑后的技能包', content: '更新后的指令，继续使用 scripts/probe.py。' }, saved.id);
    assert.match(fs.readFileSync(path.join(loaded.resourceBase.path, 'SKILL.md'), 'utf8'), /更新后的指令/);
    assert.match(fs.readFileSync(path.join(loaded.resourceBase.path, 'SKILL.md'), 'utf8'), /license: MIT\nmetadata:\n  source: zip-test\n/);
    assert.equal(store.files('alice', saved.id).length, 4);
    const next = store.stageImport('alice', parsed, 'replacement.zip');
    assert.equal(next.skills[0].existing.id, saved.id);
    assert.throws(() => store.installImport('alice', next.id), { status: 409 });
    const changed = store.save('alice', { ...saved, enabled: false }, saved.id);
    assert.throws(() => store.installImport('alice', next.id, { [saved.name]: { id: saved.id, version: saved.version } }), { status: 409 });
    const [replaced] = store.installImport('alice', next.id, { [saved.name]: { id: changed.id, version: changed.version } });
    assert.equal(replaced.id, saved.id);
    assert.equal(replaced.enabled, true);
    assert.equal(fs.existsSync(loaded.resourceBase.path), false);
    const root = store.resourceBase('alice', replaced);
    store.remove('alice', replaced.id, replaced.version);
    assert.equal(fs.existsSync(root), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a bundle installs atomically and keeps sibling references until its last skill is removed', async () => {
  const dir = temp();
  try {
    const store = createSkillsStore(dir);
    const data = await parse(archive({ 'skills/a/SKILL.md': markdown('skill-a', 'disable-model-invocation: true\n'), 'skills/b/SKILL.md': markdown('skill-b', 'user-invocable: false\n'), 'shared/manual.md': 'shared' }));
    const preview = store.stageImport('alice', data, 'collection.zip');
    const existing = store.save('alice', { title: '已有 B', name: 'skill-b', description: 'existing', content: 'existing', enabled: true });
    assert.throws(() => store.installImport('alice', preview.id), { status: 409 });
    assert.deepEqual(store.list('alice').skills, [existing]);
    const installed = store.installImport('alice', preview.id, { 'skill-b': { id: existing.id, version: existing.version } });
    const candidates = await personalSkillProvider(store, 'alice').list();
    assert.deepEqual(candidates.map(skill => skill.invocation), [{ modelInvocable: true, userInvocable: false }, { modelInvocable: false, userInvocable: true }]);
    const rootA = store.resourceBase('alice', installed[0]);
    assert.equal(fs.readFileSync(path.resolve(rootA, '../../shared/manual.md'), 'utf8'), 'shared');
    assert.match(fs.readFileSync(path.resolve(rootA, '../b/SKILL.md'), 'utf8'), /name: skill-b/);
    store.remove('alice', installed[0].id, installed[0].version);
    assert.equal(fs.existsSync(rootA), true);
    store.remove('alice', installed[1].id, installed[1].version);
    assert.equal(fs.existsSync(rootA), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
test('ZIP import HTTP preview, install, files and downloads authorize the validated owner', async () => {
  const dir = temp();
  const portal = http.createServer((req, res) => {
    const uid = req.headers.cookie;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(['alice', 'bob'].includes(uid) ? { authenticated: true, user: { uid, username: uid } } : { authenticated: false }));
  });
  const portalPort = await listen(portal), holder = http.createServer(), port = await listen(holder);
  await new Promise(resolve => holder.close(resolve));
  const child = spawn(process.execPath, [new URL('../index.js', import.meta.url).pathname], { env: { ...process.env, NODE_ENV: 'development', PORT: String(port), PORTAL_AUTH_URL: `http://127.0.0.1:${portalPort}`, DSH_HOME_DIR: dir, DSH_PROFILE: 'nonexistent-test-profile', HARNESS_DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', () => {});
  const call = (uid, suffix, method = 'GET', body, binary = false) => fetch(`http://127.0.0.1:${port}/api/chat/skills${suffix}`, { method, headers: { cookie: uid || '', 'Content-Type': binary ? 'application/zip' : 'application/json' }, ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }) });
  try {
    for (let i = 0; i < 120 && !output.includes('适配层就绪'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(output.includes('适配层就绪'), output);
    assert.equal((await call('', '/imports', 'POST', fixture(), true)).status, 401);
    const response = await call('alice', '/imports?name=skills.zip', 'POST', fixture(), true);
    assert.equal(response.status, 201);
    const { preview } = await response.json();
    assert.equal(preview.fileCount, 4);
    const mixedResponse = await call('alice', '/imports?name=mixed.zip', 'POST', archive({ 'ok/SKILL.md': markdown('http-ok'), 'broken/SKILL.md': '---\nname: [bad\n---\nx' }), true);
    assert.equal(mixedResponse.status, 201);
    const mixedPreview = (await mixedResponse.json()).preview;
    assert.equal(mixedPreview.skills.length, 1);
    assert.equal(mixedPreview.invalid.length, 1);
    assert.equal(mixedPreview.invalid[0].path, 'broken/SKILL.md');
    assert.equal((await call('bob', '/imports/' + preview.id, 'POST', {})).status, 404);
    assert.equal((await call('bob', '/imports/' + preview.id, 'DELETE')).status, 404);
    const installed = await call('alice', '/imports/' + preview.id, 'POST', {});
    assert.equal(installed.status, 200);
    const saved = (await installed.json()).skills[0];
    assert.equal((await call('bob', '/' + saved.id + '/files')).status, 404);
    assert.equal((await (await call('alice', '/' + saved.id + '/files')).json()).files.length, 4);
    const suffix = '/' + saved.id + '/file?path=' + encodeURIComponent('assets/样本.bin');
    assert.equal((await call('bob', suffix)).status, 404);
    const download = await call('alice', suffix);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /^attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from([0, 128, 255, 42]));
    assert.equal((await call('alice', '/imports', 'POST', Buffer.from('invalid'), true)).status, 400);
  } finally { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); await new Promise(resolve => portal.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
