const labels = {
  lightrag_query_data: '知识检索',
  kb_ingest: '文档入库', kb_update: '知识更新',
  kb_status: '健康状态', kb_analyze: '知识库体检',
  kb_report: '运营报告', kb_graph_search: '图谱检索',
  kb_feedback_inbox: '反馈收件箱', kb_feedback_context: '反馈依据',
  kb_diagnosis_submit: '诊断提交',
};

export const toolLabel = name => labels[name] || '处理资料';
export function visibleTool(card) {
  return Boolean(labels[card.name] || card.status === 'error');
}

function stageKey(card) {
  const args = card.args || {};
  // Repeated searches form a stage; writes to different documents stay separate.
  return card.name === 'lightrag_query_data'
    ? `${card.name}:${args.kb || 'company'}`
    : `${card.name}:${JSON.stringify(args)}`;
}

function outcome(card) {
  const j = card.resultJson, text = String(card.resultText || '');
  const result = (status, summary) => ({ status, summary });
  const done = summary => result('done', summary);
  if (card.status === 'running') return result('running', '正在处理这一阶段…');
  if (card.status === 'interrupted') return result('error', '已停止接收，这一阶段的结果尚未确认。');
  if (card.status === 'error') return result('error', '这一步未成功，尚未得到可用结果。');
  if (card.name !== 'kb_status' && j?.ok === false) return result('error', '处理未成功，需核对返回结果。');
  switch (card.name) {
    case 'lightrag_query_data': {
      const data = j?.data || j;
      const chunks = data?.chunks, entities = data?.entities, relations = data?.relationships;
      if ([chunks, entities, relations].some(Array.isArray)) {
        const parts = [];
        if (chunks?.length) parts.push(`${chunks.length} 段相关资料`);
        if (entities?.length) parts.push(`${entities.length} 个关联实体`);
        if (relations?.length) parts.push(`${relations.length} 条关联关系`);
        return done(parts.length ? `找到${parts.join('、')}` : '检索已完成，未找到匹配的知识依据');
      }
      // The main backend also returns rendered text and truncated history previews.
      if (text.includes('无命中')) return done('检索已完成，未找到匹配的知识依据');
      const references = text.match(/(?:^|\n)引用[：:]\s*([^\n]+)/)?.[1];
      return done(references ? `已查阅相关资料；引用：${references}` : '知识检索已完成，依据见回答');
    }
    case 'kb_ingest':
      if (['active', 'processed', 'verified'].includes(j?.document?.status)) return done('文档已完成入库');
      return result('pending', '已提交入库，文档解析与入库状态待确认');
    case 'kb_update':
      if (j?.intent_id || ['replace', 'delete'].includes(card.args?.action)) {
        return result('pending', '知识变更已提交，等待后台处理与核验');
      }
      return done('知识更新已执行');
    case 'kb_status':
      if (j?.ok === false || j?.engine?.status === 'unreachable') return result('warning', '状态检查已完成，知识服务需要检查');
      if (j?.engine) return done(`引擎：${j.engine.status || '未知'}；管道${j.engine.pipeline_busy ? '忙碌' : '空闲'}`);
      return done(text.split('\n').find(Boolean) || '知识库状态已检查');
    case 'kb_graph_search':
      if (j?.entities?.length) return done(`找到 ${j.entities.length} 个实体、${j.relations?.length || 0} 条关系`);
      if (Array.isArray(j?.matches)) return done(j.matches.length ? `找到 ${j.matches.length} 个匹配实体` : '图谱检索已完成，未找到匹配实体');
      return done(text.split('\n').find(Boolean) || '知识图谱检索已完成');
    case 'kb_analyze':
      return j?.summary ? done(`体检完成：${j.summary.conflicts ?? 0} 项源冲突、${j.summary.failed_docs ?? 0} 份失败文档`)
        : done('知识库体检已完成，结果见回答');
    case 'kb_report': return done('运营报告已整理');
    case 'kb_feedback_inbox': return done(Array.isArray(j?.items) ? `读到 ${j.items.length} 条反馈` : '反馈收件箱已查阅');
    case 'kb_feedback_context': return done('已核对反馈关联的问题与知识依据');
    case 'kb_diagnosis_submit': return done('诊断已提交；修复提案仍需审批与执行');
    default: return done('已收到处理结果');
  }
}

function knowledgeReferences(card) {
  const files = [];
  for (const call of card.calls || [card]) {
    if (call.name !== 'lightrag_query_data' || call.status !== 'done' || outcome(call).status !== 'done') continue;
    const data = call.resultJson?.data || call.resultJson;
    const references = Array.isArray(data?.references) ? data.references : [];
    const rendered = String(call.resultText || '').match(/(?:^|\n)引用[：:]\s*([^\n]+)/)?.[1];
    for (const reference of [...references, ...(rendered ? rendered.split('、') : [])]) {
      const file = typeof reference === 'string' ? reference : reference?.file_path || reference?.file;
      if (typeof file === 'string' && file.trim()) files.push(file.trim());
    }
  }
  return [...new Set(files)];
}

export function taskProgress(card) {
  const results = (card.calls || [card]).map(outcome);
  return {
    title: toolLabel(card.name),
    status: ['running', 'error', 'warning', 'pending', 'done'].find(status => results.some(r => r.status === status)),
    summaries: [...new Set(results.map(r => r.summary))],
    references: knowledgeReferences(card),
  };
}

export function groupTaskMessages(messages) {
  const out = [], groups = new Map();
  for (const message of messages) {
    if (message.role === 'thinking') continue;
    if (message.role !== 'tool') {
      groups.clear(); // Keep stages in order around answers, approvals and new turns.
      out.push(message);
      continue;
    }
    if (!visibleTool(message)) continue;
    const key = stageKey(message), existing = groups.get(key);
    if (existing) existing.calls.push(message);
    else {
      const group = { ...message, calls: [message] };
      out.push(group);
      groups.set(key, group);
    }
  }
  return out;
}
