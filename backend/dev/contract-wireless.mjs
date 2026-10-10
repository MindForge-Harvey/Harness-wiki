import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { apply } from '../dsh/dsh-wireless/lib/index.js'
import { catalogStatus, knowledgeQuery, caseSearch, parameterCheck } from '../dsh/dsh-wireless/lib/catalog.js'

test('snapshot assets are integrity checked and carry pinned source provenance', () => {
  const directory = new URL('../dsh/dsh-wireless/resources/', import.meta.url)
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', directory)))
  assert.match(manifest.commit, /^[0-9a-f]{40}$/)
  for (const [name, entry] of Object.entries(manifest.resources)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(name, directory))).digest('hex'), entry.sha256)
  }
  assert.equal(catalogStatus().counts.parameter_signatures, 279)
  assert.equal(catalogStatus().counts.case_entries, 4)
  for (const row of caseSearch().cases) {
    for (const reference of row.references) {
      assert.ok(reference.url.includes(manifest.commit))
      assert.ok(manifest.sources[reference.source_path])
    }
  }
})

test('semantic retrieval finds aliases, preserves policies and does not invent unknown parameters', () => {
  const result = knowledgeQuery({ query: 'QRxLevMin 是什么意思？', vendor: 'Huawei', system: '4G' })
  assert.ok(result.results.parameters.length > 0)
  assert.ok(result.results.parameters.every(row => row.vendor === '华为' && row.system === 'LTE'))
  assert.ok(result.results.parameters.every(row => row.needs_human_review === true && row.signature_policy))
  assert.ok(result.results.parameters.some(row => row.numeric_direction === 'increase'))
  const resources = JSON.parse(fs.readFileSync(new URL('../dsh/dsh-wireless/resources/signature-policy.json', import.meta.url)))
  const blocked = resources.find(row => row.hard_aggregation_policy === 'blocked')
  const blockedResult = knowledgeQuery({ query: blocked.canonical_action_id, limit: 12 })
  assert.ok(blockedResult.results.parameters.some(row => row.signature_policy.hard_aggregation_policy === 'blocked'))
  const timer = knowledgeQuery({ query: '资源类切换准备失败惩罚定时器', kind: 'parameters' })
  assert.ok(timer.results.parameters.length > 0)
  assert.ok(timer.results.parameters.every(row => row.parameter_name === '资源类切换准备失败惩罚定时器'))
  const times = knowledgeQuery({ query: '非资源类切换准备失败惩罚次数', kind: 'parameters' })
  assert.ok(times.results.parameters.every(row => row.parameter_name === '非资源类切换准备失败惩罚次数'))
  const unknown = knowledgeQuery({ query: 'FooBeamQuantumXYZ 参数的取值？' })
  assert.equal(unknown.results.total_parameter_matches, 0)
  assert.equal(unknown.results.total_lesson_matches, 0)
  assert.throws(() => knowledgeQuery({ query: 'QRxLevMin', limit: 100 }), /limit/)
  assert.equal(knowledgeQuery({ query: '经验性的结论', kind: 'lessons' }).results.lessons.length, 3)
})

test('case search separates bundle outcomes, synthetic demonstrations and unexecuted recommendations', () => {
  const found = caseSearch({ query: '低接通的历史案例', vendor: '华为', system: 'LTE' })
  assert.equal(found.cases.length, 1)
  const bundle = found.cases[0]
  assert.equal(bundle.context_comparison.vendor.status, 'unknown_requires_confirmation')
  assert.equal(bundle.outcome.scope, 'ticket_bundle')
  assert.equal(bundle.outcome.kpi_before_after, null)
  assert.deepEqual(bundle.actions.map(row => [row.parameter, row.before, row.after]),
    [['QRxLevMin', -64, -62], ['SNonIntraSearch', 25, 27]])
  const veto = caseSearch({ query: 'LDH003' }).cases[0]
  assert.equal(veto.actions[0].role, 'recommended_not_execution_record')
  assert.notEqual(veto.actions[0].parameter_cn, veto.actions[1].parameter_cn)
  assert.equal(veto.actions[0].after, undefined)
  assert.equal(veto.outcome.scope, 'research_gate_decision')
  const demo = caseSearch({ query: 'HoCfgSwitch' }).cases[0]
  assert.equal(demo.evidence_type, 'onboarding_demo')
  assert.equal(demo.outcome.scope, 'demo_ticket')
  assert.equal(caseSearch({ query: '不存在的FooBeamQuantumXYZ' }).cases.length, 0)
})

test('parameter reads include historical applications without narrowing bundle outcomes or inventing manufacturer identity', () => {
  for (const query of ['QRxLevMin 增大有什么作用？', '最低接入电平']) {
    const result = knowledgeQuery({ query, kind: 'parameters', vendor: '华为', system: 'LTE' })
    assert.ok(result.results.parameters.length > 0)
    const application = result.results.case_applications[0]
    assert.equal(application.case_id, 'real-low-access-bundle')
    assert.deepEqual(application.matched_actions.map(a => [a.parameter, a.before, a.after]), [['QRxLevMin', -64, -62]])
    assert.equal(application.actions.length, 2)
    assert.equal(application.context.vendor, null)
    assert.equal(application.context_comparison.vendor.status, 'unknown_requires_confirmation')
    assert.equal(application.outcome.scope, 'ticket_bundle')
    assert.equal(application.outcome.kpi_before_after, null)
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  }
  assert.equal(knowledgeQuery({ query: 'SNonIntraSearch', kind: 'parameters' }).results.case_applications[0].matched_actions[0].parameter, 'SNonIntraSearch')
  assert.equal(knowledgeQuery({ query: '资源类切换准备失败惩罚定时器', kind: 'parameters' }).results.case_applications[0].matched_actions[0].role, 'recommended_not_execution_record')
  assert.equal(knowledgeQuery({ query: 'FooBeamQuantumXYZ', kind: 'parameters' }).results.case_applications.length, 0)
})

test('parameter adaptation checks declared range, lattice base and enums without imputing missing values', () => {
  const base = { parameter: 'CELLSEL.QRxLevMin', current: -64, target: -62, min: -156, max: -44,
    step: 2, unit: '源编码', constraint_source: '用户声明' }
  const passed = parameterCheck(base)
  assert.equal(passed.status, 'constraints_pass')
  assert.equal(passed.delta, 2)
  assert.equal(passed.rollback_reference.value, -64)
  assert.equal(parameterCheck({ ...base, target: -43 }).status, 'blocked')
  assert.equal(parameterCheck({ ...base, target: -61 }).status, 'blocked')
  assert.equal(parameterCheck({ ...base, step: 0 }).status, 'blocked')
  assert.equal(parameterCheck({ ...base, min: -40 }).status, 'blocked')
  assert.equal(parameterCheck({ ...base, current: 'not-a-number' }).status, 'blocked')
  assert.equal(parameterCheck({ ...base, min: 0.1, max: 1, step: 0.2, current: 0.1, target: 0.3 }).status, 'constraints_pass')
  const incomplete = parameterCheck({ parameter: 'QRxLevMin', target: -62 })
  assert.equal(incomplete.status, 'needs_data')
  assert.equal(incomplete.current, null)
  assert.ok(incomplete.missing_fields.includes('current') && incomplete.missing_fields.includes('min'))
  const noStep = parameterCheck({ ...base, step: undefined })
  assert.equal(noStep.status, 'constraints_pass')
  assert.equal(noStep.checks.some(row => row.name === 'target_step'), false)
  const enumeration = { parameter: 'HoCfgSwitch', current: '关', target: '开', enum_values: ['开', '关'],
    unit: '枚举', constraint_source: '用户声明' }
  assert.equal(parameterCheck(enumeration).status, 'constraints_pass')
  assert.equal(parameterCheck({ ...enumeration, target: 'maybe' }).status, 'blocked')
  assert.equal(parameterCheck({ ...enumeration, min: 0 }).status, 'blocked')
})

test('real SDK tool runtime registers and executes all wireless contracts and renders citations', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  apply(ctx)
  const execution = { signal: new AbortController().signal }
  const lookup = ctx.tools.get('wireless_knowledge_query')
  const result = await lookup.execute({ query: 'QRxLevMin', kind: 'parameters', limit: 2 }, execution)
  assert.equal(result.results.parameters.length, 2)
  const text = lookup.output.render({}, result)[0].text
  assert.ok(text.includes('https://github.com/') && text.includes(result.snapshot.commit))
  const historical = await ctx.tools.get('wireless_case_search').execute({ query: 'LDJT028' }, execution)
  assert.equal(historical.cases[0].actions[0].after, -62)
  const history = ctx.tools.get('wireless_history_search')
  const searched = await history.execute({ query: 'QRxLevMin', vendor: '华为' }, execution)
  const decision = ctx.tools.get('wireless_echo_decision')
  const noCandidates = await decision.execute({ operation: 'rank_candidates' }, execution)
  assert.equal(noCandidates.status, 'no_candidates')
  assert.ok(decision.output.render({}, noCandidates)[0].text.includes('no_candidates'))
  assert.ok(searched.cases.some(row => row.case_id === 'real-low-access-bundle'))
  assert.equal(searched.sources.production_workorder_connector.status, 'not_connected')
  assert.deepEqual(JSON.parse(history.output.render({}, searched)[0].text), searched)
  assert.equal((await ctx.tools.get('wireless_parameter_check').execute({ parameter: 'QRxLevMin' }, execution)).status, 'needs_data')
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(() => lookup.execute({ query: 'QRxLevMin' }, { signal: aborted.signal }), /abort/i)
})
