"""决策步 04 生成方案的产出：**候选动作集**（``CandidateSet``）。

「这一轮到底把哪些参数、编成哪几个方案组、送进后面几步去判」—— 把这件事从一堆
临时元组变成一个类型化对象。

三层结构：方案组 → 方案 → 参数（2026-09-21 业务回话 Q1）
------------------------------------------------------
* **方案组**（``CandidateGroup``）：本步的主键与判断单位。业务口径「不需要包」——
  原先叫「包（package）」的东西就是它，命名按业务术语改为「方案组」。
  判断按组分组，**发送仍整单一次 HTTP、整批原子**（2026-09-21 二次回话确认），
  所以本模块**不提供**任何「这个组单独发」的字段，那会诱导出一条不存在的路径。
* **方案**（``CandidatePlan``）：组内的中间层，按 ``plan_number`` 归并。
  组内寻优「按方案与根因的关联性选」是业务口径：关联判定由调用方注入的 ``relevance_of``
  给（:mod:`services.decision.relevance`，2026-09-22 起 LLM 载体），本模块只把判定挂到方案上
  （:attr:`CandidatePlan.relevance`），**选择在 04 组内寻优那一步做**
  （:func:`services.decision.chain.select_plans`）。
  「关联度并列都要」的口径同时意味着：**不许在这里偷偷加排序**。
* **参数**（``Candidate``）：一条 ICOS 初案参数，原样不加工。

分组键：组名为主、组号为辅
--------------------------
2026-09-21 业务回话 Q6 的数据结论：初案 ``type2``（组名）在 02 样本里 374/374
全有值，而方案组编号**整单缺失 9 单**；组号→组名严格 1:1，组名→组号 1:1 或 1:2
（L/N 双制式前缀，如 低切换 = LDQH|NDQH）。**组名是比组号更稳的组键，
组号只是组名的制式细分代码** —— 同组名不同组号**并成一组**。

不带 ICOS 的 ``final_ratio``
----------------------------
2026-09-24 业务确认：初案的 ``final_ratio`` **没有任何意义，不得用于方案决策**。候选集
因此不再带「档位」（原 ``CandidateGroup.tier`` / ``tier_index`` / ``CandidateSet.tiers``、
``Candidate.final_ratio`` 一并删除）。组的次序 = 组在初案里的**首现次序**（仓储按
ICOS 推送先后 ``sort_id`` 给出），只是列出的先后，不代表优先级。

在那之前档位已经降成信息位：「先试最高档的那个包」随业务口径作废（「不太关注档位，更多考虑
方案组」+「多个候选方案组并列判、08 一次裁决」），**选择只按组**，
round 0 = 全部组并列选中。形态 C 的「档位回退换回环」随之取消，重过结论见
``docs/04-生成方案-与合规链的先后-选型论证.md``。

边界
----
* 候选集随裁决对象落 ``OrderDecision.candidates``（04）。
* **本模块不做选择**：关联判定只是挂上去的结论，谁发谁不发由决策链定（见上「方案」一条）。
* 纯函数、无 IO、无 settings。关联判定与可行性预判都由调用方以 callable 传进来
  （前者要调模型，后者要读规则库；决策服务今天不传 ``feasibility_of``，规则库结论在 07 才算）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    Iterator,
    List,
    Mapping,
    Optional,
    Sequence,
    Tuple,
    TypeVar,
)

from services.common.text_utils import _text
from services.decision.rule_assessment import FeasibilityShape, PlanFeasibility
from services.decision.plan_table import plan_key
from services.decision.relevance import PlanRelevance, RelevanceJudge, RootCauseBrief, resolve_plan_relevance


def plan_group_key(plan: Mapping[str, Any]) -> str:
    """本单内的分组键：组名（``type2``）→ 组号 → 方案编号 → 自成一组。

    **组名为主**是 2026-09-21 业务回话 Q6 的数据结论（见模块文档）：同组名不同
    组号（L/N 双制式）必须并成一组，所以组号不再参与主键、只留作来源线索
    （:attr:`CandidateGroup.source_plan_groups`）。

    **回落到方案编号不是凑数**：现网有初案整单不带组号（02 样本 9 单），而实测
    **方案编号能把它们归位** —— 无组号行的 ``plan_number`` 与有组号行重叠
    （``NYH0016`` 3 条无组号 + 25 条在 ``NYH0016_G01`` 里）。让它们每条自成一组
    会把一个方案拆散，而同一方案的参数是配套的，只发一半会停在没人设计过的中间态。

    键上带字段名前缀：组名、组号、方案编号**取值相同却含义不同**时不会被并成一组。
    """
    for field_name in ("type2", "plan_group_number", "plan_number"):
        value = (_text(plan.get(field_name)) or "").strip()
        if value:
            return f"{field_name}:{value}"
    return f"execution_id:{(_text(plan.get('execution_id')) or '').strip()}"


def _plan_key_in_group(row: Mapping[str, Any]) -> str:
    """组内归并方案的键：``plan_number``，缺失则该行自成一方案（不硬凑）。"""
    number = (_text(row.get("plan_number")) or "").strip()
    if number:
        return number
    return f"execution_id:{(_text(row.get('execution_id')) or '').strip()}"


@dataclass(frozen=True)
class Candidate:
    """候选集里的一条 —— 一条 ICOS 初案参数。"""

    #: 对齐键。**必须逐字等于** ``plan_table.plan_key``，也就是 ``ActionVerdict.key``。
    #: 另立键空间会同时打断根因回指、复核对齐、冲突成员集合三处。
    key: str
    parachinname: str
    #: 组内位次，1 起（跨方案连续编号）。等于调用方给的次序（仓储按 ICOS 推送先后
    #: ``sort_id``），只是列出的先后，**不代表优先级**。
    position: int
    execution_id: str = ""
    sort_id: Optional[int] = None
    #: 参数当前现网值（锚点）与 ICOS 建议目标值，取自初案，**原样不加工**。
    #: 04 的三件事里「取值」这一件就落在这一对上；08 冲突检测也用这一对
    #: （判定口径见 :func:`iter_value_conflicts`）。
    f_para: str = ""
    b_para: str = ""
    #: 决策步 04 的确定性可行性预判。``None`` = 调用方没传（本模块不自己算，它带文件 IO）。
    feasibility: Optional[PlanFeasibility] = None

    @property
    def feasibility_shape(self) -> str:
        return self.feasibility.shape if self.feasibility else ""

    @property
    def infeasible(self) -> bool:
        """代码**确定**判死。判不了（``constraint_unparsable`` / 规则未命中）不算。"""
        return bool(self.feasibility) and self.feasibility.shape == FeasibilityShape.REJECTED

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "parachinname": self.parachinname,
            "position": self.position,
            "execution_id": self.execution_id,
            "sort_id": self.sort_id,
            "f_para": self.f_para,
            "b_para": self.b_para,
            "feasibility": self.feasibility.to_dict() if self.feasibility else None,
            "infeasible": self.infeasible,
        }


@dataclass(frozen=True)
class CandidatePlan:
    """方案组里的一个**方案**（``plan_number``）—— 三层结构的中间层。

    关联判定（差额 ②）2026-09-22 起以 Phase-1 LLM 载体落地，挂在 :attr:`relevance`；
    04 组内寻优（:func:`services.decision.chain.optimal_plans`）按 :attr:`relevant` 窄化 ——
    与根因关联的方案并列都留，全组都不关联时全留。本层自己**不做选择**，也不许加排序。
    """

    #: ICOS 原样给的方案编号。``None`` = 该行没给（此方案由 execution_id 兜底自成）。
    plan_number: Optional[str]
    #: 组内第几个方案，1 起（按首现次序）。
    position: int
    items: Tuple[Candidate, ...]
    #: 与本单根因的关联判定（Phase-1 LLM / Phase-2 映射表）。``None`` = 未判，
    #: 由 :attr:`relevant` 解释为「保留」（fail-open，组内全保留）。
    relevance: Optional[PlanRelevance] = None

    @property
    def size(self) -> int:
        return len(self.items)

    @property
    def all_infeasible(self) -> bool:
        """整方案每一条都被确定性预判判死。空方案不算（那是「没东西」不是「都不行」）。"""
        return bool(self.items) and all(item.infeasible for item in self.items)

    @property
    def relevant(self) -> bool:
        """是否与本单根因关联 / 是否参与本轮下发。

        **fail-open**：未给出判定（``relevance is None``）时返回 ``True``（保留）。
        这与「bypass = 组内全保留」一致 —— LLM 失败/未传 callable 时**只做窄化、
        不做扩展**，绝不让关联判定把本来该发的方案挡掉。
        """
        return self.relevance.relevant if self.relevance is not None else True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "plan_number": self.plan_number,
            "position": self.position,
            "size": self.size,
            "all_infeasible": self.all_infeasible,
            "relevance": self.relevance.to_dict() if self.relevance else None,
            "relevant": self.relevant,
            "items": [item.to_dict() for item in self.items],
        }


@dataclass(frozen=True)
class CandidateGroup:
    """一个**方案组** —— 04 的主键与判断单位。"""

    #: 分组键，见 :func:`plan_group_key`。本单内唯一。
    key: str
    #: ICOS 原样给的组名（``type2``）。``None`` = 上游没下发（落到了组号/方案编号兜底）。
    name: Optional[str]
    plans: Tuple[CandidatePlan, ...]
    #: 组内出现过的方案组编号，按首现次序去重。**只作来源线索**：组名→组号
    #: 可以是 1:2（L/N 双制式），且组号跨几十张工单复用，当不了组 ID。
    source_plan_groups: Tuple[str, ...] = ()
    #: 第几轮被标成「本轮选中」。``None`` = 本轮没轮到它。
    #: 今天没人写它（恒 ``None``）：P4 回环改的是决策链的下发集合（``chain.ChainState``），不是这一格；
    #: 留给日后「组内换方案」那种回环（待业务定）。
    selected_in_round: Optional[int] = None

    @property
    def ungrouped(self) -> bool:
        """组名与组号都缺失（落到了方案编号/逐条兜底）。**显式布尔**，不靠推。"""
        return self.name is None and not self.source_plan_groups

    @property
    def selected(self) -> bool:
        return self.selected_in_round is not None

    @property
    def items(self) -> Tuple[Candidate, ...]:
        """组内全部参数（跨方案摊平，保持方案的先后与方案内的次序）。"""
        return tuple(item for plan in self.plans for item in plan.items)

    @property
    def size(self) -> int:
        return sum(plan.size for plan in self.plans)

    @property
    def all_infeasible(self) -> bool:
        """整组每一条都被确定性预判判死。空组不算（那是「没东西」不是「都不行」）。"""
        return bool(self.plans) and all(plan.all_infeasible for plan in self.plans)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "source_plan_groups": list(self.source_plan_groups),
            "ungrouped": self.ungrouped,
            "selected_in_round": self.selected_in_round,
            "selected": self.selected,
            "size": self.size,
            "all_infeasible": self.all_infeasible,
            "plans": [plan.to_dict() for plan in self.plans],
        }


@dataclass(frozen=True)
class CandidateSet:
    """一轮决策的候选动作集。"""

    taskno: str
    #: ICOS 重推理轮（``agent_execution_plan.retry_times``）。
    retry_times: int = 0
    #: P4 回环轮，04 首轮 = 0。**与 retry_times 是两个计数器，不可合并**：
    #: 前者是「ICOS 让我们重来一次」，后者是「同一轮里我们自己换了一批组再裁」。
    round_index: int = 0
    groups: Tuple[CandidateGroup, ...] = ()
    warnings: Tuple[str, ...] = field(default_factory=tuple)

    @property
    def source_count(self) -> int:
        """进来的初案条数。**04 不许增删行** —— 这个数必须等于初案数。"""
        return sum(group.size for group in self.groups)

    @property
    def selected_groups(self) -> Tuple[CandidateGroup, ...]:
        return tuple(group for group in self.groups if group.selected)

    @property
    def selected_count(self) -> int:
        return sum(group.size for group in self.selected_groups)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "taskno": self.taskno,
            "retry_times": self.retry_times,
            "round_index": self.round_index,
            "source_count": self.source_count,
            "selected_count": self.selected_count,
            "groups": [group.to_dict() for group in self.groups],
            "warnings": list(self.warnings),
        }


def group_plans_by_group(
    plans: Sequence[Mapping[str, Any]],
) -> List[Tuple[str, List[Mapping[str, Any]]]]:
    """初案清单 → ``[(分组键, 该组的初案行)]``，组按**首现次序**、组内保持调用方给的次序。

    **分组的唯一实现**，:func:`build_candidate_set` 走它。**不看 ``final_ratio``**
    （2026-09-24 业务：该列没有意义，不得用于方案决策）；次序只是列出的先后。
    """
    groups: Dict[str, List[Mapping[str, Any]]] = {}
    for plan in plans:
        groups.setdefault(plan_group_key(plan), []).append(plan)
    return list(groups.items())


def build_candidate_set(
    plans: Sequence[Mapping[str, Any]],
    *,
    taskno: str = "",
    retry_times: int = 0,
    round_index: int = 0,
    feasibility_of: Optional[Callable[[Mapping[str, Any]], Optional[PlanFeasibility]]] = None,
    relevance_of: Optional[RelevanceJudge] = None,
    root_cause: Optional[RootCauseBrief] = None,
) -> CandidateSet:
    """初案清单 → 候选集。**纯函数：无 IO、不读配置、不调模型。**

    两个注入位都由调用方给 callable，本模块仍是叶子：

    * ``feasibility_of`` —— 可行性预判，要读规则库 CSV（带文件 IO）。
    * ``relevance_of`` —— 组内**根因关联判定**（差额 ②，2026-09-22 Phase-1 起的
      LLM 载体）。只在**组内 >1 方案**时调一次（单方案组无寻优必要、省一次 LLM），
      失败/未传 → 整组 bypass（:attr:`CandidatePlan.relevant` 视作 ``True`` 保留）。
      ``root_cause`` 是 02 根因收敛里置信度达到阈值的根因（``RootCauseBrief``），喂给判定 callable。

    两个都不传就是不带预判的纯结构（分组）。
    """
    groups: List[CandidateGroup] = []
    for key, rows in group_plans_by_group(plans):
        # 组内再按方案编号归并（方案层）。保持行的先后：方案按首现、参数按调用方次序。
        rows_by_plan: Dict[str, List[Mapping[str, Any]]] = {}
        for row in rows:
            rows_by_plan.setdefault(_plan_key_in_group(row), []).append(row)

        # 关联判定：整组一次（LLM 要在对比上下文里判，并列才说得清）。
        # 单方案组直接跳过 —— 只有一个方案，没有「寻优」可言。
        judgment: Optional[Mapping[str, PlanRelevance]] = None
        if relevance_of and len(rows_by_plan) > 1:
            judgment = relevance_of(rows, root_cause)

        position = 0
        group_plans: List[CandidatePlan] = []
        for plan_position, plan_rows in enumerate(rows_by_plan.values(), 1):
            plan_number = (_text(plan_rows[0].get("plan_number")) or "").strip() or None
            items: List[Candidate] = []
            for row in plan_rows:
                position += 1
                items.append(
                    Candidate(
                        key=plan_key(row.get("execution_id"), row.get("parachinname")),
                        parachinname=_text(row.get("parachinname")) or "",
                        position=position,
                        execution_id=_text(row.get("execution_id")) or "",
                        sort_id=_int_or_none(row.get("sort_id")),
                        f_para=_text(row.get("f_para")) or "",
                        b_para=_text(row.get("b_para")) or "",
                        feasibility=feasibility_of(row) if feasibility_of else None,
                    )
                )
            group_plans.append(
                CandidatePlan(
                    plan_number=plan_number,
                    position=plan_position,
                    items=tuple(items),
                    relevance=resolve_plan_relevance(plan_number, judgment),
                )
            )

        source_plan_groups: List[str] = []
        for row in rows:
            value = (_text(row.get("plan_group_number")) or "").strip()
            if value and value not in source_plan_groups:
                source_plan_groups.append(value)
        name = next(
            (value for row in rows if (value := (_text(row.get("type2")) or "").strip())),
            None,
        )
        groups.append(
            CandidateGroup(
                key=key,
                name=name,
                plans=tuple(group_plans),
                source_plan_groups=tuple(source_plan_groups),
            )
        )

    return CandidateSet(
        taskno=taskno,
        retry_times=retry_times,
        round_index=round_index,
        groups=tuple(groups),
    )


_T = TypeVar("_T")


def iter_value_conflicts(
    entries: Iterable[Tuple[Any, Any, _T]],
) -> Iterator[Tuple[str, Tuple[_T, ...], Tuple[str, ...]]]:
    """「同一参数、两个以上不同目标值」的**唯一判定口径**。

    决策步 08 的 :func:`services.decision.arbitration.resolve_dispatch_conflicts`
    （合规后、推送值）走这里 —— 参数名怎么归一、值怎么比、几条算冲突，只写这一次。

    入参是 ``(参数名, 目标值, 载荷)``；产出 ``(参数名, 该参数下全部载荷, 去重后的目标值)``，
    参数名按首次出现的次序、载荷与目标值按入参次序。参数名与目标值都去首尾空白后比较；
    参数名为空的条目跳过（无从比较）。同一参数出现多次但目标值一致 —— 是冗余，不是冲突。
    """
    seen: Dict[str, List[Tuple[str, _T]]] = {}
    for name, value, payload in entries:
        name = (_text(name) or "").strip()
        if not name:
            continue
        seen.setdefault(name, []).append(((_text(value) or "").strip(), payload))

    for name, bucket in seen.items():
        if len(bucket) < 2:
            continue
        values: List[str] = []
        for value, _payload in bucket:
            if value not in values:
                values.append(value)
        if len(values) < 2:
            continue
        yield name, tuple(payload for _, payload in bucket), tuple(values)


def _int_or_none(value: Any) -> Optional[int]:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return None


__all__ = [
    "Candidate",
    "CandidateGroup",
    "CandidatePlan",
    "CandidateSet",
    "build_candidate_set",
    "group_plans_by_group",
    "iter_value_conflicts",
    "plan_group_key",
]
