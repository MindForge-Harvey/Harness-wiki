import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import test from 'node:test'
import { createMemoryService } from '../dsh/dsh-wireless/lib/compiler.js'
import { createDecisionService } from '../dsh/dsh-wireless/lib/decision.js'
import { echoQuery, echoStatus } from '../dsh/dsh-wireless/lib/echo.js'
import { taskProgress } from '../../frontend/src/lib/task-progress.mjs'

const cutoff = '2026-10-10T00:00:00+08:00'
const context = { issue_type: '低速率', vendor: '华为', system: 'LTE' }
const current_snapshot = { parameter: 'Sim.A', current_value: 200, min: 100, max: 300,
  unit: '模拟编码', source_ref: '模拟当前快照', constraint_source: '模拟厂家范围' }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-consumer-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let clock = Date.parse(cutoff)
  const memory = createMemoryService({ directory })
  const decision = createDecisionService({ memory, now: () => clock })
  function pack(char, rows, options = {}) {
    const package_id = 'wp_' + char.repeat(24), root = path.join(directory, 'packages', package_id)
    fs.mkdirSync(root, { recursive: true })
    const values = {}
    for (const [name, records] of Object.entries({ 'memory_objects.jsonl': rows,
      'memory_scores.jsonl': [], 'memory_evidence_profiles.jsonl': [] })) {
      const bytes = records.map(row => JSON.stringify(row)).join('\n') + '\n'
      fs.writeFileSync(path.join(root, name), bytes)
      values[name] = crypto.createHash('sha256').update(bytes).digest('hex')
    }
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
      checksum: { values }, source: { dataset: 'synthetic_contract_fixture' },
      harness: { mode: 'historical', as_of: '2026-10-08T00:00:00+08:00', ...options } }))
    return rows.map(row => ({ package_id, memory_id: row.memory_id }))
  }
  return { decision, pack, advance: duration => { clock += duration } }
}
function strategy(id, passed = 100, failed = 20, state = 'validated') {
  return { memory_id: id, memory_type: 'strategy_memory', state, trace_ids: ['synthetic-shared-trace'],
    title: '模拟下载慢策略', applicability: { issue_types: ['低速率'], vendors: ['华为'], systems: ['LTE'] },
    metrics: { support_count: passed + failed, long_eval_pass_count: passed, long_eval_fail_count: failed },
    content: { parameter_semantic_id: 'Sim.A', scheme_group: '模拟调度',
      value_pattern: { direction: 'increase', shape_distribution: [{ shape_id: 'fixture-shape',
        support_count: passed + failed, long_eval_pass_count: passed, long_eval_fail_count: failed,
        example: { direction: 'increase', delta_ratio: 0.1, before_position_bucket: 'p40_60' } }] } } }
}

test('source ranker actually compares LCB and sample size; selection can only materialize frozen candidates', async t => {
  const { decision, pack, advance } = fixture(t)
  const refs = pack('a', [strategy('one', 1, 0), strategy('mature')])
  const direct = await decision({ operation: 'select_candidate', candidate_refs: refs, context,
    selected_candidate_id: `${refs[1].package_id}:${refs[1].memory_id}` })
  assert.equal(direct.selected_candidate.memory.memory_id, 'mature', 'fixed candidate selection can run independently of ranking')
  const result = await decision({ operation: 'rank_candidates', candidate_refs: refs, context })
  assert.equal(result.status, 'ranked_candidates')
  assert.ok(result.source.url.includes(echoStatus().source_commit))
  assert.equal(result.candidates[0].memory.memory_id, 'mature', '1/1 does not beat 100/120 merely through raw pass rate')
  assert.equal(result.candidates[0].score_breakdown.credibility_mode, 'echo_lcb')
  assert.deepEqual(Object.keys(result.candidates[0].score_breakdown.weighted).sort(), ['boundary_match', 'credibility', 'risk_penalty', 'route_match'])
  assert.equal(result.calibrated_gate_loaded, false)
  assert.equal(result.automatic_accept_certificate, false)
  const select = { operation: 'select_candidate', candidate_set_id: result.candidate_set_id,
    selected_candidate_id: result.candidates[0].candidate_id }
  const chosen = await decision(select)
  assert.deepEqual(chosen.action_pattern, strategy('mature').content)
  assert.equal(chosen.selected_candidate.memory.metrics.long_eval_pass_count, 100)
  assert.equal(chosen.execution_permission, 'not_granted')
  await assert.rejects(decision({ ...select, selected_candidate_id: 'invented-new-action' }), /只能选择/)
  advance(3600001)
  await assert.rejects(decision(select), /过期/)
})

test('candidate admission preserves source state, time and manufacturer boundaries', async t => {
  const { decision, pack } = fixture(t)
  assert.equal((await decision({ operation: 'rank_candidates' })).status, 'no_candidates')
  for (const [char, state] of [['b', 'restricted'], ['c', 'counter_evidence'], ['d', 'unverified']]) {
    const refs = pack(char, [strategy(state, 10, 5, state)])
    await assert.rejects(decision({ operation: 'rank_candidates', candidate_refs: refs, context }), /正向候选/)
  }
  const demo = pack('e', [strategy('demo')], { mode: 'demo' })
  await assert.rejects(decision({ operation: 'rank_candidates', candidate_refs: demo }), /演示包/)
  const future = pack('f', [strategy('future')], { as_of: '2026-10-11T00:00:00+08:00' })
  await assert.rejects(decision({ operation: 'rank_candidates', candidate_refs: future }), /截止时间/)
  const refs = pack('a', [strategy('known')])
  await assert.rejects(decision({ operation: 'rank_candidates', candidate_refs: refs, context: { vendor: '中兴' } }), /不兼容/)
  await assert.rejects(decision({ operation: 'rank_candidates', candidate_refs: refs, as_of: '' }), /as_of/)
})

test('source value selector rebases historical shape to observed current state and then checks declared constraints', async t => {
  const { decision, pack } = fixture(t)
  const [candidate_ref] = pack('a', [strategy('value')])
  const result = await decision({ operation: 'adapt_value', candidate_ref, current_snapshot, context })
  assert.equal(result.status, 'adapted_value_candidate')
  assert.equal(result.target, 220)
  assert.equal(result.selection.current_value_source, 'observed_snapshot')
  assert.equal(result.selection.selection_policy, 'child_outcome_bayesian_lcb_v1')
  assert.equal(result.constraint_check.status, 'constraints_pass')
  assert.equal(result.automatic_accept_certificate, false)
  const independent = await decision({ operation: 'adapt_value', candidate_ref,
    current_snapshot: { ...current_snapshot, current_value: 150 } })
  assert.equal(independent.target, 170, 'adaptation does not require previous root analysis, ranking or selection')
  const blocked = await decision({ operation: 'adapt_value', candidate_ref,
    current_snapshot: { ...current_snapshot, step: 3, step_base: 100 } })
  assert.equal(blocked.status, 'blocked')
})

test('missing current state and zero effective child outcomes never materialize a numeric target', async t => {
  const { decision, pack } = fixture(t)
  const [candidate_ref, zero] = pack('a', [strategy('known'), strategy('zero', 0, 0)])
  const missing = await decision({ operation: 'adapt_value', candidate_ref })
  assert.equal(missing.status, 'needs_data')
  assert.ok(missing.missing_fields.includes('current_value'))
  const unsupported = await decision({ operation: 'adapt_value', candidate_ref: zero, current_snapshot })
  assert.equal(unsupported.status, 'needs_data')
  assert.equal(unsupported.target, null)
  await assert.rejects(decision({ operation: 'adapt_value', candidate_ref,
    current_snapshot: { ...current_snapshot, parameter: 'Other.Parameter' } }), /身份/)
})

test('upstream skills remain separately frozen and source consumers have truthful UI outcomes', () => {
  assert.equal(echoStatus().source_files, 158)
  assert.equal(echoStatus().upstream_skill_files, 10)
  for (const source_path of ['wireless-root-cause-analysis/SKILL.md', 'wireless-solution-decision/SHADOW.md']) {
    const result = echoQuery({ source_path, view: 'implementation' })
    assert.equal(result.passages[0].reference.source_path, source_path)
    assert.ok(result.passages[0].reference.url.includes(echoStatus().source_commit))
    assert.equal(result.passages[0].reference.sha256.length, 64)
  }
  const card = { name: 'wireless_echo_decision', status: 'done', resultJson: { status: 'ranked_candidates', candidates: [{}, {}] } }
  assert.equal(taskProgress(card).status, 'done')
  card.resultJson = { status: 'needs_data' }
  assert.equal(taskProgress(card).status, 'needs_data')
})
