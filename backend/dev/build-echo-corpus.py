"""Freeze tracked ECHO-Mem text from the audited commit; never read private/run files.

Usage: python3 backend/dev/build-echo-corpus.py /path/to/wireless_knowledge_compilation
The research checkout is only needed to rebuild this deployment asset.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

resources = Path(__file__).resolve().parents[1] / "dsh/dsh-wireless/resources"
manifest_path = resources / "manifest.json"
manifest = json.loads(manifest_path.read_text())
checkout = Path(sys.argv[1]).resolve()
commit = manifest["commit"]
prefix = "echo-mem-reproducibility/"
paths = subprocess.check_output(
    ["git", "ls-tree", "-r", "--name-only", "-z", commit, "--", prefix], cwd=checkout
).decode().split("\0")
files = []
for name in sorted(paths):
    if not name or Path(name).suffix not in {".md", ".py", ".json", ".jsonl"}:
        continue
    content = subprocess.check_output(["git", "show", f"{commit}:{name}"], cwd=checkout)
    files.append({"source_path": name, "sha256": hashlib.sha256(content).hexdigest(),
                  "content": content.decode("utf-8")})
corpus = {"repository": manifest["repository"], "commit": commit, "files": files,
          "scope": "Tracked source text only; source code/expected results are not runtime execution claims."}
output = resources / "echo-corpus.json"
output.write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + "\n")
manifest["resources"][output.name] = {"sha256": hashlib.sha256(output.read_bytes()).hexdigest()}
manifest["scope"] = "无线参数语义、案例和研究经验，以及 ECHO-Mem 固定提交的完整已跟踪文本语料；非全量生产历史库。"
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"source_files": len(files), "bytes": output.stat().st_size, "commit": commit}))
