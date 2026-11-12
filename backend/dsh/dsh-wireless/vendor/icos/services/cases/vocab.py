"""案例库的词表归一：制式、厂家、一级 / 二级原因、问题类型、**参数名**。

同类案例按「参数 + 二级原因 + 问题类型」匹配，而人工精选案例是人填的、自闭环案例取自 ICOS 初案，两边写法
不一样（见 ``assets/case_vocab.yaml`` 的文件头）。归一把两边都折到同一套键上：**以 ICOS 初案一侧为准**，
因为案例最终要匹配的是本单的初案。

决策时本单初案也走同一套归一（:mod:`services.orders.decision_service` 里构造
:class:`~services.decision.case_evidence.ActionQuery`），所以**入库与查询必须同一个** :class:`CaseVocab`。

参数名四级回落：

1. 命中 ``params`` 概念别名 → 概念键（跨厂家同一个参数同一个键）；
2. 本身就是规则库中文名（``parachinname``）→ 规范化后的中文名当键 —— 自闭环案例与本单初案都是这种写法；
3. 规则库里有这个 OMC 名 → 回查中文名，再走 1，没有概念就按 2 同形取键（``fold(中文名)``），
   与决策侧拿初案 ``parachinname`` 算出的键对得上；
4. 都不中 → 中文部分规范化（NFKC、去空白、小写）后的字符串当键，只能精确匹配 —— 导入报告记「未归一」。

2 排在 3 前面：人同时填了 OMC 名和中文名时以中文名为准，OMC 名一名多义时不会把人写明的参数改掉。
带斜杠的写法（「qRxLevMin/最小接收电平」）按 ``/`` 拆开逐段试，但先试整串 —— 规则库有 5 个中文名本身
带斜杠（「异频/异系统测量启动门限」「ACK/NACK offset」…），拆开就对不上决策侧了。

OMC 名回查（2026-10-19 起）
--------------------------
规则库 ``plat_ret_para`` / ``paraomcname`` / ``dz_paraomcname`` / ``fc_paraomcname`` 四列都建进索引
（单元格里有逗号、分号的先拆开）。09-30 换成 ``sys_cell_execute_jiangsu.csv`` 后 258 行里 ``plat_ret_para``
只有 27 行有值，后三列每行都有，只读 ``plat_ret_para`` 时客户只填了 OMC 名的参数修改大多归一不上。

同一个 OMC 名在规则库里会对应多个中文名（中兴 ``selQrxLevMin`` 同时是「最小接入电平」和「小区选择所需的
最小RSRP接收水平」；华为开关组 ``UlSchSwitch`` 下挂「上行接入用户调度优化开关」「智能预调度开关」），
取哪一个是**确定的**：

a. 案例填了厂家、候选里有这个厂家的 → 只在这个厂家的候选里取（OMC 名是厂家各自的命名空间）；
   没填厂家或这个厂家一个都没有，就在全部候选里取；
b. 其中有命中 ``params`` 概念别名的 → 取它（按规则库行序的第一个）；
c. 都不是概念 → 按规则库行序取第一个。

取到的键之外还有别的候选键时，:attr:`ParamResolution.alternatives` 列出它们，导入报告据此提示
「OMC 名多义，填上参数中文名」—— 开关组这种只看 OMC 名分不出子开关的，要靠人补中文名。

词表文件按「路径 + mtime」缓存（同规则库 CSV）：改 YAML 不用重启。
"""
from __future__ import annotations

import re
import threading
import unicodedata
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

import yaml

from services.common.config import get_settings
from services.common.logging import get_logger
from services.common.text_utils import _text

logger = get_logger(__name__)

ASSETS_DIR = Path(__file__).resolve().parent / "assets"
DEFAULT_VOCAB = ASSETS_DIR / "case_vocab.yaml"
DEFAULT_ENUMS = ASSETS_DIR / "case_enums.yaml"


def fold(value: Any) -> str:
    """比较用的规范形：NFKC（全角转半角）、去全部空白、小写。"""
    text = unicodedata.normalize("NFKC", _text(value))
    return re.sub(r"\s+", "", text).lower()


class ParamMatch:
    """参数归一命中的是哪一级（导入报告用）。"""

    CONCEPT = "概念别名"
    RULE_OMC = "规则库OMC名"
    RULE_NAME = "规则库原名"
    RAW = "未归一"


@dataclass(frozen=True)
class ParamResolution:
    key: str
    #: 展示名：概念名 / 规则库中文名 / 原文的中文部分。
    name: str
    matched: str
    #: OMC 名一名多义时没取上的那些候选（展示名），见模块文档「OMC 名回查」；其余情形为空。
    alternatives: Tuple[str, ...] = ()

    @property
    def normalized(self) -> bool:
        return self.matched != ParamMatch.RAW


_CJK = re.compile(r"[一-鿿]")


@dataclass(frozen=True)
class CaseVocab:
    nettype_map: Dict[str, str] = field(default_factory=dict)
    vendor_map: Dict[str, str] = field(default_factory=dict)
    cause1_aliases: Dict[str, str] = field(default_factory=dict)
    cause2_aliases: Dict[str, str] = field(default_factory=dict)
    cause2_suffixes: Tuple[str, ...] = ()
    #: fold(别名) → (概念键, 概念名)
    param_aliases: Dict[str, Tuple[str, str]] = field(default_factory=dict)
    #: fold(OMC 名) → 候选 ((规则库中文名, 厂家), …)，命中概念别名的排前面，其余按规则库行序。
    rule_omc: Dict[str, Tuple[Tuple[str, str], ...]] = field(default_factory=dict)
    #: fold(规则库中文名)
    rule_names: frozenset = frozenset()
    #: 规则库 type2（ICOS 方案组）按 :meth:`cause2` 归一后的键 —— 二级原因键对齐的就是它们。
    rule_groups: frozenset = frozenset()
    #: 枚举（case_enums.yaml）
    cause2_enum: frozenset = frozenset()
    cause1_enum: frozenset = frozenset()
    plan_enum: frozenset = frozenset()
    problem_enum: frozenset = frozenset()
    field_enums: Dict[str, frozenset] = field(default_factory=dict)

    # ---- 上下文维度 ----
    def nettype(self, raw: Any) -> str:
        """「4G」「NR」→ 4g / 5g；「4G+5G」→ 4g+5g；认不出的原样小写。"""
        text = fold(raw)
        if not text:
            return ""
        parts = [part for part in re.split(r"[+/、,，&]|和", text) if part]
        keys: List[str] = []
        for part in parts:
            key = self.nettype_map.get(part, part)
            if key not in keys:
                keys.append(key)
        return "+".join(sorted(keys))

    def vendor(self, raw: Any) -> str:
        text = fold(raw)
        return self.vendor_map.get(text, _text(raw))

    # ---- 根因 ----
    def cause1(self, raw: Any) -> str:
        text = _text(raw)
        if not text:
            return ""
        if text.endswith("类") and len(text) > 1:
            text = text[:-1]
        return self.cause1_aliases.get(text, text)

    def cause2(self, raw: Any) -> str:
        text = _text(raw)
        if not text:
            return ""
        # 后缀可能叠了两层：规则库里有「驻留比方案组方案组」，只去一层会归成「驻留比方案组」，与人写的「驻留比」对不上。
        stripped = True
        while stripped:
            stripped = False
            for suffix in self.cause2_suffixes:
                if text.endswith(suffix) and len(text) > len(suffix):
                    text = text[: -len(suffix)]
                    stripped = True
                    break
        return self.cause2_aliases.get(text, text)

    def known_cause2(self, key: str) -> bool:
        """二级原因键是否认得：在分析类型枚举里，或是某个 ICOS 方案组（规则库 type2 去后缀）。"""
        return bool(key) and (key in self.cause2_enum or key in self.rule_groups)

    def problem(self, raw: Any) -> str:
        """问题类型只去首尾空白、原文全等比（2026-10-20 用户定，不归一）。

        工单的「SA无线接通率_M」与案例的「SA无线接通率」、「…(单码字0-6)小区」与「…(单码字0-6)」都不算同一问题类型。
        """
        return _text(raw)

    # ---- 参数 ----
    def param(self, name: Any, omc: Any = None, vendor: Any = None) -> ParamResolution:
        """参数名 → 归一键。``name`` 可以是「qRxLevMin/最小接收电平」这种 OMC 名与中文名拼在一起的写法；
        ``vendor`` 只在 OMC 名一名多义时用来挑候选（见模块文档「OMC 名回查」）。"""
        text = _text(name)
        tokens = [token for token in re.split(r"[/／]", text) if token.strip()]
        # 整串先试：规则库中文名本身就可能带斜杠（「异频/异系统测量启动门限」）。
        lookups = ([text] if len(tokens) > 1 else []) + tokens
        if _text(omc):
            tokens.insert(0, _text(omc))
            lookups.insert(0, _text(omc))
        for token in lookups:
            hit = self.param_aliases.get(fold(token))
            if hit:
                return ParamResolution(key=hit[0], name=hit[1], matched=ParamMatch.CONCEPT)
        # 规则库原名本身就是键（自闭环案例与本单初案都是规则库写法，走这条也能精确对上）。
        for token in lookups:
            if fold(token) in self.rule_names:
                return ParamResolution(key=fold(token), name=token.strip(), matched=ParamMatch.RULE_NAME)
        for token in lookups:
            candidates = self.rule_omc.get(fold(token))
            if candidates:
                return self._from_omc(candidates, vendor)
        chinese_tokens = [token for token in tokens if _CJK.search(token)]
        display = (chinese_tokens or tokens or [""])[0].strip()
        return ParamResolution(key=fold(display), name=display, matched=ParamMatch.RAW)

    def _from_omc(self, candidates: Tuple[Tuple[str, str], ...], vendor: Any) -> ParamResolution:
        """OMC 名回查到的候选里取一个：先按厂家收窄，再取第一个（候选已按「概念在前、规则库行序」排好）。"""
        wanted = self.vendor(vendor) if _text(vendor) else ""
        pool = [item for item in candidates if wanted and self.vendor(item[1]) == wanted] or list(candidates)
        resolved = [self._rule_chinese(chinese) for chinese, _ in pool]
        chosen = resolved[0]
        others = tuple(dict.fromkeys(item.name for item in resolved if item.key != chosen.key))
        return replace(chosen, alternatives=others)

    def _rule_chinese(self, chinese: str) -> ParamResolution:
        """规则库中文名 → 归一键：概念别名优先，否则 ``fold(中文名)``（与「规则库原名」一级同形）。"""
        hit = self.param_aliases.get(fold(chinese))
        if hit:
            return ParamResolution(key=hit[0], name=hit[1], matched=ParamMatch.CONCEPT)
        return ParamResolution(key=fold(chinese), name=chinese, matched=ParamMatch.RULE_OMC)

    # ---- 枚举校验 ----
    def in_enum(self, field_name: str, value: Any) -> Optional[bool]:
        """值是否在字段枚举里；该字段没有枚举（或值为空）返回 ``None``。"""
        values = self.field_enums.get(field_name)
        text = _text(value)
        if not values or not text:
            return None
        return text in values


def _alias_table(section: Dict[str, Iterable[str]]) -> Dict[str, str]:
    table: Dict[str, str] = {}
    for key, aliases in (section or {}).items():
        table[fold(key)] = str(key)
        for alias in aliases or ():
            table[fold(alias)] = str(key)
    return table


def _clean(value: Any) -> str:
    text = _text(value)
    return "" if text.lower() == "nan" else text


#: 规则库里写 OMC 名的四列（见模块文档「OMC 名回查」）。
RULE_OMC_COLUMNS = ("plat_ret_para", "paraomcname", "dz_paraomcname", "fc_paraomcname")
_OMC_SPLIT = re.compile(r"[,，;；]")


def _rule_index(path: Optional[Path]) -> Tuple[Dict[str, List[Tuple[str, str]]], frozenset, Tuple[str, ...]]:
    """规则库的 OMC 名 → 候选 [(中文名, 厂家), …]（规则库行序）、中文名集合、type2 原文。

    规则库读不到就空（归一退到别名表与原文）。
    """
    try:
        from services.compliance.rule_library import load_rules

        frame = load_rules(path)
    except Exception as exc:  # noqa: BLE001 - 规则库缺了不该让导入 / 决策失败，只是少一级回落
        logger.warning("案例归一：规则库读取失败，参数只按别名表与原文归一", extra={"error": str(exc)})
        return {}, frozenset(), ()
    omc: Dict[str, List[Tuple[str, str]]] = {}
    names: set = set()
    groups: List[str] = []
    for _, row in frame.iterrows():
        chinese = _clean(row.get("parachinname"))
        if chinese:
            names.add(fold(chinese))
            candidate = (chinese, _clean(row.get("vendor")))
            for column in RULE_OMC_COLUMNS:
                for code in _OMC_SPLIT.split(_clean(row.get(column))):
                    if not fold(code):
                        continue
                    candidates = omc.setdefault(fold(code), [])
                    if candidate not in candidates:
                        candidates.append(candidate)
        group = _clean(row.get("type2"))
        if group and group not in groups:
            groups.append(group)
    return omc, frozenset(names), tuple(groups)


def _omc_candidates(
    rule_omc: Mapping[str, Any], params: Dict[str, Tuple[str, str]]
) -> Dict[str, Tuple[Tuple[str, str], ...]]:
    """OMC 索引的候选排好序：命中概念别名的在前，其余保持规则库行序（``sorted`` 是稳定的）。

    值可以是候选列表 ``[(中文名, 厂家), …]``，也可以只是一个中文名（不分厂家）。
    """
    table: Dict[str, Tuple[Tuple[str, str], ...]] = {}
    for code, value in (rule_omc or {}).items():
        items = [(value, "")] if isinstance(value, str) else [(_text(name), _text(vendor)) for name, vendor in value or ()]
        items = [item for item in items if _text(item[0])]
        if fold(code) and items:
            table[fold(code)] = tuple(sorted(items, key=lambda item: fold(item[0]) not in params))
    return table


def build_vocab(
    vocab_doc: Dict[str, Any],
    enums_doc: Dict[str, Any],
    rule_omc: Mapping[str, Any],
    rule_names: Iterable[str],
    rule_groups: Iterable[str] = (),
) -> CaseVocab:
    """``rule_omc``：fold(OMC 名) → 候选 ``[(规则库中文名, 厂家), …]``（规则库行序）或单个中文名。"""
    params: Dict[str, Tuple[str, str]] = {}
    for concept in vocab_doc.get("params") or ():
        key = fold(concept.get("key"))
        name = _text(concept.get("name")) or key
        if not key:
            continue
        for alias in [concept.get("key"), name, *(concept.get("aliases") or ())]:
            if _text(alias):
                params[fold(alias)] = (key, name)
    cause1 = vocab_doc.get("cause1") or {}
    cause2 = vocab_doc.get("cause2") or {}
    analysis = enums_doc.get("analysis_types") or ()
    fields = {name: frozenset(values or ()) for name, values in (enums_doc.get("fields") or {}).items()}
    vocab = CaseVocab(
        nettype_map=_alias_table(vocab_doc.get("nettype") or {}),
        vendor_map=_alias_table(vocab_doc.get("vendor") or {}),
        cause1_aliases={str(k): _text(v) for k, v in (cause1.get("aliases") or {}).items()},
        cause2_aliases={str(k): _text(v) for k, v in (cause2.get("aliases") or {}).items()},
        cause2_suffixes=tuple(cause2.get("strip_suffixes") or ()),
        param_aliases=params,
        rule_omc=_omc_candidates(rule_omc, params),
        rule_names=frozenset(rule_names),
        cause2_enum=frozenset(_text(row.get("cause2")) for row in analysis),
        cause1_enum=frozenset(_text(row.get("cause1")) for row in analysis),
        plan_enum=frozenset(
            "/".join(_text(row.get(level)) for level in ("level1", "level2", "level3"))
            for row in (enums_doc.get("plan_types") or ())
        ),
        problem_enum=frozenset(_text(value) for value in (enums_doc.get("problem_types") or ())),
        field_enums=fields,
    )
    # 方案组要按**同一份**后缀与别名归一，所以先建出词表、再拿它折规则库的 type2。
    groups = frozenset(key for key in (vocab.cause2(group) for group in rule_groups) if key)
    return replace(vocab, rule_groups=groups)


_cache: Dict[str, Tuple[Tuple[float, float], CaseVocab]] = {}
_lock = threading.Lock()


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _load_yaml(path: Path) -> Dict[str, Any]:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except FileNotFoundError:
        logger.warning("案例词表文件不存在，按空词表归一", extra={"path": str(path)})
        return {}


def get_vocab(path: Optional[str] = None) -> CaseVocab:
    """当前生效的词表（``order_loop.case_library.vocab_path``，留空用内置），按「路径 + mtime」缓存。"""
    vocab_path = Path(path or get_settings().case_library.vocab_path or DEFAULT_VOCAB)
    enums_path = vocab_path.parent / DEFAULT_ENUMS.name
    if not enums_path.exists():
        enums_path = DEFAULT_ENUMS
    stamp = (_mtime(vocab_path), _mtime(enums_path))
    key = str(vocab_path)
    cached = _cache.get(key)
    if cached is not None and cached[0] == stamp:
        return cached[1]
    with _lock:
        cached = _cache.get(key)
        if cached is not None and cached[0] == stamp:
            return cached[1]
        rule_omc, rule_names, rule_groups = _rule_index(None)
        vocab = build_vocab(_load_yaml(vocab_path), _load_yaml(enums_path), rule_omc, rule_names, rule_groups)
        _cache[key] = (stamp, vocab)
        return vocab


def clear_cache() -> None:
    _cache.clear()


__all__ = [
    "CaseVocab",
    "ParamMatch",
    "ParamResolution",
    "build_vocab",
    "clear_cache",
    "fold",
    "get_vocab",
]
