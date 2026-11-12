"""决策步 08 综合决策及参数编排 —— **参数冲突剔除**。

问题
----
推送是**整批原子**：一次 HTTP 把整单的动作全发出去。同一个参数在同一批里带着两个
不同的目标值、而且都 ``need_call=是``，参数平台侧是后写覆盖先写，**最终生效哪一个
不可预期**，报文里两条都在、事后也看不出谁生效了。

2026-09-22 起（``e5278b7``）全组并列裁决，低档方案组不再被整档跳过 —— 同一参数
跨组各出现一次的机会随之变大。这一步是那次切换的配套兜底：「过的都发」之前，
先把会互相覆盖的那几条拿掉。

剔除规则（业务口径 Q4「不择优、只做冲突剔除」；2026-09-24 按业务「``final_ratio``
没有任何意义、不得用于方案决策」改定）
-------------------------------------------------------------------------
1. 只看**已判可下发**的动作（``need_call=是``）。没准入的本来就不会被执行，不构成冲突。
2. 目标值按**推送口径**比（合规之后的 ``b_para``）—— 冲突发生在报文里，就按报文里
   的值判。「怎样算冲突」与决策步 06 共用
   :func:`services.decision.candidate_set.iter_value_conflicts` 一处口径：
   同值是冗余不是冲突（发两条同值报文结果确定），不进这里。
3. 一个参数出现两个以上不同目标值 → **冲突各方全部剔除**，该参数本轮保持现网值。
   系统手上没有任何可以替 ICOS 选的依据 —— 这就是「不择优」。

2026-09-23 至 09-24 之间的实现曾取成员里最高的 ICOS ``final_ratio`` 定胜负（规则名
``priority``，最高分上并列才 ``tie_drop_all``）。业务确认这一列没有意义后删掉；库里那段
时间的轨迹 / ``llm_solution.arbitration`` 里可能还留着这两个规则名，读的时候当历史看。

边界
----
纯函数：不碰库、不读配置、不改入参。**只给结论** —— 怎么落库（改 ``need_call``、
写 phase、挂轨迹）是调用方 :class:`services.orders.decision_service.DecisionService`
的事。结论与入参次序无关（成员的列出次序除外），由用例钉住。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Sequence, Tuple

from services.decision.candidate_set import iter_value_conflicts


class ArbitrationRule:
    """一条冲突是按哪条规则裁的。封闭词表，落进轨迹与 ``llm_solution``。

    今天只有一条；保留成词表是为了让落库的 ``rule`` 能与历史取值
    （``priority`` / ``tie_drop_all``，见模块文档）区分开。
    """

    #: 同一参数多个不同目标值 → 冲突各方全部剔除。
    DROP_ALL = "drop_all"


class MemberOutcome:
    KEPT = "kept"
    DROPPED = "dropped"


@dataclass(frozen=True)
class DispatchEntry:
    """08 的输入：一条**已判可下发**、准备进报文的动作。"""

    #: 本单内唯一的行标识。调用方用 ``agent_decision_id`` —— **不用** ``plan_key``：
    #: 后者在 ``execution_id`` 为空时回落到参数名，而同名参数正是这里要处理的对象，
    #: 拿它当键会让冲突成员互相顶掉。
    key: str
    parachinname: str
    #: 推送口径的目标值（合规之后的 ``b_para``）。
    value: str
    #: 以下两格只用于留痕，不参与裁决。
    execution_id: str = ""
    group_key: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "execution_id": self.execution_id,
            "value": self.value,
            "group_key": self.group_key,
        }


@dataclass(frozen=True)
class ConflictResolution:
    """一个参数的冲突，以及 08 对它的裁决。"""

    parachinname: str
    rule: str
    #: 全部冲突成员，按入参次序。**全部剔除**（见模块文档）。
    members: Tuple[DispatchEntry, ...]
    #: 出现过的不同目标值，按入参次序去重。
    values: Tuple[str, ...]

    @property
    def dropped_keys(self) -> Tuple[str, ...]:
        return tuple(member.key for member in self.members)

    @property
    def cross_group(self) -> bool:
        """成员分属不同方案组。组号缺失（空 ``group_key``）不参与判断。"""
        return len({member.group_key for member in self.members if member.group_key}) > 1

    def outcome_of(self, key: str) -> str:
        return MemberOutcome.DROPPED if key in self.dropped_keys else MemberOutcome.KEPT

    def to_dict(self) -> Dict[str, Any]:
        return {
            "parachinname": self.parachinname,
            "rule": self.rule,
            "values": list(self.values),
            "cross_group": self.cross_group,
            "members": [
                {**member.to_dict(), "outcome": self.outcome_of(member.key)}
                for member in self.members
            ],
        }


def resolve_dispatch_conflicts(
    entries: Sequence[DispatchEntry],
) -> Tuple[ConflictResolution, ...]:
    """对一整单**已判可下发**的动作做参数冲突剔除，返回每个冲突参数的裁决。

    没有冲突返回空 tuple —— 调用方据此什么都不用做。规则见模块文档。
    """
    triples = ((entry.parachinname, entry.value, entry) for entry in entries)
    return tuple(
        ConflictResolution(
            parachinname=name,
            rule=ArbitrationRule.DROP_ALL,
            members=members,
            values=values,
        )
        for name, members, values in iter_value_conflicts(triples)
    )


__all__ = [
    "ArbitrationRule",
    "ConflictResolution",
    "DispatchEntry",
    "MemberOutcome",
    "resolve_dispatch_conflicts",
]
