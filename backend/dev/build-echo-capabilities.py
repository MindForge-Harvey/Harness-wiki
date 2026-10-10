"""Freeze upstream skills and the two decision consumers at the audited commit."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1] / 'dsh/dsh-wireless'
checkout = Path(sys.argv[1]).resolve()
manifest_path = root / 'resources/manifest.json'
manifest = json.loads(manifest_path.read_text())
commit = manifest['commit']

def read(name):
    return subprocess.check_output(['git', 'show', f'{commit}:{name}'], cwd=checkout)

names = ['wireless-workorder-orchestrator', 'wireless-workorder-intake',
         'wireless-problem-identification', 'wireless-evidence-builder',
         'wireless-root-cause-analysis', 'wireless-solution-decision',
         'wireless-effect-evaluation', 'wireless-knowledge-compiler']
paths = [f'{name}/SKILL.md' for name in names] + [
    'wireless-solution-decision/SHADOW.md', 'prompts/shadow_solution_select.md']
files = []
for name in paths:
    data = read(name)
    files.append({'source_path': name, 'sha256': hashlib.sha256(data).hexdigest(),
                  'content': data.decode()})
target = root / 'resources/echo-skill-corpus.json'
target.write_text(json.dumps({'repository': manifest['repository'], 'commit': commit,
    'scope': 'Upstream skill methods; separate from the reproduction artifact.',
    'files': files}, ensure_ascii=False, indent=2) + '\n')
manifest['resources'][target.name] = {'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

vendor = root / 'vendor/echo_mem'
base = json.loads((vendor / 'source-manifest.json').read_text())
hashes = dict(base['files'])
for name in ['pipeline/selection/__init__.py', 'pipeline/selection/plan_ranker.py',
             'pipeline/selection/action_value_selector.py']:
    data = read('echo-mem-reproducibility/' + name)
    file = vendor / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(data)
    hashes[name] = hashlib.sha256(data).hexdigest()
(vendor / 'decision-source-manifest.json').write_text(json.dumps({
    'repository': manifest['repository'], 'commit': commit,
    'root': 'echo-mem-reproducibility', 'files': hashes}, indent=2) + '\n')
print(json.dumps({'upstream_skill_files': len(files), 'decision_consumers': 2, 'commit': commit}))
