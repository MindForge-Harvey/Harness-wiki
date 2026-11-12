---
name: wireless-effect-evaluation
description: 按 ECHO-Mem 方法评价无线候选方案的历史支持与反证，或比较实际执行后的同口径效果、业务判据和归因范围；用于方案可靠性及优化效果评估。
---

## ICOS 执行回执与短评估

对 ICOS run_id 先按 [ICOS 契约](../wireless-workorder-orchestrator/references/icos-workflow.md) 调用 wireless_icos_feedback 读取已提交的回执与短评估分类。改善/通过、恶化/不通过和缺失保持不同含义，执行行按 short_result_id 关联评估。短评估来自输入，工具没有新采集现场指标。

归档数据含真实 actions 的执行与长期评价时，在用户要求评价执行后结果的这一阶段，将带 source_ref 的 archived_feedback 交给 wireless_icos_feedback；不要把反馈写进决策前 context。字段对应 trace 的 exec_state、short_eval_result、long_eval_result 和 improvement_result，并用 context 中的 execution_id 关联。短评估“未启用”不当作失败；失败动作的 after 只是尝试目标，不当作实际值；“改善”与长期 Fail 冲突时分别说明。没有 KPI 前后值时只评价执行与归档标签，不能计算改善幅度。

有真实执行与同口径前后观测时，继续使用下方 wireless_workorder 的 record_execution/evaluate 保存并计算效果；恶化后需要新一轮建议加载 wireless-multi-round-reasoning。最终候选动作不是执行反馈，不得据此补造 after 值或成功结论。

先确定评估对象：尚未执行的候选看历史支持与当前适用条件；已执行方案看真实反馈与前后效果。读 [历史决策方法的评估阶段](../wireless-workorder-orchestrator/references/echo-decision-workflow.md#评估)，按所需模式完成，不要求两者都运行。

## 执行前评估

读 [历史检索契约](../wireless-workorder-orchestrator/references/echo-analysis-method.md)，调用 wireless_history_search 或复用仍适用的结果；用户指定包时保留版本。比较可比案例、策略/组合的正向支持、限制和反证，说明问题机制、厂家版本、参数身份/方向、当前值与边界、共同动作的异同。

沿原包读取有效 Pass/Fail、LCB、状态和证据画像。命中条目数与结构关联次数不是独立效果样本，不跨包累加重复 Trace。只有案例摘要时引用已知结果，不估计全量成功率；历史 LCB 不当作本单成功概率，RCA validated 不当作方案有效性。

交付历史支持程度、关键反证、当前待确认条件、验证指标与业务判据、观察窗口及停止/回退参考。判据缺来源时可提出待确认评价方案，不称为已批准规则。缺当前数据仍可完成历史支持评估；缺实测历史仍可说明机制依据与具体缺口。具体参数目标交 wireless-parameter-adaptation 检查。

## 执行后评估

已有 workorder_id 时 read 方案、真实执行与已有评价；优先关联 execution_id。无工单 ID 的普通评估可直接比较用户实际输入，不要求先保存；用户要求记录或正在处理工程工单时，按 [效果输入契约](../wireless-workorder-orchestrator/references/input-contracts.md) 接入并调用 `wireless_workorder(operation="evaluate", workorder_id=..., input={execution_id,before,after,evaluation_rule})`；无已有执行记录时以有来源的 execution 输入替代 execution_id。

使用实际反馈核对方案偏离、动作覆盖、前后值、执行时间、失败和回退。无记录的归档工单可用真实 execution 输入评估，来源必须明确；候选 target 不补成实际 after，部分执行不缩窄成单动作效果。

before/after 使用真实观测，明确定义、单位、人群、样本量、来源、对象与窗口。当前工具拒绝混对象/口径、重叠或逆序窗口、跨执行时间和不同窗口时长的直接比较；普通分析也遵循这些可比性要求。负荷、其他配置或故障变化可能影响解释时保留这一事实，不直接归功于本方案。

评价判据、目标指标、绝对改善要求和观察小时数来自用户业务口径；未知时只报告描述性差异。若事前已有冻结判据优先按其评价，事后新增判据标为探索性分析。源码七天编译成熟边界不替代当前业务观察窗口。

分别交付实际执行情况、前后变化、判据达成、观察成熟性、归因范围及未评价副作用。工具状态保留 process_failure、not_assessable、needs_data、observing、declared_rule_met 或 declared_rule_not_met；未调用工具时不宣称获得其状态。百分比指标差值用百分点，相对变化另外呈现。

涉及历史效果对照或经验适用性时复用/执行历史检索；仅按完整输入计算差值不必另查历史。对照历史的共同动作、评价窗口与记录结果，解释此次结果是否一致；缺历史 KPI 前后值时不比较改善幅度。

多动作变化保留组合范围，单动作前后相关性也不等于因果证明。执行失败是流程结果，尚未达到声明窗口时继续观察；未提供副作用指标时标记未评价。业务达标不直接生成源 long_eval_pass，混合执行不强行写成二元效果结果。

用户明确要求沉淀历史时交给 wireless-knowledge-compiler 的 TraceRecord 准入与归因；当前记录与源 Trace 的自动映射尚未接入，不从评估摘要制造源记录。
