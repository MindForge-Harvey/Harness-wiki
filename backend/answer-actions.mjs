import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });

/** Resolve an answer from the persisted transcript, never from client-supplied text. */
export function selectAnswer(events, sessionId, messageSeq) {
  if (!/^[\w-]{1,200}$/.test(sessionId || '') || !Number.isSafeInteger(messageSeq) || messageSeq < 0) {
    throw invalid('回答标识无效');
  }
  let question = '';
  let queryId = null;
  for (const event of events || []) {
    if (event.kind === 'user') { question = event.text || ''; queryId = null; }
    if (event.kind === 'tool' && event.name === 'lightrag_query_data' && event.status === 'done') {
      queryId = event.queryId || queryId;
    }
    if (event.kind === 'assistant' && event.seq === messageSeq && event.text) {
      return { sessionId, messageSeq, question, answer: event.text, queryId, time: event.time };
    }
  }
  throw invalid('这条回答不存在或尚未保存，请稍后重试', 404);
}

/** Only a question/answer snapshot is shared; tools, reasoning and other turns stay private. */
export function createAnswerShareStore(dir) {
  return {
    create(answer) {
      const id = crypto.randomBytes(24).toString('hex');
      const share = { id, question: answer.question, answer: answer.answer, time: answer.time, createdAt: new Date().toISOString() };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(share), { flag: 'wx', mode: 0o600 });
      return share;
    },
    get(id) {
      if (!/^[a-f0-9]{48}$/.test(id || '')) throw invalid('分享链接不存在', 404);
      try { return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') throw invalid('分享链接不存在', 404);
        throw error;
      }
    },
  };
}
