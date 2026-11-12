"""决策步 04「案例参考」—— 本单每条候选参数的同类案例、成败统计与**案例支撑度**。纯函数。

案例知识库（方案 2b′，2026-09-27 起）把「以前同类问题上这么调过没有、调了多少、效果好不好」
变成可计数的事实：一个案例是一张工单一轮的一套处置（人工精选 / 自闭环回灌），一条动作是一个参数
从多少调到多少；案例的评估结论（改善 / 通过 / 恶化 ……）由同案动作共享。

本模块只做计算：输入是**已归一**的案例（:class:`CaseFact`）与本单候选（:class:`ActionQuery`），
输出挂到决策轨迹、裁决对象与 04 关联判定提示词上的证据（:class:`CaseEvidence`）。
**不读库、不读配置、不调模型** —— 取数与归一在 ``services.cases``，门槛由调用方从配置折成
:class:`EvidencePolicy` 传进来。所以同一份案例集合永远得出同一个档位，可复核。

口径（业务 2026-09-24 对齐清单 + 09-27 拍板）
-------------------------------------------
* **同类 = 同参数 + 同二级原因 + 同问题类型**（``param_key``、``cause2_key``、``problem_key`` 都相等；
  问题类型 2026-10-20 用户定加入，之前只比前两项）。一级原因相同不算同类 ——
  「覆盖」底下弱覆盖与过覆盖对同一参数的调整方向恰好相反，混在一起统计会互相抵消；问题类型不同
  （如「宏站弱覆盖小区」与「5G低用户上行速率」）要改善的指标不同，同一参数同样调法的成败不能互相佐证。
  本单或案例缺问题类型就判不了同类。三项不全相同的案例既不进计数、也不被引用。
* **引用与计数同一口径**（2026-10-20 用户定）：每条候选的可引用案例只从计进「同类先例」的那几例里取
  （同类 + 同向 + 判得出成败，改善与恶化都算），按相似度取前 ``max_refs`` 条。之前一级原因相同、
  反向调整、没评估结论的案例也会被引用，那时的轮次在裁决对象里照旧留着（``match_level`` 为「同参数同一级原因」的引用）。
* **方向分开数**：与本单同向的先例才进支撑度；反向调整的先例单独记数（``opposite``），不进分母。
* **成败**：改善 / 通过 = 成功，恶化 / 不通过 / 未通过 = 失败（短评估封闭词表，
  :data:`~services.decision.prior_round.SHORT_ASSESS_RESULT_VOCAB`）；其余（缺失、没评估）不计。
  **失败计入分母、只降档不否决**。
* **不分来源、一例计一例**（2026-10-19 用户定）：人工精选与自闭环案例同权。之前人工精选一例按
  ``curated_weight`` 例计（默认 2），那时的轮次在裁决对象 ``cases.policy.curated_weight`` 里记着当时的权重。
* **支撑度**（与 02「根因置信度」、已下线的 ICOS「置信度档位」都不是一回事，故另起名）：

  ====== ============================================================
  高      例数 ≥ high_min_cases 且成功比例 ≥ high_min_ratio
  中      例数 ≥ mid_min_cases 且成功比例 ≥ mid_min_ratio
  低      有同类先例，但够不上中（样本不足，或成功比例 < mid_min_ratio 即「反例为主」）
  无先例  没有同向的同类先例
  ====== ============================================================

* **幅度参考**：同向成功先例的调整幅度（|b − f|）中位数与最大值；本单超出最大值记「幅度超常」。
  只是注记 —— 取值仍由 07 规则库定（对齐清单 Q15）。
* **相似度**（0–100，确定性）：参数相同为前提；二级原因同 30、方向同 25、问题类型同 15、
  制式同 10、厂家同 10、场景同 5、地市同 5。被引用的都是同类先例，前三项恒得（最低 70；
  问题类型进同类口径之前只有前两项恒得、最低 55）。取代展示层曾经由模型编的「相似度 74%」。
* **整单「历史案例参考」**就是各候选引用的合并（同参数 + 同二级原因 + 同问题类型），2026-10-20 起不再用别的参数的案例补位。
"""
from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from services.common.text_utils import _text
from services.decision.prior_round import ShortAssessVerdict, classify_short_assess


# --------------------------------------------------------------------------- #
# 封闭词表
# --------------------------------------------------------------------------- #
class CaseCollection:
    CURATED = "curated"
    CLOSED_LOOP = "closed_loop"


#: 集合的中文名（正文与界面用）。
COLLECTION_LABELS: Dict[str, str] = {
    CaseCollection.CURATED: "人工精选",
    CaseCollection.CLOSED_LOOP: "自闭环",
}


class CaseOutcome:
    SUCCESS = "success"
    FAIL = "fail"
    UNKNOWN = "unknown"


class Direction:
    UP = "增大"
    DOWN = "减小"
    SWITCH = "开关"
    OTHER = "其他"


DIRECTION_VOCAB = (Direction.UP, Direction.DOWN, Direction.SWITCH, Direction.OTHER)


class Support:
    """案例支撑度。"""

    HIGH = "高"
    MID = "中"
    LOW = "低"
    NONE = "无先例"


class MatchLevel:
    """案例与本单候选的匹配层级。只有 :data:`SAME_KIND` 进计数与逐参数引用。

    其余几档只出现在 2026-10-20 之前的轮次里：:data:`CAUSE2` 是问题类型进同类口径之前的同类先例，
    :data:`CAUSE1` 是那时引用比计数宽的参考引用；:data:`PARAM` 从来不引用。
    """

    SAME_KIND = "同参数同二级原因同问题类型"
    CAUSE2 = "同参数同二级原因"
    CAUSE1 = "同参数同一级原因"
    PARAM = "仅参数相同"
    #: 不同参数、同二级原因 —— 2026-10-20 前整单「历史案例参考」补位用的，只出现在那时的轮次里。
    CAUSE_ONLY = "同二级原因"


class EvidenceStatus:
    """整单这一步的结论。

    2026-10-20 前还有一档 ``empty``（案例库里没有生效案例），用户定不考虑空库：没有同类就是 :data:`MISS`。
    那时的轮次在裁决对象里还写着 ``empty``，读的一侧不再单独认它，按「没有同类」展示。
    """

    #: 至少一条候选有同类先例。
    HIT = "hit"
    #: 查了，一条同类先例都没有。
    MISS = "miss"


def outcome_of(estimate_result: Any) -> str:
    """评估结论原文 → :class:`CaseOutcome`。与短评估状态机同一张词表。"""
    verdict = classify_short_assess(estimate_result)
    if verdict == ShortAssessVerdict.PASSED:
        return CaseOutcome.SUCCESS
    if verdict == ShortAssessVerdict.DETERIORATED:
        return CaseOutcome.FAIL
    return CaseOutcome.UNKNOWN


_NUMBER_RE = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)\s*(?:%|db|dbm|ms|s|次|个)?\s*$", re.IGNORECASE)


def parse_number(value: Any) -> Optional[float]:
    """「-110」「80%」「3dB」→ 数；其余（开关名、枚举、区间）→ ``None``。"""
    text = _text(value).replace("，", ",").replace(",", "")
    match = _NUMBER_RE.match(text)
    return float(match.group(1)) if match else None


def direction_of(f_para: Any, b_para: Any, declared: Any = None) -> Tuple[str, Optional[float]]:
    """调整方向与差值 ``(方向, b − f)``。

    声明了方向（案例模板「调整方向」）且在词表里就用声明的；两个值都是数就按差值定增大 / 减小；
    否则（开关名、枚举）记「其他」。差值只在两个值都是数时才有。
    """
    before, after = parse_number(f_para), parse_number(b_para)
    delta = after - before if before is not None and after is not None else None
    word = _text(declared)
    if word in DIRECTION_VOCAB:
        return word, delta
    if delta is not None:
        if delta > 0:
            return Direction.UP, delta
        if delta < 0:
            return Direction.DOWN, delta
    return Direction.OTHER, delta


def _same_value(left: Any, right: Any) -> bool:
    a, b = parse_number(left), parse_number(right)
    if a is not None and b is not None:
        return abs(a - b) < 1e-9
    return _text(left).lower() == _text(right).lower() and bool(_text(left))


# --------------------------------------------------------------------------- #
# 输入
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class CaseActionFact:
    """案例里的一条动作（已归一）。"""

    param_key: str
    param_name: str = ""
    direction: str = Direction.OTHER
    f_para: str = ""
    b_para: str = ""
    delta: Optional[float] = None


@dataclass(frozen=True)
class CaseFact:
    """一个生效案例（已归一）。``outcome`` 用 :func:`outcome_of` 从评估结论推出。"""

    case_id: str
    collection: str
    outcome: str
    actions: Tuple[CaseActionFact, ...] = ()
    trust: str = ""
    estimate_result: str = ""
    taskno: str = ""
    city: str = ""
    nettype: str = ""
    vendor: str = ""
    cover_scene: str = ""
    problem_key: str = ""
    problem_type: str = ""
    cause1_key: str = ""
    cause2_key: str = ""
    cause1: str = ""
    cause2: str = ""
    #: 案例日期（YYYY-MM-DD），排序用：同分时新案优先。
    created: str = ""
    plan_text: str = ""
    reuse_note: str = ""
    estimate_note: str = ""


@dataclass(frozen=True)
class OrderContext:
    """本单与案例比对用的上下文（已归一）。"""

    taskno: str = ""
    problem_key: str = ""
    nettype: str = ""
    vendor: str = ""
    cover_scene: str = ""
    city: str = ""


@dataclass(frozen=True)
class ActionQuery:
    """本单一条候选（ICOS 初案的一个参数，已归一）。``key`` 是 ``plan_table.plan_key``。"""

    key: str
    param_key: str
    param_name: str = ""
    direction: str = Direction.OTHER
    f_para: str = ""
    b_para: str = ""
    delta: Optional[float] = None
    cause1_key: str = ""
    cause2_key: str = ""
    plan_number: str = ""


@dataclass(frozen=True)
class EvidencePolicy:
    """档位门槛与引用上限。由调用方从 ``order_loop.case_library`` 折过来（本模块不读配置）。"""

    high_min_cases: float = 5.0
    high_min_ratio: float = 0.8
    mid_min_cases: float = 2.0
    mid_min_ratio: float = 0.5
    max_refs: int = 3

    def to_dict(self) -> Dict[str, Any]:
        return {
            "high_min_cases": self.high_min_cases,
            "high_min_ratio": self.high_min_ratio,
            "mid_min_cases": self.mid_min_cases,
            "mid_min_ratio": self.mid_min_ratio,
            "max_refs": self.max_refs,
        }


# --------------------------------------------------------------------------- #
# 输出
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class CaseRef:
    """一条被引用的案例（正文 ［案例:ID］ 与界面案例卡的最小信息）。"""

    case_id: str
    collection: str
    outcome: str
    similarity: int
    match_level: str
    trust: str = ""
    estimate_result: str = ""
    param_name: str = ""
    direction: str = ""
    f_para: str = ""
    b_para: str = ""
    cause2: str = ""
    city: str = ""
    nettype: str = ""
    vendor: str = ""
    taskno: str = ""
    created: str = ""

    @property
    def collection_label(self) -> str:
        return COLLECTION_LABELS.get(self.collection, self.collection)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "case_id": self.case_id,
            "collection": self.collection,
            "collection_label": self.collection_label,
            "outcome": self.outcome,
            "estimate_result": self.estimate_result,
            "similarity": self.similarity,
            "match_level": self.match_level,
            "trust": self.trust,
            "param_name": self.param_name,
            "direction": self.direction,
            "f_para": self.f_para,
            "b_para": self.b_para,
            "cause2": self.cause2,
            "city": self.city,
            "nettype": self.nettype,
            "vendor": self.vendor,
            "taskno": self.taskno,
            "created": self.created,
        }


def _fmt_number(value: Optional[float]) -> str:
    if value is None:
        return ""
    return str(int(value)) if abs(value - round(value)) < 1e-9 else f"{value:g}"


@dataclass(frozen=True)
class ActionCaseBasis:
    """一条候选的案例依据。"""

    key: str
    param_name: str
    param_key: str
    direction: str
    support: str
    #: 同向同类先例（一例计一例，不分来源）与其中成败。
    cases: int = 0
    success: int = 0
    fail: int = 0
    #: 其中人工精选几例（只作说明，不加权）。
    curated: int = 0
    #: 成功比例（定档用）。无先例时为 ``None``。
    success_ratio: Optional[float] = None
    #: 同类里**反向**调整的先例数（不进支撑度）。
    opposite: int = 0
    opposite_success: int = 0
    #: 同向成功先例的调整幅度（|b − f|）中位数 / 最大值；本单的幅度。
    typical_delta: Optional[float] = None
    max_success_delta: Optional[float] = None
    current_delta: Optional[float] = None
    #: 本单幅度超出同向成功先例的最大幅度。
    over_magnitude: bool = False
    #: 成功比例低于中档门槛（反例为主）。
    negative_dominant: bool = False
    refs: Tuple[CaseRef, ...] = ()
    #: 本单缺问题类型、候选缺二级原因，判不了同类时的说明。
    note: str = ""

    @property
    def has_precedent(self) -> bool:
        return self.cases > 0

    @property
    def ref_ids(self) -> Tuple[str, ...]:
        return tuple(ref.case_id for ref in self.refs)

    def summary(self) -> str:
        """一句话：进轨迹、进正文表、给关联判定。"""
        if not self.cases:
            base = f"无同向同类先例（支撑度 {self.support}）"
            if self.opposite:
                base += f"；同类里有 {self.opposite} 例反向调整（改善 {self.opposite_success}）"
            return base + (f"；{self.note}" if self.note else "")
        parts = [f"同类 {self.cases} 例（改善 {self.success} / 恶化 {self.fail}"]
        if self.curated:
            parts[0] += f"，其中人工精选 {self.curated}"
        parts[0] += f"），支撑度 {self.support}"
        if self.negative_dominant:
            parts.append("反例为主")
        if self.typical_delta is not None:
            span = f"常见幅度 {_fmt_number(self.typical_delta)}"
            if self.current_delta is not None:
                span += f"，本单 {_fmt_number(abs(self.current_delta))}"
            if self.over_magnitude:
                span += "（超出同类成功最大幅度 " + _fmt_number(self.max_success_delta) + "）"
            parts.append(span)
        if self.opposite:
            parts.append(f"另有 {self.opposite} 例反向调整")
        return "；".join(parts)

    def brief(self) -> Dict[str, Any]:
        """给 04 关联判定提示词的精简版（不带界面字段）。"""
        return {
            "support": self.support,
            "cases": self.cases,
            "success": self.success,
            "fail": self.fail,
            "opposite": self.opposite,
            "negative_dominant": self.negative_dominant,
            "over_magnitude": self.over_magnitude,
            "refs": list(self.ref_ids),
            "summary": self.summary(),
        }

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "param_name": self.param_name,
            "param_key": self.param_key,
            "direction": self.direction,
            "support": self.support,
            "cases": self.cases,
            "success": self.success,
            "fail": self.fail,
            "curated": self.curated,
            "success_ratio": None if self.success_ratio is None else round(self.success_ratio, 4),
            "opposite": self.opposite,
            "opposite_success": self.opposite_success,
            "typical_delta": self.typical_delta,
            "max_success_delta": self.max_success_delta,
            "current_delta": self.current_delta,
            "over_magnitude": self.over_magnitude,
            "negative_dominant": self.negative_dominant,
            "refs": [ref.to_dict() for ref in self.refs],
            "note": self.note,
            "summary": self.summary(),
        }


@dataclass(frozen=True)
class CaseEvidence:
    """整单这一轮的案例证据：落 ``decision_json.cases``。"""

    status: str
    library_version: str = ""
    library_size: int = 0
    actions: Mapping[str, ActionCaseBasis] = field(default_factory=dict)
    #: 整单「历史案例参考」：各候选的引用合并去重（只有同参数、同二级原因、同问题类型的同类先例，2026-10-20 起不补位）。
    refs: Tuple[CaseRef, ...] = ()
    policy: EvidencePolicy = field(default_factory=EvidencePolicy)
    #: 这份证据有没有喂给 04 关联判定（由调用方按配置回填）。
    relevance_evidence: bool = False

    @property
    def hit_count(self) -> int:
        return sum(1 for basis in self.actions.values() if basis.has_precedent)

    def basis(self, key: str) -> Optional[ActionCaseBasis]:
        return self.actions.get(key)

    def cited_ids(self) -> Tuple[str, ...]:
        """本轮任何地方引用得到的案例编号（正文引用校验的白名单）。"""
        seen: List[str] = []
        for ref in self.refs:
            if ref.case_id not in seen:
                seen.append(ref.case_id)
        for basis in self.actions.values():
            for ref in basis.refs:
                if ref.case_id not in seen:
                    seen.append(ref.case_id)
        return tuple(seen)

    def summary(self) -> str:
        counts: Dict[str, int] = {}
        for basis in self.actions.values():
            counts[basis.support] = counts.get(basis.support, 0) + 1
        tiers = "、".join(
            f"{word} {counts[word]}" for word in (Support.HIGH, Support.MID, Support.LOW, Support.NONE) if counts.get(word)
        )
        return (
            f"库内 {self.library_size} 例；{len(self.actions)} 个候选里 {self.hit_count} 个有同类先例"
            + (f"（支撑度 {tiers}）" if tiers else "")
            + f"；整单参考案例 {len(self.refs)} 例"
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "library_version": self.library_version,
            "library_size": self.library_size,
            "relevance_evidence": self.relevance_evidence,
            "policy": self.policy.to_dict(),
            "hit_count": self.hit_count,
            "action_count": len(self.actions),
            "refs": [ref.to_dict() for ref in self.refs],
            "actions": [basis.to_dict() for basis in self.actions.values()],
            "summary": self.summary(),
        }


# --------------------------------------------------------------------------- #
# 计算
# --------------------------------------------------------------------------- #
def _eq(left: str, right: str) -> bool:
    return bool(left) and bool(right) and left == right


def _nettype_overlap(query: str, case: str) -> bool:
    if not query or not case:
        return False
    return query == case or query in case.split("+") or case in query.split("+")


def _context_score(case: CaseFact, context: OrderContext) -> int:
    score = 0
    score += 10 if _nettype_overlap(context.nettype, case.nettype) else 0
    score += 10 if _eq(context.vendor, case.vendor) else 0
    score += 5 if _eq(context.cover_scene, case.cover_scene) else 0
    score += 5 if _eq(context.city, case.city) else 0
    return score


def _same_direction(query: ActionQuery, action: CaseActionFact) -> bool:
    """同向：两边都是增大 / 减小就比方向词；有一边是开关 / 其他就比目标值是否相同。"""
    numeric = (Direction.UP, Direction.DOWN)
    if query.direction in numeric and action.direction in numeric:
        return query.direction == action.direction
    return _same_value(query.b_para, action.b_para)


#: 相似度里同二级原因、同向、同问题类型三项的分值（上下文四项见 :func:`_context_score`）。
_CAUSE2_SCORE = 30
_DIRECTION_SCORE = 25
_PROBLEM_SCORE = 15


def _similarity(case: CaseFact, context: OrderContext) -> int:
    """同类先例的相似度：同二级原因、同向、同问题类型三项恒得（只有同类先例才被引用），其余看上下文。"""
    return min(100, _CAUSE2_SCORE + _DIRECTION_SCORE + _PROBLEM_SCORE + _context_score(case, context))


def _same_kind(query: ActionQuery, context: OrderContext, case: CaseFact) -> bool:
    """同类（参数由调用方先比过）：同二级原因 + 同问题类型，任一边缺值都不算。"""
    return _eq(query.cause2_key, case.cause2_key) and _eq(context.problem_key, case.problem_key)


_LEVEL_RANK = {
    MatchLevel.SAME_KIND: 0,
    MatchLevel.CAUSE2: 0,
    MatchLevel.CAUSE1: 1,
    MatchLevel.PARAM: 2,
    MatchLevel.CAUSE_ONLY: 3,
}


def _ref_sort_key(ref: CaseRef) -> Tuple[Any, ...]:
    # 层级 → 相似度 → 人工精选优先 → 新案优先 → 编号（稳定）
    return (
        _LEVEL_RANK.get(ref.match_level, 9),
        -ref.similarity,
        0 if ref.collection == CaseCollection.CURATED else 1,
        # created 是 YYYY-MM-DD，取负序靠反转字符：空串排最后
        tuple(-ord(ch) for ch in ref.created) if ref.created else (1,),
        ref.case_id,
    )


def _ref(case: CaseFact, action: Optional[CaseActionFact], level: str, similarity: int) -> CaseRef:
    return CaseRef(
        case_id=case.case_id,
        collection=case.collection,
        outcome=case.outcome,
        similarity=similarity,
        match_level=level,
        trust=case.trust,
        estimate_result=case.estimate_result,
        param_name=action.param_name if action else "",
        direction=action.direction if action else "",
        f_para=action.f_para if action else "",
        b_para=action.b_para if action else "",
        cause2=case.cause2 or case.cause2_key,
        city=case.city,
        nettype=case.nettype,
        vendor=case.vendor,
        taskno=case.taskno,
        created=case.created,
    )


def _tier(cases: int, ratio: Optional[float], policy: EvidencePolicy) -> str:
    if cases <= 0 or ratio is None:
        return Support.NONE
    if cases >= policy.high_min_cases and ratio >= policy.high_min_ratio:
        return Support.HIGH
    if cases >= policy.mid_min_cases and ratio >= policy.mid_min_ratio:
        return Support.MID
    return Support.LOW


def assess_action(
    query: ActionQuery,
    context: OrderContext,
    cases: Sequence[CaseFact],
    policy: EvidencePolicy,
) -> ActionCaseBasis:
    """一条候选的案例依据。每个案例最多按它的**第一条**同参数动作计一次（同案同参数重复写不重复计数）。

    **引用与计数同一口径**（2026-10-20 用户定）：``refs`` 只取进了 ``cases`` 的那几例（同参数 + 同二级原因 + 同问题类型
    + 同向、评估结论判得出成败，改善与恶化都算），按相似度排、取前 ``max_refs`` 条。之前同一级原因、反向调整、
    没评估结论的案例也会被引用，裁决表「可引用案例」与「同类先例」因此对不上。
    """
    same_dir: List[Tuple[CaseFact, CaseActionFact]] = []
    opposite: List[CaseFact] = []
    for case in cases:
        action = next((item for item in case.actions if item.param_key and item.param_key == query.param_key), None)
        if action is None:
            continue
        if not _same_kind(query, context, case) or case.outcome == CaseOutcome.UNKNOWN:
            continue
        if _same_direction(query, action):
            same_dir.append((case, action))
        else:
            opposite.append(case)

    success = sum(1 for case, _ in same_dir if case.outcome == CaseOutcome.SUCCESS)
    ratio = success / len(same_dir) if same_dir else None
    success_deltas = [
        abs(action.delta) for case, action in same_dir if case.outcome == CaseOutcome.SUCCESS and action.delta is not None
    ]
    typical = statistics.median(success_deltas) if success_deltas else None
    maximum = max(success_deltas) if success_deltas else None
    current = query.delta
    missing = [word for word, value in (("问题类型", context.problem_key), ("二级原因", query.cause2_key)) if not value]
    note = f"本单缺{'、'.join(missing)}，判不了同类" if missing else ""
    refs = sorted((_ref(case, action, MatchLevel.SAME_KIND, _similarity(case, context)) for case, action in same_dir), key=_ref_sort_key)
    return ActionCaseBasis(
        key=query.key,
        param_name=query.param_name,
        param_key=query.param_key,
        direction=query.direction,
        support=_tier(len(same_dir), ratio, policy),
        cases=len(same_dir),
        success=success,
        fail=sum(1 for case, _ in same_dir if case.outcome == CaseOutcome.FAIL),
        curated=sum(1 for case, _ in same_dir if case.collection == CaseCollection.CURATED),
        success_ratio=ratio,
        opposite=len(opposite),
        opposite_success=sum(1 for case in opposite if case.outcome == CaseOutcome.SUCCESS),
        typical_delta=typical,
        max_success_delta=maximum,
        current_delta=current,
        over_magnitude=bool(current is not None and maximum is not None and abs(current) > maximum + 1e-9),
        negative_dominant=bool(ratio is not None and ratio < policy.mid_min_ratio),
        refs=tuple(refs[: policy.max_refs]),
        note=note,
    )


def _order_refs(actions: Iterable[ActionCaseBasis], policy: EvidencePolicy) -> Tuple[CaseRef, ...]:
    """整单「历史案例参考」：各候选的引用（都是同参数、同二级原因、同问题类型的同类先例）按相似度合并去重，取前 ``max_refs`` 条。

    **不补位**（2026-10-20 用户定）：之前不够 ``max_refs`` 条时，用与本单同二级原因、但参数不同的案例补上
    （``match_level`` 为「同二级原因」），那时的轮次在裁决对象里照旧留着。
    """
    picked: Dict[str, CaseRef] = {}
    for ref in sorted((ref for basis in actions for ref in basis.refs), key=_ref_sort_key):
        picked.setdefault(ref.case_id, ref)
    return tuple(sorted(picked.values(), key=_ref_sort_key)[: policy.max_refs])


def build_case_evidence(
    queries: Sequence[ActionQuery],
    context: OrderContext,
    cases: Sequence[CaseFact],
    policy: EvidencePolicy,
    *,
    library_version: str = "",
    library_size: Optional[int] = None,
) -> CaseEvidence:
    """整单的案例证据。``cases`` 是已按有效期筛过、动作里有本单候选参数的生效案例；同一 ``key`` 只算一次（取第一条）。

    **本单自己的案例不参与**：自闭环回灌会把这张单前几轮的处置也收进库，重推理轮次再拿它当「先例」
    就是自己证明自己 —— 前几轮的下发与评估由多轮决策（``prior_round``）管，不归案例库。

    取回的案例为空（库里没有调过这几个参数的案例）就是一条同类先例都没有（:data:`EvidenceStatus.MISS`），不区分空库。
    """
    if context.taskno:
        cases = [case for case in cases if case.taskno != context.taskno]
    size = len(cases) if library_size is None else library_size
    actions = {query.key: assess_action(query, context, cases, policy) for query in _unique(queries)}
    refs = _order_refs(actions.values(), policy)
    status = EvidenceStatus.HIT if any(basis.has_precedent for basis in actions.values()) else EvidenceStatus.MISS
    return CaseEvidence(
        status=status,
        library_version=library_version,
        library_size=size,
        actions=actions,
        refs=refs,
        policy=policy,
    )


def _unique(queries: Sequence[ActionQuery]) -> List[ActionQuery]:
    seen: Dict[str, ActionQuery] = {}
    for query in queries:
        if query.key and query.key not in seen:
            seen[query.key] = query
    return list(seen.values())


#: 正文 / 关联判定理由里的案例引用写法：［案例:CASE-202607-001］（全角括号，半角冒号也认）。
CASE_CITATION_RE = re.compile(r"［案例[:：]\s*([^］\]\s]+)\s*］")


def cited_case_ids(text: Any) -> Tuple[str, ...]:
    """从一段文字里抽出 ［案例:ID］ 引用的编号（去重、保序）。"""
    found: List[str] = []
    for match in CASE_CITATION_RE.finditer(_text(text)):
        case_id = match.group(1).strip()
        if case_id and case_id not in found:
            found.append(case_id)
    return tuple(found)


def strip_unknown_citations(text: Any, allowed: Iterable[str]) -> Tuple[str, Tuple[str, ...]]:
    """删掉不在白名单里的 ［案例:ID］（模型编出来的编号），返回 ``(清理后文本, 被删的编号)``。

    只删引用标记本身、不动前后文字：一句话里编了个案例编号，那句话照留，只是不再带一个查无此案的引用。
    """
    allowed_set = set(allowed)
    removed: List[str] = []

    def _sub(match: "re.Match[str]") -> str:
        case_id = match.group(1).strip()
        if case_id in allowed_set:
            return f"［案例:{case_id}］"
        if case_id not in removed:
            removed.append(case_id)
        return ""

    cleaned = CASE_CITATION_RE.sub(_sub, _text(text))
    return cleaned, tuple(removed)


__all__ = [
    "COLLECTION_LABELS",
    "CASE_CITATION_RE",
    "ActionCaseBasis",
    "ActionQuery",
    "CaseActionFact",
    "CaseCollection",
    "CaseEvidence",
    "CaseFact",
    "CaseOutcome",
    "CaseRef",
    "Direction",
    "DIRECTION_VOCAB",
    "EvidencePolicy",
    "EvidenceStatus",
    "MatchLevel",
    "OrderContext",
    "Support",
    "assess_action",
    "build_case_evidence",
    "cited_case_ids",
    "direction_of",
    "outcome_of",
    "parse_number",
    "strip_unknown_citations",
]
