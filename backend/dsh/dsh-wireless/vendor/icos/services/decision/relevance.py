"""决策步 04 组内寻优 —— 「方案与根因的关联性」判定（差额清单 ②）。

业务口径（2026-09-21 Q1 + 二次回话）：每个方案组里**按方案与根因的关联性**
寻优；关联度并列的方案**都要**（与 Q4 不排序一致）。判据今天卡 P1.5
（根因类目 ⟷ 方案组映射表，业务侧未排期）。

两段式解法（2026-09-22 起，业务侧确认）
----------------------------------------
* **Phase-1（本阶段）**：LLM 作为网优专家，通过提示词给出关联判定。
  **恒做、不配开关**（2026-09-24 业务：「关联判定是一定要做的」）—— 每张单的每个
  多方案组调一次。判定结果落 ``CandidatePlan.relevance``，决策链的 04 组内寻优按它窄化
  （``services.decision.chain.optimal_plans``）—— 2026-09-25 合规链删除后决策链是唯一裁决者，
  这就是真正的组内寻优，直接决定发不发。
* **Phase-2（等映射表到位）**：``relevance_of`` 换成「查映射表 + LLM 兜底」
  的实现，``candidate_set`` 一行不动。切换是行为变更，先拿同一批工单对照前后选中的方案再切。

硬约束
------
* **不许排序**：业务口径「寻优不是评分排序」。判定输出是「与根因最关联的
  方案集合（并列全保留）」，不是带置信度的排序。提示词必须锁这个输出 schema。
* **bypass = 组内全保留**：LLM 失败 / 解析失败 / 未传 callable 时，所有方案
  都视作「保留」（fail-open，与合规链 ``llm_call_bypass`` 同口径）。意味着
  Phase-1 的判定**只做窄化、不做扩展**。
* **纯函数边界**：本模块只定义契约 + 纯函数助手；LLM 调用本体由调用方
  （``decision_service``）注入的 callable 承载，``candidate_set`` 仍是无 IO
  叶子。**LLM 失败的 try/except 不在 candidate_set 里**——由 LLM 兜底外壳
  捕获并返回 ``None``（= bypass），candidate_set 看到的永远是「判好了」或
  「没判（None）」两种状态。

根因入参
--------
关联判定的根因是 **02 根因收敛（模型载体）里置信度达到阈值的那几条**（:class:`RootCauseBrief`，
见 :mod:`services.decision.cause_convergence`；阈值 ``order_loop.decision.root_cause.confidence_threshold``，
默认 40）。2026-09-24 业务：收敛独立成 02、每单一次，**04 直接用它，不再每组各收敛一遍**；
置信度参与决策 —— 只有高置信根因才是寻优依据。

演进：09-24 上午这里还是「只给原文、由模型每组自己收敛」（``root_cause`` 由关联判定输出）；
同一单几个组可能收敛出几种说法，也没有置信度。现在根因由 02 给定，:attr:`PlanRelevance.root_cause`
记的是送进来的那几条（带置信度），关联判定只判「方案是否直接针对其中任一条」。

**没有高置信根因**（02 收敛失败、两个字段都空、或全部低于阈值）= 根因不明：不调模型、组内全留
（与关联判定失败同一个结果；业务 09-17：两字段皆空的工单全部初案按通用方案判）。

案例证据（2026-09-27 起）
------------------------
案例知识库开着且 ``order_loop.case_library.relevance_evidence`` 为真时，决策服务在初案行上挂
:data:`CASE_BRIEF_KEY`（04 案例参考算出的该参数同类先例统计，见 :mod:`services.decision.case_evidence`），
这里把它随参数一起喂给模型，并在提示词里加一段「案例怎么用」（``CASE_RULES``）。**输出契约不变**：
仍是「相关 / 不相关」二态、并列全留、只窄化不扩展。这会改变选中哪些方案（业务 2026-09-27 选定），
与 09-21「寻优不做评分排序」口径有出入，所以留了开关。

**模型只判与根因的关联**（拿不准时可参考支撑度列入）；「反例为主不选」**由代码判**（:func:`apply_case_veto`，
2026-09-27 实测后改）：同一份提示词连调三次，模型一次剔除、两次保留，还把「组内唯一相关才保留」读成
「相关方案之一就保留」—— 交给模型就是抛硬币。代码口径：一个方案的**全部参数**都以恶化为主（有同类先例、
成功比例低于中档门槛），且同组还有别的方案被判相关、又不是全部反例为主，才把它改判为不选，
``source`` 记 :data:`CASE_SOURCE`，理由写明依据的案例与成败。只有它一个相关时照留（fail-open）。

理由里引用的 ［案例:编号］ 只认喂进去的那几个（:func:`~services.decision.case_evidence.strip_unknown_citations`），
模型编的编号删掉；:attr:`PlanRelevance.cited_cases` 按方案各记各的（理由是整组一段，只留**本方案参数**的引用）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Sequence

from services import prompts
from services.common.llm import LLMClient, LLMError, LLMTimeout, get_llm_client
from services.common.logging import get_logger
from services.common.text_utils import _text
from services.decision.case_evidence import cited_case_ids, strip_unknown_citations
from services.decision.cause_convergence import ModelCause
from services.prompts import PromptNotFound, PromptRenderError

logger = get_logger(__name__)

#: 提示词 ``plan_relevance`` 的输出契约键（见 ``assets/relevance.yaml``）。
_RELEVANCE_LLM_KEYS = ("relevant_plans", "reasoning")

#: 「反例为主不选」由代码改判时 :attr:`PlanRelevance.source` 的取值（另两个是 ``llm`` / ``mapping``）。
CASE_SOURCE = "case"

#: 判定理由的长度上限：喂了案例证据时放宽 —— 200 字常把「案例怎么影响了判断」那一句截掉。
REASON_LIMIT = 200
REASON_LIMIT_WITH_CASES = 400

#: 初案行上挂案例证据的键（:meth:`ActionCaseBasis.brief` 的产出）。由决策服务按开关挂上，
#: 本模块只读 —— 行上没有它就是没开案例证据，提示词里不出现案例那一段。
CASE_BRIEF_KEY = "_case_brief"

#: 喂了案例证据时插进提示词的规则段（``CASE_RULES`` 占位符）。没喂时是空串。
CASE_RULES_TEXT = (
    "--- 同类案例证据（来自案例知识库，按规则统计，不是你的判断）\n"
    "方案清单里的参数可能带 cases 字段：同参数、同二级原因、同问题类型、与本单**同方向**调整的历史案例统计 ——\n"
    "support（案例支撑度：高 / 中 / 低 / 无先例）、cases（同类先例数）、success / fail（其中改善 / 恶化）、\n"
    "opposite（反向调整的先例数，不进支撑度）、negative_dominant（反例为主）、refs（可引用的案例编号）。\n"
    "使用规则：\n"
    "a. 与根因的关联仍是主判据，案例只是佐证，不能拿案例替代根因判断；\n"
    "b. 拿不准是否与根因相关、但同类案例支撑度为「中」或「高」的方案 → 列入；\n"
    "c. 同类案例以恶化为主（negative_dominant 为 true）**不是你判断关联的依据**：照常只判它与根因的关联。"
    "反例为主的方案要不要剔除，由系统在你判完之后按规则处理，你不要替系统剔除；\n"
    "d. 「无先例」不是不列入的理由 —— 案例库是加分项，不是门槛；\n"
    "e. reasoning 里用到案例时，按 ［案例:编号］ 写出依据的案例，编号只能取自 refs，不得编造。\n"
)


@dataclass(frozen=True)
class PlanRelevance:
    """一条方案（``plan_number``）与本单根因的关联判定。

    挂在 :attr:`CandidatePlan.relevance`，决策链 04 组内寻优按 :attr:`relevant` 窄化
    （与根因关联的方案并列都留、全组都不关联时全留），落进候选集与裁决对象。
    """

    #: 是否与本单根因关联。``False`` = 判定不关联；``True`` = 关联或并列保留。
    relevant: bool
    #: 判据来源。Phase-1 = ``"llm"``，Phase-2 命中映射表 = ``"mapping"``。
    #: **写进类型而不是靠自觉**（同 ``rule_assessment`` 的 ``feasibility_source``）
    #: —— 下游不许把 LLM 判定当代码事实用。
    source: str = "llm"
    reason: str = ""
    #: 判关联时送进来的根因（02 收敛里达到阈值的那几条，带置信度，整组一份、每个方案都带），
    #: 形如「过覆盖（88%）、邻区故障影响切换（70%）」。判的是「与**它们**的关联」。
    #: 09-24 上午之前的落库行里，这一格是关联判定自己从原文收敛的一句话（没有置信度）。
    root_cause: str = ""
    #: 这次判定喂了案例证据（2026-09-27 起）。
    case_informed: bool = False
    #: 判定理由里引用的案例编号（只留喂进去的那几个）。
    cited_cases: "tuple[str, ...]" = ()

    def to_dict(self) -> "dict[str, Any]":
        return {
            "relevant": self.relevant,
            "source": self.source,
            "reason": self.reason,
            "root_cause": self.root_cause,
            "case_informed": self.case_informed,
            "cited_cases": list(self.cited_cases),
        }


@dataclass(frozen=True)
class RootCauseBrief:
    """关联判定的根因输入：02 收敛里**置信度达到阈值**的根因（见模块文档）。调用方负责按阈值筛好。"""

    causes: "tuple[ModelCause, ...]" = ()

    @property
    def judgeable(self) -> bool:
        """有高置信根因才判。没有 = 根因不明，组内全留。"""
        return bool(self.causes)

    @property
    def label(self) -> str:
        """落进 :attr:`PlanRelevance.root_cause` 的那一句。"""
        return "、".join(f"{cause.cause}（{cause.confidence}%）" for cause in self.causes)

    def to_dict(self) -> "dict[str, Any]":
        return {
            "causes": [
                {
                    "cause": cause.cause,
                    "category": cause.category,
                    "confidence": cause.confidence,
                    "evidence": cause.evidence,
                }
                for cause in self.causes
            ]
        }


#: callable 契约。入参：本组初案行 + 本单根因原文（:class:`RootCauseBrief`，可为 ``None``）。
#: 出参：``plan_number → PlanRelevance`` 的映射；``None`` = 整组 bypass（全保留）。
#:
#: 之所以按「**整组一次**」而不是「逐方案」：LLM 要在同组方案的**对比上下文**里
#: 判关联，逐条调既贵又会让「并列」判定丢失（看不到别的方案就无法说并列）。
#: 单方案组由 ``build_candidate_set`` 直接跳过，根本不调。
RelevanceJudge = Callable[
    [Sequence[Mapping[str, Any]], "Optional[RootCauseBrief]"],
    "Optional[Mapping[str, PlanRelevance]]",
]


def resolve_plan_relevance(
    plan_number: Optional[str],
    judgment: Optional[Mapping[str, PlanRelevance]],
) -> Optional[PlanRelevance]:
    """把判定映射落到一条方案上。

    没判到（``judgment`` 为 ``None``、或该 ``plan_number`` 不在映射里、或
    ``plan_number`` 本身为 ``None``）就返回 ``None`` —— 由
    :attr:`CandidatePlan.relevant` 解释为「保留」（fail-open）。
    """
    if not judgment or plan_number is None:
        return None
    return judgment.get(plan_number)


def _build_plans_context(
    rows: Sequence[Mapping[str, Any]],
) -> "list[dict[str, Any]]":
    """把一组的初案行压成喂给 LLM 的方案清单。

    **无 ``plan_number`` 的方案不喂** —— 它们由 :func:`resolve_plan_relevance`
    自动保留（映射里查不到 → ``None`` → ``relevant=True``）。LLM 只在有编号的
    方案之间做对比判定。
    """
    plans: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for row in rows:
        number = (_text(row.get("plan_number")) or "").strip()
        if not number:
            continue
        if number not in plans:
            plans[number] = {
                "plan_number": number,
                "type2": _text(row.get("type2")) or "",
                "params": [],
            }
            order.append(number)
        param = {
            "parachinname": _text(row.get("parachinname")) or "",
            "b_para": _text(row.get("b_para")) or "",
            "f_para": _text(row.get("f_para")) or "",
        }
        brief = row.get(CASE_BRIEF_KEY)
        if isinstance(brief, Mapping):
            param["cases"] = dict(brief)
        plans[number]["params"].append(param)
    return [plans[name] for name in order]


def _case_refs(plans_ctx: "list[dict[str, Any]]") -> "tuple[bool, set[str], dict[str, set[str]]]":
    """喂进去的案例证据：有没有、可引用的编号有哪些（整组 / 按方案）。"""
    informed = False
    refs: "set[str]" = set()
    by_plan: "dict[str, set[str]]" = {}
    for plan in plans_ctx:
        mine = by_plan.setdefault(_text(plan.get("plan_number")), set())
        for param in plan["params"]:
            brief = param.get("cases")
            if isinstance(brief, Mapping):
                informed = True
                ids = {_text(item) for item in brief.get("refs") or () if _text(item)}
                refs.update(ids)
                mine.update(ids)
    return informed, refs, by_plan


def _parse_relevance(
    parsed: Any,
    group_plan_numbers: Sequence[str],
    root_cause: str = "",
    *,
    case_informed: bool = False,
    case_refs: "Optional[set[str]]" = None,
    plan_refs: "Optional[Mapping[str, set[str]]]" = None,
) -> "Optional[dict[str, PlanRelevance]]":
    """把 LLM 输出落到 ``plan_number → PlanRelevance`` 映射。

    * 非 dict / ``relevant_plans`` 非列表 → ``None``（bypass，没判）。
    * **空列表**（模型说「全组都不直接相关」）→ 组内每个方案都记 ``relevant=False`` 并带上理由。
      **这是判了，不是没判** —— 2026-09-24 之前它被当成 bypass 记 ``None``，于是「模型认定这组
      与根因无关」和「调用失败」在库里长得一模一样。组内全留（不窄化到零）由 04 寻优负责
      （``services.decision.chain.optimal_plans``：全判不关联时全留 —— 低关联转通用路径、不是拒绝）。
    * 幻觉出的 plan_number（不在本组里）忽略。
    * 命中映射表 / LLM 给出的集合 = ``relevant=True``，组内其余 = ``False``。
    """
    if not isinstance(parsed, dict):
        return None
    raw_list = parsed.get("relevant_plans")
    if not isinstance(raw_list, list):
        return None
    relevant_set: set[str] = set()
    for item in raw_list:
        name = _text(item)
        if name:
            relevant_set.add(name)
    reasoning = _text(parsed.get("reasoning")) or ""
    reasoning, invented = strip_unknown_citations(reasoning, case_refs or ())
    if invented:
        logger.warning("关联判定理由里有编造的案例编号，已删去", extra={"invented": list(invented)})
    limit = REASON_LIMIT_WITH_CASES if case_informed else REASON_LIMIT
    if len(reasoning) > limit:
        reasoning = reasoning[: limit - 3] + "..."
    cited = cited_case_ids(reasoning)
    plan_refs = plan_refs or {}
    return {
        number: PlanRelevance(
            relevant=(number in relevant_set),
            source="llm",
            reason=reasoning,
            root_cause=root_cause,
            case_informed=case_informed,
            # 理由是整组一段：只留本方案参数自己的引用，不然组内每个方案看起来都引用了同一批案例。
            cited_cases=tuple(case_id for case_id in cited if case_id in plan_refs.get(number, ())),
        )
        for number in group_plan_numbers
    }


def _plan_negative_briefs(plan: Mapping[str, Any]) -> "Optional[list[Mapping[str, Any]]]":
    """方案的**全部参数**都以恶化为主时返回它们的证据，否则 ``None``（没有先例的参数不算反例为主）。"""
    params = plan.get("params") or []
    briefs = [param.get("cases") for param in params]
    if params and all(isinstance(brief, Mapping) and brief.get("negative_dominant") for brief in briefs):
        return [dict(brief, parachinname=param.get("parachinname")) for param, brief in zip(params, briefs)]
    return None


def apply_case_veto(
    judgment: "Mapping[str, PlanRelevance]",
    plans_ctx: "Sequence[Mapping[str, Any]]",
) -> "dict[str, PlanRelevance]":
    """**「反例为主不选」—— 代码判，不交模型**（2026-09-27 实测后改，见模块文档）。

    模型判为相关、但全部参数的同类案例都以恶化为主的方案，在同组另有「判为相关且不是全部反例为主」的方案时
    改判为不相关（``source=case``）；同组没有这样的方案（它是唯一相关的）时照留 —— 只窄化、不窄化到零。
    纯函数：同一份判定 + 同一份案例统计永远得出同一个结果。
    """
    out = dict(judgment)
    negative = {
        _text(plan.get("plan_number")): briefs
        for plan in plans_ctx
        if (briefs := _plan_negative_briefs(plan)) is not None
    }
    keepers = [
        number for number, rel in judgment.items() if rel.relevant and number not in negative
    ]
    if not keepers or not negative:
        return out
    for number, briefs in negative.items():
        rel = judgment.get(number)
        if rel is None or not rel.relevant:
            continue
        refs = tuple(dict.fromkeys(ref for brief in briefs for ref in brief.get("refs") or ()))
        evidence = "；".join(
            f"{brief.get('parachinname')} 同类 {brief.get('cases')} 例（改善 {brief.get('success')} / 恶化 {brief.get('fail')}）"
            for brief in briefs
        )
        cite = "".join(f"［案例:{ref}］" for ref in refs[:2])
        out[number] = PlanRelevance(
            relevant=False,
            source=CASE_SOURCE,
            reason=(
                f"同类案例以恶化为主：{evidence}{cite}；同组方案 {'、'.join(keepers)} 与根因相关且不是反例为主，"
                f"按规则不选本方案（模型原判：与根因相关）。"
            ),
            root_cause=rel.root_cause,
            case_informed=True,
            cited_cases=refs,
        )
    return out


def judge_relevance_llm(
    rows: Sequence[Mapping[str, Any]],
    root_cause: "Optional[RootCauseBrief]",
    *,
    llm_client: Optional[LLMClient] = None,
) -> "Optional[Mapping[str, PlanRelevance]]":
    """Phase-1 LLM 关联判定（实现 :data:`RelevanceJudge` 契约）。

    **失败 / 解析失败 / 没有高置信根因 / 组内无带编号方案 → 返回 ``None``（bypass，
    组内全保留）**。这是 fail-open：只窄化、不扩展，绝不让关联判定把本来该发的
    方案挡掉。调用方（``decision_service``）把它包成 ``relevance_of`` 注入
    :func:`build_candidate_set`。

    ``llm_client`` 不传则取 :func:`get_llm_client`（生产路径）；测试传 fake。
    """
    if root_cause is None or not rows:
        return None
    # 没有高置信根因（02 失败、两字段皆空、或全部低于阈值）：根因不明，问了也只是让模型现编。
    if not getattr(root_cause, "judgeable", False):
        return None
    plans_ctx = _build_plans_context(rows)
    if not plans_ctx:
        return None  # 组内全无 plan_number → 没东西可判，bypass
    group_plan_numbers = [p["plan_number"] for p in plans_ctx]
    group_name = plans_ctx[0].get("type2") or ""
    root_cause_ctx = root_cause.to_dict()
    case_informed, case_refs, plan_refs = _case_refs(plans_ctx)

    try:
        prompt = prompts.render(
            "plan_relevance",
            ROOT_CAUSE_JSON=json.dumps(root_cause_ctx, ensure_ascii=False),
            GROUP_NAME=group_name,
            PLANS_JSON=json.dumps(plans_ctx, ensure_ascii=False),
            CASE_RULES=CASE_RULES_TEXT if case_informed else "",
        )
    except (PromptNotFound, PromptRenderError) as exc:
        logger.warning(
            "关联判定提示词渲染失败，整组 bypass",
            extra={"scene": "plan_relevance", "error": str(exc)},
        )
        return None

    client = llm_client or get_llm_client()
    try:
        parsed, _raw_text, _attempts = client.complete_json(
            prompt, scene="plan_relevance"
        )
    except (LLMError, LLMTimeout) as exc:
        logger.warning(
            "关联判定 LLM 调用失败，整组 bypass",
            extra={"scene": "plan_relevance", "error": str(exc)},
        )
        return None
    except Exception as exc:  # noqa: BLE001 - bypass 路径绝不能把已经判完的决策带崩
        logger.warning(
            "关联判定 LLM 异常，整组 bypass",
            extra={"scene": "plan_relevance", "error": str(exc)},
        )
        return None

    if parsed is None:
        logger.warning(
            "关联判定 LLM 输出无法解析为 JSON，整组 bypass",
            extra={"scene": "plan_relevance"},
        )
        return None
    judgment = _parse_relevance(
        parsed, group_plan_numbers, root_cause.label,
        case_informed=case_informed, case_refs=case_refs, plan_refs=plan_refs,
    )
    if judgment is None or not case_informed:
        return judgment
    return apply_case_veto(judgment, plans_ctx)


__all__ = [
    "CASE_BRIEF_KEY",
    "CASE_SOURCE",
    "apply_case_veto",
    "CASE_RULES_TEXT",
    "PlanRelevance",
    "RootCauseBrief",
    "RelevanceJudge",
    "judge_relevance_llm",
    "resolve_plan_relevance",
]
