# ECHO-Mem 工程步骤与运行入口

分析消费经验；本入口负责工单记录、真实结果评价与经验版本生成。阶段可按输入独立执行，不能把所有工单都声称已经闭环。

| 工程步骤 | 当前入口/真实实现 | 产物或缺口 |
| --- | --- | --- |
| 工单标准化与可恢复状态 | wireless_workorder intake/read/history | 工单 ID、输入版本、事件输入/结果 |
| 历史驱动分析 | wireless_history_search + 数据/根因/方案 skills | 历史检索结果与来源范围、当前对照、可区分假设、适配候选 |
| 证据对齐与引用核对 | build_evidence/identify/diagnose | 当前证据、隔离项、分型与假设；历史来源和当前观测分别保存 |
| 执行前支持评估与候选保存 | wireless-effect-evaluation + save_plan | 可比历史支持/反证、适用条件、plan_id/action_id；明确提供的业务评价规则随候选保存 |
| 实际反馈 | record_execution | execution_id、来源、实际前后值与时间；不从候选补成反馈 |
| 效果比较与成熟性 | evaluate | 同口径前后差异、用户判据达成状态；不自动写论文 long_eval 标签 |
| Trace 准入、去重、截止/成熟时间过滤 | wireless_compile_history → worker/compile.py | Schema/来源验证、纳入/排除；历史评价可见声明由用户提供 |
| 归因与六类编译 | 固定源 pipeline/compile/outcome_compilation.py、compile_rules.py | 源证据作用域与实际形成的记忆类型 |
| 生命周期、评分与画像 | 固定源 pipeline/transition/state.py、scoring/score.py、compile/memory_evidence_profiles.py | 类型状态、历史可信度、支持与反证画像 |
| 冻结版本与读出 | 固定源 pipeline/package/build.py + wireless_memory_query | 本地包、校验和、源 Trace 与版本；统一历史检索自动读取本地包 |
| 现场执行、正式发布、Static/Adaptive 回放 | 尚未连接这些工程入口 | 完成已有独立部分，准确说明未执行阶段；不拿 expected 指标作为运行结果 |

固定源步骤均来自提交 e734ac032a7dc671878d05cd40d2b31b68d156fc；通过 wireless_echo_query 的 implementation 模式按实际源路径核对，不将源码读取等同于实验执行。

根因、方案、执行前/后的评价判断按 [历史决策方法](../../wireless-workorder-orchestrator/references/echo-decision-workflow.md)；普通分析直接交付这些判断，工程入口仅在用户要求记录、处理流程或沉淀时保存对应产物。

source_refs 中保留实际案例/包/记忆/Trace 及输入来源。historical_case_ids 只填固定案例工具返回的 ID；历史记忆不冒充当前 evidence_id。当前实际处理记录缺源 Trace 结构时保留记录与缺口，等待真实映射输入，不损坏或替换已沉淀版本。
