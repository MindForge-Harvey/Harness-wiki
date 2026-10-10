import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { presentNotification, projectHistory } from '../harness/presentation.mjs'
import { plainAssistantText } from '../harness/narrative.mjs'
import { echoQuery, echoTopics } from '../dsh/dsh-wireless/lib/echo.js'
import { createWorkorderStore } from '../dsh/dsh-wireless/lib/workflow.js'
import { parameterCheck } from '../dsh/dsh-wireless/lib/catalog.js'
import { groupTaskMessages, taskProgress } from '../../frontend/src/lib/task-progress.mjs'

test('live and historical browser projections omit raw reasoning without changing SDK context or requested technical details', () => {
  const event = { type: 'assistant/message', seq: 1, data: { message: { content: [
    { type: 'reasoning', text: 'PRIVATE_REASONING_SENTINEL' },
    { type: 'text', text: '用户要求的实现说明：state.py' },
  ] } } };
  const notification = { method: 'session.event', params: { sessionId: 's', event } };
  const before = structuredClone(notification);
  assert.ok(!JSON.stringify(presentNotification(notification)).includes('PRIVATE_REASONING_SENTINEL'));
  assert.equal(presentNotification(notification).params.event.data.message.content[0].text, '用户要求的实现说明：state.py');
  assert.deepEqual(notification, before);
  assert.deepEqual(projectHistory([event]).map(e => e.kind), ['assistant']);
  assert.ok(!JSON.stringify(projectHistory([event])).includes('PRIVATE_REASONING_SENTINEL'));
});

test('Chinese explanatory asides become sentences consistently while evidence values and technical notation remain intact', () => {
  const original = 'QRxLevMin 从 -64 调到 -62（这些数值沿用历史记录的编码，材料未提供物理单位口径），同时把 SNonIntraSearch 从 25 调到 27。整单评价通过，不能归给单个动作。';
  const displayed = plainAssistantText(original);
  assert.ok(!/[（）]/.test(displayed));
  for (const fact of ['-64', '-62', '25', '27', '整单评价通过，不能归给单个动作', '这些数值沿用历史记录的编码，材料未提供物理单位口径']) assert.ok(displayed.includes(fact));
  const event = { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: original }] } } };
  assert.equal(presentNotification({ params: { event } }).params.event.data.message.content[0].text, displayed);
  assert.equal(projectHistory([event])[0].text, displayed);
  assert.equal(event.data.message.content[0].text, original);
  assert.equal(plainAssistantText(displayed), displayed);
  const technical = '`配置（源编码单位尚未明确，不应转换）`\n```python\nprint("这些括号（是代码原文不能重新排版）")\n```\n$指标（a+b 的公式内容不能重新排版）$\n| 参数 | 值（这是表格原文的说明不能重新排版） |\n> 原文引用。说明（这段内容是直接引文，不应重新排版）。\n计算规则为指标（参考均值 = a+b，必须保留公式分组）。';
  assert.equal(plainAssistantText(technical), technical);
});

test('history keeps structured results larger than the text preview and marks unfinished stages honestly', () => {
  const result = { padding: '长'.repeat(4500), guides: [{ title: '多参数改善怎样归因' }] };
  const history = projectHistory([
    { type: 'tool/call', data: { callId: 'a', name: 'wireless_echo_query', arguments: '{}' } },
    { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'a', content: [{ type: 'text', text: JSON.stringify(result) }] }] } } },
    { type: 'tool/call', data: { callId: 'b', name: 'wireless_case_search', arguments: '{}' } },
    { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '断开' } } } },
  ]);
  assert.equal(history[0].resultText.length, 4000);
  assert.deepEqual(history[0].resultJson, result);
  assert.equal(history[1].status, 'interrupted');
  assert.equal(taskProgress({ ...history[1], args: {} }).status, 'error');
});

test('repeated mechanism queries form one stage per turn, while failed calls and distinct workorders stay distinguishable', () => {
  const call = (id, status) => ({ id, role: 'tool', name: 'wireless_echo_query', status, args: {},
    resultJson: echoQuery({ topic: 'authority' }) });
  const messages = [{ id: 'u', role: 'user' }, { role: 'thinking', content: 'PRIVATE' },
    { role: 'tool', name: 'skill', status: 'done' }, call('a', 'done'), call('b', 'error'),
    { id: 'u2', role: 'user' }, call('c', 'done')];
  const grouped = groupTaskMessages(messages);
  assert.equal(grouped.length, 4);
  assert.equal(grouped[1].calls.length, 2);
  assert.equal(taskProgress(grouped[1]).status, 'error');
  assert.equal(taskProgress(grouped[3]).status, 'done');
  assert.ok(grouped[1].calls[0].resultJson.guides[0].references.length > 0); // Sources stay in agent evidence, outside presentation.
  const orders = ['wo_a', 'wo_b'].map(id => ({ role: 'tool', name: 'wireless_workorder', status: 'done', args: { operation: 'intake', workorder_id: id } }));
  assert.equal(groupTaskMessages(orders).length, 2);
  assert.equal(messages.length, 7); // Presentation does not mutate underlying events.
});

test('progress uses actual domain outcomes: persisted drafts and successful tool calls are not completed optimization', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-presentation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const run = createWorkorderStore({ directory });
  const record = run({ operation: 'intake', input: { raw_text: '某小区低速率' } });
  const progress = (operation, result) => taskProgress({ name: 'wireless_workorder', status: 'done', args: { operation }, resultJson: result });
  assert.equal(progress('intake', record).status, 'needs_data');
  const classified = run({ operation: 'identify', workorder_id: record.workorder_id });
  assert.match(progress('identify', classified).summaries[0], /低速率.*根因仍需验证/);
  const evidence = run({ operation: 'build_evidence', workorder_id: record.workorder_id, input: {} });
  assert.equal(progress('build_evidence', evidence).status, 'needs_data');
  const evaluated = run({ operation: 'evaluate', workorder_id: record.workorder_id, input: {} });
  assert.equal(progress('evaluate', evaluated).status, 'needs_data');
  const args = { parameter: '模拟开关', current: 0, target: 1, enum_values: [0, 1], unit: '模拟编码', constraint_source: '用户声明' };
  const checked = taskProgress({ name: 'wireless_parameter_check', status: 'done', resultJson: parameterCheck(args) });
  assert.equal(checked.status, 'done');
  assert.match(checked.summaries[0], /尚未执行/);
  assert.equal(taskProgress({ name: 'wireless_parameter_check', status: 'done', resultJson: parameterCheck({ ...args, target: 2 }) }).status, 'warning');
});

test('default ECHO answers expose useful mechanisms and illustrative examples, with explicit implementation access retained', () => {
  for (const topic of echoTopics) {
    const result = echoQuery({ topic: topic.id });
    assert.equal(result.view, 'knowledge');
    assert.equal(result.passages, undefined);
    assert.ok(result.guides[0].explanation && result.guides[0].example && result.guides[0].application);
    assert.ok(result.guides[0].references.every(r => r.url.includes('/blob/') && !r.source_path));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
  const knowledge = echoQuery({ topic: 'authority' }).guides[0];
  assert.match(knowledge.explanation, /不能给每个参数各记一次成功/);
  assert.match(knowledge.example, /假设/);
  assert.match(echoQuery({ topic: 'compilation' }).guides[0].explanation, /组合本身不证明操作顺序/);
  assert.equal(echoQuery({ topic: 'scoring' }).runtime, undefined);
  assert.ok(echoQuery({ query: '目前能实际执行和记录什么？' }).runtime);
  assert.ok(echoQuery({ topic: 'authority', view: 'implementation' }).passages.some(p => p.text.includes('single-action')));
});
