---
name: wireless-knowledge-compiler
description: 使用固定版本 ECHO-Mem 规则将历史 TraceRecord 编译为本地不可变记忆包，进行准入、去重、成熟时间过滤、归因、六类记忆、状态评分与证据画像；用于历史沉淀和编译验证。
---

调用 `wireless_compile_history`，输入工作区的 TraceRecord JSONL 或 JSON 数组 file_path、带时区的 as_of 和 mode。单批最多 200 条/4 MB，60 秒超时；大型历史先分批或另行设计完整版本构建，不能称分批包已经做了跨批聚合。

- mode=historical 需要用户明确给出的 evaluation_visible_at_cutoff=true，说明归档评价在截止前可见；只有执行时间不能证明结果可见。不替用户填写这一事实，缺失时列为输入缺口。
- mode=demo 仅用于用户要求的演示/验证；演示样例不能进入真实效果包。不要自动从文档摘要制造完整 Trace、执行事件或评价结果。

工具执行源项目固定提交的 Schema 校验、重复 ID 冲突检查、时间过滤、七天成熟边界、证据作用域、准入、规则编译、状态迁移、评分和画像，导出有校验和的版本包。编译可能产生 case、rca、strategy、playbook、risk、counter_evidence 六类记忆，实际数量由输入决定，不生成六个空壳。

使用 `wireless_memory_query(package_id=...)` 读取产物、源 Trace ID、状态及支持/反证。小样本 unverified 保持原状态；演示统计只描述演示。RCA 的历史标签不由动作长评通过率证明正确；执行失败保留流程风险，混合/组合结果按源编译器归因。

当前适配器采用公开复现规则路径，ontology_mode=off；语义草案通过独立查询提供，不能将未经审核的草案关联转换为执行等价。包在本地冻结，不自动替换线上知识或开启自动放行；校准 gate、全量生产数据及发布治理是独立能力。报告编译模式、截止时间、纳入/排除/去重、类型与状态统计、包 ID 和来源版本。
