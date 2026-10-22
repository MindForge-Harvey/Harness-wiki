import assert from 'node:assert/strict';
import test from 'node:test';
import { groupTaskMessages, taskProgress, citationSources, citationPlan, linkCitations, stripOwnSourceLine } from '../src/lib/task-progress.mjs';

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

test('citations number each turn once and reset on the next user message', () => {
  const messages = [
    { role: 'user', id: 'u1', content: '查制度' },
    tool('lightrag_query_data', { id: 't1', resultText: '引用：/kb/报销制度.pdf、差旅管理办法.docx' }),
    tool('lightrag_query_data', { id: 't2', resultJson: { references: ['差旅管理办法.docx', '发票说明.pdf'] } }),
    tool('kb_status', { id: 't3' }),
    { role: 'assistant', id: 'a1', content: '说明' },
    { role: 'user', id: 'u2', content: '再查一次' },
    { role: 'assistant', id: 'a2', content: '无检索' },
  ];
  const sources = citationSources(messages);
  // 同一轮内跨多次检索去重编号；与检索无关的工具不产生来源，没有检索的轮次不渲染来源区。
  assert.deepEqual(sources.get('a1'), [
    { index: 1, file: '/kb/报销制度.pdf', name: '报销制度.pdf' },
    { index: 2, file: '差旅管理办法.docx', name: '差旅管理办法.docx' },
    { index: 3, file: '发票说明.pdf', name: '发票说明.pdf' },
  ]);
  assert.equal(sources.has('a2'), false);

  const answer = '依据 [[报销制度.pdf]] 与 [[差旅管理办法.docx]] 办理，再次提到 [[报销制度.pdf]]；'
    + '[[不存在的文件.docx]] 保留原文\n\n来源文件：报销制度.pdf';
  // 只列回答真正引用的文件，按首次出现编号；重复引用同一文件不新增编号。
  const plan = citationPlan(answer, sources.get('a1'));
  assert.deepEqual(plan.map(source => [source.index, source.name]),
    [[1, '报销制度.pdf'], [2, '差旅管理办法.docx']]);
  assert.equal(linkCitations(answer, plan, 'a1'),
    '依据 [1](#cite-a1-1) 与 [2](#cite-a1-2) 办理，再次提到 [1](#cite-a1-1)；[[不存在的文件.docx]] 保留原文\n\n来源文件：报销制度.pdf');
  assert.equal(stripOwnSourceLine(answer), '依据 [[报销制度.pdf]] 与 [[差旅管理办法.docx]] 办理，再次提到 [[报销制度.pdf]]；[[不存在的文件.docx]] 保留原文');
  // 回答里没有角标时退回列出本轮全部来源，避免丢失检索依据。
  assert.deepEqual(citationPlan('无角标回答', sources.get('a1')).map(source => source.index), [1, 2, 3]);
  assert.equal(linkCitations('无来源正文 [[报销制度.pdf]]', [], 'a2'), '无来源正文 [[报销制度.pdf]]');
});

test('unhealthy services and rejected writes are distinguished from success', () => {
  assert.equal(taskProgress(tool('kb_status', { resultJson: { ok: false } })).status, 'warning');
  assert.equal(taskProgress(tool('kb_update', { resultJson: { ok: false } })).status, 'error');
});
