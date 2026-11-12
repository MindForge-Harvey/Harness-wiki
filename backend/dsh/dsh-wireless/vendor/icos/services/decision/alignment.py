"""决策步 05 根因对齐的**兜底** —— 类别四档关联路由（**确定性，不调模型**）。主路径见 :mod:`services.decision.cause_alignment`。

05 的产出 = 每个初案动作挂到 02 收敛根因上的**关联四档**
（:class:`services.decision.verdict.Association`：直接 / 次级 / 通用 / 不一致）。
本模块之前这一步恒是 ``PENDING``（未判定）—— :class:`ActionVerdict.association` 写死
``PENDING``、:attr:`Cause.aligned` 恒 ``False``、``cause_gaps`` 恒空。现在 02 确定性解析
收敛不出类别时（自由文本、两字段皆空）仍是未判定；四档只作注记（``gate.gate_path``），
2026-09-24 通用方案容忍度删除后不影响任何一条决策条件。

本模块把**确定性**的四档路由补上，作为 P1.5「根因类目 ⟷ 方案组」映射表到位前的
兜底（业务口径「先跑起来再换」）：

=================  ==========================================================
档                 判据
=================  ==========================================================
直接关联           初案 ``type1`` == 02 收敛**主因类别**（``primary_category``）
次级关联           初案 ``type1`` 落在 02 收敛的**其余类别**里
通用方案           初案 ``type1`` == ``参数通用``（现网 type1 仅两值之一）
不一致             初案 ``type1`` 不在任何收敛类别、也不是参数通用 → 记「不一致项」，
                  走通用路径（**不是拒绝**）
=================  ==========================================================

2026-10-03 起本模块**退为兜底**：业务定根因对齐分析的是「02 收敛出的根因与方案之间的对应关系」，
由模型以网优专家身份判（:mod:`services.decision.cause_alignment`，四档同词，由那边按「针对的根因里有没有
主因」定）。只有 02 模型收敛没有根因可对（失败 / 两字段皆空 / 一条都没读出来）时，决策流水线与
``verdict.build_order_decision`` 才退回这里的类别四档；事后从 DB 行重建裁决对象也走这里。

类别四档本身的口径不变
----------------------
02 确定性解析的类别（六词表）与初案 ``type1``（现网两值：覆盖 / 参数通用）都是**封闭词表**，
四档判据是纯粹的集合归属判断 —— 它只回答「类别对没对上」，回答不了「这个方案的参数对哪条根因起作用」，
后者才是业务要的对齐，所以交给了模型。

依赖
----
本模块 → :mod:`services.decision.convergence`（02 收敛，叶子）+ ``plan_table.plan_key``
（对齐键）。**不 import verdict**（否则 ``verdict → alignment → verdict`` 成环）——
四档的字符串取值与 ``verdict.Association`` 逐字相等，由
``tests/test_alignment.py`` 钉住（同 ``convergence.CAUSE_BASIS`` 的既有范式）。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, Mapping, Sequence, Tuple

from services.common.text_utils import _text
from services.decision.convergence import CAUSE_CATEGORIES
from services.decision.plan_table import plan_key

if TYPE_CHECKING:  # 仅类型注解用
    from services.decision.convergence import ConvergenceResult

#: 初案 ``type1`` 里表示「通用方案」的取值。现网 type1 只有 覆盖 / 参数通用 两个值。
TYPE1_GENERIC = "参数通用"

#: 四档取值。**必须逐字等于** ``verdict.Association`` 的同名字段，由
#: ``tests/test_alignment.py::test_四档常量逐字等于_verdict_Association`` 钉住。
ASSOCIATION_DIRECT = "直接关联"
ASSOCIATION_SECONDARY = "次级关联"
ASSOCIATION_GENERAL = "通用方案"
ASSOCIATION_INCONSISTENT = "不一致"

#: ``AlignmentGap.kind`` 的取值。
GAP_INCONSISTENT = "inconsistent"   # 初案 type1 不在任何收敛类别、也不是参数通用
GAP_NO_PLAN = "no_plan"             # 收敛出的类别没有任何初案 type1 对上


@dataclass(frozen=True)
class AlignmentGap:
    """05 的一条「记录不一致项」/「有根因无方案」—— 流程图上那个红框。

    与 :class:`services.decision.verdict.CauseGap` 同构；本模块不 import verdict，
    故自立一类，由调用方（verdict.py）转成 ``CauseGap``。
    """

    kind: str
    cause: str
    detail: str = ""
    #: 主因落空要进整单判定，次因落空只记录。
    is_primary: bool = False


@dataclass(frozen=True)
class AlignmentResult:
    """05 根因对齐的产出。

    * ``associations``：``plan_key → 四档``。查不到的动作（初案被清理等）由调用方
      退回 ``Association.PENDING``。
    * ``gaps``：不一致项 + 有根因无方案。
    * ``aligned``：02 有没有收敛出根因可供对齐。``False`` = 自由文本/两字段皆空，
      05 无从对齐，``associations`` / ``gaps`` 恒空 —— **与「对齐过、没有 gap」区分**。
    """

    associations: Dict[str, str]
    gaps: Tuple[AlignmentGap, ...]
    aligned: bool


def _classify(type1: str, primary: str, categories: set[str]) -> str:
    """一条初案的 ``type1`` → 四档。见模块文档的判据表。"""
    if primary and type1 == primary:
        return ASSOCIATION_DIRECT
    if type1 in categories:
        return ASSOCIATION_SECONDARY
    if type1 == TYPE1_GENERIC:
        return ASSOCIATION_GENERAL
    return ASSOCIATION_INCONSISTENT


def align_root_causes(
    convergence: "ConvergenceResult",
    icos_rows: Sequence[Mapping[str, Any]],
) -> AlignmentResult:
    """02 收敛结果 + 初案清单 → 05 关联四档 + 不一致项/有根因无方案。

    **纯函数**：无 IO、不调模型。四档判据只认两类封闭词表（收敛六词表 + 初案 type1），
    见模块文档。P1.5 映射表到位后，这里换成「查映射表 + 本函数兜底」。
    """
    causes = convergence.causes
    if not causes:
        return AlignmentResult(associations={}, gaps=(), aligned=False)

    primary = convergence.primary_category
    categories = set(convergence.categories)
    # 初案里出现过的 type1（含空/缺失）—— no_plan 判定用。
    plan_type1s: set[str] = set()

    associations: Dict[str, str] = {}
    inconsistent_seen: list[str] = []
    for plan in icos_rows or []:
        if not isinstance(plan, dict):
            continue
        type1 = _text(plan.get("type1"))
        key = plan_key(plan.get("execution_id"), plan.get("parachinname"))
        if not key or not type1:
            continue
        plan_type1s.add(type1)
        association = _classify(type1, primary, categories)
        associations[key] = association
        if association == ASSOCIATION_INCONSISTENT and type1 not in inconsistent_seen:
            inconsistent_seen.append(type1)

    gaps: list[AlignmentGap] = []
    # 有根因无方案：收敛类别没有任何初案 type1 对上。主因先列（要进整单判定）。
    missing = [c for c in convergence.categories if c not in plan_type1s]
    for category in sorted(missing, key=lambda c: (c != primary,)):
        gaps.append(
            AlignmentGap(
                kind=GAP_NO_PLAN,
                cause=category,
                detail=f"收敛出「{category}」但初案无对应 type1",
                is_primary=(category == primary),
            )
        )
    for type1 in inconsistent_seen:
        gaps.append(
            AlignmentGap(
                kind=GAP_INCONSISTENT,
                cause=type1,
                detail=f"初案 type1「{type1}」不在收敛类别 {list(CAUSE_CATEGORIES)} 里",
                is_primary=False,
            )
        )
    return AlignmentResult(associations=associations, gaps=tuple(gaps), aligned=True)


__all__ = [
    "ASSOCIATION_DIRECT",
    "ASSOCIATION_GENERAL",
    "ASSOCIATION_INCONSISTENT",
    "ASSOCIATION_SECONDARY",
    "TYPE1_GENERIC",
    "GAP_INCONSISTENT",
    "GAP_NO_PLAN",
    "AlignmentGap",
    "AlignmentResult",
    "align_root_causes",
]
