import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createOrderArchive } from '../dsh/dsh-wireless/lib/orders.js'
import { apply } from '../dsh/dsh-wireless/lib/index.js'
import { greetingReply, createQuickReplyHistory } from '../harness/quick-replies.mjs'
import { restoredConversation } from '../harness/conversation.mjs'
import { createIcosService } from '../dsh/dsh-wireless/lib/icos.js'
import { orderAnalysisInput } from '../dsh/dsh-wireless/lib/order-context.js'
import { createNetworkDataStore } from '../dsh/dsh-wireless/lib/network-data.js'

function archiveFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wireless-order-contract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const trace = (id, issued, issue, system, state) => ({ trace_id: 't_' + id,
    ticket: { id, issued_at: issued, primary_issue_type: issue, system, vendor: '华为', region: '西安', cell_name: "A%小区'", cell_id: '460-1', eci: '123' },
    actions: [{ action_id: '2050834013812651014', param_cn_name: '参数一', before_value: '6', after_value: '7',
      scheme_id: 'PLAN-1', exec_id: 'PLAN-1-1', root_cause_l1: '参数', root_cause_l2: '低接通方案组',
      exec_state: state, long_eval_result: 'long_eval_fail', improvement_result: '改善',
      short_eval_result: '评估不通过(短评估未启用,直接进入系统评估)' }],
    aggregate: { ticket_outcome: 'long_eval_fail' } })
  const traces = [trace('ORDER-OLD', '2025-06-01', '切换差小区', 'LTE', 'exec_failed'),
    trace('ORDER-1', '2026-06-01', '接通低小区', 'LTE', 'exec_failed'),
    trace('ORDER-2', '2026-06-30', 'SA无线接通率', 'NR', 'exec_success'),
    trace('ORDER-3', '2026-08-30', '切换差小区', 'LTE', 'exec_success')]
  const fixture = path.join(root, 'traces.json'), zip = path.join(root, 'orders.zip'), database = path.join(root, 'orders.sqlite')
  fs.writeFileSync(fixture, JSON.stringify(traces))
  execFileSync('python3', ['-c', 'import json,sys,zipfile; rows=json.load(open(sys.argv[1])); z=zipfile.ZipFile(sys.argv[2],"w"); z.writestr("data/staged/splits/dev_trace_records.jsonl","\\n".join(json.dumps(r,ensure_ascii=False) for r in rows)); z.close()', fixture, zip])
  execFileSync('python3', [new URL('./import-wireless-orders.py', import.meta.url).pathname, zip, database])
  const query = createOrderArchive({ database })
  t.after(() => query.close())
  return { root, database, zip, query }
}

test('archive import keeps distinct tickets and resolves month scope independently of memory packages', t => {
  const { query, zip, database } = archiveFixture(t)
  assert.equal(query({ operation: 'catalog' }).total_tickets, 4)
  const june = query({ month: '6月', limit: 1 })
  assert.equal(june.total, 2)
  assert.equal(june.filters.month, '2026-06')
  assert.equal(june.tickets[0].ticket_id, 'ORDER-2')
  assert.equal(june.has_more, true)
  assert.deepEqual(june.matched_date_range, { from: '2026-06-01', to: '2026-06-30' })
  assert.equal(june.outcome_counts.reduce((n, r) => n + r.count, 0), june.total)
  assert.equal(query({ month: '2025-06' }).total, 1)
  assert.equal(query({ month: '6', offset: 1 }).tickets[0].ticket_id, 'ORDER-1')
  assert.equal(query({ date_from: '2026-06-30', date_to: '2026-06-30', system: '5G' }).total, 1)
  assert.equal(query({ date_from: '2026-11-01' }).total, 0)
  const reused = JSON.parse(execFileSync('python3', [new URL('./import-wireless-orders.py', import.meta.url).pathname, zip, database]))
  assert.equal(reused.reused, true)
})

test('business ticket detail preserves identifiers, failure targets and conflicting evaluations', t => {
  const { query } = archiveFixture(t)
  const record = query({ operation: 'read', ticket_id: 'ORDER-1' })
  assert.equal(record.status, 'found')
  assert.equal(record.actions[0].action_id, '2050834013812651014')
  assert.equal(record.actions[0].recorded_target, '7')
  assert.equal(record.actions[0].actual_after, null)
  assert.equal(record.actions[0].long_eval_result, 'long_eval_fail')
  assert.equal(record.actions[0].improvement_result, '改善')
  assert.match(record.actions[0].short_eval_result, /未启用/)
  assert.equal(record.actions[0].short_evaluation_status, 'not_enabled')
  assert.match(record.actions[0].short_evaluation_interpretation, /不算一次实际评估失败/)
  assert.equal(query({ operation: 'read', ticket_id: 't_ORDER-2' }).actions[0].actual_after, '7')
  assert.equal(query({ operation: 'read', ticket_id: 'unknown' }).status, 'not_found')
  assert.equal(query({ query: '%' }).total, 4)
  assert.equal(query({ query: "' OR 1=1 --" }).total, 0)
  assert.throws(() => query({ month: '13' }), /month/)
  assert.throws(() => query({ date_from: '2026-02-30' }), /日期/)
  assert.throws(() => query({ limit: 100000 }), /分页/)
})

test('historical tickets exclude later snapshots; explicit latest/date and restored sessions keep their own period', async t => {
  const { root, database } = archiveFixture(t)
  const network = createNetworkDataStore({ database: path.join(root, 'network.sqlite'), writable: true })
  const query = createOrderArchive({ database, network })
  t.after(() => query.close())
  const snapshot = day => ({ ticket_id: 'ORDER-2', snapshot_date: day, source_ref: `network://${day}/ORDER-2`,
    order_patch: { conclusion: `${day}上行拥塞` }, parameters: {},
    observations: [{ object_id: '460-1', kind: 'kpi', metric: '上行PRB利用率', value: 92, unit: '%',
      definition: 'used/total', source_ref: `network://${day}/ORDER-2`, data_origin: 'constructed',
      time_window: { start: day + 'T18:00:00+08:00', end: day + 'T18:15:00+08:00' } }],
    rules: [{ parachinname: '参数一', para: '>0', rule_scope: '+1' }] })
  network.write(snapshot('2026-11-01'))
  const historical = query({ operation: 'read', ticket_id: 'ORDER-2' })
  assert.equal(historical.available_analysis, undefined)
  assert.ok(historical.missing_fields.includes('KPI/MR time series'))
  assert.equal(historical.analysis_selection.selected_date, '2026-06-30')
  assert.equal(query.analysisData('ORDER-2'), null)
  assert.equal(query.networkQuery({ ticket_id: 'ORDER-2' }).status, 'not_found')
  assert.deepEqual(historical.analysis_selection.available_dates, ['2026-11-01'])
  const latest = query.networkQuery({ ticket_id: 'ORDER-2', analysis_scope: 'latest' })
  assert.equal(latest.snapshot_date, '2026-11-01')
  assert.equal(latest.analysis_selection.cross_period, true)
  assert.throws(() => query.analysisData('ORDER-2', '2026-02-30'), /日期/)
  assert.throws(() => query.analysisData('ORDER-2', '2026-11-01', 'latest'), /不能同时/)
  const service = createIcosService({ directory: root, orders: query })
  const original = await service('context', { ticket_id: 'ORDER-2' })
  assert.equal(original.analysis_basis, undefined)
  const explicit = await service('context', { ticket_id: 'ORDER-2', analysis_scope: 'latest' })
  assert.notEqual(original.run_id, explicit.run_id)
  assert.equal(explicit.analysis_basis.snapshot_date, '2026-11-01')
  const restored = await service('context', { operation: 'read', run_id: explicit.run_id, view: 'summary' })
  assert.equal(restored.analysis_selection.scope, 'latest')
  assert.equal(restored.analysis_basis.snapshot_date, '2026-11-01')
  const transcribed = await service('context', { input: { source_ref: 'network://2026-11-01/ORDER-2',
    order: { taskno: 'ORDER-2', createtime: '2026-11-01' }, conclusion: 'misplaced transcription' } })
  assert.equal(transcribed.input_resolution, 'canonical_stored_snapshot')
  assert.equal(transcribed.analysis_basis.archive_issued_at, '2026-06-30')
  assert.equal(transcribed.analysis_basis.snapshot_date, '2026-11-01')
  const canonical = await service('context', { operation: 'read', run_id: transcribed.run_id, view: 'full' })
  assert.equal(canonical.input.order.conclusion, '2026-11-01上行拥塞')
  assert.equal(canonical.input.observations.length, 1)
  assert.equal(canonical.input.rules.length, 1)

  // Migrate the old unscoped analysis without retaining its future diagnosis or downstream stages.
  const legacyInput = orderAnalysisInput(historical, { networkData: snapshot('2026-11-01') })
  delete legacyInput.archive_context.analysis_selection
  const legacy = await service('context', { input: legacyInput })
  const migrated = await service('context', { operation: 'read', run_id: legacy.run_id, view: 'full' })
  assert.equal(migrated.refreshed_from_network_data, true)
  const clean = await service('context', { operation: 'read', run_id: legacy.run_id, view: 'full' })
  assert.equal(clean.input.network_context, undefined)
  assert.equal(clean.input.order.conclusion, undefined)
  assert.equal(clean.analysis_selection.selected_date, '2026-06-30')
  assert.deepEqual(Object.keys(clean.stages), ['context'])

  network.write(snapshot('2026-06-30'))
  assert.equal(query.networkQuery({ ticket_id: 'ORDER-2' }).snapshot_date, '2026-06-30')
  const refreshed = await service('context', { operation: 'read', run_id: original.run_id })
  assert.equal(refreshed.analysis_basis.snapshot_date, '2026-06-30')
  assert.equal(query.networkQuery({ ticket_id: 'ORDER-2', snapshot_date: '2026-11-01' }).snapshot_date, '2026-11-01')
  assert.equal(query.networkQuery({ ticket_id: 'ORDER-2', operation: 'series', metric: '上行PRB利用率' }).observations[0].time_window.start.slice(0, 10), '2026-06-30')
})

test('SDK exposes business workorder lookup without creating a ledger or requiring an internal id', async t => {
  const { database } = archiveFixture(t)
  const old = process.env.WIRELESS_ARCHIVE_DB
  process.env.WIRELESS_ARCHIVE_DB = database
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); if (old === undefined) delete process.env.WIRELESS_ARCHIVE_DB; else process.env.WIRELESS_ARCHIVE_DB = old })
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx); apply(ctx)
  const result = await ctx.tools.execute({ name: 'wireless_order_query', arguments: { operation: 'read', ticket_id: 'ORDER-1' },
    callId: 'read-order', signal: new AbortController().signal })
  assert.equal(result.isError, false)
  assert.equal(result.value.ticket.id, 'ORDER-1')
  assert.equal(result.value.action_summary.execution_states.exec_failed, 1)
})

test('a business ticket creates the original analysis context without deriving diagnoses or leaking its outcome', async t => {
  const { root, query } = archiveFixture(t)
  const run = createIcosService({ directory: path.join(root, 'analysis'), orders: query })
  const context = await run('context', { ticket_id: 'ORDER-1' })
  assert.equal(context.status, 'completed')
  assert.equal(context.result.order.taskno, 'ORDER-1')
  assert.equal(context.result.order.nettype, '4g')
  assert.equal(context.result.order.conclusion, undefined)
  assert.equal(context.result.initial_plans[0].execution_id, '2050834013812651014')
  assert.equal(context.result.initial_plans[0].type2, '低接通方案组')
  assert.equal(context.result.initial_plans[0].b_para, '7')
  assert.equal((await run('root_cause', { run_id: context.run_id })).result.status, 'not_called')
  const stored = await run('context', { run_id: context.run_id, operation: 'read' })
  for (const key of ['long_eval_result', 'exec_state', 'actual_after', 'short_eval_result', 'improvement_result']) {
    assert.equal(stored.input.initial_plans[0][key], undefined)
  }
  await run('cases', { run_id: context.run_id })
  assert.equal((await run('candidates', { run_id: context.run_id })).status, 'completed')
  assert.equal((await run('context', { ticket_id: 'missing' })).status, 'not_found')
  await assert.rejects(run('context', { ticket_id: 'ORDER-1', input: {} }), /三选一/)
})

test('archive case snapshots exclude the target and future tickets and count only whole successful evaluated bundles', t => {
  const { query } = archiveFixture(t)
  const current = query({ operation: 'read', ticket_id: 'ORDER-3' })
  const previous = query.caseRecords(current.ticket)
  assert.deepEqual(previous.map(record => record.ticket.id), ['ORDER-OLD'])
  const failed = orderAnalysisInput(current, { caseRecords: previous })
  assert.equal(failed.cases.length, 0)
  const success = structuredClone(previous[0])
  success.actions[0].exec_state = 'exec_success'
  success.actions[0].long_eval_result = 'long_eval_pass'
  success.actions[0].actual_after = '7'
  const usable = orderAnalysisInput(current, { caseRecords: [success, current] })
  assert.equal(usable.cases.length, 1)
  assert.equal(usable.cases[0].estimate_result, '改善')
  assert.equal(usable.cases[0].outcome_scope, 'archived_successfully_executed_bundle')
  assert.equal(usable.cases[0].actions[0].after, '7')
  success.actions.push({ ...success.actions[0], exec_state: 'exec_failed' })
  assert.equal(orderAnalysisInput(current, { caseRecords: [success] }).cases.length, 0)
})

test('instant greeting is narrow, durable and does not intercept a workorder request', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wireless-greeting-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const answer = greetingReply('你好')
  assert.match(answer, /无忧侠/)
  assert.equal(greetingReply('你好，查一下6月工单'), null)
  assert.equal(greetingReply('你好', true), null)
  const first = createQuickReplyHistory(root)
  first.append('session/../../id', '你好', answer)
  const reopened = createQuickReplyHistory(root)
  assert.equal(reopened.read('session/../../id').length, 2)
  assert.match(reopened.context('session/../../id'), /用户：你好/)
  const later = { time: Date.now() + 100, kind: 'user', text: '6月的工单' }
  assert.equal(reopened.merge('session/../../id', [later]).at(-1).text, later.text)
  assert.equal(reopened.read('another-session').length, 0)
})

test('restart context restores the previous business ticket without stale skill catalog reminders', () => {
  const context = restoredConversation([
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '查工单 ORDER-1\n<system-reminder>旧能力清单</system-reminder>' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已经取得工单 ORDER-1。' }] } } },
  ])
  assert.match(context, /ORDER-1/)
  assert.ok(!context.includes('旧能力清单'))
  assert.equal(restoredConversation([]), '')
})

test('restart preserves the user ticket and successful run reference rather than ids in assistant prose or failed calls', () => {
  const good='icos_'+'a'.repeat(24),bad='icos_'+'b'.repeat(24)
  const restored=restoredConversation([
    {type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'分析工单 SNXIA512260630163682851377932320'}]}},
    {type:'assistant/message',data:{message:{content:[{type:'text',text:'参考案例 SNOTHER12345678。'}]}}},
    {type:'tool/call',data:{callId:'valid',name:'wireless_icos_root_cause',arguments:JSON.stringify({run_id:good})}},
    {type:'tool/result',data:{message:{content:[{type:'tool-result',toolCallId:'valid',content:[]}]}}},
    {type:'tool/call',data:{callId:'bad',name:'wireless_icos_decision',arguments:JSON.stringify({run_id:bad})}},
    {type:'tool/result',data:{message:{content:[{type:'tool-result',toolCallId:'bad',isError:true,content:[]}]}}},
  ])
  assert.match(restored,/用户最近明确的业务工单号：SNXIA512260630163682851377932320/)
  assert.ok(restored.includes(good));assert.ok(!restored.includes(bad))
})
