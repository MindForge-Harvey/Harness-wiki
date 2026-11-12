"""Harness supplies judgments. This adapter has no model/network implementation."""
from contextvars import ContextVar


class LLMError(RuntimeError):
    pass


class LLMTimeout(LLMError):
    pass


class LLMClient:
    def complete_json(self, *args, **kwargs):
        raise LLMError("Model judgments must be supplied by Harness")


_task = ContextVar("icos_harness_task", default=None)
set_current_taskno = _task.set
reset_current_taskno = _task.reset


def get_llm_client():
    return LLMClient()
