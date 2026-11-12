# ICOS 工单分析工具契约

具体工单的根因分析、方案生成、候选比较与综合裁决默认使用此契约，无需用户说“ICOS”。支持业务工单号、带结论/六维/初案的输入，以及已有 run_id 的续办。ECHO-Mem 用于补充历史，不替代原项目阶段逻辑；无具体工单的开放式问题可使用历史分析方法。

## 创建与恢复

调用 `wireless_icos_context(operation="create", input=...)`，或将同契约 JSON 写入工作区后用 `file_path`。输入最大 4 MB。保存返回的 `run_id`，后续所有阶段均使用它。`read` 恢复完整输入、阶段结果、revision 与 workflow；`update` 使用原 run_id 和完整的新输入快照补数，旧阶段随之失效。不要只提交局部字段覆盖完整输入。

只有业务单号时直接调用 `wireless_icos_context(ticket_id="业务工单号")`；ticket_id、input、file_path 三选一。入口从 SQLite 读取原单，将工单身份与归档初案映射到原字段，不导入本单执行/评价结果，不把方案组名填成诊断原文。初案 target 是当时建议值，不是新预测或已执行值。入口同时抽取最多 80 张更早、同问题/厂家/制式工单作为有界案例快照；只有整单动作均执行成功、长期评价一致且已知的记录进入原同类统计。样本计数不是全库计数，也不代表原决策时这些评价已可见。完整历史经验仍由 cases 阶段另查并保留来源。

`context(operation="read", ticket_id=..., view="summary")` 也可直接按业务单号解析当前上下文，不需要先知道 run_id。默认按原工单日期取数，不自动采用更晚快照。用户明确选择最新状态才传 analysis_scope="latest"，明确指定日期才传 snapshot_date；两者互斥。有业务单号时切日期也使用 ticket_id+snapshot_date，禁止手抄库内快照到 input 或修改 createtime。已知库内 source_ref 的转写输入会自动恢复原始完整快照，保留原工单日期与来源；用户新增补数使用独立 source_ref。跨期时原工单只用于定位小区，不解释原事件。各阶段的 analysis_selection / analysis_basis 给出选定时期、来源、阈值和目标；context read 保持已明确选择的时期，旧版未绑定日期的分析先刷新并清除失效阶段。

归档没有结论及六维原文时，root_cause 按原代码返回 not_called 与缺口，不能根据动作名或事后评价编造根因。已有初案可继续组织候选、检查参数和整单复核，给出条件建议及具体补证问题；不能把归档候选复核说成生成了新的参数动作。

## 原代码对应关系

固定源文件位于 `backend/dsh/dsh-wireless/vendor/icos/`，SHA-256 记录在 source-manifest.json。阶段工作器仅适配输入与 Harness 判断，业务计算继续调用以下源内核：

| 阶段 | 原项目 services/decision 中的实现 |
| --- | --- |
| 根因收敛 | cause_dimensions.converge_order、dimension_verdicts；cause_convergence.converge_root_causes_llm |
| 目标确认 | verdict._build_objective |
| 同类案例 | case_evidence.build_case_evidence |
| 生成候选与组内寻优 | candidate_set.build_candidate_set、relevance.judge_relevance_llm |
| 根因与方案对齐 | cause_alignment；原提示词与解析器 |
| 参数规则、方向与幅度 | rule_assessment、case_steps，调用 services/compliance 原规则 |
| 整单复核 | order_review、chain.drop_by_review、drop_conflicts |
| 综合决策 | chain.resolve_conditions、verdict.build_order_decision |
| 多轮调整与回退建议 | prior_round、multi_round.plan_multi_round_steps / plan_rollback |

原决策服务的 KPI 取数阶段只展示指标，不进入根因收敛。当前 context 有 observations 时可独立调用指标分析器，但不得宣称原根因收敛已经读取 KPI 或新增了原代码没有的因果规则。

## 完整输入示例

```json
{
  "source_ref": "用户本次提供的 ICOS 工单导出",
  "order": {
    "taskno": "用户真实工单号",
    "task_type": "宏站弱覆盖小区",
    "cell_name": "用户提供的小区",
    "nettype": "4g",
    "vendor": "华为",
    "conclusion": "用户提供的原始分析结果",
    "smart_conclusion": "用户提供的原始分析概述",
    "cover_totalverdict": "用户提供的覆盖维判定原文"
  },
  "initial_plans": [
    {
      "execution_id": "用户提供的执行编号",
      "plan_number": "用户提供的方案编号",
      "type1": "覆盖",
      "type2": "弱覆盖",
      "parachinname": "用户提供的参数中文名",
      "f_para": "用户提供的当前值",
      "b_para": "ICOS 原始建议值"
    }
  ]
}
```

示例中的字符串是字段说明，不能直接当作工单事实。未知可选字段省略。六维字段为 `cover_totalverdict`、`adj_totalverdict`、`param_totalverdict`、`interfere_totalverdict`、`alarm_totalverdict`、`resource_totalverdict`，有几维带几维。每轮最多 40 条初案，使用原裁决计数边界；execution_id 必须唯一。每条初案需要 execution_id 和 parachinname，保留 type1/type2/execute_number/vendor/plan_group_number 等原字段；不使用 final_ratio。工具不从描述猜初案或当前值。

其他可选输入：

- `observations`：与 `wireless_data_analyze` 相同的有来源观测，context 实际调用现有指标分析器；新取数尚未连接，原 ICOS 根因收敛仍只消费原文。
- `cases`：最多 500 条，每条需要唯一 case_id、source_ref、problem_type/task_type、cause1/type1、cause2/type2、estimate_result 与 actions。动作包含 parachinname/parameter、f_para/before、b_para/after。保留 taskno、厂家、制式、地市。工具按源词表归一并运行原匹配/统计。
- `rules`：最多 2000 行 ICOS 规则快照，字段 type1/type2/nettype/vendor/parachinname/para/rule_scope/execute_number/band/is_use。省略则使用随代码携带的原规则 CSV。工具执行原五元组匹配、方向与步长规则，不把规则快照解释为现场厂家版本已确认。
- `retry_times`：当前轮次，从 0 起。大于 0 时需要 prior_execution_rows；其中 short_result_id 与 short_evals[].id 对应，不能按轮次猜关联。
- `prior_execution_rows`：原执行行，含 execution_id、tool、f_para/b_para、原值、执行回执、retry_times、short_result_id、llm_solution 等原字段。
- `short_evals`：含唯一整数 id、short_assess_result 及原始前后指标。结论只接受改善、通过、恶化、不通过、未通过、缺失。
- 归档数据的长期评价与执行回执在用户请求效果分析时，通过 `wireless_icos_feedback` 的 `archived_feedback` 单独提交，含 source_ref 与 actions（execution_id、parameter、before、after、exec_state、short_eval_raw、long_eval_result、improvement_result、exec_failure_reason）。它独立存入反馈阶段，不加入决策前输入。短评估“未启用”保持未启用；失败动作的 after 记为尝试目标；长期 Fail 与“改善”冲突时保留冲突，不自动改判。
- `confidence_threshold`：默认 40。ICOS confidence 表示原文支撑强度，不能解释为当前根因正确概率，也不改 ECHO-Mem 的历史可信度口径。

可以在 context 中关联已存在的 `workorder_id`。最终 decision 的 `save_to_workorder=true` 会把选中动作保存到现有工单账本的候选方案，不保存成实际执行。

分析完成后才创建工单账本时，用 context 的 `operation="link_workorder"`，仅传 run_id 和 workorder_id。此操作保留输入与全部分析阶段；不要用 update 进行关联。read 优先 view=summary，获取当前工单、parameter_changes 和阶段摘要；需要完整原始输入/历史时才使用 full。

## 阶段编排

完整首轮通常调用：context → objective、root_cause、cases → candidates → alignment、parameter_risk → consistency → decision。存在前轮记录时在 cases 后调用 multi_round，再构造 candidates。每个阶段首次执行前，用 skill 工具加载 workflow[].skill 对应的 Skill；同一会话已加载则复用。先加载接入 Skill 再创建 context，不能只读本总契约就省略各阶段的方法指引。objective/root/cases 可按需要独立使用；以每次返回的 workflow / missing_stages 为准。用户仅问某一阶段时完成相关阶段即可。

工具名称均以 `wireless_icos_` 开头：

| 后缀 | 产物 |
|---|---|
| context | 输入快照与观测计算，01 |
| objective | 目标、边界与未确认项，03 |
| root_cause | 根因收敛，02 |
| cases | 同类案例证据及现有 ECHO-Mem 检索，04 |
| candidates | 方案组、方案、参数及组内关联判断，04 |
| alignment | 根因与方案对应关系，05 |
| parameter_risk | 原规则校验及目标值适配，07 |
| consistency | 整单相关性/冲突复核与剩余集合条件，06 |
| decision | 完整 OrderDecision、逐动作和整单裁决，08 |
| multi_round | 缩步长、反向或回退建议 |
| feedback | 已提供的执行回执及短评估分类 |

## 模型判断协议

root_cause、candidates、alignment、consistency 首次只传 run_id。返回 `needs_judgment` 时，逐条阅读 `judgment_requests[].prompt`，按原输出契约完成判断，再用同一个工具提交 `judgment`；candidates 使用 `judgments`，按返回的 key 映射到每组判断。提交时带上返回的 `judgment_token`，保证使用的是本轮上下文。

- 根因输出 `{causes:[{cause,category,confidence,evidence}],reasoning}`，最多五条；evidence 必须逐字摘录输入，分数表示原文支撑强度。
- 组内判断为 `{relevant_plans:[本组 plan_number],reasoning}`；并列关联都保留，不编造表外方案。
- 对齐输出 `{plans:[{plan_id,relation,causes,reason}],reasoning}`；plan_id 和 relation 严格使用返回提示词中的值。
- 复核输出 `{actions:[{execution_id,parachinname,relevance,path,evidence}],conflicts:[...]}`；逐动作键和词表严格使用提示词。冲突必须明确 is_conflict=true，成员均为准备采用的动作。

`needs_judgment` 表示待 Harness 判断，不能把工具中的临时降级产物当成完成的分析。确实无法判断或模型失败时，使用有事实依据的 `bypass_reason` 记录原因并运行原降级规则。不要为了完成流程编造判断。

`decision(operation="preview")` 可在复核前查看候选执行集合；最终使用 finalize。只把 `completed` 的阶段当作已完成。上游重算自动使相关下游结果失效；revision 冲突先 read。追问复用有效阶段，不反复重跑所有模型判断。

解释已有方案用 `decision(operation="explain")`：只读已完成的逐动作裁决，不改变 revision。返回每项的 final_stage/final_reason、独立规则检查和实际 reviewed 结果；以最终决定为去留依据，不能把“规则合法”“复核正向”说成最终采用。para 为取值约束，rule_scope 为步长；单值类的 !=X 不参与取值判定。数值规则按现值加一步核边界，越界拒绝，不做夹边或格点吸附。

续问时可直接传 `decision(operation="explain", ticket_id="业务工单号")` 读取该单已有裁决；无需猜测内部 run_id。若本轮此前明确采用了跨期时点，同传 snapshot_date 或 analysis_scope="latest"；也可用该轮返回的 run_id。未找到已完成裁决时先恢复上下文并检查阶段状态。

## 结果含义

源算法中的 dispatched / 可下发是候选裁决字段；本接入没有调用 ICOS 推送、网管下发、现场回退或自动发布。对用户表述为选中动作、建议目标值和待执行条件。实际执行记录继续使用现有 `wireless_workorder(record_execution)`；前后效果使用 `wireless-effect-evaluation`，经验编译使用 `wireless-knowledge-compiler`。

cases 中 shared_history 来自现有 ECHO-Mem 入口，可用于解释与反证；ICOS 同类成败分母只使用提供的 ICOS 案例快照。未命中、读取失败、规则未匹配、匹配键缺失、未评估和不通过分别解释。原规则允许无匹配条件下保留建议，不把它说成已经通过规则校验。

源内核与规则的文件哈希固定在 backend/dsh/dsh-wireless/vendor/icos/source-manifest.json，模型网关、数据库配置、Worker 与现场推送代码没有带入。
