# cas-server — 项目内置独立 CAS 认证中心

本目录是一个**独立的前后端一体的 CAS 统一认证系统**，只负责「认证」，不承载任何门户或业务页面。
门户（homepage + portal-auth）和各业务系统是 CAS 的 client（service），
登录成功后由 CAS 302 回跳 service 即可回到门户或业务系统。

> 本服务从外部 mock-cas-server 项目收入本项目，删除了其自带的示例门户页面，
> 仅保留 CAS 协议核心，不再依赖任何外部项目。

## 职责边界

- **负责**：账号密码认证、发放/校验一次性 Service Ticket、维护单点登录会话（TGT）、单点登出。
- **不负责**：门户展示（由 `homepage` 承担）、门户会话（由 `portal-auth` 承担）。

## 认证流程

```text
浏览器
  -> 门户/业务系统 302 到 CAS /cas/login?service=<回跳地址>
  -> CAS 展示登录页（未登录）或免密放行（已登录 TGT）
  -> 用户提交账号密码
  -> CAS 校验通过，发放 ST-xxx 票据
  -> 302 回跳 service?ticket=ST-xxx
  -> 门户/业务系统拿 ticket 调 /cas/serviceValidate 校验（换取用户名/uid）
  -> 校验通过，建立各自登录态
```

## 协议端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/cas/login` | GET | 展示登录页；若已登录（TGT）则免密发放 ticket 回跳 service |
| `/cas/login` | POST | 校验账号密码，发放 ticket，302 回跳 `service?ticket=ST-xxx` |
| `/cas/serviceValidate` | GET | 校验 ticket，返回 CAS XML（含 user/uid/displayName） |
| `/cas/logout` | GET | 单点登出，清除 TGT，按需回跳 `service` |

## 本地启动

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/python app.py
```

默认监听 `http://127.0.0.1:9000/cas/login`，开发账号：`wangqiyue / Wqy@2026#Secure!Cas`。

## 配置

见 `.env.example`。生产环境至少需要设置 `SECRET_KEY`（强随机值，可用 `openssl rand -hex 32`），
并把 `SIMULATED_USERS` 替换为真实账号数据源（LDAP / 数据库等）。

## Docker

```bash
docker build -t cas-server:latest .
```

或通过根目录 `docker-compose.gateway.yml` 与 portal-auth、homepage 统一编排启动。

## 协议约定（client 须遵守）

- `service` 参数不得含转义/查询符号。
- 登录传给 CAS 的 `service` 与校验时的 `service` 必须严格一致。
- ticket 一次性使用，30 秒过期。
