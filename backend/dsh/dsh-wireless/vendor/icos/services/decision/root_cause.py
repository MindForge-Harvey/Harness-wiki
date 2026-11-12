"""初案根因分组 —— **后端实际据以裁决的那套根因**，按 ``(type1, type2)`` 分组、排名、定主因。

这不是展示层自己的判断。分组的输入就是 ``icos_initial_plan_record`` 每条初案上的
``type1`` / ``type2`` —— 也就是 :func:`services.compliance.rule_library.match_rule_row`
的五元组匹配键的前两位，它决定命中哪一行规则、拿到什么取值约束与规则步长，
因而决定这个参数能不能调、调到多少。

排名只是**列出的先后**：按根因在初案里首次出现的次序（仓储按 ICOS 推送先后 ``sort_id``
给出）。2026-09-24 之前按初案 ``final_ratio`` 排，业务确认那一列没有任何意义、不得用于
方案决策，改掉了。

与 02 根因收敛（:mod:`services.decision.convergence`）不是一回事：那边的输入是工单的
``conclusion`` / ``smart_conclusion``，这边是初案的规则库匹配键。决策步 05 根因对齐
（:mod:`services.decision.alignment`）负责把两边对上。

为什么要有这个模块
------------------
改版前，界面上的"根因"有四套互不相干的来源：

1. ``wireless_order_info.type1/2/3`` —— 快照抬头的根因链；
2. ``icos_initial_plan_record.type1/type2`` —— **真正决定下发与否的那一套**；
3. ``order_analysis.root_cause_candidates`` —— 模型自造的候选与置信度；
4. 「根因收敛」那一节 —— 提示词要求模型只读 ``conclusion``/``smart_conclusion``
   自己再收敛一遍，并把 1 和 2 从输入里删掉。

于是「生成方案」那一节让模型把每个参数动作挂到第 4 套根因上，而真正决定这个参数
能不能调的是第 2 套。两条链各说各话。本模块把第 2 套**原样**整理出来，界面与正文
都只认它；模型的职责从"再收敛一遍"收窄成"解释这套收敛在专业上为什么成立"。

**本模块只出分组事实，不出 Markdown。** 「根因收敛」表、大屏「根因候选」面板的
展示字段（``dimension`` / ``evidence`` / ``confidenceLabel`` / Tailwind ``tone``）都在
:mod:`services.frontend_view.decision_render`（P5「渲染迁出决策包」）。

口径边界
--------
* **只分组，不参与匹配**。结果不回写、不改写初案的 type1/type2，规则库匹配键一个字都
  没动。让多源收敛的结果真正进入匹配键是另一回事，得单独一轮、单独验证。
  现网数据也不支持急着做：规则库统共只有 19 组 (type1, type2)、``type1`` 只有
  参数通用 / 干扰 / 覆盖 / 资源 四个值，而收敛错了会打成 ``RuleNotMatched``，
  那条路恰恰是 **bypass 直通下发** —— "根因判得更细"反而会绕过全部校验。
* **不编置信度**。初案上没有任何研判置信度（``final_ratio`` 没有意义，不读）。
* **不臆造根因**。初案没带 type1/type2 的不成组，不拿工单的 type1/type2/type3 顶替 ——
  那是另一套来源（上面第 1 套）。

依赖是单向的：本模块 import ``plan_table.plan_key``（初案与决策行的唯一对齐键），
反过来没有 —— 裁决条目的「根因」列由调用方把 :func:`root_cause_labels` 算好传进去。
"""
from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

from services.decision.plan_table import plan_key as _plan_key
from services.common.text_utils import _text

#: 组结论的封闭词表。**模型不得自拟**，也不得改写。
#:
#: 与改版前模型自己填的 ``主因/次因/已排除`` 相比，第三档换成了「未进入本轮」：
#: 那一档指的是旧版逐档策略下"更高档已产出可下发动作，本档整档没试"（``phase=
#: skipped_lower_priority``，2026-09-22 起不再产生，只在历史轮次里），方案本身并没有被
#: 否定，叫「已排除」会读成"根因被证伪"。
VERDICT_PRIMARY = "主因"
VERDICT_SECONDARY = "次因"
VERDICT_NOT_THIS_ROUND = "未进入本轮"

#: ``llm_solution.phase`` 里表示"整档跳过"的历史取值（``decision.phase.Phase.SKIPPED_LOWER_PRIORITY``，
#: 2026-09-22 起不再产生，只在老轮次上）。这里用字面量，本模块是包内叶子，不为一个常量多一条 import。
_PHASE_SKIPPED = "skipped_lower_priority"


def _cause_label(level1: str, level2: str) -> str:
    """一级/二级原因 → 根因名。二级缺失时只报一级。"""
    if level1 and level2:
        return f"{level1} / {level2}"
    return level1 or level2


def row_action_state(row: Dict[str, Any]) -> str:
    """决策行 → 该动作在本轮的下场：``admitted`` / ``skipped`` / ``rejected``。

    只分三档，比 ``plan_table.verdict_row_state`` 粗：本模块要报的是"这条根因本轮
    有没有被动手"，不是"每个参数各自为什么"。

    ⚠ ``llm_solution`` 是 JSON 原文时对它做**子串匹配**（不解析），名字里带
    ``skipped_lower_priority`` 的其它取值会被误读成整档跳过。这是既有口径，对象路径
    （``ActionVerdict.round_state``）按解析出来的准入态判、没有这个缺陷；现实行上两者相等。
    """
    if _text(row.get("need_call_parameter_platform")) == "是":
        return "admitted"
    llm_solution = row.get("llm_solution")
    if isinstance(llm_solution, dict):
        phase = _text(llm_solution.get("phase"))
    else:
        text = _text(llm_solution)
        phase = _PHASE_SKIPPED if _PHASE_SKIPPED in text else ""
    return "skipped" if phase == _PHASE_SKIPPED else "rejected"


def row_action_states(round_rows: Sequence[Dict[str, Any]]) -> List[Tuple[str, str]]:
    """本轮决策行 → ``[(对齐键, 下场), ...]``，:func:`root_cause_groups` 的第二个入参。"""
    return [
        (_plan_key(row.get("execution_id"), row.get("tool")), row_action_state(row))
        for row in (round_rows or [])
        if isinstance(row, dict)
    ]


def root_cause_groups(
    icos_rows: Sequence[Dict[str, Any]],
    action_states: Sequence[Tuple[str, str]] = (),
) -> Tuple[List[Dict[str, Any]], int]:
    """初案 + 本轮动作下场 → ``(groups, unmatched)``。

    ``action_states`` 是本轮每个动作的 ``(对齐键, 下场)``，下场取 ``admitted`` /
    ``skipped`` / ``rejected``：按行来的走 :func:`row_action_states`，按裁决对象来的由
    ``frontend_view.decision_tables`` 从 ``ActionVerdict.admission`` 备出。
    ``unmatched`` 是挂不上任何根因组的动作数（初案被清理、历史行缺 execution_id）。

    ``groups`` 按排名给出，每组：``rank`` / ``cause`` / ``level1`` / ``level2`` / ``level3`` /
    ``plan_group_numbers`` / ``execution_ids`` / ``plan_count`` /
    ``action_count`` / ``admitted_count`` / ``skipped_count`` / ``rejected_count`` /
    ``verdict`` / ``selected``。

    分组
    ----
    按 ``(type1, type2)`` 分组，**不按方案组编号**：一个方案组可以含多个参数，多个
    方案组也可能挂同一条根因；决定规则命中的是 (type1, type2)，分组就按它。

    排序
    ----
    按根因在初案里**首次出现**的次序（仓储按 ICOS 推送先后给出）—— 只是列出的先后，
    **不代表优先级**。**不看 ``final_ratio``**（2026-09-24 业务：没有意义）。
    **排名只取决于初案**，与动作下场无关 —— 所以只要 :func:`root_cause_refs` 的调用方
    （裁决对象、整单复核）不传 ``action_states``，拿到的引用也一样。

    结论
    ----
    * ``主因`` —— 本轮据此**下发了参数**的那条根因（多条时取排名最前的）。整单一条
      都没准入时退到排名第一条：那是系统实际尝试过的根因，不是没有结论。
      **有且仅有一条**（``selected`` 为真的那组）。
    * ``未进入本轮`` —— 该组动作全部是历史轮次的整档跳过（``skipped_lower_priority``）。
    * ``次因`` —— 其余。
    """
    groups: Dict[Tuple[str, str], Dict[str, Any]] = {}
    order: List[Tuple[str, str]] = []
    #: 对齐键 → 该初案所属的分组键。决策行靠它回查自己挂在哪条根因上。
    key_to_group: Dict[str, Tuple[str, str]] = {}

    for plan in icos_rows or []:
        if not isinstance(plan, dict):
            continue
        level1, level2 = _text(plan.get("type1")), _text(plan.get("type2"))
        if not level1 and not level2:
            # 初案没带根因字段 —— 不拿工单的 type1/type2 顶替（那是另一套来源）。
            continue
        group_key = (level1, level2)
        if group_key not in groups:
            order.append(group_key)
            groups[group_key] = {
                "level1": level1,
                "level2": level2,
                "level3": "",
                "cause": _cause_label(level1, level2),
                "plan_group_numbers": [],
                "execution_ids": [],
                "plan_count": 0,
                "action_count": 0,
                "admitted_count": 0,
                "skipped_count": 0,
                "rejected_count": 0,
            }
        group = groups[group_key]
        group["plan_count"] += 1
        if (level3 := _text(plan.get("type3"))) and level3 not in group["level3"]:
            group["level3"] = f"{group['level3']}、{level3}" if group["level3"] else level3
        if (number := _text(plan.get("plan_group_number"))) and number not in group["plan_group_numbers"]:
            group["plan_group_numbers"].append(number)
        if key := _plan_key(plan.get("execution_id"), plan.get("parachinname")):
            key_to_group.setdefault(key, group_key)
            if key not in group["execution_ids"]:
                group["execution_ids"].append(key)

    # 本轮动作按对齐键回挂到根因组上。挂不上的只影响该组的计数，不影响其余组。
    unmatched = 0
    for action_key, state in action_states or []:
        group_key = key_to_group.get(action_key)
        if group_key is None:
            unmatched += 1
            continue
        group = groups[group_key]
        group["action_count"] += 1
        group[f"{state}_count"] += 1

    ranked = order
    if not ranked:
        return [], unmatched

    # 主因：排名最前、真的下发了参数的那条；一条都没准入就退到排名第一条。
    primary_key = next((key for key in ranked if groups[key]["admitted_count"]), ranked[0])

    result: List[Dict[str, Any]] = []
    for index, group_key in enumerate(ranked):
        group = groups[group_key]
        if group_key == primary_key:
            verdict = VERDICT_PRIMARY
        elif group["action_count"] and group["skipped_count"] == group["action_count"]:
            verdict = VERDICT_NOT_THIS_ROUND
        else:
            verdict = VERDICT_SECONDARY
        result.append(
            {
                "rank": index + 1,
                **group,
                "plan_group_numbers": list(group["plan_group_numbers"]),
                "execution_ids": list(group["execution_ids"]),
                "verdict": verdict,
                "selected": group_key == primary_key,
            }
        )
    return result, unmatched


#: :func:`converged_cause_match` 的三种结果。
CONVERGED_MATCHED = "matched"
#: 初案一级原因是「参数通用」、二级原因也对不上任何收敛根因 —— 不针对某一条根因的通用方案。
#: 与 05 根因对齐的四档同名（``alignment.ASSOCIATION_GENERAL``）。
CONVERGED_GENERIC = "generic"
CONVERGED_UNMATCHED = "unmatched"

#: 初案 ``type1`` 里表示通用方案的取值（同 ``alignment.TYPE1_GENERIC``；那边 import 了 convergence，这里不跟进）。
_TYPE1_GENERIC = "参数通用"


def converged_cause_match(
    plan: Dict[str, Any], causes: Sequence[Dict[str, Any]]
) -> Dict[str, Any]:
    """一条初案 → 它对应 **02 收敛根因**里的哪几条（2026-09-27 业务：「生成方案」裁决表的「根因」列
    用收敛后的根因）。

    02 根因收敛**不产逐动作的指针**（它读的是工单原文，里面没有能对齐到具体参数的标识），04 关联判定也只判
    「方案与这几条根因整体相关与否」。所以这里按初案**自己声明的**一级/二级原因去对收敛根因，两级：

    1. 名称 —— 收敛根因名与初案二级原因相同，或被二级原因包含（``过覆盖`` ⊂ ``过覆盖方案组B``）；
    2. 类别 —— 名称都对不上时，收敛根因的类别（六词表）与初案一级原因相同。

    返回 ``{"status", "ranks", "plan_cause"}``：``ranks`` 是对上的收敛根因的 ``rank``（按收敛表先后，
    低置信的也算 —— 收敛表上它照样有一行）；都对不上时 ``status`` 为 :data:`CONVERGED_GENERIC`
    （一级原因是「参数通用」）或 :data:`CONVERGED_UNMATCHED`，``plan_cause`` 是初案自己的根因名，供展示「对不上」。

    这是**对应关系，不是裁决**：不进任何裁决门。2026-10-03 起 05 根因对齐由模型以网优专家身份判
    （:mod:`services.decision.cause_alignment`），本函数退为它的兜底（模型没判到 / 调用失败的方案），
    以及 schema 13 之前的轮次「根因」列的来源。
    """
    level1, level2 = _text(plan.get("type1")), _text(plan.get("type2"))
    rows = [item for item in causes or [] if isinstance(item, dict) and _text(item.get("cause"))]
    by_name = [
        item for item in rows
        if level2 and (_text(item.get("cause")) == level2 or _text(item.get("cause")) in level2)
    ]
    matched = by_name or [
        item for item in rows if level1 and level1 != _TYPE1_GENERIC and _text(item.get("level1")) == level1
    ]
    if matched:
        status = CONVERGED_MATCHED
    else:
        status = CONVERGED_GENERIC if level1 == _TYPE1_GENERIC else CONVERGED_UNMATCHED
    return {
        "status": status,
        "ranks": [int(item.get("rank") or 0) for item in matched],
        "plan_cause": _cause_label(level1, level2),
    }


def root_cause_labels(
    icos_rows: Sequence[Dict[str, Any]], groups: Sequence[Dict[str, Any]]
) -> Dict[str, str]:
    """``{对齐键: "覆盖 / 过覆盖"}`` —— 每个参数动作挂在哪一组根因上，取值与「根因收敛」表的「根因」列**逐字相同**。

    ``groups`` 取 :func:`root_cause_groups` 的分组（或展示层由它渲染出的候选，只用 ``cause`` 一个键）。
    有了它，每个参数动作的根因锚点是**回查出来的**，不再由模型自己往收敛表上挂。
    展示层的裁决表「根因」列用它（2026-10-03 业务：与「根因收敛」表的根因一一对应，不带序号）。
    """
    known = {item["cause"] for item in groups}
    labels: Dict[str, str] = {}
    for plan in icos_rows or []:
        if not isinstance(plan, dict):
            continue
        cause = _cause_label(_text(plan.get("type1")), _text(plan.get("type2")))
        key = _plan_key(plan.get("execution_id"), plan.get("parachinname"))
        if key and cause in known:
            labels.setdefault(key, cause)
    return labels


def root_cause_refs(
    icos_rows: Sequence[Dict[str, Any]], groups: Sequence[Dict[str, Any]]
) -> Dict[str, str]:
    """``{对齐键: "#1 覆盖 / 过覆盖"}`` —— 决策侧的根因引用（裁决对象 ``actions[].cause.ref``、整单复核上下文）。

    同 :func:`root_cause_labels`，前面带上该组在分组里的序号。展示层的裁决表不用它（不带序号，见上）。
    """
    ranks = {item["cause"]: item["rank"] for item in groups}
    return {key: f"#{ranks[cause]} {cause}" for key, cause in root_cause_labels(icos_rows, groups).items()}


__all__ = [
    "CONVERGED_GENERIC",
    "CONVERGED_MATCHED",
    "CONVERGED_UNMATCHED",
    "VERDICT_NOT_THIS_ROUND",
    "VERDICT_PRIMARY",
    "VERDICT_SECONDARY",
    "converged_cause_match",
    "root_cause_groups",
    "root_cause_labels",
    "root_cause_refs",
    "row_action_state",
    "row_action_states",
]
