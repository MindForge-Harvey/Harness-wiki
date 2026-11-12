/** Model-driven single-Skill and combined-Skill evaluation on archived real records. */
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply } from '../dsh/dsh-wireless/lib/index.js'

const root = process.cwd(), directory = path.resolve(process.argv[2] || '.run/icos-real-data-20261111')
const base = process.env.HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3098'
const out = path.join(directory, 'model-results')
fs.mkdirSync(out, { recursive: true })
process.env.WIRELESS_DATA_DIR = path.join(directory, 'runtime-data')
const cases = JSON.parse(fs.readFileSync(path.join(directory, 'cases.json')))
const compiled = JSON.parse(fs.readFileSync(path.join(directory, 'compiled-history.json')))
const byCase = id => cases.find(row => row.case === id)
const ctx = new Context(); new SystemPrompt(ctx, {}); new ToolRuntime(ctx); apply(ctx)
let callSerial = 0
async function tool(name, args) {
  const output = await ctx.tools.execute({ name, arguments: args, callId: `skill-precondition-${++callSerial}`, signal: new AbortController().signal })
  if (output.isError) throw new Error(JSON.stringify(output))
  return output.value
}

const singles = [
  ['wireless-workorder-intake', 'case-01', '请将提供的真实工单输入接入为可恢复的 ICOS 分析记录。保留来源和原执行编号字符串，给出工单对象、问题类型及主要缺口。', ['wireless_icos_context']],
  ['wireless-problem-identification', 'case-04', '只完成问题分型，区分原工单现象、参数动作与当前根因。给出问题类型、对象和后续应核实的证据。', ['wireless_icos_objective']],
  ['wireless-evidence-builder', 'case-01', '只整理本单可用证据：当前上下文、记录动作、历史参考、缺失的当前观测；不要把历史动作和参数数值构造成 KPI。', ['wireless_icos_context']],
  ['wireless-data-analysis', 'case-05', '只分析提供的参数记录中能确定的变化与数据口径，核对有没有真正的 KPI 时序可用于基线/效果计算。不得把参数取值作为网络 KPI，不补造观测。', ['wireless_icos_context']],
  ['wireless-root-cause-analysis', 'case-06', '只做根因阶段。实际调用根因工具，检查证据是否足以确认根因；不能把问题类型、历史动作组标签或条件建议当成本单已证实根因。', ['wireless_icos_root_cause']],
  ['wireless-objective-confirmation', 'case-12', '只确认本单目标指标和小区边界，说明有无数值改善目标、时间窗和当前 KPI。', ['wireless_icos_objective']],
  ['wireless-case-retrieval', 'case-04', '只检索本单相关历史，报告实际同类样本、方向、成败及适用差异；区分提交的训练子集与全库，不把历史成功率写成本单成功概率。', ['wireless_icos_cases']],
  ['wireless-solution-decision', 'case-04', '只对现有归档动作池进行候选组织与组内比较。调用候选工具；缺当前根因时保留条件判断，不制造根因或表外方案。', ['wireless_icos_candidates']],
  ['wireless-cause-plan-alignment', 'case-09', '只进行根因与方案对齐阶段，调用对齐工具。没有当前根因原文时说明可做和不能做的对齐结论，不从方案名称倒推确诊根因。', ['wireless_icos_alignment']],
  ['wireless-parameter-adaptation', 'case-08', '只做参数约束及步长检查，调用参数风险工具，逐项给出原值、归档目标、规则后目标及是否保留。不能把通过约束当成效果保证。', ['wireless_icos_parameter_risk']],
  ['wireless-plan-consistency', 'case-01', '只做本轮动作的整单一致性复核。调用复核工具，按需要回传 judgment 与 judgment_token，报告相关性、冲突和未评估项。', ['wireless_icos_consistency']],
  ['wireless-comprehensive-decision', 'case-10', '产出本单最终综合裁决，先检查已备前置阶段；若还缺整单复核，完成必要复核再 finalize。明确哪些动作保留和哪些证据缺失。', ['wireless_icos_decision']],
  ['wireless-multi-round-reasoning', 'case-02', '只检查能否启动多轮重推理。当前输入没有明确轮次或原系统短评估关联，不能把长期 Fail 或短评估未启用占位文本当作有效短评估。实际调用工具并明确缺口，不编造新目标。', ['wireless_icos_multi_round']],
  ['wireless-effect-evaluation', 'case-02', '只评价已发生的执行和归档效果标签，读取本项明确允许的归档反馈文件并提交 archived_feedback 给反馈工具。分开报告执行成败、未启用的短评估、长期标签及“改善”标签冲突。没有 KPI 就不计算改善百分比。', ['wireless_icos_feedback'], true],
  ['wireless-memory-engineering', 'case-04', '将这张真实工单及有来源的候选动作保存到现有 wireless_workorder 账本，并返回 workorder_id/plan_id。候选来自归档动作回放，不能自动记成真实执行；不要编造时间窗和效果。', ['wireless_workorder']],
  ['wireless-knowledge-compiler', 'case-04', '只测试真实历史编译及读取：使用提供的训练子集 normalized JSONL，historical 模式，截止 2026-11-11T00:00:00+08:00。评价可见性依据该包 exported_at=2026-11-10T15:22:00.310750+08:00 的已归档快照，此次测试明确声明它在所选截止前可见；不要声称它在原工单决策时已经可见。实际编译并读取包，报告六类记忆、状态、反证及小样本边界。', ['wireless_compile_history', 'wireless_memory_query']],
  ['wireless-echo-mem', 'case-01', '结合本单多动作/执行不全的实际结构，查询并解释 ECHO-Mem 怎样保存案例、归因与反证；整单 Pass 是否能广播给每个参数？只解释有来源的方法，不读取本单目标结果。', ['wireless_echo_query']],
  ['wireless-demo-analysis', 'case-06', '测试这个 Skill 收到真实工单时的路由。只处理这张真实记录，调用其合适的已有业务工具，不要用场景库里的合成弱覆盖案例替换。给出可完成的分析及真实数据缺口。', ['wireless_icos_context']],
  ['wireless-workorder-orchestrator', 'case-09', '按本单实际输入完成目标、根因、案例、候选、对齐、参数风险、整单复核和最终裁决；无根因原文时明确未知，不创建原文。执行必要的 Skills 与阶段工具，并用三条总结得到的实质结论。', ['wireless_icos_decision']],
].map(([skill, caseId, task, expectedTools, feedback = false], index) => ({
  id: `single-${String(index+1).padStart(2,'0')}`, kind: 'single_skill', skills: [skill], caseId, task, expectedTools, feedback,
}))
const combinations = [
  { id: 'combined-access', kind: 'combined_skills', caseId: 'case-04', skills: ['wireless-case-retrieval','wireless-solution-decision','wireless-parameter-adaptation','wireless-plan-consistency','wireless-comprehensive-decision'],
    task: '联合完成历史对比、候选方案、参数检查、整单复核和最终裁决。给出本单哪些实际参数建议可保留、历史支持与当前根因缺口；不查看目标事后结果。', expectedTools: ['wireless_icos_cases','wireless_icos_parameter_risk','wireless_icos_decision'] },
  { id: 'combined-nr', kind: 'combined_skills', caseId: 'case-12', skills: ['wireless-objective-confirmation','wireless-cause-plan-alignment','wireless-parameter-adaptation','wireless-plan-consistency','wireless-comprehensive-decision'],
    task: '联合评估这张 NR 工单，完成目标、对齐、约束、整单复核和最终决策。明确根因未知条件下结论的含义，不把规则与历史标签当成现场验证。', expectedTools: ['wireless_icos_objective','wireless_icos_alignment','wireless_icos_parameter_risk','wireless_icos_decision'] },
  { id: 'combined-feedback', kind: 'combined_skills', caseId: 'case-02', skills: ['wireless-effect-evaluation','wireless-multi-round-reasoning','wireless-memory-engineering'], feedback: true,
    task: '读取本项明确允许的真实归档反馈，先评价执行/短评估/长期评估标签冲突，再检查重推理是否具备条件，将有来源的工单及反馈保存到现有账本。不能凭长期 Fail 制造短评估轮次、KPI 改善或回退执行结果。', expectedTools: ['wireless_icos_feedback','wireless_icos_multi_round','wireless_workorder'] },
  { id: 'combined-execution-fail', kind: 'combined_skills', caseId: 'case-16', skills: ['wireless-effect-evaluation','wireless-evidence-builder','wireless-workorder-orchestrator'], feedback: true,
    task: '只回顾这张真实 NR 工单的执行证据。调用反馈工具核对实际执行失败原因，区分“参数规则可计算”与“设备实际接受/执行”。所有动作失败时，不得宣称 after_value 已在现网生效或网络已改善；不启动完整新方案流程。', expectedTools: ['wireless_icos_feedback'] },
]
const specifications = [...singles, ...combinations]
const filter = process.env.EVAL_CASES?.split(',')
const previous = process.env.EVAL_RESUME === '1' ? specifications.flatMap(spec => {
  const file = path.join(out,spec.id+'.json')
  if (!fs.existsSync(file)) return []
  const record = JSON.parse(fs.readFileSync(file))
  return record.status === 'passed' ? [record] : []
}) : []
const selected = filter ? specifications.filter(s => filter.includes(s.id)) : specifications
const chosen = selected.filter(spec => !previous.some(row => row.id === spec.id))
const results = [...previous]
const common = '这是用户提供的真实脱敏归档数据功能测试。请先用 skill 工具加载本项指定的 Skill，再实际调用业务工具。读取工单优先使用 wireless_icos_context(operation=read,view=summary)，它包括代码计算的 parameter_changes 和阶段摘要；不要展开不需要的完整历史。工单没有 conclusion/smart_conclusion、六维诊断或原始 KPI 时序；问题类型只是现象，方案组标签不能作为当前根因。动作池是执行混合子集留下的历史动作，不是完整原始候选池。execution_id 必须保留字符串。前置输入和纯计算阶段已准备好，本项只评估指定方法，可复用这些产物；不要用 shell/import 内部模块代替业务工具，不修改项目代码。若缺数据，实际核对后给出准确缺口，不为了通过测试编造。最后用三条左右的结论说明事实、判断和边界。'

async function prepare(spec) {
  const entry = byCase(spec.caseId), input = JSON.parse(fs.readFileSync(entry.input_file))
  input.evaluation_namespace = spec.id + '-v3'
  const inputFile = path.join(out, spec.id + '-input.json')
  fs.writeFileSync(inputFile, JSON.stringify(input, null, 2))
  const initial = await tool('wireless_icos_context', { input })
  // Single-Skill checks receive real prerequisite artifacts. Combined checks start
  // from context/basic objective/root checks so the model must perform the chain.
  const prerequisites = spec.kind === 'combined_skills' ? ['objective','root_cause']
    : ['objective','root_cause','cases','candidates','alignment','parameter_risk']
  for (const stage of prerequisites) {
    await tool('wireless_icos_' + stage, { run_id: initial.run_id })
  }
  const feedbackFile = path.join(directory, 'feedback', spec.caseId + '-tool-input.json')
  const message = common + (spec.kind === 'combined_skills' ? '\n这是组合测试，只有 context/目标/原文缺口检查预备完成；其余阶段请实际调用对应工具完成，不只在答复里引用。' : '') +
    '\n指定 Skills：' + spec.skills.join('、') + '\n任务：' + spec.task +
    `\n工单：${entry.issue}，${entry.system}，${entry.actions} 个归档动作。已准备 run_id=${initial.run_id}。` +
    `\n决策前输入文件：${inputFile}。训练历史包：${compiled.package_id}。` +
    `\n训练子集编译文件：${path.join(directory,'train-history-normalized.jsonl')}。` +
    (spec.feedback ? `\n本项允许读取的目标归档反馈：${feedbackFile}。其中 actions 可直接作为 archived_feedback 提交。` :
      '\n本项禁止读取任何目标 feedback/、traces/ 目录、原始 ZIP 或 tool-calls.json 中的目标事后结果；不能把反馈倒填决策。')
  return { entry, inputFile, run_id: initial.run_id, message }
}

async function evaluate(spec) {
  const started = Date.now(), prepared = await prepare(spec)
  const sessionId = `paper-data-${Date.now()}-${spec.id}`
  console.log(JSON.stringify({ event:'started', test:spec.id, skills:spec.skills, case:spec.caseId }))
  const events = [], decoder = new TextDecoder()
  let buffer = ''
  try {
    const response = await fetch(base + '/api/chat/stream', { method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({sessionId,message:prepared.message}), signal:AbortSignal.timeout(300000) })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes,{stream:true})
      let end
      while ((end=buffer.indexOf('\n\n'))>=0) {
        const block=buffer.slice(0,end);buffer=buffer.slice(end+2)
        const raw=block.match(/\ndata: (.+)/)?.[1]
        if(raw) events.push({event:block.match(/^event: (.+)/)?.[1],data:JSON.parse(raw)})
      }
    }
    const calls=events.map(e=>e.data.params?.event).filter(e=>e?.type==='tool/call').map(e=>({
      ...e.data,args:typeof e.data.arguments==='string'?JSON.parse(e.data.arguments):e.data.arguments,
    }))
    const outputs=events.map(e=>e.data.params?.event).filter(e=>e?.type==='tool/result').flatMap(e=>e.data.message?.content||[]).filter(b=>b.type==='tool-result')
    const loaded=calls.filter(c=>c.name==='skill').map(c=>c.args.name)
    const names=calls.map(c=>c.name)
    const answer=events.find(e=>e.event==='done')?.data.finalResponse||''
    const toolErrors=outputs.filter(o=>o.isError).map(o=>({callId:o.toolCallId,text:(o.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('')}))
    const missingSkills=spec.skills.filter(name=>!loaded.includes(name))
    const missingTools=spec.expectedTools.filter(name=>!names.includes(name))
    const result={...spec,case:prepared.entry,run_id:prepared.run_id,sessionId,elapsed_ms:Date.now()-started,
      loaded_skills:loaded,tools:names,tool_errors:toolErrors,missing_skills:missingSkills,missing_tools:missingTools,
      answer,transport_errors:events.filter(e=>e.event==='error').map(e=>e.data),
      status:answer&&!missingSkills.length&&!missingTools.length&&!toolErrors.length?'passed':'needs_review'}
    fs.writeFileSync(path.join(out,spec.id+'-events.json'),JSON.stringify(events,null,2))
    fs.writeFileSync(path.join(out,spec.id+'.json'),JSON.stringify(result,null,2))
    results.push(result)
    console.log(JSON.stringify({event:'finished',test:spec.id,status:result.status,seconds:Math.round(result.elapsed_ms/1000),
      loaded:loaded.length,tools:names.filter(n=>n.startsWith('wireless_')),errors:toolErrors.length,answer:answer.slice(0,150)}))
  } catch(error) {
    const result={...spec,run_id:prepared.run_id,sessionId,status:'transport_failure',error:error.message,elapsed_ms:Date.now()-started}
    fs.writeFileSync(path.join(out,spec.id+'.json'),JSON.stringify(result,null,2));results.push(result)
    console.log(JSON.stringify({event:'failed',test:spec.id,error:error.message}))
  }
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(results,null,2))
}

try {
  const pending=[...chosen]
  async function worker(){ while(pending.length) { const spec=pending.shift(); try{await evaluate(spec)}catch(error){
    const result={...spec,status:'preparation_failure',error:error.message};results.push(result);console.log(JSON.stringify(result))
  } } }
  await Promise.allSettled(Array.from({length:Number(process.env.EVAL_CONCURRENCY)||2},worker))
} finally { await ctx.fiber.dispose() }
console.log(JSON.stringify({status:'finished',tests:results.length,passed:results.filter(r=>r.status==='passed').length,output:out}))
