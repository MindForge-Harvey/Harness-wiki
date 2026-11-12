import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { wirelessDataDir, createWorkorderStore } from './workflow.js'
import { analyzeObservations } from './analytics.js'
import { orderAnalysisInput } from './order-context.js'
import { compactAnalysis } from './network-data.js'
import { explainRecordedDecision } from './decision-explanation.js'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const worker = path.join(plugin, 'worker/icos.py')
const manifestPath = path.join(plugin, 'vendor/icos/source-manifest.json')
const source = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && Boolean(value.trim())
const toolName = stage => `wireless_icos_${stage}`
const stageSkills = {
  context: 'wireless-workorder-intake', objective: 'wireless-objective-confirmation',
  root_cause: 'wireless-root-cause-analysis', cases: 'wireless-case-retrieval',
  candidates: 'wireless-solution-decision', alignment: 'wireless-cause-plan-alignment',
  parameter_risk: 'wireless-parameter-adaptation', consistency: 'wireless-plan-consistency',
  decision: 'wireless-comprehensive-decision', multi_round: 'wireless-multi-round-reasoning',
  feedback: 'wireless-effect-evaluation',
}
const dependencies = {
  objective: [], root_cause: [], cases: [], feedback: [], multi_round: ['cases'],
  candidates: ['root_cause', 'cases'], alignment: ['root_cause', 'candidates'],
  parameter_risk: ['cases', 'candidates'],
  consistency: ['objective', 'root_cause', 'cases', 'candidates', 'alignment', 'parameter_risk'],
  decision: ['objective', 'root_cause', 'cases', 'candidates', 'alignment', 'parameter_risk', 'consistency'],
}
const stageDescriptions = {
  root_cause: '02 根因收敛：读取 ICOS 结论及六维原文，返回 Harness 判断要求；提交 judgment 后由原解析器校验根因和原文支撑分。',
  objective: '03 目标确认：提取问题指标、目标小区和时间边界，标记未确认项。',
  cases: '04 案例参考：原 ICOS 同参数/二级原因/问题类型匹配、成败与幅度统计，同时查询现有 ECHO-Mem 历史。',
  candidates: '04 候选方案与组内寻优：从 ICOS 初案构造方案组→方案→参数；返回各组判断要求，judgments 按返回组键提交。',
  alignment: '05 根因与方案对齐：返回本轮方案和根因的判断要求；提交 judgment 后执行原对齐解析。',
  parameter_risk: '07 参数风险：执行 ICOS 规则匹配、取值约束、方向、步长与案例幅度适配。使用随代码携带的规则或输入规则快照。',
  consistency: '06 整单一致性：针对实际准备采用的动作返回相关性与冲突复核要求；提交 judgment 后剔除存疑/冲突动作并重评条件。',
  decision: '08 综合决策：原决策链执行组内选择、根因剔除、规则适配、冲突剔除、条件回环和复核，生成完整 OrderDecision。解释保留/剔除用 operation=explain 只读实际逐动作依据；preview 看复核前集合；finalize 要求复核完成。',
  multi_round: '多轮重推理：读取输入中的前轮实际执行回执和短评估，运行原缩步长/反向/回退阶梯，返回建议，不操作设备。',
  feedback: '读取 ICOS 短评估及执行回执，或按请求接收带来源的 archived_feedback 历史反馈。区分短评估未启用、执行成败、长期评估及改善标签冲突；失败动作的建议目标不作为实际改后值。',
}

function prerequisites(state, stage, args = {}) {
  let names = [...dependencies[stage]]
  if (state.input.retry_times > 0 && ['candidates', 'consistency', 'decision'].includes(stage)) names.push('multi_round')
  if (stage === 'decision' && args.operation === 'preview') names = names.filter(name => name !== 'consistency')
  return [...new Set(names)]
}
function missingFor(state, stage, args) {
  return prerequisites(state, stage, args).filter(name => state.stages[name]?.response.status !== 'completed')
}
function workflow(state) {
  return Object.keys(dependencies).map(stage => ({ stage, tool: toolName(stage), skill: stageSkills[stage],
    status: state.stages[stage]?.response.result?.preview ? 'preview' : state.stages[stage]?.response.status || 'not_started',
    requires: missingFor(state, stage),
  }))
}
function invalidate(state, changed) {
  const removed = new Set([changed])
  let more = true
  while (more) {
    more = false
    for (const name of Object.keys(dependencies)) if (!removed.has(name) && prerequisites(state, name).some(dep => removed.has(dep))) {
      removed.add(name); more = true
    }
  }
  for (const name of removed) delete state.stages[name]
  return [...removed].filter(name => name !== changed)
}
function boundedArray(value, name, limit) {
  if (!Array.isArray(value) || value.length > limit || value.some(row => !object(row))) throw new Error(`${name} 必须是最多 ${limit} 项的对象数组`)
}
function normalizeInput(input) {
  if (!object(input) || !object(input.order) || !nonempty(input.order.taskno) || !nonempty(input.source_ref)) {
    throw new Error('input 需要 source_ref 与 order.taskno；其余未知字段可以省略')
  }
  const data = clone(input)
  data.initial_plans ||= []
  for (const [name, limit] of [['initial_plans', 40], ['cases', 500], ['rules', 2000], ['observations', 10000],
    ['prior_execution_rows', 2000], ['short_evals', 100]]) {
    if (data[name] !== undefined) boundedArray(data[name], name, limit)
  }
  data.retry_times ??= 0
  data.confidence_threshold ??= 40
  if (!Number.isInteger(data.retry_times) || data.retry_times < 0 || data.retry_times > 20) throw new Error('retry_times 必须是 0 至 20 整数')
  if (!Number.isInteger(data.confidence_threshold) || data.confidence_threshold < 0 || data.confidence_threshold > 100) throw new Error('confidence_threshold 必须是 0 至 100 整数')
  const identities = new Set()
  for (const row of data.initial_plans) {
    if (!nonempty(row.parachinname) || !['string', 'number'].includes(typeof row.execution_id) || String(row.execution_id).trim() === '') throw new Error('每条初案需要 execution_id 与 parachinname')
    if (row.taskno && String(row.taskno) !== data.order.taskno) throw new Error('初案 taskno 与当前工单不一致')
    const key = String(row.execution_id).trim()
    if (identities.has(key)) throw new Error('初案 execution_id 必须唯一，避免源对齐键碰撞')
    identities.add(key)
    delete row.final_ratio
  }
  const caseIds = new Set()
  for (const row of data.cases || []) {
    if (!nonempty(row.case_id) || !nonempty(row.source_ref) || caseIds.has(row.case_id)) throw new Error('案例需要唯一 case_id 和 source_ref')
    caseIds.add(row.case_id)
    boundedArray(row.actions || [], 'case.actions', 200)
  }
  const evalIds = new Set()
  for (const row of data.short_evals || []) {
    if (!Number.isSafeInteger(row.id) || evalIds.has(row.id)) throw new Error('short_evals 需要唯一整数 id，供执行行 short_result_id 关联')
    if (!['改善', '通过', '恶化', '不通过', '未通过', '缺失'].includes(row.short_assess_result)) throw new Error('short_assess_result 不在 ICOS 词表内')
    evalIds.add(row.id)
  }
  if (Buffer.byteLength(JSON.stringify(data)) > 4 * 1024 * 1024) throw new Error('ICOS 输入快照最多 4 MB')
  return data
}

function invoke(python, payload, signal) {
  return new Promise((resolve, reject) => {
    // No gateway credentials/config environment reaches the embedded source modules.
    const child = spawn(python, ['-B', worker], { signal, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } })
    let stdout = '', stderr = '', failure
    const timer = setTimeout(() => { failure = new Error('ICOS 阶段超过 30 秒'); child.kill('SIGKILL') }, 30000)
    child.stdout.on('data', data => {
      stdout += data
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) { failure = new Error('ICOS 阶段输出超过 4 MB'); child.kill('SIGKILL') }
    })
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (failure) return reject(failure)
      let result
      try { result = JSON.parse(stdout) } catch { return reject(new Error(stderr || 'ICOS worker 未返回合法 JSON')) }
      if (code !== 0 || result.error) return reject(new Error(result.error || stderr || 'ICOS 阶段失败'))
      resolve(result)
    })
    child.stdin.on('error', () => {})
    const input = JSON.stringify(payload)
    if (Buffer.byteLength(input) > 8 * 1024 * 1024) { child.kill(); reject(new Error('ICOS 阶段上下文超过 8 MB')); return }
    child.stdin.end(input)
  })
}

export function createIcosService({ directory = wirelessDataDir(), workspace = process.cwd(), python,
  historySearch, orders, workorder = createWorkorderStore({ directory }) } = {}) {
  const runs = path.join(directory, 'icos-runs')
  const managed = path.resolve(plugin, '../../.runtime/wireless-python/bin/python')
  const executable = python || process.env.WIRELESS_PYTHON || (fs.existsSync(managed) ? managed : 'python3')
  const fileFor = id => {
    if (!/^icos_[a-f0-9]{24}$/.test(id || '')) throw new Error('run_id 必须使用 wireless_icos_context 返回的 ID')
    return path.join(runs, `${id}.json`)
  }
  function load(id) {
    const target = fileFor(id)
    if (!fs.existsSync(target)) throw new Error('ICOS 分析记录不存在，请先创建上下文')
    const state = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (state.input_hash !== hash(state.input)) throw new Error('ICOS 输入快照校验失败')
    return state
  }
  function save(state) {
    const target = fileFor(state.run_id), temp = target + '.' + crypto.randomUUID() + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(temp, target)
  }
  async function locked(id, action) {
    fs.mkdirSync(runs, { recursive: true })
    const lock = fileFor(id) + '.lock'
    let descriptor
    try { descriptor = fs.openSync(lock, 'wx', 0o600) }
    catch (error) { if (error.code === 'EEXIST') throw new Error('同一 ICOS 分析正在更新，请读取最新 revision 后重试'); throw error }
    try { return await action() }
    finally { fs.closeSync(descriptor); fs.unlinkSync(lock) }
  }
  function response(state, value) {
    const network = state.input.network_context
    const thresholds = [...new Map((state.input.observations || []).filter(row => row?.metric && row.threshold
      && Number.isFinite(row.threshold.value) && row.object_id && row.object_id === state.input.order.cgi)
      .map(row => [JSON.stringify([row.metric,row.threshold]), { metric: row.metric, column: row.source_column || null,
        unit: row.unit, ...row.threshold }])).values()]
    return { ...value, run_id: state.run_id, revision: state.revision, workorder_id: state.workorder_id || null,
      ...(state.input.archive_context?.analysis_selection ? { analysis_selection: state.input.archive_context.analysis_selection } : {}),
      ...(network ? { analysis_basis: { snapshot_date: network.snapshot_date || null, diagnostic_source: 'network_snapshot',
        diagnostic_source_ref: network.source_ref || state.input.source_ref, archive_issued_at: state.input.order.createtime || null,
        data_origin: network.provenance?.origin || null,
        analysis_window: network.analysis_window || null, anomaly_thresholds: thresholds,
        evaluation_targets: network.evaluation_policy || null,
        interpretation: '本轮根因与方案仅针对所列分析日期。快照诊断不是原归档结论；跨期快照不能解释原工单根因或原执行效果。异常阈值与优化目标分开使用。',
      } } : {}),
      workflow: workflow(state), source: { project: source.source_project, snapshot_date: source.snapshot_date,
        manifest_sha256: hash(source) }, device_operation_performed: false }
  }
  async function context(args, execution) {
    const operation = args.operation || (args.input || args.file_path || args.ticket_id ? 'create' : 'read')
    if (operation === 'link_workorder') {
      if (!nonempty(args.workorder_id)) throw new Error('link_workorder 需要已有 workorder_id')
      workorder({ operation: 'read', workorder_id: args.workorder_id })
      return locked(args.run_id, async () => {
        const state = load(args.run_id)
        if (args.expected_revision !== undefined && state.revision !== args.expected_revision) throw new Error('ICOS revision 冲突，请先 read')
        if (state.workorder_id === args.workorder_id) return response(state, { status: 'linked', reused: true })
        state.workorder_id = args.workorder_id
        state.revision += 1
        state.history.push({ stage: 'link_workorder', revision: state.revision, workorder_id: args.workorder_id, at: new Date().toISOString() })
        save(state)
        return response(state, { status: 'linked', invalidated_stages: [] })
      })
    }
    if (operation === 'read') {
      if (!args.run_id && args.ticket_id) {
        const resolved = await context({ ...args, operation: 'create' }, execution)
        if (!resolved.run_id) return resolved
        return context({ operation: 'read', run_id: resolved.run_id, view: args.view || 'summary' }, execution)
      }
      const state = load(args.run_id)
      const prior = state.input.archive_context?.analysis_selection
      const selectionArgs = { analysis_scope: args.analysis_scope || (prior?.scope === 'latest' ? 'latest' : 'ticket'),
        snapshot_date: args.snapshot_date || (!args.analysis_scope && prior?.scope === 'specified_date' ? prior.selected_date : undefined) }
      const selection = state.input.archive_context && orders?.analysisSelection?.(state.input.order.taskno, selectionArgs.snapshot_date, selectionArgs.analysis_scope)
      const latest = state.input.archive_context && orders?.analysisData?.(state.input.order.taskno, selectionArgs.snapshot_date, selectionArgs.analysis_scope)
      if ((selection && hash(selection) !== hash(prior || {})) || (latest && state.input.network_context?.version !== latest.version)
        || (selection && !latest && state.input.network_context)) {
        const updated = await context({ operation: 'update', run_id: args.run_id, ticket_id: state.input.order.taskno,
          ...selectionArgs, expected_revision: state.revision }, execution)
        return { ...updated, refreshed_from_network_data: true,
          interpretation: '已按本轮分析日期刷新资料并清除失效阶段；未匹配该日期的快照不会带入历史工单分析。' }
      }
      if (args.view === 'summary') {
        const prepared = state.stages.context.response.result.parameter_changes ? state.stages.context.response
          : await invoke(executable, { state, args: { stage: 'context' } }, execution.signal)
        const summaries = {}
        for (const [name, stage] of Object.entries(state.stages)) {
          if (['context', 'feedback'].includes(name)) continue
          const r = stage.response.result
          summaries[name] = { status: stage.response.status, ...(name === 'cases' ? {
            result: { status: r.status, library_size: r.library_size, hit_count: r.hit_count,
              action_count: r.action_count, refs: r.refs, actions: r.actions },
          } : name === 'decision' ? { result: { verdict: r.decision?.verdict, chain: r.decision?.chain,
            manual_required: r.manual_required, preview: r.preview } } : { result: r }) }
        }
        return response(state, { status: 'restored', ...prepared.result,
          input_summary: { source_ref: state.input.source_ref, case_count: state.input.cases?.length || 0,
            observation_count: state.input.observations?.length || 0,
            diagnostic_text_available: Boolean(state.input.order.conclusion || state.input.order.smart_conclusion || Object.keys(prepared.result.dimensions || {}).length),
            short_evaluation_count: state.input.short_evals?.length || 0, retry_times: state.input.retry_times },
          stage_summaries: summaries })
      }
      return response(state, { status: 'restored', input: state.input, stages: state.stages, history: state.history })
    }
    if (!['create', 'update'].includes(operation)) throw new Error('context operation 需要 create/read/update')
    let input = args.input
    if ([args.input, args.file_path, args.ticket_id].filter(Boolean).length !== 1) throw new Error('input、file_path 与 ticket_id 必须三选一')
    // A known stored source is read canonically, never reconstructed from model-transcribed fields.
    // This preserves the original ticket date, complete observations, rules and provenance.
    if (input?.order?.taskno && orders?.analysisSelection && !input.archive_context) {
      const selection = orders.analysisSelection(input.order.taskno)
      for (const day of selection.available_dates) {
        const stored = orders.analysisData(input.order.taskno, day)
        if (stored && input.source_ref === stored.source_ref) {
          const resolved = await context({ ...args, input: undefined, ticket_id: input.order.taskno,
            snapshot_date: day, analysis_scope: 'ticket' }, execution)
          return { ...resolved, input_resolution: 'canonical_stored_snapshot',
            interpretation: '已按库内来源恢复完整原始快照，保留原工单日期；本轮分析日期单独记录，不使用转写字段替换库内资料。' }
        }
      }
    }
    if (args.ticket_id) {
      if (!orders) throw new Error('工单查询入口不可用')
      const record = orders({ operation: 'read', ticket_id: args.ticket_id })
      if (record.status !== 'found') return record
      const analysisSelection = orders.analysisSelection?.(record.ticket.id, args.snapshot_date, args.analysis_scope)
      const networkData = orders.analysisData?.(record.ticket.id, args.snapshot_date, args.analysis_scope)
      input = orderAnalysisInput(record, { networkData, analysisSelection, caseRecords: orders.caseRecords?.(networkData
        ? { ...record.ticket, issued_at: networkData.snapshot_date } : record.ticket) || [] })
    }
    if (args.file_path) {
      const root = fs.realpathSync(workspace), target = fs.realpathSync(path.resolve(root, args.file_path))
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error('file_path 必须位于工作区内')
      if (fs.statSync(target).size > 4 * 1024 * 1024) throw new Error('工单文件最多 4 MB')
      input = JSON.parse(fs.readFileSync(target, 'utf8'))
    }
    input = normalizeInput(input)
    if (args.workorder_id) workorder({ operation: 'read', workorder_id: args.workorder_id })
    const run_id = operation === 'update' ? args.run_id : 'icos_' + hash({ input, workorder_id: args.workorder_id || null }).slice(0, 24)
    return locked(run_id, async () => {
      let state = fs.existsSync(fileFor(run_id)) ? load(run_id) : null
      if (args.expected_revision !== undefined && args.expected_revision !== (state?.revision || 0)) throw new Error('ICOS revision 冲突，请先 read')
      if (state && state.input_hash === hash(input)) return response(state, { ...state.stages.context.response, reused: true })
      if (operation === 'update' && !state) throw new Error('待更新分析不存在')
      state = { run_id, revision: (state?.revision || 0) + 1, input, input_hash: hash(input),
        workorder_id: state?.workorder_id || args.workorder_id || null, stages: {}, history: state?.history || [] }
      const output = await invoke(executable, { state, args: { stage: 'context' } }, execution.signal)
      if (input.observations?.length) output.result.observation_analysis = compactAnalysis(analyzeObservations({ observations: input.observations }))
      state.stages.context = { response: output, request: {}, at: new Date().toISOString() }
      state.history.push({ stage: 'context', revision: state.revision, input_hash: state.input_hash, at: new Date().toISOString() })
      save(state)
      return response(state, output)
    })
  }
  return async function icos(stage, args = {}, execution = {}) {
    if (stage === 'context') return context(args, execution)
    if (!dependencies[stage]) throw new Error('未知 ICOS 工具阶段')
    if (stage === 'decision' && args.operation === 'explain' && args.ticket_id) {
      const resolved = await context({ operation: 'read', ticket_id: args.ticket_id, snapshot_date: args.snapshot_date,
        analysis_scope: args.analysis_scope, view: 'summary' }, execution)
      if (!resolved.run_id) return resolved
      return icos(stage, { run_id: resolved.run_id, operation: 'explain' }, execution)
    }
    return locked(args.run_id, async () => {
      const state = load(args.run_id)
      if (state.input.archive_context && orders?.analysisSelection && !state.input.archive_context.analysis_selection?.policy) {
        return response(state, { status: 'needs_stages', missing_stages: ['context'], next_tools: ['wireless_icos_context'],
          interpretation: '旧分析未绑定取数时点，请先 context read 按工单日期恢复；需要跨期分析时明确指定日期或 latest。' })
      }
      if (args.expected_revision !== undefined && state.revision !== args.expected_revision) throw new Error('ICOS revision 冲突，请先 read')
      if (stage === 'decision' && args.operation === 'explain') return response(state, explainRecordedDecision(state))
      const missing = missingFor(state, stage, args)
      if (missing.length) return response(state, { status: 'needs_stages', missing_stages: missing, next_tools: missing.map(toolName) })
      if (!state.input.initial_plans.length && ['candidates', 'alignment', 'parameter_risk', 'consistency', 'decision'].includes(stage)) {
        return response(state, { status: 'needs_data', missing_fields: ['initial_plans'], next_tools: ['wireless_icos_context'] })
      }
      if (state.input.retry_times > 0 && stage === 'multi_round' && !state.input.prior_execution_rows?.length) {
        return response(state, { status: 'needs_data', missing_fields: ['prior_execution_rows'], next_tools: ['wireless_icos_context'] })
      }
      const hasNewRequest = ['judgment', 'judgments', 'bypass_reason', 'operation', 'rollback_only', 'save_to_workorder', 'archived_feedback']
        .some(key => args[key] !== undefined)
      if (!args.refresh && !hasNewRequest && state.stages[stage]) {
        return response(state, { ...state.stages[stage].response, reused: true })
      }
      const request = Object.fromEntries(Object.entries(args).filter(([key]) => ['judgment', 'judgments', 'bypass_reason', 'operation', 'rollback_only', 'archived_feedback'].includes(key)))
      if (request.archived_feedback !== undefined) {
        if (stage !== 'feedback' || !object(request.archived_feedback) || !nonempty(request.archived_feedback.source_ref)) throw new Error('archived_feedback 仅用于 feedback，且需要 source_ref')
        boundedArray(request.archived_feedback.actions, 'archived_feedback.actions', 200)
        const known = new Set(state.input.initial_plans.map(row => String(row.execution_id)))
        for (const row of request.archived_feedback.actions) {
          if (!known.has(String(row.execution_id))) throw new Error('归档反馈 execution_id 不属于本次工单')
          if (!['exec_success', 'exec_failed', 'exec_skipped', 'unknown'].includes(row.exec_state)) throw new Error('归档执行状态不在词表中')
        }
      }
      for (const key of ['judgment', 'judgments']) if (request[key] !== undefined && !object(request[key])) throw new Error(`${key} 必须是 JSON 对象`)
      if (request.bypass_reason !== undefined && !nonempty(request.bypass_reason)) throw new Error('bypass_reason 需要真实失败或无法判断原因')
      if (stage === 'decision' && request.operation && !['preview', 'finalize'].includes(request.operation)) throw new Error('decision operation 需要 preview/finalize')
      const judgmentToken = hash({ input: state.input_hash, stage,
        upstream: prerequisites(state, stage, args).map(name => [name, state.stages[name]?.request_hash]) })
      if ((request.judgment || (request.judgments && Object.keys(request.judgments).length)) && args.judgment_token !== judgmentToken) {
        throw new Error('judgment_token 缺失或上下文已变化，请先无判断调用该工具获取本轮要求')
      }
      if (stage === 'candidates' && request.judgments && !args.refresh) {
        request.judgments = { ...state.stages[stage]?.request.judgments, ...request.judgments }
      }
      const fingerprint = hash({ ...request, save_to_workorder: args.save_to_workorder || false })
      if (!args.refresh && state.stages[stage]?.request_hash === fingerprint) return response(state, { ...state.stages[stage].response, reused: true })
      const output = await invoke(executable, { state, args: { ...request, stage } }, execution.signal)
      if (output.status === 'needs_judgment') output.judgment_token = judgmentToken
      if (stage === 'cases' && historySearch) {
        const o = state.input.order
        output.shared_history = await historySearch({ query: [o.task_type, o.type2,
          ...state.input.initial_plans.map(row => row.parachinname)].filter(Boolean).join(' ').slice(0, 2000) || o.taskno,
          ...(o.vendor ? { vendor: o.vendor } : {}), ...(o.nettype ? { system: o.nettype } : {}), limit: 6 })
        output.history_interpretation = 'ICOS 同类计数只消费输入中的案例快照；ECHO 检索结果保留原来源与作用域，供分析补充，不混入 ICOS 成败分母。'
      }
      const invalidated_stages = invalidate(state, stage)
      state.revision += 1
      state.stages[stage] = { request, request_hash: fingerprint, response: output, at: new Date().toISOString() }
      state.history.push({ stage, revision: state.revision, status: output.status, request_hash: fingerprint,
        invalidated_stages, at: new Date().toISOString() })
      state.history = state.history.slice(-500)
      if (stage === 'decision' && output.status === 'completed' && args.save_to_workorder) {
        if (!state.workorder_id) throw new Error('先在 context 中关联已存在的 workorder_id')
        if (request.operation === 'preview') throw new Error('preview 不能保存为最终候选方案')
        const actions = output.result.rows.filter(row => row.need_call_parameter_platform === '是').map(row => ({
          parameter: row.tool, current: row.f_para, target: row.b_para,
        }))
        if (actions.length) {
          const record = workorder({ operation: 'save_plan', workorder_id: state.workorder_id,
            input: { title: 'ICOS 工单候选方案', rationale: '按 ICOS 阶段分析、参数规则及整单复核形成',
              source_refs: [state.input.source_ref, `ICOS:${state.run_id}:revision:${state.revision}`], actions } })
          output.saved_plan = { workorder_id: state.workorder_id, plan_id: record.stages.plan.plan_id }
        }
      }
      save(state)
      return response(state, { ...output, invalidated_stages })
    })
  }
}

const string = description => ({ type: 'string', description })
const json = description => ({ type: 'object', additionalProperties: true, description })
const runProperties = {
  run_id: string('wireless_icos_context 返回的持久化分析 ID。'),
  expected_revision: { type: 'integer', description: '可选乐观锁；冲突先 context read。' },
  refresh: { type: 'boolean', description: '明确需要重算时使用；变化使依赖阶段失效。' },
}
export function icosToolDefinitions(service) {
  return [{
    name: 'wireless_icos_context',
    description: '先加载 wireless-workorder-intake Skill。有业务工单号时始终用 ticket_id；切到指定日期用 ticket_id+snapshot_date，最新用 ticket_id+analysis_scope=latest。工具自动读取原单、完整指标、诊断、初案、规则和历史，不要将查询结果手抄进 input。input/file_path 仅用于新的外部输入或用户实际补数。read 优先 view=summary；update 补数使旧阶段失效；link_workorder 关联账本保留阶段。',
    parameters: { type: 'object', properties: { ...runProperties,
      operation: { type: 'string', enum: ['create', 'read', 'update', 'link_workorder'] },
      view: { type: 'string', enum: ['summary', 'full'], description: 'read 优先 summary；full 返回完整输入/阶段/历史，可能很大。' },
      ticket_id: string('业务工单号或源 Trace ID；与 input/file_path 三选一。自动读取原单并保留未知项，历史动作作为归档候选，不代表新生成或实际执行。'),
      snapshot_date: string('仅用户明确指定分析日期时传 YYYY-MM-DD；默认按工单日期取数，不自动使用更晚快照。'),
      analysis_scope: { type: 'string', enum: ['ticket', 'latest'], description: '默认 ticket：原工单日期；仅用户明确要求最新小区状态时选 latest。不能同时指定 snapshot_date。' },
      input: json('需要 source_ref、order.taskno；可含 initial_plans、observations、cases、rules、prior_execution_rows、short_evals、retry_times。字段详见 ICOS 工单 Skill 契约。'),
      file_path: string('工作区内最多 4 MB 的同契约 JSON 文件；与 input 二选一。'),
      workorder_id: string('可选，关联已有工单；不从泛化描述伪造 ICOS 初案或现场值。'),
    }, additionalProperties: false }, execute: (args, execution) => service('context', args, execution),
  }, ...Object.entries(stageDescriptions).map(([stage, description]) => ({
    name: toolName(stage), description: `先加载 ${stageSkills[stage]} Skill。${description}`,
    parameters: { type: 'object', properties: { ...runProperties,
      ...(['root_cause', 'alignment', 'consistency'].includes(stage) ? {
        judgment: json('先无 judgment 调用获取原提示词，再按返回要求提交 Harness 结构化判断；不得编造原文、方案或动作 ID。'),
        judgment_token: string('本阶段 needs_judgment 返回的上下文令牌；提交判断时必需。'),
        bypass_reason: string('仅模型失败或确实无法判断时，记录具体原因并执行原降级规则。'),
      } : {}),
      ...(stage === 'candidates' ? { judgments: json('按 judgment_requests[].key 返回的组键映射到 {relevant_plans:[本组方案编号],reasoning:理由}。'),
        judgment_token: string('本阶段 needs_judgment 返回的上下文令牌；提交判断时必需。'),
        bypass_reason: string('实际无法完成关联判断的原因。') } : {}),
      ...(stage === 'decision' ? { operation: { type: 'string', enum: ['preview', 'finalize', 'explain'], description: '解释已完成方案的保留/剔除时用 explain，只读逐动作实际依据，不重算、不保存。preview/finalize 分别为预览与最终裁决。' },
        ticket_id: string('explain 优先直接给业务工单号，不需要知道 run_id；preview/finalize 仍用已有 run_id。'),
        snapshot_date: string('explain 按用户此前明确选择的分析日期读取；默认原工单日期。'),
        analysis_scope: { type: 'string', enum: ['ticket', 'latest'], description: 'explain 仅在此前明确按最新状态分析时用 latest；默认 ticket。' },
        save_to_workorder: { type: 'boolean', description: 'finalize 后将选中动作保存为关联工单的候选方案；不记录执行。' } } : {}),
      ...(stage === 'multi_round' ? { rollback_only: { type: 'boolean', description: '明确要求按原值生成回退建议时启用。' } } : {}),
      ...(stage === 'feedback' ? { archived_feedback: json('用户要求分析执行后结果时提供：source_ref、actions（execution_id、parameter、before、after、exec_state、short_eval_raw、long_eval_result、improvement_result、exec_failure_reason）。与原 input 的决策前快照分开保存。') } : {}),
    }, required: stage === 'decision' ? [] : ['run_id'], additionalProperties: false }, execute: (args, execution) => service(stage, args, execution),
  }))]
}
