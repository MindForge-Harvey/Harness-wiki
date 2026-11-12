# -*- coding: utf-8 -*-
"""整单复核 —— 决策链路里第一处**整单视角**的判断。

立项时（2026-09-17）裁决归合规链，它逐条初案跑、一次只看见一个参数，整单视角只有
``final_ratio`` 分档这一个粗动作（已取消，该列不再读；合规链 2026-09-25 已删除）。
于是两件事全系统没人回答：

1. **相关性** —— 这个参数跟这张工单的问题类型有没有关系。现网 142 个实际下发动作里
   69 个（49%）走 ``rule_match_bypass``，即"规则库里没有这条参数的规则 → 原样照发"，
   那条路上**不存在任何判断**。规则侧的资产（``参数×指标`` 映射表之类）按构造也覆盖
   不到它们 —— 它们恰恰是没有规则行的那批。
2. **冲突** —— 一批动作是 ``push_service`` 整批原子发出的，彼此方向相不相冲、功能互不
   互斥，逐参数调用**看不到兄弟动作，判不了**。

这两件事改版前由展示层那 11 节长文顺带做了（05 的"指标研判"、07 的"方案一致性"），
四步统一把展示层降成渲染器之后就一起没了。本模块是把它们**升回决策侧**，不是搬回展示层。

在哪跑
------
**决策流水线的「06 方案一致性」一步**（``DecisionService``）：决策链（04 → 07 → 08 → 决策条件）算完、
结论写回决策行之前，对即将写库的整轮跑一次；结论以 ``review=`` 传进 ``build_order_decision``，进裁决对象的
``consistency`` 与逐动作 ``relevance``，随 ``agent_order_decision`` 同事务落库（2026-09-23 起）。在那之前它是
独立线程 ``OrderReviewWorker``，推送之后补写 ``agent_execution_plan.order_review_json`` —— 那一列只剩存量轮在读。

裁决位：恒为 ``demote``
----------------------
判「指标存疑」的参数、批内「方向冲突 / 功能互斥」的冲突各方 → **不发**（2026-09-28 业务定）。依据由
:func:`review_demotions` 给出，剔除由决策链做（``chain.drop_by_review``，原因 ``整单复核·…``），之后对剩下的
下发集合重评 08 决策条件。多轮决策接管的参数不在其列（同 07 / 08）。

2026-10-03 业务：方案一致性影响下发，是决策链固定的一步 —— 原来的总开关 ``order_review.enabled``（默认关）、
只注记的观察档 ``mode: annotate`` 与外部提示词 ``prompt_path`` 一并退役（配着只告警，见 ``common.config``）。
库里存量轮的 ``consistency.mode`` 仍可能是 ``annotate``，读的一侧照样认得。

本模块自己**只给判断**，不碰库、不改 need_call：它返回 :class:`OrderReviewOutcome`，剔除由调用方做。

失败一律 fail-open
------------------
立项时实测的模型真实失败率在 10%～12%（合规链 ``plan_compliance`` 10%、``order_analysis`` 12%）。复核挂了就是没有复核
结论，**不能变成"这张工单不许下发"** —— 那等于给主链路加了个 12% 概率的拦路虎。
所有异常路径都落 :class:`ReviewPhase` 里的一个 ``*_bypass``，注记照写，说明为什么没有结论；demote 档下
没有结论（失败、模型漏判、超出送审条数）的参数一律照发。

封闭词表
--------
``relevance`` 三档、``conflict.kind`` 两档，**模型不得自拟**。理由同
``plan_table._REJECT_REASON_BY_PHASE``：放开自由措辞会出现"关联性一般""可能有帮助"，
上屏后没人能据此判断，也没法做回归断言。表外的词一律归到 :data:`RELEVANCE_UNJUDGED`
并计数 —— 不四舍五入到"中性"，那会把模型的失败伪装成一个结论。

整单判定不问模型
----------------
``order_verdict`` 走 :func:`services.decision.action_facts.order_dispatch_verdict`，
由裁决计数算出。模型只供相关性与冲突这两样它才有优势的东西；能数出来的一律不问它。
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple

from services import prompts
from services.common.config import DecisionSettings, get_settings
from services.common.llm import (
    LLMClient,
    LLMError,
    LLMTimeout,
    get_llm_client,
    reset_current_taskno,
    set_current_taskno,
)
from services.common.logging import get_logger
from services.common.text_utils import _text
from services.compliance.rule_constraint import parse_scalar_float
from services.decision.cause_dimensions import dimension_verdicts
from services.decision.action_facts import number_text, order_dispatch_verdict
from services.decision.multi_round import MULTI_ROUND_PHASE_SET
from services.decision.plan_table import (
    row_solution,
    plan_key,
    rule_basis,
    verdict_entries,
    verdict_row_state,
    verdict_stats,
)

logger = get_logger(__name__)

#: 本模块使用的提示词场景 key（见 services/prompts/assets/order_review.yaml）
PROMPT_SCENE = "order_review"

#: 落库 JSON 的结构版本。读取方按它决定怎么解 —— 加字段不用动，改语义要 +1。
REVIEW_SCHEMA_VERSION = 1

#: 裁决位，恒为 ``demote``（2026-10-03 起不再可配；``annotate`` 只出现在存量轮）。
REVIEW_MODE = "demote"


class ReviewPhase:
    """``order_review_json.phase`` 的取值 —— 排查时先看它定位走了哪条路。"""

    SUCCESS = "success"
    #: 总开关关着时的取值。2026-10-03 起复核恒做、没有开关，新一轮不再产生（词表保留，不改语义）。
    DISABLED = "disabled"
    #: 这一轮没有可复核的动作（整单全是档位跳过行）。
    NO_ACTION = "no_action"
    LLM_CALL_BYPASS = "llm_call_bypass"
    LLM_CALL_TIMEOUT_BYPASS = "llm_call_timeout_bypass"
    PARSE_BYPASS = "parse_bypass"
    #: 本行没参与复核（档位跳过）。整轮成功时个别行也会是这个。
    NOT_REVIEWED = "not_reviewed"


# --------------------------------------------------------------------------- #
# 封闭词表
# --------------------------------------------------------------------------- #
RELEVANCE_POSITIVE = "指标正向"
RELEVANCE_NEUTRAL = "指标中性"
RELEVANCE_DOUBTFUL = "指标存疑"
#: 模型没给、或给了表外的词。**不并进"中性"** —— 那会把一次失败伪装成一个结论，
#: 而"存疑率"正是 annotate 阶段要观测的那个数，掺了假的就白观测了。
RELEVANCE_UNJUDGED = "未判定"

RELEVANCE_VOCAB = (RELEVANCE_POSITIVE, RELEVANCE_NEUTRAL, RELEVANCE_DOUBTFUL)

#: 证据分级 —— **两档，由事实定死**（模型标错后端按事实改回来）。
#:
#: =============  ==========================================  ================
#: 档              依据                                        可核查性
#: =============  ==========================================  ================
#: 规则库事实      规则库为该参数登记的 type1/type2/operate      可核查到行
#: LLM原理补充     模型的参数化知识                             **不可核查**
#: =============  ==========================================  ================
#:
#: 2026-09-18 ~ 09-27 之间还有中间一档「知识库依据」（规则库无匹配、但从 qa 的文档知识库检索到了片段）。
#: 文档知识通道 2026-09-27 删除（决策用的知识一律在 order 内部构建、不调 qa），这一档只在那几天的存量轮里
#: 出现 —— 读的一侧照样认得（``EVIDENCE_KNOWLEDGE`` 留作历史取值），新一轮不再产出。
EVIDENCE_RULE = "规则库事实"
EVIDENCE_LLM = "LLM原理补充"
#: 历史取值：只出现在 2026-09-27 之前的存量轮（见上）。
EVIDENCE_KNOWLEDGE = "知识库依据"

#: 证据分级的封闭词表，按信息量降序（新一轮只产出这两档）。
EVIDENCE_VOCAB = (EVIDENCE_RULE, EVIDENCE_LLM)

CONFLICT_DIRECTION = "方向冲突"
CONFLICT_EXCLUSIVE = "功能互斥"
CONFLICT_VOCAB = (CONFLICT_DIRECTION, CONFLICT_EXCLUSIVE)
#: 冲突条目上模型的显式结论（2026-10-03）：只有 JSON 布尔 ``true`` 才算冲突，见 :func:`_parse_conflicts`。
CONFLICT_FLAG_KEY = "is_conflict"

#: ``llm_solution.phase`` 里表示"整档跳过"的历史取值（``decision.phase.Phase.SKIPPED_LOWER_PRIORITY``，
#: 2026-09-22 起不再产生，只在老轮次上）。同 ``root_cause`` 用字面量。
_PHASE_SKIPPED = "skipped_lower_priority"

#: 送进提示词的规则行字段。整行 40 列里只有这几列与"这参数治什么"有关，
#: 其余（band / 解析器 / 模板名之类）进去只会挤掉真正有用的上下文。
_RULE_KEYS = ("type1", "type2", "operate", "para", "rule_scope")


@dataclass
class OrderReviewOutcome:
    """一轮整单复核的结果。**只读产物，本模块不落库。**"""

    success: bool
    phase: str
    #: 裁决位。新一轮恒为 :data:`REVIEW_MODE`；存量轮可能是 ``annotate``（2026-10-03 前的观察档）。
    mode: str = "demote"
    #: ``plan_key → {"relevance", "path", "evidence"}``。只含真正判到的行。
    relevance: Dict[str, Dict[str, str]] = field(default_factory=dict)
    #: 真正进了提示词的那些行的对齐键。用来把「模型漏判」和「超出条数上限没送进去」
    #: 分开 —— 两者都是"这行没有结论"，但一个是模型的问题、一个是我们自己截断的。
    listed_keys: List[str] = field(default_factory=list)
    #: ``[{"members": [plan_key, ...], "kind", "reason"}]``，成员已对齐到本轮的行。
    conflicts: List[Dict[str, Any]] = field(default_factory=list)
    #: 整单判定，来自 :func:`order_dispatch_verdict`（代码算的，不问模型）。
    order_verdict: Dict[str, Any] = field(default_factory=dict)
    stats: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    error: Optional[str] = None
    elapsed_ms: int = 0
    reviewed_at: Optional[datetime] = None

    def row_slice(self, row: Dict[str, Any]) -> Dict[str, Any]:
        """整轮结果 → **这一行**的注记（``build_order_decision`` 按它填逐动作标注与 06 一致性）。

        形状与存量轮落在 ``order_review_json`` 里的那一份逐字相同 —— 裁决对象读新旧两种
        来源走的是同一段解析。整单部分（判定、计数）每行都带一份，逐行部分只放本行自己的
        相关性，和**涉及本行**的冲突。
        """
        key = plan_key(row.get("execution_id"), row.get("tool"))
        action = self.relevance.get(key)
        involved = [item for item in self.conflicts if key in (item.get("members") or [])]
        phase = self.phase
        if self.success and action is None:
            # 整轮跑通了但这一行没有结论，有三种原因，**必须分得开** ——
            # 混成一种展示层就得再猜一次，而猜错的方向正是"把我们自己的截断说成模型漏判"：
            #   档位跳过      → 本轮压根没试         → not_reviewed
            #   超出条数上限  → 没送进提示词         → not_reviewed
            #   送进去了没判  → 模型漏了这一条       → parse_bypass
            missed_by_model = key in self.listed_keys
            phase = ReviewPhase.PARSE_BYPASS if missed_by_model else ReviewPhase.NOT_REVIEWED
        return {
            "schema": REVIEW_SCHEMA_VERSION,
            "phase": phase,
            "mode": self.mode,
            "reviewed_at": (self.reviewed_at or datetime.now()).strftime("%Y-%m-%d %H:%M:%S"),
            "action": action,
            "conflicts": involved,
            "order": {
                **self.order_verdict,
                "relevance_counts": self.stats.get("relevance_counts", {}),
                # 两档证据分布：LLM原理补充剩多少，就是规则库还没覆盖的那部分。
                "evidence_counts": self.stats.get("evidence_counts", {}),
                "conflict_count": len(self.conflicts),
                "reviewed_action_count": self.stats.get("reviewed_action_count", 0),
            },
            "warnings": list(self.warnings),
            **({"error": self.error} if self.error else {}),
        }


def _is_skipped(row: Dict[str, Any]) -> bool:
    return _text(row_solution(row).get("phase")) == _PHASE_SKIPPED


def reviewable_rows(round_rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """本轮里真正要复核的行 —— 档位跳过的不算。

    ``skipped_lower_priority`` 是"更高档已出可下发动作，本档整档没试"，它没有裁决、
    没有规则行，问模型"它跟这单有没有关系"既无依据也无用处（它本轮不会发出去）。
    """
    return [row for row in round_rows or [] if isinstance(row, dict) and not _is_skipped(row)]


def _rule_snapshot(row: Dict[str, Any]) -> Dict[str, Any]:
    # 读哪一份依据由 plan_table.rule_basis 定：决策链的行是 07 的代码事实规则行，
    # 合规链时期的老行是合规链的 rule_row（按原口径，不改提示词入参）。
    rule_row = rule_basis(row).get("rule_row")
    if not isinstance(rule_row, dict):
        return {}
    snapshot = {key: rule_row.get(key) for key in _RULE_KEYS if rule_row.get(key) not in (None, "")}
    return snapshot


#: 「调整方向」的四个词（:func:`adjust_direction`）。数值类后面带幅度，如「调大（+4）」。
DIRECTION_UP = "调大"
DIRECTION_DOWN = "调小"
DIRECTION_SAME = "不变"
DIRECTION_NON_NUMERIC = "非数值"


def adjust_direction(current: Any, target: Any) -> str:
    """现网值 → 裁决后目标值的调整方向，**代码算好喂给模型**，不让它自己比较数值（2026-10-03）。

    实测小模型读不准负数门限的大小：「小区选择最小 RSRP -110 → -106」与「频内重选 -110 → -114」
    一抬一降，模型 5 次都说成「两者都在降低、方向一致」，真冲突因此漏判。
    两个值都是单个数 → 「调大（+4）」/「调小（-2）」/「不变」；否则（开关组合、枚举）→「非数值」，
    方向由模型看取值本身判。
    """
    before, after = parse_scalar_float(current), parse_scalar_float(target)
    if before is None or after is None:
        return DIRECTION_NON_NUMERIC
    delta = after - before
    if abs(delta) < 1e-9:
        return DIRECTION_SAME
    word = DIRECTION_UP if delta > 0 else DIRECTION_DOWN
    return f"{word}（{'+' if delta > 0 else ''}{number_text(delta)}）"


def build_review_context(
    order: Dict[str, Any],
    round_rows: Sequence[Dict[str, Any]],
    icos_rows: Sequence[Dict[str, Any]] = (),
    root_cause_refs: Optional[Dict[str, str]] = None,
    max_actions: int = 30,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """→ ``(提示词上下文, 进了上下文的那些行)``。

    工单侧只给**判相关性用得上**的那几个字段：问题类型（现象）、指标英文码、结论文本、
    制式与小区。**不给状态** —— 同 ``_order_analysis_context`` 的既有口径，状态一进去
    模型就会照抄成"当前闭环状态为 Received"，而这一节跟进度毫无关系。
    """
    rows = reviewable_rows(round_rows)
    listed = rows[:max_actions]
    refs = root_cause_refs or {}

    actions: List[Dict[str, Any]] = []
    for row in listed:
        key = plan_key(row.get("execution_id"), row.get("tool"))
        state = verdict_row_state(row)
        item = {
            "对齐键": key,
            "执行编号": _text(row.get("execution_id")),
            "参数中文名": _text(row.get("tool")),
            "现网值": _text(row.get("f_para")),
            "ICOS建议值": _text(row.get("org_b_para")),
            "裁决后目标值": _text(row.get("b_para")),
            # 判方向冲突以它为准：模型自己比较负数会读反（见 adjust_direction）。
            "调整方向": adjust_direction(row.get("f_para"), row.get("b_para")),
            "裁决结论": state.get("admission_label"),
            "是否进参数平台": "是" if state.get("is_dispatched") else "否",
            "根因锚点": refs.get(key, ""),
            # 规则行为空 = 规则库里没有这条参数的规则，模型据此决定证据分级。
            # 这一条必须显性化：它正是"这个动作没经过任何相关性判断"的那批。
            "规则库匹配行": _rule_snapshot(row) or None,
        }
        actions.append(item)

    ticket = {
        "工单编号": _text(order.get("taskno")),
        "问题类型": _text(order.get("task_type")),
        "指标英文码": _text(order.get("outside_type")),
        "网络制式": _text(order.get("nettype")),
        "小区名称": _text(order.get("cell_name")),
        "分析结果": _text(order.get("conclusion")),
        "分析概述": _text(order.get("smart_conclusion")),
    }
    # 六维判定（2026-10-29 晚用户定）：与 02 根因收敛同口径三路一起给 —— 分析结果 / 分析概述照旧，
    # 有内容的那几维附在后面；一维都没有时与之前逐字一样。
    if dimensions := dimension_verdicts(order):
        ticket["六维判定"] = dimensions
    context = {
        "工单": ticket,
        "本轮动作": actions,
        "说明": (
            "「规则库匹配行」为 null 表示规则库里没有这条参数的规则，"
            "该动作是按 ICOS 建议值直通下发的，判它的相关性只能靠无线机理。"
            "「调整方向」是后端按 现网值 → 裁决后目标值 算好的（调大 = 数值变大，如 -110 → -106 是调大），"
            "以它为准，不要自己比较数值。"
        ),
    }
    if len(rows) > len(listed):
        context["截断说明"] = f"本轮共 {len(rows)} 项动作，上表只列前 {len(listed)} 项"
    return context, listed


def _render_prompt(context: Dict[str, Any]) -> str:
    return prompts.render(PROMPT_SCENE, context=context)


def _normalize_relevance(value: Any) -> str:
    text = _text(value)
    return text if text in RELEVANCE_VOCAB else RELEVANCE_UNJUDGED


def _normalize_evidence(value: Any, has_rule: bool, warnings: List[str], key: str) -> str:
    """证据分级**由事实决定，不由模型决定**。

    两档的判据是后端已知的客观事实，与模型说什么无关：

    * 有规则库匹配行 → ``规则库事实``（适用根因大类与操作取向有登记）
    * 没有 → ``LLM原理补充``

    这里不接受模型的取值，只在它说错时记一句 warning —— 那是"模型以为自己有依据"
    的信号，值得看。反过来做（信模型的标注）会让最该标「LLM原理补充」的那批行 ——
    规则库无匹配、占现网下发动作 49% 的 bypass 行 —— 被模型一句"规则库事实"洗成
    有依据的结论。
    """
    expected = EVIDENCE_RULE if has_rule else EVIDENCE_LLM
    text = _text(value)
    if text and text != expected:
        warnings.append(f"模型给的证据分级与事实不符，已按事实改为「{expected}」：{key}")
    return expected


def _parse_actions(
    llm_obj: Dict[str, Any],
    listed: Sequence[Dict[str, Any]],
    warnings: List[str],
) -> Dict[str, Dict[str, str]]:
    """模型返回的逐条判断 → ``{对齐键: {...}}``。对不上的丢掉并记 warning。

    对齐一律按 :func:`plan_key`（执行编号 + 参数中文名），不按模型返回的下标 ——
    它漏一条、多一条、重排一次，下标就全错位，而错位不会报错，只会把 A 参数的判断
    挂到 B 参数头上。
    """
    by_key = {plan_key(row.get("execution_id"), row.get("tool")): row for row in listed}
    parsed: Dict[str, Dict[str, str]] = {}
    raw_actions = llm_obj.get("actions")
    if not isinstance(raw_actions, list):
        warnings.append("模型未返回 actions 数组，本轮逐条相关性为空")
        return parsed

    for item in raw_actions:
        if not isinstance(item, dict):
            continue
        key = plan_key(item.get("execution_id"), item.get("parachinname"))
        if key not in by_key:
            warnings.append(
                f"模型给出的动作对不上本轮任何一行，已丢弃："
                f"execution_id={_text(item.get('execution_id'))!r} "
                f"参数={_text(item.get('parachinname'))!r}"
            )
            continue
        if key in parsed:
            warnings.append(f"模型对同一个动作判了两次，保留第一次：{key}")
            continue
        parsed[key] = {
            "relevance": _normalize_relevance(item.get("relevance")),
            "path": _text(item.get("path")),
            "evidence": _normalize_evidence(
                item.get("evidence"), bool(_rule_snapshot(by_key[key])), warnings, key
            ),
        }

    missing = [key for key in by_key if key not in parsed]
    if missing:
        warnings.append(f"模型漏判了 {len(missing)} 项动作（按对齐键计）")
    return parsed


def _parse_conflicts(
    llm_obj: Dict[str, Any], listed: Sequence[Dict[str, Any]], warnings: List[str]
) -> List[Dict[str, Any]]:
    """模型返回的冲突 → 对齐后的清单。

    只认 **模型显式下了结论**（:data:`CONFLICT_FLAG_KEY` 是 JSON 布尔 ``true``）、**两个及以上成员都对得上
    且都进了参数平台**、``kind`` 在 :data:`CONFLICT_VOCAB` 里的冲突：

    * ``is_conflict`` 是 ``false``、缺失、或不是布尔（``"true"`` 这类字符串也不算）→ 不算冲突。2026-10-03 起加这一格：
      小模型会把「作用方向一致、不构成冲突」的对子照样写成 ``kind=方向冲突``（reason 里自己说不冲突），
      kind 在词表内、代码判不出来，demote 照剔；让模型先写 reason 再给结论，自相矛盾的那条自己就是 ``false``。
      拿不准一律按不冲突 —— 错也错在「不剔」这一边，与复核失败照发同一个方向；
    * 没发出去的动作之间谈冲突没有意义，本轮它根本不会生效；**多轮决策接管的行**（缩步长 / 反向 / 回退）也不当成员
      —— 它们是按上一轮评估从原值起算的值、不是新的调整，也不受 06 剔除，留着只会连带剔掉与之配对的新参数（2026-10-03）；
    * 词表外的 ``kind`` 说不清是哪种冲突，当不了 demote 的依据。

    丢弃的都记一条 warning。返回的冲突形状不变（``members`` / ``kind`` / ``reason``），结论格不落库 ——
    留下来的全是 ``true``。
    """
    # 多轮决策接管的行（缩步长 / 反向 / 回退）不当冲突成员（2026-10-03）：它们的值是按上一轮评估从原值起算的，
    # 相对现网值常常与新参数反向（缩步长往回走、回退恢复原值），却不是一次新的调整；它们本身也不受 06 剔除，
    # 留着只会让与之配对的新参数被连带剔掉。e2e 里两条回退行之间也被判过「方向冲突」。
    dispatched = {
        plan_key(row.get("execution_id"), row.get("tool"))
        for row in listed
        if verdict_row_state(row).get("is_dispatched") and row_solution(row).get("phase") not in MULTI_ROUND_PHASE_SET
    }
    raw_conflicts = llm_obj.get("conflicts")
    if raw_conflicts in (None, ""):
        return []
    if not isinstance(raw_conflicts, list):
        warnings.append("模型返回的 conflicts 不是数组，已忽略")
        return []

    conflicts: List[Dict[str, Any]] = []
    for item in raw_conflicts:
        if not isinstance(item, dict):
            continue
        if item.get(CONFLICT_FLAG_KEY) is not True:
            warnings.append(
                f"模型没有判定构成冲突（{CONFLICT_FLAG_KEY}={item.get(CONFLICT_FLAG_KEY)!r}），已丢弃："
                + _text(item.get("reason"))[:60]
            )
            continue
        members = item.get("members")
        if not isinstance(members, list):
            continue
        aligned = []
        for member in members:
            if isinstance(member, dict):
                key = plan_key(member.get("execution_id"), member.get("parachinname"))
            else:
                key = _text(member)
            if key in dispatched and key not in aligned:
                aligned.append(key)
        if len(aligned) < 2:
            warnings.append("模型给出的冲突对不上两条已准入动作，已丢弃")
            continue
        kind = _text(item.get("kind"))
        # 词表外的 kind 整条丢弃，**不兜底成「方向冲突」**：demote 档会把冲突各方真剔掉，
        # 兜底等于把模型没说清的东西当成了冲突（2026-10-02 前就是兜底，e2e 里假冲突照剔）。
        if kind not in CONFLICT_VOCAB:
            warnings.append(f"模型给出的冲突类型「{kind or '（空）'}」不在词表内，已丢弃")
            continue
        conflicts.append({"members": aligned, "kind": kind, "reason": _text(item.get("reason"))})
    return conflicts


def _stats(
    relevance: Dict[str, Dict[str, str]],
    listed: Sequence[Dict[str, Any]],
    total: int,
) -> Dict[str, Any]:
    counts = {word: 0 for word in (*RELEVANCE_VOCAB, RELEVANCE_UNJUDGED)}
    for item in relevance.values():
        counts[item["relevance"]] = counts.get(item["relevance"], 0) + 1
    evidence = {word: 0 for word in EVIDENCE_VOCAB}
    for item in relevance.values():
        evidence[item["evidence"]] = evidence.get(item["evidence"], 0) + 1

    return {
        "action_count": total,
        "listed_action_count": len(listed),
        "reviewed_action_count": len(relevance),
        "relevance_counts": counts,
        #: annotate 阶段真正要看的那个数：多少个实际发出去的动作被判成"跟这单没关系"。
        "doubtful_count": counts.get(RELEVANCE_DOUBTFUL, 0),
        #: 两档证据的分布。``EVIDENCE_LLM`` 剩多少，就是规则库还没覆盖的那部分。
        "evidence_counts": evidence,
        "truncated_count": max(total - len(listed), 0),
    }


def _bypass(
    phase: str, error: str, mode: str, order_verdict: Dict[str, Any], stats: Dict[str, Any]
) -> OrderReviewOutcome:
    """失败但不阻塞：注记照写，说明为什么没有结论。"""
    return OrderReviewOutcome(
        success=False,
        phase=phase,
        mode=mode,
        order_verdict=order_verdict,
        stats=stats,
        warnings=[error],
        error=error,
        reviewed_at=datetime.now(),
    )


def review_demotions(outcome: Optional[OrderReviewOutcome]) -> Dict[str, Tuple[str, str]]:
    """demote 档要剔掉的参数：``plan_key → (依据, 说明)``（2026-09-28 业务）。

    * 相关性判为 :data:`RELEVANCE_DOUBTFUL` 的 → 依据「指标存疑」，说明取模型给的作用路径；
    * 批内冲突（:data:`CONFLICT_VOCAB`）的**每个成员** → 依据是冲突类型，说明取模型给的理由。
      冲突各方全部剔除、不择优，与 08 同参数冲突剔除同一口径；成员只收已准入的（见 :func:`_parse_conflicts`）。

    **先剔存疑、再看冲突**（2026-10-03）：冲突里只要有一方判了「指标存疑」，它就不发了，冲突随之不存在，
    其余各方**不连带剔除**。之前一律剔冲突各方 —— e2e 里「SINR 低门限」已判存疑不发，与它「冲突」的开关照样被剔。
    （多轮决策接管的参数判存疑也照发，但它们不当冲突成员，见 :func:`_parse_conflicts`，所以这里不用区分。）

    复核没跑通（``*_bypass``）或没判到的参数不在结果里 —— 没有复核结论就照发（fail-open）。
    本函数只给依据，已准入与否、是不是多轮决策接管由剔除的一方再核一遍。
    """
    if outcome is None or not outcome.success:
        return {}
    drops: Dict[str, Tuple[str, str]] = {}
    for key, item in outcome.relevance.items():
        if item.get("relevance") == RELEVANCE_DOUBTFUL:
            drops[key] = (RELEVANCE_DOUBTFUL, _text(item.get("path")))
    removed = set(drops)
    for conflict in outcome.conflicts:
        kind = _text(conflict.get("kind"))
        if kind not in CONFLICT_VOCAB:
            continue
        members = [_text(key) for key in conflict.get("members") or []]
        if any(key in removed for key in members):
            continue
        for key in members:
            drops.setdefault(key, (kind, _text(conflict.get("reason"))))
    return drops


def run_order_review(
    order: Dict[str, Any],
    round_rows: Sequence[Dict[str, Any]],
    icos_rows: Sequence[Dict[str, Any]] = (),
    *,
    root_cause_refs: Optional[Dict[str, str]] = None,
    llm_client: Optional[LLMClient] = None,
    settings: Optional[DecisionSettings] = None,
) -> OrderReviewOutcome:
    """对**一轮**决策行跑整单复核。异常一律 fail-open，绝不抛给调用方。

    调用方是 ``DecisionService._review``（决策流水线「06 方案一致性」一步，落库前）；本函数不碰库、
    不改 ``need_call``，只给判断 —— demote 档由调用方按 :func:`review_demotions` 剔除。
    """
    settings = settings or get_settings().decision
    mode = REVIEW_MODE
    rows = reviewable_rows(round_rows)
    order_verdict = order_dispatch_verdict(verdict_stats(verdict_entries(round_rows, icos_rows)))

    if not rows:
        return OrderReviewOutcome(
            success=True,
            phase=ReviewPhase.NO_ACTION,
            mode=mode,
            order_verdict=order_verdict,
            stats=_stats({}, [], 0),
            warnings=["本轮没有可复核的动作（全部为档位跳过行）"],
            reviewed_at=datetime.now(),
        )

    context, listed = build_review_context(order, round_rows, icos_rows, root_cause_refs, settings.max_actions)
    base_stats = _stats({}, listed, len(rows))
    prompt = _render_prompt(context)
    client = llm_client or get_llm_client()

    token = set_current_taskno(order.get("taskno"))
    started = time.monotonic()
    try:
        llm_obj, raw_text, attempts = client.complete_json(
            prompt,
            timeout_seconds=settings.llm_timeout_seconds,
            max_attempts=settings.parse_max_attempts,
            retry_wait_seconds=settings.parse_retry_wait_seconds,
            scene=PROMPT_SCENE,
        )
    except LLMTimeout as exc:
        logger.warning(
            "整单复核 LLM 超时，本轮不产出复核结论（不影响下发）",
            extra={"taskno": order.get("taskno"), "error": str(exc)},
        )
        return _bypass(
            ReviewPhase.LLM_CALL_TIMEOUT_BYPASS, f"复核 LLM 调用超时：{exc}", mode,
            order_verdict, base_stats,
        )
    except LLMError as exc:
        logger.warning(
            "整单复核 LLM 调用失败，本轮不产出复核结论（不影响下发）",
            extra={"taskno": order.get("taskno"), "error": str(exc)},
        )
        return _bypass(
            ReviewPhase.LLM_CALL_BYPASS, f"复核 LLM 调用失败：{exc}", mode,
            order_verdict, base_stats,
        )
    except Exception as exc:  # noqa: BLE001 - 复核绝不能把主链路带崩
        logger.warning(
            "整单复核意外失败，本轮不产出复核结论（不影响下发）",
            extra={"taskno": order.get("taskno"), "error": str(exc)},
            exc_info=True,
        )
        return _bypass(
            ReviewPhase.LLM_CALL_BYPASS, f"复核意外失败：{exc}", mode, order_verdict, base_stats,
        )
    finally:
        reset_current_taskno(token)

    elapsed_ms = int((time.monotonic() - started) * 1000)

    if not isinstance(llm_obj, dict):
        logger.warning(
            "整单复核返回无法解析为 JSON，本轮不产出复核结论",
            extra={"taskno": order.get("taskno"), "attempts": attempts},
        )
        outcome = _bypass(
            ReviewPhase.PARSE_BYPASS,
            f"复核返回无法解析为 JSON（已重试 {attempts} 次）",
            mode, order_verdict, base_stats,
        )
        outcome.elapsed_ms = elapsed_ms
        return outcome

    warnings: List[str] = []
    relevance = _parse_actions(llm_obj, listed, warnings)
    conflicts = _parse_conflicts(llm_obj, listed, warnings)
    stats = _stats(relevance, listed, len(rows))

    logger.info(
        "整单复核完成",
        extra={
            "taskno": order.get("taskno"),
            "mode": mode,
            "action_count": stats["action_count"],
            "reviewed": stats["reviewed_action_count"],
            "doubtful": stats["doubtful_count"],
            "relevance_counts": json.dumps(stats["relevance_counts"], ensure_ascii=False),
            "evidence_counts": json.dumps(stats["evidence_counts"], ensure_ascii=False),
            "conflict_count": len(conflicts),
            "order_verdict": order_verdict.get("verdict"),
            "elapsed_ms": elapsed_ms,
            "attempts": attempts,
            "warnings": warnings,
        },
    )
    return OrderReviewOutcome(
        success=True,
        phase=ReviewPhase.SUCCESS,
        mode=mode,
        relevance=relevance,
        listed_keys=[plan_key(row.get("execution_id"), row.get("tool")) for row in listed],
        conflicts=conflicts,
        order_verdict=order_verdict,
        stats=stats,
        warnings=warnings,
        elapsed_ms=elapsed_ms,
        reviewed_at=datetime.now(),
    )


__all__ = [
    "CONFLICT_DIRECTION",
    "CONFLICT_EXCLUSIVE",
    "CONFLICT_FLAG_KEY",
    "CONFLICT_VOCAB",
    "adjust_direction",
    "EVIDENCE_KNOWLEDGE",
    "EVIDENCE_LLM",
    "EVIDENCE_RULE",
    "EVIDENCE_VOCAB",
    "PROMPT_SCENE",
    "RELEVANCE_DOUBTFUL",
    "RELEVANCE_NEUTRAL",
    "RELEVANCE_POSITIVE",
    "RELEVANCE_UNJUDGED",
    "RELEVANCE_VOCAB",
    "REVIEW_MODE",
    "REVIEW_SCHEMA_VERSION",
    "OrderReviewOutcome",
    "ReviewPhase",
    "build_review_context",
    "review_demotions",
    "reviewable_rows",
    "run_order_review",
]
