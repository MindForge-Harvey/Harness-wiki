"""决策步 07 参数风险评估 —— 确定性部分：每个动作的**风险依据档**，与本轮下发集合的风险面。

为什么先做「依据」、不做「等级」
------------------------------
风险**等级**要两样东西，今天都没有：

* ``parameter_level``（参数风险分级）—— 规则库 209 行全是「其他」，等业务供数（P2-2c）；
* 阈值 —— 分级阈值待定。（通用方案要不要比专项更严，即待拍板 #2，2026-09-24 已定：不更严。）

但有一样东西今天就确定、而且最要紧：**这个动作的取值有没有硬约束兜着**。
2026-09-23 双跑（清单 §3.21）量出来的正是这一条 —— 全组并列后多发的 51 条全部是
规则库无匹配的直通下发。所以 07 这一轮只给**依据档**（封闭词表，由事实定死），
等级位 :attr:`ActionRisk.parameter_level` 原样透传，业务供数那天自动有值。

依据档（封闭词表）
------------------
==================  ====================================================
``硬约束内``          命中规则、``para`` 给出取值约束（单值 / 区间）、快照是代码事实，且还能再调一步
``余量不足一步``      同上，但按规则方向再调一步就越出 ``para`` 区间（只注记，照发）
``有规则无硬约束``    命中规则，但 ``para`` 不是单值 / 区间（或快照是模型回抄的）
``规则库无匹配``      没有规则行，取值没有任何硬约束
==================  ====================================================

后两档合称「无硬约束」（:data:`UNCONSTRAINED`）。方案里曾待确认的通用方案容忍度
「不允许无硬域参数多参数同发」按的就是这个口径（2026-09-24 拍板通用不比专项更严，该条件已删）——
本模块只把**计数**记下来
（:attr:`DispatchRiskSummary.multi_unconstrained`），**不据此改任何下场**。

边界
----
* **annotate**：只算、只落轨迹，不碰 ``need_call``、不参与裁决。08「风险·余量」数它的
  「余量不足一步」，2026-10-03 起也只注记、不剔除（业务 09-30：一步落在取值约束内即下发）。
* 输入是**决策行形态**的 dict（``agent_execution_plan`` 那一行，``llm_solution`` 可以是
  dict 也可以是 JSON 串）—— 决策时的草稿与库里读出来的行走同一个函数。
* **一行推导都不新写**：准入三态取自 ``plan_table.verdict_row_state``，读哪一份依据取自
  ``plan_table.rule_basis``，规则事实取自 ``verdict.RuleRow.from_solution``，余量取自
  ``verdict.StepBasis.from_solution``。本模块只做归档与计数。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Mapping, Optional

from services.decision.plan_table import rule_basis, verdict_row_state
from services.decision.verdict import RuleRow, StepBasis


class RiskBasis:
    """动作的风险依据档。封闭词表，落进轨迹。"""

    HARD = "硬约束内"
    TIGHT = "余量不足一步"
    SOFT = "有规则无硬约束"
    NONE = "规则库无匹配"


RISK_BASIS_VOCAB = (RiskBasis.HARD, RiskBasis.TIGHT, RiskBasis.SOFT, RiskBasis.NONE)
#: 取值没有硬约束兜着的两档。
UNCONSTRAINED = frozenset({RiskBasis.SOFT, RiskBasis.NONE})


@dataclass(frozen=True)
class ActionRisk:
    """一个动作的 07 结论。"""

    basis: str
    #: 本轮是否进了参数平台（``need_call=是``）。
    dispatched: bool
    #: 下发了、但**没经过任何规则校验**（``verdict_row_state`` 的 ``admitted_unchecked``：
    #: 决策链的行是规则库无匹配 / 规则写法判读不了 / 07 判定失败，合规链时期的老行是四条 bypass）。
    unchecked: bool
    #: 单步步长与域内余量。只有硬约束档才有；其余为 ``None``（不造数）。
    step_magnitude: Optional[float] = None
    domain_margin: Optional[float] = None
    #: 业务给的风险分级，原样透传。现网恒为「其他」或空 —— 见 :attr:`graded`。
    parameter_level: str = ""
    graded: bool = False
    #: 命中的是一条业务已停用的规则（``is_use='否'``，匹配器不读这一列）。
    rule_disabled: bool = False

    @property
    def constrained(self) -> bool:
        return self.basis not in UNCONSTRAINED

    def to_dict(self) -> Dict[str, Any]:
        return {
            "basis": self.basis,
            "constrained": self.constrained,
            "dispatched": self.dispatched,
            "unchecked": self.unchecked,
            "step_magnitude": self.step_magnitude,
            "domain_margin": self.domain_margin,
            "parameter_level": self.parameter_level,
            "graded": self.graded,
            "rule_disabled": self.rule_disabled,
        }


def assess_action_risk(row: Mapping[str, Any]) -> ActionRisk:
    """一条决策行 → 它的 07 依据档。

    被 08 冲突剔除的行（``phase=dropped_conflict``）不用特殊处理：规则事实取自
    ``matched_rule``（引擎在每条命中规则的路径上都写，与 phase 无关），剔除改的只是
    下场，不改它当时命中了什么规则、余量还剩多少。

    规则事实与一步依据取 :func:`~services.decision.plan_table.rule_basis` —— 谁裁决这一行
    读谁的：决策链的行是 07 的规则库结论，合规链时期的老行是合规链的 ``llm_solution``。
    """
    row = dict(row)
    state = verdict_row_state(row)
    solution = rule_basis(row)
    rule = RuleRow.from_solution(solution)
    if rule is None:
        return ActionRisk(
            basis=RiskBasis.NONE,
            dispatched=state["is_dispatched"],
            unchecked=state["admission_state"] == "admitted_unchecked",
        )

    step = None
    if rule.hard_constraint_usable:
        step = StepBasis.from_solution(solution, b_para=row.get("b_para"), dispatched=state["is_dispatched"])
        basis = RiskBasis.TIGHT if step and step.tight_margin else RiskBasis.HARD
    else:
        basis = RiskBasis.SOFT
    return ActionRisk(
        basis=basis,
        dispatched=state["is_dispatched"],
        unchecked=state["admission_state"] == "admitted_unchecked",
        step_magnitude=step.step_magnitude if step else None,
        domain_margin=step.domain_margin_value if step else None,
        parameter_level=rule.parameter_level,
        graded=rule.graded,
        rule_disabled=rule.rule_disabled,
    )


@dataclass(frozen=True)
class DispatchRiskSummary:
    """本轮**下发集合**的风险面 —— 只数 ``dispatched`` 的动作。

    没下发的动作风险无从谈起，混进来会把「这一批发出去的东西有多少没兜底」稀释掉。
    """

    dispatched: int = 0
    by_basis: Dict[str, int] = field(default_factory=dict)
    unchecked: int = 0
    graded: int = 0

    @property
    def unconstrained(self) -> int:
        return sum(count for basis, count in self.by_basis.items() if basis in UNCONSTRAINED)

    @property
    def tight(self) -> int:
        return self.by_basis.get(RiskBasis.TIGHT, 0)

    @property
    def multi_unconstrained(self) -> bool:
        """两条以上无硬约束的动作同批下发。

        对应方案里的通用方案容忍度「不允许无硬域参数多参数同发」—— 2026-09-24 拍板通用路径不比专项
        更严，该条件已删；这里的计数只作风险面的描述。
        这里只记事实，不据此改任何下场。
        """
        return self.unconstrained >= 2

    def to_dict(self) -> Dict[str, Any]:
        return {
            "dispatched": self.dispatched,
            "by_basis": {basis: self.by_basis.get(basis, 0) for basis in RISK_BASIS_VOCAB},
            "unconstrained": self.unconstrained,
            "unchecked": self.unchecked,
            "tight": self.tight,
            "graded": self.graded,
            "multi_unconstrained": self.multi_unconstrained,
        }


def summarize_dispatch_risk(risks: Iterable[ActionRisk]) -> DispatchRiskSummary:
    by_basis: Dict[str, int] = {}
    dispatched = unchecked = graded = 0
    for risk in risks:
        if not risk.dispatched:
            continue
        dispatched += 1
        by_basis[risk.basis] = by_basis.get(risk.basis, 0) + 1
        unchecked += int(risk.unchecked)
        graded += int(risk.graded)
    return DispatchRiskSummary(dispatched=dispatched, by_basis=by_basis, unchecked=unchecked, graded=graded)


__all__ = [
    "RISK_BASIS_VOCAB",
    "UNCONSTRAINED",
    "ActionRisk",
    "DispatchRiskSummary",
    "RiskBasis",
    "assess_action_risk",
    "summarize_dispatch_risk",
]
