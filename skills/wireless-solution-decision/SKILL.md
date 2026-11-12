---
name: wireless-solution-decision
description: 按原项目代码构建方案组、候选方案与参数，执行组内寻优并按需衔接根因对齐、规则适配、整单复核和综合决策；用于具体工单方案生成与比较。
metadata:
  code_source: network-ops-loop-v3/services/decision/candidate_set.py; relevance.py; chain.py
  method_source: wireless-solution-decision/SKILL.md; wireless-solution-decision/SHADOW.md
  source_commit: e734ac032a7dc671878d05cd40d2b31b68d156fc
---

解释已完成方案为什么保留/剔除时，先调用 wireless_icos_decision(operation="explain", ticket_id=业务工单号) 读取真实逐动作记录。以 final_stage/final_reason 为最终决定，规则的 para 与 rule_scope 分开引用，reviewed 按实际值解释；早期剔除的动作仍可能有独立复核评价。不得补写满分、夹边/格点吸附、未复核等记录未给出的结论，也不据新快照断言旧执行错误。


具体工单默认按工单日期取数：wireless_network_query / wireless_icos_context / wireless_data_analyze(ticket_id=...) 使用同一时点，analysis_selection 给出选定日期及其他可用日期。仅用户明确要求最新状态时用 analysis_scope="latest"，明确指定日期时用 snapshot_date；不得为补齐证据自行跨期。其他日期快照不能解释原工单根因或原执行效果。工单期指标缺失仍可总结归档方案、执行与评价，并按原代码做条件性候选复核。旧会话先 context read 清除失效跨期结果；series 支持 his016 等原列名。


## ICOS 初案候选与组内寻优

具体工单的方案生成默认复用原项目代码。只有业务单号时先由总编排 Skill 拆解任务，用 wireless_icos_context(ticket_id=...) 取得原始候选及 run_id；用户已有 run_id 或 initial_plans 时直接复用。按 [ICOS 契约](../wireless-workorder-orchestrator/references/icos-workflow.md) 使用 wireless_icos_candidates。先补齐 root_cause / cases，阅读每组判断请求；judgments 按返回 key 提交 relevant_plans 和 reasoning，同时传 judgment_token。只能选本组原有方案，关联并列保留，全组无关联时按源规则处理，不凭 final_ratio 排序。

没有 judgment_requests 时不提交 judgments，也不为了产生分数调用 ECHO 排序器代替 ICOS 组内选择。用户只要求候选组织/比较时，在该阶段交付归档方案结构、已有历史支持与缺口即可。补充查询 ECHO 包时，只有 candidate_pools.positive_candidates 中明确为 validated/reusable 的策略或组合才传给 rank_candidates；unverified、restricted 或反证条目只用于说明边界，不试调用正向排序。不用“被拒绝一次”来代替检查已返回的状态。

`status=completed` 且 `judgment_requests=[]` 是本阶段的结束条件；即使 selected_count=0 或 relevance=null，也不能据此自建判断请求、猜 judgment_token 或使用 refresh 试图触发评分。refresh 会使下游阶段失效，仅在输入或分析依据确有变化、需要重算时使用。当前根因缺失时保留该缺口，候选比较不必得到选中动作才能完成。

类型必须是 strategy_memory 或 playbook_memory；case_memory 即使 validated、标题中带“组合”，也只是案例。若工具返回 no_candidates 与 rejected_candidates，解释不准入原因并保留背景用途，不声称已执行源排序。

候选完成后按需要加载 wireless-cause-plan-alignment、wireless-parameter-adaptation、wireless-plan-consistency 和 wireless-comprehensive-decision，分别执行对齐、规则检查、整单复核与裁决。ECHO 历史方案仍可通过下方工具单独比较，不把它们自动伪装成 ICOS 初案。

## 补充历史候选与开放式建议

以下用于原方案链中的历史补充，或无工单初案时的开放式条件建议；不能用历史排序替代原代码的组内关联、规则适配和整单复核。归档初案的复核不表述为新创作动作，缺初案时明确提出补充初案或独立生成条件建议。

先读 [ECHO-Mem 分析契约](../wireless-workorder-orchestrator/references/echo-analysis-method.md)，用 `wireless_history_search` 找可比历史案例、策略、组合及反证，并复用其参数语义与研究经验。已有同条件结果足够则复用；没有命中也必须说明查过哪些来源，保留有来源的条件性方向。

方法来自源同名 Skill 的根因驱动召回、厂家/制式/场景适配、推荐/备选、风险回退和评价要求；已有固定候选时采用源 SHADOW.md 与 shadow_solution_select.md 的受限选择。先按 [候选模式与源工具](references/echo-candidate-selection.md) 判断本轮模式；不把开放式建议和给定候选择优混在一起。

按 [方案方法](../wireless-workorder-orchestrator/references/echo-decision-workflow.md#方案生成) 将候选根因对应到历史参数动作或组合。无需重新跑根因分析来证明用户已声明的诊断，只保留其来源和未验证边界。推荐与历史原动作分别描述，当前适配由值适配能力处理；没有依据的协同关系不补成组合机制。

按 candidate_pools 区分正向候选、复核、反证与背景。需要比较本地历史包的正向候选时调用 wireless_echo_decision(rank_candidates)，实际执行源 ranker；需要选择时 select_candidate 只接受所返回的候选 ID，动作模式从固定来源填充。比较机制/参数族匹配、历史有效样本与可信度、策略/组合类型、当前边界和风险；排序第一名不是自动推荐，风险与具体反证仍须核对。源包分数与本轮排序分分别解释；校准 gate 尚未接入，不生成放行证书。

有 workorder_id 时读取当前证据与根因假设；有用户指定的 package_id 时用 `wireless_memory_query` 读取策略、组合和反证，保持状态及支持作用域。编译包没有自动加载校准 gate；unverified 或 demo 不变成自动放行依据。

候选应对应具体问题机制、参数对象与调整方向，并说明来源支持了什么。历史曾执行的值是对照点，不能直接复制为当前目标；用户提供当前值与约束后，用 `wireless_parameter_check` 检查候选。数据不足时仍可给出条件性方案和先验证的指标。

候选方向不能超出已查到的作用解释。例如只知道 SNonIntraSearch 调整会改变测量触发边界时，不把“提高它可避免用户被异频测量带走”作为已支持的因果方案；保留历史方向，待核对厂家版本的触发逻辑后再判断适用性。

优先区分：

- 当前问题假设与历史标签；参数机制解释与观察到的效果。
- 实际执行组合与未执行推荐；工单级整体评价与单动作归因。
- 相同方案编号与不同参数身份；匹配场景与未知厂家/版本。
- 有观测的 KPI 改善与仅有长评 Pass；正向案例与具体反证边界。

来源中的 LDH003 反证案例分别涉及“资源类切换准备失败惩罚定时器”的推荐与“非资源类切换准备失败惩罚次数”的 gold 对照，不把二者合并，也不据此宣称所有 +2 调整必然失败。

给出建议的方向、依据、待确认条件、验证指标/观察窗口以及回退参考。观察窗口无当前业务定义时可提出待确认方案，不冒充源记录。没有全量 MemoryPackage 与 gate 产物时，不伪造 Auto/accept 证书、LCB、失败概率或成功率。

需要评价候选是否值得实施时加载 wireless-effect-evaluation 的执行前历史证据评估，共用本轮检索。每个推荐连起“当前假设 → 历史动作与已知结果 → 当前适配 → 验证判据”；历史只给整单 Pass 时不预测单参数收益或 KPI 改善幅度。

分析回答交付候选比较；用户要求保存方案或正在工程工单处理中时，用 `wireless_workorder(operation="save_plan")` 保存，契约见 [方案与反馈](../wireless-workorder-orchestrator/references/input-contracts.md)。保留 rationale、source_refs、当前 evidence_ids、历史 case_ids、动作身份和当前值/候选值/约束。记忆包出处在 source_refs 中保存包/记忆/Trace 标识，不能填入只接受快照案例 ID 的 historical_case_ids。未知值省略，允许 draft_needs_data；候选约束通过不表示已审批或下发。工具生成稳定 plan_id/action_id，幂等保存并保留旧版本。

用户提供实际执行、失败或回退反馈时先 read 原工单/方案，按已有 action_id 用 `record_execution` 保存 source_ref、实际状态/时间/前后值，返回 execution_id。缺值保留缺口，不能从候选 target 补成实际 after；偏离方案按实际反馈记录，更正关联 supersedes_execution_id。反馈来源明确为用户提供，工具未调用网管。用户要求直接现场下发时说明当前接口未接入，并完成能做的方案检查与记录。
