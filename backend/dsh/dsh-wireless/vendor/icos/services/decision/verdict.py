# -*- coding: utf-8 -*-
"""类型化裁决对象 —— 「这张工单本轮是什么下场」，生产一次、所有人只读。

这是《网优自闭环决策链路重构方案》P1 的全部产出。它解决的不是精度问题，是**结构**问题：
今天库里没有任何类型化的裁决结果，裁决散在 ``agent_execution_plan`` 的 6 个列 + 3 个 JSON
列里，于是每个消费者自己重新推导一遍 —— ``llm_solution`` 有 4 处独立解析，
``need_call`` 涉及 12 个文件，``root_cause.row_action_state`` 与 ``plan_table.verdict_row_state``
是两套各自实现的「这行什么下场」。加一个消费者就多一套推导，这才是根因。

P1 的边界（**这一条最要紧，动手改之前先读**）
--------------------------------------------
本模块**一行推导都不新写**。:func:`build_order_decision` 做的事只有一件：调用现有的
单一来源函数，把它们的返回值装进类型里。

======================  ==================================================
对象字段                 它照抄的那一处
======================  ==================================================
``ActionVerdict.*``      :func:`services.decision.plan_table.verdict_row_state`
``.phase``               :func:`services.decision.plan_table.row_solution`
``.need_call``           ``services.orders.push_service._need_call`` 的同构实现
``.rule_row`` / ``.step`` :func:`services.decision.plan_table.rule_basis`（谁裁决读谁的依据）+ :func:`~services.decision.action_facts.domain_margin`
``.warnings`` / ``.error`` :func:`services.decision.plan_table.rule_basis`（同上）
``.chain``               :func:`services.decision.plan_table.enforced_chain`
``.cause``               :func:`services.decision.root_cause.root_cause_refs`
``OrderDecision.causes`` :func:`services.decision.cause_dimensions.converge_order`（六维 / 结论两字段选源）
``OrderDecision.verdict``:func:`services.decision.action_facts.order_dispatch_verdict`
======================  ==================================================

所以「对象字段 == 现有各处推导」在**构造上**就是成立的，``tests/test_verdict.py``
只负责把它钉死，防止后面有人在这里悄悄写第二套口径。

``causes`` 那一行是唯一一处**换过源**的：从初案 ``type1/type2`` 分组（那是**决策步 05
根因对齐**，不是收敛）换成了 **02 根因收敛**。收敛本身住在新模块
:mod:`services.decision.convergence` 里，**本模块仍然只做装配 —— 上面那条边界没破**。

**P1 不改任何调用方。** 4→1 的收口是 P5 的活（展示层降为渲染），本模块先把靶子立起来。

2026-09-23 起**对象转正**：``DecisionService`` 在每轮决策写完决策行之后调用
:func:`build_order_decision`，把结果落进 ``agent_order_decision`` 表（一单一轮一行）。
01 信息汇总与对齐、03 方案目标确认的确定性部分也在这一轮落进对象（见各自的类文档）。

本模块里的编号一律是「决策步」，不是「展示层节号」
--------------------------------------------------
两套编号在这个仓库里同时存在，而且**数字会撞**，看注释前先分清是哪一套：

* **决策步 01–08**（本模块、:mod:`services.decision.verdict` 用的就是这套）——
  2026-09-18 改版流程图：01 信息汇总与对齐 / 02 根因收敛 / 03 方案目标确认 /
  04 生成方案 / 05 根因对齐 / 06 方案一致性校验 / 07 参数风险评估 /
  08 综合决策及参数编排。见《决策链路重构方案》。
* **展示层节号 01–11**（:mod:`services.decision.plan_table`、
  :mod:`services.decision.action_facts`、``prompts/assets/solution_generation.yaml``
  与 ``narrative.sections.SOLUTION_SECTION_SCENE_HEADINGS`` 用的是这套）——
  方案决策正文的 11 个小标题，01 触发来源 … 05 生成方案 … 11 最终参数方案。

撞得最狠的是 **05**：决策步 05 是「根因对齐」，展示层 05 节是「生成方案」。
``plan_table`` 文档里的「05 节那张表」指的是后者，与本模块的 05 无关。

改版前本模块写的是六步编号（``causes`` 标 ``03a``、``consistency`` 标 ``04`` 之类），
已全部按八步图改过。旧编号 → 新编号：``03a``→02、``02``→03、``03b``→05、
``04``→06、``05``→07、``06``→08。**只改了注释，没有任何行为变更。**

还没填满的字段
--------------
``consistency``（06）由整单复核给出：2026-09-23 起复核**并进决策的同步路径**
（``DecisionService`` 在落库前跑、以 ``review=`` 传进来），决策时产出的对象就带着它；
复核恒做（2026-10-03 起没有开关），重推理轮次决策链没东西可发时不复核、``reviewed=False``。
事后从 DB 行重建的**存量轮**仍按行上的 ``order_review_json``
读（那是复核还在异步旁路时写的注记，新一轮不再写这一列）。
``iterations``（P4 调优 / 剔除 / 回环）取自决策链，合规链时期的老轮次与回退轮为空。``gate``（决策条件）只有决策时产出的对象才带
（:mod:`services.decision.gate` 的 observe 评估），事后从 DB 行重建的对象恒为未评估。
``candidates``（04）同理：决策时产出才有，事后重建为 ``None``。

这类字段一律带一个显式的「有没有评估过」布尔位（``evaluated`` / ``reviewed``），
**不能用空集合表示未评估** —— 「评估过，没有冲突」和「压根没评估冲突」是两个结论，
混成一个，P3 双跑对比时就分不出「新链路发现问题」和「老链路没这一步」。

与三个包的职责对齐
------------------
本模块属于 ``services/decision/``：只认 DB 事实与裁决，**不认识 Markdown、不认识前端、
不写库**。所以 :class:`Cause` 刻意没有「根因候选」面板上的 ``tone``（Tailwind 类名）与
``confidenceLabel``（成品展示文案）—— 那两个是展示口味，已随 P5 迁到
``services/frontend_view/decision_render.py``。

依赖方向
--------
``verdict → {action_facts, root_cause, order_review} → plan_table``，单向，无环。
本模块不 import ``services.orders``（仓储是调用方），由
``tests/test_decision_package.py`` 钉死。因此**本轮的行由调用方筛好再传进来**
（同 :func:`~services.decision.plan_table.verdict_entries` 的既有约定），
不在这里重写一遍 ``repository.latest_round_rows``。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Sequence, Tuple

from services.decision.phase import BYPASS_PHASES, Phase
from services.decision.pipeline import StageRecord
from services.compliance.rule_library import normalize_nettype
from services.compliance.rule_constraint import (
    para_kind,
    parse_scalar_float,
    parse_step,
)
from services.common.text_utils import _text
from services.decision.action_facts import (
    VERDICT_AUTO,
    VERDICT_CONDITIONAL,
    VERDICT_NONE,
    domain_margin,
    order_dispatch_verdict,
)
from services.decision.alignment import align_root_causes
from services.decision.cause_alignment import CauseAlignment
from services.decision.case_evidence import ActionCaseBasis, CaseEvidence
from services.decision.cause_convergence import (
    DEFAULT_CONFIDENCE_THRESHOLD,
    CauseConvergence,
    CauseStanding,
    ConvergenceStatus,
)
from services.decision.cause_dimensions import DIMENSION_FIELDS, converge_order
from services.decision.convergence import (
    CONFIDENCE_ABSENT,
    SOURCE_DIMENSIONS,
    ConclusionShape,
    ConvergenceResult,
)
from services.decision.order_review import RELEVANCE_UNJUDGED, RELEVANCE_VOCAB, OrderReviewOutcome
from services.decision.plan_table import (
    row_solution,
    enforced_chain,
    icos_plan_facts,
    plan_key,
    rule_basis,
    verdict_entries,
    verdict_row_state,
    verdict_stats,
)
from services.decision.root_cause import root_cause_groups, root_cause_refs

if TYPE_CHECKING:  # 仅类型注解：candidate_set → rule_assessment → verdict，运行期 import 会成环
    from services.decision.candidate_set import CandidateSet

#: 本对象的结构版本。**改了字段语义就 +1**；加字段不用动。
#: 与 ``decision_trace_json`` / ``order_review_json`` 同一规矩：库里会长期同时存在多个
#: 版本的行，消费方靠它决定按哪套字段读，而不是靠猜哪些键存在。
#:
#: 1 → 2：``causes`` 换源。:class:`Cause` 的 ``cause`` / ``level1`` / ``level2`` /
#: ``basis`` / ``confidence`` / ``confidence_source`` / ``verdict`` / ``selected``
#: 语义全变了（从初案对齐换成 **02 根因收敛**），另加 ``suggestion`` / ``aligned``
#: 两个字段。今天库里 0 行携带 ``OrderDecision``，**不存在混版本人群 ——
#: 正因为这样，现在改是最便宜的时刻**。
#:
#: 2 → 3（2026-09-23，对象转正、开始落库）：字段顺序按流程图 01→08 重排（``causes`` 02
#: 排到 ``objective`` 03 前面）；新增 ``candidates``（04）、``facts.summary`` /
#: ``plan_stats`` / ``issues``（01）、``objective`` 的目标小区与确认（03）、
#: ``ActionVerdict.risk_basis`` / ``path`` / ``gate_failed``（07 / 05 / 08 注记）；
#: ``gate`` 决策时可为已评估。``objective.confirmed`` 语义从「恒 False」变成确定性判断。
#:
#: 3 → 4（2026-09-24，业务：初案 ``final_ratio`` 没有任何意义、不得用于方案决策）：删
#: ``ActionVerdict.final_ratio``、``ChainAction.final_ratio``、``facts.plans[].final_ratio``；
#: 候选集删 ``tier`` / ``tier_index`` / ``items[].final_ratio``；08 冲突剔除的 ``rule`` 只剩
#: ``drop_all``（冲突各方全部剔除），旧的 ``priority`` / ``tie_drop_all`` 只在 v3 行里；
#: 初案根因分组（``actions[].cause``）的排名改为 ICOS 推送先后。
#:
#: 4 → 5（2026-09-24，业务：根因收敛结果要带置信度）：``causes`` 默认改由 **02 模型收敛**产出
#: （``basis`` = :data:`CauseBasis.ORDER_CONCLUSION_MODEL`）—— ``confidence`` 从恒 0 变成 0–100 的
#: 置信度，``verdict`` 取主因 / 次因 / 低置信（与阈值比较），``evidence`` 是模型摘录的原文依据；
#: 模型收敛失败时退回确定性解析（``basis`` 仍是 ``ORDER_CONCLUSION``、无置信度）。新增
#: ``cause_convergence``（状态 / 阈值 / 模型给的理由）。04 关联判定的 ``root_cause`` 改记送进去的高置信根因。
#:
#: 5 → 6（2026-09-25，短评估结果参与多轮决策）：新增 ``prior_rounds``（紧跟 ``facts``，01 的输入一源）——
#: 前几轮下发了什么、执行回执、短评估结论与逐项指标，以及由此得出的多轮决策排除（前几轮动过、评估没通过的
#: 参数本轮不再调，见 :mod:`services.decision.prior_round`）。首轮是空块，事后重建是 ``None``。
#:
#: 6 → 7（2026-09-25 业务拍板多轮决策阶梯）：``prior_rounds.excluded`` 换成 ``outer``（本轮每个动过的参数
#: 的多轮决策动作：缩步长 / 反向 / 回退 / 不再调，见 :mod:`services.decision.outer_loop`），新增
#: ``histories``（逐参数原值 / 现网值 / 试过的值）与 ``rollback_round``（转人工前的回退轮）。
#:
#: 7 → 8（2026-09-25 合规链删除）：``shadow`` 里与合规链对照的那几格全部拿掉 —— 逐动作的
#: ``before_dispatched`` / ``before_value`` / ``change``，整份的 ``changed`` / ``blocks_order`` /
#: ``dispatched_before`` / ``dropped`` / ``added`` / ``tuned`` / ``uncompared``。决策链是唯一的裁决者，
#: 没有「另一边」可比；``mode`` 恒为 ``enforce``。
#:
#: 8 → 9（2026-09-26 决策流水线）：新增 ``pipeline`` —— 这一轮每一步的轨迹（步骤编号 / 名字 / 跑没跑 /
#: 耗时 / 摘要），``services.decision.pipeline`` 产出，按执行顺序。
#:
#: 9 → 10（2026-09-27 决策案例知识库）：新增 ``cases``（04 案例参考：本轮每条候选的同类先例、成败、
#: 案例支撑度与引用案例，紧跟 ``candidates``）与 ``actions[].case_basis``（该动作的那一份）。
#: 案例库开关关着、或事后从 DB 行重建时两者都是 ``None``。
#:
#: 10 → 11（2026-09-27 文档知识通道删除）：``consistency`` 拿掉 ``knowledge_asked_count`` /
#: ``knowledge_hit_count``（order → qa 的检索不存在了）；``facts.sources`` 的「知识库/案例库」一行换成
#: 「案例库」，按本轮 04 案例参考如实报通没通。证据分级新一轮只有两档（「知识库依据」只在存量轮）。
#:
#: 11 → 12（2026-10-03「外环」改称「多轮决策」）：``prior_rounds.outer`` 改名 ``prior_rounds.multi_round``，
#: ``actions[].phase`` 的多轮决策三档取值 ``outer_loop_*`` 改为 ``multi_round_*``。读存量对象时两套名字都认
#: （:func:`services.decision.multi_round.multi_round_from_doc`、:func:`services.decision.phase.canonical_phase`）。
#:
#: 12 → 13（2026-10-03 业务：05 根因对齐由模型以网优专家身份判「02 收敛根因 ⟷ 方案」的对应关系）：新增
#: ``alignment``（紧跟 ``cases``，:meth:`services.decision.cause_alignment.CauseAlignment.to_dict`：逐方案针对哪几条
#: 根因、四档关联、理由与来源，以及有根因无方案；``demotion`` / ``demoted`` 是对下发的影响 —— 模型判「不一致」的
#: 方案在决策链里不发，不剔到零）；``actions[].association`` 与 ``cause_gaps`` 改由它出（模型没判到
#: 的方案按初案原因对上），模型收敛的 ``causes`` 填上挂接计数并 ``aligned=True``。02 模型收敛没有根因时 ``alignment``
#: 是 ``not_called``、四档照旧按类别；事后从 DB 行重建时为 ``None``。
#:
#: 13 → 14（2026-10-09 去掉 P6 双跑时期的「影子」叫法）：决策链的结论 ``shadow`` 改名 ``chain``（形状不变，
#: 即 :meth:`ChainVerdict.to_dict`）。代码里没有读它的地方（推送、展示、正文都读 ``actions``），所以存量对象
#: 不迁移、读侧也不用认旧名；手写排查 SQL 时 schema ≤ 13 的行在 ``shadow`` 里。
#:
#: 14 → 15（2026-10-27 决策流水线「01 指标取数」）：新增 ``facts.kpi_data`` —— 本轮网管指标 / MR / 工参
#: 三路取数的摘要（拉取记录、窗口、明细行数；不含明细行，明细在转存表里按 taskno 取），``services.kpi_interpretation``
#: 产出、本模块原样挂；``facts.sources`` 的网管指标 / MR / 工参三行改由它报通没通（不再恒为「无通道」）。
#: 开关关着、这一步失败或事后从 DB 行重建时是 ``None``。**只展示，不进任何判断。**
#:
#: 15 → 16（2026-10-29 六维判定）：工单六维判定全有时 02 改用六维收敛 —— ``causes[].basis`` 多两档
#: :attr:`CauseBasis.ORDER_DIMENSIONS`（确定性兜底，``verdict`` 是「未排序根因」）/ :attr:`CauseBasis.ORDER_DIMENSIONS_MODEL`；
#: ``cause_convergence`` 加 ``source``（``conclusion`` / ``dimensions``）；``facts.order`` 带六个 ``*_totalverdict``。
#: 存量对象不迁移，读侧照认旧档。
#:
#: 16 → 17（2026-10-29 晚，用户定三路一起用）：02 模型收敛改为 conclusion / smart_conclusion 与六维判定一起送、
#: 六维有几维带几维 —— 模型根因的出处换成 :attr:`CauseBasis.ORDER_DIMENSIONS_MODEL`（新串，含结论两字段），
#: schema 16 的旧串留作 :attr:`CauseBasis.ORDER_DIMENSIONS_MODEL_LEGACY`、照认；``cause_convergence.source = dimensions``
#: 的含义随之变成「六维参与了收敛」。确定性兜底（``ORDER_DIMENSIONS``，六维全有逐维一条）不变。存量对象不迁移。
DECISION_SCHEMA_VERSION = 17


# --------------------------------------------------------------------------- #
# 封闭词表
# --------------------------------------------------------------------------- #
class Admission:
    """一个参数动作的准入态 —— **四档**，本模块的规范取值。

    比 :func:`~services.decision.plan_table.verdict_row_state` 的三档多拆出
    ``SKIPPED``：机制上「更高档位已出可下发动作，本档整档没试」与「判过了，没通过」
    都落成 ``need_call='否'``，但业务含义相反 —— 前者的方案并没有被否定。
    今天这个区分只活在 :func:`services.decision.root_cause.row_action_state` 里，
    而那一处是靠 JSON 原文子串匹配实现的（见 :attr:`ActionVerdict.round_state`）。

    两套老口径都能从这四档**无损还原**，由 ``tests/test_verdict.py`` 钉死：

    ==================  ==========================  ==================
    Admission           plan_table.admission_state  root_cause 三档
    ==================  ==========================  ==================
    ADMITTED            admitted                    admitted
    ADMITTED_UNCHECKED  admitted_unchecked          admitted
    SKIPPED             rejected                    skipped
    REJECTED            rejected                    rejected
    ==================  ==========================  ==================
    """

    #: 已准入，且过了规则合规校验与数值一步后验。
    ADMITTED = "admitted"
    #: 已准入，但走的是四条 bypass 之一 —— **没经过任何规则校验**，按 ICOS 建议值直通。
    #: 现网 142 个下发动作里 79 个（56%）是这一档，正文里所谓的「条件项」指的就是它。
    ADMITTED_UNCHECKED = "admitted_unchecked"
    #: 判过了，没通过。
    REJECTED = "rejected"
    #: 整档跳过，本轮压根没试。**不是被否定**。
    SKIPPED = "skipped"


#: 准入态里算「进了参数平台」的那两档。
ADMITTED_STATES = frozenset({Admission.ADMITTED, Admission.ADMITTED_UNCHECKED})


class Association:
    """初案与本单收敛根因的关联度 —— 方案 05「根因对齐」的产出。

    2026-10-03 起由 :func:`services.decision.cause_alignment.align_root_causes_llm` 出：模型以网优专家身份判
    每个方案针对哪几条 02 收敛根因，四档由代码按「针对的根因里有没有主因」定（模型没判到的方案按初案原因对上）。
    02 模型收敛没有根因时退回 :func:`services.decision.alignment.align_root_causes` 的类别四档；
    02 确定性解析也收敛不出类别时是 :data:`Association.PENDING`。
    对下发的影响只有一处（业务 10-03）：模型判的「不一致」在决策链里不发（不剔到零，见
    :func:`services.decision.chain.drop_by_alignment`）；专项 / 通用路径仍只注记 —— 2026-09-24 通用方案容忍度删除后
    它不影响任何一条决策条件。
    """

    #: 方案针对的根因里有主因（类别四档：初案 type1 == 收敛主因类别）→ 专项路径
    DIRECT = "直接关联"
    #: 只针对次因 / 低置信根因（类别四档：在次因类别里）→ 专项路径
    SECONDARY = "次级关联"
    #: 不针对某一条根因、有通用收益（类别四档：type1 = 参数通用）→ 通用判定路径
    GENERAL = "通用方案"
    #: 与收敛根因都对不上 → 记一条「不一致项」+ 走通用路径。**不是拒绝。**
    INCONSISTENT = "不一致"
    #: 05 还没做。
    PENDING = "未判定"


ASSOCIATION_VOCAB = (
    Association.DIRECT,
    Association.SECONDARY,
    Association.GENERAL,
    Association.INCONSISTENT,
)


class CauseBasis:
    """根因清单是从哪儿收敛出来的。

    方案 02「根因收敛」定死：**唯一依据是** ``wireless_order_info`` 的 ``conclusion`` 与
    ``smart_conclusion``。而今天 :func:`services.decision.root_cause.root_cause_groups`
    是从初案 ``type1/type2`` 分组的 —— 按那条规则那根本不是收敛，是**对齐**。

    两件事并存不冲突（初案 type1/type2 同时是规则库五元组匹配键，决定取值约束与步长，
    不能动），但必须在类型上分得开，否则 P3 换成真收敛时没人说得清哪份是哪份。
    """

    #: 按初案 (type1, type2) 分组 —— 严格说是对齐，不是收敛。今天仍然喂着
    #: :class:`CauseRef` 与展示层，是 **05 根因对齐**接管前的过渡形态。
    #: :attr:`OrderDecision.causes` 已经不走它了。
    ICOS_PLAN_TYPE = "icos_initial_plan.type1/type2"
    #: 02 根因收敛的**确定性解析**，由 :mod:`services.decision.convergence` 产出（只认三段式、
    #: 无置信度）。schema 5 起只在模型收敛失败时出现在 :attr:`OrderDecision.causes` 上。
    ORDER_CONCLUSION = "wireless_order_info.conclusion+smart_conclusion"
    #: 02 根因收敛的**模型收敛**（2026-09-24 业务：根因要带置信度），由
    #: :mod:`services.decision.cause_convergence` 产出。schema 5 起 :attr:`OrderDecision.causes` 默认是它。
    ORDER_CONCLUSION_MODEL = "wireless_order_info.conclusion+smart_conclusion（模型收敛）"
    #: 六维判定（2026-10-29，取哪几维见 :mod:`services.decision.cause_dimensions`）。
    #: 确定性兜底 —— 六维全有时每维一条、不排序（``verdict`` 恒为「未排序根因」）、无置信度。
    ORDER_DIMENSIONS = "wireless_order_info.六维判定"
    #: 结论两字段与六维判定一起送的**模型收敛**（schema 17 起，六维有几维带几维），口径同
    #: :attr:`ORDER_CONCLUSION_MODEL`（主因 / 次因 / 低置信）。
    ORDER_DIMENSIONS_MODEL = "wireless_order_info.conclusion+smart_conclusion+六维判定（模型收敛）"
    #: schema 16 的六维模型收敛（六维全有、只送六维）。新对象不再写，读侧照认。
    ORDER_DIMENSIONS_MODEL_LEGACY = "wireless_order_info.六维判定（模型收敛）"


#: 02 **模型收敛**的出处 —— 展示层按它认「这是模型收敛的根因」（结论来源 / 结论 + 六维 / schema 16 的只有六维）。
MODEL_CAUSE_BASES: Tuple[str, ...] = (
    CauseBasis.ORDER_CONCLUSION_MODEL,
    CauseBasis.ORDER_DIMENSIONS_MODEL,
    CauseBasis.ORDER_DIMENSIONS_MODEL_LEGACY,
)


#: 模型收敛的 :attr:`Cause.confidence_source`。
CONFIDENCE_SOURCE_MODEL = "02 模型收敛：原文对这条根因的支撑强度（0–100）"


class RuleProvenance:
    """``llm_solution.rule_row`` 这一份快照**是谁写的** —— 别想当然以为是规则库。

    ``engine`` 算出 ``rule_snapshot`` 之后只送两个地方：提示词与 trace。它**从不**
    把这份快照写回 ``llm_obj``（``engine.py`` 里没有 ``llm_obj["rule_row"] = …``）。
    而提示词要求模型「原样回抄」，``harness`` 只校验它是个 dict。于是：

    ================================================  ==================
    phase                                              rule_row 的来源
    ================================================  ==================
    ``rule_match_bypass``                              ``{}``（规则库压根没匹配上）
    其余三条 bypass                                     ``rule_snapshot``，**代码事实**
    ``success`` / ``harness_validate``                 **模型回抄的文本**
    / ``numeric_postcheck``
    ================================================  ==================

    要命的是数值一步策略的
    步长、方向、硬域、软建议**全部**从 ``llm_obj["rule_row"]`` 取 —— 也就是说
    成功路径上的数值裁决建立在**模型回抄的规则行**上，而不是 CSV 原文。
    今天没有任何一处校验这两者相等。

    P1 只负责把这件事**标出来**；要不要改成以代码快照为准，是 P3 的事
    （方案里「硬约束：任何 LLM 不得覆盖」那一条真正落地就在这里）。
    """

    #: 代码从规则库裁出来的快照，可信。取自 ``llm_solution.matched_rule``。
    CODE = "code_snapshot"
    #: 模型回抄的那一份，**未经校验**。取自 ``llm_solution.rule_row``，
    #: 只在没有 ``matched_rule`` 的历史行上才会出现（该键由 P2-2c 引入）。
    LLM_ECHO = "llm_echo"
    #: 规则库无匹配，没有规则行。
    NONE = "no_rule"


#: ``parameter_level`` 里表示「没分级」的值。现网 209 行**全是它** ——
#: 也就是说 07 风险评估今天没有任何分级依据，等业务供数。
#: 真正的分级词表由业务定，本模块只认「是不是还等于这个哨兵值」。
RISK_UNGRADED = "其他"


class SourceState:
    """多维数据汇总里，某一源今天到底通没通。

    方案「逐节点对账」那张表的类型化版本。写进对象而不是只写进文档，是因为 01
    「信息汇总与对齐」现在只有两源，「多维」名不副实 —— 这件事应该由数据自己说出来，
    而不是等人去翻方案。
    """

    #: 有表、有数据、决策链在读。
    CONNECTED = "connected"
    #: 有表有列，但全量为空（如 ``top_causes`` 90 张工单 0 条有值、
    #: ``parameter_level`` 209 行全是「其他」）。
    EMPTY = "empty"
    #: 库里无表无列、也无接入接口（网管指标 / MR / 工参 / 知识库通道）。
    ABSENT = "absent"


#: 整单判定的封闭词表。与 :mod:`services.decision.action_facts` 同源，不另立一套。
ORDER_VERDICT_VOCAB = (VERDICT_AUTO, VERDICT_CONDITIONAL, VERDICT_NONE)


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def _loads(raw: Any) -> Dict[str, Any]:
    """JSON 列 → dict。取不到一律空字典，不抛。

    ``row_to_dict`` 把 Text 列原样取成字符串，所以 ``decision_trace_json`` /
    ``order_review_json`` / ``order_info`` 三列读出来都是 JSON 字符串。
    ``llm_solution`` **不走这里** —— 它有自己的单一解析点
    （:func:`~services.decision.plan_table.row_solution`），本模块只调用它。
    """
    if isinstance(raw, dict):
        return raw
    text = _text(raw)
    if not text.startswith("{"):
        return {}
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _need_call_column_or_json(row: Dict[str, Any]) -> str:
    """``push_service._need_call`` 的同构实现 —— **推送侧真正发出去的那个值**。

    与 ``verdict_row_state(row)["is_dispatched"]``（只认列、``== "是"``）刻意分开：
    两者在**列为空**时结论相反 —— 这里默认 ``"是"``（历史行只有 JSON 的兼容口径），
    那边判 ``False``。于是同一行会出现「界面说未准入、报文里带着 need_call=是」。
    见 :attr:`ActionVerdict.need_call_diverges`。

    这不是本模块新引入的分歧，是把已经存在的分歧显性化。收口归 P5
    （``push_service`` 改读 :attr:`ActionVerdict.admission`），在那之前先让它可观测。
    """
    value = row.get("need_call_parameter_platform")
    if value in ("是", "否"):
        return value
    raw = row.get("llm_solution")
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return "是"
        if isinstance(parsed, dict) and parsed.get("need_call_parameter_platform") in ("是", "否"):
            return parsed["need_call_parameter_platform"]
    return "是"


def _clean(value: Any) -> Any:
    """对象 → 可 JSON 序列化的值。给 :meth:`OrderDecision.to_dict` 用。"""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(item) for item in value]
    if hasattr(value, "to_dict"):
        return value.to_dict()
    return _text(value)


# --------------------------------------------------------------------------- #
# ActionVerdict 的子对象
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class RuleRow:
    """命中的规则库行快照 —— ``llm_solution.rule_row``。

    **``None`` 是有信息量的**：它就是「规则库里没有这条参数的规则」那 49%。今天那条路
    走 ``rule_match_bypass`` 直通下发，路上不存在任何判断；重构后规则库降为「风险输入」，
    这里为 ``None`` 只意味着**没有硬约束可用**，不再意味着「不判」。

    字段与 :data:`services.compliance.rule_library.RULE_ROW_SNAPSHOT_KEYS` 一一对应。
    """

    #: 规则登记的适用一级/二级原因。与初案的 type1/type2 同名不同源。
    type1: str = ""
    type2: str = ""
    #: 操作取向（"提高RSRP门限"这类）。**05 根因对齐**判「参数与 operate 搭不搭」
    #: （组级看方案组 operate 与收敛根因，参数级看 parachinname 与 operate），
    #: **08 综合决策及参数编排**据此下整单结论。
    #:
    #: 六步图时这行写的是「05/06」，指的是那时的 05 参数风险评估 / 06 综合决策；
    #: 按机械映射本该是 07/08，但「搭不搭」这件事在八步图里归 05 根因对齐 ——
    #: 所以这里写全名而不是数字，免得下一个人再照着数字换算一遍。
    operate: str = ""
    nettype: str = ""
    vendor: str = ""
    band: str = ""
    parachinname: str = ""
    #: 规则库自己那份参数名。与 ``parachinname`` 无关，也与初案的 f_para/b_para 无关。
    para: str = ""
    #: 单步步长与方向，形如 ``+2`` / ``-3``。符号就是硬约束的方向，不是修饰。
    rule_scope: str = ""
    #: 这份快照是谁写的。见 :class:`RuleProvenance`。
    provenance: str = RuleProvenance.CODE
    #: ``rule_scope`` 解析得出步长没有。**必须是显式布尔，不能靠 step 是否存在反推** ——
    #: ``apply_one_step_policy`` 在步长不可解析时**提前 return**，整段后验不跑，
    #: 于是"没解析出步长"与"压根没走到后验"在 ``step_scope_analysis`` 上长得一样。
    #: 现网 209 行规则里 rule_scope 可解析的只有 86 行。
    step_parsable: bool = False
    #: ``para`` 解析得出取值约束没有（单值 / 区间）。与 :attr:`step_parsable` 并列；
    #: 硬约束（:attr:`hard_constraint_usable`）要求它成立、且快照是代码写的。
    constraint_parsable: bool = False
    #: 多行命中且未推断出 band 时的告警 —— 「这条规则可能选错了」的唯一信号。
    #: 今天全系统零消费者。
    ambiguity: str = ""

    # ---- 以下三列由 P2-2c 打通（只在 matched_rule 那一份里有） ----
    #: 参数风险分级，07 的分级依据。现网 209 行全是 :data:`RISK_UNGRADED`，等业务供数。
    parameter_level: str = ""
    #: 功能互斥，06 方案一致性要它。现网 209 行**全空** —— 互斥今天没有现成数据源。
    mutual_exclusion: str = ""
    #: 该规则启用与否。**匹配器今天完全不读它**：3 行标着「否」仍在参与匹配。
    is_use: str = ""
    #: 模型回抄的那份与代码事实在**决定性的三列**上对不上。见 :attr:`echo_diverges`。
    echo_diverges: bool = False

    #: 原始快照，留着给排查用（CSV 列可能多于上面这几个）。
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def graded(self) -> bool:
        """业务给这条参数定过风险等级没有。现网恒 ``False``。"""
        return bool(self.parameter_level) and self.parameter_level != RISK_UNGRADED

    @property
    def rule_disabled(self) -> bool:
        """命中的是一条**业务已经关掉**的规则。

        ``is_use='否'`` 的行今天照样参与匹配（``rule_library`` 压根不读这一列），
        而现网那 3 行各自都是它那个五元组的唯一行 —— 于是那 3 个参数拿到的硬约束
        来自一条停用规则。要不要据此过滤是规则库语义问题，得业务定；
        本属性先让影响面可统计。
        """
        return self.is_use == "否"

    @property
    def hard_constraint_usable(self) -> bool:
        """这条规则真的能当硬约束用吗 —— ``para`` 给出了取值约束（单值 / 区间），且快照是代码写的。

        「硬约束」就是 ``para`` 的取值约束。方案 P4 的决策条件第 1 条
        「硬约束，任何 LLM 不得覆盖」只对这一档成立。
        """
        return self.constraint_parsable and self.provenance == RuleProvenance.CODE

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type1": self.type1,
            "type2": self.type2,
            "operate": self.operate,
            "nettype": self.nettype,
            "vendor": self.vendor,
            "band": self.band,
            "parachinname": self.parachinname,
            "para": self.para,
            "rule_scope": self.rule_scope,
            "provenance": self.provenance,
            "step_parsable": self.step_parsable,
            "constraint_parsable": self.constraint_parsable,
            "hard_constraint_usable": self.hard_constraint_usable,
            "ambiguity": self.ambiguity,
            "parameter_level": self.parameter_level,
            "graded": self.graded,
            "mutual_exclusion": self.mutual_exclusion,
            "is_use": self.is_use,
            "rule_disabled": self.rule_disabled,
            "echo_diverges": self.echo_diverges,
        }

    #: 决定性的两列 —— 模型抄错这两个才真的影响裁决，抄错 band 之类不影响。
    _DECISIVE = ("rule_scope", "para")

    @classmethod
    def from_solution(cls, solution: Dict[str, Any]) -> Optional["RuleRow"]:
        """``llm_solution`` → 规则行。**优先取代码事实 ``matched_rule``。**

        ``rule_row`` 只在没有 ``matched_rule`` 的历史行上才用 —— 那一份在成功路径上
        是模型回抄的（见 :class:`RuleProvenance`）。两份都在时顺带比一比决定性的三列，
        对不上就置 :attr:`echo_diverges`：这正是 P3/P4 要不要把硬约束切成代码事实的证据。
        """
        echo = solution.get("rule_row")
        echo = echo if isinstance(echo, dict) else {}
        fact = solution.get("matched_rule")
        fact = fact if isinstance(fact, dict) else {}
        raw = fact or echo
        if not raw:
            return None

        phase = _text(solution.get("phase"))
        if fact:
            provenance = RuleProvenance.CODE
        else:
            # 历史行：没有 matched_rule。bypass 路径上 rule_row 本来就是代码写的。
            provenance = RuleProvenance.CODE if phase in BYPASS_PHASES else RuleProvenance.LLM_ECHO
        diverges = bool(
            fact
            and echo
            and any(_text(fact.get(key)) != _text(echo.get(key)) for key in cls._DECISIVE)
        )

        rule_scope = _text(raw.get("rule_scope"))
        para = _text(raw.get("para"))
        step_magnitude, _ = parse_step(rule_scope)
        ambiguity = solution.get("rule_match_ambiguity")
        return cls(
            provenance=provenance,
            step_parsable=step_magnitude is not None,
            constraint_parsable=para_kind(para) in ("single", "interval"),
            ambiguity=_text(ambiguity),
            parameter_level=_text(raw.get("parameter_level")),
            mutual_exclusion=_text(raw.get("is_mutual_exclusion")),
            is_use=_text(raw.get("is_use")),
            echo_diverges=diverges,
            type1=_text(raw.get("type1")),
            type2=_text(raw.get("type2")),
            operate=_text(raw.get("operate")),
            nettype=_text(raw.get("nettype")),
            vendor=_text(raw.get("vendor")),
            band=_text(raw.get("band")),
            parachinname=_text(raw.get("parachinname")),
            para=_text(raw.get("para")),
            rule_scope=_text(raw.get("rule_scope")),
            raw=dict(raw),
        )


@dataclass(frozen=True)
class StepBasis:
    """数值一步后验的全过程 —— ``llm_solution.step_scope_analysis``。

    这一段**是代码写回的，不是模型的话**。它是今天决策链里
    唯一一处「硬约束代码裁决、LLM 不得覆盖」，方案 P4 的决策条件第 1 条就长在这上面。

    ``None`` = 这一行没走到数值后验（整档跳过、前置校验未过、规则库无匹配走了直通）。
    与 ``analysis_end_time`` 同一口径：留空比造一份假依据诚实。
    """

    #: 锚点 = 参数**当前现网值** ``f_para``。一步调整只以它为基准，不以 ICOS 建议值为基准。
    anchor_raw: str = ""
    anchor_numeric: Optional[float] = None
    #: 单步步长（``rule_scope`` 的绝对值）。
    step_magnitude: Optional[float] = None
    #: 方向：+1 调大 / -1 调小 / None 规则库没写方向（维持双向候选）。
    step_direction: Optional[int] = None
    step_direction_text: str = ""
    #: 规则库是否**显式声明**了方向。False 时反向候选不剔除。
    step_direction_enforced: bool = False
    step_raw: str = ""
    #: 一步候选值 —— 合法目标值的全集，只可能是 anchor±step。
    allowed_one_step_values: Tuple[Any, ...] = ()
    #: 值到硬域**外**边界的距离分档：in_band / near / far。
    distance_level: str = ""
    distance_explanation: str = ""
    #: 代码最终选了哪个动作（pick_candidate_a / pick_candidate_b / …）。
    chosen_action: str = ""
    #: 值在 ``para`` 区间**内**离边界还剩多少 —— 与 ``distance_level`` **不是一回事**。
    #: 三格都取自 :func:`services.decision.action_facts.domain_margin`。
    domain_margin_text: str = ""
    #: 上面那个的数值形态；"待平台校验"/"不适用"这类非数值口径为 ``None``。
    domain_margin_value: Optional[float] = None
    #: 按规则方向再调一步就越出取值约束，07 风险评估必须点名（只注记，不剔除）。
    #: 展示层裁决依据表（``decision_render.render_step_basis_table``）的 ``tight_margin_count``
    #: 数的就是它。
    tight_margin: bool = False
    #: 07 按案例建议步数走了几步与目标值（2026-10-09）。0 / 空 = 一步（:attr:`allowed_one_step_values` 仍是
    #: 现网值 + 一步，多步的目标值记在这里）。只在多步时进 :meth:`to_dict`，一步的行与之前逐字相同。
    case_steps: int = 0
    case_target: str = ""

    def to_dict(self) -> Dict[str, Any]:
        out = self._base_dict()
        if self.case_steps > 1:
            out["case_steps"] = self.case_steps
            out["case_target"] = self.case_target
        return out

    def _base_dict(self) -> Dict[str, Any]:
        return {
            "anchor_raw": self.anchor_raw,
            "anchor_numeric": self.anchor_numeric,
            "step_magnitude": self.step_magnitude,
            "step_direction": self.step_direction,
            "step_direction_text": self.step_direction_text,
            "step_direction_enforced": self.step_direction_enforced,
            "step_raw": self.step_raw,
            "allowed_one_step_values": list(self.allowed_one_step_values),
            "distance_level": self.distance_level,
            "distance_explanation": self.distance_explanation,
            "chosen_action": self.chosen_action,
            "domain_margin_text": self.domain_margin_text,
            "domain_margin_value": self.domain_margin_value,
            "tight_margin": self.tight_margin,
        }

    @classmethod
    def from_solution(
        cls, solution: Dict[str, Any], *, b_para: Any, dispatched: bool = True
    ) -> Optional["StepBasis"]:
        """``dispatched`` = 这一行本轮下发（``verdict_row_state`` 的 ``is_dispatched``）。不下发的行
        ``b_para`` 是 ICOS 原值，余量记「不适用」；07 判否的（``reject_no_valid_step``）同样不算。"""
        analysis = solution.get("step_scope_analysis")
        if not isinstance(analysis, dict) or not analysis:
            return None
        parsed = analysis.get("step_parsed")
        parsed = parsed if isinstance(parsed, dict) else {}
        distance = analysis.get("distance_assessment")
        distance = distance if isinstance(distance, dict) else {}
        candidates = analysis.get("allowed_one_step_values")
        candidates = tuple(candidates) if isinstance(candidates, (list, tuple)) else ()

        # 取值约束与步长取规则行：与 RuleRow.from_solution 同一个优先级（代码事实 matched_rule 优先）。
        fact = solution.get("matched_rule") or solution.get("rule_row")
        fact = fact if isinstance(fact, dict) else {}
        chosen_action = _text(analysis.get("chosen_action"))
        margin = domain_margin(
            b_para,
            para=fact.get("para"),
            rule_scope=fact.get("rule_scope"),
            dispatched=dispatched and chosen_action != "reject_no_valid_step",
        )
        magnitude = parse_scalar_float(parsed.get("magnitude"))
        try:
            case_steps = int(analysis.get("case_steps") or 0)
        except (TypeError, ValueError):
            case_steps = 0

        direction = parsed.get("direction")
        return cls(
            anchor_raw=_text(analysis.get("anchor_raw")),
            anchor_numeric=parse_scalar_float(analysis.get("anchor_numeric")),
            step_magnitude=magnitude,
            step_direction=int(direction) if isinstance(direction, (int, float)) else None,
            step_direction_text=_text(parsed.get("direction_text")),
            step_direction_enforced=bool(parsed.get("direction_enforced")),
            step_raw=_text(parsed.get("raw")),
            allowed_one_step_values=candidates,
            distance_level=_text(distance.get("level")),
            distance_explanation=_text(distance.get("explanation")),
            chosen_action=chosen_action,
            domain_margin_text=margin.text,
            domain_margin_value=margin.value,
            tight_margin=margin.tight,
            case_steps=case_steps if case_steps > 1 else 0,
            case_target=_text(analysis.get("case_target")) if case_steps > 1 else "",
        )


@dataclass(frozen=True)
class ChainNote:
    """这一行由**决策链**裁决 —— 判到哪一步、为什么。取自 ``llm_solution.new_chain``。

    2026-09-25 合规链删除后每一行都有它；``None`` 只出现在合规链时期的老轮次（shadow / off 档）。
    P6 enforce 档（09-24 ~ 09-25）的行上还有 ``new_chain.compliance``（合规链原结论备查），这里不读。
    """

    #: 由哪一步定的下场：``services.decision.chain.ChainStage`` 的取值（04 / 07 / 08）。
    stage: str
    #: 为什么是这个下场：``services.decision.chain.ChainReason`` 的取值。
    reason: str
    #: 给人看的一句话（开关 / 条件型规则怎么判的）。
    detail: str = ""
    #: 07 规则库结论的形态与原因码（``services.decision.rule_assessment`` 的 ``FeasibilityShape`` /
    #: ``FeasibilityReason``）。依据表「为什么没有步长判定」按原因码说。
    #: 空串 = 这一轮没落规则依据块（依据块上线前的 enforce 轮次）。
    rule_shape: str = ""
    rule_reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "stage": self.stage,
            "reason": self.reason,
            "detail": self.detail,
            "rule_shape": self.rule_shape,
            "rule_reason": self.rule_reason,
        }


@dataclass(frozen=True)
class CauseRef:
    """这个动作挂在哪条根因上 —— 按 :func:`~services.decision.plan_table.plan_key` **回查出来的**。

    改版前是模型自己往收敛表上挂，挂错根因在结构上是可能的；现在不可能了。
    ``None`` = 回查不到（初案已清理、或历史行缺 execution_id）。

    :attr:`rank` 是**初案对齐表**的序位，**不是** :attr:`OrderDecision.causes` **的下标**
    —— ``causes`` 换成 **02 根因收敛**之后两者是两个互不相干的编号空间。
    别写 ``decision.causes[action.cause.rank - 1]``（见 :func:`_cause_ref_index`）。
    把动作挂到收敛出的根因上是 **05 根因对齐**的事。
    """

    #: **初案对齐表**里的第几行（1 起）。不是 ``OrderDecision.causes`` 的下标。
    rank: int
    #: 根因名，形如 ``覆盖 / 过覆盖``。
    cause: str
    #: 成品引用文本，形如 ``#1 覆盖 / 过覆盖``。
    #: 必须逐字等于 :func:`services.decision.root_cause.root_cause_refs` 的值。
    ref: str

    def to_dict(self) -> Dict[str, Any]:
        return {"rank": self.rank, "cause": self.cause, "ref": self.ref}


@dataclass(frozen=True)
class Relevance:
    """整单复核给这个动作的标注 —— ``order_review_json.action``。

    **这是标注，不是裁决。** 方案里那条硬约束贯穿 P3–P4：LLM 判断实测不可靠
    （小模型在输入逐字段相同的 18 张工单上翻转 28%；换大模型后自身一致，
    但两个模型只在 50.8% 的动作上结论相同），在业务侧标出金标准之前，
    它只能落轨迹，**不得进任何裁决门**。
    """

    #: 封闭词表：指标正向 / 指标中性 / 指标存疑 / 未判定。
    relevance: str
    #: 模型给的作用路径说明（自由文本，仅供人读）。
    path: str = ""
    #: 证据分级，**由事实决定不由模型决定**：有规则行 = 规则库事实，没有 = LLM原理补充。
    #: （2026-09-27 之前的存量轮还可能是「知识库依据」—— 文档知识通道已删除。）
    evidence: str = ""
    #: 存量轮「知识库依据」那一档的出处（当时检索命中的文件名）。新一轮恒为空。
    sources: Tuple[str, ...] = ()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "relevance": self.relevance,
            "path": self.path,
            "evidence": self.evidence,
            "sources": list(self.sources),
        }


@dataclass(frozen=True)
class Conflict:
    """一组互相冲突的动作 —— ``order_review_json.conflicts`` 的一项。

    只认「两个及以上成员都对得上、且都进了参数平台」的冲突：没发出去的动作之间谈
    方向冲突没有意义。今天它在旁路里、是注记；方案 06 要把它扶正成裁决。
    """

    #: 成员的 plan_key。
    members: Tuple[str, ...]
    #: 封闭词表：方向冲突 / 功能互斥。
    kind: str
    reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {"members": list(self.members), "kind": self.kind, "reason": self.reason}


@dataclass(frozen=True)
class TraceStage:
    """决策轨迹的一个阶段 —— ``decision_trace_json.stages[]`` 的一项。

    只有合规链时期（2026-09-25 之前）的行有阶段：合规链逐阶段打点（前置校验 / 规则库匹配 / 合规模型 /
    结构校验 / 数值后验）。决策链的行 ``stages`` 为空，注记落在轨迹顶层键（``candidate_ref`` / ``risk`` /
    ``alignment`` / ``gate``），为什么是这个下场看 :attr:`ActionVerdict.chain`。

    「这个参数为什么是这个下场」以前只能翻日志，现在库里有。本对象只做转写，
    不重新解释 —— 证据体（inputs/outputs/detail）原样带着。
    """

    seq: int
    stage: str
    failed: bool = False
    verdict: str = ""
    inputs: Any = None
    outputs: Any = None
    detail: Any = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"seq": self.seq, "stage": self.stage, "failed": self.failed}
        if self.verdict:
            out["verdict"] = self.verdict
        for key, value in (("inputs", self.inputs), ("outputs", self.outputs), ("detail", self.detail)):
            if value is not None:
                out[key] = _clean(value)
        return out


# --------------------------------------------------------------------------- #
# ActionVerdict
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ActionVerdict:
    """一个参数动作的完整下场。**一行 ``agent_execution_plan`` 一个。**

    今天这个「下场」散在 6 个列 + 3 个 JSON 列里，由每个消费者自己拼。这个类是那份
    拼装的唯一成品：``push_service`` 读 :attr:`admission`、展示层读 :attr:`label`、
    风险评估读 :attr:`step`，谁都不再碰原始行。
    """

    #: 初案与决策行的对齐键，全系统唯一一处口径（:func:`~services.decision.plan_table.plan_key`）。
    key: str
    agent_decision_id: str
    parachinname: str
    #: 参数**当前现网值**（一步调整的锚点）。
    f_para: str
    #: ICOS **建议的目标值**。
    org_b_para: str
    #: **裁决后**的目标值。合规失败时它被退回 ICOS 原值 —— 所以
    #: ``b_para == org_b_para`` 不等于"原样下发"，先看准入再看改写，反过来必错。
    b_para: str

    #: 准入态（四档，见 :class:`Admission`）。
    admission: str
    #: 准入/未准入的**短原因**，封闭词表。由 :attr:`label` 切出来，不另立词表。
    reason: str
    #: 成品标签，逐字等于 ``verdict_row_state(row)["admission_label"]``。
    label: str
    #: 走了哪条路（:class:`services.decision.phase.Phase` 的取值）。
    phase: str
    #: 裁决是否改写了 ICOS 建议值。``None`` = 未准入或没有建议值快照，此时该问题无意义。
    changed: Optional[bool]

    #: 推送侧真正发出去的 ``need_call`` 值。**可能与 :attr:`admission` 不一致**，
    #: 见 :attr:`need_call_diverges`。
    need_call: str

    #: 只在 :data:`Admission.SKIPPED` 行上有值：**把这条挤掉的那个方案**的 execution_id。
    #: ``_skip_lower_tiers`` 一直在写它（``llm_solution.execution_id``），但今天全系统
    #: 零消费者 —— 于是界面只能说「整档跳过」，说不出「被谁挤掉的」。
    superseded_by: str = ""

    #: 方案组编号。``agent_execution_plan`` 上没有这一列，按 :attr:`key` 回查初案得来。
    plan_group_number: str = ""
    plan_number: str = ""
    execute_number: str = ""
    execution_id: str = ""
    #: 回查到的**初案**上那个 ``b_para``。正常情况下它等于 :attr:`org_b_para`
    #: （后者就是决策落库时抄的初案建议值快照），不等就说明回查错位或初案被改写过 ——
    #: 见 :attr:`plan_snapshot_diverges`。
    plan_b_para: str = ""

    rule_row: Optional[RuleRow] = None
    step: Optional[StepBasis] = None
    cause: Optional[CauseRef] = None
    #: 05 关联度。P1 恒为 :data:`Association.PENDING`。
    association: str = Association.PENDING
    #: 整单复核的标注。``None`` = 这一行没有复核结论。
    relevance: Optional[Relevance] = None
    #: **本行**的复核阶段（``order_review_json.phase``，取值是
    #: :class:`services.decision.order_review.ReviewPhase`）。
    #:
    #: 它与 :attr:`phase` **同名不同义**，务必分清：那个是决策行的
    #: :class:`services.decision.phase.Phase`。两套词表里都有 ``parse_bypass`` /
    #: ``llm_call_bypass``，混了极难排查，所以这里刻意不叫 ``phase``。
    #:
    #: 而且它是**逐行**的：整轮跑通但模型漏判了某一行时，那一行单独记
    #: ``parse_bypass``/``not_reviewed``。所以**不能拿任意一行的它当整单结论**
    #: （见 :class:`ConsistencyReport`）。
    review_phase: str = ""
    #: 涉及本行的冲突。空 tuple 与「没复核过」由 :attr:`reviewed` 区分。
    conflicts: Tuple[Conflict, ...] = ()
    #: 本行有没有过复核（哪怕结论是 bypass）。
    reviewed: bool = False
    trace: Tuple[TraceStage, ...] = ()
    #: 裁决这一行的那条链路留下的告警（经 ``plan_table.rule_basis``：决策链的行是 07 规则库判定的告警，
    #: 合规链时期的老行是 ``llm_solution.warnings``）。
    warnings: Tuple[str, ...] = ()
    #: 失败原因，同上取谁裁决的那一份（决策链 07 判不出来的那一句 / 老行的 ``llm_solution.error``）。
    error: str = ""
    #: 决策时写进轨迹顶层键的三份注记，**原样读回、不在这里重算**：
    #: 07 依据档（``risk.basis``）、05 判定路径（``alignment.path``：专项 / 通用）、
    #: 08 本动作没过的决策条件（``gate.failed``）。空 = 行上没有注记（历史行、注记失败）。
    risk_basis: str = ""
    path: str = ""
    gate_failed: Tuple[str, ...] = ()
    #: 决策链裁决这一行的「判到哪一步、为什么」；合规链时期的老行为 ``None``。
    #: 此时 :attr:`rule_row` / :attr:`step` 是决策链 07 的规则库结论（见 ``plan_table.rule_basis``）。
    chain: Optional[ChainNote] = None
    #: 04 案例参考：这一动作的同类先例、成败与案例支撑度（schema 10 起）。
    #: ``None`` = 案例库没开 / 这一步失败 / 事后从 DB 行重建（重建不重查案例库）。
    case_basis: Optional[ActionCaseBasis] = None

    # ---- 老口径的还原 ----
    @property
    def is_dispatched(self) -> bool:
        """== ``verdict_row_state(row)["is_dispatched"]``。"""
        return self.admission in ADMITTED_STATES

    @property
    def admission_state(self) -> str:
        """== ``verdict_row_state(row)["admission_state"]``（三档）。

        :data:`Admission.SKIPPED` 在这里塌回 ``rejected`` —— 那边不区分整档跳过。
        """
        return Admission.REJECTED if self.admission == Admission.SKIPPED else self.admission

    @property
    def round_state(self) -> str:
        """== ``root_cause.row_action_state(row)``（三档：admitted / skipped / rejected）。

        **那一处的实现有个已知缺陷**：它不解析 ``llm_solution``，而是对 JSON 原文做
        ``"skipped_lower_priority" in text`` 的子串匹配。于是 ``prior_phase`` 或
        ``llm_reasoning`` 里偶然出现这个词，就会把一条真判过的行误报成「整档跳过」。
        本属性按**解析出来的 phase** 判，是正确的那一个。
        ``tests/test_verdict.py`` 同时钉住"现实行上两者相等"与"这个分歧确实存在"。
        """
        if self.is_dispatched:
            return "admitted"
        return "skipped" if self.admission == Admission.SKIPPED else "rejected"

    @property
    def dispatch_state(self) -> str:
        """== ``_build_parameter_verdicts`` 的 ``dispatchState``（两态）。

        ``not_dispatched`` 在界面上叫「参数删除」。注意它**只看准入**：合规失败分支会
        同时把 ``b_para`` 退回原值并置 ``need_call='否'``，落在这一档，
        不会因为 ``b_para == org_b_para`` 被误算成"原样下发"。
        """
        return "dispatched" if self.is_dispatched else "not_dispatched"

    @property
    def state_label(self) -> str:
        """== ``_build_parameter_verdicts`` 的 ``stateLabel`` —— **导出用的权威文案**。

        ``services.exports.builder`` 直接照抄这一格，所以词表改了要同步改那边；
        大屏不读它（前端由 ``dispatchState`` + ``changed`` 现算同一套词）。
        三档：``参数删除`` / ``下发 · 原值`` / ``下发 · 参数调优``。
        ``changed is None``（缺 ICOS 建议值快照，无从比对）并入「下发 · 原值」——
        "其实无从判断"这件事不丢，它在 :attr:`changed` 里。
        """
        if not self.is_dispatched:
            return "参数删除"
        return "下发 · 参数调优" if self.changed else "下发 · 原值"

    @property
    def reject_detail(self) -> str:
        """被规则取值约束判否时的**精确**原因（整句）。不是那条则为空串。

        2026-09-30 起取自规则约束判定的 ``summary``（落在 ``step.distance_explanation``，
        由 ``rule_assessment._synthesize_step_scope_analysis`` 写入）—— 四档剔除原因
        （不满足取值约束 / 调整方向与规则不符 / 现网已是目标值 / 参数值不可计算）原样可读。
        """
        if self.is_dispatched or self.step is None:
            return ""
        if self.step.chosen_action != "reject_no_valid_step":
            return ""
        return self.step.distance_explanation

    @property
    def changed_vs_plan(self) -> Optional[bool]:
        """拿**初案**的 ``b_para`` 当比较基准算出来的"改没改" —— 与 :attr:`changed` 不同源。

        今天 ``frontend_view.service._build_original_plan_overview`` 用的就是这个基准
        （``decision.b_para == plan.b_para``），而全系统基准
        :func:`~services.decision.plan_table.verdict_row_state` 用的是
        ``b_para == org_b_para``。两者在初案被改写、或回查错位时给**相反**结论，
        于是同屏两张表打架（「合规修正后下发：由 9 调整为 5」vs「已准入·按建议值」）。

        本对象两个都给，并由 :attr:`plan_snapshot_diverges` 点名分歧行。
        :attr:`changed` 才是权威的那一个。
        """
        if not (self.is_dispatched and self.plan_b_para):
            return None
        return self.b_para != self.plan_b_para

    @property
    def plan_snapshot_diverges(self) -> bool:
        """初案现值与决策落库时抄的建议值快照对不上 —— 上面那个分歧的成因。"""
        return bool(self.plan_b_para and self.org_b_para and self.plan_b_para != self.org_b_para)

    @property
    def has_rule(self) -> bool:
        """规则库有没有这条参数的规则。``False`` 就是那 49% 的盲区。"""
        return self.rule_row is not None

    @property
    def need_call_diverges(self) -> bool:
        """推送侧的 ``need_call`` 与准入态对不上 —— 这一行会「界面说不发、报文说发」。

        成因只有一个：``need_call_parameter_platform`` 列不是「是」也不是「否」
        （空值、脏值），两边的兜底方向相反。P5 收口 ``push_service`` 之后消失。
        """
        return (self.need_call == "是") != self.is_dispatched

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "agent_decision_id": self.agent_decision_id,
            "parachinname": self.parachinname,
            "f_para": self.f_para,
            "org_b_para": self.org_b_para,
            "b_para": self.b_para,
            "admission": self.admission,
            "reason": self.reason,
            "reject_detail": self.reject_detail,
            "label": self.label,
            "phase": self.phase,
            "changed": self.changed,
            "dispatch_state": self.dispatch_state,
            "state_label": self.state_label,
            "need_call": self.need_call,
            "need_call_diverges": self.need_call_diverges,
            "superseded_by": self.superseded_by,
            "plan_group_number": self.plan_group_number,
            "plan_number": self.plan_number,
            "execute_number": self.execute_number,
            "execution_id": self.execution_id,
            "plan_b_para": self.plan_b_para,
            "changed_vs_plan": self.changed_vs_plan,
            "plan_snapshot_diverges": self.plan_snapshot_diverges,
            "review_phase": self.review_phase,
            "rule_row": self.rule_row.to_dict() if self.rule_row else None,
            "step": self.step.to_dict() if self.step else None,
            "cause": self.cause.to_dict() if self.cause else None,
            "association": self.association,
            "relevance": self.relevance.to_dict() if self.relevance else None,
            "conflicts": [item.to_dict() for item in self.conflicts],
            "reviewed": self.reviewed,
            "trace": [item.to_dict() for item in self.trace],
            "warnings": list(self.warnings),
            "error": self.error,
            "risk_basis": self.risk_basis,
            "path": self.path,
            "gate_failed": list(self.gate_failed),
            "chain": self.chain.to_dict() if self.chain else None,
            "case_basis": self.case_basis.to_dict() if self.case_basis else None,
        }


# --------------------------------------------------------------------------- #
# 整单侧的子对象
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class SourceStatus:
    """多维数据汇总里一个源的接入状态。见 :class:`SourceState`。"""

    name: str
    state: str
    detail: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "state": self.state, "detail": self.detail}


#: 01「触发来源」的八个字段 —— 与展示层 ``solution_gen_trigger`` 提示词逐个对应，
#: 一个不多一个不少。改提示词的字段清单就要同步改这里，反之亦然。
TRIGGER_FIELDS = (
    "taskno", "cell_name", "task_type", "degradation_time",
    "level_r", "nettype", "vendor", "cover_area",
)


class FactIssueKind:
    """01 对齐发现的问题类别。封闭词表。"""

    #: 工单抬头（:data:`TRIGGER_FIELDS`）有字段为空 —— 正文只能写「输入未提供」。
    TRIGGER_FIELD_MISSING = "trigger_field_missing"
    #: 初案的作用小区与工单小区不同 —— 调的不是这张工单的小区，03 的闭环边界据此不确认。
    PLAN_CELL_MISMATCH = "plan_cell_mismatch"
    #: 初案制式与工单制式不同。规则库按**工单**制式匹配，这条初案会拿到别的制式的规则。
    PLAN_NETTYPE_MISMATCH = "plan_nettype_mismatch"
    #: 初案厂商与工单厂商不同。同上，规则库按工单厂商匹配。
    PLAN_VENDOR_MISMATCH = "plan_vendor_mismatch"
    #: 初案缺 type1 / type2 / parachinname —— 规则库五元组凑不齐，07 规则库评估会判匹配键不全、不下发。
    PLAN_MATCH_KEY_MISSING = "plan_match_key_missing"


@dataclass(frozen=True)
class FactIssue:
    """01 信息汇总与对齐发现的一处不一致。**只记录，不裁决。**"""

    kind: str
    #: 涉及的字段名（工单或初案上的列名）。
    field: str
    detail: str
    #: 涉及的初案对齐键（``plan_key``）；工单侧的问题为空。
    keys: Tuple[str, ...] = ()

    def to_dict(self) -> Dict[str, Any]:
        return {"kind": self.kind, "field": self.field, "detail": self.detail, "keys": list(self.keys)}


@dataclass(frozen=True)
class MultiSourceFacts:
    """01 信息汇总与对齐 —— 这张工单本轮能拿到的全部事实，以及各源之间对不对得上。

    今天只有工单 + 初案两源（``build_order_payload`` 汇的就这两样），
    :attr:`sources` 把「哪些源压根没有通道」一并摆出来，免得「多维」这个词
    在下游被当成已经多维了。

    「汇总」= :attr:`summary`（工单抬头八字段）+ :attr:`plan_stats`（方案组与参数计数，
    与展示层「当前汇总可执行方案组情况」那张表**同一个函数**算的）。
    「对齐」= :attr:`issues`：工单与初案之间确定性可查的不一致（小区 / 制式 / 厂商 /
    匹配键 / 抬头缺字段）。只记录，不裁决 —— 03 的目标确认会读其中的小区一项。
    """

    taskno: str
    taskid: str
    #: 工单主表的关键字段投影。
    order: Dict[str, Any] = field(default_factory=dict)
    #: 初案行投影（每条一个 dict）。
    plans: Tuple[Dict[str, Any], ...] = ()
    #: 每一源通没通。
    sources: Tuple[SourceStatus, ...] = ()
    #: 工单抬头：:data:`TRIGGER_FIELDS` 八个字段，原值照抄（空 = 输入未提供）。
    summary: Dict[str, str] = field(default_factory=dict)
    #: 方案组汇总计数，取自 :func:`~services.decision.plan_table.icos_plan_facts`。
    plan_stats: Dict[str, Any] = field(default_factory=dict)
    #: 跨源对齐发现的不一致。空 = 查过、没发现（这里查过就是查过，不需要另一个布尔位）。
    issues: Tuple[FactIssue, ...] = ()
    #: 01 指标取数（网管指标 / MR / 工参）的摘要，原样来自 ``services.kpi_interpretation.decision_fetch``；
    #: 没取（开关关着、这一步失败、事后重建）为 ``None``。只展示、不进判断。
    kpi_data: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "taskno": self.taskno,
            "taskid": self.taskid,
            "summary": dict(self.summary),
            "plan_stats": _clean(self.plan_stats),
            "issues": [item.to_dict() for item in self.issues],
            "sources": [item.to_dict() for item in self.sources],
            "kpi_data": self.kpi_data,
            "order": _clean(self.order),
            "plans": [_clean(item) for item in self.plans],
        }


@dataclass(frozen=True)
class Objective:
    """03 方案目标确认 —— 确定性部分。

    「目标」= 主指标（本轮要改善什么）+ 闭环边界（只动本单目标小区）。
    :attr:`confirmed` 是**确定性判断**，三条都满足才确认：主指标已知、目标小区可识别、
    没有初案作用到别的小区（取自 01 对齐的 ``plan_cell_mismatch``，同一份推导）。
    没确认的原因逐条列在 :attr:`unconfirmed`。**只记录，不裁决。**

    关联指标与护栏指标**不在这里** —— 那要一张「问题类型 → 指标」的业务映射表，
    今天没有；在代码里编一张等于替业务定口径。它们留在展示层正文里由模型讲，
    并按提示词要求就地标注「（LLM 原理补充）」。
    """

    #: 主指标（工单 ``task_type``；经 ``task_type_replace.csv`` 映射后的值在
    #: ``order_info.order_data.问题类型`` 里，本模块优先取那个）。
    main_metric: str = ""
    #: 指标英文码（``outside_type``）。
    metric_code: str = ""
    #: 劣化时间 / 持续天数 / 劣化次数。
    degradation_time: str = ""
    duration_day: Optional[int] = None
    degradation_times: Optional[int] = None
    severity: str = ""
    #: 闭环边界：本单目标小区。三者至少一个非空才算「目标小区可识别」。
    target_cell: str = ""
    target_cgi: str = ""
    target_eci: str = ""
    #: 作用于非本单小区的初案条数（01 对齐 ``plan_cell_mismatch`` 的计数）。
    off_target_count: int = 0
    #: 没确认的原因。空 = 已确认。
    unconfirmed: Tuple[str, ...] = ()

    @property
    def confirmed(self) -> bool:
        """由 :attr:`unconfirmed` 推出，不另存 —— 存成字段就能构造出「确认了但有原因」的谎。"""
        return not self.unconfirmed

    def to_dict(self) -> Dict[str, Any]:
        return {
            "main_metric": self.main_metric,
            "metric_code": self.metric_code,
            "degradation_time": self.degradation_time,
            "duration_day": self.duration_day,
            "degradation_times": self.degradation_times,
            "severity": self.severity,
            "target_cell": self.target_cell,
            "target_cgi": self.target_cgi,
            "target_eci": self.target_eci,
            "off_target_count": self.off_target_count,
            "confirmed": self.confirmed,
            "unconfirmed": list(self.unconfirmed),
        }


@dataclass(frozen=True)
class Cause:
    """**02 根因收敛**出来的一条根因 —— 本单根因清单（基准）的一行。

    字段取自 :func:`services.decision.cause_dimensions.converge_order` 的结果（六维全有用六维，否则解析结论两字段），
    **刻意丢掉了 ``tone`` 与 ``confidenceLabel``** —— 那两个是 Tailwind 类名与成品展示
    文案，决策对象不该认识它们（见模块文档「与三个包的职责对齐」）。

    一条 = ``conclusion`` 「问题分析」段里的**一个条目**，不是一个类别：127/137 单存在
    重复类别，而同一重复类别下各条的证据两两不同、建议两两不同。所以 :attr:`cause` 与
    :attr:`level1` 在单张工单内**不唯一**，:attr:`rank` 才是主键。
    """

    #: 1 起，在本单清单里的位次，与 **ICOS 问题排序**同序。
    #: 依据是 conclusion 的问题排序位次（换源前是初案 ``final_ratio`` 档位，那一列 2026-09-24
    #: 起业务定为无意义、决策不再读）。
    #: **也不要拿它当回指下标**：``ActionVerdict.cause.rank`` 是初案对齐表的序位，
    #: 两者是两个互不相干的编号空间（见 :func:`_cause_ref_index`）。
    rank: int
    #: 形如 ``邻区·邻区故障影响切换``，无细名时只报类别。
    #: 分隔符 ``·`` 与 ``root_cause._cause_label`` 的 ``A / B`` **刻意不同形** ——
    #: 同形会让两个编号空间被人按字符串 join，也会让 :func:`_cause_ref_index` 的回查
    #: 碰巧命中（用例全绿而生产上挂错根因）。
    cause: str
    #: 一级类别，六词表之一（覆盖 / 邻区 / 参数 / 干扰 / 告警 / 资源）。
    #: **05 根因对齐查 P1.5「根因类目 ⟷ 方案组」映射表的键就是它。**
    level1: str = ""
    #: ``smart_conclusion`` **前缀对齐**来的细根因名（``TA过大`` 这类）。
    #: 对不上时留空 + 一条 warning，**不按类别聚合兜底**。
    level2: str = ""
    #: ``conclusion`` 侧没有三级原因这一层，02 根因收敛下恒空。
    #: **保留字段不删**（删会改 ``to_dict`` 键集）；这个槽位有主：哪天
    #: ``sort_conclusion`` 的二级原因被允许进来（要形态门控，见 ``convergence``
    #: 模块文档），落在这里。
    level3: str = ""
    #: 收敛依据的出处。02 根因收敛下恒为 :data:`CauseBasis.ORDER_CONCLUSION`。
    basis: str = CauseBasis.ORDER_CONCLUSION
    #: ``conclusion``「问题分析」``$`` 右侧原文，**不压缩不截断**（最长 209 字）。
    #: 换源之前这里是整表几乎相同的一句写死文案，零信息量。
    evidence: str = ""
    #: ``conclusion``「优化建议」``$`` 右侧原文。**本档质量最高的一列**：523 条只有
    #: 50 个不同文本，是个准封闭词表 —— 「覆盖」类目在 P1.5 映射表里散在 10 个方案组上，
    #: 类别这把钥匙开不了锁的时候，这一列是 05 根因对齐唯一更高分辨率的连接键。
    suggestion: str = ""
    #: **02 根因收敛填不出来。** conclusion 侧没有任何数值，不编（换源前这里放的是初案
    #: ``final_ratio``，那一列没有意义，也不再读）。``0.0`` 是「无来源」不是「置信度为零」，
    #: 靠 :attr:`confidence_source` 说清。
    confidence: float = 0.0
    #: 02 根因收敛下恒为 ``convergence.CONFIDENCE_ABSENT``，**绝不留空串** ——
    #: 空串会被读成「忘了填」。
    confidence_source: str = ""
    #: 封闭词表，**取值集合由** :attr:`basis` **决定**：
    #:
    #: * ``ORDER_CONCLUSION``       → 首位根因 / 伴随根因（02 确定性解析的 ICOS 排序位次档）
    #: * ``ORDER_DIMENSIONS``       → 未排序根因（02 六维确定性兜底：六维没有排序，整单一条首位都没有）
    #: * ``ORDER_CONCLUSION_MODEL`` / ``ORDER_DIMENSIONS_MODEL`` → 主因 / 次因 / 低置信（02 模型收敛：置信度最高
    #:   且达阈值 / 其余达阈值 / 低于阈值，见 ``cause_convergence.CauseStanding``）
    #: * ``ICOS_PLAN_TYPE``         → 主因 / 次因 / 未进入本轮（本轮裁决结果，root_cause 那侧）
    #:
    #: 结论来源与模型收敛下整单至多一条首位/主因（六维确定性兜底一条都没有：六维不排序）。两套词表**刻意不同名** —— 那边的「主因」是本轮真下发了
    #: 参数的那条（事后量），这边是 ICOS 排序首位（先验基准），同名不同义比不同名危险得多。
    verdict: str = ""
    #: 02 根因收敛下 = **ICOS 问题排序自己排第一的那条**（先验基准；六维确定性兜底恒为 False），
    #: 不是「本轮据此下发了参数的那条」（那是 ``root_cause`` 的事后量）。
    selected: bool = False
    #: 以下六个 **02 根因收敛填不出来**，是 **05 根因对齐**的挂接计数：schema 13 起模型收敛的轮次由
    #: 05 的模型对齐摊回来（:func:`_aligned_causes`，几个方案 / 几项动作针对这条根因、本轮各几项准入）；
    #: 确定性解析的轮次仍填不出来（类别四档只对到类别，同类别可重复）。
    #: **0 / () 是「没算过」不是「没有」—— 看** :attr:`aligned`。
    plan_count: int = 0
    action_count: int = 0
    admitted_count: int = 0
    skipped_count: int = 0
    rejected_count: int = 0
    plan_group_numbers: Tuple[str, ...] = ()
    #: 05 根因对齐跑过没有。同 :attr:`GateResult.evaluated` /
    #: :attr:`ConsistencyReport.reviewed` / :attr:`Objective.confirmed` 的既有范式：
    #: **不能用 0 或空集合表示未评估**，否则 P3 双跑对比时分不出「新链路认为这条根因
    #: 没动作」和「新链路根本没这一步」。
    aligned: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "rank": self.rank,
            "cause": self.cause,
            "level1": self.level1,
            "level2": self.level2,
            "level3": self.level3,
            "basis": self.basis,
            "evidence": self.evidence,
            "suggestion": self.suggestion,
            "confidence": self.confidence,
            "confidence_source": self.confidence_source,
            "verdict": self.verdict,
            "selected": self.selected,
            "plan_count": self.plan_count,
            "action_count": self.action_count,
            "admitted_count": self.admitted_count,
            "skipped_count": self.skipped_count,
            "rejected_count": self.rejected_count,
            "plan_group_numbers": list(self.plan_group_numbers),
            "aligned": self.aligned,
        }


@dataclass(frozen=True)
class CauseGap:
    """「记录不一致项」与「有根因无方案」—— 流程图上那个红框。

    P1 产不出来（它是 05 的第四档产出，而 05 要等「根因类目 ⟷ 方案组」映射表）。
    类先立着，P3 填。
    """

    #: inconsistent（初案 type1 不在任何收敛类别里）/ no_plan（有根因无对应方案）
    kind: str
    cause: str = ""
    detail: str = ""
    #: 主因落空要进整单判定，次因落空只记录。
    is_primary: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "cause": self.cause,
            "detail": self.detail,
            "is_primary": self.is_primary,
        }


@dataclass(frozen=True)
class ConsistencyReport:
    """06 方案一致性校验。

    来自整单复核（:mod:`services.decision.order_review`）。2026-09-23 起复核在决策的
    同步路径里跑，结论随裁决对象同事务落库 —— 不再是 ``order_review_json`` 那一列旁路注记。
    裁决（不发哪几个）由决策链按它做（demote，:func:`services.decision.chain.drop_by_review`），本报告只记结论；
    存量轮的 ``mode`` 可能是 ``annotate``（2026-10-03 前的观察档）。:attr:`reviewed` 如实说
    「这一轮到底有没有人看过一致性」。**空 conflicts 不等于没冲突** ——
    ``reviewed=False`` 时它只意味着没查过。
    """

    #: 这一轮跑过一致性判断没有（哪怕结论是 bypass）。
    reviewed: bool = False
    #: 现在只有 annotate —— 产出判断、不改 need_call。整单级，每行都带同一份。
    mode: str = ""
    #: 逐行复核阶段的**去重集合**，不是"代表行的那一个"。
    #:
    #: ``order_review.OrderReviewOutcome.row_slice`` 写的 ``phase`` 是逐行的：整轮跑通、
    #: 但模型漏判了某一行时，那一行会单独记 ``parse_bypass``/``not_reviewed``。拿任意一行
    #: 的它当整单结论，就会把"模型漏了一条"读成"整轮没跑成"，或者反过来。
    #: 整轮真正的结论要看 :attr:`reviewed` 与各行 phase 的分布。
    review_phases: Tuple[str, ...] = ()
    #: 去重后的冲突。同一个冲突在每个涉事行上都存了一份，按成员集合去重。
    conflicts: Tuple[Conflict, ...] = ()
    #: 复核侧自己报的整单计数（``order_review_json.order``），与本对象的去重结果互为校验。
    reviewed_action_count: int = 0
    order_conflict_count: int = 0
    relevance_counts: Dict[str, int] = field(default_factory=dict)
    #: 证据分级的分布。「LLM原理补充」剩多少，就是规则库还没覆盖到的那部分。
    evidence_counts: Dict[str, int] = field(default_factory=dict)
    #: 复核自己留下的告警（模型漏判、对不上的动作、证据分级被纠正……）与失败原因。
    #: 旁路年代它们只在每行的注记里，并进裁决对象之后不能丢。
    warnings: Tuple[str, ...] = ()
    error: str = ""
    reviewed_at: str = ""

    @property
    def conflict_count(self) -> int:
        return len(self.conflicts)

    @property
    def count_diverges(self) -> bool:
        """去重后的冲突数与复核侧自报的对不上 —— 说明有行的注记缺了或多了。"""
        return self.reviewed and self.conflict_count != self.order_conflict_count

    def to_dict(self) -> Dict[str, Any]:
        return {
            "reviewed": self.reviewed,
            "mode": self.mode,
            "review_phases": list(self.review_phases),
            "conflict_count": self.conflict_count,
            "order_conflict_count": self.order_conflict_count,
            "count_diverges": self.count_diverges,
            "reviewed_action_count": self.reviewed_action_count,
            "relevance_counts": dict(self.relevance_counts),
            "evidence_counts": dict(self.evidence_counts),
            "warnings": list(self.warnings),
            "error": self.error,
            "reviewed_at": self.reviewed_at,
            "conflicts": [item.to_dict() for item in self.conflicts],
        }


@dataclass(frozen=True)
class RiskAssessment:
    """07 参数风险评估的整单侧计数。

    P1 能填的只有「有没有裁决依据」「余量够不够一步」这两样确定性事实 ——
    它们是展示层裁决依据表（``decision_render.render_step_basis_table``）已经在算的。
    真正的风险**分级**要等 ``parameter_level``（209 行现在全是「其他」），
    :attr:`graded` 为 ``False`` 就是在说这件事。
    """

    row_count: int = 0
    with_basis_count: int = 0
    no_basis_count: int = 0
    #: 域内余量已不足一步的动作数 —— 再调一步就出域。
    tight_margin_count: int = 0
    #: 没有硬域可用的动作数（规则库无匹配）。这就是 49% 的盲区在整单上的投影。
    no_rule_count: int = 0
    #: 命中了规则、但那条规则当不了硬约束（步长或硬域解析不出来，或快照是模型回抄的）。
    #: 与 :attr:`no_rule_count` 合起来才是「07 真正无依据」的全貌 ——
    #: 现网规则库里步长与硬域**同时**可解析的只有 80/209（38%），
    #: 光看「有没有命中规则」会把这批高估成有依据。
    no_hard_constraint_count: int = 0
    #: 命中的是一条业务已停用的规则（``is_use='否'``，而匹配器不读这一列）。
    disabled_rule_count: int = 0
    #: 模型回抄的规则行与代码事实在决定性三列上对不上的条数。
    echo_diverged_count: int = 0
    #: 业务给出了风险分级的动作数。现网恒 0（``parameter_level`` 209 行全是「其他」）。
    graded_count: int = 0

    @property
    def graded(self) -> bool:
        """这一单有没有任何一条动作拿到了真实的风险分级。

        **由数据推出来，不是写死的** —— 业务把 ``parameter_level`` 填上那天，
        它自己就翻成 ``True``，不用改代码。这就是 P2-2c「把通道打通」的验收点。
        """
        return self.graded_count > 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "row_count": self.row_count,
            "with_basis_count": self.with_basis_count,
            "no_basis_count": self.no_basis_count,
            "tight_margin_count": self.tight_margin_count,
            "no_rule_count": self.no_rule_count,
            "no_hard_constraint_count": self.no_hard_constraint_count,
            "disabled_rule_count": self.disabled_rule_count,
            "echo_diverged_count": self.echo_diverged_count,
            "graded_count": self.graded_count,
            "graded": self.graded,
        }


@dataclass(frozen=True)
class GateCondition:
    """决策条件里的一条。见 :class:`GateResult`。"""

    name: str
    passed: bool
    detail: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "passed": self.passed, "detail": self.detail}


@dataclass(frozen=True)
class GateResult:
    """「是否满足决策条件」那个判断框。

    今天只有 ``need_call`` 一个是/否，**没有「条件」这个概念** —— 所以 P1 的
    :attr:`evaluated` 恒为 ``False``，:attr:`conditions` 恒为空。

    别把空 conditions 读成「条件全过了」：那正是这个布尔位存在的理由。
    """

    evaluated: bool = False
    conditions: Tuple[GateCondition, ...] = ()
    #: 未通过项 —— 回环（参数调优/剔除）就是冲它去的。
    unmet: Tuple[str, ...] = ()

    @property
    def passed(self) -> Optional[bool]:
        """``None`` = 没评估过。**不要用 ``not gate.passed`` 做判断。**"""
        if not self.evaluated:
            return None
        return not self.unmet

    def to_dict(self) -> Dict[str, Any]:
        return {
            "evaluated": self.evaluated,
            "passed": self.passed,
            "conditions": [item.to_dict() for item in self.conditions],
            "unmet": list(self.unmet),
        }


@dataclass(frozen=True)
class IterationTrace:
    """决策链对一个参数做的一次**调优 / 剔除**（P4，2026-09-24 落地）。

    方案里这两个分支原先都**藏在代码里静默发生**：参数调优 = 数值一步策略把 ICOS 建议值按步长取整到
    合法的一步候选；参数剔除 = 后验违规直接判死、不复评。P4 把它们显性化，逐条落这里，
    ``round_index`` 区分发生在哪一轮：

    * **第 0 轮**是首轮决策 —— 07 读规则库对方案做的调整（按步长取整 / 拉回可调范围 / 剔除）与 08 的同参数冲突剔除；
    * **第 1 轮起**是回环 —— 08「是否满足决策条件」判不满足，按不满足项走调优或剔除分支，再复评。

    由决策链（:mod:`services.decision.chain`）产出，落在 ``ChainVerdict.iterations``，
    同时就是 ``OrderDecision.iterations``。
    """

    round_index: int
    #: tune（调优）/ drop（剔除）
    action: str
    key: str = ""
    before: str = ""
    after: str = ""
    #: 为什么：第 0 轮是决策链的原因词（按规则步长改写为一步 / 同参数冲突剔除 …），
    #: 回环轮是没满足的决策条件（「、」连接）。
    reason: str = ""
    parachinname: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "round_index": self.round_index,
            "action": self.action,
            "key": self.key,
            "parachinname": self.parachinname,
            "before": self.before,
            "after": self.after,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class ChainAction:
    """决策链对**一条 ICOS 初案参数**的下场。每条初案一个（与 ``actions`` 一样全集）。

    合规链时期（schema ≤ 7）这里还并排放着合规链的实际下场（``before_*`` / ``change``），
    2026-09-25 合规链删除后拿掉了 —— 库里老轮次的 JSON 仍带着那几格。
    """

    #: 决策行的 ``agent_decision_id``（与 08 冲突剔除同一个键）；没有决策行时退回对齐键。
    key: str
    #: 对齐键（``plan_key``），即 :attr:`ActionVerdict.key`。
    plan_key: str
    parachinname: str
    #: 方案组分组键与方案编号 —— 04 组内寻优的单位。
    group_key: str
    plan_number: str
    #: 由哪一步定的下场：``services.decision.chain.ChainStage`` 的取值（04 / 07 / 08）。
    stage: str
    #: 为什么是这个下场：``services.decision.chain.ChainReason`` 的取值。
    reason: str
    #: 发不发、发什么值（不发为空串）。
    dispatched: bool
    value: str = ""
    #: 给人看的一句话（开关 / 条件型规则怎么判的、多轮决策为什么是这一档）。
    detail: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "plan_key": self.plan_key,
            "parachinname": self.parachinname,
            "group_key": self.group_key,
            "plan_number": self.plan_number,
            "stage": self.stage,
            "reason": self.reason,
            "dispatched": self.dispatched,
            "value": self.value,
            "detail": self.detail,
        }


#: ``ChainVerdict.mode`` 取这个值且算成了 = 本轮由决策链裁决。2026-09-25 合规链删除后恒为这个值；
#: 此前的老轮次还有 ``shadow``（P6 双跑：只算不发）/ ``off`` / ``recomputed``（双跑报表事后重算）。
CHAIN_MODE_ENFORCE = "enforce"


@dataclass(frozen=True)
class ChainVerdict:
    """决策链（04 组内寻优 → 07 规则库风险评估 → 08 冲突剔除 → 决策条件回环）这一轮的结论。

    算法在 :mod:`services.decision.chain`，这里只是落库形态（``OrderDecision.chain`` → ``decision_json.chain``，
    schema ≤ 13 的存量对象里叫 ``shadow``）。``DecisionService`` 把 :attr:`actions` 写进每一行的下发两格，
    :attr:`OrderDecision.actions` 与整单判定随之推出来 —— 推送、展示、正文只读 ``OrderDecision.actions``，不读这里。

    P6 双跑时期它与合规链并排算（shadow 档只算不发、enforce 档接管下发），``mode`` 的取值是那时定的。
    2026-09-25 合规链删除后它是唯一的裁决者，``mode`` 恒为 :data:`CHAIN_MODE_ENFORCE`。
    ``evaluated=False`` = 决策链没算成（``error`` 说明原因）：``DecisionService`` 据此整单转人工、一行不写。
    """

    evaluated: bool = False
    #: 恒为 :data:`CHAIN_MODE_ENFORCE`（老轮次还有 ``shadow`` / ``off`` / ``recomputed``）。
    mode: str = ""
    actions: Tuple[ChainAction, ...] = ()
    #: 给人看的补充说明。
    notes: Tuple[str, ...] = ()
    error: str = ""
    #: P4：决策链的调优 / 剔除（第 0 轮是 07 / 08 的首轮调整，第 1 轮起是决策条件回环）。
    iterations: Tuple[IterationTrace, ...] = ()
    #: 决策条件回环实际跑了几轮（0 = 首轮就满足）。
    loop_rounds: int = 0
    #: 回环用尽仍不满足的决策条件。非空 = 这张单**整单不下发、转人工**（见 :attr:`manual`）。
    conditions_unmet: Tuple[str, ...] = ()

    @property
    def dispatched_after(self) -> int:
        """决策链这一轮发几条。"""
        return sum(1 for item in self.actions if item.dispatched)

    @property
    def manual(self) -> bool:
        """决策条件回环用尽仍不满足 —— 这张单**整单不下发、转人工**（2026-09-24 拍板），
        ``DecisionService`` 据此抛 ``DecisionConditionsUnmet``。"""
        return self.evaluated and bool(self.conditions_unmet)

    @property
    def enforced(self) -> bool:
        """本轮是否由决策链裁决（算成了）。没算成（``evaluated=False``）的轮次整单转人工、不落库
        （``decision_service.DecisionChainFailed``），所以落了库的新轮次恒为 True；老轮次的 shadow 档是 False。"""
        return self.evaluated and self.mode == CHAIN_MODE_ENFORCE

    def to_dict(self) -> Dict[str, Any]:
        return {
            "evaluated": self.evaluated,
            "mode": self.mode,
            "enforced": self.enforced,
            "dispatched_after": self.dispatched_after,
            "actions": [item.to_dict() for item in self.actions],
            "notes": list(self.notes),
            "error": self.error,
            "iterations": [item.to_dict() for item in self.iterations],
            "loop_rounds": self.loop_rounds,
            "conditions_unmet": list(self.conditions_unmet),
            "manual": self.manual,
        }


@dataclass(frozen=True)
class OrderVerdict:
    """08 综合决策及参数编排的整单结论。

    **由计数算出，不问模型** —— 逐字沿用
    :func:`services.decision.action_facts.order_dispatch_verdict`，两处不可能给出两个说法。
    """

    #: 封闭词表：可自动下发 / 条件下发 / 不下发；空串 = 连决策行都没有，无从判定。
    word: str = ""
    #: 成品叙述，逐字等于 ``order_dispatch_verdict(...)["statement"]``。
    statement: str = ""
    row_count: int = 0
    admitted_count: int = 0
    #: 准入但没经规则校验的条数 —— 「条件下发」就是被它触发的。
    unchecked_count: int = 0
    rejected_count: int = 0
    changed_count: int = 0
    unchanged_count: int = 0
    #: 未准入原因 → 条数。
    rejected_reasons: Dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "word": self.word,
            "statement": self.statement,
            "row_count": self.row_count,
            "admitted_count": self.admitted_count,
            "unchecked_count": self.unchecked_count,
            "rejected_count": self.rejected_count,
            "changed_count": self.changed_count,
            "unchanged_count": self.unchanged_count,
            "rejected_reasons": dict(self.rejected_reasons),
        }


# --------------------------------------------------------------------------- #
# OrderDecision
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class OrderDecision:
    """一张工单**一轮**的完整裁决。生产一次、落库一次（``agent_order_decision``）、所有人只读。

    字段顺序 = 流程图 01→08 + 决策条件 + 回环（schema 3 起，2026-09-23 重排）。
    上一版刻意没调，理由是会改 :meth:`to_dict` 的键序与位置构造语义；这一轮对象开始
    落库、又要加 ``candidates``，是结构本来就要动的唯一窗口（清单 §4.4 的建议），
    库里此前 0 行携带它，不存在混版本人群。全仓只有关键字构造，没有位置构造。
    """

    schema: int
    taskno: str
    taskid: str
    #: 轮次，== ``agent_execution_plan.retry_times``（0 起）。界面上的「第 N 轮」是它 +1。
    retry_times: int

    facts: MultiSourceFacts        # 多维数据汇总 + 01 信息汇总与对齐
    causes: Tuple[Cause, ...]      # 02 根因收敛
    objective: Objective           # 03 方案目标确认
    #: 04 生成方案的候选集。``None`` = 事后从 DB 行重建的对象（候选集只在决策时产出）。
    candidates: Optional["CandidateSet"]  # 04 生成方案
    cause_gaps: Tuple[CauseGap, ...]  # 05 的「记录不一致项」
    consistency: ConsistencyReport # 06 方案一致性校验
    risk: RiskAssessment           # 07 参数风险评估
    actions: Tuple[ActionVerdict, ...]  # 08 的逐动作裁决
    gate: GateResult               # 是否满足决策条件
    #: 调优 / 剔除 / 复评（P4）= 决策链的 ``chain.iterations``；合规链时期的老轮次与回退轮为空。
    iterations: Tuple[IterationTrace, ...]
    verdict: OrderVerdict          # 08 的整单结论
    #: 决策链这一轮的结论。放在 ``verdict`` 之后只因为它有默认值；:meth:`to_dict` 里它紧跟 ``iterations``。
    #: schema ≤ 13 的存量对象里这一块叫 ``shadow``（P6 双跑时期的名字，不迁移）。
    chain: ChainVerdict = field(default_factory=ChainVerdict)
    #: 02 模型收敛这一次的状态（converged / not_called / failed）、所用阈值与模型给的理由。
    #: ``None`` = 不是决策时产出的（事后从 DB 行重建）。:meth:`to_dict` 里它紧跟 ``causes``。
    cause_convergence: Optional[Dict[str, Any]] = None
    #: 多轮决策：前几轮的下发与短评估、本轮据此排除的参数（``prior_round.PriorRounds.to_dict``）。
    #: 形状见 ``multi_round.prior_rounds_doc``（rounds / histories / multi_round / rollback_round），首轮各项为空；
    #: ``None`` = 不是决策时产出的（事后从 DB 行重建）。
    #: :meth:`to_dict` 里它紧跟 ``facts``。
    prior_rounds: Optional[Dict[str, Any]] = None
    #: 构造过程中发现的口径问题（对不上的行、分歧的字段…）。空 = 没发现。
    warnings: Tuple[str, ...] = ()
    #: 这一轮的**决策流水线轨迹**（``services.decision.pipeline``）：每一步跑没跑、耗时、一句摘要，
    #: 按执行顺序。决策时由 ``DecisionService`` 在落库前挂上；事后从 DB 行重建时为空（重建不重跑流水线）。
    pipeline: Tuple[StageRecord, ...] = ()
    #: 04 案例参考（schema 10 起）：本轮每条候选的同类先例与整单参考案例。放在最后只因为它有默认值；
    #: :meth:`to_dict` 里它紧跟 ``candidates``。``None`` = 案例库没开 / 这一步失败 / 事后重建。
    cases: Optional[CaseEvidence] = None
    #: 05 根因对齐（schema 13 起）：模型判的「02 收敛根因 ⟷ 方案」对应关系（``CauseAlignment.to_dict``）。
    #: :meth:`to_dict` 里它紧跟 ``cases``、在 ``cause_gaps`` 之前。``None`` = 这一步没跑到 / 坏了 / 事后重建。
    alignment: Optional[Dict[str, Any]] = None

    @property
    def round_no(self) -> int:
        """界面口径的轮次（1 起）。"""
        return self.retry_times + 1

    @property
    def admitted(self) -> Tuple[ActionVerdict, ...]:
        return tuple(item for item in self.actions if item.is_dispatched)

    @property
    def primary_cause(self) -> Optional[Cause]:
        return next((item for item in self.causes if item.selected), None)

    def action_by_key(self, key: str) -> Optional[ActionVerdict]:
        return next((item for item in self.actions if item.key == key), None)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schema": self.schema,
            "taskno": self.taskno,
            "taskid": self.taskid,
            "retry_times": self.retry_times,
            "round_no": self.round_no,
            "facts": self.facts.to_dict(),
            "prior_rounds": self.prior_rounds,
            "causes": [item.to_dict() for item in self.causes],
            "cause_convergence": self.cause_convergence,
            "objective": self.objective.to_dict(),
            "candidates": self.candidates.to_dict() if self.candidates is not None else None,
            "cases": self.cases.to_dict() if self.cases is not None else None,
            "alignment": self.alignment,
            "cause_gaps": [item.to_dict() for item in self.cause_gaps],
            "consistency": self.consistency.to_dict(),
            "risk": self.risk.to_dict(),
            "actions": [item.to_dict() for item in self.actions],
            "gate": self.gate.to_dict(),
            "iterations": [item.to_dict() for item in self.iterations],
            "chain": self.chain.to_dict(),
            "verdict": self.verdict.to_dict(),
            "warnings": list(self.warnings),
            "pipeline": [item.to_dict() for item in self.pipeline],
        }


# --------------------------------------------------------------------------- #
# 构造
# --------------------------------------------------------------------------- #
#: 工单主表上进 :attr:`MultiSourceFacts.order` 的列。只挑决策链真正读得到的，
#: 不整行搬 —— 整行搬会让「哪些字段其实没人消费」这件事永远看不清。
_ORDER_FACT_KEYS = (
    "taskno", "taskid", "cell_name", "cgi", "eci", "city", "province", "region",
    "nettype", "vendor", "task_type", "outside_type", "cate", "type", "level_r",
    "type1", "type2", "type3", "conclusion", "smart_conclusion", *DIMENSION_FIELDS, "sort_conclusion",
    "scene", "scene_level", "inoutdoor", "cover_area", "createtime",
    "degradation_time", "duration_day", "degradation_times",
)

#: 初案行上进 :attr:`MultiSourceFacts.plans` 的列。
_PLAN_FACT_KEYS = (
    "execution_id", "plan_number", "plan_group_number", "execute_number",
    "parachinname", "type1", "type2", "type3", "f_para", "b_para", "operate",
    "language_describe", "vendor", "ne_type", "nettype", "cell_name",
)


def _case_source(cases: Optional[CaseEvidence]) -> SourceStatus:
    """「案例库」这一源：本轮 04 案例参考真跑了就算通（2026-09-27 起，order 内部三张表）。

    不考虑空库（2026-10-20 用户定）：之前库内 0 例时报 ``empty``，现在照报通、写「库内 0 例」。
    """
    if cases is None:
        return SourceStatus("案例库", SourceState.ABSENT, "本轮没有案例参考（order_loop.case_library 未启用或这一步失败）")
    return SourceStatus(
        "案例库", SourceState.CONNECTED, f"decision_case：库内 {cases.library_size} 例，{cases.hit_count} 个候选有同类先例"
    )


#: 01 指标取数的三路在 ``facts.sources`` 里的名字（与 ``kpi_interpretation.decision_fetch.SOURCE_TITLES`` 同名）。
_KPI_SOURCE_NAMES = ("网管指标", "MR", "工参")
#: 拉取记录的状态（``order_data_pull.status``）→ 这一源本轮通没通：拉到了（含部分拉到、沿用上次）算通，
#: 取数成功但源库里没有这个小区是「有表无数据」，取数失败与没取一样是「本轮没有这一源」。
_KPI_SOURCE_STATES = {
    "ok": SourceState.CONNECTED,
    "partial": SourceState.CONNECTED,
    "reused": SourceState.CONNECTED,
    "empty": SourceState.EMPTY,
}


def _kpi_sources(kpi_data: Optional[Dict[str, Any]]) -> Tuple[SourceStatus, ...]:
    """「网管指标 / MR / 工参」三行：按本轮 01 指标取数的拉取记录报通没通（2026-10-27 起）。"""
    entries = {
        _text(item.get("label")): item
        for item in (kpi_data or {}).get("sources") or ()
        if isinstance(item, dict) and _text(item.get("label"))
    }
    statuses = []
    for name in _KPI_SOURCE_NAMES:
        item = entries.get(name)
        if item is None:
            statuses.append(
                SourceStatus(name, SourceState.ABSENT, "本轮没有指标取数（order_loop.kpi_interpretation 未启用或这一步失败）")
            )
            continue
        status = _text(item.get("status"))
        matched = _text(item.get("matched_by"))
        detail = "；".join(
            part
            for part in (
                _text(item.get("status_label")) or status,
                _text(item.get("target_table")),
                _text(item.get("access_note")),
                f"按 {matched} 命中" if matched else "",
                _text(item.get("error")),
            )
            if part
        )
        statuses.append(SourceStatus(name, _KPI_SOURCE_STATES.get(status, SourceState.ABSENT), detail))
    return tuple(statuses)


def _source_statuses(
    order: Dict[str, Any],
    icos_rows: Sequence[Dict[str, Any]],
    graded: bool = False,
    *,
    conclusion_shape: str = "",
    cases: Optional[CaseEvidence] = None,
    kpi_data: Optional[Dict[str, Any]] = None,
) -> Tuple[SourceStatus, ...]:
    """方案「逐节点对账」那张表的类型化版本 —— 哪些源今天真的通了。

    ``top_causes`` 单列出来是因为它**有列但 90 张工单 0 条有值**，这种「看着有、其实没有」
    最容易被下游当成可用输入。

    「根因结果」这一行是**形态感知**的：光看两字段非空，会让自由文本工单报 ``CONNECTED``
    却产出零条根因 —— 正是上一句警告 ``top_causes`` 的那种「看着有、其实没有」。
    自由文本标 ``EMPTY`` 而不新开第四档，是因为 :class:`SourceState` 的口径是「这个源今天
    对决策链**可用**吗」，``top_causes``「有列无数据」也标 ``EMPTY``，这是同构的既有先例；
    第四档（``UNPARSED``）是跨模块封闭词表，动它要连 ``frontend_view`` 一起看。
    """
    return (
        SourceStatus("工单信息", SourceState.CONNECTED, "wireless_order_info，两个接入接口"),
        SourceStatus(
            "根因结果",
            SourceState.CONNECTED,
            "六维判定（cover / adj / param / interfere / alarm / resource_totalverdict）全有：模型收敛与 conclusion + "
            "smart_conclusion 一起送，确定性兜底逐维一条",
        )
        if conclusion_shape == ConclusionShape.DIMENSIONS
        else SourceStatus(
            "根因结果",
            SourceState.CONNECTED
            if conclusion_shape == ConclusionShape.SECTIONED
            else SourceState.EMPTY,
            "conclusion + smart_conclusion；三段式形态才收敛得出根因（现网 30/93）。"
            "自由文本 47/93（50.5%）本档收敛不出，两字段皆空 16/93（17.2%）",
        ),
        SourceStatus(
            "预定义方案",
            SourceState.CONNECTED if icos_rows else SourceState.EMPTY,
            "icos_initial_plan_record",
        ),
        SourceStatus(
            "top_causes",
            SourceState.EMPTY,
            "有列无数据（实测 90 张工单 0 条有值），不作为收敛输入",
        ),
        *_kpi_sources(kpi_data),
        _case_source(cases),
        SourceStatus(
            "参数风险分级",
            SourceState.CONNECTED if graded else SourceState.EMPTY,
            "规则库 parameter_level，通道已通（llm_solution.matched_rule）；"
            "现网 209 行全是「其他」，等业务供数",
        ),
        SourceStatus(
            "功能互斥",
            SourceState.EMPTY,
            "规则库 is_mutual_exclusion，通道已通；现网 209 行全空，互斥无现成数据源",
        ),
    )


def _fact_issues(order: Dict[str, Any], icos_rows: Sequence[Dict[str, Any]]) -> Tuple[FactIssue, ...]:
    """01 对齐：工单与初案之间**确定性可查**的不一致。只记录，不裁决。

    制式与厂商按规则库匹配的同一口径比（``normalize_nettype``）—— 规则库匹配读的是
    **工单**的制式与厂商，初案自己的那两列与工单不一致时，这条初案会拿到别的规则。
    02 样本（154 单）上小区 / 制式三项全一致，现网 0 例不等于不会发生：
    入站没有任何一处校验初案与工单同属一个小区。
    """
    issues: List[FactIssue] = []
    for name in TRIGGER_FIELDS:
        if not _text(order.get(name)):
            issues.append(
                FactIssue(FactIssueKind.TRIGGER_FIELD_MISSING, name, f"工单 {name} 为空，正文只能写「输入未提供」")
            )

    def _mismatch(kind: str, name: str, norm, label: str) -> None:
        expected = norm(order.get(name))
        if not expected:
            return  # 工单侧没给，无从比；缺字段已在上面记过
        keys = tuple(
            plan_key(plan.get("execution_id"), plan.get("parachinname"))
            for plan in icos_rows
            if (actual := norm(plan.get(name))) and actual != expected
        )
        if keys:
            issues.append(
                FactIssue(kind, name, f"{len(keys)} 条初案的{label}与工单（{expected}）不一致", keys=keys)
            )

    _mismatch(FactIssueKind.PLAN_CELL_MISMATCH, "cell_name", _text, "作用小区")
    _mismatch(FactIssueKind.PLAN_NETTYPE_MISMATCH, "nettype", normalize_nettype, "制式")
    _mismatch(FactIssueKind.PLAN_VENDOR_MISMATCH, "vendor", _text, "厂商")

    missing_keys = tuple(
        plan_key(plan.get("execution_id"), plan.get("parachinname"))
        for plan in icos_rows
        if not all(_text(plan.get(name)) for name in ("type1", "type2", "parachinname"))
    )
    if missing_keys:
        issues.append(
            FactIssue(
                FactIssueKind.PLAN_MATCH_KEY_MISSING,
                "type1/type2/parachinname",
                f"{len(missing_keys)} 条初案缺规则库匹配键，07 规则库评估会判匹配键不全、不下发",
                keys=missing_keys,
            )
        )
    return tuple(issues)


def _build_objective(
    order: Dict[str, Any],
    round_rows: Sequence[Dict[str, Any]],
    issues: Sequence[FactIssue] = (),
) -> Objective:
    """03 的字段投影。主指标优先取 ``order_info`` 里**已映射**的那个值。

    ``task_type`` 经 ``task_type_replace.csv`` 映射成 ``task_main_type`` 是在
    ``decision_service.build_order_payload`` 里做的，映射后的值落在
    ``order_info.order_data.问题类型``。本模块不能 import ``services.orders``
    （决策包的依赖白名单），所以从已落库的 payload 里读回来 —— 那本来就是同一份值，
    不是第二套映射。
    """
    mapped = ""
    for row in round_rows or []:
        if not isinstance(row, dict):
            continue
        order_data = _loads(row.get("order_info")).get("order_data")
        if isinstance(order_data, dict) and (value := _text(order_data.get("问题类型"))):
            mapped = value
            break
    main_metric = mapped or _text(order.get("task_type"))
    target = {name: _text(order.get(name)) for name in ("cell_name", "cgi", "eci")}
    off_target = sum(
        len(item.keys) for item in issues if item.kind == FactIssueKind.PLAN_CELL_MISMATCH
    )
    unconfirmed: List[str] = []
    if not main_metric:
        unconfirmed.append("问题类型缺失，主指标无从确认")
    if not any(target.values()):
        unconfirmed.append("目标小区缺失（小区名 / CGI / ECI 均为空），闭环边界无从确认")
    if off_target:
        unconfirmed.append(f"{off_target} 条初案作用于非本单小区，越出闭环边界")
    return Objective(
        main_metric=main_metric,
        metric_code=_text(order.get("outside_type")),
        degradation_time=_text(order.get("degradation_time")),
        duration_day=order.get("duration_day") if isinstance(order.get("duration_day"), int) else None,
        degradation_times=(
            order.get("degradation_times") if isinstance(order.get("degradation_times"), int) else None
        ),
        severity=_text(order.get("level_r")),
        target_cell=target["cell_name"],
        target_cgi=target["cgi"],
        target_eci=target["eci"],
        off_target_count=off_target,
        unconfirmed=tuple(unconfirmed),
    )


def _build_causes(convergence: ConvergenceResult) -> Tuple[Cause, ...]:
    """**02 根因收敛**的解析结果 → 类型化根因。丢掉 tone / confidenceLabel。

    六个挂接计数硬置 ``0`` / ``()`` 并 ``aligned=False`` —— 它们是 **05 根因对齐**
    的**挂接计数**产出（区别于 :attr:`ActionVerdict.association` 的四档，那部分已由
    :mod:`services.decision.alignment` 填好）。计数仍填不出来：初案 ``type1`` 只对齐到
    **类别**，而 :class:`Cause` 按收敛条目编号、同类别可重复 —— 要把动作数摊到具体哪条
    ``Cause`` 上，得等 P1.5 映射表给出「类目 ⟷ 方案组」的精细键。**不从入参里取**：
    取了就等于给「将来某人顺手填个假值」开门。
    """
    causes: List[Cause] = []
    for item in convergence.causes:
        causes.append(
            Cause(
                rank=item.rank,
                cause=item.label,
                level1=item.category,
                level2=item.cause_name,
                level3="",                            # conclusion / 六维两侧都没有三级原因这一层
                basis=(
                    CauseBasis.ORDER_DIMENSIONS
                    if convergence.source == SOURCE_DIMENSIONS
                    else CauseBasis.ORDER_CONCLUSION
                ),
                evidence=item.evidence,
                suggestion=item.suggestion,
                confidence=0.0,
                confidence_source=CONFIDENCE_ABSENT,
                verdict=item.position,
                selected=item.leading,
                plan_count=0,
                action_count=0,
                admitted_count=0,
                skipped_count=0,
                rejected_count=0,
                plan_group_numbers=(),
                aligned=False,                        # 05 根因对齐还没做
            )
        )
    return tuple(causes)


def _build_model_causes(result: CauseConvergence, threshold: int) -> Tuple[Cause, ...]:
    """**02 模型收敛**的结果 → 类型化根因（schema 5 起 :attr:`OrderDecision.causes` 的默认来源）。

    置信度原样落 :attr:`Cause.confidence`（0–100）；结论按阈值给主因 / 次因 / 低置信，
    ``selected`` = 主因那条。挂接计数先硬置 0，05 模型对齐跑过时由 :func:`_aligned_causes` 填上。
    """
    causes: List[Cause] = []
    for item in result.causes:
        standing = result.standing(item, threshold)
        causes.append(
            Cause(
                rank=item.rank,
                cause=item.cause,
                level1=item.category,
                level2="",
                level3="",
                basis=(
                    CauseBasis.ORDER_DIMENSIONS_MODEL
                    if result.source == SOURCE_DIMENSIONS
                    else CauseBasis.ORDER_CONCLUSION_MODEL
                ),
                evidence=item.evidence,
                suggestion="",
                confidence=float(item.confidence),
                confidence_source=CONFIDENCE_SOURCE_MODEL,
                verdict=standing,
                selected=standing == CauseStanding.PRIMARY,
                aligned=False,
            )
        )
    return tuple(causes)


def _aligned_causes(
    causes: Tuple[Cause, ...], alignment: CauseAlignment, actions: Sequence["ActionVerdict"]
) -> Tuple[Cause, ...]:
    """把 05 根因对齐的结果摊回模型收敛的每条根因：几个方案、几项动作针对它、本轮各几项准入 / 未准入，
    以及这些方案的方案组编号；``aligned=True``。按根因名对（05 点名的根因名与收敛表一字不差）。"""
    by_key = {item.key: item for item in actions}
    out: List[Cause] = []
    for cause in causes:
        plans = [plan for plan in alignment.plans if cause.cause in plan.causes]
        hit = [by_key[key] for plan in plans for key in plan.keys if key in by_key]
        states = [item.round_state for item in hit]
        out.append(
            replace(
                cause,
                plan_count=len(plans),
                action_count=len(hit),
                admitted_count=states.count("admitted"),
                skipped_count=states.count("skipped"),
                rejected_count=states.count("rejected"),
                plan_group_numbers=tuple(
                    dict.fromkeys(plan.plan_group_number for plan in plans if plan.plan_group_number)
                ),
                aligned=True,
            )
        )
    return tuple(out)


def _cause_ref_index(candidates: Sequence[Dict[str, Any]], refs: Dict[str, str]) -> Dict[str, CauseRef]:
    """``{对齐键: CauseRef}``。``ref`` 文本逐字取自 ``root_cause_refs``，不重新拼。

    这里的 ``rank`` 是**初案对齐表**（:func:`services.decision.root_cause.root_cause_groups`）
    的序位，**不是** :attr:`OrderDecision.causes` **的下标** —— ``causes`` 换成
    **02 根因收敛**之后，两者是两个互不相干的编号空间。
    别写 ``decision.causes[action.cause.rank - 1]``，那会拿到错的根因，而且不会报错。

    把动作挂到收敛出的根因上是 **05 根因对齐**的事（阻塞于业务侧 P1.5「根因类目 ⟷
    方案组」映射表），占位符是 :attr:`ActionVerdict.association`（恒
    :data:`Association.PENDING`）。02 根因收敛**根本不产 per-action 指针**：
    ``root_cause_refs`` 的键是 ``plan_key(execution_id, parachinname)``，而
    ``execution_id`` 只存在于初案行 —— ``conclusion`` 里没有任何能对齐到具体动作的标识。
    因此 :mod:`services.decision.convergence` **不提供 ``*_refs`` 这类函数**。
    """
    by_ref = {
        f"#{item.get('rank')} {item.get('cause')}": (int(item.get("rank") or 0), _text(item.get("cause")))
        for item in candidates or []
        if isinstance(item, dict)
    }
    index: Dict[str, CauseRef] = {}
    for key, ref in (refs or {}).items():
        rank, cause = by_ref.get(ref, (0, ""))
        index[key] = CauseRef(rank=rank, cause=cause, ref=ref)
    return index


def _parse_conflicts(raw: Any) -> Tuple[Conflict, ...]:
    conflicts: List[Conflict] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        members = tuple(_text(member) for member in (item.get("members") or []) if _text(member))
        # ``kind`` 原样带出，**不在这里二次归一** —— 写库那一刻
        # ``order_review._parse_conflicts`` 已经归过了，这里再归一次等于悄悄改写历史数据。
        # 词表本身由 ``tests/test_verdict.py`` 对着 ``CONFLICT_VOCAB`` 钉住。
        conflicts.append(
            Conflict(
                members=members,
                kind=_text(item.get("kind")),
                reason=_text(item.get("reason")),
            )
        )
    return tuple(conflicts)


def _parse_trace(raw: Any) -> Tuple[TraceStage, ...]:
    stages = _loads(raw).get("stages")
    if not isinstance(stages, list):
        return ()
    out: List[TraceStage] = []
    for item in stages:
        if not isinstance(item, dict):
            continue
        out.append(
            TraceStage(
                seq=int(item.get("seq") or 0),
                stage=_text(item.get("stage")),
                failed=bool(item.get("failed")),
                verdict=_text(item.get("verdict")),
                inputs=item.get("inputs"),
                outputs=item.get("outputs"),
                detail=item.get("detail"),
            )
        )
    return tuple(out)


def _admission(row: Dict[str, Any], state: Dict[str, Any], phase: str) -> str:
    """三档 → 四档：把「整档跳过」从 rejected 里拆出来。

    优先级必须是**先看准入、再看跳过**：``_skip_lower_tiers`` 写的行一定是
    ``need_call='否'``，所以现实里两者不会同时成立；但万一数据脏了，
    「已经发出去了」永远比「本档没试」更该被看见。
    """
    if state["is_dispatched"]:
        return (
            Admission.ADMITTED_UNCHECKED
            if state["admission_state"] == "admitted_unchecked"
            else Admission.ADMITTED
        )
    return Admission.SKIPPED if phase == Phase.SKIPPED_LOWER_PRIORITY else Admission.REJECTED


def _reason_of(label: str) -> str:
    """成品标签 → 短原因。**从 label 切出来，不另建一套词表。**

    ``verdict_row_state`` 产出的标签形如 ``未准入·档位跳过`` / ``已准入·裁决改写``，
    ``·`` 后面那截就是封闭词表里的原因。自己再维护一份 phase→原因 的映射，
    正是这次重构要消灭的重复 —— 而且两份一旦漂移，界面和裁决对象会各说一套。
    """
    return label.split("·", 1)[1] if "·" in label else label


def build_action_verdict(
    row: Dict[str, Any],
    *,
    plan: Optional[Dict[str, Any]] = None,
    cause_ref: Optional[CauseRef] = None,
    association: str = Association.PENDING,
    review_note: Optional[Dict[str, Any]] = None,
) -> ActionVerdict:
    """一行 ``agent_execution_plan`` → 一个 :class:`ActionVerdict`。

    ``review_note`` 是这一行的整单复核注记（``OrderReviewOutcome.row_slice`` 的形状）。
    决策时由 ``build_order_decision`` 从同步复核的结果切好传进来；不传就读行上的
    ``order_review_json``（存量轮：复核还在异步旁路时写的那一列）。

    ``plan`` 是按 :func:`~services.decision.plan_table.plan_key` 回查到的初案行，
    只用来补 ``agent_execution_plan`` 上**没有的列**（方案组编号等）。
    回查不到不影响其余字段 —— 与 ``plan_table.verdict_entries`` 的同名口径一致。

    ``association`` 是 **05 根因对齐**的四档；调用方（``build_order_decision``）按 05 的模型对齐结果
    （没有就按 :func:`services.decision.alignment.align_root_causes` 的类别四档）算好后传进来。不传 = 未对齐。
    """
    solution = row_solution(row)
    state = verdict_row_state(row)
    phase = _text(solution.get("phase"))
    label = _text(state["admission_label"])
    plan = plan if isinstance(plan, dict) else {}

    # 规则行与一步依据：谁裁决这一行就读谁的（决策链的行读 07 的规则库结论）。
    basis = rule_basis(row)
    rule_row = RuleRow.from_solution(basis)
    step = StepBasis.from_solution(
        basis,
        b_para=row.get("b_para"),
        dispatched=state["is_dispatched"],
    )
    chain_doc = enforced_chain(row)
    chain = (
        ChainNote(
            stage=_text(chain_doc.get("stage")),
            reason=_text(chain_doc.get("reason")),
            detail=_text(chain_doc.get("detail")),
            rule_shape=_text(basis.get("rule_shape")),
            rule_reason=_text(basis.get("rule_reason")),
        )
        if chain_doc is not None
        else None
    )

    review = review_note if isinstance(review_note, dict) else _loads(row.get("order_review_json"))
    trace_doc = _loads(row.get("decision_trace_json"))
    action_note = review.get("action")
    relevance = None
    if isinstance(action_note, dict):
        word = _text(action_note.get("relevance"))
        relevance = Relevance(
            relevance=word if word in RELEVANCE_VOCAB else RELEVANCE_UNJUDGED,
            path=_text(action_note.get("path")),
            evidence=_text(action_note.get("evidence")),
            sources=tuple(
                _text(item) for item in (action_note.get("sources") or []) if _text(item)
            ) if isinstance(action_note.get("sources"), list) else (),
        )

    # 告警与失败原因同样取裁决这一行的那条链路的（合规链退役后行上不再有合规链的这两格）。
    warnings = basis.get("warnings")
    return ActionVerdict(
        key=plan_key(row.get("execution_id"), row.get("tool")),
        agent_decision_id=_text(row.get("agent_decision_id")),
        parachinname=_text(row.get("tool")) or _text(plan.get("parachinname")),
        f_para=_text(row.get("f_para")),
        org_b_para=_text(row.get("org_b_para")),
        b_para=_text(row.get("b_para")),
        admission=_admission(row, state, phase),
        reason=_reason_of(label),
        label=label,
        phase=phase,
        changed=state["changed"],
        need_call=_need_call_column_or_json(row),
        # 只有跳档行会带它 —— 其余 phase 的 llm_solution 里没有 execution_id 这个键。
        superseded_by=(
            _text(solution.get("execution_id"))
            if phase == Phase.SKIPPED_LOWER_PRIORITY
            else ""
        ),
        plan_group_number=_text(plan.get("plan_group_number")),
        plan_number=_text(row.get("plan_number")) or _text(plan.get("plan_number")),
        execute_number=_text(row.get("execute_number")) or _text(plan.get("execute_number")),
        execution_id=_text(row.get("execution_id")),
        plan_b_para=_text(plan.get("b_para")),
        rule_row=rule_row,
        step=step,
        cause=cause_ref,
        association=association,
        relevance=relevance,
        review_phase=_text(review.get("phase")),
        conflicts=_parse_conflicts(review.get("conflicts")),
        reviewed=bool(review),
        trace=_parse_trace(row.get("decision_trace_json")),
        warnings=tuple(_text(item) for item in warnings) if isinstance(warnings, list) else (),
        error=_text(basis.get("error")),
        risk_basis=_text(_note(trace_doc, "risk").get("basis")),
        path=_text(_note(trace_doc, "alignment").get("path")),
        gate_failed=tuple(
            _text(item) for item in (_note(trace_doc, "gate").get("failed") or []) if _text(item)
        ),
        chain=chain,
    )


def _note(trace_doc: Dict[str, Any], key: str) -> Dict[str, Any]:
    """轨迹顶层键的注记 → dict。缺失或形状不对一律空字典。"""
    value = trace_doc.get(key)
    return value if isinstance(value, dict) else {}


def build_order_decision(
    order: Dict[str, Any],
    icos_rows: Sequence[Dict[str, Any]] = (),
    round_rows: Sequence[Dict[str, Any]] = (),
    *,
    candidates: Optional["CandidateSet"] = None,
    gate: Optional[GateResult] = None,
    review: Optional[OrderReviewOutcome] = None,
    chain: Optional[ChainVerdict] = None,
    cause_convergence: Optional[CauseConvergence] = None,
    confidence_threshold: int = DEFAULT_CONFIDENCE_THRESHOLD,
    prior_rounds: Optional[Dict[str, Any]] = None,
    case_evidence: Optional[CaseEvidence] = None,
    cause_alignment: Optional[CauseAlignment] = None,
    kpi_data: Optional[Dict[str, Any]] = None,
) -> OrderDecision:
    """DB 行 → :class:`OrderDecision`。**唯一入口。**

    ``kpi_data`` 是 01 指标取数的摘要（只有决策时才有，``services.kpi_interpretation`` 产出的纯 dict），
    原样挂进 ``facts.kpi_data``，并由它报 ``facts.sources`` 的网管指标 / MR / 工参三行；本模块不取数、不解读。

    ``cause_alignment`` 是 05 根因对齐（模型载体）的产出（只有决策时才有）：有逐方案的对应关系时，
    ``actions[].association`` 与 ``cause_gaps`` 由它出、原样挂进 ``alignment``；没有（02 模型收敛没有根因、
    这一步坏了、事后重建）就退回类别四档（:func:`services.decision.alignment.align_root_causes`）。

    ``case_evidence`` 是 04 案例参考的产出（只有决策时才有），原样挂进对象、逐动作按 ``key`` 切给
    ``actions[].case_basis``；本模块不查案例库、不重算它。

    ``prior_rounds`` 是多轮决策那一块（``prior_round.PriorRounds.to_dict`` 的产出），只有决策时才有，
    原样落进对象；本模块不 import ``prior_round`` 的类型，也不在这里重算它。

    ``cause_convergence`` 是 02 模型收敛的结果（每条根因带置信度），同样只有决策时才有；
    收敛成功就用它出 ``causes``（结论按 ``confidence_threshold`` 分主因 / 次因 / 低置信），
    失败或没传就退回确定性解析（无置信度）。

    ``candidates`` / ``gate`` / ``review`` / ``chain`` 是**只有决策时才有**的四样产出
    （04 候选集、08 决策条件评估、06 整单复核、决策链的结论），由 ``DecisionService`` 传进来；
    事后从 DB 行重建时不传，对象上分别是 ``None``、未评估、按行上的旧注记读（没有就是
    未复核）、未评估 —— 如实说「这一份不是决策时产出的」，不在这里补算。

    ``round_rows`` 必须是**同一轮**的决策行（调用方用
    ``repository.latest_round_rows`` 或按 ``retry_times`` 筛好再传）。本模块不 import
    ``services.orders``，也就不该在这里重写一遍取轮次的口径 —— 那正是"多一个消费者
    就多一套推导"的老毛病。行与行的 ``retry_times`` 不一致时取最大值并记一条 warning。

    这个函数**不做任何新判断**：每一处结论都来自现有的单一来源函数（见模块文档那张表），
    所以"对象字段 == 现有各处推导"是构造上成立的，不是靠用例去追平的。
    """
    order = order if isinstance(order, dict) else {}
    icos_rows = [item for item in (icos_rows or []) if isinstance(item, dict)]
    rows = [item for item in (round_rows or []) if isinstance(item, dict)]
    warnings: List[str] = []

    # ---- 轮次 ----
    retries = {int(item.get("retry_times") or 0) for item in rows}
    if len(retries) > 1:
        warnings.append(
            f"传入的决策行跨了 {len(retries)} 轮（retry_times={sorted(retries)}），"
            "已按最大轮次记录；调用方应当先筛轮次再进来"
        )
    retry_times = max(retries) if retries else 0

    # ---- 02 根因收敛：六维判定全有用六维，否则用 wireless_order_info 的 conclusion + smart_conclusion ----
    convergence = converge_order(order)
    warnings.extend(convergence.warnings)

    # ---- 05 根因对齐：模型判的对应关系优先，没有就退回类别四档 ----
    if cause_alignment is not None and cause_alignment.usable:
        associations = cause_alignment.associations()
        alignment_gaps = cause_alignment.gaps()
    else:
        category_alignment = align_root_causes(convergence, icos_rows)
        associations, alignment_gaps = category_alignment.associations, category_alignment.gaps

    # ---- 动作的根因锚点：仍走初案对齐（plan_key），等 05 根因对齐接管 ----
    # 这三行**继续吃 root_cause 的输出**。把上面新收敛出的 causes 喂进 _cause_ref_index
    # 是另一条路：refs 的文本是用初案标签拼的（``#1 覆盖 / 过覆盖``），收敛标签是
    # ``#1 邻区·…``，by_ref 查不到 → 每个 CauseRef **静默退化成 rank=0, cause=""**。
    # 排名只取决于初案，不必传本轮动作的下场（见 root_cause_groups 的文档）。
    ref_groups, _unmatched = root_cause_groups(icos_rows)
    refs = root_cause_refs(icos_rows, ref_groups)
    cause_index = _cause_ref_index(ref_groups, refs)

    # ---- 08 逐动作裁决 ----
    plans_by_key: Dict[str, Dict[str, Any]] = {}
    for plan in icos_rows:
        if key := plan_key(plan.get("execution_id"), plan.get("parachinname")):
            plans_by_key.setdefault(key, plan)

    # 06 整单复核的逐行注记：决策时由同步复核的结果切出来，存量轮读行上那一列。
    review_notes = [
        review.row_slice(row) if review is not None else _loads(row.get("order_review_json"))
        for row in rows
    ]

    actions: List[ActionVerdict] = []
    for row, note in zip(rows, review_notes):
        key = plan_key(row.get("execution_id"), row.get("tool"))
        actions.append(
            build_action_verdict(
                row,
                plan=plans_by_key.get(key),
                cause_ref=cause_index.get(key),
                association=associations.get(key, Association.PENDING),
                review_note=note,
            )
        )
    if case_evidence is not None:
        actions = [replace(item, case_basis=case_evidence.basis(item.key)) for item in actions]
    diverged = [item.key for item in actions if item.need_call_diverges]
    if diverged:
        warnings.append(
            f"{len(diverged)} 个动作的推送 need_call 与准入态不一致"
            f"（need_call_parameter_platform 列为空或非法）：{diverged[:5]}"
        )
    stale = [item.key for item in actions if item.plan_snapshot_diverges]
    if stale:
        warnings.append(
            f"{len(stale)} 个动作的初案 b_para 与落库的 org_b_para 快照对不上 —— "
            f"以初案为基准的那张表会和裁决表给出相反的「改没改」：{stale[:5]}"
        )

    # ---- 08 整单结论：逐字沿用 order_dispatch_verdict ----
    counts = verdict_stats(verdict_entries(rows, icos_rows))
    dispatch = order_dispatch_verdict(counts)
    verdict = OrderVerdict(
        word=_text(dispatch.get("verdict")),
        statement=_text(dispatch.get("statement")),
        row_count=int(counts.get("row_count") or 0),
        admitted_count=int(counts.get("admitted_count") or 0),
        unchecked_count=int(counts.get("unchecked_count") or 0),
        rejected_count=int(counts.get("rejected_count") or 0),
        changed_count=int(counts.get("changed_count") or 0),
        unchanged_count=int(counts.get("unchanged_count") or 0),
        rejected_reasons=dict(counts.get("rejected_reasons") or {}),
    )

    # ---- 06 一致性：决策时来自同步复核，存量轮来自行上的旧注记 ----
    reviews = [note for note in review_notes if note]
    if reviews:
        # 冲突在每个涉事行上都存了一份，按成员集合去重；**phase 逐行收集不取代表行**
        # （row_slice 的 phase 是逐行的，见 ConsistencyReport.review_phases）。
        merged: Dict[Tuple[str, ...], Conflict] = {}
        phases: List[str] = []
        for note in reviews:
            for conflict in _parse_conflicts(note.get("conflicts")):
                merged.setdefault(conflict.members, conflict)
            if (phase := _text(note.get("phase"))) and phase not in phases:
                phases.append(phase)
        # 整单部分（mode 与各项计数）每行都带同一份，取第一份即可 —— 这一份**是**整单的。
        order_part = reviews[0].get("order")
        order_part = order_part if isinstance(order_part, dict) else {}
        consistency = ConsistencyReport(
            reviewed=True,
            mode=_text(reviews[0].get("mode")),
            review_phases=tuple(sorted(phases)),
            conflicts=tuple(merged.values()),
            reviewed_action_count=int(order_part.get("reviewed_action_count") or 0),
            order_conflict_count=int(order_part.get("conflict_count") or 0),
            relevance_counts=dict(order_part.get("relevance_counts") or {}),
            evidence_counts=dict(order_part.get("evidence_counts") or {}),
            # 告警、失败原因与复核时刻是整单的，每行都带同一份，取第一份。
            warnings=tuple(
                _text(item) for item in (reviews[0].get("warnings") or []) if _text(item)
            ) if isinstance(reviews[0].get("warnings"), list) else (),
            error=_text(reviews[0].get("error")),
            reviewed_at=_text(reviews[0].get("reviewed_at")),
        )
        if consistency.count_diverges:
            warnings.append(
                f"整单复核自报 {consistency.order_conflict_count} 个冲突，"
                f"逐行注记去重后只有 {consistency.conflict_count} 个 —— 有行的注记缺了或多了"
            )
    else:
        consistency = ConsistencyReport(reviewed=False)

    # ---- 07 风险：只填确定性事实，分级留给 P2-2c ----
    with_basis = sum(1 for item in actions if item.step is not None)
    rules = [item.rule_row for item in actions if item.rule_row is not None]
    risk = RiskAssessment(
        row_count=len(actions),
        with_basis_count=with_basis,
        no_basis_count=len(actions) - with_basis,
        tight_margin_count=sum(1 for item in actions if item.step and item.step.tight_margin),
        no_rule_count=sum(1 for item in actions if not item.has_rule),
        no_hard_constraint_count=sum(1 for rule in rules if not rule.hard_constraint_usable),
        disabled_rule_count=sum(1 for rule in rules if rule.rule_disabled),
        echo_diverged_count=sum(1 for rule in rules if rule.echo_diverges),
        graded_count=sum(1 for rule in rules if rule.graded),
    )
    if disabled := [item.key for item in actions if item.rule_row and item.rule_row.rule_disabled]:
        warnings.append(
            f"{len(disabled)} 个动作命中的是 is_use='否' 的停用规则（匹配器不读这一列）：{disabled[:5]}"
        )
    if echoed := [item.key for item in actions if item.rule_row and item.rule_row.echo_diverges]:
        warnings.append(
            f"{len(echoed)} 个动作的模型回抄规则行与代码事实在 rule_scope/para 上不一致，"
            f"而数值后验读的是回抄的那份：{echoed[:5]}"
        )

    issues = _fact_issues(order, icos_rows)
    _plan_rows, plan_stats = icos_plan_facts(icos_rows)
    facts = MultiSourceFacts(
        taskno=_text(order.get("taskno")),
        taskid=_text(order.get("taskid")),
        order={key: order.get(key) for key in _ORDER_FACT_KEYS if key in order},
        plans=tuple(
            {key: plan.get(key) for key in _PLAN_FACT_KEYS if key in plan} for plan in icos_rows
        ),
        sources=_source_statuses(
            order, icos_rows, graded=risk.graded, conclusion_shape=convergence.shape, cases=case_evidence,
            kpi_data=kpi_data,
        ),
        summary={name: _text(order.get(name)) for name in TRIGGER_FIELDS},
        plan_stats=dict(plan_stats),
        issues=issues,
        kpi_data=dict(kpi_data) if kpi_data is not None else None,
    )

    # ---- 02 根因收敛：模型收敛（带置信度）优先，失败退回确定性解析 ----
    if cause_convergence is not None and cause_convergence.converged:
        causes = _build_model_causes(cause_convergence, confidence_threshold)
        if cause_alignment is not None and cause_alignment.usable:
            causes = _aligned_causes(causes, cause_alignment, actions)
    else:
        causes = _build_causes(convergence)
        if cause_convergence is not None and cause_convergence.status == ConvergenceStatus.FAILED:
            warnings.append(
                "02 根因收敛（模型）失败，causes 退回"
                + ("六维逐维兜底（每维一条、不排序）" if convergence.source == SOURCE_DIMENSIONS else "确定性解析")
                + f"、无置信度：{cause_convergence.error}"
            )
    cause_convergence_note = (
        {
            "status": cause_convergence.status,
            "threshold": confidence_threshold,
            "confident_count": len(cause_convergence.confident(confidence_threshold)),
            "reasoning": cause_convergence.reasoning,
            "error": cause_convergence.error,
            "source": cause_convergence.source,
        }
        if cause_convergence is not None
        else None
    )

    return OrderDecision(
        schema=DECISION_SCHEMA_VERSION,
        taskno=_text(order.get("taskno")),
        taskid=_text(order.get("taskid")),
        retry_times=retry_times,
        facts=facts,
        prior_rounds=dict(prior_rounds) if prior_rounds is not None else None,
        causes=causes,
        cause_convergence=cause_convergence_note,
        objective=_build_objective(order, rows, issues),
        candidates=candidates,
        cause_gaps=tuple(
            CauseGap(kind=gap.kind, cause=gap.cause, detail=gap.detail, is_primary=gap.is_primary)
            for gap in alignment_gaps
        ),
        consistency=consistency,
        risk=risk,
        actions=tuple(actions),
        # 决策时由 DecisionService 传入 08 的 observe 评估；事后重建恒为未评估。
        gate=gate if gate is not None else GateResult(evaluated=False),
        # P4：决策链裁决的轮次，它的调优 / 剔除 / 回环就是这一单的；合规链时期的老轮次与回退轮为空。
        iterations=chain.iterations if chain is not None and chain.enforced else (),
        verdict=verdict,
        # 决策链的结论：决策时由 DecisionService 算好传入；事后重建恒为未评估（重建不重跑决策链）。
        chain=chain if chain is not None else ChainVerdict(),
        warnings=tuple(warnings),
        cases=case_evidence,
        alignment=cause_alignment.to_dict() if cause_alignment is not None else None,
    )


__all__ = [
    "ADMITTED_STATES",
    "ASSOCIATION_VOCAB",
    "DECISION_SCHEMA_VERSION",
    "MODEL_CAUSE_BASES",
    "TRIGGER_FIELDS",
    "FactIssue",
    "FactIssueKind",
    "ORDER_VERDICT_VOCAB",
    "RISK_UNGRADED",
    "ActionVerdict",
    "Admission",
    "Association",
    "Cause",
    "CauseBasis",
    "CauseGap",
    "CauseRef",
    "ChainNote",
    "Conflict",
    "ConsistencyReport",
    "GateCondition",
    "GateResult",
    "IterationTrace",
    "MultiSourceFacts",
    "Objective",
    "OrderDecision",
    "OrderVerdict",
    "Relevance",
    "RiskAssessment",
    "RuleProvenance",
    "RuleRow",
    "CHAIN_MODE_ENFORCE",
    "ChainAction",
    "ChainVerdict",
    "SourceState",
    "SourceStatus",
    "StepBasis",
    "TraceStage",
    "build_action_verdict",
    "build_order_decision",
]
