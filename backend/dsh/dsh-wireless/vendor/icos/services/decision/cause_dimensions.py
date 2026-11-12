# -*- coding: utf-8 -*-
"""六维判定 —— ``base_info_extract`` 的六个 ``*_totalverdict``：对照表、清洗、取有内容的维度与「六维全有」判定。

业务口径（2026-10-29 用户）
--------------------------
* ICOS 在工单上新增六个可选入参，每个是一个维度的问题判定原文，与 02 根因收敛的六词表一一对应
  （:data:`DIMENSIONS`）。
* **02 模型收敛与 06 方案一致性三路一起用**（2026-10-29 晚，推翻当天上午的「六维全有才用六维、替代结论」）：
  ``conclusion`` / ``smart_conclusion`` 恒给，六维**有几维带几维**（:func:`dimension_verdicts`；清洗后为空的维度不带）。
  原先的「全有」门槛是为「六维替代结论」设的，混喂之后不再需要。
* **「六维全有」只剩 02 确定性兜底用**（:func:`dimensions_of` → :func:`converge_order`）：模型收敛失败时，
  六维全有每维一条（不排序），否则照旧解析 ``conclusion`` / ``smart_conclusion``。
* 02 的模型收敛换输入、不换输出契约（每条根因仍带 0–100 置信度），见
  :mod:`services.decision.cause_convergence`。

决策时、事后重建裁决对象、06 复核、展示层都只从这里取六维，调用方不各自判断。

清洗
----
示例数据（``data/icos_data/03/icos-genyin-20261027.xlsx``）里一维多条判定用 ``<br>`` / ``</br>`` 连接，
4G 参数维有 17 单是 ``</br>@@@@`` 占位符。所以 ``<br>`` 的各种写法换成换行、只由 ``@`` 与空白组成的行丢掉。
**不按「；」切**：日期串「劣化时间为：10月20日；10月21日」里也是它，切了会把一条判定拆碎。

依赖
----
只 import :mod:`services.common.text_utils` 与 :mod:`services.decision.convergence`，不碰配置 / 库 / 模型。
"""
from __future__ import annotations

import re
from typing import Any, Dict, Mapping, Optional, Tuple

from services.common.text_utils import _text
from services.decision.convergence import (
    ConclusionShape,
    ConvergedCause,
    ConvergenceResult,
    converge_order_causes,
)

#: ``(入参字段名, 根因类别)``，顺序同 :data:`~services.decision.convergence.CAUSE_CATEGORIES`
#: （逐字一致由 ``tests/test_cause_dimensions.py::test_对照表与六词表逐字一致`` 钉住）。
DIMENSIONS: Tuple[Tuple[str, str], ...] = (
    ("cover_totalverdict", "覆盖"),
    ("adj_totalverdict", "邻区"),
    ("param_totalverdict", "参数"),
    ("interfere_totalverdict", "干扰"),
    ("alarm_totalverdict", "告警"),
    ("resource_totalverdict", "资源"),
)

#: 六个入参字段名，同 :data:`DIMENSIONS` 的顺序。
DIMENSION_FIELDS: Tuple[str, ...] = tuple(field for field, _ in DIMENSIONS)

_BREAK = re.compile(r"</?br\s*/?>", re.IGNORECASE)
_PLACEHOLDER = re.compile(r"[@\s]*")


def clean_verdict(text: Any) -> str:
    """一维判定原文 → 清洗后的文本（一行一条）。为空即「这一维没有」。"""
    lines = (line.strip() for line in _BREAK.sub("\n", _text(text)).split("\n"))
    return "\n".join(line for line in lines if not _PLACEHOLDER.fullmatch(line))


def dimension_verdicts(order: Mapping[str, Any]) -> Dict[str, str]:
    """工单 → ``{类别: 清洗后的判定}``，**只留有内容的维度**（按 :data:`DIMENSIONS` 顺序）；一维都没有是空 dict。

    02 模型收敛、06 复核与展示层的模型上下文都用它（有几维带几维）。
    """
    cleaned = ((category, clean_verdict(order.get(field))) for field, category in DIMENSIONS)
    return {category: text for category, text in cleaned if text}


def dimensions_of(order: Mapping[str, Any]) -> Optional[Dict[str, str]]:
    """工单 → ``{类别: 清洗后的判定}``（按 :data:`DIMENSIONS` 顺序）。**六维都有内容才返回**，否则 ``None``。

    只给 02 确定性兜底用（:func:`converge_order`）；模型收敛与 06 用 :func:`dimension_verdicts`。
    """
    dims = dimension_verdicts(order)
    return dims if len(dims) == len(DIMENSIONS) else None


# --------------------------------------------------------------------------- #
# 02 根因收敛的确定性兜底
# --------------------------------------------------------------------------- #
def converge_dimensions(dims: Mapping[str, str]) -> ConvergenceResult:
    """六维判定 → 确定性收敛结果：每维一条（类别 = 维度、证据 = 判定原文），**不排序、没有主因**。

    用途与结论来源的确定性解析相同：02 模型收敛失败时裁决对象 ``causes`` 的兜底、05 类别四档的输入、
    ``facts.sources`` 的「根因结果」。六维没有 ICOS 问题排序，所以条目 ``ranked=False`` —— 05 类别四档因此
    没有「直接关联」（本来就只注记、不剔）。
    """
    causes = tuple(
        ConvergedCause(rank=rank, category=category, evidence=text, ranked=False)
        for rank, (category, text) in enumerate(dims.items(), 1)
    )
    return ConvergenceResult(shape=ConclusionShape.DIMENSIONS, causes=causes)


def converge_order(order: Mapping[str, Any]) -> ConvergenceResult:
    """工单 → 02 确定性收敛：六维全有用六维，否则照旧解析 ``conclusion`` / ``smart_conclusion``。

    决策流水线与 ``verdict.build_order_decision``（含事后从库行重建）都调它。模型收敛是三路一起送的，
    兜底只能取一种确定性形态：六维全有逐维一条，否则解析结论两字段（2026-10-29 晚混喂时这里不变）。
    """
    dims = dimensions_of(order)
    if dims is not None:
        return converge_dimensions(dims)
    return converge_order_causes(order)  # type: ignore[arg-type]  # 它只调 .get，Mapping 就够


__all__ = [
    "DIMENSIONS",
    "DIMENSION_FIELDS",
    "clean_verdict",
    "converge_dimensions",
    "converge_order",
    "dimension_verdicts",
    "dimensions_of",
]
