# 无线网优助手与 ECHO-Mem 工作台

基于 DeepSeek Harness SDK（npm 包 `@deepseek-ai/dsh-sdk-client`）的无线网优工作台，连接 ECHO-Mem 原理与编译机制，配有蓝白视觉的产品门户（Vite + React 前端、轻量门户认证适配和 Nginx 静态服务）。自包含仓库：不依赖 DeepSeek Harness 源码仓。

## 阿里云知识服务模式（当前默认）

无线网优助手连接阿里云上的 LightRAG 与 MinerU，用于网优文档解析与补充检索。配置集中在 `backend/.env`：文本模型 `qwen3.8-flash`、图片模型 `qwen3.8-omni-flash`、模型兼容地址和密钥、LightRAG 地址与 `X-API-Key`、MinerU 地址与 Bearer key。密钥文件不进 Git 或镜像。首次配置见 `backend/.env.example` 与 [QUICK_START.md](QUICK_START.md)。

```bash
docker compose -f docker-compose.app.yml --env-file backend/.env up -d --build
```

访问 `http://localhost:<WEB_PORT>/chat`（模板默认 8080，本机配置 8086）。默认只启动前后端；本地 LightRAG 放入关闭的 `local-engines` profile，MinerU 由阿里云运行。PDF 上传经过「本地后端 → LightRAG → MinerU 适配器 → MinerU」解析入库；聊天图片附件调用多模态模型后交给问答模型。集成状态可查看 `/api/integrations/health`。

会话、知识注册表、意图与审计账本保存在 `rag-kb-runtime` 卷，附件保存在 `rag-kb-spool` 卷。SDK 的运行配置由 `.env` 在启动时生成到 `.runtime/dsh-home`，`dsh/home` 继续作为插件模板。

远程 REST 模式支持知识检索、文档管理与图谱增删改查。`KB_RAG_STORAGE` 和 `KB_LIGHTRAG_INPUTS_DIR` 留空时，依赖共享文件的 GraphML 重复实体分析和原文图片回溯自动降级；PDF 解析与图片附件识别仍可用。

## 通用 Harness 更新

已接入项目级网优 Skill 目录，显式固定 `workspace-write` 文件沙箱和业务审批策略；知识问答采用简洁回复、证据复用与完成即停止的规则。运行配置按 profile manifest 连接插件，内容不变时不重复写入。

通用经验、适用边界、可复制提示词与验证方式见 [可复用的 Harness 执行规范](docs/harness/README.md)。`GET /api/skills` 返回 SDK 实际发现的项目能力；本地检查运行 `cd backend && npm run test:harness`。

## 网优与 ECHO-Mem 能力

默认 `rag-kb` profile 专注历史驱动的网优分析，安装 13 个网优 Skill，分为两条路径：**分析回答**消费 ECHO-Mem 历史案例和已沉淀经验，对照当前数据做根因、参数与方案分析；**工单记忆工程**保存工单、方案与实际反馈，评价效果并编译本地经验版本。普通分析无需先保存工单；工程分析复用同一套历史方法。LightRAG/MinerU 用于网优资料补充，`wireless-echo-mem` 保留原理与源码问答。

根因、方案与评估 Skills 共用 [ECHO-Mem 历史决策方法](skills/wireless-workorder-orchestrator/references/echo-decision-workflow.md)：从历史标签提出可区分的当前假设，从历史动作/组合生成适配候选，执行前评价历史支持和反证，执行后比较真实效果与业务判据。每项原则有固定源实现对应关系；普通评估可直接回答，需要保存或沉淀时再进入工程流程。

Harness 按目标自由组合 [ECHO 能力](skills/wireless-workorder-orchestrator/references/echo-capabilities.md)，不要求固定工单阶段顺序。根因采用源问题框架与多维证据，固定候选采用源 Shadow 约束；源排序与值适配通过 `wireless_echo_decision` 按需独立执行。

根因、数据、参数应用与方案分析先调用 `wireless_history_search`，自动检索固定案例、参数经验、研究结论及本地冻结包中的六类记忆，返回命中/未命中、读取不完整与生产数据源未接入状态。已有经验保留；语义或研究结论不冒充实测工单。回答保留简短案例标识、历史动作/结果和当前适用差异。执行方法见 [ECHO-Mem 分析契约](skills/wireless-workorder-orchestrator/references/echo-analysis-method.md)，工程步骤见 [工单记忆工程](skills/wireless-memory-engineering/SKILL.md)。

部署携带固定版本的参数语义快照（279 个签名映射）、4 个混合类型案例条目、3 条研究经验摘要、ECHO-Mem 158 份复现文本、10 份源 Skill/Shadow/选择提示文本及源规则编译器，不依赖临时研究目录。9 个领域工具支持统一历史检索、源状态候选分池、原理检索、工单/方案/反馈记录、观测对齐、根因引用核对、参数约束、源候选排序/受限选择/值适配、效果比较和源规则编译。新编译的本地历史包自动进入后续检索，旧版本保留；演示包默认排除，跨包重复 Trace 不累加效果统计。全量生产库、现场采集/下发、完整结构导航、校准 gate、线上发布与完整时序回放尚未连接。材料与范围见 [网优语料](docs/wireless-network-optimization/available-corpus.md)。

本机编译依赖首次安装：`python3 -m venv backend/.runtime/wireless-python`，然后 `backend/.runtime/wireless-python/bin/pip install -r backend/dsh/dsh-wireless/compiler-requirements.txt`；Docker 镜像安装到 `/opt/wireless-python`。可用 `WIRELESS_PYTHON` 覆盖解释器，使用源项目要求的 Python 3.12 验证。

离线检查：`cd backend && npm run test:harness`。启动后运行 `node dev/smoke-wireless.mjs` 检查问答，或 `node dev/smoke-wireless-workflow.mjs` 检查模拟工单、效果评估和演示编译；`node dev/smoke-wireless-focus.mjs` 检查专用定位、ECHO 原理和方案/反馈/记录链（均调用所配置模型）；`HARNESS_TEST_BASE_URL` 指定入口。工单与版本包保存到 DSH_HOME 的 `storages/dsh-wireless`，可用 `WIRELESS_DATA_DIR` 覆盖。

## 目录结构

```text
rag-harness-sdk/
├── backend/                    # 后端
│   ├── index.js                #   适配层：浏览器 ↔ dsh 子进程桥（SSE 聊天/审批/kb REST，3088）
│   ├── package.json            #   适配层依赖：@deepseek-ai/dsh-sdk-client（含版本 overrides）
│   ├── cas-server/             #   独立 CAS 认证中心（前后端一体，仅负责认证）
│   ├── portal-auth/            #   门户的 CAS 客户端与门户会话服务
│   └── dsh/                    # dsh 运行时与插件
│       ├── home/               #     DSH_HOME：settings、profiles/rag-kb、.env（模板 .env.example）
│       ├── dsh-knowledge/      #     知识库插件（LightRAG 适配、/kb/* REST、kb_* 模型工具）
│       ├── dsh-wireless/       #     ECHO 来源问答、网优阶段、方案/反馈记录、效果评估与规则编译
│       └── plugin-approval-bridge/ # 审批桥接插件（/approvals/* HTTP 面）
├── frontend/                   # 前端：React 门户与首页 Nginx
├── gateway/                    # 网关 Nginx 路由
├── nginx.conf                  # 服务器总入口，TLS 与多应用路由
└── docker-compose.yml          # 服务器总入口 Nginx
```

门户 SSO 由三部分组成（`docker-compose.gateway.yml` 统一编排）：

- `cas-server`：独立 CAS 认证系统，登录成功 302 回跳 service（门户/业务系统）。
- `portal-auth`：门户的 CAS 客户端，发起登录、校验 Ticket，通过签名 Cookie 保存最小用户身份。
- `homepagev2`：React 门户前端（静态页）。

## 认证流程

```text
浏览器
  -> 点击产品的“登录并进入”
  -> /api/auth/login
  -> CAS /login
  -> /api/auth/callback?ticket=ST-xxx
  -> portal-auth 服务端校验 Ticket
  -> 浏览器获得签名的 HttpOnly 会话 Cookie
  -> 门户 /api/auth/me 返回当前用户
  -> 自动继续访问产品 /sso/login
  -> CAS 复用全局登录会话，无需再次输入密码
  -> 产品获得并校验自己的 Service Ticket
```

前端不会读取或保存 CAS Ticket，也不会把用户名当作可信身份。

## 业务系统单点登录接入

任何业务系统都可以通过 CAS 协议接入本门户，实现「门户登录一次，各系统免密进入」。
下面以「大客户内外数据比对智能体」（139 工程，即 tri-source-agent）为例，
说明接入步骤并给出后端示例代码。

### 接入原理

```text
业务系统后端(未登录)
  -> 302 到 CAS /cas/login?service=<业务系统回跳地址>
  -> CAS 展示登录页 / 免密发放 ticket
  -> 302 回跳 <业务系统回跳地址>?ticket=ST-xxx
  -> 业务系统后端拿 ticket 调 CAS /cas/serviceValidate 校验
  -> CAS 返回 XML(含 user/uid)
  -> 校验通过，业务系统建立自己的登录态(如签发 JWT)
```

业务系统只需实现两个动作：**引导登录**（跳 CAS）和 **校验回跳**（验 ticket）。

### 关键配置（139 工程 `.env` 实例）

```ini
# 浏览器跳转的 CAS 登录地址
CAS_SERVER_URL=http://127.0.0.1:9000/cas

# 本系统对外回跳地址，必须与登录时传给 CAS 的 service 完全一致
CAS_SERVICE_URL=http://127.0.0.1:9100/vip_139/report/api/auth/sso/login

# 后端校验 ticket 接口（可留空，自动推导为 {CAS_SERVER_URL}/serviceValidate）
SSO_VALIDATE_URL=http://127.0.0.1:9000/cas/serviceValidate

# 从 CAS 返回 attributes 中取用户标识的属性名
SSO_UID_ATTRIBUTE=uid
```

> 重要协议约束（CAS 官方规范，必须遵守）：
> - 登录传给 CAS 的 `service` 与校验时用的 `service` **必须严格一致**。
> - `service` 参数不得含转义符号 / `#` / 多个 `?`。
> - ticket 一次性使用，30 秒过期。

### 后端示例代码（以 139 工程为准，可复制到任意 Python 后端）

```python
"""CAS 单点登录客户端接入示例（路由适配任意 Web 框架）。"""
import xml.etree.ElementTree as ET
from urllib.parse import urlencode

import requests

CAS_SERVER = "http://127.0.0.1:9000/cas"
CAS_SERVICE_URL = "http://127.0.0.1:9100/vip_139/report/api/auth/sso/login"  # 本系统回跳地址


def build_login_url() -> str:
    """构造引导用户跳转到 CAS 登录页的 URL。"""
    query = urlencode({"service": CAS_SERVICE_URL})
    return f"{CAS_SERVER}/login?{query}"


def sso_login(request) -> "Response":
    """GET /sso/login：未登录就跳 CAS，带 ticket 回跳则校验。"""
    ticket = request.args.get("ticket", "")
    if not ticket:
        # 未登录：跳转到 CAS 登录页
        return redirect_302(build_login_url())
    # 已从 CAS 回跳：校验 ticket
    result = validate_ticket(ticket)
    if not result["success"]:
        return render_error("登录失败: " + result["error"])
    # 建立本系统登录态，例如签发 JWT / 写入会话
    return issue_local_session(result["uid"])


def validate_ticket(ticket: str) -> dict:
    """向 CAS 校验 ticket，返回 {"success": bool, "uid": str, "attributes": dict}。"""
    url = f"{CAS_SERVER}/serviceValidate?{urlencode({'service': CAS_SERVICE_URL, 'ticket': ticket})}"
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as exc:
        return {"success": False, "error": f"CAS 不可达: {exc}"}
    return parse_cas_xml(resp.text)


def parse_cas_xml(xml_text: str) -> dict:
    """解析 CAS /serviceValidate 返回的 XML。"""
    ns = {"cas": "http://www.yale.edu/tp/cas"}
    root = ET.fromstring(xml_text)
    failure = root.find(".//cas:authenticationFailure", ns)
    if failure is not None:
        return {"success": False, "error": (failure.text or "").strip()}
    uid = root.findtext(".//cas:authenticationSuccess/cas:user", namespaces=ns)
    attrs = {}
    node = root.find(".//cas:authenticationSuccess/cas:attributes", ns)
    if node is not None:
        for child in node:
            key = child.tag.rsplit("}", 1)[-1]
            attrs[key] = (child.text or "").strip()
    if not uid:
        return {"success": False, "error": "CAS 未返回 uid"}
    return {"success": True, "uid": attrs.get("uid", uid), "attributes": attrs}
```

接入后，在门户 `frontend/.env` 中把该产品入口指向本系统 `/sso/login`，例如：

```ini
VITE_KEY_ACCOUNT_COMPARISON_URL=http://127.0.0.1:9100/vip_139/report/api/auth/sso/login
```

门户前端「登录并进入」即可触发上述 SSO 流程，进入 139 工程时不需再输入密码。

## 本地联调

### 1. 启动项目内置 CAS 认证服务

CAS 已收入本项目 `cas-server/`，为独立认证系统（不再依赖外部 mock-cas-server 项目）。

```bash
cd cas-server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/python app.py
```

默认地址为 `http://127.0.0.1:9000/cas/login`。演示账号：`wangqiyue / Wqy@2026#Secure!Cas`。

### 2. 启动门户认证后端

```bash
cd portal-auth
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/python app.py
```

门户认证适配监听 `http://127.0.0.1:9010`。

### 3. 启动前端

```bash
cd homepage
npm ci
npm run dev -- --host 127.0.0.1 --port 4173
```

访问 `http://127.0.0.1:4173`，点击右上角“统一登录”。

对话工作台原型位于 `http://127.0.0.1:4173/chat?agent=agent-hub`，也可以从
门户产品详情中的“对话原型”进入。当前版本用于界面与交互联调，回复内容为前端演示数据，
后续再接入真实智能体会话接口。

如需验证门户到业务系统的完整跳转，切换到“大客户内外数据比对智能体”，
点击“登录并进入”。其默认入口为：

```text
http://127.0.0.1:9100/vip_139/report/api/auth/sso/login
```

各产品入口通过 `frontend/.env` 中的 `VITE_*_URL` 配置。没有配置入口的产品
在登录后显示“应用接入中”，不会跳转到虚构地址。

## 自动化检查

```bash
cd cas-server
.venv/bin/python -m py_compile app.py

cd ../portal-auth
.venv/bin/python -m unittest discover -s tests -v

cd ../homepage
npm run build

cd ..
docker compose -f docker-compose.gateway.yml config --quiet
```

## Docker 运行

推荐用根目录的 `docker-compose.gateway.yml` 将 CAS、门户认证后端、门户前端统一编排启动：

```bash
docker compose -f docker-compose.gateway.yml up -d --build
```

拓扑（网关 `:8080` 为唯一对外入口）：

- `/` → `homepagev2`：门户前端静态页
- `/api/auth/*` → `portal-auth`：门户认证后端
- `/cas/*` → `cas-server`：项目内置 CAS 认证中心

Docker 中的 `portal-auth` 不依赖数据库或 Redis，只保存经过签名的最小身份 Cookie。
`cas-server` 的演示账号仅用于联调，生产请替换为真实账号数据源。

## 生产配置

生产环境至少需要设置：

```ini
# cas-server（项目内置 CAS）
APP_ENV=production
SECRET_KEY=<强随机值>

# portal-auth（门户认证后端）
PORTAL_AUTH_SECRET_KEY=<强随机值>
CAS_PUBLIC_URL=https://sso.example.com/cas
CAS_INTERNAL_URL=http://cas-server:9000/cas
CAS_SERVICE_URL=https://www.example.com/api/auth/callback
PORTAL_PUBLIC_URL=https://www.example.com
SESSION_COOKIE_SECURE=true
SESSION_TTL_SECONDS=3600

VITE_KEY_ACCOUNT_COMPARISON_URL=https://www.example.com/report/api/auth/sso/login
VITE_AGENT_HUB_URL=https://www.example.com/agent_hub/api/auth/sso/login
```

- `CAS_PUBLIC_URL`：浏览器（用户）可访问的 CAS 登录地址。
- `CAS_INTERNAL_URL`：portal-auth 后端校验 ticket 时访问的 CAS 内网地址（指向 cas-server 容器）。
- `SECRET_KEY` / `PORTAL_AUTH_SECRET_KEY`：分别用 `openssl rand -hex 32` 生成。

门户 Cookie 默认有效一小时；过期后会通过 CAS 全局会话静默恢复登录。
生产请把 `cas-server` 的演示账号替换为真实账号数据源（LDAP / 数据库等）。

> 说明：当前根级 `nginx.conf`（`docker-compose.yml`）仍指向生产多业务路由。
> 若仅部署门户 SSO，请使用 `docker-compose.gateway.yml`（网关单入口，:8080）。

## 当前范围

- 已完成门户自身的 CAS 登录闭环。
- 已完成登录、用户状态查询和本地会话退出。
- 尚未把九个业务系统逐个接成 CAS 客户端。
- `cas-server` 内置的演示账号仅用于开发联调，生产应替换为真实账号数据源（LDAP/数据库等）。
