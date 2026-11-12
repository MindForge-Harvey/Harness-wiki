"""统一日志：控制台可读 + 文件轮转 + 链路 ID 透传。

两点行为需要知道：

* **``extra`` 字段没有白名单**：record 上所有非标准属性都会被渲染出来，
  ``extra={"taskno": ...}`` 写什么就出现什么，不会被静默丢弃。
* **request_id / taskno 用 contextvars 透传**：HTTP 入口和 worker 线程各自绑定一次，
  之后同一条链路上的日志自动带上，不必每条手写。
"""
from __future__ import annotations

import logging
import os
import re
import sys
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone, tzinfo
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from typing import Any, Iterator
from contextlib import contextmanager

LOG_FORMAT = "%(asctime)s | %(levelname)-7s | %(name)s%(context)s | %(message)s%(extras)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# 按天轮转，保留 30 天；轮转文件名后缀见 TimedRotatingFileHandler 默认的 suffix。
_DEFAULT_BACKUP_COUNT = 30
_FALSEY = frozenset({"0", "false", "no", "off", ""})

# logging.LogRecord 的内建属性；渲染 extras 时要排除掉。
_RESERVED_ATTRS = frozenset(
    {
        "args", "asctime", "created", "exc_info", "exc_text", "filename", "funcName",
        "levelname", "levelno", "lineno", "message", "module", "msecs", "msg", "name",
        "pathname", "process", "processName", "relativeCreated", "stack_info",
        "thread", "threadName", "taskName", "context", "extras",
    }
)

_request_id_var: ContextVar[str | None] = ContextVar("ops_loop_request_id", default=None)
_taskno_var: ContextVar[str | None] = ContextVar("ops_loop_taskno", default=None)
_worker_var: ContextVar[str | None] = ContextVar("ops_loop_worker", default=None)

_configured = False


def set_log_context(
    *, request_id: str | None = None, taskno: str | None = None, worker: str | None = None
) -> None:
    if request_id is not None:
        _request_id_var.set(request_id)
    if taskno is not None:
        _taskno_var.set(taskno)
    if worker is not None:
        _worker_var.set(worker)


def clear_log_context() -> None:
    _request_id_var.set(None)
    _taskno_var.set(None)
    _worker_var.set(None)


@contextmanager
def log_context(**kwargs: str | None) -> Iterator[None]:
    """with 作用域内附加链路上下文，退出自动还原。"""
    tokens = []
    mapping = {"request_id": _request_id_var, "taskno": _taskno_var, "worker": _worker_var}
    for key, value in kwargs.items():
        var = mapping.get(key)
        if var is not None:
            tokens.append((var, var.set(value)))
    try:
        yield
    finally:
        for var, token in reversed(tokens):
            var.reset(token)


class _ContextFilter(logging.Filter):
    """把 contextvars 与 extra 字段渲染进 record。"""

    def filter(self, record: logging.LogRecord) -> bool:
        parts = []
        request_id = getattr(record, "request_id", None) or _request_id_var.get()
        taskno = getattr(record, "taskno", None) or getattr(record, "task_no", None) or _taskno_var.get()
        worker = getattr(record, "worker", None) or _worker_var.get()
        if request_id:
            parts.append(f"req={request_id}")
        if taskno:
            parts.append(f"taskno={taskno}")
        if worker:
            parts.append(f"w={worker}")
        record.context = (" [" + " ".join(parts) + "]") if parts else ""

        extras = {
            key: value
            for key, value in record.__dict__.items()
            if key not in _RESERVED_ATTRS
            and not key.startswith("_")
            and key not in ("request_id", "taskno", "task_no", "worker")
        }
        record.extras = (" " + _render_extras(extras)) if extras else ""
        return True


def _render_extras(extras: dict[str, Any]) -> str:
    chunks = []
    for key, value in extras.items():
        text = str(value)
        if len(text) > 500:
            text = text[:500] + "…"
        if any(ch in text for ch in " |="):
            text = f'"{text}"'
        chunks.append(f"{key}={text}")
    return "{" + " ".join(chunks) + "}"


_LOG_TZ_OFFSET_RE = re.compile(r"^([+-])(\d{1,2})(?::?(\d{2}))?$")


def _resolve_log_tz() -> tzinfo | None:
    value = (os.getenv("LOG_TZ") or "").strip()
    if not value:
        return None
    match = _LOG_TZ_OFFSET_RE.match(value)
    if match:
        sign = 1 if match.group(1) == "+" else -1
        hours = int(match.group(2))
        minutes = int(match.group(3) or 0)
        return timezone(sign * timedelta(hours=hours, minutes=minutes))
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(value)
    except Exception:  # noqa: BLE001 - tzdata 缺失时不应影响日志初始化
        return None


class _Formatter(logging.Formatter):
    def __init__(self, fmt: str, datefmt: str, tz: tzinfo | None = None) -> None:
        super().__init__(fmt=fmt, datefmt=datefmt)
        self._tz = tz

    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:  # noqa: N802
        if self._tz is None:
            return super().formatTime(record, datefmt)
        stamp = datetime.fromtimestamp(record.created, tz=self._tz)
        return stamp.strftime(datefmt or DATE_FORMAT)

    def format(self, record: logging.LogRecord) -> str:
        if not hasattr(record, "context"):
            record.context = ""
        if not hasattr(record, "extras"):
            record.extras = ""
        return super().format(record)


def _flag(name: str, default: bool = True) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in _FALSEY


def configure_logging(
    app_name: str = "ops-loop", level: str = "INFO", log_dir: str | None = None
) -> logging.Logger:
    """进程入口调用一次。重复调用是幂等的。"""
    global _configured
    root = logging.getLogger()
    if _configured:
        return root

    root.setLevel(getattr(logging, str(level).strip().upper(), logging.INFO))
    for handler in list(root.handlers):
        root.removeHandler(handler)

    formatter = _Formatter(LOG_FORMAT, DATE_FORMAT, tz=_resolve_log_tz())
    context_filter = _ContextFilter()

    if _flag("LOG_TO_STDOUT", True):
        stream = logging.StreamHandler(sys.stdout)
        stream.setFormatter(formatter)
        stream.addFilter(context_filter)
        root.addHandler(stream)

    if _flag("LOG_TO_FILE", True):
        directory = Path(log_dir or os.getenv("LOG_DIR") or (Path.cwd() / "logs"))
        try:
            directory.mkdir(parents=True, exist_ok=True)
            # 按天轮转（本地午夜切分，不随 LOG_TZ 改变——TimedRotatingFileHandler
            # 只认进程本地时间）；保留 30 天，超期自动删除。
            file_handler = TimedRotatingFileHandler(
                directory / f"{app_name}.log",
                when="midnight",
                backupCount=_DEFAULT_BACKUP_COUNT,
                encoding="utf-8",
            )
            file_handler.suffix = "%Y-%m-%d"
            file_handler.setFormatter(formatter)
            file_handler.addFilter(context_filter)
            root.addHandler(file_handler)
        except OSError as exc:  # 只读文件系统等场景：退化为仅 stdout，不阻塞启动
            root.warning("日志文件初始化失败，仅输出到 stdout: %s", exc)

    # SQLAlchemy 的 INFO 会把每条 SQL 都刷出来，这里压到 WARNING。
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    # uvicorn 的访问日志与本模块 _trace 中间件的「请求完成」重复，压到 WARNING。
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

    _configured = True
    return root


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


__all__ = [
    "clear_log_context",
    "configure_logging",
    "get_logger",
    "log_context",
    "set_log_context",
]
