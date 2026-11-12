"""决策行 ``llm_solution.phase`` 的取值 —— 排查时先看这个字段定位走了哪条路。

2026-09-25 起**合规链已删除**，每条初案由决策链（04 组内寻优 → 07 规则库风险评估 → 08 冲突剔除
→ 决策条件回环，:mod:`services.decision.chain`）裁决，新行的 phase 只有三种来路：

* :data:`Phase.NEW_CHAIN` —— 决策链裁决的行（下发与否、为什么，看 ``llm_solution.new_chain``）；
* 多轮决策三档与 :data:`Phase.EXCLUDED_PRIOR_ROUND` —— 重推理轮次由多轮决策阶梯接管的行
  （:mod:`services.decision.multi_round`）。

**其余取值都是历史**：合规链（逐条问模型 + 数值后验）时期的行上才有，库里的老轮次还带着，
展示层与裁决对象要能读懂它们，所以词表整份保留、一个都不删。它们原先定义在
``services.compliance.engine``，随合规链一起搬到这里。
"""
from __future__ import annotations

from typing import Any, Dict


class Phase:
    """``llm_solution.phase`` 的取值。"""

    #: **决策链裁决**（2026-09-25 合规链删除之后的唯一形态）：下发两格由决策链写，
    #: 判到哪一步、为什么在 ``llm_solution.new_chain``（``enforced`` / ``stage`` / ``reason`` / ``rule``）。
    NEW_CHAIN = "new_chain"
    #: **多轮决策不再调**：前几轮动过这个参数、短评估没通过，而多轮决策阶梯已经走完（或本轮由同参数的
    #: 另一条初案承载多轮决策动作），这一条不发（见 :mod:`services.decision.multi_round`）。
    #: 说明在 ``llm_solution.multi_round``。刻意不与 ``skipped_lower_priority`` 共享子串。
    EXCLUDED_PRIOR_ROUND = "excluded_prior_round"
    #: **多轮决策动作**（2026-09-25 业务拍板）：短评估没通过之后，对动过的参数缩步长 / 反向 / 回退。
    #: 值由多轮决策阶梯确定性算出，不走一步策略（它们从原值起算，不是「从现网值走一步」）。
    #: 2026-10-03 前叫 ``outer_loop_*``（那时称「外环」），见 :data:`LEGACY_PHASE_ALIASES`。
    MULTI_ROUND_SHRINK = "multi_round_shrink"
    MULTI_ROUND_REVERSE = "multi_round_reverse"
    MULTI_ROUND_ROLLBACK = "multi_round_rollback"

    # ---- 以下是历史取值：合规链时期（2026-09-25 之前）的行上才有 ----
    SUCCESS = "success"
    MISSING_ICOS_TYPE1_TYPE2 = "missing_icos_type1_type2"
    PRECHECK = "precheck"
    RULE_MATCH = "rule_match"
    RULE_MATCH_BYPASS = "rule_match_bypass"
    LLM_CALL_BYPASS = "llm_call_bypass"
    LLM_CALL_TIMEOUT_BYPASS = "llm_call_timeout_bypass"
    PARSE_BYPASS = "parse_bypass"
    HARNESS_VALIDATE = "harness_validate"
    NUMERIC_POSTCHECK = "numeric_postcheck"
    COMPLIANCE_FAILED = "compliance_failed"
    #: 逐档 break 时期（2026-09-22 之前）：更高档出了可下发，这一档整档没试。
    SKIPPED_LOWER_PRIORITY = "skipped_lower_priority"
    #: ``plan_feasibility_skip`` 开关（默认关、已随合规链删除）打开时，被 07 规则库确定性结论判死、
    #: 没跑合规链的行。刻意**不共享子串**：``root_cause`` 在 ``llm_solution`` 不是 dict 时对 JSON 原文做
    #: ``"skipped_lower_priority" in text`` 的子串匹配，名字里带上它会被误读成「档位跳过」。
    SKIPPED_INFEASIBLE = "skipped_infeasible"
    #: 合规链判了可下发、被 08 参数冲突剔除拿掉的行（合规链原 phase 在 ``llm_solution.compliance_phase``）。
    #: 决策链里的冲突剔除不再改 phase，原因记在 ``new_chain.reason``。
    DROPPED_CONFLICT = "dropped_conflict"


#: 合规链时期走 bypass 的 phase 集合（都是 need_call=是、没经过规则校验、按 ICOS 建议值直通）。
#: 决策链里的「未经规则校验」由 ``new_chain.unchecked`` 表达，不看这个集合。
BYPASS_PHASES = frozenset(
    {
        Phase.RULE_MATCH_BYPASS,
        Phase.LLM_CALL_BYPASS,
        Phase.LLM_CALL_TIMEOUT_BYPASS,
        Phase.PARSE_BYPASS,
    }
)

#: 改过名的取值：旧名 → 现名。新行不再产出旧名，库里的存量行（决策行 ``llm_solution.phase``、
#: 裁决对象 ``actions[].phase``）还带着 —— 读的一侧经 :func:`canonical_phase` 换成现名再判，
#: 不在各处各认一遍。
LEGACY_PHASE_ALIASES: Dict[str, str] = {
    #: 2026-10-03「外环」改称「多轮决策」。
    "outer_loop_shrink": Phase.MULTI_ROUND_SHRINK,
    "outer_loop_reverse": Phase.MULTI_ROUND_REVERSE,
    "outer_loop_rollback": Phase.MULTI_ROUND_ROLLBACK,
}


def canonical_phase(value: Any) -> Any:
    """phase 取值 → 现名（改过名的旧取值换成现名，其余原样返回）。"""
    if isinstance(value, str):
        return LEGACY_PHASE_ALIASES.get(value, value)
    return value


__all__ = ["BYPASS_PHASES", "LEGACY_PHASE_ALIASES", "Phase", "canonical_phase"]
