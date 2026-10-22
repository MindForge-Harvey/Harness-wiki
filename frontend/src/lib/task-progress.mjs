const labels = {
  lightrag_query_data: '知识检索',
  kb_ingest: '文档入库', kb_update: '知识更新',
  kb_status: '健康状态', kb_analyze: '知识库体检',
  kb_report: '运营报告', kb_graph_search: '图谱检索',
  kb_feedback_inbox: '反馈收件箱', kb_feedback_context: '反馈依据',
  kb_diagnosis_submit: '诊断提交',
};

// 模型可调用的内置工具：全部给出可读名称，用户才看得懂每一步在做什么。
const toolTitles = {
  bash: '执行命令', pwsh: '执行命令',
  read: '读取文件', write: '写入文件', edit: '修改文件', read_image: '查看图片',
  grep: '搜索文件', glob: '查找文件',
  skill: '加载技能', todo_write: '更新计划',
  subagent: '委派子任务', subagent_fork: '委派子任务',
  send_message: '向子任务发消息', interrupt_agent: '中止子任务',
  list_agents: '查看子任务', list_subagent_models: '查看可用模型',
  workflow: '运行工作流', ralph: '迭代执行',
  get_goal: '查看目标', create_goal: '创建目标', update_goal: '更新目标',
  job_output: '读取后台任务', job_list: '查看后台任务', job_kill: '停止后台任务',
  web_search: '网络检索', web_fetch: '读取网页',
  exit_plan_mode: '提交计划',
};

// 连续出现时合并为一行展示的文件类工具，避免一次任务里堆出十几行读取。
const batchableTools = new Set(['read', 'write', 'edit', 'grep', 'glob', 'read_image']);

export const toolLabel = name => labels[name] || toolTitles[name] || '执行工具';

/** 任何工具调用都要出现在过程块：未知工具用默认标题，失败的工具同样可见。 */
export function visibleTool(card) {
  return Boolean(card && card.name);
}

const firstLine = (text, limit = 60) => {
  const line = String(text || '').split('\n').map(part => part.trim()).find(Boolean) || '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};

const lastSegment = (value) => {
  const parts = String(value || '').split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || '';
};

/** 从调用参数里提取一行能说明「这一步在做什么」的摘要。 */
export function argBrief(card) {
  const args = card.args || {};
  switch (card.name) {
    case 'bash': case 'pwsh':
      // 命令本身比模型写的英文描述更直观，用户能直接看到执行了什么。
      return firstLine(args.command || args.description);
    case 'read': case 'write': case 'edit':
      return lastSegment(args.file_path) || '';
    case 'read_image':
      return lastSegment(args.file_path || args.path) || '';
    case 'grep':
      return args.pattern ? `${args.pattern}${args.include ? ` · ${args.include}` : ''}` : '';
    case 'glob':
      return args.pattern || '';
    case 'skill':
      return args.name || '';
    case 'todo_write':
      return Array.isArray(args.todos) ? `${args.todos.length} 项计划` : '';
    case 'subagent': case 'subagent_fork':
      return firstLine(args.description || args.prompt, 40);
    case 'send_message': case 'interrupt_agent':
      return String(args.agent_id || args.id || args.target || '');
    case 'workflow':
      return firstLine(args.meta?.title || args.description, 40);
    case 'ralph':
      return firstLine(args.description || args.script, 40);
    case 'create_goal': case 'update_goal':
      return firstLine(args.objective || args.status, 40);
    case 'job_output': case 'job_kill':
      return String(args.job_id || '');
    case 'web_search':
      return Array.isArray(args.queries) ? args.queries.slice(0, 2).join('、') : String(args.query || '');
    case 'web_fetch':
      return String(args.url || '');
    default:
      return '';
  }
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
  if (card.status === 'error') return result('error', '这一步未成功');
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
    case 'bash': case 'pwsh':
      return done(text ? firstLine(text) : '命令已执行');
    case 'read':
      return done(text ? firstLine(text) : '文件已读取');
    case 'write':
      return done(text ? firstLine(text) : '文件已写入');
    case 'edit':
      return done(text ? firstLine(text) : '文件已修改');
    case 'glob': {
      const count = text.split('\n').filter(line => line.trim()).length;
      return done(count ? `找到 ${count} 个文件` : '未找到匹配的文件');
    }
    case 'grep': {
      const count = text.split('\n').filter(line => line.trim()).length;
      return done(count ? `找到 ${count} 行匹配` : '未找到匹配内容');
    }
    case 'web_search': return done(text ? firstLine(text) : '网络检索已完成');
    case 'web_fetch': return done(text ? firstLine(text) : '网页已读取');
    case 'todo_write': return done(Array.isArray(card.args?.todos) ? `计划已更新（${card.args.todos.length} 项）` : '计划已更新');
    case 'skill': return done(card.args?.name ? `已加载技能 ${card.args.name}` : '技能已加载');
    default:
      return done(text ? firstLine(text) : '已完成');
  }
}

export function knowledgeReferences(card) {
  const files = [];
  for (const call of card.calls || [card]) {
    if (call.name !== 'lightrag_query_data' || call.status !== 'done' || outcome(call).status !== 'done') continue;
    const data = call.resultJson?.data || call.resultJson;
    const references = [
      ...(Array.isArray(data?.references) ? data.references : []),
      ...(Array.isArray(call.references) ? call.references : []),
    ];
    const rendered = String(call.resultText || '').match(/(?:^|\n)引用[：:]\s*([^\n]+)/)?.[1];
    for (const reference of [...references, ...(rendered ? rendered.split('、') : [])]) {
      const file = typeof reference === 'string' ? reference : reference?.file_path || reference?.file;
      if (typeof file === 'string' && file.trim()) files.push(file.trim());
    }
  }
  return [...new Set(files)];
}

/** 来源文件只用文件名展示与匹配，避免把宿主绝对路径暴露给用户。 */
export function sourceName(file) {
  return String(file || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

/**
 * 按轮次汇总检索来源：每条用户消息之后所有 lightrag_query_data 结果的引用文件，
 * 按首次出现顺序去重并编号；该轮每个最终回答都映射到同一份编号来源列表。
 * @param {Array} messages 会话消息（含 role/name/references/resultText）
 * @returns {Map<string, Array<{ index: number, file: string, name: string }>>} 回答 id → 来源列表
 */
export function citationSources(messages) {
  const byAnswer = new Map();
  let files = [];
  for (const message of messages) {
    if (message.role === 'user') {
      files = [];
      continue;
    }
    if (message.role === 'tool') {
      if (message.name !== 'lightrag_query_data' || message.status !== 'done') continue;
      for (const file of knowledgeReferences(message)) {
        if (!files.some(existing => existing === file)) files.push(file);
      }
      continue;
    }
    if (message.role === 'assistant' && files.length) {
      byAnswer.set(message.id, files.map((file, index) => ({ index: index + 1, file, name: sourceName(file) })));
    }
  }
  return byAnswer;
}

/** 在来源列表里找标记对应的文件：支持完整路径、文件名与路径后缀三种写法。 */
function sourceOf(key, sources) {
  const normalized = String(key || '').trim().replaceAll('\\', '/');
  if (!normalized) return null;
  return sources.find((source) => {
    const file = String(source.file || '').replaceAll('\\', '/');
    return file === normalized || source.name === normalized || file.endsWith('/' + normalized);
  }) || null;
}

/**
 * 把本轮检索来源与回答里的 [[文件名]] 标记对应起来。
 * 只列回答真正引用的文件，按首次出现顺序编号，角标与来源清单一一对应；
 * 回答里没有标记时退回列出本轮全部检索来源（此时只有清单、没有角标）。
 * @param {string} text 回答正文
 * @param {Array<{ index: number, file: string, name: string }>} sources 本轮检索来源
 * @returns {Array<{ index: number, file: string, name: string }>} 编号后的来源清单
 */
export function citationPlan(text, sources) {
  const picked = [];
  for (const match of String(text || '').matchAll(/\[\[([^\]\n]{1,200})\]\]/g)) {
    const hit = sourceOf(match[1], sources);
    if (hit && !picked.includes(hit)) picked.push(hit);
  }
  return (picked.length ? picked : sources).map((source, index) => ({ ...source, index: index + 1 }));
}

/** 模型偶尔会在结尾自写「来源文件：…」：有自动来源清单时去掉这行，避免与角标清单重复。 */
export function stripOwnSourceLine(text) {
  return String(text || '').replace(/\n\s*(?:来源(?:文件)?|出处|参考资料)[：:][^\n]*\s*$/, '');
}

/** 把模型写的 [[文件名]] 换成可点击角标；匹配不到来源文件时原样保留，避免误删正文。 */
export function linkCitations(text, sources, messageId) {
  if (!sources?.length) return text;
  return String(text || '').replace(/\[\[([^\]\n]{1,200})\]\]/g, (match, raw) => {
    const hit = sourceOf(raw, sources);
    return hit ? `[${hit.index}](#cite-${messageId}-${hit.index})` : match;
  });
}

/** 单次调用的展开明细：命令类先给出实际执行的命令，其余给出结果原文。 */
function callDetail(call) {
  const text = String(call.resultText || '').trim();
  const brief = argBrief(call);
  if (call.name === 'bash' || call.name === 'pwsh') {
    const command = String(call.args?.command || '').trim();
    return [command ? `$ ${command}` : brief, text].filter(Boolean).join('\n');
  }
  // 文件类工具的 resultText 自带路径，参数摘要只补在缺少路径的情况下。
  if (call.name === 'read' || call.name === 'write' || call.name === 'edit') return text || brief;
  return [brief, text].filter(Boolean).join('\n');
}

export function taskProgress(card) {
  const calls = card.calls || [card];
  const results = calls.map(outcome);
  const detail = calls.map(callDetail).filter(Boolean).join('\n\n');
  return {
    title: toolLabel(card.name),
    status: ['running', 'error', 'warning', 'pending', 'done'].find(status => results.some(r => r.status === status)),
    summaries: [...new Set(results.map(r => r.summary))],
    references: knowledgeReferences(card),
    brief: argBrief(calls[0]),
    detail,
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

/**
 * 把对话整理为「用户消息 → 执行过程 → 最终回答」。
 * 同一轮里后面还有工具或审批的 assistant 文本属于过程旁白，最后一段才是回答；
 * 推理、工具、审批按出现顺序收进过程块。
 * @param {Array<object>} messages 按时间排列的消息
 * @returns {Array<object>} 渲染项：user、process、assistant、approval、error
 */
export function groupConversation(messages) {
  const turns = [];
  let turn = null;
  for (const message of messages) {
    if (message.role === 'user') {
      turn = { user: message, items: [] };
      turns.push(turn);
      continue;
    }
    if (!turn) { turn = { user: null, items: [] }; turns.push(turn); }
    turn.items.push(message);
  }

  const out = [];
  for (const { user, items } of turns) {
    if (user) out.push(user);
    const visible = items.filter(item => item.role !== 'tool' || visibleTool(item));
    // 从后往前找第一条助手文本：它后面没有工具或审批，才是这一轮的最终回答。
    let answerIndex = -1;
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      if (visible[index].role !== 'assistant') continue;
      const followed = visible.slice(index + 1).some(item => ['tool', 'approval', 'error'].includes(item.role));
      if (!followed) answerIndex = index;
      break;
    }

    const steps = [], groups = new Map();
    visible.forEach((item, index) => {
      if (index === answerIndex) return;
      if (item.role === "thinking" || item.role === "assistant") {
        // 同一阶段内的推理与旁白合并为一条「思考」，避免一轮里几十条碎片。
        const last = steps.at(-1);
        if (last?.role === "note") last.parts.push(item);
        else steps.push({ id: `note-${item.id}`, role: "note", ts: item.ts, parts: [item] });
        return;
      }
      if (item.role !== "tool") { steps.push(item); return; }
      // 同一工具连续重试失败合并成一条，避免列表里出现多行一模一样的「这一步未成功」。
      const last = steps.at(-1);
      if (item.status === "error" && last?.role === "tool" && last.name === item.name && taskProgress(last).status === "error") {
        last.calls.push(item);
        return;
      }
      // 连续的同种文件操作合并为一行（读取 3 个文件），明细仍逐条保留。
      if (batchableTools.has(item.name) && last?.role === "tool" && last.name === item.name) {
        last.calls.push(item);
        last.ts = item.ts;
        return;
      }
      const key = stageKey(item), existing = groups.get(key);
      if (existing) { existing.calls.push(item); return; }
      const group = { ...item, calls: [item] };
      groups.set(key, group);
      steps.push(group);
    });

    if (steps.length) {
      out.push({
        id: `process-${user?.id || steps[0].id}`,
        role: 'process',
        steps,
        running: steps.some(step => step.role === 'tool' && taskProgress(step).status === 'running'),
        start: steps[0].ts || 0,
        end: Math.max(...steps.map(step => step.ts || 0), 0),
      });
    }
    if (answerIndex >= 0) out.push(visible[answerIndex]);
  }
  return out;
}
