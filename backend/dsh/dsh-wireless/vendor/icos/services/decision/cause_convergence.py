"""决策步 02 根因收敛 —— 模型从工单原文收敛根因，**每条根因带 0–100 的置信度**。

业务口径
--------
* 2026-09-24（关联判定那一轮）：用 ``conclusion`` / ``smart_conclusion`` 原文做根因收敛时，完全由
  模型凭网优知识收敛，不区分、不使用结构化根因。
* 2026-09-24（本模块）：**收敛出的根因本身要带置信度**；收敛独立成 02 的一次模型调用（每单都做，
  不再由 04 每个方案组各收敛一遍）；置信度用 0–100；置信度**参与决策** —— 只有达到阈值
  （``order_loop.decision.root_cause.confidence_threshold``，默认 40；2026-09-27 由 60 改为 40）的根因才作为 04 组内寻优的依据，
  全部低于阈值 = 根因不明，04 不窄化；界面上的「根因收敛」表与大屏根因候选改读这份结果。
* 2026-10-29（六维判定）：工单带了六维判定时改用 scene :data:`SCENE_DIMENSIONS`。当天上午是「六维全有才用、
  只送六维」，**晚间用户改为三路一起用**：``conclusion`` / ``smart_conclusion`` 与六维（有几维带几维，取自
  :func:`services.decision.cause_dimensions.dimension_verdicts`）、本单问题类型一起送；一维都没有就照旧走
  :data:`SCENE`，与 2026-10-29 之前逐字一样。输出契约不变，结果多记一个 :attr:`CauseConvergence.source`，
  裁决对象据此标根因出处。

与 :mod:`services.decision.convergence` 的分工
----------------------------------------------
那是**确定性解析器**：只认「问题排序 / 问题分析 / 优化建议」三段式，按位次拆出 (类别, 证据, 建议)，
不编置信度。它仍是 **05 根因对齐**的输入（要六词表类别当映射键），也是本模块失败时裁决对象
``causes`` 的兜底。本模块是**模型载体**：自由文本工单也能收敛，每条带置信度与原文依据。
两者输出进 :class:`~services.decision.verdict.Cause` 时靠 ``basis`` 分开（``CauseBasis``）。

置信度是什么
------------
模型按提示词里的刻度给出的「**原文对这条根因的支撑强度**」（有量化证据的明确点名 85–100 …
只有弱线索 0–39），不是概率，也不是本轮下发了什么。模型同一输入会翻转（L2 观测 28%），所以
阈值做成配置、结论落轨迹，差异清单里能看见每一单因为置信度被怎样处理。

失败口径（fail-open）
--------------------
调用 / 渲染 / 解析失败 → :attr:`ConvergenceStatus.FAILED`：裁决对象的 ``causes`` 退回确定性解析
（无置信度），04 拿不到可用根因、组内全留（与关联判定失败同一个结果）。**绝不把决策带崩。**
两个字段都空、也没有六维 → :attr:`ConvergenceStatus.NOT_CALLED`，不调模型（业务 09-17：两字段皆空的工单按通用方案判）。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from typing import Any, Dict, Mapping, Optional, Tuple

from services import prompts
from services.common.llm import LLMClient, LLMError, LLMTimeout, get_llm_client
from services.common.logging import get_logger
from services.common.text_utils import _text
from services.decision.convergence import CAUSE_CATEGORIES, SOURCE_CONCLUSION, SOURCE_DIMENSIONS
from services.prompts import PromptNotFound, PromptRenderError

logger = get_logger(__name__)

#: 提示词 ``root_cause_convergence`` / ``root_cause_convergence_dims`` 的输出契约键（见 ``assets/cause_convergence.yaml``）。
_CONVERGENCE_LLM_KEYS = ("causes", "reasoning")
SCENE = "root_cause_convergence"
#: 工单带了六维判定时用的 scene（2026-10-29；晚间起结论两字段与六维一起送），输出契约同 :data:`SCENE`。
SCENE_DIMENSIONS = "root_cause_convergence_dims"

#: 六词表之外的类别一律记成它。05 根因对齐不读本模块的类别，这里只作展示与分组线索。
CATEGORY_OTHER = "其他"
CATEGORY_VOCAB: Tuple[str, ...] = (*CAUSE_CATEGORIES, CATEGORY_OTHER)

MAX_CAUSES = 5
_MAX_CAUSE_CHARS = 30
_MAX_EVIDENCE_CHARS = 200
_MAX_REASONING_CHARS = 300

#: 阈值没配时的默认值（与 ``DecisionSettings.root_cause_confidence_threshold`` 同值）。
DEFAULT_CONFIDENCE_THRESHOLD = 40


class ConvergenceStatus:
    #: 模型给出了结论。**可以是空清单**（原文读不出任何根因线索）—— 那是判了，不是没判。
    CONVERGED = "converged"
    #: 两个字段都空，没东西可收敛，不调模型。
    NOT_CALLED = "not_called"
    #: 调用 / 渲染 / 解析失败。
    FAILED = "failed"


class CauseStanding:
    """一条根因与阈值比较后的结论。**展示层「根因收敛」表的「结论」列就用这套词。**

    「主因 / 次因」与前端 ``solutionSections.buildRootFocusChain`` 认的两个词同名，这是刻意的：
    根因链路那一格按它们拼。注意与初案对齐表（``root_cause``，展示在「根因对齐」一节）的同名词
    **口径不同** —— 那边的主因是「本轮据此下发了参数的那条」，这边是「置信度最高且达到阈值的那条」。
    """

    #: 置信度最高、且达到阈值。整单至多一条。
    PRIMARY = "主因"
    #: 其余达到阈值的。
    SECONDARY = "次因"
    #: 低于阈值 —— 不作为 04 组内寻优的依据。
    LOW = "低置信"


@dataclass(frozen=True)
class ModelCause:
    """模型收敛出的一条根因。"""

    #: 1 起，按置信度从高到低（并列保持模型给的先后）。
    rank: int
    cause: str
    #: 六词表之一，或 :data:`CATEGORY_OTHER`。
    category: str
    #: 0–100 的整数。
    confidence: int
    #: 原文里支撑它的那一句（模型摘录）。
    evidence: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "rank": self.rank,
            "cause": self.cause,
            "category": self.category,
            "confidence": self.confidence,
            "evidence": self.evidence,
        }


@dataclass(frozen=True)
class CauseConvergence:
    """一单的 02 根因收敛结果（模型载体）。"""

    status: str
    causes: Tuple[ModelCause, ...] = ()
    reasoning: str = ""
    error: str = ""
    #: 收敛原文的来源（``convergence.CONVERGENCE_SOURCE_VOCAB``，2026-10-29）：``dimensions`` = 结论两字段与六维一起送
    #: （schema 16 那一版只送六维），``conclusion`` = 只有结论两字段。
    source: str = SOURCE_CONCLUSION

    @property
    def converged(self) -> bool:
        return self.status == ConvergenceStatus.CONVERGED

    def confident(self, threshold: int) -> Tuple[ModelCause, ...]:
        """置信度达到阈值的根因 —— **04 组内寻优只认这几条**。没收敛成功一律为空。"""
        if not self.converged:
            return ()
        return tuple(cause for cause in self.causes if cause.confidence >= threshold)

    def standing(self, cause: ModelCause, threshold: int) -> str:
        """这条根因的结论：主因 / 次因 / 低置信（见 :class:`CauseStanding`）。"""
        if cause.confidence < threshold:
            return CauseStanding.LOW
        top = self.confident(threshold)
        return CauseStanding.PRIMARY if top and top[0] is cause else CauseStanding.SECONDARY

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "causes": [cause.to_dict() for cause in self.causes],
            "reasoning": self.reasoning,
            "error": self.error,
            "source": self.source,
        }


def _confidence(value: Any) -> Optional[int]:
    """模型给的置信度 → 0–100 的整数。``85`` / ``"85"`` / ``"85%"`` / ``0.85`` 都认；认不出返回 ``None``。

    严格落在 ``(0, 1)`` 的小数按比例读（模型偶尔会给 0.85）；其余（含恰好的 1）按百分数读，
    四舍五入后夹到 0–100。
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        match = re.search(r"-?\d+(?:\.\d+)?", _text(value) or "")
        if not match:
            return None
        number = float(match.group(0))
    if 0 < number < 1:
        number *= 100
    return int(min(100, max(0, round(number))))


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 3] + "..."


def parse_convergence(parsed: Any) -> Optional[CauseConvergence]:
    """模型输出 → :class:`CauseConvergence`。**不是 dict 或 causes 不是列表 → ``None``**（按失败处理）。

    逐条校验：根因名为空、置信度认不出的条目丢掉（不猜）；类别不在六词表里记「其他」；
    同名根因只留第一条；按置信度从高到低重排（并列保持模型给的先后）后截到 :data:`MAX_CAUSES` 条。
    """
    if not isinstance(parsed, dict) or not isinstance(parsed.get("causes"), list):
        return None
    items = []
    seen = set()
    for raw in parsed["causes"]:
        if not isinstance(raw, dict):
            continue
        cause = _clip((_text(raw.get("cause")) or "").strip(), _MAX_CAUSE_CHARS)
        confidence = _confidence(raw.get("confidence"))
        if not cause or confidence is None or cause in seen:
            continue
        seen.add(cause)
        category = (_text(raw.get("category")) or "").strip()
        items.append(
            (
                cause,
                category if category in CATEGORY_VOCAB else CATEGORY_OTHER,
                confidence,
                _clip((_text(raw.get("evidence")) or "").strip(), _MAX_EVIDENCE_CHARS),
            )
        )
    items.sort(key=lambda item: -item[2])  # sort 是稳定的：并列保持模型给的先后
    causes = tuple(
        ModelCause(rank=index, cause=cause, category=category, confidence=confidence, evidence=evidence)
        for index, (cause, category, confidence, evidence) in enumerate(items[:MAX_CAUSES], 1)
    )
    reasoning = _clip((_text(parsed.get("reasoning")) or "").strip(), _MAX_REASONING_CHARS)
    return CauseConvergence(status=ConvergenceStatus.CONVERGED, causes=causes, reasoning=reasoning)


def converge_root_causes_llm(
    conclusion: Any,
    smart_conclusion: Any,
    *,
    dimensions: Optional[Mapping[str, str]] = None,
    task_type: Any = "",
    llm_client: Optional[LLMClient] = None,
) -> CauseConvergence:
    """02 根因收敛（模型载体）。**永不抛** —— 失败一律返回 :attr:`ConvergenceStatus.FAILED`。

    ``dimensions`` 是 :func:`services.decision.cause_dimensions.dimension_verdicts` 的结果（有内容的那几维）：
    非空就用 :data:`SCENE_DIMENSIONS`，**结论两字段、六维与本单问题类型 ``task_type`` 一起送**（2026-10-29 晚
    用户定三路一起用；问题类型是条目多于 5 条时的取舍依据，格式同 05 根因对齐的 ``PROBLEM_JSON``）；
    为空或 ``None`` 则走 :data:`SCENE`，``task_type`` 不进提示词，与 2026-10-29 之前逐字一样。
    ``llm_client`` 不传则取 :func:`get_llm_client`（生产路径）；测试传 fake 或整个换成桩。
    """
    source = {
        "conclusion": (_text(conclusion) or "").strip(),
        "smart_conclusion": (_text(smart_conclusion) or "").strip(),
    }
    placeholders = {"ROOT_CAUSE_JSON": json.dumps(source, ensure_ascii=False)}
    if dimensions:
        scene, origin = SCENE_DIMENSIONS, SOURCE_DIMENSIONS
        placeholders["DIMENSIONS_JSON"] = json.dumps(dict(dimensions), ensure_ascii=False)
        placeholders["PROBLEM_JSON"] = json.dumps({"task_type": (_text(task_type) or "").strip()}, ensure_ascii=False)
    elif source["conclusion"] or source["smart_conclusion"]:
        scene, origin = SCENE, SOURCE_CONCLUSION
    else:
        return CauseConvergence(status=ConvergenceStatus.NOT_CALLED)

    def _failed(message: str, exc: Optional[BaseException] = None) -> CauseConvergence:
        logger.warning(
            f"02 根因收敛{message}，退回确定性解析的根因（无置信度），04 不窄化",
            extra={"scene": scene, "error": str(exc) if exc else ""},
        )
        return CauseConvergence(
            status=ConvergenceStatus.FAILED,
            error=message if exc is None else f"{message}：{exc}",
            source=origin,
        )

    try:
        prompt = prompts.render(scene, **placeholders)
    except (PromptNotFound, PromptRenderError) as exc:
        return _failed("提示词渲染失败", exc)

    try:
        client = llm_client or get_llm_client()
        parsed, _raw_text, _attempts = client.complete_json(prompt, scene=scene)
    except (LLMError, LLMTimeout) as exc:
        return _failed("模型调用失败", exc)
    except Exception as exc:  # noqa: BLE001 - 02 坏了只退回兜底，不能把整单决策带崩
        return _failed("模型调用异常", exc)

    result = parse_convergence(parsed)
    if result is None:
        return _failed("模型输出不是约定的 JSON")
    return replace(result, source=origin)


__all__ = [
    "CATEGORY_OTHER",
    "CATEGORY_VOCAB",
    "DEFAULT_CONFIDENCE_THRESHOLD",
    "MAX_CAUSES",
    "SCENE",
    "SCENE_DIMENSIONS",
    "CauseConvergence",
    "CauseStanding",
    "ConvergenceStatus",
    "ModelCause",
    "converge_root_causes_llm",
    "parse_convergence",
]
