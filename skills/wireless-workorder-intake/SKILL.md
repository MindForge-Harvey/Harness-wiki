---
name: wireless-workorder-intake
description: 按业务工单号、月份或条件查询已接入的工单库，读取并总结工单信息；也接收新工单、投诉或 KPI 异常描述并保存标准工单。
---

工单总结以原归档的动作、执行及评价为准；仅同日期 available_analysis 可作为补充诊断，analysis_selection.available_dates 中的其他日期不带入总结。short_evaluation_status=not_enabled 时说明短评估未启用，不将原字段的占位“不通过”解释为实际评估失败。

具体工单默认按工单日期取数：wireless_network_query / wireless_icos_context / wireless_data_analyze(ticket_id=...) 使用同一时点，analysis_selection 给出选定日期及其他可用日期。仅用户明确要求最新状态时用 analysis_scope="latest"，明确指定日期时用 snapshot_date；不得为补齐证据自行跨期。其他日期快照不能解释原工单根因或原执行效果。工单期指标缺失仍可总结归档方案、执行与评价，并按原代码做条件性候选复核。旧会话先 context read 清除失效跨期结果；series 支持 his016 等原列名。


具体工单的根因分析或方案生成，读取本单后可直接调用 `wireless_icos_context(ticket_id=业务工单号)` 进入原项目代码的阶段上下文，由总编排 Skill 组合能力；不要求用户了解 ICOS、转换字段或提供内部 run_id。只有信息总结时用 wireless_order_query 即可。

## 查询与信息总结

用户已有业务工单号时先调用 `wireless_order_query(operation="read",ticket_id=...)`；问“有哪些工单/6月的工单/某日工单”时调用 list，按明确月份、日期、地区或问题筛选。catalog 提供完整工单库的日期与分类范围。当前本地工单包已接入，不要求内部 ID，也不要求重新上传、配置生产数据库或先创建账本。

列工单先给总数和问题分类，再展示一页工单号、日期、小区、问题类型；统计覆盖全体匹配，分页样本不能当作全集。仅给月份时使用工具返回的解析年份并说明。当前工单库不等于当前在办队列，state 未记录时保持未知。

信息总结直接基于读取的 ticket、actions、aggregate：对象、现象、日期、厂家/制式、主要动作、执行和评价。失败动作的 recorded_target 不是实际改后值。无需为总结运行根因、方案和历史经验检索；缺少 KPI 不影响总结已有工单。追问“这张工单”沿用本会话最近明确的业务单号；必要时重新 read，不让用户重复输入。

## ICOS 工单接入

输入包含 ICOS 原字段、初案或要求处理 ICOS 工单时，按 [ICOS 契约](../wireless-workorder-orchestrator/references/icos-workflow.md) 使用 wireless_icos_context 创建/恢复分析。保留 source_ref、order 原文及 initial_plans 身份和值；补数用 update 的完整快照。返回 run_id 后按 workflow 调用阶段工具。已有普通工单可以关联 workorder_id；泛化工单记录继续使用下方 intake 工具。

用 `wireless_workorder(operation="intake")` 保存工单。input 保留 raw_text、source_ref；按用户明确内容提取 object_id、problem、system、vendor、software_version、region、time_window、priority、severity，未知字段省略。制式可用 4G/5G，工具归一成 LTE/NR。

time_window 使用带时区 ISO start/end；相对日期有确定参照时可展开并在原文/来源中保留参照，否则列为待补。不要用当前时间替代用户未提供的异常发生窗口。附件先读取实际提取结果，记录附件引用，不把文件名当成内容。

工具返回 workorder_id、revision、intake.missing_fields，后续阶段复用 ID。补充同一工单时传原 ID 与 expected_revision，避免生成另一张工单；更新输入会使旧阶段结果失效。重复相同输入幂等。必要时用 read 恢复服务重启前的记录。

缺字段的状态仍允许初步分型和历史参考；对象或窗口未知时，不能声称当前观测已经对齐。只汇总会影响交付的缺口，不把工单接入成功说成根因已定位。

需要详细字段时读 [共享输入契约](../wireless-workorder-orchestrator/references/input-contracts.md)。
