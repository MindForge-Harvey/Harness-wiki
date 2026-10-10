"""Select a concrete action value from a strategy's child outcome statistics."""

from __future__ import annotations

import math
from typing import Any

from ..common.parameter_range import numeric_position, to_number
from ..scoring.bayesian_score import credibility_from_counts


def _count(row: dict[str, Any], key: str) -> int:
    try:
        return max(0, int(row.get(key) or 0))
    except (TypeError, ValueError):
        return 0


def _support_score(support: int) -> float:
    return min(1.0, math.log1p(max(0, support)) / math.log1p(200))


def _position_bucket(position: float | None) -> str | None:
    if position is None:
        return None
    if position < 0.05:
        return "p00_05"
    if position < 0.20:
        return "p05_20"
    if position < 0.40:
        return "p20_40"
    if position < 0.60:
        return "p40_60"
    if position < 0.80:
        return "p60_80"
    if position < 0.95:
        return "p80_95"
    return "p95_100"


def _snapshot_range(snapshot: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(snapshot, dict):
        return None
    for key in ("parameter_range", "effective_parameter_range", "range"):
        value = snapshot.get(key)
        if isinstance(value, dict) and value.get("min") is not None and value.get("max") is not None:
            return value
    if snapshot.get("min") is not None and snapshot.get("max") is not None:
        return {
            "min": snapshot.get("min"),
            "max": snapshot.get("max"),
            "step": snapshot.get("step"),
            "complete": True,
        }
    return None


def _range_midpoint(snapshot_range: dict[str, Any] | None) -> float | None:
    if not isinstance(snapshot_range, dict):
        return None
    lo = to_number(snapshot_range.get("min"))
    hi = to_number(snapshot_range.get("max"))
    if lo is None or hi is None:
        return None
    return round((lo + hi) / 2, 6)


def _current_value(snapshot: dict[str, Any] | None) -> float | None:
    if not isinstance(snapshot, dict):
        return None
    for key in ("current_value", "before_value", "value"):
        number = to_number(snapshot.get(key))
        if number is not None:
            return number
    return None


def _current_value_context(
    current_parameter_snapshot: dict[str, Any] | None,
    parameter_value_prior: dict[str, Any] | None = None,
    *,
    parameter_snapshot_match: str | None = None,
) -> dict[str, Any]:
    snapshot_range = _snapshot_range(current_parameter_snapshot)
    current = _current_value(current_parameter_snapshot)
    if snapshot_range and current is not None:
        return {
            "snapshot": current_parameter_snapshot,
            "current_value": current,
            "parameter_range": snapshot_range,
            "current_value_source": "observed_snapshot",
            "current_value_confidence": "observed",
            "target_value_confidence": "observed",
            "parameter_snapshot_match": "exact",
            "current_parameter_snapshot_used": True,
        }

    prior = parameter_value_prior if isinstance(parameter_value_prior, dict) else {}
    prior_range = _snapshot_range(prior)
    median_current = to_number(prior.get("median_current_value"))
    fallback_match = parameter_snapshot_match or (
        "ambiguous" if isinstance(current_parameter_snapshot, dict) else "missing_predicted_parameter"
    )
    if prior_range and median_current is not None:
        fallback_snapshot = {
            "current_value": median_current,
            "parameter_range": prior_range,
            "snapshot_policy": "train_median_fallback_v1",
        }
        return {
            "snapshot": fallback_snapshot,
            "current_value": median_current,
            "parameter_range": prior_range,
            "current_value_source": "train_median_fallback",
            "current_value_confidence": "imputed",
            "target_value_confidence": "imputed",
            "parameter_snapshot_match": fallback_match,
            "current_parameter_snapshot_used": False,
        }

    midpoint = _range_midpoint(prior_range)
    if prior_range and midpoint is not None:
        fallback_snapshot = {
            "current_value": midpoint,
            "parameter_range": prior_range,
            "snapshot_policy": "range_midpoint_fallback_v1",
        }
        return {
            "snapshot": fallback_snapshot,
            "current_value": midpoint,
            "parameter_range": prior_range,
            "current_value_source": "range_midpoint_fallback",
            "current_value_confidence": "imputed",
            "target_value_confidence": "imputed",
            "parameter_snapshot_match": fallback_match,
            "current_parameter_snapshot_used": False,
        }

    return {
        "snapshot": None,
        "current_value": None,
        "parameter_range": None,
        "current_value_source": "unavailable",
        "current_value_confidence": "unavailable",
        "target_value_confidence": "unavailable",
        "parameter_snapshot_match": parameter_snapshot_match or "unavailable",
        "current_parameter_snapshot_used": False,
    }


def _format_number(value: float | None) -> str:
    if value is None:
        return ""
    rounded = round(value, 6)
    if rounded == int(rounded):
        return str(int(rounded))
    return f"{rounded:g}"


def _round_to_step(value: float, step: object) -> float:
    step_num = to_number(step)
    if step_num is None or step_num <= 0:
        return round(value, 6)
    return round(round(value / step_num) * step_num, 6)


def _shape_candidate_row(
    row: dict[str, Any],
    current_parameter_snapshot: dict[str, Any] | None,
) -> dict[str, Any] | None:
    snapshot_range = _snapshot_range(current_parameter_snapshot)
    current = _current_value(current_parameter_snapshot)
    shape = row.get("example") if isinstance(row.get("example"), dict) else {}
    delta_ratio = to_number(shape.get("delta_ratio"))
    if not snapshot_range or current is None or delta_ratio is None:
        return None

    lo = to_number(snapshot_range.get("min"))
    hi = to_number(snapshot_range.get("max"))
    if lo is None or hi is None or hi == lo:
        return None

    span = hi - lo
    direction = str(shape.get("direction") or "")
    sign = -1 if direction == "decrease" else 1
    delta = _round_to_step(sign * abs(delta_ratio) * abs(span), snapshot_range.get("step"))
    if delta == 0:
        return None

    target = max(min(current + delta, max(lo, hi)), min(lo, hi))
    current_position = numeric_position(current, {**snapshot_range, "complete": True})
    current_bucket = _position_bucket(current_position)
    expected_bucket = shape.get("before_position_bucket")
    location_match = current_bucket is not None and current_bucket == expected_bucket
    return {
        "source": "shape_distribution",
        "suggested_delta": f"{delta:+g}",
        "target_value": _format_number(target),
        "normalized_shape_id": row.get("shape_id"),
        "current_position": current_position,
        "current_position_bucket": current_bucket,
        "shape_before_position_bucket": expected_bucket,
        "shape_location_match": location_match,
        **row,
    }


def _row_score(row: dict[str, Any]) -> dict[str, Any]:
    passed = _count(row, "long_eval_pass_count")
    failed = _count(row, "long_eval_fail_count")
    support = _count(row, "support_count")
    bayes = credibility_from_counts(passed, failed)
    lcb = float(bayes["credibility_lcb"])
    location_bonus = 0.05 if row.get("shape_location_match") else 0.0
    score = round(min(1.0, lcb * 0.8 + _support_score(support) * 0.2 + location_bonus), 6)
    return {
        "score": score,
        "credibility_lcb": lcb,
        "support_score": round(_support_score(support), 6),
        "support_count": support,
        "long_eval_pass_count": passed,
        "long_eval_fail_count": failed,
        "pass_rate": row.get("pass_rate"),
    }


def _candidate_rows(
    value_pattern: dict[str, Any],
    observed_changes: list[dict[str, Any]] | None = None,
    current_parameter_snapshot: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in value_pattern.get("shape_distribution") or []:
        if isinstance(row, dict):
            shape_row = _shape_candidate_row(row, current_parameter_snapshot)
            if shape_row:
                rows.append(shape_row)
    for row in value_pattern.get("delta_distribution") or []:
        if isinstance(row, dict) and row.get("delta_bucket") is not None:
            rows.append({
                "source": "delta_distribution",
                "suggested_delta": row.get("delta_bucket"),
                "normalized_shape_id": None,
                **row,
            })
    for row in observed_changes or value_pattern.get("observed_changes") or []:
        if isinstance(row, dict) and row.get("delta_bucket") is not None:
            rows.append({
                "source": "observed_changes",
                "suggested_delta": row.get("delta_bucket"),
                "normalized_shape_id": row.get("normalized_shape_id"),
                **row,
            })
    return rows


def select_action_value(
    value_pattern: dict[str, Any] | None,
    *,
    observed_changes: list[dict[str, Any]] | None = None,
    current_parameter_snapshot: dict[str, Any] | None = None,
    parameter_value_prior: dict[str, Any] | None = None,
    parameter_snapshot_match: str | None = None,
) -> dict[str, Any]:
    """Choose the suggested delta/value for a selected strategy memory.

    ``current_parameter_snapshot`` is reserved for clean pre-decision parameter
    state. The paper replay currently does not pass held-out action values into
    recommendation, so this selector falls back to child outcome statistics.
    """
    pattern = value_pattern if isinstance(value_pattern, dict) else {}
    current_context = _current_value_context(
        current_parameter_snapshot,
        parameter_value_prior,
        parameter_snapshot_match=parameter_snapshot_match,
    )
    rows = _candidate_rows(
        pattern,
        observed_changes=observed_changes,
        current_parameter_snapshot=current_context.get("snapshot"),
    )
    if not rows:
        return {
            "selected": False,
            "suggested_delta": pattern.get("delta_bucket") or "",
            "value_pattern_id": pattern.get("pattern_id") or "",
            "selection_policy": "pattern_default",
            "reason": "no_child_value_statistics",
            "current_parameter_snapshot_used": current_context["current_parameter_snapshot_used"],
            "current_value_source": current_context["current_value_source"],
            "current_value_confidence": current_context["current_value_confidence"],
            "target_value_confidence": "unavailable",
            "parameter_snapshot_match": current_context["parameter_snapshot_match"],
            "current_value": _format_number(current_context.get("current_value")),
            "candidates": [],
        }

    ranked = []
    for row in rows:
        scored = _row_score(row)
        ranked.append({
            **row,
            **scored,
        })
    ranked.sort(
        key=lambda item: (
            float(item.get("score") or 0.0),
            int(item.get("support_count") or 0),
            str(item.get("source") or ""),
        ),
        reverse=True,
    )
    best = ranked[0]
    return {
        "selected": True,
        "suggested_delta": best.get("suggested_delta") or "",
        "target_value": best.get("target_value") or best.get("after_value") or "",
        "value_pattern_id": pattern.get("pattern_id") or "",
        "normalized_shape_id": best.get("normalized_shape_id") or pattern.get("normalized_shape_id"),
        "selection_policy": "child_outcome_bayesian_lcb_v1",
        "score": best.get("score"),
        "credibility_lcb": best.get("credibility_lcb"),
        "support_count": best.get("support_count"),
        "source": best.get("source"),
        "reason": "selected_by_child_value_outcome_statistics",
        "current_parameter_snapshot_used": current_context["current_parameter_snapshot_used"],
        "current_value_source": current_context["current_value_source"],
        "current_value_confidence": current_context["current_value_confidence"],
        "target_value_confidence": current_context["target_value_confidence"] if best.get("target_value") else "unavailable",
        "parameter_snapshot_match": current_context["parameter_snapshot_match"],
        "current_value": _format_number(current_context.get("current_value")),
        "candidates": [
            {
                "source": item.get("source"),
                "suggested_delta": item.get("suggested_delta"),
                "target_value": item.get("target_value"),
                "normalized_shape_id": item.get("normalized_shape_id"),
                "current_position_bucket": item.get("current_position_bucket"),
                "shape_before_position_bucket": item.get("shape_before_position_bucket"),
                "shape_location_match": item.get("shape_location_match"),
                "score": item.get("score"),
                "credibility_lcb": item.get("credibility_lcb"),
                "support_count": item.get("support_count"),
                "long_eval_pass_count": item.get("long_eval_pass_count"),
                "long_eval_fail_count": item.get("long_eval_fail_count"),
                "pass_rate": item.get("pass_rate"),
            }
            for item in ranked[:5]
        ],
    }
