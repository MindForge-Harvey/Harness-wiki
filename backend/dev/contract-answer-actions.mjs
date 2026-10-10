import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectAnswer, createAnswerShareStore } from '../answer-actions.mjs';

const events = [
  { kind: 'user', seq: 1, text: '第一个问题' },
  { kind: 'assistant', seq: 2, text: '第一个回答' },
  { kind: 'user', seq: 3, text: '第二个问题' },
  { kind: 'thinking', seq: 4, text: 'private reasoning' },
  { kind: 'tool', seq: 5, name: 'lightrag_query_data', status: 'done', queryId: 'q-test' },
  { kind: 'assistant', seq: 6, text: '第二个回答', time: 1000 },
];

test('answer actions bind the exact persisted answer to its question and retrieval', () => {
  const answer = selectAnswer(events, 'session-test', 6);
  assert.equal(answer.question, '第二个问题');
  assert.equal(answer.answer, '第二个回答');
  assert.equal(answer.queryId, 'q-test');
  assert.equal(selectAnswer(events, 'session-test', 2).queryId, null);
  for (const [session, seq] of [['../escape', 6], ['session-test', '6'], ['session-test', -1]]) {
    assert.throws(() => selectAnswer(events, session, seq), { status: 400 });
  }
  assert.throws(() => selectAnswer(events, 'session-test', 4), { status: 404 });
  assert.throws(() => selectAnswer(events, 'session-test', 99), { status: 404 });
});

test('shared snapshots survive a restart and contain only the selected question and answer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-shares-'));
  try {
    const share = createAnswerShareStore(dir).create(selectAnswer(events, 'session-test', 6));
    assert.match(share.id, /^[a-f0-9]{48}$/);
    assert.deepEqual(createAnswerShareStore(dir).get(share.id), share);
    assert.deepEqual(Object.keys(share).sort(), ['id', 'question', 'answer', 'time', 'createdAt'].sort());
    assert.equal(JSON.stringify(share).includes('private reasoning'), false);
    assert.equal(JSON.stringify(share).includes('第一个回答'), false);
    assert.equal(fs.statSync(path.join(dir, share.id + '.json')).mode & 0o777, 0o600);
    assert.throws(() => createAnswerShareStore(dir).get('../escape'), { status: 404 });
    assert.throws(() => createAnswerShareStore(dir).get('a'.repeat(48)), { status: 404 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
