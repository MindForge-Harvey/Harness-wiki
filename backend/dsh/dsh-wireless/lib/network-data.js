import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { analyzeObservations } from './analytics.js'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
export const networkDatabase = () => process.env.WIRELESS_NETWORK_DB || path.join(project, '.run/wireless-network-data/network.sqlite')
export function compactAnalysis(analysis) {
  return { ...analysis, series: analysis.series.map(({ values, ...series }) => series) }
}

/** A separate, source-labelled observation store; the original ticket archive stays immutable. */
export function createNetworkDataStore({ database = networkDatabase(), writable = false } = {}) {
  let db
  function open() {
    if (db) return db
    if (!writable && !fs.existsSync(database)) return null
    if (writable) fs.mkdirSync(path.dirname(database), { recursive: true })
    db = new DatabaseSync(database, { readOnly: !writable })
    if (writable) db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots(ticket_id TEXT,snapshot_date TEXT,version TEXT NOT NULL,data TEXT NOT NULL,
        PRIMARY KEY(ticket_id,snapshot_date));
      CREATE TABLE IF NOT EXISTS observations(ticket_id TEXT,snapshot_date TEXT,object_id TEXT,metric TEXT,
        start TEXT,value REAL NOT NULL,data TEXT NOT NULL,PRIMARY KEY(ticket_id,snapshot_date,object_id,metric,start));
      CREATE TABLE IF NOT EXISTS parameter_rules(ticket_id TEXT,snapshot_date TEXT,parameter TEXT,execution_key TEXT,data TEXT NOT NULL,
        PRIMARY KEY(ticket_id,snapshot_date,parameter,execution_key));
      CREATE TABLE IF NOT EXISTS metric_definitions(system TEXT,column_name TEXT,data TEXT NOT NULL,PRIMARY KEY(system,column_name));
      CREATE INDEX IF NOT EXISTS observations_lookup ON observations(ticket_id,snapshot_date,object_id,metric,start);
    `)
    return db
  }
  function stored(ticket_id, snapshot_date) {
    if (!open()) return null
    const row = snapshot_date
      ? db.prepare('SELECT * FROM snapshots WHERE ticket_id=? AND snapshot_date=?').get(ticket_id, snapshot_date)
      : db.prepare('SELECT * FROM snapshots WHERE ticket_id=? ORDER BY snapshot_date DESC LIMIT 1').get(ticket_id)
    return row ? { ...JSON.parse(row.data), version: row.version } : null
  }
  function read(ticket_id, snapshot_date) {
    const snapshot = stored(ticket_id, snapshot_date)
    if (!snapshot) return null
    const parameters = [ticket_id, snapshot.snapshot_date]
    return { ...snapshot,
      observations: db.prepare('SELECT data FROM observations WHERE ticket_id=? AND snapshot_date=? ORDER BY start,object_id,metric')
        .all(...parameters).map(row => JSON.parse(row.data)),
      rules: db.prepare('SELECT data FROM parameter_rules WHERE ticket_id=? AND snapshot_date=? ORDER BY parameter,execution_key')
        .all(...parameters).map(row => JSON.parse(row.data)),
    }
  }
  function write(snapshot) {
    if (!writable) throw new Error('指标库为只读，不能由模型补造观测')
    if (!snapshot.ticket_id || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.snapshot_date) || !snapshot.source_ref
      || !snapshot.observations?.length || !snapshot.rules?.length) throw new Error('快照需要工单、日期、来源、指标和规则')
    const { observations, rules, metric_definitions = [], ...data } = snapshot
    const validation = analyzeObservations({ observations })
    if (validation.quarantined.length || validation.duplicate_rows.length) throw new Error('指标快照含冲突或无效观测：' + JSON.stringify(validation.quarantined.slice(0, 2).map(row => row.issues)))
    const version = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
    data.observation_count = observations.length
    data.rule_count = rules.length
    open().exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?)').run(data.ticket_id, data.snapshot_date, version, JSON.stringify(data))
      for (const table of ['observations', 'parameter_rules']) db.prepare(`DELETE FROM ${table} WHERE ticket_id=? AND snapshot_date=?`).run(data.ticket_id, data.snapshot_date)
      const observation = db.prepare('INSERT INTO observations VALUES (?,?,?,?,?,?,?)')
      for (const row of observations) observation.run(data.ticket_id, data.snapshot_date, row.object_id, row.metric,
        row.time_window.start, row.value, JSON.stringify(row))
      const rule = db.prepare('INSERT INTO parameter_rules VALUES (?,?,?,?,?)')
      for (const row of rules) rule.run(data.ticket_id, data.snapshot_date, row.parachinname, row.execute_number || '', JSON.stringify(row))
      for (const row of metric_definitions) db.prepare('INSERT OR REPLACE INTO metric_definitions VALUES (?,?,?)')
        .run(row.system, row.column, JSON.stringify(row))
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return { ticket_id: data.ticket_id, version, observations: observations.length, rules: rules.length }
  }
  function query(args = {}) {
    if ((args.operation || 'read') === 'catalog') return { status: open() ? 'available' : 'not_configured', snapshots: open()
      ? db.prepare('SELECT ticket_id,snapshot_date,version FROM snapshots ORDER BY snapshot_date DESC,ticket_id').all() : [] }
    if (typeof args.ticket_id !== 'string' || !args.ticket_id.trim()) throw new Error('read/series 需要业务工单号 ticket_id')
    if (args.snapshot_date && !/^\d{4}-\d{2}-\d{2}$/.test(args.snapshot_date)) throw new Error('snapshot_date 需要 YYYY-MM-DD')
    const snapshot = read(args.ticket_id, args.snapshot_date)
    if (!snapshot) return { status: 'not_found', ticket_id: args.ticket_id, snapshot_date: args.snapshot_date || null }
    if (args.operation === 'series') {
      if (!args.metric) throw new Error('series 需要 metric，可使用中文名或原列名')
      const rows = snapshot.observations.filter(row => (row.metric === args.metric || row.source_column === args.metric)
        && (!args.object_id || row.object_id === args.object_id))
      return { status: 'found', ticket_id: args.ticket_id, snapshot_date: snapshot.snapshot_date, source_ref: snapshot.source_ref,
        total: rows.length, observations: rows.slice(0, 288), provenance: snapshot.provenance }
    }
    if (args.operation && args.operation !== 'read') throw new Error('operation 需要 catalog/read/series')
    const { observations, ...metadata } = snapshot
    return { status: 'found', ...metadata, analysis: compactAnalysis(analyzeObservations({ observations })),
      metrics: [...new Map(observations.map(row => [row.source_column, { column: row.source_column, name: row.metric,
        unit: row.unit, definition: row.definition }])).values()] }
  }
  return { read, summary: stored, write, query, close: () => { db?.close(); db = undefined } }
}
