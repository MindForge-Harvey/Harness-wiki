---
name: wireless-memory-engineering
description: 驱动 ECHO-Mem 工单与记忆工程，保存工单、分析阶段、候选方案和实际反馈，评价效果并编译本地经验版本；用于处理流程、记录、沉淀及编译请求。
---

## ICOS 阶段结果与现有账本融合

ICOS 分析由 wireless_icos_context 保存 run_id、revision、输入、各阶段结果与轨迹；按 [ICOS 契约](../wireless-workorder-orchestrator/references/icos-workflow.md) 关联已有 workorder_id。用户要求保存时，最终 wireless_icos_decision 的 save_to_workorder=true 将选中动作写为本账本的候选方案。实际执行继续 record_execution，效果继续 evaluate，源 Trace 导出和经验编译继续使用下方已有工具。ICOS 分析快照不能直接充当带真实执行与成熟评价的 TraceRecord。

先分析、后建立账本时，用 `wireless_icos_context(operation="link_workorder",run_id=...,workorder_id=...)` 关联，不传 input，不改变原输入或已完成阶段。不要通过 update 塞入 workorder_id，update 只用于完整业务输入变化。仅保存归档候选无需强行运行整单决策，可直接用已有 actions 保存 save_plan；参数身份和完整枚举字符串原样保留，约束不足保持草稿，不能把归档日期补成精确分析窗口。

负责生产和维护经验，分析阶段调用 wireless-workorder-orchestrator 的历史驱动分析能力。普通根因、参数、方案或评估问答由分析入口交付；用户要求处理工单流程、保存/恢复记录、记录实际反馈、保存评价或沉淀时使用这里。

按本轮目标推进必要阶段，读 [工程步骤](references/engineering-steps.md)；具体工具输入按 [共享契约](../wireless-workorder-orchestrator/references/input-contracts.md)。

- 新工单通过 intake 保存稳定 ID；已有工单先 read，补数保持原 ID 与版本。
- 分析按 [历史决策方法](../wireless-workorder-orchestrator/references/echo-decision-workflow.md) 执行历史检索、当前证据对齐、问题分型、根因假设、候选生成与执行前支持评估；用 identify/build_evidence/diagnose 保存真实阶段结果，用 save_plan 保存候选及 rationale/preconditions/evaluation_rule。仅保存明确来源的评价规则，提议未确认时在说明中保留，不写成既定规则。历史检索为空也记录范围与缺口，已有经验仍保留。
- 用户提供真实执行、失败、回退反馈时 record_execution，关联原方案 action_id；实际值和时间来自反馈，缺值保持缺口。
- 有可比前后观测及业务判据时 evaluate，对照真实执行及历史预期，保留组合归因和观察成熟状态；实际结果与此前候选、判据分开保存。
- 请求沉淀时核对源 TraceRecord 输入、截止和评价可见性声明，调用 wireless_compile_history；已有账本可用 wireless_workorder 的 export_trace，input 传 execution_id、mode、明确声明的 long_eval_result、long_eval_source_ref 与 evaluation_visible_at。工具保留实际执行值、缺口、来源和组合边界；不从描述性差值自行推定长期 Pass/Fail。需要保持已有策略身份时，只传来源中已存在的 scheme_id/scheme_group。合成反馈只能导出为 demo。
- 编译后用 wireless_memory_query 读取包，核对状态/评分/支持与反证。后续分析的 wireless_history_search 自动发现新的本地历史包；保留旧包、固定快照和既有经验，不覆盖它们。

各阶段成功只表示该产物完成。历史模式和合成样本模式分开，实际下发/回退、正式发布、校准 gate 与完整时序实验尚未接入，按实际可执行步骤交付并报告对应接口缺口。
