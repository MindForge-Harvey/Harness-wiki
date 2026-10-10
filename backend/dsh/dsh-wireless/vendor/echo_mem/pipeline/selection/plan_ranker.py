"""Plan/memory ranking for ECHO-Mem shadow selection.

The current ranker scores memory candidates before the veto gate. Its main
controlled variable is the credibility term:

- full ECHO-Mem uses Beta-Binomial lower confidence bound (LCB)
- no-bayes ablation uses raw historical pass_rate

This keeps Bayesian calibration as a real ranking variable rather than a UI-only
score.
"""

from __future__ import annotations

import math
import json
from typing import Any

from ..scoring.bayesian_score import credibility_score


PARAM_CLUE_WEIGHTS = [
    ("parameter_semantic_id", 500),
    ("param_object", 220),
    ("param_en_name", 220),
    ("site_param_object", 120),
    ("site_param_en_name", 120),
]

DEFAULT_RANKER_CONFIG: dict[str, Any] = {
    "version": "ranker_v1",
    "weights": {
        "route_match": 0.35,
        "credibility": 0.45,
        "boundary_match": 0.10,
        "risk_penalty": 0.10,
    },
    "unknown_boundary_score": 0.5,
    "bayesian": {
        "alpha0": 1.0,
        "beta0": 1.0,
        "lcb_q": 0.05,
    },
}

_CREDIBILITY_CACHE: dict[tuple[int, float, float, float], float] = {}
_SCORE_BREAKDOWN_CACHE: dict[tuple[Any, ...], dict[str, Any]] = {}
_RANKED_MEMORIES_CACHE: dict[tuple[Any, ...], tuple[dict[str, Any], ...]] = {}


def _frozen_value(value: Any) -> Any:
    if isinstance(value, dict):
        return tuple(sorted((str(key), _frozen_value(item)) for key, item in value.items()))
    if isinstance(value, (list, tuple, set)):
        return tuple(_frozen_value(item) for item in value)
    return value


def _config_key(config: dict[str, Any]) -> str:
    return json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def norm_values(*values: Any) -> set[str]:
    out = set()
    for value in values:
        if isinstance(value, list):
            out.update(str(v).strip().lower() for v in value if str(v or "").strip())
        elif str(value or "").strip():
            out.add(str(value).strip().lower())
    return out


def memory_credibility(
    memory: dict[str, Any],
    *,
    use_bayesian_credibility: bool,
    bayesian_config: dict[str, Any] | None = None,
) -> float:
    metrics = memory.get("metrics") if isinstance(memory.get("metrics"), dict) else {}
    content = memory.get("content") if isinstance(memory.get("content"), dict) else {}
    if use_bayesian_credibility:
        config = bayesian_config or {}
        alpha0 = float(config.get("alpha0", 1.0))
        beta0 = float(config.get("beta0", 1.0))
        lcb_q = float(config.get("lcb_q", 0.05))
        cache_key = (id(memory), alpha0, beta0, lcb_q)
        if cache_key in _CREDIBILITY_CACHE:
            return _CREDIBILITY_CACHE[cache_key]
        value = float(credibility_score(
            metrics,
            alpha0=alpha0,
            beta0=beta0,
            lcb_q=lcb_q,
        ))
        _CREDIBILITY_CACHE[cache_key] = value
        return value
    return float(metrics.get("pass_rate") or content.get("pass_rate") or 0)


def memory_candidate_score(
    memory: dict[str, Any],
    root: dict[str, Any],
    param_clues: dict[str, set[str]],
    *,
    use_bayesian_credibility: bool = True,
    query: dict[str, Any] | None = None,
    ranker_config: dict[str, Any] | None = None,
) -> float:
    return memory_candidate_score_breakdown(
        memory,
        root,
        param_clues,
        use_bayesian_credibility=use_bayesian_credibility,
        query=query,
        ranker_config=ranker_config,
    )["total"]


def _config(ranker_config: dict[str, Any] | None) -> dict[str, Any]:
    config = dict(DEFAULT_RANKER_CONFIG)
    config["weights"] = dict(DEFAULT_RANKER_CONFIG["weights"])
    config["bayesian"] = dict(DEFAULT_RANKER_CONFIG["bayesian"])
    if isinstance(ranker_config, dict):
        config.update({key: value for key, value in ranker_config.items() if key not in {"weights", "bayesian"}})
        if isinstance(ranker_config.get("weights"), dict):
            config["weights"].update(ranker_config["weights"])
        if isinstance(ranker_config.get("bayesian"), dict):
            config["bayesian"].update(ranker_config["bayesian"])
    return config


def _route_match(memory: dict[str, Any], query: dict[str, Any]) -> tuple[float, dict[str, bool]]:
    app = memory.get("applicability") if isinstance(memory.get("applicability"), dict) else {}
    fields = [
        ("issue_type", "issue_types", 0.40),
        ("vendor", "vendors", 0.25),
        ("system", "systems", 0.20),
        ("region", "regions", 0.10),
        ("band", "bands", 0.05),
    ]
    matched: dict[str, bool] = {}
    score = 0.0
    denominator = 0.0
    for query_key, app_key, weight in fields:
        query_value = str(query.get(query_key) or "").strip().lower()
        if not query_value or query_value.startswith("未知") or query_value == "未标注":
            continue
        denominator += weight
        hit = query_value in norm_values(app.get(app_key))
        matched[query_key] = hit
        if hit:
            score += weight
    return (score / denominator if denominator else 0.0), matched


def _boundary_match(memory: dict[str, Any], unknown_score: float) -> tuple[float, bool, str]:
    content = memory.get("content") if isinstance(memory.get("content"), dict) else {}
    pattern = content.get("value_pattern") if isinstance(content.get("value_pattern"), dict) else {}
    boundary = pattern.get("effective_parameter_range") or content.get("boundary_conditions")
    if not isinstance(boundary, dict) or not boundary:
        return unknown_score, False, "heldout_prechange_value_unavailable"
    confidence = str(boundary.get("confidence") or "").lower()
    if confidence in {"parsed", "direct"} or (boundary.get("min") is not None and boundary.get("max") is not None):
        return 1.0, True, "complete_candidate_boundary"
    return 0.7, True, "partial_candidate_boundary"


def _risk_penalty(memory: dict[str, Any]) -> tuple[float, list[str]]:
    content = memory.get("content") if isinstance(memory.get("content"), dict) else {}
    metrics = memory.get("metrics") if isinstance(memory.get("metrics"), dict) else {}
    reasons: list[str] = []
    penalty = 0.0
    state = str(memory.get("state") or "")
    if state == "counter_evidence":
        penalty = max(penalty, 1.0)
        reasons.append("counter_evidence_state")
    elif state == "restricted":
        penalty = max(penalty, 0.7)
        reasons.append("restricted_state")
    failure_rate = metrics.get("execution_failure_rate", content.get("execution_failure_rate"))
    try:
        failure = max(0.0, min(1.0, float(failure_rate)))
    except (TypeError, ValueError):
        failure = 0.0
    if failure:
        penalty = max(penalty, failure)
        reasons.append("execution_failure_rate")
    return penalty, reasons


def memory_candidate_score_breakdown(
    memory: dict[str, Any],
    root: dict[str, Any],
    param_clues: dict[str, set[str]],
    *,
    use_bayesian_credibility: bool = True,
    query: dict[str, Any] | None = None,
    ranker_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the four paper terms and their weighted total in [approximately -1, 1]."""
    config = _config(ranker_config)
    cache_key = (
        id(memory),
        _frozen_value(root),
        _frozen_value(param_clues),
        bool(use_bayesian_credibility),
        _frozen_value(query or {}),
        _config_key(config),
    )
    cached = _SCORE_BREAKDOWN_CACHE.get(cache_key)
    if cached is not None:
        return cached
    weights = config["weights"]
    content = memory.get("content") if isinstance(memory.get("content"), dict) else {}
    metrics = memory.get("metrics") if isinstance(memory.get("metrics"), dict) else {}
    support = float(metrics.get("support_count") or content.get("support_count") or 0)
    credibility = memory_credibility(
        memory,
        use_bayesian_credibility=use_bayesian_credibility,
        bayesian_config=config["bayesian"],
    )
    support_score = min(1.0, math.log1p(max(0.0, support)) / math.log1p(200.0))
    credibility_term = min(1.0, max(0.0, credibility * 0.8 + support_score * 0.2))

    route_term, route_fields = _route_match(memory, query or {})

    root_key = str(root.get("root_cause_key") or "").lower()
    root_l2 = str(root.get("root_cause_l2") or "").lower()
    root_values = norm_values(
        content.get("root_causes"),
        content.get("solution_proxy_root_causes"),
        content.get("solution_proxy_root_cause"),
    )
    if root_key and root_key in root_values:
        route_term = min(1.0, route_term + 0.15)
    elif root_l2 and str(content.get("scheme_group") or "").strip().lower() == root_l2:
        route_term = min(1.0, route_term + 0.10)

    clue_hits: list[str] = []
    for key, weight in PARAM_CLUE_WEIGHTS:
        values = param_clues.get(key) or set()
        if not values:
            continue
        candidate_value = str(content.get(key) or "").strip().lower()
        if candidate_value and candidate_value in values:
            clue_hits.append(key)
    if clue_hits:
        route_term = min(1.0, route_term + 0.10)

    if memory.get("state") == "reusable":
        credibility_term = min(1.0, credibility_term + 0.05)
    elif memory.get("state") == "validated":
        credibility_term = min(1.0, credibility_term + 0.03)

    boundary_term, boundary_available, boundary_reason = _boundary_match(
        memory,
        float(config.get("unknown_boundary_score", 0.5)),
    )
    risk_term, risk_reasons = _risk_penalty(memory)
    weighted = {
        "route_match": route_term * float(weights.get("route_match", 0.0)),
        "credibility": credibility_term * float(weights.get("credibility", 0.0)),
        "boundary_match": boundary_term * float(weights.get("boundary_match", 0.0)),
        "risk_penalty": risk_term * float(weights.get("risk_penalty", 0.0)),
    }
    total = weighted["route_match"] + weighted["credibility"] + weighted["boundary_match"] - weighted["risk_penalty"]
    result = {
        "route_match": round(route_term, 6),
        "credibility": round(credibility_term, 6),
        "boundary_match": round(boundary_term, 6),
        "risk_penalty": round(risk_term, 6),
        "weighted": {key: round(value, 6) for key, value in weighted.items()},
        "total": round(total, 6),
        "route_fields": route_fields,
        "parameter_clue_hits": clue_hits,
        "boundary_available": boundary_available,
        "boundary_reason": boundary_reason,
        "risk_reasons": risk_reasons,
        "credibility_mode": "echo_lcb" if use_bayesian_credibility else "raw_pass_rate",
        "bayesian_config": config["bayesian"] if use_bayesian_credibility else None,
        "config_version": config.get("version"),
    }
    _SCORE_BREAKDOWN_CACHE[cache_key] = result
    return result


def rank_memories(
    memories: list[dict[str, Any]],
    root: dict[str, Any],
    param_clues: dict[str, set[str]],
    *,
    use_bayesian_credibility: bool = True,
    query: dict[str, Any] | None = None,
    ranker_config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    config = _config(ranker_config)
    cache_key = (
        tuple(id(memory) for memory in memories),
        _frozen_value(root),
        _frozen_value(param_clues),
        bool(use_bayesian_credibility),
        _frozen_value(query or {}),
        _config_key(config),
    )
    cached = _RANKED_MEMORIES_CACHE.get(cache_key)
    if cached is not None:
        return list(cached)
    ranked = sorted(
        memories,
        key=lambda m: memory_candidate_score(
            m,
            root,
            param_clues,
            use_bayesian_credibility=use_bayesian_credibility,
            query=query,
            ranker_config=ranker_config,
        ),
        reverse=True,
    )
    _RANKED_MEMORIES_CACHE[cache_key] = tuple(ranked)
    return ranked
