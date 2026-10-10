"""Bayesian credibility from long-eval pass/fail counts (ECHO-Mem module A).

Uses Beta-Binomial with prior Beta(alpha0, beta0). The primary score for ranking
is the lower confidence bound (LCB) of the posterior — so 1/1 pass does not
rank above 100/120 pass.

Consumed by pipeline/scoring/score.py as strategy_effectiveness (A-2).
Not used directly in Shadow「候选准备」yet (B-1 plan_ranker will wire Credibility).
"""

from __future__ import annotations

import math
from functools import lru_cache
from typing import Any

DEFAULT_ALPHA0 = 1.0
DEFAULT_BETA0 = 1.0
DEFAULT_LCB_Q = 0.05


def _clip01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def long_eval_success_fail(metrics: dict[str, Any]) -> tuple[int, int]:
    """Long-eval outcomes used for effect calibration (not full support_count)."""
    s = int(metrics.get("long_eval_pass_count") or 0)
    f = int(metrics.get("long_eval_fail_count") or 0)
    return max(0, s), max(0, f)


def raw_pass_rate(success: int, failure: int) -> float | None:
    total = success + failure
    if total <= 0:
        return None
    return success / total


# --- Regularized incomplete beta I_x(a,b) and quantile (stdlib only) ---


def _log_beta(a: float, b: float) -> float:
    return math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)


def _betacf(a: float, b: float, x: float, max_iter: int = 200, eps: float = 3e-14) -> float:
    """Continued fraction for incomplete beta (Numerical Recipes style)."""
    am = bm = 1.0
    az = 1.0
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    bz = 1.0 - qab * x / qap
    if abs(bz) < 1e-30:
        bz = 1e-30
    em = iter_count = 0
    tem = oldd = 1.0
    while iter_count < max_iter:
        em += 1.0
        tem = em + em
        d = em * (b - em) * x / ((qam + tem) * (a + tem))
        ap = az + d * am
        bp = bz + d * bm
        d = -(a + em) * (qab + em) * x / ((a + tem) * (qap + tem))
        app = ap + d * az
        bpp = bp + d * bz
        am = ap / bpp
        bm = bp / bpp
        az = app / bpp
        bz = 1.0
        if abs(app - oldd) < eps * abs(app):
            return az
        oldd = app
        iter_count += 1
    return az


def _regularized_incomplete_beta(x: float, a: float, b: float) -> float:
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    bt = math.exp(
        math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
        + a * math.log(x)
        + b * math.log(1.0 - x)
    )
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * _betacf(a, b, x) / a
    return 1.0 - bt * _betacf(b, a, 1.0 - x) / b


def beta_posterior_quantile(
    alpha: float,
    beta: float,
    q: float,
    *,
    max_bisect: int = 64,
) -> float:
    """Quantile of Beta(alpha, beta) at probability q in (0, 1)."""
    q = _clip01(q)
    if q <= 0.0:
        return 0.0
    if q >= 1.0:
        return 1.0
    lo, hi = 0.0, 1.0
    for _ in range(max_bisect):
        mid = (lo + hi) * 0.5
        if _regularized_incomplete_beta(mid, alpha, beta) < q:
            lo = mid
        else:
            hi = mid
    return (lo + hi) * 0.5


@lru_cache(maxsize=20000)
def credibility_from_counts(
    success: int,
    failure: int,
    *,
    alpha0: float = DEFAULT_ALPHA0,
    beta0: float = DEFAULT_BETA0,
    lcb_q: float = DEFAULT_LCB_Q,
) -> dict[str, Any]:
    """Posterior Beta(alpha0+s, beta0+f); return mean, LCB, and diagnostics."""
    s = max(0, int(success))
    f = max(0, int(failure))
    a0 = max(1e-9, float(alpha0))
    b0 = max(1e-9, float(beta0))
    pa = a0 + s
    pb = b0 + f
    mean = pa / (pa + pb)
    lcb = beta_posterior_quantile(pa, pb, lcb_q) if (s + f) > 0 else mean
    raw = raw_pass_rate(s, f)
    return {
        "success_count": s,
        "failure_count": f,
        "eval_total": s + f,
        "alpha0": a0,
        "beta0": b0,
        "posterior_alpha": pa,
        "posterior_beta": pb,
        "posterior_mean": round(mean, 6),
        "credibility_lcb": round(_clip01(lcb), 6),
        "lcb_quantile": lcb_q,
        "raw_pass_rate": round(raw, 6) if raw is not None else None,
        "log_beta_normalizer": round(_log_beta(pa, pb), 6),
    }


def credibility_from_metrics(
    metrics: dict[str, Any],
    *,
    alpha0: float = DEFAULT_ALPHA0,
    beta0: float = DEFAULT_BETA0,
    lcb_q: float = DEFAULT_LCB_Q,
) -> dict[str, Any]:
    s, f = long_eval_success_fail(metrics)
    return credibility_from_counts(s, f, alpha0=alpha0, beta0=beta0, lcb_q=lcb_q)


def credibility_score(metrics: dict[str, Any], **kwargs: Any) -> float:
    """Single [0,1] score for strategy_effectiveness / future plan_ranker Credibility."""
    return float(credibility_from_metrics(metrics, **kwargs)["credibility_lcb"])
