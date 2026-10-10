import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createMemoryService } from './compiler.js'
import { parameterCheck, vendorName, systemName } from './catalog.js'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const worker = path.join(plugin, 'worker/decision.py')
const source = JSON.parse(fs.readFileSync(path.join(plugin, 'vendor/echo_mem/decision-source-manifest.json')))
const sourceRef = name => ({ commit: source.commit, source_path: name,
  url: `${source.repository}/blob/${source.commit}/echo-mem-reproducibility/${name}` })
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const identities = memory => ['parameter_semantic_id', 'param_object', 'param_en_name', 'param_cn_name']
  .map(key => memory.content?.[key]).filter(nonempty)

function invoke(python, request, signal) {
  return new Promise((resolve, reject) => {
    const process = spawn(python, ['-B', worker], { signal, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => process.kill('SIGKILL'), 20000)
    process.stdout.on('data', chunk => { out += chunk; if (out.length > 1000000) process.kill('SIGKILL') })
    process.stderr.on('data', chunk => { err = (err + chunk).slice(-6000) })
    process.on('error', error => { clearTimeout(timer); reject(error) })
    process.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(err || 'ECHO consumer 未成功完成'))
      try { resolve(JSON.parse(out)) } catch { reject(new Error('ECHO consumer 输出不合法')) }
    })
    process.stdin.on('error', () => {})
    process.stdin.end(JSON.stringify(request))
  })
}

export function createDecisionService({ memory = createMemoryService(), python, now = () => Date.now() } = {}) {
  const managed = path.resolve(plugin, '../../.runtime/wireless-python/bin/python')
  const executable = python || globalThis.process.env.WIRELESS_PYTHON || (fs.existsSync(managed) ? managed : 'python3')
  const sets = new Map()
  function freeze(candidates, context, as_of) {
    const candidate_set_id = 'ecs_' + crypto.createHash('sha256').update(JSON.stringify({ context, as_of, candidates })).digest('hex').slice(0, 24)
    for (const [key, set] of sets) if (now() - set.created > 3600000) sets.delete(key)
    if (sets.size >= 64) sets.delete(sets.keys().next().value)
    const set = { candidates, context, as_of, created: now() }
    sets.set(candidate_set_id, set)
    return { candidate_set_id, set }
  }
  function loadRefs(refs, context, as_of) {
    if (!Array.isArray(refs) || !refs.length || refs.length > 24) throw new Error('candidate_refs 需要 1 至 24 项')
    const entries = refs.map(ref => load(ref, context, as_of))
    if (new Set(entries.map(row => row.candidate_id)).size !== entries.length) throw new Error('候选引用重复')
    return entries
  }
  function load(ref, context, as_of) {
    if (!ref || !nonempty(ref.memory_id)) throw new Error('候选需要 package_id 和 memory_id')
    const result = memory.query({ package_id: ref.package_id, query: ref.memory_id, limit: 12 })
    if (result.compiler.mode !== 'historical') throw new Error('演示包不能用于候选择优或目标值适配')
    if (!Number.isFinite(Date.parse(result.compiler.as_of))) throw new Error('候选包缺有效截止时间')
    if (Date.parse(result.compiler.as_of) > Date.parse(as_of)) throw new Error('候选包晚于决策截止时间')
    const row = result.memories.find(row => row.memory.memory_id === ref.memory_id)
    if (!row) throw new Error('memory_id 不在指定记忆包中')
    const m = row.memory
    if (!['strategy_memory', 'playbook_memory'].includes(m.memory_type) || !['validated', 'reusable'].includes(m.state)) {
      throw new Error('只有 validated/reusable 策略或组合可以进入正向候选；其他经验保留作复核与反证')
    }
    const comparison = {}
    for (const [key, appKey, canonical] of [['vendor', 'vendors', vendorName], ['system', 'systems', systemName]]) {
      if (!context[key]) { comparison[key] = 'current_unknown_requires_confirmation'; continue }
      const known = (m.applicability?.[appKey] || []).filter(value => nonempty(value) && !/未知|未标注/.test(value))
      if (known.length && !known.some(value => canonical(value) === canonical(context[key]))) throw new Error(`${key} 与当前候选不兼容`)
      comparison[key] = known.length ? 'matches' : 'unknown_requires_confirmation'
    }
    return { ...row, candidate_id: `${ref.package_id}:${ref.memory_id}`, package_id: ref.package_id,
      source: result.source, context_comparison: comparison }
  }
  return async function decision(args = {}, execution = {}) {
    const { operation, context = {}, as_of = new Date(now()).toISOString() } = args
    if (!nonempty(as_of) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(as_of) || !Number.isFinite(Date.parse(as_of))) throw new Error('as_of 必须是带时区的 ISO 时间')
    if (!context || typeof context !== 'object' || Array.isArray(context) || Object.values(context).some(v => typeof v !== 'string' || v.length > 500)) throw new Error('context 只接受当前已知的简短字符串字段')
    if (operation === 'rank_candidates') {
      const refs = args.candidate_refs || []
      if (!Array.isArray(refs) || refs.length > 24) throw new Error('candidate_refs 最多 24 项')
      if (!refs.length) return { status: 'no_candidates', candidates: [],
        interpretation: '没有可用历史正向候选；仍可按源 Skill 给有出处的条件性方向，不制造候选或实测统计。' }
      const entries = loadRefs(refs, context, as_of)
      const normalizedContext = { ...context,
        ...(context.vendor ? { vendor: vendorName(context.vendor) } : {}),
        ...(context.system ? { system: systemName(context.system) } : {}) }
      const output = await invoke(executable, { operation, entries, context: normalizedContext,
        root: args.root || {}, parameter_clues: args.parameter_clues || {} }, execution.signal)
      const byId = new Map(entries.map(row => [row.candidate_id, row]))
      const candidates = output.ranked.map((ranked, index) => ({ ...byId.get(ranked.candidate_id), ...ranked, rank: index + 1 }))
      const { candidate_set_id } = freeze(candidates, context, as_of)
      return { status: 'ranked_candidates', candidate_set_id, candidates, algorithm: output.algorithm, config: output.config,
        source: sourceRef('pipeline/selection/plan_ranker.py'), context: normalizedContext, as_of,
        calibrated_gate_loaded: false, automatic_accept_certificate: false,
        interpretation: '源 ranker 实际执行；分数用于历史候选比较，不是当前成功概率。排序未执行校准 veto；未知条件和同 Trace 的多个版本分别保留。候选集在当前进程有效一小时。' }
    }
    if (operation === 'select_candidate') {
      const view = args.candidate_set_id ? { candidate_set_id: args.candidate_set_id, set: sets.get(args.candidate_set_id) }
        : freeze(loadRefs(args.candidate_refs, context, as_of), context, as_of)
      const set = view.set
      if (!set || now() - set.created > 3600000) throw new Error('候选集不存在或已过期；按当前条件重新排序')
      const row = set.candidates.find(row => row.candidate_id === args.selected_candidate_id)
      if (!row) throw new Error('只能选择给定候选集中的 candidate_id，不能生成表外动作')
      const checked = load({ package_id: row.package_id, memory_id: row.memory.memory_id }, set.context, set.as_of)
      if (JSON.stringify(checked.memory) !== JSON.stringify(row.memory)) throw new Error('候选来源发生变化，须重新读取')
      return { status: 'historical_candidate_selected', candidate_set_id: view.candidate_set_id,
        selected_candidate: row, action_pattern: checked.memory.content,
        source: { commit: source.commit, source_path: 'wireless-solution-decision/SHADOW.md',
          url: `${source.repository}/blob/${source.commit}/wireless-solution-decision/SHADOW.md` },
        automatic_accept_certificate: false, execution_permission: 'not_granted',
        interpretation: '所选动作模式由固定来源填充；没有重新生成参数、方向或统计。当前值适配、约束和反证仍需按需检查。' }
    }
    if (operation === 'adapt_value') {
      const row = load(args.candidate_ref, context, as_of), snapshot = args.current_snapshot || {}
      if (row.memory.memory_type !== 'strategy_memory') throw new Error('值选择按具体策略动作进行；组合不能当作单参数')
      const missing = ['parameter', 'unit', 'source_ref', 'constraint_source'].filter(key => !nonempty(snapshot[key]))
      for (const key of ['current_value', 'min', 'max']) if (typeof snapshot[key] !== 'number' || !Number.isFinite(snapshot[key])) missing.push(key)
      if (missing.length) return { status: 'needs_data', missing_fields: missing, candidate_id: row.candidate_id,
        interpretation: '缺真实当前快照或声明边界时只保留历史方向，不采用训练中位数或范围中点补现值。' }
      if (!identities(row.memory).includes(snapshot.parameter)) throw new Error('当前快照参数身份与策略不一致')
      if (snapshot.min > snapshot.max || snapshot.current_value < snapshot.min || snapshot.current_value > snapshot.max) throw new Error('当前快照与声明范围冲突')
      const output = await invoke(executable, { operation, memory: row.memory, snapshot }, execution.signal)
      const selection = output.selection
      let target = null
      const best = selection.candidates?.[0]
      const effectCount = (best?.long_eval_pass_count || 0) + (best?.long_eval_fail_count || 0)
      if (selection.selected && selection.current_parameter_snapshot_used && effectCount > 0) {
        if (best.source === 'shape_distribution' && best.target_value !== undefined && best.target_value !== null) target = Number(best.target_value)
        else if (selection.suggested_delta !== '' && Number.isFinite(Number(selection.suggested_delta))) target = snapshot.current_value + Number(selection.suggested_delta)
      }
      if (target !== null && !Number.isFinite(target)) target = null
      const constraint_check = parameterCheck({ parameter: snapshot.parameter, current: snapshot.current_value,
        ...(target !== null ? { target } : {}), min: snapshot.min, max: snapshot.max,
        ...(snapshot.step !== undefined ? { step: snapshot.step } : {}),
        ...(snapshot.step_base !== undefined ? { step_base: snapshot.step_base } : {}),
        unit: snapshot.unit, constraint_source: snapshot.constraint_source })
      return { status: target === null ? 'needs_data' : constraint_check.status === 'blocked' ? 'blocked' : 'adapted_value_candidate',
        candidate_id: row.candidate_id, context_comparison: row.context_comparison,
        current_snapshot: snapshot, target, selection, constraint_check,
        algorithm: output.algorithm, source: sourceRef('pipeline/selection/action_value_selector.py'),
        ...(target === null ? { missing_fields: ['effective_transferable_child_value_statistics'] } : {}),
        automatic_accept_certificate: false,
        interpretation: '源值选择器实际执行，使用声明的当前快照；候选来自子级有效评价，保留源分数和归因边界。旧 after 值不复制成当前目标；没有效果样本或可迁移值时交付缺口。约束通过不代表效果或下发许可。' }
    }
    throw new Error('未知 ECHO decision operation')
  }
}
