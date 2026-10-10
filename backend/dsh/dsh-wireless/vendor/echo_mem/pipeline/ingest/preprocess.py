"""Ingest 前对 xlsx 字段做归一化（主要为「问题类型」/ primary_issue_type）。

业务口径（山西执行库）：
- 带后缀 ``_M`` 的标签与去掉 ``_M`` 后视为同一问题类型（如 ``切换差小区_M`` → ``切换差小区``）。
- 别名合并：
  - ``低接通`` / ``低接通小区`` → ``接通低小区``
  - ``高掉线`` / ``高掉线小区`` / ``掉线高小区_M`` → ``掉线高小区``

``省端问题类型`` 在归一化问题类型后保留末尾场景标签 ``{一般场景}`` / ``{VIP场景}`` 等。
"""

from __future__ import annotations

import math
import re
from typing import Any

import pandas as pd

# 精确别名 →  canonical
ISSUE_TYPE_ALIASES: dict[str, str] = {
    "低接通": "接通低小区",
    "低接通小区": "接通低小区",
    "高掉线": "掉线高小区",
    "高掉线小区": "掉线高小区",
}

SCENE_SUFFIX_RE = re.compile(r"(\{[^}]+\})$")


def _is_missing(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, float) and math.isnan(v):
        return True
    s = str(v).strip()
    return s == "" or s.lower() == "nan"


def _strip_m_suffix(label: str) -> str:
    if label.endswith("_M"):
        return label[:-2]
    return label


def normalize_issue_type(raw: Any) -> str | None:
    """归一化 Excel「问题类型」→ TraceRecord.ticket.primary_issue_type。"""
    if _is_missing(raw):
        return None
    label = _strip_m_suffix(str(raw).strip())
    return ISSUE_TYPE_ALIASES.get(label, label)


def canonical_issue_type(raw: Any, *, default: str = "未匹配类型") -> str:
    """读取 Trace / 编译时使用的标准问题类型（幂等）。"""
    return normalize_issue_type(raw) or default


def normalize_trace_record(trace: dict[str, Any]) -> dict[str, Any]:
    """对单条 TraceRecord 做读盘修正：问题类型归一化 + 按最新规则重算 aggregate。"""
    from ..common.ticket_aggregate import compute_ticket_aggregate

    out = dict(trace)
    ticket = trace.get("ticket")
    if isinstance(ticket, dict):
        issue_raw = ticket.get("primary_issue_type")
        province_raw = ticket.get("province_issue_type")
        issue = canonical_issue_type(issue_raw)
        province = normalize_province_issue_type(province_raw) if province_raw is not None else province_raw
        if issue != issue_raw or province != province_raw:
            out["ticket"] = {**ticket, "primary_issue_type": issue, "province_issue_type": province}
    actions = trace.get("actions")
    if isinstance(actions, list) and actions:
        out["aggregate"] = compute_ticket_aggregate(actions)
    return out


def normalize_province_issue_type(raw: Any) -> str | None:
    """归一化 Excel「省端问题类型」，保留末尾 ``{场景}`` 标签。"""
    if _is_missing(raw):
        return None
    text = str(raw).strip()
    match = SCENE_SUFFIX_RE.search(text)
    if match:
        base = text[: match.start()]
        scene = match.group(1)
        base_norm = normalize_issue_type(base)
        return f"{base_norm or base}{scene}"
    return normalize_issue_type(text)


def preprocess_action_dataframe(
    df: pd.DataFrame,
    *,
    report: bool = True,
) -> tuple[pd.DataFrame, dict[str, int]]:
    """归一化 canonical 列 ``primary_issue_type`` / ``province_issue_type``。

    Adapter 层已经把原始列名翻译成 canonical（snake_case），所以这里只认 canonical。
    """
    out = df.copy()
    stats: dict[str, int] = {}

    if "primary_issue_type" in out.columns:
        before = out["primary_issue_type"].astype(str)
        out["primary_issue_type"] = out["primary_issue_type"].map(
            lambda v: normalize_issue_type(v) if not _is_missing(v) else v
        )
        after = out["primary_issue_type"].astype(str)
        stats["primary_issue_type"] = int((before != after).sum())

    if "province_issue_type" in out.columns:
        before = out["province_issue_type"].astype(str)
        out["province_issue_type"] = out["province_issue_type"].map(
            lambda v: normalize_province_issue_type(v) if not _is_missing(v) else v
        )
        after = out["province_issue_type"].astype(str)
        stats["province_issue_type"] = int((before != after).sum())

    if report and stats:
        parts = ", ".join(f"{k}={v}" for k, v in stats.items() if v)
        if parts:
            print(f"[preprocess] normalized rows: {parts}", flush=True)

    return out, stats


def _self_check() -> None:
    assert normalize_issue_type("切换差小区_M") == "切换差小区"
    assert normalize_issue_type("切换差小区") == "切换差小区"
    assert normalize_issue_type("低接通") == "接通低小区"
    assert normalize_issue_type("低接通小区") == "接通低小区"
    assert normalize_issue_type("高掉线") == "掉线高小区"
    assert normalize_issue_type("掉线高小区_M") == "掉线高小区"
    assert (
        normalize_province_issue_type("接通低小区_M{VIP场景}")
        == "接通低小区{VIP场景}"
    )
    assert normalize_province_issue_type("低接通") == "接通低小区"
    print("[preprocess] self-check ok")


if __name__ == "__main__":
    _self_check()
