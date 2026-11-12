# KnowledgeCore（知核）· 功能规格与接口定义 v0.3

> 产品：基于 LightRAG 的知识库引擎与知识底座（DeepSeek Harness 宿主）
> v0.2：M0/M1/M2 已实施（含实测修订），见 §10 实施状态与 §11 修订记录。

---

## 1. 已确认决策（评审记录）

| # | 决策 | 影响 |
|---|---|---|
| D1 | 接受 `dsh-knowledge` 命名演进 | 包名/插件名重命名，旧挂载点同步迁移 |
| D2 | 图谱级编辑（实体合并）进 MVP | MVP 含图谱 tab + 实体/关系编辑操作集 |
| D3 | 会话反哺为 P0 | MVP 含 assistant-actions 反哺按钮 + 内联表单 |
| D4 | 有分部门分库预期 | 所有接口自始带 `kb` 参数；MVP 单库，V2 启用多库 |
| D5 | rerank 不开启 | 关闭 rerank 配置；检索链路为 图+向量 混合，无重排 |
| D6 | 前端弃用悬浮窗 | UI 落点：`conversation.view` 工作台 + 会话内轻交互（见 §7） |

## 2. 领域模型

### 2.1 概念

| 概念 | 定义 | 存储 |
|---|---|---|
| 知识库（KB） | 一个独立检索域，id 形如 `company`、`hr`、`finance` | LightRAG workspace（V2）或独立实例；harness 路由表 |
| 文档（Document） | 知识的最小管理单元（一个文件/一段文本/一条会话沉淀） | LightRAG 索引 + harness 注册表 |
| 实体（Entity） | 图谱节点（人名、部门、制度、系统…） | LightRAG 图谱存储 |
| 关系（Relation） | 图谱有向边（负责、引用、替代…） | LightRAG 图谱存储 |
| 注册表（Registry） | harness 侧的文档元数据：版本链、状态、审计、主题 | harness `storage` 服务（`kb-registry`） |
| 主题（Topic） | 分类标签，沿用现有 12 大主题 | 注册表字段 |

### 2.2 文档状态机

```
pending ──▶ processing ──▶ active
   │            │              │ 替换(replace)   删除(delete)
   └──▶ failed │◀── retry ──┘  ▼                 ▼
        （可重试）           outdated(旧版本)   retired(退役，软删除)
```

- 状态来源：LightRAG `doc_status` + `pipeline_status` 回读，harness 侧注册表为权威。
- `active` 文档同一 `source` 下最多一个（替换后旧版自动 `outdated`）。
- 软删除：`retired` 保留注册表记录与审计，索引删除可撤回（V1 实现撤回，MVP 先只记审计）。

### 2.3 主题清单（沿用现有）

产品和营销、创新和研发、党建工作、党组工作/公司章程/董事会运作、风险与合规、供应链管理、公共关系与综合行政、人力资源管理、网络建设和维护、业务支撑和IT、战略与文化、资产和财务。

---

## 3. 系统架构

```
Client（浏览器）
  ├─ 知识库视图（conversation.view: knowledge）── 工作台 5 tab
  ├─ 会话反哺按钮（conversation.chat.assistant-actions: kb-save）
  ├─ 引擎健康徽章（conversation.session.header.utilities: kb-health）
  ├─ kb_* 工具卡（tool.call.toolview: kb_ingest / kb_update / kb_status）
  └─ 全部经 Package 私有 RPC（host.call）访问 Host

Host（dsh-knowledge 插件，Profile bundle）
  ├─ /kb/* HTTP 路由（代理 + 编排 LightRAG 9623）
  ├─ 模型工具：lightrag_query（保留）、kb_ingest、kb_update、kb_status
  ├─ 事件：kb.document.*、kb.engine.health
  ├─ 长任务：harness jobs（批量导入/重扫）
  └─ 注册表 + 审计：harness storage

底座（LightRAG v1.5.6 @127.0.0.1:9623，独立进程）
  解析(MinerU/VLM) → 抽取 → 图+向量双索引 → 多模式检索
  rerank：❌ 关闭（D5）
```

## 4. 功能规格

### 4.1 知识沉淀

#### 4.1.1 文件上传沉淀（工作台「沉淀」tab）
- 交互：拖拽区 + 文件选择；支持 `.docx .pdf .md .txt .xlsx .pptx`（以 LightRAG `supported_file_types` 回读为准，前端动态渲染）。
- 一次可选多个文件；每个文件独立任务，逐文件反馈状态。
- 提交流程：前端上传 → Host 缓存临时文件 → 调 LightRAG `/documents/upload`（异步处理）→ 轮询 `doc_status` 直到 processing 完成 → 事件通知前端。
- 校验：空文件、超大（>100MB 拒绝）、不支持类型 → 前端即时报错，不触达引擎。
- 元数据：默认 `source=文件名`、`title=文件名`、`topic=未分类`，可在上传前编辑。

#### 4.1.2 文本沉淀
- 交互：粘贴文本 + 标题 + 主题；等价于 LightRAG `/documents/text`。
- 用途：制度条文、会议纪要、零散知识点。

#### 4.1.3 会话反哺（P0，D3）
- 入口：每条 assistant 回复动作行的「沉淀到知识库」按钮（`kb-save`）。
- 内联表单字段（卡片内展开，不弹窗）：

| 字段 | 来源 | 可编辑 |
|---|---|---|
| 标题 | 预填：消息首行截断 40 字 | ✅ |
| 正文 | 预填：该消息完整 markdown 文本 | ✅ |
| 主题 | 下拉 12 主题，默认「未分类」 | ✅ |
| 目标库 | 下拉，MVP 仅「公司知识库」 | ✅（V2 多库） |
| AI 精炼 🔧 | 开关，默认**关**（MVP 直存用户确认文本；V1 加结论化改写） | ✅ |

- 提交流程：`host.call('kb.saveConversation', {…})` → Host 附 `source = session:<sessionId>/message:<messageId>`、`actor` → 走文本沉淀 → 按钮状态变「已沉淀 ✓」。
- 幂等：同一 messageId 重复点击 = 更新同一条沉淀（`source` 相同则走替换），不产生重复知识。

### 4.2 知识更新（重点）

#### 4.2.1 文档版本替换 🔧
- 策略：**先插新、后删旧**（新内容以临时 doc_id 插入，成功后删除旧 doc_id，再在注册表推进版本链）。失败则旧版无损，状态回滚，无知识丢失窗口。
- 版本链：`v1 → v2 → …`，每跳记录 `{from, to, ts, actor, reason?}`。
- 交互：文档列表行内「替换」→ 选新文件 → 确认对话框展示 old title/version → new filename。
- 替换后图谱影响：旧版抽取的实体不删除（实体可能被多文档共享），仅移除旧版 chunk 索引；孤儿实体清理放 V1（`kb.cleanupOrphans`）。

#### 4.2.2 文档删除/退役
- 交互：行内「删除」→ 确认（说明不可撤回窗口）→ 软删除（注册表 `retired` + LightRAG 索引删除 + 审计）。
- MVP 提供「撤回退役」按钮（重新插入原文需要保留原文缓存；MVP 保留上传临时文件 7 天以支撑撤回 🔧）。

#### 4.2.3 失败重试
- 「文档」tab 的 failed 列表：行内「重试」→ LightRAG `reprocess_failed`；失败原因原样透传展示（截断 300 字）。

#### 4.2.4 图谱编辑（MVP，D2）——「图谱」tab
操作集：

| 操作 | LightRAG API | 交互 |
|---|---|---|
| 搜索实体 | `GET /graph/label/search`（name 关键词） | 搜索框 + 实体列表 |
| 编辑实体 | `POST /graph/entity/edit`（description 等字段） | 实体卡片「编辑」内联表单 |
| 删除实体 | `POST /graph/entity/delete` | 确认对话框；🔧 级联关系由引擎处理，注册表审计记录 |
| 合并实体 | `POST /graph/entities/merge` | 多选（或拖拽 A→B）→ 确认框显示被合并方将消失 → 审计记录 |
| 创建实体 | `POST /graph/entity/create` | 「新建实体」表单 |
| 创建/编辑/删除关系 | `POST /graph/relation/create|edit|delete` | 图上选两节点连线 → 关系表单（描述/关键词） |

- 可视化：SVG 力导向图（自绘，零第三方依赖）；节点=实体、边=关系，hover 显示描述，选中高亮邻域。
- 图谱变更后即时生效于后续检索（引擎实时读图存储）。
- 图谱 tab 提供「以当前图谱直接提问」入口 → 跳转「检索」tab 并预置 query。

#### 4.2.5 冲突修复 / 自动重扫（V1）
- `documents/source_conflicts` 检测列表 + repair 操作。
- 目录同步（`documents/scan`）与 auto-rescan 配置。

### 4.3 知识检索

| 通道 | 说明 |
|---|---|
| 对话内工具 | `lightrag_query`（保留）：6 检索模式；响应含 `references`（文件名+片段） |
| 工作台「检索」tab | 检索效果测试台：query + 模式下拉 + 流式回答 + 引用列表；不进入会话流 |

- 引用展示：文件名 + 置信度排序；点击引用 → 打开文档详情（注册表元数据 + 源文件下载，V1）。
- rerank 关闭（D5）：`min_rerank_score` 不参与排序；答案质量以 图+向量 混合检索为准。

### 4.4 知识治理

#### 4.4.1 「概览」tab
- 引擎健康：health 摘要 + 各队列状态（extract/embedding/query）+ 失败计数。
- 统计卡片：文档总数 / active / processing / failed / retired；实体数、关系数；近 7 天沉淀趋势（注册表聚合）。
- 待办提示：failed 文档 N 条、孤儿实体提示（V1）、引擎不可达红条。

#### 4.4.2 「文档」tab
- 表格：标题、source、版本、主题、状态、更新时间；筛选（状态/主题/关键词）；分页（LightRAG `documents/paginated`）。
- 行内操作：替换、删除、重试、详情。

#### 4.4.3 「审计」tab
- 全量写操作流水：`{ts, actor, action, target, detail, kb}`；筛选（action/actor/时间）。
- 操作类型：ingest / replace / delete / retry / entity_create / entity_edit / entity_delete / entity_merge / relation_* / save_conversation。

### 4.5 多知识库（预留设计，D4）

- **接口层**：所有 `/kb/*` 路由与工具自始携带 `kb` 参数（默认 `company`），MVP 忽略非默认值并返回 400。
- **引擎层（V2 二选一）**：
  - 方案 A：LightRAG workspaces（`storage_workspaces` 多 workspace，单实例多索引）——当前实例该配置为 null，需评估启用成本；
  - 方案 B：每 KB 一个 LightRAG 实例/数据目录，harness 路由表 `kb_id → base_url` 映射。
- **UI**：工作台顶部「知识库选择器」下拉；切换即切换视图内所有数据（文档/图谱/审计均按 kb 过滤）。
- **权限预留**：注册表记录 `kb → allowed_actors` 字段，MVP 全员读写；V2 接入审批与角色。

---

## 5. Host 接口定义

### 5.1 HTTP 路由（`/kb/*`，Web 前端使用）

| 方法+路径 | 请求 | 响应 | 说明 |
|---|---|---|---|
| `GET /kb/health` | `?kb=company` | `{ok, engine:{status,version,queues,rerank_disabled:true}, stats}` | 引擎健康+概览统计 |
| `GET /kb/kbs` | — | `{kbs:[{id,name,default}]}` | 知识库列表（MVP 恒返回 company） |
| `GET /kb/documents` | `?kb&status&topic&q&page&page_size` | `{total,items:[{id,title,source,version,status,topic,updated_at}]}` | 文档列表 |
| `POST /kb/documents/upload` | multipart: `file`, form: `title,topic,kb` | `{ok, documents:[{id,title,status}]}` | 文件沉淀 |
| `POST /kb/documents/text` | `{title,text,topic,kb}` | `{ok, document}` | 文本沉淀 |
| `POST /kb/documents/{id}/replace` | multipart: `file`, form: `reason?` | `{ok, document:{id,version}}` | 版本替换（先插后删） |
| `DELETE /kb/documents/{id}` | `?kb` | `{ok, retired:true}` | 退役（软删除） |
| `POST /kb/documents/{id}/retry` | `{}` | `{ok}` | 失败重试 |
| `GET /kb/graph/entities` | `?kb&q&page&page_size` | `{total,items:[{name,type,description,degree}]}` | 实体搜索 |
| `POST /kb/graph/entities/create` | `{name,type?,description,kb}` | `{ok}` | 建实体 |
| `POST /kb/graph/entities/edit` | `{name,updates:{description?},kb}` | `{ok}` | 改实体 |
| `POST /kb/graph/entities/merge` | `{source,target,kb}` | `{ok,merged:{source,target}}` | 合并（source 并入 target） |
| `POST /kb/graph/entities/delete` | `{name,kb}` | `{ok}` | 删实体 |
| `POST /kb/graph/relations/create` | `{src,tgt,description?,keywords?,kb}` | `{ok}` | 建关系 |
| `POST /kb/graph/relations/edit` | `{src,tgt,updates:{description?},kb}` | `{ok}` | 改关系 |
| `POST /kb/graph/relations/delete` | `{src,tgt,kb}` | `{ok}` | 删关系 |
| `GET /kb/graph/visualize` | `?kb&limit` | `{entities:[],relations:[]}` | 图谱数据 |
| `GET /kb/audit` | `?kb&action&actor&page` | `{total,items:[{ts,actor,action,target,detail}]}` | 审计流水 |
| `POST /kb/query` / `POST /kb/query/stream` | `{query,mode,kb}` | NDJSON 流（沿用现有格式） | 检索测试台 |

> 写操作全部记审计（§4.4.3）；写操作失败不落审计，仅记日志。
> MVP 中所有 `kb` 参数仅接受 `company`。

### 5.2 模型工具（Preset 可见）

#### `lightrag_query`（保留，微调）
- 新增可选参数 `kb`（默认 `company`；MVP 传其他值报错提示）。
- 输出保留 `{response, references}`。

#### `kb_ingest` —— 知识沉淀
```
parameters:
  kind: enum[file, text, conversation]
  file_path?: string        # kind=file：工作区文件路径
  text?: string             # kind=text / conversation：正文
  title: string             # 必填，文档标题
  topic?: string            # 12 主题之一或"未分类"
  kb?: string               # 默认 company
output: { ok, document: {id, title, status}, task? }
```
- `kind=conversation` 时正文应为**结论化表达**（工具描述引导模型先提炼再入库）。
- 长任务（文件解析）返回 `task` 引用，结果经 `kb.document.ingested` 事件回传会话。

#### `kb_update` —— 知识更新
```
parameters:
  action: enum[replace, delete, retry, entity_create, entity_edit,
               entity_merge, entity_delete, relation_create,
               relation_edit, relation_delete]
  document_id?: string      # replace/delete/retry
  file_path?: string        # replace
  entity_name?: string      # 实体操作
  entity_updates?: object   # entity_edit {description}
  merge_target?: string     # entity_merge（source=entity_name, target=merge_target）
  src?: string; tgt?: string; description?: string  # 关系操作
  kb?: string
output: { ok, changed: {…}, audit: {action, target} }
```

#### `kb_status` —— 健康与状态
```
parameters: { kb?: string }
output: { ok, engine: {…}, stats: {…}, failed_documents: [...] }
```

### 5.3 事件（Host 总线）

| 事件 | 载荷 | 触发 |
|---|---|---|
| `kb.document.ingested` | `{kb, document:{id,title,status}, actor}` | 沉淀完成 |
| `kb.document.updated` | `{kb, document:{id,version}, from_version, actor}` | 替换完成 |
| `kb.document.deleted` | `{kb, document:{id,title}, actor}` | 退役 |
| `kb.document.failed` | `{kb, document:{id,title}, reason}` | 处理失败 |
| `kb.graph.changed` | `{kb, op, entity?/relation?, actor}` | 图谱写操作 |
| `kb.engine.health` | `{kb, healthy, detail}` | 健康轮询变化 |

### 5.4 注册表数据模型（harness storage `kb-registry`）

```
documents: { [doc_id]: {
  kb, source, title, topic, status, version, versions: [{v,ts,actor}],
  created_at, updated_at, retired_at?, file_cache?: 临时文件路径
}}
audit: [ { ts, actor, action, target, detail, kb } ]
settings: { default_kb: 'company', rerank_enabled: false, kb_routes: { company: 'http://127.0.0.1:9623' } }
```

---

## 6. 非功能需求

| 项 | 要求 |
|---|---|
| 可靠性 | 替换操作无知识丢失窗口（先插后删）；引擎不可达时前端全 tab 降级为只读+红条 |
| 性能 | 文档列表/图谱分页加载（≤100/页）；图谱可视化 limit 默认 200 节点 |
| 并发 | 批量上传逐文件串行提交引擎（`max_parallel_insert` 引擎已限），前端仅排队展示 |
| 安全 | 写操作走 harness 审批栈（工具调用侧由 preset 策略决定）；上传文件类型白名单；临时文件 7 天清理 🔧 |
| 审计 | 所有写操作必留痕，审计不可删改 |

## 7. UI 规格（与 D6 对齐）

| 落点 | 内容规格 |
|---|---|
| `conversation.view` id=`knowledge`（order 5，会话头视图导航自动出现 tab） | 顶部：库选择器 + 健康徽章 + 统计摘要；下方 5 tab：概览/沉淀/文档/图谱/检索/审计（图谱与审计并列，共 6 tab）🔧 见下 |
| `conversation.chat.assistant-actions` id=`kb-save` | 「沉淀到知识库」按钮 → 卡片内联表单（§4.1.3）→ 成功后 ✓ 态 |
| `conversation.session.header.utilities` id=`kb-health` | 三色徽章；点击 → 打开知识库视图「概览」tab 🔧（需验证 utilities 侧是否有 openView 通道，无则仅展示徽章） |
| `tool.call.toolview` key=`kb_ingest`/`kb_update`/`kb_status` | 摄入卡：文档名+状态+进度+失败原因+重试按钮；更新卡：操作摘要+审计引用；状态卡：健康摘要 |
| `settings.section` id=`knowledge`（V1） | 引擎连接配置、默认库、默认检索模式 |

🔧 Tab 最终方案：**概览 / 沉淀 / 文档 / 图谱 / 审计** 5 tab，「检索测试」并入「概览」页底部（减少 tab 密度）。评审时可再定。

## 8. MVP 范围与验收用例

**范围**：§4 中标注 MVP 的全部条目 + 图谱编辑操作集（D2）+ 会话反哺（D3）。

**验收用例**（逐条可验证）：

1. 上传《新员工公司规章制度学习手册》→ 状态 pending→processing→active → 对话中提问"差旅报销标准"→ 带引用回答。
2. 替换该手册为新版 → 旧版 outdated、版本链 v1→v2、审计有 replace 记录 → 检索命中新版内容。
3. 删除某文档 → 状态 retired、检索不再命中、审计有 delete 记录。
4. 图谱 tab：搜索实体 → 编辑描述 → 两个重复实体合并 → 关系归并 → 后续图谱问答命中合并结果。
5. 会话反哺：某条回复点「沉淀到知识库」→ 填表单提交 → 按钮变 ✓ → 知识库检索可命中该沉淀（引用 source=session/message）。
6. 制造失败（上传损坏文件）→ failed 列表出现 → 行内重试。
7. 健康徽章三色正确；引擎停掉 → 徽章红 + 概览红条 + 工作台只读降级。
8. rerank 关闭：任何检索不触发 rerank 调用，检索功能正常。

## 9. 里程碑

| 阶段 | 内容 | 关键交付 |
|---|---|---|
| M0 基座重构（1-2 天） | 包重命名 dsh-knowledge；路由 /kb/* 骨架；注册表+审计落地；rerank 关闭 | Host 骨架 + 单元自测 |
| M1 沉淀与文档（2-3 天） | 上传/文本/替换/删除/重试；文档与概览 tab；kb_ingest/kb_update 工具；事件 | 验收 1-3、6 |
| M2 图谱与反哺（3-4 天） | 图谱 tab（可视化+编辑+合并）；会话反哺全链路；审计 tab；工具卡定制 | 验收 4-5、7、8 |
| M3 打磨（1-2 天） | 健康徽章、空态/错误态、主题筛选、性能 | 全量回归 |
| V1 | 自动重扫、冲突修复、实体孤儿清理、撤回退役、AI 精炼、settings 页 | — |
| V2 | 多知识库（workspaces 或实例路由）、目录同步、定时更新、权限 | — |

---

## 10. 实施状态（v0.2 → v0.3）

> v2 重构（§11.8）后，v1 时代的实现证据文件（`lib/{engine,kb,flywheel}.js`、`dev/{selfcheck,acceptance,*-probe,flywheel-unit}.mjs`）已删除；下表 M0-M3 与飞轮 P0-P2 行为历史记录，当前权威实现见 §11.8 与 `node dev/run-tests.mjs`。

| 里程碑 | 状态 | 证据 |
|---|---|---|
| M0 基座 | ✅ 完成 | `lib/{engine,registry,http,kb}.js`；`dev/selfcheck.mjs` 引擎/注册表 8 项自测全过；rerank 双保险关闭（`.env` `RERANK_BINDING=null` + 请求级 `enable_rerank:false`） |
| M1 沉淀与文档 | ✅ 完成 | `/kb/*` 12 条路由；`kb_ingest`/`kb_update`/`kb_status` 工具；删除队列（空闲即发/失败复位/60s 快速核验/2min 全量核验/最多 3 次重试）；selfcheck E2E：沉淀→409→替换 v1→v2→退役→引擎侧无残留 |
| M2 图谱与反哺 | ✅ 完成 | 图谱 7 条路由 + `kb_update` 图谱 action；`graph-probe` 7/7（含实体合并）；`saveConversation` 幂等更新；`conv-probe` 4/4 |
| M2 客户端 | ✅ 代码完成，⏳ 待宿主重启后运行时验证 | `client/client.js` 重写：`conversation.view` 工作台（概览/沉淀/文档/图谱/审计）+ `assistant-actions` 反哺 + `header.utilities` 健康徽章；悬浮窗已移除 |
| M3 重命名与验收 | ⏳ 进行中 | 见 §11.3 切换步骤 |
| **飞轮 P0（知识飞轮地基）** | ✅ 完成（⏳ 待宿主重启生效） | `lib/curator.js`：query_log 采集（append-only）、提案存储+状态机+审计联动、golden runner（/query/data，无 LLM 生成）；`lib/index.js` 三处查询入口接入 + `/kb/curator/*` 3 条只读路由；`golden/golden.yaml` 29 题（expect 全部实测摘取）；基线 2026-09-07：文档命中率 100% / 实体命中率 100% / 引用覆盖率 98.2%（`dev/selfcheck-curator.mjs` 4/4）；skills：`kb-usage`、`kb-gardener`（工作区 `.dsh/skills/`）。见 §11.4 |
| **飞轮 P1（提案→门控→审批→提交）** | ✅ 完成（⏳ 待宿主重启生效） | `lib/flywheel.js`：applyOp/revertOp（entity_edit 前值重放回滚）+ runGate 双条件门控（自证题 + golden 回归，容差 2%）+ commitProposal + commit_log 账本；`kb_propose` 工具（additive 自动门控+自动提交，破坏性/文本经 `ctx.approval` 人工审批，前值捕获失败自动降级人工）；`flywheel-unit.mjs` 5/5（冗余/通过/自证失败回滚/golden 回滚/降级）；`flywheel-probe.mjs` 真实引擎 E2E 5/5（门控通过→提交→冗余拒绝→账本回溯→清理）；工作台第 7 tab「提案」。见 §11.5 |
| **飞轮 P2（gardener 眼睛 + 周报）** | ✅ 完成（⏳ 待宿主重启生效） | `lib/analyze.js`：五类健康分析（源冲突/失败文档/重复实体候选/检索缺口三分类）+ 周报；`kb_analyze`/`kb_report` 工具；engine 增 `sourceConflicts`；kb-gardener 技能更新（周期编排 schedule 周提醒 + goal 延续）。实测：GraphML 流式扫描 109,037 实体 → 499 组重复候选（eNodeB/ENODEB、CMNET/Cmnet 等真实大小写变体）；源冲突 0；失败文档 0。见 §11.6 |
| **v2 重构（意图账本 + 收敛器 + 单一写入口）** | ✅ 完成 | `lib/{store,engine-port,fake-engine,intent,reconciler,registry,service,curator,gate}.js` v2 全量替换 v1；`dev/run-tests.mjs` 8 套件全过（存储原语/引擎契约怪癖/意图账本/收敛器/服务层/curator/门控/健康分析）；v1 文件已删除。见 §11.8 |

## 11. 修订记录（实施期实测决策，替代 v0.1 中的 🔧 提案）

### 11.1 引擎实测事实（v1.5.6 本部署）
1. **文档 id 内容寻址**：相同内容的文档插入得到相同 doc_id（删除后可原样重建）。
2. **同 source 重插返回 409**：`Document storage already contains ... Delete the existing record before re-inserting`。→ 替换必须走"先插新（临时 source）后删旧"。
3. **track_status 直接返回 doc_id 与状态**：`{track_id, documents:[{id,status,...}]}`，无需扫描列表定位。
4. **删除是异步的**（`deletion_started ... background`），且**管道忙时发出的删除请求可能被静默丢弃**（返回 200 但不执行）。→ 删除队列 + 核验重试（见 §11.2）。
5. **删除成本极高**：本库图谱 10.9 万节点/24.8 万边，每次删除触发全图重建（分钟级）；workers=1 时管道忙会让 API 整体变慢（health 超时需 60s 档）。
6. **管道忙时图谱编辑返回 409**（`Pipeline is busy with another operation`）。→ Host 翻译为友好错误；UI 以健康状态禁用图谱编辑入口。
7. **GraphML 存储不支持 list 类型属性值**（写图崩溃 500）。→ 所有图谱写入前数组值拍平为顿号字符串（`kb.flattenArrays`）。
8. `page_size` 下限 10；`/graphs` 必填 `label`；`GET /documents` 不支持按 id 过滤。

### 11.2 实现修订
- **注册表存储**：v0.1 计划用 harness `storage` 服务；落地为 Node fs 直写 JSON/JSONL（`${DSH_HOME}/storages/dsh-knowledge/`），零依赖、可平移。审计为 append-only JSONL。
- **删除可靠性**：`kb.js` 内置删除队列——空闲时批量发出、请求失败即复位重试、发出后 60s 快速核验 + 2 分钟全量核验、3 次失败写 `delete_failed` 审计。替换流程的"删旧"环节走同一队列，失败不影响新版本。
- **会话反哺幂等**：同 `session_id/message_id` 重复沉淀 → 自动走替换（版本链推进），不产生重复知识；注册表中旧版留存为 `outdated`（版本史可查）。
- **工具卡定制（`tool.call.toolview`）推迟至 V1**：MVP 用工具 `output.render` 覆盖会话流展示（摄入/更新均有中文状态文案）。
- **健康徽章**：`header.utilities` 无视图跳转通道，徽章仅展示状态（悬停详情），入口由会话头「知识库」视图 tab 承担。
- **工作台 tab**：定为 概览/沉淀/文档/图谱/审计 5 个，「检索测试」并入概览页。

### 11.3 M3 切换步骤（重命名 dsh-knowledge）
1. `package.json` name → `dsh-knowledge`；`cordis.patch.yml` 插件 id → `dsh-knowledge`；`lib/index.js` `name` 导出、`client/client.js` 模块 id 同步。
2. 目录 `dsh-lightrag/` → `dsh-knowledge/`。
3. 更新 `~/.dsh/profiles/web/package.json`：依赖键、link 路径、bundles 条目 → `dsh-knowledge`。
4. 宿主进程重启 + 页面刷新（由部署方执行）；旧 `dsh-lightrag` 插件 id 的运行时状态不迁移（注册表数据独立于插件 id，位于 `storages/dsh-knowledge`）。
5. legacy `/lightrag/*` 路由随切换移除。

### 11.4 知识飞轮 P0（2026-09-07，对应 KB-FLYWHEEL-ON-HARNESS-PLAN.md）
- **query_log 在插件层采集，不 fork LightRAG**：`lightrag_query` 工具、`/kb/query`、`/kb/query/stream` 三入口统一经 `curator.logQuery`（带 session_id/client/latency/references），落 `storages/dsh-knowledge/query_log.jsonl`。工具路径的 session_id 来自 `exec.agent.sessionId`。
- **提案账本 append-only**：`proposals.jsonl` 状态机 `proposed → eval_passed/rejected → approved → committed`，状态迁移=追加新行（同 id 末行生效），每次迁移写审计；`curation_runs/` 留待 P1 commit 流程。
- **golden 评测口径**：runner 用 `engine.queryData`（只取检索数据，不生成 LLM 回答），三指标=文档命中率（文件名精确/包含）、实体命中率（精确/概念包含）、引用覆盖率（**空白剥离后**子串匹配——chunk 原文句子常被换行/制表符打断，实测必须归一化）；golden 集随包发布（`golden/golden.yaml`），运行期可在 storages 目录覆盖。
- **实测事实（引擎批次方差）**：同一 query 的实体集与 chunk 排序存在运行间方差（LLM 关键词生成所致）；29 题基线两轮对比仅 1 题实体翻转，覆盖率指标稳定（98.2%），门控判定需容忍 ±5% 噪声。
- 路由：`GET /kb/curator/proposals`、`GET /kb/curator/query-log`、`GET /kb/curator/golden`（考试卷全文 + 历史基线 + 体检进度）、`POST /kb/curator/golden/run`（「立即体检」：现场串行跑 29 题 /query/data，只读约 1 分钟，完成后落 baseline 报告并 emit `kb.curator.golden`）。
- **评测可视化**：工作台第 6 个 tab「评测」——指标卡（三项命中率 + 题目数）、考试卷逐题表（题目/期望文档/概念/条文 + 上次体检命中）、历史基线列表、立即体检按钮（轮询 `/kb/curator/golden`）。基线报告同时落 .md（人读）+ .json（结构化）；`listBaselines` 合并运行时目录（优先）与包内 `reports/`（版本化兜底），重启后即可见 P0 基线。

### 11.5 知识飞轮 P1（2026-09-07）
- **提案=原子交易**：`kb_propose` 一条提案一个 op；evidence/rationale 必填；additive 必带自证题。provenance=derived:agent；提案编号按已有提案最大号+1（行数含迁移行，不可作基数——实测修复）。
- **双条件门控（线上前后对比 + 自动回滚，替代快照）**：条件一自证题（base 能答上=冗余拒绝；应用后答不上=拒绝+回滚）；条件二 golden 回归（cand vs base，**判定只看文档命中率 + 引用覆盖率（容差 2%）；实体命中率只记录趋势不入判定**——首个真实提案（MinerU）即被实体噪声误杀：实测单轮实体噪声 3.4%~6.9%，additive 结构上无法破坏实体检索，硬性门控只会误杀）。golden base 用 24h 内最近基线缓存，避免每次门控跑两遍 29 题。
- **审批分级**：additive（entity_edit/entity_create/relation_create）门控通过后按 `auto_commit_ops`（默认三者全自动）直接提交；配置外/破坏性/文本 op 经 `ctx.approval.request({agent, toolName, callId, reason, signal})` 人工审批（open turn 内），拒绝即 reject 不应用。
- **entity_edit 前值捕获**：回滚=前值重放；前值来源 **GraphML 节点 d2 描述**（流式查找 ~0.3s）→ queryData hl_keywords 直取兜底；两路都失败 → **降级人工路径**（先审批后应用，绝不"应用了却回不了"）。实测：引擎跑在容器（health.working_directory 是容器路径），宿主插件需显式配置 `KB_RAG_STORAGE`＝**活库宿主路径**（docker inspect 实测挂载：`/home/sjy-spark/Desktop/work/rag/lightrag/light-rag-docker/LightRAG/rag-storage-0.6B` → `/app/data/rag_storage`；仓库顶层 `LightRAG/rag_storage` 是 8月6日旧快照，不可用）。
- **存储三件套实测勘误（2026-09-07 用户纠正）**：`kv_store_full_entities.json` 键是 `doc-<hash>`、值是 `{entity_names:[...]}`——**"文档→实体名"删除索引（1801 篇文档），不是实体档案卡**；实体档案（entity_id/entity_type/description）在 **GraphML 节点属性**（d0/d1/d2）里；`vdb_entities.json` 951MB 超 Node 单字符串上限（512MB）不可整读。全量实体名单唯一可靠来源=GraphML 节点（活库 109,099）。
- **账本**：提案状态迁移（append-only）+ 提交审计（`registry.audit` 现在返回行，供 `commit_audit_ref` 引用）+ `curation_runs/commit_log.jsonl`。
- **实测 E2E**（真实引擎，自测实体跑完即删）：entity_create 提案 base 自证 0/1 → 应用 → cand 1/1 → golden delta 0/0/0 → eval_passed → committed；同题再提 → 冗余拒绝；账本可回溯。
- **P1 边界**：text_ingest 走人工审批（异步抽取 + 删除重建成本高，不做自动门控）；破坏性 op 人工审批即门控，无自动评测；curation_runs 批量记账留待 P2。

### 11.6 知识飞轮 P2（2026-09-07）
- **五类健康分析（kb_analyze，全只读）**：①源冲突（engine `GET /documents/source_conflicts`，实测 0 条）；②失败文档（registry+engine status_counts，实测 0/1801）；③重复实体候选——**全量实体名流式扫描活库 GraphML**（217MB/109,099 节点，readline 逐行 ~1.3s），规范化名称聚类（全半角括号/空白/大小写统一）→ **实测 500 组候选**（eNodeB≈eNode B≈ENODEB、CMNET≈Cmnet、SLA≈sla、BOSS系统≈Boss系统 等，别名法合并的现成素材）；④检索缺口三分类——query_log 零命中查询去重后重探 /query/data 分诊：a-missing（采购）/ b-retrieval-jitter（波动观察）/ b-missing-text（描述增强/补条文，最有价值）；⑤孤儿实体暂未自动化。
- **周报（kb_report）**：检索信号（总量/零命中率/高频 Top10）、提案飞轮（状态分布/批准率/已提交 delta）、golden 趋势、健康（失败文档/最近缺口分类）。报告 .md+.json 落 reports/。
- **周期编排**：运营会话 + `schedule_create` 周提醒 + `create_goal` 延续（kb-gardener 技能 §1.1）；schedule 是会话内提醒（非 cron），审批只能在 open turn 内——"提醒把人拉进会话"是 harness 原生正确姿势。
- **三源信号边界**：messageFeedback 仅支持按会话查询（无全局接口），session log 全局检索成本高——P2 以 query_log 为主源，双源合并留待 P3。
- 测试：`analyze-unit.mjs` 4/4（归一化/聚类/三分类/周报指标）；`analyze-probe.mjs` 真实引擎 4/4。

### 11.7 体验优化轮（2026-09-07，产品经理视角）
- **总览首页**：「概览」tab 升级为总览——引擎健康、体检分数（口语化三指标+与上一基线对比箭头）、近 7 天检索（次数/没查到比例/高频问题）、**待办清单（点击直达对应 tab）**、最近动态（审计+提案混合时间线）。新增 `GET /kb/curator/stats` 聚合接口（一次请求拿全）。
- **「运营」tab（第 8 个）**：检索流水（最近 100 次查询：时间/问题/命中/耗时/入口）、体检报告（四类数字卡+重复概念候选+缺口三分类表+历史报告）、周报（关键指标卡+历史）。新增 `GET /kb/curator/reports`（analysis+weekly 历史）。
- **全站术语口语化**（client 统一文案层）：状态 `proposed→已提出 / eval_passed→考试通过 / committed→已生效`；操作 `entity_edit→补充描述 / text_ingest→新增资料 / entity_merge→合并概念…`；指标 `doc_hit_rate→找得到 / citation_coverage→读得全 / entity_hit_rate→认得全`（精确术语悬停提示）；缺口分类 `a-missing→库里没有 / b-missing-text→内容不全`；delta 显示 `持平 ✓ / 变好 ↑ / 变差 ↓`。
- **审批/工具文案口语化**：kb_propose 审批卡 reason 由 JSON delta 改为"考试通过（自证题通过；旧知识检查：找文档持平、读内容持平）"。
- **导航联动**：总览待办卡点击 → 跳转 文档/运营/提案/评测 tab（onNavigate 状态提升）。
- 测试：flywheel 7/7、analyze 4/4、全文件语法通过；stats/reports 聚合逻辑 standalone 验证。

### 11.8 v2 重构（2026-09-14：意图账本 + 收敛器 + 单一写入口）

> 核心反转：**注册表是意图账本（事实源），引擎是物化视图**；收敛器持续对账让引擎逼近注册表，而不是反过来补救。解决 v1 的 P0 级问题：内存队列重启即丢、门控中间态污染基线、回滚失败被静默吞掉、file_path 越界、tunable 全部硬编码。

- **模块清单（v2 全量替换 v1，v1 文件已删除）**：
  - `lib/store.js`：存储原语——原子写（tmp+rename）、防抖 JSON store（`flushSync` 关机落盘）、append-only JSONL（`compact` 同 key 末行生效）。修复 v1 全文件读写 + 无界增长。
  - `lib/engine-port.js`：`createLightRagEngine` 适配器 + 纯函数（`isPipelineBusy`/`flattenGraphArrays`/`engineStatusToRegistry`/`fileSetOf`）；§11.1 的 8 条引擎怪癖全部集中在此层。
  - `lib/fake-engine.js`：与真实引擎同接口的内存实现，模拟全部怪癖（同 source 409/删除异步且忙时静默丢弃/忙时写 409/内容寻址 id/数组值 500/track 形状/page_size 下限）。
  - `lib/intent.js`：意图账本——所有文档类变更先落 WAL（`intents.jsonl`）再执行；状态机 `pending → issuing → issued → verifying → verified/failed/stuck`；串行执行器（同一时刻一个意图）；`replace` 阶段机（先删旧核验消失、再插新，崩溃从所处阶段续跑）；`stuck` = 重试耗尽，可见可重试，绝不静默。文件字节入 `spool/`，终态清理。
  - `lib/reconciler.js`：收敛器——启动/定时全量对账：引擎有注册表无 → 收养（单条汇总审计）；注册表 active 引擎无 → 标 missing；注册表 retired 引擎残留 → 低优先级补删意图；进行中意图覆盖的文档豁免。
  - `lib/registry.js`：注册表 v2——内存索引（byId/bySource，O(1) 查找）+ 防抖写盘；`audit.jsonl` append-only。
  - `lib/service.js`：单一写入口——origin 策略链（user 直行 / agent 破坏性+图谱写 403 除非 approved / flywheel 门控背书直行 / system 直行）；同 source 活文档或在途意图 → 409；文件名净化 + 扩展校验；`retryDoc` 显式 doc_ids（v1 全局重试双 bug 修正）。
  - `lib/gate.js`：门控 v2——基线在**提案应用前**测量且缓存键=内容指纹+题集指纹（v1 基线被提案污染、24h 缓存期间库漂移全算 delta 的失真修正）；回滚失败 → `stuck` + 审计行（v1 静默吞掉修正）；意图类提案（text_ingest/delete_doc）提交后停在 `approved + intent_ref`，由意图终态回调升 committed/rejected。
  - `lib/curator.js`：curator v2——query_log/proposals 改 append log + 内存索引；回放层 `replay.json`（promoted 上限 100 / sampled 150，超量淘汰最老）；基线报告文件名带毫秒时间戳（v1 同日互相覆盖修正）。
- **契约测试（`node dev/run-tests.mjs`，8 套件，零网络零真实引擎）**：store（原子性/防抖/压缩）、engine（怪癖锁定 + 纯函数）、intent（全链路 + 重启恢复 + 崩溃窗口 409 找回 + 替换阶段机 + stuck/retry）、reconciler（收养/缺失/补删/豁免/分页）、service（origin 策略/幂等/审计）、curator（状态机/golden/回放/指纹）、gate（冗余拒绝/自证回滚/golden 回归回滚/回滚失败 stuck/指纹锚定缓存/意图联动）、analyze（缺口三分类/聚类/周报）。harness：`makeStack` 每用例新临时目录 + 假引擎，`{dir, engine}` 复用即"重启"模拟。
- **实施期修正（v2 内测发现）**：`retireDoc` 第三参是状态而非 reason（意图核验路径曾把删除原因写成状态）；spool 丢失的 failed 转换曾被"引擎未返回 track_id"覆盖；`verifyAt` 统一走 `verifyDelayMs` 配置（原硬编码 5s）；收敛器对账字段 `doc_id`（非 `docId`）；收养合并为单次 `adoptDocs`（单条汇总审计）。

### 11.9 图文关联（2026-09-20）

> 参照 qa-assistant 的图片检索机制（`qa-assistant/LightRAG数据文件与图片检索机制详解.md`），在 `lightrag_query_data` 的证据渲染面注入原文档图片。核心设计事实与决策：

- **模型可见面是 render，不是 execute 返回的 JSON**：注入只发生在 `output.render`（chunks 文本先裁剪到 1600 字符再注入），execute 返回与 query_log 检索快照保持原始 chunk（占位符原样），诊断证据不受渲染策略污染；注入是"原始 chunk + inputs 目录"的确定性函数，会话可重放。
- **引擎实测勘误**：`/query/data` 的 chunk 同时携带 `reference_id`（本页序号，如 "2"）与 `chunk_id`（完整键 `doc-<hash>-chunk-NNN` / `-mm-drawing-NNN`）——mm 反查依赖后者，`clipQueryData` 此前丢弃了它（本次补上）。磁盘 `.parsed` 目录名带类别前缀（`风险与合规_审计_*.docx.parsed`），而 chunk `file_path` 是裸入库名，定位必须做后缀匹配；drawings.json 文件名同样带前缀。
- **两条通道**：①普通 chunk 的 `<drawing path="..."/>` 占位符原地替换为 `![caption](http://host:port/kb/image?…)`（绝对 URL——宿主聊天 markdown 渲染器只放行绝对 HTTP(S) 图片，相对路径渲染为 alt 文本），不可定位时移除；②mm-drawing chunk 按 id 末尾序号反查 drawings.json，三级校验（hash 前缀 → `[Image Name]` 相等 → 相似度 ≥0.75），都不过不给图。实测大量文档 `.parsed` 已删（652 个 parsed 目录中 244 个含 drawings.json），两通道正确降级。
- **渲染裁剪交互**：render 把 `\s+` 压成单行后再提取 `[Image Name]`，贪婪匹配会把整段描述吞进图片名导致三级校验必败——名称提取正则在 `[Image Type]` 或行尾截断（契约测试锁定）。
- **注入顺序先裁剪后注入**：mm 追加的图片行必在 1600 字符窗口末尾存活；占位符替换只影响窗口内标签。
- **URL 前缀惰性求值**：`webServer.port` 在渲染期（宿主已监听）读取；启动早期为空时注入直通。`0.0.0.0` 监听地址统一改写回环 `127.0.0.1`（浏览器不可访问 0.0.0.0）。
- **EMF/WMF**：宿主机有 libreoffice（/usr/bin/libreoffice）；`/kb/image` 按需 headless 转 PNG（独立临时 profile 防并发冲突，缓存 key=路径+mtime+size，实测首次 ~1s / 命中 0ms），不可用时降级返回原文件由前端回退 alt。
- **安全**：图片解析强制约束在 `__parsed__` 根内（`path.relative` 判定），拒绝绝对路径/http(s)/协议相对 path，与 P2-9 工作区边界同一防御思路；`KB_LIGHTRAG_INPUTS_DIR` 未配置整体降级（与 KB_RAG_STORAGE 同模式）。
- **测试**：`dev/contract-images.mjs` 16 用例（相似度口径/目录定位三形态/穿越拒绝/两通道/三级校验/单行 content 回归/EMF 桩转换缓存），挂入 run-tests（11 套件）；真实引擎 + 真实 inputs + 真实 libreoffice 端到端实测两通道命中。
