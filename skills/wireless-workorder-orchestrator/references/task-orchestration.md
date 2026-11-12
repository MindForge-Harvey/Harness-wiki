# 使用 Harness 原生任务编排

Harness 已提供 `todo_write`、Skill 加载和工具循环。领域 Skill 负责提供方法与依赖，Harness 根据本轮目标组合它们，不另起规划服务。

## 形成计划

每轮需要多个能力时先加载总编排 Skill，明确交付目标、已知工单和可复用结果。用户追问切换到方案等新目标，也在本轮首个分析阶段调用前更新任务清单，不等执行结束才补计划。先写一两句公开执行说明，用 `todo_write({todos:[{content,status},...]})` 记录简短任务。每次提交完整清单；status 为 pending / in_progress / completed，顺序工作最多一项 in_progress。

任务写业务动作，可注明对应 Skill，例如“读取工单与初案（工单查询）”“核对根因和历史支持”“比较候选并检查参数”“整单复核”。不要把“输出最终回答”单独列为任务，不要为每次工具调用创建任务，也不要为了凑齐数量调用全部 Skills。最终回答前更新最后一次完整清单：实际分析步骤完成则标记 completed；真正待用户补数的工作保持 pending 并改成具体补证任务，不留下已结束但仍为 in_progress 的项目。

## 根据目标调度

| 用户目标 | 选择与停止位置 |
| --- | --- |
| 列工单、信息总结 | 工单接入 Skill → wireless_order_query；无需任务清单或后续阶段 |
| 根因分析 | context → root_cause；有观测时独立调用数据分析，按需补充历史；交付根因与待补项后停止 |
| 方案生成、综合建议 | context → objective / root_cause / cases → candidates → alignment / parameter_risk → consistency → decision；只补未完成依赖 |
| 只比较初案 | context、root_cause、cases、candidates；在候选比较停止 |
| 某参数风险 | 在已有 run_id 上补 cases / candidates 后调用 parameter_risk；不强制走最终裁决 |
| 执行后再优化 | 有实际回执与短评估才进入 feedback / multi_round，再按失效情况更新方案链 |

每个阶段先加载 workflow 返回的对应 Skill，已加载则复用。workflow[].requires 与 needs_stages 是实际依赖；needs_judgment 读取原提示词并提交本轮令牌，直到 completed。阶段完成后及时更新任务状态。复用已完成阶段时说明复用了哪些结果，只把本轮实际调用的步骤说成本轮新执行。工具完成不等于判断有充分依据，空根因、未匹配规则与待补证分别保留。

## 交互与改计划

本地已有数据先读取；缺少会改变结论的输入时，完成独立部分后提出具体问题，例如“请补充该小区的覆盖/邻区/参数诊断原文，或这次异常时段的接通失败分项”。不能只问用户要不要继续，也不能要求重新上传已存在的工单。任务状态保留未完成的依赖，不将待补证标成已分析完成。

用户补数后 context read 复原有效结果，update 用完整新快照，并按返回失效阶段调整计划。用户转为单步请求时缩小计划；所有所需阶段完成后结束本轮，不额外启动执行或经验编译。
