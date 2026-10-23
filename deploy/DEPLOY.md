# rag-harness-sdk 内网部署文档（免认证 · 前后端镜像部署）

> 目标形态：内网服务器上只跑 **前端（nginx）+ 后端（适配层 + dsh 运行时 + 沙箱）** 两个容器，
> 无 CAS 登录、无门户认证；LightRAG 引擎与大模型网关作为外部服务由后端连接。
> 后端代码以卷挂载方式进容器，改代码只需 `docker restart`。

---

## 1. 架构与端口

```
浏览器
  │  http://<服务器IP>:8080
  ▼
┌─────────────────────┐   /api/** 代理   ┌──────────────────────────────┐
│ rag-kb-frontend     │ ───────────────▶ │ rag-kb-backend (:3088)       │
│ nginx + Vite 构建产物│                  │  ├ 适配层 index.js (3088)     │
└─────────────────────┘                  │  ├ dsh 子进程 (3090，容器内)  │
                                         │  └ bubblewrap 沙箱            │
                                         │     python3 / libreoffice …   │
                                         └──────┬───────────────┬───────┘
                                                │               │
                                                ▼               ▼
                                     LightRAG 引擎（外部）   内网大模型网关
                                     LIGHTRAG_BASE_URL      OpenAI 兼容 /v1
```

| 组件 | 端口 | 说明 |
| --- | --- | --- |
| 前端 | **8080**（宿主机） | 用户唯一入口，所有请求经 nginx 转发 |
| 后端适配层 | 3088（宿主机） | 也可直连调试；生产流量建议走 8080 |
| dsh 子进程 webserver | 3090 | 仅容器内部使用，不对外 |

镜像内已预置（内网无需再装任何依赖）：

- **沙箱**：`bubblewrap`（dsh 沙箱在 Linux 的隔离底座）
- **文档处理 Python 库**：`python-docx`(Word)、`python-pptx`(PPT)、`openpyxl`+`pandas`(Excel)、
  `markdown`(MD)、`beautifulsoup4`+`lxml`(HTML)、`Pillow`+`matplotlib`(图片/图表)
- **LibreOffice 无头版**（writer/calc/impress）：docx / pptx / xlsx / pdf 格式互转
- **pandoc**：Markdown ↔ docx 转换
- **中文字体** `fonts-noto-cjk`：生成中文文档必备

---

## 2. 前置条件

1. 服务器已安装 Docker（20.10+）与 Docker Compose v2（`docker compose version` 可用）。
2. 服务器与以下服务网络可达：
   - **内网大模型网关**：`http://10.142.175.2:32028/v1`（OpenAI 兼容，Bearer 鉴权）；
   - **LightRAG 引擎**：一个已建库的 LightRAG REST 服务（若服务器上没有，见 §7 用 `docker-compose.app.yml` 同机部署）。
3. 传输通道：部署机（可访问外网，用于构建镜像）到内网服务器可用 `scp` 传输。

---

## 3. 文件清单

本次部署涉及的新增/修改文件（都在 `rag-harness-sdk/` 下）：

| 文件 | 作用 |
| --- | --- |
| `docker-compose.deploy.yml` | 新增：免认证部署栈（仅前后端），含 `HOST=0.0.0.0` 与 `DISABLE_PORTAL_AUTH` 注入 |
| `backend/Dockerfile` | 重写：预装沙箱 + 文档处理全环境 |
| `backend/index.js` | 修改：`HOST` 支持环境变量覆盖（容器内用 `0.0.0.0`，本机开发默认 `127.0.0.1`） |
| `backend/portal-session.mjs` | 修改：新增 `DISABLE_PORTAL_AUTH=1` 免认证开关 |
| `backend/session-ownership.mjs` | 修改：生产模式下 `DISABLE_PORTAL_AUTH=1` 时允许 SQLite（无需强制 PostgreSQL） |
| `frontend/nginx.conf` | 修改：`resolver 127.0.0.11` 延迟解析 backend hostname；`/api/auth/*` 改由后端应答 |
| `frontend/index.html` | 修改：vis-network 改为本地静态引用（内网可用图谱） |
| `frontend/public/vendor/vis-network.min.js` | 新增：图谱库本地副本 |
| `backend/.env` | 部署时按服务器环境修改（见 §4） |

> `backend/Dockerfile` 与 `frontend/Dockerfile` 在部署机构建（需要外网拉取基础镜像与 npm/pip 包），
> 产出 `rag-kb-backend:latest` 与 `rag-kb-frontend:latest` 两个镜像，打包导入内网。

---

## 4. 第一步：修改 `backend/.env`

> 标记说明：🔴 **必须改**（本机路径/IP，服务器不存在）· 🟡 **按需改** · 🟢 **保持默认**

打开 `backend/.env`，**只改下面标记 🔴 的两项**，其他别动：

```sh
# ============================================================
# 🔴 🔴 🔴  以下两项服务器必须改！本机路径写死了，服务器上不存在
# ============================================================

# LightRAG 引擎 REST 地址
LIGHTRAG_BASE_URL=http://127.0.0.1:9623
#       ↑ 改成服务器实际地址，例如：
#       同机部署 → http://127.0.0.1:9623
#       异机部署 → http://<引擎所在机器IP>:9623

# LightRAG 引擎活库宿主路径（实体扫描、图片定位、来源文件下载用）
KB_RAG_STORAGE=/home/sjy-spark/Desktop/work/rag/lightrag/light-rag-docker/LightRAG/rag-storage-0.6B
#       ↑ 改成服务器上的真实目录，例如 /opt/lightrag/rag-storage

# LightRAG 原料区根目录（含 __parsed__，图文注入用）
KB_LIGHTRAG_INPUTS_DIR=/home/sjy-spark/Desktop/work/rag/lightrag/light-rag-docker/LightRAG/inputs
#       ↑ 改成服务器上的真实目录，例如 /opt/lightrag/inputs

# ============================================================
# 🟡 按需修改
# ============================================================
LLM_REASONING_EFFORT=off            # off=关闭思考（最快），high=开启思考

# ============================================================
# 🟢 保持默认（别动）
# ============================================================
PORT=3088
DSH_CHILD_HTTP_PORT=3090
DSH_PROFILE=rag-kb
DSH_HOME_DIR=dsh/home
LLM_PROVIDER=intranet-deepseek      # 已配好内网网关路由
LLM_MODEL=Deepseek-V4-Flash          # 已配好
INTRANET_LLM_API_KEY=26ec728f-99b2-4650-bcf8-9adf08e510e6  # 已配好
QWEN_TOKEN_PLAN_API_KEY=...          # 回退用，保留即可

# 以下两行仅 docker-compose.app.yml（同机部署 LightRAG 引擎）使用
# 当前免认证栈忽略，不用管
# LIGHTRAG_DOTENV=...
# LIGHTRAG_PROMPTS_DIR=...
```

### 路径找不到怎么办？

- **引擎与后端同机**：`KB_RAG_STORAGE` 和 `KB_LIGHTRAG_INPUTS_DIR` 直接填 LightRAG 引擎的数据目录，例如 `/opt/lightrag/rag-storage`、`/opt/lightrag/inputs`
- **引擎与后端异机**：从引擎机器上把这两个目录 `rsync` 一份到后端服务器，填同步后的路径；`LIGHTRAG_BASE_URL` 填引擎机器的 IP
- **服务器还没建 LightRAG 库**：先用 `docker compose -f docker-compose.app.yml` 同机部署 LightRAG（见 §8.4），建好库后再切回免认证栈

### .env 改完以后，compose 里的 volumes 自动对应当

```yaml
# docker compose 启动时会读 .env 的值：
#   KB_RAG_STORAGE=/opt/lightrag/rag-storage        → 容器内 /data/rag_storage
#   KB_LIGHTRAG_INPUTS_DIR=/opt/lightrag/inputs      → 容器内 /data/inputs
volumes:
  - ${KB_RAG_STORAGE}:/data/rag_storage
  - ${KB_LIGHTRAG_INPUTS_DIR}:/data/inputs
```

如果你**没改** .env 里的这两项，compose 会用默认值 `/data/rag_storage` 和 `/data/inputs`——但宿主机上这两个目录可能不存在，容器启动会报错。**所以 🔴 的两项必须改。**

---

## 5. 第二步：构建并分发镜像（部署机上执行）

### 5.1 构建镜像

```sh
cd rag-harness-sdk
docker compose -f docker-compose.deploy.yml --env-file backend/.env build
```

构建完成后确认两个镜像存在：

```sh
docker images | grep rag-kb
# rag-kb-backend     latest   ...（约 2.5GB，含 LibreOffice/Python 库/字体）
# rag-kb-frontend    latest   ...（约 100MB）
```

### 5.2 导出镜像

```sh
docker save rag-kb-backend:latest | gzip > rag-kb-backend.tar.gz
docker save rag-kb-frontend:latest | gzip > rag-kb-frontend.tar.gz
```

### 5.3 传输到内网服务器

```sh
scp rag-kb-backend.tar.gz rag-kb-frontend.tar.gz user@<服务器IP>:/opt/rag-kb/
scp -r rag-harness-sdk user@<服务器IP>:/opt/rag-kb/   # 项目源码（compose 与 .env 在其中）
```

> 源码必须一起拷贝：compose 从 `./backend` 挂载代码与配置。

---

## 6. 第三步：服务器上启动

### 6.1 导入镜像

```sh
cd /opt/rag-kb
docker load < rag-kb-backend.tar.gz
docker load < rag-kb-frontend.tar.gz
```

### 6.2 启动

```sh
cd /opt/rag-kb/rag-harness-sdk
docker compose -f docker-compose.deploy.yml --env-file backend/.env up -d
```

> 首次启动会自动创建 `rag-kb-backend-node-modules`、`rag-kb-sessions`、`rag-kb-spool` 三个数据卷。

### 6.3 验证

```sh
# 1) 容器状态（backend 应为 healthy）
docker compose -f docker-compose.deploy.yml ps

# 2) 后端健康检查
curl -s http://127.0.0.1:3088/api/health
# 期望：{"ok":true,"child":"0 active / 0 sessions"}

# 3) 免认证身份（前端登录态依赖此接口）
curl -s http://127.0.0.1:3088/api/auth/me
# 期望：{"authenticated":true,"user":{"username":"local","uid":"local"}}

# 4) 沙箱与文档处理环境
docker exec rag-kb-backend bwrap --version
docker exec rag-kb-backend python3 -c "import docx, pptx, openpyxl, pandas, bs4, markdown, PIL, matplotlib; print('python deps ok')"
docker exec rag-kb-backend libreoffice --version
docker exec rag-kb-backend pandoc --version
```

### 6.4 浏览器冒烟

1. 打开 `http://<服务器IP>:8080/chat`（无需登录，自动以本地账号进入）；
2. 提问一个知识库问题 → 出现回答 + 引用来源 + 知识关联图谱；
3. 让智能体生成文档验证沙箱：例如发送「用 python 生成一个包含表格的 Word 文档到工作区」→
   批准审批 → 右侧文档面板出现生成的 `.docx` 并可下载。

---

## 7. 服务器统一 nginx 入口

服务器上通常有一个对外统一入口 nginx，用户请求先到它再转发到内部服务。
以下两种方案**任意选其一**，都不需要改前后端代码。

### 方案 A：端口 / 子域名隔离（推荐，零代码改动）

服务器 nginx 直接把域名或子域名转发到 frontend 容器的 8080 端口：

```nginx
# /etc/nginx/conf.d/rag-kb.conf
server {
    listen 80;
    server_name kb.your-server.com;   # 换成你的域名或服务器 IP

    # ⚠️ SSE 流式回答必须加这三行，否则 LLM 回答会被缓冲
    proxy_buffering off;
    proxy_cache off;
    proxy_http_version 1.1;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**优点**：前后端代码、compose、容器内 nginx 全部不用改
**缺点**：如果服务器上已有很多应用，需要管理多个端口或子域名

### 方案 B：路径前缀 `/rag-harness/`

如果必须用同一域名加路径区分多个应用（**后端接口无需修改**，外层 nginx 会自动剥离前缀）：

**第一步：构建带前缀的前端镜像**（默认构建不带前缀，兼容方案 A）：

```sh
cd rag-harness-sdk
docker build --build-arg VITE_BASE=/rag-harness/ \
  -f frontend/Dockerfile -t rag-kb-frontend:latest frontend/
```

**第二步：服务器 nginx 配置**（注意 `proxy_pass` 结尾带 `/` 剥离前缀）：

```nginx
# /etc/nginx/conf.d/rag-harness.conf
server {
    listen 80;
    server_name your-server.com;

    # ⚠️ SSE 流式回答必须加这三行，否则 LLM 回答会被缓冲
    proxy_buffering off;
    proxy_cache off;
    proxy_http_version 1.1;

    # 注意：proxy_pass 结尾带 /，会自动剥离 /rag-harness/ 前缀
    # 容器内前端收到的是 /api/ /assets/ / 等无前缀路径，完全兼容
    location /rag-harness/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**容器内 nginx 已内置 `/rag-harness/` 回退规则**（`rewrite last` 二次匹配），
即使外层 nginx 未剥离前缀、直接访问容器 `/rag-harness/...` 也能正常工作。

**后端接口完全不需要改**——外层 nginx 剥离前缀后，容器内看到的是 `/api/health`、
`/api/auth/me` 等无前缀路径，和方案 A 完全一致。

### HTTPS（可选）

如果服务器 nginx 已经配好了 HTTPS（推荐），只需在 server 块里加 `443 ssl` 和证书路径，
其余配置完全一样，前端会自动走 HTTPS。

---

## 8. 日常运维

### 8.1 重启命令选择（⚠️ 关键区别）

| 你改了什么 | 用什么命令 | 原因 |
| --- | --- | --- |
| `.env` 里的值、compose 的 `environment`、`env_file` | `docker compose restart backend` 或 `docker compose up -d` | Docker Compose 的 `env_file` 只在容器创建时注入，`docker restart` 只重启进程不重新注入环境变量 |
| `backend/` 下的 JS 代码、`dsh/home/settings.yaml`、profile 配置 | `docker restart rag-kb-backend` 就行 | 这些文件是 bind mount，进程重启就能读到 |

> ⚠️ **坑**：改了 `.env` 后跑 `docker restart rag-kb-backend`，新值不会生效！
> 必须用 `docker compose -f docker-compose.deploy.yml restart backend`
> 或 `docker compose -f docker-compose.deploy.yml up -d`（后者会检测到 env 变化并重建容器）。
> 这个行为是 Docker Compose 的设计决定，不是 bug。

### 8.2 修改后端代码 / 配置（无需重建镜像）

后端代码与 `dsh/home/`（插件、settings.yaml、profile）都是挂载进容器的：

```sh
# 改 JS 代码或 dsh/home/ 配置后：
docker restart rag-kb-backend

# 改 .env 后（⚠️ 必须用 compose）：
docker compose -f docker-compose.deploy.yml restart backend
# 或者更保险的做法（会重新读取 env_file 并重建容器）：
docker compose -f docker-compose.deploy.yml up -d
```

改前端代码则需重新构建前端镜像（在部署机构建后重新分发，或在有 npm 源的服务器上构建）。

### 8.3 开启思考输出

编辑 `backend/.env` → `LLM_REASONING_EFFORT=high` → **必须用 compose 重启**：

```sh
docker compose -f docker-compose.deploy.yml restart backend
```

### 8.4 修改 LightRAG 地址或数据路径

编辑 `backend/.env` 里的 `LIGHTRAG_BASE_URL` / `KB_RAG_STORAGE` / `KB_LIGHTRAG_INPUTS_DIR`：

```sh
# 改完 .env 后，不仅要重启，还要确保 compose 的 volumes 绑定也刷新
docker compose -f docker-compose.deploy.yml up -d
```

### 8.5 数据备份

| 数据 | 位置 | 备份方式 |
| --- | --- | --- |
| 会话历史 | 卷 `rag-kb-sessions` | `docker run --rm -v rag-kb-deploy_rag-kb-sessions:/data -v $PWD:/bak alpine tar czf /bak/sessions.tar.gz -C /data .` |
| 审批附件 | 卷 `rag-kb-spool` | 同上 |
| LightRAG 数据 | `KB_RAG_STORAGE` 指向的目录 | 常规目录备份 |

### 8.4 与 LightRAG 同机部署（可选）

如果希望 LightRAG 也由本项目的 compose 托管（引擎 + 前后端一体），改用：

```sh
docker compose -f docker-compose.app.yml --env-file backend/.env up -d --build
```

该栈额外要求 `backend/.env` 配置 `LIGHTRAG_DOTENV`（引擎自身配置文件，含建库模型 key）与
`LIGHTRAG_PROMPTS_DIR`（自定义提示词目录），缺失时启动即报错。

---

## 9. 故障排查

| 现象 | 排查 |
| --- | --- |
| 打开历史会话报 502（响应体为 JSON） | 旧版镜像缺 `zstd`：适配层回放 `.zstd` 压缩会话日志时解压失败。确认镜像 ≥ 2026-10-23 版（`docker exec rag-kb-backend zstd --version`）；旧镜像临时止血可从新镜像拷贝二进制：`docker cp <新镜像容器>:/usr/bin/zstd rag-kb-backend:/usr/bin/` 后 `docker restart rag-kb-backend` |
| 页面打开报「登录服务暂不可用」 | `curl http://127.0.0.1:3088/api/auth/me`；若 503 检查 compose 是否注入 `DISABLE_PORTAL_AUTH: "1"` |
| 回答报模型错误 / 无响应 | `docker logs rag-kb-backend --tail 50`；确认服务器能通 `http://10.142.175.2:32028/v1`（`curl` 测试）；模型名大小写须为 `Deepseek-V4-Flash` |
| 知识库问答报连接失败 | `LIGHTRAG_BASE_URL` 是否正确；`curl $LIGHTRAG_BASE_URL/health` |
| 图谱不显示 / 加载失败 | 已内置本地 vis-network，不应出现；若出现说明前端镜像过旧，重建前端镜像 |
| 沙箱执行报 `bwrap: cannot create namespace` | 确认 compose 的 `security_opt: seccomp=unconfined` 与 `cap_add: SYS_ADMIN` 存在；内核需允许 unprivileged user namespace |
| 生成的中文文档乱码/方块 | 镜像内已含 `fonts-noto-cjk`；若用了自装字体环境需自行补充 |
| 改了代码不生效 | 确认改的是**服务器上挂载的** `rag-harness-sdk/backend/`；然后 `docker restart rag-kb-backend` |
| 3088 端口被占用 | `ss -ltnp | grep 3088`；宿主机上若有同端口进程先停掉，或改 `.env` 的 `PORT` |

---

## 10. 安全提示

免认证形态下**任何能访问 8080 的人都是同一个「local」账号**，且沙箱内可产生写入。
请通过内网防火墙/访问控制把 8080（与 3088）限制在可信网段；不要把该端口暴露到公网。
后续如需恢复门户认证：去掉 compose 中 `DISABLE_PORTAL_AUTH`，并在 `frontend/nginx.conf`
把 `/api/auth/` 改回门户服务地址。
