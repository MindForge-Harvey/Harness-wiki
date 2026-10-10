"""Read-only adapter: execute frozen ECHO ranker/value selector without LLM calls."""
import hashlib
import json
from pathlib import Path
import sys

vendor = Path(__file__).resolve().parents[1] / 'vendor/echo_mem'
manifest = json.loads((vendor / 'decision-source-manifest.json').read_text())
for name, expected in manifest['files'].items():
    if hashlib.sha256((vendor / name).read_bytes()).hexdigest() != expected:
        raise ValueError(f'ECHO source integrity mismatch: {name}')
sys.path.insert(0, str(vendor))
from pipeline.selection.plan_ranker import rank_memories, memory_candidate_score_breakdown, DEFAULT_RANKER_CONFIG
from pipeline.selection.action_value_selector import select_action_value

request = json.load(sys.stdin)
if request['operation'] == 'rank_candidates':
    entries = request['entries']
    memories = [entry['memory'] for entry in entries]
    ids = {id(entry['memory']): entry['candidate_id'] for entry in entries}
    query = request.get('context') or {}
    root = request.get('root') or {}
    clues = {key: {str(value).strip().lower() for value in values}
             for key, values in (request.get('parameter_clues') or {}).items()}
    ranked = rank_memories(memories, root, clues, query=query)
    result = {'algorithm': 'pipeline/selection/plan_ranker.py:rank_memories',
        'config': DEFAULT_RANKER_CONFIG, 'ranked': [
            {'candidate_id': ids[id(memory)], 'score_breakdown':
             memory_candidate_score_breakdown(memory, root, clues, query=query)}
            for memory in ranked]}
elif request['operation'] == 'adapt_value':
    content = request['memory'].get('content') or {}
    result = {'algorithm': 'pipeline/selection/action_value_selector.py:select_action_value',
        'selection': select_action_value(content.get('value_pattern'),
            observed_changes=content.get('observed_changes'),
            current_parameter_snapshot=request['snapshot'])}
else:
    raise ValueError('unsupported operation')
result['source_commit'] = manifest['commit']
print(json.dumps(result, ensure_ascii=False, allow_nan=False))
