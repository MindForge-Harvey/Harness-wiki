"""多轮决策：前几轮的短评估事实 —— 重推理那一轮决策的输入一源。

短评估判「恶化」之后，工单回到 ``ReReasoning`` 再决策一轮。2026-09-25 之前这一轮对前面
一无所知：初案还是那一批，``f_para`` 还是第一轮之前的现网值，于是算出同一个 ``b_para``
再推一遍 —— 第一轮的值早已生效，现网毫无变化，只是多等一个评估周期，第二次评估照样
恶化、转人工。「多轮决策」实际上是「多等一轮再转人工」。

本模块把**前几轮**摊成一份事实（:class:`PriorRounds`），落进裁决对象的 ``prior_rounds``：

* 每轮评估的结论与指标（主指标、整体恶化程度、r1~r15 逐项的前后值与变好 / 变差）；
* 每轮实际下发了哪些参数、执行回执怎样（:class:`ExecutedAction`）；
* 由此汇成的**逐参数调整历史**（:meth:`PriorRounds.histories`）：原值、现网值、试过哪些值、
  第一次动它时依据的规则行 —— 本轮这个参数怎么调（缩步长 / 反向 / 回退）由
  :mod:`services.decision.multi_round` 按它算。

「动过」的口径
--------------
* **执行回执缺失按已执行算**：准入了、推出去了、回执没回 —— 不知道改没改，按改了处理。
  只有回执明确「失败」的才不算动过（现网值也不跟着变）。
* **没挂上评估结论的轮次按恶化算**：能走到重推理，前面每一轮都必然被判了恶化；挂不上
  （``short_result_id`` 没回写）是关联缺失，不是「评估通过」。明确「改善 / 通过」的轮次不算。
* 参数身份按参数名对齐（:func:`parameter_key`，一张工单是一个小区）。

另外两份口径也住在这里，因为入站契约、状态机、决策与展示层都要用（本模块是纯叶子，
只 import 标准库，谁都能 import 它）：

* **短评估结论词表**（:data:`SHORT_ASSESS_RESULT_VOCAB`）：词表外的取值入站即 400，
  状态机也**绝不把词表外的取值默认判成功**（改造前除「恶化」外一律 ``Succeed``）；
* **指标方向**（:data:`LOWER_IS_BETTER_TOKENS`）与指标名配对（:func:`metric_names`）：
  前者与前端 ``shortEvalMetrics.ts::metricDirection`` 逐项相同（``tests/test_regressions.py`` 钉住）。

纯函数：不碰库、不读配置、不调模型。取数由 ``DecisionService`` 做。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _number(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(_text(value))
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> Optional[int]:
    try:
        return int(_text(value))
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# 短评估结论词表
# --------------------------------------------------------------------------- #
class ShortAssessVerdict:
    """短评估结论归到的三类。"""

    PASSED = "passed"
    DETERIORATED = "deteriorated"
    #: ICOS 取不到评估数据（多为数据融合层没数）。没有数据就不能判闭环 —— 转人工。
    MISSING = "missing"


#: ICOS ``short_assess_result`` 的封闭词表 → 归类。多指标评估回「改善 / 恶化」，
#: 单指标评估回「通过 / 不通过」（存量还见过「未通过」），库表注释另有「缺失」。
SHORT_ASSESS_RESULT_VOCAB: Dict[str, str] = {
    "改善": ShortAssessVerdict.PASSED,
    "通过": ShortAssessVerdict.PASSED,
    "恶化": ShortAssessVerdict.DETERIORATED,
    "不通过": ShortAssessVerdict.DETERIORATED,
    "未通过": ShortAssessVerdict.DETERIORATED,
    "缺失": ShortAssessVerdict.MISSING,
}


def classify_short_assess(value: Any) -> Optional[str]:
    """``short_assess_result`` 原文 → :class:`ShortAssessVerdict`；词表外（含空）返回 ``None``。"""
    return SHORT_ASSESS_RESULT_VOCAB.get(_text(value))


# --------------------------------------------------------------------------- #
# 执行回执
# --------------------------------------------------------------------------- #
class ExecState:
    EXECUTED = "executed"
    FAILED = "failed"
    #: 准入了、推出去了，回执没回（或是说不清成败的自由文本）。
    UNKNOWN = "unknown"


EXEC_STATE_LABELS: Dict[str, str] = {
    ExecState.EXECUTED: "执行成功",
    ExecState.FAILED: "执行失败",
    ExecState.UNKNOWN: "执行回执缺失",
}

#: ICOS 回执措辞现网有「成功」「执行成功」两种；失败侧先判（「执行失败」里没有「成功」，
#: 但自由文本里两种词同时出现时按失败算，与展示层同一顺序）。
EXEC_FEEDBACK_FAILURE_TOKENS: Tuple[str, ...] = ("失败", "异常", "错误")
EXEC_FEEDBACK_SUCCESS_TOKENS: Tuple[str, ...] = ("成功",)


def exec_state(exec_feedback: Any) -> str:
    text = _text(exec_feedback)
    if any(token in text for token in EXEC_FEEDBACK_FAILURE_TOKENS):
        return ExecState.FAILED
    if any(token in text for token in EXEC_FEEDBACK_SUCCESS_TOKENS):
        return ExecState.EXECUTED
    return ExecState.UNKNOWN


# --------------------------------------------------------------------------- #
# 指标：名字、方向、变好变差
# --------------------------------------------------------------------------- #
#: 「越低越好」的指标名特征词。与前端 ``shortEvalMetrics.ts::metricDirection`` 的词表
#: 逐项相同，两处必须同源 —— 同一个指标在后端归 lower、前端归 higher，图表的上下半区
#: 就会对不上。末三个是现网 4G 的「问题小区数」口径（接通低小区 / 掉线高小区 /
#: 宏站弱覆盖小区）：数的是坏小区，越少越好，名字里却没有前面任何一个词。
LOWER_IS_BETTER_TOKENS: Tuple[str, ...] = (
    "掉线", "掉话", "时延", "丢包", "失败", "差", "恶化", "低速率用户采样占比",
    "低小区", "高小区", "弱覆盖",
)


class Direction:
    LOWER = "lower"
    HIGHER = "higher"


def metric_direction(name: Any) -> str:
    text = _text(name)
    return Direction.LOWER if any(token in text for token in LOWER_IS_BETTER_TOKENS) else Direction.HIGHER


#: 指标代号：``r1`` … ``r15``，容忍 ``R01`` / ``1`` 这类写法。
METRIC_MARK_PATTERN = re.compile(r"^r?0*(1[0-5]|[1-9])$", re.IGNORECASE)
#: 现网这几对列都是逗号分隔，个别来源用中文逗号或分号。
METRIC_LIST_SEPARATORS = re.compile(r"[,，;；|\n]+")


def split_metric_list(value: Any) -> List[str]:
    text = _text(value)
    if not text:
        return []
    return [item.strip() for item in METRIC_LIST_SEPARATORS.split(text) if item.strip()]


def normalize_metric_mark(value: str) -> Optional[str]:
    match = METRIC_MARK_PATTERN.match(value.strip().lower())
    return f"r{int(match.group(1))}" if match else None


def metric_names(row: Mapping[str, Any]) -> Dict[str, str]:
    """短评估行 → 「指标代号 → 指标名」。

    ``index_mark`` / ``index_name`` 和 ``much_mark`` / ``much_index_list`` 都是**逗号分隔、
    按位一一对应**的（见 sql/init_schema.sql 的列注释）。``much_*`` 后配、覆盖前者 ——
    与前端 ``shortEvalMetrics.ts::mapRawShortEvalMetrics`` 同序，两处覆盖顺序必须一致。
    """
    names: Dict[str, str] = {}
    for mark_key, name_key in (("index_mark", "index_name"), ("much_mark", "much_index_list")):
        marks = [normalize_metric_mark(item) for item in split_metric_list(row.get(mark_key))]
        labels = split_metric_list(row.get(name_key))
        for mark, label in zip(marks, labels):
            if mark and label:
                names[mark] = label
    return names


class Trend:
    BETTER = "better"
    WORSE = "worse"
    FLAT = "flat"
    #: 前后值缺一个。
    UNKNOWN = "unknown"


TREND_LABELS: Dict[str, str] = {
    Trend.BETTER: "变好",
    Trend.WORSE: "变差",
    Trend.FLAT: "持平",
    Trend.UNKNOWN: "缺数",
}


def metric_trend(before: Optional[float], after: Optional[float], direction: str) -> str:
    if before is None or after is None:
        return Trend.UNKNOWN
    if after == before:
        return Trend.FLAT
    went_down = after < before
    better = went_down if direction == Direction.LOWER else not went_down
    return Trend.BETTER if better else Trend.WORSE


@dataclass(frozen=True)
class MetricChange:
    name: str
    #: ``r1`` … ``r15``；主指标与整体恶化程度为空。
    mark: str
    before: Optional[float]
    after: Optional[float]
    direction: str
    trend: str

    @classmethod
    def of(cls, name: str, before: Any, after: Any, *, mark: str = "", direction: str = "") -> "MetricChange":
        before_value, after_value = _number(before), _number(after)
        direction = direction or metric_direction(name)
        return cls(
            name=name,
            mark=mark,
            before=before_value,
            after=after_value,
            direction=direction,
            trend=metric_trend(before_value, after_value, direction),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "mark": self.mark,
            "before": self.before,
            "after": self.after,
            "direction": self.direction,
            "trend": self.trend,
            "trend_label": TREND_LABELS[self.trend],
        }


# --------------------------------------------------------------------------- #
# 一轮
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ExecutedAction:
    """某一轮**准入并推出去**的一个参数动作。未准入的不在这里 —— 它们从没被执行过。"""

    #: ``agent_decision_id``
    key: str
    parachinname: str
    execution_id: str
    #: 那一轮下发前的现网值（``f_para``）。
    from_value: str
    #: 那一轮下发的值（``b_para``）—— 执行成功的话就是该参数此刻的现网值。
    to_value: str
    exec_feedback: str
    state: str
    #: 这一行下发时依据的规则行（``plan_table.rule_basis`` 的 ``matched_rule``，由取数方注入）。
    #: 空 = 规则库无匹配。只供多轮决策算缩步长 / 反向用，不进 :meth:`to_dict`（落库的规则在决策行里）。
    rule: Mapping[str, Any] = field(default_factory=dict, compare=False)

    @property
    def touched(self) -> bool:
        """这个参数算不算「动过」：回执明确失败才不算。"""
        return self.state != ExecState.FAILED

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "parachinname": self.parachinname,
            "execution_id": self.execution_id,
            "from_value": self.from_value,
            "to_value": self.to_value,
            "exec_feedback": self.exec_feedback,
            "state": self.state,
            "state_label": EXEC_STATE_LABELS[self.state],
        }


@dataclass(frozen=True)
class PriorRound:
    """前面的某一轮：下发了什么、评估怎么说。"""

    #: ``agent_execution_plan.retry_times``（0 起）。
    retry_times: int
    #: ``short_eval_result.id``；``None`` = 这一轮没挂上评估结论。
    short_eval_id: Optional[int]
    #: ``short_assess_result`` 原文。
    result: str
    #: :class:`ShortAssessVerdict`；``None`` = 没挂上评估结论或词表外。
    verdict: Optional[str]
    assess_count: Optional[int]
    assess_time: str
    #: 主劣化指标（``task_main_type`` + ``main_type_f/h``）；评估里没带就是 ``None``。
    main: Optional[MetricChange]
    #: 整体恶化程度（``fmuch`` → ``hmuch``，越低越好）；没带就是 ``None``。
    overall: Optional[MetricChange]
    #: 整体恶化比例 ``(K0-K1)/K1``；解析不了是 ``None``。
    much_result: Optional[float]
    metrics: Tuple[MetricChange, ...]
    actions: Tuple[ExecutedAction, ...]

    @property
    def round_no(self) -> int:
        """界面口径的轮次（1 起）。"""
        return self.retry_times + 1

    @property
    def passed(self) -> bool:
        return self.verdict == ShortAssessVerdict.PASSED

    @property
    def worsened(self) -> Tuple[MetricChange, ...]:
        """这一轮变差的指标（主指标、整体恶化程度、r1~r15 依次）。"""
        pool = [item for item in (self.main, self.overall) if item is not None] + list(self.metrics)
        return tuple(item for item in pool if item.trend == Trend.WORSE)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "retry_times": self.retry_times,
            "round_no": self.round_no,
            "short_eval_id": self.short_eval_id,
            "result": self.result,
            "verdict": self.verdict,
            "assess_count": self.assess_count,
            "assess_time": self.assess_time,
            "main": self.main.to_dict() if self.main is not None else None,
            "overall": self.overall.to_dict() if self.overall is not None else None,
            "much_result": self.much_result,
            "metrics": [item.to_dict() for item in self.metrics],
            "worsened": [item.name for item in self.worsened],
            "actions": [item.to_dict() for item in self.actions],
        }


def parameter_key(name: Any) -> str:
    """多轮决策按参数名对齐（一张工单是一个小区，参数名就是参数的身份）。"""
    return _text(name)


# --------------------------------------------------------------------------- #
# 多轮决策动作词表（2026-09-25 业务拍板）
# --------------------------------------------------------------------------- #
class MultiRoundAction:
    """短评估没通过之后，下一轮对一个动过的参数做什么。阶梯与算法见 :mod:`services.decision.multi_round`。"""

    #: 第 2 轮：同方向、步长减半（从原值起算）。
    SHRINK = "shrink"
    #: 第 3 轮：同参数反向一步（从原值起算）。
    REVERSE = "reverse"
    #: 回退到原值：规则库限定了方向 / 没有硬域可校验 / 非数值参数时代替反向；末轮仍恶化、转人工前也回退。
    ROLLBACK = "rollback"
    #: 阶梯走完了，本轮不再调这个参数。
    NONE = "none"


#: 界面与决策链原因用的短语。合规链时期老行的 phase 短原因（``plan_table``）与决策链的
#: ``ChainReason`` 都取这一份 —— 谁裁决都是同一个说法。
MULTI_ROUND_ACTION_LABELS: Dict[str, str] = {
    MultiRoundAction.SHRINK: "多轮决策缩步长",
    MultiRoundAction.REVERSE: "多轮决策反向",
    MultiRoundAction.ROLLBACK: "多轮决策回退",
}

#: 2026-10-03 前的旧字面（那时叫「外环」）。新行不再产出，库里存量行的 ``new_chain.reason`` 还带着 ——
#: 按原因认「这是一条多轮决策调整」的读侧要把它们一并认上。
LEGACY_MULTI_ROUND_ACTION_LABELS: Dict[str, str] = {
    MultiRoundAction.SHRINK: "外环缩步长",
    MultiRoundAction.REVERSE: "外环反向",
    MultiRoundAction.ROLLBACK: "外环回退",
}

#: 改名前代码拼出、存进库里的展示文字 → 现在的说法：三档原因词，加上整单判定句里多轮决策那半句
#: （``action_facts.order_dispatch_verdict`` 当年的「短评估外环调整」「按外环阶梯取值」）。
_LEGACY_WORDING: Tuple[Tuple[str, str], ...] = (
    *((LEGACY_MULTI_ROUND_ACTION_LABELS[kind], MULTI_ROUND_ACTION_LABELS[kind]) for kind in MULTI_ROUND_ACTION_LABELS),
    ("短评估外环调整", "短评估多轮决策调整"),
    ("按外环阶梯取值", "按多轮决策阶梯取值"),
)


def display_wording(text: Any) -> str:
    """展示用：准入标签 / 原因 / 整单判定句里改名前的旧字面换成现在的说法（「外环缩步长」→「多轮决策缩步长」）。

    只给展示层用 —— 库里的存量行与老裁决对象不迁移，界面上统一成新词。只换代码拼出来的固定说法，
    不做「外环」的泛替换（参数名、模型写的正文里可能有「室外环境」「PUCCH外环功控」）。
    """
    out = "" if text is None else str(text)
    for legacy, current in _LEGACY_WORDING:
        out = out.replace(legacy, current)
    return out


@dataclass(frozen=True)
class ParameterHistory:
    """一个参数在前几轮里被怎么动过（只算没通过的轮次、回执不是失败的动作）。"""

    parachinname: str
    #: 第一次动它之前的现网值（第一次动作的 ``f_para``）—— 缩步长 / 反向 / 回退都从它起算。
    original: str
    #: 第一次调到的值 —— 调整方向与幅度从它来。
    first_target: str
    #: 此刻的现网值：最近一次（回执不是失败的）下发值。
    current: str
    #: 试过的值，按轮次。
    tried: Tuple[str, ...]
    #: 第一次动它的那条初案 —— 多轮决策动作挂回同一条上（ICOS 按 execution_id 对执行记录）。
    execution_id: str
    #: 第一次动它时依据的规则行；空 = 规则库无匹配。
    rule: Mapping[str, Any]
    #: 最近一次动它是第几轮、那一轮评估怎么说。
    last_round_no: int
    last_result: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "parachinname": self.parachinname,
            "original": self.original,
            "first_target": self.first_target,
            "current": self.current,
            "tried": list(self.tried),
            "execution_id": self.execution_id,
            "last_round_no": self.last_round_no,
            "last_result": self.last_result,
        }


@dataclass(frozen=True)
class PriorRounds:
    """本轮之前的全部轮次，按轮次升序。首轮决策时为空。"""

    rounds: Tuple[PriorRound, ...] = ()

    def __bool__(self) -> bool:
        return bool(self.rounds)

    @property
    def latest(self) -> Optional[PriorRound]:
        return self.rounds[-1] if self.rounds else None

    def histories(self) -> Dict[str, ParameterHistory]:
        """``parameter_key → 这个参数的调整历史``。口径见模块文档。"""
        building: Dict[str, Dict[str, Any]] = {}
        for prior in self.rounds:
            if prior.passed:
                continue
            for action in prior.actions:
                key = parameter_key(action.parachinname)
                if not action.touched or not key:
                    continue
                item = building.setdefault(
                    key,
                    {
                        "parachinname": action.parachinname,
                        "original": action.from_value,
                        "first_target": action.to_value,
                        "tried": [],
                        "execution_id": action.execution_id,
                        "rule": dict(action.rule or {}),
                    },
                )
                item["tried"].append(action.to_value)
                item.update(current=action.to_value, last_round_no=prior.round_no, last_result=prior.result)
        return {
            key: ParameterHistory(
                parachinname=item["parachinname"],
                original=item["original"],
                first_target=item["first_target"],
                current=item["current"],
                tried=tuple(item["tried"]),
                execution_id=item["execution_id"],
                rule=item["rule"],
                last_round_no=item["last_round_no"],
                last_result=item["last_result"],
            )
            for key, item in building.items()
        }

    def to_dict(self) -> Dict[str, Any]:
        return {
            "rounds": [item.to_dict() for item in self.rounds],
            "histories": [item.to_dict() for item in self.histories().values()],
        }


def _metric_changes(short_eval: Mapping[str, Any]) -> Tuple[MetricChange, ...]:
    names = metric_names(short_eval)
    out: List[MetricChange] = []
    for index in range(1, 16):
        before, after = short_eval.get(f"r{index}_f"), short_eval.get(f"r{index}_h")
        if _number(before) is None and _number(after) is None:
            continue
        mark = f"r{index}"
        out.append(MetricChange.of(names.get(mark) or f"指标{index}", before, after, mark=mark))
    return tuple(out)


#: 决策行 → 它下发时依据的规则行。由取数方注入（``plan_table.rule_basis``），本模块保持叶子。
RuleOf = Callable[[Mapping[str, Any]], Mapping[str, Any]]


def _executed_actions(rows: Sequence[Mapping[str, Any]], rule_of: Optional[RuleOf]) -> Tuple[ExecutedAction, ...]:
    return tuple(
        ExecutedAction(
            key=_text(row.get("agent_decision_id")),
            parachinname=_text(row.get("tool")),
            execution_id=_text(row.get("execution_id")),
            from_value=_text(row.get("f_para")),
            to_value=_text(row.get("b_para")),
            exec_feedback=_text(row.get("exec_feedback")),
            state=exec_state(row.get("exec_feedback")),
            rule=dict(rule_of(row) or {}) if rule_of is not None else {},
        )
        for row in rows
        if _text(row.get("need_call_parameter_platform")) == "是"
    )


def build_prior_round(
    retry_times: int,
    rows: Sequence[Mapping[str, Any]],
    short_eval: Optional[Mapping[str, Any]],
    *,
    rule_of: Optional[RuleOf] = None,
) -> PriorRound:
    """一轮的决策行 + 挂在这一轮上的短评估行（没有就是 ``None``）→ :class:`PriorRound`。"""
    short_eval = short_eval or {}
    has_main = short_eval.get("main_type_f") is not None or short_eval.get("main_type_h") is not None
    has_overall = short_eval.get("fmuch") is not None or short_eval.get("hmuch") is not None
    return PriorRound(
        retry_times=retry_times,
        short_eval_id=_int(short_eval.get("id")),
        result=_text(short_eval.get("short_assess_result")),
        verdict=classify_short_assess(short_eval.get("short_assess_result")),
        assess_count=_int(short_eval.get("short_assess_count")),
        assess_time=_text(short_eval.get("short_assess_time")),
        main=(
            MetricChange.of(
                _text(short_eval.get("task_main_type")) or "主劣化问题",
                short_eval.get("main_type_f"),
                short_eval.get("main_type_h"),
            )
            if has_main
            else None
        ),
        overall=(
            MetricChange.of(
                "整体恶化程度", short_eval.get("fmuch"), short_eval.get("hmuch"), direction=Direction.LOWER
            )
            if has_overall
            else None
        ),
        much_result=_number(short_eval.get("much_result")),
        metrics=_metric_changes(short_eval),
        actions=_executed_actions(rows, rule_of),
    )


def build_prior_rounds(
    rows: Sequence[Mapping[str, Any]],
    short_evals_by_id: Mapping[int, Mapping[str, Any]],
    *,
    current_retry: int,
    rule_of: Optional[RuleOf] = None,
) -> PriorRounds:
    """这张工单**全部轮次**的决策行 + ``short_eval_result`` 按 id 索引 → 本轮之前的 :class:`PriorRounds`。

    轮次与评估的配对走 ``agent_execution_plan.short_result_id``（落库时回写到当轮全部行上），
    不靠 ``short_assess_count`` 猜 —— 同一轮可能被评估多次，序号与闭环轮次并不一一对应。
    ``rule_of`` 取一行下发时依据的规则行（多轮决策算缩步长 / 反向要用），不传则都当规则库无匹配。
    """
    by_retry: Dict[int, List[Mapping[str, Any]]] = {}
    for row in rows or []:
        if not isinstance(row, Mapping):
            continue
        retry = _int(row.get("retry_times")) or 0
        if retry < current_retry:
            by_retry.setdefault(retry, []).append(row)
    rounds: List[PriorRound] = []
    for retry in sorted(by_retry):
        round_rows = by_retry[retry]
        linked = next(
            (value for value in (_int(row.get("short_result_id")) for row in round_rows) if value is not None),
            None,
        )
        short_eval = short_evals_by_id.get(linked) if linked is not None else None
        rounds.append(build_prior_round(retry, round_rows, short_eval, rule_of=rule_of))
    return PriorRounds(rounds=tuple(rounds))


__all__ = [
    "Direction",
    "EXEC_FEEDBACK_FAILURE_TOKENS",
    "EXEC_FEEDBACK_SUCCESS_TOKENS",
    "EXEC_STATE_LABELS",
    "ExecState",
    "ExecutedAction",
    "LOWER_IS_BETTER_TOKENS",
    "METRIC_LIST_SEPARATORS",
    "METRIC_MARK_PATTERN",
    "MetricChange",
    "LEGACY_MULTI_ROUND_ACTION_LABELS",
    "display_wording",
    "MULTI_ROUND_ACTION_LABELS",
    "MultiRoundAction",
    "ParameterHistory",
    "PriorRound",
    "PriorRounds",
    "RuleOf",
    "SHORT_ASSESS_RESULT_VOCAB",
    "ShortAssessVerdict",
    "TREND_LABELS",
    "Trend",
    "build_prior_round",
    "build_prior_rounds",
    "classify_short_assess",
    "exec_state",
    "metric_direction",
    "metric_names",
    "metric_trend",
    "normalize_metric_mark",
    "parameter_key",
    "split_metric_list",
]
