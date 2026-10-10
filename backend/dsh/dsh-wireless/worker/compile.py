"""Harness adapter around the unchanged pinned ECHO-Mem rule compiler.

Creates an immutable local package. No network, LLM, source-tree writes or publication.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import redirect_stdout
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
import sys

VENDOR = Path(__file__).resolve().parents[1] / "vendor" / "echo_mem"


def iso(value):
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamps require an explicit timezone")
    return parsed


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def jsonl(path, values):
    path.write_text("".join(json.dumps(value, ensure_ascii=False) + "\n" for value in values), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--as-of", required=True)
    parser.add_argument("--mode", choices=["demo", "historical"], required=True)
    parser.add_argument("--evaluation-visible", action="store_true")
    args = parser.parse_args()
    provenance = json.loads((VENDOR / "source-manifest.json").read_text())
    for relative, expected in provenance["files"].items():
        if hashlib.sha256((VENDOR / relative).read_bytes()).hexdigest() != expected:
            raise ValueError(f"vendored source integrity mismatch: {relative}")
    sys.path.insert(0, str(VENDOR))
    from pipeline.common.schema_check import validate
    from pipeline.compile import compile_rules
    from pipeline.compile.memory_evidence_profiles import build_profiles
    from pipeline.compile.outcome_compilation import materialize_evidence_authority
    from pipeline.evidence.extract import extract_all
    from pipeline.scoring.score import score_memory
    from pipeline.transition.state import evaluate
    from pipeline.package.build import _build_index, _stats, _knowledge_layers

    raw = Path(args.input).read_text(encoding="utf-8").strip()
    rows = json.loads(raw) if raw.startswith("[") else [json.loads(line) for line in raw.splitlines() if line.strip()]
    if not isinstance(rows, list) or not rows or len(rows) > 200:
        raise ValueError("provide 1 to 200 TraceRecord objects")
    cutoff = iso(args.as_of)
    if args.mode == "historical" and not args.evaluation_visible:
        raise ValueError("historical compilation requires a declaration that evaluations were visible at the cutoff")
    selected, excluded, seen = [], [], {}
    duplicates = 0
    for trace in rows:
        errors = validate(trace, "trace_record")
        if errors:
            raise ValueError(f"TraceRecord schema error: {errors[:5]}")
        identity = trace["trace_id"]
        payload = json.dumps(trace, sort_keys=True, ensure_ascii=False)
        if identity in seen:
            if seen[identity] != payload:
                raise ValueError(f"conflicting duplicate trace_id: {identity}")
            duplicates += 1
            continue
        seen[identity] = payload
        dataset = str(trace.get("source", {}).get("dataset", ""))
        if args.mode == "historical" and (dataset.startswith("minimal_sample") or identity.startswith("t_sample_") or "样例" in str(trace.get("ticket", {}).get("vendor", ""))):
            raise ValueError("onboarding demo traces cannot enter a historical effect package")
        times = [iso(value) for value in [trace["ticket"].get("issued_at"), trace["source"].get("ingested_at")]
                 if value]
        successful = []
        for action in trace.get("actions", []):
            for key in ["issued_at", "exec_at", "rollback_at"]:
                if action.get(key):
                    times.append(iso(action[key]))
            if action.get("exec_state") == "exec_success" and action.get("exec_at"):
                successful.append(iso(action["exec_at"]))
        if any(time > cutoff for time in times):
            excluded.append({"trace_id": identity, "reason": "record_after_cutoff"})
        elif successful and max(successful) + timedelta(days=7) > cutoff:
            excluded.append({"trace_id": identity, "reason": "long_evaluation_maturity_not_reached"})
        else:
            selected.append(trace)
    if not selected:
        print(json.dumps({"status": "needs_data", "selected_trace_count": 0, "excluded": excluded}))
        return 0
    # Matches the public reproduction's bounded rule path. Ontology labels are queried
    # separately; no draft link can silently turn into executable identity equivalence.
    compile_rules._ACTION_ONTOLOGY_MODE = "off"
    compile_rules._SUPPORT_PROFILE_CONSTRUCTION_MODE = "enabled"
    compile_rules._BUNDLE_PARTICIPATION_MODE = "off"
    compile_rules._STRUCTURAL_SIGNATURE_GRANULARITY_MODE = "frozen_current"
    traces, authority = materialize_evidence_authority(selected)
    evidence = [unit for trace in traces for unit in extract_all(trace)]
    with redirect_stdout(sys.stderr):
        memories, sidecars = compile_rules.compile_all_with_sidecars(traces, evidence, risk_traces=traces)
    transitions = []
    for memory in memories:
        old = memory.get("state") or "draft"
        new, rule_id, transition_evidence = evaluate(memory)
        if old != new:
            transitions.append({"memory_id": memory["memory_id"], "from_state": old, "to_state": new,
                                "rule_id": rule_id, "evidence": transition_evidence})
            memory["state"] = new
    scores = [score_memory(memory) for memory in memories]
    profiles = build_profiles(memories, scores_by_memory_id={row["memory_id"]: row for row in scores})
    for kind, values in [("memory_object", memories), ("evidence_unit", evidence),
                         ("memory_score", scores), ("memory_evidence_profile", profiles)]:
        for value in values:
            errors = validate(value, kind)
            if errors:
                raise ValueError(f"{kind} output validation failed: {errors[:5]}")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    files = {
        "trace_records.authorized.jsonl": traces,
        "evidence_units.jsonl": evidence,
        "memory_objects.jsonl": memories,
        "memory_scores.jsonl": scores,
        "memory_evidence_profiles.jsonl": profiles,
        "state_transitions.jsonl": transitions,
        "support_routing_profiles.jsonl": sidecars.get("support_routing_profiles") or [],
    }
    for name, values in files.items():
        jsonl(output / name, values)
    dump(output / "evidence_authority_manifest.json", authority)
    index = _build_index(memories)
    dump(output / "index.json", index)
    manifest = {
        "package_id": output.name, "package_name": "harness_wireless_rule_compile", "version": "0.1",
        "description": "Local package from pinned ECHO-Mem rules; no calibrated recommendation gate",
        "created_at": datetime.now().astimezone().isoformat(),
        "source": {"dataset": sorted({str(row["source"].get("dataset", "")) for row in selected}),
                   "trace_count": len(traces), "sampled": False, "compile_backend": "rule_v1",
                   "compile_eligibility": "enabled"},
        "stats": _stats(memories, scores), "knowledge_layers": _knowledge_layers(),
        "files": {name.removesuffix(".jsonl"): name for name in files if name != "trace_records.authorized.jsonl"},
        "applicability_index": {key: len(value) for key, value in index["by_issue_type"].items()},
        "checksum": {"algo": "sha256", "manifest_excluded": True, "values": {
            file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in output.iterdir() if file.is_file()}},
        "harness": {"mode": args.mode, "as_of": args.as_of, "compiler_commit": provenance["commit"],
                    "ontology_mode": "off", "calibrated_gate_loaded": False,
                    "evaluation_visibility": "demo" if args.mode == "demo" else "user_declared_visible_at_cutoff",
                    "duplicates_removed": duplicates, "excluded": excluded,
                    "supported_memory_types": ["case_memory", "rca_memory", "strategy_memory", "playbook_memory", "risk_memory", "counter_evidence_memory"]},
    }
    # The public schema expects a dataset label; keep distinct labels in adapter metadata.
    manifest["harness"]["source_datasets"] = manifest["source"]["dataset"]
    manifest["source"]["dataset"] = ";".join(manifest["source"]["dataset"])
    errors = validate(manifest, "memory_package")
    if errors:
        raise ValueError(f"package schema validation failed: {errors[:5]}")
    dump(output / "manifest.json", manifest)
    print(json.dumps({"status": "compiled_local_package", "trace_count": len(traces),
                      "memory_count": len(memories), "memory_type_counts": dict(Counter(row["memory_type"] for row in memories)),
                      "state_counts": dict(Counter(row["state"] for row in memories)),
                      "duplicates_removed": duplicates, "excluded": excluded, "mode": args.mode,
                      "compiler_commit": provenance["commit"], "calibrated_gate_loaded": False}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"status": "invalid_or_unavailable", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
