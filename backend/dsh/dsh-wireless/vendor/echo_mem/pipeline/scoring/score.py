"""MemoryObject 六维评分。

输出 data/compiled/memory_scores.jsonl，并把 score_ref 写回 memory_objects.jsonl。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from ..common import io as cio
from ..common import paths as P
from ..common.schema_check import validate
from .bayesian_score import credibility_from_metrics
from .credibility import (
    DEFAULT_CREDIBILITY_WEIGHTS,
    SUPPORTED_CREDIBILITY_COMPONENTS,
    CredibilityConfig,
    credibility_from_metrics_weighted,
    credibility_score_weighted,
    parse_weight_spec,
)

DEFAULT_WEIGHTS = {
    "evidence_completeness": 0.15,
    "evaluation_credibility": 0.20,
    "strategy_effectiveness": 0.25,
    "risk_intensity": 0.15,
    "boundary_clarity": 0.10,
    "reusability": 0.15,
}

TR_REUSABLE_MIN_LCB = 0.55


def _clip01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def _parse_overall_weights(spec: str | None) -> dict[str, float]:
    merged = dict(DEFAULT_WEIGHTS)
    if spec:
        for part in spec.split(","):
            part = part.strip()
            if not part:
                continue
            if "=" not in part:
                raise ValueError(f"overall weight must use key=value: {part}")
            key, value = part.split("=", 1)
            key = key.strip()
            if key not in DEFAULT_WEIGHTS:
                raise ValueError(f"unsupported overall weight key: {key}")
            weight = float(value.strip())
            if weight < 0:
                raise ValueError(f"overall weight must be non-negative: {key}={value}")
            merged[key] = weight
    total = sum(merged.values())
    if total <= 0:
        raise ValueError("at least one positive overall weight is required")
    return {key: value / total for key, value in merged.items()}


def evidence_completeness(memory: dict) -> float:
    """根据该 memory 关联的 evidence_ids 数量 + 关键字段非空率粗算。"""
    ev_count = len(memory.get("evidence_ids", []))
    has_ap = 1 if memory.get("applicability", {}).get("issue_types") else 0
    content_ok = 1 if memory.get("content") else 0
    # 期望至少 5 条 evidence_ids（识别/根因/方案/执行/评估各一）
    return _clip01(0.5 * min(1.0, ev_count / 5.0) + 0.25 * has_ap + 0.25 * content_ok)


def evaluation_credibility(metrics: dict) -> float:
    total = metrics.get("long_eval_pass_count", 0) + metrics.get("long_eval_fail_count", 0)
    support = max(1, metrics.get("support_count", 1))
    return _clip01(total / support if support else 0)


def strategy_effectiveness(metrics: dict, credibility_config: CredibilityConfig | None = None) -> float:
    """Credibility-weighted long-eval effectiveness (default: Bayesian LCB)."""
    return credibility_score_weighted(metrics, credibility_config)


def risk_intensity(metrics: dict) -> float:
    """风险越低，分越高。"""
    support = max(1, metrics.get("support_count", 1))
    exec_fail = metrics.get("exec_fail_count", 0)
    audit_to = metrics.get("audit_timeout_count", 0)
    long_fail = metrics.get("long_eval_fail_count", 0)
    weighted = (exec_fail + 0.5 * audit_to + 0.7 * long_fail) / support
    return _clip01(1.0 - min(1.0, weighted))


def boundary_clarity(applicability: dict) -> float:
    """适用边界越聚拢越清晰。"""
    issue_n = len(applicability.get("issue_types", []))
    vendor_n = len(applicability.get("vendors", []))
    region_n = len(applicability.get("regions", []))
    scheme_n = len(applicability.get("scheme_ids", []))
    exclusions = len(applicability.get("exclusions", []))

    # 单一 issue / 单一 vendor 加分；region/scheme 过散减分
    score = 0.4 * (1.0 if issue_n == 1 else 0.6 if issue_n == 2 else 0.3)
    score += 0.2 * (1.0 if vendor_n == 1 else 0.6 if vendor_n in (0, 2) else 0.3)
    score += 0.2 * (1.0 / (1.0 + math.log1p(max(0, region_n - 1))))
    score += 0.1 * (1.0 / (1.0 + math.log1p(max(0, scheme_n - 1))))
    score += 0.1 * min(1.0, exclusions / 2.0)
    return _clip01(score)


def reusability(memory: dict, metrics: dict) -> float:
    support = max(1, metrics.get("support_count", 1))
    # log scale
    s_log = math.log1p(support) / math.log1p(20)
    # 类型权重
    type_weight = {
        "case_memory": 0.5,
        "rca_memory": 0.3,
        "strategy_memory": 1.0,
        "playbook_memory": 1.0,
        "risk_memory": 0.7,
        "counter_evidence_memory": 0.7,
    }.get(memory["memory_type"], 0.5)
    return _clip01(0.7 * s_log + 0.3 * type_weight)


def overall(parts: dict, weights: dict) -> float:
    total = 0.0
    for k, w in weights.items():
        total += w * parts.get(k, 0.0)
    return _clip01(total)


def score_memory(
    memory: dict,
    weights: dict | None = None,
    credibility_config: CredibilityConfig | None = None,
) -> dict:
    w = weights or DEFAULT_WEIGHTS
    metrics = memory.get("metrics", {})
    app = memory.get("applicability", {})

    is_rca_label = memory.get("memory_type") == "rca_memory"
    bayesian: dict | None = None
    credibility: dict | None = None
    if is_rca_label:
        parts = {
            "evidence_completeness": evidence_completeness(memory),
            # RCA labels come from source type1/type2. Long evaluation is not
            # used as effect evidence for RCA correctness.
            "evaluation_credibility": min(1.0, math.log1p(metrics.get("support_count", 0)) / math.log1p(10)),
            "strategy_effectiveness": 0.5,
            "risk_intensity": 0.8,
            "boundary_clarity": boundary_clarity(app),
            "reusability": min(0.6, reusability(memory, metrics)),
        }
    else:
        credibility = credibility_from_metrics_weighted(metrics, credibility_config)
        bayesian = credibility.get("bayesian")
        parts = {
            "evidence_completeness": evidence_completeness(memory),
            "evaluation_credibility": evaluation_credibility(metrics),
            "strategy_effectiveness": float(credibility["score"]),
            "risk_intensity": risk_intensity(metrics),
            "boundary_clarity": boundary_clarity(app),
            "reusability": reusability(memory, metrics),
        }
    parts["overall"] = overall(parts, w)

    out: dict = {
        "score_id": f"s_{memory['memory_id']}",
        "memory_id": memory["memory_id"],
        "evidence_completeness": round(parts["evidence_completeness"], 4),
        "evaluation_credibility": round(parts["evaluation_credibility"], 4),
        "strategy_effectiveness": round(parts["strategy_effectiveness"], 4),
        "risk_intensity": round(parts["risk_intensity"], 4),
        "boundary_clarity": round(parts["boundary_clarity"], 4),
        "reusability": round(parts["reusability"], 4),
        "overall": round(parts["overall"], 4),
        "weights": w,
        "scored_by": "rule_v1+scoring_v2",
        "scored_at": cio.now_iso(),
    }
    if credibility is not None:
        out["credibility"] = {
            "method": credibility["method"],
            "score": credibility["score"],
            "weights": credibility["weights"],
            "components": credibility["components"],
            "success_count": credibility["success_count"],
            "failure_count": credibility["failure_count"],
            "eval_total": credibility["eval_total"],
            "raw_pass_rate": credibility["raw_pass_rate"],
        }
    if bayesian is not None:
        out["bayesian_credibility"] = {
            "posterior_mean": bayesian["posterior_mean"],
            "credibility_lcb": bayesian["credibility_lcb"],
            "raw_pass_rate": bayesian["raw_pass_rate"],
            "success_count": bayesian["success_count"],
            "failure_count": bayesian["failure_count"],
            "lcb_quantile": bayesian["lcb_quantile"],
        }
    return out


def should_promote_reusable(
    memory: dict,
    score: dict,
    *,
    reusable_credibility_mode: str = "lcb",
) -> bool:
    if memory.get("memory_type") == "rca_memory":
        return False
    if reusable_credibility_mode == "none":
        credibility_ok = True
    elif reusable_credibility_mode == "score":
        credibility_ok = score.get("strategy_effectiveness", 0.0) >= TR_REUSABLE_MIN_LCB
    else:
        lcb = (score.get("bayesian_credibility") or {}).get("credibility_lcb", 0.0)
        credibility_ok = lcb >= TR_REUSABLE_MIN_LCB
    return (
        memory.get("state") == "validated"
        and score.get("overall", 0.0) >= 0.7
        and memory.get("metrics", {}).get("support_count", 0) >= 5
        and credibility_ok
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default=str(P.MEMORY_OBJECTS_JSONL))
    ap.add_argument("--out-scores", default=str(P.MEMORY_SCORES_JSONL))
    ap.add_argument("--out-memories", default=str(P.MEMORY_OBJECTS_JSONL))
    ap.add_argument(
        "--weights",
        default="",
        help=(
            "Overall dimension weights, e.g. "
            "strategy_effectiveness=0.35,risk_intensity=0.2. "
            "Unspecified dimensions keep defaults before normalization."
        ),
    )
    ap.add_argument(
        "--credibility-weights",
        default="",
        help=(
            "Credibility component weights. Examples: 'wilson_lcb' or "
            "'bayesian_lcb=0.5,wilson_lcb=0.5'. Supported: "
            + ",".join(sorted(SUPPORTED_CREDIBILITY_COMPONENTS))
        ),
    )
    ap.add_argument(
        "--reusable-credibility-mode",
        default="lcb",
        choices=["lcb", "score", "none"],
        help="Construction ablation switch for TR-002 reusable promotion.",
    )
    args = ap.parse_args()
    P.ensure_dirs()

    weights = _parse_overall_weights(args.weights)

    credibility_weights = parse_weight_spec(
        args.credibility_weights,
        default=DEFAULT_CREDIBILITY_WEIGHTS,
        supported=SUPPORTED_CREDIBILITY_COMPONENTS,
    )
    credibility_config = CredibilityConfig(credibility_weights)

    memories = list(cio.read_jsonl(args.inp))
    scores: list[dict] = []
    for m in memories:
        sc = score_memory(m, weights=weights, credibility_config=credibility_config)
        errs = validate(sc, "memory_score")
        if errs:
            print(f"[scoring] bad: {errs[:2]}", file=sys.stderr)
        scores.append(sc)
        m["score_ref"] = sc["score_id"]
        # 二次升级到 reusable（TR-002）
        if should_promote_reusable(
            m,
            sc,
            reusable_credibility_mode=args.reusable_credibility_mode,
        ):
            m["state"] = "reusable"

    Path(args.out_scores).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out_scores, "w", encoding="utf-8") as f:
        for s in scores:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    with open(args.out_memories, "w", encoding="utf-8") as f:
        for m in memories:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")

    avg = sum(s["overall"] for s in scores) / max(1, len(scores))
    print(f"[scoring] DONE: scored {len(scores)}, avg overall = {avg:.3f}", file=sys.stderr)


if __name__ == "__main__":
    main()
