import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatAttachmentStore, validateAttachments } from '../chat-attachments.mjs';

const upload = (name = '测试.md', content = '附件内容', mimeType = '') => ({ name, data: Buffer.from(content).toString('base64'), mimeType });
test('stored attachments survive restart, preserve display text, and isolate session lookups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attachments-'));
  try {
    const store = createChatAttachmentStore(dir);
    const turn = store.save('session-a', '请总结', [upload(), upload('测试.md', '另一个同名文件')]);
    assert.notEqual(turn.attachments[0].id, turn.attachments[1].id);
    assert.equal(turn.content.length, 1);
    const restarted = createChatAttachmentStore(dir);
    const events = restarted.project('session-a', [{ kind: 'user', text: turn.prompt }, { kind: 'assistant', text: '完成' }]);
    assert.equal(events[0].text, '请总结');
    assert.deepEqual(events[0].attachments, turn.attachments);
    const item = restarted.file('session-a', turn.attachments[0].id);
    assert.equal(fs.readFileSync(item.path, 'utf8'), '附件内容');
    assert.equal(fs.statSync(item.path).mode & 0o777, 0o600);
    assert.throws(() => restarted.file('session-b', item.id), { status: 404 });
    assert.throws(() => restarted.file('../escape', item.id), { status: 400 });
    assert.throws(() => restarted.file('session-a', '../escape'), { status: 404 });
    assert.equal(events[1].text, '完成');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('raster images are native SDK inputs; unsafe display formats stay downloadable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attachments-'));
  try {
    const store = createChatAttachmentStore(dir);
    const png = { name: '图.png', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7eQAAAAASUVORK5CYII=' };
    const turn = store.save('images', '看图', [png, upload('page.html', '<script>alert(1)</script>', 'text/html'), upload('向量.svg', '<svg/>', 'image/svg+xml')]);
    assert.deepEqual(turn.content[1], { type: 'image', mimeType: 'image/png', data: png.data });
    assert.equal(turn.content.length, 2);
    assert.equal(store.file('images', turn.attachments[0].id).inline, true);
    for (const attachment of turn.attachments.slice(1)) {
      const item = store.file('images', attachment.id);
      assert.equal(item.inline, false);
      assert.equal(item.contentType, 'text/plain; charset=utf-8');
    }
    const long = store.save('images', '长文件名', [upload('文'.repeat(100) + '.md')]);
    assert.ok(fs.existsSync(store.file('images', long.attachments[0].id).path));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('invalid payloads are rejected before files are written, with browser-matching limits', () => {
  for (const input of [{}, [null], [upload('', 'a')], [{ name: 'a', data: '@@@' }], [{ name: 'a', data: 'YQ' }], Array.from({ length: 9 }, () => upload())]) assert.throws(() => validateAttachments(input), { status: 400 });
  assert.throws(() => validateAttachments([upload('empty', '')]), { status: 413 });
  assert.throws(() => validateAttachments([upload('big', Buffer.alloc(20 * 1024 * 1024 + 1))]), { status: 413 });
  const large = upload('valid', Buffer.alloc(20 * 1024 * 1024));
  assert.equal(validateAttachments([large])[0].bytes.length, 20 * 1024 * 1024);
  assert.throws(() => validateAttachments([large, large, upload()]), { status: 413 });
});
