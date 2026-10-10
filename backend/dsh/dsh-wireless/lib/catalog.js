import fs from 'node:fs'
import crypto from 'node:crypto'

const directory = new URL('../resources/', import.meta.url)
const read = name => JSON.parse(fs.readFileSync(new URL(name, directory), 'utf8'))
const manifest = read('manifest.json')
// Snapshot files are deployment assets, independent of the ignored research checkout.
for (const [name, entry] of Object.entries(manifest.resources)) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(new URL(name, directory))).digest('hex')
  if (digest !== entry.sha256) throw new Error(`无线知识快照校验失败：${name}`)
}
const ontology = read('ontology.json')
const signaturePolicies = read('signature-policy.json')
const linkPolicies = read('link-policy.json')
const cases = read('cases.json')
const lessons = read('lessons.json')
const policies = new Map(signaturePolicies.map(row => [row.signature_id, row]))
const links = new Map()
for (const row of linkPolicies) {
  for (const id of [row.left_signature_id, row.right_signature_id]) {
    if (!links.has(id)) links.set(id, [])
    links.get(id).push(row)
  }
}
const ontologyPath = 'data/raw/action_ontology/action_ontology_reviewed_draft_v2.json'
const reference = sourcePath => ({ source_path: sourcePath, ...manifest.sources[sourcePath] })
const normalize = value => String(value ?? '').toLowerCase().replaceAll(/[\s_\-\/]+/g, '')
export const vendorName = value => ({ huawei: '华为', zte: '中兴' }[normalize(value)] || normalize(value))
export const systemName = value => ({ '4g': 'lte', '5g': 'nr' }[normalize(value)] || normalize(value))
const limitOf = value => {
  if (value === undefined) return 6
  if (!Number.isInteger(value) || value < 1 || value > 12) throw new Error('limit 必须为 1 至 12 的整数')
  return value
}

const parameters = ontology.ontology_candidates.map(row => {
  const [vendor, system, parameterName, schemeName] = row.reason.split(';').map(x => x.trim())
  return { ...row, vendor, system, parameter_name: parameterName, scheme_name: schemeName,
    evidence_type: 'parameter_semantic_annotation',
    signature_policy: policies.get(row.signature_id) || null,
    reviewed_link_policies: links.get(row.signature_id) || [],
  }
})

// These aliases expand retrieval only. They never authorize merging vendor-local identities.
const aliases = [
  ['qrxlevmin', '最低接收电平', '最小接入电平', '最低接入电平'],
  ['snonintrasearch', '异频/异系统测量启动门限', '异频异系统测量启动门限'],
  ['hocfgswitch', '切换控制开关'],
  ['低接通', '接通率', '低接通用户占比高小区'],
  ['切换差', '切换差小区'],
  ['低速率', '速率低', '吞吐低', '吞吐下降', '下载慢'],
  ['智能预调度', '智能预调度持续时间系数'],
  ['msg3', 'msg3 harq'],
  ['经验', '经验性结论', '研究结论'],
]
const identityTerms = [...new Set([
  ...parameters.flatMap(row => [row.parameter_name, row.canonical_action_id, row.parameter_concept_id]),
  ...cases.flatMap(row => [row.case_id, row.context.problem, ...row.actions.flatMap(a => [a.parameter, a.parameter_cn, a.scheme_id])]),
  ...lessons.flatMap(row => [row.lesson_id, ...row.keywords]),
].filter(Boolean))]

function termsOf(query) {
  const normalized = normalize(query)
  if (!normalized) return []
  const terms = new Set([normalized])
  const identities = identityTerms.map(normalize).filter(value => value.length >= 2 && normalized.includes(value))
  // ASCII words work for parameter names/IDs; Chinese identity terms work inside natural questions.
  for (const token of String(query).match(/[a-z0-9_]+/gi) || []) {
    const value = normalize(token)
    if (value.length >= 3 && !identities.some(other => other !== value && other.includes(value))) terms.add(value)
  }
  // Specific parameter identities dominate contained generic words, e.g. a full punishment
  // timer name must not degrade to the generic research keyword "失败".
  for (const value of identities) {
    if (!identities.some(other => other !== value && other.includes(value))) terms.add(value)
  }
  for (const group of aliases) {
    if (group.some(word => {
      const value = normalize(word)
      return terms.has(value) || (normalized.includes(value) &&
        !identities.some(other => other !== value && other.includes(value)))
    })) {
      for (const word of group) terms.add(normalize(word))
    }
  }
  return [...terms]
}

export function matches(query, fields) {
  const terms = termsOf(query)
  const hits = fields.filter(Boolean).filter(field => {
    const text = normalize(field)
    return terms.some(term => text.includes(term))
  })
  return { relevance_score: hits.length, matched_fields: [...new Set(hits)] }
}

export function catalogStatus() {
  return {
    snapshot: { repository: manifest.repository, commit: manifest.commit, date: manifest.snapshot_date },
    counts: {
      parameter_signatures: parameters.length,
      canonical_action_labels: new Set(parameters.map(row => row.canonical_action_id)).size,
      parameter_concepts: new Set(parameters.map(row => row.parameter_concept_id)).size,
      case_entries: cases.length,
      onboarding_demo_traces: 1,
      narrative_case_summaries: 3,
      research_lessons: lessons.length,
    },
    capabilities: ['parameter_semantics', 'bounded_case_retrieval', 'research_lessons', 'declared_parameter_constraints',
      'persisted_workorders', 'aligned_current_evidence', 'referenced_root_cause_hypotheses', 'before_after_evaluation',
      'pinned_rule_compilation', 'versioned_memory_readout', 'echo_source_qa', 'versioned_candidate_plans',
      'execution_feedback_ledger', 'workorder_event_history', 'sourced_candidate_ranker',
      'bounded_candidate_selection', 'sourced_current_value_adaptation'],
    limitations: ['未预置全量生产历史包；用户提供的历史可通过编译工具生成本地版本。',
      '现场观测使用用户提供的数据；校准 gate 未加载，不执行参数下发。'],
  }
}

export function knowledgeQuery({ query, kind = 'all', vendor, system, operation_family, limit } = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('query 不能为空')
  if (!['all', 'parameters', 'lessons'].includes(kind)) throw new Error('未知 kind')
  const count = limitOf(limit)
  const terms = termsOf(query)
  const identitiesOf = row => [row.parameter_name, row.canonical_action_id, row.parameter_concept_id]
  const directMatch = row => identitiesOf(row).some(field => terms.some(term => normalize(field).includes(term)))
  const specificParameter = parameters.some(row => identitiesOf(row).some(field => terms.includes(normalize(field))))
  const scored = kind === 'lessons' ? [] : parameters
    .filter(row => (!vendor || vendorName(row.vendor) === vendorName(vendor)) &&
      (!system || systemName(row.system) === systemName(system)) &&
      (!operation_family || row.operation_family === operation_family))
    .filter(row => !specificParameter || directMatch(row))
    .map(row => ({ ...row, ...matches(query, [row.parameter_name, row.scheme_name,
      row.canonical_action_id, row.parameter_concept_id, row.effect_direction, row.reason]) }))
    .filter(row => row.relevance_score > 0)
    .sort((a, b) => b.relevance_score - a.relevance_score || a.signature_id.localeCompare(b.signature_id))
  // Show distinct action/direction/policy identities before repetitive signatures. This is
  // presentation diversity, not evidence aggregation; every result retains its own signature.
  const seen = new Set(), first = [], remaining = []
  for (const row of scored) {
    const key = [row.canonical_action_id, row.parameter_concept_id, row.vendor, row.system,
      row.signature_policy?.hard_aggregation_policy].join('|')
    if (seen.has(key)) remaining.push(row)
    else { seen.add(key); first.push(row) }
  }
  const ranked = [...first, ...remaining]
  const foundLessons = kind === 'parameters' ? [] : lessons
    .map(row => ({ ...row, ...matches(query, [row.title, ...row.keywords, row.finding, row.application]) }))
    .filter(row => row.relevance_score > 0)
    .sort((a, b) => b.relevance_score - a.relevance_score)
  // Return application evidence in the same read as parameter semantics. Keep the
  // entire submitted bundle: a matching parameter does not inherit the bundle's outcome.
  const related = kind === 'lessons' ? { cases: [], total_matches: 0, truncated: false }
    : caseSearch({ query, vendor, system, limit: count })
  const applications = related.cases.map(row => {
    const matchedActions = row.actions.filter(action => matches(query,
      [action.parameter, action.parameter_cn, action.scheme_id]).relevance_score > 0)
    return { ...row, matched_actions: matchedActions,
      application_boundary: '动作与前后值说明当时怎样调整；调整原因只使用已记录原因或所问参数已核对的机制。共同动作没有在本次语义查询中核实的作用，不补写因果链。',
    }
  })
  return {
    ...catalogStatus(), query,
    results: {
      parameters: ranked.slice(0, count), lessons: foundLessons.slice(0, count),
      case_applications: applications, total_case_matches: related.total_matches,
      cases_truncated: related.truncated,
      total_parameter_matches: ranked.length, total_lesson_matches: foundLessons.length,
      truncated: ranked.length > count || foundLessons.length > count,
    },
    references: ranked.length ? [reference(ontologyPath),
      reference('data/raw/action_ontology/action_ontology_signature_policy_v2.csv'),
      reference('data/raw/action_ontology/action_ontology_link_policy_v2.csv')] : [],
    interpretation: [
      'effect_direction 是原材料的作用方向解释/优化意图，不是本次现场效果证明；confidence 是语义标注置信度。',
      'needs_human_review 保留原材料标记；hard_aggregation_policy 仅为签名归并许可，不是参数执行许可。',
      '参数中文别名仅用于检索；保留厂家、制式、原签名与方向，不将相似名称自动归并。',
      '先展示不同动作/方向/归并政策的代表签名以减少重复；这是显示排序，不是证据合并。',
      '未命中时表示当前快照缺少相关材料，不能强行映射为已知参数。',
      'case_applications 用于解释参数在工单或研究案例中的用法。matched_actions 只是所问动作；完整 actions 与 outcome 保留组合及实际执行/推荐的区别。',
      '讲清工单问题、调整目的、实际前后值、同时采取的动作、记录的结果与适用边界；资料交由智能体消化，不要求用户跳转源码理解。',
      '参数问答说明机制、可比历史应用和当前条件，保留简短案例标识及依据；用历史检索入口自动补查本地记忆包，未命中如实说明。',
      'SNonIntraSearch 的厂家版本、单位和测量触发不等式尚未核实：历史 25→27 只说明门限改变，不能称其放宽或收紧测量触发、促进或抑制异频测量、让用户更容易转向其他频层。',
      '参数值的口径写成独立句，例如“这些数值沿用历史记录的编码，材料未提供物理单位口径。”不要在 -64 调到 -62 后插入括号说明。',
    ],
  }
}

export function caseSearch({ query = '', vendor, system, evidence_type, limit } = {}) {
  if (typeof query !== 'string') throw new Error('query 必须是字符串')
  const count = limitOf(limit)
  const ranked = cases.filter(row => (!evidence_type || row.evidence_type === evidence_type) &&
    (!system || !row.context.system || systemName(row.context.system) === systemName(system)) &&
    (!vendor || !row.context.vendor || vendorName(row.context.vendor) === vendorName(vendor)))
    .map(row => {
      const match = query.trim() ? matches(query, [row.case_id, row.title, row.context.problem,
        ...row.actions.flatMap(a => [a.parameter, a.parameter_cn, a.scheme_id])]) : { relevance_score: 0, matched_fields: [] }
      const contextComparison = {}
      for (const [key, expected] of [['vendor', vendor], ['system', system]]) {
        if (expected) contextComparison[key] = { requested: expected, historical: row.context[key],
          status: row.context[key] ? 'matches' : 'unknown_requires_confirmation' }
      }
      return { ...row, ...match, context_comparison: contextComparison }
    })
    .filter(row => !query.trim() || row.relevance_score > 0)
    .sort((a, b) => b.relevance_score - a.relevance_score || a.case_id.localeCompare(b.case_id))
  return { ...catalogStatus(), query, cases: ranked.slice(0, count), total_matches: ranked.length,
    truncated: ranked.length > count,
    interpretation: [
      'relevance_score 是字段检索命中数，不是因果可信度或成功概率。',
      '四个条目混合演示与案例摘要，不用于计算历史成功率。',
      'actions.role 区分实际执行、演示、推荐与 gold 对照；outcome.scope 决定结果能说明什么。',
      '厂家/制式未知的条目仅作参考，不能当成已匹配当前厂家版本；不从历史范围推定当前范围。',
    ] }
}

function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function parameterCheck(args = {}) {
  if (typeof args.parameter !== 'string' || !args.parameter.trim()) throw new Error('parameter 不能为空')
  const checks = [], missing = []
  const provided = key => args[key] !== undefined && args[key] !== null && args[key] !== ''
  const add = (name, passed, detail) => checks.push({ name, status: passed ? 'pass' : 'fail', detail })
  for (const key of ['current', 'target', 'unit', 'constraint_source']) if (!provided(key)) missing.push(key)
  const current = numeric(args.current), target = numeric(args.target)
  const enumMode = Array.isArray(args.enum_values) && args.enum_values.length > 0
  if (enumMode) {
    add('constraint_mode', !['min', 'max', 'step', 'step_base'].some(provided), '枚举约束与数值范围/步长不能混用。')
    for (const key of ['current', 'target']) if (provided(key)) {
      add(`${key}_enum`, args.enum_values.some(value => String(value) === String(args[key])),
        { value: args[key], allowed_values: args.enum_values })
    }
  } else {
    if (provided('current')) add('current_numeric', current !== null, { value: args.current })
    if (provided('target')) add('target_numeric', target !== null, { value: args.target })
    for (const key of ['min', 'max']) if (!provided(key)) missing.push(key)
    if (provided('min') && provided('max')) {
      const min = numeric(args.min), max = numeric(args.max)
      const validRange = min !== null && max !== null && min <= max
      add('range_definition', validRange, { min: args.min, max: args.max })
      if (validRange && target !== null) add('target_range', target >= min && target <= max, { min, max, target })
      if (validRange && current !== null) add('current_range', current >= min && current <= max, { min, max, current })
    }
    if (provided('step')) {
      const step = numeric(args.step)
      const base = provided('step_base') ? numeric(args.step_base) : provided('min') ? numeric(args.min) : null
      add('step_definition', step !== null && step > 0, { step: args.step })
      if (base === null) missing.push('step_base')
      if (step !== null && step > 0 && base !== null && target !== null) {
        const quotient = (target - base) / step
        add('target_step', Number.isFinite(quotient) && Math.abs(quotient - Math.round(quotient)) <= 1e-8,
          { target, step, base, base_source: provided('step_base') ? 'step_base' : 'declared_min' })
      }
    }
  }
  const failed = checks.some(check => check.status === 'fail')
  const delta = current !== null && target !== null ? target - current : null
  return {
    parameter: args.parameter, status: failed ? 'blocked' : missing.length ? 'needs_data' : 'constraints_pass',
    current: args.current ?? null, target: args.target ?? null,
    delta: Number.isFinite(delta) ? delta : null,
    direction: delta === null ? 'enum_or_unknown' : delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'unchanged',
    unit: args.unit || null, constraint_source: args.constraint_source || null,
    checks, missing_fields: [...new Set(missing)],
    context_needed: ['厂家及软件版本、制式与参数对象身份', '当前快照时间与取值口径', '问题 KPI、场景证据和相应观察窗口'],
    rollback_reference: { value: args.current ?? null, scope: '仅为输入当前值；执行前需核对快照及相关配置。' },
    interpretation: 'constraints_pass 仅表示用户声明的范围/枚举及已提供步长约束通过；不验证声明来源，不等于优化有效或允许下发。未提供步长时不声称步长已检查。',
  }
}
