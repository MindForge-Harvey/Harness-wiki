import { knowledgeQuery, caseSearch, parameterCheck } from './catalog.js'
import { createWorkorderStore } from './workflow.js'
import { createMemoryService } from './compiler.js'
import { echoQuery } from './echo.js'
import { createHistorySearch } from './history.js'
import { createDecisionService } from './decision.js'

export const name = 'dsh-wireless'
export const inject = ['tools']
const string = description => ({ type: 'string', description })
const scalar = { oneOf: [{ type: 'number' }, { type: 'string' }] }
const filterProperties = {
  query: string('具体参数名、问题类型、方案编号或经验主题；自然语言也可。'),
  vendor: string('可选厂家筛选，如华为、中兴；未知厂家案例将明确标记为需确认。'),
  system: string('可选制式，如 LTE/NR（兼容 4G/5G）。'),
  limit: { type: 'integer', description: '返回上限，1 至 12；默认 6。' },
}
const definitions = [
  {
    name: 'wireless_echo_query',
    description: '查询 ECHO-Mem 如何把历史网优过程变成可复用经验，并用于新工单。默认返回中文机制解释、说明性工单例子、使用方法与出处；涵盖归因、六类经验、可信度、案例比对、参数适配、风险与记录。只有用户明确询问源码、字段、算法实现或复现细节时才使用 implementation 模式读取原文。',
    parameters: { type: 'object', properties: {
      query: string('原理或实现问题；空字符串返回阅读目录。'),
      topic: { type: 'string', enum: ['overview', 'trace', 'authority', 'compilation', 'state', 'scoring', 'retrieval', 'value', 'gate', 'publication', 'replay', 'experiments'] },
      view: { type: 'string', enum: ['knowledge', 'implementation'], description: '默认 knowledge：解释机制如何解决网优问题；明确问源码实现时才用 implementation。' },
      source_path: string('前次结果提供的固定源路径，按实际片段继续阅读；不要猜路径。'),
      start_line: { type: 'integer', description: 'source_path 模式的起始行，默认 1，每次最多 80 行。' },
      limit: { type: 'integer', description: '原文片段上限 1 至 8，默认 5。' },
    }, additionalProperties: false },
    execute: echoQuery,
  },
  {
    name: 'wireless_knowledge_query',
    description: '一次查询同时返回无线参数含义、调整方向和相关工单/案例中的实际用法。case_applications 保留工单问题、匹配动作、完整组合、参数前后值、执行或推荐角色、结果及边界。回答需消化成中文说明，结合工单讲为什么调、怎么调和已知效果；来源供内部核对。语义标注不是效果统计，不编造缺失的案例或改善幅度。',
    parameters: { type: 'object', properties: { ...filterProperties,
      kind: { type: 'string', enum: ['all', 'parameters', 'lessons'], description: '默认 all；parameters 查语义，lessons 查研究经验。' },
      operation_family: { type: 'string', enum: ['coverage', 'capacity', 'handover', 'access', 'interference', 'other'] },
    }, required: ['query'], additionalProperties: false },
    execute: knowledgeQuery,
  },
  {
    name: 'wireless_case_search',
    description: '只读检索已接入的 4 个无线案例条目（1 个演示 Trace、3 个案例摘要）。返回实际执行/推荐/gold 角色、参数前后值、工单级效果作用域、适用差异及原始来源；空 query 列出全部。没有全量历史成功率。',
    parameters: { type: 'object', properties: { ...filterProperties,
      evidence_type: { type: 'string', enum: ['onboarding_demo', 'anonymized_real_case_summary', 'published_experiment_case_summary'] },
    }, additionalProperties: false },
    execute: caseSearch,
  },
  {
    name: 'wireless_parameter_check',
    description: '根据明确提供的当前值、目标值、单位与约束来源，确定性检查数值范围/已提供步长或枚举约束，计算幅度和回滚参考。缺失信息返回 needs_data；不自动从历史案例填当前值/范围，不下发配置。',
    parameters: { type: 'object', properties: {
      parameter: string('参数名称及必要对象，如 CELLSEL.QRxLevMin。'),
      current: { ...scalar, description: '用户提供的当前值；缺失则留空。' },
      target: { ...scalar, description: '用户提供或明确讨论的候选目标值。' },
      min: { type: 'number', description: '当前厂家版本认可的最小值；不要借用历史案例范围。' },
      max: { type: 'number', description: '当前厂家版本认可的最大值。' },
      step: { type: 'number', description: '已知允许步长；未知时省略，不假定为 1。' },
      step_base: { type: 'number', description: '步长格点基准；省略时使用已声明 min，不能默认为 0。' },
      enum_values: { type: 'array', items: scalar, description: '允许的枚举值，与数值范围模式互斥。' },
      unit: string('用户提供的物理单位或源编码口径；不自动换算 dBm。'),
      constraint_source: string('约束来自哪个当前配置/手册/用户声明；工具只检查所声明约束。'),
    }, required: ['parameter'], additionalProperties: false },
    execute: parameterCheck,
  },
]

export function apply(ctx) {
  const workorder = createWorkorderStore()
  const memory = createMemoryService()
  const decision = createDecisionService({ memory })
  const workflowDefinitions = [
    {
      name: 'wireless_echo_decision',
      description: '按需执行固定 ECHO-Mem 源候选排序、给定候选 ID 选择或当前快照值适配，三种能力独立调用，不强制整套流程。只接受实际历史包中的 validated/reusable 策略/组合；源 LCB/四项排序不等于当前成功率。选择动作从冻结候选填充，不能创造表外参数或统计；值适配不推定现值。未执行校准 gate 或网管下发。',
      parameters: { type: 'object', properties: {
        operation: { type: 'string', enum: ['rank_candidates', 'select_candidate', 'adapt_value'] },
        candidate_refs: { type: 'array', maxItems: 24, items: { type: 'object', properties: {
          package_id: string('历史检索返回的本地包版本。'), memory_id: string('该包内的策略/组合 ID。'),
        }, required: ['package_id', 'memory_id'], additionalProperties: false } },
        candidate_ref: { type: 'object', properties: { package_id: string('历史包 ID。'), memory_id: string('具体策略 ID。') },
          required: ['package_id', 'memory_id'], additionalProperties: false },
        context: { type: 'object', properties: Object.fromEntries(['issue_type', 'vendor', 'system', 'region', 'band'].map(key => [key, string('当前已知事实，未知省略。')])), additionalProperties: false },
        root: { type: 'object', properties: { root_cause_key: string('本轮根因假设键。'), root_cause_l2: string('本轮二级根因假设。') }, additionalProperties: false },
        parameter_clues: { type: 'object', properties: Object.fromEntries(['parameter_semantic_id', 'param_object', 'param_en_name', 'site_param_object', 'site_param_en_name'].map(key => [key, { type: 'array', items: { type: 'string' } }])), additionalProperties: false },
        as_of: string('带时区决策截止时间；省略用当前时间。'),
        candidate_set_id: string('排序或选择返回的候选集 ID，在当前进程有效一小时；也可用本轮 candidate_refs 直接选择。'),
        selected_candidate_id: string('候选集内的 candidate_id；直接选择时由实际 package_id:memory_id 组成，必须属于本轮 candidate_refs。'),
        current_snapshot: { type: 'object', properties: {
          parameter: string('与策略一致的参数身份。'), current_value: { type: 'number' },
          min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' }, step_base: { type: 'number' },
          unit: string('当前单位或源编码口径。'), source_ref: string('真实当前快照来源。'), constraint_source: string('当前范围/步长来源。'),
        }, additionalProperties: false },
      }, required: ['operation'], additionalProperties: false }, execute: decision,
    },
    {
      name: 'wireless_history_search',
      description: '根因、数据、参数应用和方案分析的必经历史检索：自动查询已有案例、参数经验、研究结论以及本地冻结记忆包中的六类经验，无需用户提供包 ID。返回实际检索范围、命中/未命中、真实生产库未接入状态，以及正向候选、复核与反证；已有语义和研究经验不冒充实测工单。只读，不创建工单或编译记忆。',
      parameters: { type: 'object', properties: { ...filterProperties,
        package_ids: { type: 'array', items: string('已有本地包 ID。'), minItems: 1, maxItems: 100, description: '可选，用户指定版本时固定这些包；省略自动发现。' },
        as_of: string('可选带时区决策截止时间，省略用本次查询时间；排除截止之后的包/快照，快照缺逐条评价可见时间，不能作严格时序回放证明。'),
        include_demo: { type: 'boolean', description: '默认 false；仅演示或明确查询演示包时为 true。演示仍不进入有效策略池。' },
      }, required: ['query'], additionalProperties: false },
      execute: createHistorySearch({ memory }),
    },
    {
      name: 'wireless_workorder',
      description: '持久化网优工单、分型/证据/根因假设、候选方案版本、用户实际执行/失败/回退反馈和效果评估，或读取历史事件。返回稳定工单/方案/执行 ID 与 revision，保留来源和阶段输入结果。记录反馈不调用网管，不等于下发。input 契约见对应无线 Skill。',
      parameters: { type: 'object', properties: {
        operation: { type: 'string', enum: ['intake', 'read', 'history', 'identify', 'build_evidence', 'diagnose', 'save_plan', 'record_execution', 'evaluate'] },
        workorder_id: string('intake 返回的稳定 ID；后续操作必需。更新 intake 时传原 ID。'),
        expected_revision: { type: 'integer', description: '可选乐观锁；版本冲突先 read。' },
        input: { type: 'object', additionalProperties: true, description: 'intake: 原文/对象/问题/场景；build_evidence: observations/historical_case_ids；diagnose: hypotheses；save_plan: title/rationale/source_refs/actions/evidence_ids；record_execution: plan_id/source_ref/actions；evaluate: execution_id（优先）或 execution/before/after/evaluation_rule；history: limit。按 Skill 契约构造，不填造事实。' },
      }, required: ['operation'], additionalProperties: false },
      execute: workorder,
    },
    {
      name: 'wireless_compile_history',
      description: '把工作区中的 TraceRecord JSONL/JSON 数组交给固定来源的 ECHO-Mem 规则编译器，进行 Schema 校验、去重、截止时间/七天成熟边界过滤、归因、六类记忆编译、状态/评分/画像和本地版本包导出。最多 200 条/4 MB，60 秒超时。演示必须 mode=demo；未发布远程知识或加载风险 gate。',
      parameters: { type: 'object', properties: {
        file_path: string('工作区历史 TraceRecord JSONL 或 JSON 数组文件路径；不能用新工单对象或案例摘要代替。'),
        as_of: string('带时区的 ISO 版本截止时间；例如 2026-10-08T00:00:00+08:00。'),
        mode: { type: 'string', enum: ['historical', 'demo'], description: '默认 historical；演示数据必须显式 demo，不能混成真实效果。' },
        evaluation_visible_at_cutoff: { type: 'boolean', description: 'historical 模式必需：用户明确声明这些归档评价在截止前可见；不由模型擅自替用户确认。' },
      }, additionalProperties: false },
      execute: memory.compile,
    },
    {
      name: 'wireless_memory_query',
      description: '按已编译的本地 package_id 查询固定版本的记忆、源 Trace ID、状态、评分与支持/反证画像。只读校验文件哈希，演示或 unverified 记忆不作为现场统计或可执行证书。',
      parameters: { type: 'object', properties: {
        package_id: string('wireless_compile_history 返回的版本包 ID。'),
        query: string('具体参数/问题/记忆 ID；空字符串列出所选类型。'),
        memory_type: { type: 'string', enum: ['case_memory', 'rca_memory', 'strategy_memory', 'playbook_memory', 'risk_memory', 'counter_evidence_memory'] },
        limit: { type: 'integer', description: '返回上限 1 至 12，默认 6。' },
      }, required: ['package_id'], additionalProperties: false },
      execute: memory.query,
    },
  ]
  for (const definition of [...definitions, ...workflowDefinitions]) ctx.effect(() => ctx.tools.register({
    ...definition,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, execution) {
      execution.signal?.throwIfAborted()
      return definition.execute(args, execution)
    },
  }))
}
