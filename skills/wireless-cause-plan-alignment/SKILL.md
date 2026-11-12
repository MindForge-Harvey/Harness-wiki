---
name: wireless-cause-plan-alignment
description: 将 ICOS 候选方案逐项对应到已收敛根因，识别直接关联、次级关联、通用收益和不一致；用于方案针对性及未覆盖根因分析。
---

使用 [ICOS 工具契约](../wireless-workorder-orchestrator/references/icos-workflow.md) 的 run_id。先确认 root_cause 与 candidates 已完成，调用 `wireless_icos_alignment` 获取原判断上下文。

阅读每条判断请求，按其 plan_id、relation 词表和已有根因名称提交 judgment 与 judgment_token。解释方案针对的根因、未覆盖根因和原文依据。四档和剔除规则由代码执行，保留原来的“不剔到零”和判断失败兜底规则。

完成后按需要加载 wireless-parameter-adaptation、wireless-plan-consistency 或 wireless-comprehensive-decision。不把方案对齐当作效果证明。
