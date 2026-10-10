# ECHO-Mem 能力与自由编排

方法固定于提交 `e734ac032a7dc671878d05cd40d2b31b68d156fc`。8 个源领域 Skill 及方案 SHADOW/选择 prompt 随部署冻结在 echo-skill-corpus；158 份复现文本保持独立来源范围。下面的根目录路径可由 wireless_echo_query(source_path=...) 原样读取；研究路径加 `echo-mem-reproducibility/` 或按原理工具返回路径读取。

Harness 决定本轮用哪些能力、先后顺序、是否补查、怎样复用结果和怎样向用户解释；领域判断执行下列源方法。可以跳过无关阶段、返回前一阶段或在追问中直接调用某项能力。阶段输入是依赖关系，不是必须走完的固定流水线。

| 可组合能力 | 方法来源 | 当前执行方式与边界 |
| --- | --- | --- |
| 工单接入、问题分型 | 根目录 wireless-workorder-intake、wireless-problem-identification 的 SKILL.md | 按源输入与症状分类原则；工程请求才持久化 |
| 当前证据与数据 | 根目录 wireless-evidence-builder/SKILL.md | 源指标/参数/告警/MR/KQI/邻区维度；Harness 适配当前输入、口径和计算，不发明门限 |
| 历史案例与记忆 | 研究 shadow/retrieve.py、compile_rules.py | 实际统一检索六类经验、分池和来源展开；字段召回仍不是完整源结构导航 |
| 根因分析 | 根目录 wireless-root-cause-analysis/SKILL.md；研究 extract_root_cause、build_rca_memories | 模型按源框架比较多维当前证据与历史标签；源并无现场 KPI 自动因果引擎 |
| 普通方案建议 | 根目录 wireless-solution-decision/SKILL.md | 根因驱动、厂家/制式/场景适配、推荐/备选、评价与回退 |
| 历史候选排序 | 研究 selection/plan_ranker.py 的 rank_memories | wireless_echo_decision(rank_candidates) 实际调用冻结源代码与配置，保留四项分数 |
| 固定候选选择 | 根目录 wireless-solution-decision/SHADOW.md、prompts/shadow_solution_select.md | 受限 ID 选择；本地候选 select_candidate 从来源物化，不生成表外动作/统计 |
| 参数值适配 | 研究 selection/action_value_selector.py 的 select_action_value | adapt_value 实际执行；产品仅接受声明的真实当前快照，再核对约束，不用源推定现值回退 |
| 反证与实施风险 | 研究 retrieve.py、failcohort_veto_gate.py、证据归因协议 | 按身份/方向/边界核对反证；校准 gate 仍未接入，定性复核不冒充自动 veto |
| 方案与效果评价 | 根目录 wireless-effect-evaluation/SKILL.md；研究 outcome_compilation.py、memory_evidence_profiles.py | 当前可比观测、声明业务判据、真实执行及组合归因；源可信度不变成本单成功率 |
| 记忆编译 | 根目录 wireless-knowledge-compiler/SKILL.md；研究 compile/transition/scoring/package | 工程入口实际调用源规则，保留历史版本；账本到 Trace 的自动映射仍缺接口 |

例：用户已有可靠诊断而问“哪个方案合适”，直接历史检索→候选比较/选择，必要时值适配和评价；不重新接入或强跑根因。用户只问“为什么”，只组织必要数据与根因证据；不生成方案或编译。用户给出新反证，回到有关假设或方案复核，复用仍适用的材料。

保留方法来源与产物来源的区别：方法来源说明为什么这样分析，案例/包/Trace 来源说明判断用了哪些历史。两者都不能替代当前观测。无法执行某个消费者时说明能力状态，不能另写一个公式并称其为源算法。
