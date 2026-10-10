"""JSON Schema 校验。被各阶段在写出前调用。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

from . import paths as P
from . import io as cio

SCHEMA_MAP = {
    "trace_record": P.SCHEMAS / "trace_record.schema.json",
    "evidence_unit": P.SCHEMAS / "evidence_unit.schema.json",
    "memory_object": P.SCHEMAS / "memory_object.schema.json",
    "memory_evidence_profile": P.SCHEMAS / "memory_evidence_profile.schema.json",
    "state_transition": P.SCHEMAS / "state_transition.schema.json",
    "memory_score": P.SCHEMAS / "memory_score.schema.json",
    "memory_package": P.SCHEMAS / "memory_package.schema.json",
    "experiment_spec": P.SCHEMAS / "experiment_spec.schema.json",
    "run_artifact": P.SCHEMAS / "run_artifact.schema.json",
    "canonical_action": P.SCHEMAS / "canonical_action.schema.json",
    "action_ontology_draft": P.SCHEMAS / "action_ontology_draft.schema.json",
    "bootstrap_analysis": P.SCHEMAS / "bootstrap_analysis.schema.json",
}


_CACHE: dict[str, Draft202012Validator] = {}


def get_validator(kind: str) -> Draft202012Validator:
    if kind in _CACHE:
        return _CACHE[kind]
    schema_path = SCHEMA_MAP[kind]
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    v = Draft202012Validator(schema)
    _CACHE[kind] = v
    return v


def validate(record: dict, kind: str) -> list[str]:
    v = get_validator(kind)
    return [f"{'/'.join(map(str,e.path))}: {e.message}" for e in v.iter_errors(record)]


def validate_file(path: Path | str, kind: str) -> tuple[int, list[tuple[int, list[str]]]]:
    errors: list[tuple[int, list[str]]] = []
    n = 0
    for i, rec in enumerate(cio.read_jsonl(path), 1):
        n += 1
        errs = validate(rec, kind)
        if errs:
            errors.append((i, errs))
    return n, errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("kind", choices=list(SCHEMA_MAP.keys()))
    args = ap.parse_args()
    n, errs = validate_file(args.file, args.kind)
    print(f"validated {n} records, {len(errs)} bad")
    for i, e in errs[:20]:
        print(f"  line {i}:")
        for msg in e:
            print(f"    - {msg}")
    sys.exit(0 if not errs else 1)


if __name__ == "__main__":
    main()
