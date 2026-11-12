---
name: wireless-multi-round-reasoning
description: 对 ICOS 执行后未通过或恶化的工单读取前轮执行回执和短评估，运行缩步长、反向或回退阶梯，生成下一轮候选建议。
---

使用 [ICOS 工具契约](../wireless-workorder-orchestrator/references/icos-workflow.md)。context 中 retry_times 大于 0，并提供 prior_execution_rows 与 short_evals 的真实关联；缺失时补数据，不猜执行结果。

先用 `wireless_icos_feedback` 核对评估及执行回执，再完成 cases，调用 `wireless_icos_multi_round`。只有用户要求生成回退建议时才使用 rollback_only=true。工具执行原阶梯，保留原值、现值、已经尝试的值及本轮承载动作。

需要重新形成方案时继续 candidates → alignment / parameter_risk → consistency → decision。参数恢复原值只表示恢复建议，不能把它说成问题已解决或设备已回退。实际效果分析复用 wireless-effect-evaluation。
