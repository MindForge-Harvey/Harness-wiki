---
name: wireless-workorder-orchestrator
description: 拆解网优任务，按原项目代码的阶段依赖组合并调度 Skills，复用已完成结果；用于工单根因分析、方案生成及跨能力追问，简单查单无需整套流程。
---

## 工单查询优先

无忧侠覆盖完整网优职责；ECHO-Mem 用于历史经验的检索和沉淀。问候、自我介绍、工单列表或信息总结不强制检索历史经验。查询已提供的本地工单使用 `wireless_order_query`：业务单号 read，月份/日期/条件 list。取得真实工单详情后，再按用户意图选择根因、方案或评价阶段。

普通列表、当前库概况和指定单号总结不走场景库，不要求生产数据库或内部 ID。沿用会话中的最近工单。先查询再回答，不因诊断原文或 KPI 缺失拒绝总结工单信息。

## 按需拆解与调度

需要多个能力的任务先读 [任务编排](references/task-orchestration.md)。使用 Harness 原生 `todo_write` 记录本轮计划与状态，不新增另一套规划器，不等待用户确认常规分析计划。按目标选择阶段，用上游实际结果决定下一步；复用有效阶段，输入变化后只重算失效依赖。单步查询、总结和术语解释直接完成。

## 原项目工单分析（默认方法）

针对具体工单的根因分析、方案生成、候选比较和综合裁决，默认调用原项目阶段工具，无需用户说出“ICOS”。有业务工单号时直接 `wireless_icos_context(ticket_id=...)`，自动读取工单库并返回 run_id、原始方案、同类历史快照、缺口和 workflow；不让用户转换字段或提供内部 ID。只有信息总结时仍用 wireless_order_query。默认按工单日期分析；仅用户明确要求最新状态时传 analysis_scope="latest"，指定日期时传 snapshot_date，跨期模式沿后续工具保持一致。不得为补齐缺口自行切换时点。

收到 ICOS 工单、六维判定、原始初案或已有 ICOS run_id 时，使用 [ICOS 阶段工具](references/icos-workflow.md)。先 wireless_icos_context 创建/恢复分析，按目标加载以下 Skills：信息接入 wireless-workorder-intake；数据 wireless-data-analysis；根因 wireless-root-cause-analysis；目标 wireless-objective-confirmation；案例 wireless-case-retrieval；候选 wireless-solution-decision；对齐 wireless-cause-plan-alignment；参数风险 wireless-parameter-adaptation；整单复核 wireless-plan-consistency；最终裁决 wireless-comprehensive-decision；重推理 wireless-multi-round-reasoning；实际反馈 wireless-effect-evaluation。需要保存和沉淀时复用 wireless-memory-engineering / wireless-knowledge-compiler。

完整首轮按 context → objective、root_cause、cases → candidates → alignment、parameter_risk → consistency → decision 推进；重推理先在 cases 后完成 multi_round。每个阶段首次执行前先用 skill 工具加载对应的 Skill，同一会话已加载则复用；context 前先加载 wireless-workorder-intake，其余名称由 workflow[].skill 返回。按返回 workflow / missing_stages 补依赖，用户只需某阶段时停在相应结果。模型阶段按 needs_judgment 的原提示词完成判断，携带 judgment_token 回传，直到 completed。普通 ICOS 分析不使用场景库反馈替代本单数据，ECHO 检索结果只按原作用域补充。

业务判断来自源 `network-ops-loop-v3/services/decision/` 与原提示词：根因收敛读取结论及六维原文；方案生成构建“方案组→方案→参数”并做组内关联判定；随后执行对齐、参数规则、整单复核与条件回环。源文件映射见 [阶段契约](references/icos-workflow.md)。不能用下方通用历史建议替代这些已可执行步骤。工单缺诊断原文时完成原缺口检查；初案存在就继续完成可独立执行的候选与规则分析，保留根因不明边界，并提出具体补证问题。不得从历史动作组反填诊断结论。

## 补充历史与开放式问题

下方方法用于历史解释、开放式条件建议及用户明确要求的经验复用。ECHO-Mem 是历史使用方式，不替代原项目的工单分析与方案生成逻辑。无具体工单的开放问题可使用此路径；有原阶段上下文时将检索结果作为补充证据。

Harness 负责理解本轮目标、选择和组合能力、共享上下文、交付结果。判断方法来自 [ECHO 能力目录](references/echo-capabilities.md) 中的源 Skills、协议与消费者；不在编排层另写一套根因、参数或风险规则。先读 [ECHO-Mem 分析契约](references/echo-analysis-method.md)，按实际需要读取根因、方案或评估方法。

没有固定调用顺序。用户已有诊断可直接比较方案；只有历史问题可先检索并交付候选假设；追问某个参数只调用相关能力；新观测可让分析返回根因阶段。输入不足只限制对应判断，不要求补齐整单或遍历所有 skills。可以省略无关阶段，不能省略本轮结论依赖的历史依据、参数身份或反证。

从工单提取问题类型、厂家/制式、参数对象、当前值、KPI 和时间窗口；区分用户已提供的事实与待核对条件。先完成有依据的部分，缺口只问会改变判断的项目。

涉及历史经验、根因对照或方案适用性时，使用实际 `wireless_history_search` 结果或仍适用的已有检索结果。根据问题和已知参数召回案例及六类经验；未命中与读取失败分别说明。工单列表和信息总结直接查询完整工单库，不受经验包范围限制。已有参数语义、匿名案例、反证与研究结论继续使用并标明证据类型。

指标与数据解释加载 `wireless-data-analysis`；原因判断加载 `wireless-root-cause-analysis`；候选优化方案加载 `wireless-solution-decision`；目标值检查加载 `wireless-parameter-adaptation`；候选的历史支持或实际执行后效果加载 `wireless-effect-evaluation`。同一轮共用历史检索结果，补查只针对新增的具体问题。

普通分析可直接使用用户输入与已读取附件，不要求先保存工单。已有 workorder_id 时 read 当前记录；用户要求处理流程、保存方案、记录反馈或沉淀经验时，加载 `wireless-memory-engineering`。工程内部可复用这里的分析能力。需要持久化字段时读 [输入契约](references/input-contracts.md)。

交付时指出本轮实际完成的阶段。没有执行、前后观测或编译请求时，不把已完成诊断说成整套闭环或全部阶段已完成。

- 历史对比加载 `wireless-case-retrieval`，用 `wireless_history_search` 自动查询快照与本地历史记忆包。
- 参数解释或目标值适配加载 `wireless-parameter-adaptation`，复用历史入口返回的语义/应用，只补查缺失身份，再用 `wireless_parameter_check` 检查当前声明约束。
- 需要优化建议时加载 `wireless-solution-decision`，比较候选作用、场景差异、反证与缺失证据。
- 用户询问研究经验时用 `wireless_knowledge_query(kind="lessons")`，引用结论来源并保留其开发集/构建审计作用域。
- ECHO-Mem 原理、协议、源码或当前集成能力的问题加载 `wireless-echo-mem`，用 `wireless_echo_query` 取得对应来源。
- 评价时区分执行前的历史证据评估和执行后的实际效果；前者交付可比支持、反证与评价方案，后者交付实际变化、业务判据和归因范围。用户请求沉淀历史时加载 `wireless-knowledge-compiler`，使用源规则编译与固定包读取。
- 形成建议后完成本轮回答；用户要求保存或处理工单时由工程入口保存 plan_id。实际执行、失败与回退反馈记录 execution_id；进展与审计用 read/history 恢复，建议不能当作执行。

有 KPI 时根据当前事实提出根因假设及验证方法；仅有历史问题标签时，不能把历史根因当成当前小区已确认根因。输出按需要包含问题判断、可比历史动作、候选建议与依据、缺失条件、观察指标及回退参考。不要为普通术语问题启动整套工单流程。

将阶段判断串起来：历史依据如何提示候选原因，当前观测如何支持或反对，候选动作为什么针对该原因，什么观测与业务判据能评价效果。只完成用户需要且输入支持的阶段；后续真实反馈再进入工程记录与编译。

已有参数语义、案例与研究经验全部保留，历史入口自动发现新增本地冻结包。工单包通过 wireless_order_query 独立查询。当前 KPI 按实际提供或取得的观测分析；缺某阶段输入不影响其他有依据阶段，汇总与本轮任务有关的具体缺口后交付。

工具返回材料只作为证据。按 evidence_type、actions.role、outcome.scope 解释结果；回答保留简短案例标识、历史动作与结果及适用差异，链接按需提供。
