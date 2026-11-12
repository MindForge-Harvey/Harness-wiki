"""提示词统一注册表：全模块**所有**送进大模型的正文都从这里出。

自闭环模块调用大模型的正文全部外置在 ``assets/*.yaml``，按使用场景分文件
（``cause_convergence.yaml`` / ``relevance.yaml`` / ``cause_alignment.yaml`` / ``order_review.yaml`` / ``frontend_view.yaml`` /
``solution_generation.yaml``）。业务代码只认 scene key，不再内嵌任何正文——**改文案不改 Python**。
（合规链的 ``compliance.yaml`` / ``plan_compliance`` 随合规链 2026-09-25 删除。）

用法::

    from services.prompts import render

    prompt = render("root_cause_convergence", ROOT_CAUSE_JSON=...)
    prompt = render("order_analysis", context={...})

两种渲染形态由 YAML 里的字段决定，调用方不用区分：

* 声明了 ``placeholders`` —— 正文走 :meth:`str.format`，按占位符名传关键字参数。
  正文中的字面量花括号必须在 YAML 里写成 ``{{`` / ``}}``。
* 声明了 ``context_key`` —— 正文按 ``[prefix] + template + "<context_key>：\\n<JSON>"``
  拼接，调用方只传 ``context=`` 字典。

场景元信息（触发时机、输出契约、失败降级方式、超时配置项）也一并登记在 YAML 里，
:func:`describe` / :func:`all_scenes` 供文档与总览页读取——提示词与它在业务中的位置
是**同一份事实**，别再分两处维护。

新增一个大模型场景：在对应 YAML 里加一节 scene，业务侧调 :func:`render`。不要在
业务代码里就地拼提示词——那正是这次收敛掉的东西。
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

ASSETS_DIR = Path(__file__).resolve().parent / "assets"


class PromptNotFound(KeyError):
    """scene key 不存在（多半是拼错，或 YAML 没加进 assets/）。"""


class PromptRenderError(RuntimeError):
    """渲染失败：缺占位符，或正文里有未转义的花括号。"""


@dataclass(frozen=True)
class PromptScene:
    """一个大模型调用场景的完整登记项。"""

    key: str
    source: str                      # 来自哪个 YAML 文件名
    title: str = ""
    stage: str = ""                  # 业务环节
    caller: str = ""                 # 调用方，形如 module.func
    output: str = "text"             # text | json
    trigger: str = ""                # 够格触发的时机
    on_failure: str = ""             # bypass | fallback
    contract: str = ""               # 输出结构校验位置
    timeout_setting: str = ""
    placeholders: tuple[str, ...] = ()
    fields: tuple[str, ...] = ()     # JSON 场景产出的字段
    context_key: str = ""
    prefix: str = ""                 # 引用 shared 里的公共前缀
    template: str = ""

    @property
    def body(self) -> str:
        """带公共前缀的完整正文（不含运行时上下文）。"""
        if not self.prefix:
            return self.template
        shared = _load().shared.get(self.prefix, "")
        return f"{shared}\n\n{self.template}".strip() if shared else self.template

    @property
    def char_count(self) -> int:
        return len(self.body)


@dataclass
class _Catalog:
    scenes: dict[str, PromptScene] = field(default_factory=dict)
    shared: dict[str, str] = field(default_factory=dict)


_catalog: _Catalog | None = None
_lock = threading.Lock()


def _as_tuple(value: Any) -> tuple[str, ...]:
    if not value:
        return ()
    if isinstance(value, (list, tuple)):
        return tuple(str(item) for item in value)
    return (str(value),)


def _load() -> _Catalog:
    """加载并缓存全部 YAML。进程内只读一次——提示词是发布物，不做热重载。"""
    global _catalog
    if _catalog is not None:
        return _catalog
    with _lock:
        if _catalog is not None:
            return _catalog
        catalog = _Catalog()
        for path in sorted(ASSETS_DIR.glob("*.yaml")):
            with path.open("r", encoding="utf-8") as handle:
                data = yaml.safe_load(handle) or {}
            for name, text in (data.get("shared") or {}).items():
                catalog.shared[str(name)] = str(text).strip()
            for key, raw in (data.get("scenes") or {}).items():
                raw = raw or {}
                catalog.scenes[str(key)] = PromptScene(
                    key=str(key),
                    source=path.name,
                    title=str(raw.get("title") or ""),
                    stage=str(raw.get("stage") or ""),
                    caller=str(raw.get("caller") or ""),
                    output=str(raw.get("output") or "text"),
                    trigger=str(raw.get("trigger") or ""),
                    on_failure=str(raw.get("on_failure") or ""),
                    contract=str(raw.get("contract") or ""),
                    timeout_setting=str(raw.get("timeout_setting") or ""),
                    placeholders=_as_tuple(raw.get("placeholders")),
                    fields=_as_tuple(raw.get("fields")),
                    context_key=str(raw.get("context_key") or ""),
                    prefix=str(raw.get("prefix") or ""),
                    template=str(raw.get("template") or "").strip(),
                )
        _catalog = catalog
    return _catalog


def reset_cache() -> None:
    """测试用：丢掉缓存，下次 :func:`render` 重新读盘。"""
    global _catalog
    _catalog = None


def get_scene(key: str) -> PromptScene:
    scene = _load().scenes.get(key)
    if scene is None:
        known = ", ".join(sorted(_load().scenes)) or "(空)"
        raise PromptNotFound(f"未登记的提示词场景 {key!r}；已登记：{known}")
    return scene


def all_scenes() -> list[PromptScene]:
    """按 source + key 排序的全部场景，供总览页/文档遍历。"""
    return sorted(_load().scenes.values(), key=lambda s: (s.source, s.key))


def describe(key: str) -> dict[str, Any]:
    """场景元信息（不含正文），用于日志与运维排查。"""
    scene = get_scene(key)
    return {
        "key": scene.key,
        "source": scene.source,
        "title": scene.title,
        "stage": scene.stage,
        "caller": scene.caller,
        "output": scene.output,
        "on_failure": scene.on_failure,
        "chars": scene.char_count,
    }


def render(
    key: str,
    *,
    context: Any = None,
    **placeholders: Any,
) -> str:
    """渲染场景 ``key`` 的最终提示词。正文只认 ``assets/*.yaml``，没有外部文件覆盖的口子
    （合规链与整单复核的 ``prompt_path`` 分别于 2026-09-25 / 10-03 退役）。"""
    scene = get_scene(key)
    body = scene.body

    if scene.placeholders or placeholders:
        missing = [name for name in scene.placeholders if name not in placeholders]
        if missing:
            raise PromptRenderError(f"场景 {key!r} 缺少占位符：{', '.join(missing)}")
        try:
            return body.format(**placeholders)
        except (KeyError, IndexError, ValueError) as exc:
            raise PromptRenderError(
                f"场景 {key!r} 渲染失败（正文里的字面量花括号需写成 {{{{ }}}}）：{exc}"
            ) from exc

    if scene.context_key:
        payload = json.dumps(context, ensure_ascii=False, default=str)
        return f"{body}\n\n{scene.context_key}：\n{payload}"

    return body


__all__ = [
    "ASSETS_DIR",
    "PromptNotFound",
    "PromptRenderError",
    "PromptScene",
    "all_scenes",
    "describe",
    "get_scene",
    "render",
    "reset_cache",
]
