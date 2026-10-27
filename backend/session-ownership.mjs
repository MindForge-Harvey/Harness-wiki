import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const schema = `CREATE TABLE IF NOT EXISTS harness_sessions (
  session_id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, title TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL, updated_at DOUBLE PRECISION NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
)`;
/** 每轮结束时登记本会话生成或修改过的文档，文档面板只展示登记到当前会话的记录。 */
const documentsSchema = `CREATE TABLE IF NOT EXISTS harness_session_documents (
  session_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  size INTEGER NOT NULL, mtime DOUBLE PRECISION NOT NULL, PRIMARY KEY (session_id, path)
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
    // 单机部署（DISABLE_PORTAL_AUTH=1）允许 production 用 SQLite，无需强制 PostgreSQL
    if (production && process.env.DISABLE_PORTAL_AUTH !== '1') throw new Error('HARNESS_DATABASE_URL must be configured in production');
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
  await query(documentsSchema);
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
    async list(uid, { limit = 200, offset = 0 } = {}) {
      // limit/offset 由路由层钳制后传入，拼进 SQL 是安全的。
      const cap = Math.min(Math.max(Math.trunc(Number(limit)) || 200, 1), 500);
      const off = Math.max(Math.trunc(Number(offset)) || 0, 0);
      return (await query(`SELECT session_id,title,updated_at FROM harness_sessions WHERE owner_uid=$1 AND deleted=0 ORDER BY updated_at DESC LIMIT ${cap} OFFSET ${off}`, [uid]))
        .map(row => ({ sessionId: row.session_id, title: row.title, time: Number(row.updated_at) }));
    },
    async touch(uid, id) {
      await requireSession(uid, id);
      await query('UPDATE harness_sessions SET updated_at=$1 WHERE session_id=$2 AND owner_uid=$3 AND deleted=0', [Date.now(), id, uid]);
    },
    async remove(uid, id) {
      await requireSession(uid, id);
      await query('UPDATE harness_sessions SET deleted=1 WHERE session_id=$1 AND owner_uid=$2', [id, uid]);
      await query('DELETE FROM harness_session_documents WHERE session_id=$1', [id]);
    },
    async clear(uid) { await query('UPDATE harness_sessions SET deleted=1 WHERE owner_uid=$1', [uid]); },
    /** 登记一轮执行里生成或修改的文档；同一路径以最后一次写入为准。 */
    async recordDocuments(sessionId, docs) {
      for (const doc of docs) {
        await query(`INSERT INTO harness_session_documents (session_id,path,name,kind,size,mtime)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (session_id,path) DO UPDATE SET
            name=EXCLUDED.name, kind=EXCLUDED.kind, size=EXCLUDED.size, mtime=EXCLUDED.mtime`,
          [sessionId, doc.path, doc.name, doc.kind, doc.size, doc.mtime]);
      }
    },
    /** 当前会话登记过的文档，按修改时间倒序。 */
    async listDocuments(sessionId) {
      return (await query('SELECT path,name,kind,size,mtime FROM harness_session_documents WHERE session_id=$1 ORDER BY mtime DESC', [sessionId]))
        .map(row => ({ path: row.path, name: row.name, kind: row.kind, size: Number(row.size), mtime: Number(row.mtime) }));
    },
    /** 已有归属记录的文档路径，用于启动时只补齐尚未归属的文档。 */
    async documentPaths() {
      return (await query('SELECT DISTINCT path FROM harness_session_documents', [])).map(row => row.path);
    },
    /** 所有未删除会话，供首次升级按时间窗口回填文档归属。 */
    async sessions() {
      return (await query('SELECT session_id,created_at,updated_at FROM harness_sessions WHERE deleted=0', []))
        .map(row => ({ sessionId: row.session_id, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }));
    },
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
