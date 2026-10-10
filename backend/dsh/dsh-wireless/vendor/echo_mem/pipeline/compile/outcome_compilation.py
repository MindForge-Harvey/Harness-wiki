"""Train-only outcome-label policies for construction ablations.

This module must only run before a train memory package is compiled.  Both
`long_eval_result` and `improvement_result` are post-action labels.  They are
never recommendation-time features and must never be attached to a target
dev/holdout query.

The policies intentionally preserve the original labels and stamp provenance
on every derived action outcome.  Multi-action tickets are handled separately
because `para_improvement` is constant across their parameter rows and is
therefore a strategy/plan-bundle label, not an independently observed causal
label for each parameter action.
"""

from __future__ import annotations

import copy
from collections import Counter
from typing import Any

from ..common.ticket_aggregate import compute_ticket_aggregate


POLICY_LONG_EVAL_ONLY = "long_eval_only"
POLICY_LONG_EVAL_NAIVE_COMPONENT_BROADCAST = "long_eval_naive_component_broadcast"
POLICY_LONG_EVAL_MULTI_STRUCTURAL_ONLY = "long_eval_multi_structural_only"
POLICY_NAIVE_BROADCAST = "improvement_naive_broadcast"
POLICY_ATTRIBUTION_SAFE = "improvement_attribution_safe"
POLICY_CONFLICT_REMAP = "improvement_conflict_remap"

POLICIES = frozenset({
    POLICY_LONG_EVAL_ONLY,
    POLICY_LONG_EVAL_NAIVE_COMPONENT_BROADCAST,
    POLICY_LONG_EVAL_MULTI_STRUCTURAL_ONLY,
    POLICY_NAIVE_BROADCAST,
    POLICY_ATTRIBUTION_SAFE,
    POLICY_CONFLICT_REMAP,
})

IMPROVEMENT_TO_OUTCOME = {
    "改善": "long_eval_pass",
    "恶化": "long_eval_fail",
    "无变化": "long_eval_unknown",
}

OUTCOME_ROLE_BY_RESULT = {
    "long_eval_pass": "support",
    "long_eval_fail": "counter",
    "long_eval_mixed": "conflict",
}


def _is_realized_action(action: dict[str, Any]) -> bool:
    """Return whether the action belongs to the actually executed bundle."""
    issued_state = action.get("issued_state")
    return (
        action.get("exec_state") == "exec_success"
        and issued_state in {None, "", "下发成功"}
    )


def _materialize_trace_evidence_authority(trace: dict[str, Any]) -> Counter[str]:
    """Stamp the maximum attribution scope without inventing local endpoints.

    The current source exposes long-evaluation at ticket/plan level. A strict
    single-action plan can support action-direct evidence because its submitted
    and realized scopes coincide. Partial realization of a multi-action plan
    does not silently narrow the outcome target. Components otherwise remain
    structural associations unless a future source explicitly supplies a local
    endpoint.
    """
    counts: Counter[str] = Counter()
    actions = [action for action in (trace.get("actions") or []) if isinstance(action, dict)]
    realized_actions = [action for action in actions if _is_realized_action(action)]
    aggregate = trace.setdefault("aggregate", {})
    policy = str(aggregate.get("compiled_outcome_policy") or POLICY_LONG_EVAL_ONLY)
    if policy == POLICY_LONG_EVAL_ONLY:
        bundle_outcome = str(aggregate.get("ticket_outcome") or "long_eval_unknown")
        bundle_basis = "ticket_long_eval_endpoint"
    else:
        bundle_outcome = str(
            aggregate.get("bundle_outcome")
            or aggregate.get("ticket_outcome")
            or "long_eval_unknown"
        )
        bundle_basis = str(
            aggregate.get("bundle_outcome_basis")
            or "compiled_bundle_outcome"
        )
    suppress_multi_bundle_outcome = (
        policy == POLICY_LONG_EVAL_MULTI_STRUCTURAL_ONLY
        and len(realized_actions) > 1
    )
    bundle_is_composite = bundle_outcome == "long_eval_mixed"
    bundle_role = (
        "unresolved"
        if suppress_multi_bundle_outcome
        else OUTCOME_ROLE_BY_RESULT.get(bundle_outcome, "unresolved")
    )
    bundle_scope = (
        "bundle_direct"
        if bundle_role in {"support", "counter"}
        else "unresolved"
    )
    bundle_eligible = bundle_scope == "bundle_direct"
    aggregate["maximum_attribution_scope"] = bundle_scope
    aggregate["outcome_role"] = bundle_role
    aggregate["result_evidence_eligible"] = bundle_eligible
    aggregate["outcome_record_kind"] = (
        "bundle_composite" if bundle_is_composite else "atomic_direct"
    )
    aggregate["outcome_channel"] = (
        "execution_mix" if bundle_is_composite else bundle_role
    )
    aggregate["evidence_authority_basis"] = (
        "multi_action_bundle_outcome_suppressed_negative_control"
        if suppress_multi_bundle_outcome
        else bundle_basis
    )
    counts[f"bundle_scope:{bundle_scope}"] += 1
    counts[f"bundle_role:{bundle_role}"] += 1

    single_realized = len(realized_actions) == 1
    strict_single_action_plan = len(actions) == 1 and single_realized
    for action in actions:
        explicit_scope = str(action.get("compiled_outcome_scope") or "")
        action_result = str(action.get("long_eval_result") or "long_eval_unknown")
        realized = _is_realized_action(action)
        has_mature_binary_result = action_result in {"long_eval_pass", "long_eval_fail"}

        intentional_naive_broadcast = (
            policy == POLICY_LONG_EVAL_NAIVE_COMPONENT_BROADCAST
            and realized
            and len(realized_actions) > 1
            and bundle_role in {"support", "counter"}
        )

        if intentional_naive_broadcast:
            scope = "action_direct"
            role = bundle_role
            eligible = True
            basis = "intentional_multi_action_bundle_broadcast_negative_control"
            action["long_eval_result"] = bundle_outcome
        elif (
            realized
            and has_mature_binary_result
            and strict_single_action_plan
            and explicit_scope != "plan_bundle_only"
        ):
            scope = "action_direct"
            role = OUTCOME_ROLE_BY_RESULT[action_result]
            eligible = True
            basis = (
                "explicit_single_action_attribution"
                if explicit_scope == "action_attributable_single_action_ticket"
                else "strict_single_action_plan_equivalence"
            )
        elif realized and len(realized_actions) > 1:
            scope = "component_associated"
            role = "unresolved"
            eligible = False
            basis = "multi_action_bundle_without_local_endpoint"
        else:
            scope = "unresolved"
            role = "unresolved"
            eligible = False
            basis = (
                "non_realized_action"
                if not realized
                else "missing_or_nonbinary_action_endpoint"
            )

        action["maximum_attribution_scope"] = scope
        action["outcome_role"] = role
        action["result_evidence_eligible"] = eligible
        action["evidence_authority_basis"] = basis
        action["component_of_bundle_relation"] = bool(
            realized and len(realized_actions) > 1
        )
        action["associated_bundle_outcome"] = bundle_outcome
        action["associated_bundle_outcome_role"] = bundle_role
        counts[f"action_scope:{scope}"] += 1
        counts[f"action_role:{role}"] += 1
    return counts


def materialize_evidence_authority(
    traces: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return copied traces with explicit eligibility, role, and attribution."""
    copied = copy.deepcopy(traces)
    counts: Counter[str] = Counter()
    for trace in copied:
        counts.update(_materialize_trace_evidence_authority(trace))
    return copied, {
        "schema_version": "evidence_authority_manifest.v1",
        "trace_count": len(copied),
        "counts": dict(sorted(counts.items())),
        "contract": (
            "strict single-action plan with mature endpoint may be action-direct; "
            "multi-action components without local endpoints remain component-associated"
        ),
    }


def _original_outcome(action: dict[str, Any]) -> str:
    return str(action.get("long_eval_result") or "long_eval_unknown")


def _improvement_value(action: dict[str, Any]) -> str:
    return str(action.get("improvement_result") or "").strip()


def _mapped_improvement(action: dict[str, Any]) -> str | None:
    return IMPROVEMENT_TO_OUTCOME.get(_improvement_value(action))


def _ticket_improvement(actions: list[dict[str, Any]]) -> tuple[str, bool]:
    values = {
        value
        for action in actions
        if (value := _improvement_value(action)) and value != "无指标"
    }
    if not values:
        return "", False
    if len(values) == 1:
        return next(iter(values)), False
    return "mixed", True


def _trace_original_outcome(trace: dict[str, Any]) -> str:
    return str((trace.get("aggregate") or {}).get("ticket_outcome") or "long_eval_unknown")


def _bundle_outcome(actions: list[dict[str, Any]], original_ticket_outcome: str) -> tuple[str, str]:
    improvement, mixed = _ticket_improvement(actions)
    if mixed:
        return "long_eval_unknown", "mixed_improvement_labels"
    mapped = IMPROVEMENT_TO_OUTCOME.get(improvement)
    if mapped:
        return mapped, "ticket_plan_bundle_improvement"
    if improvement == "无变化":
        return "long_eval_unknown", "ticket_plan_bundle_unchanged"
    return original_ticket_outcome, "fallback_original_long_eval"


def _action_outcome(
    action: dict[str, Any],
    *,
    policy: str,
    action_count: int,
    realized_action_count: int,
) -> tuple[str, str, str]:
    original = _original_outcome(action)
    mapped = _mapped_improvement(action)
    improvement = _improvement_value(action)

    if policy == POLICY_LONG_EVAL_ONLY:
        return original, "action_row", "original_long_eval"

    if policy == POLICY_LONG_EVAL_NAIVE_COMPONENT_BROADCAST:
        return original, "intentional_naive_component_broadcast", "original_bundle_long_eval_broadcast_negative_control"

    if policy == POLICY_LONG_EVAL_MULTI_STRUCTURAL_ONLY:
        if realized_action_count > 1:
            return "long_eval_unknown", "plan_bundle_only", "multi_action_structural_association_only"
        return original, "action_row", "original_single_action_long_eval"

    if policy == POLICY_NAIVE_BROADCAST:
        if mapped:
            return mapped, "naive_action_broadcast", "para_improvement_broadcast_negative_control"
        return original, "action_row", "fallback_original_long_eval"

    if policy == POLICY_ATTRIBUTION_SAFE:
        if action_count == 1:
            if mapped:
                return mapped, "action_attributable_single_action_ticket", "single_action_para_improvement"
            return original, "action_attributable_single_action_ticket", "fallback_original_long_eval"
        return "long_eval_unknown", "plan_bundle_only", "multi_action_not_action_attributable"

    if policy == POLICY_CONFLICT_REMAP:
        if not mapped:
            if improvement == "无变化":
                return "long_eval_unknown", "plan_bundle_only" if action_count > 1 else "action_row", "unchanged_not_support_or_counter"
            return original, "plan_bundle_only" if action_count > 1 else "action_row", "fallback_original_long_eval"
        concordant = (
            (mapped == "long_eval_pass" and original == "long_eval_pass")
            or (mapped == "long_eval_fail" and original == "long_eval_fail")
        )
        if concordant:
            return original, "plan_bundle_only" if action_count > 1 else "action_attributable_single_action_ticket", "dual_outcome_concordant"
        return "long_eval_unknown", "plan_bundle_only" if action_count > 1 else "action_attributable_single_action_ticket", "dual_outcome_conflict_remapped_unknown"

    raise ValueError(f"unknown outcome compilation policy: {policy}")


def apply_outcome_compilation_policy(
    traces: list[dict[str, Any]],
    policy: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return copied train traces and a manifest for one construction policy."""
    if policy not in POLICIES:
        raise ValueError(f"unknown outcome compilation policy: {policy}")
    copied = copy.deepcopy(traces)
    action_reason_counts: Counter[str] = Counter()
    action_scope_counts: Counter[str] = Counter()
    evidence_authority_counts: Counter[str] = Counter()
    derived_action_outcomes: Counter[str] = Counter()
    original_ticket_outcomes: Counter[str] = Counter()
    derived_ticket_outcomes: Counter[str] = Counter()
    bundle_outcomes: Counter[str] = Counter()
    ticket_improvements: Counter[str] = Counter()
    single_action_tickets = 0
    multi_action_tickets = 0
    single_realized_action_tickets = 0
    multi_realized_action_tickets = 0

    for trace in copied:
        actions = [action for action in (trace.get("actions") or []) if isinstance(action, dict)]
        action_count = len(actions)
        realized_action_count = sum(_is_realized_action(action) for action in actions)
        single_action_tickets += int(action_count == 1)
        multi_action_tickets += int(action_count > 1)
        single_realized_action_tickets += int(realized_action_count == 1)
        multi_realized_action_tickets += int(realized_action_count > 1)
        original_ticket_outcome = _trace_original_outcome(trace)
        original_ticket_outcomes[original_ticket_outcome] += 1
        improvement, improvement_mixed = _ticket_improvement(actions)
        ticket_improvements["mixed" if improvement_mixed else improvement or "missing_or_no_metric"] += 1
        if policy in {
            POLICY_LONG_EVAL_ONLY,
            POLICY_LONG_EVAL_NAIVE_COMPONENT_BROADCAST,
            POLICY_LONG_EVAL_MULTI_STRUCTURAL_ONLY,
        }:
            bundle_outcome, bundle_basis = (
                original_ticket_outcome,
                "original_ticket_long_eval",
            )
        else:
            bundle_outcome, bundle_basis = _bundle_outcome(actions, original_ticket_outcome)
        bundle_outcomes[bundle_outcome] += 1

        for action in actions:
            original = _original_outcome(action)
            compiled, scope, basis = _action_outcome(
                action,
                policy=policy,
                action_count=action_count,
                realized_action_count=realized_action_count,
            )
            action["original_long_eval_result"] = original
            action["compiled_outcome_result"] = compiled
            action["compiled_outcome_policy"] = policy
            action["compiled_outcome_scope"] = scope
            action["compiled_outcome_basis"] = basis
            action["bundle_outcome_result"] = bundle_outcome
            action["bundle_outcome_basis"] = bundle_basis
            action["outcome_field_contract"] = "train_only_post_action_label_never_runtime_feature"
            action["long_eval_result"] = compiled
            action_reason_counts[basis] += 1
            action_scope_counts[scope] += 1
            derived_action_outcomes[compiled] += 1

        aggregate = compute_ticket_aggregate(actions)
        aggregate["original_ticket_outcome"] = original_ticket_outcome
        aggregate["compiled_outcome_policy"] = policy
        aggregate["bundle_outcome"] = bundle_outcome
        aggregate["bundle_outcome_basis"] = bundle_basis
        aggregate["outcome_field_contract"] = "train_only_post_action_label_never_runtime_feature"
        trace["aggregate"] = aggregate
        evidence_authority_counts.update(_materialize_trace_evidence_authority(trace))
        derived_ticket_outcomes[str(aggregate.get("ticket_outcome") or "unknown")] += 1

    manifest = {
        "schema_version": "outcome_compilation_manifest.v1",
        "policy": policy,
        "field_contract": {
            "long_eval_result": "train-only construction label or evaluator-only target label",
            "improvement_result": "train-only construction label or evaluator-only target label",
            "forbidden_runtime_feature": True,
            "multi_action_improvement_scope": "strategy_or_plan_bundle_not_independent_parameter_action",
        },
        "trace_count": len(copied),
        "single_action_ticket_count": single_action_tickets,
        "multi_action_ticket_count": multi_action_tickets,
        "single_realized_action_ticket_count": single_realized_action_tickets,
        "multi_realized_action_ticket_count": multi_realized_action_tickets,
        "ticket_improvement_distribution": dict(sorted(ticket_improvements.items())),
        "original_ticket_outcome_distribution": dict(sorted(original_ticket_outcomes.items())),
        "derived_ticket_outcome_distribution": dict(sorted(derived_ticket_outcomes.items())),
        "bundle_outcome_distribution": dict(sorted(bundle_outcomes.items())),
        "derived_action_outcome_distribution": dict(sorted(derived_action_outcomes.items())),
        "action_scope_distribution": dict(sorted(action_scope_counts.items())),
        "evidence_authority_distribution": dict(sorted(evidence_authority_counts.items())),
        "action_basis_distribution": dict(sorted(action_reason_counts.items())),
    }
    return copied, manifest
