import assert from 'node:assert/strict';
import test from 'node:test';
import { selectAttachments, transferFiles, hasTransferFiles, attachmentKind, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../src/lib/attachments.mjs';

const file = (name, size = 42, lastModified = 1) => ({ name, size, lastModified });
test('clipboard file items and drag files use one extraction path; text is left alone', () => {
  const image = file('截图.png');
  const item = { kind: 'file', getAsFile: () => image };
  assert.deepEqual(transferFiles({ files: [image], items: [item] }), [image]);
  assert.deepEqual(transferFiles({ files: [], items: [item, { kind: 'string' }] }), [image]);
  assert.deepEqual(transferFiles({ files: [], items: [{ kind: 'file', getAsFile: () => null }] }), []);
  assert.equal(hasTransferFiles({ types: ['Files'] }), true);
  assert.equal(hasTransferFiles({ items: [item] }), true);
  assert.equal(hasTransferFiles({ types: ['text/plain'] }), false);
});
test('selections accumulate, skip duplicate sources, and enforce count and byte limits', () => {
  const first = file('截图.png');
  const selected = selectAttachments([], [first, first, file('资料.md')]);
  assert.equal(selected.accepted.length, 2);
  const current = selected.accepted.map(({ file, fingerprint }) => ({ ...file, fingerprint }));
  assert.equal(selectAttachments(current, [first]).accepted.length, 0);
  assert.equal(selectAttachments([], Array.from({ length: 9 }, (_, i) => file(`文档${i}`))).accepted.length, 8);
  assert.equal(selectAttachments([], [file('too-large', MAX_FILE_BYTES + 1)]).accepted.length, 0);
  const batch = selectAttachments([], [file('a', MAX_FILE_BYTES), file('b', MAX_FILE_BYTES), file('c')]);
  assert.equal(batch.accepted.length, 2);
  assert.equal(batch.accepted.reduce((sum, item) => sum + item.file.size, 0), MAX_TOTAL_BYTES);
  assert.match(batch.errors[0], /40 MB/);
  assert.equal(selectAttachments([], [file('empty', 0)]).accepted.length, 0);
});
test('preview types work for clipboard MIME and files with missing MIME', () => {
  assert.equal(attachmentKind({ name: 'image', mimeType: 'image/png' }), 'image');
  assert.equal(attachmentKind(file('照片.JPEG')), 'image');
  assert.equal(attachmentKind(file('制度.PDF')), 'pdf');
  assert.equal(attachmentKind(file('说明.md')), 'text');
  assert.equal(attachmentKind(file('报告.docx')), 'file');
});
