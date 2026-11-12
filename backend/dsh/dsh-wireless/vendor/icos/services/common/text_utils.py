"""快照组装用到的纯工具：取值归一、文本压缩、哈希、检索分词。

从 ``frontend_view/service.py`` 拆出来的第一层 —— **本模块什么都不 import**，没有任何
业务语义，也不碰配置与库。改这里等于同时改展示层与决策层的取值口径，动手前先看
:mod:`services.frontend_view.service` 与 :mod:`services.decision` 里的调用方。

原先放在 ``services/frontend_view/`` 下，随 ``plan_table`` / ``root_cause`` /
``action_facts`` 移出展示包时一并下沉到 ``services/common/`` —— 那三个模块都要用它，
留在原处会让 :mod:`services.decision` 为了两个纯函数反向依赖展示包。

Tailwind 配色 ``TONE_CLASSES`` / ``_tone`` 曾经也在这里，随 P5「渲染迁出决策包」
搬到了 :mod:`services.frontend_view.tone` —— 决策包不再产出展示字段，配色没有理由留在
两边共用的叶子里。

风格提醒（与 ``service.py`` 同）：这些函数刻意写得紧凑、私有名前缀保留下划线，
是为保持快照输出逐字段可比对，不要顺手重命名或重排。
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


def _text(value: Any, default: str = "") -> str:
    if _is_blank(value):
        return default
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return str(value).strip()


def _number(value: Any, default: float = 0.0) -> float:
    if _is_blank(value):
        return default
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return default


def _optional_number(value: Any) -> Optional[float]:
    if _is_blank(value):
        return None
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None


def _json_loads(value: Any, fallback: Any) -> Any:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def _extract_json_object(raw: str) -> Dict[str, Any]:
    """模型回复 → 第一个 JSON 对象：整段即对象 / ```json 围栏 / 首个 ``{`` 到末个 ``}``。取不到就抛。

    与 ``services.common.llm.extract_json_object`` 不是一回事（那个取不到返回 None、
    切块规则也不同），展示文案的三个富化阶段与正文写作一直用的是这一份。
    """
    raw = (raw or "").strip()
    if raw.startswith("{"):
        return json.loads(raw)
    fenced = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", raw, re.IGNORECASE)
    if fenced:
        return json.loads(fenced.group(1))
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        return json.loads(raw[start : end + 1])
    raise ValueError("LLM 返回中没有 JSON 对象")


def _hash_obj(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _project_root() -> Path:
    # network-ops-loop-v3/services/common/text_utils.py → 仓库根
    # 深度与它此前所在的 services/frontend_view/ 相同（都是 services 下一层），
    # 所以从展示包搬到 common 时 parents[3] 不用跟着改。
    return Path(__file__).resolve().parents[3]


def _compact_text(value: Any, limit: int = 160) -> str:
    text = re.sub(r"\s+", " ", _text(value)).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _looks_readable_text(value: Any) -> bool:
    """判断模型返回的正文是不是「人能读」的 —— 乱码或过短一律判否，走兜底。"""
    text = _text(value)
    if not text:
        return False
    mojibake_markers = ("滮", "Ԫ", "淶", "Ҫ", "Ƶ", "ܹ", "£", "¡", "Ð", "Î", "Ï")
    if any(marker in text for marker in mojibake_markers):
        return False
    chinese_chars = len(re.findall(r"[一-鿿]", text))
    ascii_words = len(re.findall(r"[A-Za-z]{3,}", text))
    return chinese_chars >= 6 or ascii_words >= 8


def _search_tokens(text: str) -> List[str]:
    chunks = re.findall(r"[A-Za-z0-9\-\+]+|[一-鿿]{2,}", (text or "").lower())
    stopwords = {"问题", "工单", "小区", "场景", "一般", "当前", "处理", "优化", "网络"}
    return [token for token in chunks if token and token not in stopwords]


def _line(start: float, end: float, points: int = 6) -> List[float]:
    if points <= 1:
        return [round(end, 4)]
    step = (end - start) / (points - 1)
    return [round(start + step * idx, 4) for idx in range(points)]


__all__ = [
    "_compact_text",
    "_extract_json_object",
    "_hash_obj",
    "_is_blank",
    "_json_loads",
    "_line",
    "_looks_readable_text",
    "_number",
    "_optional_number",
    "_project_root",
    "_search_tokens",
    "_text",
]
