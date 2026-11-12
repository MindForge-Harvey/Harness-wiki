# ICOS 工单步骤与 Harness Skills

实现位于 wireless-network-optimization 分支。ICOS 源代码取自本地 wireless-network-optimizaton-agent/network-ops-loop-v3，固定 40 份源文件及领域资产的 SHA-256；原文件保持不变，适配代码独立维护。没有携带源项目的生产配置、客户工单、数据库客户端、Worker 或现场推送服务。

## 已接入

新增 11 个 `wireless_icos_*` 工具：context、root_cause、objective、cases、candidates、alignment、parameter_risk、consistency、decision、multi_round、feedback。已有 14 个 Skills 保留，新加目标确认、根因方案对齐、整单一致性、综合决策、多轮重推理 5 个 Skills，总计 19 个。11 个已有 Skills 增加了 ICOS 路由。

主入口为 wireless-workorder-orchestrator。具体工单的根因分析和方案生成默认走原项目阶段工具，不再要求用户指定 ICOS。`wireless_icos_context(ticket_id=...)` 从完整 SQLite 工单库建立上下文，保留原始方案及未知字段，隔离本单事后评价；同时提供有界的同类历史快照。业务动作的归档分组标签只用于原候选分组，不填成已确认根因。

首轮通常按 context → objective/root_cause/cases → candidates → alignment/parameter_risk → consistency → decision 执行。重推理在 cases 后先运行 multi_round；各工具返回缺失前置阶段，Harness 按本轮目标选择所需 Skills、复用有效结果，输入改变后只补失效依赖。多阶段任务直接使用 Harness 已有 `todo_write` 拆解并更新进度，前端“执行过程”展示最新计划和实际调用；单步列表和信息总结不启动整套流程。

模型阶段先返回原提示词与 judgment_token，Harness 判断后回传 judgment；候选按组键回传 judgments。原解析器、范围/方向/步长计算、案例统计、冲突裁决及决策条件回环继续由 Python 执行。模型网关不在 Python 内核中调用。

完整输入、返回状态与用法见 [ICOS 阶段契约](../../skills/wireless-workorder-orchestrator/references/icos-workflow.md)。输入 JSON 可内联传入，也可从工作区文件读取。每轮最多 40 个初案动作，与原裁决计数边界一致。

## 与已有无线能力融合

- Skills 由现有 skill-filesystem provider 发现，领域工具由现有 dsh-wireless 插件注册，无需另起 ICOS 后端。
- ICOS cases 自动调用现有统一历史检索；ECHO 结果保持原来源与作用域，不计入 ICOS 同类成败分母。
- context 的 observations 调用现有指标分析器；ICOS 原根因收敛只消费结论和六维原文。
- context 可关联已存在的 workorder_id，最终 decision 使用 save_to_workorder=true 保存候选。实际执行、效果比较和历史编译继续使用现有账本与 ECHO 工具。
- 分析记录保存到 WIRELESS_DATA_DIR/icos-runs。输入校验、持久化 revision、同记录互斥、判断上下文令牌、幂等复用和依赖失效避免跨阶段混用。

## 边界

工单已连接本地全量 SQLite 归档，也可提交来源快照；新指标采集未连接。案例快照最多抽取 80 张更早、同问题/厂家/制式工单，使用完整成功执行且评价一致的组合，保留快照分母和时间可见性限制。观测与前轮反馈按实际提交材料分析。参数规则默认使用原项目携带的 CSV，也可提供本轮规则快照。候选裁决中的 dispatched / 可下发表示算法选择结果，没有调用设备下发、回退或发布。

ICOS confidence 表示原文支撑强度，ECHO 历史可信度仍按原协议解释。原 ICOS 决策条件已经执行，不等同于 ECHO 研究的校准 gate。原代码允许无匹配规则时保留条件建议；未匹配、未评估与通过分别返回。

原项目根因收敛读取结论及六维原文；KPI 取数阶段只展示，不进入该收敛判断。原文缺失时保留缺口，可以继续复核已有初案并提出具体补证问题，不能用历史动作或事后评价补造根因，也不能把归档初案复核称为新的动作预测。

## 验证与维护

首次安装或更新 Python 依赖：

```bash
backend/.runtime/wireless-python/bin/pip install -r backend/dsh/dsh-wireless/compiler-requirements.txt
```

Docker 继续使用同一 requirements 文件安装到 /opt/wireless-python。

```bash
cd backend
npm run test:wireless-icos
npm run test:harness
```

ICOS 契约测试通过真实 SDK ToolRuntime 调用全部 11 个阶段工具，覆盖规则改值、同类案例、组内选择、根因对齐、整单复核、最终裁决、已有工单保存、恢复、依赖失效、过期判断、冲突各方剔除、重推理阶梯和输入边界。测试输入与模型判断为合成固定样例；源计算内核真实执行。

2026-11-11 验证：19 个项目 Skills 全部通过结构校验，完整 Harness 回归 50/50 通过。使用配置的 qwen3.8-flash 进行真实模型会话验收，加载了总编排及 11 个阶段相关 Skills，实际调用全部 11 个 ICOS 工具，完成前轮反馈核对、缩步长重推理、模型判断提交、参数校验、整单复核和最终裁决。模型会话使用隔离的合成输入，没有连接生产工单库或现场执行。复现命令：

```bash
HARNESS_TEST_BASE_URL=http://127.0.0.1:3088 node backend/dev/smoke-wireless-icos.mjs
```

该脚本需要已启动的本地 Harness 后端和可用模型配置，调用轨迹写到被 Git 忽略的 .run/icos-live/smoke.json。

自然语言入口与跨轮自动编排使用 `node backend/dev/smoke-wireless-project.mjs` 验证。它只提供业务工单号和“根因分析”“为这张工单生成优化方案”，不指定内部 ID、工具或 Skill，检查原阶段调用、原生任务清单和前轮结果复用。轨迹保存到 `.run/wireless-project-live/`。

本次补充验证：后端回归 61/61，前端构建和 Markdown/任务抽屉网页检查通过；40 份固定源文件与本地原项目逐份 SHA-256 一致。真实模型完成根因→方案连续追问；另一个未预置分析的 NR 工单，仅凭业务单号和方案生成请求自动加载 10 个相关 Skills，执行完整方案阶段链，任务清单在分析前建立并更新 5 次。归档缺诊断原文的阶段仍保留缺口，不将流程调用通过解释为根因准确率验证。

### 真实归档数据验证

2026-11-11 使用用户提供的 ECHO-Mem 归档包，核验 120,857 张工单、266,234 个动作；功能抽样 16 张 LTE/NR 工单、32 个动作，执行 273 次真实 SDK 调用。使用配置模型完成 19 个单 Skill 场景和 4 个组合场景，定向修复后调用检查 23/23 通过，后端回归 52/52 通过。原始失败、复验、工具轨迹、逐项答复及文字核对说明保留在 Git 忽略的 `.run/icos-real-data-20261111/`，报告为该目录的 `evaluation.md`。

组合覆盖 LTE 接通方案链、NR 接通方案链、反馈→重推理条件检查→账本保存，以及 NR 全动作执行失败回顾。单 Skill 测试预备必要的纯计算阶段；组合测试只预备上下文、目标及原文缺口检查，其余相关阶段由模型调用。159 张 Train 工单编译成 242 个六类记忆对象；ICOS 快照与 ECHO 记忆来自同一批历史，不作独立互证。

实测补齐了 context 的 `view=summary`、参数变化计算、保留阶段的 `link_workorder`、独立的 `archived_feedback` 及候选类型/状态拒绝结果，并明确空判断请求的结束条件。数据没有当前诊断原文、六维文本、KPI/MR 时序和有效短评估轮次，因而不能验证根因准确率、KPI 改善幅度或完整多轮闭环。归档动作目标是回放输入，不是对未知结果的新预测。模型原答复中仍有数值转述与来源口径问题，报告逐项注明；调用通过不等于全文正确或现场放行。

复用已准备的本地输入与历史包时，在仓库根目录执行：

```bash
node backend/dev/evaluate-wireless-paper-tools.mjs .run/icos-real-data-20261111
HARNESS_TEST_BASE_URL=http://127.0.0.1:3098 node backend/dev/evaluate-wireless-paper-skills.mjs .run/icos-real-data-20261111
backend/.runtime/wireless-python/bin/python backend/dev/report-wireless-paper-eval.py .run/icos-real-data-20261111
```

模型测试要求后端使用同目录下的 `runtime-data` 作为 WIRELESS_DATA_DIR，并使用隔离 DSH_HOME_DIR。`EVAL_RESUME=1` 保留已通过项，`EVAL_CASES=single-08` 可定向复验。准备和时间归一脚本分别为 `backend/dev/prepare-wireless-paper-eval.py`、`backend/dev/normalize-wireless-paper-traces.py`；原始工单及生成包不放入跟踪文件。

更新原内核时显式运行 `python3 backend/dev/vendor-icos.py <network-ops-loop-v3目录>`，核对 manifest diff 并重新运行契约测试。不要复制源项目的 configs/config.yml 或完整运行目录。
