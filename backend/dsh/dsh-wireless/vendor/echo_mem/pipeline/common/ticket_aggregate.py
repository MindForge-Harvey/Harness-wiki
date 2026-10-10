"""工单级 aggregate.ticket_outcome 聚合（TraceRecord.actions → aggregate）。"""

from __future__ import annotations

from typing import Any

# 对外展示的收敛类型（9 类）
TICKET_OUTCOME_PASS = "long_eval_pass"
TICKET_OUTCOME_MIXED = "long_eval_mixed"
TICKET_OUTCOME_LONG_EVAL_FAIL = "long_eval_fail"
TICKET_OUTCOME_BLOCKED = "execution_blocked"
TICKET_OUTCOME_UNKNOWN = "long_eval_unknown"
TICKET_OUTCOME_MANUAL = "manual_handoff"
TICKET_OUTCOME_AUDIT_TIMEOUT = "audit_timeout"
TICKET_OUTCOME_ISSUED_FAILED = "issued_failed"
TICKET_OUTCOME_EXEC_FAILED = "exec_failed"

_BLOCKED_EXEC_STATES = frozenset(
    {"exec_failed", "audit_timeout", "issued_failed"},
)


def compute_ticket_aggregate(actions: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(actions)
    issued_success = sum(1 for a in actions if a.get("issued_state") == "下发成功")
    exec_states = [a.get("exec_state") for a in actions]
    long_evals = [a.get("long_eval_result") for a in actions]
    pass_n = long_evals.count("long_eval_pass")
    fail_n = long_evals.count("long_eval_fail")
    unknown_n = long_evals.count("long_eval_unknown")
    success_n = exec_states.count("exec_success")
    failed_n = exec_states.count("exec_failed")
    skipped_n = exec_states.count("no_exec_needed")
    audit_to = exec_states.count("audit_timeout")
    issued_failed_n = exec_states.count("issued_failed")
    blocked_n = sum(1 for s in exec_states if s in _BLOCKED_EXEC_STATES)

    if n == 0:
        outcome = TICKET_OUTCOME_UNKNOWN
    elif skipped_n == n:
        outcome = TICKET_OUTCOME_MANUAL
    elif pass_n > 0 and (fail_n > 0 or blocked_n > 0):
        outcome = TICKET_OUTCOME_MIXED
    elif pass_n > 0:
        outcome = TICKET_OUTCOME_PASS
    elif fail_n == n:
        outcome = TICKET_OUTCOME_LONG_EVAL_FAIL
    elif audit_to == n:
        outcome = TICKET_OUTCOME_AUDIT_TIMEOUT
    elif issued_failed_n == n:
        outcome = TICKET_OUTCOME_ISSUED_FAILED
    elif failed_n == n:
        outcome = TICKET_OUTCOME_EXEC_FAILED
    elif pass_n == 0 and fail_n > 0:
        outcome = TICKET_OUTCOME_BLOCKED
    else:
        outcome = TICKET_OUTCOME_UNKNOWN

    return {
        "action_count": n,
        "issued_success": issued_success,
        "exec_success": success_n,
        "exec_failed": failed_n,
        "exec_skipped": skipped_n,
        "audit_timeout": audit_to,
        "issued_failed": issued_failed_n,
        "long_eval_pass": pass_n,
        "long_eval_fail": fail_n,
        "long_eval_unknown": unknown_n,
        "ticket_outcome": outcome,
    }


def normalize_ticket_outcome_label(outcome: str | None) -> str | None:
    return outcome
