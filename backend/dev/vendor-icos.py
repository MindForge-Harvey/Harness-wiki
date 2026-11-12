"""Freeze only the ICOS decision kernels and their domain assets, never runtime config/data."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path, help="network-ops-loop-v3 source directory")
args = parser.parse_args()
target = Path(__file__).resolve().parents[1] / "dsh/dsh-wireless/vendor/icos"
files = [*args.source.glob("services/decision/*.py")]
files += [args.source / name for name in [
    "services/common/text_utils.py", "services/common/config.py", "services/common/logging.py",
    "services/compliance/rule_constraint.py", "services/compliance/rule_library.py",
    "services/compliance/assets/sys_cell_execute_jiangsu.csv",
    "services/compliance/assets/rule_type2_fallback.yaml",
    "services/cases/vocab.py", "services/cases/assets/case_vocab.yaml",
    "services/prompts/registry.py", "services/prompts/__init__.py",
    "services/orders/task_type_replace.csv",
]]
files += [args.source / f"services/prompts/assets/{name}.yaml" for name in [
    "cause_convergence", "cause_alignment", "relevance", "order_review",
]]
hashes = {}
for source in sorted(files):
    relative = source.relative_to(args.source)
    destination = target / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    hashes[str(relative)] = hashlib.sha256(source.read_bytes()).hexdigest()
for directory in ["services", "services/common", "services/compliance", "services/cases"]:
    (target / directory / "__init__.py").write_text("", encoding="utf-8")
(target / "source-manifest.json").write_text(json.dumps({
    "source_project": "wireless-network-optimizaton-agent/network-ops-loop-v3",
    "snapshot_date": "2026-11-11",
    "revision": "local-source-snapshot-no-git-metadata",
    "files": hashes,
    "integration": "Unmodified decision kernels; Harness supplies model judgments and bounded input snapshots. No original workers, database clients, LLM gateway, or ICOS push service are bundled.",
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(target / "NOTICE.txt").write_text(
    "ICOS decision kernels copied from the user's local wireless-network-optimizaton-agent project.\n"
    "Original source files are unchanged and SHA-256 pinned in source-manifest.json.\n"
    "Runtime integration is maintained separately in worker/icos.py and lib/icos.js.\n"
    "No credentials, production configuration, customer workorders, or database dumps are included.\n",
    encoding="utf-8",
)
print(json.dumps({"files": len(hashes), "destination": str(target)}))
