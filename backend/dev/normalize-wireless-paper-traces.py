"""Normalize archived exporter timestamps while retaining every original value.

Date-only issue dates use the END of the source day, a conservative bound for the
compiler's maturity check. This does not claim an exact original issue time.
"""
import argparse
from datetime import datetime, time, timedelta, timezone
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("input", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--exported-at", required=True)
parser.add_argument("--source-ref", required=True)
args = parser.parse_args()
zone = timezone(timedelta(hours=8))


def normalize(raw):
    text = str(raw).strip()
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        return datetime.combine(datetime.fromisoformat(text).date(), time.max, tzinfo=zone).isoformat(), "day_upper_bound"
    if "/" in text:
        patterns = ["%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%Y/%m/%d %H:%M:%S"]
        parsed = None
        for pattern in patterns:
            try:
                parsed = datetime.strptime(text, pattern)
                if pattern.endswith("%H:%M"):
                    return parsed.replace(second=59, microsecond=999999, tzinfo=zone).isoformat(), "minute_upper_bound"
                break
            except ValueError:
                continue
        if parsed is None: raise ValueError(f"Unsupported source timestamp: {text}")
    else:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=zone)).isoformat(), "reported_datetime"


rows, changes = [], 0
for line in args.input.read_text().splitlines():
    trace = json.loads(line)
    originals = {}
    for section, values, keys in [("ticket", [trace["ticket"]], ["issued_at"]),
        ("actions", trace["actions"], ["issued_at", "exec_at", "rollback_at"])]:
        for i, row in enumerate(values):
            for key in keys:
                if not row.get(key): continue
                original = row[key]
                row[key], precision = normalize(original)
                path = f"{section}.{i}.{key}"
                originals[path] = {"original": original, "normalized": row[key], "precision": precision}
                changes += original != row[key]
    trace["source"]["evaluation_visible_at"] = args.exported_at
    trace["source"]["evaluation_visibility_source_ref"] = args.source_ref + "#manifest.exported_at"
    trace["source"]["timestamp_normalization"] = {"timezone": "+08:00", "slash_dates": "day/month/year",
        "date_only_policy": "conservative end-of-day bound, not an exact issue time", "values": originals}
    rows.append(trace)
args.output.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))
print(json.dumps({"records": len(rows), "timestamp_changes": changes, "output": str(args.output),
    "original_input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest()}))
