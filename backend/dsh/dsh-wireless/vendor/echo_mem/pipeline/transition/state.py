"""按 docs/architecture/state-transition-rules.md 的规则迁移 MemoryObject.state。

输入：data/compiled/memory_objects.jsonl（draft 态）
产出：
- data/compiled/state_transitions.jsonl
- data/compiled/memory_objects.jsonl（state 字段就地更新）

规则评估顺序：TR-006 → TR-004 → TR-001 → TR-003 → TR-002
"""

from __future__ import annotations

import argparse
import json
import sys
from functools import lru_cache
from pathlib import Path

from ..common import io as cio
from ..common import paths as P
from ..common.schema_check import validate
from ..scoring.bayesian_score import credibility_from_counts


TR_VALIDATED_MIN_RAW_PASS_RATE = 0.70
TR_VALIDATED_MIN_LCB = 0.40
TR_VALIDATED_MIN_SUPPORT = 3
TR_COUNTER_EVIDENCE_MAX_RAW_PASS_RATE = 0.40
TR_COUNTER_EVIDENCE_MIN_FAIL = 3


@lru_cache(maxsize=4096)
def _cached_credibility(success: int, failure: int) -> dict:
    return credibility_from_counts(success, failure)


def _exec_fail_rate(metrics: dict) -> float:
    sup = max(1, metrics.get("support_count", 1))
    exec_fail = metrics.get("exec_fail_count", 0)
    return exec_fail / sup


def _safe_pass_rate(metrics: dict) -> float | None:
    pr = metrics.get("pass_rate")
    if isinstance(pr, (int, float)):
        return float(pr)
    pass_n = metrics.get("long_eval_pass_count", 0)
    fail_n = metrics.get("long_eval_fail_count", 0)
    total = pass_n + fail_n
    return pass_n / total if total > 0 else None


def evaluate(
    memory: dict,
    *,
    credibility_mode: str = "lcb",
    enable_counter_evidence_state: bool = True,
) -> tuple[str, str | None, dict]:
    """返回 (to_state, rule_id 或 None, evidence-stats)。

    rule_id is None 表示保留原 state。
    """
    metrics = memory.get("metrics", {})
    support = metrics.get("support_count", 0)
    pass_n = metrics.get("long_eval_pass_count", 0)
    fail_n = metrics.get("long_eval_fail_count", 0)
    pass_rate = _safe_pass_rate(metrics)
    has_eval = (pass_n + fail_n) > 0
    bayesian = _cached_credibility(pass_n, fail_n)
    credibility_lcb = bayesian["credibility_lcb"]
    posterior_mean = bayesian["posterior_mean"]
    credibility_gate = (
        pass_rate
        if credibility_mode == "raw_pass_rate" and pass_rate is not None
        else credibility_lcb
    )

    evidence = {
        "long_eval_pass_count": pass_n,
        "long_eval_fail_count": fail_n,
        "exec_fail_count": metrics.get("exec_fail_count", 0),
        "pass_rate": float(pass_rate) if pass_rate is not None else 0.0,
        "pass_rate_available": pass_rate is not None,
        "support_count": support,
        "credibility_gate_mode": credibility_mode,
        "credibility_gate_value": credibility_gate,
        "bayesian_credibility": {
            "posterior_mean": posterior_mean,
            "credibility_lcb": credibility_lcb,
            "lcb_quantile": bayesian["lcb_quantile"],
            "eval_total": bayesian["eval_total"],
        },
    }

    memory_type = memory.get("memory_type")

    # Process risks are informational; no eval-driven state migration.
    if memory_type == "risk_memory":
        return "draft", None, evidence

    # Effect counter-evidence is already compiled as a veto object.
    if memory_type == "counter_evidence_memory":
        return "counter_evidence", "TR-004", evidence

    # RCA objects are source labels in the current dataset: type1 is the
    # first-level root cause, type2 is the second-level root cause. They are
    # factual labels, not effect-tested strategies.
    if memory_type == "rca_memory":
        evidence["validation_boundary"] = "source_type1_type2_label"
        return "validated", "TR-RCA-LABEL", evidence

    # 优先处理执行失败超半数（TR-006）
    if memory_type in {"strategy_memory", "case_memory"}:
        if _exec_fail_rate(metrics) > 0.5 and support >= 1:
            return "restricted", "TR-006", evidence

    # 缺评估：保持 unverified
    if not has_eval:
        # case_memory 的 unverified 也可，由后续 scoring 决定
        return "unverified", None, evidence

    # TR-004 counter_evidence: strong historical failure remains a hard veto.
    if (
        enable_counter_evidence_state
        and
        pass_rate is not None
        and pass_rate < TR_COUNTER_EVIDENCE_MAX_RAW_PASS_RATE
        and fail_n >= TR_COUNTER_EVIDENCE_MIN_FAIL
    ):
        return "counter_evidence", "TR-004", evidence

    # TR-001 validated: positive raw direction plus enough support and a
    # conservative ECHO LCB. This prevents 1/1 pass from becoming validated.
    if (
        pass_rate is not None
        and pass_rate >= TR_VALIDATED_MIN_RAW_PASS_RATE
        and support >= TR_VALIDATED_MIN_SUPPORT
        and credibility_gate >= TR_VALIDATED_MIN_LCB
    ):
        # 后面 scoring 再看是否升级 reusable（要 overall_score、更高 support 与 LCB）。
        return "validated", "TR-001", evidence

    # TR-003 restricted
    if pass_rate is not None and 0.4 <= pass_rate < TR_VALIDATED_MIN_RAW_PASS_RATE:
        return "restricted", "TR-003", evidence

    # Low pass-rate but not enough failures for hard counter-evidence. It is
    # still evaluated, so keep it usable only with restrictions instead of
    # hiding it as unverified.
    if pass_rate is not None and pass_rate < 0.4:
        return "restricted", "TR-003", evidence

    return "unverified", None, evidence


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default=str(P.MEMORY_OBJECTS_JSONL))
    ap.add_argument("--out-transitions", default=str(P.STATE_TRANSITIONS_JSONL))
    ap.add_argument("--out-memories", default=str(P.MEMORY_OBJECTS_JSONL))
    ap.add_argument(
        "--credibility-mode",
        default="lcb",
        choices=["lcb", "raw_pass_rate"],
        help="Construction ablation switch: use LCB or bare pass rate for transition credibility gates.",
    )
    ap.add_argument(
        "--disable-counter-evidence-state",
        action="store_true",
        help="Construction ablation switch: keep low pass-rate strategy/playbook memories restricted instead of counter_evidence.",
    )
    args = ap.parse_args()

    P.ensure_dirs()
    memories = list(cio.read_jsonl(args.inp))
    transitions: list[dict] = []
    updated: list[dict] = []

    for m in memories:
        old_state = m.get("state", "draft")
        new_state, rule_id, ev = evaluate(
            m,
            credibility_mode=args.credibility_mode,
            enable_counter_evidence_state=not args.disable_counter_evidence_state,
        )
        if new_state != old_state:
            tid = f"tr_{m['memory_id']}_{rule_id or 'auto'}"
            trans = {
                "transition_id": tid,
                "memory_id": m["memory_id"],
                "from_state": old_state,
                "to_state": new_state,
                "trigger": _rule_to_trigger(rule_id, ev),
                "rule_id": rule_id or "TR-AUTO",
                "evidence": ev,
                "narrative": _narrative(m, old_state, new_state, rule_id, ev),
                "applicability_after": m.get("applicability", {}),
                "occurred_at": cio.now_iso(),
            }
            errs = validate(trans, "state_transition")
            if errs:
                print(f"[transition] bad transition: {errs[:2]}", file=sys.stderr)
            transitions.append(trans)
            m["state"] = new_state
        updated.append(m)

    # 写迁移
    Path(args.out_transitions).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out_transitions, "w", encoding="utf-8") as f:
        for t in transitions:
            f.write(json.dumps(t, ensure_ascii=False) + "\n")
    # 覆盖写回 memories（state 已更新）
    with open(args.out_memories, "w", encoding="utf-8") as f:
        for m in updated:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")

    print(
        f"[transition] memories={len(updated)} transitions={len(transitions)}",
        file=sys.stderr,
    )
    # 简单统计
    from collections import Counter
    state_dist = Counter(m["state"] for m in updated)
    print(f"[transition] state distribution: {dict(state_dist)}", file=sys.stderr)


def _rule_to_trigger(rule_id: str | None, ev: dict) -> str:
    if rule_id == "TR-001":
        return "echo_lcb_validated"
    if rule_id == "TR-002":
        return "scoring_threshold"
    if rule_id == "TR-003":
        return "long_eval_mixed"
    if rule_id == "TR-004":
        return "long_eval_fail_majority"
    if rule_id == "TR-005":
        return "manual_override"
    if rule_id == "TR-006":
        return "exec_failure_blocker"
    return "long_eval_mixed"


def _narrative(m: dict, fr: str, to: str, rule_id: str | None, ev: dict) -> str:
    pr = ev.get("pass_rate")
    pr_text = f"{pr:.2f}" if ev.get("pass_rate_available", True) and isinstance(pr, (int, float)) else "N/A"
    bayes = ev.get("bayesian_credibility") if isinstance(ev.get("bayesian_credibility"), dict) else {}
    lcb = bayes.get("credibility_lcb")
    lcb_text = f"{lcb:.2f}" if isinstance(lcb, (int, float)) else "N/A"
    return (
        f"[{rule_id or 'auto'}] {m['memory_type']} '{m.get('title','')}' "
        f"由 {fr} → {to}；通过率 {pr_text}，ECHO LCB {lcb_text}，"
        f"支持 trace {ev.get('support_count')}。"
    )


if __name__ == "__main__":
    main()
