import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { createNetworkDataStore } from './network-data.js'

const execute = promisify(execFile)
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
export const archiveDatabase = () => process.env.WIRELESS_ARCHIVE_DB || path.join(project, '.run/wireless-orders/orders.sqlite')

export async function prepareOrderArchive({ database = archiveDatabase(), archive } = {}) {
  const candidates = [archive, process.env.WIRELESS_ORDER_ARCHIVE,
    path.resolve(project, '../wireless-network-optimizaton-agent/ECHO-Mem_paper_data_20261110.zip'),
    path.resolve(project, '../wireless-network-optimization-agent/ECHO-Mem_paper_data_20261110.zip')].filter(Boolean)
  const source = candidates.find(file => fs.existsSync(file))
  if (!source) return { available: fs.existsSync(database), status: fs.existsSync(database) ? 'indexed' : 'archive_not_found' }
  const { stdout } = await execute(process.env.WIRELESS_PYTHON || 'python3',
    [path.join(project, 'backend/dev/import-wireless-orders.py'), source, database], { timeout: 180000, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout)
}

function integer(value, fallback, min, max) {
  const n = value ?? fallback
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`分页参数需要 ${min} 至 ${max} 的整数`)
  return n
}
function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('日期需要 YYYY-MM-DD')
  return value
}
const text = (value, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('查询字段需要非空字符串')
  return value.trim()
}

export function createOrderArchive({ database = archiveDatabase(), network = createNetworkDataStore() } = {}) {
  let db
  function open() {
    if (!fs.existsSync(database)) return null
    db ??= new DatabaseSync(database, { readOnly: true })
    return db
  }
  function catalog() {
    if (!open()) return { available: false, status: 'index_not_ready', message: '工单索引尚未就绪，请稍后重试。' }
    return JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='catalog'").get().value)
  }
  function analysisSelection(ticket_id, snapshot_date, analysis_scope = 'ticket') {
    if (!['ticket', 'latest'].includes(analysis_scope)) throw new Error('analysis_scope 需要 ticket/latest')
    if (snapshot_date) date(snapshot_date)
    if (snapshot_date && analysis_scope === 'latest') throw new Error('snapshot_date 与 latest 不能同时指定')
    const row = open()?.prepare('SELECT issued_at FROM tickets WHERE ticket_id=? OR trace_id=?').get(ticket_id, ticket_id)
    const ticket_date = row?.issued_at?.slice(0, 10) || null
    const available_dates = (network.query({ operation: 'catalog' }).snapshots || [])
      .filter(item => item.ticket_id === ticket_id).map(item => item.snapshot_date)
    const selected_date = snapshot_date || (analysis_scope === 'latest' ? available_dates[0] : ticket_date) || null
    return { policy: 'ticket_period_v1', scope: snapshot_date ? 'specified_date' : analysis_scope,
      ticket_date, selected_date, available_dates,
      cross_period: Boolean(selected_date && ticket_date && selected_date !== ticket_date),
      interpretation: snapshot_date || analysis_scope === 'latest'
        ? '按用户明确选择的分析时点取数；跨期快照只能说明该时点的小区状态，不能反推原工单根因或执行效果。'
        : '默认复盘工单日期；仅使用同日指标、诊断和参数。其他日期资料不自动带入，归档方案及执行评价仍可独立总结。' }
  }
  function query(args = {}) {
    const meta = catalog()
    if (!meta.available) return meta
    const operation = args.operation || (args.ticket_id ? 'read' : 'list')
    if (operation === 'catalog') return { ...meta, status: 'available',
      latest_tickets: db.prepare('SELECT ticket_id,issued_at,issue,system,vendor,region,cell_name FROM tickets ORDER BY issued_at DESC,ticket_id LIMIT 5').all(),
      interpretation: '当前工单库的日期范围是归档记录范围；未记录在办状态时不能推定这些工单目前待处理。' }
    if (operation === 'read') {
      const id = text(args.ticket_id, 128)
      const row = db.prepare('SELECT detail FROM tickets WHERE ticket_id=? OR trace_id=?').get(id, id)
      if (!row) return { status: 'not_found', ticket_id: id, source: meta.source, available: true }
      const detail = JSON.parse(row.detail)
      const selection = analysisSelection(detail.ticket.id)
      const available = selection.selected_date ? network.summary(detail.ticket.id, selection.selected_date) : null
      const states = {}, long_evaluations = {}
      for (const a of detail.actions) {
        a.short_evaluation_status = /未启用|not enabled/i.test(a.short_eval_result || '') ? 'not_enabled'
          : a.short_eval_result ? 'reported' : 'missing'
        a.short_evaluation_interpretation = a.short_evaluation_status === 'not_enabled'
          ? '短评估未启用；原字段中的不通过为占位文本，不算一次实际评估失败。'
          : a.short_evaluation_status === 'missing' ? '未记录短评估结果。' : '按原始短评估结果解释。'
        states[a.exec_state || 'unknown'] = (states[a.exec_state || 'unknown'] || 0) + 1
        long_evaluations[a.long_eval_result || 'unknown'] = (long_evaluations[a.long_eval_result || 'unknown'] || 0) + 1
      }
      return { status: 'found', ...detail, action_summary: { total: detail.actions.length, execution_states: states, long_evaluations },
        analysis_selection: selection,
        archive_missing_fields: ['conclusion', 'smart_conclusion', 'KPI/MR time series'].filter(k => !detail.ticket[k]),
        missing_fields: ['conclusion', 'smart_conclusion'].filter(k => !detail.ticket[k] && !available?.order_patch?.[k])
          .concat(available?.observation_count ? [] : ['KPI/MR time series']),
        ...(available ? { available_analysis: available, analysis_basis: {
          snapshot_date: available.snapshot_date, diagnostic_source: 'network_snapshot', diagnostic_source_ref: available.source_ref,
          archive_issued_at: detail.ticket.issued_at || null,
          interpretation: '诊断与六维判定来自所列日期的小区分析快照，不是原归档诊断。归档动作/执行/评价与当前分析资料分开解释。',
        } } : {}),
        interpretation: '工单日期与状态按原档案。失败动作的 recorded_target 只是尝试目标，actual_after 未确认；参数动作组不能当成已确认根因。' }
    }
    if (operation !== 'list') throw new Error('operation 需要 catalog/list/read')
    const clauses = [], parameters = [], filters = {}
    if (args.month) {
      let month = text(args.month, 7).replace(/月$/, '')
      if (/^\d{1,2}$/.test(month)) {
        const suffix = '-' + String(Number(month)).padStart(2, '0')
        const matched = Object.keys(meta.months).filter(m => m.endsWith(suffix)).sort()
        month = matched.at(-1) || meta.date_range.to.slice(0, 4) + suffix
        filters.year_resolution = '按工单库该月份最近有数据的年份'
      }
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('month 需要 YYYY-MM 或 1 至 12 月')
      clauses.push('substr(issued_at,1,7)=?'); parameters.push(month); filters.month = month
    }
    for (const [key, column, comparator] of [['date_from', 'issued_at', '>='], ['date_to', 'issued_at', '<='],
      ['issue', 'issue', '='], ['region', 'region', '='], ['vendor', 'vendor', '='], ['system', 'system', '=']]) {
      if (!args[key]) continue
      let value = key.startsWith('date_') ? date(args[key]) : text(args[key])
      if (key === 'system') value = ({ '4G': 'LTE', '5G': 'NR' }[value.toUpperCase()] || value.toUpperCase())
      filters[key] = value; clauses.push(`${column} ${comparator} ?`); parameters.push(value)
    }
    if (filters.date_from && filters.date_to && filters.date_from > filters.date_to) throw new Error('起始日期不能晚于结束日期')
    if (args.query) {
      const q = text(args.query).replace(/[\\%_]/g, c => '\\' + c)
      clauses.push("(ticket_id LIKE ? ESCAPE '\\' OR cell_name LIKE ? ESCAPE '\\' OR issue LIKE ? ESCAPE '\\')")
      parameters.push(...Array(3).fill(`%${q}%`)); filters.query = args.query
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
    const scope = db.prepare('SELECT COUNT(*) AS total,MIN(issued_at) AS first_date,MAX(issued_at) AS last_date FROM tickets' + where).get(...parameters)
    const total = scope.total
    const limit = integer(args.limit, 10, 1, 50), offset = integer(args.offset, 0, 0, 1000000)
    const rows = db.prepare('SELECT ticket_id,issued_at,issue,system,vendor,region,cell_name,action_count,outcome FROM tickets' + where + ' ORDER BY issued_at DESC,ticket_id LIMIT ? OFFSET ?').all(...parameters, limit, offset)
    const counts = column => db.prepare(`SELECT ${column} AS name,COUNT(*) AS count FROM tickets${where} GROUP BY ${column} ORDER BY count DESC,name LIMIT 12`).all(...parameters)
    return { status: total ? 'found' : 'no_matches', source: meta.source, filters, total, limit, offset,
      has_more: offset + rows.length < total, tickets: rows, issue_counts: counts('issue'), system_counts: counts('system'), outcome_counts: counts('outcome'),
      matched_date_range: { from: scope.first_date, to: scope.last_date },
      archive: { total_tickets: meta.total_tickets, date_range: meta.date_range },
      interpretation: '汇总覆盖全部匹配记录，列表为当前分页。当前工单库不等于当前在办队列；归档结果不自动代表现网状态。' }
  }
  query.close = () => { db?.close(); db = undefined; network.close() }
  query.analysisSelection = analysisSelection
  query.analysisData = (ticket_id, snapshot_date, analysis_scope) => {
    const selection = analysisSelection(ticket_id, snapshot_date, analysis_scope)
    const data = selection.selected_date ? network.read(ticket_id, selection.selected_date) : null
    return data ? { ...data, analysis_selection: selection } : null
  }
  query.networkQuery = (args = {}) => {
    if (args.operation === 'catalog') return network.query(args)
    if (typeof args.ticket_id !== 'string' || !args.ticket_id.trim()) throw new Error('read/series 需要业务工单号 ticket_id')
    const selection = analysisSelection(args.ticket_id, args.snapshot_date, args.analysis_scope)
    const result = selection.selected_date ? network.query({ ...args, snapshot_date: selection.selected_date })
      : { status: 'not_found', ticket_id: args.ticket_id, snapshot_date: null }
    return { ...result, analysis_selection: selection }
  }
  query.caseRecords = (ticket, limit = 80) => {
    if (!open() || !ticket.issued_at || !ticket.primary_issue_type) return []
    const rows = db.prepare(`SELECT detail FROM tickets WHERE issue=? AND vendor=? AND system=?
      AND issued_at<? AND ticket_id<>? ORDER BY issued_at DESC,ticket_id LIMIT ?`)
      .all(ticket.primary_issue_type, ticket.vendor || '', ticket.system || '', ticket.issued_at.slice(0, 10), ticket.id,
        integer(limit, 80, 1, 100))
    return rows.map(row => JSON.parse(row.detail))
  }
  return query
}
