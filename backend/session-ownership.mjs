import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const schema = `CREATE TABLE IF NOT EXISTS harness_sessions (
  session_id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, title TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL, updated_at DOUBLE PRECISION NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
)`;
const missing = () => Object.assign(new Error('会话不存在'), { status: 404 });
export function validSessionId(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,200}$/.test(id)) throw Object.assign(new Error('会话标识无效'), { status: 400 });
}

/** PostgreSQL in production; a persistent local SQLite database during development. */
export async function createSessionStore({ databaseUrl = process.env.HARNESS_DATABASE_URL,
  sqlitePath, production = process.env.NODE_ENV === 'production' } = {}) {
  let query, close;
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000 });
    query = async (sql, args = []) => (await pool.query(sql, args)).rows;
    close = () => pool.end();
  } else {
    if (production) throw new Error('HARNESS_DATABASE_URL must be configured in production');
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const db = new DatabaseSync(sqlitePath);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    query = async (sql, args = []) => {
      // SQLite's numbered placeholders do not accept pg's positional array binding.
      const ordered = [];
      const statement = db.prepare(sql.replace(/\$(\d+)/g, (_, n) => { ordered.push(args[Number(n) - 1]); return '?'; }));
      return statement.all(...ordered);
    };
    close = () => db.close();
  }
  await query(schema);
  await query('CREATE INDEX IF NOT EXISTS harness_sessions_owner_time ON harness_sessions (owner_uid, updated_at)');
  const requireSession = async (uid, id) => {
    validSessionId(id);
    const rows = await query('SELECT * FROM harness_sessions WHERE session_id=$1 AND owner_uid=$2 AND deleted=0', [id, uid]);
    if (!rows.length) throw missing();
    return rows[0];
  };
  return {
    require: requireSession, close,
    async create(uid, title, id = 'session-' + randomUUID().replaceAll('-', ''), time = Date.now()) {
      validSessionId(id);
      if (!uid) throw new Error('Missing authenticated user ID');
      await query('INSERT INTO harness_sessions (session_id,owner_uid,title,created_at,updated_at) VALUES ($1,$2,$3,$4,$4)',
        [id, uid, String(title || '新对话').slice(0, 100), time]);
      return id;
    },
    async list(uid) {
      return (await query('SELECT session_id,title,updated_at FROM harness_sessions WHERE owner_uid=$1 AND deleted=0 ORDER BY updated_at DESC LIMIT 200', [uid]))
        .map(row => ({ sessionId: row.session_id, title: row.title, time: Number(row.updated_at) }));
    },
    async touch(uid, id) {
      await requireSession(uid, id);
      await query('UPDATE harness_sessions SET updated_at=$1 WHERE session_id=$2 AND owner_uid=$3 AND deleted=0', [Date.now(), id, uid]);
    },
    async remove(uid, id) {
      await requireSession(uid, id);
      await query('UPDATE harness_sessions SET deleted=1 WHERE session_id=$1 AND owner_uid=$2', [id, uid]);
    },
    async clear(uid) { await query('UPDATE harness_sessions SET deleted=1 WHERE owner_uid=$1', [uid]); },
  };
}

/** Resolve ownership before reading any transcript, running the model or writing feedback. */
export async function authorizeSession(store, uid, id) { return store.require(uid, id); }

/** Approval IDs are authorized using tool calls emitted by the owner's active run. */
export async function ownedApprovals(store, uid, pending, calls) {
  const owned = [];
  for (const item of pending) {
    const run = calls.get(item.callId);
    if (!run || run.uid !== uid) continue;
    try { await store.require(uid, run.sessionId); owned.push(item); } catch (error) { if (error.status !== 404) throw error; }
  }
  return owned;
}
