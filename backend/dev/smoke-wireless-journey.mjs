/** Replay the demonstration as ordinary, consecutive user messages against the real model. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const base=process.env.HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3088'
const directory=path.resolve('.run/wireless-journey-live',String(Date.now()))
const dataDirectory=process.env.WIRELESS_TEST_DATA_DIR || path.resolve('.run/icos-real-data-20261111/runtime-data')
fs.mkdirSync(directory,{recursive:true})
const definitions=[
  {name:'access',ticket:'SNWNA011260503851110229964',identity:/杜家塬|接通低|低接通/,cause:/接入|调度|HARQ/,context:/HARQ|调度|SNonIntraSearch|接通/},
  {name:'drop',ticket:'SNXIA512260630163682851377932320',identity:/建大|专家公寓|掉线/,cause:/上行|高负荷|容量|拥塞/,context:/MLB|Mlb|DUAL|负载均衡|上行/},
]
if(process.env.JOURNEY_CASE) definitions.splice(0,definitions.length,...definitions.filter(row=>row.name===process.env.JOURNEY_CASE))
async function journey(definition) {
  let sessionId=`journey-${Date.now()}-${definition.name}`
  const turns=[],issues=[]
  const prompts=[['greeting','你好'],['june','2026年6月有哪些工单？按问题类型汇总数量，再列出5张具体工单。'],
    ['summary',`总结工单 ${definition.ticket} 的信息，包括小区、问题、参数动作和处理结果。`],
    ['root','明确按这个小区2026年11月1日的状态重新做根因分析，说明判断依据；这次分析和原工单事件分开。'],
    ['plan','为这张工单生成优化方案，先展示任务拆解，再按需要调用相关 Skills 完成分析。'],
    ['explain','逐项解释这些候选方案为什么保留或剔除，参数规则和整单复核分别起了什么作用？'],
    ['history','找出与这张工单相关的成功和失败案例，对比哪些经验可以参考、哪些条件不同。']]
  const check=(condition,message)=>{if(!condition)issues.push(message)}
  for(const [name,message] of prompts) {
    const started=Date.now(),events=[]
    const response=await fetch(base+'/api/chat/stream',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({sessionId,message}),signal:AbortSignal.timeout(360000)})
    if(!response.ok)throw new Error(`${definition.name}/${name}: HTTP ${response.status}`)
    const decoder=new TextDecoder();let buffer=''
    for await(const chunk of response.body) {
      buffer+=decoder.decode(chunk,{stream:true})
      let end
      while((end=buffer.indexOf('\n\n'))>=0) {
        const block=buffer.slice(0,end);buffer=buffer.slice(end+2)
        const data=block.match(/\ndata: (.+)/)?.[1]
        if(!data)continue
        const event={event:block.match(/^event: (.+)/)?.[1],data:JSON.parse(data),elapsed_ms:Date.now()-started}
        events.push(event)
        if(event.event==='renamed')sessionId=event.data.to
      }
    }
    const calls=events.flatMap(e=>e.data.params?.event?.type==='tool/call'?[e.data.params.event.data]:[])
    const blocks=events.flatMap(e=>e.data.params?.event?.type==='tool/result'?e.data.params.event.data.message?.content?.filter(b=>b.type==='tool-result')||[]:[])
    const values=blocks.flatMap(b=>(b.content||[]).filter(c=>c.type==='text').flatMap(c=>{try{return[JSON.parse(c.text)]}catch{return[]}}))
    const done=events.find(e=>e.event==='done'),answer=done?.data.finalResponse||''
    const deltas=events.filter(e=>e.data.method==='agent/assistant-delta')
    const runIds=[...new Set(values.map(value=>value.run_id).filter(Boolean))]
    const state=runIds.map(id=>path.join(dataDirectory,'icos-runs',id+'.json')).filter(file=>fs.existsSync(file))
      .map(file=>JSON.parse(fs.readFileSync(file))).find(row=>row.input.order.taskno===definition.ticket)
    const decision=state?.stages.decision?.response.result.decision
    const result={name,message,sessionId,elapsed_ms:Date.now()-started,first_text_ms:deltas[0]?.elapsed_ms||null,
      text_chunks:deltas.length,tools:calls.map(call=>call.name),loaded:calls.filter(call=>call.name==='skill').map(call=>JSON.parse(call.arguments).name),
      errors:blocks.filter(block=>block.isError),answer,run_ids:runIds,
      ...(state?{source:{snapshot_date:state.input.network_context?.snapshot_date,root_status:state.stages.root_cause?.response.result.status,
        roots:state.stages.root_cause?.response.result.causes,rules:state.input.rules?.length,
        admitted:decision?.verdict.admitted_count,verdict:decision?.verdict.word,rows:state.stages.decision?.response.result.rows?.map(row=>({parameter:row.tool,current:row.f_para,target:row.b_para,selected:row.need_call_parameter_platform}))}}:{})}
    turns.push(result)
    fs.writeFileSync(path.join(directory,definition.name+'-'+name+'-events.json'),JSON.stringify(events,null,2))
    fs.writeFileSync(path.join(directory,definition.name+'.json'),JSON.stringify({definition,sessionId,turns,issues},null,2))
    console.log(JSON.stringify({case:definition.name,turn:name,seconds:result.elapsed_ms/1000,first_text_ms:result.first_text_ms,tools:result.tools,errors:result.errors.length,source:result.source}))
    check(Boolean(answer),name+': missing final answer')
    check(!events.some(e=>e.event==='error'),name+': transport error')
    check(result.errors.length===0,name+': tool errors')
    check(!/生产工单库.{0,12}(未接入|未连接|没有接入)/.test(answer),name+': false missing archive claim')
    check(!/PRIVATE_REASONING/.test(JSON.stringify(events)),name+': leaked reasoning')
    if(name==='greeting'){check(result.elapsed_ms<1500,'greeting: slow');check(calls.length===0,'greeting: unnecessary tools')}
    else check(deltas.length>1&&deltas[0].elapsed_ms<done?.elapsed_ms,name+': missing true streaming')
    if(name==='june')check(/6558/.test(answer.replaceAll(',',''))&&/SN[A-Z0-9]+/.test(answer),'june: missing count or ticket ids')
    if(['summary','explain','history'].includes(name))check(definition.identity.test(answer)||definition.context.test(answer)||answer.includes(definition.ticket),name+': lost ticket context')
    if(name==='root'){
      check(definition.cause.test(answer),'root: missing supported diagnosis')
      check(state?.input.network_context?.snapshot_date==='2026-11-01','root: did not use stored data')
      check(state?.stages.root_cause?.response.result.causes?.length>0,'root: no actual causes')
      check(/11月|2026-11-01/.test(answer),'root: missing explicit analysis date')
      check(!/(?:声明|异常).{0,10}(?:门限|阈值).{0,8}75/.test(answer),'root: confuses alarm threshold and optimization target')
    }
    if(name==='explain')check(calls.some(call=>call.name==='wireless_icos_decision'&&JSON.parse(call.arguments).operation==='explain'),'explain: did not read recorded decision facts')
    if(name==='plan'){
      check(calls.some(call=>call.name==='todo_write'),'plan: missing native plan')
      check(decision?.verdict.admitted_count>0,'plan: no admitted proposal')
      check(result.source?.rules>0,'plan: missing original action rules')
    }
  }
  fs.writeFileSync(path.join(directory,definition.name+'.json'),JSON.stringify({definition,sessionId,turns,issues},null,2))
  return {case:definition.name,sessionId,turns:turns.length,issues}
}
const results=await Promise.allSettled(definitions.map(journey))
const summary=results.map((result,index)=>result.status==='fulfilled'?result.value:{case:definitions[index].name,error:String(result.reason)})
fs.writeFileSync(path.join(directory,'summary.json'),JSON.stringify(summary,null,2))
console.log(JSON.stringify({directory,summary}))
assert.ok(summary.every(row=>!row.error&&row.issues.length===0),'Journey checks failed; review saved answers and source evidence')
