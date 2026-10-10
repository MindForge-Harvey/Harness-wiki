---
name: wireless-case-retrieval
description: 实际检索已有无线案例和本地 ECHO-Mem 六类记忆，比较场景、根因、动作、效果与反证，并报告未命中或数据源未接入；用于历史工单与经验对照。
---

读 [ECHO-Mem 分析契约](../wireless-workorder-orchestrator/references/echo-analysis-method.md)。调用 `wireless_history_search`，query 用具体问题、参数或方案编号，按已知厂家/制式筛选；用户指定版本时传 package_ids，否则自动发现本地包。查看固定案例清单可用 `wireless_case_search(query="")`，这不替代具体分析的历史检索。

读取案例与 case/rca/strategy/playbook/risk/counter_evidence 六类结果，保留正向、复核、反证与背景分池。未命中说明实际范围；读取错误说明检索不完整；生产库未接入与本地材料命中可以同时成立。已有语义和研究经验照常保留，不补造实测案例。

工具给出案例和逐记忆类型的 total_matches/truncated。足以回答时直接使用；截断影响关键对照时聚焦缺失的参数/根因或用包 ID 读取具体记忆，不用同义查询重复确认。

比较问题类型、厂家与软件版本、制式、参数对象、频段、当前值和动作方向。返回的未知厂家或制式标记意味着需要确认，不等于兼容当前网络。`relevance_score` 是检索命中数，不是效果置信度。

保留三类材料的区别：

- `onboarding_demo`：演示结构，不计入真实效果证据。
- `anonymized_real_case_summary`：实际工单摘要，有执行记录但缺原始完整 Trace；按 `outcome.scope` 使用结果。
- `published_experiment_case_summary`：研究中的推荐与历史 gold 对照；`recommended_not_execution_record` 不能说成已执行。

把案例消化成中文说明：当时什么问题、根因依据是否完整、实际怎么调、共同动作、记录结果以及当前适用差异。保留简短案例标识；包记忆保留版本与源 Trace，来源链接按需提供。多动作整体 Pass 不分摊为单参数独立有效；缺 KPI 前后值明确没有改善幅度。历史范围不填成当前厂家版本约束。

按 [共用历史证据方法](../wireless-workorder-orchestrator/references/echo-decision-workflow.md#共用历史证据) 将有关材料交给后续阶段：根因阶段需要历史标签与当前可核对条件，方案阶段需要实际动作/组合及其适用差异，评估阶段需要有效评价、归因范围和反证。已有检索结果共用，不为每个阶段重新查同一批资料。

固定案例快照有 4 个混合类型条目，本地包数量以实际检索为准；不得从摘要生成历史成功率或完整失败队列。未命中不按相似名称或相同方案编号强行替代。

用户给出本地编译的 package_id 时，用 `wireless_memory_query(memory_type="case_memory")` 扩展对比，保留该版本来源、demo/historical 模式与证据作用域；不把不同包的重复 Trace 叠成新的支持次数。
