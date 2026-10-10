---
name: wireless-data-analysis
description: 按 ECHO-Mem 历史经验对照当前无线 KPI、MR、KQI、告警和参数数据，核对口径、计算有依据的差异并解释根因线索；用于指标异常、数据变化和场景比较。
metadata:
  method_source: wireless-evidence-builder/SKILL.md; wireless-root-cause-analysis/SKILL.md
  source_commit: e734ac032a7dc671878d05cd40d2b31b68d156fc
---

数据能力从源 evidence-builder 的证据维度和 root-cause-analysis 的问题诊断框架拆出；源没有同名数据 Skill 或自动 KPI 诊断器，当前口径对齐和差值计算是这些方法的输入适配，不能发明领域判据。读 [ECHO-Mem 分析契约](../wireless-workorder-orchestrator/references/echo-analysis-method.md)。先按问题现象/参数执行 wireless_history_search，取得历史案例、根因、策略和反证；缺当前数据仍先查历史，返回可比经验和具体补数方向。

从真实输入、附件提取观测，保留对象、窗口、制式、厂家、单位、计数器定义、人群、样本量与来源。已有工单 read 当前证据；工程流程中用 wireless-evidence-builder 对齐，隔离冲突。普通数据分析可在当前输入上计算，无需创建工单。

只计算实际数据支持的比例、差值和趋势；大文件用工作区脚本解析并保留真实退出状态。跨对象、口径、窗口或样本不可比时分别说明。百分比绝对差用百分点，相对变化另列；无阈值来源时只报告观测，历史分布不自动变为当前告警门限。

指标口径缺失时先列待核对项，再提出条件性解释。例如 PRB 利用率 95% 与平均吞吐 3 Mbps，在小区/用户吞吐、带宽、活跃用户数和同窗口尚未明确时，不能计算或断言每 PRB 承载效率低，不能认定吞吐异常、已饱和或排除覆盖/干扰原因。保留负荷、链路质量、统计口径等并列假设，说明哪项数据能区分；不根据这两个数字给主因或高概率结论。

将“当前观测 → 对应历史场景/根因线索 → 支持与反对 → 待区分项”连起来。历史没有指标前后值时只比较现象、动作和整体评价，不生成改善幅度或历史分位数。没有历史命中就说明范围，保留已有研究经验与一般机制推断的来源边界。

参数语义和方案名称只能提示机制及候选动作；缺实际执行记录时不能称历史上处理过、常用或效果有效，不用语义条目数量决定根因概率或方案优先级。

交付数据发现、历史对照、对根因/方案的影响及关键缺口；原因判断交 wireless-root-cause-analysis，方案比较交 wireless-solution-decision，共用检索结果。候选历史支持与实际执行前后效果交 wireless-effect-evaluation；需要保存评价时通过工程入口记录，不能把普通指标变化当作已执行优化效果。
