"""决策步 08 综合决策 ——「是否满足决策条件」的**逐条评估**。

流程图上 08 之后有个判断框「是否满足决策条件」，满足才下发，不满足走调优/剔除回环（P4）。
**2026-09-24 P4 落地**：这组条件在决策链里是真闸门 —— :func:`services.decision.chain.run_chain`
在 08 之后评估，不满足按分支调优 / 剔除、复评，用尽整单转人工。回环最后一次评估（``ChainState.gate``）
就是最终下发集合的那一份，``DecisionService`` 直接拿它落轨迹与裁决对象的 ``gate``（注记）。

**通用方案容忍度（待拍板 #2）已删**（2026-09-24 业务拍板：**通用路径不比专项更严**）。方案原文
「通用方案风险容忍度更严：只允许一步、域内余量 ≥ 单步步长、不允许无硬域参数多参数同发」里，
前两条就是下面的「硬约束」「风险·余量」，对专项与通用一视同仁；第三条先按参数数评估，与「一个
最优方案有多个可执行参数」矛盾（会把 ICOS 的方案拆开只发一个参数），09-23 改成未评估，09-24 拍板
不另设更严的条件、整条删除。

本模块还持有 **05 根因对齐的路由**（:func:`gate_path`）：四档关联决定一个动作走**专项**路径
（直接 / 次级关联）还是**通用**路径（通用方案 / 不一致 / 未判定），作为注记落进轨迹
（``alignment.path``）。容忍度删除之后，路径不再影响任何一条决策条件。两字段皆空、自由文本的
工单 05 无从对齐（未判定），按业务 2026-09-17 口径「全部初案按通用方案路径判」。

条件（封闭词表，名字即口径）
----------------------------
=====================  ===================================================  ============
条件                    判据（只看**本轮下发集合**）                             来源
=====================  ===================================================  ============
硬约束                  有硬约束的动作，其**实际下发值**用代码事实规则复核是     P4 条件 1
                        合法一步（``assess_numeric_feasibility`` 判可下发且
                        不改值）。07 已按规则库取整到合法一步，决策链的行上
                        应恒过（合规链时期专抓 bypass 路径没过数值后验的值）
一致性·同参数多值        下发集合里没有同一参数两个目标值（08 冲突剔除后应恒过） P4 条件 2
一致性·功能互斥          —— **未评估**：``is_mutual_exclusion`` 209 行全空        P4 条件 2
风险·余量               —— **只注记、不作闸门**（2026-10-03）：业务 09-30 口径    P4 条件 3
                        「现网值 + 一步落在 ``para`` 区间内即下发」，余量不足
                        一步的照发，只数出来写进 ``detail``（逐动作的在 07
                        依据档「余量不足一步」与 08 裁决依据表）
风险·分级               —— **未评估**：``parameter_level`` 无供数、阈值未定      P4 条件 3
=====================  ===================================================  ============

评估三态：``passed`` / ``failed`` / ``not_evaluated``。**未评估不是通过** ——
与 ``GateResult.passed`` 在未评估时返回 ``None`` 同一个道理。
一条都不适用（例如本单下发的动作全无硬约束，「硬约束」就无对象）记 ``passed``、
``applicable=0``，读的人看计数分得清。

边界
----
* **本模块只给结论**，不改 ``need_call``：拿结论去调优 / 剔除的是决策链的回环
  （:mod:`services.decision.chain`），评估用的就是本模块的 :func:`evaluate_gate`。
* 纯函数：不碰库、不读配置（方向开关由调用方传入）。数值复核调的是 07 规则库评估的
  ``assess_numeric_feasibility`` —— 同一套数值策略，不写第二份。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from services.decision.alignment import ASSOCIATION_DIRECT, ASSOCIATION_SECONDARY
from services.decision.candidate_set import iter_value_conflicts
from services.decision.rule_assessment import FeasibilityShape, assess_numeric_feasibility
from services.decision.plan_table import rule_basis
from services.decision.risk import ActionRisk, RiskBasis
from services.decision.verdict import GateCondition, GateResult, RuleRow


class GatePath:
    """05 关联四档 → 判定路径。注记位：落轨迹 ``alignment.path``，不影响任何决策条件。"""

    SPECIFIC = "专项"
    GENERAL = "通用"


def gate_path(association: str) -> str:
    """直接 / 次级关联走专项，其余（通用方案 / 不一致 / 未判定）一律通用。

    未判定也归通用：05 对不上的工单（两字段皆空、自由文本）业务口径就是按通用方案判。
    """
    return GatePath.SPECIFIC if association in (ASSOCIATION_DIRECT, ASSOCIATION_SECONDARY) else GatePath.GENERAL


class ConditionStatus:
    PASSED = "passed"
    FAILED = "failed"
    NOT_EVALUATED = "not_evaluated"


class GateConditionName:
    HARD_CONSTRAINT = "硬约束"
    SAME_PARAM = "一致性·同参数多值"
    MUTUAL_EXCLUSION = "一致性·功能互斥"
    RISK_MARGIN = "风险·余量"
    RISK_GRADE = "风险·分级"


GATE_CONDITION_VOCAB = (
    GateConditionName.HARD_CONSTRAINT,
    GateConditionName.SAME_PARAM,
    GateConditionName.MUTUAL_EXCLUSION,
    GateConditionName.RISK_MARGIN,
    GateConditionName.RISK_GRADE,
)

#: 每条条件出自哪里。硬约束与同参数多值在决策链的回环里生效（2026-09-24）；功能互斥与分级没有供数、
#: 风险·余量只注记（2026-10-03），三条恒「未评估」。
_SOURCE = {
    GateConditionName.HARD_CONSTRAINT: "方案 P4 决策条件 1",
    GateConditionName.SAME_PARAM: "方案 P4 决策条件 2",
    GateConditionName.MUTUAL_EXCLUSION: "方案 P4 决策条件 2（is_mutual_exclusion 无供数）",
    GateConditionName.RISK_MARGIN: "方案 P4 决策条件 3（只注记：业务 09-30 一步落在取值约束内即下发）",
    GateConditionName.RISK_GRADE: "方案 P4 决策条件 3（parameter_level 无供数、阈值未定）",
}


@dataclass(frozen=True)
class GateAction:
    """08 决策条件的输入：一条**本轮下发**的动作。"""

    #: 本单内唯一的行标识（调用方用 ``agent_decision_id``）。
    key: str
    parachinname: str
    #: 现网值（数值复核的锚点）与**实际下发值**。
    f_para: str
    value: str
    risk: ActionRisk
    #: 代码事实规则行（``RuleRow.raw``）。只有硬约束档才用得到；``None`` = 没有。
    rule_fact: Optional[Mapping[str, Any]] = None
    #: 07 判定时区间类走了几步（默认一步；按案例建议步数放大过的是建议步数，2026-10-09）。
    #: 「硬约束」按同样的步数复核，否则多步的值会被判成不合法、在回环里压回一步。
    steps: int = 1


def _steps_of(basis: Mapping[str, Any]) -> int:
    """规则依据（``plan_table.rule_basis``）里 07 走了几步：多步的行在 ``step_scope_analysis.case_steps``，其余一步。"""
    analysis = basis.get("step_scope_analysis") if isinstance(basis, Mapping) else None
    steps = analysis.get("case_steps") if isinstance(analysis, Mapping) else None
    try:
        return max(int(steps), 1) if steps is not None else 1
    except (TypeError, ValueError):
        return 1


def gate_action_from_row(row: Mapping[str, Any], *, key: str, risk: ActionRisk) -> GateAction:
    """决策行形态的 dict → :class:`GateAction`。规则事实取 ``RuleRow.from_solution``（代码快照优先），
    读哪一份依据由 ``plan_table.rule_basis`` 定（决策链的行是 07 的规则库结论）。"""
    basis = rule_basis(dict(row))
    rule = RuleRow.from_solution(basis)
    return GateAction(
        key=key,
        parachinname=str(row.get("tool") or ""),
        f_para=str(row.get("f_para") or ""),
        value=str(row.get("b_para") or ""),
        risk=risk,
        rule_fact=dict(rule.raw) if rule is not None else None,
        steps=_steps_of(basis),
    )


@dataclass(frozen=True)
class ConditionCheck:
    name: str
    status: str
    #: 这条条件适用的动作数（例如「硬约束」只对有硬约束的动作适用）。
    applicable: int = 0
    #: 没过的动作标识，按入参次序。
    failed_keys: Tuple[str, ...] = ()
    detail: str = ""

    @property
    def source(self) -> str:
        return _SOURCE[self.name]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "applicable": self.applicable,
            "failed": len(self.failed_keys),
            "detail": self.detail,
            "source": self.source,
        }


@dataclass(frozen=True)
class GateEvaluation:
    """一轮的决策条件评估结果。"""

    conditions: Tuple[ConditionCheck, ...]
    dispatched: int = 0

    @property
    def failed_conditions(self) -> Tuple[str, ...]:
        return tuple(item.name for item in self.conditions if item.status == ConditionStatus.FAILED)

    @property
    def would_block(self) -> bool:
        """若把**已评估**的条件都当闸门执行，这一单会不会被拦。未评估的条件不算。"""
        return bool(self.failed_conditions)

    def failed_for(self, key: str) -> Tuple[str, ...]:
        """这个动作没过哪几条。"""
        return tuple(item.name for item in self.conditions if key in item.failed_keys)

    def to_gate_result(self) -> GateResult:
        """落成 ``OrderDecision.gate`` 的既有类型：只收**已评估**的条件，``unmet`` = 没过的。

        未评估的条件不进 ``conditions`` —— ``GateCondition.passed`` 只有真假两态，
        塞进去就得替它编一个结论。
        """
        evaluated = [item for item in self.conditions if item.status != ConditionStatus.NOT_EVALUATED]
        return GateResult(
            evaluated=True,
            conditions=tuple(
                GateCondition(name=item.name, passed=item.status == ConditionStatus.PASSED, detail=item.detail)
                for item in evaluated
            ),
            unmet=self.failed_conditions,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "would_block": self.would_block,
            "failed_conditions": list(self.failed_conditions),
            "dispatched": self.dispatched,
            "conditions": [item.to_dict() for item in self.conditions],
        }


def _check(name: str, applicable: int, failed: List[str], detail: str) -> ConditionCheck:
    return ConditionCheck(
        name=name,
        status=ConditionStatus.FAILED if failed else ConditionStatus.PASSED,
        applicable=applicable,
        failed_keys=tuple(failed),
        detail=detail,
    )


def _value_is_legal_step(action: GateAction, enforce_step_direction: bool) -> bool:
    """实际下发值是不是代码事实规则下的合法一步：数值策略判可下发、且**没有改值**。

    改了值说明下发的不是合法候选（该取整而没取整），判否不改值说明根本没有合法一步。
    按案例建议步数走多步的行（``action.steps`` > 1）按同样的步数复核：合法的是「现网值 + N 步」。
    """
    result = assess_numeric_feasibility(
        action.rule_fact or {},
        f_para=action.f_para,
        b_para=action.value,
        enforce_step_direction=enforce_step_direction,
        steps=action.steps,
    )
    return result.shape == FeasibilityShape.DISPATCHABLE and not result.value_changed


def evaluate_gate(actions: Sequence[GateAction], *, enforce_step_direction: bool) -> GateEvaluation:
    """对本轮下发集合逐条评估决策条件。``actions`` 只放**已下发**的动作。"""
    actions = list(actions)
    constrained = [a for a in actions if a.risk.constrained and a.rule_fact]

    hard_failed = [a.key for a in constrained if not _value_is_legal_step(a, enforce_step_direction)]

    same_param_failed: List[str] = []
    for _name, members, _values in iter_value_conflicts((a.parachinname, a.value, a) for a in actions):
        same_param_failed.extend(member.key for member in members)

    tight = sum(1 for a in constrained if a.risk.basis == RiskBasis.TIGHT)
    graded = sum(1 for a in actions if a.risk.graded)

    conditions = (
        _check(
            GateConditionName.HARD_CONSTRAINT,
            len(constrained),
            hard_failed,
            "有硬约束的动作，实际下发值用代码事实规则复核",
        ),
        _check(
            GateConditionName.SAME_PARAM,
            len(actions),
            same_param_failed,
            "下发集合内同一参数只许一个目标值",
        ),
        ConditionCheck(
            name=GateConditionName.MUTUAL_EXCLUSION,
            status=ConditionStatus.NOT_EVALUATED,
            detail="规则库 is_mutual_exclusion 无供数",
        ),
        # 只注记、不作闸门：记成未评估，回环就不会冲它剔除（业务 09-30 口径，2026-10-03 定）。
        ConditionCheck(
            name=GateConditionName.RISK_MARGIN,
            status=ConditionStatus.NOT_EVALUATED,
            applicable=len(constrained),
            detail=f"只注记、不作下发条件（一步落在取值约束内即下发）：有硬约束的动作中 {tight} 项调整后余量不足一步",
        ),
        ConditionCheck(
            name=GateConditionName.RISK_GRADE,
            status=ConditionStatus.NOT_EVALUATED,
            applicable=graded,
            detail="parameter_level 无供数、分级阈值未定",
        ),
    )
    return GateEvaluation(conditions=conditions, dispatched=len(actions))


__all__ = [
    "GATE_CONDITION_VOCAB",
    "ConditionCheck",
    "ConditionStatus",
    "GateAction",
    "GateConditionName",
    "GateEvaluation",
    "GatePath",
    "evaluate_gate",
    "gate_action_from_row",
    "gate_path",
]
