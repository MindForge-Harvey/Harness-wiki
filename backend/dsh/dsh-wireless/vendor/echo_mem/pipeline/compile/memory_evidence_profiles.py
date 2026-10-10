"""Build Memory Evidence State sidecars for Phase-1 ECHO-Mem packages.

This stage is intentionally non-invasive: it reads compiled MemoryObject
records after state transition and scoring, then writes sidecars that make
support/counter/conflict/sparse evidence explicit for runtime consumers and
construction-time audits.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from ..common import io as cio
from ..common import paths as P
from ..common.schema_check import validate
from ..scoring.bayesian_score import credibility_from_counts

PRODUCER = "rule_v1.memory_evidence_profiles"
SCHEMA_VERSION = "memory_evidence_profile.v1"
MIXED_CONFLICT_MIN_COUNT = 3
MIXED_CONFLICT_RATE = 0.20
CHILD_MIN_EFFECTIVE_EVIDENCE = 3
CHILD_MIN_DIMENSION_COVERAGE = 1.0


def _profile_id(*parts: Any) -> str:
    raw = "|".join(str(part) for part in parts if part is not None)
    digest = hashlib.md5(raw.encode("utf-8")).hexdigest()[:12]
    return f"mep_{digest}"


def _safe_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _safe_float(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _top_list(values: Any, limit: int = 8) -> list[Any]:
    if not isinstance(values, list):
        return []
    return values[:limit]


def _first(values: Any) -> Any:
    items = _top_list(values, 1)
    return items[0] if items else None


def _outcome_statistics(memory: dict[str, Any]) -> dict[str, Any]:
    metrics = memory.get("metrics") or {}
    pass_n = _safe_int(metrics.get("long_eval_pass_count"))
    fail_n = _safe_int(metrics.get("long_eval_fail_count"))
    mixed_n = _safe_int(metrics.get("long_eval_mixed_count"))
    unknown_n = _safe_int(metrics.get("long_eval_unknown_count"))
    support = _safe_int(metrics.get("support_count"))
    evaluated = pass_n + fail_n
    effective = evaluated + mixed_n
    pass_rate = pass_n / evaluated if evaluated else 0.0
    fail_rate = fail_n / evaluated if evaluated else 0.0
    mixed_rate = mixed_n / effective if effective else 0.0
    pass_cred = credibility_from_counts(pass_n, fail_n)
    fail_cred = credibility_from_counts(fail_n, pass_n)
    return {
        "support_count": support,
        "evaluated_count": evaluated,
        "effective_evidence_count": effective,
        "long_eval_pass_count": pass_n,
        "long_eval_fail_count": fail_n,
        "long_eval_mixed_count": mixed_n,
        "long_eval_unknown_count": unknown_n,
        "pass_rate": round(pass_rate, 6),
        "fail_rate": round(fail_rate, 6),
        "mixed_rate": round(mixed_rate, 6),
        "pass_posterior_mean": round(_safe_float(pass_cred.get("posterior_mean")), 6),
        "pass_lcb": round(_safe_float(pass_cred.get("credibility_lcb")), 6),
        "failure_posterior_mean": round(_safe_float(fail_cred.get("posterior_mean")), 6),
        "failure_lcb": round(_safe_float(fail_cred.get("credibility_lcb")), 6),
        "lcb_quantile": pass_cred.get("lcb_quantile"),
    }


def _support_profiles(memory: dict[str, Any]) -> list[dict[str, Any]]:
    content = memory.get("content") or {}
    profiles = content.get("support_profiles")
    return profiles if isinstance(profiles, list) else []


def _counter_action_profiles(memory: dict[str, Any]) -> list[dict[str, Any]]:
    content = memory.get("content") or {}
    profiles = content.get("action_profiles")
    return profiles if isinstance(profiles, list) else []


def _profile_type(memory: dict[str, Any], stats: dict[str, Any]) -> tuple[str, str, str]:
    memory_type = str(memory.get("memory_type") or "")
    state = str(memory.get("state") or "")
    pass_n = _safe_int(stats.get("long_eval_pass_count"))
    fail_n = _safe_int(stats.get("long_eval_fail_count"))
    mixed_n = _safe_int(stats.get("long_eval_mixed_count"))
    support = _safe_int(stats.get("support_count"))
    evaluated = _safe_int(stats.get("evaluated_count"))
    effective = _safe_int(stats.get("effective_evidence_count"))
    pass_lcb = _safe_float(stats.get("pass_lcb"))
    fail_lcb = _safe_float(stats.get("failure_lcb"))
    pass_rate = _safe_float(stats.get("pass_rate"))
    fail_rate = _safe_float(stats.get("fail_rate"))
    has_support = bool(_support_profiles(memory))

    if memory_type == "counter_evidence_memory" or state == "counter_evidence":
        return "counter_profile", "compiled_counter_evidence", "review_or_reject_by_specificity"

    if effective < 3 or support < 3:
        return "sparse_profile", "insufficient_evaluated_evidence", "rank_only_or_review"

    if (
        mixed_n >= MIXED_CONFLICT_MIN_COUNT
        and _safe_float(stats.get("mixed_rate")) >= MIXED_CONFLICT_RATE
    ):
        return "conflict_profile", "bundle_mixed_outcome_evidence", "review"

    if pass_n > 0 and fail_n > 0 and (
        state == "restricted"
        or (pass_lcb >= 0.25 and fail_lcb >= 0.20)
        or (0.30 <= pass_rate <= 0.70 and fail_rate >= 0.20)
    ):
        return "conflict_profile", "positive_and_negative_evidence_compete", "review"

    if has_support and fail_rate <= 0.20 and pass_lcb >= 0.35:
        return "support_profile", "embedded_hard_support_profile", "support_rank_if_no_counter"

    if pass_lcb >= 0.45 and pass_rate >= 0.70 and fail_rate <= 0.20:
        return "support_profile", "positive_lcb_with_low_failure_pollution", "support_rank_if_no_counter"

    if fail_n >= 3 and fail_rate >= 0.60:
        return "counter_profile", "failure_majority_with_sufficient_count", "review_or_reject_by_specificity"

    if state == "restricted":
        return "conflict_profile", "restricted_state_without_clean_support", "review"

    return "sparse_profile", "posterior_uncertainty_or_weak_evidence", "rank_only_or_review"


def _collapse_conflict_or_sparse(
    profile_type: str,
    conflict_reason: str,
    routing: str,
    stats: dict[str, Any],
) -> tuple[str, str, str]:
    """Ablation helper: remove explicit conflict/sparse states.

    C8-minus-conflict-resolution keeps support/counter statistics available
    but does not expose conflict/sparse as first-class routing states. Ambiguous
    evidence is forced to the dominant polarity, which is exactly the behavior
    this ablation is meant to contrast with conflict-as-review.
    """
    if profile_type not in {"conflict_profile", "sparse_profile"}:
        return profile_type, conflict_reason, routing
    pass_n = _safe_int(stats.get("long_eval_pass_count"))
    fail_n = _safe_int(stats.get("long_eval_fail_count"))
    if fail_n > pass_n:
        return (
            "counter_profile",
            f"{conflict_reason}; conflict_resolution_disabled_forced_counter",
            "review_or_reject_by_specificity",
        )
    return (
        "support_profile",
        f"{conflict_reason}; conflict_resolution_disabled_forced_support",
        "support_rank_if_no_counter",
    )


def _key_family(memory: dict[str, Any]) -> tuple[str, dict[str, Any], list[str]]:
    memory_type = str(memory.get("memory_type") or "")
    content = memory.get("content") or {}
    app = memory.get("applicability") or {}
    fields = ["issue_type", "vendor", "system"]

    if memory_type == "strategy_memory":
        pattern = content.get("value_pattern") or {}
        key_values = {
            "issue_type": content.get("issue_type") or _first(app.get("issue_types")),
            "vendor": content.get("vendor"),
            "system": content.get("system"),
            "scheme_id": content.get("scheme_id"),
            "parameter_semantic_id": content.get("parameter_semantic_id"),
            "direction": pattern.get("direction"),
            "value_shape": pattern.get("normalized_shape_id") or pattern.get("delta_bucket") or pattern.get("pattern_id"),
        }
        fields.extend(["scheme_id", "parameter_semantic_id", "direction", "value_shape"])
        return "strategy_action_shape", key_values, fields

    if memory_type == "playbook_memory":
        key_values = {
            "issue_type": content.get("issue_type") or _first(app.get("issue_types")),
            "vendor": content.get("vendor"),
            "system": content.get("system"),
            "scheme_group": content.get("scheme_group") or _first(app.get("scheme_groups")),
            "component_count": content.get("action_count"),
        }
        fields.extend(["scheme_group", "component_count"])
        return "playbook_component_set", key_values, fields

    if memory_type == "counter_evidence_memory":
        key_values = {
            "issue_type": content.get("issue_type") or _first(app.get("issue_types")),
            "scheme_id": content.get("scheme_id"),
            "scheme_group": content.get("scheme_group") or _first(app.get("scheme_groups")),
            "aggregation": content.get("aggregation"),
        }
        fields.extend(["scheme_id", "scheme_group", "aggregation", "action_profiles"])
        return "counter_issue_scheme", key_values, fields

    key_values = {
        "issue_types": app.get("issue_types") or [],
        "scheme_ids": app.get("scheme_ids") or [],
        "scheme_groups": app.get("scheme_groups") or [],
    }
    return memory_type or "memory", key_values, fields


def _boundary_context(memory: dict[str, Any]) -> dict[str, Any]:
    app = memory.get("applicability") or {}
    content = memory.get("content") or {}
    context = content.get("context_profile") if isinstance(content.get("context_profile"), dict) else {}
    return {
        "issue_types": app.get("issue_types") or [],
        "root_causes": app.get("root_causes") or app.get("solution_proxy_root_causes") or [],
        "vendors": app.get("vendors") or [],
        "systems": app.get("systems") or [],
        "regions": app.get("regions") or context.get("regions") or [],
        "bands": app.get("bands") or context.get("bands") or [],
        "indoor_outdoor": app.get("indoor_outdoor") or context.get("indoor_outdoor") or [],
        "exclusions": app.get("exclusions") or [],
    }


def _action_semantics(memory: dict[str, Any]) -> dict[str, Any]:
    content = memory.get("content") or {}
    pattern = content.get("value_pattern") or {}
    if memory.get("memory_type") == "playbook_memory":
        components = content.get("components") or []
        return {
            "scheme_group": content.get("scheme_group"),
            "component_count": len(components),
            "component_action_semantics": [
                {
                    "scheme_id": comp.get("scheme_id"),
                    "parameter_semantic_id": comp.get("parameter_semantic_id"),
                    "canonical_action_id": comp.get("canonical_action_id"),
                    "operation_family": comp.get("operation_family"),
                    "direction": comp.get("direction"),
                    "value_shape": comp.get("normalized_shape_id") or comp.get("delta_bucket"),
                }
                for comp in components[:8]
            ],
        }
    if memory.get("memory_type") == "counter_evidence_memory":
        return {
            "scheme_id": content.get("scheme_id"),
            "scheme_group": content.get("scheme_group"),
            "action_profiles": _counter_action_profiles(memory)[:8],
        }
    return {
        "scheme_id": content.get("scheme_id"),
        "scheme_group": (memory.get("applicability") or {}).get("scheme_groups") or [],
        "parameter_semantic_id": content.get("parameter_semantic_id"),
        "param_cn_name": content.get("param_cn_name"),
        "param_object": content.get("param_object"),
        "canonical_action_ids": content.get("canonical_action_ids") or [],
        "parameter_concept_ids": content.get("parameter_concept_ids") or [],
        "operation_families": content.get("operation_families") or [],
        "direction": pattern.get("direction"),
        "value_type": pattern.get("value_type"),
        "value_shape": pattern.get("normalized_shape_id") or pattern.get("delta_bucket") or pattern.get("pattern_id"),
    }


def _value_delta_distribution(memory: dict[str, Any]) -> dict[str, Any]:
    content = memory.get("content") or {}
    pattern = content.get("value_pattern") or {}
    if memory.get("memory_type") == "counter_evidence_memory":
        return {
            "counter_action_profiles": _counter_action_profiles(memory)[:8],
            "broad_context_outcome_prior": content.get("broad_context_outcome_prior") or {},
        }
    return {
        "observed_changes": _top_list(content.get("observed_changes"), 8),
        "delta_distribution": _top_list(pattern.get("delta_distribution"), 8),
        "shape_distribution": _top_list(pattern.get("shape_distribution"), 8),
        "typical_change": content.get("typical_change"),
        "parameter_value_prior": content.get("parameter_value_prior") or {},
    }


def _child_profile_type(
    pass_n: int,
    fail_n: int,
    mixed_n: int,
    support: int,
) -> tuple[str, str]:
    evaluated = pass_n + fail_n
    effective = evaluated + mixed_n
    pass_lcb = _safe_float(credibility_from_counts(pass_n, fail_n).get("credibility_lcb"))
    fail_lcb = _safe_float(credibility_from_counts(fail_n, pass_n).get("credibility_lcb"))
    if effective < CHILD_MIN_EFFECTIVE_EVIDENCE or support < CHILD_MIN_EFFECTIVE_EVIDENCE:
        return "sparse_profile", "child_insufficient_evidence"
    if mixed_n > 0:
        return "conflict_profile", "child_mixed_outcome_evidence"
    if pass_n > 0 and fail_n > 0 and pass_lcb >= 0.20 and fail_lcb >= 0.20:
        return "conflict_profile", "child_positive_negative_compete"
    if fail_n >= 3 and fail_lcb >= 0.35:
        return "counter_profile", "child_failure_lcb"
    if pass_n >= 3 and fail_n == 0 and pass_lcb >= 0.35:
        return "support_profile", "child_clean_positive_lcb"
    return "sparse_profile", "child_weak_evidence"


def _child_profiles(
    memory: dict[str, Any],
    parent_profile_type: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if parent_profile_type != "conflict_profile":
        return [], {
            "candidate_count": 0,
            "qualified_count": 0,
            "rejected_count": 0,
            "dimension_coverage": {},
        }
    content = memory.get("content") or {}
    pattern = content.get("value_pattern") or {}
    children: list[dict[str, Any]] = []
    audit: dict[str, Any] = {
        "candidate_count": 0,
        "qualified_count": 0,
        "rejected_count": 0,
        "rejected_by_reason": Counter(),
        "dimension_coverage": {},
        "qualification_policy": {
            "minimum_effective_evidence": CHILD_MIN_EFFECTIVE_EVIDENCE,
            "minimum_dimension_coverage": CHILD_MIN_DIMENSION_COVERAGE,
            "key_must_be_nonempty": True,
        },
    }
    parent_support = max(
        _safe_int((memory.get("metrics") or {}).get("support_count")),
        1,
    )

    def add_children(source_name: str, key_name: str, rows: Any, label_field: str) -> None:
        if not isinstance(rows, list):
            return
        valid_rows = [row for row in rows if isinstance(row, dict)]
        covered_support = sum(_safe_int(row.get("support_count")) for row in valid_rows)
        dimension_coverage = min(1.0, covered_support / parent_support)
        audit["dimension_coverage"][source_name] = round(dimension_coverage, 6)
        for row in valid_rows:
            audit["candidate_count"] += 1
            if not isinstance(row, dict):
                continue
            key_value = row.get(label_field)
            if not key_value:
                audit["rejected_count"] += 1
                audit["rejected_by_reason"]["invalid_key"] += 1
                continue
            pass_n = _safe_int(row.get("long_eval_pass_count"))
            fail_n = _safe_int(row.get("long_eval_fail_count"))
            mixed_n = _safe_int(row.get("long_eval_mixed_count"))
            unknown_n = _safe_int(row.get("long_eval_unknown_count"))
            support = _safe_int(row.get("support_count"))
            effective = pass_n + fail_n + mixed_n
            if effective < CHILD_MIN_EFFECTIVE_EVIDENCE:
                audit["rejected_count"] += 1
                audit["rejected_by_reason"]["insufficient_effective_evidence"] += 1
                continue
            if dimension_coverage < CHILD_MIN_DIMENSION_COVERAGE:
                audit["rejected_count"] += 1
                audit["rejected_by_reason"]["insufficient_dimension_coverage"] += 1
                continue
            child_type, reason = _child_profile_type(
                pass_n,
                fail_n,
                mixed_n,
                support,
            )
            children.append({
                "child_profile_id": _profile_id(memory.get("memory_id"), source_name, key_value),
                "profile_type": child_type,
                "key_family": key_name,
                "key_values": {label_field: key_value},
                "outcome_statistics": {
                    "support_count": support,
                    "long_eval_pass_count": pass_n,
                    "long_eval_fail_count": fail_n,
                    "long_eval_mixed_count": mixed_n,
                    "long_eval_unknown_count": unknown_n,
                    "pass_lcb": round(_safe_float(credibility_from_counts(pass_n, fail_n).get("credibility_lcb")), 6),
                    "failure_lcb": round(_safe_float(credibility_from_counts(fail_n, pass_n).get("credibility_lcb")), 6),
                },
                "conflict_reason": reason,
                "recommended_routing": _routing_for_profile(child_type),
                "qualification": {
                    "qualified": True,
                    "key_valid": True,
                    "effective_evidence_count": effective,
                    "minimum_effective_evidence": CHILD_MIN_EFFECTIVE_EVIDENCE,
                    "dimension_coverage": round(dimension_coverage, 6),
                    "minimum_dimension_coverage": CHILD_MIN_DIMENSION_COVERAGE,
                },
            })
            audit["qualified_count"] += 1

    add_children("observed_change", "strategy_action_observed_change", content.get("observed_changes"), "change")
    add_children("delta_bucket", "strategy_action_delta_bucket", pattern.get("delta_distribution"), "delta_bucket")
    add_children("shape", "strategy_action_shape", pattern.get("shape_distribution"), "shape_id")
    children.sort(
        key=lambda child: (
            str(child.get("key_family") or ""),
            str(child.get("child_profile_id") or ""),
        )
    )
    audit["rejected_by_reason"] = dict(sorted(audit["rejected_by_reason"].items()))
    return children, audit


def _routing_for_profile(profile_type: str) -> str:
    if profile_type == "support_profile":
        return "support_rank_if_no_counter"
    if profile_type == "counter_profile":
        return "review_or_reject_by_specificity"
    if profile_type == "conflict_profile":
        return "review"
    return "rank_only_or_review"


def _feature_manifest(
    memory: dict[str, Any],
    score: dict[str, Any] | None,
    stats: dict[str, Any],
    profile_type: str,
    conflict_reason: str,
    runtime_visible_fields: list[str],
    child_profiles: list[dict[str, Any]],
    refinement_audit: dict[str, Any],
) -> dict[str, Any]:
    support_strength = _safe_float(stats.get("pass_lcb"))
    counter_strength = _safe_float(stats.get("failure_lcb"))
    evaluated = _safe_int(stats.get("evaluated_count"))
    conflict_score = min(support_strength, counter_strength) * min(1.0, evaluated / 10.0)
    if profile_type == "conflict_profile" and conflict_score == 0.0:
        conflict_score = 0.25
    sparsity_score = max(0.0, 1.0 - min(1.0, evaluated / 5.0))
    return {
        "memory_state": memory.get("state"),
        "support_strength": round(support_strength, 6),
        "counter_strength": round(counter_strength, 6),
        "conflict_score": round(conflict_score, 6),
        "sparsity_score": round(sparsity_score, 6),
        "has_embedded_support_profile": bool(_support_profiles(memory)),
        "has_counter_action_profile": bool(_counter_action_profiles(memory)),
        "score_overall": (score or {}).get("overall"),
        "score_strategy_effectiveness": (score or {}).get("strategy_effectiveness"),
        "score_boundary_clarity": (score or {}).get("boundary_clarity"),
        "score_reusability": (score or {}).get("reusability"),
        "input_features": runtime_visible_fields,
        "conflict_reason": conflict_reason,
        "hierarchical_refinement": {
            "enabled": True,
            "child_profile_count": len(child_profiles),
            "candidate_count": refinement_audit.get("candidate_count", 0),
            "rejected_count": refinement_audit.get("rejected_count", 0),
            "rejected_by_reason": refinement_audit.get("rejected_by_reason", {}),
            "dimension_coverage": refinement_audit.get("dimension_coverage", {}),
            "qualification_policy": refinement_audit.get("qualification_policy", {}),
            "candidate_dimensions": ["observed_change", "delta_bucket", "shape_distribution"],
            "objective": "safe_decision_separability_not_purity",
        },
        "contract": "train_only_construction_sidecar; runtime may consume but evaluator-only fields are not introduced here",
    }


def build_profiles(
    memories: list[dict[str, Any]],
    *,
    scores_by_memory_id: dict[str, dict[str, Any]] | None = None,
    enable_conflict_resolution: bool = True,
    enable_hierarchical_refinement: bool = True,
) -> list[dict[str, Any]]:
    profiles: list[dict[str, Any]] = []
    for memory in memories:
        memory_type = str(memory.get("memory_type") or "")
        if memory_type not in {"strategy_memory", "playbook_memory", "counter_evidence_memory"}:
            continue
        stats = _outcome_statistics(memory)
        profile_type, conflict_reason, routing = _profile_type(memory, stats)
        if not enable_conflict_resolution:
            profile_type, conflict_reason, routing = _collapse_conflict_or_sparse(
                profile_type,
                conflict_reason,
                routing,
                stats,
            )
        key_family, key_values, runtime_fields = _key_family(memory)
        score = (scores_by_memory_id or {}).get(str(memory.get("memory_id") or ""))
        if enable_hierarchical_refinement:
            children, refinement_audit = _child_profiles(memory, profile_type)
        else:
            children, refinement_audit = [], {
                "candidate_count": 0,
                "qualified_count": 0,
                "rejected_count": 0,
                "dimension_coverage": {},
            }
        if children and profile_type == "conflict_profile":
            child_types = Counter(str(child.get("profile_type")) for child in children)
            if child_types.get("support_profile") or child_types.get("counter_profile"):
                conflict_reason = f"{conflict_reason}; hierarchical_refinement_candidates_present"
        profile = {
            "profile_id": _profile_id(memory.get("memory_id"), profile_type, key_family),
            "parent_memory_id": memory.get("memory_id"),
            "parent_memory_type": memory_type,
            "profile_type": profile_type,
            "key_family": key_family,
            "key_values": key_values,
            "runtime_visible_fields": runtime_fields,
            "outcome_statistics": stats,
            "boundary_context": _boundary_context(memory),
            "action_semantics": _action_semantics(memory),
            "value_delta_distribution": _value_delta_distribution(memory),
            "sample_evidence_refs": {
                "trace_count": len(memory.get("trace_ids") or []),
                "evidence_id_count": len(memory.get("evidence_ids") or []),
                "trace_ids_preview": (memory.get("trace_ids") or [])[:5],
                "sample_sidecar": "strategy_sample_links.jsonl",
            },
            "conflict_reason": conflict_reason,
            "recommended_routing": routing,
            "feature_manifest": _feature_manifest(
                memory,
                score,
                stats,
                profile_type,
                conflict_reason,
                runtime_fields,
                children,
                refinement_audit,
            ),
            "child_profiles": children,
            "produced_by": PRODUCER,
            "produced_at": cio.now_iso(),
            "schema_version": SCHEMA_VERSION,
        }
        profiles.append(profile)
    return profiles


def build_state_transition_manifest(
    *,
    memories: list[dict[str, Any]],
    transitions: list[dict[str, Any]],
    profiles: list[dict[str, Any]],
    source_files: dict[str, str],
) -> dict[str, Any]:
    state_dist = Counter(str(memory.get("state") or "unknown") for memory in memories)
    transition_rules = Counter(str(row.get("rule_id") or "unknown") for row in transitions)
    evidence_states = Counter(str(row.get("profile_type") or "unknown") for row in profiles)
    routing = Counter(str(row.get("recommended_routing") or "unknown") for row in profiles)
    profile_memory_types = Counter(str(row.get("parent_memory_type") or "unknown") for row in profiles)
    child_types = Counter(
        str(child.get("profile_type") or "unknown")
        for row in profiles
        for child in (row.get("child_profiles") or [])
        if isinstance(child, dict)
    )
    return {
        "schema_version": "state_transition_manifest.v1",
        "produced_by": PRODUCER,
        "produced_at": cio.now_iso(),
        "source_files": source_files,
        "memory_count": len(memories),
        "transition_count": len(transitions),
        "profile_count": len(profiles),
        "state_distribution": dict(state_dist),
        "transition_count_by_reason": dict(transition_rules),
        "evidence_state_distribution": dict(evidence_states),
        "recommended_routing_distribution": dict(routing),
        "profile_count_by_memory_type": dict(profile_memory_types),
        "hierarchical_refinement_child_distribution": dict(child_types),
        "conflict_profile_count": evidence_states.get("conflict_profile", 0),
        "sparse_profile_count": evidence_states.get("sparse_profile", 0),
        "support_profile_count": evidence_states.get("support_profile", 0),
        "counter_profile_count": evidence_states.get("counter_profile", 0),
        "capabilities": {
            "memory_evidence_state_inference": "completed",
            "conflict_detection": "completed_first_pass",
            "hierarchical_evidence_refinement": "completed_first_pass_value_delta_shape_children",
            "state_transition_manifest": "completed",
            "learned_evidence_calibrator": "not_used",
        },
        "routing_contract": {
            "support_profile": "support evidence only; do not bypass specific counter evidence",
            "counter_profile": "review/reject candidate depending on specificity",
            "conflict_profile": "default review until refinement proves safe separability",
            "sparse_profile": "rank-only or review; no hard allow",
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--memories", default=str(P.MEMORY_OBJECTS_JSONL))
    ap.add_argument("--transitions", default=str(P.STATE_TRANSITIONS_JSONL))
    ap.add_argument("--scores", default=str(P.MEMORY_SCORES_JSONL))
    ap.add_argument("--out-profiles", default=str(P.MEMORY_EVIDENCE_PROFILES_JSONL))
    ap.add_argument("--out-manifest", default=str(P.STATE_TRANSITION_MANIFEST_JSON))
    ap.add_argument(
        "--disable-conflict-resolution",
        action="store_true",
        help="Construction ablation: do not emit conflict/sparse profile states; force dominant support/counter polarity.",
    )
    ap.add_argument(
        "--disable-hierarchical-refinement",
        action="store_true",
        help="Construction ablation: emit parent profiles but no child refinement profiles.",
    )
    args = ap.parse_args()

    memories = list(cio.read_jsonl(args.memories))
    transitions = list(cio.read_jsonl(args.transitions))
    scores = list(cio.read_jsonl(args.scores))
    scores_by_id = {str(row.get("memory_id")): row for row in scores if row.get("memory_id")}
    profiles = build_profiles(
        memories,
        scores_by_memory_id=scores_by_id,
        enable_conflict_resolution=not args.disable_conflict_resolution,
        enable_hierarchical_refinement=not args.disable_hierarchical_refinement,
    )

    bad = 0
    for profile in profiles:
        errs = validate(profile, "memory_evidence_profile")
        if errs:
            bad += 1
            if bad <= 5:
                print(f"[memory-evidence-profiles] bad profile {profile.get('profile_id')}: {errs[:3]}", file=sys.stderr)

    cio.write_jsonl(args.out_profiles, profiles)
    manifest = build_state_transition_manifest(
        memories=memories,
        transitions=transitions,
        profiles=profiles,
        source_files={
            "memory_objects": str(args.memories),
            "state_transitions": str(args.transitions),
            "memory_scores": str(args.scores),
            "memory_evidence_profiles": str(args.out_profiles),
        },
    )
    Path(args.out_manifest).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out_manifest).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"[memory-evidence-profiles] profiles={len(profiles)} schema_bad={bad} "
        f"manifest={args.out_manifest}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
