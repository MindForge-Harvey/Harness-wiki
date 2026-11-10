const labels = {
  lightrag_query_data: '知识检索', lightrag_graph_search: '图谱检索',
  kb_ingest: '文档入库', kb_update: '知识更新',
  kb_status: '健康状态', kb_analyze: '知识库体检',
  kb_report: '运营报告', kb_graph_search: '图谱检索',
  kb_feedback_inbox: '反馈收件箱', kb_feedback_context: '反馈依据',
  kb_diagnosis_submit: '诊断提交',
};

// 模型可调用的内置工具：全部给出可读名称，用户才看得懂每一步在做什么。
const toolTitles = {
  bash: '执行操作', pwsh: '执行操作',
  read: '查看资料', write: '生成文件', edit: '调整内容', read_image: '查看图片',
  grep: '查找内容', glob: '查找文件',
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

/**
 * 从 bash 命令里提取被执行的脚本文件名（不含路径），用于判断是否在重复跑同一个脚本。
 * 例如 `cd /x && python gen_doc.py` → `gen_doc.py`；非脚本命令返回空串。
 */
function bashScriptName(command) {
  const stmts = String(command || '').split(/\s*(?:&&|;)\s*/).map(s => s.trim()).filter(Boolean);
  const opStmt = stmts.find(s => !/^\s*cd\s+[^\s]+\s*$/.test(s)) || stmts[0] || '';
  const m = opStmt.match(/\b(?:python\d*|node|nodejs|bun|deno|ruby)\s+[^\s]*?([^\/\\\s]+\.(?:py|js|mjs|cjs|rb|sh))\b/);
  return m ? m[1] : '';
}

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

/**
 * 解析 shell 命令，返回小白用户能看懂的动作短语（生成文档、检查结果等）。
 * 不展示脚本名和命令参数；无法归类时返回空串，交给模型写的描述兜底。
 */
function shellBrief(command) {
  const raw = String(command || '').trim();
  if (!raw) return '';
  // 文档生成统一走包装脚本，先于通用命令解析识别，避免被当成「执行命令」。
  if (isDocGenCommand(raw)) return '生成文档';
  const stmts = raw.split(/\s*(?:&&|;)\s*/).map(s => s.trim()).filter(Boolean);
  const opStmt = stmts.find(s => !/^\s*cd\s+[^\s]+\s*$/.test(s)) || stmts[0] || '';
  const tokens = opStmt.split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  const [cmd, ...rest] = tokens;
  const base = cmd.replace(/.*[\\/]/, '').toLowerCase();
  const hasFlag = flag => rest.includes(flag);
  // 运行脚本：绝大多数场景是生成 Word/Excel/PDF。
  if (['python', 'python3', 'node', 'nodejs', 'bun', 'deno', 'ruby'].includes(base)) {
    if (hasFlag('--version') || hasFlag('-V')) return '检查环境';
    // 安装依赖：python -m pip install / npm install。
    if (rest.includes('install')) return '安装依赖';
    const script = rest.find(t => !t.startsWith('-') && /\.[a-z]+$/i.test(t)) || '';
    if (/convert|transform/i.test(script)) return '转换文档格式';
    // -c 是内联代码，无法判断具体产物，用通用说法。
    if (hasFlag('-c') || hasFlag('-e')) return '处理数据';
    return '生成文档';
  }
  // 安装依赖。
  if (['pip', 'pip3', 'npm', 'pnpm', 'yarn', 'conda'].includes(base) && rest[0] === 'install') {
    return '安装依赖';
  }
  // 查看文件内容。
  if (['cat', 'head', 'tail', 'less', 'more'].includes(base)) return '查看内容';
  // 列出文件 → 检查生成结果。
  if (base === 'ls' || base === 'dir') return '检查结果';
  // 搜索内容。
  if (base === 'grep' || base === 'rg') return '查找内容';
  if (base === 'find') return '查找文件';
  // 转换文档格式。
  if (base === 'pandoc' || base === 'libreoffice' || base === 'soffice') return '转换文档格式';
  // 压缩 / 解压。
  if (['zip', 'unzip', 'tar', 'gzip', 'gunzip'].includes(base)) return '压缩或解压文件';
  // 文件整理与权限。
  if (['mkdir', 'cp', 'mv', 'rm', 'touch', 'ln'].includes(base)) return '整理文件';
  if (['chmod', 'chown'].includes(base)) return '设置权限';
  // 环境与状态检查。
  if (['pwd', 'which', 'whereis', 'command', 'type', 'uname', 'df', 'du'].includes(base)) return '检查环境';
  if (['test', '['].includes(base)) return '检查结果';
  // 文本与数据处理。
  if (['echo', 'printf'].includes(base)) return '整理内容';
  if (['sed', 'awk', 'jq', 'sort', 'uniq', 'wc', 'cut'].includes(base)) return '处理数据';
  // 下载。
  if (['curl', 'wget'].includes(base)) return '下载资料';
  if (base === 'sleep') return '等待处理';
  // 无法归类：返回空串，由调用方用模型写的描述兜底。
  return '';
}

/** bash/pwsh 这一步的动作名称：优先按命令推断；模型描述只在中文时使用，英文描述不给用户看。 */
function bashAction(card) {
  const brief = shellBrief(card?.args?.command);
  if (brief) return brief;
  const desc = firstLine(card?.args?.description, 20);
  return /[\u4e00-\u9fff]/.test(desc) ? desc : '执行命令';
}

/** 运行中的提示语：直接说明这一步正在做什么，如「正在生成文档，请稍候…」。 */
export function runningText(card) {
  if (isDocGenSkillCall(card) || card._docGenSkill) return '正在执行文档生成技能，请稍候…';
  // 合并后的文档阶段没有 args，只能靠块标记判断，否则会退化成「正在执行命令」。
  if (isDocGenCall(card) || card._docGen || card._workTitle === '生成文档') return '正在生成文档，请稍候…';
  if (card.name === 'bash' || card.name === 'pwsh') return `正在${bashAction(card)}，请稍候…`;
  if (card.name === 'lightrag_query_data') return '正在检索知识依据，请稍候…';
  return `正在${toolLabel(card.name)}，请稍候…`;
}

/** 文档类扩展名：这些文件名对用户有意义，可以展示；脚本/源码文件名隐藏。 */
const DOC_EXTS = /\.(pdf|docx?|xlsx?|pptx?|md|txt|csv|json|ya?ml|html?|png|jpe?g|gif|svg)$/i;

/** 从调用参数里提取一行能说明「这一步在做什么」的摘要。 */
export function argBrief(card) {
  const args = card.args || {};
  switch (card.name) {
    case 'bash': case 'pwsh':
      // 解析命令给出可读动作，避免只显示 `cd /长路径` 让用户困惑。
      return bashAction(card);
    case 'read': case 'write': case 'edit':
      // 只展示文档类文件名，脚本/源码文件名对小白用户无意义。
      return DOC_EXTS.test(args.file_path || '') ? lastSegment(args.file_path) : '';
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
    case 'lightrag_query_data':
      // 检索词是用户最关心的过程信息，直接展示模型的查询意图。
      return firstLine(args.query);
    default:
      return '';
  }
}

function stageKey(card) {
  const args = card.args || {};
  // 知识检索是产品核心卖点：每次检索独立成步，逐条展示检索词与命中来源，不合并；
  // 其余工具连续调用仍按参数合并成阶段，避免一次任务里堆出十几行文件读取。
  return card.name === 'lightrag_query_data'
    ? `${card.name}:${card.id || card.seq || JSON.stringify(args)}`
    : `${card.name}:${JSON.stringify(args)}`;
}

function outcome(card) {
  const j = card.resultJson, text = String(card.resultText || '');
  const result = (status, summary) => ({ status, summary });
  const done = summary => result('done', summary);
  if (card.status === 'running') return result('running', runningText(card));
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
    case 'bash': case 'pwsh': {
      // 命令失败（找不到命令、缺依赖、脚本报错）不能报成成功。
      if (/\[exit code: [1-9]\d*\]/.test(text) || /未找到命令|command not found|Traceback \(most recent call last\)/i.test(text)) {
        return result('error', /未找到命令|command not found/i.test(text) ? '执行未成功（命令未找到）' : '执行未成功');
      }
      const brief = bashAction(card);
      // 用「操作 + 已完成」的句式，不展示脚本输出原文。
      if (brief === '生成文档') return done('文档已生成');
      if (brief === '安装依赖') return done('依赖已安装');
      if (brief === '转换文档格式') return done('格式已转换');
      if (brief === '检查结果' || brief === '检查环境') return done('已检查');
      if (brief === '查看内容') return done('内容已查看');
      if (brief === '查找内容' || brief === '查找文件') return done('查找完成');
      if (brief === '整理文件' || brief === '整理内容') return done('已整理');
      if (brief === '处理数据') return done('已处理');
      if (brief === '下载资料') return done('已下载');
      if (brief === '压缩或解压文件') return done('已完成');
      return done(brief ? `${brief}已完成` : '已完成');
    }
    case 'read':
      return done('资料已查看');
    case 'write':
      return done('文件已生成');
    case 'edit':
      return done('内容已调整');
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

/**
 * 模型偶尔会在结尾自写「引用来源/参考资料：\n- xxx\n- xxx …」。
 * 前端已有自动来源清单，把这段删掉避免重复。标题行 + 后续项目符号列表整体移除。
 */
export function stripOwnSourceLine(text) {
  return String(text || '').replace(
    /\n\s*(?:引用来源|参考来源|来源(?:文件)?|出处|参考资料)[：:]\s*(?:\n\s*[-*•]\s*.+)+$/m,
    ''
  );
}

/** 把模型写的 [[文件名]] 换成可点击角标；匹配不到来源文件时原样保留，避免误删正文。 */
export function linkCitations(text, sources, messageId) {
  if (!sources?.length) return text;
  return String(text || '').replace(/\[\[([^\]\n]{1,200})\]\]/g, (match, raw) => {
    const hit = sourceOf(raw, sources);
    return hit ? `[${hit.index}](#cite-${messageId}-${hit.index})` : match;
  });
}

/** 单次调用的展开明细：命令类先给出实际执行的命令（去掉 cd 前缀），其余给出结果原文。 */
function callDetail(call) {
  const text = String(call.resultText || '').trim();
  const brief = argBrief(call);
  if (call.name === 'bash' || call.name === 'pwsh') {
    const command = String(call.args?.command || '').trim();
    // 详情里也去掉开头的纯 cd 语句，让命令主体一目了然。
    const stmts = command.split(/\s*(?:&&|;)\s*/).map(s => s.trim()).filter(Boolean);
    const meaningful = stmts.filter(s => !/^\s*cd\s+[^\s]+\s*$/.test(s));
    const cleanCmd = (meaningful.length ? meaningful : stmts).join(' && ');
    return [cleanCmd ? `$ ${cleanCmd}` : brief, text].filter(Boolean).join('\n');
  }
  if (call.name === 'read') return text || brief;
  // 写/改文件的结果是 XML 回执（<path>…<content>Created file），只给用户看文件名。
  if (call.name === 'write' || call.name === 'edit') {
    const path = call.args?.file_path || call.args?.path || text.match(/<path>([^<]+)<\/path>/)?.[1] || '';
    const name = lastSegment(path);
    return name ? `${call.name === 'write' ? '已创建文件' : '已更新文件'} ${name}` : brief;
  }
  return [brief, text].filter(Boolean).join('\n');
}

export function taskProgress(card) {
  const calls = card.calls || [card];
  const results = calls.map(outcome);
  const merged = Boolean(card._workTitle || card._docGen || card._docGenSkill);
  const multi = merged || calls.length > 1;
  // 合并/重试步骤允许中间尝试失败（如缺命令换个命令重跑）：最后一步成功则整体算成功。
  const status = multi && results.some(r => r.status === 'error')
    && !results.some(r => r.status === 'running') && results.at(-1)?.status === 'done'
    ? 'done'
    : ['running', 'error', 'warning', 'pending', 'done'].find(s => results.some(r => r.status === s));
  // 整体已成功时不再把中间失败的尝试写进摘要，失败明细保留在展开内容里。
  const shown = multi && status === 'done' ? results.filter(r => r.status !== 'error') : results;
  const detail = calls.map(callDetail).filter(Boolean).join('\n\n');
  const shell = card.name === 'bash' || card.name === 'pwsh';
  // 「这是文档生成步骤」只有一个判定口径：最终标题就是「生成文档」。
  // 归组后的块可能只剩 _workTitle（写脚本→跑脚本合并而来），也可能只剩
  // _docGen / _docGenSkill（技能加载块），三者任一成立都算，顶部与步骤同源。
  const docGenStep = Boolean(card._workTitle === '生成文档' || card._docGen || card._docGenSkill);
  // 合并后的步骤按用户视角命名；命令类把动作本身当作标题，
  // 避免标题和摘要都是同一个词（例如「处理中 处理中」）。
  const title = card._workTitle || (docGenStep ? '生成文档'
    : shell ? (bashAction(calls[0]) || '执行操作')
      : toolLabel(card.name));
  const summaries = [...new Set([
    // 运行中的动作排最前：用户此刻最想知道「正在做什么」。
    ...shown.filter(r => r.status === 'running').map(r => r.summary),
    ...shown.filter(r => r.status !== 'running').map(r => r.summary),
  ])];
  // 文档生成命令真正跑完才宣布完成：判定口径与 shellBrief 完全一致，
  // 顶部文案和步骤状态因此不会分叉。bashAction(c) === '生成文档' 本身就是
  // 充分条件——自写脚本、统一包装脚本都走这条路径，不依赖 docGenStep 标记。
  const docGenDone = Boolean(calls.some(c =>
    (c.name === 'bash' || c.name === 'pwsh') && c.status === 'done' && bashAction(c) === '生成文档'));
  // 铁律②：转圈时绝不写「已生成」。整步仍在运行（生成命令成功后又补跑命令）时，
  // 摘要固定为「正在生成文档，请稍候…」；只有整步收口才允许用「文档已生成」收口。
  if (docGenDone && status !== 'running') summaries.splice(0, summaries.length, '文档已生成');
  else if (docGenStep && status === 'running') summaries.splice(0, summaries.length, runningText(card));
  // 生成文档的阶段优先展示「文档已生成」这类结论，而不是排序靠前的环境检查结果。
  if (!results.some(r => r.status === 'running') && docGenStep) {
    const index = ['文档已生成', '格式已转换', '文件已生成']
      .map(s => summaries.indexOf(s)).find(i => i > 0);
    if (index !== undefined) summaries.unshift(...summaries.splice(index, 1));
  }
  return {
    title,
    status,
    summaries,
    references: knowledgeReferences(card),
    // 命令类的动作已经在标题里说清楚，摘要留给执行结果。
    brief: card._workTitle || card._docGen || card._docGenSkill || shell ? '' : argBrief(calls[0]),
    // 整轮合并出的阶段步骤：前端展示结果摘要，而不是内部调用条数。
    merged,
    // 文档生成命令是否已完成：顶部状态直接用它，与步骤展示同源。
    docGenDone,
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
 * 判断一个工具调用是否属于「文档生成」过程：
 * 写/改脚本文件，或用 bash 运行脚本、安装文档生成依赖。
 * 用于把模型生成 Word/Excel/PDF 时的一串写脚本→跑脚本→改脚本→再跑
 * 合并成一条「生成文档」，避免小白用户看到一堆看不懂的命令。
 */
function isDocGenCall(call) {
  if (call.name === 'write' || call.name === 'edit') {
    const fp = String(call.args?.file_path || call.args?.path || '');
    return /\.(py|js|mjs|cjs|rb|sh)$/i.test(fp);
  }
  if (call.name === 'bash' || call.name === 'pwsh') {
    const cmd = String(call.args?.command || '');
    if (bashScriptName(cmd)) return true;
    // 安装文档生成相关依赖也算文档生成的一部分。
    if (/\b(?:pip\d*|npm|pnpm|yarn)\s+install\b/.test(cmd)) return true;
    return false;
  }
  return false;
}

/** 会产出正式文档的技能：加载它们就进入文档生成阶段。 */
const DOC_SKILLS = new Set(['generate-document', 'ppt-page']);

/** 模型加载文档产出类技能：这是文档生成阶段的起点信号。 */
function isDocGenSkillCall(call) {
  return call?.name === 'skill' && DOC_SKILLS.has(call.args?.name);
}

/** 文档生成命令：统一脚本或包装层出现即视为在生成文档。 */
export function isDocGenCommand(command) {
  return /\brun_docgen\.sh\b|\bgenerate_document\.py\b/.test(String(command || ''));
}

/**
 * 本轮的文档生成阶段状态：顶部状态、执行过程卡片标题都从这里取文案。
 * 返回 null（不在文档阶段）或 { done, label }：
 * - done=true：文档已生成；
 * - done=false：仍在生成，包括两次工具调用之间的模型思考间隙——
 *   这段时间没有工具在跑，但文档阶段并未结束，不能说成「正在思考与分析」。
 */
export function docStageStatus(steps) {
  const tools = (steps || []).filter(step => step.role === 'tool');
  // 文档步骤的广义判定：
  //  1) 已经合并成 title='生成文档' 的块（最常见，skill+write+bash 合并而来）
  //  2) 被 _docGen/_docGenSkill 标记的块（旧路径遗留，或直接带标记的块）
  //  3) 单独一条 write/bash 但本轮之前加载过 generate-document 技能
  const docGenSkillLoaded = tools.some(s =>
    (s.calls?.[0] || s).name === 'skill'
    && DOC_SKILLS.has((s.calls?.[0] || s).args?.name));
  const isDocStep = step => {
    const p = taskProgress(step);
    if (p.title === '生成文档') return true;
    if (step._docGen || step._docGenSkill) return true;
    // 单独 write/bash 但之前加载过 generate-document 技能 → 也算文档阶段
    if (docGenSkillLoaded && (step.name === 'write' || step.name === 'bash' || step.name === 'pwsh')) return true;
    return false;
  };
  const last = tools.findLast(isDocStep);
  if (!last) return null;
  const progress = taskProgress(last);
  if (progress.status === 'error') return null;
  if (progress.docGenDone) return { done: true, label: '文档已生成' };
  // 文档步骤之后已经出现别的工具（如重新检索），说明模型已离开文档生成阶段。
  if (tools.at(-1) !== last) return null;
  // 标签：如果之前加载了 generate-document 技能，统一用"正在生成文档..."，
  // 不再区分 write 还是 bash——用户看得到技能加载，知道在干嘛。
  let label = runningText(last);
  if (docGenSkillLoaded) label = '正在生成文档，请稍候…';
  return { done: false, label };
}

/**
 * 执行过程卡片的唯一状态真相源（显示契约）：图标、标题文案由此同源给出。
 * 三条铁律：
 *  1. 状态前向不可逆——运行中的当前步骤粘性保持 running（渲染层 current/live 保证），
 *     本函数在 live 期间永远返回 running，不随命令间隙回摆到 done；
 *  2. 转圈时绝不写独立的「文档已生成」——文档完成但回答未完用复合句
 *     「文档已生成，正在整理回答…」，两个事实都告诉用户；
 *  3. 运行中底部永远有指示（渲染层保证），本函数只管卡片头。
 * 四态：running 转圈「正在{当前动作}，请稍候…」/ done 绿勾「文档已生成」「已完成 N 个步骤」/
 *       （回答流出中）转圈复合句 / error 红叉「本轮异常结束」。
 * @param {{ live?: boolean, steps?: Array<object>, answering?: boolean }} 输入
 *   live=本轮仍在运行；steps=过程块步骤；answering=最终回答正在流出
 * @returns {{ state: 'running'|'done'|'error', text: string }}
 */
export function runHeadline({ live, steps, answering } = {}) {
  const list = steps || [];
  const tools = list.filter(step => step.role === 'tool');
  const current = tools.at(-1);
  const runningTool = tools.find(step => taskProgress(step).status === 'running');
  const docStage = docStageStatus(list);
  // 本轮结束：绿勾收口；最后一步失败如实标红，不粉饰。
  if (!live) {
    if (current && taskProgress(current).status === 'error') return { state: 'error', text: '本轮异常结束' };
    if (docStage?.done) return { state: 'done', text: '文档已生成' };
    return { state: 'done', text: `已完成 ${tools.length || list.length} 个步骤` };
  }
  // 工具执行中（含命令间思考间隙）：当前动作粘性保持，间隙不换文案、不回摆。
  if (runningTool) return { state: 'running', text: runningText(runningTool) };
  // 文档已产出、回答整理/流出中：复合句把两个事实都告诉用户。
  if (answering) return { state: 'running', text: docStage?.done ? '文档已生成，正在整理回答…' : '正在整理回答…' };
  if (docStage && !docStage.done) return { state: 'running', text: docStage.label || '正在生成文档，请稍候…' };
  if (current) return { state: 'running', text: runningText(current) };
  return { state: 'running', text: '正在思考与分析，请稍候…' };
}

/**
 * 把连续的文档生成相关步骤合并成一条「生成文档」。
 * 输入是 groupConversation 里已按单步分组的 steps，返回合并后的 steps。
 * 一旦进入文档生成块（写脚本起头），后续所有 bash/write/edit 都纳入，
 * 直到出现非文档类工具（如知识检索、审批）才断开。
 */
function mergeDocGenSteps(steps) {
  const out = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    const first = step.calls?.[0] || step;
    if (step.role !== 'tool') {
      out.push(step);
      i += 1;
      continue;
    }
    // skill 调用（不管是不是文档技能）：始终独立一条「加载技能 xxx」，
    // 不并进文档生成块——用户想清楚看到技能加载和实际干活是两件事。
    if (first.name === 'skill') {
      out.push(step);
      i += 1;
      continue;
    }
    // 文档生成的真正起点：没有 skill 前置，直接 bash 跑文档脚本（自写脚本兜底场景）。
    if (!isDocGenCall(first)) {
      out.push(step);
      i += 1;
      continue;
    }
    // 收集连续的文档生成步骤：写/改脚本 + 任意 bash 命令（跑脚本、ls 检查、装依赖等）。
    const block = [step];
    let j = i + 1;
    while (j < steps.length) {
      const next = steps[j];
      if (next.role !== 'tool') break;
      const call = next.calls?.[0] || next;
      // 写/改脚本：纳入。
      if (call.name === 'write' || call.name === 'edit') {
        block.push(next); j += 1; continue;
      }
      // bash/pwsh：只要在文档生成块内，不管跑什么都纳入（检查输出、装依赖等）。
      if (call.name === 'bash' || call.name === 'pwsh') {
        block.push(next); j += 1; continue;
      }
      break;
    }
    if (block.length === 1) {
      out.push(step);
    } else {
      const calls = block.flatMap(s => s.calls || [s]);
      out.push({
        id: `docgen-${step.id}`,
        role: 'tool',
        name: 'bash',
        status: calls.some(c => c.status === 'running') ? 'running' : 'done',
        calls,
        ts: calls[calls.length - 1]?.ts || step.ts,
        _docGen: true,
      });
    }
    i = j;
  }
  return out;
}

/**
 * 产出型工具：写/改文件、执行命令、查看与查找等，都是为产出文件服务的内部动作。
 * 知识检索类工具不在此列，它们仍按次单独展示。
 */
const PRODUCTION_TOOLS = new Set(['bash', 'pwsh', 'write', 'edit', 'read', 'read_image', 'glob', 'grep']);

/** 这一步是否真的在产出成品文档：按动作判断（写/跑生成脚本、转换格式），
 * 不看结果文本，避免 ls 输出里出现 .docx 文件名就把环境探测误判成「生成文档」。 */
function producesDocument(call) {
  if (isDocGenCall(call)) return true;
  if (call.name === 'bash' || call.name === 'pwsh') {
    const brief = shellBrief(call.args?.command);
    return brief === '生成文档' || brief === '转换文档格式';
  }
  return false;
}

/**
 * 把一轮里连续的产出型步骤收成一条。
 * 生成一份文档往往伴随探测环境、安装依赖、写脚本、跑脚本、检查产物等十几条命令，
 * 逐条展示对用户没有信息量；这里按用户视角收成一步，明细仍保留在展开内容里。
 */
function collapseProductionSteps(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.role !== 'tool' || !PRODUCTION_TOOLS.has(step.name)) {
      out.push(step);
      continue;
    }
    const block = [step];
    let j = i + 1;
    while (j < steps.length && steps[j].role === 'tool' && PRODUCTION_TOOLS.has(steps[j].name)) {
      block.push(steps[j]);
      j += 1;
    }
    // 单步保持原样，避免把一次「查看资料」也说成生成文档。
    if (block.length === 1) {
      out.push(step);
      continue;
    }
    const calls = block.flatMap(s => s.calls || [s]);
    // 块里已经包含 generate-document 技能加载时，合并后仍要保留文档生成标记。
    const docGenSkill = block.some(s => s._docGenSkill);
    // 整轮没有产出文档时，按动作判断是查资料、环境检查还是普通处理。
    const onlyLookup = block.every(s => ['查看资料', '查找文件', '查找内容', '查看图片'].includes(taskProgress(s).title));
    const onlyProbing = calls.every(c => (c.name === 'bash' || c.name === 'pwsh')
      && ['检查环境', '检查结果'].includes(shellBrief(c.args?.command)));
    out.push({
      id: `work-${step.id}`,
      role: 'tool',
      name: 'bash',
      status: calls.some(c => c.status === 'running') ? 'running'
        : calls.some(c => c.status === 'error') ? 'error' : 'done',
      calls,
      ts: calls.at(-1)?.ts || step.ts,
      _docGenSkill: docGenSkill || undefined,
      _workTitle: docGenSkill || calls.some(producesDocument) ? '生成文档'
        : onlyLookup ? '查找资料' : onlyProbing ? '检查环境' : '处理资料',
    });
    i = j - 1;
  }
  return out;
}

/**
 * 把对话整理为「用户消息 → 执行过程 → 最终回答」。
 * 同一轮里后面还有工具或审批的 assistant 文本属于过程旁白，最后一段才是回答；
 * 推理、工具、审批按出现顺序收进过程块。
 * @param {Array<object>} messages 按时间排列的消息
 * @param {boolean} [turnEnded=false] 本轮是否已结束（isThinking 为假）。
 *   结束后若找不到"尾部回答"（如模型先写回答又补跑命令），把最后一条 assistant
 *   正文兜底提升为回答，保证下方只要有回答就一定显示，不再被过程步骤吞掉。
 * @returns {Array<object>} 渲染项：user、process、assistant、approval、error
 */
export function groupConversation(messages, turnEnded = false) {
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
    const visible = items.filter(item => {
      if (item.role === 'tool') return visibleTool(item);
      // 思考步骤只保留有内容的：空 reasoning 直接丢弃，不生成占位行。
      if (item.role === 'thinking') return Boolean(String(item.text || '').trim());
      return true;
    });
    // 从后往前找第一条助手文本：它后面没有工具或审批，才是这一轮的最终回答。
    let answerIndex = -1;
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      if (visible[index].role !== 'assistant') continue;
      const followed = visible.slice(index + 1).some(item => ['tool', 'approval', 'error'].includes(item.role));
      if (!followed) answerIndex = index;
      break;
    }
    // 回答兜底（铁律③）：一轮结束后若没有"尾部回答"（模型先写回答又补跑命令、
    // 或回答后跟了失败收尾命令），把最后一条 assistant 正文提升为回答，
    // 保证下方只要有回答就一定显示。
    if (answerIndex < 0 && turnEnded) {
      for (let index = visible.length - 1; index >= 0; index -= 1) {
        const item = visible[index];
        if (item.role === 'assistant' && String(item.content || item.text || '').trim()) {
          answerIndex = index;
          break;
        }
      }
    }

    const steps = [], groups = new Map();
    visible.forEach((item, index) => {
      if (index === answerIndex) return;
      if (item.role === "thinking") {
        // thinking 独立一条，完整展示模型的推理脉络——用户能清楚看到"模型在想什么"，
        // 知道每个工具调用之前/之后模型做了什么判断。
        steps.push({ id: `think-${item.id}`, role: "thinking", ts: item.ts, text: item.text });
        return;
      }
      if (item.role === "assistant") {
        // assistant 旁白（模型主动说的"我来帮你检索一下"之类）并进 note，
        // 但 thinking 不并进——那是推理，不是旁白。
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
      // 连续运行同一脚本的 bash 命令合并（文档生成时反复跑 gen_xxx.py），明细逐条保留。
      if ((item.name === 'bash' || item.name === 'pwsh') && last?.role === 'tool' && last.name === item.name) {
        const curScript = bashScriptName(item.args?.command);
        const lastScript = bashScriptName(last.calls?.[last.calls.length - 1]?.args?.command);
        if (curScript && curScript === lastScript) {
          last.calls.push(item);
          last.ts = item.ts;
          return;
        }
      }
      const key = stageKey(item), existing = groups.get(key);
      if (existing) { existing.calls.push(item); return; }
      const group = { ...item, calls: [item] };
      groups.set(key, group);
      steps.push(group);
    });

    // 先把写脚本/跑脚本等文档生成步骤并成一条，再把整轮产出型步骤收成一步：
    // 用户只需看到「查找资料 → 生成文档」，而不是十几条内部命令。
    const mergedSteps = collapseProductionSteps(mergeDocGenSteps(steps));

    if (mergedSteps.length) {
      out.push({
        id: `process-${user?.id || mergedSteps[0].id}`,
        role: 'process',
        steps: mergedSteps,
        running: mergedSteps.some(step => step.role === 'tool' && taskProgress(step).status === 'running'),
        start: mergedSteps[0].ts || 0,
        end: Math.max(...mergedSteps.map(step => step.ts || 0), 0),
      });
    }
    if (answerIndex >= 0) out.push(visible[answerIndex]);
  }
  return out;
}
