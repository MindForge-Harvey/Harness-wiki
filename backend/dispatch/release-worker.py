"""Bounded JSON bridge to the user's unchanged, stdlib-only release functions."""
import importlib.util
import json
from pathlib import Path
import sys

BASE = Path(__file__).parent / 'vendor' / 'release-v1.3.2'

def load(name):
    spec = importlib.util.spec_from_file_location(name, BASE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

request = json.load(sys.stdin)
operation = request.get('operation')
if operation == 'constraints':
    rules = load('rule_constraint')
    rows = request.get('rows', [])
    if not isinstance(rows, list) or len(rows) > 64:
        raise ValueError('最多处理64项参数')
    result = []
    for row in rows:
        assessed = rules.assess_constraint(row['rule'], f_para=row.get('before'), b_para=row.get('target'))
        headroom = rules.interval_headroom(row['rule'].get('para'), row['rule'].get('rule_scope'), assessed.final_b_para)
        result.append({'id': row['id'], **assessed.to_dict(), 'headroom': vars(headroom) if headroom else None})
elif operation == 'short_review':
    prior = load('prior_round')
    result = {'verdict': prior.classify_short_assess(request.get('assessment')),
              'executionState': prior.exec_state(request.get('execution_feedback')),
              'changes': [{'metric': row['metric'], 'trend': prior.metric_trend(row.get('before'), row.get('after'), row['direction'])}
                          for row in request.get('changes', [])[:64]]}
else:
    raise ValueError('未知的发布包函数')
json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)
