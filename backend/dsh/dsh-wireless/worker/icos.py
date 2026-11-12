"""Phase-level adapter for the pinned ICOS kernels. JSON stdin/stdout; no external IO."""
from __future__ import annotations

import csv
from dataclasses import asdict, is_dataclass, replace
import hashlib
import json
import logging
from pathlib import Path
import sys

VENDOR = Path(__file__).resolve().parents[1] / "vendor/icos"
sys.path.insert(0, str(VENDOR))
import icos_llm
sys.modules["services.common.llm"] = icos_llm
logging.disable(logging.CRITICAL)

from services.common.config import build_settings, set_settings
from services.cases.vocab import get_vocab
from services.compliance import rule_library
from services.compliance.rule_constraint import format_para_text_value
from services.decision import cause_alignment, cause_convergence, order_review, relevance
from services.decision.candidate_set import build_candidate_set, group_plans_by_group
from services.decision.case_evidence import (
    ActionQuery, CaseActionFact, CaseFact, EvidencePolicy, OrderContext,
    build_case_evidence, direction_of, outcome_of, parse_number,
)
from services.decision.case_steps import case_step_advice, shrink_hint
from services.decision.cause_dimensions import converge_order, dimension_verdicts
from services.decision.chain import (
    ChainStage, assess_rules, drop_by_alignment, drop_by_review, drop_conflicts,
    enforced_note, resolve_conditions, select_plans,
)
from services.decision.multi_round import (
    assign_carriers, chain_view, plan_multi_round_steps, plan_rollback, prior_rounds_doc,
)
from services.decision.plan_table import plan_key, rule_basis
from services.decision.prior_round import build_prior_rounds, classify_short_assess, MultiRoundAction, parameter_key
from services.decision.risk import assess_action_risk, summarize_dispatch_risk
from services.decision.root_cause import root_cause_groups, root_cause_refs
from services.decision.rule_assessment import assess_plan_feasibility, with_case_steps
from services.decision.verdict import _build_objective, _fact_issues, build_order_decision


def plain(value):
    if hasattr(value, "to_dict"):
        return plain(value.to_dict())
    if is_dataclass(value):
        return {key: plain(item) for key, item in asdict(value).items()}
    if isinstance(value, dict):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [plain(item) for item in value]
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


class JudgmentClient(icos_llm.LLMClient):
    def __init__(self, key, judgment=None, bypass_reason=""):
        self.key, self.judgment, self.bypass_reason = key, judgment, bypass_reason
        self.requests = []

    def complete_json(self, prompt, **kwargs):
        if self.judgment is not None:
            return self.judgment, json.dumps(self.judgment, ensure_ascii=False), 1
        if not self.bypass_reason:
            self.requests.append({"key": self.key, "scene": kwargs.get("scene"), "prompt": prompt})
        raise icos_llm.LLMError(self.bypass_reason or "Awaiting Harness judgment")


class Analysis:
    def __init__(self, state, args):
        self.data, self.stages, self.args = state["input"], state.get("stages", {}), args
        self.order, self.plans = self.data["order"], self.data.get("initial_plans", [])
        self.retry = self.data.get("retry_times", 0)
        self.threshold = self.data.get("confidence_threshold", 40)
        settings = build_settings({}, config_path="<harness-icos-input>")
        self.settings = replace(settings, decision=replace(settings.decision,
            root_cause_confidence_threshold=self.threshold, max_actions=200))
        set_settings(self.settings)
        if "rules" in self.data:
            import pandas as pd
            frame = pd.DataFrame(self.data["rules"])
            # Source CSV always has these columns; optional snapshot fields stay unknown,
            # while the original matcher can still use its normal fallback/tie-breaking.
            for column in (*rule_library.MATCH_KEYS, "band", "execute_number", "is_use"):
                if column not in frame:
                    frame[column] = ""
            if "is_use" in frame:
                frame = frame.loc[~frame["is_use"].astype(str).str.strip().isin(["否", "false", "0"])]
            # Same matcher and tie-breaking as the source, over the submitted snapshot.
            rule_library.load_rules = lambda: frame
        self.vocab = get_vocab()
        with (VENDOR / "services/orders/task_type_replace.csv").open(encoding="utf-8-sig") as handle:
            self.task_types = {row["task_type"]: row["task_main_type"] for row in csv.DictReader(handle)}

    def request_args(self, stage):
        return self.args if self.args.get("stage") == stage else self.stages.get(stage, {}).get("request", {})

    def payload(self, plan=None):
        o = self.order
        return {"order_data": {"工单编号": o.get("taskno"), "工单ID": o.get("taskid"),
            "问题类型": self.task_types.get(o.get("task_type"), o.get("task_type")),
            "网络制式": o.get("nettype"), "小区名称": o.get("cell_name"), "小区CGI标识": o.get("cgi")},
            "reason_analyze": {"服务商": o.get("vendor"), "一级原因": o.get("type1"), "二级原因": o.get("type2")},
            **({"icos_init_plan": {key: value for key, value in plan.items() if key != "final_ratio"}} if plan else {})}

    def client(self, stage, key=None):
        args = self.request_args(stage)
        judgment = args.get("judgments", {}).get(key) if key is not None else args.get("judgment")
        return JudgmentClient(key or stage, judgment, args.get("bypass_reason", ""))

    def root(self):
        client = self.client("root_cause")
        judgment = client.judgment
        if judgment is not None:
            require(isinstance(judgment.get("causes"), list), "judgment.causes 必须是数组")
            require(len(judgment["causes"]) <= 5, "根因最多 5 条")
            texts = [str(self.order.get(key) or "") for key in ["conclusion", "smart_conclusion"]]
            texts += list(dimension_verdicts(self.order).values())
            for row in judgment["causes"]:
                require(isinstance(row, dict) and bool(row.get("cause")), "根因需要 cause")
                score = row.get("confidence")
                require(type(score) is int and 0 <= score <= 100, "confidence 必须为 0–100 整数，表示原文支撑强度")
                evidence = row.get("evidence")
                require(isinstance(evidence, str) and bool(evidence.strip()) and any(evidence in text for text in texts),
                    "根因 evidence 必须逐字引用输入原文")
        result = cause_convergence.converge_root_causes_llm(self.order.get("conclusion"), self.order.get("smart_conclusion"),
            dimensions=dimension_verdicts(self.order), task_type=self.order.get("task_type"), llm_client=client)
        return result, client.requests

    def cases(self):
        v, o = self.vocab, self.order
        context = OrderContext(taskno=o.get("taskno", ""), problem_key=v.problem(o.get("task_type")),
            nettype=v.nettype(o.get("nettype")), vendor=v.vendor(o.get("vendor")),
            cover_scene=o.get("scene") or o.get("cover_area") or "", city=o.get("city", ""))
        queries = []
        for p in self.plans:
            direction, delta = direction_of(p.get("f_para"), p.get("b_para"))
            queries.append(ActionQuery(key=plan_key(p.get("execution_id"), p.get("parachinname")),
                param_key=v.param(p.get("parachinname")).key, param_name=p["parachinname"], direction=direction,
                f_para=str(p.get("f_para", "")), b_para=str(p.get("b_para", "")), delta=delta,
                cause1_key=v.cause1(p.get("type1") or o.get("type1")),
                cause2_key=v.cause2(p.get("type2") or o.get("type2")), plan_number=str(p.get("plan_number", ""))))
        facts = []
        for case in self.data.get("cases", []):
            actions = []
            for a in case.get("actions", []):
                name = a.get("parachinname") or a.get("parameter") or a.get("param_name", "")
                before, after = a.get("f_para", a.get("before", "")), a.get("b_para", a.get("after", ""))
                direction, delta = direction_of(before, after, a.get("direction"))
                actions.append(CaseActionFact(param_key=v.param(name).key, param_name=name,
                    direction=direction, f_para=str(before), b_para=str(after), delta=delta))
            result = case.get("estimate_result", "")
            facts.append(CaseFact(case_id=case["case_id"], collection=case.get("collection", "curated"),
                outcome=outcome_of(result), estimate_result=result, actions=tuple(actions),
                problem_key=v.problem(case.get("problem_type") or case.get("task_type")),
                cause1_key=v.cause1(case.get("cause1") or case.get("type1")),
                cause2_key=v.cause2(case.get("cause2") or case.get("type2")),
                **{key: str(case.get(key, "")) for key in ["taskno", "city", "nettype", "vendor", "created"]}))
        return build_case_evidence(queries, context, facts, EvidencePolicy(), library_version="submitted-icos-snapshot")

    def multi_round(self):
        evals = {int(row["id"]): row for row in self.data.get("short_evals", [])}
        prior = build_prior_rounds(self.data.get("prior_execution_rows", []), evals, current_retry=self.retry,
            rule_of=lambda row: rule_basis(dict(row)).get("matched_rule"))
        evidence = self.cases()
        hints = {}
        for p in self.plans:
            hint = shrink_hint(evidence.basis(plan_key(p.get("execution_id"), p.get("parachinname"))))
            if hint is not None:
                hints[parameter_key(p["parachinname"])] = hint
        args = self.request_args("multi_round")
        steps = plan_rollback(prior) if args.get("rollback_only") else plan_multi_round_steps(prior, case_hints=hints)
        return prior, assign_carriers(steps, self.plans)

    def candidates(self):
        root, _ = self.root()
        evidence = self.cases()
        plans = []
        for row in self.plans:
            basis = evidence.basis(plan_key(row.get("execution_id"), row.get("parachinname")))
            plans.append({**row, **({relevance.CASE_BRIEF_KEY: basis.brief()} if basis and (basis.cases or basis.opposite) else {})})
        pending = []
        groups = dict(group_plans_by_group(plans))
        supplied = self.request_args("candidates").get("judgments", {})
        require(all(key in groups for key in supplied), "judgments 含不存在的方案组键")

        def judge(rows, brief):
            key = next(key for key, items in groups.items() if items == list(rows))
            client = self.client("candidates", key)
            if client.judgment is not None:
                selected = client.judgment.get("relevant_plans")
                require(isinstance(selected, list), "judgment.relevant_plans 必须是数组")
                known = {str(p.get("plan_number")) for p in rows}
                require(all(str(number) in known for number in selected), "只能选择本组已有 plan_number")
            output = relevance.judge_relevance_llm(rows, brief, llm_client=client)
            pending.extend(client.requests)
            return output

        result = build_candidate_set(plans, taskno=self.order["taskno"], retry_times=self.retry,
            relevance_of=judge, root_cause=relevance.RootCauseBrief(causes=root.confident(self.threshold)))
        return result, pending

    def alignment(self):
        root, _ = self.root()
        client = self.client("alignment")
        if client.judgment is not None:
            units = cause_alignment._units(self.plans)
            known = {u.plan_id for u in units}
            entries = client.judgment.get("plans")
            require(isinstance(entries, list), "judgment.plans 必须是数组")
            for row in entries:
                require(row.get("plan_id") in known and row.get("relation") in cause_alignment.RELATION_VOCAB,
                    "根因对齐必须使用本轮 plan_id 和提示词中的 relation 词表")
                require(all(name in {c.cause for c in root.causes} for name in row.get("causes", [])), "引用了未知根因")
        result = cause_alignment.align_root_causes_llm(root, self.plans, task_type=self.order.get("task_type"),
            threshold=self.threshold, llm_client=client)
        return result, client.requests

    def risks(self):
        evidence, out = self.cases(), {}
        for p in self.plans:
            key = plan_key(p.get("execution_id"), p.get("parachinname"))
            result = assess_plan_feasibility(self.payload(p), task_info=self.order, enforce_step_direction=True)
            if result.rule_row is not None and result.shape == "dispatchable":
                advice = case_step_advice(evidence.basis(key), result.rule_row.raw,
                    f_para=p.get("f_para"), b_para=p.get("b_para"), max_steps=3)
                result = with_case_steps(result, advice)
            out[key] = result
        return out

    def rows(self, chain=None, feasibility=None):
        feasibility = feasibility or {}
        entries = {a["plan_key"]: a for a in chain.decided} if chain else {}
        _, steps = self.multi_round() if self.retry > 0 else (None, {})
        rows = []
        for p in self.plans:
            key = plan_key(p.get("execution_id"), p.get("parachinname"))
            action = entries.get(key)
            solution = {"phase": "decision_chain"}
            step = steps.get(parameter_key(p["parachinname"]))
            if step is not None:
                solution.update(phase=step.phase, multi_round=step.to_dict())
            if action:
                solution["new_chain"] = enforced_note(stage=action["stage"], reason=action["reason"],
                    detail=action.get("detail", ""), dispatched=action["dispatched"], feasibility=feasibility.get(key))
            rows.append({"agent_decision_id": "ica_" + hashlib.sha256(key.encode()).hexdigest()[:24],
                "taskno": self.order["taskno"], "taskid": self.order.get("taskid"), "execution_id": p.get("execution_id"),
                "tool": p["parachinname"], "plan_number": p.get("plan_number"), "execute_number": p.get("execute_number"),
                "f_para": format_para_text_value(step.current if step is not None else p.get("f_para")), "org_b_para": str(p.get("b_para", "")),
                "b_para": action["value"] if action and action["dispatched"] else str(p.get("b_para", "")),
                "need_call_parameter_platform": "是" if action and action["dispatched"] else "否",
                "retry_times": self.retry, "order_info": self.payload(p), "llm_solution": solution})
        return rows

    def chain(self, reviewed=False):
        candidates, _ = self.candidates()
        prior, steps = self.multi_round()
        chain = select_plans(candidates, self.rows(), multi_round=chain_view(steps))
        alignment, _ = self.alignment()
        demotion, drops = alignment.plan_demotions()
        if drops:
            dropped, kept_all = drop_by_alignment(chain, drops)
            alignment = alignment.with_demotion("kept_all" if kept_all else demotion,
                [entry["plan_key"] for entry in chain.decided if entry["key"] in dropped])
        feasibility = self.risks()
        assess_rules(chain, feasibility)
        drop_conflicts(chain)
        resolve_conditions(chain, enforce_step_direction=True)
        review = None
        pending = []
        if reviewed:
            groups, _ = root_cause_groups(self.plans)
            client = self.client("consistency")
            if client.judgment is not None:
                require(isinstance(client.judgment.get("actions"), list) and isinstance(client.judgment.get("conflicts"), list),
                    "整单复核 judgment 需要 actions 与 conflicts 数组")
                known = {plan_key(p.get("execution_id"), p["parachinname"]) for p in self.plans}
                for row in client.judgment["actions"]:
                    require(plan_key(row.get("execution_id"), row.get("parachinname")) in known, "复核引用了未知动作")
                    require(row.get("relevance") in order_review.RELEVANCE_VOCAB, "复核 relevance 不在词表中")
            review = order_review.run_order_review(self.order, self.rows(chain, feasibility), self.plans,
                root_cause_refs=root_cause_refs(self.plans, groups), llm_client=client, settings=self.settings.decision)
            pending = client.requests
            if not pending:
                drop_by_review(chain, order_review.review_demotions(review), enforce_step_direction=True)
        return candidates, alignment, feasibility, chain, review, prior, steps, pending

    def run(self, stage):
        pending = []
        if stage == "context":
            changes = []
            for p in self.plans:
                before, target = p.get("f_para"), p.get("b_para")
                left, right = parse_number(before), parse_number(target)
                numeric = left is not None and right is not None
                same = left == right if numeric else str(before).casefold() == str(target).casefold()
                changes.append({"execution_id": str(p["execution_id"]), "parameter": p["parachinname"],
                    "before": before, "recorded_target": target, "value_changed": not same,
                    "kind": "numeric_delta" if numeric else "enumeration_or_text",
                    "delta": right - left if numeric else None,
                    "unit": "source_encoding_unspecified", "scope": "archived_proposal_not_actual_execution"})
            result = {"order": self.order, "initial_plans": self.plans,
                "parameter_changes": changes,
                "dimensions": dimension_verdicts(self.order), "deterministic_causes": plain(converge_order(self.order)),
                "initial_plan_count": len(self.plans), "case_count": len(self.data.get("cases", [])),
                "rules_source": "submitted_snapshot" if "rules" in self.data else "bundled_icos_rules",
                "source_ref": self.data["source_ref"], "production_data_connected": False,
                "archive_context": self.data.get("archive_context"), "network_context": self.data.get("network_context")}
        elif stage == "objective":
            result = _build_objective(self.order, self.rows(), _fact_issues(self.order, self.plans))
        elif stage == "root_cause":
            result, pending = self.root()
            result = {**plain(result), "deterministic_fallback": plain(converge_order(self.order)),
                "score_meaning": "原文支撑强度；不是当前根因正确概率", "threshold": self.threshold}
        elif stage == "cases":
            result = self.cases().to_dict()
        elif stage == "candidates":
            result, pending = self.candidates()
            result = result.to_dict()
        elif stage == "alignment":
            result, pending = self.alignment()
            result = result.to_dict()
        elif stage == "parameter_risk":
            result = {key: value.to_dict() for key, value in self.risks().items()}
        elif stage == "multi_round":
            prior, steps = self.multi_round()
            result = prior_rounds_doc(prior, steps, rollback_round=bool(self.args.get("rollback_only")))
        elif stage == "feedback":
            result = {"short_evaluations": [{**row, "classification": classify_short_assess(row.get("short_assess_result"))}
                for row in self.data.get("short_evals", [])], "execution_rows": self.data.get("prior_execution_rows", []),
                "source_ref": self.data["source_ref"], "field_execution_performed": False}
            archived = self.args.get("archived_feedback")
            if archived:
                normalized = []
                for action in archived["actions"]:
                    raw_short = str(action.get("short_eval_raw") or "")
                    disabled = "未启用" in raw_short or "not enabled" in raw_short.lower()
                    long_result = action.get("long_eval_result")
                    normalized.append({**action,
                        "short_evaluation_status": "not_enabled" if disabled else "reported" if raw_short else "missing",
                        "short_evaluation_classification": None if disabled else classify_short_assess(raw_short.replace("评估", "")),
                        "actual_after": action.get("after") if action["exec_state"] == "exec_success" else None,
                        "attempted_target": action.get("after"),
                        "outcome_label_conflict": (long_result == "long_eval_fail" and action.get("improvement_result") == "改善"),
                        "effect_scope": "archived_bundle_outcome_not_independent_parameter_effect"})
                result["archived_feedback"] = {"source_ref": archived["source_ref"], "actions": normalized,
                    "successful_actions": sum(a["exec_state"] == "exec_success" for a in normalized),
                    "failed_actions": sum(a["exec_state"] == "exec_failed" for a in normalized),
                    "outcome_label_conflicts": sum(a["outcome_label_conflict"] for a in normalized),
                    "short_evaluation_disabled_actions": sum(a["short_evaluation_status"] == "not_enabled" for a in normalized),
                    "can_compute_kpi_improvement": False}
        elif stage in ("consistency", "decision"):
            candidates, alignment, feasibility, chain, review, prior, steps, pending = self.chain(
                reviewed=stage == "consistency" or self.args.get("operation") != "preview")
            rows = self.rows(chain, feasibility)
            if stage == "consistency":
                result = {"review": plain(review), "rows": rows, "gate": chain.gate.to_dict(),
                    "chain": chain.verdict().to_dict()}
            else:
                root, _ = self.root()
                rollback_only = bool(chain.dispatched) and all(
                    action["stage"] == ChainStage.MULTI_ROUND and steps.get(parameter_key(action["parachinname"])) is not None
                    and steps[parameter_key(action["parachinname"])].kind == MultiRoundAction.ROLLBACK
                    for action in chain.decided if action.get("dispatched")
                )
                exhausted = self.retry > 0 and not chain.dispatched
                decision = build_order_decision(self.order, self.plans, rows, candidates=candidates,
                    gate=chain.gate.to_gate_result(), review=review, chain=chain.verdict(),
                    cause_convergence=root, confidence_threshold=self.threshold, cause_alignment=alignment,
                    case_evidence=self.cases(), prior_rounds=prior_rounds_doc(prior, steps, rollback_round=rollback_only))
                result = {"decision": decision.to_dict(), "rows": rows,
                    "risk_summary": plain(summarize_dispatch_risk(assess_action_risk(row) for row in rows)),
                    "manual_required": chain.verdict().manual or rollback_only or exhausted,
                    "rollback_only": rollback_only,
                    "preview": self.args.get("operation") == "preview"}
                if exhausted:
                    result["rollback_proposal"] = prior_rounds_doc(prior,
                        assign_carriers(plan_rollback(prior), self.plans), rollback_round=True)
        else:
            raise ValueError("未知 ICOS 阶段")
        return {"status": "needs_judgment" if pending else "completed", "result": plain(result),
            "judgment_requests": pending, "device_operation_performed": False,
            "analysis_scope": "submitted_input_snapshot", "kernel_source": "vendor/icos/source-manifest.json"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read(8 * 1024 * 1024 + 1))
        result = Analysis(request["state"], request["args"]).run(request["args"]["stage"])
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except Exception as error:
        print(json.dumps({"error": str(error), "type": type(error).__name__}, ensure_ascii=False))
        sys.exit(1)
