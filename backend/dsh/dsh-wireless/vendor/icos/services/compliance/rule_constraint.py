# -*- coding: utf-8 -*-
"""规则取值约束判定 —— **代码而非 LLM** 裁决参数能不能发、发什么值的地方。

2026-09-30 起规则表换成 ``sys_cell_execute_jiangsu.csv``，业务定的口径是：**只用 ``para`` 与
``rule_scope`` 两列**（原 ``numeric_policy`` 的硬域、半步取整、越域拉回整套退役）。

``para`` —— 取值约束（硬约束，不满足即剔除）
--------------------------------------------
============  ===============================  ===========================================
写法           例子                              判定
============  ===============================  ===========================================
单值           ``1`` / ``UlRaUserSchOptSw-1``    ICOS 建议值必须等于它；现网已是它 → 无需下发
区间           ``<-50`` / ``>-128``             下发值 = 现网值 + ``rule_scope``（一步），须落在区间内
多值           ``28;28;28;32``                  **暂按 ICOS 建议值直发**（业务 09-30 定）
带前缀的区间    ``<DBM_102``                      **暂按 ICOS 建议值直发**（业务 09-30 定）
============  ===============================  ===========================================

``rule_scope`` —— 带符号的步长，只作用于区间类
--------------------------------------------
``+1`` 表示步长 1、往大调；``-2`` 表示步长 2、往小调。规则表 138 行数值步长全部显式带符号，
且 ``+`` 全配 ``<N``、``-`` 全配 ``>N``。裸数字（表里没有）按正方向读。
单值类的 ``rule_scope`` 写成 ``!=X``，不参与判定。

区间类的下发值由代码按「现网值 + 一步」算出，**不照搬 ICOS 建议值**：ICOS 建议值只用来核对
方向 —— 与规则方向一致就发这一步（建议值走了多步的，改写成一步），相反或没给方向就不发。

调用方可以传 ``steps``（2026-10-09，07 的「案例建议步数」，见 :mod:`services.decision.case_steps`）：
下发值改为「现网值 + ``steps`` 步」，其余判法不变。该不该多走、走几步由调用方定，本模块只算值、核区间。

比较口径：两边都能读成数就按数值比（``1`` 等于 ``1.0``），否则去掉首尾空白、不分大小写逐字比。
``TRUE`` 与 ``1`` **不**视为同一个值。

本文件不依赖配置、数据库或 LLM，是可以脱离一切外部依赖单测的纯计算。保持这个性质。

原 ``numeric_policy`` 删除后，参数值的文本口径（:func:`format_para_text_value`）与单数值解析
（:func:`parse_scalar_float`）一并搬到这里 —— 它们与模型无关，决策链、多轮决策、落库、展示层都用。
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

_ABS_TOL = 1e-6
_NUMBER = r"[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?"
_INTERVAL = re.compile(rf"^(<=|>=|<|>)\s*({_NUMBER})$")
#: 比较号开头但边界不是纯数（``<DBM_102``）：带单位前缀的区间。
_PREFIXED_INTERVAL = re.compile(r"^(<=|>=|<|>)\s*\S+$")


# --------------------------------------------------------------------------- #
# 从 numeric_policy 搬来的纯工具（参数值文本口径 + 单数值解析）
# --------------------------------------------------------------------------- #
def format_para_text_value(value: Any) -> Optional[str]:
    """ICOS/参数平台参数字段：整型值写为无小数形式（10.0 → 10，-50.0 → -50）。

    原在 ``services.compliance.harness``（合规模型输出的结构校验），2026-09-25 随合规链删除搬进
    ``numeric_policy``，2026-09-30 起 ``numeric_policy`` 删除后再搬到这里 —— 它是参数值的文本口径，
    与模型无关，决策链、多轮决策、落库都用它。
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isfinite(value) and value == int(value):
            return str(int(value))
        return str(value)
    s = str(value).strip()
    if not s:
        return s
    whole_decimal = re.fullmatch(r"(-?\d+)\.0+", s)
    if whole_decimal:
        return whole_decimal.group(1)
    if re.fullmatch(r"-?\d+", s):
        return s
    if re.fullmatch(r"-?\d+\.\d+", s) and len(s) <= 24:
        try:
            f = float(s)
            if math.isfinite(f) and f == int(f):
                return str(int(f))
        except ValueError:
            pass
    return s


def parse_scalar_float(value: Any) -> Optional[float]:
    """整串是单一数值才返回 float，否则 None（``"-15~15"`` 这类不算）。"""
    if value is None:
        return None
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    if not re.fullmatch(_NUMBER, text):
        return None
    try:
        return float(text)
    except ValueError:
        return None


class ParaKind:
    """``para`` 的写法分类。"""

    SINGLE = "single"
    MULTI = "multi"
    INTERVAL = "interval"
    PREFIXED_INTERVAL = "prefixed_interval"
    EMPTY = "empty"


class ConstraintReason:
    """判定原因码（封闭词表）。前三个可下发，其余不下发。

    展示层按它出「未准入·…」的短原因（决策链 :data:`services.decision.chain.ChainReason` 映射），
    改名要两边一起改。
    """

    #: 满足约束，按 ICOS 建议值下发。
    AS_PROPOSED = "as_proposed"
    #: 多值 / 带前缀区间 / 规则没给约束：暂按 ICOS 建议值直发，不做校验。
    PASSTHROUGH = "passthrough"
    #: 区间类：ICOS 建议值不在一步上，按规则步长改写成现网值 + 一步。
    REWRITTEN = "rewritten"
    #: ICOS 建议值不在取值约束内（单值不等 / 一步后越出区间）。
    NOT_SATISFIED = "not_satisfied"
    #: 区间类：ICOS 建议的调整方向与规则步长的方向不符（相反，或没给方向）。
    DIRECTION_MISMATCH = "direction_mismatch"
    #: 单值类：现网值已经是规则要的值，无需下发。
    AT_TARGET = "at_target"
    #: 区间类：现网值或 ICOS 建议值不是数，没法按步长计算。
    VALUE_INVALID = "value_invalid"


DISPATCH_REASONS = frozenset(
    {ConstraintReason.AS_PROPOSED, ConstraintReason.PASSTHROUGH, ConstraintReason.REWRITTEN}
)


@dataclass(frozen=True)
class ConstraintResult:
    """一个参数的判定结论。``summary`` 是给人看的一句话，正文与对照表原样引用。"""

    reason: str
    kind: str
    #: 下发值（文本口径）。不下发时是 ICOS 建议值原文。
    final_b_para: str
    summary: str
    para: str = ""
    rule_scope: str = ""
    step: Optional[float] = None
    #: +1 调大 / -1 调小 / None 未给数值步长
    direction: Optional[int] = None
    #: 区间类按现网值 + ``steps`` 步算出的值（默认一步）
    target: Optional[str] = None
    warnings: List[str] = field(default_factory=list)
    #: 区间类走了几步。默认 1；大于 1 只来自调用方给的多步依据（07 的案例建议步数），本模块不自己决定。
    steps: int = 1

    @property
    def dispatch(self) -> bool:
        return self.reason in DISPATCH_REASONS

    def to_dict(self) -> Dict[str, Any]:
        out = {
            "reason": self.reason,
            "kind": self.kind,
            "dispatch": self.dispatch,
            "final_b_para": self.final_b_para,
            "summary": self.summary,
            "para": self.para,
            "rule_scope": self.rule_scope,
            "step": self.step,
            "direction": self.direction,
            "target": self.target,
        }
        # 只有多步时才带这一格：一步的结论与 2026-10-09 之前逐字相同。
        if self.steps > 1:
            out["steps"] = self.steps
        return out


# --------------------------------------------------------------------------- #
# 解析
# --------------------------------------------------------------------------- #
def _text(value: Any) -> str:
    if value is None:
        return ""
    try:
        if value != value:  # noqa: PLR0124 - NaN
            return ""
    except (TypeError, ValueError):
        pass
    return str(value).strip()


def _number(value: Any) -> Optional[float]:
    text = _text(value).replace(",", "")
    if not re.fullmatch(_NUMBER, text):
        return None
    return float(text)


def _same_value(a: str, b: str) -> bool:
    fa, fb = _number(a), _number(b)
    if fa is not None and fb is not None:
        return math.isclose(fa, fb, rel_tol=0.0, abs_tol=_ABS_TOL)
    return a.strip().lower() == b.strip().lower()


def para_kind(para: Any) -> str:
    text = _text(para)
    if not text:
        return ParaKind.EMPTY
    if ";" in text or "；" in text:
        return ParaKind.MULTI
    if _INTERVAL.match(text):
        return ParaKind.INTERVAL
    if _PREFIXED_INTERVAL.match(text):
        return ParaKind.PREFIXED_INTERVAL
    return ParaKind.SINGLE


def parse_step(rule_scope: Any) -> tuple[Optional[float], Optional[int]]:
    """``(步长大小, 方向)``；不是数值步长（如 ``!=X``）或步长为 0 返回 ``(None, None)``。

    裸数字按正方向读（规则表里没有，保留以防现场改表）。
    """
    text = _text(rule_scope)
    value = _number(text)
    if value is None or math.isclose(value, 0.0, abs_tol=_ABS_TOL):
        return None, None
    return abs(value), (-1 if value < 0 else 1)


@dataclass(frozen=True)
class IntervalHeadroom:
    """区间类取值约束下，一个值离区间边界还剩多少（:func:`interval_headroom`）。"""

    #: 值在不在区间内。不在时 :attr:`margin` 与 :attr:`next_step_fits` 没有意义。
    inside: bool
    #: 值到区间边界的距离。
    margin: float
    #: 按规则步长同方向再走一步还在不在区间内；规则没给数值步长时为 ``None``（判不了）。
    next_step_fits: Optional[bool]


def interval_headroom(para: Any, rule_scope: Any, value: Any) -> Optional[IntervalHeadroom]:
    """``para`` 是区间（``<N`` / ``>N`` …）且 ``value`` 是数 → 离边界的余量与能不能再走一步；否则 ``None``。

    「能不能再走一步」只能拿区间本身判，不能拿「余量 < 步长」比：规则表 130 行区间全是开区间
    （``<`` / ``>``），落在边界上就已出区间 —— 余量**恰好等于**一步也是再走一步就出区间。
    """
    match = _INTERVAL.match(_text(para))
    number = _number(value)
    if match is None or number is None:
        return None
    operator, bound = match.group(1), float(match.group(2))
    step, direction = parse_step(rule_scope)
    return IntervalHeadroom(
        inside=_in_interval(number, operator, bound),
        margin=abs(bound - number),
        next_step_fits=None if step is None else _in_interval(number + direction * step, operator, bound),
    )


def _in_interval(value: float, operator: str, bound: float) -> bool:
    if operator == "<":
        return value < bound - _ABS_TOL
    if operator == "<=":
        return value <= bound + _ABS_TOL
    if operator == ">":
        return value > bound + _ABS_TOL
    return value >= bound - _ABS_TOL


def steps_within(para: Any, rule_scope: Any, anchor: Any, limit: int) -> int:
    """从 ``anchor`` 按规则步长的方向连走几步仍落在 ``para`` 区间内（至多 ``limit`` 步）。

    ``para`` 不是数值区间、``rule_scope`` 不是数值步长、``anchor`` 不是数 → 0（判不了，调用方按一步处理）。
    """
    match = _INTERVAL.match(_text(para))
    step, direction = parse_step(rule_scope)
    start = _number(anchor)
    if match is None or step is None or start is None:
        return 0
    operator, bound = match.group(1), float(match.group(2))
    count = 0
    while count < max(int(limit), 0) and _in_interval(start + direction * step * (count + 1), operator, bound):
        count += 1
    return count


def _fmt(value: float) -> str:
    return format_para_text_value(value) or ""


def _direction_text(direction: Optional[int]) -> str:
    return {1: "调大", -1: "调小"}.get(direction or 0, "")


# --------------------------------------------------------------------------- #
# 本体
# --------------------------------------------------------------------------- #
def assess_constraint(rule_row: Dict[str, Any], *, f_para: Any, b_para: Any, steps: int = 1) -> ConstraintResult:
    """规则行 + 现网值 + ICOS 建议值 → 判定结论。**永不抛**，口径见模块文档。

    ``steps``：区间类从现网值走几步（默认一步）。大于 1 只来自调用方给的多步依据（07 的案例建议步数，
    2026-10-09），本模块只按它算目标值、核区间，不判该不该多走；单值 / 多值 / 带前缀区间不受它影响。
    """
    para = _text(rule_row.get("para"))
    scope = _text(rule_row.get("rule_scope"))
    current = format_para_text_value(_text(f_para)) or ""
    proposed = format_para_text_value(_text(b_para)) or ""
    kind = para_kind(para)
    base = {"kind": kind, "para": para, "rule_scope": scope}

    if kind == ParaKind.EMPTY:
        return ConstraintResult(
            reason=ConstraintReason.PASSTHROUGH, final_b_para=proposed,
            summary="规则未给出取值约束，按 ICOS 建议值下发。", **base,
        )
    if kind == ParaKind.MULTI:
        return ConstraintResult(
            reason=ConstraintReason.PASSTHROUGH, final_b_para=proposed,
            summary=f"取值约束为多值「{para}」，暂按 ICOS 建议值下发，智能体判断无需修改。", **base,
        )
    if kind == ParaKind.PREFIXED_INTERVAL:
        return ConstraintResult(
            reason=ConstraintReason.PASSTHROUGH, final_b_para=proposed,
            summary=f"取值约束「{para}」带单位前缀，暂按 ICOS 建议值下发，智能体判断无需修改。", **base,
        )
    if kind == ParaKind.SINGLE:
        return _assess_single(para, current, proposed, base)
    return _assess_interval(para, scope, current, proposed, base, steps=max(int(steps or 1), 1))


def _assess_single(para: str, current: str, proposed: str, base: Dict[str, Any]) -> ConstraintResult:
    if not _same_value(proposed, para):
        return ConstraintResult(
            reason=ConstraintReason.NOT_SATISFIED, final_b_para=proposed,
            summary=f"取值约束：只能取 {para}；ICOS 建议值 {proposed or '（空）'} 不符合，不下发。", **base,
        )
    if current and _same_value(current, para):
        return ConstraintResult(
            reason=ConstraintReason.AT_TARGET, final_b_para=proposed,
            summary=f"取值约束：只能取 {para}；现网值已是 {current}，无需下发。", **base,
        )
    return ConstraintResult(
        reason=ConstraintReason.AS_PROPOSED, final_b_para=proposed,
        summary=f"取值约束：只能取 {para}；ICOS 建议值与之一致，按建议值下发。", **base,
    )


def _assess_interval(
    para: str, scope: str, current: str, proposed: str, base: Dict[str, Any], *, steps: int = 1
) -> ConstraintResult:
    match = _INTERVAL.match(para)
    operator, bound = match.group(1), float(match.group(2))
    step, direction = parse_step(scope)
    anchor, value = _number(current), _number(proposed)

    if step is None:
        # 表里区间类都带数值步长；万一没有，只核对建议值在不在区间里。
        if value is not None and _in_interval(value, operator, bound):
            return ConstraintResult(
                reason=ConstraintReason.AS_PROPOSED, final_b_para=proposed,
                summary=f"取值约束 {para}；规则未给出数值步长，ICOS 建议值 {proposed} 满足约束，按建议值下发。",
                **base,
            )
        return ConstraintResult(
            reason=ConstraintReason.NOT_SATISFIED, final_b_para=proposed,
            summary=f"取值约束 {para}；ICOS 建议值 {proposed or '（空）'} 不满足约束，不下发。", **base,
        )

    head = f"取值约束 {para}，规则步长 {scope}（{_direction_text(direction)}）"
    extra = {"step": step, "direction": direction}
    if anchor is None:
        return ConstraintResult(
            reason=ConstraintReason.VALUE_INVALID, final_b_para=proposed,
            summary=f"{head}；现网值「{current or '空'}」不是数值，无法按规则步长计算，不下发。",
            **base, **extra,
        )
    if value is None:
        return ConstraintResult(
            reason=ConstraintReason.VALUE_INVALID, final_b_para=proposed,
            summary=f"{head}；ICOS 建议值「{proposed or '空'}」不是数值，无法判断调整方向，不下发。",
            **base, **extra,
        )

    delta = value - anchor
    if math.isclose(delta, 0.0, abs_tol=_ABS_TOL):
        return ConstraintResult(
            reason=ConstraintReason.DIRECTION_MISMATCH, final_b_para=proposed,
            summary=f"{head}；ICOS 建议值与现网值 {current} 相同，未给出调整方向，不下发。",
            **base, **extra,
        )
    if (delta > 0) != (direction > 0):
        return ConstraintResult(
            reason=ConstraintReason.DIRECTION_MISMATCH, final_b_para=proposed,
            summary=(
                f"{head}；ICOS 建议值 {proposed} 相对现网值 {current} 为"
                f"{_direction_text(1 if delta > 0 else -1)}，方向与规则不符，不下发。"
            ),
            **base, **extra,
        )

    target_value = anchor + direction * step * steps
    target = _fmt(target_value)
    extra["target"] = target
    extra["steps"] = steps
    # 一步时措辞与 2026-10-09 之前逐字相同；多步只在调用方给了多步依据时出现。
    walk = "调一步到" if steps == 1 else f"调 {steps} 步到"
    if not _in_interval(target_value, operator, bound):
        return ConstraintResult(
            reason=ConstraintReason.NOT_SATISFIED, final_b_para=proposed,
            summary=f"{head}；现网值 {current} {walk} {target}，不满足约束，不下发。",
            **base, **extra,
        )
    if math.isclose(value, target_value, abs_tol=_ABS_TOL):
        return ConstraintResult(
            reason=ConstraintReason.AS_PROPOSED, final_b_para=proposed,
            summary=f"{head}；现网值 {current} {walk} {target}，满足约束，与 ICOS 建议值一致，按建议值下发。",
            **base, **extra,
        )
    icos_steps = abs(delta) / step
    how = (
        f"走了 {int(round(icos_steps))} 步"
        if math.isclose(icos_steps, round(icos_steps), abs_tol=_ABS_TOL)
        else "不在一步上"
    )
    rewrite = (
        f"按规则步长由现网值 {current} 调一步到 {target}"
        if steps == 1
        else f"按规则步长由现网值 {current} 调 {steps} 步到 {target}"
    )
    return ConstraintResult(
        reason=ConstraintReason.REWRITTEN, final_b_para=target,
        summary=f"{head}；ICOS 建议值 {proposed} {how}，{rewrite}，满足约束。",
        **base, **extra,
    )


__all__ = [
    "ConstraintReason",
    "ConstraintResult",
    "IntervalHeadroom",
    "assess_constraint",
    "format_para_text_value",
    "interval_headroom",
    "para_kind",
    "parse_scalar_float",
    "parse_step",
    "steps_within",
]
