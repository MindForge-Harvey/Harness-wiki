import fs from 'node:fs'
import crypto from 'node:crypto'
import { mechanisms } from './mechanisms.js'

const resources = new URL('../resources/', import.meta.url)
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', resources)))
const bytes = fs.readFileSync(new URL('echo-corpus.json', resources))
if (crypto.createHash('sha256').update(bytes).digest('hex') !== manifest.resources['echo-corpus.json'].sha256) {
  throw new Error('ECHO-Mem 语料校验失败')
}
const corpus = JSON.parse(bytes)
if (corpus.commit !== manifest.commit) throw new Error('ECHO-Mem 来源版本不一致')
const skillBytes = fs.readFileSync(new URL('echo-skill-corpus.json', resources))
if (crypto.createHash('sha256').update(skillBytes).digest('hex') !== manifest.resources['echo-skill-corpus.json'].sha256) throw new Error('ECHO-Mem Skill 语料校验失败')
const skillCorpus = JSON.parse(skillBytes)
if (skillCorpus.commit !== corpus.commit) throw new Error('ECHO-Mem Skill 来源版本不一致')
const prefix = 'echo-mem-reproducibility/'
const files = new Map([...corpus.files, ...skillCorpus.files].map(file => [file.source_path, file]))
for (const file of files.values()) {
  if (crypto.createHash('sha256').update(file.content).digest('hex') !== file.sha256) throw new Error(`ECHO-Mem 来源校验失败：${file.source_path}`)
}
const ref = (name, start, end) => {
  const sourcePath = files.has(name) ? name : prefix + name
  const file = files.get(sourcePath)
  if (!file) throw new Error(`ECHO-Mem 来源不存在：${sourcePath}`)
  return { source_path: sourcePath, sha256: file.sha256,
    url: `${corpus.repository}/blob/${corpus.commit}/${sourcePath}${start ? `#L${start}-L${end || start}` : ''}`,
    ...(start ? { start_line: start, end_line: end || start } : {}) }
}

// Maintained Chinese reading guides, with original protocol/code available below each guide.
const topics = [
  ['overview', 'ECHO-Mem 全链路与双层读取', ['echo-mem', 'echomem', '原理', '架构', '全链路', '双层', '两层', '是什么'],
    'ECHO-Mem 把历史优化 Trace 经证据准入与归因，编译成可追溯记忆、状态、评分和证据画像，再为新工单提供案例、候选动作与风险依据。结构关系负责说明“曾怎样组成方案”，结果证据负责说明“何种作用域下观察到效果”；两者不能互换。研究消费者固定特征、排序与 Review 队列后才揭示目标结果。',
    ['README.md', 'docs/protocols/evidence_authority_propagation.md', 'docs/protocols/exact_consumer_contract.md']],
  ['trace', 'Trace、动作、执行与评价记录', ['trace', '工单记录', '执行记录', '反馈', '字段', '日志', 'action', '下发', '回退'],
    '源 TraceRecord 一张工单对应一条 Trace，ticket 保存场景，actions 保存参数前后值、方案、下发、执行、失败原因和回退，source 保留数据集与采集来源。动作/长评结果属于事后证据，不是新工单的决策时输入。当前工单账本不是源 TraceRecord；未经字段映射、来源核对和评价可见性声明，不能直接编译成历史效果。',
    ['schemas/trace_record.schema.json', 'docs/DATA_INTERFACE.md', 'pipeline/compile/outcome_compilation.py']],
  ['authority', 'Evidence Authority 与组合归因', ['evidence authority', '归因', '组合', 'bundle', 'action-direct', 'action_direct', '整单', '混合', '广播'],
    '整单/组合评价保持 Bundle-direct。只有严格单动作提交方案的提交与实际执行作用域一致，才可沿用 action-direct；多动作方案仅一项执行成功也不能缩窄成单动作归因。其他组件关系为结构关联。long_eval_mixed 是执行混合的组合结果，不能进入原子的二元 Pass/Fail 直接证据通道。',
    ['docs/protocols/evidence_authority_propagation.md', 'pipeline/compile/outcome_compilation.py']],
  ['compilation', '证据编译与六类记忆', ['编译', '六类', '六种', 'memory', '记忆', 'case_memory', 'rca_memory', 'strategy_memory', 'playbook_memory', 'risk_memory', 'counter_evidence_memory'],
    '六类输出：Case 保存案例与源链；RCA 汇聚源根因标签；Strategy 描述参数动作模式；Playbook 表达动作组合；Risk 保存流程/执行约束；Counter-evidence 保存有范围的历史反证。输入决定哪些类型实际形成。动作直接效果按 authority 字段判断，不按记忆类型作排他断言；反证的 action_profiles 也可在严格局部端点下带 action_direct。去重、准入和归因先于聚合，组件出现次数不是独立效果次数；方案结构也不能补出未执行动作的效果。',
    ['pipeline/compile/compile_rules.py', 'pipeline/common/compile_eligibility.py', 'schemas/memory_object.schema.json']],
  ['state', '生命周期与 validated 的含义', ['生命周期', '状态', 'validated', 'reusable', 'restricted', 'unverified', 'draft', '根因正确'],
    '源状态机按类型使用不同规则。RCA 的 validated 表示源 type1/type2 标签边界，不证明根因正确；Risk 为信息性的过程风险。Strategy/Case 缺有效评估时为 unverified，执行失败和强历史反证走不同状态。生命周期是知识治理元数据，不直接等于优化成功概率，也不直接授予下发许可。阈值和顺序应读取固定版本代码。',
    ['pipeline/transition/state.py', 'pipeline/shadow/retrieve.py', 'docs/protocols/governed_publication_readout.md']],
  ['scoring', 'Beta 后验、可信度下界与证据画像', ['beta', 'lcb', '可信度', '后验', '成功率', '失败概率', '评分', '小样本', '画像', 'profile'],
    '效果可信度使用获得授权的 long_eval Pass/Fail 次数，先验默认 Beta(1,1)，后验 Beta(1+s,1+f)，有评估时 LCB 默认取 0.05 分位；保留原始比例与样本数，小样本 1/1 不等于稳定 100% 有效。零评估时源实现 raw_pass_rate=None，credibility_lcb 字段回退到先验均值，不能作为效果支持。缺评估的 Strategy/Case 为 unverified；RCA 标签与 Risk 使用独立类型规则。支持总数、结构关联、RCA 标签不补成效果计数。Evidence Profiles 显式保留支持、反证与作用域；分数对其历史总体成立，不自动变成当前小区成功率。',
    ['pipeline/scoring/bayesian_score.py', 'pipeline/compile/memory_evidence_profiles.py', 'schemas/memory_evidence_profile.schema.json']],
  ['retrieval', '历史案例、候选池与结构选择', ['检索', '召回', 'selector', 'ranker', '候选', '排序', '案例对比', 'episode'],
    '源读取链区分案例/episode 入口、策略/组合候选、反证和灰区复核；源正向策略/组合候选取 validated/reusable，restricted 走 review 通道，counter_evidence 走反证池。场景、参数身份、动作方向、边界和来源必须匹配，具体投影与权重取决于冻结实验契约。本地历史检索是可解释字段召回；候选可按需交源 ranker 实际排序，完整结构导航与校准 gate 仍未接入。',
    ['pipeline/shadow/retrieve.py', 'pipeline/selection/plan_ranker.py', 'docs/protocols/exact_consumer_contract.md']],
  ['value', '从历史动作到当前参数目标', ['当前值', '目标值', '幅度', '参数适配', '数值', '步长', '边界', '值选择', 'value selector'],
    '参数语义、调整方向、具体数值和厂家局部身份需要分别核对。源值选择器读取当前 snapshot 的值和范围等上下文；历史前后值只是历史动作。未知当前值、范围、单位编码或步长时不能复制旧值作为现场目标。当前工具检查用户声明的约束，不加载厂家口径证书，也不执行配置下发。',
    ['pipeline/selection/action_value_selector.py', 'pipeline/common/parameter_range.py', 'docs/protocols/structural_identity_granularity.md']],
  ['gate', 'Fail-Cohort 风险门控与 Review', ['gate', '门控', '否决', '风险决策', 'review', 'accept', '自动放行', '校准', 'fail-cohort', 'failcohort'],
    '源风险门控匹配具体参数、方向、边界和反证，区分诊断性宽场景先验、灰区复核和强反证，依赖冻结配置与风险校准产物。门控分数不天然等于失败概率。当前 Harness 未加载校准 gate；可以解释代码和提出条件建议，不能生成研究 Auto/accept 证书或凭 validated 状态自动放行。',
    ['pipeline/selection/failcohort_veto_gate.py', 'docs/protocols/exact_consumer_contract.md']],
  ['publication', '冻结包、治理发布与读出', ['发布', '冻结', '版本包', '校验和', 'publication', 'checksum', 'package', '治理'],
    'MemoryPackage 给产物固定版本与校验和，冻结包与线上治理发布是不同阶段。锁定 D.3 消费者只读形成 Memory 端点的 Bundle Evidence Profiles，匹配问题、厂家、制式和方案组；未物化、Trace/Audit-only 与执行混合记录不进入二元风险信号。Jaccard 和 0.5/0.5 融合为该冻结消费者契约，不能推广成所有网优算法。',
    ['pipeline/package/build.py', 'schemas/memory_package.schema.json', 'docs/protocols/governed_publication_readout.md']],
  ['replay', '时序可见性、成熟窗口与防泄漏', ['时序', '回放', 'replay', '泄漏', '截止', '成熟', '可见', '静态', '自适应', 'static', 'adaptive'],
    '时序回放按 test-then-learn：先冻结当前窗决策，后揭示结果。Static 用冻结 P0，Adaptive 只可增用窗口开始前严格已可见的历史，最后不完整窗口作删失。时间戳、评价可见时间和长评成熟不能混为一谈。当前编译器以截止时间、七天执行成熟及用户评价可见性声明过滤，但没有运行完整 Static/Adaptive 回放。',
    ['docs/protocols/continual_replay.md', 'pipeline/compile/temporal_evidence.py', 'pipeline/evaluation/leakage_check.py']],
  ['experiments', '研究实验、指标与复现边界', ['实验', '复现', '论文', 'table', 'q1', 'q2', 'q3', '预期', '合成', 'synthetic', '统计检验'],
    '公开例子验证确定性编译，论文规模实验还需要受控数据、冻结 sidecar、初始 bootstrap 或 decision-time ledger。重建层级分别为端到端精确、从冻结中间产物精确、新账本精确指标与仅冻结参考。源码/expected 数字不是本机实测，不把研究开发集审计当成现场指南。当前快照 README 提到的四条合成 Trace 文件未被 Git 跟踪，不能声称已完整跑通其 verify。',
    ['docs/RECONSTRUCTION_LEVELS.md', 'docs/LOCKED_MANUSCRIPT_COVERAGE.md', 'docs/protocols/statistics_gate.md', 'README.md']],
]
export const echoTopics = topics.map(([id, title, keywords, explanation, sources]) => ({
  id, title, keywords, explanation, references: sources.map(name => ref(name)),
}))
const normalize = value => String(value || '').toLowerCase().replace(/[\s_-]+/g, '')
const chunks = [...files.values()].flatMap(file => {
  const lines = file.content.split('\n'), result = []
  for (let start = 0; start < lines.length; start += 26) {
    const end = Math.min(lines.length, start + 32)
    const text = lines.slice(start, end).join('\n')
    if (text.trim()) result.push({ source_path: file.source_path, start_line: start + 1, end_line: end, text,
      normalized: normalize(text) })
  }
  return result
})

export function echoStatus() {
  return { source_commit: corpus.commit, source_files: corpus.files.length,
    upstream_skill_files: skillCorpus.files.length, source_chunks: chunks.length,
    integrated: ['原理/协议/源码检索', '工单阶段与方案版本记录', '用户执行/回退反馈记录',
      '同口径前后效果比较', '固定源规则编译、状态评分与本地冻结包读取',
      '源候选排序、受限 ID 选择与当前快照值适配'],
    not_connected: ['现场 OMC/网管下发与回退接口', '完整研究结构导航与端到端消费者',
      '校准 Fail-Cohort gate 与自动放行', '线上治理发布与完整 Static/Adaptive 回放'],
    source_artifact_issue: 'README 描述的 examples/synthetic/trace_records.jsonl 未被固定提交跟踪；现有单条 onboarding demo 是另一份资料，不替代四条预期验收。',
    interpretation: '这是来源问答能力与当前集成状态；检索源码不表示已执行其中所有研究实验。' }
}

export function echoQuery({ query = '', topic, view = 'knowledge', source_path, start_line = 1, limit = 5 } = {}) {
  if (typeof query !== 'string' || query.length > 2000) throw new Error('query 必须为最多 2000 字符的字符串')
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('limit 必须为 1 至 8 的整数')
  if (topic && !echoTopics.some(row => row.id === topic)) throw new Error('未知 ECHO-Mem topic')
  if (!['knowledge', 'implementation'].includes(view)) throw new Error('未知 ECHO-Mem view')
  if (source_path) {
    const sourcePath = files.has(source_path) ? source_path : prefix + source_path
    const file = files.get(sourcePath)
    if (!file) throw new Error('source_path 不在固定 ECHO-Mem 文本语料中')
    const lines = file.content.split('\n')
    if (!Number.isInteger(start_line) || start_line < 1 || start_line > lines.length) throw new Error('start_line 超出来源范围')
    const end = Math.min(lines.length, start_line + 79)
    const original = lines.slice(start_line - 1, end).join('\n')
    return { runtime: echoStatus(), guides: [], passages: [{ reference: ref(sourcePath, start_line, end),
      text: original.slice(0, 12000), truncated: original.length > 12000, total_lines: lines.length }], total_matches: 1 }
  }
  const normalized = normalize(query)
  const ranked = echoTopics.map(row => ({ ...row, score: (topic === row.id ? 100 : 0) +
    row.keywords.filter(word => normalized.includes(normalize(word))).reduce((n, word) => n + (normalize(word).length >= 4 ? 3 : 1), 0) }))
    .filter(row => row.score > 0 && (!topic || row.id === topic)).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const guides = ranked.slice(0, 3)
  if (view === 'knowledge') {
    const picked = !normalized && !topic ? [echoTopics[0]] : guides
    return { view, query,
      ...(!normalized && !topic ? { topics: echoTopics.map(({ id }) => ({ id, title: mechanisms[id].title })) } : {}),
      guides: picked.map(row => ({ id: row.id, ...mechanisms[row.id],
        references: row.references.map(reference => ({ title: mechanisms[row.id].title, url: reference.url })) })),
      ...(topic === 'experiments' || /目前|当前.*(?:能力|接入|执行)|能.*(?:执行|记录)|实际.*(?:执行|能力)/.test(query)
        ? { runtime: echoStatus() } : {}),
      example_scope: '例子只用于说明机制，不是新增的实测历史案例。',
      status: picked.length ? 'source_evidence_available' : 'no_source_match',
    }
  }
  const words = [...new Set([
    ...(query.match(/[a-z0-9_]{3,}/gi) || []).map(normalize).filter(word => !['echo', 'mem', 'echomem'].includes(word)),
    ...guides.flatMap(row => row.keywords.filter(word => normalized.includes(normalize(word))).map(normalize)),
  ])]
  const preferred = new Set(guides.flatMap(row => row.references.map(reference => reference.source_path)))
  const scored = chunks.map(row => {
    const hits = words.filter(word => row.normalized.includes(word))
    return { row, score: hits.length * 2 + (preferred.has(row.source_path) ? 12 : 0) +
      (row.source_path.includes('/docs/') ? 1 : 0) }
  }).filter(row => (ranked.length || words.length) && row.score > 1 &&
    (!topic || preferred.has(row.row.source_path)))
    .sort((a, b) => b.score - a.score || a.row.source_path.localeCompare(b.row.source_path) || a.row.start_line - b.row.start_line)
  // Cover multiple protocols/functions before returning adjacent slices of the same file.
  const selected = [], seen = new Set()
  for (const item of scored) {
    if (seen.has(item.row.source_path)) continue
    selected.push(item); seen.add(item.row.source_path)
    if (selected.length === limit) break
  }
  for (const item of scored) {
    if (selected.length === limit) break
    if (!selected.includes(item)) selected.push(item)
  }
  return { runtime: echoStatus(), ...(!normalized && !topic ? { topics: echoTopics.map(({ id, title }) => ({ id, title })) } : {}),
    guides: (!normalized && !topic ? [echoTopics[0]] : guides).map(({ score, keywords, ...row }) => row),
    passages: selected.map(({ row, score }) => ({ reference: ref(row.source_path, row.start_line, row.end_line),
      text: row.text.slice(0, 4200), truncated: row.text.length > 4200, relevance_score: score })),
    total_matches: scored.length, status: ranked.length || selected.length || !normalized ? 'source_evidence_available' : 'no_source_match' }
}
