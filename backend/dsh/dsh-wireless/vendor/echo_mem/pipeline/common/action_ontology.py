"""Reviewed action ontology labels for compiler-side semantic tagging.

These labels are not executable action templates. They are semantic tags over
train-only action signatures and must preserve the original vendor/RAT/scheme/
parameter/value/boundary identity for any final decision.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import paths as P
from .parameter_range import to_number


LABEL_ROLE = "semantic_label_not_executable_template"
SOURCE_VERSION = "reviewed_label_ontology_v2"
SIGNATURE_ALGORITHM_VERSION = "action_signature_hash_v1_1"


def _norm(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    text = str(value).strip()
    if text.lower() in {"nan", "nat", "none", "null"}:
        return ""
    return text


def _compact(value: Any, limit: int = 120) -> str:
    text = re.sub(r"\s+", " ", _norm(value))
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def _signature_hash(parts: list[str]) -> str:
    raw = json.dumps(parts, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:14]


def _seed_value_shape(before: Any, after: Any) -> dict[str, Any]:
    """Match scripts/export_action_ontology_llm_seed.py signature grouping."""
    before_text = _norm(before)
    after_text = _norm(after)
    before_num = to_number(before_text)
    after_num = to_number(after_text)
    if before_num is not None and after_num is not None:
        delta = round(after_num - before_num, 6)
        if delta > 0:
            direction = "increase"
        elif delta < 0:
            direction = "decrease"
        else:
            direction = "unchanged"
        return {"value_type": "numeric", "numeric_direction": direction}

    before_lower = before_text.lower()
    after_lower = after_text.lower()
    off_tokens = ("-0", "_0", "off", "false", "disable", "disabled", "guan", "关")
    on_tokens = ("-1", "_1", "on", "true", "enable", "enabled", "kai", "开")
    if any(token in before_lower for token in off_tokens) and any(token in after_lower for token in on_tokens):
        return {"value_type": "bool_or_switch", "numeric_direction": "enable"}
    if any(token in before_lower for token in on_tokens) and any(token in after_lower for token in off_tokens):
        return {"value_type": "bool_or_switch", "numeric_direction": "disable"}
    return {"value_type": "enum_or_text", "numeric_direction": "switch_enum"}


def action_ontology_signature_id(ticket: dict[str, Any], action: dict[str, Any]) -> str:
    """Return the train-only action ontology signature id for one trace action."""
    shape = _seed_value_shape(action.get("before_value"), action.get("after_value"))
    key_parts = [
        _compact(ticket.get("vendor"), 60),
        _compact(ticket.get("system"), 40),
        _compact(action.get("scheme_id"), 80),
        _compact(action.get("root_cause_l2") or action.get("scheme_group"), 100),
        _compact(action.get("root_cause_l1") or action.get("param_kind"), 80),
        _compact(action.get("root_cause_l2") or action.get("scheme_group"), 100),
        _compact(action.get("scheme_type3"), 140),
        _compact(action.get("param_object"), 100),
        _compact(action.get("param_en_name"), 100),
        _compact(action.get("param_cn_name"), 100),
        _compact(action.get("operation_summary"), 100),
        _compact(action.get("operation_detail"), 140),
        _compact(action.get("operation_delta_hint"), 140),
        _compact(action.get("parameter_group"), 80),
        shape["value_type"],
        shape["numeric_direction"],
    ]
    return _signature_hash(key_parts)


def _boolish(value: Any) -> bool:
    return str(value or "").strip().lower() in {"true", "1", "yes", "y"}


@dataclass(frozen=True)
class ActionOntologyStore:
    candidates_by_signature: dict[str, dict[str, Any]]
    policy_by_signature: dict[str, dict[str, Any]]
    source_available: bool
    source_paths: dict[str, str]

    def label_for(self, ticket: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
        signature_id = action_ontology_signature_id(ticket, action)
        candidate = self.candidates_by_signature.get(signature_id)
        policy = self.policy_by_signature.get(signature_id, {})
        if not candidate:
            return {
                "source_version": SOURCE_VERSION,
                "signature_algorithm_version": SIGNATURE_ALGORITHM_VERSION,
                "label_role": LABEL_ROLE,
                "ontology_status": "unmapped",
                "ontology_signature_id": signature_id,
                "hard_aggregation_policy": "blocked",
                "policy_reason": "signature not covered by reviewed action ontology",
            }

        return {
            "source_version": SOURCE_VERSION,
            "signature_algorithm_version": SIGNATURE_ALGORITHM_VERSION,
            "label_role": LABEL_ROLE,
            "ontology_status": "mapped",
            "ontology_signature_id": signature_id,
            "canonical_action_id": candidate.get("canonical_action_id"),
            "parameter_concept_id": candidate.get("parameter_concept_id"),
            "operation_family": candidate.get("operation_family"),
            "object_scope": candidate.get("object_scope"),
            "label_value_type": candidate.get("value_type"),
            "label_numeric_direction": candidate.get("numeric_direction"),
            "effect_direction": candidate.get("effect_direction"),
            "equivalence_level": candidate.get("equivalence_level"),
            "confidence": candidate.get("confidence"),
            "hard_aggregation_policy": policy.get("hard_aggregation_policy") or "allowed",
            "normalization_confidence": policy.get("normalization_confidence") or "",
            "parent_only": _boolish(policy.get("parent_only")),
            "requires_vendor_semantics_confirmation": _boolish(policy.get("requires_vendor_semantics_confirmation")),
            "normalized_set_change": policy.get("normalized_set_change") or "",
            "policy_bundle_id": policy.get("bundle_id") or "",
            "policy_patch_action": policy.get("patch_action") or "",
            "policy_notes": policy.get("notes") or "",
        }

    def artifact_summary(self) -> dict[str, Any]:
        policies = [row.get("hard_aggregation_policy") or "allowed" for row in self.policy_by_signature.values()]
        return {
            "source_version": SOURCE_VERSION,
            "signature_algorithm_version": SIGNATURE_ALGORITHM_VERSION,
            "source_available": self.source_available,
            "source_paths": self.source_paths,
            "candidate_count": len(self.candidates_by_signature),
            "policy_count": len(self.policy_by_signature),
            "hard_aggregation_policy_distribution": {
                key: policies.count(key)
                for key in sorted(set(policies))
            },
        }


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


@lru_cache(maxsize=1)
def load_action_ontology_store() -> ActionOntologyStore:
    draft_path = P.ACTION_ONTOLOGY_REVIEWED_DRAFT_JSON
    policy_path = P.ACTION_ONTOLOGY_SIGNATURE_POLICY_CSV
    source_paths = {
        "reviewed_draft": str(draft_path),
        "signature_policy": str(policy_path),
        "link_policy": str(P.ACTION_ONTOLOGY_LINK_POLICY_CSV),
    }
    if not draft_path.exists() or not policy_path.exists():
        return ActionOntologyStore({}, {}, False, source_paths)

    draft = json.loads(draft_path.read_text(encoding="utf-8"))
    candidates = {
        str(row["signature_id"]): row
        for row in draft.get("ontology_candidates", [])
        if row.get("signature_id")
    }
    policies = {
        str(row["signature_id"]): row
        for row in _read_csv(policy_path)
        if row.get("signature_id")
    }
    return ActionOntologyStore(candidates, policies, True, source_paths)
