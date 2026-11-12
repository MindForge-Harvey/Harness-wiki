"""初案与决策行的**对齐、判定与计数** —— 决策包的地基。

* :func:`plan_key` —— 初案与决策行的对齐键，全系统唯一一处；
* :func:`row_solution` / :func:`verdict_row_state` —— 决策行 → 解析后的
  ``llm_solution`` 与判定三件套，全系统唯一一处；
* :func:`icos_plan_facts` —— 整单收到的 ICOS 初案有哪些、去重后剩几项（01 汇总的
  ``plan_stats``，正文「当前汇总可执行方案组情况」的数据来源）；
* :func:`verdict_entries` / :func:`verdict_stats` —— 本轮每个参数动作的裁决条目与计数
  （08 整单结论的输入，正文「生成方案」裁决表的数据来源）。

**本模块只出事实与计数，不出 Markdown。** 表头、单元格转义、表后总结句都在
:mod:`services.frontend_view.decision_render`（P5「渲染迁出决策包」，2026-09-23）。
迁出前这里既算计数又排版，于是决策侧（``build_order_decision`` / 整单复核）为了拿几个
计数也得把整张表排一遍再丢掉 Markdown；现在反过来，展示层拿这里的事实去排版。

**本模块不 import 包外任何东西**（除 ``services.common`` 的纯工具），它是决策包里谁都依赖、
自己几乎谁都不依赖的那一层（包内只依赖叶子 ``phase`` 与 ``prior_round`` 的词表）。

为什么这些计数不交给模型
------------------------
方案组、参数名、前后值、裁决结论、各项计数都是纯机械的结构化转写，模型在这里只会带来
改写风险。「生成方案」的裁决结论更是决策链（04 寻优 → 07 规则库 → 08 冲突剔除 → 决策条件）
收敛后的结果（详见 :func:`verdict_row_state`），模型在正文里重判一次就会与同屏「下发参数对照表」打架。
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Sequence, Tuple

from services.decision.phase import BYPASS_PHASES, Phase, canonical_phase
from services.common.text_utils import _text
from services.decision.case_steps import CASE_STEPS_REASON
from services.decision.prior_round import LEGACY_MULTI_ROUND_ACTION_LABELS, MULTI_ROUND_ACTION_LABELS, MultiRoundAction

#: 表最多列多少行。超出的行不进表格，初案计数**仍然包含**它们 —— 口径永远是
#: "整单收到的全部初案行"，表格只是它的可视化截断。
#:
#: ⚠ 它**同时**截断了 :func:`verdict_stats` 的计数（``row_count`` 等只数前 40 条）——
#: 这是迁出前 ``build_verdict_table`` 先截断再计数留下的既有口径，``OrderDecision.verdict``
#: 的计数、整单判定都从它来。改成全量计数是一次口径变更（会让超过 40 个动作的工单
#: 判定文本变化、正文输入哈希变化），不和搬家混做。现网单张工单动作数远不到 40。
ICOS_PLAN_TABLE_ROW_LIMIT = 40

#: 初案没下发方案组编号时的占位，两张表与 ``plan_stats.groups`` 共用。
#:
#: 与旧的 ``type2`` 口径有一处实质区别：``type2`` 在入站契约上是**必填**
#: （``schemas.ImplementationPlanModel`` 里是 ``ReqStr``），几乎必有值；而
#: ``plan_group_number`` 是**可选**的（``OptStr``，e2e 专门留了一档"ICOS 整个不下发
#: 方案组编号"的形态）。也就是说空值在新口径下是正常形态而不是脏数据。
#: 占位词因此用"未编号"而不是"未分组" —— 让看表的人一眼分清是上游没给编号，
#: 而不是后端没能把这条动作归到某个组里。
#:
#: 它留在决策包而不是展示层：``plan_stats.groups`` 按它分组计数，并随裁决对象落库。
UNGROUPED = "未编号"


def plan_key(execution_id: Any, parachinname: Any) -> str:
    """初案与决策行的对齐键，**全系统唯一一处**。

    ``execution_id`` 是 ICOS 侧的唯一标识，两边都有；初案存 TEXT、决策行存 BIGINT，
    所以统一成字符串再比。极少数历史行 execution_id 为空，退到参数名兜底。
    """
    key = _text(execution_id)
    return key or _text(parachinname)


#: 取不到初案 ``sort_id`` 的行排在最后。
_UNKNOWN_SORT_ID = 2**62


def dispatch_order_key(row: Dict[str, Any]) -> Tuple[int, int, str]:
    """一条决策行在推送批内的次序键，**全系统唯一一处**。

    次序 = ICOS 推送初案的先后：初案 ``sort_id`` 升序（决策时写进了 ``order_info`` 的
    ``icos_init_plan``）；取不到的排在后面，再按 execution_id、参数名稳定下来。推送侧
    （``ExecutionRepository.pending_push_rows``）与「参数编排」那一节的展示都按它排。

    **不看 ``final_ratio``**：2026-09-24 业务确认那一列没有任何意义、不得用于方案决策
    （之前批内顺序是它的降序）。整单一次 HTTP、同参数冲突已在 08 剔掉，次序本身不改变
    执行结果；排它只为稳定可复现、推送与展示说同一个顺序。
    """
    sort_id: Optional[int] = None
    info = row.get("order_info")
    try:
        payload = json.loads(info) if isinstance(info, str) else (info or {})
        sort_id = int((payload.get("icos_init_plan") or {}).get("sort_id"))
    except (TypeError, ValueError, AttributeError):
        sort_id = None
    try:
        execution_id = int(row.get("execution_id"))
    except (TypeError, ValueError):
        execution_id = 0
    return (
        sort_id if sort_id is not None else _UNKNOWN_SORT_ID,
        execution_id,
        _text(row.get("tool")) or "",
    )


def icos_plan_facts(
    icos_rows: Sequence[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """把 ``icos_initial_plan_record`` 的行折成逐行事实与统计，返回 ``(rows, stats)``。

    去重口径
    --------
    ``(参数中文名, 修改前值, 修改后值)`` 三元组，即"参数名称、修改前后值是否一致"。
    **它与 :meth:`InitialPlanRepository.list_by_taskno` 的去重不是一回事**：那一层按
    ``execution_id`` 去重（同一次推送重复入库），这一层是业务语义上的"同一个参数改成
    同一个值被多个方案组各提了一遍"。两层都要有：前者防脏数据，后者才是 01 汇总要报的数。

    三元组比的是去掉首尾空白后的**原文**。迁出前比的是转义后的单元格文本（竖线换全角、
    换行换空格、空值换占位词），两者只在初案字段里含竖线 / 换行、或恰好等于占位词时
    才分得开 —— 现网库里一条都没有（迁出时对本地库逐单比对过，全等）。

    ``rows`` **列全部行**（含重复），重复行的 ``duplicate_of`` 指向它首现行的序号 ——
    这样"收到几个方案、每个方案含几个参数修改"看得见，"去重后剩几个"由 ``stats`` 给出。
    行上的值是原文（已去首尾空白），单元格转义与缺省占位由展示层做。
    """
    rows: List[Dict[str, Any]] = []
    #: 三元组 → 首现行的序号。len() 即去重后的参数动作数。
    seen: Dict[Tuple[str, str, str], int] = {}
    group_order: List[str] = []
    group_stats: Dict[str, Dict[str, Any]] = {}

    for plan in icos_rows or []:
        if not isinstance(plan, dict):
            continue
        group = _text(plan.get("plan_group_number"))
        name = _text(plan.get("parachinname"))
        before = _text(plan.get("f_para"))
        after = _text(plan.get("b_para"))
        seq = len(rows) + 1
        key = (name, before, after)
        duplicate_of = seen.get(key)
        if duplicate_of is None:
            seen[key] = seq
        group_name = group or UNGROUPED
        if group_name not in group_stats:
            group_order.append(group_name)
            group_stats[group_name] = {
                "plan_group_number": group_name,
                "row_count": 0,
                "unique_count": 0,
            }
        group_stats[group_name]["row_count"] += 1
        if duplicate_of is None:
            group_stats[group_name]["unique_count"] += 1
        rows.append(
            {
                "seq": seq,
                "plan_group_number": group,
                "parachinname": name,
                "f_para": before,
                "b_para": after,
                "plan_number": _text(plan.get("plan_number")),
                "execution_id": _text(plan.get("execution_id")),
                # None = 本行是该三元组的首现；否则指向首现行的序号。
                "duplicate_of": duplicate_of,
            }
        )

    listed_count = min(len(rows), ICOS_PLAN_TABLE_ROW_LIMIT)
    stats = {
        "dedupe_key": "参数中文名 + 修改前值 + 修改后值",
        "group_count": len(group_order),
        "param_row_count": len(rows),
        "unique_param_count": len(seen),
        "duplicate_count": len(rows) - len(seen),
        "groups": [group_stats[name] for name in group_order],
        # 这两项是展示口径（表里列了几行），随 ``OrderDecision.facts.plan_stats`` 落库已久，
        # 为不改对象形状保留在这里。
        "listed_row_count": listed_count,
        "truncated_count": len(rows) - listed_count,
    }
    return rows, stats


#: ``llm_solution.phase`` → 未准入的**短原因**（封闭词表）。**给合规链时期的老行用**：
#: 决策链的行（2026-09-25 起）不看 phase，未准入原因取 ``new_chain.reason``（见 :func:`verdict_row_state`）。
#:
#: 合规链时期决定一个参数进不进参数平台的有四层：前置校验与规则库匹配 → 四条 bypass
#: → ``plan_compliance`` 合规 LLM → 数值一步后验（代码会**覆写** LLM 的结论），之后还有
#: 08 冲突剔除。落到 ``agent_execution_plan`` 上只剩 ``need_call`` 一个是/否，
#: "为什么否"全在 ``phase`` 里。这张表把 phase 翻成业务口径，好让正文不必去猜。
#:
#: **不要交给模型去映射**：``rule_match``（前置字段缺失 → 不下发）与
#: ``rule_match_bypass``（规则库没这条参数的规则 → 照原值下发）名字像、结论相反，
#: 模型必错。
_REJECT_REASON_BY_PHASE: Dict[str, str] = {
    Phase.SKIPPED_LOWER_PRIORITY: "档位跳过",
    #: 与「档位跳过」是两回事：那个是"更高档已出可下发，本档没试"，
    #: 这个是"本档每一条都被代码判死了，不必试"。**不登记的话它会落进
    #: `_REJECT_REASON_DEFAULT`「未通过合规裁决」—— 而这些行压根没进过合规裁决。**
    Phase.SKIPPED_INFEASIBLE: "越出可调域或步长（代码预判，未调用模型）",
    #: 合规判了可下发，但同一参数在同一批里还有别的目标值，被决策步 08 剔除。
    #: 同样**必须登记**：落进兜底就成了「未通过合规裁决」，而它恰恰是通过了的。
    Phase.DROPPED_CONFLICT: "参数冲突剔除",
    #: 多轮决策：前几轮已调过、短评估没通过，多轮决策阶梯走完了（或同参数由另一条初案承载），本轮不发。
    #: 同样**必须登记** —— 没进过合规裁决。字面与决策链的原因 ``ChainReason.PRIOR_DETERIORATED``
    #: 相同：两条链判的是同一件事，界面上不该因为谁裁决就换一种说法。
    Phase.EXCLUDED_PRIOR_ROUND: "上轮已调整且评估未通过",
    Phase.MISSING_ICOS_TYPE1_TYPE2: "根因字段缺失",
    Phase.PRECHECK: "前置校验未过",
    Phase.RULE_MATCH: "规则匹配键缺失",
    Phase.NUMERIC_POSTCHECK: "越出可调域或步长",
    Phase.COMPLIANCE_FAILED: "规则判定未通过",
    Phase.HARNESS_VALIDATE: "裁决结构校验未过",
}
#: phase 不在上表里时的兜底短语（老数据、或新增分支还没登记）。
_REJECT_REASON_DEFAULT = "未通过裁决"

#: 多轮决策动作（缩步长 / 反向 / 回退）下发时的准入标签。它们不是「裁决改写」—— 值是多轮决策按上轮
#: 评估给的，不是对 ICOS 建议值的改写。决策链的行按 ``new_chain.reason`` 认，没有决策链块的行
#: （回退轮、老行）按 phase 认，两边字面同源（``prior_round.MULTI_ROUND_ACTION_LABELS``）。
_MULTI_ROUND_LABEL_BY_PHASE: Dict[str, str] = {
    Phase.MULTI_ROUND_SHRINK: MULTI_ROUND_ACTION_LABELS[MultiRoundAction.SHRINK],
    Phase.MULTI_ROUND_REVERSE: MULTI_ROUND_ACTION_LABELS[MultiRoundAction.REVERSE],
    Phase.MULTI_ROUND_ROLLBACK: MULTI_ROUND_ACTION_LABELS[MultiRoundAction.ROLLBACK],
}
#: 认原因时连 2026-10-03 前的旧字面（「外环…」）一起认 —— 存量行的 ``new_chain.reason`` 还是旧词。
_MULTI_ROUND_REASONS = frozenset(MULTI_ROUND_ACTION_LABELS.values()) | frozenset(LEGACY_MULTI_ROUND_ACTION_LABELS.values())
#: 准入标签的前缀（``已准入·{原因}``），:func:`verdict_stats` 据此认出多轮决策调整。
_ADMITTED_PREFIX = "已准入·"

#: ``step_scope_analysis.chosen_action`` → 未准入的短原因。**上表查不到时才用它。**
#:
#: 为什么需要第二张表：数值一步后验**判不下发时不会改 phase**。
#: :data:`Phase.NUMERIC_POSTCHECK` 只在后验**报错**（结构性失败）时才设，而后验正常跑完、
#: 算出"没有合法的一步取值"并把 ``need_call`` 覆写成否的那条路上，phase 一直停在
#: ``success``。于是它落进 :data:`_REJECT_REASON_DEFAULT` 那句最没信息量的兜底。
#:
#: 现网实测：这样的行有 11 条，而上表里那 7 个 phase 除 ``skipped_lower_priority``
#: 外**一个都没出现过** —— 也就是说词表映射了一批不发生的分支，却漏掉了唯一真正高频的那个。
#: 重构要消灭的 69 条 bypass 一旦都走进数值后验，这个数还会涨。
#:
#: 复用 ``NUMERIC_POSTCHECK`` 那句话而不是新造词：它本来就是为"越出域或步长"写的，
#: 只是挂在了一个不触发的键上。封闭词表因此**零增长**。
#: 三种具体情形（越域 / 建议值不是合法一步 / 算不出候选）的区分不进这张表 ——
#: 表里的短语要短到能进表格单元格，精确细节在
#: :attr:`services.decision.verdict.ActionVerdict.reject_detail` 上。
_REJECT_REASON_BY_CHOSEN: Dict[str, str] = {
    "reject_no_valid_step": _REJECT_REASON_BY_PHASE[Phase.NUMERIC_POSTCHECK],
}


def _reject_reason(solution: Dict[str, Any], phase: str) -> str:
    """未准入的短原因。先查 phase，查不到再看数值后验写回的 ``chosen_action``。"""
    reason = _REJECT_REASON_BY_PHASE.get(phase)
    if reason:
        return reason
    analysis = solution.get("step_scope_analysis")
    if isinstance(analysis, dict):
        chosen = _REJECT_REASON_BY_CHOSEN.get(_text(analysis.get("chosen_action")))
        if chosen:
            return chosen
    return _REJECT_REASON_DEFAULT


def row_solution(row: Dict[str, Any]) -> Dict[str, Any]:
    """决策行 → 解析后的 ``llm_solution`` 字典，**全系统唯一一处**。

    ``agent_execution_plan.llm_solution`` 是 ``Text`` 列，``row_to_dict`` 取出来是
    **JSON 字符串**（不是 dict），所以每个想读它的地方都得自己解析 —— 与其散落多份，
    不如在这里解一次。解析不了返回空字典：拿不到只影响措辞，不影响"准入与否"
    （那由 ``need_call`` 决定）。

    决策链的行（2026-09-25 起）里是 ``phase`` 与 ``new_chain``（判到哪一步、为什么、07 的规则依据）；
    多轮决策接管的行多一块 ``multi_round``。合规链时期的老行装着合规链写回的全过程：``rule_row``、
    ``step_scope_analysis``（由 ``apply_one_step_policy`` **代码覆写**）等。
    名字 2026-09-25 从 ``compliance_solution`` 改来（合规链删除后它只是「解析这一行的 llm_solution」）。

    改过名的存量写法在这里换成现名（:func:`_canonical_solution`），读的一侧只认现名。
    """
    raw = row.get("llm_solution")
    if isinstance(raw, dict):
        return _canonical_solution(raw)
    text = _text(raw)
    if not text.startswith("{"):
        return {}
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return {}
    return _canonical_solution(parsed) if isinstance(parsed, dict) else {}


#: 决策行 ``llm_solution`` 上多轮决策那一块的键（为什么这么调 / 为什么不发）。
MULTI_ROUND_NOTE_KEY = "multi_round"
#: 2026-10-03 前（那时称「外环」）的键名，存量行还带着。
_LEGACY_MULTI_ROUND_NOTE_KEY = "outer_loop"


def _canonical_solution(solution: Dict[str, Any]) -> Dict[str, Any]:
    """存量行的旧写法 → 现名：phase 旧取值（:data:`~services.decision.phase.LEGACY_PHASE_ALIASES`）、
    多轮决策那一块的旧键 ``outer_loop``。没有旧写法时原样返回同一个对象；有就返回换过的副本，不改入参。"""
    phase = solution.get("phase")
    legacy_note = _LEGACY_MULTI_ROUND_NOTE_KEY in solution and MULTI_ROUND_NOTE_KEY not in solution
    if canonical_phase(phase) == phase and not legacy_note:
        return solution
    out = {**solution, "phase": canonical_phase(phase)} if "phase" in solution else dict(solution)
    if legacy_note:
        out[MULTI_ROUND_NOTE_KEY] = out.pop(_LEGACY_MULTI_ROUND_NOTE_KEY)
    return out


def enforced_chain(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """这一行由决策链裁决时返回 ``llm_solution.new_chain``，否则 ``None``（回退轮、合规链时期的老行）。

    「这一行是谁裁决的」只在这里判一次 —— :func:`verdict_row_state` 与 :func:`rule_basis` 都走它。
    """
    chain = row_solution(row).get("new_chain")
    return chain if isinstance(chain, dict) and chain.get("enforced") else None


def rule_basis(row: Dict[str, Any]) -> Dict[str, Any]:
    """决策行 → 它的下发结论**所依据的规则事实** —— 谁裁决这一行就读谁的依据。**全系统唯一一处。**

    返回 ``llm_solution`` 形状的字典，``RuleRow.from_solution`` / ``StepBasis.from_solution`` 原样可读：

    * **决策链的行**（:func:`enforced_chain` 非空，且带 ``rule`` 块）：07 的规则库结论
      （``new_chain.rule``，``DecisionService`` 从 ``PlanFeasibility.rule_basis`` 落的）。
      规则行是代码事实，``rule_row`` 与 ``matched_rule`` 是同一份（这条路上没有模型回抄）；
      另带 ``rule_shape`` / ``rule_reason`` —— 07 规则库结论的形态与原因码，依据表
      「为什么没有步长判定」按原因码说；``warnings`` / ``error`` 是 07 判定自己的告警与失败原因。
    * 其余（回退轮、合规链时期的老行，以及 enforce 上线早于依据块的老轮次）：``llm_solution`` 原样。

    为什么要有这一处：合规链删除（2026-09-25）之后，新行上不会再有合规链的
    ``matched_rule`` / ``step_scope_analysis`` —— 裁决对象的规则行与一步依据、07 注记、
    08 决策条件、整单复核的证据、依据表都得从决策链的结论取，而老行还得照旧读。各处各自判断
    「该读哪一份」，就又回到了一个概念多处实现的老路。
    """
    solution = row_solution(row)
    chain = enforced_chain(row)
    rule = chain.get("rule") if chain is not None else None
    if not isinstance(rule, dict):
        return solution
    fact = rule.get("matched_rule") if isinstance(rule.get("matched_rule"), dict) else {}
    analysis = rule.get("step_scope_analysis")
    warnings = rule.get("warnings")
    return {
        "matched_rule": dict(fact),
        "rule_row": dict(fact),
        "step_scope_analysis": dict(analysis) if isinstance(analysis, dict) else {},
        "rule_match_ambiguity": _text(rule.get("rule_match_ambiguity")),
        "rule_shape": _text(rule.get("shape")),
        "rule_reason": _text(rule.get("reason")),
        # 07 规则库判定自己的告警与失败原因（与合规链 llm_solution 的同名两格对应）。
        "warnings": list(warnings) if isinstance(warnings, list) else [],
        "error": _text(rule.get("error")),
    }


def verdict_row_state(row: Dict[str, Any]) -> Dict[str, Any]:
    """决策行 → 这一行的判定三件套，**全系统唯一一处**。

    返回 ``{"is_dispatched", "changed", "admission_state", "admission_label"}``。

    所有消费方都从这里派生，所以「下发参数对照表」、「生成方案」正文与裁决对象的判定
    不可能出现两个说法。

    ``changed`` 只在已下发时才有意义：决策链不发的行（``DecisionService._apply_chain``，
    合规链时期是合规失败分支）会**同时**把 ``b_para`` 退回 ICOS 原值并置 ``need_call='否'``，所以
    ``b_para == org_b_para`` 不等于"原样下发"，也可能是"没发、回退留档"。
    顺序必须是先看准入、再看改写，反过来必错。

    ``admission_state`` 是三态而不是两态：机制上 ``need_call`` 只有是/否，但没经过规则校验就
    按 ICOS 建议值发出去的"是"（决策链的行看 ``new_chain.unchecked``：规则库无匹配 / 规则写法判读
    不了 / 07 判定失败；合规链时期的老行看四条 bypass phase）与过了规则校验的"是"业务含义不同。
    正文里所谓的"条件项"指的正是这一类；把它单列出来，三分类才有数据支撑，不必再靠模型自己凑。
    """
    icos_proposed = _text(row.get("org_b_para"))
    is_dispatched = _text(row.get("need_call_parameter_platform")) == "是"
    changed = (
        (_text(row.get("b_para")) != icos_proposed)
        if (is_dispatched and icos_proposed)
        else None
    )
    solution = row_solution(row)
    phase = _text(solution.get("phase"))

    # 决策链裁决的行（带 ``new_chain`` 块）：下发两格已是决策链的结论，准入态与原因看 ``new_chain``，
    # 不看 phase。块名与 ``enforced`` 键沿用 P6 双跑时期，存量行不迁移。
    chain = enforced_chain(row)
    if chain is not None:
        if not is_dispatched:
            state, label = "rejected", f"未准入·{_text(chain.get('reason'), _REJECT_REASON_DEFAULT)}"
        elif _text(chain.get("reason")) in _MULTI_ROUND_REASONS:
            state, label = "admitted", f"已准入·{_text(chain.get('reason'))}"
        elif _text(chain.get("reason")) == CASE_STEPS_REASON:
            # 按案例建议步数走了多步（2026-10-09）：过了规则校验，单列一档 —— 它不是对 ICOS 的「改写」，
            # 等于 ICOS 建议时也不是单纯「按建议值」（没有案例背书时会被压成一步）。
            state, label = "admitted", f"已准入·{CASE_STEPS_REASON}"
        elif chain.get("unchecked"):
            state, label = "admitted_unchecked", "已准入·未经规则校验"
        elif changed is None:
            state, label = "admitted", "已准入·无建议值快照"
        else:
            state, label = "admitted", "已准入·裁决改写" if changed else "已准入·按建议值"
        return {
            "is_dispatched": is_dispatched,
            "changed": changed,
            "admission_state": state,
            "admission_label": label,
        }

    if not is_dispatched:
        state, label = "rejected", f"未准入·{_reject_reason(solution, phase)}"
    elif phase in _MULTI_ROUND_LABEL_BY_PHASE:
        state, label = "admitted", f"已准入·{_MULTI_ROUND_LABEL_BY_PHASE[phase]}"
    elif phase in BYPASS_PHASES:
        state, label = "admitted_unchecked", "已准入·未经规则校验"
    elif changed is None:
        state, label = "admitted", "已准入·无建议值快照"
    else:
        state, label = "admitted", "已准入·裁决改写" if changed else "已准入·按建议值"

    return {
        "is_dispatched": is_dispatched,
        "changed": changed,
        "admission_state": state,
        "admission_label": label,
    }


def _group_by_plan_key(icos_rows: Sequence[Dict[str, Any]]) -> Dict[str, str]:
    """初案行 → ``{对齐键: 方案组编号原文}``（没下发编号的为空串）。

    方案组编号取 ``plan_group_number``（形如"LDH2002_G01"），与 :func:`icos_plan_facts`
    同一取法。**不是 ``type2``** —— 那是二级原因（"上行干扰方案组""低切换方案组"这类
    根因归类），与方案组编号是两个字段，混用会让两张表报出两套编号。
    同键取第一条：初案按推送先后取出、已按 execution_id 去重，同键只在缺 execution_id 时出现。
    """
    groups: Dict[str, str] = {}
    for plan in icos_rows or []:
        if not isinstance(plan, dict):
            continue
        key = plan_key(plan.get("execution_id"), plan.get("parachinname"))
        if key and key not in groups:
            groups[key] = _text(plan.get("plan_group_number"))
    return groups


def verdict_entries(
    round_rows: Sequence[Dict[str, Any]],
    icos_rows: Sequence[Dict[str, Any]] = (),
    cause_labels: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    """本轮决策行 → 逐动作的裁决条目（原值，不转义）。

    条目键：``group`` / ``cause`` / ``name`` / ``current`` / ``proposed`` / ``final`` /
    ``label`` / ``admission_state``（admitted / admitted_unchecked / rejected）/ ``changed``。
    同一形状也由 ``frontend_view.decision_tables.verdict_table`` 从裁决对象备出，
    两条来路共用 :func:`verdict_stats` 与展示层的同一份渲染。

    ``icos_rows`` 只用来填 ``group`` —— ``agent_execution_plan`` 上**没有
    plan_group_number 列**，编号只存在于初案侧，必须按 :func:`plan_key` 回查。
    ``cause_labels`` 同理填 ``cause``（与「根因收敛」表的「根因」列逐字相同），由
    :func:`services.decision.root_cause.root_cause_labels` 算好传进来；**本模块不反向
    import root_cause**（那边要用这里的 :func:`plan_key`，依赖必须单向）。
    两者都只影响展示列，不影响 :func:`verdict_stats` 的任何计数。
    """
    groups = _group_by_plan_key(icos_rows)
    refs = cause_labels or {}
    entries: List[Dict[str, Any]] = []
    for row in round_rows or []:
        if not isinstance(row, dict):
            continue
        state = verdict_row_state(row)
        row_key = plan_key(row.get("execution_id"), row.get("tool"))
        # 规则依据：取值约束（para）与带符号步长（rule_scope），谁裁决这一行就读谁的依据
        # （enforce 轮次是 07 的规则库结论，其余是合规链时期 llm_solution 自带的）。
        # 与 RuleRow.from_solution 同口径：优先 matched_rule、退回 rule_row，都没有就留空。
        basis = rule_basis(row)
        fact = basis.get("matched_rule") if isinstance(basis.get("matched_rule"), dict) else {}
        echo = basis.get("rule_row") if isinstance(basis.get("rule_row"), dict) else {}
        raw = fact or echo
        entries.append(
            {
                # 方案组编号在决策行上没有，按 execution_id 回查初案的 plan_group_number。
                "group": groups.get(row_key),
                # 根因同理：决策行上没有 type1/type2，按同一个键回查初案。
                # 回查不到（初案已清理、历史行缺 execution_id）留空，不猜。
                "cause": refs.get(row_key),
                # 参数中文名在决策行上就是 tool 列，与「下发参数对照表」同一取法。
                "name": row.get("tool"),
                "current": row.get("f_para"),
                "proposed": row.get("org_b_para"),
                "final": row.get("b_para"),
                "label": state["admission_label"],
                "admission_state": state["admission_state"],
                "changed": state["changed"],
                # 规则依据两格（原值，不转义）：取值约束与步长。展示层据此拼「>-128，步长-2」。
                "rule_para": _text(raw.get("para")),
                "rule_scope": _text(raw.get("rule_scope")),
            }
        )
    return entries


def verdict_stats(entries: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """裁决条目 → 计数。``OrderDecision.verdict`` 与整单判定的输入。

    ``admitted_count`` 与正文 context 里的 ``selected_action_count`` 必然相等 ——
    两者都是同一批行上 ``need_call_parameter_platform == "是"`` 的计数。
    只数前 :data:`ICOS_PLAN_TABLE_ROW_LIMIT` 条（既有口径，见该常量的说明）。
    """
    all_entries = [entry for entry in (entries or []) if isinstance(entry, dict)]
    listed = all_entries[:ICOS_PLAN_TABLE_ROW_LIMIT]
    admitted = unchecked = rejected = changed = multi_round = 0
    reasons: Dict[str, int] = {}
    for entry in listed:
        if entry.get("admission_state") == "rejected":
            rejected += 1
            label = _text(entry.get("label"), "待裁决")
            reasons[label] = reasons.get(label, 0) + 1
        else:
            admitted += 1
            if entry.get("admission_state") == "admitted_unchecked":
                unchecked += 1
            if entry.get("changed") is True:
                changed += 1
            if _text(entry.get("label")).removeprefix(_ADMITTED_PREFIX) in _MULTI_ROUND_REASONS:
                multi_round += 1
    return {
        "row_count": len(listed),
        "admitted_count": admitted,
        "unchecked_count": unchecked,
        "rejected_count": rejected,
        "changed_count": changed,
        "unchanged_count": admitted - changed,
        #: 准入里属于短评估多轮决策调整（缩步长 / 反向 / 回退）的条数 —— 它们按多轮决策阶梯取值、不做规则校验，
        #: 整单判定的叙述要把它们与「通过规则库校验」的分开说。
        "multi_round_count": multi_round,
        #: 未准入原因 → 条数。原因取自 phase 映射出的封闭词表，模型不得自拟。
        "rejected_reasons": reasons,
        "truncated_count": max(len(all_entries) - len(listed), 0),
    }


__all__ = [
    "ICOS_PLAN_TABLE_ROW_LIMIT",
    "UNGROUPED",
    "MULTI_ROUND_NOTE_KEY",
    "row_solution",
    "dispatch_order_key",
    "enforced_chain",
    "icos_plan_facts",
    "plan_key",
    "rule_basis",
    "verdict_entries",
    "verdict_row_state",
    "verdict_stats",
]
