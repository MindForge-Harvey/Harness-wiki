import fs from 'node:fs'
import path from 'node:path'
import { buildEvidence, windowOf } from './workflow.js'

const round = value => {
  if (!Number.isFinite(value)) return null
  const rounded = Math.round(value * 10000) / 10000
  return rounded === 0 ? 0 : rounded
}
const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
const keyOf = row => JSON.stringify([row.object_id, row.metric, row.unit, row.definition, row.cohort || ''])
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const quantile = (values, q) => { const s = [...values].sort((a, b) => a - b), p = (s.length - 1) * q
  return s.length ? s[Math.floor(p)] + (s[Math.ceil(p)] - s[Math.floor(p)]) * (p % 1) : null }

export function readObservations(file_path, workspace = process.cwd()) {
  const root = fs.realpathSync(workspace), file = fs.realpathSync(path.resolve(root, file_path))
  if (!file.startsWith(root + path.sep)) throw new Error('观测文件必须位于当前工作区')
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('观测文件最多 8 MB')
  const text = fs.readFileSync(file, 'utf8').trim()
  return text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** Descriptive calculations over sourced observations; no invented domain thresholds or causes. */
export function analyzeObservations({ observations, object_id, object_ids, baseline_points = 48, timezone_offset_minutes = 480 } = {}) {
  if (!Array.isArray(observations) || observations.length > 10000 || !observations.length) throw new Error('需要 1 至 10000 条观测')
  if (!Number.isInteger(baseline_points) || baseline_points < 2 || baseline_points > 5000) throw new Error('baseline_points 必须为 2 至 5000')
  if (!Number.isInteger(timezone_offset_minutes) || Math.abs(timezone_offset_minutes) > 840) throw new Error('时区偏移超出范围')
  if (object_ids !== undefined && (!Array.isArray(object_ids) || !object_ids.length || object_ids.length > 24 || object_ids.some(id => typeof id !== 'string'))) throw new Error('object_ids 必须为 1 至 24 个对象 ID')
  const selectedObjects = object_id ? new Set([object_id]) : object_ids ? new Set(object_ids) : null
  const scoped = selectedObjects ? observations.filter(row => selectedObjects.has(row?.object_id)) : observations
  const offsetLabel = `${timezone_offset_minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(timezone_offset_minutes) / 60)).padStart(2, '0')}:${String(Math.abs(timezone_offset_minutes) % 60).padStart(2, '0')}`
  const localTime = time => new Date(Date.parse(time) + timezone_offset_minutes * 60000).toISOString().replace('Z', offsetLabel)
  const period = rows => rows.length ? { start: localTime(rows[0].time_window.start), end: localTime(rows.at(-1).time_window.end) } : null
  const groups = new Map(), quarantined = [], seen = new Map()
  const duplicates = [], allSources = new Set()
  for (const [index, row] of scoped.entries()) {
    if (!row || typeof row !== 'object') { quarantined.push({ row: index, issues: ['not_an_observation'] }); continue }
    const checked = buildEvidence({ object_id: row.object_id, time_window: windowOf(row.time_window) }, { observations: [row] })
    if (checked.quarantined.length || !row.metric || !row.definition || !row.unit || typeof row.value !== 'number' || !Number.isFinite(row.value)) {
      quarantined.push({ row: index, issues: checked.quarantined[0]?.issues || ['missing_numeric_metric_contract'] }); continue
    }
    const key = keyOf(row), temporalKey = key + ':' + checked.current_evidence[0].observation.time_window.start
    if (seen.has(temporalKey)) {
      const previous = seen.get(temporalKey)
      if (canonical(previous.row) === canonical(checked.current_evidence[0].observation)) duplicates.push(index)
      else { previous.conflict = true; quarantined.push({ row: index, issues: ['conflicting_observation_same_window'] }) }
      continue
    }
    const entry = { row: checked.current_evidence[0].observation, input_index: index, conflict: false }
    seen.set(temporalKey, entry)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
    allSources.add(row.source_ref)
  }
  const series = []
  for (const entries of groups.values()) {
    const rows = entries.filter(e => { if (e.conflict) quarantined.push({ row: e.input_index, issues: ['conflicting_observation_same_window'] }); return !e.conflict }).map(e => e.row)
      .sort((a, b) => Date.parse(a.time_window.start) - Date.parse(b.time_window.start))
    if (!rows.length) continue
    const first = rows[0]
    if (object_id && first.object_id !== object_id) continue
    const durations = rows.map(r => Date.parse(r.time_window.end) - Date.parse(r.time_window.start))
    const overlap = rows.some((r, i) => i && Date.parse(r.time_window.start) < Date.parse(rows[i - 1].time_window.end))
    const comparable = new Set(durations).size === 1 && !overlap
    const values = rows.map(r => r.value), mean = average(values)
    const base = rows.slice(0, Math.min(baseline_points, Math.max(0, rows.length - 1)))
    const recent = rows.slice(base.length)
    const baseMean = average(base.map(r => r.value)), recentMean = average(recent.map(r => r.value))
    const std = base.length ? Math.sqrt(average(base.map(r => (r.value - baseMean) ** 2))) : null
    const declared = rows.filter(row => row.threshold && ({ gt: (a, b) => a > b, gte: (a, b) => a >= b,
      lt: (a, b) => a < b, lte: (a, b) => a <= b })[row.threshold.operator]?.(row.value, row.threshold.value))
    const hourly = new Map()
    for (const row of rows) { const hour = new Date(Date.parse(row.time_window.start) + timezone_offset_minutes * 60000).getUTCHours()
      if (!hourly.has(hour)) hourly.set(hour, []); hourly.get(hour).push(row.value) }
    const worstHour = [...hourly.entries()].map(([hour, v]) => ({ hour, mean: round(average(v)), observations: v.length }))
      .sort((a, b) => first.good_direction === 'higher' ? a.mean - b.mean : b.mean - a.mean)[0]
    series.push({ object_id: first.object_id, metric: first.metric, source_column: first.source_column || null,
      unit: first.unit, definition: first.definition, cohort: first.cohort || null,
      observation_count: rows.length, mean: comparable ? round(mean) : null, min: Math.min(...values), max: Math.max(...values), p50: round(quantile(values, 0.5)), p95: round(quantile(values, 0.95)),
      equal_duration_nonoverlapping_windows: comparable,
      missing_intervals: comparable ? rows.slice(1).reduce((n, row, i) => n + Math.max(0, Math.round((Date.parse(row.time_window.start) - Date.parse(rows[i].time_window.end)) / durations[0])), 0) : null,
      baseline: { observations: base.length, time_window: period(base), mean: comparable ? round(baseMean) : null, stddev: comparable ? round(std) : null },
      recent: { observations: recent.length, time_window: period(recent), mean: comparable ? round(recentMean) : null },
      change_from_baseline: comparable && base.length && recent.length ? { absolute: round(recentMean - baseMean), unit: first.unit === '%' ? 'percentage_points' : first.unit,
        relative_percent: baseMean ? round((recentMean - baseMean) / Math.abs(baseMean) * 100) : null } : null,
      declared_threshold_breaches: declared.length,
      declared_thresholds: [...new Map(rows.filter(row => row.threshold).map(row => [canonical(row.threshold), row.threshold])).values()],
      threshold_sources: [...new Set(rows.flatMap(row => row.threshold?.source_ref ? [row.threshold.source_ref] : []))],
      baseline_deviations_over_3sd: comparable && base.length >= 8 && std > 0 ? recent.filter(row => Math.abs(row.value - baseMean) > 3 * std).length : null,
      worst_hour_under_declared_direction: comparable && ['higher', 'lower'].includes(first.good_direction) ? worstHour : null,
      values: rows.slice(-96).map(row => ({ start: row.time_window.start, end: row.time_window.end, value: row.value })),
      source_refs: [...new Set(rows.map(row => row.source_ref))] })
  }
  const correlations = [], peerComparisons = []
  const reported = series.slice(0, 24)
  for (let i = 0; i < reported.length; i++) for (let j = i + 1; j < reported.length; j++) {
    const a = reported[i], b = reported[j]
    if (!a.equal_duration_nonoverlapping_windows || !b.equal_duration_nonoverlapping_windows) continue
    const byWindow = new Map(b.values.map(row => [row.start + row.end, row.value]))
    const pairs = a.values.filter(row => byWindow.has(row.start + row.end)).map(row => [row.value, byWindow.get(row.start + row.end)])
    if (pairs.length < 8) continue
    if (a.object_id !== b.object_id) {
      if (a.metric === b.metric && a.unit === b.unit && a.definition === b.definition && a.cohort === b.cohort) peerComparisons.push({
        objects: [a.object_id, b.object_id], metric: a.metric, aligned_windows: pairs.length,
        mean_difference: round(average(pairs.map(p => p[0] - p[1]))), unit: a.unit === '%' ? 'percentage_points' : a.unit,
        interpretation: '同定义、人群和窗口的描述性对照；不能排除未观测混杂' })
      continue
    }
    const ax = average(pairs.map(p => p[0])), bx = average(pairs.map(p => p[1]))
    const denominator = Math.sqrt(pairs.reduce((n, p) => n + (p[0] - ax) ** 2, 0) * pairs.reduce((n, p) => n + (p[1] - bx) ** 2, 0))
    if (denominator) correlations.push({ object_id: a.object_id, metrics: [a.metric, b.metric], aligned_windows: pairs.length,
      pearson_r: round(pairs.reduce((n, p) => n + (p[0] - ax) * (p[1] - bx), 0) / denominator), interpretation: '描述性同步关系，不证明根因或参数作用' })
  }
  return { status: series.length ? 'analyzed' : 'needs_data', input_count: observations.length, scoped_count: scoped.length, usable_count: [...groups.values()].flat().filter(e => !e.conflict).length,
    synthetic: observations.every(row => row?.data_origin === 'constructed' || String(row?.source_ref).startsWith('synthetic://')),
    series: reported, series_count: series.length, truncated: series.length > 24, correlations: correlations.slice(0, 24), peer_comparisons: peerComparisons.slice(0, 24),
    quarantined, duplicate_rows: duplicates, source_count: allSources.size,
    method: { implementation: 'Harness 描述统计适配层；不是 ECHO 论文里的自动根因算法', baseline_points,
      averaging: '相同定义、人群、等长且不重叠窗口的观测值算术均值；百分率不合并计数器', timezone_offset_minutes, analysis_time_zone: `UTC${offsetLabel}` },
    interpretation: '异常门限仅采用输入声明；3σ 仅是相对基线变化线索。分析不推导因果、不授予执行权限。' }
}
