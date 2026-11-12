---
name: wireless-comprehensive-decision
description: 汇总 ICOS 工单已完成的根因、案例、方案、对齐、参数风险及整单复核，运行综合决策和条件回环，生成逐动作及整单裁决。
---

解释已完成方案为什么保留/剔除时，先调用 wireless_icos_decision(operation="explain", ticket_id=业务工单号) 读取真实逐动作记录。以 final_stage/final_reason 为最终决定，规则的 para 与 rule_scope 分开引用，reviewed 按实际值解释；早期剔除的动作仍可能有独立复核评价。不得补写满分、夹边/格点吸附、未复核等记录未给出的结论，也不据新快照断言旧执行错误。


按 [ICOS 工具契约](../wireless-workorder-orchestrator/references/icos-workflow.md) 调用 `wireless_icos_decision(operation="finalize", run_id=...)`。缺前置阶段时按 missing_stages 加载对应 Skill；需要先看复核前集合可使用 preview。

最终采用工具生成的 OrderDecision、rows、risk_summary、manual_required 与 gate。说明选中/剔除的动作、现值与建议目标值、依据和未评估项。参数目标值、冲突裁决和整单结论不在正文里另算一份。

上游变化后先重做被标失效的阶段。若 context 已关联现有 workorder_id，用户要求保存时使用 save_to_workorder=true 保存候选方案。现场执行与回退尚未接入；后续实际反馈交 wireless-effect-evaluation，经验沉淀交 wireless-knowledge-compiler。
