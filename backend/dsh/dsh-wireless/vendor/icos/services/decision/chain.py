"""决策链 —— 从 04 候选集整条算一遍：本轮发出去什么、每个参数为什么是这个下场。

**2026-09-25 起这是唯一的裁决链**：合规链（逐条问模型 + 数值后验）已删除，没有开关档、没有对照。
``DecisionService`` 的决策流水线逐步调这四步（:func:`select_plans` → :func:`assess_rules` →
:func:`drop_conflicts` → :func:`resolve_conditions`，每一步单独记轨迹），把结论写进决策行的下发两格，
裁决对象、推送、展示随之读它；:func:`run_chain` 是四步的组合入口（给用例与离线分析）。

P6 双跑时期它与合规链并排算、不下发，模块叫 ``shadow``（「影子」）、写进决策行时叫「新链路」，
2026-10-09 起代码里的名字统一改为「决策链」。落库的名字同日改了两个没人读、不外发的：裁决对象里的
``shadow`` → ``chain``（schema 14）、状态事件原因 ``new_chain_failed`` → ``decision_chain_failed``，存量不迁移。
**决策行上的不改**：``llm_solution.new_chain``（含 ``enforced``）与 phase ``new_chain`` —— 整份 ``llm_solution``
原样作推送报文的 ``comment`` 发给 ICOS，推送存档改不了，改名只能永久双读。链路按 2026-09-23 业务口径：

```
04 生成方案   每个方案组里按「方案与根因的关联性」寻优，并列都留 —— **不受合规链影响**
      ↓        输出：多个候选方案组，每组的最优方案，每个最优方案有多个可执行参数
05 根因对齐   模型判与收敛根因都不对应的方案不发（不剔到零，2026-10-03）
      ↓
07 参数风险评估   读参数规则库，逐参数做风险判断，**再对方案做调整**（按规则步长改写为一步 / 剔除）
      ↓
08 综合决策    同参数多值按 08 冲突剔除同一规则裁掉
      ↓
   是否满足决策条件（P4）── 满足 → 就是这一批
      │ 不满足
      ↓
   回环：按不满足项调优 / 剔除 → 复评，至多 MAX_LOOP_ROUNDS 轮；用尽仍不满足 → 整单转人工
```

本模块把这条链在本轮初案上算出来，落进 ``OrderDecision.chain``（:class:`ChainVerdict`）。

各步口径
--------
**04 组内寻优**（:func:`optimal_plans`）：取组内判为与根因关联的方案，并列都留。关联判定
没做（单方案组不判、两个根因字段都空不判、判定失败 bypass；判定本身恒开、不配开关）一律按关联 ——
fail-open，只窄化不扩展。判定把组内全判成不关联时也全留：窄化到零等于这组不发，
那不是「寻优」能做的决定。

**多轮决策**（重推理轮次才有，2026-09-25）：前几轮动过、短评估没通过的参数，在组内寻优之前就由多轮决策
接管 —— 承载的那一条按多轮决策阶梯发（缩步长 / 反向 / 回退，:mod:`services.decision.multi_round`），
同参数的其余条目与阶梯走完的参数不发（原因 ``上轮已调整且评估未通过``）。多轮决策的值从原值起算、
已在多轮决策里校验过，**不进 07 规则库调整与 P4 决策条件**（07 从现网值起算一步，会把它判方向不符、或改写回上一轮已判恶化的值）。

**05 根因对齐**（:func:`drop_by_alignment`，2026-10-03 业务）：04 选中的方案里，模型以网优专家身份判为
「与本单收敛根因都不对应」的不发（原因 ``根因对齐·不一致``）。只按模型判的剔（调用失败 / 没判到的按初案原因
兜底对上，只注记）；本单没有达到阈值的根因（根因不明）不剔；剔完一个可发的都不剩时全留 —— 不剔到零。

**07 规则库风险评估**（:func:`rule_outcome`）：最优方案的每个参数过一遍规则库 + 取值约束判定
（:func:`~services.decision.rule_assessment.assess_plan_feasibility`，确定性、不调模型，由调用方
算好传进来 —— 它要读规则库 CSV）。2026-09-30 起只用命中规则行的 ``para`` 与 ``rule_scope``
（:func:`services.compliance.rule_constraint.assess_constraint`），旧数值策略的硬域 / 半步取整 / 越域拉回整套退役：

==============================  ===========  ==============================================
规则库结论                        下场          说明
==============================  ===========  ==============================================
满足取值约束                      发 ICOS 值     单值等于 ``para``；区间类建议值正是现网值 + 一步
区间类、方向一致但不在一步上        发改写值       按 ``rule_scope`` 改写成现网值 + 一步（「按规则步长改写为一步」）
区间类、同类成功案例背书多步        发多步值       案例建议步数 N ≥ 2（案例库开着就算、没有开关，以 ICOS 建议为上限，
                                              :mod:`services.decision.case_steps`）→ 现网值 + N 步（「按案例幅度调整为多步」）
多值 / 带前缀区间 / 空 ``para``    发 ICOS 值     暂按建议值直通（业务 09-30）
不满足规则取值约束                 剔除          单值不等 / 一步后越出区间
调整方向与规则不符                 剔除          区间类建议方向与步长符号相反，或与现网值相同
现网已是目标值                    剔除          单值类现网已是 ``para``
参数值不可计算                    剔除          区间类现网值或建议值不是数
五元组匹配键不全                  剔除          记「规则库判否」，与「前置缺失」同口径
规则库无匹配                      发 ICOS 值     无硬约束可依，风险记为无约束（条件下发）
规则库判定失败                    发 ICOS 值     本模块之外坏了；fail-open（条件下发）
==============================  ===========  ==============================================

**08 冲突剔除**（:func:`~services.decision.arbitration.resolve_dispatch_conflicts`），在 07 调整之后的值上跑。

通用方案容忍度（待拍板 #2）**不进决策链**：2026-09-24 拍板通用路径不比专项更严，08 决策条件里
也整条删除（原判据按参数数「至多一条」，与「一个最优方案有多个可执行参数」矛盾）。

**P4 决策条件与回环**（即「轮内回环」，与跨轮的「多轮决策」相对；2026-09-24）：08 之后在决策链的下发集合上评估决策条件
（:mod:`services.decision.gate` 的封闭词表：硬约束 / 一致性·同参数多值 / 一致性·功能互斥 /
风险·余量 / 风险·分级；功能互斥与分级今天无供数、风险·余量只注记（2026-10-03），三条都「未评估」，不触发任何动作）。评估时每条按「落库会
怎么写这一行」拼出来（:func:`enforced_note`），最后一次评估（``ChainState.gate``）就是落库那批行的
决策条件注记。不满足就按
:data:`LOOP_BRANCH` 走分支 —— **按不满足项的类型定死，不交给模型**：硬约束 → 调优（按规则步长改写为一步，
改不了就剔除），其余 → 剔除（同参数多值按 08 冲突剔除的规则：冲突各方全部剔除）—— 然后复评。回环只回 08：
04 的寻优与 07 的规则库结论一轮只算一次，回环里变的只有下发集合本身。至多 :data:`MAX_LOOP_ROUNDS`
轮，用尽仍不满足 → :attr:`ChainVerdict.manual`，按 2026-09-24 拍板**整单不下发、转人工**
（``DecisionService`` 抛 ``DecisionConditionsUnmet``，worker 置 ``ReasoningFailed``）。

**06 方案一致性**（2026-09-28 业务，:func:`drop_by_review`）：决策条件回环之后，整单复核（模型，
``order_review``，恒做、恒按 demote，2026-10-03 起没有开关）判「指标存疑」的参数、批内
「方向冲突 / 功能互斥」的冲突各方不发；多轮决策接管的不管。复核失败或没判到的照发（fail-open）。它要模型的判断，
不在 :func:`run_chain` 这个纯组合入口里，由 ``DecisionService`` 的流水线在回环之后调。

07 当场改写 / 剔除、08 冲突剔除、回环里的调优 / 剔除、06 剔除都落 :attr:`ChainVerdict.iterations`
（``IterationTrace``，第 0 轮是首轮，第 1 轮起是回环）。07 已按规则库改写成合法一步、08 已剔过冲突，
「风险·余量」只注记不作闸门（业务 09-30：一步落在取值约束内即下发），所以**今天的条件在首轮就
恒满足**：回环是给分级 / 互斥供数之后准备的，那两条一旦能评估，不满足的参数直接走剔除分支。

边界
----
纯函数：不碰库、不读配置、不调模型。规则库结论由调用方传。**只给结论** —— 写进决策行的是
``DecisionService``，推送读的是 ``OrderDecision.actions`` 的准入态。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from services.compliance.rule_constraint import ConstraintReason, format_para_text_value
from services.decision.arbitration import DispatchEntry, resolve_dispatch_conflicts
from services.decision.candidate_set import Candidate, CandidateGroup, CandidatePlan, CandidateSet
from services.decision.case_steps import CASE_STEPS_REASON
from services.decision.gate import (
    ConditionStatus,
    GateAction,
    GateConditionName,
    GateEvaluation,
    evaluate_gate,
    gate_action_from_row,
)
from services.decision.order_review import CONFLICT_DIRECTION, CONFLICT_EXCLUSIVE, RELEVANCE_DOUBTFUL
from services.decision.plan_table import plan_key
from services.decision.prior_round import LEGACY_MULTI_ROUND_ACTION_LABELS, MULTI_ROUND_ACTION_LABELS, MultiRoundAction, parameter_key
from services.decision.relevance import CASE_SOURCE
from services.decision.risk import assess_action_risk
from services.decision.rule_assessment import FeasibilityShape, PlanFeasibility, assess_numeric_feasibility
from services.decision.verdict import CHAIN_MODE_ENFORCE, IterationTrace, ChainAction, ChainVerdict

#: 决策条件评估的签名（:func:`services.decision.gate.evaluate_gate`）。可注入只为一件事：
#: 分级 / 互斥供数之前，回环的「用尽 → 转人工」那条路今天的条件触发不了，用例要能验它。
ConditionEvaluator = Callable[..., GateEvaluation]


class ChainStage:
    """一个参数的下场由目标链路的哪一步定。"""

    SELECT = "04 组内寻优"
    #: 05 根因对齐：模型判与收敛根因都不对应的方案，剔除的（2026-10-03 业务）。
    ALIGN = "05 根因对齐"
    RISK = "07 参数风险评估"
    ARBITRATE = "08 综合决策"
    #: P4：08「是否满足决策条件」判不满足，回环里调优或剔除的。
    LOOP = "08 决策条件回环"
    #: 06 方案一致性（整单复核，demote 档）：指标存疑 / 批内冲突，剔除的（2026-09-28 业务）。
    REVIEW = "06 方案一致性"
    #: 多轮决策：短评估没通过之后，对动过的参数缩步长 / 反向 / 回退。
    MULTI_ROUND = "多轮决策（短评估未通过）"


class ChainReason:
    """封闭词表。前两个属于 04，``ALIGN_*`` 属于 05 根因对齐，``MULTI_ROUND_*`` 属于多轮决策，``CONFLICT`` 属于 08，
    ``LOOP_*`` 属于 P4 回环，``REVIEW_*`` 属于 06 方案一致性，其余属于 07。"""

    NOT_OPTIMAL = "非组内最优方案"
    #: 04 组内寻优：模型判为相关，但全部参数的同类案例都以恶化为主、同组另有相关方案（代码判，见
    #: ``relevance.apply_case_veto``，2026-09-27）。与「非组内最优」分开，界面与正文才说得清为什么没发。
    CASE_NEGATIVE = "同类案例反例为主"
    #: 05 根因对齐（2026-10-03 业务）：模型判这个方案与本单收敛根因都不对应，本单另有可发的方案时不发。
    #: 模型给的理由写在 ``detail``。
    ALIGN_INCONSISTENT = "根因对齐·不一致"
    #: 多轮决策：前几轮已经动过这个参数、短评估没通过，而阶梯已走完（或同参数由另一条承载），本轮不发。
    #: 与行 phase 的短原因（``plan_table`` 里 ``EXCLUDED_PRIOR_ROUND``）同一字面。
    PRIOR_DETERIORATED = "上轮已调整且评估未通过"
    #: 多轮决策三档，字面取 ``prior_round.MULTI_ROUND_ACTION_LABELS``（按 phase 出的准入标签同源）。
    MULTI_ROUND_SHRINK = MULTI_ROUND_ACTION_LABELS[MultiRoundAction.SHRINK]
    MULTI_ROUND_REVERSE = MULTI_ROUND_ACTION_LABELS[MultiRoundAction.REVERSE]
    MULTI_ROUND_ROLLBACK = MULTI_ROUND_ACTION_LABELS[MultiRoundAction.ROLLBACK]
    RULE_OK = "规则库校验通过"
    #: 07 按规则步长把 ICOS 多步建议值改写成一步（2026-09-30 起）。「按步长取整」/「拉回可调范围」
    #: 是 2026-09-30 前旧数值策略的两档（硬域退役后「拉回」不再可能），库里存量行还带着，
    #: 读的一侧不按字面判断它们 —— 词表整份保留。
    RULE_REWRITTEN = "按规则步长改写为一步"
    #: 07 按案例建议步数走了多步（2026-10-09，案例库开着才有证据可查，没有单独开关）：同类成功案例
    #: 背书、以 ICOS 建议为上限，见 :mod:`services.decision.case_steps`。走几步、为什么写在 ``detail``。
    RULE_CASE_STEPS = CASE_STEPS_REASON
    #: 以下两个是 2026-09-30 前旧词，新行不再产出（保留供存量行认读）。
    RULE_TUNED = "按步长取整"
    RULE_CLAMPED = "拉回可调范围"
    #: 2026-09-30 起规则取值约束判否的四档（与 :class:`ConstraintReason` 一一对应）。
    RULE_NOT_SATISFIED = "不满足规则取值约束"
    RULE_DIRECTION_MISMATCH = "调整方向与规则不符"
    AT_TARGET = "现网已是目标值"
    RULE_VALUE_INVALID = "参数值不可计算"
    TIGHT_MARGIN = "余量不足一步"
    RULE_REJECTED = "规则库判否"
    NO_RULE = "规则库无匹配"
    #: 以下五个属于开关 / 条件型规则（:mod:`services.decision.rule_condition`）。
    #: 2026-09-30 起 ``rule_condition`` 整体删除（新 ``rule_constraint`` 单值分支覆盖 ``!=X`` 语义，
    #: 新规则表无比较式 scope），这些词新行不再产出，保留供存量行认读。
    CONDITION_OK = "开关/条件规则校验通过"
    PRECONDITION_NOT_MET = "现网不满足前置条件"
    OUT_OF_DOMAIN = "建议值不在规则域内"
    RULE_UNREADABLE = "规则写法无法判读"
    RULE_CHECK_FAILED = "规则库判定失败"
    CONFLICT = "同参数冲突剔除"
    #: P4 回环：决策条件不满足，调优（按规则步长改写为一步）/ 剔除。没满足的是哪几条写在 ``detail``。
    LOOP_TUNED = "回环调优"
    LOOP_DROPPED = "回环剔除"
    #: 06 方案一致性（demote）：整单复核判「指标存疑」/ 批内「方向冲突」「功能互斥」的冲突各方，不发。
    #: 模型给的作用路径 / 冲突理由写在 ``detail``。
    REVIEW_DOUBTFUL = "整单复核·指标存疑"
    REVIEW_DIRECTION = "整单复核·方向冲突"
    REVIEW_EXCLUSIVE = "整单复核·功能互斥"


CHAIN_REASON_VOCAB: Tuple[str, ...] = (
    ChainReason.NOT_OPTIMAL,
    ChainReason.CASE_NEGATIVE,
    ChainReason.ALIGN_INCONSISTENT,
    ChainReason.PRIOR_DETERIORATED,
    ChainReason.MULTI_ROUND_SHRINK,
    ChainReason.MULTI_ROUND_REVERSE,
    ChainReason.MULTI_ROUND_ROLLBACK,
    ChainReason.RULE_OK,
    ChainReason.RULE_REWRITTEN,
    ChainReason.RULE_CASE_STEPS,
    #: 以下两个是 2026-09-30 前旧词（硬域时期 ④ / ③ 分支），新行不再产出。
    ChainReason.RULE_TUNED,
    ChainReason.RULE_CLAMPED,
    ChainReason.RULE_NOT_SATISFIED,
    ChainReason.RULE_DIRECTION_MISMATCH,
    ChainReason.AT_TARGET,
    ChainReason.RULE_VALUE_INVALID,
    ChainReason.TIGHT_MARGIN,
    ChainReason.RULE_REJECTED,
    ChainReason.NO_RULE,
    ChainReason.CONDITION_OK,
    ChainReason.PRECONDITION_NOT_MET,
    ChainReason.OUT_OF_DOMAIN,
    ChainReason.RULE_UNREADABLE,
    ChainReason.RULE_CHECK_FAILED,
    ChainReason.CONFLICT,
    ChainReason.LOOP_TUNED,
    ChainReason.LOOP_DROPPED,
    ChainReason.REVIEW_DOUBTFUL,
    ChainReason.REVIEW_DIRECTION,
    ChainReason.REVIEW_EXCLUSIVE,
    #: 以下三个是 2026-10-03 前多轮决策三档的旧字面（「外环缩步长」等），新行不再产出。
    *LEGACY_MULTI_ROUND_ACTION_LABELS.values(),
)

#: 06 整单复核的依据（``order_review.review_demotions`` 给的封闭词）→ 决策链原因。
_REVIEW_REASON: Dict[str, str] = {
    RELEVANCE_DOUBTFUL: ChainReason.REVIEW_DOUBTFUL,
    CONFLICT_DIRECTION: ChainReason.REVIEW_DIRECTION,
    CONFLICT_EXCLUSIVE: ChainReason.REVIEW_EXCLUSIVE,
}

#: 多轮决策动作 → 决策链原因。
_MULTI_ROUND_REASON: Dict[str, str] = {
    MultiRoundAction.SHRINK: ChainReason.MULTI_ROUND_SHRINK,
    MultiRoundAction.REVERSE: ChainReason.MULTI_ROUND_REVERSE,
    MultiRoundAction.ROLLBACK: ChainReason.MULTI_ROUND_ROLLBACK,
}

#: 首轮（第 0 轮）里 07 改了值的那几种原因 —— 记成 ``tune`` 迭代。
_ROUND0_TUNES = frozenset({ChainReason.RULE_REWRITTEN, ChainReason.RULE_TUNED, ChainReason.RULE_CLAMPED})

#: 首轮（第 0 轮）里 07 把参数剔掉的那几种原因 —— 记成 ``drop`` 迭代。
_ROUND0_DROPS = frozenset({
    ChainReason.RULE_NOT_SATISFIED,
    ChainReason.RULE_DIRECTION_MISMATCH,
    ChainReason.AT_TARGET,
    ChainReason.RULE_VALUE_INVALID,
    ChainReason.TIGHT_MARGIN,
    ChainReason.RULE_REJECTED,
    ChainReason.PRECONDITION_NOT_MET,
    ChainReason.OUT_OF_DOMAIN,
    ChainReason.CONFLICT,
})


class LoopAction:
    """``IterationTrace.action`` 的取值。"""

    TUNE = "tune"
    DROP = "drop"


#: P4 回环最多几轮（方案建议 2）。第 0 轮是首轮决策，回环从第 1 轮算；用尽仍不满足 → 整单转人工。
MAX_LOOP_ROUNDS = 2

#: 决策条件不满足时走哪个分支 —— 方案 P4「回环的两个分支怎么分」：**按不满足项的类型定死，
#: 不交给模型**。一个参数同时不满足几条时，只要有一条要剔除就剔除。
LOOP_BRANCH: Dict[str, str] = {
    #: 下发值不是合法一步：能按规则步长改写为一步就改值，改不了才降级为剔除。
    GateConditionName.HARD_CONSTRAINT: LoopAction.TUNE,
    #: 冲突是成对的，调值改不掉 —— 按 08 冲突剔除同一规则：冲突各方全部剔除（不择优）。
    GateConditionName.SAME_PARAM: LoopAction.DROP,
    GateConditionName.MUTUAL_EXCLUSION: LoopAction.DROP,
    #: 余量不足一步：2026-10-03 起只注记（gate 记「未评估」），这一支不会走到；留着让词表与分支一一对应。
    GateConditionName.RISK_MARGIN: LoopAction.DROP,
    GateConditionName.RISK_GRADE: LoopAction.DROP,
}

#: 发出去、但没经过任何规则校验的那几种原因 —— 对应准入态 ``admitted_unchecked``
#: （整单判定里的「条件下发」）。其余发出去的都经过了规则库（``para`` / ``rule_scope`` 取值约束判定）。
UNCHECKED_REASONS = frozenset({
    ChainReason.NO_RULE,
    ChainReason.RULE_UNREADABLE,
    ChainReason.RULE_CHECK_FAILED,
})

def enforced_note(
    *, stage: str, reason: str, detail: str, dispatched: bool, feasibility: Optional[PlanFeasibility]
) -> Dict[str, Any]:
    """写进决策行 ``llm_solution.new_chain`` 的那一块。

    **一份定义两处用**：``DecisionService._apply_chain`` 照它落库；P4 回环评估决策条件时照它拼出
    「落库会怎么写这一行」，再交给 07 风险注记与 08 决策条件同一组函数 —— 回环判的与落库后
    注记判的因此不可能是两个说法。键名 ``enforced`` 沿用 P6 enforce 档时期（``plan_table.enforced_chain``
    认它），合规链删除之后每一行都带它。
    """
    note: Dict[str, Any] = {
        "enforced": True,
        "stage": stage,
        "reason": reason,
        "detail": detail,
        "unchecked": dispatched and reason in UNCHECKED_REASONS,
    }
    if feasibility is not None:
        note["rule"] = feasibility.rule_basis()
    return note


#: 规则取值约束判否（:class:`ConstraintReason`）→ 决策链原因（2026-09-30 起的四档）。
_CONSTRAINT_REJECT_REASON = {
    ConstraintReason.NOT_SATISFIED: ChainReason.RULE_NOT_SATISFIED,
    ConstraintReason.DIRECTION_MISMATCH: ChainReason.RULE_DIRECTION_MISMATCH,
    ConstraintReason.AT_TARGET: ChainReason.AT_TARGET,
    ConstraintReason.VALUE_INVALID: ChainReason.RULE_VALUE_INVALID,
}


def _value(raw: Any) -> str:
    return format_para_text_value(raw) or ""


# --------------------------------------------------------------------------- #
# 04
# --------------------------------------------------------------------------- #
def optimal_plans(group: CandidateGroup) -> Tuple[CandidatePlan, ...]:
    """04 组内寻优：与根因关联的方案，并列都留；没判的按关联；全判不关联时全留。"""
    relevant = tuple(plan for plan in group.plans if plan.relevant)
    return relevant or group.plans


# --------------------------------------------------------------------------- #
# 07
# --------------------------------------------------------------------------- #
def rule_outcome(
    feasibility: Optional[PlanFeasibility], *, f_para: Any, b_para: Any
) -> Tuple[bool, str, str, str]:
    """07 规则库风险评估：一个参数的 ``(发不发, 发什么值, 原因, 说明)``。规则见模块文档。

    2026-09-30 起判定只用 ``para`` 与 ``rule_scope``（:func:`assess_constraint`），硬域与开关 /
    条件型规则（``rule_condition``）整套退役：改值一律是「按规则步长改写为一步」，
    剔除是四档（不满足取值约束 / 调整方向与规则不符 / 现网已是目标值 / 参数值不可计算）。
    """
    icos_value = _value(b_para)
    if feasibility is None:
        return True, icos_value, ChainReason.RULE_CHECK_FAILED, ""
    shape = feasibility.shape
    if shape == FeasibilityShape.DISPATCHABLE:
        # 按案例建议步数走了多步（with_case_steps 重算过）：等于 ICOS 建议也记这一档 —— 不按一步压是因为有案例背书。
        if feasibility.steps > 1 and feasibility.case_steps is not None:
            return True, _value(feasibility.final_b_para), ChainReason.RULE_CASE_STEPS, feasibility.case_steps.summary()
        if feasibility.value_changed:
            return True, _value(feasibility.final_b_para), ChainReason.RULE_REWRITTEN, ""
        return True, icos_value, ChainReason.RULE_OK, ""
    if shape == FeasibilityShape.REJECTED:
        reason = (
            _CONSTRAINT_REJECT_REASON.get(feasibility.constraint.reason)
            if feasibility.constraint is not None
            else None
        ) or ChainReason.RULE_REJECTED
        detail = feasibility.constraint.summary if feasibility.constraint is not None else ""
        return False, "", reason, detail
    if shape == FeasibilityShape.RULE_NOT_MATCHED:
        return True, icos_value, ChainReason.NO_RULE, ""
    return True, icos_value, ChainReason.RULE_CHECK_FAILED, ""


# --------------------------------------------------------------------------- #
# 决策链：四步，每一步读写同一份 ChainState
# --------------------------------------------------------------------------- #
@dataclass
class ChainState:
    """决策链一轮的中间状态。四步（:func:`select_plans` → :func:`assess_rules` → :func:`drop_conflicts`
    → :func:`resolve_conditions`）依次读写它，最后 :meth:`verdict` 收成 :class:`ChainVerdict`。

    ``decided`` 是每条初案参数一个条目（与 ``ChainAction`` 同形的 dict），``context`` 是条目键 →
    ``(初案条目, 规则库结论)``（回环评估决策条件与调优要用，不进 ChainAction）。
    """

    decided: List[Dict[str, Any]] = field(default_factory=list)
    context: Dict[str, Tuple[Candidate, Optional[PlanFeasibility]]] = field(default_factory=dict)
    notes: List[str] = field(default_factory=list)
    iterations: List[IterationTrace] = field(default_factory=list)
    loop_rounds: int = 0
    conditions_unmet: Tuple[str, ...] = ()
    #: 回环最后一次评估 —— 也就是**最终下发集合**的决策条件评估（:func:`resolve_conditions` 写）。
    #: ``DecisionService`` 直接拿它落轨迹与裁决对象的 ``gate``，不再对同一批行重算一遍。
    gate: Optional[GateEvaluation] = None

    @property
    def dispatched(self) -> int:
        return sum(1 for entry in self.decided if entry.get("dispatched"))

    def count(self, reason: str) -> int:
        return sum(1 for entry in self.decided if entry.get("reason") == reason)

    def verdict(self) -> ChainVerdict:
        """四步都走完之后的结论。还有没过 07 的条目（``assess_rules`` 没跑）就是调用方用错了。"""
        pending = [entry["key"] for entry in self.decided if entry.get(_PENDING)]
        if pending:
            raise RuntimeError(f"决策链还有 {len(pending)} 条没过 07 参数风险评估：{pending[:5]}")
        return ChainVerdict(
            evaluated=True,
            mode=CHAIN_MODE_ENFORCE,
            actions=tuple(ChainAction(**entry) for entry in self.decided),
            notes=tuple(self.notes),
            iterations=tuple(self.iterations),
            loop_rounds=self.loop_rounds,
            conditions_unmet=self.conditions_unmet,
        )


#: 条目上的临时标记：04 选中、等 07 判。:func:`assess_rules` 判完即摘掉。
_PENDING = "_pending"


def select_plans(
    candidates: CandidateSet,
    rows: Sequence[Mapping[str, Any]] = (),
    *,
    multi_round: Optional[Mapping[str, Mapping[str, Any]]] = None,
) -> ChainState:
    """**04 组内寻优**（多轮决策接管的参数先排出去）：每条初案参数一个条目。

    * 多轮决策接管的参数（``multi_round``：``prior_round.parameter_key → {kind, value, detail, carrier_key}``，
      ``multi_round.chain_view`` 产出）：承载那一条按多轮决策的值发，同参数其余条目与阶梯走完的不发；
      多轮决策的值不进 07 与决策条件（见模块文档）；
    * 非组内最优方案（:func:`optimal_plans`）：整方案不发；
    * 其余：选中，等 07 判（:func:`assess_rules`）。

    ``rows`` 是本轮的草稿决策行，只用来取 ``agent_decision_id``（条目键，结论按它写回行）；
    没有草稿行时键退回对齐键。
    """
    multi_round = multi_round or {}
    rows_by_key: Dict[str, Mapping[str, Any]] = {}
    for row in rows:
        rows_by_key.setdefault(plan_key(row.get("execution_id"), row.get("tool")), row)

    state = ChainState()
    unjudged = unrelated = 0
    multi_round_counts: Dict[str, int] = {}
    for group in candidates.groups:
        optimal = {id(plan) for plan in optimal_plans(group)}
        if len(group.plans) > 1 and all(plan.relevance is None for plan in group.plans):
            unjudged += 1
        elif len(group.plans) > 1 and not any(plan.relevant for plan in group.plans):
            unrelated += 1
        for plan in group.plans:
            for item in plan.items:
                row = rows_by_key.get(item.key) or {}
                entry: Dict[str, Any] = {
                    "key": str(row.get("agent_decision_id") or item.key),
                    "plan_key": item.key,
                    "parachinname": item.parachinname,
                    "group_key": group.key,
                    "plan_number": plan.plan_number or "",
                }
                step = multi_round.get(parameter_key(item.parachinname))
                if step is not None:
                    kind = str(step.get("kind") or "")
                    if kind in _MULTI_ROUND_REASON and step.get("carrier_key") == item.key:
                        entry.update(stage=ChainStage.MULTI_ROUND, reason=_MULTI_ROUND_REASON[kind], dispatched=True,
                                     value=_value(step.get("value")), detail=str(step.get("detail") or ""))
                        multi_round_counts[kind] = multi_round_counts.get(kind, 0) + 1
                    else:
                        entry.update(stage=ChainStage.SELECT, reason=ChainReason.PRIOR_DETERIORATED,
                                     dispatched=False, value="", detail=str(step.get("detail") or ""))
                        if kind == MultiRoundAction.NONE:
                            multi_round_counts[kind] = multi_round_counts.get(kind, 0) + 1
                elif id(plan) not in optimal:
                    if plan.relevance is not None and plan.relevance.source == CASE_SOURCE:
                        entry.update(stage=ChainStage.SELECT, reason=ChainReason.CASE_NEGATIVE, dispatched=False,
                                     value="", detail=plan.relevance.reason)
                    else:
                        entry.update(stage=ChainStage.SELECT, reason=ChainReason.NOT_OPTIMAL, dispatched=False, value="")
                else:
                    entry.update(stage=ChainStage.RISK, **{_PENDING: True})
                state.context[entry["key"]] = (item, None)
                state.decided.append(entry)
    if unjudged:
        state.notes.append(f"04 组内寻优：{unjudged} 个多方案组没有关联判定（工单无根因或判定失败），组内方案全部保留")
    if unrelated:
        state.notes.append(f"04 组内寻优：{unrelated} 个多方案组判为全组与根因不直接相关，按通用方案路径全部保留")
    if multi_round_counts:
        parts = [f"{MULTI_ROUND_ACTION_LABELS[kind]} {n} 个" for kind, n in multi_round_counts.items() if kind in MULTI_ROUND_ACTION_LABELS]
        if multi_round_counts.get(MultiRoundAction.NONE):
            parts.append(f"阶梯走完不再调 {multi_round_counts[MultiRoundAction.NONE]} 个")
        state.notes.append("多轮决策（前几轮调过、短评估未通过）：" + "、".join(parts))
    return state


def drop_by_alignment(state: ChainState, drops: Mapping[str, str]) -> Tuple[List[str], bool]:
    """**05 根因对齐**（2026-10-03 业务）：模型判「与本单收敛根因都不对应」的方案不发。

    ``drops`` 是 ``plan_key → 模型给的理由``（``CauseAlignment.plan_demotions`` 给，只含模型判的「不一致」、
    且本单有采信根因）。跑在 04 组内寻优之后、07 之前：只动 04 选中、等 07 判的条目 —— 04 已经不发的无所谓剔，
    多轮决策接管的值按上轮评估给（回退更是恢复原值），与 06 同理不受它管。

    **不剔到零**（业务 10-03，同 04「全组都不关联时组内全留」）：剔完本单一个可发的都不剩（剩下的全是不一致），
    就一条不剔、记一条注记，照常走 07 / 08。返回 ``(被剔的条目键, 是否因不剔到零而全留)``。
    """
    alive = [entry for entry in state.decided if entry.get(_PENDING) or entry.get("dispatched")]
    hits = [entry for entry in alive if entry.get(_PENDING) and entry["plan_key"] in drops]
    if not hits:
        return [], False
    if len(hits) == len(alive):
        state.notes.append(
            f"05 根因对齐：剩下的 {len(hits)} 条全部与收敛根因不一致，不剔到零、全部保留（照常过 07 / 08）"
        )
        return [], True
    for entry in hits:
        entry.pop(_PENDING, None)
        entry.update(
            stage=ChainStage.ALIGN, reason=ChainReason.ALIGN_INCONSISTENT, dispatched=False, value="",
            detail=drops[entry["plan_key"]],
        )
    state.notes.append(f"05 根因对齐：与收敛根因不一致的 {len(hits)} 条不发")
    return [entry["key"] for entry in hits], False


def assess_rules(state: ChainState, feasibility: Mapping[str, PlanFeasibility]) -> None:
    """**07 参数风险评估**：04 选中的每个参数过一遍规则库结论（:func:`rule_outcome`，改写为一步 / 剔除 /
    直通 / 无规则照发）。``feasibility`` 是 ``plan_key → 规则库结论``（调用方算好，缺了按
    「规则库判定失败」照发）。每个条目都挂上它的规则库结论（回环复核与调优要用）。"""
    for entry in state.decided:
        item, _ = state.context[entry["key"]]
        state.context[entry["key"]] = (item, feasibility.get(item.key))
        if entry.pop(_PENDING, False):
            dispatched, value, reason, detail = rule_outcome(
                feasibility.get(item.key), f_para=item.f_para, b_para=item.b_para
            )
            entry.update(reason=reason, dispatched=dispatched, value=value, detail=detail)


def drop_conflicts(state: ChainState) -> None:
    """**08 综合决策 · 同参数冲突剔除**：在 07 调整之后的值上，同一参数两个以上不同目标值 → 冲突各方
    全部不发（不择优）。随后把首轮（第 0 轮）07 / 08 做过的调整显性化进 ``iterations``。"""
    dropped = _conflict_losers(state.decided)
    for entry in state.decided:
        if entry["key"] in dropped:
            entry.update(stage=ChainStage.ARBITRATE, reason=ChainReason.CONFLICT, dispatched=False, value="")
    state.iterations = _round0_iterations(state.decided, state.context)


def resolve_conditions(
    state: ChainState,
    *,
    enforce_step_direction: bool = True,
    evaluate_conditions: ConditionEvaluator = evaluate_gate,
) -> None:
    """**08 是否满足决策条件 + 回环**：不满足就按 :data:`LOOP_BRANCH` 调优或剔除、复评，至多
    :data:`MAX_LOOP_ROUNDS` 轮；用尽仍不满足记进 ``conditions_unmet``（→ :attr:`ChainVerdict.manual`，
    整单转人工）。``enforce_step_direction`` 是算规则库结论时用的同一个方向开关。
    最后一次评估留在 ``state.gate`` —— 它评的就是最终下发集合。"""

    def _evaluate() -> GateEvaluation:
        return evaluate_conditions(
            _gate_actions(state.decided, state.context), enforce_step_direction=enforce_step_direction
        )

    gate = _evaluate()
    while gate.would_block and state.loop_rounds < MAX_LOOP_ROUNDS:
        state.loop_rounds += 1
        state.iterations.extend(
            _apply_branches(
                state.decided, state.context, gate, state.loop_rounds, enforce_step_direction=enforce_step_direction
            )
        )
        gate = _evaluate()
    if state.loop_rounds:
        state.notes.append(
            f"08 决策条件回环跑了 {state.loop_rounds} 轮"
            + (f"，仍不满足：{'、'.join(gate.failed_conditions)} —— 整单转人工" if gate.would_block else "，复评满足")
        )
    state.conditions_unmet = gate.failed_conditions
    state.gate = gate


def drop_by_review(
    state: ChainState,
    drops: Mapping[str, Tuple[str, str]],
    *,
    enforce_step_direction: bool = True,
    evaluate_conditions: ConditionEvaluator = evaluate_gate,
) -> List[str]:
    """**06 方案一致性 · demote**（2026-09-28 业务）：整单复核判「指标存疑」的参数、批内「方向冲突 /
    功能互斥」的冲突各方 → 不发。返回被剔掉的条目键。

    ``drops`` 是 ``plan_key → (依据, 说明)``（``order_review.review_demotions``），依据按 :data:`_REVIEW_REASON`
    翻成决策链原因。只动**已下发、不归多轮决策**的条目：没发的无所谓剔，多轮决策的值是按上轮评估给的
    （回退更是恢复原值），与 07 / 08 同理不受它管。

    剔除只减不增，不会让已满足的决策条件变成不满足；剔了东西就对剩下的下发集合重评一次，
    ``state.gate`` 仍是最终下发集合的那一份。剔除记进 ``iterations``（第 0 轮，属首轮决策）与 ``notes``。
    """
    dropped: List[str] = []
    counts: Dict[str, int] = {}
    for entry in state.decided:
        hit = drops.get(entry["plan_key"])
        reason = _REVIEW_REASON.get(hit[0]) if hit else None
        if reason is None or not entry["dispatched"] or entry["stage"] == ChainStage.MULTI_ROUND:
            continue
        before = entry["value"]
        entry.update(stage=ChainStage.REVIEW, reason=reason, dispatched=False, value="", detail=hit[1])
        state.iterations.append(IterationTrace(
            round_index=0, action=LoopAction.DROP, key=entry["key"], parachinname=entry["parachinname"],
            before=before, after="", reason=reason,
        ))
        dropped.append(entry["key"])
        counts[reason] = counts.get(reason, 0) + 1
    if dropped:
        state.notes.append(
            f"06 方案一致性：整单复核剔除 {len(dropped)} 条（"
            + "、".join(f"{reason.removeprefix('整单复核·')} {n}" for reason, n in counts.items()) + "）"
        )
        state.gate = evaluate_conditions(
            _gate_actions(state.decided, state.context), enforce_step_direction=enforce_step_direction
        )
    return dropped


def run_chain(
    candidates: CandidateSet,
    rows: Sequence[Mapping[str, Any]],
    feasibility: Mapping[str, PlanFeasibility],
    *,
    enforce_step_direction: bool = True,
    evaluate_conditions: ConditionEvaluator = evaluate_gate,
    multi_round: Optional[Mapping[str, Mapping[str, Any]]] = None,
) -> ChainVerdict:
    """整条决策链一次跑完：04 组内寻优 → 07 参数风险评估 → 08 冲突剔除 → 决策条件回环。

    与 ``DecisionService`` 的流水线逐步调用的是**同四个函数**（那边每一步单独记轨迹）；这里是给
    只要结论的调用方（用例、离线分析）的组合入口。参数说明见各步。
    """
    state = select_plans(candidates, rows, multi_round=multi_round)
    assess_rules(state, feasibility)
    drop_conflicts(state)
    resolve_conditions(state, enforce_step_direction=enforce_step_direction, evaluate_conditions=evaluate_conditions)
    return state.verdict()


# --------------------------------------------------------------------------- #
# P4：决策条件与回环
# --------------------------------------------------------------------------- #
def _conflict_losers(decided: Sequence[Mapping[str, Any]]) -> set:
    """08 同参数冲突剔除（与现行 08 同一个函数）在当前下发集合上要拿掉的条目键。"""
    return {
        key
        for resolution in resolve_dispatch_conflicts(
            [
                DispatchEntry(
                    key=entry["key"],
                    parachinname=entry["parachinname"],
                    value=entry["value"],
                )
                for entry in decided
                if entry["dispatched"]
            ]
        )
        for key in resolution.dropped_keys
    }


def _round0_iterations(
    decided: Sequence[Mapping[str, Any]], context: Mapping[str, Tuple[Candidate, Optional[PlanFeasibility]]]
) -> List[IterationTrace]:
    """首轮（第 0 轮）的调整：07 改写 / 剔除、08 冲突剔除。04 没选上的不算（那是寻优，不是调整）。"""
    out: List[IterationTrace] = []
    for entry in decided:
        item, _feasibility = context[entry["key"]]
        # 按案例建议步数走多步的：只有改了 ICOS 建议值才算一次调优（正好等于建议值就是原样下发）。
        case_tuned = entry["reason"] == ChainReason.RULE_CASE_STEPS and entry["value"] != _value(item.b_para)
        if entry["reason"] in _ROUND0_TUNES or case_tuned:
            action, after = LoopAction.TUNE, entry["value"]
        elif entry["reason"] in _ROUND0_DROPS:
            action, after = LoopAction.DROP, ""
        else:
            continue
        out.append(IterationTrace(
            round_index=0, action=action, key=entry["key"], parachinname=entry["parachinname"],
            before=_value(item.b_para), after=after, reason=entry["reason"],
        ))
    return out


def _gate_actions(
    decided: Sequence[Mapping[str, Any]], context: Mapping[str, Tuple[Candidate, Optional[PlanFeasibility]]]
) -> List[GateAction]:
    """当前下发集合 → 08 决策条件的输入。

    每条按「落库会怎么写这一行」拼出来（:func:`enforced_note`），交给 07 风险注记
    （``assess_action_risk``）与 08 决策条件（``gate_action_from_row``）**同一组函数** ——
    所以最后一次评估就是对落库那批行的评估，``DecisionService`` 直接拿 ``state.gate`` 落注记。
    """
    actions: List[GateAction] = []
    for entry in decided:
        # 多轮决策的值从原值起算、已在多轮决策里校验过 —— 一步策略的硬约束会把它判越步长（见模块文档）。
        if not entry["dispatched"] or entry["stage"] == ChainStage.MULTI_ROUND:
            continue
        item, feasibility = context[entry["key"]]
        row = {
            "agent_decision_id": entry["key"],
            "tool": entry["parachinname"],
            "f_para": _value(item.f_para),
            "org_b_para": _value(item.b_para),
            "b_para": entry["value"],
            "need_call_parameter_platform": "是",
            "llm_solution": {"new_chain": enforced_note(
                stage=entry["stage"], reason=entry["reason"], detail=entry.get("detail", ""),
                dispatched=True, feasibility=feasibility,
            )},
        }
        actions.append(gate_action_from_row(row, key=entry["key"], risk=assess_action_risk(row)))
    return actions


def _apply_branches(
    decided: List[Dict[str, Any]],
    context: Mapping[str, Tuple[Candidate, Optional[PlanFeasibility]]],
    gate: GateEvaluation,
    round_index: int,
    *,
    enforce_step_direction: bool,
) -> List[IterationTrace]:
    """一轮回环：按 :data:`LOOP_BRANCH` 对不满足项调优或剔除，就地改 ``decided``，返回这一轮的迭代。"""
    failed: Dict[str, List[str]] = {}
    for check in gate.conditions:
        if check.status == ConditionStatus.FAILED:
            for key in check.failed_keys:
                failed.setdefault(key, []).append(check.name)
    # 同参数多值：冲突集里谁该剔由 08 冲突剔除的规则定（成对的，不是每个成员都剔）。
    if GateConditionName.SAME_PARAM in gate.failed_conditions:
        losers = _conflict_losers(decided)
        for key in list(failed):
            if GateConditionName.SAME_PARAM in failed[key] and key not in losers:
                failed[key].remove(GateConditionName.SAME_PARAM)

    out: List[IterationTrace] = []
    for entry in decided:
        names = failed.get(entry["key"])
        if not entry["dispatched"] or not names:
            continue
        item, feasibility = context[entry["key"]]
        why = "、".join(names)
        before = entry["value"]
        after = how = ""
        if all(LOOP_BRANCH.get(name) == LoopAction.TUNE for name in names):
            fact = feasibility.rule_row.raw if feasibility is not None and feasibility.rule_row is not None else {}
            # 步数沿用 07 的结论（按案例建议走多步的照旧多步，不在回环里被压回一步）。
            tuned = assess_numeric_feasibility(
                fact, f_para=item.f_para, b_para=before, enforce_step_direction=enforce_step_direction,
                steps=feasibility.steps if feasibility is not None else 1,
            )
            if tuned.shape == FeasibilityShape.DISPATCHABLE and tuned.value_changed:
                after, how = _value(tuned.final_b_para), ChainReason.RULE_REWRITTEN
        if after:
            entry.update(stage=ChainStage.LOOP, reason=ChainReason.LOOP_TUNED, value=after,
                         detail=f"第 {round_index} 轮回环：{why}不满足，{how}")
            action = LoopAction.TUNE
        else:
            entry.update(stage=ChainStage.LOOP, reason=ChainReason.LOOP_DROPPED, dispatched=False, value="",
                         detail=f"第 {round_index} 轮回环：{why}不满足，剔除")
            action = LoopAction.DROP
        out.append(IterationTrace(
            round_index=round_index, action=action, key=entry["key"], parachinname=entry["parachinname"],
            before=before, after=after, reason=why,
        ))
    return out


__all__ = [
    "ChainState",
    "LOOP_BRANCH",
    "MAX_LOOP_ROUNDS",
    "LoopAction",
    "CHAIN_REASON_VOCAB",
    "UNCHECKED_REASONS",
    "ChainReason",
    "ChainStage",
    "enforced_note",
    "optimal_plans",
    "assess_rules",
    "drop_by_alignment",
    "drop_by_review",
    "drop_conflicts",
    "resolve_conditions",
    "rule_outcome",
    "select_plans",
    "run_chain",
]
