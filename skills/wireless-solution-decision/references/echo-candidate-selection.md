# ECHO-Mem 方案模式与源消费者

来源提交 `e734ac032a7dc671878d05cd40d2b31b68d156fc`：源 `wireless-solution-decision/SKILL.md` 定义领域方案流程，`wireless-solution-decision/SHADOW.md` 和 `prompts/shadow_solution_select.md` 定义给定候选中的受限选择。研究排序和值选择分别来自 `echo-mem-reproducibility/pipeline/selection/plan_ranker.py`、`action_value_selector.py`。源文本随部署冻结，可用 wireless_echo_query 的 source_path 按需核对。

## 给定候选中的选择

已有用户指定候选表，或历史包返回正向策略/组合时使用。先解释问题/根因与参数族是否匹配，再并列看有效历史效果和样本；区分单动作策略与组合，最后核对具体失败背景与复核条件。小样本通过率不作为高确定性依据，案例说明不能变成表外候选。

本地包可独立调用 `wireless_echo_decision`：

- `rank_candidates`：candidate_refs 为检索返回的 package_id/memory_id；context 只填写当前已知 issue_type/vendor/system/region/band，root 为本轮假设，parameter_clues 为已知身份。源四项排序实际执行，返回 candidate_set_id、候选 ID 与逐项分数。正向状态、演示、厂家/制式不兼容、截止时间由工具检查。
- `select_candidate`：传 candidate_set_id 和表内 selected_candidate_id；也可直接给本轮 candidate_refs 与 selected_candidate_id（由实际 package_id 和 memory_id 以冒号连接），无需先排序。模型解释为什么选，系统从冻结来源填充动作模式与统计；不能改写参数、方向、步长、评价数字或共同动作。可选择备选而非机械取 Top1。候选集过期时按当前条件重建，不凭旧 ID 补造来源。
- `adapt_value`：可以直接使用检索获得的具体策略引用，无需先排序。传 current_snapshot 中实际参数身份、current_value、min/max、unit、source_ref、constraint_source，已知 step/step_base 时一并提供。工具执行源值选择器并检查当前声明约束，缺快照不做中位数/中点推定。

三种能力独立组合。排序不等于风险门控；选择不等于下发；值适配不等于实际效果。源码四项权重用于明确版本的候选排序，不能成为 KPI 异常门限或当前根因概率。

用户直接给候选表时保持原 ID、动作和统计，按同样受限方法选择；它不是本地包，不能编造 package_id 调工具。模拟评价只能说明如何比较，不能说真实策略已经反复验证或可靠有效。固定表模式不扩展新候选；候选均不适用时说明无可推荐项或需复核。只有输入本身提供 rule_baseline 时可选它，不制造虚构基线。

## 条件性方案建议

无可用固定候选，或用户明确要求探索方向时，沿源普通方案 Skill 使用已查到的参数语义、历史案例、专家/厂家资料形成有出处的条件性方向。逐项说明来源、当前根因假设、历史原动作/结果、适用差异和待确认条件；缺历史支持时标明机制推断，不能创建实测支持、候选 ID 或统计。

建议中的新方向不是既有候选的改写。若用户要扩展固定候选，先说明扩展依据并形成新一轮候选比较；保留原候选版本，不把模型探索当作 ECHO 已验证策略。当前值和目标值未知时给方向，不照抄历史 after。
