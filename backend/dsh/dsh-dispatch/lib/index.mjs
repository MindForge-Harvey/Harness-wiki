export const name = 'wireless-dispatch';
export const inject = ['tools'];

const text = description => ({ type: 'string', description });
const strings = description => ({ type: 'array', items: { type: 'string' }, description });
const tools = ['dispatch_context', 'dispatch_plan', 'dispatch_clarify'];

export function apply(ctx) {
  async function call(path, input, execution) {
    const sessionId = execution.agent?.session?.id;
    if (!sessionId) throw new Error('调度工具缺少绑定会话');
    const response = await fetch(process.env.DISPATCH_INTERNAL_URL + '/api/dispatch/internal/' + path, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dispatch-token': process.env.DISPATCH_INTERNAL_TOKEN },
      body: JSON.stringify({ session_id: sessionId, ...input }), signal: AbortSignal.any([execution.signal, AbortSignal.timeout(10000)]),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '调度接口请求失败');
    return result;
  }
  const definitions = [
    { name: 'dispatch_context', description: '读取本轮用户目标、可用网格和小区、指标、能力目录、演示数据时间及上一任务。每轮先调用一次，以实际目录规划任务。',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: (_, execution) => call('context', {}, execution) },
    { name: 'dispatch_plan', description: '提交已经理解的用户意图和能力依赖计划。服务端校验后立即通过 HTTP 派发真实的本地专业任务，返回受理记录。每轮只成功调用一次；不要声称已收到工具尚未返回的业务结果。',
      parameters: { type: 'object', additionalProperties: false, properties: {
        intent: { type: 'string', enum: ['metrics_query', 'knowledge_query', 'complaint_analysis', 'optimization', 'region_analysis', 'grid_analysis', 'closed_loop', 'effect_tracking', 'data_analysis', 'specialized_diagnosis', 'decision_review', 'rollback', 'operations'] },
        scenario_id: text('可选，匹配实际目录中的业务场景 ID；场景用于组织能力，不强制执行完整模板。'),
        understanding: text('用一句自然中文准确复述用户目标、范围和执行边界，在界面直接展示。'),
        scope: { type: 'object', properties: { grid_ids: strings('实际目录中的网格 ID。'), cell_ids: strings('实际目录中的小区 ID。') }, required: ['grid_ids', 'cell_ids'], additionalProperties: false },
        period: { type: 'object', properties: { kind: { type: 'string', enum: ['last_days', 'yesterday', 'today', 'custom'] }, days: { type: 'integer' }, start: text('自定义窗口的带时区 ISO 起始时间'), end: text('自定义窗口的带时区 ISO 结束时间') }, required: ['kind'], additionalProperties: false },
        metric_ids: strings('单纯指标查询只选用户要求的指标。综合诊断用空数组读取全套指标。'),
        execution_requested: { type: 'boolean', description: '只有用户明确要求执行、下发、安排处理或闭环处理才为 true。查询、诊断、给建议不授权模拟调参。' },
        steps: { type: 'array', items: { type: 'object', properties: { id: text('唯一短步骤 ID，如 metrics'), capability_id: text('实际目录中的原子工具 ID'), depends_on: strings('依赖的步骤 ID，独立步骤用空数组'), input: { type: 'object', additionalProperties: true, description: '可选工具专属输入，严格按目录 parameters；如TOP N的metric_id/limit/order，工单查询的status/limit。无参数工具省略或空对象。' }, reason: text('为何选择该能力，使用简洁业务语言') }, required: ['id', 'capability_id', 'depends_on', 'reason'], additionalProperties: false } },
      }, required: ['intent', 'understanding', 'scope', 'period', 'metric_ids', 'execution_requested', 'steps'] },
      execute: (plan, execution) => call('plan', { plan }, execution) },
    { name: 'dispatch_clarify', description: '任务确实缺少必需的对象或目标，或请求对象不在目录时，给出一个简洁澄清问题。不会派发任何业务任务。可先复用上一任务的已知范围，避免重复提问。',
      parameters: { type: 'object', properties: { question: text('一个简洁、能帮助用户继续的澄清问题。') }, required: ['question'], additionalProperties: false },
      execute: (args, execution) => call('clarify', args, execution) },
  ];
  definitions.forEach(definition => ctx.effect(() => ctx.tools.register({ ...definition,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  })));
  // Only the three bounded dispatch tools are visible in this dedicated profile.
  ctx.on('agent/created', async ({ agent }) => {
    await agent.ctx.inject(['tools'], scope => { scope.effect(() => scope.tools.restrict({ allow: tools })); });
  });
}
