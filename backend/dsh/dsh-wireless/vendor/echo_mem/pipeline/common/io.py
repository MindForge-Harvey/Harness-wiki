"""JSONL 读写、安全序列化、去重落盘。"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Iterator


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def read_jsonl(path: Path | str) -> Iterator[dict]:
    path = Path(path)
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def write_jsonl(path: Path | str, records: Iterable[dict]) -> int:
    """原子写入：先写 .tmp 再 replace，避免读端在半写入时解码失败。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    count = 0
    try:
        with tmp.open("w", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r, ensure_ascii=False, default=_json_fallback) + "\n")
                count += 1
        tmp.replace(path)
    except Exception:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise
    return count


def append_jsonl(path: Path | str, records: Iterable[dict]) -> int:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False, default=_json_fallback) + "\n")
            count += 1
    return count


def _json_fallback(o: Any):
    if isinstance(o, datetime):
        return o.isoformat()
    if hasattr(o, "isoformat"):
        return o.isoformat()
    return str(o)


def safe_get(d: dict, *keys, default=None):
    cur: Any = d
    for k in keys:
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return cur
