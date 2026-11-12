---
name: wireless-data-analysis
description: 按 ECHO-Mem 历史经验对照当前无线 KPI、MR、KQI、告警和参数数据，核对口径、计算有依据的差异并解释根因线索；用于指标异常、数据变化和场景比较。
metadata:
  method_source: wireless-evidence-builder/SKILL.md; wireless-root-cause-analysis/SKILL.md
  source_commit: e734ac032a7dc671878d05cd40d2b31b68d156fc
---

具体工单默认按工单日期取数：wireless_network_query / wireless_icos_context / wireless_data_analyze(ticket_id=...) 使用同一时点，analysis_selection 给出选定日期及其他可用日期。仅用户明确要求最新状态时用 analysis_scope="latest"，明确指定日期时用 snapshot_date；不得为补齐证据自行跨期。其他日期快照不能解释原工单根因或原执行效果。工单期指标缺失仍可总结归档方案、执行与评价，并按原代码做条件性候选复核。旧会话先 context read 清除失效跨期结果；series 支持 his016 等原列名。


## ICOS 当前数据

已有 ICOS run_id 时用 wireless_icos_context(operation="read") 读取工单及已有 observation_analysis；创建时 observations 已调用现有 wireless_data_analyze 计算。有新观测时用 context update 保存完整输入，或直接用下方数据工具分析。ICOS 原根因收敛消费结论/六维原文，新 KPI 分析作为单独证据解释。阶段字段与调用方式见 [ICOS 契约](../wireless-workorder-orchestrator/references/icos-workflow.md)。

读取优先使用 view=summary。parameter_changes 已由代码逐项计算数值差值、枚举变化及是否实际改变；单位未知时保留源编码，recorded_target 是归档建议，不能称为真实改后值。input_summary.observation_count=0 时，直接交付参数变化和 KPI 时序缺口，不生成参数伪观测、不造时间窗，也不为“试算”编写 JSON/JSONL 文件交给 KPI 分析器。只有真实 KPI observations 才调用 wireless_data_analyze。

数据能力从源 evidence-builder 的证据维度和 root-cause-analysis 的问题诊断框架拆出；源没有同名数据 Skill 或自动 KPI 诊断器，当前口径对齐和差值计算是这些方法的输入适配，不能发明领域判据。读 [ECHO-Mem 分析契约](../wireless-workorder-orchestrator/references/echo-analysis-method.md)。先按问题现象/参数执行 wireless_history_search，取得历史案例、根因、策略和反证；缺当前数据仍先查历史，返回可比经验和具体补数方向。

从真实输入、附件提取观测，保留对象、窗口、制式、厂家、单位、计数器定义、人群、样本量与来源。已有工单 read 当前证据；工程流程中用 wireless-evidence-builder 对齐，隔离冲突。普通数据分析可在当前输入上计算，无需创建工单。

只计算实际数据支持的比例、差值和趋势；大文件用工作区脚本解析并保留真实退出状态。跨对象、口径、窗口或样本不可比时分别说明。百分比绝对差用百分点，相对变化另列；无阈值来源时只报告观测，历史分布不自动变为当前告警门限。

结构化观测可直接交 wireless_data_analyze，传 observations 或工作区 JSON/JSONL file_path。工具按对象、指标、单位、定义、人群分组，检查非法观测和重复冲突，计算基线/近期差异、声明门限越界、时段特征和同窗口相关性；均值只对等长且不重叠窗口成立，相关性不用于证明因果。场景库通过 wireless-demo-analysis 提供数据和独立历史，不与真实检索混合。

指标口径缺失时先列待核对项，再提出条件性解释。例如 PRB 利用率 95% 与平均吞吐 3 Mbps，在小区/用户吞吐、带宽、活跃用户数和同窗口尚未明确时，不能计算或断言每 PRB 承载效率低，不能认定吞吐异常、已饱和或排除覆盖/干扰原因。保留负荷、链路质量、统计口径等并列假设，说明哪项数据能区分；不根据这两个数字给主因或高概率结论。

将“当前观测 → 对应历史场景/根因线索 → 支持与反对 → 待区分项”连起来。历史没有指标前后值时只比较现象、动作和整体评价，不生成改善幅度或历史分位数。没有历史命中就说明范围，保留已有研究经验与一般机制推断的来源边界。

参数语义和方案名称只能提示机制及候选动作；缺实际执行记录时不能称历史上处理过、常用或效果有效，不用语义条目数量决定根因概率或方案优先级。

交付数据发现、历史对照、对根因/方案的影响及关键缺口；原因判断交 wireless-root-cause-analysis，方案比较交 wireless-solution-decision，共用检索结果。候选历史支持与实际执行前后效果交 wireless-effect-evaluation；需要保存评价时通过工程入口记录，不能把普通指标变化当作已执行优化效果。
