# 本地工单查询

无线网络优化 Harness 使用 `wireless_order_query` 查询完整工单库；`wireless_history_search` 查询可复用历史经验。两者的数据范围与职责独立。现有接入和总编排 Skills 已包含查询、总结与连续追问路径。

## 导入

后端启动时查找同级 `wireless-network-optimizaton-agent` 项目里的 `ECHO-Mem_paper_data_20261110.zip`，也可通过 `WIRELESS_ORDER_ARCHIVE` 指定 ZIP。以 JSONL TraceRecord 建立只读查询索引，不重复计入 CSV 表示。默认索引为 `.run/wireless-orders/orders.sqlite`，`WIRELESS_ARCHIVE_DB` 可覆盖；原始工单和索引不进 Git。已有索引且归档未改变时直接复用；仅保留索引也可查询。

可手动运行：

```bash
python3 backend/dev/import-wireless-orders.py <归档ZIP路径> .run/wireless-orders/orders.sqlite
```

索引保留原工单日期、业务单号、小区信息、动作与评价。失败动作的记录目标不转换为实际改后值；短评估未启用与长期评价标签保持原文。默认“当前工单”指当前库收录的记录，未记录的在办状态保持未知。

## 查询契约

- `catalog`：全库数量、日期覆盖、月份及分类。
- `list`：`month`、`date_from/date_to`、`issue`、`region`、`system`、`vendor`、`query`；分页 `limit=1..50`、`offset`。日期范围含首尾日。月份缺少年份时，按该月份最近有数据的年份解析并明确返回。
- `read`：`ticket_id` 接受业务单号或源 Trace ID，返回来源、对象、动作及执行/评价汇总，不要求内部账本 ID。

只读 HTTP 查询使用 `GET /api/wireless/orders` 的同名参数。问“6月有哪些工单”时返回匹配总数、主要问题和一页具体工单；问“总结这张工单”沿用同会话已明确的业务单号，不强制进入诊断和方案流程。

## 响应与会话

完整问候走即时回复，带附件、已选 Skills 或包含业务请求的消息进入 Harness。即时回复持久化并与 SDK 历史合并，后续分析可获得此前问候上下文。后端重启触发 SDK 会话迁移时，恢复最近业务对话，保留工单号；运行提示和已选 Skills 指令不出现在用户历史正文。

后端通过 SSE 即时转发 SDK 的文字增量和工具事件，收到请求即返回准备状态，连接空闲时发送心跳。前端按收到的文字直接更新，同一条消息完成时原位校正，不额外播放打字动画、不重复追加最终答案。界面公开展示简短执行说明、实际 Skill 加载、逐次工具调用及可展开的输入/结果；不展示模型的私有推理内容。工具执行链保留在会话历史中。

同一页面内的会话各自保存消息、工具进度、任务状态、草稿与输出连接。切换历史会话或新建对话只改变当前显示，不取消后台请求；运行中的会话在侧栏显示进度标识，切回后立即恢复正在执行的内容。迟到的开始、迁移、完成及历史加载结果始终更新原会话，不能覆盖当前会话。只有明确点击“停止接收”才断开对应输出流。页面刷新或离开工作台后，完成结果仍可从服务端历史读取；这不等同于流重连。

## Skills 库

左侧统一使用 Skills 库，内容由 `/api/skills` 读取运行端同一套 SDK 目录注册表，不维护单独的能力清单。支持搜索、选择一个或多个 Skills，应用后在输入框显示已选项，随下一条消息发送 `selectedSkills`。后端校验名称，要求 Harness 先加载全部选定方法，再按问题调用必要业务工具；未选择时由 Harness 按问题自动选择。加载方法不强制执行与用户请求无关的分析。

## 当前数据范围

截至本次导入，约 85 MiB ZIP 中的完整工单数据已写入约 782 MiB SQLite 索引，共 120,857 张工单、266,234 条动作，日期覆盖 2025-01-20 至 2026-08-30；2026 年 6 月有 6,558 张工单。业务单号、日期、问题、地区、小区标识等字段已建索引，查询直接读取数据库。分析账本、历史经验包及反馈仍以本地 JSON/JSONL 保存。归档不含 KPI/MR 时序，不能把工单动作与评价记录当成已接入的指标时序。

## 小区分析数据

`node backend/dev/seed-wireless-network.mjs` 安装用户授权补充的 2026-11-01 小区分析数据，保存到 `.run/wireless-network-data/network.sqlite`；可用 `WIRELESS_NETWORK_DB` 覆盖路径。原工单归档保持不变。当前覆盖低接通工单 SNWNA011260503851110229964 和掉线工单 SNXIA512260630163682851377932320，共 2,304 条 15 分钟观测、21 个原项目指标定义与 4 条参数规则。掉线工单包括本小区及异频邻区，数据还含诊断结论、六维原文、参数、告警和观察/回退判据。

指标名与原列取自原项目 `services/kpi_interpretation/assets/kpi_columns.yaml`，字典保留源文件哈希。PRB/掉线率的展示值与原比率分别保存，掉线率及 PRB 保留对应原始计数器。补充数据在 provenance/data_origin 中标明 constructed，不将其当作原归档或现场采集；业务回答不添加 mock 等用途标签，询问来源时按实际性质说明。

`wireless_network_query` 支持 catalog/read/series；默认按工单日期精确匹配快照，不自动使用最新资料。`analysis_selection` 返回工单日期、所选日期和其他可用日期。仅用户明确要求最新状态时传 `analysis_scope="latest"`，明确指定日期时传 `snapshot_date`，两者互斥。跨期时原工单只用于定位小区，不能据此解释原事件或原执行效果。read 返回匹配快照及实际描述统计，series 接受中文指标名或 his016 等原列，按对象返回序列。`wireless_data_analyze(ticket_id=...)` 直接取库中观测计算。只读 HTTP 入口为 `/api/wireless/network`，使用相同参数。缺少某日期时返回未找到，不用11月数据冒充6月历史。

原初案自带的 value_rule/adjustment_rule 映射到原规则引擎的 para/rule_scope，并保留五元组、执行编号、频段及来源；不再只依赖随代码携带的省侧 CSV。已有分析 read 时只刷新选定时期的数据；旧版未绑定日期的分析迁移至工单日期并清除跨期诊断和下游阶段。最新或指定日期模式保存于分析上下文中，后续 read 不会静默切换。新输入中的当前值优先取参数快照，原归档动作和事后评价独立保留。补齐证据不绕过原来的候选、对齐、规则与整单复核。

真实模型验收已基于补充快照识别上行容量拥塞，保留 MlbDirection 的 DOWNLINK→DUAL 动作；规则匹配、根因对齐、整单复核与综合裁决完成。修复统计浮点负零导致的 SDK 无损 JSON 校验问题后，复验零工具错误、准入 1 个动作，未执行现场下发。轨迹为 `.run/wireless-project-live/1794392294534/`。测试覆盖快照持久化、日期隔离、原规则命中、旧缺口失效及 SDK 指标读取。

## 验证

```bash
cd backend
npm run test:harness
```

真实模型验收从仓库根执行 `node backend/dev/smoke-wireless-orders.mjs`。覆盖问候、身份、月份列表、当前工单库、业务单号详情和“进行信息总结”连续追问，不在提示中注入内部 ID、文件位置、指定 Skill 或预制阶段。原始事件保存在 `.run/wireless-orders-live/`。

`node backend/dev/smoke-wireless-stream.mjs` 使用真实模型检查单个及多个已选 Skills 的加载、工单查询、文字在完成前增量到达、工具无错误及非法 Skill 被拒绝。原始事件与到达时间保存在 `.run/wireless-stream-live/`。

`node backend/dev/smoke-wireless-journey.mjs` 从新会话连续验证问候、6月查询、指定工单总结、根因、方案、逐项解释及历史对照，覆盖低接通/掉线两条链路。轨迹和逐轮答案写入 `.run/wireless-journey-live/`。2026-11-11 复验14轮均完成、零工具错误；掉线单保留 DOWNLINK→DUAL，低接通单保留HARQ开关调整并剔除其余两项。

复验补充了快照/归档来源及阈值/目标的明确字段、短评估未启用的归一说明、只读裁决解释和按业务号恢复上下文。SDK 配置更新导致 disposed 时不再发送空的成功结果，而返回可恢复的中断说明。SDK 长输出被截断后仍显示“资料已返回”，不因 JSON 预览不完整误显示“无有效数据”；该状态同时用于实时工具卡和历史时间线。

2026-11-11 修正历史时点选择：6月工单默认不再引用11月补充诊断，归档方案、执行及评价仍可独立读取。原11月补充数据保持原日期，明确选择后可继续用于该时点的新一轮分析。日期隔离、显式选择、单指标序列与旧会话迁移均有回归覆盖。产品对外名称统一为“无忧侠”。

时点隔离的真实模型复验：`.run/wuyouxia-period-1794395869837/` 包含工单总结、6月复盘与明确切换11月的三轮记录。进一步修复了转写库内快照导致日期/字段丢失的问题；`.run/wuyouxia-final-1794396211872/` 复验由 ticket_id+snapshot_date 直接建立上下文，保留归档日期2026-06-30、分析日期2026-11-01、观测来源及原始指标/规则，零工具错误，最终准入DOWNLINK→DUAL一项。`node backend/dev/smoke-wireless-period.mjs` 可重新检查两种时点的取数隔离。
