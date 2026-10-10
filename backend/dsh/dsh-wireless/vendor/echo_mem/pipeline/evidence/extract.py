"""TraceRecord → 5 类 EvidenceUnit。

每条 trace 至少产出：
- 1 条 identification_evidence（工单/小区/问题类型）
- 1 条 root_cause_evidence（type1+type2 根因标签；兼容旧字段 param_kind/scheme_group）
- 每个 action 1 条 strategy_evidence
- 每个 action 1 条 execution_evidence
- 每个 action 1 条 evaluation_evidence

调用：
    python -m pipeline.evidence.extract \
        --in  data/staged/trace_records.jsonl \
        --out data/compiled/evidence_units.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from ..common import io as cio
from ..common import paths as P
from ..common.compile_eligibility import is_compile_effect_eligible
from ..common.schema_check import validate
from ..compile.outcome_compilation import materialize_evidence_authority


def _action_root_cause_parts(action: dict) -> tuple[str | None, str | None, str | None]:
    l1 = action.get("root_cause_l1") or action.get("param_kind")
    l2 = action.get("root_cause_l2") or action.get("scheme_group")
    l1 = str(l1).strip() if l1 else None
    l2 = str(l2).strip() if l2 else None
    key = action.get("root_cause_key")
    key = str(key).strip() if key else None
    if not key:
        key = " / ".join([x for x in [l1, l2] if x]) or None
    return l1, l2, key


def _eid(trace_id: str, kind: str, action_id: str | None = None) -> str:
    if action_id:
        return f"e_{kind}_{trace_id}_{action_id}"
    return f"e_{kind}_{trace_id}"


def extract_identification(trace: dict) -> dict:
    tid = trace["trace_id"]
    t = trace["ticket"]
    payload = {
        "phenomenon": t.get("primary_issue_type"),
        "province_phenomenon": t.get("province_issue_type"),
        "ticket_type": t.get("ticket_type"),
        "scene": {
            "region": t.get("region"),
            "band": t.get("band"),
            "indoor": t.get("is_indoor"),
            "system": t.get("system"),
            "vendor": t.get("vendor"),
        },
    }
    return {
        "evidence_id": _eid(tid, "ident"),
        "trace_id": tid,
        "ticket_id": t["id"],
        "action_id": None,
        "evidence_type": "identification_evidence",
        "confidence": "direct",
        "payload": payload,
        "narrative": f"问题类型: {payload['phenomenon']}; 区域: {payload['scene']['region']}",
        "extracted_by": "rule",
        "extracted_at": cio.now_iso(),
    }


def extract_root_cause(trace: dict) -> dict:
    tid = trace["trace_id"]
    t = trace["ticket"]
    root_l1 = Counter()
    root_l2 = Counter()
    root_keys = Counter()
    for action in trace["actions"]:
        l1, l2, key = _action_root_cause_parts(action)
        if l1:
            root_l1[l1] += 1
        if l2:
            root_l2[l2] += 1
        if key:
            root_keys[key] += 1
    groups = Counter(a.get("scheme_group") for a in trace["actions"] if a.get("scheme_group"))
    objs = Counter(a.get("param_object") for a in trace["actions"] if a.get("param_object"))
    schemes = Counter(a.get("scheme_id") for a in trace["actions"] if a.get("scheme_id"))

    primary_key = root_keys.most_common(1)[0][0] if root_keys else None
    primary_l1 = root_l1.most_common(1)[0][0] if root_l1 else None
    primary_l2 = root_l2.most_common(1)[0][0] if root_l2 else None
    inferred = primary_key or "未知根因"

    payload = {
        "inferred_root_cause": inferred,
        "primary_root_cause": inferred,
        "primary_root_cause_l1": primary_l1,
        "primary_root_cause_l2": primary_l2,
        "root_cause_keys": [k for k, _ in root_keys.most_common(5)],
        "proxy_kind": "trace_label",
        "not_for_rca_input": False,
        "basis": {
            "root_cause_l1_top": [x for x, _ in root_l1.most_common(3)],
            "root_cause_l2_top": [x for x, _ in root_l2.most_common(3)],
            "root_cause_key_top": [x for x, _ in root_keys.most_common(5)],
            "scheme_group_top": [g for g, _ in groups.most_common(3)],
            "param_object_top": [o for o, _ in objs.most_common(3)],
            "scheme_ids": [s for s, _ in schemes.most_common(5)],
            "issue_type": t.get("primary_issue_type"),
        },
        "confidence_basis": "type1/type2 为源数据给出的一级/二级根因标签；type3 只作动作级方案生成参考。",
    }
    return {
        "evidence_id": _eid(tid, "rca"),
        "trace_id": tid,
        "ticket_id": t["id"],
        "action_id": None,
        "evidence_type": "root_cause_evidence",
        "confidence": "direct",
        "payload": payload,
        "narrative": f"根因标签: {inferred}",
        "extracted_by": "rule",
        "extracted_at": cio.now_iso(),
    }


def extract_strategy(trace: dict) -> list[dict]:
    out: list[dict] = []
    tid = trace["trace_id"]
    tk = trace["ticket"]
    for a in trace["actions"]:
        payload = {
            "scheme_id": a.get("scheme_id"),
            "scheme_group": a.get("scheme_group"),
            "param_object": a.get("param_object"),
            "param_en_name": a.get("param_en_name"),
            "site_param_object": a.get("site_param_object"),
            "site_param_en_name": a.get("site_param_en_name"),
            "param_cn_name": a.get("param_cn_name"),
            "before_value": a.get("before_value"),
            "after_value": a.get("after_value"),
            "value_rule": a.get("value_rule"),
            "adjustment_rule": a.get("adjustment_rule"),
            "verbal_desc": a.get("verbal_desc"),
        }
        out.append({
            "evidence_id": _eid(tid, "strat", a["action_id"]),
            "trace_id": tid,
            "ticket_id": tk["id"],
            "action_id": a["action_id"],
            "evidence_type": "strategy_evidence",
            "confidence": "direct",
            "payload": payload,
            "narrative": (a.get("verbal_desc") or
                          f"{a.get('param_cn_name')}: {a.get('before_value')}→{a.get('after_value')}"),
            "extracted_by": "rule",
            "extracted_at": cio.now_iso(),
        })
    return out


def extract_execution(trace: dict) -> list[dict]:
    out: list[dict] = []
    tid = trace["trace_id"]
    tk = trace["ticket"]
    for a in trace["actions"]:
        payload = {
            "issued_state": a.get("issued_state"),
            "exec_state": a.get("exec_state"),
            "exec_failure_reason": a.get("exec_failure_reason"),
            "rollback_state": a.get("rollback_state"),
        }
        nar = f"执行: {a.get('exec_state')}"
        if a.get("exec_failure_reason"):
            nar += f"; 失败原因: {a['exec_failure_reason'][:40]}"
        out.append({
            "evidence_id": _eid(tid, "exec", a["action_id"]),
            "trace_id": tid,
            "ticket_id": tk["id"],
            "action_id": a["action_id"],
            "evidence_type": "execution_evidence",
            "confidence": "direct",
            "payload": payload,
            "narrative": nar,
            "extracted_by": "rule",
            "extracted_at": cio.now_iso(),
        })
    return out


def extract_evaluation(trace: dict) -> list[dict]:
    out: list[dict] = []
    tid = trace["trace_id"]
    tk = trace["ticket"]
    aggregate = trace.get("aggregate") or {}
    bundle_scope = str(aggregate.get("maximum_attribution_scope") or "unresolved")
    bundle_role = str(aggregate.get("outcome_role") or "unresolved")
    bundle_outcome = str(
        aggregate.get("bundle_outcome")
        or aggregate.get("ticket_outcome")
        or "long_eval_unknown"
    )
    out.append({
        "evidence_id": _eid(tid, "eval_bundle"),
        "trace_id": tid,
        "ticket_id": tk["id"],
        "action_id": None,
        "evidence_type": "evaluation_evidence",
        "confidence": (
            "direct"
            if bundle_scope == "bundle_direct" and bundle_role != "unresolved"
            else "weak"
        ),
        "payload": {
            "long_eval": bundle_outcome,
            "maximum_attribution_scope": bundle_scope,
            "outcome_role": bundle_role,
            "result_evidence_eligible": bool(
                aggregate.get("result_evidence_eligible")
            ),
            "evidence_authority_basis": aggregate.get("evidence_authority_basis"),
            "evidence_level": "realized_bundle",
        },
        "narrative": f"实际执行方案包长评估: {bundle_outcome}",
        "extracted_by": "rule",
        "extracted_at": cio.now_iso(),
    })
    for a in trace["actions"]:
        short_eval = a.get("short_eval_result")
        long_eval = a.get("long_eval_result")
        scope = str(a.get("maximum_attribution_scope") or "unresolved")
        role = str(a.get("outcome_role") or "unresolved")
        payload = {
            "short_eval": short_eval,
            "long_eval": long_eval,
            "short_eval_effective": bool(short_eval and "未启用" not in short_eval),
            "maximum_attribution_scope": scope,
            "outcome_role": role,
            "result_evidence_eligible": bool(a.get("result_evidence_eligible")),
            "evidence_authority_basis": a.get("evidence_authority_basis"),
            "associated_bundle_outcome": a.get("associated_bundle_outcome"),
            "associated_bundle_outcome_role": a.get("associated_bundle_outcome_role"),
            "evidence_level": "action_or_component_relation",
        }
        out.append({
            "evidence_id": _eid(tid, "eval", a["action_id"]),
            "trace_id": tid,
            "ticket_id": tk["id"],
            "action_id": a["action_id"],
            "evidence_type": "evaluation_evidence",
            "confidence": (
                "direct"
                if scope == "action_direct" and role != "unresolved"
                else "weak"
            ),
            "payload": payload,
            "narrative": f"长评估: {long_eval}",
            "extracted_by": "rule",
            "extracted_at": cio.now_iso(),
        })
    return out


def extract_all(trace: dict) -> list[dict]:
    if not (trace.get("aggregate") or {}).get("maximum_attribution_scope"):
        materialized, _ = materialize_evidence_authority([trace])
        trace = materialized[0]
    out: list[dict] = []
    out.append(extract_identification(trace))
    out.append(extract_root_cause(trace))
    out.extend(extract_strategy(trace))
    out.extend(extract_execution(trace))
    out.extend(extract_evaluation(trace))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default=str(P.TRACE_RECORDS_JSONL))
    ap.add_argument("--out", default=str(P.EVIDENCE_UNITS_JSONL))
    ap.add_argument(
        "--effect-only",
        action="store_true",
        help="仅抽取效果学习池工单（long_eval_pass/mixed/fail）的证据",
    )
    args = ap.parse_args()

    P.ensure_dirs()
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n_in = 0
    n_skipped = 0
    n_out = 0
    bad = 0
    with out_path.open("w", encoding="utf-8") as fout:
        for trace in cio.read_jsonl(args.inp):
            n_in += 1
            if args.effect_only and not is_compile_effect_eligible(trace):
                n_skipped += 1
                continue
            for ev in extract_all(trace):
                errs = validate(ev, "evidence_unit")
                if errs:
                    bad += 1
                    if bad <= 3:
                        print(f"[evidence] bad: {errs}", file=sys.stderr)
                fout.write(json.dumps(ev, ensure_ascii=False) + "\n")
                n_out += 1
            if n_in % 1000 == 0:
                print(f"[evidence] processed {n_in} traces, wrote {n_out} evidence units", file=sys.stderr)
    print(
        f"[evidence] DONE: in={n_in} skipped={n_skipped} out={n_out} bad={bad} "
        f"effect_only={args.effect_only}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
