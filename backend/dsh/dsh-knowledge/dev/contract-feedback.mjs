/** 反馈账本与诊断提案契约测试。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRunner, ok, eq } from './harness.mjs'

const { check, finish } = makeRunner('contract-feedback')
const { createFeedbackLedger } = await import('../lib/feedback.js')
const { createDiagnosisLedger } = await import('../lib/diagnosis.js')
const { createCurator } = await import('../lib/curator.js')
const { createFakeEngine } = await import('../lib/fake-engine.js')
const { validateDiagnosisCases } = await import('../lib/diagnosis-submit.js')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kb-feedback-'))

await check('反馈校验与筛选', async () => {
  const dir = tmp(); const f = createFeedbackLedger({ dir })
  let failed = false
  try { f.record({ rating: 'bad', query: 'q' }) } catch (e) { failed = e.status === 400 }
  ok(failed, 'invalid rating must fail')
  failed = false
  try { f.record({ rating: 'negative', query: 'q' }) } catch (e) { failed = e.status === 400 }
  ok(failed, 'negative feedback needs type or note')
  const row = f.record({ rating: 'negative', issue_type: 'missing_content', query: 'q', note: '缺少流程' })
  const duplicate = f.record({ rating: 'negative', issue_type: 'missing_content', query_id: 'q-1', query: 'q', note: '缺少流程' })
  const duplicateAgain = f.record({ rating: 'negative', issue_type: 'missing_content', query_id: 'q-1', query: 'q', note: '缺少流程' })
  ok(duplicateAgain.duplicate === true, 'same query feedback should deduplicate')
  eq(f.list({ issue_type: 'missing_content' }).length, 2)
  eq(f.get(row.feedback_id).query, 'q')
})

await check('诊断限制与重启恢复', async () => {
  const dir = tmp(); const f = createFeedbackLedger({ dir })
  for (let i = 0; i < 60; i++) f.record({ rating: 'negative', issue_type: i % 2 ? 'wrong_entity' : 'missing_content', query: 'q' + i, note: 'n' })
  const d = createDiagnosisLedger({ dir, feedback: f })
  const row = d.create()
  eq(row.feedback_count, 50)
  ok(row.candidate_count <= 10, 'candidate cap')
  ok(row.recommended_count <= 3, 'recommendation cap')
  const d2 = createDiagnosisLedger({ dir, feedback: f })
  eq(d2.list().length, 1)
})

await check('提案状态机：执行失败落盘错误并允许重新审批', async () => {
  const dir = tmp(); const f = createFeedbackLedger({ dir })
  f.record({ rating: 'negative', issue_type: 'missing_content', query: '差旅报销流程', note: '缺少流程' })
  const d = createDiagnosisLedger({ dir, feedback: f })
  const row = d.create()
  const p = row.proposals[0]
  eq(p.status, 'awaiting_approval', 'fresh proposal awaits approval')

  // 执行失败：错误与回填 payload 一并落盘，前端据此展示失败原因
  const failedRow = d.setProposalStatus(p.proposal_id, 'failed', { error: 'LightRAG 409: Pipeline is busy', payload: { title: '差旅报销', text: '流程正文' } })
  eq(failedRow.status, 'failed')
  eq(failedRow.error, 'LightRAG 409: Pipeline is busy')
  eq(failedRow.payload.title, '差旅报销')

  // failed 可重新审批（参数补齐后重试，提案不卡死）
  const retried = d.setProposalStatus(p.proposal_id, 'executing', { intent_id: 'in-1' })
  eq(retried.status, 'executing')
  eq(retried.intent_id, 'in-1')
  eq(d.proposal(p.proposal_id).proposal.status, 'executing', 'latest status wins on reread')

  // 未知提案返回 null，approve 分支据此回 404
  eq(d.proposal('dp-nope'), null)
})

// ---- 模型语义诊断（kb_diagnosis_submit 链路） ----

/** 组装一条带查询记录与检索快照的标准诊断前置数据。 */
function setupDiagnosisEnv() {
  const dir = tmp()
  const f = createFeedbackLedger({ dir })
  const curator = createCurator({ dir, registry: null })
  const engine = createFakeEngine()
  const fb = f.record({ rating: 'negative', issue_type: 'missing_content', query_id: 'q-1', query: '采购审批需要哪些条件？', note: '没有回答审批条件' })
  curator.logQuery({
    query_id: 'q-1', query: '采购审批需要哪些条件？', answer: '采购流程如下…', mode: 'mix',
    references: [{ file: '采购管理办法.docx', score: 0.9 }],
    retrieval_snapshot: {
      chunks: [{ reference_id: 'c-1', file_path: '采购管理办法.docx', content: '第四章 采购流程' }],
      entities: [{ entity_id: 'e-1', entity_name: '采购管理', description: '制度', source_id: null, file_path: null }],
      relationships: [], references: [{ file_path: '采购管理办法.docx', reference_id: 'c-1', score: 0.9 }],
    },
  })
  return { dir, f, curator, engine, fb }
}

await check('模型诊断：合法可执行案例通过校验并落为待审批提案', async () => {
  const env = setupDiagnosisEnv()
  const result = await validateDiagnosisCases({
    cases: [{
      case_id: 'case-001',
      feedback_ids: [env.fb.feedback_id],
      issue_type: 'missing_content',
      cause_layer: 'knowledge',
      root_cause: '现有文档只描述采购流程，未覆盖审批条件',
      action: 'add_text',
      payload: { title: '采购审批条件补充', text: '（待用户确认）审批条件如下…', topic: '供应链管理' },
      confidence: 0.86,
      impact: 'medium',
      evidence: [{ type: 'chunk', reference_id: 'c-1', reason: '内容只描述流程' }],
      missing_information: ['需要确认制度版本'],
      recommend: true,
    }],
    feedback: env.f, curator: env.curator, engine: env.engine,
  })
  ok(result.ok, 'batch validates')
  ok(result.cases[0].validation.ok, 'case passes: ' + JSON.stringify(result.cases[0].validation.errors))
  eq(result.cases[0].evidence.filter((e) => e.type === 'feedback').length, 1, 'feedback evidence auto-enriched')
  eq(result.cases[0].evidence.filter((e) => e.type === 'query')[0].query_id, 'q-1', 'query evidence carries query_id')

  const d = createDiagnosisLedger({ dir: env.dir, feedback: env.f })
  const row = d.submitCases({ cases: result.cases })
  eq(row.mode, 'agent')
  eq(row.proposals[0].status, 'awaiting_approval')
  eq(row.proposals[0].cause_layer, 'knowledge')
  eq(row.proposals[0].root_cause, '现有文档只描述采购流程，未覆盖审批条件')
  eq(row.proposals[0].recommend, true)
  eq(row.recommended_count, 1)
  // 重启后可读
  const d2 = createDiagnosisLedger({ dir: env.dir, feedback: env.f })
  eq(d2.list().length, 1)
  eq(d2.list()[0].mode, 'agent')
})

await check('模型诊断：引用与参数校验失败 → 降级 needs_manual_review 并保留错误清单', async () => {
  const env = setupDiagnosisEnv()
  const result = await validateDiagnosisCases({
    cases: [
      { // feedback 不存在 + chunk 证据不属于关联查询 + payload 缺 text
        feedback_ids: ['fb-nope'],
        issue_type: 'missing_content',
        cause_layer: 'knowledge',
        action: 'add_text',
        payload: { title: '只有标题' },
        confidence: 0.5,
      },
      { // 未知 action + confidence 越界
        feedback_ids: [env.fb.feedback_id],
        action: 'make_coffee',
        confidence: 1.5,
      },
      { // edit_entity 目标实体不存在（假引擎 entities 为空）
        feedback_ids: [env.fb.feedback_id],
        issue_type: 'wrong_entity',
        cause_layer: 'graph',
        action: 'edit_entity',
        payload: { entity_name: '不存在的实体', updates: { description: 'x' } },
        confidence: 0.7,
      },
    ],
    feedback: env.f, curator: env.curator, engine: env.engine,
  })
  ok(result.ok, 'batch level ok (case-level failures are data, not errors)')
  eq(result.cases[0].validation.ok, false)
  ok(result.cases[0].validation.errors.some((e) => e.includes('反馈不存在')))
  ok(result.cases[0].validation.errors.some((e) => e.includes('add_text 的 payload 需要 text')))
  eq(result.cases[1].validation.ok, false)
  ok(result.cases[1].validation.errors.some((e) => e.includes('未知 action')))
  ok(result.cases[1].validation.errors.some((e) => e.includes('confidence')))
  eq(result.cases[2].validation.ok, false)
  ok(result.cases[2].validation.errors.some((e) => e.includes('实体不存在于图谱')))

  const d = createDiagnosisLedger({ dir: env.dir, feedback: env.f })
  const row = d.submitCases({ cases: result.cases })
  eq(row.proposals.filter((p) => p.status === 'needs_manual_review').length, 3, 'all invalid cases demoted')
  ok(row.proposals[1].validation.errors.length > 0, 'errors persisted with proposal')
  // 未知 action 兜底为 manual_review（建议类）
  eq(row.proposals[1].action, 'manual_review')
})

await check('模型诊断：建议类动作即使校验通过也不可执行', async () => {
  const env = setupDiagnosisEnv()
  const result = await validateDiagnosisCases({
    cases: [{
      feedback_ids: [env.fb.feedback_id],
      issue_type: 'missing_content',
      cause_layer: 'retrieval',
      root_cause: '相关制度存在但 mix 模式未命中',
      action: 'adjust_retrieval',
      payload: { advice: [
        '【配置】在知识库设置页将检索模式从 mix 切换为 nano',
        '【核对】用"采购审批需要哪些条件"重新提问，预期引用《采购管理办法.docx》',
      ] },
      confidence: 0.6,
    }, {
      // 图谱结构问题：增/删/合不自动执行，advice 引导人工在实体检索页操作
      feedback_ids: [env.fb.feedback_id],
      issue_type: 'wrong_entity',
      cause_layer: 'graph',
      root_cause: '实体「采购管理」与「采购管理办法」重复',
      action: 'manual_review',
      payload: { advice: [
        '【改图谱】在「文档管理 → 实体检索」页合并实体：将「采购管理办法」合并至「采购管理」（保留规范名）',
        '【核对】合并后用"采购审批需要哪些条件"重新提问，预期实体命中不重复',
      ] },
      confidence: 0.75,
    }],
    feedback: env.f, curator: env.curator, engine: env.engine,
  })
  ok(result.cases[0].validation.ok, 'advisory case with operable advice passes')
  ok(result.cases[1].validation.ok, 'graph-layer advisory with 改图谱 advice passes')
  const d = createDiagnosisLedger({ dir: env.dir, feedback: env.f })
  const row = d.submitCases({ cases: result.cases })
  eq(row.proposals.filter((p) => p.status === 'needs_manual_review').length, 2, 'advisory actions never await approval')
  eq(row.proposals[0].action, 'adjust_retrieval')
  eq(row.proposals[0].payload.advice.length, 2, 'advice persisted with proposal')
})

await check('模型诊断：建议类动作 advice 不合规 → 校验失败降级', async () => {
  const env = setupDiagnosisEnv()
  const result = await validateDiagnosisCases({
    cases: [
      { // 没有 advice：人工处置价值缺失
        feedback_ids: [env.fb.feedback_id],
        issue_type: 'wrong_source',
        cause_layer: 'answer_generation',
        root_cause: '回答引用错配',
        action: 'prompt_fix',
        payload: { reason: '引用错配' },
        confidence: 0.7,
      },
      { // advice 为空数组同样无效
        feedback_ids: [env.fb.feedback_id],
        issue_type: 'outdated_content',
        cause_layer: 'knowledge',
        action: 'manual_review',
        payload: { advice: [] },
        confidence: 0.4,
      },
      { // 策略性描述（无操作指令前缀）对运维者不可执行
        feedback_ids: [env.fb.feedback_id],
        issue_type: 'answer_style',
        cause_layer: 'user_expectation',
        root_cause: '提问过于宽泛',
        action: 'manual_review',
        payload: { advice: ['建议用户优化提问方式'] },
        confidence: 0.5,
      },
    ],
    feedback: env.f, curator: env.curator, engine: env.engine,
  })
  eq(result.cases[0].validation.ok, false)
  ok(result.cases[0].validation.errors.some((e) => e.includes('prompt_fix 的 payload 需要 advice')), 'missing advice reported')
  eq(result.cases[1].validation.ok, false)
  ok(result.cases[1].validation.errors.some((e) => e.includes('manual_review 的 payload 需要 advice')), 'empty advice array reported')
  eq(result.cases[2].validation.ok, false)
  ok(result.cases[2].validation.errors.some((e) => e.includes('【改提问】')), 'strategy-only advice rejected with prefix guidance')
  const d = createDiagnosisLedger({ dir: env.dir, feedback: env.f })
  const row = d.submitCases({ cases: result.cases })
  eq(row.proposals.filter((p) => p.status === 'needs_manual_review').length, 3, 'all demoted')
})

await check('模型诊断：超出案例上限整批拒绝；空 cases 拒绝', async () => {
  const env = setupDiagnosisEnv()
  const tooMany = await validateDiagnosisCases({ cases: Array.from({ length: 11 }, () => ({ feedback_ids: [env.fb.feedback_id], action: 'manual_review' })), feedback: env.f, curator: env.curator, engine: env.engine })
  eq(tooMany.ok, false)
  const empty = await validateDiagnosisCases({ cases: [], feedback: env.f, curator: env.curator, engine: env.engine })
  eq(empty.ok, false)
})

await check('反馈手动管理：修正类型/说明，未知类型拒绝，重启后生效', async () => {
  const dir = tmp(); const f = createFeedbackLedger({ dir })
  const row = f.record({ rating: 'negative', issue_type: 'missing_content', query: 'q', note: '原说明' })
  const updated = f.update(row.feedback_id, { issue_type: 'wrong_entity', note: '修正后的说明' })
  eq(updated.issue_type, 'wrong_entity')
  eq(updated.note, '修正后的说明')
  eq(f.list({ issue_type: 'wrong_entity' }).length, 1, 'list sees the update')
  eq(f.get(row.feedback_id).note, '修正后的说明', 'latest row wins')
  let failed = false
  try { f.update(row.feedback_id, { issue_type: 'bogus' }) } catch (e) { failed = e.status === 400 }
  ok(failed, 'unknown issue_type rejected')
  failed = false
  try { f.update('fb-nope', { note: 'x' }) } catch (e) { failed = e.status === 404 }
  ok(failed, 'missing feedback rejected')
  // 重启后仍读到修正值
  const f2 = createFeedbackLedger({ dir })
  eq(f2.get(row.feedback_id).issue_type, 'wrong_entity')
})

await check('反馈手动管理：删除（墓碑行）后列表与统计排除，不可再改', async () => {
  const dir = tmp(); const f = createFeedbackLedger({ dir })
  const a = f.record({ rating: 'negative', issue_type: 'missing_content', query: 'qa', note: 'x' })
  const b = f.record({ rating: 'negative', issue_type: 'other', query: 'qb', note: 'y' })
  eq(f.stats().open, 2)
  const gone = f.remove(a.feedback_id)
  eq(gone.status, 'deleted')
  eq(f.stats().open, 1, 'deleted feedback no longer counted open')
  eq(f.list({ limit: 50 }).some((r) => r.feedback_id === a.feedback_id), false, 'deleted hidden from list')
  eq(f.list({ status: null, limit: 50 }).some((r) => r.feedback_id === a.feedback_id), false, 'deleted hidden even without status filter')
  ok(!!f.get(b.feedback_id), 'other feedback untouched')
  let failed = false
  try { f.update(a.feedback_id, { note: 'z' }) } catch (e) { failed = e.status === 409 }
  ok(failed, 'updating a deleted feedback is rejected')
  failed = false
  try { f.remove(a.feedback_id) } catch (e) { failed = e.status === 404 || e.status === 409 }
  // remove 对已删除行 append 墓碑仍成功（末行同状态幂等），不承诺 404；主断言是列表排除
  ok(f.list({ limit: 50 }).length === 1, 'list still excludes deleted after repeat remove')
  // 删除后同一 query_id 的新反馈不受旧 dedupe 影响
  const again = f.record({ rating: 'negative', issue_type: 'missing_content', query_id: 'q-9', query: 'qa', note: '重新提交' })
  ok(again.duplicate !== true, 'deleted row does not dedupe a fresh submission')
  // 重启后墓碑仍生效
  const f2 = createFeedbackLedger({ dir })
  eq(f2.stats().open, 2, 'tombstone survives restart')
})

await check('回答点赞：按用户与回答保存、去重、切换、撤销，并在重启后恢复', async () => {
  const dir = tmp(); const f = createFeedbackLedger({ dir })
  const base = { actor: 'alice', session_id: 's-1', message_id: '6', query: 'q', answer: 'a', query_id: 'q-1' }
  const first = f.vote({ ...base, rating: 'positive' })
  eq(f.vote({ ...base, rating: 'positive' }).feedback_id, first.feedback_id)
  eq(f.stats().total, 1, 'repeated positive votes do not append duplicates')
  eq(f.vote({ ...base, rating: 'negative' }).feedback_id, first.feedback_id)
  eq(f.stats().total, 1, 'switching votes updates the same record')
  eq(f.get(first.feedback_id).issue_type, 'other')
  f.vote({ ...base, actor: 'bob', rating: 'positive' })
  eq(f.stats().total, 2, 'different users never merge into one vote')
  const f2 = createFeedbackLedger({ dir })
  eq(f2.votes({ actor: 'alice', session_id: 's-1' })[0].rating, 'negative')
  eq(f2.votes({ actor: 'bob', session_id: 's-1' })[0].rating, 'positive')
  f2.vote({ ...base, rating: null })
  eq(f2.votes({ actor: 'alice', session_id: 's-1' }).length, 0)
  eq(f2.votes({ actor: 'bob', session_id: 's-1' }).length, 1, 'cancellation affects only the author')
  eq(createFeedbackLedger({ dir }).stats().total, 1, 'cancellation persists across restart')
  let failed = false
  try { f2.vote({ ...base, rating: 'fake' }) } catch (e) { failed = e.status === 400 }
  ok(failed, 'invalid ratings are rejected')
})

const failed = finish()
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) process.exit(failed ? 1 : 0)
