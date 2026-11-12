"""CAS 认证服务（本项目内置的独立统一认证中心）。

独立 CAS 前后端系统，只负责「认证」，不承载任何门户/业务页面。
门户网站（homepage + portal-auth）与各业务系统是 CAS 的 client(service)，
登录成功后由 CAS 302 回跳 service 即可回到门户或业务系统。

实现 CAS 2.0 协议核心行为：
  1. GET  /cas/login?service=...               展示登录表单（未登录）或免密放行（已登录）
  2. POST /cas/login                           校验账号，发 ticket，302 回跳 service?ticket=ST-xxx
  3. GET  /cas/serviceValidate?service=&ticket= 返回 CAS XML 认证结果，供 client 校验
  4. GET  /cas/logout?service=...               登出，清除 SSO 会话并回跳 service

协议约定（client 须遵守）：
  - service 参数不得含转义/查询符号
  - 登录传给 CAS 的 service 与校验时的 service 必须严格一致
"""

import logging
import os
import threading
import time
import uuid
import xml.sax.saxutils as saxutils

from dotenv import load_dotenv
from flask import Flask, redirect, render_template_string, request, session

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("cas-server")

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "cas-server-secret-change-me")

CAS_NAMESPACE = "http://www.yale.edu/tp/cas"

# ---------------- 内存中「已发放的 ticket」 ----------------
_tickets: dict = {}
_tickets_lock = threading.Lock()

# ---------------- 用户库 ----------------
# 生产应替换为真实账号数据源（LDAP/数据库等）；这里用环境变量读取的开发账号。
SIMULATED_USERS = {
    "wangqiyue": {
        "password": os.environ.get("WANGQIYUE_PASSWORD", "Wqy@2026#Secure!Cas"),
        "uid": "wangqiyue",
    },
    "zhangsan": {
        "password": os.environ.get("ZHANGSAN_PASSWORD", "Zs@2026#Secure!Cas"),
        "uid": "zhangsan",
    },
}

CAS_PREFIX = "/cas"
CAS_LOGIN_PATH = f"{CAS_PREFIX}/login"
CAS_VALIDATE_PATH = f"{CAS_PREFIX}/serviceValidate"
CAS_LOGOUT_PATH = f"{CAS_PREFIX}/logout"

# CAS 独立登录页（认证前端）：仅负责账号密码认证，登录成功后回跳 service。
LOGIN_TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>统一认证登录</title>
  <style>
    body { font-family: -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
           background: #f0f2f5; display:flex; align-items:center; justify-content:center;
           height:100vh; margin:0; }
    .card { background:#fff; border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,.12);
            padding:40px 44px; width:360px; }
    h2 { margin:0 0 6px; font-size:20px; }
    .sub { color:#888; font-size:13px; margin-bottom:24px; }
    label { display:block; font-size:13px; color:#333; margin:14px 0 6px; }
    input { width:100%; box-sizing:border-box; padding:10px 12px; border:1px solid #dcdfe6;
            border-radius:6px; font-size:14px; }
    input:focus { outline:none; border-color:#4c6ef5; }
    button { width:100%; margin-top:24px; padding:11px; background:#4c6ef5; color:#fff;
             border:none; border-radius:6px; font-size:15px; cursor:pointer; }
    button:hover { background:#3b5bdb; }
    .err { color:#e03131; background:#fff5f5; border:1px solid #ffc9c9; border-radius:6px;
           padding:8px 10px; font-size:13px; margin-bottom:8px; }
    .tip { margin-top:16px; font-size:12px; color:#aaa; }
  </style>
</head>
<body>
  <form class="card" method="post" action="{{ action }}">
    <h2>统一认证登录</h2>
    <div class="sub">CAS 统一认证中心</div>
    {% if error %}<div class="err">{{ error }}</div>{% endif %}
    <input type="hidden" name="service" value="{{ service }}">
    <label for="username">用户名</label>
    <input id="username" name="username" autocomplete="username" autofocus required>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">登 录</button>
    <div class="tip">开发账号：wangqiyue / Wqy@2026#Secure!Cas</div>
  </form>
</body>
</html>
"""


def _issue_ticket(service: str) -> str:
    """发放一次性 ST 票据，并记录其绑定的 service。"""
    ticket = "ST-" + uuid.uuid4().hex
    with _tickets_lock:
        _tickets[ticket] = {"service": service, "created": time.time()}
    return ticket


def _consume_ticket(ticket: str) -> dict:
    """校验并取回 ticket（成功才删除，保证一次性使用）。"""
    with _tickets_lock:
        rec = _tickets.get(ticket)
        if not rec:
            return {"ok": False, "reason": "ticket 无效或已使用"}
        if time.time() - rec["created"] > 30:
            _tickets.pop(ticket, None)
            return {"ok": False, "reason": "ticket 已过期"}
        _tickets.pop(ticket, None)
        return {"ok": True, "service": rec["service"]}


@app.get(CAS_LOGIN_PATH)
def login_get():
    service = request.args.get("service", "")
    if not service:
        return "缺少 service 参数", 400
    # 已在单点（CAS）登录过：免密直接发放 ticket 回跳，不再展示登录页
    if session.get("cas_user"):
        ticket = _issue_ticket(service)
        redirect_to = f"{service}?ticket={ticket}"
        logger.info("CAS 已登录，免密放行 %s -> %s", session["cas_user"], redirect_to)
        return redirect(redirect_to, 302)
    return render_template_string(LOGIN_TEMPLATE, action=CAS_LOGIN_PATH, service=service, error=None)


@app.post(CAS_LOGIN_PATH)
def login_post():
    form = request.form
    service = form.get("service", "")
    username = (form.get("username") or "").strip()
    password = form.get("password") or ""

    if not service:
        return "缺少 service 参数", 400

    user = SIMULATED_USERS.get(username)
    if not user or user["password"] != password:
        return render_template_string(
            LOGIN_TEMPLATE, action=CAS_LOGIN_PATH, service=service, error="用户名或密码错误"
        ), 401

    # 登录成功：建立 SSO 会话（TGT），下次免密；302 回跳 service（门户/业务系统）
    session["cas_user"] = user["uid"]
    ticket = _issue_ticket(service)
    redirect_to = f"{service}?ticket={ticket}"
    logger.info("CAS 登录成功 username=%s -> 回跳 %s", username, redirect_to)
    return redirect(redirect_to, 302)


@app.get(CAS_VALIDATE_PATH)
def service_validate():
    service = request.args.get("service", "")
    ticket = request.args.get("ticket", "")

    # 先做协议外观校验（与真实 CAS 行为一致）
    if not service or not ticket:
        xml = _failure("INVALID_REQUEST", "Illegal parameter")
        return app.response_class(xml, mimetype="text/xml")
    if "?" in service.rstrip("/") or "#" in service or service.count("?") > 0:
        xml = _failure("INVALID_REQUEST", "service 参数不规范")
        return app.response_class(xml, mimetype="text/xml")

    rec = _consume_ticket(ticket)
    if not rec["ok"]:
        return app.response_class(
            _failure("INVALID_TICKET", rec["reason"]), mimetype="text/xml"
        )
    if rec["service"] != service:
        return app.response_class(
            _failure("INVALID_SERVICE", "service 与 ticket 不匹配，必须严格一致"),
            mimetype="text/xml",
        )

    user = SIMULATED_USERS["wangqiyue"]
    xml = (
        '<cas:serviceResponse xmlns:cas="%s">'
        "<cas:authenticationSuccess>"
        "<cas:user>%s</cas:user>"
        "<cas:attributes>"
        "<cas:uid>%s</cas:uid>"
        "<cas:displayName>%s</cas:displayName>"
        "</cas:attributes>"
        "</cas:authenticationSuccess>"
        "</cas:serviceResponse>" % (CAS_NAMESPACE, saxutils.escape(user["uid"]),
                                    saxutils.escape(user["uid"]), "测试用户")
    )
    logger.info("serviceValidate 成功 service=%s", service)
    return app.response_class(xml, mimetype="text/xml")


@app.get(CAS_LOGOUT_PATH)
def logout():
    """CAS 登出：清除 SSO 会话，按需回跳 service（如门户登出页）。"""
    session.pop("cas_user", None)
    service = request.args.get("service", "")
    if service:
        return redirect(service, 302)
    return redirect(f"{CAS_PREFIX}/login", 302)


def _failure(code: str, message: str) -> str:
    return (
        '<cas:serviceResponse xmlns:cas="%s">'
        '<cas:authenticationFailure code="%s">%s</cas:authenticationFailure>'
        "</cas:serviceResponse>"
        % (CAS_NAMESPACE, saxutils.escape(code), saxutils.escape(message))
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "9000"))
    print(f"CAS Server 启动: http://127.0.0.1:{port}{CAS_PREFIX}/login")
    app.run(host="0.0.0.0", port=port, debug=False)
