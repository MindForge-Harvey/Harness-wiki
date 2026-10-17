# 知识库智能体（rag-kb）与产品门户

基于 DeepSeek Harness SDK（npm 包 `@deepseek-ai/dsh-sdk-client`）的知识库智能体适配层，外加蓝白视觉的产品门户（Vite + React 前端、轻量门户认证适配和 Nginx 静态服务）。自包含仓库：不依赖 DeepSeek Harness 源码仓。

## 对话工作台的 Skills 配置

左侧「Skills 配置」支持新建、导入 ZIP 技能包或单文件 `SKILL.md`、编辑和预览 Markdown 指令、启停及删除。填写技能名称、英文调用名称、适用场景与指令后，点击「保存并生效」；助手从下一次提问开始按适用场景调用，也可以在对话中输入 `/调用名称` 明确使用。

ZIP 可以包含一个技能，也可以包含多个独立技能目录；系统自动查找 `SKILL.md`，预览技能和文件清单，确认后整体安装。完整保留 `scripts/`、`references/`、`assets/` 及其他资源，支持中文路径和二进制附件，保留可执行标记。多个技能的相对目录和共享文件也会保留，便于技能间引用。遇到同名技能必须勾选替换，提交时校验版本，避免覆盖其他窗口的新修改。

运行时给模型提供真实的技能目录，脚本和资料可通过原有文件、终端工具使用；导入时不会执行脚本。生产镜像包含 Python 3，沿用现有 Node.js 和 shell，脚本所需第三方依赖按技能自身的环境要求准备。导入保留 `disable-model-invocation` 与 `user-invocable` 设置，例如仅手动调用的技能可通过 `/技能名` 使用。

技能包文件沿用账号隔离和既有存储卷，配置中可查看并下载包内文件。上传最多 20 MB，解压合计最多 100 MB、1000 项；会校验路径、链接、重复文件、文件大小及 CRC。预览未确认的包会在取消时清理，过期预览在后续导入时回收。导入、下载和删除 API 均校验登录身份与技能归属。

首次打开配置或发起问答时，会为当前账号安装并启用 4 个初始技能：`grill-me`（需求追问，适配自现有同名技能）、`knowledge-qa`（知识检索问答）、`meeting-notes`（会议纪要）、`document-compare`（文档对比）。源码位于 `backend/starter-skills/`，随应用一起打包。初始化只执行一次：保留用户已有的同名技能，后续编辑、停用、删除不会被重新覆盖或自动恢复。

配置按已验证的账号隔离，保存在 `DSH_HOME/storages/personal-skills/`，沿用现有持久化存储。适配层在校验会话归属后绑定账号，运行时通过各 agent 的独立 Skill Provider 提供指令；每步检查配置版本，更新目录并刷新会话已加载且被修改的技能内容。停用、删除会撤销目录并提示助手停止沿用旧指令，无需重启服务。知识库写操作仍走原有审批流程。

验证命令：`node --test backend/dev/contract-skills.mjs backend/dev/contract-skill-archive.mjs`；前端使用 `npm run test:chat` 和 `npm run build`。

## 实时语音输入

聊天输入框的麦克风现通过 `speech-recognition-agent` 的 Voice API v1 实时转写。点击开始后，文字持续回填；点击结束或按回车后，先完整提交最后一段音频并关闭麦克风，再等待重新识别、补标点和文字订正。最终文字替换本次录音的预览，保留开始录音前的草稿，用户确认后自行发送。手动编辑、切换会话或退出页面会取消听录和订正，迟到的结果不会覆盖新内容。

本地使用：

1. 在 `speech-recognition-agent` 项目执行 `./run.sh`，等待服务就绪。
2. `backend/.env` 可设置 `VOICE_API_BASE_URL=http://127.0.0.1:8765`（默认即为此地址）。填**服务根地址**，不要追加 `/api/v1/voice`；服务若部署在子路径下，可填带该前缀的根地址。
3. 在本项目执行 `./start.sh`，打开 `http://localhost:5173/chat`，允许麦克风权限。

浏览器访问同域 `/api/v1/voice/*`（线上前缀为 `/harness-wiki/api/v1/voice/*`），由后端代理就绪检查、WebSocket、会话查询和取消接口。代理沿用门户身份校验，HTTP 查询与取消按账号限制；WebSocket 校验页面来源，登录 Cookie 不会传给语音服务。音频使用 AudioWorklet 采集为 16 kHz、单声道、小端 PCM16，600 ms 一块，并兼容设备的 44.1/48 kHz 采样率。录音只由语音服务在内存处理，不进入聊天附件或上传历史。

结束听录后 WebSocket 保持连接直到收到最终结果；此阶段断线时自动查询会话结果，最多等待 120 秒。听录期间断线则结束采集并保留已收到的文字，需重新点击开始。服务繁忙、权限拒绝和订正失败会显示提示；订正降级时仍可使用转写文字。服务目前只支持一路同时听录，其他用户遇到繁忙提示需稍后重试。代理的会话归属仅保存在当前后端进程内，重启后正在等待的结果无法通过代理恢复。

未来公网部署时，将语音服务部署到 harness-wiki 后端可达的位置，再修改 `VOICE_API_BASE_URL` 并重启后端。容器内的 `127.0.0.1` 指向容器自身，不能指向开发机。需要同步更新外层 `deploy/outer-nginx.conf` 和容器内 Nginx 的 WebSocket Upgrade 配置；仓库已包含这些配置。前端和用户操作无需再切换，也无需在浏览器暴露模型密钥。当前改动仅在本地验证，未部署公网。

验证：`npm --prefix frontend run test:chat`、`node --test backend/dev/contract-voice-proxy.mjs`、`npm --prefix frontend run build`。

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

### 知识库工作台

后端需要支持内置 SQLite 的 Node.js 22.19 以上版本，推荐 Node.js 24。准备好 `backend/.env` 后，在仓库根目录执行：

```bash
./start.sh
```

启动脚本会选择可用的 Node.js，启动后端 `3088` 和前端 `5173`，并检查服务是否就绪。访问 `http://localhost:5173/chat`；停止服务使用 `./stop.sh`。也可用 `NODE_BIN=/absolute/path/to/node ./start.sh` 指定运行时。

本地未设置 `PORTAL_AUTH_URL` 时使用开发身份；生产环境仍要求门户认证。不需要为独立的工作台开发启动 CAS。只运行前端时，登录检查、历史对话和消息发送均无法连接后端。

以下步骤用于另外联调门户 SSO。

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

## 47 服务器的统一门户与个人会话（2026-10-10）

线上 `docker-compose.server.yml` 使用主门户的 `portal-auth` 和 CAS；账号数据由主门户写入共享 PostgreSQL 的 `agent_showcase` 库。知识库应用不再展示独立的单卡片首页，`/harness-wiki/` 直接显示并定位到 `/harness-wiki/chat`，左上角返回 `/?agent=knowledge-harness` 的九智能体统一主页。

- `HARNESS_DATABASE_URL`：服务器 `.env` 中配置，指向现有专用数据库，密码不写入仓库或镜像。
- `harness_sessions` 保存会话 ID、不可变的 `owner_uid`、标题、时间与删除状态；开发环境没有数据库 URL 时使用持久化 SQLite，生产缺少数据库配置时拒绝启动。
- `GET /api/chat/sessions` 只返回当前用户的列表；历史读取、继续对话、反馈、创建分享、删除与审批操作在后端校验归属。客户端提供的用户 ID 只用于发现过期登录状态，不用于授权。
- 删除会话后数据库保留不可重新认领的删除标记。引擎日志仍保存在原 `harness-sessions` 数据卷，原始数据可恢复。
- 浏览器不再从共享 `rag-kb-sessions` localStorage 读取历史；登录账号变更时清空消息、附件、输入和执行状态，重新读取该账号的历史。
- 已生成的分享链接仍只展示用户主动分享的单条问答快照，不开放整段会话。

旧日志只能通过 `backend/import-legacy-sessions.mjs` 和明确的归属映射导入，禁止客户端认领。已确认的 20:08 会话归 harvey，其余四条更早日志归原 agentshow。

验证：`node --test backend/dev/contract-session-ownership.mjs backend/dev/contract-portal-session.mjs backend/dev/contract-answer-actions.mjs` 覆盖真实 HTTP 路由、跨用户请求、重启持久化、删除后拒绝认领和审批隔离；前端另有 18 项聊天功能测试及生产构建。

线上验收：两个新注册账号完成真实模型问答、本人历史恢复、跨用户历史/继续/反馈/分享/删除拒绝访问、未登录拒绝访问，以及浏览器切换账号清空旧消息。服务再次更新后验证 PostgreSQL 归属与原日志均持久保留，临时账号和日志随后清理。`harness-wiki` 健康，主门户与 CAS/portal-auth 健康检查正常。

源码与镜像回滚资料在 `/root/work_project/codex-backups/` 和主门户 README 的此次发布记录中；数据库导入前快照为 `/root/work_project/backups/agent-showcase/before-harness-ownership-20261010.sql.gz`。环境文件、数据库和三类应用数据卷必须保留。
