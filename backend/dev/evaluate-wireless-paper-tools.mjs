/** Real archived records through the real ToolRuntime; no model judgments are fabricated. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply } from '../dsh/dsh-wireless/lib/index.js'

const root = process.cwd()
const output = path.resolve(process.argv[2] || '.run/icos-real-data-20261111')
fs.mkdirSync(path.join(output, 'tool-results'), { recursive: true })
process.env.WIRELESS_DATA_DIR = path.join(output, 'runtime-data')
const cases = JSON.parse(fs.readFileSync(path.join(output, 'cases.json')))
const ctx = new Context(); new SystemPrompt(ctx, {}); new ToolRuntime(ctx); apply(ctx)
let serial = 0
const calls = []
async function call(name, args) {
  const result = await ctx.tools.execute({ name, arguments: args, callId: `real-data-${++serial}`, signal: new AbortController().signal })
  calls.push({ name, arguments: args, isError: result.isError, value: result.value })
  if (result.isError) throw new Error(name + ': ' + JSON.stringify(result))
  return result.value
}
function save(name, value) { fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n') }
const perCase = [], failures = []
try {
  let compiled
  try {
    compiled = await call('wireless_compile_history', { file_path: path.relative(root, path.join(output, 'train-history-normalized.jsonl')),
      as_of: '2026-11-11T00:00:00+08:00', mode: 'historical', evaluation_visible_at_cutoff: true })
    save('compiled-history.json', compiled)
  } catch (error) { failures.push({ stage: 'compile', error: error.message }) }
  for (const entry of cases) {
    try {
      const input = JSON.parse(fs.readFileSync(entry.input_file))
      input.evaluation_namespace = 'deterministic-real-data-baseline'
      const context = await call('wireless_icos_context', { input })
      const run_id = context.run_id
      const stages = { context }
      for (const stage of ['objective', 'root_cause', 'cases', 'candidates', 'alignment', 'parameter_risk']) {
        stages[stage] = await call('wireless_icos_' + stage, { run_id })
        assert.equal(stages[stage].status, 'completed', `${entry.case}/${stage}`)
      }
      assert.equal(stages.root_cause.result.status, 'not_called', 'dataset has no root-cause source: must not invent one')
      stages.preview = await call('wireless_icos_decision', { run_id, operation: 'preview' })
      stages.consistency = await call('wireless_icos_consistency', { run_id })
      const archived = JSON.parse(fs.readFileSync(entry.feedback_file))
      const feedback = { source_ref: archived.source_ref, actions: archived.actions.map((a, i) => {
        const plan = input.initial_plans[i]
        assert.equal(plan.parachinname, a.param_cn_name)
        return { execution_id: plan.execution_id, parameter: a.param_cn_name,
          before: a.before_value, after: a.after_value, exec_state: a.exec_state,
          short_eval_raw: a.short_eval_result, long_eval_result: a.long_eval_result,
          improvement_result: a.improvement_result, exec_failure_reason: a.exec_failure_reason,
          exec_at: a.exec_at }
      }) }
      save(`feedback/${entry.case}-tool-input.json`, feedback)
      stages.feedback = await call('wireless_icos_feedback', { run_id, archived_feedback: feedback })
      for (const row of stages.feedback.result.archived_feedback.actions) {
        if (row.exec_state !== 'exec_success') assert.equal(row.actual_after, null)
        if (String(row.short_eval_raw).includes('未启用')) assert.equal(row.short_evaluation_classification, null)
      }
      // Retain a separate no-feedback state for decision-before-outcome model tests.
      const cleanInput = { ...input, evaluation_namespace: 'single-skill-prepared-input' }
      const clean = await call('wireless_icos_context', { input: cleanInput })
      for (const stage of ['objective', 'root_cause', 'cases', 'candidates', 'alignment', 'parameter_risk']) {
        await call('wireless_icos_' + stage, { run_id: clean.run_id })
      }
      const summary = { ...entry, run_id, clean_run_id: clean.run_id,
        root_status: stages.root_cause.result.status,
        rule_shapes: Object.values(stages.parameter_risk.result).map(r => r.shape),
        rule_reasons: Object.values(stages.parameter_risk.result).map(r => r.reason),
        case_hits: stages.cases.result.hit_count, referenced_cases: stages.cases.result.refs.length,
        preview_selected: stages.preview.result.decision.chain.dispatched_after,
        consistency_status: stages.consistency.status,
        feedback_summary: Object.fromEntries(Object.entries(stages.feedback.result.archived_feedback).filter(([k]) => k !== 'actions')) }
      save(`tool-results/${entry.case}.json`, stages)
      perCase.push(summary)
      save('tool-summary.json', { perCase, failures, compiled_package_id: compiled?.package_id })
      console.log(JSON.stringify({ case: entry.case, issue: entry.issue, selected: summary.preview_selected,
        case_hits: summary.case_hits, rule_shapes: summary.rule_shapes, feedback: summary.feedback_summary }))
    } catch (error) { failures.push({ case: entry.case, error: error.message }); console.log(JSON.stringify(failures.at(-1))) }
  }
  save('tool-summary.json', { perCase, failures, compiled_package_id: compiled?.package_id })
  save('tool-calls.json', calls)
} finally { await ctx.fiber.dispose() }
console.log(JSON.stringify({ status: failures.length ? 'has_failures' : 'passed', cases: perCase.length, failures, calls: calls.length }))
