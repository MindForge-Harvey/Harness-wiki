---
name: wireless-problem-identification
description: 依据标准工单现象与当前异常指标做无线问题初步分型，保留候选类型、未知严重度和后续取证方向；用于诊断前的问题识别。
---

已有 workorder_id 用 `wireless_workorder(operation="identify", workorder_id=...)`；新工单先加载 wireless-workorder-intake。工具使用原始现象和已对齐证据中的声明阈值异常，返回 primary_issue_type、candidate_issue_types 和所需取证。

初步类型是症状分类，不是原因确证：低速率不等于容量不足，切换差不等于邻区漏配，掉线不等于弱覆盖。保留混合类型与尚未排除的方向。工具的关键词规则可能只给出部分候选；补充解释必须说明依据，不能给没有阈值或业务定义的指标贴“异常”标签。

severity、priority 没有用户口径时保持 unknown。若有现场业务判据，保留它的来源再解释严重度；不以历史动作通过率推导当前严重度。

按候选类型进入 wireless-evidence-builder。已有同版本分型可复用；当前证据更新后 identify 会失效，需要重算。没有具体症状则指出所缺现象，不强行唯一分型。
