"""Composable credibility scoring for long-eval pass/fail evidence.

The scorer keeps a conservative LCB blend as the default, while letting
experiments combine several credibility estimators with weights.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .bayesian_score import credibility_from_metrics, long_eval_success_fail, raw_pass_rate

DEFAULT_CREDIBILITY_WEIGHTS = {
    "bayesian_lcb": 0.7,
    "wilson_lcb": 0.3,
}
SUPPORTED_CREDIBILITY_COMPONENTS = {
    "bayesian_lcb",
    "wilson_lcb",
    "raw_pass_rate",
    "support_confidence",
}


@dataclass(frozen=True)
class CredibilityConfig:
    weights: dict[str, float]

    @classmethod
    def default(cls) -> "CredibilityConfig":
        return cls(dict(DEFAULT_CREDIBILITY_WEIGHTS))


def _clip01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def normalize_weights(weights: dict[str, float], supported: set[str]) -> dict[str, float]:
    cleaned: dict[str, float] = {}
    for key, value in weights.items():
        if key not in supported:
            raise ValueError(f"unsupported weight key: {key}")
        weight = float(value)
        if weight < 0:
            raise ValueError(f"weight must be non-negative: {key}={value}")
        if weight > 0:
            cleaned[key] = weight
    total = sum(cleaned.values())
    if total <= 0:
        raise ValueError("at least one positive weight is required")
    return {key: value / total for key, value in cleaned.items()}


def parse_weight_spec(
    spec: str | None,
    *,
    default: dict[str, float],
    supported: set[str],
) -> dict[str, float]:
    """Parse ``a=0.7,b=0.3`` into normalized weights.

    A bare component name such as ``wilson_lcb`` is shorthand for
    ``wilson_lcb=1``. Empty spec returns the normalized default.
    """
    if not spec:
        return normalize_weights(default, supported)
    raw: dict[str, float] = {}
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" in part:
            key, value = part.split("=", 1)
            raw[key.strip()] = float(value.strip())
        else:
            raw[part] = 1.0
    return normalize_weights(raw, supported)


def wilson_lcb(success: int, failure: int, *, z: float = 1.6448536269514722) -> float:
    """Wilson lower confidence bound for a Bernoulli pass rate.

    Default z is approximately the one-sided 95% lower bound, matching the
    conservative spirit of the Bayesian 5% LCB already used by the project.
    """
    s = max(0, int(success))
    f = max(0, int(failure))
    n = s + f
    if n <= 0:
        return 0.5
    phat = s / n
    z2 = z * z
    denom = 1.0 + z2 / n
    centre = phat + z2 / (2.0 * n)
    margin = z * math.sqrt((phat * (1.0 - phat) + z2 / (4.0 * n)) / n)
    return _clip01((centre - margin) / denom)


def support_confidence(success: int, failure: int, *, saturation: int = 20) -> float:
    """Confidence from evidence volume only, independent of pass rate."""
    total = max(0, int(success)) + max(0, int(failure))
    return _clip01(math.log1p(total) / math.log1p(max(1, saturation)))


def credibility_from_metrics_weighted(
    metrics: dict[str, Any],
    config: CredibilityConfig | None = None,
) -> dict[str, Any]:
    cfg = config or CredibilityConfig.default()
    weights = normalize_weights(cfg.weights, SUPPORTED_CREDIBILITY_COMPONENTS)
    success, failure = long_eval_success_fail(metrics)
    total = success + failure
    bayesian = credibility_from_metrics(metrics)
    raw = raw_pass_rate(success, failure)

    components = {
        "bayesian_lcb": float(bayesian["credibility_lcb"]),
        "wilson_lcb": wilson_lcb(success, failure),
        "raw_pass_rate": 0.5 if raw is None else float(raw),
        "support_confidence": support_confidence(success, failure),
    }
    score = sum(weights[key] * components[key] for key in weights)
    method = "+".join(f"{key}:{weights[key]:.3f}" for key in sorted(weights))
    return {
        "method": method,
        "score": round(_clip01(score), 6),
        "weights": {key: round(value, 6) for key, value in weights.items()},
        "components": {key: round(_clip01(value), 6) for key, value in components.items()},
        "success_count": success,
        "failure_count": failure,
        "eval_total": total,
        "raw_pass_rate": round(raw, 6) if raw is not None else None,
        "bayesian": bayesian,
    }


def credibility_score_weighted(
    metrics: dict[str, Any],
    config: CredibilityConfig | None = None,
) -> float:
    return float(credibility_from_metrics_weighted(metrics, config)["score"])
