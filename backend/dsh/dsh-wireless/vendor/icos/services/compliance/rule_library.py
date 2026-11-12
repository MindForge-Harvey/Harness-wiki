# -*- coding: utf-8 -*-
"""规则库（省侧 CSV，``sys_cell_execute_jiangsu.csv``）加载与五元组匹配。

匹配键（REQ-012/013）：``type1, type2, nettype, vendor, parachinname``
* ``type1`` / ``type2`` **只取 ICOS 初案**，禁止回退工单；
* ``vendor`` 允许回退：工单根因 → 初案 → task_info；
* ``type2`` 字面不一致时经 ``rule_type2_fallback.yaml`` 静默映射后重试；
* 多行命中先按初案的 ``execute_number`` 取（规则表里全局唯一），取不到再按 ``band`` 择优：
  具体频段 → ``all`` → 首行。

``is_use=否`` 的行在载入时就滤掉（业务已停用的规则不参与匹配，命中不到即按「规则库无匹配」处理）。
判定只用命中行的 ``para`` 与 ``rule_scope``，见 :mod:`services.compliance.rule_constraint`。

缓存
----
:func:`match_rule_row` 是**按初案逐条**调用的（一个 taskno 下 8 条初案就要匹配 8 次），
因此 DataFrame 按「路径 + mtime」缓存：文件更新后自动失效，不必重启进程。
不要改成每次调用 ``pd.read_csv``。
"""
from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from services.common.config import get_settings
from services.common.logging import get_logger

logger = get_logger(__name__)

MATCH_KEYS = ("type1", "type2", "nettype", "vendor", "parachinname")
#: 规则库行里**描述规则本身**的那几列：:class:`services.decision.verdict.RuleRow` 的字段，
#: 也是正文逐条依据里「规则行」展示的列（``frontend_view.service.solution_rule_evidence``）。
#:
#: 2026-09-30 起只保留参与判定的列 —— 模型只引用这些；``execute_number`` 加进来：
#: 多行命中靠它取定一行，决策侧与正文都要能读到。
RULE_ROW_SNAPSHOT_KEYS = (
    "type1", "type2", "operate", "nettype", "vendor", "band",
    "parachinname", "execute_number", "para", "rule_scope",
)

#: 07 规则库结论里的规则事实（决策行 ``llm_solution.new_chain.rule.matched_rule``，合规链时期的老行
#: 在 ``llm_solution.matched_rule``）—— **代码事实，模型碰不到**。决策侧（07 风险依据、08 决策条件、
#: 裁决对象）一律读它，经 ``plan_table.rule_basis`` 取。
#:
#: 比 :data:`RULE_ROW_SNAPSHOT_KEYS` 多出来的三列都有明确的决策用途，且都是今天**有列无人读**的：
#:
#: * ``parameter_level`` —— 参数风险分级，05 的分级依据。现网 209 行**全是「其他」**，
#:   等业务供数；通道先打通，供了数就自动生效。
#: * ``is_mutual_exclusion`` —— 功能互斥，04 方案一致性要它。现网 209 行**全空**，
#:   即互斥今天没有现成数据源；让「它是空的」在数据上可见，而不是靠翻 CSV 才知道。
#: * ``is_use`` —— 该规则启用与否。**匹配器今天完全不读它**：现网 3 行标着「否」
#:   仍在参与匹配，且每条都是它那个五元组的唯一行，于是那 3 个参数命中的是一条
#:   业务已经关掉的规则。要不要据此过滤是规则库语义问题，得业务定；
#:   在那之前先让它跟着事实一起落库，好统计影响面。
RULE_FACT_KEYS = RULE_ROW_SNAPSHOT_KEYS + (
    "parameter_level", "is_mutual_exclusion", "is_use",
)

_df_cache: dict[str, tuple[float, pd.DataFrame]] = {}
_fallback_cache: dict[str, tuple[float, dict[str, str]]] = {}
_lock = threading.Lock()


def _norm(value: Any) -> str:
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    if value is None:
        return ""
    return str(value).strip()


def normalize_nettype(value: Any) -> str:
    text = _norm(value).lower()
    if text in ("4g", "lte", "eutran"):
        return "4g"
    if text in ("5g", "nr", "sa", "nsa"):
        return "5g"
    return text


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def load_rules(path: Path | None = None) -> pd.DataFrame:
    """读规则库 CSV，按 (路径, mtime) 缓存。"""
    csv_path = Path(path) if path else get_settings().compliance.resolved_rule_csv()
    key = str(csv_path)
    stamp = _mtime(csv_path)

    cached = _df_cache.get(key)
    if cached is not None and cached[0] == stamp:
        return cached[1]

    with _lock:
        cached = _df_cache.get(key)
        if cached is not None and cached[0] == stamp:
            return cached[1]
        frame: pd.DataFrame | None = None
        # 一律按文本读：否则整列是数时 pandas 会把 1 读成 1.0、true 读成布尔。
        read_kwargs = {"dtype": str, "keep_default_na": False}
        for encoding in ("utf-8-sig", "utf-8", "gbk"):
            try:
                frame = pd.read_csv(csv_path, encoding=encoding, **read_kwargs)
                break
            except UnicodeDecodeError:
                continue
            except FileNotFoundError:
                logger.error("规则库 CSV 不存在", extra={"path": key})
                raise
        if frame is None:
            frame = pd.read_csv(csv_path, **read_kwargs)
        total = len(frame)
        frame = _drop_disabled(frame)
        _df_cache[key] = (stamp, frame)
        logger.info(
            "规则库已载入",
            extra={"path": key, "rows": len(frame), "disabled_rows": total - len(frame)},
        )
        return frame


def _drop_disabled(frame: pd.DataFrame) -> pd.DataFrame:
    """滤掉 ``is_use=否`` 的行；没有这一列就原样返回。"""
    lowered = {str(column).lower(): str(column) for column in frame.columns}
    column = lowered.get("is_use")
    if column is None:
        return frame
    return frame.loc[frame[column].map(_norm) != "否"].reset_index(drop=True)


def load_type2_fallback(path: Path | None = None) -> dict[str, str]:
    """``type1 → 规范 type2`` 的静默映射表。"""
    yaml_path = Path(path) if path else get_settings().compliance.resolved_type2_fallback()
    key = str(yaml_path)
    stamp = _mtime(yaml_path)

    cached = _fallback_cache.get(key)
    if cached is not None and cached[0] == stamp:
        return cached[1]

    with _lock:
        mapping: dict[str, str] = {}
        try:
            with yaml_path.open("r", encoding="utf-8") as handle:
                data = yaml.safe_load(handle) or {}
            raw = data.get("type2_fallback") or {}
            mapping = {_norm(k): _norm(v) for k, v in raw.items() if _norm(k) and _norm(v)}
        except (OSError, yaml.YAMLError) as exc:
            logger.warning("type2 回退表载入失败，按空表处理", extra={"path": key, "error": str(exc)})
        _fallback_cache[key] = (stamp, mapping)
        return mapping


def clear_cache() -> None:
    """测试 / 热更新用。"""
    with _lock:
        _df_cache.clear()
        _fallback_cache.clear()


def _column_map(frame: pd.DataFrame) -> dict[str, str]:
    """CSV 列名大小写可能不一，做一次不区分大小写的映射。"""
    lowered = {str(column).lower(): str(column) for column in frame.columns}
    return {key: lowered.get(key, key) for key in (*MATCH_KEYS, "band", "execute_number")}


def _filter_by_keys(
    frame: pd.DataFrame,
    columns: dict[str, str],
    type1: str,
    type2: str,
    nettype: str,
    vendor: str,
    parachinname: str,
) -> pd.DataFrame:
    mask = (
        frame[columns["type1"]].map(_norm).eq(type1)
        & frame[columns["type2"]].map(_norm).eq(type2)
        & frame[columns["nettype"]].map(normalize_nettype).eq(nettype)
        & frame[columns["vendor"]].map(_norm).eq(vendor)
        & frame[columns["parachinname"]].map(_norm).eq(parachinname)
    )
    return frame.loc[mask].copy()


def _row_to_dict(row: pd.Series) -> dict[str, Any]:
    return {str(key): (None if pd.isna(value) else value) for key, value in row.items()}


def infer_band_hint(task_info: dict[str, Any], order_data: dict[str, Any]) -> str | None:
    """从工单字段推断频段，用于多行命中时择优。"""
    for key in ("band", "freq_band", "frequency_band"):
        value = task_info.get(key) or order_data.get(key)
        if value:
            return _norm(value).lower()
    for field in (
        task_info.get("cgi"),
        task_info.get("cell_name"),
        order_data.get("小区CGI标识"),
        order_data.get("小区名称"),
    ):
        if not field:
            continue
        match = re.search(r"n\d{1,3}\b", str(field), re.I)
        if match:
            return match.group(0).lower()
    return None


def _select_row(
    matched: pd.DataFrame, band_hint: str | None, band_column: str, warnings: list[str]
) -> dict[str, Any]:
    if len(matched) > 1:
        warnings.append(f"规则库命中 {len(matched)} 行，将按 band 策略择优")

    bands = matched[band_column].map(lambda x: _norm(x).lower())
    if band_hint:
        exact = matched[bands == band_hint]
        if not exact.empty:
            chosen_index = exact.index[0]
        else:
            generic = matched[bands == "all"]
            if not generic.empty:
                chosen_index = generic.index[0]
                warnings.append(f"未找到 band={band_hint}，退回 band=all")
            else:
                chosen_index = matched.index[0]
                warnings.append(f"未找到 band={band_hint} 且无 all 行，取首行")
    else:
        generic = matched[bands == "all"]
        if not generic.empty:
            chosen_index = generic.index[0]
        else:
            chosen_index = matched.index[0]
            warnings.append("未推断频段，且无 band=all 行，取命中集首行")

    row = _row_to_dict(matched.loc[chosen_index])
    if len(matched) > 1 and not band_hint:
        row["_ambiguity"] = True
        warnings.append("多行命中且未提供 band 推断，已取当前行；建议在 rule_match_ambiguity 中说明")
    return row


class RuleNotMatched(Exception):
    """规则库无匹配行 —— 这不是错误，而是 bypass 直通下发的信号（REQ-020）。"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class RuleMatchFailed(Exception):
    """前置字段缺失，连匹配都做不了 —— 这才是真失败。"""


def match_rule_row(
    structured_data: dict[str, Any], task_info: dict[str, Any] | None = None
) -> tuple[dict[str, Any], list[str]]:
    """返回 (rule_row, warnings)。

    无匹配抛 :class:`RuleNotMatched`（走 bypass），前置缺失抛 :class:`RuleMatchFailed`（判失败）。
    两者必须用**异常类型**区分——它决定下不下发，靠返回 None + 匹配 warning 子串太脆。
    """
    warnings: list[str] = []
    task_info = task_info or {}
    order_data = structured_data.get("order_data") or {}
    reason_analyze = structured_data.get("reason_analyze") or {}
    icos = structured_data.get("icos_init_plan") or {}

    type1, type2 = _norm(icos.get("type1")), _norm(icos.get("type2"))
    nettype = normalize_nettype(order_data.get("网络制式") or reason_analyze.get("网络制式"))
    vendor = _norm(reason_analyze.get("服务商") or icos.get("vendor") or task_info.get("vendor"))
    parachinname = _norm(icos.get("parachinname"))

    if not type1 or not type2:
        raise RuleMatchFailed("缺少 icos_init_plan.type1 或 type2，无法匹配规则库（不回退工单）")
    if not parachinname:
        raise RuleMatchFailed("缺少 icos_init_plan.parachinname，无法匹配规则库")

    frame = load_rules()
    columns = _column_map(frame)

    matched = _filter_by_keys(frame, columns, type1, type2, nettype, vendor, parachinname)
    if matched.empty:
        mapped_type2 = load_type2_fallback().get(type1)
        if mapped_type2 and mapped_type2 != type2:
            matched = _filter_by_keys(
                frame, columns, type1, mapped_type2, nettype, vendor, parachinname
            )
            if not matched.empty:
                warnings.append(f"type2 经回退表映射 {type2} → {mapped_type2} 后命中")

    if matched.empty:
        raise RuleNotMatched(
            f"规则库无匹配行: type1={type1}, type2={type2}, nettype={nettype}, "
            f"vendor={vendor}, parachinname={parachinname}"
        )

    if len(matched) > 1:
        # 五元组不唯一时，先用初案自带的执行编号精确取（规则表里 execute_number 全局唯一）；
        # band 在 4G 上推不出来，同键 FDD/TDD 两行规则方向都可能相反，不能靠它。
        execute_number = _norm(icos.get("execute_number"))
        column = columns["execute_number"]
        if execute_number and column in matched.columns:
            exact = matched.loc[matched[column].map(_norm) == execute_number]
            if len(exact) == 1:
                warnings.append(
                    f"规则库命中 {len(matched)} 行，按执行编号 {execute_number} 取定一行"
                )
                return _row_to_dict(exact.iloc[0]), warnings

    band_hint = infer_band_hint(task_info, order_data)
    return _select_row(matched, band_hint, columns["band"], warnings), warnings


def _snapshot(rule_row: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    """按给定列名裁一份快照（CSV 列名大小写不敏感，NaN 归成 None）。"""
    snapshot: dict[str, Any] = {}
    lowered = {str(key).lower(): value for key, value in rule_row.items()}
    for key in keys:
        value = lowered.get(key)
        if isinstance(value, float) and pd.isna(value):
            value = None
        if key in lowered:
            snapshot[key] = value
    return snapshot


def rule_fact_snapshot(rule_row: dict[str, Any]) -> dict[str, Any]:
    """裁出 07 规则库结论里的规则事实 —— **决策侧的权威规则事实**，详见 :data:`RULE_FACT_KEYS`。"""
    return _snapshot(rule_row, RULE_FACT_KEYS)


__all__ = [
    "MATCH_KEYS",
    "RULE_FACT_KEYS",
    "RULE_ROW_SNAPSHOT_KEYS",
    "RuleMatchFailed",
    "RuleNotMatched",
    "clear_cache",
    "infer_band_hint",
    "load_rules",
    "load_type2_fallback",
    "match_rule_row",
    "normalize_nettype",
    "rule_fact_snapshot",
]
