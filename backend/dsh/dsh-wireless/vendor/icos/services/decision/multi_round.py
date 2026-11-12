"""多轮决策阶梯：短评估没通过之后，下一轮对动过的参数怎么调（2026-09-25 业务拍板）。

最多 3 轮（``order_loop.short_assess_max_rounds``）。第 1 轮按 ICOS 初案；之后每一轮，对前几轮
动过、评估没通过的参数（:meth:`PriorRounds.histories`），按下面的阶梯取**第一档没试过的**：

======  ==========================================================================
第 1 档  **缩步长**：从原值起、同方向、步长减半（原值与第一次调到的值都是整数时按 1 向下取整、
        不小于 1；不是整数就缩不了）。``para`` 是区间约束时再校验一次
第 2 档  **反向**：从原值起反向一步（步长取规则库 ``rule_scope`` 的大小）。以下情形改为**回退到原值**：
        规则库限定了方向（``rule_scope`` 显式带符号）、规则库无匹配或 ``para`` 不是区间（反向的值没法校验）、
        非数值参数（开关 / 枚举）、反向一步出了 ``para`` 区间
======  ==========================================================================

**2026-09-30 起规则表 ``sys_cell_execute_jiangsu.csv`` 的数值步长全部显式带符号**，所以命中规则的参数
第 2 档恒为回退，阶梯实际是「缩步长 → 回退」；「反向」只剩裸数字步长（表里没有）这条边角路径。

例子：现网 -110，``rule_scope=-4``（只许调小）、``para`` 为 ``>-140``::

    第 1 轮  -110 → -114（ICOS 建议，或由 07 按规则步长改写成这一步）   恶化
    第 2 轮  -114 → -112（缩步长：从原值走半步 2）                      恶化
    第 3 轮  -112 → -110（rule_scope 带符号不能反向 → 回退）

缩不了（半步小于 1，例如步长 1 的整数参数）就直接用第 2 档。

**读案例**（2026-10-09，案例库开着就读、没有开关，提示由 :mod:`services.decision.case_steps` 给）：同参数 + 同二级原因 + 同问题类型 + 同方向的先例以恶化为主 → 不缩、直接回退；同类成功的常见幅度比第一次走的小 →
第 1 档缩到那个幅度（仍按整数粒度取整、仍校验 ``para`` 区间）；其余照旧减半。两档都试过、或要去的值就是
现网值，本轮不再调这个参数（:attr:`MultiRoundAction.NONE`，合规链一侧记 ``excluded_prior_round``）。

**转人工前先回退**（:func:`plan_rollback`）：末轮仍恶化、或某一轮一个可发的都没有时，把所有
现网值不等于原值的参数恢复原值，推一批给 ICOS，推完即转人工、不再等评估。

**只有回退的一轮也不参与评估**（2026-09-25 业务）：阶梯走到回退（例如限定方向的参数第 3 轮），而这一轮
下发的**全是**回退、没有任何新尝试时，这一轮同样按回退轮处理 —— 推完即转人工。回退只是把现网恢复
原样，评估回「改善」也不代表原问题解决了；这一轮若同时有别的参数在缩步长 / 反向 / 走初案，照常评估。
回退轮的行在 ``llm_solution`` 上带 :data:`ROLLBACK_ROUND_KEY`，ICOS 回的执行回执在转人工后照样入库。

这些值**不走 07 规则库调整与 08 决策条件**：07 要求「从现网值按 ``rule_scope`` 正好走一步」，而缩步长、反向、
回退都从**原值**起算 —— 相对现网值既不是一步、方向也可能相反。放进去会被判方向不符，或被改写回
上一轮已判恶化的那个值。合法性在这里校验：缩步长落在原值与第一次调到的值之间
（插值，``para`` 是区间时再校验一次），反向要求 ``para`` 是区间且落在区间内，回退就是原值。

纯函数：不碰库、不读配置、不调模型。
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field, replace
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from services.decision.phase import Phase
from services.compliance.rule_constraint import parse_step
from services.decision.case_evidence import Direction
from services.decision.case_steps import CaseShrinkHint
from services.decision.plan_table import row_solution, plan_key
from services.decision.prior_round import (
    MULTI_ROUND_ACTION_LABELS,
    MultiRoundAction,
    ParameterHistory,
    PriorRounds,
    parameter_key,
)

_TOL = 1e-6
_NUMBER = re.compile(r"[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?")
#: ``para`` 区间约束：``<-50`` / ``>-128`` / ``<=8`` / ``>=-110``。
_PARA_INTERVAL = re.compile(r"^(<=|>=|<|>)\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$")

#: 多轮决策动作 → 合规链一侧的 phase。
MULTI_ROUND_PHASES: Dict[str, str] = {
    MultiRoundAction.SHRINK: Phase.MULTI_ROUND_SHRINK,
    MultiRoundAction.REVERSE: Phase.MULTI_ROUND_REVERSE,
    MultiRoundAction.ROLLBACK: Phase.MULTI_ROUND_ROLLBACK,
}
MULTI_ROUND_PHASE_SET = frozenset(MULTI_ROUND_PHASES.values())

#: 决策行 ``llm_solution`` 上的标记：这一行属于**回退轮**（推完即转人工、不参与评估）。
ROLLBACK_ROUND_KEY = "rollback_round"


def is_rollback_row(row: Mapping[str, Any]) -> bool:
    """这条决策行是不是回退轮的（推送侧据此推完即转人工，执行回执入口据此在转人工后仍收回执）。"""
    return bool(row_solution(dict(row)).get(ROLLBACK_ROUND_KEY))


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _num(value: Any) -> Optional[float]:
    text = _text(value)
    if not _NUMBER.fullmatch(text):
        return None
    return float(text)


def _fmt(value: float) -> str:
    if math.isclose(value, round(value), abs_tol=_TOL):
        return str(int(round(value)))
    return f"{value:.6f}".rstrip("0").rstrip(".")


def _same(a: Any, b: Any) -> bool:
    x, y = _num(a), _num(b)
    if x is not None and y is not None:
        return math.isclose(x, y, abs_tol=_TOL)
    return _text(a) == _text(b)


def granularity(rule: Mapping[str, Any], original: float, target: float) -> Optional[float]:
    """缩步长能缩到多细：只剩整数回退 ——
    原值与目标值都是整数就按 1，否则缩不了（返回 None，直接走反向 / 回退）。"""
    _ = rule
    if all(math.isclose(v, round(v), abs_tol=_TOL) for v in (original, target)):
        return 1.0
    return None


def _para_interval(para: Any) -> Optional[Tuple[str, float]]:
    """``para`` 区间约束 ``(operator, bound)``；不是区间（单值 / 多值 / 带前缀）返回 None。"""
    match = _PARA_INTERVAL.match(_text(para))
    if not match:
        return None
    try:
        return match.group(1), float(match.group(2))
    except ValueError:
        return None


def _in_para_interval(value: float, para: Any) -> bool:
    interval = _para_interval(para)
    if interval is None:
        return False
    operator, bound = interval
    if operator == "<":
        return value < bound - _TOL
    if operator == "<=":
        return value <= bound + _TOL
    if operator == ">":
        return value > bound + _TOL
    return value >= bound - _TOL


@dataclass(frozen=True)
class MultiRoundStep:
    """多轮决策对一个参数的本轮动作。"""

    parachinname: str
    #: :class:`MultiRoundAction`。
    kind: str
    #: 本轮要下发的值；``NONE`` 为空。
    value: str
    #: 此刻的现网值 —— 推给 ICOS 时作 ``f_para``（不是初案那个首轮之前的值）。
    current: str
    #: 第一次动之前的原值。
    original: str
    #: 第一次动它的那条初案（优先挂回同一条）。
    execution_id: str
    #: 给人看的一句话：前几轮怎么动的、评估怎么说、这一档为什么是这个值。
    detail: str
    #: 第一次动它时依据的规则行（写进决策行，风险注记与依据表读它）。
    rule: Mapping[str, Any] = field(default_factory=dict, compare=False)
    #: 挂在哪一条初案上（``plan_key``），由 :func:`assign_carriers` 填；空 = 初案里找不到这个参数。
    carrier_key: str = ""
    #: 转人工前的回退轮（:func:`plan_rollback`）：推完即转人工，不等评估。
    rollback_round: bool = False

    @property
    def dispatched(self) -> bool:
        return self.kind != MultiRoundAction.NONE and bool(self.carrier_key)

    @property
    def phase(self) -> str:
        return MULTI_ROUND_PHASES.get(self.kind, Phase.EXCLUDED_PRIOR_ROUND)

    @property
    def label(self) -> str:
        return MULTI_ROUND_ACTION_LABELS.get(self.kind, "")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "parachinname": self.parachinname,
            "kind": self.kind,
            "label": self.label,
            "value": self.value,
            "current": self.current,
            "original": self.original,
            "execution_id": self.execution_id,
            "carrier_key": self.carrier_key,
            "rollback_round": self.rollback_round,
            "detail": self.detail,
        }


def _prefix(history: ParameterHistory) -> str:
    result = f"短评估「{history.last_result}」" if history.last_result else "未关联到短评估结论（按恶化处理）"
    return (
        f"第 {history.last_round_no} 轮后{result}；该参数原值 {history.original or '（空）'}，"
        f"试过 {'、'.join(history.tried) or '（无）'}，现网 {history.current or '（空）'}"
    )


def _reverse(
    history: ParameterHistory, original: Optional[float], direction: int, para: Any
) -> Tuple[Optional[str], str]:
    """第 2 档：反向一步 ``(值, 说明)``；反向不成立时值为 None、说明是为什么（改为回退）。

    2026-09-30 起按 ``para`` 区间约束校验反向值。新规则表
    数值步长全部显式带符号 —— **显式带符号**时方向被规则限定 → 反向不成立、走回退；
    裸数字（表里没有）不视作限定方向，反向照走（仅作边角覆盖，新表不会走到）。
    """
    rule = history.rule or {}
    if original is None or direction == 0:
        return None, "非数值参数，不能反向"
    if not rule:
        return None, "规则库无匹配、没有区间约束可校验反向的值"
    scope_text = _text(rule.get("rule_scope"))
    step_magnitude, step_direction = parse_step(scope_text)
    if not step_magnitude:
        return None, f"规则 rule_scope={scope_text} 不是数值步长，不能反向"
    # 仅显式带符号（``+N`` / ``-N``）才视作「规则限定了方向」；裸数字不算。
    if scope_text and scope_text[0] in "+-" and step_direction is not None:
        return None, f"规则库限定了调整方向（rule_scope={scope_text}），不能反向"
    para = rule.get("para")
    if _para_interval(para) is None:
        return None, f"规则 para={_text(para)} 不是区间约束，反向无法校验"
    value = original - direction * step_magnitude
    if not _in_para_interval(value, para):
        return None, f"反向一步到 {_fmt(value)} 出了取值约束 {_text(para)}"
    return _fmt(value), f"同参数反向一步：从原值 {history.original} 反向走 {_fmt(step_magnitude)}"


def _hint_applies(hint: Optional[CaseShrinkHint], direction: int) -> bool:
    """案例提示与第一次调整同方向才用（案例按 ICOS 初案的方向查，多轮决策动的是同一个参数、同一方向）。"""
    if hint is None or direction == 0:
        return False
    return hint.direction == (Direction.UP if direction > 0 else Direction.DOWN)


def _case_cite(hint: CaseShrinkHint) -> str:
    return f"（引用案例 {'、'.join(hint.refs)}）" if hint.refs else ""


def _candidates(history: ParameterHistory, hint: Optional[CaseShrinkHint] = None) -> List[Tuple[str, str, str]]:
    """阶梯上的候选，按档次：``[(动作, 值, 说明), ...]``。

    ``hint`` 是同参数 + 同二级原因 + 同问题类型 + 同方向的案例提示（2026-10-09，案例库开着才有）：
    同类以恶化为主 → 不再缩步长 / 反向，直接回退；同类成功的常见幅度比第一次走的小 → 缩到那个幅度；
    否则照旧步长减半。
    """
    rule = history.rule or {}
    original, target = _num(history.original), _num(history.first_target)
    para = rule.get("para") if rule else None
    numeric = original is not None and target is not None and not math.isclose(original, target, abs_tol=_TOL)
    direction = (1 if target > original else -1) if numeric else 0
    use_hint = _hint_applies(hint, direction)

    if use_hint and hint.negative_dominant:
        return [(
            MultiRoundAction.ROLLBACK,
            history.original,
            f"同类案例以恶化为主（支撑度{hint.support or '低'}）{_case_cite(hint)}，不再缩步长，回退到原值",
        )]

    out: List[Tuple[str, str, str]] = []
    if numeric:
        # 缩步长是插值（落在原值与第一次调到的值之间），本身安全；para 给了区间就再校验一次。
        interval = _para_interval(para)
        grain = granularity(rule, original, target)
        delta = abs(target - original)
        if grain:
            half = math.floor(delta / 2 / grain + _TOL) * grain
            why = f"同方向步长减半：从原值 {history.original} 走 {_fmt(half)}（第一次走了 {_fmt(delta)}）"
            typical = hint.typical_delta if use_hint else None
            if typical is not None:
                by_case = math.floor(abs(typical) / grain + _TOL) * grain
                if grain - _TOL <= by_case < delta - _TOL:
                    half = by_case
                    why = (
                        f"按同类成功案例常见幅度 {_fmt(abs(typical))} 缩步长{_case_cite(hint)}：从原值 {history.original} "
                        f"走 {_fmt(by_case)}（第一次走了 {_fmt(delta)}）"
                    )
            value = original + direction * half
            if half >= grain - _TOL and half < delta - _TOL and (interval is None or _in_para_interval(value, para)):
                out.append((MultiRoundAction.SHRINK, _fmt(value), why))
    reverse, why = _reverse(history, original if numeric else None, direction, para)
    if reverse is not None:
        out.append((MultiRoundAction.REVERSE, reverse, why))
    else:
        out.append((MultiRoundAction.ROLLBACK, history.original, f"{why}，回退到原值"))
    return out


def plan_multi_round_steps(
    prior: PriorRounds, *, case_hints: Optional[Mapping[str, CaseShrinkHint]] = None
) -> Dict[str, MultiRoundStep]:
    """重推理这一轮：前几轮动过的每个参数 → 本轮的多轮决策动作（阶梯上第一档没试过的）。

    ``case_hints``：``parameter_key → 案例提示``（2026-10-09，案例建议步数开着才传），见 :func:`_candidates`。
    """
    steps: Dict[str, MultiRoundStep] = {}
    hints = case_hints or {}
    for key, history in prior.histories().items():
        prefix = _prefix(history)
        chosen: Optional[Tuple[str, str, str]] = None
        for kind, value, why in _candidates(history, hints.get(key)):
            if _same(value, history.current) or any(_same(value, tried) for tried in history.tried):
                continue
            chosen = (kind, value, why)
            break
        if chosen is None:
            kind, value, detail = MultiRoundAction.NONE, "", f"{prefix}：缩步长与反向 / 回退都已试过，本轮不再调整"
        else:
            kind, value, why = chosen
            detail = f"{prefix}：{why}，本轮调到 {value}"
        steps[key] = MultiRoundStep(
            parachinname=history.parachinname,
            kind=kind,
            value=value,
            current=history.current,
            original=history.original,
            execution_id=history.execution_id,
            detail=detail,
            rule=dict(history.rule or {}),
        )
    return steps


def plan_rollback(prior: PriorRounds) -> Dict[str, MultiRoundStep]:
    """转人工前的回退：现网值不等于原值的参数一律恢复原值。一个都不用回退时返回空。"""
    steps: Dict[str, MultiRoundStep] = {}
    for key, history in prior.histories().items():
        if _same(history.current, history.original):
            continue
        steps[key] = MultiRoundStep(
            parachinname=history.parachinname,
            kind=MultiRoundAction.ROLLBACK,
            value=history.original,
            current=history.current,
            original=history.original,
            execution_id=history.execution_id,
            detail=f"{_prefix(history)}：多轮决策轮次用尽 / 没有可换的动作，转人工前回退到原值 {history.original}",
            rule=dict(history.rule or {}),
            rollback_round=True,
        )
    return steps


def assign_carriers(steps: Mapping[str, MultiRoundStep], plans: Sequence[Mapping[str, Any]]) -> Dict[str, MultiRoundStep]:
    """每个多轮决策动作挂在哪一条初案上：优先第一次动它的那条（同 execution_id），否则同名参数的第一条。

    同一参数在初案里出现多条时只有承载的那一条发，其余不发 —— 一轮里同一参数只能有一个目标值。
    """
    out: Dict[str, MultiRoundStep] = {}
    for key, step in steps.items():
        matches = [plan for plan in plans if parameter_key(plan.get("parachinname")) == key]
        chosen = next(
            (plan for plan in matches if _text(plan.get("execution_id")) == step.execution_id),
            matches[0] if matches else None,
        )
        carrier = plan_key(chosen.get("execution_id"), chosen.get("parachinname")) if chosen else ""
        out[key] = replace(step, carrier_key=carrier)
    return out


#: ``prior_rounds`` 里本轮多轮决策动作那一格的键（schema 12 起）。
PRIOR_ROUNDS_STEPS_KEY = "multi_round"
#: schema 7–11 的键名（2026-10-03 前称「外环」），存量裁决对象还带着。
_LEGACY_PRIOR_ROUNDS_STEPS_KEY = "outer"


def prior_rounds_doc(
    prior: PriorRounds, steps: Mapping[str, MultiRoundStep], *, rollback_round: bool = False
) -> Dict[str, Any]:
    """裁决对象的 ``prior_rounds`` 块：前几轮事实 + 本轮的多轮决策动作。事后重算从 ``multi_round`` 回放。"""
    doc = prior.to_dict()
    doc[PRIOR_ROUNDS_STEPS_KEY] = [step.to_dict() for step in steps.values()]
    doc["rollback_round"] = rollback_round
    return doc


def multi_round_from_doc(doc: Optional[Mapping[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """落库的 ``decision_json.prior_rounds`` → ``parameter_key → 多轮决策动作``（决策链要的那几格）。

    没有这一块（首轮、老轮次）返回空字典 —— 与决策时「没有多轮决策动作」同一个结果。
    schema 11 及之前的对象这一格叫 ``outer``，照样认。
    """
    doc = doc or {}
    items = doc.get(PRIOR_ROUNDS_STEPS_KEY)
    if items is None:
        items = doc.get(_LEGACY_PRIOR_ROUNDS_STEPS_KEY)
    out: Dict[str, Dict[str, Any]] = {}
    for item in items or []:
        if isinstance(item, Mapping) and parameter_key(item.get("parachinname")):
            out[parameter_key(item.get("parachinname"))] = {
                "kind": _text(item.get("kind")),
                "value": _text(item.get("value")),
                "detail": _text(item.get("detail")),
                "carrier_key": _text(item.get("carrier_key")),
            }
    return out


def chain_view(steps: Mapping[str, MultiRoundStep]) -> Dict[str, Dict[str, Any]]:
    """决策时的多轮决策动作 → 决策链要的形状（与 :func:`multi_round_from_doc` 回放出来的同形）。"""
    return {
        key: {"kind": step.kind, "value": step.value, "detail": step.detail, "carrier_key": step.carrier_key}
        for key, step in steps.items()
    }


__all__ = [
    "MULTI_ROUND_PHASES",
    "MULTI_ROUND_PHASE_SET",
    "PRIOR_ROUNDS_STEPS_KEY",
    "ROLLBACK_ROUND_KEY",
    "MultiRoundStep",
    "assign_carriers",
    "granularity",
    "is_rollback_row",
    "multi_round_from_doc",
    "plan_multi_round_steps",
    "plan_rollback",
    "prior_rounds_doc",
    "chain_view",
]
