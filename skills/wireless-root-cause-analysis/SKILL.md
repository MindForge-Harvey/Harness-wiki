---
name: wireless-root-cause-analysis
description: 按 ECHO-Mem 方法先查历史工单和根因/反证经验，再对照当前数据比较无线根因假设、支持与反对依据及区分检查；用于为什么异常和主辅原因判断。
metadata:
  method_source: wireless-root-cause-analysis/SKILL.md
  source_commit: e734ac032a7dc671878d05cd40d2b31b68d156fc
---

先读 [ECHO-Mem 分析契约](../wireless-workorder-orchestrator/references/echo-analysis-method.md)。调用 `wireless_history_search`，或复用仍适用的真实检索结果，读取历史案例、rca_memory、风险和反证。没有当前 KPI 或没有命中仍要完成检索并说明结果，保留可用参数机制与研究经验。

方法继承源仓库同名 Skill 的“问题诊断框架 → 多维证据 → 主辅根因 → 不确定性 → 优化方向”，并按源 extract_root_cause/build_rca_memories 的标签边界使用历史。源版本与读取路径见 [ECHO 能力目录](../wireless-workorder-orchestrator/references/echo-capabilities.md)。模型执行这套证据比较，不能把历史标签频数、相似案例数量或长评 Pass 当作当前因果证明。

按 [根因方法](../wireless-workorder-orchestrator/references/echo-decision-workflow.md#根因分析) 选择与问题有关的诊断维度，不机械遍历：低速率看覆盖、干扰、容量、调度、功控和终端；掉线看保持性、切换、邻区、告警和质量；接通看接入过程、随机接入、门限、告警和覆盖。它们是源 Skill 的候选框架，不是凭现象锁定的根因。

分别核对指标、参数、告警、MR/KQI/路测、邻区/拓扑、历史案例依据。只展开会影响本轮判断的维度，说明各维度已知事实、支持/反对机制与缺口；缺一类不补造事实，也不阻断其他有依据的分析。多维一致且有区分力时才提高定性确定程度；冲突或只有现象时保留并列假设，不输出虚构概率。

源诊断维度提供候选框架，具体因果链须有本轮历史材料、参数作用解释或实际观测依据；依据未覆盖时只保留维度与待验证检查，不扩写未经核对的跨链路机制。原始描述和模型解释分开：“忙时慢”不能补成“只有忙时慢、闲时正常、负荷已高”。只有现象时交付并列候选和取证优先级，不按模型直觉给根因概率或主辅排序。

已有 workorder_id 时 read 当前证据；需要持久化对齐时加载 wireless-evidence-builder。普通原因问答可直接整理用户提供的事实，不要求创建工单。指标分析加载 wireless-data-analysis，共用历史检索结果。

逐项比较：历史根因及当时依据、当前支持/反对观测、场景与参数差异、尚未排除的原因、能区分候选的下一项检查。历史标签与组合效果只提供假设线索；若没有对应历史支持，明确该候选来自一般机制推断。新证据改变假设方向时才聚焦补查。

案例按 case_id、工单或源 Trace 去重；同一工单的多个参数应用不是多条独立成功案例。只引用会影响本轮判断的历史动作与数字，并逐项核对本轮返回的原值；不同问题族的背景案例主要解释适用差异，不展开无关数值，也不把其动作变成本轮根因证据。

在工程处理或用户要求保存时用 `wireless_workorder(operation="diagnose", workorder_id=..., input={hypotheses:[...]})`。每项包含 cause、supporting_evidence_ids、contradicting_evidence_ids、distinguishing_checks；source_refs 可保存历史案例或包/记忆/Trace 的出处。当前引用必须来自 current_evidence，历史出处单独保存，不能使用隔离、虚构或历史 ID 代替当前观测。

工具核对引用与冲突，返回 current_evidence_supported_hypothesis、counter_evidence_present 或 unverified_hypothesis。这是证据绑定，不是因果校准。说明每条观测如何支持或反对该机制；不要只列 ID 后宣称根因确定。

主辅原因可以按当前证据的特异性和反证比较，但不用长评通过率给根因正确率评分，不编造百分比置信度。没有当前观测时仍可给候选假设与区分检查，明确尚未验证。参数具体方向交给 wireless-solution-decision 和 wireless-parameter-adaptation。

交付每个有关候选的来源、场景差异、当前支持/反对、剩余歧义及能改变判断的下一项检查。给主因时解释为什么比备选更受当前证据支持；无法区分时保留并列假设。检索未命中只限制历史支持，不阻断有机制依据的条件性分析。

详细假设字段见 [共享输入契约](../wireless-workorder-orchestrator/references/input-contracts.md)。
