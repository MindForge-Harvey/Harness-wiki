import assert from 'node:assert/strict';
import test from 'node:test';
import { groupTaskMessages, taskProgress } from '../src/lib/task-progress.mjs';

const tool = (name, extra = {}) => ({ role: 'tool', name, status: 'done', args: {}, ...extra });

test('main backend rendered search text and truncated history remain usable', () => {
  const text = 'chunks：\n- [报销制度.pdf] 报销需审批。\n引用：报销制度.pdf\n查询 id：q-test';
  assert.match(taskProgress(tool('lightrag_query_data', { resultText: text })).summaries[0], /报销制度.pdf/);
  assert.equal(taskProgress(tool('lightrag_query_data', { resultText: '{"chunks":[{"content":"truncated' })).status, 'done');
  assert.match(taskProgress(tool('lightrag_query_data', { resultText: '（无命中：实体、关系、chunks 均为空）' })).summaries[0], /未找到/);
});

test('knowledge evidence includes entity-only results without declaring a miss', () => {
  const card = tool('lightrag_query_data', { resultJson: { chunks: [], entities: [{ entity_name: '报销' }], relationships: [] } });
  assert.match(taskProgress(card).summaries[0], /1 个关联实体/);
});

test('source files retain real names across rendered, structured and grouped retrievals', () => {
  const calls = [
    tool('lightrag_query_data', { resultText: '引用：差旅管理办法.docx、财务,报销细则.xlsx\n查询 id：q-test' }),
    tool('lightrag_query_data', { resultJson: { references: ['差旅管理办法.docx', '发票说明.pdf'] } }),
    tool('lightrag_query_data', { resultJson: { data: { references: [{ file_path: '补充说明.pdf' }] } } }),
    tool('lightrag_query_data', { status: 'error', resultText: '引用：失败结果.pdf' }),
  ];
  assert.deepEqual(taskProgress({ ...calls[0], calls }).references,
    ['差旅管理办法.docx', '财务,报销细则.xlsx', '发票说明.pdf', '补充说明.pdf']);
  assert.deepEqual(taskProgress(tool('lightrag_query_data', { resultJson: { entities: [{ entity_name: '报销' }] } })).references, []);
});

test('async document submissions never claim completed ingestion or replacement', () => {
  for (const name of ['kb_ingest', 'kb_update']) {
    const card = tool(name, { resultJson: { ok: true, intent_id: 'intent-test', document: { status: 'pending' } } });
    assert.equal(taskProgress(card).status, 'pending');
    assert.equal(taskProgress({ ...card, status: 'error' }).status, 'error');
  }
  assert.equal(taskProgress(tool('kb_ingest', { resultJson: { document: { status: 'active' } } })).status, 'done');
});

test('repeated searches group within a stage while writes, answers and turns retain order', () => {
  const messages = [
    { role: 'user', content: '查制度' },
    tool('lightrag_query_data', { args: { query: '报销' } }),
    tool('lightrag_query_data', { args: { query: '差旅' } }),
    { role: 'assistant', content: '已有依据' },
    tool('lightrag_query_data', { args: { query: '例外' } }),
    tool('kb_update', { args: { action: 'delete', doc_id: 'a' } }),
    tool('kb_update', { args: { action: 'delete', doc_id: 'b' } }),
    { role: 'user', content: '再查一次' },
    tool('lightrag_query_data'),
  ];
  const grouped = groupTaskMessages(messages);
  assert.equal(grouped.length, 8);
  assert.equal(grouped[1].calls.length, 2);
  assert.equal(grouped[3].calls.length, 1);
  assert.notEqual(grouped[4].args.doc_id, grouped[5].args.doc_id);
});

test('every tool call stays visible while reasoning is not exposed', () => {
  const messages = [
    { role: 'thinking', content: 'internal reasoning' }, tool('skill'), tool('read'),
    tool('read', { status: 'error' }), tool('kb_graph_search', { status: 'interrupted' }),
  ];
  const grouped = groupTaskMessages(messages);
  // 所有工具都展示；连续同名读取合并为一组，失败的调用仍按错误呈现。
  assert.deepEqual(grouped.map(card => card.name), ['skill', 'read', 'kb_graph_search']);
  assert.equal(grouped[1].calls.length, 2);
  assert.equal(taskProgress(grouped[1]).status, 'error');
  assert.equal(taskProgress(grouped[2]).status, 'error');
  assert.ok(!JSON.stringify(grouped).includes('internal reasoning'));
});

test('unhealthy services and rejected writes are distinguished from success', () => {
  assert.equal(taskProgress(tool('kb_status', { resultJson: { ok: false } })).status, 'warning');
  assert.equal(taskProgress(tool('kb_update', { resultJson: { ok: false } })).status, 'error');
});
