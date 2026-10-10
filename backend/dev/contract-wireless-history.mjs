import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import test from 'node:test'
import { createMemoryService } from '../dsh/dsh-wireless/lib/compiler.js'
import { createHistorySearch } from '../dsh/dsh-wireless/lib/history.js'
import { taskProgress, visibleTool } from '../../frontend/src/lib/task-progress.mjs'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wireless-history-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const memory = createMemoryService({ directory })
  const run = createHistorySearch({ memory })
  const search = args => run({ as_of: '2026-10-10T00:00:00+08:00', ...args })
  return { directory, memory, search }
}

// Synthetic packages exercise retrieval contracts, not historical wireless efficacy.
function writePackage(directory, digit, rows, { mode = 'historical', as_of = '2026-10-08T00:00:00+08:00' } = {}) {
  const package_id = 'wp_' + digit.repeat(24)
  const root = path.join(directory, 'packages', package_id)
  fs.mkdirSync(root, { recursive: true })
  const files = {
    'memory_objects.jsonl': rows,
    'memory_scores.jsonl': rows.map(row => ({ memory_id: row.memory_id, credibility_lcb: 0.2 })),
    'memory_evidence_profiles.jsonl': rows.map(row => ({ memory_id: row.memory_id, trace_ids: row.trace_ids, authority: 'fixture_only' })),
  }
  const values = {}
  for (const [name, records] of Object.entries(files)) {
    const bytes = records.map(row => JSON.stringify(row)).join('\n') + '\n'
    fs.writeFileSync(path.join(root, name), bytes)
    values[name] = crypto.createHash('sha256').update(bytes).digest('hex')
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ package_id,
    checksum: { values }, source: { dataset: 'synthetic_contract_fixture', trace_count: 1 },
    harness: { mode, as_of, compiler_commit: 'fixture', calibrated_gate_loaded: false } }))
  return package_id
}

const row = (memory_type, state, id = memory_type) => ({ memory_id: id, memory_type, state,
  title: 'FooHistoryOnly 下载慢历史', summary: '合成契约夹具', trace_ids: ['fixture-shared-trace'],
  applicability: { vendors: ['华为'], systems: ['LTE'], issue_types: ['低速率'] },
  content: { parameter: 'FooHistoryOnly', direction: 'increase' } })

test('analysis actually searches retained experience and distinguishes missing production data from no matching history', t => {
  const { directory, search } = fixture(t)
  const hit = search({ query: 'QRxLevMin', vendor: '华为', system: '4G' })
  assert.equal(hit.status, 'history_match')
  assert.equal(hit.cases[0].case_id, 'real-low-access-bundle')
  assert.equal(hit.cases[0].outcome.kpi_before_after, null)
  assert.equal(hit.parameter_semantics.length > 0, true)
  assert.equal(hit.method_lessons.length, 3)
  assert.equal(hit.sources.production_workorder_connector.status, 'not_connected')
  assert.equal(hit.sources.local_memory_packages.status, 'no_eligible_historical_package')
  assert.equal(fs.existsSync(path.join(directory, 'packages')), false, 'analysis is read-only')
  const miss = search({ query: 'FooHistoryOnly' })
  assert.equal(miss.status, 'no_history_match')
  assert.equal(miss.cases.length, 0)
  assert.equal(miss.method_lessons.length, 3, 'retain existing method lessons after no match')
  const semanticsOnly = search({ query: 'Msg3 HARQ' })
  assert.ok(semanticsOnly.parameter_semantics.length > 0)
  assert.equal(semanticsOnly.status, 'no_history_match', 'parameter annotations are not measured workorders')
})

test('automatic package discovery preserves six types and separates eligible candidates, review and counter-evidence', t => {
  const { directory, search } = fixture(t)
  const records = [row('case_memory', 'validated'), row('rca_memory', 'validated'),
    row('strategy_memory', 'reusable', 'positive'), row('strategy_memory', 'restricted', 'review'),
    row('strategy_memory', 'unverified', 'unverified'), row('strategy_memory', 'deprecated', 'deprecated'),
    row('strategy_memory', 'counter_evidence', 'counter-state'), row('playbook_memory', 'validated'),
    row('risk_memory', 'validated'), row('counter_evidence_memory', 'validated')]
  const package_id = writePackage(directory, 'a', records)
  const result = search({ query: '这个小区下载慢', vendor: 'Huawei', system: '4G', limit: 12 })
  assert.equal(result.status, 'history_match')
  assert.equal(result.sources.local_memory_packages.historical_package_count, 1)
  assert.ok(Object.values(result.memories).every(group => group.memories.length > 0))
  assert.deepEqual(result.candidate_pools.positive_candidates.map(r => r.memory.memory_id).sort(), ['playbook_memory', 'positive'])
  assert.deepEqual(result.candidate_pools.review_evidence.map(r => r.memory.memory_id), ['review'])
  assert.equal(result.candidate_pools.counter_evidence.length, 2)
  assert.ok(result.candidate_pools.background.some(r => r.memory.memory_id === 'unverified'))
  assert.ok(result.candidate_pools.background.some(r => r.memory.memory_id === 'deprecated'))
  assert.equal(result.memories.rca_memory.memories[0].usage.current_root_cause_confirmed, false)
  assert.equal(result.memories.case_memory.memories[0].package_id, package_id)
  assert.equal(result.memories.case_memory.memories[0].evidence_profile.authority, 'fixture_only')
  assert.deepEqual(result.unique_matched_trace_ids, ['fixture-shared-trace'])
  assert.equal(result.method.calibrated_gate_loaded, false)
  assert.equal(search({ query: 'FooHistoryOnly', vendor: '中兴' }).status, 'no_history_match')
  const limited = search({ query: 'FooHistoryOnly', limit: 1 })
  assert.equal(limited.candidate_pools.review_evidence[0].memory.memory_id, 'review')
  assert.equal(limited.candidate_pools.counter_evidence.length, 1)
  assert.equal(limited.candidate_pool_counts.counter_evidence.total_matches, 2)
  assert.equal(limited.candidate_pool_counts.counter_evidence.truncated, true)
})

test('demo and future packages cannot become decision evidence; explicit versions and duplicated traces remain distinguishable', t => {
  const { directory, search } = fixture(t)
  const first = writePackage(directory, 'a', [row('strategy_memory', 'validated')])
  const second = writePackage(directory, 'b', [row('strategy_memory', 'validated')])
  const demo = writePackage(directory, 'c', [row('strategy_memory', 'validated')], { mode: 'demo' })
  const future = writePackage(directory, 'd', [row('strategy_memory', 'validated')], { as_of: '2026-10-20T00:00:00+08:00' })
  const result = search({ query: 'FooHistoryOnly', as_of: '2026-10-10T00:00:00+08:00' })
  assert.equal(result.candidate_pools.positive_candidates.length, 2)
  assert.deepEqual(result.unique_matched_trace_ids, ['fixture-shared-trace'])
  assert.equal(result.sources.local_memory_packages.packages.find(p => p.package_id === future).status, 'after_decision_cutoff')
  assert.equal(result.sources.local_memory_packages.packages.find(p => p.package_id === demo).status, 'demo_excluded')
  assert.equal(search({ query: 'FooHistoryOnly', package_ids: [demo] }).status, 'no_history_match')
  const displayDemo = search({ query: 'FooHistoryOnly', package_ids: [demo], include_demo: true })
  assert.equal(displayDemo.candidate_pools.positive_candidates.length, 0)
  assert.equal(displayDemo.candidate_pools.background[0].usage.effect_statistics_authority, 'demonstration_only')
  assert.equal(search({ query: 'FooHistoryOnly', package_ids: [second] }).candidate_pools.positive_candidates[0].package_id, second)
  assert.equal(search({ query: 'FooHistoryOnly', package_ids: [first], as_of: '2026-10-01T00:00:00+08:00' }).status, 'no_history_match')
  assert.throws(() => search({ query: 'FooHistoryOnly', package_ids: ['../escape'] }), /package_id/)
  assert.throws(() => search({ query: 'FooHistoryOnly', as_of: '2026-10-10' }), /as_of/)
  assert.throws(() => search({ query: 'FooHistoryOnly', as_of: '' }), /as_of/)
})

test('corrupt or missing sources produce incomplete search while valid retained evidence remains usable', t => {
  const { directory, search } = fixture(t)
  const broken = writePackage(directory, 'a', [row('strategy_memory', 'validated')])
  fs.appendFileSync(path.join(directory, 'packages', broken, 'memory_objects.jsonl'), 'tampered')
  const result = search({ query: 'QRxLevMin' })
  assert.equal(result.status, 'search_incomplete')
  assert.ok(result.cases.length > 0)
  assert.equal(result.candidate_pools.positive_candidates.length, 0)
  assert.equal(result.sources.local_memory_packages.packages[0].status, 'read_error')
  assert.equal(search({ query: 'FooHistoryOnly', package_ids: ['wp_' + 'b'.repeat(24)] }).status, 'search_incomplete')
})

test('unspecified decision time defaults to the current query time and excludes future packages', t => {
  const { directory, memory } = fixture(t)
  writePackage(directory, 'a', [row('strategy_memory', 'validated')], { as_of: new Date(Date.now() + 86400000).toISOString() })
  const result = createHistorySearch({ memory })({ query: 'FooHistoryOnly' })
  assert.ok(Math.abs(Date.parse(result.filters.as_of) - Date.now()) < 5000)
  assert.equal(result.sources.local_memory_packages.packages[0].status, 'after_decision_cutoff')
  assert.equal(result.status, 'no_history_match')
})

test('the interface shows completed historical search even on no match, with incomplete sources distinguished', t => {
  const { search } = fixture(t)
  const card = { name: 'wireless_history_search', status: 'done', resultJson: search({ query: 'FooHistoryOnly' }) }
  assert.equal(visibleTool(card), true)
  assert.equal(taskProgress(card).status, 'done')
  assert.match(taskProgress(card).summaries[0], /检索已完成.*未找到.*未接入/)
  card.resultJson = search({ query: 'QRxLevMin' })
  assert.match(taskProgress(card).summaries[0], /历史已查.*案例/)
  card.resultJson = search({ query: 'FooHistoryOnly', package_ids: ['wp_' + 'a'.repeat(24)] })
  assert.equal(taskProgress(card).status, 'warning')
})
