# -*- coding: utf-8 -*-
"""02 根因收敛 —— **本单根因清单（基准）**，从工单结论两个字段确定性解析出来。

决策步 **02 根因收敛** 定死：唯一依据是 ``wireless_order_info`` 的 ``conclusion`` 与
``smart_conclusion``。本模块就是那条规则的实现，**不用大模型，纯解析**：三段式
``conclusion`` 按下标拆成 (类别, 证据, 建议) 三元组，``smart_conclusion`` 按**前缀对齐**
补上细根因名。同一份输入永远得到同一份输出，没有温度、没有重试、没有回退到模型。

为什么单独一个模块
------------------
:mod:`services.decision.root_cause` 的模块文档开篇也自称「根因收敛」，但它的输入是初案
``icos_initial_plan_record.type1/type2`` —— 按 02 的定义那是**决策步 05 根因对齐**，不是
收敛。两件事并存不冲突（初案 type1/type2 同时是规则库五元组匹配键，决定取值约束与步长，
动不得），但必须分成两个模块、两个出处常量，否则 P3 双跑对比时没人说得清哪份是哪份。
:class:`services.decision.verdict.CauseBasis` 的两个取值就是这条分界的类型化形态。

这个模块今天收敛得动多少
------------------------
**现网 93 张工单里，三段式只有 30 张（32%）。** 另外自由文本 47 张（50.5%）、两字段皆空
16 张（17.2%）。也就是说 **02 根因收敛上线后约 68% 的工单 ``causes`` 是空的** —— 这是本档
今天的能力边界，写在这里是为了没人把它读成「这些工单没病」。空清单的五种含义由
:attr:`ConvergenceResult.shape` 分开，见那里的表。

``data/icos_data/wireless_order_info-工单根因信息.csv`` 那 137 单之所以 137/137 成立，
是因为它本身就是**按三段式预筛出来的切片**（与库的 taskno 交集只有 3 单）。本模块的实测
数字凡标「137」的出自该切片，标「93」的出自现网库，两者不可互相推广。

数据从哪来
----------
``conclusion``（三段：问题排序 / 问题分析 / 优化建议）与 ``smart_conclusion``
（``智能结论：`` + 每行 ``类别：根因``）。**只读这两个字段**：

* 不读 ``type1/type2/type3/suggest/type3_conclusion`` —— 另一套标注，三段式下与 conclusion
  对不上（``type1 == 排序首项`` 只有 87/137，24/137 的 ``type1`` 压根不在排序里）；
* 不读 ``top_causes`` / ``fine_plan`` —— CSV 137/137 + 库 93/93 全空；
* 不读 ``sort_conclusion`` —— 它前缀对齐同样 137/137，白给一层「二级原因」，但 47 张自由
  文本里 45 张为空、剩 2 张带的是牛头不对马嘴的陈数据，不做形态门控就会给自由文本工单
  编出根本不存在的根因。:attr:`services.decision.verdict.Cause.level3` 那个槽位给它留着。

依赖方向
--------
包内**第二个叶子**（另一个是 :mod:`~services.decision.plan_table`）：只 import
:mod:`services.common.text_utils`，包内谁都不 import。

* **不 import** :mod:`~services.decision.verdict` —— P3 的方向是 ``verdict → convergence``，
  反过来会成环。出处常量 :data:`CAUSE_BASIS` 在本模块自己定义，与
  ``verdict.CauseBasis.ORDER_CONCLUSION`` 逐字相等由
  ``tests/test_convergence.py::test_出处串逐字等于_verdict_的常量`` 钉住。
* **不 import** :mod:`~services.decision.plan_table` —— 02 根因收敛的入参不含初案行，
  用不到 ``plan_key``。
* **不 import** :mod:`~services.decision.root_cause` —— 那是决策步 05 根因对齐那一侧的资产。

口径边界
--------
* **只做收敛，不做对齐。** 把动作/初案挂到根因上是**决策步 05 根因对齐**的事，而 05 卡在
  业务侧 P1.5「根因类目 ⟷ 方案组」映射表（未排期）。所以本模块**不提供 ``*_refs``
  这类函数**：``conclusion`` 里没有任何能对齐到具体动作的标识，
  ``root_cause_refs`` 的键 ``plan_key(execution_id, parachinname)`` 里的 ``execution_id``
  只存在于初案行。
* **不编置信度。** ``conclusion`` 侧没有任何数值，:data:`CONFIDENCE_ABSENT` 是如实回答。
* **不认识 Markdown、不认识前端、不写库。** 本模块里没有表头常量、没有 Tailwind 配色、
  没有单元格转义。整个决策包都是这样（P5 已把 ``root_cause`` / ``plan_table`` /
  ``action_facts`` 里原有的那些迁到 ``services/frontend_view/decision_render.py``，
  ``tests/test_decision_package.py`` 钉住）。
* **不从自由文本里猜类别。** 46/47 单能子串命中六词表、1 单（``TA过大``）命中不了，而没有
  任何真值能验证猜得对不对。:data:`ConclusionShape.FREE_TEXT` 那条分支是将来做映射表时
  现成的插入点。

失败一律 fail-open
------------------
**全函数、永不抛，每一次让步都进** :attr:`ConvergenceResult.warnings`。这不是洁癖是算术：
本模块在**每一次** :func:`services.decision.verdict.build_order_decision` 上执行，
``tests/test_verdict.py`` 里 60+ 条用例全部经它，抛一次整个文件连同与根因毫无关系的用例
一起变红；而现网 93 行里 63 行（68%）走不出三元组，这是多数情况不是边角。

warnings 每条以 ``02 根因收敛：`` 开头（**固定机读前缀**，供 P3 双跑对比 grep）。
不抛异常的代价就是每一次让步都必须看得见，否则 fail-open 会退化成 fail-silent。

本模块里的编号一律是「决策步」，不是「展示层节号」
--------------------------------------------------
仓库里两套编号并存且**数字会撞**：决策步 01–08（本模块与
:mod:`~services.decision.verdict` 用这套）与展示层节号 01–11
（``plan_table`` / ``action_facts`` / ``order_review`` / ``solution_generation.yaml``
用那套）。撞得最狠的是 **05**：决策步 05 是「根因对齐」，展示层 05 节是「生成方案」。
所以本模块所有注释一律写全名「02 根因收敛」「05 根因对齐」，不写光秃秃的数字。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from services.common.text_utils import _compact_text, _is_blank, _text

# --------------------------------------------------------------------------- #
# 02 根因收敛：常量与封闭词表
# --------------------------------------------------------------------------- #

#: 一级类别 —— **六个，不是五个**。漏掉「告警」会丢掉问题排序 18 次、智能结论 78 次，
#: 而且是一声不响地丢。现网实测频次（CSV 137 单）：
#: 问题排序/问题分析/优化建议三段**完全相同** {覆盖 187, 邻区 252, 参数 41, 干扰 6,
#: 告警 18, 资源 19}（合计 523）；智能结论 {覆盖 243, 邻区 447, 参数 313, 干扰 22,
#: 告警 78, 资源 79}（合计 1182）。
#:
#: 五个字段上的越界词实测均为 0，**但见** :func:`converge`：越界词是**留下并标记**，
#: 不是丢弃 —— 这张表是观测，不是 ICOS 的承诺。
CAUSE_CATEGORIES: Tuple[str, ...] = ("覆盖", "邻区", "参数", "干扰", "告警", "资源")

#: 「问题排序」段的分隔符（U+2014 U+2014 U+003E）。现网实测只有这一种拼法：整行非汉字
#: 字符普查恰好是 {'—': 772, '>': 386}，772 = 2×386，再无其他候选。
#:
#: **不做多分隔符兼容** —— 兼容等于默许上游改格式不告诉我们。异常分隔符走
#: :attr:`ConclusionParse.warnings` 那条路，而且只影响佐证：问题排序不是数据源（见
#: :func:`parse_conclusion` 的「脊柱」一节）。
CATEGORY_SEPARATOR: str = "——>"

#: 02 根因收敛的出处。**必须逐字等于** ``verdict.CauseBasis.ORDER_CONCLUSION``。
#: 不 import 那个常量是为了不成环（见模块文档「依赖方向」），逐字相等由
#: ``tests/test_convergence.py::test_出处串逐字等于_verdict_的常量`` 钉住。
CAUSE_BASIS: str = "wireless_order_info.conclusion+smart_conclusion"

#: 收敛原文的来源（2026-10-29 六维判定）：``dimensions`` = 原文里有六维判定，``conclusion`` = 只有工单结论两个字段。
#: 两处用法口径不同：确定性收敛（本模块的 :class:`ConvergenceResult`）是**二选一** —— 六维全有逐维一条
#: （:func:`services.decision.cause_dimensions.dimensions_of`）；02 模型收敛（``cause_convergence.CauseConvergence``）
#: schema 17 起是**结论两字段 + 有内容的六维一起送**（:func:`~services.decision.cause_dimensions.dimension_verdicts`
#: 非空即 ``dimensions``；schema 16 那一版只送六维）。
SOURCE_CONCLUSION: str = "conclusion"
SOURCE_DIMENSIONS: str = "dimensions"
CONVERGENCE_SOURCE_VOCAB: Tuple[str, ...] = (SOURCE_CONCLUSION, SOURCE_DIMENSIONS)

#: 六维来源的确定性收敛出处。**必须逐字等于** ``verdict.CauseBasis.ORDER_DIMENSIONS``（用例钉住，理由同 :data:`CAUSE_BASIS`）。
DIMENSIONS_BASIS: str = "wireless_order_info.六维判定"

#: 填给 ``verdict.Cause.confidence_source``。02 根因收敛碰不到初案，``conclusion`` 侧
#: 没有任何数值（换源前 ``Cause.confidence`` 放的是初案 ``final_ratio``，那一列 2026-09-24
#: 起业务定为无意义、不再读）。
#:
#: **绝不能留空串** —— 空串会被读成「忘了填」，而 ``0.0`` 会被前端渲染成「置信度 0」。
CONFIDENCE_ABSENT: str = "conclusion 不提供置信度来源；02 根因收敛不编置信度"

#: 每条 warning 的固定机读前缀，供 P3 双跑对比 grep。
_WARN_PREFIX: str = "02 根因收敛："

#: 类别位允许的最大长度。超过它、含空白、或为空，判为 ``$`` 落错位置的**解析垃圾**而丢弃；
#: 短且无空白的越界词则**保留并标记**（见 :attr:`ConvergedCause.category_known`）。
#: 现网最长类别 2 字。
_MAX_CATEGORY_LEN: int = 12

#: 三个段头。``问题排序`` 的内容与段头**同行**（137/137），另两个段头独占一行、内容在随后
#: 的 tab 行 —— 两种写法都接受，成本三行。
_SECTION_ORDER: str = "问题排序"
_SECTION_ANALYSIS: str = "问题分析"
_SECTION_SUGGESTION: str = "优化建议"
_SECTION_HEADS: Tuple[str, ...] = (_SECTION_ORDER, _SECTION_ANALYSIS, _SECTION_SUGGESTION)

#: ``smart_conclusion`` 正文的首行。现网 first-line values {'智能结论：': 137}。
_SMART_HEAD: str = "智能结论"


class ConclusionShape:
    """``conclusion`` + ``smart_conclusion`` 这**一对**字段的形态 —— 五档。

    形态判别不是锦上添花：现网 93 行里三段式只有 30 行（32%），自由文本 47 行（50.5%）、
    两字段皆空 16 行（17.2%）。不分形态，「解析出 0 条」这一个信号要同时表示
    「这单本来就没有结构化根因」「这单的形态本档读不了」和「契约破了」，下游没法处置。
    """

    #: 三段齐全且至少解出 1 条条目。本模块唯一能真正收敛的形态。现网 30/93。
    SECTIONED = "sectioned"
    #: 自由文本：一句叙述，没有「问题排序」、没有 ``$``、没有类别；``smart_conclusion``
    #: 在这形态下是一句**裸短语**（``过覆盖`` / ``TA过大`` / ``小区存在弱覆盖``），连冒号
    #: 都没有。现网 47/93。**这是正常形态，不是错误** —— causes 为空是如实回答，
    #: 不是解析失败。
    FREE_TEXT = "free_text"
    #: 两字段皆空。现网 16/93，且两字段**同空同有、0 例外**。
    EMPTY = "empty"
    #: 自称三段式（有「问题排序」段头）却一条条目都解不出来，或 ``conclusion`` 空而
    #: ``smart_conclusion`` 有内容 —— **契约破了**。现网 0 例，它是探针。
    MALFORMED = "malformed"
    #: 入口兜底：解析器自己抛了。永远带一条含异常类名的 warning。
    #: 见 :func:`converge_order_causes`。
    FAILED = "failed"
    #: 六维判定（2026-10-29）：六维全有，每维一条、不分首位与伴随。**不由本模块的** :func:`converge`
    #: **产出**（那里只认两个结论字段），由 :func:`services.decision.cause_dimensions.converge_dimensions` 产出。
    DIMENSIONS = "dimensions"


#: 六档形态的封闭词表，供用例对表。
CONCLUSION_SHAPE_VOCAB: Tuple[str, ...] = (
    ConclusionShape.SECTIONED,
    ConclusionShape.FREE_TEXT,
    ConclusionShape.EMPTY,
    ConclusionShape.MALFORMED,
    ConclusionShape.FAILED,
    ConclusionShape.DIMENSIONS,
)


class CausePosition:
    """这条根因在 **ICOS 问题排序**里的位次档 —— 两档，模型不得自拟。

    刻意**不复用** :mod:`services.decision.root_cause` 的 主因 / 次因 / 未进入本轮：
    那三档的判据全部来自本轮决策行（``admitted_count`` / ``skipped_count``），
    **02 根因收敛一条都读不到**。那边的「主因」是本轮真下发了参数的那条（事后量，
    ``test_高档位没准入时主因落到真正下发的那条`` 把它钉死了），这边是 ICOS 排序首位
    （先验基准）—— **同名不同义比不同名危险得多**。

    那套词表原样留给 **05 根因对齐** 与 **08 综合决策及参数编排**。
    """

    #: 问题排序第一条。结论来源的清单里有且仅有一条（清单为空时一条都没有）。
    LEADING = "首位根因"
    #: 其余条目。「伴随」**不含任何处置含义** —— 02 根因收敛阶段任何一档都不该被读成
    #: 「被否定」，那是 **05 根因对齐** 与 **08 综合决策及参数编排** 那一侧才谈得上的事。
    ACCOMPANYING = "伴随根因"
    #: 六维判定的条目（2026-10-29）：六维没有 ICOS 问题排序，排在第一的「覆盖」不是首位根因，
    #: 条目不分首位与伴随。六维来源的清单里**一条首位根因都没有**。
    UNRANKED = "未排序根因"


#: 三档位次的封闭词表，供用例对表。
CAUSE_POSITION_VOCAB: Tuple[str, ...] = (
    CausePosition.LEADING,
    CausePosition.ACCOMPANYING,
    CausePosition.UNRANKED,
)


#: 单条 warning 的长度上限与整单条数上限。
#:
#: warnings 由 ``verdict.build_order_decision`` **原样并进** ``OrderDecision.warnings``，
#: 再进快照与落库。不封顶的话，一条畸形工单（比如 500 个越界词）就能把整单裁决对象
#: 撑成几十 KB —— 越界词那条 warning 本身是逐词一条的。截断要留痕（尾部加省略标记），
#: 否则又成了静默丢弃。
_WARN_MAX_LEN: int = 500
_WARN_MAX_COUNT: int = 20


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
    而本模块对外承诺的是**全函数**，:func:`converge` 也在文档里写了「永不抛」。
    承诺要么兑现要么改写，不能靠「调用方大概不会传那种东西」。
    """
    try:
        return _text(value)
    except Exception:  # noqa: BLE001 - 入参是什么都不该让 02 根因收敛把整单带崩
        return ""


# --------------------------------------------------------------------------- #
# 02 根因收敛：数据类
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class SectionTriple:
    """``conclusion`` 三段按下标拆出来的一条 —— **纯语法层产物**，还没做任何语义判断。"""

    #: 类别原文，**未经词表过滤**（越界词在这里原样带出，由 :func:`converge` 标记）。
    category: str
    #: 「问题分析」``$`` 右侧。现网长度 min/median/max = 13/53/209。
    evidence: str
    #: 「优化建议」``$`` 右侧。**别假设一定以「建议」开头** —— 523 条里 8 条是
    #: 「持续观察」、1 条以「将城」开头。同位次类别对不上时是空串。
    suggestion: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "category": self.category,
            "evidence": self.evidence,
            "suggestion": self.suggestion,
        }


@dataclass(frozen=True)
class ConclusionParse:
    """:func:`parse_conclusion` 的产物。**只拆结构，不认类别词表、不定主因、不判形态。**

    形态是**一对**字段的属性，这里只出一个开关位 :attr:`sectioned`，由 :func:`converge`
    合成。
    """

    #: ``conclusion`` 里出现了「问题排序」段头。形态判别的唯一开关 —— 实测它与
    #: 「``smart_conclusion`` 以『智能结论』开头」**完全同真同假，93/93 零分歧**，
    #: 所以一个判别器管两个字段，另一侧只当探针（见 :func:`converge` 的一致性 warning）。
    sectioned: bool = False
    #: 「问题排序」段按 :data:`CATEGORY_SEPARATOR` 切出的类别序列，已逐项 strip。
    #: **仅用于佐证与告警，不作数据源**（见 :func:`parse_conclusion` 的「脊柱」一节）。
    order_categories: Tuple[str, ...] = ()
    #: 以「问题分析」为脊柱拆出的条目。:attr:`ConvergenceResult.causes` 一对一由它产出。
    triples: Tuple[SectionTriple, ...] = ()
    warnings: Tuple[str, ...] = ()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sectioned": self.sectioned,
            "order_categories": list(self.order_categories),
            "triples": [item.to_dict() for item in self.triples],
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class CauseMention:
    """``smart_conclusion`` 里**前缀对齐之外**的那些条目 —— 有类别有根因名，
    但**没有证据、没有建议**。

    ``smart`` 恒为 ``conclusion`` 的超集（137/137），110 单有尾部；多出的类别按单计
    {资源 48, 告警 43, 邻区 20, 覆盖 17, 干扰 15, 参数 6}。它们**不进主清单**
    （混进去会让「有根因无证据」与「另一处提到」长得一样，且清单会从 523 行涨到 1182 行，
    多出来的全是无证据行），但必须留着：**05 根因对齐判 ``Association.INCONSISTENT``
    时要决定尾部类别算不算数**，那是业务判断，02 根因收敛只负责把两个集合都摆出来、
    不替它决定。
    """

    #: 在 ``smart_conclusion`` 正文里的行号（1 起，已跳过「智能结论：」首行）。
    seq: int
    category: str
    #: 冒号右侧的根因名。全表 83 个不同 (类别, 根因) 对，单张工单内 0 重复。
    cause_name: str

    def to_dict(self) -> Dict[str, Any]:
        return {"seq": self.seq, "category": self.category, "cause_name": self.cause_name}


@dataclass(frozen=True)
class ConvergedCause:
    """02 根因收敛出来的**一条**根因 —— 本单根因清单（基准）的一行。

    一条 = ``问题分析`` 段里的**一个条目**，不是一个类别。127/137 单存在重复类别，而同一
    重复类别下各条的证据两两不同、建议两两不同（碰撞 0 例），
    ``覆盖——>邻区——>邻区——>邻区`` 是 **4 条根因分属 2 个类别**，不是 2 条。
    按类别去重会在 523 条证据里丢掉 239 条，而 ``Cause.evidence`` 是单数字符串，
    没有任何字段装得下多条。

    因此 :attr:`category` 在单张工单内**不唯一**，:attr:`rank` 才是主键。要类别粒度的人
    自己去卷 :attr:`ConvergenceResult.categories` —— 从 284 行还原 523 行不可能。
    """

    #: 1 起，在本单清单里的位次，与 ICOS 问题排序同序。
    #:
    #: **不是任何优先级排名**（conclusion 侧没有任何数值），**也不要拿它当回指下标** —— ``verdict.ActionVerdict.cause.rank``
    #: 是**初案对齐表**的序位，两者是两个互不相干的编号空间。
    #: 条目被判为解析垃圾丢弃时，剩余条目**连续重编号**（并记一条 warning）。
    rank: int
    #: 一级类别。**05 根因对齐那张 P1.5「根因类目 ⟷ 方案组」映射表的键就是它。**
    category: str
    #: 细根因名，取自 ``smart_conclusion`` **前缀对齐**的第 :attr:`rank` 条
    #: （如 ``TA过大`` / ``邻区故障影响切换``）。与初案 ``type2`` 的词汇同源，
    #: 是 05 根因对齐的次级连接键。
    #:
    #: 本单前缀对齐前提一破（任一位类别对不上 / smart 有丢弃行 / 条目不够），
    #: **整单**所有条目的这一位一起留空 ** + 一条 warning**，
    #: **绝不回落到按类别聚合**：单内按类别聚合时 523 条里 418 条（79.9%）候选多于一个。
    #: 例：``(覆盖, 建议处理邻区TA过大问题)`` 共现 **10 个**不同根因名，Top3 是
    #: {TA过大 42, 过覆盖 26, 小区存在高重叠覆盖 9}。聚合从不给错答案，只是 80% 的时候
    #: **给不出**答案 —— 这才是不拿它兜底的真正理由。
    #: 留空是**一个响亮的缺口**，聚合兜底是**一个安静的第二套口径**。
    cause_name: str = ""
    #: 证据原文，**不压缩、不截断**。最长 209 字，截断削掉的正是 05 根因对齐判关联度与
    #: 08 综合决策讲道理的原料。
    evidence: str = ""
    #: ICOS 现成的「这条根因该做什么」。**本档质量最高的一列**：523 条只有 50 个不同文本，
    #: 是个准封闭词表；而「覆盖」类目在 P1.5 映射表里散在 10 个方案组上 —— 类别这把钥匙
    #: 开不了锁的时候，这一列是 05 根因对齐唯一更高分辨率的连接键。
    suggestion: str = ""
    #: 来源有没有排序。结论来源恒为 ``True``（ICOS 问题排序）；六维判定的条目是 ``False``（2026-10-29），
    #: :attr:`leading` / :attr:`position` 据此派生 —— 它是输入事实，不是推得出来的位。
    ranked: bool = True

    @property
    def category_known(self) -> bool:
        """:attr:`category` 落在 :data:`CAUSE_CATEGORIES` 里没有。

        ``False`` = ICOS 出了六词表外的词，条目**仍然保留** —— 丢弃会像按五词表解析那次
        一样静默丢数据（问题排序 18 次 + 智能结论 78 次，一声不响），而静默丢弃是这条链上
        最贵的失败模式。带着越界词流到 05 根因对齐，那正是 ``Association.INCONSISTENT``。

        **派生自** :attr:`category`，与 :attr:`leading` / :attr:`position` 同理：存成字段
        就能构造出 ``category="容量", category_known=True`` 这种会被 :meth:`to_dict`
        原样写出去的谎，而判据 ``category in CAUSE_CATEGORIES`` 本来就在手边。
        """
        return self.category in CAUSE_CATEGORIES

    @property
    def leading(self) -> bool:
        """是不是本单的首位根因。结论来源的清单里有且仅有一条 ``True``（清单为空时一条都没有）；
        六维来源（:attr:`ranked` 为假）一条都没有。

        **派生自** :attr:`rank`，不是独立存储的字段。位次这一个 bit 在本类上只有
        ``rank`` 一个真身：存成字段就会有第二、第三份，而它们能各自被写成不一致的值
        （``rank=3`` 配 ``leading=True`` 在类型上完全合法），于是「首位根因」到底听谁的
        变成一个要靠读代码才答得出的问题。这正是本模块自己的规矩：
        **推得出来的位一律不另存**。不排序的来源（:attr:`ranked` 为假）没有首位根因。
        """
        return self.ranked and self.rank == 1

    @property
    def position(self) -> str:
        """:data:`CAUSE_POSITION_VOCAB` 之一。同样派生自 :attr:`rank` 与 :attr:`ranked`，理由见 :attr:`leading`。"""
        if not self.ranked:
            return CausePosition.UNRANKED
        return CausePosition.LEADING if self.leading else CausePosition.ACCOMPANYING

    @property
    def label(self) -> str:
        """``邻区·邻区故障影响切换``；无细名时只报类别。喂 ``verdict.Cause.cause``。

        分隔符 ``·`` 与 ``root_cause._cause_label`` 的 ``A / B`` **刻意不同形** ——
        同形会让两个编号空间被人按字符串 join，也会让 ``verdict._cause_ref_index`` 的
        字符串回查**碰巧命中**，那是最坏情况：用例全绿而生产上挂错根因。
        可检测 < 结构上不可能。
        """
        if not self.cause_name:
            return self.category
        return f"{self.category}·{self.cause_name}"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "rank": self.rank,
            "category": self.category,
            "category_known": self.category_known,
            "cause_name": self.cause_name,
            "evidence": self.evidence,
            "suggestion": self.suggestion,
            "position": self.position,
            "leading": self.leading,
            "label": self.label,
        }


@dataclass(frozen=True)
class ConvergenceResult:
    """:func:`converge` / :func:`converge_order_causes` 的唯一返回物。

    刻意**不是**「根因收敛」表那样的 ``(candidates, stats, markdown)`` 三元组（那是展示层
    ``decision_render.render_root_cause_convergence`` 的形状）：没有 markdown（不是决策包的活），
    也没有 stats 字典 —— 那个字典正是 ``listed_row_count`` / ``truncated_count`` 这类
    展示层账混进来的入口。计数一律做成 ``@property``：
    键打错字是 ``AttributeError``，不是静默 ``None``。

    **空清单的五种含义**（现网 68% 的工单落在「空但不是没病」那几档上，靠 :attr:`shape`
    分开）::

        shape=EMPTY      causes=()   源里根本没东西                  16/93
        shape=FREE_TEXT  causes=()   源里有东西，本档读不了           47/93
        shape=MALFORMED  causes=()   三段式但结构坏了，看 warnings     0/93（探针）
        shape=FAILED     causes=()   解析器自己抛了，看 warnings       0（探针）
        shape=SECTIONED  causes=()   真的一条根因都没有                0/93

    六维判定（``shape=DIMENSIONS``、``source=dimensions``，2026-10-29）恒为六条、不排序、没有主因，
    见 :func:`services.decision.cause_dimensions.converge_dimensions`。

    空输入返回的是**结构完整的空壳**，不是 ``None``（同 ``root_cause._empty_stats``
    的范式）。
    """

    #: :data:`CONCLUSION_SHAPE_VOCAB` 之一。**空清单不等于这单没病** —— 靠它分辨。
    shape: str = ConclusionShape.EMPTY
    #: 本单根因清单（基准），按 ICOS 问题排序保序。现网每单 1~4 条
    #: （长度直方图 {(4,4,4): 122, (2,2,2): 8, (3,3,3): 6, (1,1,1): 1}）。
    causes: Tuple[ConvergedCause, ...] = ()
    #: 提到了但无证据支撑的条目。见 :class:`CauseMention`。
    mentions: Tuple[CauseMention, ...] = ()
    #: 每条都以 ``02 根因收敛：`` 开头（**固定机读前缀**，供 P3 双跑对比 grep），
    #: 由 ``verdict.build_order_decision`` 原样并进 ``OrderDecision.warnings``。
    warnings: Tuple[str, ...] = ()

    @property
    def source(self) -> str:
        """:data:`CONVERGENCE_SOURCE_VOCAB` 之一（2026-10-29）：形态是 ``DIMENSIONS`` 即六维来源，其余都是结论来源。

        **派生自** :attr:`shape`，不另存 —— 两份各存一份时，``shape=DIMENSIONS`` 忘了传来源，出处就会报成结论来源。
        """
        return SOURCE_DIMENSIONS if self.shape == ConclusionShape.DIMENSIONS else SOURCE_CONCLUSION

    @property
    def basis(self) -> str:
        """收敛依据的出处：结论来源恒为 :data:`CAUSE_BASIS`，六维来源恒为 :data:`DIMENSIONS_BASIS`。

        留成 @property 而不是字段：字段可以被构造成别的值，而 :meth:`to_dict` 会把那个
        **假出处**原样写进落库 JSON。出处只由 :attr:`source` 决定，不是可以被调用方改写的入参。
        """
        return DIMENSIONS_BASIS if self.source == SOURCE_DIMENSIONS else CAUSE_BASIS

    @property
    def primary(self) -> Optional[ConvergedCause]:
        """首位根因。空清单或不排序的来源（六维）时是 ``None`` —— **None 有信息量**，别当成「主因是第 0 条」。"""
        return self.causes[0] if self.causes and self.causes[0].leading else None

    @property
    def primary_category(self) -> str:
        """主因类目 —— **05 根因对齐查 P1.5 映射表的键**。无根因时空串。"""
        primary = self.primary
        return primary.category if primary is not None else ""

    @property
    def categories(self) -> Tuple[str, ...]:
        """去重保序的类别序列。现网 26 种，Top：(覆盖, 邻区) 65 单、(覆盖,) 12 单。"""
        seen: List[str] = []
        for item in self.causes:
            if item.category not in seen:
                seen.append(item.category)
        return tuple(seen)

    @property
    def mentioned_only_categories(self) -> Tuple[str, ...]:
        """只在 :attr:`mentions` 里出现、清单里没有的类别（去重保序）。

        05 根因对齐判「不一致」时才用；02 根因收敛只负责把它摆出来。
        """
        listed = set(self.categories)
        seen: List[str] = []
        for item in self.mentions:
            if item.category not in listed and item.category not in seen:
                seen.append(item.category)
        return tuple(seen)

    @property
    def convergeable(self) -> bool:
        """本单的形态今天收敛得动吗（``shape`` 是 SECTIONED 或 DIMENSIONS）。

        **与 ``bool(causes)`` 不是一回事**：FREE_TEXT 也给空清单，但那不是「没病」。
        """
        return self.shape in (ConclusionShape.SECTIONED, ConclusionShape.DIMENSIONS)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "shape": self.shape,
            "basis": self.basis,
            "convergeable": self.convergeable,
            "primary_category": self.primary_category,
            "categories": list(self.categories),
            "causes": [item.to_dict() for item in self.causes],
            "mentions": [item.to_dict() for item in self.mentions],
            "warnings": list(self.warnings),
        }


# --------------------------------------------------------------------------- #
# 02 根因收敛：conclusion 三段拆解
# --------------------------------------------------------------------------- #
def _split_section_head(line: str) -> Tuple[str, str]:
    """行是段头就返回 ``(段名, 冒号右侧内容)``，不是段头返回 ``("", "")``。

    ``问题排序：<内容>`` 的内容与段头同行（137/137），``问题分析：`` / ``优化建议：``
    的段头独占一行 —— 两种写法都接受。条目行形如 ``类别$证据``，不会有 ``名+冒号``
    的前缀，所以这里不会把条目行误判成段头。
    """
    for name in _SECTION_HEADS:
        if line == name:
            return name, ""
        for colon in ("：", ":"):
            if line.startswith(name + colon):
                return name, line[len(name) + len(colon) :].strip()
    return "", ""


def _split_entry(line: str) -> Tuple[str, str, str]:
    """条目行 ``类别$内容`` → ``(类别, 内容, 出错原因)``。出错时前两位是空串。

    ``maxsplit=1``：现网 ``$`` 恒 1 次/条（直方图 {1: 523}），所以今天 ``split("$")``
    与 ``split("$", 1)`` 等价 —— 但将来多一个 ``$`` 时右侧不该被切碎。真正的风险是
    **零个** ``$``：那会让 ``parts[1]`` 抛 ``IndexError``，是实测唯一会炸的路径。
    """
    parts = line.split("$", 1)
    if len(parts) != 2:
        return "", "", f"条目行没有 $ 分隔符，已跳过：{_compact_text(line, 60)}"
    category = parts[0].strip()
    value = parts[1].strip()
    # 类别位分诊：短且无空白的越界词留着（可能是第 7 个类别词），
    # 长的、含空白的、空的判为 $ 落错位置的解析垃圾 —— 留下去只会把垃圾灌进
    # ``verdict.Cause.cause`` 和 08 综合决策的正文。
    if not category:
        return "", "", f"条目行的类别位是空的，已丢弃该条目：{_compact_text(line, 60)}"
    if len(category) > _MAX_CATEGORY_LEN or any(ch.isspace() for ch in category):
        return "", "", (
            f"条目行的类别位不像类别（长度 {len(category)} 或含空白），"
            f"判为 $ 落错位置的解析垃圾，已丢弃该条目：{_compact_text(line, 60)}"
        )
    return category, value, ""


def parse_conclusion(text: Any) -> ConclusionParse:
    """``conclusion`` 原文 → 三段语法结构。**纯语法，不认类别词表。永不抛。**

    脊柱
    ----
    **「问题分析」是脊柱，另外两段是挂件。** 一条根因 = 一个问题分析条目（类别 + 证据，
    两者由 ``$`` 保证同时存在）；「问题排序」只做**次序佐证**（恒与问题分析同序同类别，
    137/137），**不做数据源**；「优化建议」按**下标 + 同类别守卫**挂上去。

    理由：conclusion 里唯一能保证「既有类别又有实体内容」的就是问题分析条目。把问题排序
    当脊柱，遇到整行无分隔符的单子（``id=172``，1 条目、0 分隔符，**那是正常单**）或分隔符
    哪天换写法，整单直接归零；把优化建议当脊柱，8 条「持续观察」这类无信息建议会变成根因。

    没有等长闸门
    ------------
    **不设「三段等长且逐位同类」这道整段闸门**，改成逐位组装：一段短了只让对应位次的建议
    留空，不让整单清零。137 单 CSV 是**按三段式预筛出来的切片**，拿它当普遍形态去设整段
    闸门，等于把一个没验过的分支设成悬崖。逐位降级在 137 单上与闸门版逐字同结果，
    失败模式却完全不同。

    三个已知陷阱
    ------------
    * 问题排序末位那个**恒存在的尾随** ``\\n``（137/137）—— 不 strip 会得到 ``'邻区\\n'``，
      直接把六词表打穿；
    * 每个条目行开头那个**恒为一个的** ``\\t``（523/523）；
    * 每个条目块首尾**恒各有一个空行**（delta=2，137/137）—— 所以过滤空行是**必须的**，
      不是可选的；而条目块内部**从不夹空行**（0/137），所以过滤不会误删。

    三者由「按 ``\\n`` 切、逐行 ``.strip()``、跳过空行」一招解掉。
    """
    raw = _safe_text(text)
    warnings: List[str] = []
    sectioned = False
    order_chunks: List[str] = []
    analysis: List[Tuple[str, str]] = []
    suggestion: List[Tuple[str, str]] = []
    stray = 0
    section = ""

    def collect(name: str, content: str) -> None:
        if name == _SECTION_ORDER:
            order_chunks.append(content)
            return
        category, value, problem = _split_entry(content)
        if problem:
            warnings.append(_warn(f"{name} 段：{problem}"))
            return
        (analysis if name == _SECTION_ANALYSIS else suggestion).append((category, value))

    for line in (item.strip() for item in raw.split("\n")):
        if not line:
            continue
        name, rest = _split_section_head(line)
        if name:
            section = name
            if name == _SECTION_ORDER:
                sectioned = True
            if rest:
                collect(name, rest)
            continue
        if not section:
            stray += 1
            continue
        collect(section, line)

    # 一个段头都没出现过 = 自由文本形态，那是**正常形态**，由 :func:`converge` 统一报一句
    # 「本档读不了」就够了 —— 在这里再报一遍「N 行游离」纯属噪音。
    # 只有「有段头、却仍有行落在段头之前」才是真的游离。
    if stray and section:
        warnings.append(_warn(f"{stray} 行游离在三个段头之前，已丢弃"))

    order_categories: List[str] = []
    for chunk in order_chunks:
        order_categories.extend(
            part.strip() for part in chunk.split(CATEGORY_SEPARATOR) if part.strip()
        )

    # 逐位组装：建议只在「位次存在且类别相同」时才挂上去。
    # 丢建议好过错配建议 —— 50 个 (类别, 建议) 键里 45 个是歧义的。
    triples: List[SectionTriple] = []
    mismatched: List[int] = []
    for index, (category, evidence) in enumerate(analysis):
        text_suggestion = ""
        if index < len(suggestion) and suggestion[index][0] == category:
            text_suggestion = suggestion[index][1]
        elif index < len(suggestion):
            mismatched.append(index + 1)
        triples.append(
            SectionTriple(category=category, evidence=evidence, suggestion=text_suggestion)
        )

    if mismatched:
        warnings.append(
            _warn(f"优化建议与问题分析在第 {mismatched} 位类别对不上，这些位次的建议已留空")
        )
    if len(analysis) != len(suggestion):
        warnings.append(
            _warn(
                f"三段长度不等（问题排序 {len(order_categories)} / 问题分析 {len(analysis)} / "
                f"优化建议 {len(suggestion)}），已按问题分析逐位组装、缺位留空"
            )
        )
    listed = [item.category for item in triples]
    if sectioned and order_categories and order_categories != listed:
        warnings.append(
            _warn(
                f"问题排序与问题分析对不上（排序 {order_categories} / 分析 {listed}）—— "
                "排序只作佐证不作数据源，清单仍按问题分析出"
            )
        )

    return ConclusionParse(
        sectioned=sectioned,
        order_categories=tuple(order_categories),
        triples=tuple(triples),
        warnings=_cap_warnings(warnings),
    )


# --------------------------------------------------------------------------- #
# 02 根因收敛：smart_conclusion 拆解
# --------------------------------------------------------------------------- #
def parse_smart_conclusion(text: Any) -> Tuple[Tuple[str, str], ...]:
    """``smart_conclusion`` 原文 → ``((类别, 根因名), …)``，保序、保重复、不去重、不聚合。

    首行「智能结论：」跳过；正文每行按**第一个全角** ``：`` 切一刀，两侧都非空才收。
    现网每行恒 1 个全角冒号、0 个半角，根因文本从不含冒号（1182/1182）。

    没有冒号的行丢弃 —— 那是自由文本形态下的**裸短语**（``过覆盖`` / ``TA过大`` /
    ``小区存在弱覆盖``，全表 4 个取值），六词类别表在那里根本不存在。**永不抛。**
    """
    pairs, _dropped = _parse_smart_lines(text)
    return tuple(pairs)


def _parse_smart_lines(text: Any) -> Tuple[List[Tuple[str, str]], List[str]]:
    """``smart_conclusion`` → (收下的 ``(类别, 根因名)``, **丢掉的正文行**)。

    丢掉的行要一起返回，不能只是 ``continue`` 掉：前缀对齐是**按下标**配对的，
    而丢一行就让其后所有位次整体上移一格。只丢不记的话，
    ``分析[i]`` 会安静地配上 ``smart[i+1]`` 的根因名 —— 证据与名字对不上，却一条
    warning 都没有。实测：把一张真工单的某行全角 ``：`` 改成半角（**一个字符**），
    4 条根因里 3 条挂上别人的名字。
    """
    lines = [item.strip() for item in _text(text).split("\n") if item.strip()]
    if lines and lines[0].startswith(_SMART_HEAD):
        lines = lines[1:]
    pairs: List[Tuple[str, str]] = []
    dropped: List[str] = []
    for line in lines:
        category, separator, cause_name = line.partition("：")
        category = category.strip()
        cause_name = cause_name.strip()
        if separator and category and cause_name:
            pairs.append((category, cause_name))
        else:
            dropped.append(line)
    return pairs, dropped


# --------------------------------------------------------------------------- #
# 02 根因收敛：本体
# --------------------------------------------------------------------------- #
def converge(conclusion: Any, smart_conclusion: Any) -> ConvergenceResult:
    """两个字段 → 本单根因清单。**决策步 02 根因收敛的本体，也是本模块的契约面。**

    签名刻意是两个裸值而不是 ``order`` dict：「02 根因收敛的唯一依据是这两个字段」写在
    签名里是事实，写在注释里只是个说法 —— 拿不到 order 就不可能顺手读 ``type1``
    （三段式下它与 conclusion 对不上：``type1 != 排序首项`` 50/137，24/137 根本不在排序里）。
    137 单真数据扫描驱动的也是它。

    前缀对齐
    --------
    ``conclusion`` 的 N 个条目与 ``smart_conclusion`` 的**前 N 条**逐位同类别，
    137/137 + 库内 30/30 零反例。所以每个条目都能拿到自己的根因名，不用模型也不用猜。

    不能配对的是**尾部**：``smart`` 恒为 ``conclusion`` 的超集（137/137），多出的条目没有
    证据也没有建议，进 :attr:`~ConvergenceResult.mentions`，不进主清单。

    守卫是**整单**的，不是逐位的
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    任一位类别对不上 / ``smart`` 有被丢弃的正文行 / 条目数不够 → 判定
    **前缀对齐这个前提在本单已经破了**，整单 ``cause_name`` 一起留空 + 一条 warning，
    **不回落到按类别聚合**（单内按类别聚合 523 条里 418 条候选多于一个）。

    逐位放行是不行的：判据「同位次类别相同」看着严其实很弱 —— 类别只有 6 个取值，
    127/137 单存在重复类别、21/137 单全部条目同一类别。实测在 ``smart`` 开头注入一行，
    523 条里 372 条（71%）挂上别人的名字，其中 83 条所在的 22 张工单一条 warning 都不出。
    **挂错名是安静的谎，留空是响亮的缺口。**

    已知盲区（**不要把这道守卫说成是全面的**）
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    全单同一类别的工单（21/137）上，``smart`` 开头被插入**同类别**条目时，逐位类别序列
    与真值逐字相同、没有丢弃行、长度仍是正常的超集（110/137 本来就更长）——
    **数据里没有任何信号能把它与正常单区分开**，本模块拦不住，会整体错位一格。
    ``tests/test_convergence.py::test_已知盲区_同类别纯插入检测不出来`` 把这个事实钉住了。
    前置条件至今 0 例（137/137 前缀对齐成立）。

    主因
    ----
    ``rank == 1`` 即首位根因。四路互证：排序首项 == 去重后首项 == smart 首项 ==
    sort_conclusion 首项，137/137。首项类别分布 {覆盖 93, 邻区 18, 资源 16, 参数 4,
    告警 4, 干扰 2}。**绝不用工单主表的** ``type1`` **定主因** —— 那会在三段式上错 36%。

    **永不抛**（兜底档 ``FAILED`` 在 :func:`converge_order_causes` 上）。
    """
    conc = _safe_text(conclusion)
    smart = _safe_text(smart_conclusion)
    conc_blank = _is_blank(conc)
    smart_blank = _is_blank(smart)

    parse = parse_conclusion(conc)
    pairs_list, dropped_smart = _parse_smart_lines(smart)
    pairs = tuple(pairs_list)
    warnings: List[str] = list(parse.warnings)

    # ---- 形态合成（总函数，五档里的前四档全可达）----
    if conc_blank and smart_blank:
        shape = ConclusionShape.EMPTY
        warnings.append(
            _warn("conclusion 与 smart_conclusion 两字段皆空，本单收敛不出根因（现网实测 17.2%）")
        )
    elif conc_blank:
        shape = ConclusionShape.MALFORMED
        warnings.append(
            _warn(
                "conclusion 为空而 smart_conclusion 有内容 —— 两字段现网同空同有、0 例外，"
                "这是契约破了；smart 的条目全部只作「提到」记录"
            )
        )
    elif parse.triples:
        # **只要解出了条目就收敛，哪怕「问题排序」段头缺席。**
        # 形态判别的开关是 ``sectioned``（问题排序段头），但拿它当 FREE_TEXT 的充分条件会
        # 在「有问题分析、没问题排序」这种单子上**静默丢掉已经解出来的条目** ——
        # 而静默丢弃是这条链上最贵的失败模式（见 CAUSE_CATEGORIES 那段的五词表事故）。
        # 现网 93/93 没出现过这种单，所以下面那条 warning 是探针。
        shape = ConclusionShape.SECTIONED
        if not parse.sectioned:
            warnings.append(
                _warn(
                    "conclusion 没有「问题排序」段头，却解出了问题分析条目 —— 现网 93/93 没有"
                    "这种形态；条目**照常收敛**（不丢），但次序佐证这一路失效了"
                )
            )
    elif parse.sectioned:
        shape = ConclusionShape.MALFORMED
        warnings.append(
            _warn("conclusion 自称三段式却一条条目都解不出来 —— 结构坏了，本单根因清单为空")
        )
    else:
        shape = ConclusionShape.FREE_TEXT
        warnings.append(
            _warn(
                "conclusion 是自由文本（无「问题排序」段头、无可解析条目），02 根因收敛今天"
                f"读不了这种形态，本单根因清单为空（现网实测 50.5%）：{_compact_text(conc, 80)}"
            )
        )

    # ---- 判别器一致性探针：只记 warning，不改 shape ----
    # 现网 (含「问题排序」, smart 以「智能结论」开头) = {(False,False): 63, (True,True): 30}，
    # 93/93 零分歧。真出现分歧是新闻，必须留痕；但 conclusion 那一侧的三段仍然可解，
    # 没有理由丢 —— 所以不降档。
    if parse.sectioned != smart.startswith(_SMART_HEAD):
        warnings.append(
            _warn(
                f"两个字段的形态判别对不上（conclusion 三段式={parse.sectioned}，"
                f"smart_conclusion 以「{_SMART_HEAD}」开头={smart.startswith(_SMART_HEAD)}）—— "
                "现网 93/93 零分歧，已按 conclusion 一侧判形态"
            )
        )

    if shape != ConclusionShape.SECTIONED:
        # 收敛不出清单时，smart 的条目全部只作「提到」记录（从第 1 条起编号）。
        mentions = tuple(
            CauseMention(seq=index + 1, category=category, cause_name=cause_name)
            for index, (category, cause_name) in enumerate(pairs)
        )
        return ConvergenceResult(shape=shape, mentions=mentions, warnings=_cap_warnings(warnings))

    # ---- 前缀对齐 + **整单**守卫 ----
    #
    # 守卫必须是整单的，不能逐位放行。判据「同位次类别相同」看着挺严，其实很弱：
    # 类别只有 6 个取值，而 127/137 单存在重复类别、21/137 单全部条目同一个类别。
    # 于是 smart 整体移位一格时，守卫在多数位次上照常放行，把**别人的根因名**挂到
    # 本条证据上。实测注入一行综述：523 条里 372 条（71%）挂错名，其中 83 条所在的
    # 22 张工单**一条 warning 都不出**；全单同类别的 id=112 更是四条全错、守卫全盲。
    #
    # 所以只要有任何一位对不上、或 smart 有被丢弃的正文行、或条目数不够，就判定
    # **「前缀对齐这个前提在本单已经破了」**，整单根因名一起留空。
    # 从一条已被证明错位的流里继续按下标取名，比没有名字糟得多：
    # 留空是一个响亮的缺口，挂错名是一个安静的谎。
    total = len(parse.triples)
    mismatched = [
        index + 1
        for index, triple in enumerate(parse.triples)
        if index >= len(pairs) or pairs[index][0] != triple.category
    ]
    # 丢弃的行同样会让下标整体上移，哪怕逐位类别「碰巧」全对。
    aligned = bool(total) and not mismatched and not dropped_smart
    names: List[str] = [pairs[index][1] for index in range(total)] if aligned else [""] * total
    #: 被 causes 消费掉的 pairs 下标。对齐成立时恰好是前 total 个；不成立时一个都不消费
    #: —— 那些条目会原样进 mentions，而不是凭空消失。
    consumed = set(range(total)) if aligned else set()

    if total and not aligned:
        reason = []
        if dropped_smart:
            reason.append(
                f"smart_conclusion 有 {len(dropped_smart)} 行不是「类别：根因」形态"
                f"（首行 {dropped_smart[0][:40]!r}），下标空间已被压缩"
            )
        if mismatched:
            reason.append(f"第 {mismatched} 位与问题分析类别对不上（或条目不够）")
        warnings.append(
            _warn(
                "前缀对齐前提已破（" + "；".join(reason) + "）—— **整单**根因名留空，"
                "不从已错位的流里按下标取名（挂错名是安静的谎），"
                "也不按类别聚合兜底（单内按类别聚合 523 条里 418 条候选多于一个）。"
                f"这 {len(pairs)} 条 smart 条目全部进 mentions，一条都没丢"
            )
        )

    # ---- 组装 ----
    causes: List[ConvergedCause] = []
    unknown: List[str] = []
    for index, triple in enumerate(parse.triples):
        rank = index + 1
        known = triple.category in CAUSE_CATEGORIES
        if not known:
            unknown.append(triple.category)
        causes.append(
            ConvergedCause(
                rank=rank,
                category=triple.category,
                cause_name=names[index],
                evidence=triple.evidence,
                suggestion=triple.suggestion,
                # position / leading 不在这里传 —— 它们派生自 rank，见 ConvergedCause.leading
            )
        )
    for word in unknown:
        warnings.append(
            _warn(
                f"类别「{word}」不在六词表 {list(CAUSE_CATEGORIES)} 里 —— 条目已保留并标记"
                "（丢弃会静默丢数据），带着它流到 05 根因对齐去判不一致"
            )
        )

    # mentions 收的是「**没有被任何 cause 消费掉**的 smart 条目」，不是「下标落在尾部的」。
    #
    # 按下标收尾部时，一旦发生错位，那些没配上位次的条目既拿不到 cause_name、也不进
    # mentions，**从结果里彻底消失**（实测错位后 1319 条里凭空少掉 195 条，零 warning）。
    # 那正是本模块承诺不做的 fail-silent。
    #
    # 改成按消费与否收之后，干净数据上逐字同结果（消费集恰好是前 total 个，137/137），
    # 而「有名 causes 数 + mentions 数 == pairs 数」成为一条**恒真的机读不变量** ——
    # 下面那条守卫就是在看它。seq 仍是条目在 smart 正文里的序号，语义没变。
    mentions = tuple(
        CauseMention(seq=index + 1, category=category, cause_name=cause_name)
        for index, (category, cause_name) in enumerate(pairs)
        if index not in consumed
    )
    named = sum(1 for name in names if name)
    if named + len(mentions) != len(pairs):
        warnings.append(
            _warn(
                f"记账对不上：有名根因 {named} + mentions {len(mentions)} != smart 条目 "
                f"{len(pairs)} —— 有 smart 条目既没配上位次也没进 mentions，这是丢数据，"
                "请把这张工单的两个字段原文留档后报 02 根因收敛的维护者"
            )
        )
    return ConvergenceResult(
        shape=shape,
        causes=tuple(causes),
        mentions=mentions,
        warnings=_cap_warnings(warnings),
    )


def converge_order_causes(order: Dict[str, Any]) -> ConvergenceResult:
    """工单行 → 本单根因清单。两行适配器，只取两个键后转调 :func:`converge`，外加一道兜底。

    **只读** ``conclusion`` **与** ``smart_conclusion``。不读 ``type1/type2/type3/suggest/
    type3_conclusion``（另一套标注，三段式下对不上 36%），不读 ``top_causes``
    （CSV 137/137 + 库 93/93 全空），不读 ``sort_conclusion``（见模块文档「数据从哪来」）。

    唯一一道 ``except Exception``：本函数在**每一次**
    :func:`services.decision.verdict.build_order_decision` 上执行，一个意料之外的入参类型
    就能带崩整单裁决。捕到就返回 ``shape=FAILED`` + 一条带异常类名与消息的 warning
    （它会一路冒到 ``OrderDecision.warnings``）。

    兜底会藏 bug，这一点没法否认 —— 缓解是把**异常类名**写进 warning，并由
    ``tests/test_convergence.py::test_异常一律兜底成_FAILED`` 证明这一档只能靠注入会抛的
    对象触达，正常输入永远走不到。
    """
    try:
        return converge(order.get("conclusion"), order.get("smart_conclusion"))
    except Exception as exc:  # noqa: BLE001 —— 见上：这一道是刻意的整单保护
        return ConvergenceResult(
            shape=ConclusionShape.FAILED,
            warnings=(
                _warn(
                    f"解析器自身抛了 {type(exc).__name__}：{exc} —— 本单根因清单按空处理，"
                    "这不是数据问题，是 convergence 模块的 bug，请查"
                ),
            ),
        )


__all__ = [
    "CATEGORY_SEPARATOR",
    "CAUSE_BASIS",
    "CAUSE_CATEGORIES",
    "CAUSE_POSITION_VOCAB",
    "CONCLUSION_SHAPE_VOCAB",
    "CONFIDENCE_ABSENT",
    "CONVERGENCE_SOURCE_VOCAB",
    "DIMENSIONS_BASIS",
    "SOURCE_CONCLUSION",
    "SOURCE_DIMENSIONS",
    "CauseMention",
    "CausePosition",
    "ConclusionParse",
    "ConclusionShape",
    "ConvergedCause",
    "ConvergenceResult",
    "SectionTriple",
    "converge",
    "converge_order_causes",
    "parse_conclusion",
    "parse_smart_conclusion",
]
