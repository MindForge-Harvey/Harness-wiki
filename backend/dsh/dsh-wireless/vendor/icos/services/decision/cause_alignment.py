"""决策步 05 根因对齐 —— 模型以网优专家身份判「02 收敛根因 ⟷ ICOS 方案」的对应关系（2026-10-03 业务）。

业务口径
--------
根因对齐分析的是 **02 根因收敛后的根因结果与方案之间的对应关系**，由大模型根据提示词
（``assets/cause_alignment.yaml``，scene ``root_cause_alignment``）以网优专家的身份判定：逐个方案看它
针对哪一条（或哪几条）收敛根因、还是不针对具体根因只有通用收益、还是与根因都对不上。

**影响下发**（业务 10-03，推翻 09-28「只写注记」）：判为「不一致」的方案不发（决策链原因 ``根因对齐·不一致``，
:func:`services.decision.chain.drop_by_alignment`，跑在 04 组内寻优之后、07 之前）。三条边界都是业务选定的：

* 只剔「不一致」—— 直接关联 / 次级关联 / 通用方案照发；
* **不剔到零** —— 剩下可发的全是不一致时一条不剔（同 04「全组都不关联时组内全留」）；
* **只按模型判的剔** —— 兜底对上的（``source=rule``）只注记；本单没有达到阈值的根因（根因不明）也不剔（同 04）。

剔没剔、剔了哪几个方案记在 :attr:`CauseAlignment.demotion` / :attr:`CauseAlignment.demoted`（见 :class:`Demotion`）。

在此之前 05 是确定性的四档路由（:mod:`services.decision.alignment`：初案 ``type1`` 与 02 确定性解析的
**类别**字面比对），「生成方案」裁决表的「根因」列也是按初案一级/二级原因与根因名称、类别字面对上的
（:func:`services.decision.root_cause.converged_cause_match`）—— 都不看参数本身起什么作用。两者现在退为兜底：

* 02 模型收敛没有根因（失败 / 两字段皆空 / 一条都没读出来）→ :attr:`AlignmentStatus.NOT_CALLED`，
  不调模型，调用方照旧走 ``alignment.align_root_causes``（类别四档）；
* 模型调用 / 解析失败、某个方案没判到或判得不合契约、方案数超过 :data:`MAX_PLANS` →
  那几个方案按 ``converged_cause_match`` 对上（``source`` 记 :data:`SOURCE_RULE`），展示上标明未经模型研判。

分工：模型判、代码定档
----------------------
模型只答专家问题：这个方案**针对哪几条根因**（:data:`Relation` 三选一 + 根因名）。四档关联
（直接关联 / 次级关联 / 通用方案 / 不一致，与 ``verdict.Association`` 同词）由代码按规则定
（:func:`association_for`）：针对的根因里有**主因**（02 结论为「主因」的那条）是直接关联，只针对次因或
低置信根因是次级关联。档位是规则、不交模型 —— 同 04「反例为主不选」由代码判的道理。

对齐单位是**方案**（``plan_number``），一个方案的全部参数共享一条对应关系；没有方案编号的初案按参数单列。

依赖
----
本模块 → ``cause_convergence``（02 模型收敛）、``alignment``（四档词与 :class:`AlignmentGap`）、
``root_cause``（兜底的名称 / 类别对法）、``plan_table.plan_key``。**不 import verdict**（verdict import 本模块）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, replace
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from services import prompts
from services.common.llm import LLMClient, LLMError, LLMTimeout, get_llm_client
from services.common.logging import get_logger
from services.common.text_utils import _text
from services.decision.alignment import (
    ASSOCIATION_DIRECT,
    ASSOCIATION_GENERAL,
    ASSOCIATION_INCONSISTENT,
    ASSOCIATION_SECONDARY,
    GAP_INCONSISTENT,
    GAP_NO_PLAN,
    AlignmentGap,
)
from services.decision.cause_convergence import (
    DEFAULT_CONFIDENCE_THRESHOLD,
    CauseConvergence,
    CauseStanding,
)
from services.decision.plan_table import plan_key
from services.decision.root_cause import CONVERGED_GENERIC, CONVERGED_MATCHED, converged_cause_match
from services.prompts import PromptNotFound, PromptRenderError

logger = get_logger(__name__)

#: 提示词 ``root_cause_alignment`` 的输出契约键（见 ``assets/cause_alignment.yaml``）。
_ALIGNMENT_LLM_KEYS = ("plans", "reasoning")
SCENE = "root_cause_alignment"

#: 一次调用至多喂这么多个方案，其余按兜底对上（本地库每单至多 2 个方案，留足余量）。
MAX_PLANS = 40
_MAX_REASON_CHARS = 120
_MAX_REASONING_CHARS = 300

#: 判定来源：模型判的 / 按初案一级/二级原因与根因名称、类别对上的兜底。
SOURCE_LLM = "llm"
SOURCE_RULE = "rule"


class AlignmentStatus:
    #: 模型给出了结论（个别方案没判到的按兜底补齐，``source`` 分得开）。
    ALIGNED = "aligned"
    #: 02 模型收敛没有根因可对（失败 / 两字段皆空 / 一条都没读出来），不调模型。
    NOT_CALLED = "not_called"
    #: 调用 / 渲染 / 解析失败，或没有一条可用的对应关系：全部方案按兜底对上。
    FAILED = "failed"


class Relation:
    """模型给的对应关系 —— 封闭词表，提示词里逐字列着。"""

    #: 方案的作用机理直接处置其中至少一条根因。
    TARGETED = "针对根因"
    #: 不针对任何一条具体根因，但对本单问题有通用收益。
    GENERAL = "通用收益"
    #: 与收敛根因都对不上，也看不出通用收益。
    UNRELATED = "无关"


RELATION_VOCAB: Tuple[str, ...] = (Relation.TARGETED, Relation.GENERAL, Relation.UNRELATED)


class Demotion:
    """05 对下发的影响（:attr:`CauseAlignment.demotion`）。"""

    #: 模型判的「不一致」方案本轮不发。
    APPLIED = "applied"
    #: 剩下可发的全是不一致 —— 不剔到零，全留。
    KEPT_ALL = "kept_all"
    #: 没有要剔的（没有模型判的不一致，或那几个方案 04 已经没选）。
    NONE = "none"
    #: 有模型判的不一致，但本单没有达到阈值的根因（根因不明）—— 不剔。
    ROOT_CAUSE_UNKNOWN = "root_cause_unknown"
    #: 模型没给出结论（失败 / 没调）—— 兜底对上的只注记，不剔。
    NOT_JUDGED = "not_judged"


def association_for(relation: str, causes: Sequence[str], primary: str) -> str:
    """对应关系 + 针对的根因 → 四档关联（**规则，不交模型**）。

    针对根因且其中有主因 → 直接关联；只针对次因 / 低置信根因（或本单没有主因 = 根因不明）→ 次级关联；
    通用收益 → 通用方案；无关 → 不一致（记一条不一致项，走通用路径，**不是拒绝**）。
    """
    if relation == Relation.TARGETED and causes:
        return ASSOCIATION_DIRECT if primary and primary in causes else ASSOCIATION_SECONDARY
    if relation == Relation.GENERAL:
        return ASSOCIATION_GENERAL
    return ASSOCIATION_INCONSISTENT


@dataclass(frozen=True)
class PlanAlignment:
    """一个方案（``plan_number``）与本单收敛根因的对应关系。"""

    #: 喂给模型的方案标识：方案编号；没有方案编号的初案是 ``未编号-<对齐键>``。
    plan_id: str
    plan_number: str
    plan_group_number: str
    #: ICOS 初案自己声明的一级/二级原因（``覆盖 / 弱覆盖``），只作参照。
    plan_cause: str
    #: 方案下的参数中文名（按初案先后）。
    params: Tuple[str, ...]
    #: 方案下各参数动作的对齐键（``plan_table.plan_key``）—— 决策行与裁决对象按它回查。
    keys: Tuple[str, ...]
    #: :data:`RELATION_VOCAB` 之一。
    relation: str
    #: 针对的收敛根因名（与「根因收敛」表的根因名一字不差，按收敛表先后）。只有「针对根因」才非空。
    causes: Tuple[str, ...]
    #: 四档关联（:func:`association_for`）。
    association: str
    reason: str = ""
    #: :data:`SOURCE_LLM` / :data:`SOURCE_RULE`。
    source: str = SOURCE_LLM

    def to_dict(self) -> Dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "plan_number": self.plan_number,
            "plan_group_number": self.plan_group_number,
            "plan_cause": self.plan_cause,
            "params": list(self.params),
            "keys": list(self.keys),
            "relation": self.relation,
            "causes": list(self.causes),
            "association": self.association,
            "reason": self.reason,
            "source": self.source,
        }


@dataclass(frozen=True)
class CauseAlignment:
    """一单一轮的 05 根因对齐结果。"""

    status: str
    plans: Tuple[PlanAlignment, ...] = ()
    #: 02 结论为「主因」的那条根因名；空 = 没有达到阈值的根因（根因不明）。
    primary: str = ""
    #: 达到采信阈值、却没有任何方案针对的根因（有根因无方案），按收敛表先后。
    uncovered: Tuple[str, ...] = ()
    reasoning: str = ""
    error: str = ""
    #: 对下发的影响（:class:`Demotion`）。空 = 还没过决策链（决策流水线在 05 剔完后填）。
    demotion: str = ""
    #: 本轮因「根因对齐·不一致」不发的方案（``plan_id``）。
    demoted: Tuple[str, ...] = ()

    @property
    def usable(self) -> bool:
        """有逐方案的对应关系可用（模型判的或兜底的）。``False`` = 调用方退回类别四档。"""
        return bool(self.plans)

    def plan_of(self, key: str) -> Optional[PlanAlignment]:
        return next((plan for plan in self.plans if key in plan.keys), None)

    def associations(self) -> Dict[str, str]:
        """``对齐键 → 四档``。"""
        return {key: plan.association for plan in self.plans for key in plan.keys}

    def plan_demotions(self) -> Tuple[str, Dict[str, str]]:
        """要交给决策链剔除的动作：``(Demotion, {对齐键: 理由})``。

        只有**模型判的**「不一致」、且本单有采信根因（有主因）才剔；「不剔到零」要看决策链里还剩什么，
        由 :func:`services.decision.chain.drop_by_alignment` 判。
        """
        if self.status != AlignmentStatus.ALIGNED:
            return Demotion.NOT_JUDGED, {}
        targets = [
            plan for plan in self.plans
            if plan.association == ASSOCIATION_INCONSISTENT and plan.source == SOURCE_LLM
        ]
        if not targets:
            return Demotion.NONE, {}
        if not self.primary:
            return Demotion.ROOT_CAUSE_UNKNOWN, {}
        return Demotion.APPLIED, {
            key: plan.reason or "与本单收敛根因都不对应" for plan in targets for key in plan.keys
        }

    def with_demotion(self, demotion: str, dropped_keys: Sequence[str] = ()) -> "CauseAlignment":
        """记下决策链实际剔了什么：被剔的动作按对齐键回到方案。"""
        dropped = set(dropped_keys)
        return replace(
            self,
            demotion=demotion,
            demoted=tuple(plan.plan_id for plan in self.plans if dropped & set(plan.keys)),
        )

    def gaps(self) -> Tuple[AlignmentGap, ...]:
        """「有根因无方案」（主因先列）+ 「不一致项」—— 裁决对象的 ``cause_gaps``。"""
        out: List[AlignmentGap] = [
            AlignmentGap(
                kind=GAP_NO_PLAN,
                cause=cause,
                detail=f"收敛出「{cause}」但没有方案针对它",
                is_primary=cause == self.primary,
            )
            for cause in sorted(self.uncovered, key=lambda name: name != self.primary)
        ]
        out.extend(
            AlignmentGap(
                kind=GAP_INCONSISTENT,
                cause=plan.plan_cause or plan.plan_id,
                detail=f"方案 {plan.plan_id} 与收敛根因不对应" + (f"：{plan.reason}" if plan.reason else ""),
            )
            for plan in self.plans
            if plan.association == ASSOCIATION_INCONSISTENT
        )
        return tuple(out)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "primary": self.primary,
            "plans": [plan.to_dict() for plan in self.plans],
            "uncovered": list(self.uncovered),
            "llm_plan_count": sum(1 for plan in self.plans if plan.source == SOURCE_LLM),
            "rule_plan_count": sum(1 for plan in self.plans if plan.source == SOURCE_RULE),
            "reasoning": self.reasoning,
            "error": self.error,
            "demotion": self.demotion,
            "demoted": list(self.demoted),
        }


# --------------------------------------------------------------------------- #
# 方案清单
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class _Unit:
    """一个待对齐的方案：同一 ``plan_number`` 的初案行（没有编号的单列）。"""

    plan_id: str
    rows: Tuple[Mapping[str, Any], ...]
    keys: Tuple[str, ...]

    @property
    def head(self) -> Mapping[str, Any]:
        return self.rows[0]


def _units(plans: Sequence[Mapping[str, Any]]) -> List[_Unit]:
    """初案 → 方案清单（按初案先后）。算不出对齐键的行（执行编号与参数名都缺）不进来 —— 挂不上任何动作。"""
    grouped: Dict[str, List[Mapping[str, Any]]] = {}
    keys: Dict[str, List[str]] = {}
    order: List[str] = []
    for plan in plans or []:
        if not isinstance(plan, Mapping):
            continue
        key = plan_key(plan.get("execution_id"), plan.get("parachinname"))
        if not key:
            continue
        plan_id = _text(plan.get("plan_number")) or f"未编号-{key}"
        if plan_id not in grouped:
            grouped[plan_id], keys[plan_id] = [], []
            order.append(plan_id)
        grouped[plan_id].append(plan)
        if key not in keys[plan_id]:
            keys[plan_id].append(key)
    return [_Unit(plan_id=pid, rows=tuple(grouped[pid]), keys=tuple(keys[pid])) for pid in order]


def _plan_cause(row: Mapping[str, Any]) -> str:
    level1, level2 = _text(row.get("type1")), _text(row.get("type2"))
    return f"{level1} / {level2}" if level1 and level2 else level1 or level2


def _plans_context(units: Sequence[_Unit]) -> List[Dict[str, Any]]:
    """喂给模型的方案清单。不带裁决结果 —— 对应关系与下不下发无关，带上会诱导模型按下场倒推。"""
    return [
        {
            "plan_id": unit.plan_id,
            "plan_group_number": _text(unit.head.get("plan_group_number")),
            "group_name": _text(unit.head.get("type2")),
            "icos_category": _text(unit.head.get("type1")),
            "operate": _text(unit.head.get("operate")),
            "params": [
                {
                    "parachinname": _text(row.get("parachinname")),
                    "f_para": _text(row.get("f_para")),
                    "b_para": _text(row.get("b_para")),
                }
                for row in unit.rows
            ],
        }
        for unit in units
    ]


def _alignment(
    unit: _Unit, relation: str, causes: Sequence[str], primary: str, reason: str, source: str
) -> PlanAlignment:
    head = unit.head
    return PlanAlignment(
        plan_id=unit.plan_id,
        plan_number=_text(head.get("plan_number")),
        plan_group_number=_text(head.get("plan_group_number")),
        plan_cause=_plan_cause(head),
        params=tuple(dict.fromkeys(_text(row.get("parachinname")) for row in unit.rows if _text(row.get("parachinname")))),
        keys=unit.keys,
        relation=relation,
        causes=tuple(causes),
        association=association_for(relation, causes, primary),
        reason=reason,
        source=source,
    )


def _rule_alignment(unit: _Unit, convergence: CauseConvergence, primary: str) -> PlanAlignment:
    """兜底：初案一级/二级原因与收敛根因的名称、类别对上（``root_cause.converged_cause_match``）。"""
    causes = [{"rank": c.rank, "cause": c.cause, "level1": c.category} for c in convergence.causes]
    names = {c.rank: c.cause for c in convergence.causes}
    match = converged_cause_match(dict(unit.head), causes)
    matched = [names[rank] for rank in match["ranks"] if rank in names]
    plan_cause = match["plan_cause"] or "未声明"
    if match["status"] == CONVERGED_MATCHED and matched:
        relation, reason = Relation.TARGETED, f"按初案原因「{plan_cause}」与根因名称或类别对上"
    elif match["status"] == CONVERGED_GENERIC:
        relation, reason = Relation.GENERAL, f"初案原因「{plan_cause}」为参数通用方案"
    else:
        relation, reason = Relation.UNRELATED, f"初案原因「{plan_cause}」与收敛根因的名称、类别都对不上"
    return _alignment(unit, relation, matched if relation == Relation.TARGETED else (), primary, reason, SOURCE_RULE)


def _primary(convergence: CauseConvergence, threshold: int) -> str:
    return next(
        (c.cause for c in convergence.causes if convergence.standing(c, threshold) == CauseStanding.PRIMARY), ""
    )


def _uncovered(convergence: CauseConvergence, threshold: int, plans: Sequence[PlanAlignment]) -> Tuple[str, ...]:
    covered = {cause for plan in plans for cause in plan.causes}
    return tuple(c.cause for c in convergence.confident(threshold) if c.cause not in covered)


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 3] + "..."


def parse_alignment(
    parsed: Any, units: Sequence[_Unit], known_causes: Sequence[str], primary: str
) -> Optional[Tuple[Dict[str, PlanAlignment], str]]:
    """模型输出 → ``({plan_id: PlanAlignment}, reasoning)``。**形状不对（非 dict / plans 非列表）→ ``None``**。

    逐条校验，不合契约的条目丢掉（那个方案由调用方按兜底对上）：plan_id 不在本批里、relation 不在词表里、
    「针对根因」却一条已知根因都没点名；同一 plan_id 只认第一条。根因名只认收敛表里有的（去掉首尾空白后
    一字不差），按收敛表先后排；「通用收益 / 无关」带了根因名的一律清掉 —— 档位只看 relation。
    """
    if not isinstance(parsed, dict) or not isinstance(parsed.get("plans"), list):
        return None
    by_id = {unit.plan_id: unit for unit in units}
    out: Dict[str, PlanAlignment] = {}
    for raw in parsed["plans"]:
        if not isinstance(raw, dict):
            continue
        plan_id = (_text(raw.get("plan_id")) or "").strip()
        relation = (_text(raw.get("relation")) or "").strip()
        unit = by_id.get(plan_id)
        if unit is None or plan_id in out or relation not in RELATION_VOCAB:
            continue
        named = {(_text(item) or "").strip() for item in raw.get("causes") or [] if _text(item)}
        causes = [name for name in known_causes if name in named] if relation == Relation.TARGETED else []
        if relation == Relation.TARGETED and not causes:
            continue
        reason = _clip((_text(raw.get("reason")) or "").strip(), _MAX_REASON_CHARS)
        out[plan_id] = _alignment(unit, relation, causes, primary, reason, SOURCE_LLM)
    reasoning = _clip((_text(parsed.get("reasoning")) or "").strip(), _MAX_REASONING_CHARS)
    return out, reasoning


def align_root_causes_llm(
    convergence: Optional[CauseConvergence],
    plans: Sequence[Mapping[str, Any]],
    *,
    task_type: Any = "",
    threshold: int = DEFAULT_CONFIDENCE_THRESHOLD,
    llm_client: Optional[LLMClient] = None,
) -> CauseAlignment:
    """05 根因对齐（模型载体）。**永不抛** —— 失败一律按兜底对上并记 :attr:`AlignmentStatus.FAILED`。

    ``convergence`` 是 02 模型收敛的结果；没收敛成功或一条根因都没有 → :attr:`AlignmentStatus.NOT_CALLED`
    （空结果，调用方退回类别四档）。``llm_client`` 不传则取 :func:`get_llm_client`（生产路径）；测试传 fake。
    """
    if convergence is None or not convergence.converged or not convergence.causes:
        return CauseAlignment(status=AlignmentStatus.NOT_CALLED)
    units = _units(plans)
    if not units:
        return CauseAlignment(status=AlignmentStatus.NOT_CALLED, error="没有可对齐的初案（执行编号与参数名都缺）")
    primary = _primary(convergence, threshold)
    asked, overflow = units[:MAX_PLANS], units[MAX_PLANS:]

    def _finish(status: str, judged: Dict[str, PlanAlignment], reasoning: str = "", error: str = "") -> CauseAlignment:
        result = tuple(judged.get(unit.plan_id) or _rule_alignment(unit, convergence, primary) for unit in units)
        return CauseAlignment(
            status=status,
            plans=result,
            primary=primary,
            uncovered=_uncovered(convergence, threshold, result),
            reasoning=reasoning,
            error=error,
        )

    def _failed(message: str, exc: Optional[BaseException] = None) -> CauseAlignment:
        logger.warning(
            f"05 根因对齐{message}，按初案一级/二级原因与根因名称、类别对上（只注记，不剔方案）",
            extra={"scene": SCENE, "error": str(exc) if exc else ""},
        )
        return _finish(AlignmentStatus.FAILED, {}, error=message if exc is None else f"{message}：{exc}")

    root_cause = {
        "threshold": threshold,
        "causes": [
            {
                "cause": c.cause,
                "category": c.category,
                "confidence": c.confidence,
                "standing": convergence.standing(c, threshold),
                "evidence": c.evidence,
            }
            for c in convergence.causes
        ],
    }
    try:
        prompt = prompts.render(
            SCENE,
            ROOT_CAUSE_JSON=json.dumps(root_cause, ensure_ascii=False),
            PROBLEM_JSON=json.dumps({"task_type": _text(task_type)}, ensure_ascii=False),
            PLANS_JSON=json.dumps(_plans_context(asked), ensure_ascii=False),
        )
    except (PromptNotFound, PromptRenderError) as exc:
        return _failed("提示词渲染失败", exc)

    try:
        client = llm_client or get_llm_client()
        parsed, _raw_text, _attempts = client.complete_json(prompt, scene=SCENE)
    except (LLMError, LLMTimeout) as exc:
        return _failed("模型调用失败", exc)
    except Exception as exc:  # noqa: BLE001 - 模型坏了只退回兜底（不剔方案），不能把整单决策带崩
        return _failed("模型调用异常", exc)

    result = parse_alignment(parsed, asked, [c.cause for c in convergence.causes], primary)
    if result is None:
        return _failed("模型输出不是约定的 JSON")
    judged, reasoning = result
    if not judged:
        return _failed("模型输出没有一条可用的对应关系")
    missing = [unit.plan_id for unit in asked if unit.plan_id not in judged]
    error = ""
    if missing or overflow:
        error = "；".join(
            part
            for part in (
                f"模型没判到（或判得不合契约）的方案按初案原因对上：{'、'.join(missing)}" if missing else "",
                f"方案数超过 {MAX_PLANS}，其余 {len(overflow)} 个按初案原因对上" if overflow else "",
            )
            if part
        )
    return _finish(AlignmentStatus.ALIGNED, judged, reasoning, error)


__all__ = [
    "MAX_PLANS",
    "RELATION_VOCAB",
    "SCENE",
    "SOURCE_LLM",
    "SOURCE_RULE",
    "AlignmentStatus",
    "CauseAlignment",
    "Demotion",
    "PlanAlignment",
    "Relation",
    "align_root_causes_llm",
    "association_for",
    "parse_alignment",
]
