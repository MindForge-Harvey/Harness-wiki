"""决策流水线 —— 把一轮决策写成一串**有编号的步骤**：整体流程一眼可见，每一步跑了什么可追踪。

为什么要有它
------------
决策的步骤原先散在 ``DecisionService.process_order`` 的一百多行里（02 收敛、04 候选集、决策链、
07 / 08 注记、06 复核、裁决对象……），流程图上的 01–08 要从控制流里一行行读出来，某一步失败了
怎么收口（整单转人工 / 只少一份注记）也各写各的。现在：

* **流程就是一张表**：``Pipeline`` 是一串 :class:`Stage`，每一步带流程图上的步骤编号、名字、
  一句话职责与失败口径。读 ``DECISION_PIPELINE``（``services.orders.decision_service``）就是读流程图。
* **过程随结论落库**：每一步跑完记一条 :class:`StageRecord`（跑了没有、耗时、一句摘要），整串落进
  ``OrderDecision.pipeline``（``decision_json.pipeline``）—— 方案「落库的是过程，不只是结论」那条口径。
* **失败口径声明在步骤上**，不散在各处的 try/except 里：见 :class:`OnError`。

本模块只有机制（步骤、执行器、轨迹），不含任何业务步骤；不 import 包内其它模块，谁都能依赖它。
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Generic, List, Optional, Sequence, Tuple, TypeVar, Union

C = TypeVar("C")


class StageStatus:
    """一步的结果。封闭词表。"""

    DONE = "done"
    #: 这一步失败了。注记类的步骤失败后流水线继续（只少一份注记），其余的失败会让整轮收口。
    FAILED = "failed"
    #: 条件不满足、这一轮不需要这一步（例如首轮不走多轮决策）。
    SKIPPED = "skipped"


class OnError:
    """一步失败时怎么办。

    * :data:`RAISE` —— 异常原样上抛（这一轮怎么收口由调用方定）；
    * :data:`ANNOTATE` —— **注记**：失败只记进轨迹、流水线继续。只给不改下场的步骤用 ——
      注记坏了是「少一份注记」，不是「这张单不许下发」；
    * 一个函数 ``exc -> Exception`` —— 把异常翻成调用方认得的业务异常再抛（例如决策链的
      任何一步坏了都翻成「决策链没算成」，整单转人工）。
    """

    RAISE = "raise"
    ANNOTATE = "annotate"


ErrorPolicy = Union[str, Callable[[BaseException], BaseException]]


class PipelineExit(Exception):
    """某一步决定**本轮不再往下走**（例如重推理轮次裁完一个可发的都没有 → 改写回退轮）。

    不是失败：执行器把这一步记成 ``done``（摘要是退出原因）后原样上抛，由调用方接着处理。
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Stage(Generic[C]):
    """流水线的一步。

    ``step`` 是**业务流程图上的步骤编号**（``02`` / ``04`` / ``07`` / ``08`` / ``01·03·08`` …），
    不是执行序号 —— 执行顺序由它在流水线里的位置决定，编号告诉读的人它对应流程图上哪一步。
    流程图之外的环节（多轮决策、落草稿行、写回）用中文短词占位。

    ``run`` 读写上下文，返回一句摘要（进轨迹，给人看）；返回 ``None`` 就没有摘要。
    ``when`` 不满足时这一步记 ``skipped``、不跑。
    """

    step: str
    name: str
    run: Callable[[C], Optional[str]]
    #: 这一步做什么（一句话）。:meth:`Pipeline.outline` 用它把流程打印成清单。
    doc: str = ""
    on_error: ErrorPolicy = OnError.RAISE
    when: Optional[Callable[[C], bool]] = None


@dataclass(frozen=True)
class StageRecord:
    """一步跑下来的记录：落进 ``OrderDecision.pipeline``。"""

    step: str
    name: str
    status: str
    elapsed_ms: int = 0
    summary: str = ""
    error: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "step": self.step,
            "name": self.name,
            "status": self.status,
            "elapsed_ms": self.elapsed_ms,
            "summary": self.summary,
            "error": self.error,
        }


def _clip(text: str, limit: int = 300) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


@dataclass(frozen=True)
class Pipeline(Generic[C]):
    """一串按顺序执行的 :class:`Stage`。"""

    name: str
    stages: Tuple[Stage[C], ...]

    def run(self, ctx: C, trace: List[StageRecord]) -> None:
        """依次执行每一步，逐步往 ``trace`` 里追加记录。

        ``trace`` 由调用方持有：流水线中途抛出（失败或 :class:`PipelineExit`）时，已经跑过的那几步
        照样在里面，调用方拿它记日志或落库。
        """
        for stage in self.stages:
            if stage.when is not None and not stage.when(ctx):
                trace.append(StageRecord(stage.step, stage.name, StageStatus.SKIPPED))
                continue
            started = time.monotonic()

            def _elapsed() -> int:
                return int((time.monotonic() - started) * 1000)

            try:
                summary = stage.run(ctx)
            except PipelineExit as exit_:
                trace.append(StageRecord(stage.step, stage.name, StageStatus.DONE, _elapsed(), _clip(exit_.reason)))
                raise
            except Exception as exc:  # noqa: BLE001 - 按步骤声明的口径处置，见 OnError
                error = _clip(f"{type(exc).__name__}: {exc}")
                trace.append(StageRecord(stage.step, stage.name, StageStatus.FAILED, _elapsed(), error=error))
                if stage.on_error == OnError.ANNOTATE:
                    continue
                if stage.on_error == OnError.RAISE:
                    raise
                translated = stage.on_error(exc)
                if translated is exc:
                    raise
                raise translated from exc
            trace.append(StageRecord(stage.step, stage.name, StageStatus.DONE, _elapsed(), _clip(summary or "")))

    def outline(self) -> List[str]:
        """流程清单：``[编号] 名字 —— 职责``，一行一步。文档与日志用。"""
        return [f"[{stage.step}] {stage.name} —— {stage.doc}".rstrip(" —") for stage in self.stages]


def render_trace(trace: Sequence[StageRecord]) -> str:
    """把轨迹压成一行给日志：``02 根因收敛 12ms → 04 生成方案 3ms → …``，失败 / 跳过的标出来。"""
    marks = {StageStatus.FAILED: "✗", StageStatus.SKIPPED: "跳过"}
    parts = []
    for record in trace:
        mark = marks.get(record.status)
        tail = mark if mark else f"{record.elapsed_ms}ms"
        parts.append(f"{record.step} {record.name} {tail}")
    return " → ".join(parts)


__all__ = [
    "ErrorPolicy",
    "OnError",
    "Pipeline",
    "PipelineExit",
    "Stage",
    "StageRecord",
    "StageStatus",
    "render_trace",
]
