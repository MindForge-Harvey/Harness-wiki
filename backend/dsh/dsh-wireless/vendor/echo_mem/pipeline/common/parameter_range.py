"""参数取值域解析与全量数据范围修复（effective / range_repair）。

厂商 Excel 常只给出半边界（如 ``<= -120``）。编译时用全量 trace 上同方案+参数的
before/after 数值 min/max 补缺失侧，生成 ``effective_parameter_range``，不覆盖原始
``parameter_range``。
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

REPAIR_INDEX_VERSION = 1


def slug(s: object) -> str:
    text = str(s or "unknown").strip().lower()
    text = re.sub(r"\s+", "_", text)
    text = re.sub(r"[^0-9a-zA-Z_\-\u4e00-\u9fff]+", "_", text)
    return text.strip("_") or "unknown"


def to_number(v: object) -> float | None:
    if v is None:
        return None
    text = str(v).strip()
    if not text or text.lower() in {"nan", "nat", "none", "null"}:
        return None
    if not re.fullmatch(r"[+-]?\d+(?:\.\d+)?", text):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_parameter_range(value_rule: object) -> dict | None:
    """Parse vendor scheme_desc / value_rule into explicit or partial range."""
    if value_rule is None:
        return None
    raw = str(value_rule).strip()
    if not raw or raw.lower() in {"nan", "none", "null"}:
        return None

    normalized = raw.replace("～", "~").replace("—", "~").replace("–", "~")

    # 中兴等方案描述：[-140..-44];step 2 或 [0..62];step 2
    bracket_step = re.fullmatch(
        r"\s*\[\s*([+-]?\d+(?:\.\d+)?)\s*\.\.\s*([+-]?\d+(?:\.\d+)?)\s*\]\s*;\s*step\s*([+-]?\d+(?:\.\d+)?)\s*",
        normalized,
        flags=re.IGNORECASE,
    )
    if bracket_step:
        lo = float(bracket_step.group(1))
        hi = float(bracket_step.group(2))
        step = float(bracket_step.group(3))
        if lo > hi:
            lo, hi = hi, lo
        return {
            "raw": raw,
            "min": lo,
            "max": hi,
            "step": step,
            "operator": "between",
            "limit": None,
            "source": "value_rule",
            "confidence": "parsed",
            "complete": True,
        }

    bracket_only = re.fullmatch(
        r"\s*\[\s*([+-]?\d+(?:\.\d+)?)\s*\.\.\s*([+-]?\d+(?:\.\d+)?)\s*\]\s*",
        normalized,
    )
    if bracket_only:
        lo = float(bracket_only.group(1))
        hi = float(bracket_only.group(2))
        if lo > hi:
            lo, hi = hi, lo
        return {
            "raw": raw,
            "min": lo,
            "max": hi,
            "step": None,
            "operator": "between",
            "limit": None,
            "source": "value_rule",
            "confidence": "parsed",
            "complete": True,
        }

    range_match = re.fullmatch(
        r"\s*([+-]?\d+(?:\.\d+)?)\s*[~]\s*([+-]?\d+(?:\.\d+)?)\s*",
        normalized,
    )
    if not range_match:
        range_match = re.fullmatch(
            r"\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*",
            normalized,
        )
    if range_match:
        lo = float(range_match.group(1))
        hi = float(range_match.group(2))
        if lo > hi:
            lo, hi = hi, lo
        return {
            "raw": raw,
            "min": lo,
            "max": hi,
            "operator": "between",
            "limit": None,
            "source": "value_rule",
            "confidence": "parsed",
            "complete": True,
        }

    bound_match = re.fullmatch(r"\s*(<=|<|>=|>)\s*([+-]?\d+(?:\.\d+)?)\s*", normalized)
    if bound_match:
        op = bound_match.group(1)
        val = float(bound_match.group(2))
        return {
            "raw": raw,
            "min": val if op in {">", ">="} else None,
            "max": val if op in {"<", "<="} else None,
            "operator": op,
            "limit": val,
            "source": "value_rule",
            "confidence": "partial",
            "complete": False,
        }

    return {
        "raw": raw,
        "min": None,
        "max": None,
        "operator": None,
        "limit": None,
        "source": "value_rule",
        "confidence": "unparsed",
        "complete": False,
    }


def action_vendor_parameter_range(action: dict) -> dict | None:
    """Prefer scheme_desc; use value_rule when scheme_desc missing or unparsed."""
    scheme_range = parse_parameter_range(action.get("scheme_desc"))
    value_range = parse_parameter_range(action.get("value_rule"))
    if scheme_range:
        scheme_range = {**scheme_range, "source": "scheme_desc"}
    if value_range:
        value_range = {**value_range, "source": "value_rule"}
    if scheme_range and scheme_range.get("complete"):
        return scheme_range
    if scheme_range:
        return scheme_range
    return value_range


def semantic_param_id(action: dict, ticket: dict | None) -> str:
    ticket = ticket or {}
    vendor = slug(ticket.get("vendor"))
    system = slug(ticket.get("system"))
    param_object = slug(action.get("param_object"))
    param_name = slug(action.get("param_en_name") or action.get("param_cn_name"))
    return ".".join([vendor, system, param_object, param_name])


def range_repair_key(action: dict, ticket: dict | None = None) -> str:
    ticket = ticket or {}
    return "|".join([
        slug(ticket.get("vendor")),
        slug(ticket.get("system")),
        slug(action.get("scheme_id")),
        semantic_param_id(action, ticket),
    ])


def numeric_position(value: float | None, param_range: dict | None) -> float | None:
    if value is None or not param_range or not param_range.get("complete"):
        return None
    lo = param_range.get("min")
    hi = param_range.get("max")
    if lo is None or hi is None or hi == lo:
        return None
    return round((value - lo) / (hi - lo), 4)


def range_ratio(delta: float | None, param_range: dict | None) -> float | None:
    if delta is None or not param_range or not param_range.get("complete"):
        return None
    lo = param_range.get("min")
    hi = param_range.get("max")
    if lo is None or hi is None or hi == lo:
        return None
    return round(abs(delta) / abs(hi - lo), 4)


def build_range_repair_index(traces: list[dict]) -> dict[str, dict]:
    """Scan all traces; per scheme+param collect numeric before/after min/max."""
    buckets: dict[str, list[float]] = defaultdict(list)
    for trace in traces:
        ticket = trace.get("ticket") or {}
        for action in trace.get("actions") or []:
            key = range_repair_key(action, ticket)
            for field in ("before_value", "after_value"):
                num = to_number(action.get(field))
                if num is not None:
                    buckets[key].append(num)

    index: dict[str, dict] = {}
    for key, values in buckets.items():
        if len(values) < 2:
            continue
        lo = min(values)
        hi = max(values)
        if lo >= hi:
            continue
        index[key] = {
            "min": lo,
            "max": hi,
            "sample_count": len(values),
            "value_count": len(values),
        }
    return index


def build_effective_parameter_range(
    vendor_range: dict | None,
    repair_stats: dict | None,
) -> dict | None:
    """Merge dataset min/max with vendor partial bounds; skip if vendor already complete."""
    if vendor_range and vendor_range.get("complete"):
        return None
    if not repair_stats:
        return None

    observed_min = float(repair_stats["min"])
    observed_max = float(repair_stats["max"])
    if observed_min >= observed_max:
        return None

    eff_min = observed_min
    eff_max = observed_max
    filled: list[str] = []

    vendor_min = vendor_range.get("min") if vendor_range else None
    vendor_max = vendor_range.get("max") if vendor_range else None

    if vendor_min is not None:
        eff_min = max(eff_min, float(vendor_min))
    else:
        filled.append("min")

    if vendor_max is not None:
        eff_max = min(eff_max, float(vendor_max))
    else:
        filled.append("max")

    if eff_min >= eff_max:
        # 观测簇与半边界可能数值交叉（如 <=-120 但历史调到 -98）；用观测+厂商边界共同定端点
        endpoints = [observed_min, observed_max]
        if vendor_min is not None:
            endpoints.append(float(vendor_min))
        if vendor_max is not None:
            endpoints.append(float(vendor_max))
        eff_min = min(endpoints)
        eff_max = max(endpoints)
        if eff_min >= eff_max:
            return None

    raw_vendor = (vendor_range or {}).get("raw")
    return {
        "raw": f"{eff_min:g}~{eff_max:g}",
        "min": eff_min,
        "max": eff_max,
        "operator": "between",
        "limit": None,
        "source": "range_repair",
        "confidence": "dataset_inferred",
        "complete": True,
        "repair": {
            "filled": filled,
            "vendor_range": vendor_range,
            "observed_min": observed_min,
            "observed_max": observed_max,
            "sample_count": repair_stats.get("sample_count"),
            "index_version": REPAIR_INDEX_VERSION,
        },
    }


def resolve_action_ranges(
    action: dict,
    ticket: dict | None,
    repair_index: dict[str, dict] | None,
) -> tuple[dict | None, dict | None, dict | None]:
    """Return (vendor_parameter_range, effective_parameter_range, range_for_position)."""
    vendor = action_vendor_parameter_range(action)
    effective = None
    if repair_index is not None:
        stats = repair_index.get(range_repair_key(action, ticket))
        effective = build_effective_parameter_range(vendor, stats)

    position_range = vendor if vendor and vendor.get("complete") else effective
    return vendor, effective, position_range


def enrich_action_range_fields(
    action: dict,
    ticket: dict | None,
    repair_index: dict[str, dict] | None,
    *,
    include_positions: bool = True,
) -> dict[str, Any]:
    """Fields to merge onto trace actions or value_pattern dicts."""
    vendor, effective, position_range = resolve_action_ranges(action, ticket, repair_index)
    out: dict[str, Any] = {
        "parameter_range": vendor,
        "effective_parameter_range": effective,
    }
    if not include_positions:
        return out

    before_num = to_number(action.get("before_value"))
    after_num = to_number(action.get("after_value"))
    delta = (
        round(after_num - before_num, 6)
        if before_num is not None and after_num is not None
        else None
    )
    out.update({
        "before_position": numeric_position(before_num, position_range),
        "after_position": numeric_position(after_num, position_range),
        "delta_ratio": range_ratio(delta, position_range),
        "range_position_basis": (
            "vendor" if vendor and vendor.get("complete") else "effective" if effective else None
        ),
    })
    return out
