"""知识编译「效果学习池」准入：仅长评估结论清晰的工单进入可复用知识聚合。

工单追踪仍保留全量 trace；本模块只约束 compile / evidence（效果向）/ case_episode 聚合。
流程风险 risk_memory 使用全量 trace 单独编译（见 compile_rules.compile_all）。
"""

from __future__ import annotations

from typing import Any

# 与 aggregate.ticket_outcome 一致
COMPILE_EFFECT_OUTCOMES = frozenset({
    "long_eval_pass",
    "long_eval_mixed",
    "long_eval_fail",
})

COMPILE_EFFECT_OUTCOME_ORDER = (
    "long_eval_pass",
    "long_eval_mixed",
    "long_eval_fail",
)


def ticket_outcome(trace: dict[str, Any]) -> str:
    return (trace.get("aggregate") or {}).get("ticket_outcome") or "long_eval_unknown"


def is_compile_effect_eligible(trace: dict[str, Any]) -> bool:
    return ticket_outcome(trace) in COMPILE_EFFECT_OUTCOMES


def filter_effect_traces(traces: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [t for t in traces if is_compile_effect_eligible(t)]


def effect_eligibility_stats(traces: list[dict[str, Any]]) -> dict[str, Any]:
    from collections import Counter

    outcomes = Counter(ticket_outcome(t) for t in traces)
    total = len(traces)
    eligible = sum(outcomes.get(k, 0) for k in COMPILE_EFFECT_OUTCOMES)
    return {
        "trace_total": total,
        "effect_eligible_count": eligible,
        "effect_excluded_count": total - eligible,
        "effect_eligible_ratio": round(eligible / total, 4) if total else 0.0,
        "outcome_counts": dict(outcomes),
        "effect_outcomes": list(COMPILE_EFFECT_OUTCOME_ORDER),
    }
