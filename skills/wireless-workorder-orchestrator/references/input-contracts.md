# 无线工单工具输入契约

所有事实来自用户描述、已读取附件或明确提供的数据。`source_ref` 可指附件及页/行号，或“本次用户提供的指标”；这种引用不等于采集源已核验。工具不自动拉取现场系统。

## intake / read

`wireless_workorder` 的 `operation="intake"`、`input`：

```json
{
  "raw_text": "用户工单原文",
  "source_ref": "附件或用户输入引用",
  "external_id": "可选外部工单编号",
  "object_id": "实际小区/网元 ID",
  "problem": "实际问题描述",
  "system": "LTE",
  "vendor": "实际厂家",
  "software_version": "实际软件版本",
  "time_window": {"start": "2026-10-07T10:00:00+08:00", "end": "2026-10-07T11:00:00+08:00"}
}
```

日期为格式示例，未知事实省略。工具返回稳定 `workorder_id` 与 `revision`。更新同一工单传原 ID，必要时用 `expected_revision` 防止覆盖。`read`、`identify` 只需 operation 和 workorder_id。

## build_evidence

input 包含 `observations` 数组及可选 `historical_case_ids`。每条观测：

- `id` 可选；`kind` 取 kpi/mr/kqi/alarm/parameter/neighbor/context。
- `object_id`、`time_window`、`value`、`source_ref` 必需，窗口与当前工单对齐。
- KPI/MR/KQI 另需 `metric`、`unit`、`definition`，value 为有限数值。
- `sample_count` 为真实正整数；比例可保留 `numerator`/`denominator`，工具核对与 `%`/`ratio` value 的一致性。
- `threshold` 可选：`operator` 为 gt/gte/lt/lte，`value` 为判据，`source_ref` 为用户阈值来源。true 表示超过所声明异常判据，不是自动确认根因。
- `cohort` 可选，保留人群/业务口径；`good_direction` 可选 higher/lower，用于效果比较。

重复数据去重；重复 ID 的歧义、对象/窗口不匹配、缺少来源或口径进入 quarantine。工具输出 `evidence_id`，后续根因引用它。替换证据包时将仍有效的旧观测合并后提交。

## diagnose

input 为 `hypotheses` 数组，每项：`cause`、`supporting_evidence_ids`、`contradicting_evidence_ids`、`distinguishing_checks`，可选 `hypothesis_id` 与 `source_refs`。source_refs 保留实际历史案例或包/记忆/Trace 出处；支持与反对只引用当前已对齐 evidence_id。历史出处不冒充当前证据，工具核对当前引用，不自动证明因果或核验出处文字。

## evaluate

input：

```json
{
  "execution": {
    "state": "executed_success",
    "executed_at": "2026-10-07T11:00:00+08:00",
    "actions": [{"parameter": "实际参数", "before": "实际前值", "after": "实际后值"}]
  },
  "before": [],
  "after": [],
  "evaluation_rule": {
    "min_observation_hours": 1,
    "required_metrics": ["实际评价指标"],
    "min_absolute_improvement": 0,
    "source_ref": "用户业务判据"
  }
}
```

before/after 使用上述观测字段。示例时间与判据不作默认值。state 可为 executed_success/execution_failed/not_executed/unknown；两窗需同对象、同定义/单位/人群、同长度，分居实际执行时间两侧，不重叠。每个指标给 good_direction；观察规则满足时才评价所声明目标是否达到。单位 `%` 的绝对改善用百分点。无样本量或规则时只做描述性比较。

已有反馈时传 `execution_id` 替代 execution；只使用该工单、当前输入版本的反馈。不同动作执行时间不能自动捏成单一时刻。工具不将声明判据通过写成源 long_eval_pass。

## save_plan / record_execution / history

`save_plan` 的 input：

```json
{
  "title": "针对该工单的候选方案",
  "rationale": "机制依据与当前证据，仍待确认的条件",
  "source_refs": ["实际手册/案例来源或用户方案声明"],
  "evidence_ids": [],
  "historical_case_ids": [],
  "actions": [{
    "parameter": "实际参数对象.参数名",
    "current": -64,
    "target": -62,
    "constraints": {"min": -156, "max": -44, "step": 2, "unit": "源编码", "constraint_source": "用户声明当前约束"}
  }],
  "preconditions": ["该方案实际适用条件"],
  "evaluation_rule": {"source_ref": "实际业务判据"}
}
```

数值只演示格式，不是当前厂家默认。current、target 和 constraints 未知时省略；工具保留缺口，不以历史范围填现场约束。保存 plan_id、每个 action_id 及原输入版本；方案状态为候选，不授予执行权限。

historical_case_ids 只接受固定快照检索返回的案例 ID。本地记忆包的依据在 source_refs 中保留 package_id、memory_id 与 trace_ids；不能将 memory_id 填入 historical_case_ids 或当前 evidence_ids。source_refs 是来源声明，不等于工具已校验这条历史出处。

`record_execution` 的 input：

```json
{
  "plan_id": "save_plan 返回的 pl_...",
  "source_ref": "用户执行反馈或实际平台日志引用",
  "actions": [{
    "action_id": "方案中已有的 pa_...",
    "state": "executed_success",
    "executed_at": "2026-10-07T11:00:00+08:00",
    "before": -64,
    "after": -62,
    "detail": "实际反馈内容"
  }]
}
```

state 为 executed_success/execution_failed/not_executed/unknown/rolled_back。回退另记 rollback_at、rollback_value；失败可保留 failure_reason。缺实际时间或前后值可记录但保持 gaps，不能从方案补出。不同 action_id、混对象、重复动作或非法时间拒绝。更正追加 supersedes_execution_id，原反馈保留。记录工具不执行设备操作。

`history` 用工单 ID 和可选 input.limit（默认最近 20 条，1 至 100），返回事件原始输入/结果、方案和执行版本；`read` 恢复当前阶段。旧方案和反馈在补充工单输入后仍保留，但不直接套用于新输入的评估。它们是 Harness 审计记录，尚未转换成源 TraceRecord。
