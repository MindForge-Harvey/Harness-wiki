---
name: wireless-objective-confirmation
description: 确认 ICOS 工单的问题指标、目标小区和时间边界，标记缺失或越界条件；用于方案目标确认及已有 ICOS 分析记录的目标核对。
---

按 [ICOS 工具契约](../wireless-workorder-orchestrator/references/icos-workflow.md) 创建或恢复 run_id，调用 `wireless_icos_objective`。

解释 main_metric、目标小区、劣化窗口及 unconfirmed。源实现只整理已提供字段；没有数值改善目标时保持未知。目标确认不替代 KPI 取证或根因判断。

后续选择方案加载 wireless-solution-decision；综合分析由 wireless-workorder-orchestrator 按返回 workflow 推进。
