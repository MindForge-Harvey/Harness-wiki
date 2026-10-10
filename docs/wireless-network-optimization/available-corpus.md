# 当前可用的无线工单、案例与经验语料

核查日期：2026-10-08；职责与检索接入更新：2026-10-10。源快照：`e734ac032a7dc671878d05cd40d2b31b68d156fc`。

源仓库根目录已经提供 **1 条结构化脱敏演示工单、279 条动作语义映射、参数归并规则、案例分析与大量实验文档**。这些可以支持首批演示与领域规则整理。全量历史工单和已编译 Memory Package 没有随 Git 提供。

## 可用材料清单

| 材料 | 实际数量/内容 | 可以做什么 | 证据边界 |
| --- | --- | --- | --- |
| `data/samples/eval_traces_sample.jsonl` | 1 条 Trace、1 个动作，2097 字节；TraceRecord Schema 校验通过 | 工单结构解析、历史动作展示、引用与流程演示 | onboarding 样例，不能作为效果统计或论文评测集 |
| `action_ontology_reviewed_draft_v2.json` | 279 个签名映射，92 个规范动作标签、87 个参数概念；131 条草案关联 | 参数名称/动作语义规范化、问题族与调整方向的参考资料 | 属于语义标注，不是 279 条工单或效果证明；279 条均保留 `needs_human_review=true` 标记 |
| `action_ontology_signature_policy_v2.csv` | 279 行：allowed 240、conditional 17、blocked 22 | 建立可归并、条件归并、禁止归并的确定性规则 | 聚合许可不代表现场执行许可 |
| `action_ontology_link_policy_v2.csv` | 15 条审核规则：blocked 12、conditional 3 | 区分反向动作、厂商语义与签名关系 | JSON 中的 131 条草案关联不能全部当成审核通过的链接 |
| `echo-mem-case-studies-20260621.md` | 2 个叙述案例：成功推荐、反证转复核 | 方案解释与失败案例对照 | 原始完整 Trace/运行产物未随 Git 提供；这是一份既有实验案例总结 |
| `ECHO-Mem_Overview_Trace_Example.md` | 1 张实际工单的匿名展示，含 2 个动作 | 组合方案结构、前后参数值、执行记录与归因教学 | 提供整体 Pass，无具体 KPI 前后值；单动作效果未独立验证 |
| `docs/experiments/*.md` | 277 份实验/研究文档 | 提炼失败模式、候选选择、风险门控和知识编译经验 | 不全是现场优化指南；旧实验结论需要保留日期、协议与适用范围 |
| JSAC 中文稿与专家经验分享大纲 | 方法、实验讨论、语义规则与经验组织框架；分享大纲 v0.4 | 领域解释性语料、检索、方法规则整理 | 稿件中的指标需追溯冻结结果；大纲只展开了部分内容 |

以上材料位于仓库根目录及论文/实验目录。用户最初链接的 `echo-mem-reproducibility/` 声明有 4 条合成工单，但当前 Git 快照缺少其 `examples/synthetic/trace_records.jsonl`。根目录这一条样例与缺失的四条合成数据是不同输入，不能互相替代以通过冻结复现。

## 可以马上展示的工单内容

### 结构化样例：切换差小区

- 场景：LTE、B3、样例厂家。
- 问题：切换差小区。
- 动作：切换控制开关 `HoCfgSwitch`，从“关”到“开”。
- 记录结果：执行成功，长期评价通过。
- 可用字段：工单上下文、参数前后值、调整规则、方案组、执行与评价、来源。

这条记录适合演示接入、历史案例字段对比和结果引用。只有一个演示样本，不能估计普遍成功率或当前网络最佳参数。

### 实际双动作工单的匿名叙述

`ECHO-Mem_Overview_Trace_Example.md` 提供一张 LTE“低接通用户占比高”工单：

| 动作 | 参数 | 调整前 → 调整后 | 记录结果 |
| --- | --- | --- | --- |
| A1 | 最小接入电平 `QRxLevMin` | -64 → -62 | 执行成功 |
| A2 | 异频/异系统测量启动门限 `SNonIntraSearch` | 25 → 27 | 执行成功 |

整体长期评价为 Pass。数值是源编码，材料没有完成物理单位换算，也没有具体 KPI 改善幅度。因此可沉淀为“特定上下文下的历史组合案例”，不能推断 A1、A2 单独调整都有效，更不能作为新工单直接下发的参数模板。

### 成功与反证案例

已有案例总结记录：智能预调度持续时间系数增加的推荐与历史成功动作一致；另一条切换惩罚相关推荐命中失败队列背景，从自动接受转为人工复核。可以分别做“来源支持的候选”和“同方案族但参数/边界存在差异”的解释案例。完整可重放输入需要另取原始 Trace 与对应版本记忆包。

## 已有的经验内容

### 参数与动作的语义经验

279 条映射按 operation family 分布为：coverage 107、capacity 92、handover 32、access 29、interference 14、other 5。分类是源标注，不表示每个签名只适用于这一种现场问题。

具体标注包括：

- `QRxLevMin` 增加被解释为收紧最低接收/接入门限和选择/重选准入边界。
- Msg3 HARQ 最大传输次数增加被解释为提高 Msg3 重传容忍度。
- NR 切换准备失败惩罚次数/定时器分别保留次数与持续时间的动作语义。
- SRI 虚警门限、远端干扰 PUSCH 增强、NR 负荷均衡切换接纳等开关有独立概念与适用身份。
- 增加与减少、打开与关闭、同名但厂商语义不同的参数，需要依据归并策略分别处理。

这些适合作为参数词典、解释参考和规范化规则。其 `effect_direction` 是知识层的意图/机制说明，不能转换为“这个调整已经证明能改善当前工单”的效果承诺。CSV 审核策略和原始厂家/制式/参数身份应共同保留。

### 实验得到的系统经验

1. **挂更多案例不必然改善最终选择。** 6 月 27 日 strategy-first 小样本实验显示，为候选补齐 case/episode 来源有解释和审计价值，但没有解决 Top-1 选择问题；文档后来修正了原先假设。
2. **缺少干净当前参数快照时，历史子项统计不能确定本单调多少。** 同一实验记录没有使用当前参数 snapshot，值选择器没有形成有效收益。
3. **不能全局放松风险阈值来换覆盖率。** 7 月 9 日方向审计记录，部分阈值放松同时增加正向放行和已知失败漏放；结论倾向改善证据区分与细粒度支持，再考虑释放规则。
4. **执行失败、未执行方案和效果失败需要分开。** 原始字段审计区分效果证据、未执行候选/方案结构、流程约束；未执行动作不能继承所在工单的 Pass/Fail。

这些是具体协议下的研究结论，适合沉淀成系统规则、反例和验收用例；不是通用无线参数优化规律。

## 当前 harness-wiki 中的状态

远程 LightRAG 当前有效文档仅 1 份：`A-RAG.pdf`。网优材料已通过本地结构化工具接入 Harness，不依赖远程文档入库：默认 `rag-kb` profile 加载 `dsh-wireless`，部署携带固定来源版本与 SHA-256 清单。

已安装 **13 个网优 Skill**：保留原 11 个，新增 `wireless-data-analysis` 与 `wireless-memory-engineering`。分析入口消费历史、对照当前数据回答；工程入口驱动记录、评价和编译。[ECHO-Mem 分析契约](../../skills/wireless-workorder-orchestrator/references/echo-analysis-method.md) 将源召回、候选分池、证据对照、方案比较、值适配与反证复核落实到真实入口，未接入研究消费者的步骤明确保留缺口。

工具共 9 个：新增 `wireless_echo_decision` 和 `wireless_history_search`，保留 `wireless_echo_query`、`wireless_knowledge_query`、`wireless_case_search`、`wireless_parameter_check`、`wireless_workorder`、`wireless_compile_history`、`wireless_memory_query`。统一历史入口自动发现并校验本地包，返回六类记忆、正向/复核/反证池与来源状态，无需用户指定包 ID。ECHO 原理工具分别提供 158 份复现文本和 10 份根目录源 Skill/Shadow/选择提示文本。决策工具按需运行源 ranker、受限 ID 物化和真实当前快照值选择，三项可独立组合；未加载校准 gate。工单工具保存 ID/阶段、方案/实际反馈及事件输入结果，隔离观测、核对引用和比较效果；编译器沿用固定源准入/归因、状态/评分/画像与校验和。新包自动纳入后续检索，旧包与快照继续保留；演示与真实历史分开，不自动发布或开启现网 gate。

缺少某个工单的当前 KPI 或归档评价时，相应阶段返回缺失输入；Skill 已接入。现场采集接口、全量生产历史导出和校准 gate 尚未预置。根因记忆的结构性 validated 不等于当前根因确证或参数效果通过。

Git 文件树未包含 `data/raw/train.csv`、原始 XLSX/大规模工单 CSV、`data/staged/` 全集或 `memory_package/exports/` 内容。`memory_package/sample/` 仅提供生成说明。实验文档提到大规模历史数据，说明数据曾被研究使用；并不表示数据已随当前快照提供。

现在可以从四类入口提问：结构化切换演示、匿名双动作低接通案例、成功推荐叙述、反证复核叙述。机器样例和叙述案例分别标记并保留原始引用；动作本体、归并审核规则与 3 条筛选后的研究经验已经随工具提供。扩展历史对比与效果统计时仍需实际历史导出或可追溯的 MemoryPackage。

## 来源

- [脱敏工单 JSONL](https://github.com/Jinbo666/wireless_knowledge_compilation/blob/e734ac032a7dc671878d05cd40d2b31b68d156fc/data/samples/eval_traces_sample.jsonl)、[样例说明](https://github.com/Jinbo666/wireless_knowledge_compilation/blob/e734ac032a7dc671878d05cd40d2b31b68d156fc/data/samples/README.md)
- [动作语义映射](https://github.com/Jinbo666/wireless_knowledge_compilation/blob/e734ac032a7dc671878d05cd40d2b31b68d156fc/data/raw/action_ontology/action_ontology_reviewed_draft_v2.json)、[签名归并策略](https://github.com/Jinbo666/wireless_knowledge_compilation/blob/e734ac032a7dc671878d05cd40d2b31b68d156fc/data/raw/action_ontology/action_ontology_signature_policy_v2.csv)、[关联审核策略](https://github.com/Jinbo666/wireless_knowledge_compilation/blob/e734ac032a7dc671878d05cd40d2b31b68d156fc/data/raw/action_ontology/action_ontology_link_policy_v2.csv)
- [成功与反证案例](https://github.com/Jinbo666/wireless_knowledge_compilation/blob/e734ac032a7dc671878d05cd40d2b31b68d156fc/docs/experiments/echo-mem-case-studies-20260621.md)
- [实际双动作工单的匿名展示](https://github.com/Jinbo666/wireless_knowledge_compilation/blob/e734ac032a7dc671878d05cd40d2b31b68d156fc/paper/manuscript/ECHO-Mem_Overview_Trace_Example.md)
- [Strategy-first 样本证据实验及修正结论](https://github.com/Jinbo666/wireless_knowledge_compilation/blob/e734ac032a7dc671878d05cd40d2b31b68d156fc/docs/experiments/echo-mem-strategy-sampled-evidence-dev-20260627.md)
- [方向约束与风险放松审计](https://github.com/Jinbo666/wireless_knowledge_compilation/blob/e734ac032a7dc671878d05cd40d2b31b68d156fc/docs/experiments/echo-mem-direction-guard-badcase-audit-dev-20260709.md)
- [原始字段与准入边界审计](https://github.com/Jinbo666/wireless_knowledge_compilation/blob/e734ac032a7dc671878d05cd40d2b31b68d156fc/docs/experiments/raw-source-field-opportunity-audit-20260711.md)
- [JSAC 中文主稿](https://github.com/Jinbo666/wireless_knowledge_compilation/blob/e734ac032a7dc671878d05cd40d2b31b68d156fc/paper/manuscript/ECHO-Mem_JSAC_Chinese_Full.md)、[专家经验分享大纲](https://github.com/Jinbo666/wireless_knowledge_compilation/blob/e734ac032a7dc671878d05cd40d2b31b68d156fc/paper/manuscript/ECHO-Mem_Expert_Experience_Sharing_Master_Outline.md)
