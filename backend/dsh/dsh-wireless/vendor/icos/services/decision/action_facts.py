"""动作层的两个后端事实：**域内余量**与**整单判定**。

方案决策正文后四节（08 风险评估 / 09 参数编排 / 10 综合结论 / 11 最终参数方案）改版前
都由模型自己从裁决表和 ``llm_solution`` 的原始 JSON 里**算**出来：步长多少、离硬域边界
还剩多少、整单能不能自动下发。这些全是既成事实，模型在这里做的是算术和转写，而算术是
它最容易出错的地方 —— 实测正文里出现过自己推出来的"距下边界仍有 26dB 余量"，那个数
没有任何地方校验过。

那四节的表格与成品段落（裁决依据表、推送编排、成果物清单）已随 P5「渲染迁出决策包」
搬到 :mod:`services.frontend_view.decision_render`。留在这里的是决策对象自己要用的两样：

* :func:`domain_margin` —— ``StepBasis`` 余量三格（文本 / 数值 / 不足一步）的唯一实现，随裁决对象落库；
* :func:`order_dispatch_verdict` —— 裁决计数 → 整单判定，``OrderVerdict`` 的唯一来源。

唯一一处新算的是「域内余量」：目标值离 ``para`` 区间边界还剩多少（2026-09-30 硬域退役后一度
恒「待平台校验」，10-03 起按 ``para`` 区间重算）。区间的解析与「再走一步还在不在区间内」复用
:func:`~services.compliance.rule_constraint.interval_headroom`，**不自己写第二个解析器**。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from services.compliance.rule_constraint import ParaKind, interval_headroom, para_kind, parse_scalar_float
from services.common.text_utils import _text


def number_text(value: Any) -> str:
    """数值 → 文本。整数去掉小数尾巴，免得 -114.0 与裁决表里的 -114 看着像两个值。

    域内余量的文本（随裁决对象落库）用它，展示层的锚点 / 一步候选两列也用它 ——
    同一个数在对象里和表里必须写成同一个样子。
    """
    number = parse_scalar_float(value)
    if number is None:
        return _text(value)
    return str(int(number)) if float(number).is_integer() else f"{number:g}"


#: 域内余量算不出数时的写法（封闭词表，正文提示词按字面认）。
#: 多值 / 带单位前缀的区间 / 规则没给约束 / 值不是数：07 按 ICOS 建议值直发或判不了，余量交平台校验。
MARGIN_PENDING = "待平台校验"
#: 单值约束（只能取那一个值），或这一行本轮不下发（没有裁决后的目标值）：余量这个概念不适用。
MARGIN_NOT_APPLICABLE = "不适用"
#: 值已不在 ``para`` 区间内。下发集合里不会出现（07 已把出区间的判死），只在存量 / 异常行上。
MARGIN_OUT_OF_DOMAIN = "已越出取值约束"


@dataclass(frozen=True)
class DomainMargin:
    """一个动作的域内余量（:func:`domain_margin`）。"""

    #: 表里那一格：余量数值的文本，或上面三个口径之一。
    text: str
    #: 数值形态；算不出数时为 ``None``。
    value: Optional[float] = None
    #: 按规则方向再调一步就越出取值约束 —— 风险评估必须点名。**只注记**：业务 09-30 口径是
    #: 「现网值 + 一步落在 ``para`` 区间内即下发」，08「风险·余量」不据此剔除（2026-10-03 定）。
    tight: bool = False


def domain_margin(value: Any, *, para: Any, rule_scope: Any, dispatched: bool = True) -> DomainMargin:
    """裁决后目标值在 ``para`` 区间**内**离边界还剩多少，以及按规则方向还能不能再调一步。

    与 ``step_scope_analysis.distance_assessment`` 记的不是一回事：那个记的是 07 判没判过。
    风险评估要问的是"还能不能再调一步"，答案在这里。

    :class:`services.decision.verdict.StepBasis`（随裁决对象落库）与展示层按行重建的裁决依据表
    报的是同一个余量，都调这一个函数。``dispatched=False`` = 这一行本轮不下发（07 判否，或被
    04 / 08 / 06 剔掉）：没有裁决后的目标值，行上的 ``b_para`` 还是 ICOS 原值，不对它算余量。
    """
    if not dispatched or para_kind(para) == ParaKind.SINGLE:
        return DomainMargin(MARGIN_NOT_APPLICABLE)
    headroom = interval_headroom(para, rule_scope, value)
    if headroom is None:
        return DomainMargin(MARGIN_PENDING)
    if not headroom.inside:
        return DomainMargin(MARGIN_OUT_OF_DOMAIN)
    return DomainMargin(
        text=number_text(headroom.margin),
        value=headroom.margin,
        tight=headroom.next_step_fits is False,
    )


# --------------------------------------------------------------------------- #
# 整单判定（裁决对象 verdict；2026-10-13 起不进正文，「综合结论」只拿它核对数量）
# --------------------------------------------------------------------------- #
#: 整单判定的封闭词表。**模型不得自拟，也不得改写**。
VERDICT_AUTO = "可自动下发"
VERDICT_CONDITIONAL = "条件下发"
VERDICT_NONE = "不下发"
#: 多轮决策调整在整单判定叙述里的说明：值按多轮决策阶梯取（从原值起算），不做规则校验。
MULTI_ROUND_NOTE = "按多轮决策阶梯取值，未再做规则校验"


def order_dispatch_verdict(verdict_stats: Dict[str, Any]) -> Dict[str, Any]:
    """裁决计数（:func:`services.decision.plan_table.verdict_stats`）→ 整单判定。

    判定口径完全由计数决定，没有可解释的余地：

    * 一项都没进参数平台 → ``不下发``；
    * 进了，但有动作没经过规则校验（规则库无匹配 / 规则判不了，按 ICOS 建议值直通）→ ``条件下发``；
    * 进了且全部过了规则库校验 → ``可自动下发``。短评估多轮决策调整（缩步长 / 反向 / 回退）按多轮决策阶梯取值、
      不做规则校验，也算在这一档（行为未变），叙述里单独说明，不把它们说成「通过了规则库校验」。

    这三行以前写在 ``fallbacks._fallback_conclusion_section`` 里、只在降级时生效，
    模型正常产出时自己判一遍 —— 于是同一张工单降级前后可能给出两个结论。
    现在提到这里，两条路径引用同一个函数。

    ``statement`` 是纯文本叙述（不含 Markdown），随 ``OrderVerdict.statement`` 落库，
    所以留在决策包。

    ``row_count`` 为 0（连决策行都没有）时返回空判定：那种情况下本节确实无从判定，
    硬给一个"不下发"反而是编结论，交给调用方退回状态叙述。
    """
    total = int(verdict_stats.get("row_count") or 0)
    admitted = int(verdict_stats.get("admitted_count") or 0)
    unchecked = int(verdict_stats.get("unchecked_count") or 0)
    rejected = int(verdict_stats.get("rejected_count") or 0)
    multi_round = int(verdict_stats.get("multi_round_count") or 0)
    if not total:
        return {"verdict": "", "statement": "", "admitted_count": 0}

    if admitted == 0:
        statement = (
            f"{VERDICT_NONE}。本轮 {total} 项参数动作均未通过裁决，没有动作进入参数平台，"
            "相关参数保持现网值不变。"
        )
        verdict = VERDICT_NONE
    elif unchecked:
        statement = (
            f"{VERDICT_CONDITIONAL}。共 {admitted} 个参数动作进入参数平台，"
            f"其中 {unchecked} 项因规则库无匹配规则或规则判定未能完成，按 ICOS 建议值直通，"
            "取值约束与规则步长待参数平台校验。"
        )
        verdict = VERDICT_CONDITIONAL
    else:
        if multi_round >= admitted:
            detail = f"均为短评估多轮决策调整（{MULTI_ROUND_NOTE}）。"
        elif multi_round:
            detail = f"其中 {multi_round} 项为短评估多轮决策调整（{MULTI_ROUND_NOTE}），其余均已通过规则库校验。"
        else:
            detail = "均已通过规则库校验。"
        statement = f"{VERDICT_AUTO}。共 {admitted} 个参数动作进入参数平台，{detail}"
        verdict = VERDICT_AUTO

    if rejected:
        statement += f"其余 {rejected} 项未进入本轮，不涉及下发。"
    return {"verdict": verdict, "statement": statement, "admitted_count": admitted}


__all__ = [
    "MARGIN_NOT_APPLICABLE",
    "MARGIN_OUT_OF_DOMAIN",
    "MARGIN_PENDING",
    "VERDICT_AUTO",
    "VERDICT_CONDITIONAL",
    "VERDICT_NONE",
    "DomainMargin",
    "domain_margin",
    "number_text",
    "order_dispatch_verdict",
]
