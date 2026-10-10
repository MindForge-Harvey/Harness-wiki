---
name: wireless-workorder-intake
description: 接收无线工单、投诉或 KPI 异常描述，提取有来源的对象与时间信息，形成可恢复的标准工单并标记缺失字段；用于新工单接入与补充工单信息。
---

用 `wireless_workorder(operation="intake")` 保存工单。input 保留 raw_text、source_ref；按用户明确内容提取 object_id、problem、system、vendor、software_version、region、time_window、priority、severity，未知字段省略。制式可用 4G/5G，工具归一成 LTE/NR。

time_window 使用带时区 ISO start/end；相对日期有确定参照时可展开并在原文/来源中保留参照，否则列为待补。不要用当前时间替代用户未提供的异常发生窗口。附件先读取实际提取结果，记录附件引用，不把文件名当成内容。

工具返回 workorder_id、revision、intake.missing_fields，后续阶段复用 ID。补充同一工单时传原 ID 与 expected_revision，避免生成另一张工单；更新输入会使旧阶段结果失效。重复相同输入幂等。必要时用 read 恢复服务重启前的记录。

缺字段的状态仍允许初步分型和历史参考；对象或窗口未知时，不能声称当前观测已经对齐。只汇总会影响交付的缺口，不把工单接入成功说成根因已定位。

需要详细字段时读 [共享输入契约](../wireless-workorder-orchestrator/references/input-contracts.md)。
