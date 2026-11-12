"""统一配置：``configs/config.yml`` → 类型化 ``Settings``。

只有一条链路：**读 YAML → 归一化 → 冻结的 dataclass**。没有模块级可变 dict，
读一个值就是读一个 dataclass 字段。

配置文件分四块（详见 ``configs/config.example.yml`` 顶部说明）::

    common             三个模块共用：app / database / redis / llm / qa_service / intent_router
    knowledge_qa       知识问答       ← 本进程不读
    data_self_service  数据自服务     ← 本进程不读（指标解读的 MR / 工参源在 order_loop 里单独配）
    order_loop         工单自闭环     ← 本模块的全部专属配置

约定
----
- **数据库**只有一份 ``common.database``；**ICOS 出站**只有一条真实链路，由
  ``order_loop.icos.analyze`` 给出 ``url`` / ``token``，**不按环境名分块，也没有
  dry_run/mock 开关**——本地和生产的唯一差异是这个 URL 指向哪：本地指向
  ``icos-simulator``，生产指向真实 ICOS。
- **LLM** 的 ``api_key`` / ``base_url`` / ``model`` 三个字段各自独立回落：
  ``order_loop.llm`` → ``common.llm``。详见 :func:`_llm_settings`。
- 环境变量的优先级一律高于配置文件，用于部署期临时覆盖。
- 存量的旧扁平 schema（``rds_db_config`` / ``llm_config`` / ``order_backend`` /
  ``external_services``）由 :func:`normalize_config` 就地升级并告警，见该函数说明。

用法
----
- 进程内取值：:func:`get_settings`，首次调用读盘并缓存。
- 测试注入：:func:`override_settings`（上下文管理器，退出即还原）或 :func:`set_settings`。
- 配置文件改动后要生效需重启进程，或显式调 :func:`reload_settings`。
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Iterator, Sequence

import yaml
from sqlalchemy import URL

from services.common.logging import get_logger

logger = get_logger(__name__)

# network-ops-loop-v3/services/common/config.py → 仓库根
PROJECT_ROOT = Path(__file__).resolve().parents[3]
MODULE_ROOT = Path(__file__).resolve().parents[2]

_TRUTHY = frozenset({"1", "true", "yes", "y", "on"})
_FALSEY = frozenset({"0", "false", "no", "n", "off", ""})


# --------------------------------------------------------------------------- #
# 取值助手
# --------------------------------------------------------------------------- #
def _as_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in _TRUTHY:
        return True
    if text in _FALSEY:
        return False
    return default


def _as_int(value: Any, default: int) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return default


def _as_float(value: Any, default: float) -> float:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return default


def _as_text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _env(*names: str) -> str | None:
    """按顺序返回第一个非空环境变量。"""
    for name in names:
        raw = os.environ.get(name)
        if raw is not None and str(raw).strip():
            return str(raw).strip()
    return None


def _section(cfg: dict[str, Any], key: str) -> dict[str, Any]:
    value = cfg.get(key) if isinstance(cfg, dict) else None
    return value if isinstance(value, dict) else {}


def _nested(cfg: dict[str, Any], *path: str) -> dict[str, Any]:
    """按路径逐层取子段，任一层缺失即返回空 dict。"""
    node: dict[str, Any] = cfg if isinstance(cfg, dict) else {}
    for key in path:
        node = _section(node, key)
    return node


def normalize_base_path(value: Any) -> str:
    """把 ``common.app.base_path`` 归一化成 ``""`` 或 ``"/前缀"``。

    配置里怎么写都接受（``wnoa`` / ``/wnoa`` / ``/wnoa/`` / ``//wnoa//``），统一产出
    **有前导斜杠、无尾斜杠**的形式，这样拼接时 ``f"{base}/api/health"`` 永远只有一个斜杠。
    留空或只写斜杠都视为「不加前缀」，返回 ``""`` —— FastAPI 的 ``root_path`` 和
    Flask 的 ``url_prefix`` 都要求空前缀必须是空串，不能是 ``"/"``。

    这份规则是两个后端（本模块与 network-qa-assistant）+ 前端 + nginx 的共同约定，
    改动要同步 frontend/src/api/base.ts 与 frontend/scripts/generate_runtime_config.py
    里的同名实现（那两处跑在浏览器/启动脚本里，无法 import 这里）。
    icos-simulator 不参与：它是纯本地联调件、不上生产，始终只监听原始路径。
    """
    text = str(value or "").strip()
    if not text:
        return ""
    return "/" + text.strip("/") if text.strip("/") else ""


# --------------------------------------------------------------------------- #
# 分段配置
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class DatabaseSettings:
    host: str = "127.0.0.1"
    port: int = 5432
    user: str = "postgres"
    password: str = ""
    database: str = "postgres"
    schema: str = "public"
    # 全进程共用一个 Engine，所有 worker 线程从这一个池子取连接——
    # 调大 worker 数时要同步看这里，池子打满会让线程排队等连接。
    pool_size: int = 5
    max_overflow: int = 10
    pool_recycle_seconds: int = 1800
    pool_pre_ping: bool = True
    statement_timeout_ms: int = 0

    @property
    def url(self) -> URL:
        """SQLAlchemy 连接 URL。

        **必须用 URL.create 而不是拼字符串**：口令里的 ``@`` / ``#`` / ``/`` / ``?``
        在 URL 里都是保留字符，拼进去会被解析器当分隔符。实测口令
        ``Znf#SYP@2AH5B&Q`` 拼串后，解析器按**第一个** ``@`` 断开，host 变成
        ``2AH5B&Q@host.docker.internal``、口令被截成 ``Znf#SYP``，最终报
        "could not translate host name"。URL.create 走的是结构化入参，
        由 SQLAlchemy 自己转义，不存在这个问题。
        """
        return URL.create(
            "postgresql+psycopg2",
            username=self.user,
            password=self.password,
            host=self.host,
            port=self.port,
            database=self.database,
        )

    @property
    def safe_url(self) -> str:
        """脱敏后的连接串，用于日志。"""
        return f"postgresql://{self.user}@{self.host}:{self.port}/{self.database}"


@dataclass(frozen=True)
class LLMSettings:
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    timeout_seconds: float = 60.0
    max_tokens: int = 4096
    temperature: float = 0.2
    top_p: float = 0.8
    enable_thinking: bool = False
    #: 是否校验上游 TLS 证书。内网模型网关（省侧 MaaS、自建 vLLM）多用自签证书，
    #: 开着校验会让 OpenAI SDK 抛 SSLError，日志里表现为**快速失败**的
    #: 「LLM 请求失败: Connection error.」——与网络不通长得一模一样，极易误判成
    #: 防火墙/路由问题。自签网关必须置 false（与 qa-backend 的 LLM_SSL_VERIFY 同义）。
    ssl_verify: bool = True
    #: 平台静态请求头（网关鉴权/路由用，含 identity-info 这类身份标识头），见
    #: configs/config.example.yml 的 common.llm.headers 说明。值里的 ``${api_key}``
    #: 占位符已在加载期替换为 api_key；值为空的键在加载期已被过滤，不会出现在这里。
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def enabled(self) -> bool:
        return bool(self.api_key and self.base_url and self.model)


@dataclass(frozen=True)
class IcosSettings:
    """ICOS 出站：唯一一条真实链路（analyzeResultReception）+ 推送节奏。"""

    analyze_url: str = ""
    analyze_token: str = ""
    request_timeout_seconds: float = 20.0
    max_push_retry_times: int = 5


@dataclass(frozen=True)
class CaseLibrarySettings:
    """决策案例知识库（配置段 ``order_loop.case_library``，方案 2b′，2026-09-27 起）。

    决策时对本单每条候选参数找**同类案例**（同参数 + 同二级原因 + 同问题类型），算先例数、成败与常见调整幅度，
    定出「案例支撑度」（高 / 中 / 低 / 无先例），挂到决策轨迹与裁决对象上、写进正文引用；
    ``relevance_evidence`` 打开时还把它喂给 04 组内关联判定（会影响选中哪些方案）。

    支撑度**按规则算、不交给模型**：同样的案例集合永远得出同样的档位（裁决对象记下
    ``library_version``，事后可复核按哪一版案例库判的）。
    """

    #: 总开关，**默认关**。关着时流水线的「案例参考」一步记 skipped、不查库，
    #: 启动自检也不核对三张案例表 —— 省端升级镜像不会因为 DBA 还没跑新 DDL 就起不来。
    enabled: bool = False
    #: 把案例证据喂给 04 组内关联判定（业务 2026-09-27 选定）。**这会改变选中哪些方案**，
    #: 与 09-21「寻优不做评分排序」口径有出入；关掉即退回只注记（证据照挂、不进提示词）。
    relevance_evidence: bool = True
    #: 有效期（月）：早于它的案例不参与匹配。0 = 不限。
    validity_months: int = 12
    #: 档位门槛（按例数与成功比例；失败计入分母）。人工精选与自闭环案例一例计一例（2026-10-19 用户定；
    #: 原来的来源权重 ``curated_weight`` 已退役，配着只在启动时告警）。
    high_min_cases: float = 5.0
    high_min_ratio: float = 0.8
    mid_min_cases: float = 2.0
    mid_min_ratio: float = 0.5
    #: 每条动作最多引用几个案例（正文与界面都只列这么多）。
    max_refs: int = 3
    #: 词表与参数别名 YAML。留空用内置的 ``services/cases/assets/case_vocab.yaml``。
    vocab_path: str = ""
    #: 案例建议步数的上限（≥ 1）。案例建议步数**没有开关**（2026-10-09 用户定：步数判定一定要参考案例），
    #: 案例库开着（``enabled``）就算、**影响下发**：07 对区间类参数，在同类成功案例支撑度为「高」、常见幅度与
    #: ICOS 建议都 ≥ 2 步时，按 min(案例步数, ICOS 建议步数, 本上限, 取值约束内可走步数) 下发，不再一律压成一步；
    #: 多轮决策缩步长时按同类成功幅度缩、同类以恶化为主直接回退（见 ``services.decision.case_steps``）。
    #: 案例库关着就没有证据可参考，07 照旧一步。
    step_advice_max_steps: int = 3
    #: 自闭环案例**自动入库**（2026-10-18 用户定：智能体闭环成功、最终评估改善的工单自动进案例库，单轮多轮都收；
    #: 只有人工精选的历史工单手动导入）。单独一个开关、**默认关**：自动入库没有人工过目，模拟器 / 造数工单也会进库，
    #: 测试环境可以只读案例不写。总开关 ``enabled`` 关着时它不起作用。口径见 ``services.cases.harvest``。
    auto_harvest_enabled: bool = False
    #: 自动入库的扫描间隔（秒，下限 30）。
    auto_harvest_interval_seconds: float = 300.0


@dataclass(frozen=True)
class ComplianceSettings:
    """参数规则库与数值一步策略的设置（配置段 ``order_loop.compliance``，段名沿用）。

    2026-09-25 合规链（逐条问模型）删除后，这一段只剩决策步 07 读规则库要用的几项；
    原来的 ``prompt_path`` / ``llm_timeout_seconds`` / ``parse_*`` / ``trace_*`` 随合规链一起没了，
    配置里还留着的话启动时告警一条（见 :func:`_warn_obsolete_keys`）。
    """

    rule_csv_path: str = ""
    type2_fallback_path: str = ""
    #: 2026-09-30 起**不再生效**：新规则表 ``sys_cell_execute_jiangsu.csv`` 的 ``rule_scope``
    #: 全部显式带符号，方向恒按符号走（见 :mod:`services.compliance.rule_constraint`）。
    #: 字段保留只为让现场存量配置照常解析，不用改配置文件。
    enforce_step_direction: bool = True

    def resolved_rule_csv(self) -> Path:
        if self.rule_csv_path:
            return Path(self.rule_csv_path)
        return MODULE_ROOT / "services" / "compliance" / "assets" / "sys_cell_execute_jiangsu.csv"

    def resolved_type2_fallback(self) -> Path:
        if self.type2_fallback_path:
            return Path(self.type2_fallback_path)
        return self.resolved_rule_csv().parent / "rule_type2_fallback.yaml"



@dataclass(frozen=True)
class DecisionSettings:
    """决策侧的设置：整单复核（``services/decision/order_review.py``）与 02 根因置信度阈值。

    整单复核补的是「这个参数跟这张工单有没有关系」和「这批一起发出去的动作彼此冲不冲突」
    —— 立项时合规链逐条初案跑、没有整单视角，这两件全系统没人回答。

    整单复核（决策流水线「06 方案一致性」）**恒做、恒按 demote 剔除**（2026-10-03 业务：方案一致性影响下发，
    是决策链固定的一步，同 04 / 05 不配开关）：判「指标存疑」的参数、批内「方向冲突 / 功能互斥」的冲突各方不发，
    复核失败或没判到的照发。原来的总开关 ``enabled``、观察档 ``mode: annotate``、外部提示词 ``prompt_path``
    已退役（配着只告警）。代价：每单多一次整单调用（p50 约 15s，上限 ``llm_timeout_seconds × parse_max_attempts``）。
    下面这几项只管**怎么调**模型。
    """

    #: 02 根因收敛的置信度阈值（0–100，``order_loop.decision.root_cause.confidence_threshold``，
    #: 默认 40；2026-09-24 业务定 60，2026-09-27 业务改为 40）。模型从 conclusion / smart_conclusion 收敛出的每条根因带一个
    #: 0–100 的置信度，**只有达到阈值的根因才作为 04 组内寻优的依据**；全部低于阈值 = 根因不明，
    #: 04 不窄化（组内全留）。展示层据它把根因分成主因 / 次因 / 低置信。
    root_cause_confidence_threshold: int = 40
    #: 整单复核单次调用的超时与解析重试（提示词比 02 / 04 / 05 大，单独调）。
    llm_timeout_seconds: float = 120.0
    parse_max_attempts: int = 2
    parse_retry_wait_seconds: float = 0.0
    #: 送进提示词的动作条数上限。超出的不进提示词，但**仍然参与计数** ——
    #: 与 plan_table / root_cause 两张表的截断同规矩。
    max_actions: int = 30


@dataclass(frozen=True)
class WorkerSettings:
    """后台线程编排：决策 / ICOS 推送 / 快照刷新 / 正文叙述各类 worker 的数量与节奏。

    整单复核不再单起线程（2026-09-23 并进决策的同步路径），``review_*`` 两个键已删。
    """

    decision_worker_count: int = 1
    decision_idle_seconds: float = 10.0
    decision_gap_seconds: float = 3.0
    push_worker_count: int = 2
    push_idle_seconds: float = 5.0
    push_backoff_seconds: float = 30.0
    snapshot_worker_count: int = 1
    snapshot_poll_seconds: float = 1.0
    #: 方案决策正文的叙述线程（``NarrationWorker``）：裁决落库后异步写 11 节正文的解释。
    #: 领活有行级租约（advisory lock 罩住整次写作），多开是安全的；每线程一次写一轮，
    #: 一轮是 10 次链式模型调用、一到几分钟。
    narrative_worker_count: int = 1
    narrative_poll_seconds: float = 5.0
    #: 一轮叙述最多领几次。全部小节都没写成（模型整段不可用）才算一次失败并重试，
    #: 用尽即置 failed —— 展示层按确定性兜底出正文，不会一直显示「生成中」。
    narrative_max_attempts: int = 3
    # 重推理轮次上限不在这里：2026-09-25 起与短评估状态机共用 Settings.short_assess_max_rounds。
    shutdown_grace_seconds: float = 10.0
    enabled: bool = True


@dataclass(frozen=True)
class FrontendViewSettings:
    enabled: bool = True
    # 对应 order_loop.frontend_view.llm_enabled；
    # 注意环境变量那一路叫 FRONTEND_VIEW_ENABLE_LLM（见 frontend_view 的 _llm_enabled）
    llm_enabled: bool = True
    # 快照文案的 max_tokens 统一取 common.llm.max_tokens，这里不再单列 ——
    # 早先有个 snapshot_llm_max_tokens，但全项目没有读取方，属于空挂配置，已删。
    # 0 = 继承 common.llm.timeout_seconds
    llm_timeout_seconds: float = 0.0
    # 「方案自动决策」正文按 11 个小标题分 8 次链式调用生成（6 级 DAG），这两个预算
    # **只管 solution_generation 阶段**，其余三个阶段仍走上面的 llm_timeout_seconds。
    #
    # 为什么必须单列：整篇长文改成链式后，若沿用 llm_timeout_seconds(360s)，最坏
    # 6 级 × 360s = 2160s，会超过 outbox_stale_seconds 被判定认领方已死、收回重派，
    # 于是重复烧一遍 token。单步收到 90s、整阶段封顶 600s 才能稳定落在回收窗口内。
    # 0 = 回落到 llm_timeout_seconds。
    solution_step_timeout_seconds: float = 90.0
    # 阶段总预算。累计耗时越过它之后，**剩余小节不再调模型**，直接按节兜底。
    # 已完成的小节照常保留 —— 降级是按节的，不整篇作废。
    solution_total_budget_seconds: float = 600.0
    # （曾有 outbox_batch_size「单轮最多取多少条」：快照 outbox 按租约一次只领一条，
    # 它从来没有读取方，2026-09-28 删除；配置里留着不报错、不生效。）
    outbox_max_attempts: int = 3
    # processing 状态超过这么多秒仍未 complete/fail，视为认领方已死（进程重启/崩溃），
    # 由 SnapshotWorker 回收重新入队。要盖过一次刷新的最坏耗时（含 LLM 重试），
    # 定太短会把仍在正常处理的行错误抢回来，制造双重处理。
    outbox_stale_seconds: int = 600
    #: 大屏批量导出（入参 / 结果）一次最多几张工单，**只管取库模式**（回传模式另有上限，
    #: 见 ``services.exports.service.MAX_PAYLOAD_EXPORT_ORDERS``）。导出按 500 张一块取数、
    #: 流式写 xlsx，内存不随张数涨（5000 张实测峰值增量约 90MB、耗时约 7s）。
    #: 默认 3000 是业务 2026-09-30 定的，现场按需在配置里调。
    export_max_orders: int = 3000
    #: 大屏首页「实时工单流转」自动刷新（2026-10-09 业务定**默认关**）。打开后停在首页时每隔
    #: ``big_screen_auto_refresh_seconds`` 秒重拉一次列表，打开推演舱 / 根因图谱、页面切到后台时暂停。
    #: 随 ``/api/big-screen/data`` 的 ``meta.autoRefresh`` 下发给前端：改完重启 order 后端即可，前端镜像不用动。
    big_screen_auto_refresh_enabled: bool = False
    #: 间隔秒数，下限 :data:`BIG_SCREEN_AUTO_REFRESH_MIN_SECONDS`（配得再小也按它）。
    big_screen_auto_refresh_seconds: int = 120


#: 大屏自动刷新间隔的下限：配成个位数秒会让每块大屏把后端当成轮询目标。
BIG_SCREEN_AUTO_REFRESH_MIN_SECONDS = 30


#: 请求体上限的默认值（MB），配置键 ``order_loop.server.max_content_length_mb``。
DEFAULT_MAX_CONTENT_LENGTH_MB = 30


@dataclass(frozen=True)
class KpiGpSettings:
    """网管指标源（GP icos_dev），只读，独立 Engine。

    连接五项（host / port / user / password / database）已按 host 是否填写解析好，
    见 :func:`_kpi_gp_settings`。
    """

    host: str = ""
    port: int = 15433
    user: str = ""
    password: str = ""
    database: str = "icos"
    schema: str = "icos_dev"
    connect_timeout: int = 5
    statement_timeout_ms: int = 30000
    pool_size: int = 3
    #: True = gp.host 留空，连接五项整套取自 ``wide``（网管表与 MR / 工参同库，按 schema 区分）。
    same_as_wide: bool = False

    @property
    def configured(self) -> bool:
        return bool(self.host and self.user and self.database)

    @property
    def url(self) -> URL:
        return URL.create(
            "postgresql+psycopg2",
            username=self.user,
            password=self.password,
            host=self.host,
            port=self.port,
            database=self.database,
        )

    @property
    def safe_url(self) -> str:
        return f"postgresql://{self.user}@{self.host}:{self.port}/{self.database}"


@dataclass(frozen=True)
class KpiWideSettings:
    """MR / 工参源（宽表库），只读，独立 Engine。

    连接只认 ``order_loop.kpi_interpretation.wide`` 自己这一段，不读 ``data_self_service.pg``、
    不回落到 ``common.database``：与问答侧各配各的，换一边的库不牵动另一边。
    MR / 工参的 schema 不在这里配，写在 ``kpi_interpretation/assets/mr_*.yaml`` /
    ``engineer_*.yaml``（``mrodata`` / ``baseinfo``）。
    """

    host: str = ""
    port: int = 5432
    user: str = ""
    password: str = ""
    database: str = ""
    connect_timeout: int = 2
    statement_timeout_ms: int = 0
    pool_size: int = 2

    @property
    def configured(self) -> bool:
        # database 也要填：留空时 psycopg2 会去连与用户名同名的库，报错看不出是漏配。
        return bool(self.host and self.user and self.database)

    @property
    def url(self) -> URL:
        return URL.create(
            "postgresql+psycopg2",
            username=self.user,
            password=self.password,
            host=self.host,
            port=self.port,
            database=self.database,
        )

    @property
    def safe_url(self) -> str:
        return f"postgresql://{self.user}@{self.host}:{self.port}/{self.database}"


@dataclass(frozen=True)
class StoreTableSettings:
    """一类数据（网管指标 / MR / 工参）的转存表。每行都带 ``taskno``。"""

    enabled: bool = True
    table_4g: str = ""
    table_5g: str = ""
    #: 只有网管指标用：GP 字典表的快照（不分工单）。
    dictionary_table: str = ""


@dataclass(frozen=True)
class KpiStoreSettings:
    """转存目标：只存工单涉及的小区，按工单拉取。

    ``database`` 已按 host 是否填写解析好，见 :func:`_kpi_store_settings`。
    """

    enabled: bool = False
    #: True = host 留空，与工单表同库（直接用 common.database）。
    same_as_app_db: bool = True
    database: DatabaseSettings = field(default_factory=DatabaseSettings)
    #: 每张工单每一路一行（来源、表、窗口、行数、状态、拉取时间），按 taskno 查这一张就知道存了什么。
    pull_log_table: str = "order_data_pull"
    #: 一张工单的数据按工单整体删除，三类同一个保留期。
    retention_days: int = 180
    kpi: StoreTableSettings = field(
        default_factory=lambda: StoreTableSettings(
            table_4g="order_kpi_4g", table_5g="order_kpi_5g", dictionary_table="kpi_dictionary"
        )
    )
    mr: StoreTableSettings = field(
        default_factory=lambda: StoreTableSettings(table_4g="order_mr_4g", table_5g="order_mr_5g")
    )
    engineer: StoreTableSettings = field(
        default_factory=lambda: StoreTableSettings(
            table_4g="order_engineer_4g", table_5g="order_engineer_5g"
        )
    )
    #: 解读结果：一张工单一行（text、fallback_used、劣化段与划分方式）。
    result_enabled: bool = True
    result_table: str = "order_kpi_interpretation"
    #: facts.detail 逐行落表：一个参数一行。网管日粒度 / MR / 工参同表，用 section 区分；
    #: 网管小时粒度单独一张（detail_hour_table）。
    detail_table: str = "order_kpi_detail"
    detail_hour_table: str = "order_kpi_detail_hour"
    #: 门限严重程度：每张工单、每条门限一行（基线期 / 问题期的级别、时点数、最差值、结论）。
    severity_table: str = "order_kpi_severity"


@dataclass(frozen=True)
class KpiInterpretationSettings:
    enabled: bool = False
    baseline_days: int = 7
    llm_timeout_seconds: float = 120.0
    #: 劣化段对比基线段，两道门槛同时满足才标「明显」：变化幅度 ≥ change_ratio_gate，
    #: 且劣化段均值落在基线均值 ± change_std_gate 倍标准差之外。
    change_ratio_gate: float = 0.2
    change_std_gate: float = 2.0
    #: 决策流水线「01 指标取数」整步的时间预算（秒）：超了这一步记失败、决策照常往下走；0 = 不设预算。
    decision_fetch_timeout_seconds: float = 60.0
    gp: KpiGpSettings = field(default_factory=KpiGpSettings)
    wide: KpiWideSettings = field(default_factory=KpiWideSettings)
    store: KpiStoreSettings = field(default_factory=KpiStoreSettings)


@dataclass(frozen=True)
class ServerSettings:
    host: str = "0.0.0.0"
    port: int = 5004
    #: 请求体上限（字节），超过的请求在进路由前就回 413（见 ``http.register_request_hooks``）。
    #: 2026-10-22 之前写死 20MB、配置里没有键，现场 ICOS 一批 ``base_info_extract`` 超了只能改代码。
    max_content_length: int = DEFAULT_MAX_CONTENT_LENGTH_MB * 1024 * 1024


@dataclass(frozen=True)
class Settings:
    timezone: str = "Asia/Shanghai"
    #: 全站路径前缀，已归一化为 "" 或 "/前缀"；作为 FastAPI root_path 生效。
    base_path: str = ""
    log_level: str = "INFO"
    log_dir: str = ""
    server: ServerSettings = field(default_factory=ServerSettings)
    database: DatabaseSettings = field(default_factory=DatabaseSettings)
    llm: LLMSettings = field(default_factory=LLMSettings)
    icos: IcosSettings = field(default_factory=IcosSettings)
    case_library: CaseLibrarySettings = field(default_factory=CaseLibrarySettings)
    compliance: ComplianceSettings = field(default_factory=ComplianceSettings)
    decision: DecisionSettings = field(default_factory=DecisionSettings)
    workers: WorkerSettings = field(default_factory=WorkerSettings)
    frontend_view: FrontendViewSettings = field(default_factory=FrontendViewSettings)
    kpi_interpretation: KpiInterpretationSettings = field(
        default_factory=KpiInterpretationSettings
    )
    # 短评估模块的对外开放开关，与前端 SHORT_EVALUATION_ENABLED 呼应。
    # 注意：这不是「mock/真实短评估」的模式开关（那类字段已被 c07b149 移除，
    # 见 test_settings_has_no_short_eval_field），只管 short_assess_result_extract
    # 是否受理，不改变四分支状态机或落库逻辑。
    short_assess_enabled: bool = True
    # 多轮决策（短评估判恶化 → 重推理）最多几轮，第 1 轮是首轮决策。两处读它：短评估状态机
    # （第 N 轮恶化且 N >= 上限 → 回退后转人工）与决策线程（领到的轮次等于上限 → 写回退轮）。
    # 2026-09-25 之前是两套：状态机按 ICOS 的 short_assess_count >= 2 写死、决策线程读
    # workers.max_process_retry_times（3），后者永远到不了。默认 3（业务 2026-09-25 定：
    # 第 1 轮 ICOS 初案、第 2 轮缩步长、第 3 轮反向或回退）。
    short_assess_max_rounds: int = 3
    config_path: str = ""

    def with_overrides(self, **kwargs: Any) -> "Settings":
        return replace(self, **kwargs)


# --------------------------------------------------------------------------- #
# 加载
# --------------------------------------------------------------------------- #
#: 配置文件基名的可选后缀。K8s ConfigMap 的 key 决定挂载后的文件名，各平台生成
#: ``config.yml`` 或 ``config.yaml`` 的都有，两种都认，免得为一个后缀改代码。
#: **顺序即优先级**：同目录下两份都在时取 ``.yml``（与仓库内既有约定一致）。
_CONFIG_BASENAMES = ("config.yml", "config.yaml")


def _config_names_in(directory: Path) -> list[Path]:
    """目录下两种后缀的候选，按 _CONFIG_BASENAMES 的顺序。"""
    return [directory / name for name in _CONFIG_BASENAMES]


def config_candidates() -> list[Path]:
    paths: list[Path] = []
    env_path = _env("ORDER_LOOP_CONFIG_YAML", "APP_CONFIG_YAML", "UNIFIED_CONFIG_YAML")
    if env_path:
        # 环境变量给的是**完整路径**，后缀照单全收（部署方显式指路，不替它猜）。
        # 但部署现场常见「env 写 .yml、平台实际生成 .yaml」的错配，此时再按同目录
        # 的另一个后缀兜一把 —— 否则整份配置静默丢失：analyze_url 变空串，
        # 启动直接撞 validate_runtime_settings，报错却只提示去配 ICOS_ANALYZE_URL。
        explicit = Path(env_path).expanduser()
        paths.append(explicit)
        if explicit.name in _CONFIG_BASENAMES:
            paths.extend(p for p in _config_names_in(explicit.parent) if p != explicit)
    for directory in (
        PROJECT_ROOT / "configs",
        MODULE_ROOT / "configs",
        Path("configs"),
    ):
        paths.extend(_config_names_in(directory))
    return paths


def find_config_path() -> Path | None:
    for path in config_candidates():
        if path.is_file():
            return path
    return None


def load_raw_config() -> tuple[dict[str, Any], str]:
    path = find_config_path()
    if path is None:
        return {}, ""
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    return (data if isinstance(data, dict) else {}), str(path)


# --------------------------------------------------------------------------- #
# 旧 schema 兼容
#
# configs/config.yml 不入库，各部署机上都是自己那一份，所以改 schema 不能指望
# 「所有人都同步换文件」。这里把旧扁平结构（rds_db_config / llm_config /
# order_backend / external_services）就地升级成四段式，并告警提示迁移。
# 各环境的 config.yml 都换成新结构后，这一段连同 _LEGACY_* 表可以整体删掉。
# --------------------------------------------------------------------------- #

#: 旧 order_backend 的全大写键 → (order_loop 下的分组, 新键)
_LEGACY_ORDER_KEYS: dict[str, tuple[str, str]] = {
    "API_TIMEOUT_VALUE": ("icos", "request_timeout_seconds"),
    "ICOS_PUSH_MAX_RETRY_TIMES": ("icos", "max_push_retry_times"),
    "RULE_LIBRARY_SC_CSV": ("compliance", "rule_csv_path"),
    "RULE_TYPE2_FALLBACK_YAML": ("compliance", "type2_fallback_path"),
    "PLAN_COMPLIANCE_PROMPT": ("compliance", "prompt_path"),
    "RULE_COMPLIANCE_LLM_TIMEOUT_SEC": ("compliance", "llm_timeout_seconds"),
    "RULE_COMPLIANCE_LLM_PARSE_MAX_ATTEMPTS": ("compliance", "parse_max_attempts"),
    "RULE_COMPLIANCE_LLM_PARSE_RETRY_WAIT_SEC": ("compliance", "parse_retry_wait_seconds"),
    "WORKERS_ENABLED": ("workers", "enabled"),
    "DECISION_WORKER_COUNT": ("workers", "decision_worker_count"),
    "DECISION_POLL_INTERVAL_SECONDS": ("workers", "decision_poll_interval_seconds"),
    "DECISION_GAP_SECONDS": ("workers", "decision_gap_seconds"),
    "ICOS_PUSH_WORKER_COUNT": ("workers", "push_worker_count"),
    "PUSH_PENDING_POLL_INTERVAL_SECONDS": ("workers", "push_poll_interval_seconds"),
    "PUSH_FAILURE_BACKOFF_SECONDS": ("workers", "push_failure_backoff_seconds"),
    "FRONTEND_SNAPSHOT_WORKER_COUNT": ("workers", "snapshot_worker_count"),
    "SNAPSHOT_REFRESH_QUEUE_TIMEOUT_SECONDS": ("workers", "snapshot_queue_timeout_seconds"),
    "MAX_PROCESS_RETRY_TIMES": ("workers", "max_process_retry_times"),
    "WORKER_SHUTDOWN_GRACE_SECONDS": ("workers", "shutdown_grace_seconds"),
    "FRONTEND_VIEW_ENABLED": ("frontend_view", "enabled"),
    "FRONTEND_VIEW_LLM_ENABLED": ("frontend_view", "llm_enabled"),
    "SNAPSHOT_OUTBOX_MAX_ATTEMPTS": ("frontend_view", "outbox_max_attempts"),
    "SNAPSHOT_OUTBOX_STALE_SECONDS": ("frontend_view", "outbox_stale_seconds"),
    "HOST": ("server", "host"),
    "PORT": ("server", "port"),
}

#: 旧 external_services 通道名 → order_loop.icos 下的通道名
_LEGACY_ENDPOINT_NAMES = {
    "icos_tools_platform_url": "analyze",
}

#: 存量配置文件把端点塞在这个子块里，只作兼容读取，新配置一律写在通道下。
_LEGACY_ENDPOINT_BLOCK = "LOCAL"

_LEGACY_TOP_KEYS = ("rds_db_config", "llm_config", "order_backend", "external_services")

#: 新 schema 的判别键。**不能拿 data_self_service 当判据** —— 新旧两套里它都在顶层。
_NEW_TOP_KEYS = ("common", "knowledge_qa", "order_loop")


def _legacy_endpoint(external: dict[str, Any], legacy_name: str) -> dict[str, str]:
    """取一条 ICOS 出站通道的 URL / TOKEN（含 LOCAL 子块兼容）。

    **只有一套 ICOS，因此不按环境名分块**。别把「按 env 名取同名子块」的写法加回来：
    那样一填没建对应块的名字，就会**同时**把 URL 读成空串、又把 dry_run 关掉，
    于是每单推送必失败、重试到顶后转 LinkFailed —— 比不改还糟。
    """
    block = _section(external, legacy_name)
    url, token = _as_text(block.get("URL")), _as_text(block.get("TOKEN"))
    if url or token:
        return {"url": url, "token": token}

    legacy = _section(block, _LEGACY_ENDPOINT_BLOCK)
    legacy_url, legacy_token = _as_text(legacy.get("URL")), _as_text(legacy.get("TOKEN"))
    if legacy_url or legacy_token:
        logger.warning(
            "external_services.%s 仍把 URL/TOKEN 写在 %s 子块里；新结构请写成 "
            "order_loop.icos.%s.url / .token。本次已按兼容路径读取",
            legacy_name,
            _LEGACY_ENDPOINT_BLOCK,
            _LEGACY_ENDPOINT_NAMES[legacy_name],
        )
    return {"url": legacy_url, "token": legacy_token}


def _upgrade_legacy(raw: dict[str, Any]) -> dict[str, Any]:
    """旧扁平 schema → 四段式。只搬键、不改值（CURRENT_DEBUG_ENV 除外）。"""
    order_cfg = _section(raw, "order_backend")
    external = _section(raw, "external_services") or _section(order_cfg, "external_services")

    order_loop: dict[str, Any] = {}
    if "llm" in order_cfg:
        order_loop["llm"] = order_cfg["llm"]
    for legacy_key, (group, new_key) in _LEGACY_ORDER_KEYS.items():
        if legacy_key in order_cfg:
            order_loop.setdefault(group, {})[new_key] = order_cfg[legacy_key]

    for legacy_name, new_name in _LEGACY_ENDPOINT_NAMES.items():
        endpoint = _legacy_endpoint(external, legacy_name)
        if endpoint["url"] or endpoint["token"]:
            order_loop.setdefault("icos", {})[new_name] = endpoint

    app_cfg = dict(_section(raw, "app"))
    # 旧 order_backend.LOG_LEVEL / LOG_DIR 会永远压过 app 段，是个改上面那份不生效
    # 的坑。新 schema 取消这两个键，统一收敛到 common.app（环境变量仍可覆盖）。
    for legacy_key, app_key in (("LOG_LEVEL", "log_level"), ("LOG_DIR", "log_dir")):
        if _as_text(order_cfg.get(legacy_key)):
            app_cfg[app_key] = order_cfg[legacy_key]

    return {
        "common": {
            "app": app_cfg,
            "database": _section(raw, "rds_db_config"),
            "llm": _section(raw, "llm_config"),
        },
        "order_loop": order_loop,
    }


def normalize_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    """把任意版本的配置内容归一化成四段式 schema。"""
    if not isinstance(raw, dict):
        return {}
    if any(isinstance(raw.get(key), dict) for key in _NEW_TOP_KEYS):
        stale = [key for key in _LEGACY_TOP_KEYS if key in raw]
        if stale:
            logger.warning(
                "配置文件同时存在新四段式与旧顶层段 %s；旧段已被忽略，请删除以免改了不生效",
                "/".join(stale),
            )
        return raw
    if any(key in raw for key in _LEGACY_TOP_KEYS):
        logger.warning(
            "配置文件仍是旧结构（顶层 %s），本次已在内存中升级为 common/order_loop 四段式。"
            "请按 configs/config.example.yml 迁移。",
            "/".join(key for key in _LEGACY_TOP_KEYS if key in raw),
        )
    return _upgrade_legacy(raw)


def _database_settings(cfg: dict[str, Any]) -> DatabaseSettings:
    db = _nested(cfg, "common", "database")
    return DatabaseSettings(
        host=_env("ORDER_DB_HOST", "PGHOST") or _as_text(db.get("host"), "127.0.0.1"),
        port=_as_int(_env("ORDER_DB_PORT", "PGPORT") or db.get("port"), 5432),
        user=_env("ORDER_DB_USER", "PGUSER") or _as_text(db.get("user"), "postgres"),
        password=_env("ORDER_DB_PASSWORD", "PGPASSWORD") or _as_text(db.get("password")),
        database=_env("ORDER_DB_NAME", "PGDATABASE")
        or _as_text(db.get("database") or db.get("name"), "postgres"),
        schema=_as_text(db.get("schema"), "public"),
        pool_size=_as_int(_env("ORDER_DB_POOL_SIZE") or db.get("pool_size"), 5),
        max_overflow=_as_int(_env("ORDER_DB_MAX_OVERFLOW") or db.get("max_overflow"), 10),
        pool_recycle_seconds=_as_int(db.get("pool_recycle_seconds"), 1800),
        pool_pre_ping=_as_bool(db.get("pool_pre_ping"), True),
        statement_timeout_ms=_as_int(db.get("statement_timeout_ms"), 0),
    )


def _llm_headers(order_llm: dict[str, Any], llm_cfg: dict[str, Any], api_key: str) -> dict[str, str]:
    """取平台静态请求头：``order_loop.llm.headers`` 整段覆盖 ``common.llm.headers``。

    与 base_url/model/api_key 不同，这里**不做键级合并**——网关一换，整套头往往一起换，
    半张 common 的头半张 order_loop 的头拼在一起更容易配错。要复用 common 的头就别在
    order_loop.llm 下写 headers 键。

    值里的 ``${api_key}`` 占位符替换成 api_key（Azure OpenAI 等 ``api-key`` 头要用）。

    **某个键要不要发送，只看这个键的值是否非空**——不再有单独的 auth/enabled 开关：
    值留空（或不写这个键）就是不发送该头，例如 identity-info 不需要时直接留
    ``identity-info: ""``，要用时再填值，不需要额外的 enabled 开关配合。
    """
    raw_headers = order_llm.get("headers") if isinstance(order_llm.get("headers"), dict) else None
    if raw_headers is None:
        raw_headers = llm_cfg.get("headers") if isinstance(llm_cfg.get("headers"), dict) else {}
    result: dict[str, str] = {}
    for key, value in raw_headers.items():
        text_key = _as_text(key)
        text_value = _as_text(value).replace("${api_key}", api_key)
        if text_key and text_value:
            result[text_key] = text_value
    return result


def _llm_settings(cfg: dict[str, Any]) -> LLMSettings:
    """工单后端的 LLM 取值：**只认 configs/config.yml**，没有环境变量覆盖。

    ``order_loop.llm.{api_key,base_url,model,max_tokens,headers}`` → 同名
    ``common.llm`` 字段，各自独立回落：只填 ``order_loop.llm.model``，其余仍走
    ``common.llm``，不需要把整组配置抄一遍。``headers`` 是整段回落，不是逐键合并，
    见 :func:`_llm_headers`。

    ``max_tokens`` 单独开了覆盖通道（其余调用参数仍只认 ``common.llm``）：工单后端的调用
    （02 根因收敛、04 关联判定、整单复核、叙述）各有自己的超时预算，而索要长 JSON 的提示词
    会让模型写到 max_tokens 上限才停（finish_reason=length）。按实测约 100 tok/s，
    ``common.llm`` 面向其他模块给的大上限会让单次生成远超预算、每单超时走 bypass
    （当年的合规链就是这样静默失效的）。工单后端因此要能独立收紧上限，而不必压低其他模块的额度。

    这里刻意不加 ``_env()``：LLM 的接入信息只有配置文件一个来源，
    排查「模型怎么连错了」时不必再去翻容器环境变量。
    """
    llm_cfg = _nested(cfg, "common", "llm")
    order_llm = _nested(cfg, "order_loop", "llm")

    base_url = _as_text(order_llm.get("base_url")) or _as_text(llm_cfg.get("base_url"))
    model = (
        _as_text(order_llm.get("model") or order_llm.get("model_name"))
        or _as_text(llm_cfg.get("model") or llm_cfg.get("model_name"))
    )
    api_key = _as_text(order_llm.get("api_key")) or _as_text(llm_cfg.get("api_key"))
    return LLMSettings(
        api_key=api_key,
        base_url=base_url,
        model=model,
        timeout_seconds=_as_float(llm_cfg.get("timeout_seconds"), 60.0),
        max_tokens=_as_int(
            order_llm.get("max_tokens")
            if _as_text(order_llm.get("max_tokens"))
            else llm_cfg.get("max_tokens"),
            4096,
        ),
        temperature=_as_float(llm_cfg.get("temperature"), 0.2),
        top_p=_as_float(llm_cfg.get("top_p"), 0.8),
        enable_thinking=_as_bool(llm_cfg.get("enable_thinking"), False),
        # ssl_verify 跟 base_url 走：换端点往往同时换证书信任级别（公网可信 →
        # 内网自签），所以它必须能随 order_loop.llm.base_url 一起覆盖，否则
        # 工单后端指到自签网关时只能连带把其他模块的校验也关掉。
        ssl_verify=_as_bool(
            order_llm.get("ssl_verify")
            if _as_text(order_llm.get("ssl_verify"))
            else llm_cfg.get("ssl_verify"),
            True,
        ),
        headers=_llm_headers(order_llm, llm_cfg, api_key),
    )


def _icos_settings(cfg: dict[str, Any]) -> IcosSettings:
    """ICOS 出站：唯一一条真实链路的地址。

    **只有一套 ICOS，因此不按环境名分块**：``order_loop.icos.analyze`` 段下直接写
    ``url`` / ``token``。别把「按 env 名取同名子块」的写法加回来：那样一填没建对应块
    的名字，就会把 URL 读成空串，于是每单推送必失败、重试到顶后转 LinkFailed ——
    比不改还糟。本地和生产的唯一差异是这个 URL 指向哪（本地指向 icos-simulator，
    生产指向真实 ICOS），没有 dry_run/mock 开关。
    """
    icos_cfg = _nested(cfg, "order_loop", "icos")
    analyze = _section(icos_cfg, "analyze")

    return IcosSettings(
        analyze_url=_env("ICOS_ANALYZE_URL") or _as_text(analyze.get("url")),
        analyze_token=_env("ICOS_ANALYZE_TOKEN") or _as_text(analyze.get("token")),
        request_timeout_seconds=_as_float(icos_cfg.get("request_timeout_seconds"), 20.0),
        max_push_retry_times=_as_int(icos_cfg.get("max_push_retry_times"), 5),
    )


def _case_library_settings(cfg: dict[str, Any]) -> CaseLibrarySettings:
    """``order_loop.case_library`` 段。**默认关**，不配这一段一切照旧。环境变量 CASE_LIBRARY_ENABLED 可覆盖开关。"""
    section = _nested(cfg, "order_loop", "case_library")
    if section.get("curated_weight") is not None:
        logger.warning(
            "order_loop.case_library.curated_weight 已废弃并被忽略：2026-10-19 起人工精选与自闭环案例一例计一例，不再按来源加权",
        )
    enabled_env = _env("CASE_LIBRARY_ENABLED")
    defaults = CaseLibrarySettings()
    return CaseLibrarySettings(
        enabled=(
            _as_bool(enabled_env, False) if enabled_env else _as_bool(section.get("enabled"), False)
        ),
        relevance_evidence=_as_bool(section.get("relevance_evidence"), defaults.relevance_evidence),
        validity_months=max(0, _as_int(section.get("validity_months"), defaults.validity_months)),
        high_min_cases=_as_float(section.get("high_min_cases"), defaults.high_min_cases),
        high_min_ratio=_as_float(section.get("high_min_ratio"), defaults.high_min_ratio),
        mid_min_cases=_as_float(section.get("mid_min_cases"), defaults.mid_min_cases),
        mid_min_ratio=_as_float(section.get("mid_min_ratio"), defaults.mid_min_ratio),
        max_refs=max(1, _as_int(section.get("max_refs"), defaults.max_refs)),
        vocab_path=_as_text(section.get("vocab_path")),
        step_advice_max_steps=max(1, _as_int(section.get("step_advice_max_steps"), defaults.step_advice_max_steps)),
        auto_harvest_enabled=_as_bool(section.get("auto_harvest_enabled"), defaults.auto_harvest_enabled),
        auto_harvest_interval_seconds=max(
            30.0, _as_float(section.get("auto_harvest_interval_seconds"), defaults.auto_harvest_interval_seconds)
        ),
    )


#: 随合规链（逐条问模型）2026-09-25 删除的配置键：配着不报错，启动时各告警一句。
_OBSOLETE_COMPLIANCE_KEYS = (
    "prompt_path",
    "llm_timeout_seconds",
    "parse_max_attempts",
    "parse_retry_wait_seconds",
    "trace_enabled",
    "trace_max_chars",
    "trace_record_max_chars",
    "trace_record_total_chars",
)
#: 同上，``order_loop.decision`` 下的：P6 双跑的开关档与合规链退役开关、判死跳过合规链的开关。
_OBSOLETE_DECISION_KEYS = ("new_chain", "plan_feasibility_skip")


def _warn_obsolete_keys(section: dict[str, Any], keys: Sequence[str], prefix: str) -> None:
    """合规链删除后留在配置里的键：不报错、不生效，逐个提醒一句。

    与 ``order_review.async`` 同规矩 —— 以为自己还开着合规链 / 还在 shadow 档的现场，
    要能从启动日志里知道这些键已经不起作用了。
    """
    for key in keys:
        if section.get(key) is not None:
            logger.warning(
                f"{prefix}.{key} 已废弃并被忽略：合规链 2026-09-25 已删除，参数下发只由决策链裁决",
            )


def _compliance_settings(cfg: dict[str, Any]) -> ComplianceSettings:
    rules = _nested(cfg, "order_loop", "compliance")
    _warn_obsolete_keys(rules, _OBSOLETE_COMPLIANCE_KEYS, "order_loop.compliance")
    return ComplianceSettings(
        rule_csv_path=_env("RULE_LIBRARY_SC_CSV") or _as_text(rules.get("rule_csv_path")),
        type2_fallback_path=_as_text(rules.get("type2_fallback_path")),
        enforce_step_direction=_as_bool(
            _env("COMPLIANCE_ENFORCE_STEP_DIRECTION") or rules.get("enforce_step_direction"),
            True,
        ),
    )


#: ``order_loop.decision.order_review`` 下已退役的键（2026-10-03 业务：06 方案一致性影响下发，恒做、恒按 demote 剔除）：
#: 总开关、只注记的观察档、外部提示词覆盖。配着不报错、不生效，启动时告警一次。
_OBSOLETE_ORDER_REVIEW_KEYS = ("enabled", "mode", "prompt_path")


def _root_cause_confidence_threshold(cfg: dict[str, Any]) -> int:
    """02 根因收敛置信度阈值，夹到 0–100。取不到数按默认 40（与 :attr:`DecisionSettings.root_cause_confidence_threshold` 同值）。"""
    section = _nested(cfg, "order_loop", "decision", "root_cause")
    raw = _env("DECISION_ROOT_CAUSE_CONFIDENCE_THRESHOLD") or section.get("confidence_threshold")
    value = _as_int(raw, DecisionSettings.root_cause_confidence_threshold)
    if not 0 <= value <= 100:
        logger.warning(
            "decision.root_cause.confidence_threshold 超出 0–100，已夹到边界",
            extra={"value": value},
        )
    return min(100, max(0, value))


def _short_assess_max_rounds(raw: Any) -> int:
    """多轮决策轮次上限。小于 1 没有意义（连首轮都不许跑），夹到 1 并告警。"""
    value = _as_int(raw, 3)
    if value < 1:
        logger.warning("short_assess_max_rounds 小于 1，已按 1 处理（首轮恶化即转人工）", extra={"value": value})
    return max(1, value)


def _decision_settings(cfg: dict[str, Any]) -> DecisionSettings:
    review = _nested(cfg, "order_loop", "decision", "order_review")
    if review.get("async") is not None:
        # 2026-09-23 复核并进决策的同步路径，独立线程与这个开关一并删除。配着它不报错，
        # 只提醒一句：以为自己还在"异步、不占决策时延"的现场，会被 PushPending 推迟吓一跳。
        logger.warning(
            "order_review.async 已废弃并被忽略：整单复核现在随决策同步执行（开关 enabled 仍然有效）",
        )
    retired = [f"order_review.{key}" for key in _OBSOLETE_ORDER_REVIEW_KEYS if review.get(key) is not None]
    if _env("ORDER_REVIEW_ENABLED"):
        retired.append("环境变量 ORDER_REVIEW_ENABLED")
    if retired:
        # 以为自己关着复核、或还在只注记的观察档的现场，要能从启动日志里知道它已经恒做、恒剔了。
        logger.warning(
            f"{'、'.join(retired)} 已废弃并被忽略：06 方案一致性 2026-10-03 起恒做、恒按 demote 剔除"
            "（指标存疑 / 冲突各方不发），不再有开关、观察档与外部提示词",
        )
    _warn_obsolete_keys(_nested(cfg, "order_loop", "decision"), _OBSOLETE_DECISION_KEYS, "order_loop.decision")
    return DecisionSettings(
        root_cause_confidence_threshold=_root_cause_confidence_threshold(cfg),
        llm_timeout_seconds=_as_float(review.get("llm_timeout_seconds"), 120.0),
        parse_max_attempts=max(1, _as_int(review.get("parse_max_attempts"), 2)),
        parse_retry_wait_seconds=max(0.0, _as_float(review.get("parse_retry_wait_seconds"), 0.0)),
        max_actions=max(1, _as_int(review.get("max_actions"), 30)),
    )


def _worker_settings(cfg: dict[str, Any]) -> WorkerSettings:
    workers = _nested(cfg, "order_loop", "workers")
    if workers.get("max_process_retry_times") is not None:
        # 配着它不报错，只提醒一句：以为自己把重推理放宽到了 3 轮的现场，实际一直只有 2 轮。
        logger.warning(
            "workers.max_process_retry_times 已废弃并被忽略：重推理轮次上限改由 "
            "order_loop.short_assess_max_rounds 统一控制（默认 3）",
            extra={"value": workers.get("max_process_retry_times")},
        )
    return WorkerSettings(
        decision_worker_count=max(1, _as_int(workers.get("decision_worker_count"), 1)),
        decision_idle_seconds=_as_float(workers.get("decision_poll_interval_seconds"), 10.0),
        decision_gap_seconds=_as_float(workers.get("decision_gap_seconds"), 3.0),
        push_worker_count=max(1, _as_int(workers.get("push_worker_count"), 2)),
        push_idle_seconds=_as_float(workers.get("push_poll_interval_seconds"), 5.0),
        push_backoff_seconds=_as_float(workers.get("push_failure_backoff_seconds"), 30.0),
        snapshot_worker_count=max(1, _as_int(workers.get("snapshot_worker_count"), 1)),
        snapshot_poll_seconds=_as_float(workers.get("snapshot_queue_timeout_seconds"), 1.0),
        narrative_worker_count=max(1, _as_int(workers.get("narrative_worker_count"), 1)),
        narrative_poll_seconds=_as_float(workers.get("narrative_poll_interval_seconds"), 5.0),
        narrative_max_attempts=max(1, _as_int(workers.get("narrative_max_attempts"), 3)),
        shutdown_grace_seconds=_as_float(workers.get("shutdown_grace_seconds"), 10.0),
        enabled=_as_bool(_env("ORDER_LOOP_WORKERS_ENABLED") or workers.get("enabled"), True),
    )


def _warn_obsolete_knowledge(cfg: dict[str, Any]) -> None:
    """文档知识通道（order → qa 的 RAG 检索，方案 P2-2b）2026-09-27 删除后留在配置 / 环境里的开关：
    不报错、不生效，提醒一句（同合规链删除的做法）。

    删的理由：决策用的知识一律在 order 服务内部构建、不调 qa（2026-09-27 定）；知识库初期以案例知识库
    （``order_loop.case_library``）为主。它原先只给 06 整单复核查手册，把规则库无匹配的动作从
    「LLM原理补充」升到「知识库依据」—— 删掉后证据分级回到两档。
    """
    if _nested(cfg, "order_loop", "knowledge") or _env("KNOWLEDGE_ENABLED") or _env("KNOWLEDGE_SEARCH_URL"):
        logger.warning(
            "order_loop.knowledge 已废弃并被忽略：文档知识通道（order → qa 检索）2026-09-27 已删除，"
            "决策只用 order 服务内部的案例知识库（order_loop.case_library）"
        )


def _warn_obsolete_big_screen(order_cfg: dict[str, Any]) -> None:
    """大屏 2026-09-26 起直接读快照表、不再落 JSON 文件：留着的文件路径配置不报错，提醒一句。"""
    if _env("BIG_SCREEN_DATA_JSON") or _as_text(_section(order_cfg, "big_screen").get("data_json")):
        logger.warning(
            "order_loop.big_screen.data_json / BIG_SCREEN_DATA_JSON 已废弃并被忽略："
            "大屏每次直接读快照表，不再落 JSON 文件",
        )
def _kpi_store_settings(store: dict[str, Any], app_db: DatabaseSettings) -> KpiStoreSettings:
    """转存库连接：host 留空就整套用 common.database，填了就只认 store 段。

    不逐项回落：只填 host 而把口令留空时，若拿 common.database 的口令去连另一台库，
    报错会是认证失败，看不出是配置漏填。
    """
    host = _as_text(store.get("host"))
    schema = _as_text(store.get("schema")) or app_db.schema
    if not host:
        database = replace(app_db, schema=schema)
    else:
        database = DatabaseSettings(
            host=host,
            port=_as_int(store.get("port"), 5432),
            user=_as_text(store.get("user")),
            password=_env("KPI_STORE_PASSWORD") or _as_text(store.get("password")),
            database=_as_text(store.get("database"), "postgres"),
            schema=schema,
            pool_size=app_db.pool_size,
            max_overflow=app_db.max_overflow,
            pool_recycle_seconds=app_db.pool_recycle_seconds,
            pool_pre_ping=app_db.pool_pre_ping,
            statement_timeout_ms=app_db.statement_timeout_ms,
        )
    defaults = KpiStoreSettings()
    result = _section(store, "result")
    return KpiStoreSettings(
        result_enabled=_as_bool(result.get("enabled"), defaults.result_enabled),
        result_table=_as_text(result.get("table"), defaults.result_table),
        detail_table=_as_text(result.get("detail_table"), defaults.detail_table),
        detail_hour_table=_as_text(result.get("detail_hour_table"), defaults.detail_hour_table),
        severity_table=_as_text(result.get("severity_table"), defaults.severity_table),
        enabled=_as_bool(store.get("enabled"), False),
        same_as_app_db=not host,
        database=database,
        pull_log_table=_as_text(store.get("pull_log_table"), defaults.pull_log_table),
        retention_days=max(1, _as_int(store.get("retention_days"), defaults.retention_days)),
        kpi=_store_table_settings(_section(store, "kpi"), defaults.kpi),
        mr=_store_table_settings(_section(store, "mr"), defaults.mr),
        engineer=_store_table_settings(_section(store, "engineer"), defaults.engineer),
    )


def _store_table_settings(block: dict[str, Any], default: StoreTableSettings) -> StoreTableSettings:
    return StoreTableSettings(
        enabled=_as_bool(block.get("enabled"), default.enabled),
        table_4g=_as_text(block.get("table_4g"), default.table_4g),
        table_5g=_as_text(block.get("table_5g"), default.table_5g),
        dictionary_table=_as_text(block.get("dictionary_table"), default.dictionary_table),
    )


def _kpi_wide_settings(wide: dict[str, Any]) -> KpiWideSettings:
    """宽表库连接只认 ``wide`` 这一段，不逐项回落到别处（同 GP 源）。

    口令可由环境变量 ``KPI_WIDE_PASSWORD`` 覆盖。
    """
    return KpiWideSettings(
        host=_as_text(wide.get("host")),
        port=_as_int(wide.get("port"), 5432),
        user=_as_text(wide.get("user")),
        password=_env("KPI_WIDE_PASSWORD") or _as_text(wide.get("password")),
        database=_as_text(wide.get("database")),
        connect_timeout=max(1, _as_int(wide.get("connect_timeout"), 2)),
        statement_timeout_ms=max(0, _as_int(wide.get("statement_timeout_ms"), 0)),
        pool_size=max(1, _as_int(wide.get("pool_size"), 2)),
    )


def _kpi_gp_settings(gp: dict[str, Any], wide: KpiWideSettings) -> KpiGpSettings:
    """网管指标源：host 填了就只认 gp 段；留空就整套用 wide 的连接（同 store 段的写法）。

    整套取、不逐项回落：只填 host 而把口令留空时，若拿 wide 的口令去连另一台库，
    报错会是认证失败，看不出是配置漏填。schema、超时与连接池始终按 gp 段。
    """
    host = _as_text(gp.get("host"))
    if host:
        connection = {
            "host": host,
            "port": _as_int(gp.get("port"), 15433),
            "user": _as_text(gp.get("user")),
            "password": _env("KPI_GP_PASSWORD") or _as_text(gp.get("password")),
            "database": _as_text(gp.get("database"), "icos"),
        }
    else:
        connection = {
            "host": wide.host,
            "port": wide.port,
            "user": wide.user,
            "password": wide.password,
            "database": wide.database,
        }
    return KpiGpSettings(
        **connection,
        schema=_as_text(gp.get("schema"), "icos_dev"),
        connect_timeout=max(1, _as_int(gp.get("connect_timeout"), 5)),
        statement_timeout_ms=max(0, _as_int(gp.get("statement_timeout_ms"), 30000)),
        pool_size=max(1, _as_int(gp.get("pool_size"), 3)),
        same_as_wide=not host,
    )


def _kpi_interpretation_settings(
    cfg: dict[str, Any], app_db: DatabaseSettings
) -> KpiInterpretationSettings:
    kpi = _nested(cfg, "order_loop", "kpi_interpretation")
    wide = _kpi_wide_settings(_section(kpi, "wide"))
    return KpiInterpretationSettings(
        enabled=_as_bool(kpi.get("enabled"), False),
        baseline_days=max(1, _as_int(kpi.get("baseline_days"), 7)),
        llm_timeout_seconds=_as_float(kpi.get("llm_timeout_seconds"), 120.0),
        change_ratio_gate=max(0.0, _as_float(kpi.get("change_ratio_gate"), 0.2)),
        change_std_gate=max(0.0, _as_float(kpi.get("change_std_gate"), 2.0)),
        decision_fetch_timeout_seconds=max(0.0, _as_float(kpi.get("decision_fetch_timeout_seconds"), 60.0)),
        gp=_kpi_gp_settings(_section(kpi, "gp"), wide),
        wide=wide,
        store=_kpi_store_settings(_section(kpi, "store"), app_db),
    )


def build_settings(cfg: dict[str, Any], config_path: str = "") -> Settings:
    cfg = normalize_config(cfg)
    app_cfg = _nested(cfg, "common", "app")
    order_cfg = _section(cfg, "order_loop")
    server_cfg = _section(order_cfg, "server")
    view_cfg = _section(order_cfg, "frontend_view")
    _warn_obsolete_big_screen(order_cfg)
    _warn_obsolete_knowledge(cfg)
    database = _database_settings(cfg)
    return Settings(
        timezone=_as_text(app_cfg.get("timezone"), "Asia/Shanghai"),
        # 部署期可用 APP_BASE_PATH 临时覆盖（K8s 里直接由 ConfigMap 注入更顺手）。
        base_path=normalize_base_path(_env("APP_BASE_PATH") or app_cfg.get("base_path")),
        # 日志级别只有 common.app.log_level 一处可配（环境变量仍可临时覆盖）。
        # 旧 order_backend.LOG_LEVEL 会永远压过 app 段，已在归一化时并入 app。
        log_level=_env("LOG_LEVEL") or _as_text(app_cfg.get("log_level"), "INFO"),
        log_dir=_env("LOG_DIR") or _as_text(app_cfg.get("log_dir")),
        server=ServerSettings(
            host=_env("ORDER_LOOP_HOST") or _as_text(server_cfg.get("host"), "0.0.0.0"),
            port=_as_int(_env("ORDER_LOOP_PORT") or server_cfg.get("port"), 5004),
            # 不许配成 0 关掉：上限是挡超大请求把进程内存撑爆的唯一一道。
            max_content_length=max(
                1, _as_int(server_cfg.get("max_content_length_mb"), DEFAULT_MAX_CONTENT_LENGTH_MB)
            ) * 1024 * 1024,
        ),
        database=database,
        llm=_llm_settings(cfg),
        icos=_icos_settings(cfg),
        case_library=_case_library_settings(cfg),
        compliance=_compliance_settings(cfg),
        decision=_decision_settings(cfg),
        workers=_worker_settings(cfg),
        frontend_view=FrontendViewSettings(
            enabled=_as_bool(view_cfg.get("enabled"), True),
            llm_enabled=_as_bool(view_cfg.get("llm_enabled"), True),
            llm_timeout_seconds=_as_float(view_cfg.get("llm_timeout_seconds"), 0.0),
            solution_step_timeout_seconds=_as_float(
                view_cfg.get("solution_step_timeout_seconds"), 90.0
            ),
            solution_total_budget_seconds=_as_float(
                view_cfg.get("solution_total_budget_seconds"), 600.0
            ),
            outbox_max_attempts=_as_int(view_cfg.get("outbox_max_attempts"), 3),
            outbox_stale_seconds=_as_int(view_cfg.get("outbox_stale_seconds"), 600),
            export_max_orders=max(1, _as_int(view_cfg.get("export_max_orders"), 3000)),
            big_screen_auto_refresh_enabled=_as_bool(view_cfg.get("big_screen_auto_refresh_enabled"), False),
            big_screen_auto_refresh_seconds=max(
                BIG_SCREEN_AUTO_REFRESH_MIN_SECONDS,
                _as_int(view_cfg.get("big_screen_auto_refresh_seconds"), 120),
            ),
        ),
        kpi_interpretation=_kpi_interpretation_settings(cfg, database),
        short_assess_enabled=_as_bool(
            _env("ORDER_LOOP_SHORT_ASSESS_ENABLED") or order_cfg.get("short_assess_enabled"), True
        ),
        short_assess_max_rounds=_short_assess_max_rounds(
            _env("ORDER_LOOP_SHORT_ASSESS_MAX_ROUNDS") or order_cfg.get("short_assess_max_rounds")
        ),
        config_path=config_path,
    )


def validate_runtime_settings(settings: Settings, *, start_workers: bool) -> None:
    """启动前置校验：worker 要跑起来就必须有 ICOS analyze URL 可推。"""
    if start_workers and settings.workers.enabled and not settings.icos.analyze_url:
        raise RuntimeError(
            "ORDER_LOOP_WORKERS_ENABLED=true 时必须配置 ICOS analyze URL；"
            "本地请使用 ICOS_ANALYZE_URL 指向 icos-simulator"
        )


_settings: Settings | None = None


def get_settings() -> Settings:
    """进程内单例。首次调用时读盘。"""
    global _settings
    if _settings is None:
        raw, path = load_raw_config()
        _settings = build_settings(raw, path)
    return _settings


def reload_settings() -> Settings:
    """强制重新读盘（配置变更后调用；正常流程不需要）。"""
    global _settings
    _settings = None
    return get_settings()


def set_settings(settings: Settings) -> None:
    """直接注入（测试 / 嵌入式使用）。"""
    global _settings
    _settings = settings


@contextmanager
def override_settings(**kwargs: Any) -> Iterator[Settings]:
    """临时覆盖设置，退出时还原。测试里用它注入配置，不必去改全局状态。"""
    global _settings
    previous = _settings
    base = get_settings()
    try:
        _settings = replace(base, **kwargs)
        yield _settings
    finally:
        _settings = previous


__all__ = [
    "CaseLibrarySettings",
    "ComplianceSettings",
    "DatabaseSettings",
    "FrontendViewSettings",
    "IcosSettings",
    "LLMSettings",
    "MODULE_ROOT",
    "PROJECT_ROOT",
    "ServerSettings",
    "normalize_base_path",
    "Settings",
    "WorkerSettings",
    "build_settings",
    "get_settings",
    "load_raw_config",
    "normalize_config",
    "override_settings",
    "reload_settings",
    "set_settings",
    "validate_runtime_settings",
]
