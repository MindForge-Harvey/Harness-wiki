"""决策步 07 参数风险评估 —— **规则库的确定性结论**（规则五元组匹配 + 取值约束判定）。

一条 ICOS 初案参数进来，用纯代码跑一遍「规则五元组匹配 + ``para`` / ``rule_scope`` 取值约束判定」
（:func:`services.compliance.rule_constraint.assess_constraint`），回答「这条到底能不能下发、发什么值」。
能判死的判死，判不了的明说判不了。

归属与名字（2026-09-24 从 ``plan_feasibility`` 改名）
---------------------------------------------------
本模块诞生时挂在**决策步 04 生成方案**，角色是「预判」（annotate，只落轨迹）。业务 2026-09-23
口径定为「**参数规则库的校验放在 07 参数风险评估**，由 07 读规则库对方案做调整」之后，它的结论
成了决策链 07 的依据（:func:`services.decision.chain.rule_outcome`），还落进决策行
（:meth:`PlanFeasibility.rule_basis`），所以归到 07、改了名。2026-09-25 合规链删除后，它是参数
规则库校验的**唯一**实现。其余几处是**消费**它的结论：04 候选集（``Candidate.feasibility``）、
08 决策条件（``assess_numeric_feasibility`` 复核实际下发值）。当年「判死的不问合规链模型」的
``plan_feasibility_skip`` 开关已随合规链删除。

**改的只是模块名与步骤归属，落库与配置的名字刻意没动**（改了就是同一份数据两个名字、或现场配置静默失效）：

=========================================  =========================================
沿用旧名的                                  在哪
=========================================  =========================================
``plan_feasibility``（:data:`PERSISTED_KEY`）  决策轨迹 ``decision_trace_json`` 的注记键；``skipped_infeasible``
                                           行的 ``llm_solution`` 键
``plan_feasibility_code``                  注记里的 ``source``（:data:`FEASIBILITY_SOURCE_CODE`）
=========================================  =========================================

类名（``PlanFeasibility`` / ``FeasibilityShape`` …）不带步骤编号，没改。告警前缀与出处串
（:data:`PLAN_FEASIBILITY_BASIS`）带着步骤编号，改成了 07 —— 改名前落库的行里仍是「04 生成方案」。

事前预演 vs 事后转写（**与 action_facts 的边界，先看这一段**）
--------------------------------------------------------------
本模块与 :mod:`~services.decision.action_facts` 都讲锚点 / 步长 / 一步候选 / 域内余量。
**区别不在内容，在角色**：

================  ==========================================  ==========================================
                  ``action_facts``                            ``rule_assessment``（本模块）
================  ==========================================  ==========================================
时机                决策行**写好之后**                            决策行**还不存在时**
数据                读决策行上的一步依据（``plan_table.rule_basis``）  只有初案、工单与规则库
角色                **转写**既成事实                               **亲自预演** 一遍策略
================  ==========================================  ==========================================

不把这段写在最前面，三个月后它就会变成包里第三个讲步长的模块。

判得出与判不出
--------------
2026-09-30 起规则表换成 ``sys_cell_execute_jiangsu.csv``，判定只用命中规则行的 ``para``（取值约束）
与 ``rule_scope``（带符号步长），原数值一步策略（硬域、半步取整、越域拉回）整套退役。
``assess_constraint`` 对**每一条命中规则的参数都给确定结论**（可下发 / 判否，多值与带前缀区间按
ICOS 建议值直通），没有「约束不可解析」的早退分支。判不出的只剩两种：规则库无匹配
（:data:`FeasibilityShape.RULE_NOT_MATCHED`，照 ICOS 原值发、记「未经规则校验」）与本模块自己坏了
（:data:`FeasibilityShape.FAILED`）。

（2026-09-20 旧策略下的实测分布 —— 195 条里确定结论只占 35.4%、「约束不可解析」55 条 —— 已不适用；
脚本 ``scripts/ops/probe_04_deterministic.py`` 名字里的 04 是本模块诞生时的归属。）

依赖方向（**它不是纯叶子，别照 convergence 的样子用**）
-------------------------------------------------------
* :mod:`~services.decision.convergence` 是纯叶子（只 import ``services.common.text_utils``）。
  **本模块不是**：:func:`assess_plan_feasibility` → ``match_rule_row`` → ``load_rules()``
  → 读 settings + 规则库 CSV（按 (路径, mtime) 缓存）。**带配置与文件 IO。**
  白名单本身放行 ``services.compliance``，**没有任何用例会替你提醒这件事**。
* 因此本模块切成两层：:func:`assess_numeric_feasibility` 是**纯函数本体**（无 IO、
  无 settings，规则事实由调用方给），:func:`assess_plan_feasibility` 是**外层**
  （做匹配、兜异常）。单测的绝大部分打在本体上，不依赖挂载的规则库。
* 依赖方向是 ``rule_assessment → verdict``（要 ``RuleRow`` / ``StepBasis``），
  **与 convergence 相反**（那边是 ``verdict → convergence``）。``verdict`` 不得反向
  import 本模块，否则成环。

边界
----
本模块只给**行级**结论、**不碰库、不碰控制流**：谁拿结论做什么（07 调整方案、落决策行）
是调用方的事。计数与分布由脚本自己做（``scripts/ops/probe_04_deterministic.py``，
名字里的 04 是它诞生时的归属）。
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Dict, List, Mapping, Optional, Tuple

from services.common.text_utils import _text
from services.compliance.rule_constraint import (
    ConstraintReason,
    ConstraintResult,
    assess_constraint,
    format_para_text_value,
    parse_scalar_float,
)
from services.compliance.rule_library import (
    RuleMatchFailed,
    RuleNotMatched,
    match_rule_row,
    rule_fact_snapshot,
)
from services.decision.case_steps import CaseStepAdvice
from services.decision.verdict import RuleRow, StepBasis

# --------------------------------------------------------------------------- #
# 词表与常量
# --------------------------------------------------------------------------- #

#: warning 的机读前缀。编号带名字 —— 决策步 07 是「参数风险评估」，展示层 07 节却是「方案一致性」，
#: 只写数字会被读错。改名（2026-09-24）前是「04 生成方案：」，库里老行仍是那个前缀。
_WARN_PREFIX: str = "07 参数风险评估："
_WARN_MAX_LEN: int = 500
_WARN_MAX_COUNT: int = 20


class FeasibilityShape:
    """形态五档。**存储位**，与探针脚本的五个桶一一对应。"""

    #: 确定可下发：规则命中、取值约束判可下发（按建议值 / 按规则步长改写为一步 / 多值等直通）。
    DISPATCHABLE = "dispatchable"
    #: 确定判否：取值约束判否（不满足约束 / 方向不符 / 现网已是目标值 / 不可计算），或五元组匹配键不全。
    REJECTED = "rejected"
    #: 规则库没有这条参数的规则。没有硬约束可依：决策链 07 按「规则库无匹配」照 ICOS 原值发（条件下发）。
    RULE_NOT_MATCHED = "rule_not_matched"
    #: 旧数值策略时期的形态（``rule_scope`` 非数值步长 / ``para`` 不可判，策略提前 return）。
    #: 2026-09-30 起 ``assess_constraint`` 对每条命中规则都给结论，新行不再产出，保留供存量行认读。
    CONSTRAINT_UNPARSABLE = "constraint_unparsable"
    #: **探针档**：本模块自己坏了（抛异常 / 自拼的入参被策略判死 / 上游契约不自洽）。
    #: 现网应当恒 0，非 0 就是有东西变了。
    FAILED = "failed"


FEASIBILITY_SHAPE_VOCAB: Tuple[str, ...] = (
    FeasibilityShape.DISPATCHABLE,
    FeasibilityShape.REJECTED,
    FeasibilityShape.RULE_NOT_MATCHED,
    FeasibilityShape.CONSTRAINT_UNPARSABLE,
    FeasibilityShape.FAILED,
)


class FeasibilityVerdict:
    """三态。**派生位**，由 :attr:`PlanFeasibility.shape` 映射而来。

    **刻意不复用**「可自动下发 / 条件下发 / 不下发」那套词 —— 那是**整单级**封闭词表
    （见 ``action_facts`` 的整单判定与提示词里那条「模型不得改判」）。两个不同粒度的
    结论长成一模一样，模型和人都分不清。
    """

    FEASIBLE = "确定可行"
    INFEASIBLE = "确定不可行"
    UNDECIDED = "需判断"


FEASIBILITY_VERDICT_VOCAB: Tuple[str, ...] = (
    FeasibilityVerdict.FEASIBLE,
    FeasibilityVerdict.INFEASIBLE,
    FeasibilityVerdict.UNDECIDED,
)

#: 形态 → 三态。键集必须与 :data:`FEASIBILITY_SHAPE_VOCAB` 逐字相等（用例钉死），
#: 所以 property 里**直接下标取值**、不写 ``.get(..., UNDECIDED)`` ——
#: 那个默认值就是一个安静的第二套口径。
_SHAPE_TO_VERDICT: Dict[str, str] = {
    FeasibilityShape.DISPATCHABLE: FeasibilityVerdict.FEASIBLE,
    FeasibilityShape.REJECTED: FeasibilityVerdict.INFEASIBLE,
    FeasibilityShape.RULE_NOT_MATCHED: FeasibilityVerdict.UNDECIDED,
    FeasibilityShape.CONSTRAINT_UNPARSABLE: FeasibilityVerdict.UNDECIDED,
    FeasibilityShape.FAILED: FeasibilityVerdict.UNDECIDED,
}


class FeasibilityReason:
    """原因码，比形态细一级 —— 把「同一档里不同来路」留痕。"""

    OK_NO_CHANGE = "ok_no_change"
    OK_PICK_CANDIDATE = "ok_pick_candidate"
    #: 2026-09-30 前的取值：旧数值策略（``apply_one_step_policy``）的来路，新行不再产出，
    #: 库里存量行还带着，读的一侧不按字面判断它。
    REJECTED_NO_VALID_STEP = "rejected_no_valid_step"
    REJECTED_POLICY_ERROR = "rejected_policy_error"
    #: 连五元组匹配键都凑不齐（缺 type1/type2 之类）。现网 0 例。
    REJECTED_MATCH_FAILED = "rejected_match_failed"
    UNPARSABLE_CONSTRAINT = "unparsable_constraint"
    RULE_NOT_MATCHED = "rule_not_matched"
    FAILED_EXCEPTION = "failed_exception"
    #: 上游契约不自洽：``need_call`` 与 ``chosen_action`` 给出相反的话。
    FAILED_INCONSISTENT = "failed_inconsistent"
    #: 2026-09-30 起 rule_constraint 的四档剔除原因码（与 ConstraintReason 一一对应）。
    REJECTED_NOT_SATISFIED = "rejected_not_satisfied"
    REJECTED_DIRECTION_MISMATCH = "rejected_direction_mismatch"
    REJECTED_AT_TARGET = "rejected_at_target"
    REJECTED_VALUE_INVALID = "rejected_value_invalid"


#: ``final_b_para`` 判否或没走到判定时的占位（字面沿用旧数值策略时期，存量行都是它）。**不留空串、不用 0** ——
#: 空串会被读成「忘了填」，0 会被渲染成「值等于零」。
FINAL_ABSENT: str = "未走到数值后验，代码不编下发值"

#: 本模块产出的判据体是**代码算的**。
#: 刻意与 ``verdict.RuleProvenance.CODE``（``"code_snapshot"``）**不同形** ——
#: 同形会让字符串回查碰巧命中、用例全绿而生产上挂错。两者粒度不同：
#: 那个说的是「这一行规则是谁写的」，这个说的是「这条预判结论是谁算的」。
#: **值沿用改名前的模块名**：它随注记落库，库里存量行都是这个串（见模块文档「归属与名字」）。
FEASIBILITY_SOURCE_CODE: str = "plan_feasibility_code"

#: 结论落库时用的键名：决策轨迹 ``decision_trace_json`` 的注记、``skipped_infeasible`` 行的
#: ``llm_solution``。**沿用改名前的模块名** —— 存量行都用它，改了新旧两代数据就各一个名字。
PERSISTED_KEY: str = "plan_feasibility"

#: 出处串。与 ``convergence.CAUSE_BASIS`` 同规矩：结论要能自报家门。改名前是「决策步 04 生成方案 ·
#: 确定性可行性预判」，那时落库的注记里仍是旧串。
PLAN_FEASIBILITY_BASIS: str = "决策步 07 参数风险评估 · 规则库确定性结论"

#: 多行命中、取了首条可用规则时，规则依据块里 ``rule_match_ambiguity`` 的文本
#: （合规链那一格也是一句话，``RuleRow.ambiguity`` 按文本收）。
RULE_AMBIGUITY_NOTE: str = "多行命中且未推断 band，已取首条可用规则"


# --------------------------------------------------------------------------- #
# 小工具（照 convergence，刻意不提到 text_utils 去 —— 它们是本模块「永不抛」承诺的一部分）
# --------------------------------------------------------------------------- #


def _warn(message: str) -> str:
    """给 warning 加上固定机读前缀 + 单条截断。所有 warning 都必须经过它。"""
    text = f"{_WARN_PREFIX}{message}"
    if len(text) > _WARN_MAX_LEN:
        text = text[: _WARN_MAX_LEN - 3] + "…（已截断）"
    return text


def _cap_warnings(warnings: List[str]) -> Tuple[str, ...]:
    """去重（保序）+ 封顶。溢出的条数**记一条**，不是悄悄扔掉。"""
    seen: List[str] = []
    for item in warnings:
        if item not in seen:
            seen.append(item)
    if len(seen) <= _WARN_MAX_COUNT:
        return tuple(seen)
    dropped = len(seen) - _WARN_MAX_COUNT
    return tuple(seen[:_WARN_MAX_COUNT]) + (
        _warn(f"还有 {dropped} 条 warning 未列出（整单上限 {_WARN_MAX_COUNT} 条）"),
    )


def _safe_text(value: Any) -> str:
    """:func:`_text` 的永不抛版本。

    ``_text`` 最后一步是 ``str(value).strip()`` —— 入参是个 ``__str__`` 会抛的对象时它就抛。
    而本模块对外承诺「永不抛」，承诺要么兑现要么改写。
    """
    try:
        return _text(value)
    except Exception:  # noqa: BLE001 - 入参是什么都不该让规则库评估把整单带崩
        return ""


# --------------------------------------------------------------------------- #
# 结论对象
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class PlanFeasibility:
    """一条初案参数的确定性可行性结论。

    **凡能从别的存储字段推出来的位一律 property**：存成字段就能构造出
    ``shape=FAILED`` 而 ``verdict="确定可行"`` 这种类型上合法、且会被 :meth:`to_dict`
    原样写进轨迹的谎。
    """

    #: 五档之一，取自 :data:`FEASIBILITY_SHAPE_VOCAB`。
    shape: str
    #: 原因码，取自 :class:`FeasibilityReason`。
    reason: str
    #: 代码事实规则行。``None`` = 规则库无匹配。``provenance`` 恒为代码快照。
    rule_row: Optional[RuleRow] = None
    #: 多行命中且未推断 band，取了首条可用规则。**它不在规则事实快照的键集里**，
    #: 必须在裁快照之前 pop 出来 —— 今天全系统零消费者，丢了没人发现。
    rule_ambiguity: bool = False
    #: 一步依据（锚点 / 一步候选）。``None`` = 没走到取值约束判定（规则库无匹配 / 更早就失败）。
    #: 按**会发出去的那个值**算：可下发时是判定给出的下发值（改写过的就是改写值），
    #: 其余是 ICOS 建议值 —— 与 08 决策条件同一口径。
    basis_step: Optional[StepBasis] = None
    #: 由取值约束结论合成的旧形状 ``step_scope_analysis``（:attr:`basis_step` 就是从它解析的，
    #: 见 :func:`_synthesize_step_scope_analysis`）。
    #: 只供 :meth:`rule_basis` 落库，**不进** :meth:`to_dict` —— 轨迹里已有解析后的那份，
    #: 再放一份原文只会顶到轨迹的字符预算。
    step_analysis: Optional[Dict[str, Any]] = None
    #: 初案建议值的文本口径。
    b_para_text: str = ""
    #: 判定给出的下发值文本；判否 / 没走到判定时是 :data:`FINAL_ABSENT`。
    final_b_para: str = FINAL_ABSENT
    #: 旧数值策略返回的失败串原文。2026-09-30 起取值约束判定不产出失败串，新行恒为空串
    #: （判否的说明在 :attr:`constraint` 的 ``summary``）。
    policy_error: str = ""
    #: 本次实际用的方向约束开关。不落的话将来回放对不上。
    enforce_step_direction: bool = True
    #: 2026-09-30 起：规则取值约束判定的结论（``assess_constraint`` 的产物）。落进决策行
    #: ``new_chain.rule.constraint``，正文「规则依据」列与下发参数对照表的理由原样引用它的 summary。
    constraint: Optional[ConstraintResult] = None
    warnings: Tuple[str, ...] = field(default_factory=tuple)
    #: 2026-10-09 起：07 算过的案例建议步数（:class:`services.decision.case_steps.CaseStepAdvice`）。
    #: ``None`` = 没算（案例库没开 / 这一条不可下发或没有规则行）。放大了的（``applied``）由 :func:`with_case_steps`
    #: 按建议步数重算过下发值；落进决策行 ``new_chain.rule.case_steps``。
    case_steps: Optional[CaseStepAdvice] = None

    # ---- 派生位（一律 property，不另存字段）----

    @property
    def verdict(self) -> str:
        """三态。键集与形态词表逐字相等，所以直接下标取值。"""
        return _SHAPE_TO_VERDICT[self.shape]

    @property
    def source(self) -> str:
        return FEASIBILITY_SOURCE_CODE

    @property
    def basis(self) -> str:
        return PLAN_FEASIBILITY_BASIS

    @property
    def decided(self) -> bool:
        """代码自己给出了确定结论（可行或不可行）。"""
        return self.shape in (FeasibilityShape.DISPATCHABLE, FeasibilityShape.REJECTED)

    @property
    def hard_constraint_usable(self) -> bool:
        """有没有可用的硬约束。**不自己再判一遍** step/domain 可解析。"""
        return bool(self.rule_row) and bool(self.rule_row.hard_constraint_usable)

    @property
    def value_changed(self) -> bool:
        """策略是否改动了 ICOS 的建议值。"""
        if self.final_b_para == FINAL_ABSENT:
            return False
        return self.final_b_para != self.b_para_text

    @property
    def steps(self) -> int:
        """下发值从现网值走了几步（区间类）。默认 1；按案例建议步数放大过的是建议步数。"""
        return self.constraint.steps if self.constraint is not None else 1

    def to_dict(self) -> Dict[str, Any]:
        """**键集包含派生位** —— 字段数变了键集不变（``case_steps`` 只在算过时才有）。"""
        out = self._to_dict()
        if self.case_steps is not None:
            out["case_steps"] = self.case_steps.to_dict()
        return out

    def _to_dict(self) -> Dict[str, Any]:
        return {
            "shape": self.shape,
            "verdict": self.verdict,
            "reason": self.reason,
            "source": self.source,
            "basis": self.basis,
            "decided": self.decided,
            "hard_constraint_usable": self.hard_constraint_usable,
            "rule_ambiguity": self.rule_ambiguity,
            "b_para": self.b_para_text,
            "final_b_para": self.final_b_para,
            "value_changed": self.value_changed,
            "policy_error": self.policy_error,
            "enforce_step_direction": self.enforce_step_direction,
            "rule_row": self.rule_row.to_dict() if self.rule_row else None,
            "basis_step": self.basis_step.to_dict() if self.basis_step else None,
            "warnings": list(self.warnings),
        }

    def rule_basis(self) -> Dict[str, Any]:
        """落进决策行的**规则依据块**（enforce 档写在 ``llm_solution.new_chain.rule``）。

        键名与合规链 ``llm_solution`` 里的同名键一致（``matched_rule`` / ``step_scope_analysis`` /
        ``rule_match_ambiguity``），读的一侧（:func:`services.decision.plan_table.rule_basis`）
        因此能原样交给 ``RuleRow.from_solution`` / ``StepBasis.from_solution``，不写第二套解析。
        ``shape`` / ``reason`` 是 07 规则库结论的形态与原因码 —— 依据表「为什么没有步长判定」按它说。
        ``warnings`` / ``error`` 与合规链 ``llm_solution`` 的同名两格对应：规则匹配与取值约束判定的告警原文，
        以及判不出来的那一句（存量行是旧数值策略报错的原文；本模块自己坏了时是说明原因的那条 warning）。
        ``constraint`` 是取值约束判定的结论（2026-09-30 起），判法写在它的 ``summary``。
        """
        error = self.policy_error
        if not error and self.shape == FeasibilityShape.FAILED and self.warnings:
            error = self.warnings[-1]
        out = {
            "shape": self.shape,
            "reason": self.reason,
            # 代码事实快照（规则库裁出来的那份），没有规则行时为 None。
            "matched_rule": dict(self.rule_row.raw) if self.rule_row else None,
            "step_scope_analysis": dict(self.step_analysis) if self.step_analysis else None,
            "constraint": self.constraint.to_dict() if self.constraint else None,
            "rule_match_ambiguity": RULE_AMBIGUITY_NOTE if self.rule_ambiguity else "",
            "warnings": list(self.warnings),
            "error": error,
        }
        # 案例建议步数只在算过时才带（案例库关着的行与 2026-10-09 之前逐字相同）。
        if self.case_steps is not None:
            out["case_steps"] = self.case_steps.to_dict()
        return out


# --------------------------------------------------------------------------- #
# 本体：纯函数，无 IO、无 settings
# --------------------------------------------------------------------------- #


def assess_numeric_feasibility(
    rule_fact: Mapping[str, Any],
    *,
    f_para: Any,
    b_para: Any,
    enforce_step_direction: bool = True,
    steps: int = 1,
) -> PlanFeasibility:
    """规则事实已经匹配好，只跑规则取值约束判定。**纯函数：无文件 IO、不读配置。**

    ``steps``：区间类从现网值走几步（默认一步；大于 1 只来自 07 的案例建议步数，见 :func:`with_case_steps`）。

    2026-09-30 起调 :func:`services.compliance.rule_constraint.assess_constraint` —— 只用命中规则行的
    ``para``（取值约束）与 ``rule_scope``（带符号步长）裁决。

    为了不触动下游（``verdict.StepBasis`` / 展示层裁决依据表 / 08 决策条件复核），这里把
    :class:`ConstraintResult` **合成**成旧 ``step_scope_analysis`` 的形状再落 ``step_analysis`` ——
    ``StepBasis.from_solution`` 原样可读。新形状的 ``constraint`` 一并落在 ``rule_basis()``，
    正文「规则依据」列与下发参数对照表的理由读它。

    ``enforce_step_direction`` 自 2026-09-30 起不再生效（新规则表步长全部显式带符号、方向恒按符号走），
    保留入参只为不破坏调用方签名。
    """
    warnings: List[str] = []
    f_text = _safe_text(f_para)
    o_text = _safe_text(b_para)
    b_text = format_para_text_value(o_text) or ""

    fact = dict(rule_fact or {})
    result = assess_constraint(fact, f_para=f_text, b_para=o_text, steps=steps)
    for item in result.warnings:
        warnings.append(_warn("规则约束：" + _safe_text(item)))

    rule_row = RuleRow.from_solution({"matched_rule": fact})
    analysis = _synthesize_step_scope_analysis(fact, f_text, result)

    #: ``ConstraintReason`` → ``FeasibilityReason``（剔除四档一一对应；通过两档合成一档）。
    reject_reason = {
        ConstraintReason.NOT_SATISFIED: FeasibilityReason.REJECTED_NOT_SATISFIED,
        ConstraintReason.DIRECTION_MISMATCH: FeasibilityReason.REJECTED_DIRECTION_MISMATCH,
        ConstraintReason.AT_TARGET: FeasibilityReason.REJECTED_AT_TARGET,
        ConstraintReason.VALUE_INVALID: FeasibilityReason.REJECTED_VALUE_INVALID,
    }
    if result.dispatch:
        shape = FeasibilityShape.DISPATCHABLE
        reason = (
            FeasibilityReason.OK_PICK_CANDIDATE
            if result.reason == ConstraintReason.REWRITTEN
            else FeasibilityReason.OK_NO_CHANGE
        )
        final = result.final_b_para or FINAL_ABSENT
        basis_value = final
    else:
        shape = FeasibilityShape.REJECTED
        reason = reject_reason.get(result.reason, FeasibilityReason.REJECTED_NO_VALID_STEP)
        final = FINAL_ABSENT
        basis_value = o_text

    basis_step = StepBasis.from_solution(
        {"matched_rule": fact, "step_scope_analysis": analysis},
        b_para=basis_value,
    )
    return PlanFeasibility(
        shape=shape,
        reason=reason,
        rule_row=rule_row,
        basis_step=basis_step,
        step_analysis=analysis,
        b_para_text=b_text,
        final_b_para=final,
        policy_error="",
        enforce_step_direction=enforce_step_direction,
        constraint=result,
        warnings=_cap_warnings(warnings),
    )


def _synthesize_step_scope_analysis(
    fact: Mapping[str, Any], f_text: str, result: ConstraintResult
) -> Dict[str, Any]:
    """把 :class:`ConstraintResult` 合成成旧 ``step_scope_analysis`` 的形状，供
    :meth:`services.decision.verdict.StepBasis.from_solution` 原样解析 —— 不让展示层与
    08 复核跟着改形状。新形状的事实落在 ``rule_basis()`` 的 ``constraint`` 键。"""
    scope = _safe_text(fact.get("rule_scope"))
    direction_text = {1: "调大", -1: "调小"}.get(result.direction or 0, "未声明")
    chosen = (
        "no_change"
        if result.reason in (ConstraintReason.AS_PROPOSED, ConstraintReason.PASSTHROUGH)
        else "pick_candidate_a"
        if result.reason == ConstraintReason.REWRITTEN
        else "reject_no_valid_step"
    )
    # 「一步候选」恒是现网值 + 一步：多步时 target 是多步的目标值，另记两格（只在多步时出现）。
    one_step = result.target
    anchor = parse_scalar_float(f_text)
    if result.steps > 1 and anchor is not None and result.step is not None and result.direction is not None:
        one_step = format_para_text_value(anchor + result.direction * result.step)
    analysis = {
        "anchor_raw": f_text,
        "anchor_numeric": anchor,
        "step_parsed": {
            "raw": scope,
            "magnitude": result.step,
            "direction": result.direction,
            "direction_text": direction_text,
            "direction_enforced": result.direction is not None,
            "说明": result.summary,
        },
        "allowed_one_step_values": [one_step] if one_step else [],
        "distance_assessment": {
            "level": "in_band" if result.dispatch else "far",
            "explanation": result.summary,
        },
        "chosen_action": chosen,
        "f_para_constraint_summary": result.summary,
    }
    if result.steps > 1:
        analysis["case_steps"] = result.steps
        analysis["case_target"] = result.target
    return analysis


# --------------------------------------------------------------------------- #
# 外层：做规则匹配，兜异常
# --------------------------------------------------------------------------- #


def assess_plan_feasibility(
    structured_data: Mapping[str, Any],
    *,
    task_info: Optional[Mapping[str, Any]] = None,
    enforce_step_direction: bool,
) -> PlanFeasibility:
    """一条初案 → 确定性可行性结论。**永不抛。**

    ``structured_data`` 是合规链时期沿用下来的那份入参（``order_data`` / ``reason_analyze`` /
    ``icos_init_plan`` 三段），由调用方拼好传进来 —— 本模块**不许** import
    ``services.orders``（决策包白名单只有 ``services.common`` / ``services.compliance``），
    而那两个拼装函数是纯函数，调用方传进来没有信息损失。

    异常分三类，**绝不合并**：

    * ``RuleNotMatched`` —— 规则库里没有这条参数的规则。今天走 bypass **原样直通下发**
      （现网 71/195）。合并会把这批今天会下发的初案判死。
    * ``RuleMatchFailed`` —— 连匹配键都凑不齐（缺 type1/type2 之类）。这是**判否**。
    * 其余 —— 配置 / CSV 读取一类的环境故障。**不是**「规则未命中」，
      混进去就把环境问题说成了业务事实。
    """
    warnings: List[str] = []
    icos = (structured_data or {}).get("icos_init_plan") or {}
    b_text = format_para_text_value(_safe_text(icos.get("b_para"))) or ""

    def _short(shape: str, reason: str) -> PlanFeasibility:
        return PlanFeasibility(
            shape=shape,
            reason=reason,
            b_para_text=b_text,
            enforce_step_direction=enforce_step_direction,
            warnings=_cap_warnings(warnings),
        )

    try:
        rule_row, match_warnings = match_rule_row(dict(structured_data or {}), dict(task_info or {}))
    except RuleNotMatched as exc:
        warnings.append(_warn(f"规则库无匹配：{_safe_text(exc)}"))
        return _short(FeasibilityShape.RULE_NOT_MATCHED, FeasibilityReason.RULE_NOT_MATCHED)
    except RuleMatchFailed as exc:
        warnings.append(_warn(f"五元组匹配键不全：{_safe_text(exc)}"))
        return _short(FeasibilityShape.REJECTED, FeasibilityReason.REJECTED_MATCH_FAILED)
    except Exception as exc:  # noqa: BLE001 - 唯一一道兜底；类名写进 warning，否则它会藏 bug
        warnings.append(_warn(f"规则匹配意外失败（{type(exc).__name__}）：{_safe_text(exc)}"))
        return _short(FeasibilityShape.FAILED, FeasibilityReason.FAILED_EXCEPTION)

    for item in match_warnings or []:
        warnings.append(_warn("规则匹配：" + _safe_text(item)))

    # **必须先 pop 再裁快照**：这个键不在规则事实的键集里，快照一裁就没了。
    row = dict(rule_row or {})
    ambiguity = bool(row.pop("_ambiguity", None))
    if ambiguity:
        warnings.append(_warn(RULE_AMBIGUITY_NOTE))

    try:
        result = assess_numeric_feasibility(
            rule_fact_snapshot(row),
            f_para=icos.get("f_para"),
            b_para=icos.get("b_para"),
            enforce_step_direction=enforce_step_direction,
        )
    except Exception as exc:  # noqa: BLE001 - 本体号称纯函数且永不抛；真抛了就是它自己坏了
        warnings.append(_warn(f"数值预判意外失败（{type(exc).__name__}）：{_safe_text(exc)}"))
        return _short(FeasibilityShape.FAILED, FeasibilityReason.FAILED_EXCEPTION)

    # 在本体结论上只补外层自己知道的两格，**不逐字段重建** —— 2026-10-02 前这里逐个字段抄，
    # 漏了 09-30 新加的 ``constraint``：07 的四档剔除原因全落成「规则库判否」、``new_chain.rule.constraint`` 恒空。
    merged = list(warnings) + list(result.warnings)
    return replace(result, rule_ambiguity=ambiguity, warnings=_cap_warnings(merged))


def with_case_steps(feasibility: PlanFeasibility, advice: CaseStepAdvice) -> PlanFeasibility:
    """把 07 算好的案例建议步数挂上结论；放大了的（``advice.applied``）按建议步数重算下发值。

    只对**可下发、有规则行**的结论重算（规则行不重新匹配，取 ``rule_row.raw``）；判否 / 无匹配 / 失败的
    只挂上建议、不动结论 —— 多走几步救不回方向不符或越界。重算后万一不可下发（建议步数没核过区间，
    不该发生），退回一步的结论并在建议上记一句。**永不抛。**
    """
    if not advice.applied or feasibility.shape != FeasibilityShape.DISPATCHABLE or feasibility.rule_row is None:
        return replace(feasibility, case_steps=advice)
    try:
        again = assess_numeric_feasibility(
            feasibility.rule_row.raw,
            f_para=(feasibility.step_analysis or {}).get("anchor_raw"),
            b_para=feasibility.b_para_text,
            enforce_step_direction=feasibility.enforce_step_direction,
            steps=advice.steps,
        )
    except Exception as exc:  # noqa: BLE001 - 本体号称永不抛；真抛了就照旧一步
        return replace(feasibility, case_steps=replace(advice, steps=1, note=f"按建议步数重算失败（{type(exc).__name__}），照旧一步"))
    if again.shape != FeasibilityShape.DISPATCHABLE:
        return replace(feasibility, case_steps=replace(advice, steps=1, note="按建议步数重算后不可下发，照旧一步"))
    return replace(again, rule_ambiguity=feasibility.rule_ambiguity, warnings=feasibility.warnings, case_steps=advice)


__all__ = [
    "FEASIBILITY_SHAPE_VOCAB",
    "FEASIBILITY_SOURCE_CODE",
    "FEASIBILITY_VERDICT_VOCAB",
    "FINAL_ABSENT",
    "FeasibilityReason",
    "FeasibilityShape",
    "FeasibilityVerdict",
    "PERSISTED_KEY",
    "PLAN_FEASIBILITY_BASIS",
    "PlanFeasibility",
    "RULE_AMBIGUITY_NOTE",
    "assess_numeric_feasibility",
    "assess_plan_feasibility",
    "with_case_steps",
]
