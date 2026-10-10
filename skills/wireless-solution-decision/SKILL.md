---
name: wireless-solution-decision
description: 依 ECHO-Mem 源方案 Skill 和 Shadow 选择方法比较历史策略与组合、受限选择候选或给条件性方向；用于方案生成、择优、备选和适配。
metadata:
  method_source: wireless-solution-decision/SKILL.md; wireless-solution-decision/SHADOW.md
  source_commit: e734ac032a7dc671878d05cd40d2b31b68d156fc
---

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
