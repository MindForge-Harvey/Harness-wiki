"""Inspect the supplied paper ZIP and build outcome-blind, source-linked evaluation inputs.

No extracted business data is written into the tracked source tree. CSV remains text,
including 19-digit execution IDs. Original traces and outcomes are separate artifacts.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import io
import json
from pathlib import Path
import re
from zipfile import ZipFile

parser = argparse.ArgumentParser()
parser.add_argument("archive", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
csv.field_size_limit(32 * 1024 * 1024)


def write(name, value):
    p = args.output / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def family(issue):
    for name, pattern in [("切换", "切换"), ("接通", "接通|接入"), ("覆盖", "覆盖"),
        ("容量", "负荷|容量|拥塞"), ("速率", "速率|吞吐"), ("保持", "掉线|掉话"), ("干扰", "干扰")]:
        if re.search(pattern, issue):
            return name
    return "其他"


selected, reasons = {}, defaultdict(list)
historical = {}
history_key_counts = Counter()
profiles, hashes = {}, {}
trace_counts = {}
all_ids = {}
ticket_keys, action_keys = Counter(), Counter()
train_keys = set()
with ZipFile(args.archive) as archive:
    root = next(name[:-len("README.md")] for name in archive.namelist() if name.endswith("/README.md"))
    manifest = json.loads(archive.read(root + "manifest.json"))
    checksum_lines = archive.read(root + "SHA256SUMS.txt").decode().splitlines()
    expected_hashes = {line[:64]: line[66:].lstrip("*") for line in checksum_lines if line.strip()}
    expected_hashes = {name: digest for digest, name in expected_hashes.items()}
    schema = json.loads(archive.read(root + "schemas/trace_record.schema.json"))
    import jsonschema
    validator = jsonschema.Draft202012Validator(schema)
    schema_checks = []
    files = [("dev", "data/staged/splits/dev_trace_records.jsonl"),
        ("holdout", "data/staged/splits/holdout_trace_records.jsonl"),
        ("temporal", "data/staged/temporal_extension/post_cutoff_incremental_trace_records.jsonl"),
        ("train", "data/staged/splits/train_trace_records.jsonl")]
    picked_groups, picked_boundary = set(), set()
    for split, filename in files:
        counts = Counter(); categories = {name: Counter() for name in ["issues", "system", "vendor", "exec_state", "long_eval", "short_eval", "outcome"]}
        ids, per_ticket = set(), {}; digest = hashlib.sha256(); dates = []
        with archive.open(root + filename) as handle:
            for index, line in enumerate(handle):
                digest.update(line)
                trace = json.loads(line)
                ticket, actions = trace["ticket"], trace["actions"]
                trace_id = trace["trace_id"]
                counts["traces"] += 1; counts["actions"] += len(actions)
                counts["duplicate_trace_ids"] += trace_id in ids; ids.add(trace_id)
                per_ticket[ticket["id"]] = len(actions)
                ticket_keys.update(key for key, value in ticket.items() if value not in (None, "", []))
                for action in actions:
                    action_keys.update(key for key, value in action.items() if value not in (None, "", []))
                    for name, key in [("exec_state", "exec_state"), ("long_eval", "long_eval_result"), ("short_eval", "short_eval_result")]:
                        categories[name][str(action.get(key))] += 1
                    counts["improvement_label_disagrees_with_long_eval"] += action.get("improvement_result") == "改善" and action.get("long_eval_result") == "long_eval_fail"
                for name, key in [("issues", "primary_issue_type"), ("system", "system"), ("vendor", "vendor")]:
                    categories[name][str(ticket.get(key))] += 1
                categories["outcome"][str(trace.get("aggregate", {}).get("ticket_outcome"))] += 1
                if ticket.get("issued_at"): dates.append(ticket["issued_at"][:10])
                if index < 2 or index % 5000 == 0:
                    errors = list(validator.iter_errors(trace))
                    schema_checks.append({"split": split, "line": index + 1, "trace_id": trace_id,
                        "errors": [e.message for e in errors[:4]]})
                issue = ticket.get("primary_issue_type", "")
                group = (ticket.get("system"), family(issue))
                if split == "dev" and 0 < len(actions) <= 8:
                    if group not in picked_groups and len(picked_groups) < 10:
                        selected[trace_id] = (split, index + 1, trace); reasons[trace_id].append("system_issue_stratum"); picked_groups.add(group)
                    boundaries = []
                    if all(a.get("exec_state") == "exec_failed" for a in actions): boundaries.append("execution_failed")
                    if any(a.get("long_eval_result") == "long_eval_fail" and a.get("improvement_result") == "改善" for a in actions): boundaries.append("conflicting_outcome_labels")
                    if len(actions) >= 4: boundaries.append("multi_action_bundle")
                    for tag in boundaries:
                        if tag not in picked_boundary:
                            selected[trace_id] = (split, index + 1, trace); reasons[trace_id].append(tag); picked_boundary.add(tag)
                if split in ("holdout", "temporal") and 0 < len(actions) <= 5:
                    tag = (split, ticket.get("system"))
                    if tag not in picked_groups and sum(item[0] == split for item in selected.values()) < 2:
                        selected[trace_id] = (split, index + 1, trace); reasons[trace_id].append("additional_split_smoke"); picked_groups.add(tag)
                if split == "train":
                    keys = {(ticket.get("primary_issue_type"), a.get("param_cn_name")) for a in actions
                        if a.get("exec_state") == "exec_success" and a.get("long_eval_result") in ("long_eval_pass", "long_eval_fail")}
                    matches = keys & train_keys
                    if matches and any(history_key_counts[key] < 8 for key in matches) and len(historical) < 180:
                        historical[trace_id] = trace
                        history_key_counts.update(matches)
        hashes[filename] = digest.hexdigest()
        profiles[split] = {**counts, "minimum_issued_at": min(dates), "maximum_issued_at": max(dates),
            **{key: dict(value) for key, value in categories.items()}}
        trace_counts[split] = per_ticket; all_ids[split] = ids
        train_keys = {(tr["ticket"].get("primary_issue_type"), a.get("param_cn_name"))
            for _, _, tr in selected.values() for a in tr["actions"]}
        print(json.dumps({"stage": "trace_profile", "split": split, "traces": counts["traces"], "actions": counts["actions"]}), flush=True)

    csv_rows = defaultdict(list); csv_checks = {}
    target_ids = {tr["ticket"]["id"] for _, _, tr in selected.values()}

    class HashedReader(io.RawIOBase):
        def __init__(self, source): self.source, self.digest = source, hashlib.sha256()
        def readable(self): return True
        def readinto(self, buffer):
            data = self.source.read(len(buffer)); self.digest.update(data); buffer[:len(data)] = data; return len(data)

    for split in ["train", "dev", "holdout"]:
        filename = f"data/raw/{split}.csv"
        raw = archive.open(root + filename); hashing = HashedReader(raw)
        counts = Counter(); nonempty = Counter(); field_values = defaultdict(Counter)
        with io.TextIOWrapper(io.BufferedReader(hashing), encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                counts[row["taskno"]] += 1
                for key in ["para_analysis", "dz_result", "fc_result", "para_short_assess_result", "ticket_long_eval_result"]:
                    if row.get(key):
                        nonempty[key] += 1
                        if len(row[key]) <= 200: field_values[key][row[key]] += 1
                if row["taskno"] in target_ids: csv_rows[row["taskno"]].append(row)
        hashes[filename] = hashing.digest.hexdigest()
        mismatch = [key for key in set(counts) | set(trace_counts[split]) if counts[key] != trace_counts[split].get(key)]
        csv_checks[split] = {"rows": sum(counts.values()), "tickets": len(counts), "csv_jsonl_count_mismatches": len(mismatch),
            "nonempty_fields": dict(nonempty), "compact_values": {k: dict(v.most_common(8)) for k, v in field_values.items()}}
        print(json.dumps({"stage": "csv_reconcile", "split": split, **{k: csv_checks[split][k] for k in ['rows','tickets','csv_jsonl_count_mismatches']}}), flush=True)

    for filename in expected_hashes:
        if filename not in hashes:
            digest = hashlib.sha256()
            with archive.open(root + filename) as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""): digest.update(chunk)
            hashes[filename] = digest.hexdigest()
    checksums = {name: {"expected": expected, "actual": hashes[name], "matches": expected == hashes[name]}
        for name, expected in expected_hashes.items()}
    overlaps = {f"{a}:{b}": len(all_ids[a] & all_ids[b]) for i, a in enumerate(all_ids) for b in list(all_ids)[i+1:]}

    case_facts = []
    for trace in historical.values():
        ticket = trace["ticket"]
        # A single archived trace can contain failed, successful and unevaluated components.
        # Only actual successful actions enter a factual historical case; outcome scope remains bundle.
        actions = [a for a in trace["actions"] if a.get("exec_state") == "exec_success"]
        outcomes = {a.get("long_eval_result") for a in actions} - {None, "long_eval_unknown"}
        if not actions or len(outcomes) != 1: continue
        groups = defaultdict(list)
        for action in actions: groups[(action.get("root_cause_l1"), action.get("root_cause_l2"))].append(action)
        for j, ((cause1, cause2), grouped) in enumerate(groups.items()):
            case_facts.append({"case_id": f"{trace['trace_id']}-group-{j}", "source_ref": f"{args.archive.name}#train/{trace['trace_id']}",
                "taskno": ticket["id"], "problem_type": ticket.get("primary_issue_type"), "cause1": cause1 or "", "cause2": cause2 or "",
                "estimate_result": "改善" if outcomes == {"long_eval_pass"} else "恶化", "created": ticket.get("issued_at"),
                "vendor": ticket.get("vendor"), "nettype": ticket.get("system"), "city": ticket.get("region"),
                "outcome_scope": "archived_trace_successfully_executed_bundle",
                "actions": [{"parameter": a.get("param_cn_name"), "before": a.get("before_value"), "after": a.get("after_value")} for a in grouped]})

    index = []
    for number, (trace_id, (split, line, trace)) in enumerate(selected.items(), 1):
        ticket = trace["ticket"]
        raw_rows = csv_rows[ticket["id"]]
        if split == "temporal":
            # The extension has no raw CSV in this package: stable local trace action identity is explicit.
            raw_rows = [{"execution_id": a["action_id"], "plan_number": a.get("scheme_id"), "execute_number": a.get("exec_id"),
                "parachinname": a.get("param_cn_name"), "f_para": a.get("before_value"), "b_para": a.get("after_value"),
                "type1": a.get("root_cause_l1"), "type2": a.get("root_cause_l2"), "para": a.get("value_rule"),
                "rule_scope": a.get("adjustment_rule"), "band": ticket.get("band")} for a in trace["actions"]]
        source_ref = f"{args.archive.name}#{split}/{trace_id}"
        plans = [{k: r[k] for k in ['execution_id','plan_number','execute_number','parachinname','f_para','b_para','type1','type2','band'] if r.get(k)} for r in raw_rows]
        rules = [{**{k: r.get(k, "") for k in ['type1','type2','parachinname','execute_number','band','para','rule_scope']},
            "nettype": {"LTE":"4g","NR":"5g"}.get(ticket.get("system"),ticket.get("system")), "vendor": ticket.get("vendor"), "is_use": "是"} for r in raw_rows]
        relevant_cases = [c for c in case_facts if c["taskno"] != ticket["id"] and c["problem_type"] == ticket.get("primary_issue_type")
            and any(a["parameter"] in {p["parachinname"] for p in plans} for a in c["actions"])][:80]
        blind = {"source_ref": source_ref, "order": {"taskno": ticket["id"], "task_type": ticket.get("primary_issue_type"),
            "cell_name": ticket.get("cell_name"), "cgi": ticket.get("cell_id"), "eci": ticket.get("eci"),
            "nettype": {"LTE":"4g","NR":"5g"}.get(ticket.get("system"),ticket.get("system")),
            "vendor": ticket.get("vendor"), "city": ticket.get("region"), "band": ticket.get("band"), "createtime": ticket.get("issued_at")},
            "initial_plans": plans, "rules": rules, "cases": relevant_cases}
        slug = f"case-{number:02d}"
        write(f"inputs/{slug}.json", blind)
        write(f"feedback/{slug}.json", {"trace_id": trace_id, "source_ref": source_ref, "ticket": ticket,
            "actions": trace["actions"], "aggregate": trace.get("aggregate"), "csv_execution_rows": raw_rows})
        write(f"traces/{slug}.json", trace)
        index.append({"case": slug, "trace_id": trace_id, "split": split, "line": line, "issue": ticket.get("primary_issue_type"),
            "system": ticket.get("system"), "actions": len(plans), "historical_cases": len(relevant_cases), "selection_reasons": reasons[trace_id],
            "input_file": str((args.output / f"inputs/{slug}.json").resolve()),
            "feedback_file": str((args.output / f"feedback/{slug}.json").resolve())})
    train_file = args.output / "train-history.jsonl"
    train_file.write_text("".join(json.dumps(r, ensure_ascii=False)+"\n" for r in historical.values()))
    archive_hash = hashlib.sha256()
    with args.archive.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024*1024),b""): archive_hash.update(chunk)
    write("profile.json", {"archive": str(args.archive), "archive_sha256": archive_hash.hexdigest(), "profiles": profiles,
        "csv_reconciliation": csv_checks, "cross_split_overlaps": overlaps, "checksums": checksums,
        "sampled_schema_checks": schema_checks, "ticket_nonempty_keys": dict(ticket_keys), "action_nonempty_keys": dict(action_keys),
        "selection_policy": "bounded functionality/edge-case coverage; not a representative accuracy sample",
        "history_traces": len(historical), "compiled_history_candidate_file": str(train_file.resolve()),
        "dataset_exported_at": manifest["exported_at"], "missing_predecision_fields": ["conclusion", "smart_conclusion", "six_dimension_verdicts", "KPI/MR time series"],
        "leakage_controls": "Target feedback is stored separately; target outcomes and failure reasons are absent from inputs. Action after_value is replayed as the recorded historical proposal, not treated as an unseen predicted action. History uses train only; target IDs are excluded."})
    write("cases.json", index)
    print(json.dumps({"status":"prepared","selected_cases":len(index),"history_traces":len(historical),
        "checksum_failures":sum(not r["matches"] for r in checksums.values()),"schema_failures":sum(bool(r['errors']) for r in schema_checks),
        "output":str(args.output)},ensure_ascii=False),flush=True)
