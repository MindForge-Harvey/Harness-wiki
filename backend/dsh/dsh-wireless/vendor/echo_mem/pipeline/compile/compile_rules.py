"""规则版编译：trace + evidence → MemoryObject。

零 LLM 调用，全部由规则与模板生成。用于：
- 冷启动 demo 端到端跑通
- LLM 后端失败时兜底
- 真值/差异对照（可以同时跑 rule_v1 与 llm_v1 后做 diff）

调用：
    python -m pipeline.compile.compile_rules \
        --traces data/compiled/compile_batch.jsonl \
        --evidence data/compiled/evidence_units.jsonl \
        --out data/compiled/memory_objects.jsonl
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from ..common import io as cio
from ..common import paths as P
from ..common.compile_eligibility import filter_effect_traces, is_compile_effect_eligible, ticket_outcome
from ..common.action_ontology import LABEL_ROLE, load_action_ontology_store
from ..common.ticket_aggregate import TICKET_OUTCOME_LONG_EVAL_FAIL
from ..common.schema_check import validate
from ..common.parameter_range import (
    action_vendor_parameter_range as _action_parameter_range,
    build_range_repair_index,
    numeric_position as _numeric_position,
    parse_parameter_range as _parse_parameter_range,
    range_ratio as _range_ratio,
    resolve_action_ranges,
    to_number as _to_number,
)
from .outcome_compilation import materialize_evidence_authority
from ..ingest.preprocess import canonical_issue_type
from ..scoring.bayesian_score import credibility_from_counts

PRODUCER = "rule_v1"
_RANGE_REPAIR_INDEX: dict[str, dict] | None = None
_PARAMETER_SEMANTIC_MODE = "normalized"
_VALUE_ABSTRACTION_MODE = "normalized"
_ACTION_ONTOLOGY_MODE = "reviewed_labels"
_SUPPORT_PROFILE_CONSTRUCTION_MODE = "enabled"
_BUNDLE_PARTICIPATION_MODE = "off"
_STRUCTURAL_SIGNATURE_GRANULARITY_MODE = "frozen_current"


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _canonicalize_trace_record(trace: dict) -> dict:
    row = copy.deepcopy(trace)
    actions = [action for action in (row.get("actions") or []) if isinstance(action, dict)]
    actions.sort(
        key=lambda action: (
            str(action.get("action_id") or ""),
            str(action.get("exec_id") or ""),
            str(action.get("param_exec_id") or ""),
            _canonical_json(action),
        )
    )
    row["actions"] = actions
    return row


def _deduplicate_records(
    records: list[dict],
    *,
    id_field: str,
    record_kind: str,
    canonicalize=None,
) -> tuple[list[dict], int]:
    """Collapse repeated source records and reject same-ID semantic conflicts."""
    by_id: dict[str, tuple[str, dict]] = {}
    duplicate_count = 0
    for original in records:
        if not isinstance(original, dict):
            raise ValueError(f"{record_kind} record must be an object")
        record = canonicalize(original) if canonicalize else copy.deepcopy(original)
        record_id = str(record.get(id_field) or "")
        if not record_id:
            raise ValueError(f"{record_kind} record missing {id_field}")
        semantic = {
            key: value
            for key, value in record.items()
            if key not in {"produced_at", "extracted_at"}
        }
        signature = _canonical_json(semantic)
        previous = by_id.get(record_id)
        if previous is None:
            by_id[record_id] = (signature, record)
            continue
        if previous[0] != signature:
            raise ValueError(
                f"conflicting duplicate {record_kind} {id_field}={record_id}"
            )
        duplicate_count += 1
        # Volatile timestamps are not semantic.  Select a stable representative
        # when otherwise-identical records carry different extraction times.
        if _canonical_json(record) < _canonical_json(previous[1]):
            by_id[record_id] = (signature, record)
    return [by_id[key][1] for key in sorted(by_id)], duplicate_count


def _ensure_evidence_authority(traces: list[dict]) -> list[dict]:
    if all(
        (trace.get("aggregate") or {}).get("maximum_attribution_scope")
        and all(
            action.get("maximum_attribution_scope")
            for action in (trace.get("actions") or [])
            if isinstance(action, dict)
        )
        for trace in traces
    ):
        return traces
    materialized, _ = materialize_evidence_authority(traces)
    return materialized


def _bundle_participation_prior(actions: list[dict]) -> dict | None:
    """Summarize bundle outcomes without promoting them to action labels.

    This object is intentionally typed as a weak participation prior.  Its
    counts must never be merged into action-level pass/fail metrics or used as
    an independent hard-veto signal.
    """
    if _BUNDLE_PARTICIPATION_MODE != "typed_weak_prior":
        return None
    eligible = [
        action for action in actions
        if action.get("compiled_outcome_scope") == "plan_bundle_only"
    ]
    counts = Counter(str(action.get("bundle_outcome_result") or "long_eval_unknown") for action in eligible)
    passed = int(counts.get("long_eval_pass") or 0)
    failed = int(counts.get("long_eval_fail") or 0)
    # Mixed/execution-blocked/missing bundle outcomes are also non-evaluated;
    # keep accounting complete without turning them into pass/fail evidence.
    unknown = len(eligible) - passed - failed
    evaluated = passed + failed
    return {
        "evidence_scope": "multi_action_bundle_component_participation",
        "evidence_strength": "weak_prior_only",
        "routing_eligibility": "gate_ineligible_without_direct_action_evidence",
        "support_count": len(eligible),
        "bundle_pass_participation_count": passed,
        "bundle_fail_participation_count": failed,
        "bundle_unknown_participation_count": unknown,
        "bundle_pass_participation_rate": round(passed / evaluated, 6) if evaluated else 0.0,
        "contract": "bundle outcome is not an independently observed component-action outcome",
    }


def _trace_issue_type(trace: dict) -> str:
    return canonical_issue_type((trace.get("ticket") or {}).get("primary_issue_type"))


def _mid(*parts: str) -> str:
    raw = "|".join([str(p) for p in parts if p is not None])
    h = hashlib.md5(raw.encode("utf-8")).hexdigest()[:10]
    return f"m_{h}"


def _index_evidence(evs: list[dict]) -> dict[str, list[dict]]:
    by_trace: dict[str, list[dict]] = defaultdict(list)
    for e in evs:
        by_trace[e["trace_id"]].append(e)
    for rows in by_trace.values():
        rows.sort(key=lambda row: str(row.get("evidence_id") or ""))
    return by_trace


def _evidence_ids_for_trace(by_trace: dict, trace_id: str, types: list[str] | None = None) -> list[str]:
    out = []
    for e in by_trace.get(trace_id, []):
        if types and e["evidence_type"] not in types:
            continue
        out.append(e["evidence_id"])
    return sorted(set(out))


# ---------- 1. CaseMemory：每个 trace 1 条（工单快照 / Trace 索引，非聚合知识）----------
# 产品语义：与 TraceRecord 1:1，供钻取与证据挂接；可复用知识见 strategy / playbook / rca。
# 后续第二步可在此基础上增加 case_episode 聚合，全量 raw 工单仍保留在 trace 层。

def build_case_memory(trace: dict, evidence_by_trace: dict) -> dict:
    tid = trace["trace_id"]
    tk = trace["ticket"]
    agg = trace.get("aggregate", {})
    issue = _trace_issue_type(trace)
    region = tk.get("region")
    outcome = agg.get("ticket_outcome", "long_eval_unknown")

    actions_brief = []
    for a in trace["actions"][:6]:
        value_pattern = _value_pattern(a, tk)
        ontology_label = _action_ontology_label(trace, a)
        actions_brief.append({
            "action_id": a["action_id"],
            "scheme_id": a.get("scheme_id"),
            "scheme_group": a.get("scheme_group"),
            "parameter_semantic_id": _semantic_param_id(a, tk),
            "param_object": a.get("param_object"),
            "param_en_name": a.get("param_en_name"),
            "param_cn_name": a.get("param_cn_name"),
            "value_type": value_pattern.get("value_type"),
            "direction": value_pattern.get("direction"),
            "delta_bucket": value_pattern.get("delta_bucket"),
            "value_pattern_id": value_pattern.get("pattern_id"),
            "canonical_action_id": ontology_label.get("canonical_action_id"),
            "action_ontology": ontology_label,
            "action_ontology_status": ontology_label.get("ontology_status"),
            "action_ontology_policy": ontology_label.get("hard_aggregation_policy"),
            "operation_summary": a.get("operation_summary"),
            "operation_delta_hint": a.get("operation_delta_hint"),
            "parameter_group": a.get("parameter_group"),
            "value_rule": a.get("value_rule"),
            "scheme_desc": a.get("scheme_desc"),
            "before_value": a.get("before_value"),
            "after_value": a.get("after_value"),
            "adjustment_rule": a.get("adjustment_rule"),
            "final_ratio": a.get("final_ratio"),
            "change": f"{a.get('before_value')}→{a.get('after_value')}",
            "exec_state": a.get("exec_state"),
            "long_eval": a.get("long_eval_result"),
            "improvement_result": a.get("improvement_result"),
            "maximum_attribution_scope": a.get("maximum_attribution_scope"),
            "outcome_role": a.get("outcome_role"),
            "result_evidence_eligible": bool(a.get("result_evidence_eligible")),
            "associated_bundle_outcome_role": a.get("associated_bundle_outcome_role"),
        })

    primary_scheme = Counter(a.get("scheme_id") for a in trace["actions"] if a.get("scheme_id")).most_common(1)
    primary_scheme_id = primary_scheme[0][0] if primary_scheme else None

    title = f"{issue}·{region or '未知区域'}·{primary_scheme_id or '混合方案'}"
    summary_outcome = {
        "long_eval_pass": "长评估通过",
        "long_eval_fail": "长评估不通过",
        "long_eval_mixed": "长评估部分通过",
        "long_eval_unknown": "长评估缺失",
        "execution_blocked": "执行受阻",
    }.get(outcome, "未知结局")
    summary = f"{issue}工单（{region or '?'}），主方案 {primary_scheme_id or '混合'}，{summary_outcome}。"

    return {
        "memory_id": _mid("case", tid),
        "memory_type": "case_memory",
        "trace_ids": [tid],
        "evidence_ids": _evidence_ids_for_trace(evidence_by_trace, tid),
        "title": title,
        "summary": summary[:120],
        "applicability": {
            "issue_types": [issue] if issue else [],
            "scheme_groups": sorted({a.get("scheme_group") for a in trace["actions"] if a.get("scheme_group")}),
            "scheme_ids": sorted({a.get("scheme_id") for a in trace["actions"] if a.get("scheme_id")}),
            "vendors": [tk["vendor"]] if tk.get("vendor") else [],
            "regions": [tk["region"]] if tk.get("region") else [],
            "indoor_outdoor": [tk["is_indoor"]] if tk.get("is_indoor") else [],
            "bands": [tk["band"]] if tk.get("band") else [],
            "systems": [tk["system"]] if tk.get("system") else [],
            "exclusions": [],
        },
        "content": {
            "ticket_summary": f"{issue}·{region or '?'}",
            "ticket_id": tk["id"],
            "ticket_context": {
                "region": tk.get("region"),
                "vendor": tk.get("vendor"),
                "system": tk.get("system"),
                "is_indoor": tk.get("is_indoor"),
                "band": tk.get("band"),
                "cover_area": tk.get("cover_area"),
                "antenna_type": tk.get("antenna_type"),
                "aau_antenna_info": tk.get("aau_antenna_info"),
            },
            "actions": actions_brief,
            "outcome": outcome,
            "evidence_authority": {
                "maximum_attribution_scope": agg.get("maximum_attribution_scope"),
                "outcome_role": agg.get("outcome_role"),
                "result_evidence_eligible": bool(agg.get("result_evidence_eligible")),
                "basis": agg.get("evidence_authority_basis"),
            },
            "aggregate": agg,
        },
        "state": "draft",
        "metrics": {
            # support_count = 已下发动作数，供 TR-006 按「失败占已下发比例」判定，避免混合工单 1 条失败即整单 restricted
            "support_count": max(
                1,
                sum(1 for a in trace["actions"] if a.get("issued_state") == "下发成功"),
            ),
            "long_eval_pass_count": agg.get("long_eval_pass", 0),
            "long_eval_fail_count": agg.get("long_eval_fail", 0),
            "exec_fail_count": agg.get("exec_failed", 0),
            "audit_timeout_count": agg.get("audit_timeout", 0),
            "pass_rate": _pass_rate(agg.get("long_eval_pass", 0), agg.get("long_eval_fail", 0)),
        },
        "score_ref": None,
        "produced_by": PRODUCER,
        "produced_at": cio.now_iso(),
        "schema_version": "1.0",
    }


def _pass_rate(p: int, f: int) -> float:
    total = p + f
    return round(p / total, 4) if total > 0 else 0.0


def _median_number(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return round(float(ordered[mid]), 6)
    return round(float((ordered[mid - 1] + ordered[mid]) / 2), 6)


def _slug(s: object) -> str:
    text = str(s or "unknown").strip().lower()
    text = re.sub(r"\s+", "_", text)
    text = re.sub(r"[^0-9a-zA-Z_\-\u4e00-\u9fff]+", "_", text)
    return text.strip("_") or "unknown"


def _fmt_num(v: float | None) -> str | None:
    if v is None:
        return None
    return str(int(v)) if v.is_integer() else f"{v:.4f}".rstrip("0").rstrip(".")


def _parse_symbolic_transition(before: object, after: object) -> dict | None:
    """Parse vendor enum values like FooSwitch-1 -> FooSwitch-0 without losing raw values."""
    before_text = str(before or "").strip()
    after_text = str(after or "").strip()
    if not before_text or not after_text:
        return None

    # Conservative: only split a shared symbolic prefix ending in -0/-1 or _0/_1.
    # Numeric values such as -64 are intentionally not matched because they have no prefix.
    before_match = re.fullmatch(r"(.+?)([-_])([01])", before_text)
    after_match = re.fullmatch(r"(.+?)([-_])([01])", after_text)
    if not before_match or not after_match:
        return None
    if before_match.group(1) != after_match.group(1):
        return None

    base = before_match.group(1)
    before_token = before_match.group(3)
    after_token = after_match.group(3)
    return {
        "base": base,
        "before": before_token,
        "after": after_token,
        "change": f"{base}: {before_token}→{after_token}",
        "raw_change": f"{before_text}→{after_text}",
    }


def _get_range_repair_index() -> dict[str, dict]:
    return _RANGE_REPAIR_INDEX or {}


def _boundary_zone(position: float | None) -> str | None:
    if position is None:
        return None
    if position < 0:
        return "below_min"
    if position > 1:
        return "above_max"
    if position <= 0.1:
        return "near_min"
    if position >= 0.9:
        return "near_max"
    return "inside"


def _position_bucket(position: float | None) -> str | None:
    if position is None:
        return None
    if position < 0:
        return "below_min"
    if position > 1:
        return "above_max"
    if position <= 0.05:
        return "p00_05"
    if position <= 0.20:
        return "p05_20"
    if position <= 0.40:
        return "p20_40"
    if position <= 0.60:
        return "p40_60"
    if position <= 0.80:
        return "p60_80"
    if position <= 0.95:
        return "p80_95"
    return "p95_100"


def _delta_ratio_bucket(delta_ratio: float | None) -> str | None:
    if delta_ratio is None:
        return None
    magnitude = abs(delta_ratio)
    if magnitude == 0:
        return "zero"
    if magnitude <= 0.02:
        return "tiny"
    if magnitude <= 0.10:
        return "small"
    if magnitude <= 0.25:
        return "medium"
    if magnitude <= 0.50:
        return "large"
    return "very_large"


def _boundary_relation(before_position: float | None, after_position: float | None) -> str | None:
    before_zone = _boundary_zone(before_position)
    after_zone = _boundary_zone(after_position)
    if not before_zone or not after_zone:
        return None
    edge_zones = {"near_min", "near_max", "below_min", "above_max"}
    if before_zone in edge_zones and after_zone == "inside":
        return "from_edge_to_inside"
    if before_zone == "inside" and after_zone in edge_zones:
        return "from_inside_to_edge"
    if before_zone in edge_zones and after_zone in edge_zones:
        return "edge_to_edge"
    return "inside_to_inside"


def _normalized_adjustment_shape(
    *,
    direction: str,
    before_position: float | None,
    after_position: float | None,
    delta_ratio: float | None,
) -> dict | None:
    before_bucket = _position_bucket(before_position)
    after_bucket = _position_bucket(after_position)
    delta_bucket = _delta_ratio_bucket(delta_ratio)
    if not (before_bucket and after_bucket and delta_bucket):
        return None
    shape_id = "|".join([direction, before_bucket, after_bucket, delta_bucket])
    return {
        "shape_id": shape_id,
        "direction": direction,
        "before_position": before_position,
        "after_position": after_position,
        "delta_ratio": delta_ratio,
        "abs_delta_ratio": round(abs(delta_ratio), 6) if delta_ratio is not None else None,
        "before_position_bucket": before_bucket,
        "after_position_bucket": after_bucket,
        "delta_ratio_bucket": delta_bucket,
        "before_zone": _boundary_zone(before_position),
        "after_zone": _boundary_zone(after_position),
        "boundary_relation": _boundary_relation(before_position, after_position),
    }


def _semantic_param_id(action: dict, ticket: dict) -> str:
    """Vendor-specific semantic key. Cross-vendor merge needs a curated/LLM mapping layer."""
    if _PARAMETER_SEMANTIC_MODE == "raw_identity":
        # Construction ablation: preserve the source identity facets without
        # slug/alias normalization.  Keep all facets so unrelated parameters
        # are never collapsed merely because semantic normalization is off.
        return "raw::" + "::".join([
            str(ticket.get("vendor") or ""),
            str(ticket.get("system") or ""),
            str(action.get("param_object") or ""),
            str(action.get("param_en_name") or ""),
            str(action.get("site_param_en_name") or ""),
            str(action.get("param_cn_name") or ""),
        ])
    vendor = _slug(ticket.get("vendor"))
    system = _slug(ticket.get("system"))
    param_object = _slug(action.get("param_object"))
    param_name = _slug(action.get("param_en_name") or action.get("param_cn_name"))
    return ".".join([vendor, system, param_object, param_name])


def _action_ontology_label(trace: dict, action: dict) -> dict:
    if _ACTION_ONTOLOGY_MODE == "off":
        return {
            "ontology_status": "unavailable",
            "hard_aggregation_policy": "allowed",
            "source_version": "disabled_by_construction_ablation",
        }
    return load_action_ontology_store().label_for(trace.get("ticket") or {}, action)


def _label_values(labels: list[dict], field: str, limit: int = 8) -> list[str]:
    values = Counter(str(label.get(field)) for label in labels if label.get(field))
    return [value for value, _ in values.most_common(limit)]


def _conservative_policy(labels: list[dict]) -> str:
    policies = {label.get("hard_aggregation_policy") or "allowed" for label in labels}
    if "blocked" in policies:
        return "blocked"
    if "conditional" in policies:
        return "conditional"
    return "allowed"


def _action_ontology_summary(labels: list[dict]) -> dict:
    if not labels:
        return {
            "source_version": "reviewed_label_ontology_v2",
            "signature_algorithm_version": "action_signature_hash_v1_1",
            "label_role": LABEL_ROLE,
            "ontology_status": "unavailable",
            "hard_aggregation_policy": "blocked",
        }
    mapped = [label for label in labels if label.get("ontology_status") == "mapped"]
    status = "mapped" if len(mapped) == len(labels) else "partial" if mapped else "unmapped"
    policy = _conservative_policy(labels)
    return {
        "source_version": labels[0].get("source_version"),
        "signature_algorithm_version": labels[0].get("signature_algorithm_version"),
        "label_role": LABEL_ROLE,
        "ontology_status": status,
        "mapped_count": len(mapped),
        "unmapped_count": len(labels) - len(mapped),
        "label_count": len(labels),
        "ontology_signature_ids": _label_values(labels, "ontology_signature_id", 12),
        "canonical_action_ids": _label_values(mapped, "canonical_action_id"),
        "parameter_concept_ids": _label_values(mapped, "parameter_concept_id"),
        "operation_families": _label_values(mapped, "operation_family"),
        "hard_aggregation_policy": policy,
        "hard_aggregation_policy_distribution": dict(Counter(label.get("hard_aggregation_policy") or "allowed" for label in labels)),
        "parent_only": any(bool(label.get("parent_only")) for label in labels),
        "requires_vendor_semantics_confirmation": any(
            bool(label.get("requires_vendor_semantics_confirmation")) for label in labels
        ),
        "policy_bundle_ids": _label_values(labels, "policy_bundle_id", 12),
        "policy_note": "semantic labels only; original signature/scheme/parameter/value/boundary remain executable identity",
    }


def _enum_kind(before: object, after: object) -> tuple[str, str | None]:
    symbolic = _parse_symbolic_transition(before, after)
    if symbolic:
        if symbolic["before"] == "0" and symbolic["after"] == "1":
            return "switch", "enable"
        if symbolic["before"] == "1" and symbolic["after"] == "0":
            return "switch", "disable"

    b = str(before or "").lower()
    a = str(after or "").lower()
    off_tokens = ("-0", "_0", "off", "false", "disable", "disabled", "关")
    on_tokens = ("-1", "_1", "on", "true", "enable", "enabled", "开")
    if any(t in b for t in off_tokens) and any(t in a for t in on_tokens):
        return "switch", "enable"
    if any(t in b for t in on_tokens) and any(t in a for t in off_tokens):
        return "switch", "disable"
    return "enum", "switch_enum"


def _value_pattern(action: dict, ticket: dict | None = None) -> dict:
    before_raw = action.get("before_value")
    after_raw = action.get("after_value")
    before_num = _to_number(before_raw)
    after_num = _to_number(after_raw)
    vendor_range, effective_range, position_range = resolve_action_ranges(
        action, ticket, _get_range_repair_index(),
    )

    if before_num is not None and after_num is not None:
        delta = round(after_num - before_num, 6)
        if delta > 0:
            direction = "increase"
        elif delta < 0:
            direction = "decrease"
        else:
            direction = "unchanged"
        delta_label = _fmt_num(abs(delta)) or "0"
        signed_delta = f"{'+' if delta > 0 else '-' if delta < 0 else ''}{delta_label}"
        before_position = _numeric_position(before_num, position_range)
        after_position = _numeric_position(after_num, position_range)
        delta_ratio = _range_ratio(delta, position_range)
        normalized_shape = _normalized_adjustment_shape(
            direction=direction,
            before_position=before_position,
            after_position=after_position,
            delta_ratio=delta_ratio,
        )
        pattern = {
            "value_type": "numeric",
            "pattern_id": f"numeric_{direction}_{signed_delta}",
            "direction": direction,
            "delta": delta,
            "delta_bucket": signed_delta,
            "parameter_range": vendor_range,
            "effective_parameter_range": effective_range,
            "range_position_basis": (
                "vendor" if vendor_range and vendor_range.get("complete") else "effective" if effective_range else None
            ),
            "before_value": before_raw,
            "after_value": after_raw,
            "before_numeric": before_num,
            "after_numeric": after_num,
            "before_position": before_position,
            "after_position": after_position,
            "delta_ratio": delta_ratio,
            "before_zone": _boundary_zone(before_position),
            "after_zone": _boundary_zone(after_position),
            "normalized_adjustment_shape": normalized_shape,
            "normalized_shape_id": normalized_shape.get("shape_id") if normalized_shape else None,
            "change": f"{before_raw}→{after_raw}",
        }
        if _VALUE_ABSTRACTION_MODE == "exact_identity":
            pattern.update({
                "pattern_id": f"numeric_exact_{_slug(before_raw)}_to_{_slug(after_raw)}",
                "delta_bucket": None,
                "before_position": None,
                "after_position": None,
                "delta_ratio": None,
                "before_zone": None,
                "after_zone": None,
                "normalized_adjustment_shape": None,
                "normalized_shape_id": None,
            })
        return pattern

    value_type, direction = _enum_kind(before_raw, after_raw)
    symbolic = _parse_symbolic_transition(before_raw, after_raw)
    transition = symbolic["change"] if symbolic else f"{before_raw}→{after_raw}"
    return {
        "value_type": value_type,
        "pattern_id": (
            f"{value_type}_{_slug(direction)}_{_slug(symbolic['base'])}_{symbolic['before']}_to_{symbolic['after']}"
            if symbolic
            else f"{value_type}_{_slug(direction)}_{_slug(before_raw)}_to_{_slug(after_raw)}"
        ),
        "direction": direction,
        "delta": None,
        "delta_bucket": None,
        "parameter_range": vendor_range,
        "effective_parameter_range": effective_range,
        "range_position_basis": (
            "vendor" if vendor_range and vendor_range.get("complete") else "effective" if effective_range else None
        ),
        "before_value": before_raw,
        "after_value": after_raw,
        "before_numeric": None,
        "after_numeric": None,
        "symbolic_transition": symbolic,
        "change": transition,
    }


def _summarize_pattern(pattern: dict) -> str:
    if pattern["value_type"] == "numeric":
        direction_label = {
            "increase": "上调",
            "decrease": "下调",
            "unchanged": "保持",
        }.get(pattern["direction"], pattern["direction"])
        return f"{direction_label} {pattern.get('delta_bucket') or ''}".strip()
    if pattern["value_type"] == "switch":
        return "开关启用" if pattern["direction"] == "enable" else "开关关闭"
    return f"枚举切换 {pattern['change']}"


# ---------- 2. RCAMemory：按 (issue_type, type1+type2) 聚合 ----------
#
# type1/type2 are source root-cause labels: type1 is the first-level root
# cause and type2 is the second-level root cause. scheme_group/param_kind are
# kept as compatibility aliases because older compiled traces used those names.

def _flat_actions(traces: list[dict]) -> list[tuple[dict, dict]]:
    return [(tr, a) for tr in traces for a in tr["actions"]]


ROOT_CAUSE_LABEL_KIND = "trace_root_cause_label"
ROOT_CAUSE_LABEL_NOTE = "由源数据 type1/type2 组成：type1 为一级根因，type2 为二级根因；type3 仅作动作级方案生成参考。"


def _root_cause_parts_for_action(action: dict) -> tuple[str | None, str | None, str | None]:
    l1 = action.get("root_cause_l1") or action.get("param_kind")
    l2 = action.get("root_cause_l2") or action.get("scheme_group")
    l1 = str(l1).strip() if l1 else None
    l2 = str(l2).strip() if l2 else None
    key = action.get("root_cause_key")
    key = str(key).strip() if key else None
    if not key:
        key = " / ".join([x for x in [l1, l2] if x]) or None
    return l1, l2, key


def _root_cause_for_action(action: dict) -> str:
    _, _, key = _root_cause_parts_for_action(action)
    return key or "未知根因"


def _root_causes_for_actions(actions: list[dict]) -> list[str]:
    roots = Counter(
        _root_cause_for_action(a)
        for a in actions
        if _root_cause_for_action(a) != "未知根因"
    )
    return [root for root, _ in roots.most_common(5)]


def _top_ticket_values(traces: list[dict], key: str, limit: int) -> list[str]:
    values = Counter()
    for trace in traces:
        value = (trace.get("ticket") or {}).get(key)
        if value:
            values[str(value)] += 1
    return [value for value, _ in values.most_common(limit)]


def _ticket_context_applicability(traces: list[dict]) -> dict[str, list[str]]:
    return {
        "vendors": _top_ticket_values(traces, "vendor", 3),
        "regions": _top_ticket_values(traces, "region", 8),
        "indoor_outdoor": _top_ticket_values(traces, "is_indoor", 4),
        "bands": _top_ticket_values(traces, "band", 8),
        "systems": _top_ticket_values(traces, "system", 4),
    }


def build_rca_memories(traces: list[dict], evidence_by_trace: dict) -> list[dict]:
    groups: dict[tuple[str, str, str, str], list[dict]] = defaultdict(list)
    for tr in traces:
        issue = _trace_issue_type(tr)
        root_counter = Counter()
        root_meta: dict[str, tuple[str, str]] = {}
        for action in tr["actions"]:
            l1, l2, key = _root_cause_parts_for_action(action)
            if not key:
                continue
            root_counter[key] += 1
            root_meta.setdefault(key, (l1 or "未知一级根因", l2 or "未知二级根因"))
        root_key = root_counter.most_common(1)[0][0] if root_counter else "未知根因"
        root_l1, root_l2 = root_meta.get(root_key, ("未知一级根因", "未知二级根因"))
        groups[(issue, root_l1, root_l2, root_key)].append(tr)

    out: list[dict] = []
    for (issue, root_l1, root_l2, root_key), trs in groups.items():
        evs: list[str] = []
        scheme_ids = Counter()
        scheme_groups = Counter()
        param_objs = Counter()
        vendors = Counter()
        regions = Counter()
        indoor_outdoor = Counter()
        bands = Counter()
        systems = Counter()
        cover_areas = Counter()
        antenna_types = Counter()
        pass_n = fail_n = exec_fail = 0
        for tr in trs:
            evs.extend(_evidence_ids_for_trace(evidence_by_trace, tr["trace_id"], ["root_cause_evidence"]))
            agg = tr.get("aggregate", {})
            pass_n += agg.get("long_eval_pass", 0)
            fail_n += agg.get("long_eval_fail", 0)
            exec_fail += agg.get("exec_failed", 0)
            for a in tr["actions"]:
                if a.get("scheme_id"):
                    scheme_ids[a["scheme_id"]] += 1
                if a.get("scheme_group"):
                    scheme_groups[a["scheme_group"]] += 1
                if a.get("param_object"):
                    param_objs[a["param_object"]] += 1
            if tr["ticket"].get("vendor"):
                vendors[tr["ticket"]["vendor"]] += 1
            if tr["ticket"].get("region"):
                regions[tr["ticket"]["region"]] += 1
            if tr["ticket"].get("is_indoor"):
                indoor_outdoor[tr["ticket"]["is_indoor"]] += 1
            if tr["ticket"].get("band"):
                bands[tr["ticket"]["band"]] += 1
            if tr["ticket"].get("system"):
                systems[tr["ticket"]["system"]] += 1
            if tr["ticket"].get("cover_area"):
                cover_areas[tr["ticket"]["cover_area"]] += 1
            if tr["ticket"].get("antenna_type"):
                antenna_types[tr["ticket"]["antenna_type"]] += 1

        inferred = root_key
        title = f"{issue}·根因：{inferred}"
        pr = _pass_rate(pass_n, fail_n)
        summary = (
            f"{issue}+{inferred}：源数据根因标签；"
            f"支撑 trace {len(trs)} 条；长评估通过率 {pr:.2f}（{pass_n}/{pass_n+fail_n}）。"
        )

        out.append({
            "memory_id": _mid("rca", issue, root_key),
            "memory_type": "rca_memory",
            "trace_ids": [tr["trace_id"] for tr in trs],
            "evidence_ids": evs,
            "title": title,
            "summary": summary[:120],
            "applicability": {
                "issue_types": [issue],
                "root_causes": [root_key] if root_key != "未知根因" else [],
                "scheme_groups": [s for s, _ in scheme_groups.most_common(5)],
                "scheme_ids": [s for s, _ in scheme_ids.most_common(8)],
                "vendors": [v for v, _ in vendors.most_common(3)],
                "regions": [r for r, _ in regions.most_common(8)],
                "indoor_outdoor": [v for v, _ in indoor_outdoor.most_common(4)],
                "bands": [b for b, _ in bands.most_common(8)],
                "systems": [s for s, _ in systems.most_common(4)],
                "exclusions": [],
            },
            "content": {
                "issue_type": issue,
                "primary_root_cause_inferred": inferred,
                "primary_root_cause": inferred,
                "primary_root_cause_l1": root_l1,
                "primary_root_cause_l2": root_l2,
                "solution_proxy_root_cause": inferred,
                "secondary_root_causes": [],
                "basis_scheme_groups": [s for s, _ in scheme_groups.most_common(5)],
                "basis_param_objects": [o for o, _ in param_objs.most_common(5)],
                "evidence_quality": ROOT_CAUSE_LABEL_KIND,
                "proxy_kind": ROOT_CAUSE_LABEL_KIND,
                "not_for_rca_input": False,
                "warning": ROOT_CAUSE_LABEL_NOTE,
                "scheme_id_top": [s for s, _ in scheme_ids.most_common(5)],
                "context_profile": {
                    "regions": [r for r, _ in regions.most_common(8)],
                    "indoor_outdoor": [v for v, _ in indoor_outdoor.most_common(4)],
                    "bands": [b for b, _ in bands.most_common(8)],
                    "systems": [s for s, _ in systems.most_common(4)],
                    "cover_areas": [v for v, _ in cover_areas.most_common(6)],
                    "antenna_types": [v for v, _ in antenna_types.most_common(6)],
                    "field_contract": "pre_decision_context_profile_not_final_rank_feature",
                },
            },
            "state": "draft",
            "metrics": {
                "support_count": len(trs),
                "long_eval_pass_count": pass_n,
                "long_eval_fail_count": fail_n,
                "exec_fail_count": exec_fail,
                "audit_timeout_count": 0,
                "pass_rate": pr,
            },
            "score_ref": None,
            "produced_by": PRODUCER,
            "produced_at": cio.now_iso(),
            "schema_version": "1.0",
        })
    return out


# ---------- 3. StrategyMemory：按问题 + 厂家 + 参数语义 + 软调整模式聚合 ----------

def _frozen_strategy_pattern_key(pattern: dict) -> str:
    """Generalized key for reusable strategy templates.

    Numeric deltas and switch literal encodings are evidence, not template
    identity: +10/+11 share numeric_{direction}; FooSwitch-1→0 and FooSwitch_1→0
    share switch_{direction} under the same parameter_semantic_id.
    """
    if _VALUE_ABSTRACTION_MODE == "exact_identity":
        return str(pattern["pattern_id"])
    if pattern["value_type"] == "numeric":
        return f"numeric_{pattern['direction']}"
    if pattern["value_type"] == "switch":
        return f"switch_{pattern['direction']}"
    return pattern["pattern_id"]


def _strategy_pattern_key(pattern: dict, ticket: dict | None = None) -> str:
    """Project retained value/context fields into a nested structural identity.

    ``frozen_current`` preserves the locked compiler identity. The remaining
    modes support the supplementary structural-identity granularity analysis.
    """
    if _STRUCTURAL_SIGNATURE_GRANULARITY_MODE == "frozen_current":
        return _frozen_strategy_pattern_key(pattern)

    value_type = str(pattern.get("value_type") or "unknown")
    direction = str(pattern.get("direction") or "unknown")
    coarse = f"{value_type}|{direction}"
    if _STRUCTURAL_SIGNATURE_GRANULARITY_MODE == "coarse_direction":
        return coarse

    shape = str(
        pattern.get("normalized_shape_id")
        or pattern.get("pattern_id")
        or "shape_unavailable"
    )
    value_aware = f"{coarse}|shape:{shape}"
    if _STRUCTURAL_SIGNATURE_GRANULARITY_MODE == "value_shape":
        return value_aware

    ticket = ticket or {}
    boundary = "|".join(
        [
            f"region:{_slug(ticket.get('region'))}",
            f"band:{_slug(ticket.get('band'))}",
            f"indoor:{_slug(ticket.get('is_indoor'))}",
        ]
    )
    return f"{value_aware}|{boundary}"


def _strategy_pattern_label(pattern: dict) -> str:
    if pattern["value_type"] == "numeric":
        return {
            "increase": "数值上调",
            "decrease": "数值下调",
            "unchanged": "数值保持",
        }.get(pattern["direction"], pattern["direction"])
    return _summarize_pattern(pattern)


def _parse_signed_delta_bucket(delta_bucket: object) -> float | None:
    if delta_bucket is None:
        return None
    text = str(delta_bucket).strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _merge_strategy_value_pattern(
    pattern_id: str,
    pairs: list[tuple[dict, dict, dict]],
    delta_distribution: list[dict],
) -> dict:
    """Aggregate per-action patterns into one strategy value_pattern.

    Numeric buckets keep direction as template identity; delta_bucket/delta and
    position fields come from the modal delta_bucket (typical example), not pairs[0].
    """
    patterns = [p for _, _, p in pairs]
    base = patterns[0]
    before_nums = [p["before_numeric"] for p in patterns if p.get("before_numeric") is not None]
    after_nums = [p["after_numeric"] for p in patterns if p.get("after_numeric") is not None]
    merged: dict = {
        "pattern_id": pattern_id,
        "raw_pattern_ids": sorted({p["pattern_id"] for p in patterns})[:12],
        "value_type": base["value_type"],
        "direction": base["direction"],
        "label": _strategy_pattern_label(base),
        "delta_distribution": delta_distribution,
        "before_range": [_fmt_num(min(before_nums)), _fmt_num(max(before_nums))] if before_nums else None,
        "after_range": [_fmt_num(min(after_nums)), _fmt_num(max(after_nums))] if after_nums else None,
    }

    if base["value_type"] == "numeric" and delta_distribution:
        typical_bucket = delta_distribution[0]["delta_bucket"]
        rep = next((p for p in patterns if p.get("delta_bucket") == typical_bucket), base)
        merged["delta_bucket"] = typical_bucket
        merged["delta"] = rep.get("delta")
        if merged["delta"] is None:
            merged["delta"] = _parse_signed_delta_bucket(typical_bucket)
        merged["delta_bucket_role"] = "typical_example"
        merged["parameter_range"] = rep.get("parameter_range")
        merged["effective_parameter_range"] = rep.get("effective_parameter_range")
        merged["range_position_basis"] = rep.get("range_position_basis")
        merged["before_position"] = rep.get("before_position")
        merged["after_position"] = rep.get("after_position")
        merged["delta_ratio"] = rep.get("delta_ratio")
        merged["before_zone"] = rep.get("before_zone")
        merged["after_zone"] = rep.get("after_zone")
        merged["normalized_adjustment_shape"] = rep.get("normalized_adjustment_shape")
        merged["normalized_shape_id"] = rep.get("normalized_shape_id")
        shape_distribution = Counter(
            p.get("normalized_shape_id")
            for p in patterns
            if p.get("normalized_shape_id")
        )
        merged["shape_distribution"] = [
            {
                "shape_id": shape_id,
                "support_count": support,
                "example": next(
                    (p.get("normalized_adjustment_shape") for p in patterns if p.get("normalized_shape_id") == shape_id),
                    None,
                ),
            }
            for shape_id, support in shape_distribution.most_common(10)
        ]
    elif base["value_type"] == "switch":
        pid_counts = Counter(p["pattern_id"] for p in patterns)
        typical_pid = pid_counts.most_common(1)[0][0] if pid_counts else base["pattern_id"]
        rep = next((p for p in patterns if p["pattern_id"] == typical_pid), base)
        merged["typical_raw_pattern_id"] = typical_pid
        merged["before_value"] = rep.get("before_value")
        merged["after_value"] = rep.get("after_value")
        merged["change"] = rep.get("change")
        merged["symbolic_transition"] = rep.get("symbolic_transition")
        merged["delta"] = rep.get("delta")
        merged["delta_bucket"] = rep.get("delta_bucket")
        merged["parameter_range"] = rep.get("parameter_range")
        merged["effective_parameter_range"] = rep.get("effective_parameter_range")
        merged["range_position_basis"] = rep.get("range_position_basis")
    else:
        merged["delta"] = base.get("delta")
        merged["delta_bucket"] = base.get("delta_bucket")
        merged["parameter_range"] = base.get("parameter_range")
        merged["effective_parameter_range"] = base.get("effective_parameter_range")
        merged["range_position_basis"] = base.get("range_position_basis")
        merged["before_position"] = base.get("before_position")
        merged["after_position"] = base.get("after_position")
        merged["delta_ratio"] = base.get("delta_ratio")
        merged["before_zone"] = base.get("before_zone")
        merged["after_zone"] = base.get("after_zone")
        merged["normalized_adjustment_shape"] = base.get("normalized_adjustment_shape")
        merged["normalized_shape_id"] = base.get("normalized_shape_id")

    return merged


def build_strategy_memories(traces: list[dict], evidence_by_trace: dict) -> list[dict]:
    traces = _ensure_evidence_authority(traces)
    bucket: dict[tuple[str, str, str, str, str, str], list[tuple[dict, dict, dict]]] = defaultdict(list)
    for tr, a in _flat_actions(traces):
        if not _is_effective_component(a):
            continue
        issue = _trace_issue_type(tr)
        vendor = tr["ticket"].get("vendor") or "未知厂家"
        system = tr["ticket"].get("system") or "未知制式"
        scheme_id = a.get("scheme_id") or "unknown"
        semantic_id = _semantic_param_id(a, tr["ticket"])
        pattern = _value_pattern(a, tr.get("ticket"))
        bucket[(issue, vendor, system, scheme_id, semantic_id, _strategy_pattern_key(pattern, tr.get("ticket")))].append((tr, a, pattern))

    out: list[dict] = []
    for (issue, vendor, system, scheme_id, semantic_id, pattern_id), pairs in bucket.items():
        trace_ids = sorted({tr["trace_id"] for tr, _, _ in pairs})
        evs: list[str] = []
        for tid in trace_ids:
            evs.extend(_evidence_ids_for_trace(evidence_by_trace, tid, ["strategy_evidence", "evaluation_evidence"]))

        pass_trace_ids = {
            tr["trace_id"] for tr, a, _ in pairs
            if _is_effect_evaluable(a)
            and a.get("long_eval_result") == "long_eval_pass"
        }
        fail_trace_ids = {
            tr["trace_id"] for tr, a, _ in pairs
            if _is_effect_evaluable(a)
            and a.get("long_eval_result") == "long_eval_fail"
        }
        unknown_trace_ids = {
            tr["trace_id"] for tr, a, _ in pairs
            if a.get("maximum_attribution_scope") == "action_direct"
            and not a.get("result_evidence_eligible")
        }
        component_associated_trace_ids = {
            tr["trace_id"] for tr, a, _ in pairs
            if _is_bundle_component_association(a)
        }
        unresolved_relation_trace_ids = {
            tr["trace_id"] for tr, a, _ in pairs
            if a.get("maximum_attribution_scope") == "unresolved"
        }
        pass_n = len(pass_trace_ids)
        fail_n = len(fail_trace_ids)
        unknown_n = len(unknown_trace_ids)
        component_associated_n = len(component_associated_trace_ids)
        unresolved_relation_n = len(unresolved_relation_trace_ids)
        direct_evidence_n = pass_n + fail_n + unknown_n
        exec_fail_n = sum(1 for _, a, _ in pairs if a.get("exec_state") == "exec_failed")
        audit_to = sum(1 for _, a, _ in pairs if a.get("exec_state") == "audit_timeout")

        change_counts = Counter(p["change"] for _, _, p in pairs)
        typical_change = change_counts.most_common(1)[0][0] if change_counts else "未知"
        pattern = pairs[0][2]
        pattern_label = _strategy_pattern_label(pattern)
        delta_counts = Counter(
            p.get("delta_bucket")
            for _, _, p in pairs
            if p.get("delta_bucket") is not None
        )
        param_obj = next((a.get("param_object") for _, a, _ in pairs if a.get("param_object")), None)
        param_en = next((a.get("param_en_name") for _, a, _ in pairs if a.get("param_en_name")), None)
        site_param_obj = next((a.get("site_param_object") for _, a, _ in pairs if a.get("site_param_object")), None)
        site_param_en = next((a.get("site_param_en_name") for _, a, _ in pairs if a.get("site_param_en_name")), None)
        param_cn = next((a.get("param_cn_name") for _, a, _ in pairs if a.get("param_cn_name")), None)
        operation_summaries = Counter(a.get("operation_summary") for _, a, _ in pairs if a.get("operation_summary"))
        operation_delta_hints = Counter(a.get("operation_delta_hint") for _, a, _ in pairs if a.get("operation_delta_hint"))
        operation_details = Counter(a.get("operation_detail") for _, a, _ in pairs if a.get("operation_detail"))
        parameter_groups = Counter(a.get("parameter_group") for _, a, _ in pairs if a.get("parameter_group"))
        final_ratios = Counter(a.get("final_ratio") for _, a, _ in pairs if a.get("final_ratio"))
        adjustment_rule = Counter(a.get("adjustment_rule") for _, a, _ in pairs if a.get("adjustment_rule")).most_common(1)
        adjustment = adjustment_rule[0][0] if adjustment_rule else None
        pr = _pass_rate(pass_n, fail_n)
        title = f"{issue}·{vendor}·{scheme_id}·{param_cn or param_en or param_obj}·{pattern_label}"
        summary = (
            f"{issue}: {vendor}/{system} 方案 {scheme_id} 对 {param_cn or param_en or param_obj} 执行 {pattern_label}，"
            f"典型变化 {typical_change}，"
            f"通过率 {pr:.2f}({pass_n}/{pass_n+fail_n})。"
        )

        regions = Counter(tr["ticket"].get("region") for tr, _, _ in pairs if tr["ticket"].get("region"))
        indoor_outdoor = Counter(tr["ticket"].get("is_indoor") for tr, _, _ in pairs if tr["ticket"].get("is_indoor"))
        bands = Counter(tr["ticket"].get("band") for tr, _, _ in pairs if tr["ticket"].get("band"))
        cover_areas = Counter(tr["ticket"].get("cover_area") for tr, _, _ in pairs if tr["ticket"].get("cover_area"))
        antenna_types = Counter(tr["ticket"].get("antenna_type") for tr, _, _ in pairs if tr["ticket"].get("antenna_type"))
        scheme_groups = Counter(a.get("scheme_group") for _, a, _ in pairs if a.get("scheme_group"))
        root_causes = Counter(
            _root_cause_for_action(a)
            for _, a, _ in pairs
            if _root_cause_for_action(a) != "未知根因"
        )
        primary_root_cause = root_causes.most_common(1)[0][0] if root_causes else "未知根因"
        action_ontology_labels = [_action_ontology_label(tr, a) for tr, a, _ in pairs]
        action_ontology_summary = _action_ontology_summary(action_ontology_labels)
        before_nums = [p["before_numeric"] for _, _, p in pairs if p["before_numeric"] is not None]
        after_nums = [p["after_numeric"] for _, _, p in pairs if p["after_numeric"] is not None]
        before_positions = [p["before_position"] for _, _, p in pairs if p.get("before_position") is not None]
        after_positions = [p["after_position"] for _, _, p in pairs if p.get("after_position") is not None]
        observed_changes = []
        for change, support in change_counts.most_common(10):
            change_pass = sum(
                1 for _, a, p in pairs
                if p["change"] == change
                and _is_effect_evaluable(a)
                and a.get("long_eval_result") == "long_eval_pass"
            )
            change_fail = sum(
                1 for _, a, p in pairs
                if p["change"] == change
                and _is_effect_evaluable(a)
                and a.get("long_eval_result") == "long_eval_fail"
            )
            change_unknown = sum(
                1 for _, a, p in pairs
                if p["change"] == change
                and a.get("maximum_attribution_scope") == "action_direct"
                and not a.get("result_evidence_eligible")
            )
            change_component_associated = sum(
                1 for _, a, p in pairs
                if p["change"] == change
                and _is_bundle_component_association(a)
            )
            sample_pattern = next((p for _, _, p in pairs if p["change"] == change), None)
            observed_changes.append({
                "change": change,
                "delta_bucket": sample_pattern.get("delta_bucket") if sample_pattern else None,
                "normalized_shape_id": sample_pattern.get("normalized_shape_id") if sample_pattern else None,
                "normalized_adjustment_shape": sample_pattern.get("normalized_adjustment_shape") if sample_pattern else None,
                "support_count": support,
                "long_eval_pass_count": change_pass,
                "long_eval_fail_count": change_fail,
                "long_eval_unknown_count": change_unknown,
                "component_associated_count": change_component_associated,
                "pass_rate": _pass_rate(change_pass, change_fail),
            })
        delta_distribution = []
        for delta_bucket, support in delta_counts.most_common(10):
            delta_pass = sum(
                1 for _, a, p in pairs
                if p.get("delta_bucket") == delta_bucket
                and _is_effect_evaluable(a)
                and a.get("long_eval_result") == "long_eval_pass"
            )
            delta_fail = sum(
                1 for _, a, p in pairs
                if p.get("delta_bucket") == delta_bucket
                and _is_effect_evaluable(a)
                and a.get("long_eval_result") == "long_eval_fail"
            )
            delta_unknown = sum(
                1 for _, a, p in pairs
                if p.get("delta_bucket") == delta_bucket
                and a.get("maximum_attribution_scope") == "action_direct"
                and not a.get("result_evidence_eligible")
            )
            delta_component_associated = sum(
                1 for _, a, p in pairs
                if p.get("delta_bucket") == delta_bucket
                and _is_bundle_component_association(a)
            )
            distinct_changes = len({p["change"] for _, _, p in pairs if p.get("delta_bucket") == delta_bucket})
            delta_distribution.append({
                "delta_bucket": delta_bucket,
                "support_count": support,
                "distinct_change_count": distinct_changes,
                "long_eval_pass_count": delta_pass,
                "long_eval_fail_count": delta_fail,
                "long_eval_unknown_count": delta_unknown,
                "component_associated_count": delta_component_associated,
                "pass_rate": _pass_rate(delta_pass, delta_fail),
            })

        shape_counts = Counter(
            p.get("normalized_shape_id")
            for _, _, p in pairs
            if p.get("normalized_shape_id")
        )
        shape_distribution = []
        for shape_id, support in shape_counts.most_common(10):
            shape_pass = sum(
                1 for _, a, p in pairs
                if p.get("normalized_shape_id") == shape_id
                and _is_effect_evaluable(a)
                and a.get("long_eval_result") == "long_eval_pass"
            )
            shape_fail = sum(
                1 for _, a, p in pairs
                if p.get("normalized_shape_id") == shape_id
                and _is_effect_evaluable(a)
                and a.get("long_eval_result") == "long_eval_fail"
            )
            shape_unknown = sum(
                1 for _, a, p in pairs
                if p.get("normalized_shape_id") == shape_id
                and a.get("maximum_attribution_scope") == "action_direct"
                and not a.get("result_evidence_eligible")
            )
            shape_component_associated = sum(
                1 for _, a, p in pairs
                if p.get("normalized_shape_id") == shape_id
                and _is_bundle_component_association(a)
            )
            example = next(
                (p.get("normalized_adjustment_shape") for _, _, p in pairs if p.get("normalized_shape_id") == shape_id),
                None,
            )
            shape_distribution.append({
                "shape_id": shape_id,
                "support_count": support,
                "long_eval_pass_count": shape_pass,
                "long_eval_fail_count": shape_fail,
                "long_eval_unknown_count": shape_unknown,
                "component_associated_count": shape_component_associated,
                "pass_rate": _pass_rate(shape_pass, shape_fail),
                "example": example,
            })

        merged_pattern = _merge_strategy_value_pattern(pattern_id, pairs, delta_distribution)
        if shape_distribution:
            merged_pattern["shape_distribution"] = shape_distribution
        pattern = merged_pattern
        parameter_value_prior = {
            "source": "train_only_observed_before_values",
            "current_value_prior_kind": "median_before_value",
            "median_current_value": _median_number(before_nums),
            "median_target_value": _median_number(after_nums),
            "median_before_position": _median_number(before_positions),
            "median_after_position": _median_number(after_positions),
            "observed_before_value_count": len(before_nums),
            "observed_after_value_count": len(after_nums),
            "parameter_range": pattern.get("parameter_range"),
            "effective_parameter_range": pattern.get("effective_parameter_range"),
            "range_position_basis": pattern.get("range_position_basis"),
            "contract": (
                "train_only fallback for Action Value Selection; use observed "
                "pre_decision_parameter_snapshot when available"
            ),
        }
        bundle_participation_prior = _bundle_participation_prior([a for _, a, _ in pairs])

        soft_features = {
            "hard_constraints": {
                "vendor": vendor,
                "system": system,
                "parameter_semantic_id": semantic_id,
            },
            "soft_signals": {
                "issue_type": issue,
                "solution_proxy_root_causes": [root for root, _ in root_causes.most_common(5)],
                "scheme_groups": [sg for sg, _ in scheme_groups.most_common(5)],
                "scheme_id": scheme_id,
                "regions": [r for r, _ in regions.most_common(8)],
                "indoor_outdoor": [v for v, _ in indoor_outdoor.most_common(4)],
                "bands": [b for b, _ in bands.most_common(8)],
                "value_pattern_id": pattern_id,
                "raw_value_pattern_ids": sorted({p["pattern_id"] for _, _, p in pairs})[:12],
                "value_type": pattern["value_type"],
                "direction": pattern["direction"],
                "delta_buckets": [d["delta_bucket"] for d in delta_distribution],
                "before_zone": pattern.get("before_zone"),
                "after_zone": pattern.get("after_zone"),
                "canonical_action_ids": action_ontology_summary.get("canonical_action_ids") or [],
                "parameter_concept_ids": action_ontology_summary.get("parameter_concept_ids") or [],
                "operation_families": action_ontology_summary.get("operation_families") or [],
                "action_ontology_status": action_ontology_summary.get("ontology_status"),
                "action_ontology_policy": action_ontology_summary.get("hard_aggregation_policy"),
            },
        }

        out.append({
            "memory_id": _mid("strategy", issue, vendor, system, scheme_id, semantic_id, pattern_id),
            "memory_type": "strategy_memory",
            "trace_ids": trace_ids,
            "evidence_ids": evs,
            "title": title,
            "summary": summary[:120],
            "applicability": {
                "issue_types": [issue],
                "root_causes": [root for root, _ in root_causes.most_common(5)],
                "solution_proxy_root_causes": [root for root, _ in root_causes.most_common(5)],
                "scheme_groups": [sg for sg, _ in scheme_groups.most_common(5)],
                "scheme_ids": [scheme_id] if scheme_id != "unknown" else [],
                "vendors": [vendor] if vendor != "未知厂家" else [],
                "regions": [r for r, _ in regions.most_common(8)],
                "indoor_outdoor": [v for v, _ in indoor_outdoor.most_common(4)],
                "bands": [b for b, _ in bands.most_common(8)],
                "systems": [system] if system != "未知制式" else [],
                "exclusions": [],
            },
            "content": {
                "issue_type": issue,
                "primary_root_cause_inferred": primary_root_cause,
                "solution_proxy_root_cause": primary_root_cause,
                "root_causes": [root for root, _ in root_causes.most_common(5)],
                "solution_proxy_root_causes": [root for root, _ in root_causes.most_common(5)],
                "root_cause_basis": {
                    "scheme_groups": [sg for sg, _ in scheme_groups.most_common(5)],
                    "evidence_quality": ROOT_CAUSE_LABEL_KIND,
                    "proxy_kind": ROOT_CAUSE_LABEL_KIND,
                    "not_for_rca_input": False,
                    "warning": ROOT_CAUSE_LABEL_NOTE,
                },
                "vendor": vendor,
                "system": system,
                "scheme_id": scheme_id,
                "param_object": param_obj,
                "param_en_name": param_en,
                "site_param_object": site_param_obj,
                "site_param_en_name": site_param_en,
                "param_cn_name": param_cn,
                "operation_summaries": [value for value, _ in operation_summaries.most_common(5)],
                "operation_delta_hints": [value for value, _ in operation_delta_hints.most_common(5)],
                "operation_details": [value for value, _ in operation_details.most_common(3)],
                "parameter_groups": [value for value, _ in parameter_groups.most_common(5)],
                "final_ratio_top": [value for value, _ in final_ratios.most_common(5)],
                "action_provenance_contract": "train_only_action_evidence_not_holdout_input",
                "action_memory_role": (
                    "outcome_profiled"
                    if direct_evidence_n > 0
                    else "structural_only"
                ),
                "maximum_attribution_scope": (
                    "action_direct"
                    if direct_evidence_n > 0
                    else "component_associated"
                ),
                "result_evidence_eligible": direct_evidence_n > 0,
                "outcome_role_counts": {
                    "support": pass_n,
                    "counter": fail_n,
                    "unresolved": unknown_n,
                },
                "evidence_channel_summary": {
                    "structural_source_count": len(trace_ids),
                    "action_direct_count": direct_evidence_n,
                    "component_associated_count": component_associated_n,
                    "unresolved_relation_count": unresolved_relation_n,
                    "result_counting_contract": (
                        "only action_direct contributes to action-level "
                        "pass/fail; component_associated preserves identity, "
                        "value, boundary, provenance, and component-of relations"
                    ),
                },
                "component_of_relations": {
                    "relation_type": "component_of",
                    "realized_bundle_trace_ids": sorted(component_associated_trace_ids),
                    "realized_bundle_trace_count": component_associated_n,
                    "playbook_memory_ids": [],
                    "playbook_count": 0,
                    "contract": (
                        "structural relation only; it does not contribute an "
                        "action-level pass/fail outcome"
                    ),
                },
                "parameter_semantic_id": semantic_id,
                "action_ontology": action_ontology_summary,
                "canonical_action_ids": action_ontology_summary.get("canonical_action_ids") or [],
                "parameter_concept_ids": action_ontology_summary.get("parameter_concept_ids") or [],
                "operation_families": action_ontology_summary.get("operation_families") or [],
                "adjustment": adjustment,
                "value_pattern": merged_pattern,
                "parameter_value_prior": parameter_value_prior,
                "typical_change": typical_change,
                "observed_changes": observed_changes,
                "matching_features": soft_features,
                "context_profile": {
                    "regions": [r for r, _ in regions.most_common(8)],
                    "indoor_outdoor": [v for v, _ in indoor_outdoor.most_common(4)],
                    "bands": [b for b, _ in bands.most_common(8)],
                    "cover_areas": [v for v, _ in cover_areas.most_common(6)],
                    "antenna_types": [v for v, _ in antenna_types.most_common(6)],
                    "field_contract": "pre_decision_context_profile_not_final_rank_feature",
                },
                "support_count": len(trace_ids),
                "evaluated_count": pass_n + fail_n,
                "long_eval_pass_count": pass_n,
                "long_eval_fail_count": fail_n,
                "long_eval_unknown_count": unknown_n,
                "pass_rate": pr,
                **({"bundle_participation_prior": bundle_participation_prior} if bundle_participation_prior else {}),
            },
            "state": "draft",
            "metrics": {
                "support_count": len(trace_ids),
                "long_eval_pass_count": pass_n,
                "long_eval_fail_count": fail_n,
                "long_eval_unknown_count": unknown_n,
                "action_direct_evidence_count": direct_evidence_n,
                "component_associated_count": component_associated_n,
                "unresolved_relation_count": unresolved_relation_n,
                "exec_fail_count": exec_fail_n,
                "audit_timeout_count": audit_to,
                "action_ontology_mapped_count": action_ontology_summary.get("mapped_count", 0),
                "action_ontology_unmapped_count": action_ontology_summary.get("unmapped_count", 0),
                "pass_rate": pr,
            },
            "score_ref": None,
            "produced_by": PRODUCER,
            "produced_at": cio.now_iso(),
            "schema_version": "1.0",
        })
    return out


# ---------- 3b. Hard support profiles：策略/组合方案内部的硬正向证据 ----------

_SUPPORT_PROFILE_MIN_SUPPORT = 50
_SUPPORT_PROFILE_MIN_PASS_LCB = 0.55
_SUPPORT_PROFILE_MAX_FAIL_COUNT = 0
_SUPPORT_PROFILE_MAX_OBJECTS = 800
_SUPPORT_ROUTING_PROFILE_MAX_OBJECTS_PER_SET = 2500

_SUPPORT_PROFILE_FAMILY_LABELS = {
    "scheme_param_direction": "同方案 + 同参数 + 同方向",
    "group_param_direction": "同方案组 + 同参数 + 同方向",
    "scheme_param_direction_value": "同方案 + 同参数 + 同方向 + 同取值形态",
    "group_param_direction_value": "同方案组 + 同参数 + 同方向 + 同取值形态",
    "issue_scheme_param_direction": "同问题 + 同方案 + 同参数 + 同方向",
    "issue_scheme_param_direction_value": "同问题 + 同方案 + 同参数 + 同方向 + 同取值形态",
    "env_issue_scheme_param_direction": "同问题 + 同厂家/制式 + 同方案 + 同参数 + 同方向",
    "env_issue_scheme_param_direction_value": "同问题 + 同厂家/制式 + 同方案 + 同参数 + 同方向 + 同取值形态",
    "boundary_region_scheme_param_direction": "同区域/频段/室分边界 + 同方案 + 同参数 + 同方向",
    "boundary_region_scheme_param_direction_value": "同区域/频段/室分边界 + 同方案 + 同参数 + 同方向 + 同取值形态",
    "canonical_action": "同动作语义",
    "canonical_action_value": "同动作语义 + 同取值形态",
}

_EMBEDDED_SUPPORT_PROFILE_CONFIG = {
    "profile_set_id": "hard_zero_fail_specific_v1",
    "profile_set_label": "Hard zero-fail support profiles（硬零失败正向画像）",
    "families": set(_SUPPORT_PROFILE_FAMILY_LABELS),
    "min_support": _SUPPORT_PROFILE_MIN_SUPPORT,
    "min_pass_lcb": _SUPPORT_PROFILE_MIN_PASS_LCB,
    "max_fail_count": _SUPPORT_PROFILE_MAX_FAIL_COUNT,
    "max_fail_rate": 0.0,
    "intended_use": "high-precision embedded support evidence",
}

_RUNTIME_SUPPORT_ROUTING_PROFILE_CONFIGS = [
    {
        **_EMBEDDED_SUPPORT_PROFILE_CONFIG,
        "intended_use": "runtime support/counter arbitration; release only with low counter prior",
    },
    {
        "profile_set_id": "recovery_zero_fail_specific_v1",
        "profile_set_label": "Zero-fail recovery support profiles（零失败恢复画像）",
        "families": set(_SUPPORT_PROFILE_FAMILY_LABELS),
        "min_support": 5,
        "min_pass_lcb": 0.50,
        "max_fail_count": 0,
        "max_fail_rate": 0.0,
        "intended_use": "runtime recovery diagnostic; zero observed failures but lower support threshold",
    },
    {
        "profile_set_id": "value_shape_balanced_v1",
        "profile_set_label": "Value-shape support profiles（值形态正向画像）",
        "families": {
            "scheme_param_direction_value",
            "group_param_direction_value",
            "issue_scheme_param_direction_value",
            "env_issue_scheme_param_direction_value",
            "boundary_region_scheme_param_direction_value",
            "canonical_action_value",
        },
        "min_support": 10,
        "min_pass_lcb": 0.60,
        "max_fail_count": None,
        "max_fail_rate": 0.30,
        "intended_use": "runtime support/counter arbitration contrast; requires low counter prior",
    },
]


def _support_profile_value_key(pattern: dict) -> str:
    if _VALUE_ABSTRACTION_MODE == "exact_identity":
        return str(pattern.get("change") or pattern.get("pattern_id") or pattern.get("value_type") or "unknown")
    return str(
        pattern.get("normalized_shape_id")
        or pattern.get("delta_bucket")
        or pattern.get("pattern_id")
        or "unknown_value"
    )


def _support_profile_group_keys(
    trace: dict,
    action: dict,
    pattern: dict,
    ontology_label: dict,
) -> dict[str, tuple[str, ...]]:
    ticket = trace.get("ticket") or {}
    issue = _trace_issue_type(trace)
    scheme_id = str(action.get("scheme_id") or "unknown_scheme")
    scheme_group = str(action.get("scheme_group") or "unknown_group")
    param = _semantic_param_id(action, ticket)
    direction = str(pattern.get("direction") or "unknown_direction")
    value_key = _support_profile_value_key(pattern)
    canonical = (
        str(ontology_label.get("canonical_action_id"))
        if ontology_label.get("ontology_status") == "mapped" and ontology_label.get("canonical_action_id")
        else ""
    )
    keys = {
        "scheme_param_direction": ("scheme_param_direction", scheme_id, param, direction),
        "group_param_direction": ("group_param_direction", scheme_group, param, direction),
        "scheme_param_direction_value": ("scheme_param_direction_value", scheme_id, param, direction, value_key),
        "group_param_direction_value": ("group_param_direction_value", scheme_group, param, direction, value_key),
        "issue_scheme_param_direction": ("issue_scheme_param_direction", issue, scheme_id, param, direction),
        "issue_scheme_param_direction_value": (
            "issue_scheme_param_direction_value",
            issue,
            scheme_id,
            param,
            direction,
            value_key,
        ),
        "env_issue_scheme_param_direction": (
            "env_issue_scheme_param_direction",
            issue,
            str(ticket.get("vendor") or "unknown_vendor"),
            str(ticket.get("system") or "unknown_system"),
            scheme_id,
            param,
            direction,
        ),
        "env_issue_scheme_param_direction_value": (
            "env_issue_scheme_param_direction_value",
            issue,
            str(ticket.get("vendor") or "unknown_vendor"),
            str(ticket.get("system") or "unknown_system"),
            scheme_id,
            param,
            direction,
            value_key,
        ),
        "boundary_region_scheme_param_direction": (
            "boundary_region_scheme_param_direction",
            str(ticket.get("region") or "unknown_region"),
            str(ticket.get("band") or "unknown_band"),
            str(ticket.get("is_indoor") or "unknown_indoor"),
            scheme_id,
            param,
            direction,
        ),
        "boundary_region_scheme_param_direction_value": (
            "boundary_region_scheme_param_direction_value",
            str(ticket.get("region") or "unknown_region"),
            str(ticket.get("band") or "unknown_band"),
            str(ticket.get("is_indoor") or "unknown_indoor"),
            scheme_id,
            param,
            direction,
            value_key,
        ),
    }
    if canonical:
        keys["canonical_action"] = ("canonical_action", canonical)
        keys["canonical_action_value"] = ("canonical_action_value", canonical, value_key)
    return keys


def _support_profile_action_sample(
    trace: dict,
    action: dict,
    pattern: dict,
    ontology_label: dict,
) -> dict:
    return {
        "scheme_id": action.get("scheme_id"),
        "scheme_group": action.get("scheme_group"),
        "param_cn_name": action.get("param_cn_name"),
        "param_object": action.get("param_object"),
        "param_en_name": action.get("param_en_name"),
        "site_param_object": action.get("site_param_object"),
        "site_param_en_name": action.get("site_param_en_name"),
        "parameter_semantic_id": _semantic_param_id(action, trace.get("ticket") or {}),
        "canonical_action_id": ontology_label.get("canonical_action_id"),
        "parameter_concept_id": ontology_label.get("parameter_concept_id"),
        "operation_family": ontology_label.get("operation_family"),
        "value_type": pattern.get("value_type"),
        "direction": pattern.get("direction"),
        "delta_bucket": pattern.get("delta_bucket"),
        "normalized_shape_id": pattern.get("normalized_shape_id"),
        "change": pattern.get("change"),
        "value_rule": action.get("value_rule"),
        "adjustment_rule": action.get("adjustment_rule"),
    }


def _support_profile_buckets(traces: list[dict]) -> dict[tuple[str, ...], list[tuple[dict, dict, dict, dict]]]:
    buckets: dict[tuple[str, ...], list[tuple[dict, dict, dict, dict]]] = defaultdict(list)
    for tr, action in _flat_actions(traces):
        if not _is_effect_evaluable(action) or not action.get("scheme_id"):
            continue
        pattern = _value_pattern(action, tr.get("ticket"))
        ontology_label = _action_ontology_label(tr, action)
        for key in _support_profile_group_keys(tr, action, pattern, ontology_label).values():
            buckets[key].append((tr, action, pattern, ontology_label))
    return buckets


def _support_profile_candidates(
    buckets: dict[tuple[str, ...], list[tuple[dict, dict, dict, dict]]],
    config: dict,
) -> list[dict]:
    families = set(config.get("families") or [])
    candidates: list[dict] = []
    for key, rows in buckets.items():
        family = key[0] if key else ""
        if families and family not in families:
            continue
        support = len(rows)
        if support < int(config.get("min_support") or 0):
            continue
        pass_n = sum(1 for _, action, _, _ in rows if action.get("long_eval_result") == "long_eval_pass")
        fail_n = sum(1 for _, action, _, _ in rows if action.get("long_eval_result") == "long_eval_fail")
        max_fail_count = config.get("max_fail_count")
        if max_fail_count is not None and fail_n > int(max_fail_count):
            continue
        fail_rate = fail_n / support if support else 0.0
        if fail_rate > float(config.get("max_fail_rate") or 0.0):
            continue
        credibility = credibility_from_counts(pass_n, fail_n)
        pass_lcb = float(credibility.get("credibility_lcb") or 0.0)
        if pass_lcb < float(config.get("min_pass_lcb") or 0.0):
            continue
        candidates.append({
            "key": key,
            "rows": rows,
            "support": support,
            "pass_n": pass_n,
            "fail_n": fail_n,
            "pass_lcb": pass_lcb,
            "posterior_mean": float(credibility.get("posterior_mean") or 0.0),
            "profile_set_id": config.get("profile_set_id"),
            "profile_set_label": config.get("profile_set_label"),
            "selection_policy": {
                "profile_set_id": config.get("profile_set_id"),
                "min_support": config.get("min_support"),
                "min_pass_lcb": config.get("min_pass_lcb"),
                "max_fail_count": config.get("max_fail_count"),
                "max_fail_rate": config.get("max_fail_rate"),
                "contract": "train_only_success_profile_not_holdout_input",
            },
            "intended_use": config.get("intended_use"),
        })
    candidates.sort(
        key=lambda row: (
            row["pass_lcb"],
            -row["fail_n"],
            row["support"],
            _SUPPORT_PROFILE_FAMILY_LABELS.get(row["key"][0], row["key"][0]),
        ),
        reverse=True,
    )
    return candidates


def build_support_profile_memories(traces: list[dict], evidence_by_trace: dict) -> list[dict]:
    """Materialize high-precision positive action profiles for strategy/playbook evidence.

    These are deliberately narrow by default: enough history, zero observed
    failed actions, and a conservative pass-rate lower bound. Broader support
    profiles stay in experiments until they prove they do not increase known
    failed-action escape. The returned entries are embedded into
    strategy_memory/playbook_memory content; they are not standalone
    MemoryObject records.
    """
    traces = _ensure_evidence_authority(traces)
    buckets = _support_profile_buckets(traces)
    candidates = _support_profile_candidates(buckets, _EMBEDDED_SUPPORT_PROFILE_CONFIG)

    out: list[dict] = []
    for item in candidates[:_SUPPORT_PROFILE_MAX_OBJECTS]:
        key = item["key"]
        rows = item["rows"]
        family = key[0]
        trace_ids = sorted({tr["trace_id"] for tr, _, _, _ in rows})
        actions = [action for _, action, _, _ in rows]
        patterns = [pattern for _, _, pattern, _ in rows]
        ontology_labels = [label for _, _, _, label in rows]
        rep_tr, rep_action, rep_pattern, rep_label = rows[0]
        issue = _trace_issue_type(rep_tr)
        context_applicability = _ticket_context_applicability([tr for tr, _, _, _ in rows])
        scheme_ids = [value for value, _ in Counter(a.get("scheme_id") for a in actions if a.get("scheme_id")).most_common(4)]
        scheme_groups = [value for value, _ in Counter(a.get("scheme_group") for a in actions if a.get("scheme_group")).most_common(4)]
        issue_types = [value for value, _ in Counter(_trace_issue_type(tr) for tr, _, _, _ in rows).most_common(4)]
        parameter_semantic_ids = [
            value
            for value, _ in Counter(_semantic_param_id(action, tr.get("ticket") or {}) for tr, action, _, _ in rows).most_common(8)
        ]
        param_names = [value for value, _ in Counter(a.get("param_cn_name") for a in actions if a.get("param_cn_name")).most_common(6)]
        param_objects = [value for value, _ in Counter(a.get("param_object") for a in actions if a.get("param_object")).most_common(6)]
        canonical_action_ids = [
            value
            for value, _ in Counter(label.get("canonical_action_id") for label in ontology_labels if label.get("canonical_action_id")).most_common(8)
        ]
        directions = [value for value, _ in Counter(p.get("direction") for p in patterns if p.get("direction")).most_common(3)]
        value_shapes = [
            value for value, _ in Counter(_support_profile_value_key(pattern) for pattern in patterns).most_common(6)
        ]
        action_profiles: list[dict] = []
        seen_samples: set[tuple[str, str, str, str]] = set()
        for tr, action, pattern, label in rows:
            sample = _support_profile_action_sample(tr, action, pattern, label)
            sample_key = (
                str(sample.get("scheme_id") or ""),
                str(sample.get("parameter_semantic_id") or ""),
                str(sample.get("direction") or ""),
                str(sample.get("normalized_shape_id") or sample.get("delta_bucket") or ""),
            )
            if sample_key in seen_samples:
                continue
            seen_samples.add(sample_key)
            action_profiles.append(sample)
            if len(action_profiles) >= 8:
                break
        evs: list[str] = []
        for tid in trace_ids:
            evs.extend(_evidence_ids_for_trace(evidence_by_trace, tid, ["strategy_evidence", "evaluation_evidence"]))
        profile_label = _SUPPORT_PROFILE_FAMILY_LABELS.get(family, family)
        param_label = param_names[0] if param_names else rep_action.get("param_en_name") or rep_action.get("param_object") or "参数"
        direction_label = directions[0] if directions else rep_pattern.get("direction") or "unknown_direction"
        pass_rate = _pass_rate(item["pass_n"], item["fail_n"])
        summary = (
            f"{profile_label}：历史成功 {item['pass_n']} / 失败 {item['fail_n']}，"
            f"保守成功率LCB {item['pass_lcb']:.2f}，用于解释“为什么敢放行”。"
        )
        out.append({
            "profile_id": _mid("support_profile", *key),
            "trace_ids": trace_ids,
            "evidence_ids": evs,
            "title": f"支持画像·{issue}·{scheme_ids[0] if scheme_ids else 'unknown'}·{param_label}·{direction_label}",
            "summary": summary[:120],
            "applicability": {
                "issue_types": issue_types,
                "scheme_groups": scheme_groups,
                "scheme_ids": scheme_ids,
                "vendors": context_applicability.get("vendors") or [],
                "regions": context_applicability.get("regions") or [],
                "indoor_outdoor": context_applicability.get("indoor_outdoor") or [],
                "bands": context_applicability.get("bands") or [],
                "systems": context_applicability.get("systems") or [],
                "exclusions": [],
            },
            "content": {
                "profile_polarity": "positive_support",
                "profile_family": family,
                "profile_family_label": profile_label,
                "profile_set_id": item.get("profile_set_id"),
                "profile_set_label": item.get("profile_set_label"),
                "profile_key": list(key),
                "profile_key_values": list(key[1:]),
                "selection_policy": item.get("selection_policy") or {},
                "quality": {
                    "support_count": item["support"],
                    "long_eval_pass_count": item["pass_n"],
                    "long_eval_fail_count": item["fail_n"],
                    "pass_rate": pass_rate,
                    "pass_credibility_lcb": round(item["pass_lcb"], 6),
                    "posterior_mean": round(item["posterior_mean"], 6),
                    "fail_rate": round(item["fail_n"] / item["support"], 6) if item["support"] else 0.0,
                },
                "issue_type": issue,
                "issue_types": issue_types,
                "scheme_ids": scheme_ids,
                "scheme_groups": scheme_groups,
                "parameter_semantic_ids": parameter_semantic_ids,
                "param_cn_names": param_names,
                "param_objects": param_objects,
                "canonical_action_ids": canonical_action_ids,
                "directions": directions,
                "value_shapes": value_shapes,
                "action_profiles": action_profiles,
                "action_ontology": _action_ontology_summary(ontology_labels),
                "warning": "正向支持画像：只说明相似动作历史成功且未观察到失败；是否自动放行仍需结合反证/否决画像。",
            },
            "state": "draft",
            "metrics": {
                "support_count": item["support"],
                "long_eval_pass_count": item["pass_n"],
                "long_eval_fail_count": item["fail_n"],
                "long_eval_unknown_count": 0,
                "exec_fail_count": 0,
                "audit_timeout_count": 0,
                "pass_rate": pass_rate,
            },
        })
    return out


def support_profiles_to_routing_profiles(profiles: list[dict]) -> list[dict]:
    """Convert full train-only support profiles into the runtime R13b sidecar.

    The embedded support profiles inside MemoryObject details are intentionally
    top-limited for UI readability. This sidecar keeps the full hard zero-fail
    profile set available for runtime support/counter arbitration.
    """
    out: dict[tuple[str, tuple[str, ...], str], dict] = {}
    for profile in profiles:
        content = profile.get("content") if isinstance(profile.get("content"), dict) else {}
        key = content.get("profile_key")
        if not isinstance(key, list) or len(key) < 2:
            continue
        key_family = str(content.get("profile_family") or key[0] or "").strip()
        key_values = [str(value) for value in key[1:] if str(value or "").strip()]
        if not key_family or len(key_values) != len(key[1:]):
            continue
        quality = content.get("quality") if isinstance(content.get("quality"), dict) else {}
        profile_set_id = str(content.get("profile_set_id") or "hard_zero_fail_specific_v1")
        profile_set_label = str(
            content.get("profile_set_label")
            or "Hard zero-fail support profiles（硬零失败正向画像）"
        )
        support_count = int(quality.get("support_count") or 0)
        pass_count = int(quality.get("long_eval_pass_count") or 0)
        fail_count = int(quality.get("long_eval_fail_count") or 0)
        pass_rate = float(quality.get("pass_rate") or 0.0)
        fail_rate = float(quality.get("fail_rate") or 0.0)
        pass_lcb = float(quality.get("pass_credibility_lcb") or 0.0)
        row = {
            "profile_id": profile.get("profile_id"),
            "profile_set_id": profile_set_id,
            "profile_set_label": profile_set_label,
            "key_family": key_family,
            "key_values": key_values,
            "support_count": support_count,
            "pass_count": pass_count,
            "fail_count": fail_count,
            "pass_rate": round(pass_rate, 6),
            "fail_rate": round(fail_rate, 6),
            "pass_lcb": round(pass_lcb, 6),
            "fail_lcb": 0.0,
            "fail_ucb": 0.0,
            "intended_use": "runtime support/counter arbitration; release only with low counter prior",
            "selection_config": content.get("selection_policy") or {},
            "source": "compile_rules.build_support_profile_memories",
        }
        dedup_key = (profile_set_id, key_family, tuple(key_values))
        prev = out.get(dedup_key)
        if prev is None or (
            float(row.get("pass_lcb") or 0.0),
            int(row.get("support_count") or 0),
        ) > (
            float(prev.get("pass_lcb") or 0.0),
            int(prev.get("support_count") or 0),
        ):
            out[dedup_key] = row
    return sorted(
        out.values(),
        key=lambda row: (
            str(row.get("profile_set_id") or ""),
            str(row.get("key_family") or ""),
            tuple(row.get("key_values") or []),
            str(row.get("profile_id") or ""),
        ),
    )


def build_support_routing_profiles_from_traces(traces: list[dict]) -> list[dict]:
    """Build runtime support-routing sidecar profiles from train-only traces.

    MemoryObject details keep the narrow hard-zero-fail support profiles for
    human inspection. Runtime arbitration also needs controlled diagnostic
    profile sets that trade precision/coverage under an explicit low-counter
    prior guard, so they are emitted only as sidecar rows.
    """
    traces = _ensure_evidence_authority(traces)
    buckets = _support_profile_buckets(traces)
    out: dict[tuple[str, str, tuple[str, ...]], dict] = {}
    for config in _RUNTIME_SUPPORT_ROUTING_PROFILE_CONFIGS:
        candidates = _support_profile_candidates(buckets, config)
        for item in candidates[:_SUPPORT_ROUTING_PROFILE_MAX_OBJECTS_PER_SET]:
            key = item["key"]
            key_family = str(key[0])
            key_values = [str(value) for value in key[1:]]
            support_count = int(item["support"])
            pass_count = int(item["pass_n"])
            fail_count = int(item["fail_n"])
            fail_rate = fail_count / support_count if support_count else 0.0
            fail_cred = credibility_from_counts(fail_count, pass_count)
            pass_lcb = round(float(item.get("pass_lcb") or 0.0), 6)
            profile_set_id = str(config["profile_set_id"])
            row = {
                "profile_id": _mid("support_routing", profile_set_id, *key),
                "profile_set_id": profile_set_id,
                "profile_set_label": config.get("profile_set_label"),
                "key_family": key_family,
                "key_values": key_values,
                "support_count": support_count,
                "pass_count": pass_count,
                "fail_count": fail_count,
                "pass_rate": round(pass_count / support_count, 6) if support_count else 0.0,
                "fail_rate": round(fail_rate, 6),
                "pass_lcb": pass_lcb,
                "fail_lcb": round(float(fail_cred.get("credibility_lcb") or 0.0), 6),
                "fail_ucb": round(1.0 - pass_lcb, 6),
                "intended_use": config.get("intended_use"),
                "selection_config": item.get("selection_policy") or {},
                "source": "compile_rules.build_support_routing_profiles_from_traces",
            }
            dedup_key = (profile_set_id, key_family, tuple(key_values))
            prev = out.get(dedup_key)
            if prev is None or (
                float(row.get("pass_lcb") or 0.0),
                -float(row.get("fail_rate") or 0.0),
                int(row.get("support_count") or 0),
            ) > (
                float(prev.get("pass_lcb") or 0.0),
                -float(prev.get("fail_rate") or 0.0),
                int(prev.get("support_count") or 0),
            ):
                out[dedup_key] = row
    return sorted(
        out.values(),
        key=lambda row: (
            str(row.get("profile_set_id") or ""),
            str(row.get("key_family") or ""),
            tuple(row.get("key_values") or []),
            str(row.get("profile_id") or ""),
        ),
    )


def _embedded_support_profile(profile: dict) -> dict:
    content = profile.get("content") or {}
    quality = content.get("quality") or profile.get("metrics") or {}
    return {
        "profile_id": profile.get("profile_id"),
        "title": profile.get("title"),
        "summary": profile.get("summary"),
        "profile_family": content.get("profile_family"),
        "profile_family_label": content.get("profile_family_label"),
        "profile_key": content.get("profile_key"),
        "quality": quality,
        "selection_policy": content.get("selection_policy") or {},
        "issue_types": content.get("issue_types") or profile.get("applicability", {}).get("issue_types") or [],
        "scheme_ids": content.get("scheme_ids") or [],
        "scheme_groups": content.get("scheme_groups") or [],
        "parameter_semantic_ids": content.get("parameter_semantic_ids") or [],
        "canonical_action_ids": content.get("canonical_action_ids") or [],
        "directions": content.get("directions") or [],
        "value_shapes": content.get("value_shapes") or [],
        "action_profiles": content.get("action_profiles") or [],
        "trace_count": len(profile.get("trace_ids") or []),
        "warning": content.get("warning"),
    }


def _top_n(items: list | None, n: int = 5) -> list:
    return list(items or [])[:n]


def _strategy_support_context(memory: dict) -> dict:
    content = memory.get("content") or {}
    pattern = content.get("value_pattern") or {}
    metrics = memory.get("metrics") or {}
    return {
        "parent_memory_id": memory.get("memory_id"),
        "parent_memory_type": memory.get("memory_type"),
        "parent_title": memory.get("title"),
        "parent_summary": memory.get("summary"),
        "parent_state": memory.get("state"),
        "parent_metrics": {
            "support_count": metrics.get("support_count"),
            "long_eval_pass_count": metrics.get("long_eval_pass_count"),
            "long_eval_fail_count": metrics.get("long_eval_fail_count"),
            "long_eval_unknown_count": metrics.get("long_eval_unknown_count"),
            "pass_rate": metrics.get("pass_rate"),
            "support_profile_count": metrics.get("support_profile_count"),
        },
        "action_identity": {
            "issue_type": content.get("issue_type"),
            "vendor": content.get("vendor"),
            "system": content.get("system"),
            "scheme_id": content.get("scheme_id"),
            "parameter_semantic_id": content.get("parameter_semantic_id"),
            "canonical_action_ids": content.get("canonical_action_ids") or [],
            "parameter_concept_ids": content.get("parameter_concept_ids") or [],
            "operation_families": content.get("operation_families") or [],
        },
        "omc_parameter_profile": {
            "param_cn_name": content.get("param_cn_name"),
            "param_object": content.get("param_object"),
            "param_en_name": content.get("param_en_name"),
            "site_param_object": content.get("site_param_object"),
            "site_param_en_name": content.get("site_param_en_name"),
            "parameter_groups": content.get("parameter_groups") or [],
            "operation_summaries": content.get("operation_summaries") or [],
            "operation_delta_hints": content.get("operation_delta_hints") or [],
            "operation_details": content.get("operation_details") or [],
            "final_ratio_top": content.get("final_ratio_top") or [],
            "adjustment": content.get("adjustment"),
        },
        "value_evidence": {
            "value_type": pattern.get("value_type"),
            "direction": pattern.get("direction"),
            "pattern_id": pattern.get("pattern_id"),
            "delta_bucket": pattern.get("delta_bucket"),
            "before_value": pattern.get("before_value"),
            "after_value": pattern.get("after_value"),
            "change": pattern.get("change"),
            "parameter_range": pattern.get("parameter_range"),
            "effective_parameter_range": pattern.get("effective_parameter_range"),
            "range_position_basis": pattern.get("range_position_basis"),
            "before_position": pattern.get("before_position"),
            "after_position": pattern.get("after_position"),
            "delta_ratio": pattern.get("delta_ratio"),
            "before_zone": pattern.get("before_zone"),
            "after_zone": pattern.get("after_zone"),
            "normalized_shape_id": pattern.get("normalized_shape_id"),
            "normalized_adjustment_shape": pattern.get("normalized_adjustment_shape"),
            "shape_distribution": _top_n(pattern.get("shape_distribution"), 5),
            "delta_distribution": _top_n(pattern.get("delta_distribution"), 5),
            "observed_changes": _top_n(content.get("observed_changes"), 5),
        },
        "context_profile": content.get("context_profile") or {},
        "matching_features": content.get("matching_features") or {},
        "sample_evidence_ref": {
            "trace_count": len(memory.get("trace_ids") or []),
            "evidence_id_count": len(memory.get("evidence_ids") or []),
            "strategy_sample_sidecar": "loaded_by_strategy_sample_panel",
        },
    }


def _playbook_support_context(memory: dict, component: dict | None = None) -> dict:
    content = memory.get("content") or {}
    metrics = memory.get("metrics") or {}
    ctx = {
        "parent_memory_id": memory.get("memory_id"),
        "parent_memory_type": memory.get("memory_type"),
        "parent_title": memory.get("title"),
        "parent_summary": memory.get("summary"),
        "parent_state": memory.get("state"),
        "parent_metrics": {
            "support_count": metrics.get("support_count"),
            "long_eval_pass_count": metrics.get("long_eval_pass_count"),
            "long_eval_fail_count": metrics.get("long_eval_fail_count"),
            "pass_rate": metrics.get("pass_rate"),
            "support_profile_count": metrics.get("support_profile_count"),
        },
        "action_identity": {
            "issue_type": content.get("issue_type"),
            "vendor": content.get("vendor"),
            "system": content.get("system"),
            "scheme_group": content.get("scheme_group"),
            "component_count": content.get("action_count"),
        },
        "context_profile": content.get("context_profile") or {},
        "sample_evidence_ref": {
            "trace_count": len(memory.get("trace_ids") or []),
            "evidence_id_count": len(memory.get("evidence_ids") or []),
            "strategy_sample_sidecar": "loaded_by_strategy_sample_panel",
        },
    }
    if component:
        ctx["component_snapshot"] = {
            "scheme_id": component.get("scheme_id"),
            "scheme_group": component.get("scheme_group"),
            "param_cn_name": component.get("param_cn_name"),
            "param_object": component.get("param_object"),
            "param_en_name": component.get("param_en_name"),
            "site_param_object": component.get("site_param_object"),
            "site_param_en_name": component.get("site_param_en_name"),
            "parameter_semantic_id": component.get("parameter_semantic_id"),
            "canonical_action_id": component.get("canonical_action_id"),
            "parameter_concept_id": component.get("parameter_concept_id"),
            "operation_family": component.get("operation_family"),
            "value_type": component.get("value_type"),
            "direction": component.get("direction"),
            "typical_change": component.get("typical_change"),
            "delta_bucket": component.get("delta_bucket"),
            "normalized_shape_id": component.get("normalized_shape_id"),
            "support_count": component.get("support_count"),
            "typical_changes": component.get("typical_changes") or [],
            "delta_buckets": component.get("delta_buckets") or [],
        }
    return ctx


def _support_profile_sort_key(profile: dict) -> tuple[float, int, str]:
    content = profile.get("content") or {}
    quality = content.get("quality") or profile.get("metrics") or {}
    return (
        float(quality.get("pass_credibility_lcb") or 0.0),
        int(quality.get("support_count") or 0),
        str(profile.get("profile_id") or ""),
    )


def _support_profile_value_from_strategy(memory: dict) -> str:
    return _support_profile_value_key((memory.get("content") or {}).get("value_pattern") or {})


def _support_profile_value_from_component(component: dict) -> str:
    return str(
        component.get("normalized_shape_id")
        or component.get("delta_bucket")
        or component.get("label")
        or component.get("typical_change")
        or "unknown_value"
    )


def _overlaps(left: list | tuple | set | None, right: list | tuple | set | None) -> bool:
    lset = {str(x) for x in (left or []) if x}
    rset = {str(x) for x in (right or []) if x}
    return bool(lset and rset and lset & rset)


def _strategy_matches_support_profile(memory: dict, profile: dict) -> bool:
    content = memory.get("content") or {}
    pattern = content.get("value_pattern") or {}
    app = memory.get("applicability") or {}
    pc = profile.get("content") or {}
    family = str(pc.get("profile_family") or "")

    directions = pc.get("directions") or []
    if directions and pattern.get("direction") not in directions:
        return False
    if family.endswith("_value") and _support_profile_value_from_strategy(memory) not in set(pc.get("value_shapes") or []):
        return False
    if family.startswith("issue") or family.startswith("env_issue"):
        if content.get("issue_type") not in set(pc.get("issue_types") or [pc.get("issue_type")]):
            return False
    if family.startswith("env_issue"):
        profile_app = profile.get("applicability") or {}
        if profile_app.get("vendors") and content.get("vendor") not in profile_app.get("vendors"):
            return False
        if profile_app.get("systems") and content.get("system") not in profile_app.get("systems"):
            return False
    if family.startswith("boundary_region"):
        profile_app = profile.get("applicability") or {}
        if profile_app.get("regions") and not _overlaps(app.get("regions"), profile_app.get("regions")):
            return False
        if profile_app.get("bands") and not _overlaps(app.get("bands"), profile_app.get("bands")):
            return False
        if profile_app.get("indoor_outdoor") and not _overlaps(app.get("indoor_outdoor"), profile_app.get("indoor_outdoor")):
            return False
    if family.startswith("scheme") or family.startswith("issue_scheme") or family.startswith("env_issue_scheme") or family.startswith("boundary_region_scheme"):
        if content.get("scheme_id") not in set(pc.get("scheme_ids") or []):
            return False
    if family.startswith("group"):
        if not _overlaps(app.get("scheme_groups") or [content.get("scheme_group")], pc.get("scheme_groups")):
            return False
    if family.startswith("canonical"):
        return _overlaps(content.get("canonical_action_ids"), pc.get("canonical_action_ids"))
    return content.get("parameter_semantic_id") in set(pc.get("parameter_semantic_ids") or [])


def attach_support_profiles_to_strategy_memories(strategies: list[dict], profiles: list[dict], limit: int = 5) -> None:
    for memory in strategies:
        if memory.get("memory_type") != "strategy_memory":
            continue
        matched = sorted(
            [profile for profile in profiles if _strategy_matches_support_profile(memory, profile)],
            key=_support_profile_sort_key,
            reverse=True,
        )[:limit]
        if not matched:
            continue
        content = memory.setdefault("content", {})
        embedded = []
        for profile in matched:
            item = _embedded_support_profile(profile)
            item["parent_evidence_context"] = _strategy_support_context(memory)
            embedded.append(item)
        content["support_profiles"] = embedded
        content["support_profile_summary"] = {
            "profile_count": len(embedded),
            "best_profile_id": embedded[0].get("profile_id"),
            "best_profile_family_label": embedded[0].get("profile_family_label"),
            "best_pass_credibility_lcb": embedded[0].get("quality", {}).get("pass_credibility_lcb"),
            "warning": "正向支持画像是本策略内部证据，不是独立放行规则；仍需结合反证/否决画像。",
        }
        memory.setdefault("metrics", {})["support_profile_count"] = len(embedded)


def _component_matches_support_profile(playbook: dict, component: dict, profile: dict) -> bool:
    pc = profile.get("content") or {}
    family = str(pc.get("profile_family") or "")
    app = playbook.get("applicability") or {}
    content = playbook.get("content") or {}
    directions = pc.get("directions") or []
    if directions and component.get("direction") not in directions:
        return False
    if family.endswith("_value") and _support_profile_value_from_component(component) not in set(pc.get("value_shapes") or []):
        return False
    if family.startswith("issue") or family.startswith("env_issue"):
        if content.get("issue_type") not in set(pc.get("issue_types") or [pc.get("issue_type")]):
            return False
    if family.startswith("env_issue"):
        profile_app = profile.get("applicability") or {}
        if profile_app.get("vendors") and content.get("vendor") not in profile_app.get("vendors"):
            return False
        if profile_app.get("systems") and content.get("system") not in profile_app.get("systems"):
            return False
    if family.startswith("boundary_region"):
        profile_app = profile.get("applicability") or {}
        if profile_app.get("regions") and not _overlaps(app.get("regions"), profile_app.get("regions")):
            return False
        if profile_app.get("bands") and not _overlaps(app.get("bands"), profile_app.get("bands")):
            return False
        if profile_app.get("indoor_outdoor") and not _overlaps(app.get("indoor_outdoor"), profile_app.get("indoor_outdoor")):
            return False
    if family.startswith("scheme") or family.startswith("issue_scheme") or family.startswith("env_issue_scheme") or family.startswith("boundary_region_scheme"):
        if component.get("scheme_id") not in set(pc.get("scheme_ids") or []):
            return False
    if family.startswith("group"):
        if component.get("scheme_group") not in set(pc.get("scheme_groups") or []):
            return False
    if family.startswith("canonical"):
        return component.get("canonical_action_id") in set(pc.get("canonical_action_ids") or [])
    return component.get("parameter_semantic_id") in set(pc.get("parameter_semantic_ids") or [])


def attach_support_profiles_to_playbook_memories(playbooks: list[dict], profiles: list[dict], limit: int = 3) -> None:
    for memory in playbooks:
        if memory.get("memory_type") != "playbook_memory":
            continue
        content = memory.setdefault("content", {})
        components = content.get("components") or []
        all_matched: dict[str, dict] = {}
        for component in components:
            matched = sorted(
                [profile for profile in profiles if _component_matches_support_profile(memory, component, profile)],
                key=_support_profile_sort_key,
                reverse=True,
            )[:limit]
            if not matched:
                continue
            embedded = []
            for profile in matched:
                item = _embedded_support_profile(profile)
                item["parent_evidence_context"] = _playbook_support_context(memory, component)
                embedded.append(item)
            component["support_profiles"] = embedded
            component["support_profile_count"] = len(embedded)
            for profile in matched:
                all_matched[str(profile.get("profile_id"))] = profile
        if all_matched:
            embedded = [
                {
                    **_embedded_support_profile(profile),
                    "parent_evidence_context": _playbook_support_context(memory),
                }
                for profile in sorted(all_matched.values(), key=_support_profile_sort_key, reverse=True)[:limit * 2]
            ]
            content["support_profiles"] = embedded
            content["support_profile_summary"] = {
                "profile_count": len(embedded),
                "covered_component_count": sum(1 for c in components if c.get("support_profiles")),
                "warning": "组合方案的正向画像来自其内部动作组件；它是支持证据，不是整包自动放行规则。",
            }
            memory.setdefault("metrics", {})["support_profile_count"] = len(embedded)


# ---------- 4. PlaybookMemory：多动作组合策略 ----------

def _action_template_signature(trace: dict, action: dict) -> str:
    pattern = _value_pattern(action)
    semantic_id = _semantic_param_id(action, trace["ticket"])
    scheme_id = action.get("scheme_id") or "unknown"
    if _STRUCTURAL_SIGNATURE_GRANULARITY_MODE != "frozen_current":
        return "|".join([
            scheme_id,
            semantic_id,
            _strategy_pattern_key(pattern, trace.get("ticket")),
        ])
    return "|".join([
        scheme_id,
        semantic_id,
        pattern["value_type"],
        str(pattern["direction"]),
    ])


def _is_effective_component(action: dict) -> bool:
    """Only successfully executed actions can be credited as playbook components."""
    return action.get("issued_state") == "下发成功" and action.get("exec_state") == "exec_success"


def _is_effect_evaluable(action: dict) -> bool:
    """Actions with a mature endpoint and action-direct write authority."""
    return (
        _is_effective_component(action)
        and action.get("maximum_attribution_scope") == "action_direct"
        and bool(action.get("result_evidence_eligible"))
        and action.get("long_eval_result") in (
            "long_eval_pass",
            "long_eval_fail",
        )
    )


def _is_bundle_component_association(action: dict) -> bool:
    """Keep the structural component relation independent of result scope.

    A deliberately authority-blind negative control may attach an action-direct
    result to a multi-action component.  That invalid result attribution must
    not erase the independently observed fact that the action was a component
    of the realized bundle.
    """
    explicit = action.get("component_of_bundle_relation")
    if explicit is not None:
        return bool(explicit)
    return action.get("maximum_attribution_scope") == "component_associated"


def _trace_bundle_outcome(trace: dict) -> str:
    """Return the outcome carried by the realized-bundle evidence channel."""
    aggregate = trace.get("aggregate") or {}
    policy = str(aggregate.get("compiled_outcome_policy") or "long_eval_only")
    if policy == "long_eval_only":
        return str(aggregate.get("ticket_outcome") or "long_eval_unknown")
    return str(
        aggregate.get("bundle_outcome")
        or aggregate.get("ticket_outcome")
        or "long_eval_unknown"
    )


def _strategy_component_lookup_key(
    issue: str,
    vendor: str,
    system: str,
    scheme_id: str,
    semantic_id: str,
    value_type: str,
    direction: str,
) -> tuple[str, str, str, str, str, str, str]:
    return (issue, vendor, system, scheme_id, semantic_id, value_type, str(direction))


def build_strategy_memory_index(strategies: list[dict]) -> dict[tuple[str, str, str, str, str, str, str], list[str]]:
    """Map playbook component signature facets to strategy_memory ids (1:N by delta_bucket)."""
    index: dict[tuple[str, str, str, str, str, str, str], list[str]] = defaultdict(list)
    for memory in strategies:
        if memory.get("memory_type") != "strategy_memory":
            continue
        content = memory.get("content") or {}
        pattern = content.get("value_pattern") or {}
        key = _strategy_component_lookup_key(
            content.get("issue_type") or "",
            content.get("vendor") or "",
            content.get("system") or "",
            content.get("scheme_id") or "unknown",
            content.get("parameter_semantic_id") or "",
            pattern.get("value_type") or "",
            pattern.get("direction") or "",
        )
        index[key].append(memory["memory_id"])
    for key in index:
        index[key] = sorted(set(index[key]))
    return dict(index)


def _action_template_entry(trace: dict, action: dict) -> dict:
    pattern = _value_pattern(action)
    l1, l2, root_key = _root_cause_parts_for_action(action)
    ontology_label = _action_ontology_label(trace, action)
    return {
        "scheme_id": action.get("scheme_id"),
        "scheme_group": action.get("scheme_group"),
        "param_cn_name": action.get("param_cn_name"),
        "param_en_name": action.get("param_en_name"),
        "param_object": action.get("param_object"),
        "site_param_object": action.get("site_param_object"),
        "site_param_en_name": action.get("site_param_en_name"),
        "parameter_group": action.get("parameter_group"),
        "root_cause_l1": l1,
        "root_cause_l2": l2,
        "root_cause_key": root_key,
        "operation_summary": action.get("operation_summary"),
        "operation_detail": action.get("operation_detail"),
        "operation_delta_hint": action.get("operation_delta_hint"),
        "parameter_semantic_id": _semantic_param_id(action, trace["ticket"]),
        "action_ontology": ontology_label,
        "canonical_action_id": ontology_label.get("canonical_action_id"),
        "parameter_concept_id": ontology_label.get("parameter_concept_id"),
        "operation_family": ontology_label.get("operation_family"),
        "action_ontology_status": ontology_label.get("ontology_status"),
        "action_ontology_policy": ontology_label.get("hard_aggregation_policy"),
        "value_type": pattern["value_type"],
        "direction": pattern["direction"],
        "label": _strategy_pattern_label(pattern),
        "typical_change": pattern.get("change"),
        "delta_bucket": pattern.get("delta_bucket"),
        "normalized_shape_id": pattern.get("normalized_shape_id"),
        "normalized_adjustment_shape": pattern.get("normalized_adjustment_shape"),
        "final_ratio": action.get("final_ratio"),
        "issued_state": action.get("issued_state"),
        "exec_state": action.get("exec_state"),
        "long_eval_result": action.get("long_eval_result"),
        "improvement_result": action.get("improvement_result"),
        "compiled_outcome_scope": action.get("compiled_outcome_scope"),
        "maximum_attribution_scope": action.get("maximum_attribution_scope"),
        "result_evidence_eligible": bool(action.get("result_evidence_eligible")),
        "associated_bundle_outcome_role": action.get("associated_bundle_outcome_role"),
        "bundle_outcome_result": action.get("bundle_outcome_result"),
    }


def build_playbook_memories(
    traces: list[dict],
    evidence_by_trace: dict,
    strategy_index: dict[tuple[str, str, str, str, str, str, str], list[str]] | None = None,
) -> list[dict]:
    """Compile trace-level action combinations into reusable playbooks.

    A playbook represents "these actions tend to appear together for this
    scene"; it complements action-level strategy_memory and avoids pretending a
    single parameter caused the whole long-evaluation result.
    """
    traces = _ensure_evidence_authority(traces)
    groups: dict[tuple[str, str, str, str, tuple[str, ...]], list[dict]] = defaultdict(list)
    for tr in traces:
        actions = tr.get("actions", [])
        effective_actions = [a for a in actions if _is_effective_component(a)]
        if len(effective_actions) < 2:
            continue
        issue = _trace_issue_type(tr)
        vendor = tr["ticket"].get("vendor") or "未知厂家"
        system = tr["ticket"].get("system") or "未知制式"
        primary_group = Counter(a.get("scheme_group") for a in effective_actions if a.get("scheme_group")).most_common(1)
        scheme_group = primary_group[0][0] if primary_group else "未知方案组"
        signature = tuple(sorted({_action_template_signature(tr, a) for a in effective_actions}))
        if not signature:
            continue
        groups[(issue, vendor, system, scheme_group, signature)].append(tr)

    out: list[dict] = []
    for (issue, vendor, system, scheme_group, signature), trs in groups.items():
        if len(trs) < 2:
            continue
        trace_ids = sorted({tr["trace_id"] for tr in trs})
        evs: list[str] = []
        pass_n = fail_n = mixed_n = unknown_n = exec_fail = audit_to = 0
        regions = Counter()
        indoor_outdoor = Counter()
        bands = Counter()
        cover_areas = Counter()
        antenna_types = Counter()
        scheme_ids = Counter()
        root_causes = Counter()
        action_templates: dict[str, list[dict]] = defaultdict(list)
        blocked_templates: dict[str, list[dict]] = defaultdict(list)
        for tr in trs:
            evs.extend(_evidence_ids_for_trace(evidence_by_trace, tr["trace_id"], ["strategy_evidence", "evaluation_evidence", "root_cause_evidence"]))
            outcome = _trace_bundle_outcome(tr)
            if outcome == "long_eval_pass":
                pass_n += 1
            elif outcome == "long_eval_fail":
                fail_n += 1
            elif outcome == "long_eval_mixed":
                mixed_n += 1
            else:
                unknown_n += 1
            exec_fail += tr.get("aggregate", {}).get("exec_failed", 0)
            audit_to += tr.get("aggregate", {}).get("audit_timeout", 0)
            if tr["ticket"].get("region"):
                regions[tr["ticket"]["region"]] += 1
            if tr["ticket"].get("is_indoor"):
                indoor_outdoor[tr["ticket"]["is_indoor"]] += 1
            if tr["ticket"].get("band"):
                bands[tr["ticket"]["band"]] += 1
            if tr["ticket"].get("cover_area"):
                cover_areas[tr["ticket"]["cover_area"]] += 1
            if tr["ticket"].get("antenna_type"):
                antenna_types[tr["ticket"]["antenna_type"]] += 1
            for a in tr.get("actions", []):
                if a.get("scheme_id"):
                    scheme_ids[a["scheme_id"]] += 1
                root = _root_cause_for_action(a)
                if root != "未知根因":
                    root_causes[root] += 1
                sig = _action_template_signature(tr, a)
                if sig in signature and _is_effective_component(a):
                    action_templates[sig].append(_action_template_entry(tr, a))
                elif not _is_effective_component(a):
                    blocked_templates[sig].append(_action_template_entry(tr, a))

        pr = _pass_rate(pass_n, fail_n)
        primary_root_cause = root_causes.most_common(1)[0][0] if root_causes else "未知根因"
        components = []
        for sig in signature:
            entries = action_templates.get(sig, [])
            if not entries:
                continue
            sample = entries[0]
            changes = Counter(e.get("typical_change") for e in entries if e.get("typical_change"))
            deltas = Counter(e.get("delta_bucket") for e in entries if e.get("delta_bucket"))
            lookup = _strategy_component_lookup_key(
                issue,
                vendor,
                system,
                sample.get("scheme_id") or "unknown",
                sample.get("parameter_semantic_id") or "",
                sample.get("value_type") or "",
                sample.get("direction") or "",
            )
            linked_strategy_ids = list((strategy_index or {}).get(lookup, []))
            components.append({
                **sample,
                "action_signature": sig,
                "linked_strategy_memory_ids": linked_strategy_ids,
                "primary_strategy_memory_id": linked_strategy_ids[0] if linked_strategy_ids else None,
                "support_count": len(entries),
                "typical_changes": [c for c, _ in changes.most_common(5)],
                "delta_buckets": [d for d, _ in deltas.most_common(5)],
                **(
                    {"bundle_participation_prior": prior}
                    if (prior := _bundle_participation_prior(entries))
                    else {}
                ),
            })
        blocked_components = []
        for sig, entries in blocked_templates.items():
            sample = entries[0]
            reasons = Counter(e.get("exec_state") or e.get("issued_state") or "unknown" for e in entries)
            blocked_components.append({
                **sample,
                "support_count": len(entries),
                "blocked_reasons": [reason for reason, _ in reasons.most_common(5)],
            })
        blocked_components.sort(key=lambda x: x["support_count"], reverse=True)
        component_ontology_labels = [
            comp["action_ontology"]
            for comp in components
            if isinstance(comp.get("action_ontology"), dict)
        ]
        component_ontology_summary = _action_ontology_summary(component_ontology_labels)

        title = f"{issue}·{vendor}·{scheme_group}·组合方案({len(components)}动作)"
        summary = (
            f"{issue}: {vendor}/{system} 在 {scheme_group} 下的 {len(components)} 个动作组合；"
            f"工单级长评估通过率 {pr:.2f}({pass_n}/{pass_n+fail_n})。"
        )
        out.append({
            "memory_id": _mid("playbook", issue, vendor, system, scheme_group, "||".join(signature)),
            "memory_type": "playbook_memory",
            "trace_ids": trace_ids,
            "evidence_ids": evs,
            "title": title,
            "summary": summary[:120],
            "applicability": {
                "issue_types": [issue],
                "root_causes": [root for root, _ in root_causes.most_common(5)],
                "solution_proxy_root_causes": [root for root, _ in root_causes.most_common(5)],
                "scheme_groups": [scheme_group] if scheme_group != "未知方案组" else [],
                "scheme_ids": [s for s, _ in scheme_ids.most_common(10)],
                "vendors": [vendor] if vendor != "未知厂家" else [],
                "regions": [r for r, _ in regions.most_common(8)],
                "indoor_outdoor": [v for v, _ in indoor_outdoor.most_common(4)],
                "bands": [b for b, _ in bands.most_common(8)],
                "systems": [system] if system != "未知制式" else [],
                "exclusions": [],
            },
            "content": {
                "issue_type": issue,
                "vendor": vendor,
                "system": system,
                "scheme_group": scheme_group,
                "primary_root_cause_inferred": primary_root_cause,
                "solution_proxy_root_cause": primary_root_cause,
                "root_causes": [root for root, _ in root_causes.most_common(5)],
                "solution_proxy_root_causes": [root for root, _ in root_causes.most_common(5)],
                "proxy_kind": ROOT_CAUSE_LABEL_KIND,
                "root_cause_proxy_not_for_rca_input": False,
                "warning": ROOT_CAUSE_LABEL_NOTE,
                "action_count": len(components),
                "maximum_attribution_scope": (
                    "bundle_direct" if pass_n + fail_n > 0 else "unresolved"
                ),
                "result_evidence_eligible": pass_n + fail_n > 0,
                "outcome_role_counts": {
                    "support": pass_n,
                    "counter": fail_n,
                    "conflict": mixed_n,
                    "unresolved": unknown_n,
                },
                "action_ontology": component_ontology_summary,
                "components": components,
                "linked_strategy_memory_ids": sorted({
                    mid
                    for comp in components
                    for mid in comp.get("linked_strategy_memory_ids", [])
                }),
                "blocked_components": blocked_components[:10],
                "matching_features": {
                    "hard_constraints": {"vendor": vendor, "system": system},
                    "soft_signals": {
                        "issue_type": issue,
                        "solution_proxy_root_causes": [root for root, _ in root_causes.most_common(5)],
                        "scheme_group": scheme_group,
                        "scheme_ids": [s for s, _ in scheme_ids.most_common(10)],
                        "regions": [r for r, _ in regions.most_common(8)],
                        "indoor_outdoor": [v for v, _ in indoor_outdoor.most_common(4)],
                        "bands": [b for b, _ in bands.most_common(8)],
                        "component_signatures": list(signature),
                        "blocked_component_signatures": list(blocked_templates.keys())[:12],
                        "canonical_action_ids": component_ontology_summary.get("canonical_action_ids") or [],
                        "parameter_concept_ids": component_ontology_summary.get("parameter_concept_ids") or [],
                        "operation_families": component_ontology_summary.get("operation_families") or [],
                        "action_ontology_status": component_ontology_summary.get("ontology_status"),
                        "action_ontology_policy": component_ontology_summary.get("hard_aggregation_policy"),
                    },
                },
                "context_profile": {
                    "regions": [r for r, _ in regions.most_common(8)],
                    "indoor_outdoor": [v for v, _ in indoor_outdoor.most_common(4)],
                    "bands": [b for b, _ in bands.most_common(8)],
                    "cover_areas": [v for v, _ in cover_areas.most_common(6)],
                    "antenna_types": [v for v, _ in antenna_types.most_common(6)],
                    "field_contract": "pre_decision_context_profile_not_final_rank_feature",
                },
                "support_count": len(trace_ids),
                "evaluated_count": pass_n + fail_n,
                "long_eval_pass_count": pass_n,
                "long_eval_fail_count": fail_n,
                "long_eval_mixed_count": mixed_n,
                "long_eval_unknown_count": unknown_n,
                "pass_rate": pr,
            },
            "state": "draft",
            "metrics": {
                "support_count": len(trace_ids),
                "long_eval_pass_count": pass_n,
                "long_eval_fail_count": fail_n,
                "long_eval_mixed_count": mixed_n,
                "long_eval_unknown_count": unknown_n,
                "exec_fail_count": exec_fail,
                "audit_timeout_count": audit_to,
                "action_ontology_mapped_count": component_ontology_summary.get("mapped_count", 0),
                "action_ontology_unmapped_count": component_ontology_summary.get("unmapped_count", 0),
                "pass_rate": pr,
            },
            "score_ref": None,
            "produced_by": PRODUCER,
            "produced_at": cio.now_iso(),
            "schema_version": "1.0",
        })
    return out


def attach_component_of_relations(
    strategies: list[dict],
    playbooks: list[dict],
) -> None:
    """Materialize reverse Action Memory → Playbook component relations."""
    playbook_ids_by_strategy: dict[str, set[str]] = defaultdict(set)
    for playbook in playbooks:
        playbook_id = str(playbook.get("memory_id") or "")
        for component in (playbook.get("content") or {}).get("components") or []:
            for strategy_id in component.get("linked_strategy_memory_ids") or []:
                playbook_ids_by_strategy[str(strategy_id)].add(playbook_id)

    for strategy in strategies:
        strategy_id = str(strategy.get("memory_id") or "")
        playbook_ids = sorted(playbook_ids_by_strategy.get(strategy_id, set()))
        content = strategy.setdefault("content", {})
        relations = content.setdefault("component_of_relations", {})
        relations.update({
            "relation_type": "component_of",
            "playbook_memory_ids": playbook_ids,
            "playbook_count": len(playbook_ids),
            "contract": (
                "structural relation only; it does not contribute an "
                "action-level pass/fail outcome"
            ),
        })


# ---------- 5. Business execution constraint (risk_memory)：业务内容约束 ----------

_MIN_PROCESS_RISK_ACTIONS = 5
_PROCESS_EXEC_FAIL_RATE = 0.20
# 近乎必然执行失败：视为系统/平台鲁棒性问题，不写入运维知识库
_SYSTEMIC_EXEC_FAIL_RATE = 0.85

_PROCESS_RISK_WARNING = (
    "业务执行约束记录（非效果知识）：仅保留参数配置约束、取值冲突等业务内容失败；"
    "403/500/权限/服务/脚本/回调/平台超时等工程故障只保留在 trace 审计，不沉淀为 memory。"
)

_PLATFORM_PROCESS_NOISE_TOKENS = (
    "403",
    "500",
    "没有访问权限",
    "授权",
    "服务未找到",
    "未解析到回显",
    "脚本制作",
    "脚本执行",
    "未生成脚本",
    "登录平台",
    "平台人员",
    "未收到清单回调",
    "清单回调",
    "下发结果未返回",
    "no modified data",
    "网元断连",
    "断连",
    "执行超时",
    "审核超时",
    "超时",
    "timeout",
    "http",
    "exception",
    "数据库",
    "接口",
    "任务号查询任务详情",
    "网元信息缺失",
    "license",
    "射频模块定时休眠",
)


def _platform_process_noise_reason(action: dict) -> str | None:
    text = " ".join(
        str(action.get(key) or "")
        for key in ("issued_detail", "exec_detail", "exec_failure_reason")
    )
    lower = text.lower()
    for token in _PLATFORM_PROCESS_NOISE_TOKENS:
        if token.lower() in lower:
            return token
    return None


def _business_execution_constraint_failure(action: dict) -> bool:
    if action.get("exec_state") != "exec_failed":
        return False
    if _platform_process_noise_reason(action):
        return False
    # 没有业务失败原因时，不把“执行失败”本身沉淀成知识。
    return bool(str(action.get("exec_failure_reason") or "").strip())


def _scheme_action_matches_risk(action: dict, risk_kind: str) -> bool:
    if risk_kind in {"business_execution_constraint", "execution_failure"}:
        return _business_execution_constraint_failure(action)
    return False


def _trace_ids_for_scheme_risk(
    pairs: list[tuple[dict, dict]],
    scheme_id: str,
    risk_kind: str,
) -> list[str]:
    """仅关联本 trace 内该方案确实存在对应流程失败的动作，避免混合工单污染成功参数。"""
    out: set[str] = set()
    for tr, action in pairs:
        if action.get("scheme_id") != scheme_id:
            continue
        if _scheme_action_matches_risk(action, risk_kind):
            out.add(tr["trace_id"])
    return sorted(out)


def build_risk_memories(traces: list[dict], evidence_by_trace: dict) -> list[dict]:
    """Compile business-level execution constraints only.

    Platform/engineering failures (403/500/permission/service/script/callback
    issues) stay in TraceRecord audit and are not converted into memory.
    Effect failures belong in counter_evidence_memory, not here.
    """
    by_scheme: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    for tr, a in _flat_actions(traces):
        s = a.get("scheme_id")
        if s:
            by_scheme[s].append((tr, a))

    out: list[dict] = []
    for scheme_id, pairs in by_scheme.items():
        n = len(pairs)
        if n < _MIN_PROCESS_RISK_ACTIONS:
            continue

        exec_fail = [a for _, a in pairs if _business_execution_constraint_failure(a)]
        platform_noise = [a for _, a in pairs if a.get("exec_state") == "exec_failed" and _platform_process_noise_reason(a)]
        exec_fail_rate = len(exec_fail) / n

        risks: list[tuple[str, list[dict], float]] = []
        if exec_fail_rate >= _PROCESS_EXEC_FAIL_RATE and exec_fail_rate < _SYSTEMIC_EXEC_FAIL_RATE:
            risks.append(("business_execution_constraint", exec_fail, exec_fail_rate))

        if not risks:
            continue

        for risk_kind, actions, rate in risks:
            trace_ids = _trace_ids_for_scheme_risk(pairs, scheme_id, risk_kind)
            if not trace_ids:
                continue
            evs: list[str] = []
            for tid in trace_ids:
                evs.extend(_evidence_ids_for_trace(evidence_by_trace, tid, ["execution_evidence"]))
            context_applicability = _ticket_context_applicability([tr for tr, _ in pairs])
            reasons = Counter()
            for a in actions:
                r = a.get("exec_failure_reason")
                if r:
                    reasons[r[:80]] += 1
            top_reasons = [r for r, _ in reasons.most_common(5)]

            risk_label = {
                "business_execution_constraint": "业务约束失败",
                "execution_failure": "业务约束失败",
            }[risk_kind]
            title = f"业务执行约束·{scheme_id}·{risk_label}"
            quote = (top_reasons[0][:30] + "...") if top_reasons else "(无原因)"
            summary = (
                f"{scheme_id} {risk_label}率 {rate:.2f}（非效果知识·不含平台工程故障）；"
                f"原因示例：\"{quote}\"。"
            )

            out.append({
                "memory_id": _mid("risk", scheme_id, risk_kind),
                "memory_type": "risk_memory",
                "trace_ids": trace_ids,
                "evidence_ids": evs,
                "title": title,
                "summary": summary[:120],
                "applicability": {
                    "issue_types": list({_trace_issue_type(tr) for tr, _ in pairs}),
                    "scheme_groups": list({a.get("scheme_group") for _, a in pairs if a.get("scheme_group")}),
                    "scheme_ids": [scheme_id],
                    "vendors": context_applicability["vendors"],
                    "regions": context_applicability["regions"],
                    "indoor_outdoor": context_applicability["indoor_outdoor"],
                    "bands": context_applicability["bands"],
                    "systems": context_applicability["systems"],
                    "exclusions": [],
                },
                "content": {
                    "scheme_id": scheme_id,
                    "risk_category": "business_execution_constraint",
                    "risk_kind": risk_kind,
                    "failure_reasons_top": top_reasons,
                    "failure_rate": round(rate, 4),
                    "action_count": n,
                    "excluded_platform_process_failure_count": len(platform_noise),
                    "warning": _PROCESS_RISK_WARNING,
                    "recommendation_hint": "仅提示参数配置约束或取值冲突；平台工程故障不参与知识沉淀",
                },
                "state": "draft",
                "metrics": {
                    "support_count": len(trace_ids),
                    "long_eval_pass_count": 0,
                    "long_eval_fail_count": 0,
                    "exec_fail_count": len(exec_fail),
                    "audit_timeout_count": 0,
                    "risk_action_count": len(actions),
                    "risk_action_rate": round(rate, 4),
                    "excluded_platform_process_failure_count": len(platform_noise),
                },
                "score_ref": None,
                "produced_by": PRODUCER,
                "produced_at": cio.now_iso(),
                "schema_version": "1.0",
            })
    return out


# ---------- 6. CounterEvidenceMemory（否决记忆）：效果已证伪 ----------

_MIN_COUNTER_TRACE_SUPPORT = 3
_MIN_COUNTER_FAIL_TRACES = 3
# 动作级聚合会把热门方案 pass 数抬高；工单级口径用略宽阈值才能沉淀否决记忆
_MAX_COUNTER_TRACE_PASS_RATE = 0.45


@dataclass(frozen=True)
class CounterEvidenceConfig:
    """Shared counter-evidence construction profile for UI compile and experiments."""

    profile_id: str = "current"
    mixed_max_pass_rate: float = _MAX_COUNTER_TRACE_PASS_RATE
    mixed_min_fail_count: int = _MIN_COUNTER_FAIL_TRACES
    mixed_min_support: int = _MIN_COUNTER_TRACE_SUPPORT
    fail_only_min_fail_count: int = _MIN_COUNTER_FAIL_TRACES
    fail_only_min_support: int = _MIN_COUNTER_TRACE_SUPPORT
    fail_only_max_pass_rate: float | None = None
    boundary_required: bool = False


DEFAULT_COUNTER_EVIDENCE_CONFIG = CounterEvidenceConfig()


def load_counter_evidence_config(path: str | Path | None = None) -> CounterEvidenceConfig:
    if not path:
        return DEFAULT_COUNTER_EVIDENCE_CONFIG
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"counter evidence config must be a JSON object: {path}")
    allowed = set(CounterEvidenceConfig.__dataclass_fields__)
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise ValueError(f"unknown counter evidence config keys {unknown}: {path}")
    return CounterEvidenceConfig(**payload)


def counter_evidence_config_dict(config: CounterEvidenceConfig | None = None) -> dict:
    return asdict(config or DEFAULT_COUNTER_EVIDENCE_CONFIG)


def _trace_scheme_eval_outcome(tr: dict, scheme_id: str) -> str | None:
    """Bundle endpoint associated with a scheme that actually participated."""
    participated = any(
        a.get("scheme_id") == scheme_id and _is_effective_component(a)
        for a in tr["actions"]
    )
    if not participated:
        return None
    outcome = _trace_bundle_outcome(tr)
    return outcome if outcome in {"long_eval_pass", "long_eval_fail"} else None


def _broad_context_outcome_priors(
    traces: list[dict],
) -> dict[tuple[str, str], dict]:
    """All-trace issue×scheme outcome denominator for broad fail-cohort hits.

    Fail-only counter evidence intentionally stores failed traces.  This side
    prior keeps the missing denominator visible, so runtime gate logic can
    distinguish "appeared in the failure library" from "statistically high
    failure context".
    """
    counts: dict[tuple[str, str], Counter] = defaultdict(Counter)
    for tr in traces:
        issue = _trace_issue_type(tr)
        seen_schemes: set[str] = set()
        for a in tr["actions"]:
            scheme_id = a.get("scheme_id")
            if not scheme_id or scheme_id in seen_schemes:
                continue
            seen_schemes.add(scheme_id)
            outcome = _trace_scheme_eval_outcome(tr, scheme_id)
            if outcome == "long_eval_pass":
                counts[(issue, scheme_id)]["long_eval_pass_count"] += 1
            elif outcome == "long_eval_fail":
                counts[(issue, scheme_id)]["long_eval_fail_count"] += 1
            else:
                counts[(issue, scheme_id)]["long_eval_unknown_count"] += 1

    priors: dict[tuple[str, str], dict] = {}
    for (issue, scheme_id), counter in counts.items():
        pass_n = int(counter.get("long_eval_pass_count") or 0)
        fail_n = int(counter.get("long_eval_fail_count") or 0)
        unknown_n = int(counter.get("long_eval_unknown_count") or 0)
        evaluated = pass_n + fail_n
        support = evaluated + unknown_n
        failure_cred = credibility_from_counts(fail_n, pass_n)
        pass_cred = credibility_from_counts(pass_n, fail_n)
        priors[(issue, scheme_id)] = {
            "aggregation": "all_trace_issue_scheme",
            "issue_type": issue,
            "scheme_id": scheme_id,
            "support_count": support,
            "evaluated_count": evaluated,
            "long_eval_pass_count": pass_n,
            "long_eval_fail_count": fail_n,
            "long_eval_unknown_count": unknown_n,
            "pass_rate": round(pass_n / evaluated, 4) if evaluated else 0.0,
            "failure_rate": round(fail_n / evaluated, 4) if evaluated else 0.0,
            "failure_posterior_mean": failure_cred["posterior_mean"],
            "failure_lcb": failure_cred["credibility_lcb"],
            "pass_credibility_lcb": pass_cred["credibility_lcb"],
            "lcb_quantile": failure_cred["lcb_quantile"],
            "contract": (
                "train_only all traces for the same issue×scheme; "
                "unknown is counted in support but excluded from pass/fail rates"
            ),
        }
    return priors


def _action_shape_outcome_priors(
    traces: list[dict],
) -> dict[tuple[str, ...], dict]:
    """Train-only pass/fail priors for action-specific counter routing.

    Counter evidence memories are anchored at issue×scheme for safety, but the
    runtime arbitration needs a narrower denominator when a candidate action has
    an explicit parameter, direction, and value shape. These priors are computed
    from all effect-evaluable train actions and attached to counter action
    profiles without using dev/holdout labels.
    """
    counts: dict[tuple[str, ...], Counter] = defaultdict(Counter)
    for tr, action in _flat_actions(traces):
        if not _is_effect_evaluable(action) or not action.get("scheme_id"):
            continue
        pattern = _value_pattern(action, tr.get("ticket"))
        ticket = tr.get("ticket") or {}
        issue = _trace_issue_type(tr)
        vendor = str(ticket.get("vendor") or "unknown_vendor")
        system = str(ticket.get("system") or "unknown_system")
        region = str(ticket.get("region") or "unknown_region")
        band = str(ticket.get("band") or "unknown_band")
        indoor = str(ticket.get("is_indoor") or "unknown_indoor")
        scheme_id = str(action.get("scheme_id") or "unknown_scheme")
        param = _semantic_param_id(action, tr.get("ticket") or {})
        direction = str(pattern.get("direction") or "unknown_direction")
        outcome = str(action.get("long_eval_result") or "")
        direction_keys = [
            ("issue_scheme_param_direction", issue, scheme_id, param, direction),
            ("env_issue_scheme_param_direction", issue, vendor, system, scheme_id, param, direction),
            ("boundary_region_scheme_param_direction", region, band, indoor, scheme_id, param, direction),
            (
                "context_issue_scheme_param_direction",
                issue,
                vendor,
                system,
                region,
                band,
                indoor,
                scheme_id,
                param,
                direction,
            ),
        ]
        for direction_key in direction_keys:
            counts[direction_key][outcome] += 1
        value_key = _support_profile_value_key(pattern)
        if value_key:
            shape_keys = [
                (
                    "issue_scheme_param_direction_value",
                    issue,
                    scheme_id,
                    param,
                    direction,
                    value_key,
                ),
                (
                    "env_issue_scheme_param_direction_value",
                    issue,
                    vendor,
                    system,
                    scheme_id,
                    param,
                    direction,
                    value_key,
                ),
                (
                    "boundary_region_scheme_param_direction_value",
                    region,
                    band,
                    indoor,
                    scheme_id,
                    param,
                    direction,
                    value_key,
                ),
                (
                    "context_issue_scheme_param_direction_value",
                    issue,
                    vendor,
                    system,
                    region,
                    band,
                    indoor,
                    scheme_id,
                    param,
                    direction,
                    value_key,
                ),
            ]
            for shape_key in shape_keys:
                counts[shape_key][outcome] += 1

    priors: dict[tuple[str, ...], dict] = {}
    for key, counter in counts.items():
        pass_n = int(counter.get("long_eval_pass") or 0)
        fail_n = int(counter.get("long_eval_fail") or 0)
        evaluated = pass_n + fail_n
        if not evaluated:
            continue
        failure_cred = credibility_from_counts(fail_n, pass_n)
        pass_cred = credibility_from_counts(pass_n, fail_n)
        family = key[0]
        key_values = list(key[1:])
        record = {
            "aggregation": key[0],
            "key_values": key_values,
            "support_count": evaluated,
            "evaluated_count": evaluated,
            "long_eval_pass_count": pass_n,
            "long_eval_fail_count": fail_n,
            "pass_rate": round(pass_n / evaluated, 4),
            "failure_rate": round(fail_n / evaluated, 4),
            "failure_posterior_mean": failure_cred["posterior_mean"],
            "failure_lcb": failure_cred["credibility_lcb"],
            "pass_credibility_lcb": pass_cred["credibility_lcb"],
            "lcb_quantile": failure_cred["lcb_quantile"],
            "maximum_attribution_scope": "action_direct",
            "contract": (
                "train_only action-direct action-shape pass/fail prior; "
                "no multi-action component labels and no dev/holdout labels"
            ),
        }
        if family.startswith("issue_scheme"):
            record.update({
                "issue_type": key_values[0],
                "scheme_id": key_values[1],
                "parameter_semantic_id": key_values[2],
                "direction": key_values[3],
            })
            if family.endswith("_value"):
                record["value_shape"] = key_values[4]
        elif family.startswith("env_issue_scheme"):
            record.update({
                "issue_type": key_values[0],
                "vendor": key_values[1],
                "system": key_values[2],
                "scheme_id": key_values[3],
                "parameter_semantic_id": key_values[4],
                "direction": key_values[5],
            })
            if family.endswith("_value"):
                record["value_shape"] = key_values[6]
        elif family.startswith("boundary_region_scheme"):
            record.update({
                "region": key_values[0],
                "band": key_values[1],
                "is_indoor": key_values[2],
                "scheme_id": key_values[3],
                "parameter_semantic_id": key_values[4],
                "direction": key_values[5],
            })
            if family.endswith("_value"):
                record["value_shape"] = key_values[6]
        elif family.startswith("context_issue_scheme"):
            record.update({
                "issue_type": key_values[0],
                "vendor": key_values[1],
                "system": key_values[2],
                "region": key_values[3],
                "band": key_values[4],
                "is_indoor": key_values[5],
                "scheme_id": key_values[6],
                "parameter_semantic_id": key_values[7],
                "direction": key_values[8],
            })
            if family.endswith("_value"):
                record["value_shape"] = key_values[9]
        priors[key] = record
    return priors


def _counter_exclusions_from_traces(
    trace_outcomes: list[tuple[dict, str]],
) -> tuple[list[str], list[str]]:
    failed_traces = [tr for tr, outcome in trace_outcomes if outcome == "long_eval_fail"]
    regions_fail = Counter(
        tr["ticket"].get("region") for tr in failed_traces if tr["ticket"].get("region")
    )
    scenes_fail = Counter()
    for tr in failed_traces:
        p = tr["ticket"].get("province_issue_type")
        if p and "{" in p and "}" in p:
            scenes_fail[p[p.index("{") + 1 : p.index("}")]] += 1

    exclusions: list[str] = []
    for r, n in regions_fail.most_common(3):
        if n >= max(2, len(failed_traces) * 0.4):
            exclusions.append(f"区域: {r}")
    for sc, n in scenes_fail.most_common(3):
        if n >= max(2, len(failed_traces) * 0.4):
            exclusions.append(f"场景: {sc}")
    if not exclusions:
        exclusions = ["该问题类型下整体长评估通过率偏低"]
    return exclusions, sorted({tr["trace_id"] for tr in failed_traces})


def _counter_action_profile(
    trace_outcomes: list[tuple[dict, str]],
    scheme_id: str,
    *,
    action_shape_priors: dict[tuple[str, ...], dict] | None = None,
) -> dict:
    """Describe failed actions behind an issue×scheme counter evidence bucket."""
    action_shape_priors = action_shape_priors or {}
    failed_traces = [tr for tr, outcome in trace_outcomes if outcome == "long_eval_fail"]
    trace_actions = [
        (tr, a)
        for tr in failed_traces
        for a in tr["actions"]
        if a.get("scheme_id") == scheme_id and _is_effective_component(a)
    ]

    def top_values(field: str, limit: int = 6) -> list[str]:
        values = Counter(str(a.get(field)) for _, a in trace_actions if a.get(field))
        return [value for value, _ in values.most_common(limit)]

    action_profiles: list[dict] = []
    grouped_actions: dict[tuple[str, str, str, str], list[tuple[dict, dict, dict, dict]]] = defaultdict(list)
    for tr, a in trace_actions:
        value_pattern = _value_pattern(a, tr["ticket"])
        ontology_label = _action_ontology_label(tr, a)
        semantic_id = _semantic_param_id(a, tr["ticket"])
        value_shape = _support_profile_value_key(value_pattern)
        key = (
            str(semantic_id or ""),
            str(a.get("param_cn_name") or a.get("param_object") or a.get("param_en_name") or ""),
            str(value_pattern.get("direction") or ""),
            str(value_shape or ""),
        )
        grouped_actions[key].append((tr, a, value_pattern, ontology_label))

    grouped_rows = sorted(
        grouped_actions.values(),
        key=lambda rows: (
            len(rows),
            str(rows[0][1].get("param_cn_name") or ""),
            str(_support_profile_value_key(rows[0][2]) or ""),
        ),
        reverse=True,
    )
    for rows in grouped_rows:
        tr, a, value_pattern, ontology_label = rows[0]
        attribution_scopes = {
            str(row_action.get("maximum_attribution_scope") or "unresolved")
            for _, row_action, _, _ in rows
        }
        profile_scope = (
            "action_direct"
            if attribution_scopes == {"action_direct"}
            else "component_associated"
        )
        semantic_id = _semantic_param_id(a, tr["ticket"])
        direction = str(value_pattern.get("direction") or "unknown_direction")
        value_shape = _support_profile_value_key(value_pattern)
        issue = _trace_issue_type(tr)
        ticket = tr.get("ticket") or {}
        vendor = str(ticket.get("vendor") or "unknown_vendor")
        system = str(ticket.get("system") or "unknown_system")
        region = str(ticket.get("region") or "unknown_region")
        band = str(ticket.get("band") or "unknown_band")
        indoor = str(ticket.get("is_indoor") or "unknown_indoor")
        direction_key = ("issue_scheme_param_direction", issue, scheme_id, semantic_id, direction)
        value_key = (
            "issue_scheme_param_direction_value",
            issue,
            scheme_id,
            semantic_id,
            direction,
            value_shape,
        )
        env_direction_key = (
            "env_issue_scheme_param_direction",
            issue,
            vendor,
            system,
            scheme_id,
            semantic_id,
            direction,
        )
        env_value_key = (
            "env_issue_scheme_param_direction_value",
            issue,
            vendor,
            system,
            scheme_id,
            semantic_id,
            direction,
            value_shape,
        )
        boundary_direction_key = (
            "boundary_region_scheme_param_direction",
            region,
            band,
            indoor,
            scheme_id,
            semantic_id,
            direction,
        )
        boundary_value_key = (
            "boundary_region_scheme_param_direction_value",
            region,
            band,
            indoor,
            scheme_id,
            semantic_id,
            direction,
            value_shape,
        )
        context_direction_key = (
            "context_issue_scheme_param_direction",
            issue,
            vendor,
            system,
            region,
            band,
            indoor,
            scheme_id,
            semantic_id,
            direction,
        )
        context_value_key = (
            "context_issue_scheme_param_direction_value",
            issue,
            vendor,
            system,
            region,
            band,
            indoor,
            scheme_id,
            semantic_id,
            direction,
            value_shape,
        )
        direction_prior = action_shape_priors.get(direction_key)
        value_prior = action_shape_priors.get(value_key)
        env_direction_prior = action_shape_priors.get(env_direction_key)
        env_value_prior = action_shape_priors.get(env_value_key)
        boundary_direction_prior = action_shape_priors.get(boundary_direction_key)
        boundary_value_prior = action_shape_priors.get(boundary_value_key)
        context_direction_prior = action_shape_priors.get(context_direction_key)
        context_value_prior = action_shape_priors.get(context_value_key)
        context_conditioned_priors = [
            prior
            for prior in (
                env_direction_prior,
                env_value_prior,
                boundary_direction_prior,
                boundary_value_prior,
                context_direction_prior,
                context_value_prior,
            )
            if prior
        ]
        action_profiles.append({
            "scheme_id": a.get("scheme_id"),
            "scheme_group": a.get("scheme_group"),
            "param_cn_name": a.get("param_cn_name"),
            "param_object": a.get("param_object"),
            "param_en_name": a.get("param_en_name"),
            "site_param_object": a.get("site_param_object"),
            "site_param_en_name": a.get("site_param_en_name"),
            "parameter_group": a.get("parameter_group"),
            "parameter_semantic_id": semantic_id,
            "action_ontology": ontology_label,
            "canonical_action_id": ontology_label.get("canonical_action_id"),
            "parameter_concept_id": ontology_label.get("parameter_concept_id"),
            "operation_family": ontology_label.get("operation_family"),
            "action_ontology_status": ontology_label.get("ontology_status"),
            "action_ontology_policy": ontology_label.get("hard_aggregation_policy"),
            "operation_summary": a.get("operation_summary"),
            "operation_delta_hint": a.get("operation_delta_hint"),
            "value_type": value_pattern.get("value_type"),
            "direction": value_pattern.get("direction"),
            "delta_bucket": value_pattern.get("delta_bucket"),
            "normalized_shape_id": value_pattern.get("normalized_shape_id"),
            "value_shape": value_shape,
            "change": value_pattern.get("change"),
            "before_position": value_pattern.get("before_position"),
            "after_position": value_pattern.get("after_position"),
            "before_zone": value_pattern.get("before_zone"),
            "after_zone": value_pattern.get("after_zone"),
            "before_value": a.get("before_value"),
            "after_value": a.get("after_value"),
            "value_rule": a.get("value_rule"),
            "adjustment_rule": a.get("adjustment_rule"),
            "final_ratio": a.get("final_ratio"),
            "scheme_type3": a.get("scheme_type3"),
            "failed_action_count_in_counter_bucket": len(rows),
            "maximum_attribution_scope": profile_scope,
            "result_evidence_eligible": profile_scope == "action_direct",
            "associated_bundle_outcome_role": "counter",
            "attribution_contract": (
                "action-direct only when every contributing row has a local "
                "single-action endpoint; otherwise this is a bundle-component association"
            ),
            "direction_outcome_prior": direction_prior or {},
            "value_shape_outcome_prior": value_prior or {},
            "env_direction_outcome_prior": env_direction_prior or {},
            "env_value_shape_outcome_prior": env_value_prior or {},
            "boundary_direction_outcome_prior": boundary_direction_prior or {},
            "boundary_value_shape_outcome_prior": boundary_value_prior or {},
            "context_direction_outcome_prior": context_direction_prior or {},
            "context_value_shape_outcome_prior": context_value_prior or {},
            "context_conditioned_outcome_priors": context_conditioned_priors,
        })
        if len(action_profiles) >= 8:
            break

    return {
        "scheme_group": top_values("scheme_group", 1)[0] if top_values("scheme_group", 1) else None,
        "scheme_groups": top_values("scheme_group", 4),
        "param_cn_names": top_values("param_cn_name"),
        "param_objects": top_values("param_object"),
        "param_en_names": top_values("param_en_name"),
        "site_param_objects": top_values("site_param_object"),
        "site_param_en_names": top_values("site_param_en_name"),
        "parameter_groups": top_values("parameter_group"),
        "operation_summaries": top_values("operation_summary"),
        "operation_delta_hints": top_values("operation_delta_hint"),
        "action_provenance_contract": "train_only_action_evidence_not_holdout_input",
        "action_profiles": action_profiles,
        "action_ontology": _action_ontology_summary([
            profile["action_ontology"]
            for profile in action_profiles
            if isinstance(profile.get("action_ontology"), dict)
        ]),
    }


def _append_counter_evidence(
    out: list[dict],
    *,
    memory_id: str,
    issue: str,
    scheme_id: str,
    pass_n: int,
    fail_n: int,
    pr: float,
    trace_ids: list[str],
    failed_trace_ids: list[str],
    exclusions: list[str],
    context_applicability: dict[str, list[str]],
    evidence_by_trace: dict,
    aggregation: str,
    extra_content: dict | None = None,
) -> None:
    extra_content = extra_content or {}
    scheme_label = extra_content.get("scheme_group")
    scheme_display = f"{scheme_label}（{scheme_id}）" if scheme_label else scheme_id
    broad_prior = extra_content.get("broad_context_outcome_prior")
    if aggregation == "fail_ticket_issue_scheme":
        prior_note = ""
        if isinstance(broad_prior, dict) and broad_prior.get("evaluated_count"):
            prior_note = (
                f"；全量同场景失败 {broad_prior.get('long_eval_fail_count', 0)} / "
                f"通过 {broad_prior.get('long_eval_pass_count', 0)}，"
                f"失败率LCB {float(broad_prior.get('failure_lcb') or 0.0):.2f}"
            )
        summary = (
            f"{issue} × {scheme_display}：长评估失败工单 cohort {fail_n} 条（失败库来源{prior_note}），"
            f"方案级证伪；受限边界: {', '.join(exclusions[:2])}。"
        )
    else:
        summary = (
            f"{issue} × {scheme_display}：工单级长评估失败 {fail_n} / 通过 {pass_n}，"
            f"通过率 {pr:.2f}；受限边界: {', '.join(exclusions[:2])}。"
        )
    evs: list[str] = []
    for tid in trace_ids:
        evs.extend(_evidence_ids_for_trace(evidence_by_trace, tid, ["evaluation_evidence", "strategy_evidence"]))

    content = {
        "scheme_id": scheme_id,
        "scheme_group": scheme_label,
        "issue_type": issue,
        "evidence_category": "proven_effect_failure",
        "evaluation_basis": "exec_success_only",
        "aggregation": aggregation,
        "maximum_attribution_scope": "bundle_direct",
        "outcome_role": "counter",
        "fail_pass_ratio": f"{fail_n}:{pass_n}",
        "pass_rate": round(pr, 4),
        "narrative": summary,
        "failed_trace_ids": failed_trace_ids[:10],
        "warning": "否决记忆：已落地且长评估证伪；执行/审核失败不计入。",
    }
    content.update(extra_content)

    out.append({
        "memory_id": memory_id,
        "memory_type": "counter_evidence_memory",
        "trace_ids": trace_ids,
        "evidence_ids": evs,
        "title": f"否决记忆·{issue}·{scheme_display} 在限定条件下不再推荐",
        "summary": summary[:120],
        "applicability": {
            "issue_types": [issue],
            "scheme_groups": [scheme_label] if scheme_label else [],
            "scheme_ids": [scheme_id],
            "vendors": context_applicability.get("vendors") or [],
            "regions": context_applicability.get("regions") or [],
            "indoor_outdoor": context_applicability.get("indoor_outdoor") or [],
            "bands": context_applicability.get("bands") or [],
            "systems": context_applicability.get("systems") or [],
            "exclusions": exclusions,
        },
        "content": content,
        "state": "draft",
        "metrics": {
            "support_count": len(trace_ids),
            "long_eval_pass_count": pass_n,
            "long_eval_fail_count": fail_n,
            "exec_fail_count": 0,
            "audit_timeout_count": 0,
            "pass_rate": round(pr, 4),
        },
        "score_ref": None,
        "produced_by": PRODUCER,
        "produced_at": cio.now_iso(),
        "schema_version": "1.0",
    })


def _counter_buckets_for_traces(
    traces: list[dict],
    *,
    scheme_outcome_filter: str | None = None,
) -> dict[tuple[str, str], list[tuple[dict, str]]]:
    """按 issue×scheme 收集 (trace, scheme级长评结论)。scheme_outcome_filter 可限定仅 fail。"""
    bucket: dict[tuple[str, str], list[tuple[dict, str]]] = defaultdict(list)
    for tr in traces:
        issue = _trace_issue_type(tr)
        seen_schemes: set[str] = set()
        for a in tr["actions"]:
            scheme_id = a.get("scheme_id")
            if not scheme_id or scheme_id in seen_schemes:
                continue
            outcome = _trace_scheme_eval_outcome(tr, scheme_id)
            if not outcome:
                continue
            if scheme_outcome_filter and outcome != scheme_outcome_filter:
                continue
            seen_schemes.add(scheme_id)
            bucket[(issue, scheme_id)].append((tr, outcome))
    return bucket


def _emit_counter_buckets(
    out: list[dict],
    seen_ids: set[str],
    bucket: dict[tuple[str, str], list[tuple[dict, str]]],
    evidence_by_trace: dict,
    *,
    aggregation: str,
    memory_id_parts: tuple[str, ...],
    min_fail_traces: int,
    min_support: int,
    max_pass_rate: float | None,
    boundary_required: bool = False,
    broad_context_priors: dict[tuple[str, str], dict] | None = None,
    action_shape_priors: dict[tuple[str, ...], dict] | None = None,
) -> None:
    for (issue, scheme_id), trace_outcomes in bucket.items():
        pass_n = sum(1 for _, o in trace_outcomes if o == "long_eval_pass")
        fail_n = sum(1 for _, o in trace_outcomes if o == "long_eval_fail")
        total = pass_n + fail_n
        if total < min_support or fail_n < min_fail_traces:
            continue
        pr = pass_n / total if total else 0.0
        if max_pass_rate is not None and pr >= max_pass_rate:
            continue

        exclusions, failed_trace_ids = _counter_exclusions_from_traces(trace_outcomes)
        if boundary_required and not any(item.startswith(("区域:", "场景:")) for item in exclusions):
            continue
        action_profile = _counter_action_profile(
            trace_outcomes,
            scheme_id,
            action_shape_priors=action_shape_priors,
        )
        broad_prior = (broad_context_priors or {}).get((issue, scheme_id))
        if broad_prior:
            action_profile["broad_context_outcome_prior"] = broad_prior
        failed_context_traces = [tr for tr, outcome in trace_outcomes if outcome == "long_eval_fail"]
        context_applicability = _ticket_context_applicability(failed_context_traces or [tr for tr, _ in trace_outcomes])
        all_trace_ids = sorted({tr["trace_id"] for tr, _ in trace_outcomes})
        memory_id = _mid("counter", *memory_id_parts, issue, scheme_id)
        if memory_id in seen_ids:
            continue
        seen_ids.add(memory_id)
        _append_counter_evidence(
            out,
            memory_id=memory_id,
            issue=issue,
            scheme_id=scheme_id,
            pass_n=pass_n,
            fail_n=fail_n,
            pr=pr,
            trace_ids=all_trace_ids,
            failed_trace_ids=failed_trace_ids,
            exclusions=exclusions,
            context_applicability=context_applicability,
            evidence_by_trace=evidence_by_trace,
            aggregation=aggregation,
            extra_content=action_profile,
        )


def build_counter_evidence(
    traces: list[dict],
    evidence_by_trace: dict,
    *,
    config: CounterEvidenceConfig | None = None,
) -> list[dict]:
    """否决记忆：① 混合 cohort 低通过率；② 长评估失败工单 cohort（主路径）。"""
    traces = _ensure_evidence_authority(traces)
    cfg = config or DEFAULT_COUNTER_EVIDENCE_CONFIG
    out: list[dict] = []
    seen_ids: set[str] = set()
    broad_context_priors = _broad_context_outcome_priors(traces)
    action_shape_priors = _action_shape_outcome_priors(traces)

    # ① 效果池全量：同工单×方案 pass+fail 混桶，通过率 < 45% 且 fail trace ≥ 3
    mixed_bucket = _counter_buckets_for_traces(traces)
    _emit_counter_buckets(
        out,
        seen_ids,
        mixed_bucket,
        evidence_by_trace,
        aggregation="trace_level_issue_scheme",
        memory_id_parts=("mixed",),
        min_fail_traces=cfg.mixed_min_fail_count,
        min_support=cfg.mixed_min_support,
        max_pass_rate=cfg.mixed_max_pass_rate,
        boundary_required=cfg.boundary_required,
        broad_context_priors=broad_context_priors,
        action_shape_priors=action_shape_priors,
    )

    # ② 仅 ticket_outcome=long_eval_fail：避免被大量 pass 工单稀释；沉淀主反证来源
    fail_tickets = [t for t in traces if ticket_outcome(t) == TICKET_OUTCOME_LONG_EVAL_FAIL]
    fail_bucket = _counter_buckets_for_traces(
        fail_tickets,
        scheme_outcome_filter="long_eval_fail",
    )
    _emit_counter_buckets(
        out,
        seen_ids,
        fail_bucket,
        evidence_by_trace,
        aggregation="fail_ticket_issue_scheme",
        memory_id_parts=("failcohort",),
        min_fail_traces=cfg.fail_only_min_fail_count,
        min_support=cfg.fail_only_min_support,
        max_pass_rate=cfg.fail_only_max_pass_rate,
        boundary_required=cfg.boundary_required,
        broad_context_priors=broad_context_priors,
        action_shape_priors=action_shape_priors,
    )
    return out


def compile_all_with_sidecars(
    traces: list[dict],
    evs: list[dict],
    *,
    risk_traces: list[dict] | None = None,
    apply_effect_eligibility: bool = True,
    counter_evidence_config: CounterEvidenceConfig | None = None,
) -> tuple[list[dict], dict[str, list[dict]]]:
    """效果向记忆用 traces；risk_memory 仅从 risk_traces 中沉淀业务执行约束。"""
    global _RANGE_REPAIR_INDEX
    canonical_traces, duplicate_traces = _deduplicate_records(
        traces,
        id_field="trace_id",
        record_kind="trace",
        canonicalize=_canonicalize_trace_record,
    )
    canonical_traces, authority_manifest = materialize_evidence_authority(canonical_traces)
    canonical_evidence, duplicate_evidence = _deduplicate_records(
        evs,
        id_field="evidence_id",
        record_kind="evidence",
    )
    by_trace = _index_evidence(canonical_evidence)
    effect_traces = (
        filter_effect_traces(canonical_traces)
        if apply_effect_eligibility
        else canonical_traces
    )
    if risk_traces is None:
        risk_input = (
            list(cio.read_jsonl(P.TRACE_RECORDS_JSONL))
            if P.TRACE_RECORDS_JSONL.exists()
            else canonical_traces
        )
    else:
        risk_input = risk_traces
    risk_src, duplicate_risk_traces = _deduplicate_records(
        risk_input,
        id_field="trace_id",
        record_kind="risk trace",
        canonicalize=_canonicalize_trace_record,
    )

    _RANGE_REPAIR_INDEX = build_range_repair_index(risk_src)
    print(
        f"[compile-rules] range_repair_index keys={len(_RANGE_REPAIR_INDEX)} "
        f"from_traces={len(risk_src)}; deduplicated="
        f"trace:{duplicate_traces},evidence:{duplicate_evidence},risk:{duplicate_risk_traces}; "
        f"authority={authority_manifest['counts']}",
        file=sys.stderr,
    )

    out: list[dict] = []
    out.extend(build_case_memory(t, by_trace) for t in effect_traces)
    out.extend(build_rca_memories(effect_traces, by_trace))
    support_profiles = (
        build_support_profile_memories(effect_traces, by_trace)
        if _SUPPORT_PROFILE_CONSTRUCTION_MODE == "enabled"
        else []
    )
    strategies = build_strategy_memories(effect_traces, by_trace)
    attach_support_profiles_to_strategy_memories(strategies, support_profiles)
    strategy_index = build_strategy_memory_index(strategies)
    out.extend(strategies)
    playbooks = build_playbook_memories(effect_traces, by_trace, strategy_index)
    attach_support_profiles_to_playbook_memories(playbooks, support_profiles)
    attach_component_of_relations(strategies, playbooks)
    out.extend(playbooks)
    out.extend(build_risk_memories(risk_src, by_trace))
    out.extend(build_counter_evidence(effect_traces, by_trace, config=counter_evidence_config))
    for memory in out:
        memory["trace_ids"] = sorted(set(memory.get("trace_ids") or []))
        memory["evidence_ids"] = sorted(set(memory.get("evidence_ids") or []))
    out.sort(
        key=lambda memory: (
            str(memory.get("memory_type") or ""),
            str(memory.get("memory_id") or ""),
        )
    )
    sidecars = {
        "support_routing_profiles": (
            build_support_routing_profiles_from_traces(effect_traces)
            if _SUPPORT_PROFILE_CONSTRUCTION_MODE == "enabled"
            else []
        ),
    }
    return out, sidecars


def compile_all(
    traces: list[dict],
    evs: list[dict],
    *,
    risk_traces: list[dict] | None = None,
    apply_effect_eligibility: bool = True,
    counter_evidence_config: CounterEvidenceConfig | None = None,
) -> list[dict]:
    memories, _ = compile_all_with_sidecars(
        traces,
        evs,
        risk_traces=risk_traces,
        apply_effect_eligibility=apply_effect_eligibility,
        counter_evidence_config=counter_evidence_config,
    )
    return memories


def main():
    global _PARAMETER_SEMANTIC_MODE, _VALUE_ABSTRACTION_MODE, _ACTION_ONTOLOGY_MODE, _SUPPORT_PROFILE_CONSTRUCTION_MODE, _BUNDLE_PARTICIPATION_MODE, _STRUCTURAL_SIGNATURE_GRANULARITY_MODE
    ap = argparse.ArgumentParser()
    ap.add_argument("--traces", default=str(P.COMPILE_BATCH_JSONL))
    ap.add_argument("--evidence", default=str(P.EVIDENCE_UNITS_JSONL))
    ap.add_argument("--out", default=str(P.MEMORY_OBJECTS_JSONL))
    ap.add_argument(
        "--risk-traces",
        default="",
        help="risk_memory 业务执行约束使用的 trace（默认 data/staged/trace_records.jsonl；平台工程故障会被排除）",
    )
    ap.add_argument(
        "--disable-effect-eligibility",
        action="store_true",
        help="论文消融专用：效果向记忆使用全部输入 traces，并在 package manifest 标记 disabled",
    )
    ap.add_argument(
        "--counter-evidence-config",
        default="",
        help="否决池构建阈值 profile JSON；不传则使用产品全量编译默认 current profile",
    )
    ap.add_argument(
        "--out-support-routing-profiles",
        default=str(P.SUPPORT_ROUTING_PROFILES_JSONL),
        help="R13b runtime support/counter arbitration 的正向画像路由 sidecar",
    )
    ap.add_argument(
        "--parameter-semantic-mode",
        choices=["normalized", "raw_identity"],
        default="normalized",
        help="Construction ablation: normalized semantic key or unnormalized raw parameter identity.",
    )
    ap.add_argument(
        "--value-abstraction-mode",
        choices=["normalized", "exact_identity"],
        default="normalized",
        help="Construction ablation: normalized value shapes or exact transitions only.",
    )
    ap.add_argument(
        "--action-ontology-mode",
        choices=["reviewed_labels", "off"],
        default="reviewed_labels",
        help="Construction ablation: consume the reviewed ontology overlay or disable it before profile aggregation.",
    )
    ap.add_argument(
        "--support-profile-construction-mode",
        choices=["enabled", "off"],
        default="enabled",
        help="Construction ablation: build/attach positive support profiles and routing sidecar or disable them.",
    )
    ap.add_argument(
        "--bundle-participation-mode",
        choices=["off", "typed_weak_prior"],
        default="off",
        help="Construction candidate: retain multi-action bundle participation as a separately typed weak prior.",
    )
    ap.add_argument(
        "--structural-signature-granularity-mode",
        choices=["frozen_current", "coarse_direction", "value_shape", "value_shape_boundary"],
        default="frozen_current",
        help="Supplementary sensitivity mode for nested Action/Bundle structural identities.",
    )
    args = ap.parse_args()
    _PARAMETER_SEMANTIC_MODE = args.parameter_semantic_mode
    _VALUE_ABSTRACTION_MODE = args.value_abstraction_mode
    _ACTION_ONTOLOGY_MODE = args.action_ontology_mode
    _SUPPORT_PROFILE_CONSTRUCTION_MODE = args.support_profile_construction_mode
    _BUNDLE_PARTICIPATION_MODE = args.bundle_participation_mode
    _STRUCTURAL_SIGNATURE_GRANULARITY_MODE = args.structural_signature_granularity_mode
    P.ensure_dirs()

    traces = list(cio.read_jsonl(args.traces))
    evs = list(cio.read_jsonl(args.evidence))
    risk_traces = list(cio.read_jsonl(args.risk_traces)) if args.risk_traces else None
    effect_n = sum(1 for t in traces if is_compile_effect_eligible(t))
    print(
        f"[compile-rules] batch={len(traces)} effect_eligible={effect_n} "
        f"evidence={len(evs)} risk_source={'custom' if risk_traces else 'trace_records'}",
        file=sys.stderr,
    )

    memories, sidecars = compile_all_with_sidecars(
        traces,
        evs,
        risk_traces=risk_traces,
        apply_effect_eligibility=not args.disable_effect_eligibility,
        counter_evidence_config=load_counter_evidence_config(args.counter_evidence_config),
    )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    bad = 0
    with out_path.open("w", encoding="utf-8") as fout:
        for m in memories:
            errs = validate(m, "memory_object")
            if errs:
                bad += 1
                if bad <= 5:
                    print(f"[compile-rules] bad memory: {m['memory_id']}: {errs[:3]}", file=sys.stderr)
            fout.write(json.dumps(m, ensure_ascii=False) + "\n")
    print(f"[compile-rules] DONE: wrote {len(memories)} memories (schema_bad={bad})", file=sys.stderr)

    support_routing_path = Path(args.out_support_routing_profiles)
    support_routing_path.parent.mkdir(parents=True, exist_ok=True)
    cio.write_jsonl(support_routing_path, sidecars.get("support_routing_profiles") or [])
    print(
        f"[compile-rules] support_routing_profiles="
        f"{len(sidecars.get('support_routing_profiles') or [])} -> {support_routing_path}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
