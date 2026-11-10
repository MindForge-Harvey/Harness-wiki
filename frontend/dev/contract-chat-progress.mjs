import assert from 'node:assert/strict';
import test from 'node:test';
import { groupTaskMessages, taskProgress, citationSources, citationPlan, linkCitations, stripOwnSourceLine, groupConversation, runningText, isDocGenCommand, docStageStatus, argBrief, runHeadline } from '../src/lib/task-progress.mjs';

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

test('generate-document skill keeps own label, doc stage covers content file and command', () => {
  const messages = [
    { role: 'user', id: 'u1', content: '生成一份报销说明 Word' },
    tool('lightrag_query_data', { id: 't1', args: { query: '报销' }, resultText: '引用：报销制度.pdf' }),
    tool('skill', { id: 's1', args: { name: 'generate-document' } }),
    tool('write', { id: 't2', args: { file_path: '/tmp/报销说明.md' } }),
    tool('bash', {
      id: 't3',
      args: { command: 'bash backend/scripts/run_docgen.sh python3 backend/scripts/generate_document.py --format=docx --output=报销说明.docx --content-file=/tmp/报销说明.md' },
    }),
    { role: 'assistant', id: 'a1', content: '文档已生成' },
  ];
  const steps = groupConversation(messages).find(item => item.role === 'process').steps;
  // 现在 skill 独立一条：加载技能 generate-document；
  // write + bash 合并成一条：生成文档（文档已生成）。
  assert.deepEqual(steps.map(step => step.role), ['tool', 'tool', 'tool']);
  assert.equal(steps[1].calls[0].name, 'skill');
  assert.equal(argBrief(steps[1].calls[0]), 'generate-document');
  assert.equal(taskProgress(steps[2]).title, '生成文档');
  assert.equal(taskProgress(steps[2]).status, 'done');
  assert.equal(taskProgress(steps[2]).summaries[0], '文档已生成');
  assert.equal(runningText({ name: 'skill', args: { name: 'generate-document' }, status: 'running' }),
    '正在执行文档生成技能，请稍候…');
});

test('document completion waits for the wrapped generation command', () => {
  const command = 'bash backend/scripts/run_docgen.sh python3 backend/scripts/generate_document.py --format=pdf --output=a.pdf --content-file=/tmp/a.md';
  assert.equal(isDocGenCommand(command), true);
  assert.equal(taskProgress(tool('bash', { args: { command } })).title, '生成文档');
  const stage = groupConversation([
    { role: 'user', id: 'u2', content: '生成 PDF' },
    tool('skill', { id: 's2', args: { name: 'generate-document' } }),
    tool('write', { id: 't4', args: { file_path: '/tmp/a.md' } }),
    tool('bash', { id: 't5', status: 'running', args: { command } }),
  ]).find(item => item.role === 'process').steps.at(-1);
  // 命令还在跑：过程块保持进行中，不能提前说「文档已生成」。
  assert.equal(taskProgress(stage).status, 'running');
  assert.ok(!taskProgress(stage).summaries.includes('文档已生成'));
});

test('self-written script marks document done for both step and header', () => {
  // 模型自写脚本（未走 run_docgen.sh）时，步骤和顶部必须用同一个完成判定。
  const stage = groupConversation([
    { role: 'user', id: 'u3', content: '生成 HTML 演示稿' },
    tool('skill', { id: 's3', args: { name: 'generate-document' } }),
    tool('bash', { id: 't6', status: 'done', args: { command: "python3 - <<'EOF'\nprint('hi')\nEOF" } }),
  ]).find(item => item.role === 'process').steps.at(-1);
  const progress = taskProgress(stage);
  assert.equal(progress.title, '生成文档');
  assert.equal(progress.status, 'done');
  assert.equal(progress.docGenDone, true);
  assert.equal(progress.summaries[0], '文档已生成');
});

test('merged work step without doc markers still counts as document stage', () => {
  // 没有 skill 调用时，写脚本→查资料→跑脚本会被收成一整条产出步骤，
  // 只留下 _workTitle='生成文档'。顶部按标题取状态，才能和步骤显示一致。
  const steps = groupConversation([
    { role: 'user', id: 'u4', content: '生成一份说明文档' },
    tool('bash', { id: 'b1', args: { command: 'python3 gen_doc.py' } }),
    tool('read', { id: 'r1', args: { file_path: '/tmp/out.md' } }),
    tool('bash', { id: 'b2', args: { command: 'python3 gen_doc.py' } }),
  ]).find(item => item.role === 'process').steps;
  const stage = steps.at(-1);
  assert.equal(stage._workTitle, '生成文档');
  assert.ok(!stage._docGen && !stage._docGenSkill);
  const progress = taskProgress(stage);
  assert.equal(progress.title, '生成文档');
  assert.equal(progress.docGenDone, true);
  assert.equal(progress.summaries[0], '文档已生成');
  // 运行中同样复用同一句文案，顶部不会退化成「正在执行命令」。
  assert.equal(runningText({ ...stage, calls: stage.calls.map(c => ({ ...c, status: 'running' })) }),
    '正在生成文档，请稍候…');
});

test('document stage stays active during model thinking gaps between tool calls', () => {
  // skill 独立一条，之后的思考间隙没有「生成文档」步骤 → docStageStatus 返回 null
  // （过程卡片退回「正在思考与分析」是合理的，因为模型还没真正开始生成文档）。
  const afterSkillGap = groupConversation([
    { role: 'user', id: 'u5', content: '做成 PPT 风格 HTML' },
    tool('lightrag_query_data', { id: 'q1', args: { query: '员工手册' } }),
    tool('skill', { id: 's4', args: { name: 'generate-document' } }),
    { role: 'thinking', id: 'th1', text: '接下来写内容文件' },
  ]).find(item => item.role === 'process').steps;
  assert.equal(docStageStatus(afterSkillGap), null);

  // 真正进入文档生成阶段（write + bash 合并块）之后的思考间隙 → 保持活动。
  const midGenGap = groupConversation([
    { role: 'user', id: 'u5b', content: '做成 PPT 风格 HTML' },
    tool('skill', { id: 's4b', args: { name: 'generate-document' } }),
    tool('write', { id: 'w1', args: { file_path: '/tmp/content.md' } }),
    { role: 'thinking', id: 'th2', text: '接下来跑转换' },
  ]).find(item => item.role === 'process').steps;
  assert.deepEqual(docStageStatus(midGenGap), { done: false, label: '正在生成文档，请稍候…' });

  // 文档命令跑完后才是「文档已生成」。
  const done = groupConversation([
    { role: 'user', id: 'u6', content: '做成 PPT 风格 HTML' },
    tool('skill', { id: 's5', args: { name: 'generate-document' } }),
    tool('bash', { id: 'b3', args: { command: 'bash backend/scripts/run_docgen.sh python3 backend/scripts/generate_document.py --format=html' } }),
  ]).find(item => item.role === 'process').steps;
  assert.deepEqual(docStageStatus(done), { done: true, label: '文档已生成' });
  // 文档步骤还没完成就又去检索，说明已离开文档阶段，不再占用状态文案。
  const left = groupConversation([
    { role: 'user', id: 'u7', content: '先加载技能再检索' },
    tool('skill', { id: 's6', args: { name: 'generate-document' } }),
    tool('lightrag_query_data', { id: 'q2', args: { query: '报销' } }),
  ]).find(item => item.role === 'process').steps;
  assert.equal(docStageStatus(left), null);
});

test('running doc step keeps a single running summary and never claims completion mid-run', () => {
  // 铁律②：生成命令已成功、又补跑命令（图片重试场景）时整步仍在运行，
  // 摘要必须固定为「正在生成文档，请稍候…」，绝不出现「文档已生成」。
  const steps = groupConversation([
    { role: 'user', id: 'u10', content: '生成 word' },
    tool('skill', { id: 'sk10', args: { name: 'generate-document' } }),
    tool('write', { id: 'w10', args: { file_path: '/tmp/gen_doc.py' } }),
    tool('bash', { id: 'b10', args: { command: 'python3 /tmp/gen_doc.py' } }),
    tool('bash', { id: 'b11', status: 'running', args: { command: 'python3 /tmp/gen_doc.py' } }),
  ]).find(item => item.role === 'process').steps;
  const progress = taskProgress(steps.at(-1));
  assert.equal(progress.status, 'running');
  assert.equal(progress.docGenDone, true); // 生成命令曾成功，但整步没收口
  assert.deepEqual(progress.summaries, ['正在生成文档，请稍候…']);
});

test('run headline is the single source: four states, no flicker across command gaps', () => {
  const genCmd = 'python3 /tmp/gen_doc.py';
  const docStep = calls => ({ id: 'd1', role: 'tool', name: 'bash', _docGen: true, calls });
  const doneCall = tool('bash', { args: { command: genCmd } });
  // 铁律①：命令间隙（本轮运行中）粘性 running + 「正在…请稍候…」，不回摆成「已完成」。
  const gap = runHeadline({ live: true, steps: [docStep([doneCall])], answering: false });
  // 下一条命令启动的快照：状态与文案都不回摆（消灭秒闪）。
  const busy = runHeadline({
    live: true,
    steps: [docStep([doneCall, tool('bash', { args: { command: genCmd }, status: 'running' })])],
    answering: false,
  });
  assert.equal(gap.state, 'running');
  assert.equal(busy.state, 'running');
  assert.equal(gap.text, busy.text);
  assert.equal(gap.text, '正在生成文档，请稍候…');
  // 回答流出中：转圈 + 复合句（文档与回答两个事实都告知）。
  const streaming = runHeadline({ live: true, steps: [docStep([doneCall])], answering: true });
  assert.deepEqual(streaming, { state: 'running', text: '文档已生成，正在整理回答…' });
  // 本轮结束：绿勾 + 文档已生成。
  assert.deepEqual(runHeadline({ live: false, steps: [docStep([doneCall])] }), { state: 'done', text: '文档已生成' });
  // 异常收口：红叉 + 本轮异常结束。
  const failed = [{ id: 'f1', role: 'tool', name: 'bash', calls: [tool('bash', { status: 'error' })] }];
  assert.deepEqual(runHeadline({ live: false, steps: failed }), { state: 'error', text: '本轮异常结束' });
  // 无工具纯思考：正在思考与分析。
  assert.deepEqual(runHeadline({ live: true, steps: [{ role: 'thinking', text: '想一想' }] }),
    { state: 'running', text: '正在思考与分析，请稍候…' });
  // 铁律②：转圈文案绝不独立宣称「文档已生成」；复合句必须同时说明仍在进行。
  for (const head of [gap, busy, streaming]) {
    assert.notEqual(head.text, '文档已生成');
    if (head.text.includes('已生成')) assert.match(head.text, /正在/);
  }
});

test('turnEnded promotes the last assistant text to the answer so the bottom is never empty', () => {
  const messages = [
    { role: 'user', id: 'u12', content: '生成 word' },
    tool('bash', { id: 'b12', args: { command: 'python3 /tmp/gen_doc.py' } }),
    { role: 'assistant', id: 'a12', content: '文档已生成，包含上面的图片。' },
    tool('bash', { id: 'b13', args: { command: 'ls -l a.docx' } }),
  ];
  // 运行中：最后动作是工具，回答暂留过程旁白，不抢跑。
  const running = groupConversation(messages, false);
  assert.ok(running.find(item => item.role === 'process').steps.some(step => step.role === 'note'));
  // 一轮结束：最后一条 assistant 兜底提升为回答，下方必有内容。
  const ended = groupConversation(messages, true);
  const answers = ended.filter(item => item.role === 'assistant');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].content, '文档已生成，包含上面的图片。');
});
