---
name: wireless-root-cause-analysis
description: 复用原项目代码与提示词收敛工单根因，读取结论及六维原文并核对引用；结合当前观测和历史反证解释缺口，用于具体工单的根因分析。
metadata:
  code_source: network-ops-loop-v3/services/decision/cause_convergence.py; cause_dimensions.py
  method_source: wireless-root-cause-analysis/SKILL.md
  source_commit: e734ac032a7dc671878d05cd40d2b31b68d156fc
---

具体工单默认按工单日期取数：wireless_network_query / wireless_icos_context / wireless_data_analyze(ticket_id=...) 使用同一时点，analysis_selection 给出选定日期及其他可用日期。仅用户明确要求最新状态时用 analysis_scope="latest"，明确指定日期时用 snapshot_date；不得为补齐证据自行跨期。其他日期快照不能解释原工单根因或原执行效果。工单期指标缺失仍可总结归档方案、执行与评价，并按原代码做条件性候选复核。旧会话先 context read 清除失效跨期结果；series 支持 his016 等原列名。


## 分析时点与缺口

以 analysis_selection/analysis_basis 的来源和日期解释诊断。默认复盘原工单时期；用户明确改为最新或指定日期重新诊断时，先说明原工单仅用于定位小区、本轮针对所选日期，不将两次状态拼成一次事件。缺少同日指标时保留根因未确认，仍交付归档已知事实和可完成的候选复核；只提确实影响结论的定向补证。异常判定用 declared_thresholds/anomaly_thresholds，优化目标用 evaluation_targets，不能混用。

资料齐全时只交付本轮根因、支持证据与对当前方案的影响，不固定追加资料缺口或完整性提醒。不要借当前未采用某动作，反推归档那次动作一定错误或导致恶化。

## ICOS 原文根因收敛

具体工单默认使用原项目代码，不要求用户说“ICOS”。只有业务单号时先加载工单接入 Skill 并用 wireless_icos_context(ticket_id=...) 建立上下文；已有 run_id 则复用。按 [ICOS 契约](../wireless-workorder-orchestrator/references/icos-workflow.md) 调用 wireless_icos_root_cause，阅读 judgment_requests[].prompt，提交 judgment 与 judgment_token。cause/evidence 只来自结论与六维原文；代码验证逐字引用、分数和字段。这里的 0–100 confidence 是原文支撑强度，不是当前因果概率；其含义与下方开放式诊断、ECHO 历史可信度分别保留。新观测可用数据 Skill 独立分析，不声称源收敛算法已经消费 KPI。

ICOS 单阶段测试先用 context read view=summary 核对输入。result.status=not_called 且 causes 为空时，表示已经完成原文缺口检查；没有 needs_judgment 就不提交判断或令牌，不调用候选/方案工具来代替根因结果。用户只请求这一阶段时交付原始现象、不能确认根因的原因和定向补证项，然后结束。参数机理或厂家触发公式未核实的方向，不扩写成“门限偏高导致未测量”等候选机制；只列需要核对的公式和观测。需要开放式假设比较时再单独执行下方方法，并保留未验证性质。

## 补充历史与开放式诊断

以下用于没有具体工单的开放问题，或作为原阶段结果的补充，不替代原代码的根因收敛。

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
