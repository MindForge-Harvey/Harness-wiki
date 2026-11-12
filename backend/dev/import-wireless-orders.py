"""Index the supplied workorder archive without changing its business records."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from zipfile import ZipFile

VERSION = 2


def import_archive(archive, target):
    archive, target = Path(archive).resolve(), Path(target).resolve()
    stat = archive.stat()
    fingerprint = f"{VERSION}:{stat.st_size}:{stat.st_mtime_ns}"
    if target.exists():
        with sqlite3.connect(target) as db:
            try:
                meta = json.loads(db.execute("SELECT value FROM metadata WHERE key='catalog'").fetchone()[0])
                if meta.get("fingerprint") == fingerprint:
                    return {**meta, "reused": True}
            except (sqlite3.Error, TypeError, ValueError):
                pass
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".building.sqlite")
    temporary.unlink(missing_ok=True)
    db = sqlite3.connect(temporary)
    try:
        db.executescript("""
          PRAGMA journal_mode=OFF;
          PRAGMA synchronous=OFF;
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE tickets (
            ticket_id TEXT PRIMARY KEY, trace_id TEXT UNIQUE NOT NULL,
            issued_at TEXT, issue TEXT, system TEXT, vendor TEXT, region TEXT,
            cell_name TEXT, cell_id TEXT, eci TEXT, split TEXT,
            action_count INTEGER, outcome TEXT, detail TEXT NOT NULL
          );
        """)
        months, issues, systems, vendors, regions, splits = (Counter() for _ in range(6))
        actions_total, dates, batch = 0, [], []
        action_keys = ("action_id", "exec_id", "param_exec_id", "param_object", "param_en_name",
            "param_cn_name", "before_value", "after_value", "value_rule", "adjustment_rule",
            "scheme_id", "scheme_group", "scheme_desc", "root_cause_l1", "root_cause_l2", "operation_summary", "operation_detail",
            "verbal_desc", "issued_state", "issued_at", "exec_state", "exec_at", "exec_failure_reason",
            "rollback_state", "short_eval_result", "long_eval_result", "improvement_result")
        with ZipFile(archive) as source:
            members = [name for name in source.namelist() if name.endswith("_trace_records.jsonl") and
                ("/splits/" in name or "/temporal_extension/" in name)]
            if not members:
                raise ValueError("归档内没有可识别的工单 TraceRecord")
            for member in members:
                split = "temporal" if "/temporal_extension/" in member else member.rsplit("/", 1)[-1].split("_")[0]
                with source.open(member) as handle:
                    for line in handle:
                        trace = json.loads(line)
                        ticket = trace["ticket"]
                        ticket_id = str(ticket["id"])
                        issued = (ticket.get("issued_at") or "")[:10]
                        normalized_actions = []
                        for original in trace.get("actions", []):
                            action = {key: original.get(key) for key in action_keys if original.get(key) is not None}
                            action["recorded_target"] = original.get("after_value")
                            action["actual_after"] = original.get("after_value") if original.get("exec_state") == "exec_success" else None
                            action["effect_scope"] = "归档工单组合评价，不能归因到单个参数"
                            normalized_actions.append(action)
                        aggregate = trace.get("aggregate") or {}
                        detail = {"ticket": ticket, "actions": normalized_actions, "aggregate": aggregate,
                            "source_ref": f"{archive.name}#{member}:{trace['trace_id']}", "trace_id": trace["trace_id"], "split": split}
                        batch.append((ticket_id, trace["trace_id"], issued, ticket.get("primary_issue_type"),
                            ticket.get("system"), ticket.get("vendor"), ticket.get("region"), ticket.get("cell_name"),
                            ticket.get("cell_id"), ticket.get("eci"), split, len(normalized_actions),
                            aggregate.get("ticket_outcome"), json.dumps(detail, ensure_ascii=False, separators=(",", ":"))))
                        months[issued[:7]] += 1
                        issues[ticket.get("primary_issue_type") or "未记录"] += 1
                        systems[ticket.get("system") or "未记录"] += 1
                        vendors[ticket.get("vendor") or "未记录"] += 1
                        regions[ticket.get("region") or "未记录"] += 1
                        splits[split] += 1
                        actions_total += len(normalized_actions)
                        if issued: dates.append(issued)
                        if len(batch) >= 1000:
                            db.executemany("INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", batch)
                            batch.clear()
            if batch: db.executemany("INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", batch)
        db.executescript("""
          CREATE INDEX tickets_date ON tickets(issued_at DESC, ticket_id);
          CREATE INDEX tickets_issue_date ON tickets(issue, issued_at DESC);
          CREATE INDEX tickets_region_date ON tickets(region, issued_at DESC);
          CREATE INDEX tickets_cell ON tickets(cell_id);
          CREATE INDEX tickets_eci ON tickets(eci);
        """)
        total = db.execute("SELECT COUNT(*) FROM tickets").fetchone()[0]
        meta = {"version": VERSION, "fingerprint": fingerprint, "source": archive.name,
            "imported_at": datetime.now(timezone.utc).isoformat(), "total_tickets": total,
            "total_actions": actions_total, "date_range": {"from": min(dates), "to": max(dates)},
            "months": dict(sorted(months.items())), "issues": dict(issues.most_common()),
            "systems": dict(systems), "vendors": dict(vendors), "regions": dict(regions), "splits": dict(splits),
            "available": True}
        db.execute("INSERT INTO metadata VALUES ('catalog', ?)", (json.dumps(meta, ensure_ascii=False),))
        db.commit()
        db.close()
        temporary.replace(target)
        return meta
    finally:
        db.close()
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("database")
    args = parser.parse_args()
    print(json.dumps(import_archive(args.archive, args.database), ensure_ascii=False))
