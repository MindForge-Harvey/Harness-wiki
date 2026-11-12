"""案例建议步数 —— 用同类成功案例的调整幅度，决定区间类参数这一次走几步（2026-10-09）。

07 参数风险评估的默认口径是「现网值 + 一步」（业务 09-30）：ICOS 建议走了几步都压成一步。本模块在
案例知识库有足够背书时放宽这一条 —— **以 ICOS 建议为上限**，保留它的多步建议：

======================  ===================================================================
条件（全部满足才放大）      说明
======================  ===================================================================
区间类参数               ``para`` 是数值区间、``rule_scope`` 是带符号的数值步长；单值 / 多值 / 带前缀不放大
ICOS 建议方向与规则一致    方向不一致的 07 本来就剔除，不谈步数
案例支撑度为「高」         同参数 + 同二级原因 + 同问题类型 + 同方向的先例够多、成功比例够高（档位门槛同 04 案例参考）
同类成功幅度 ≥ 2 步        同向成功先例幅度的中位数（``typical_delta``）折成规则步数，向下取整
ICOS 建议本身 ≥ 2 步       ICOS 建议幅度折成规则步数，向下取整
======================  ===================================================================

案例建议步数 = min(同类成功步数, ICOS 建议步数, 上限 ``max_steps``, 取值约束内最多能走的步数)；
小于 2 就照旧一步。所以放大后**绝不超过 ICOS 的建议幅度、也不超出 ``para`` 区间**；放大到正好等于
ICOS 建议时就是「按建议值下发」，只是有了案例背书。

多轮决策第 2 档（缩步长）也读案例（:class:`CaseShrinkHint`，见 :mod:`services.decision.multi_round`）：
同类以恶化为主 → 直接回退；同类成功的常见幅度比第一次走的小 → 缩到那个幅度；否则照旧缩一半。

**没有开关**（2026-10-09 用户定：步数判定一定要参考案例）：案例库开着、04 案例参考算出了证据就用；案例库关着
没有证据，07 照旧一步。纯函数：不碰库、不读配置、不调模型；上限由调用方传（``order_loop.case_library.step_advice_max_steps``）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple

from services.compliance.rule_constraint import ParaKind, para_kind, parse_step, steps_within
from services.decision.case_evidence import Direction, Support, parse_number

#: 决策链的原因词（``ChainReason.RULE_CASE_STEPS`` 与准入标签「已准入·…」同源，放在这个叶子模块里，
#: 让 ``plan_table`` 不用 import 决策链）。
CASE_STEPS_REASON = "按案例幅度调整为多步"

#: 放大的下限：案例建议步数小于它就照旧一步。
MIN_CASE_STEPS = 2

#: 默认上限（配置 ``step_advice_max_steps`` 不配时）。
DEFAULT_MAX_STEPS = 3

_TOL = 1e-6


def _floor_steps(magnitude: Optional[float], step: float) -> Optional[int]:
    if magnitude is None or step <= 0:
        return None
    return int(math.floor(abs(magnitude) / step + _TOL))


def _num_text(value: Optional[float]) -> str:
    if value is None:
        return "—"
    return str(int(round(value))) if math.isclose(value, round(value), abs_tol=_TOL) else f"{value:g}"


@dataclass(frozen=True)
class CaseStepAdvice:
    """一个参数的案例建议步数，以及为什么是这个数。``steps == 1`` = 照旧一步（:attr:`note` 说为什么）。"""

    #: 案例建议步数（≥ 1）。
    steps: int = 1
    #: 同类成功幅度折成的步数 / ICOS 建议折成的步数 / 取值约束内最多能走的步数 / 上限。判不了的为 ``None``。
    case_steps: Optional[int] = None
    icos_steps: Optional[int] = None
    room_steps: Optional[int] = None
    max_steps: int = DEFAULT_MAX_STEPS
    #: 规则步长（绝对值）与同向成功先例幅度的中位数。
    step: Optional[float] = None
    typical_delta: Optional[float] = None
    #: 案例支撑度与同类先例数（同参数、同二级原因、同问题类型、同向）。
    support: str = ""
    cases: int = 0
    success: int = 0
    #: 引用的案例编号（按相似度，至多 3 个）。
    refs: Tuple[str, ...] = ()
    #: 没放大时的原因（放大时为空）。
    note: str = ""

    @property
    def applied(self) -> bool:
        return self.steps >= MIN_CASE_STEPS

    def summary(self) -> str:
        """给人看的一句话：落进决策行 ``new_chain.detail``，正文与对照表原样引用。"""
        if not self.applied:
            return f"案例建议步数 1：{self.note}" if self.note else "案例建议步数 1"
        cite = f"，引用案例 {'、'.join(self.refs)}" if self.refs else ""
        return (
            f"案例建议步数 {self.steps}：同类成功先例 {self.success}/{self.cases} 例（支撑度{self.support}），"
            f"常见幅度 {_num_text(self.typical_delta)}（{self.case_steps} 步）；ICOS 建议 {self.icos_steps} 步，"
            f"取值约束内最多 {self.room_steps} 步，上限 {self.max_steps} 步，取最小者{cite}"
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "steps": self.steps,
            "applied": self.applied,
            "case_steps": self.case_steps,
            "icos_steps": self.icos_steps,
            "room_steps": self.room_steps,
            "max_steps": self.max_steps,
            "step": self.step,
            "typical_delta": self.typical_delta,
            "support": self.support,
            "cases": self.cases,
            "success": self.success,
            "refs": list(self.refs),
            "note": self.note,
            "summary": self.summary(),
        }


def _ref_ids(basis: Any) -> Tuple[str, ...]:
    return tuple(str(ref.case_id) for ref in (getattr(basis, "refs", None) or ())[:3] if getattr(ref, "case_id", ""))


def case_step_advice(
    basis: Any,
    rule_fact: Optional[Mapping[str, Any]],
    *,
    f_para: Any,
    b_para: Any,
    max_steps: int = DEFAULT_MAX_STEPS,
) -> CaseStepAdvice:
    """一条初案参数 → 案例建议步数。``basis`` 是 04 案例参考给这一条的
    :class:`~services.decision.case_evidence.ActionCaseBasis`（没有就是 ``None``）。**永不抛**。"""
    cap = max(int(max_steps or 0), 1)
    fact = dict(rule_fact or {})
    para, scope = fact.get("para"), fact.get("rule_scope")
    step, direction = parse_step(scope)

    def _stay(note: str, **extra: Any) -> CaseStepAdvice:
        return CaseStepAdvice(steps=1, max_steps=cap, step=step, note=note, **extra)

    if basis is None:
        return _stay("没有案例证据（案例库没开或这一条没算到）")
    common = dict(
        typical_delta=getattr(basis, "typical_delta", None),
        support=str(getattr(basis, "support", "") or ""),
        cases=int(getattr(basis, "cases", 0) or 0),
        success=int(getattr(basis, "success", 0) or 0),
        refs=_ref_ids(basis),
    )
    if para_kind(para) != ParaKind.INTERVAL or step is None:
        return _stay("不是数值区间约束的参数，不放大", **common)
    before, after = parse_number(f_para), parse_number(b_para)
    if before is None or after is None or math.isclose(after, before, abs_tol=_TOL):
        return _stay("现网值或 ICOS 建议值不是数，或没有调整", **common)
    icos_dir = 1 if after > before else -1
    if icos_dir != direction:
        return _stay("ICOS 建议方向与规则步长方向不一致", **common)
    expected = Direction.UP if icos_dir > 0 else Direction.DOWN
    if getattr(basis, "direction", expected) not in (expected, ""):
        return _stay("案例证据的方向与 ICOS 建议不一致", **common)
    if common["support"] != Support.HIGH:
        return _stay(f"同类案例支撑度为「{common['support'] or Support.NONE}」，要求「{Support.HIGH}」才放大", **common)

    case_steps = _floor_steps(common["typical_delta"], step)
    icos_steps = _floor_steps(after - before, step)
    room = steps_within(para, scope, before, cap)
    numbers = dict(case_steps=case_steps, icos_steps=icos_steps, room_steps=room)
    if case_steps is None:
        return _stay("同类成功先例没有可比的数值幅度", **common, **numbers)
    steps = min(case_steps, icos_steps or 0, cap, room)
    if steps < MIN_CASE_STEPS:
        limits = [
            label for label, value in (
                (f"同类成功常见幅度只有 {case_steps} 步", case_steps),
                (f"ICOS 建议只有 {icos_steps} 步", icos_steps),
                (f"取值约束内只能走 {room} 步", room),
            )
            if value is not None and value < MIN_CASE_STEPS
        ]
        return _stay("、".join(limits) or "不足 2 步", **common, **numbers)
    return CaseStepAdvice(steps=steps, max_steps=cap, step=step, **common, **numbers)


# --------------------------------------------------------------------------- #
# 多轮决策：缩步长读案例
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class CaseShrinkHint:
    """多轮决策第 2 档（缩步长）用的案例提示：同参数 + 同二级原因 + 同问题类型 + 同方向的先例。"""

    #: 同类的方向（:class:`~services.decision.case_evidence.Direction`），与第一次调整的方向一致才用。
    direction: str
    #: 同向成功先例幅度的中位数；没有可比的数值幅度为 ``None``。
    typical_delta: Optional[float] = None
    #: 同类以恶化为主（成功比例低于「中」档门槛）。
    negative_dominant: bool = False
    support: str = ""
    refs: Tuple[str, ...] = ()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "direction": self.direction,
            "typical_delta": self.typical_delta,
            "negative_dominant": self.negative_dominant,
            "support": self.support,
            "refs": list(self.refs),
        }


def shrink_hint(basis: Any) -> Optional[CaseShrinkHint]:
    """04 案例参考给一条初案的依据 → 缩步长用的提示。没有同类先例的不给（照旧缩一半）。"""
    if basis is None or not int(getattr(basis, "cases", 0) or 0):
        return None
    return CaseShrinkHint(
        direction=str(getattr(basis, "direction", "") or ""),
        typical_delta=getattr(basis, "typical_delta", None),
        negative_dominant=bool(getattr(basis, "negative_dominant", False)),
        support=str(getattr(basis, "support", "") or ""),
        refs=_ref_ids(basis),
    )


__all__ = [
    "CASE_STEPS_REASON",
    "DEFAULT_MAX_STEPS",
    "MIN_CASE_STEPS",
    "CaseShrinkHint",
    "CaseStepAdvice",
    "case_step_advice",
    "shrink_hint",
]
