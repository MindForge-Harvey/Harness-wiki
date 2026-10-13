/** One-time, explicitly assigned legacy ownership. No automatic claiming of old logs. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createSessionStore, validSessionId } from './session-ownership.mjs';
const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), process.env.DSH_HOME_DIR || 'dsh/home');
const assignments = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const store = await createSessionStore({ sqlitePath: path.join(home, 'storages', 'chat-sessions.sqlite') });
let count = 0;
try {
  for (const { sessionId, uid } of assignments) {
    validSessionId(sessionId);
    const root = path.join(home, 'sessions');
    const directory = fs.readdirSync(root).map(ws => path.join(root, ws, sessionId)).find(p => fs.existsSync(p));
    if (!directory) throw new Error('Legacy session missing: ' + sessionId);
    const plain = path.join(directory, 'session.v3.jsonl');
    const text = fs.existsSync(plain) ? fs.readFileSync(plain, 'utf8') : execFileSync('zstd', ['-dc', path.join(directory, 'session.v3.jsonl.zstd')], { maxBuffer: 128 * 1024 * 1024 }).toString();
    const events = text.trim().split('\n').map(JSON.parse);
    const first = events.find(e => e.type === 'user/message' && e.data?.source?.kind === 'user');
    const title = first?.data?.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '历史对话';
    const created = Date.parse(events[0].createdAt) || fs.statSync(directory).mtimeMs;
    try { await store.create(uid, title, sessionId, created); count++; }
    catch (error) {
      // Idempotent only if the immutable owner already agrees with this explicit assignment.
      const row = await store.require(uid, sessionId);
      if (row.owner_uid !== uid) throw error;
    }
  }
  console.log(JSON.stringify({ assigned: count, verified: assignments.length }));
} finally { await store.close(); }
