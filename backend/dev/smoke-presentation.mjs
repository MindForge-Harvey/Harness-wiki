/** Live provider checks: validate knowledge answers, stage outcomes and the browser boundary. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { groupTaskMessages, taskProgress } from '../../frontend/src/lib/task-progress.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3088';
const stamp = Date.now(), directory = path.join(root, '.run/presentation-smoke', String(stamp));
fs.mkdirSync(directory, { recursive: true });
const results = [];
async function chat(name, message) {
  const sessionId = `presentation-${stamp}-${name}`;
  const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }), signal: AbortSignal.timeout(240000) });
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n\n').filter(Boolean).map(block => ({
    event: block.match(/^event: (.+)/)?.[1], data: JSON.parse(block.match(/\ndata: (.+)/)?.[1] || '{}') }));
  assert.ok(!events.some(item => item.event === 'error'));
  const done = events.find(item => item.event === 'done'); assert.ok(done);
  const assistantEvents = events.map(e => e.data?.params?.event).filter(e => e?.type === 'assistant/message');
  assert.ok(assistantEvents.every(e => e.data.message.content.every(b => b.type !== 'reasoning')));
  const history = await (await fetch(base + '/api/chat/history?sessionId=' + encodeURIComponent(sessionId))).json();
  assert.ok(!history.events.some(e => e.kind === 'thinking'));
  const calls = history.events.filter(e => e.kind === 'tool');
  assert.ok(!calls.some(e => e.status === 'error'), name + ': unexpected tool error');
  const messages = history.events.map(e => ({ ...e, role: e.kind,
    args: e.kind === 'tool' ? JSON.parse(e.argsText || '{}') : {} }));
  const stages = groupTaskMessages(messages).filter(e => e.role === 'tool').map(taskProgress);
  const result = { name, sessionId, message, answer: done.data.finalResponse, stages, tools: calls.map(e => ({ name: e.name, args: JSON.parse(e.argsText || '{}') })) };
  results.push(result);
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  return result;
}
const principles = await chat('principles', 'ECHO-Mem 为什么要把经验分成六类？多个参数一起改后效果变好，能说每个参数都有效吗？只有一次成功的经验该怎么用？');
assert.ok(principles.tools.some(e => e.name === 'wireless_echo_query'));
assert.ok(principles.tools.filter(e => e.name === 'wireless_echo_query').every(e => e.args.view !== 'implementation' && !e.args.source_path));
assert.ok(!/\.py\b|\.schema\.json|source_path|raw_pass_rate|credibility_lcb|trace_ids|#L\d|\b(?:CaseMemory|EvidenceUnit|TraceRecord|unverified|validated)\b/.test(principles.answer), 'answer leaked implementation detail');
assert.match(principles.answer, /案例/); assert.match(principles.answer, /反证|失败/);
assert.match(principles.answer, /不能|不等于|无法/); assert.match(principles.answer, /样本|不确定|保守/);
assert.equal(principles.stages.filter(s => s.title === '梳理经验复用机制').length, 1);
// Count persisted reasoning without exposing its text. Qwen thinking is disabled on the wire.
const journalRoot = path.join(root, 'backend/.runtime/dsh-home/sessions');
let reasoningBlocks = 0;
for (const workspace of fs.readdirSync(journalRoot)) {
  const folder = path.join(journalRoot, workspace, principles.sessionId);
  const compressed = path.join(folder, 'session.v3.jsonl.zstd'), plain = path.join(folder, 'session.v3.jsonl');
  const source = fs.existsSync(compressed) ? execFileSync('zstd', ['-dc', compressed], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : fs.existsSync(plain) ? fs.readFileSync(plain, 'utf8') : '';
  for (const line of source.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === 'assistant/message') reasoningBlocks += (event.data?.message?.content || []).filter(b => b.type === 'reasoning').length;
  }
}
assert.equal(reasoningBlocks, 0, 'provider still emitted reasoning despite the disabled mode');
console.log(JSON.stringify({ reasoningBlocks, rawReasoningExposedToBrowser: false }));
const incomplete = await chat('incomplete', `下面是模拟工单 SIM-PRESENTATION-${stamp}，华为 LTE 小区 SIM-C1，忙时下载慢；软件版本、时间窗口和当前指标还没拿到。请先接入工单，识别问题类型，给我初步排查建议。`);
assert.ok(incomplete.stages.some(s => s.title === '接入工单' && s.status === 'needs_data'));
assert.ok(!/优化已完成|已下发|已经改善/.test(incomplete.answer));
console.log('Presentation live checks passed: ' + directory);
