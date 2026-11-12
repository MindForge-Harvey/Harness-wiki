---
name: wireless-plan-consistency
description: 对 ICOS 本轮准备采用的整批方案检查指标相关性、调整方向冲突和功能互斥，执行整单复核并重新检查剩余集合的决策条件。
---

按 [ICOS 工具契约](../wireless-workorder-orchestrator/references/icos-workflow.md) 恢复 run_id，调用 `wireless_icos_consistency`。先补齐其 missing_stages。

逐条阅读 judgment_requests 中对实际候选集合的复核上下文。参数方向使用工具已经计算的值；使用提示词中的 relevance/evidence 词表和原动作身份。判断冲突时先解释机理，确认构成冲突才设置 is_conflict=true。没有依据时保留不确定，不把协同方向误判成冲突。

携带 judgment_token 提交 judgment。代码负责剔除指标存疑或冲突各方，并对剩余集合重评条件。解释 review、warnings、gate 和剔除原因。后续用 wireless-comprehensive-decision 产出最终裁决。
