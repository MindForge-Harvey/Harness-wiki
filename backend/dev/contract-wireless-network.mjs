import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createNetworkDataStore } from '../dsh/dsh-wireless/lib/network-data.js'
import { archiveRules, orderAnalysisInput } from '../dsh/dsh-wireless/lib/order-context.js'
import { createIcosService } from '../dsh/dsh-wireless/lib/icos.js'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply } from '../dsh/dsh-wireless/lib/index.js'

function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wireless-network-'))
  const store=createNetworkDataStore({database:path.join(directory,'network.sqlite'),writable:true})
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true})})
  const record={status:'found',source_ref:'archive://contract',trace_id:'trace-contract',missing_fields:['conclusion','KPI/MR time series'],
    ticket:{id:'NETWORK-CONTRACT',cell_id:'CELL-CONTRACT',cell_name:'Contract cell',primary_issue_type:'SA无线掉线率',system:'NR',vendor:'华为',band:'n41',issued_at:'2026-06-30'},
    actions:[{action_id:'1',scheme_id:'NGFGFA009',exec_id:'NGFGFA009_2',param_cn_name:'负载均衡方向',param_en_name:'MlbDirection',
      before_value:'DOWNLINK',recorded_target:'DUAL',root_cause_l1:'资源',root_cause_l2:'高负荷',value_rule:'DUAL',adjustment_rule:'!=DUAL',
      long_eval_result:'long_eval_unknown',exec_state:'exec_success'}]}
  const observations=Array.from({length:8},(_,i)=>({kind:'kpi',object_id:'CELL-CONTRACT',metric:'上行PRB平均利用率(SA)',source_column:'his016',
    value:i<4?35:94,unit:'%',definition:'RRU_PuschPrbAssn/RRU_PuschPrbTot',source_ref:'network://20261101/contract',data_origin:'constructed',
    time_window:{start:`2026-11-01T0${i}:00:00+08:00`,end:`2026-11-01T0${i+1}:00:00+08:00`}}))
  const snapshot={ticket_id:record.ticket.id,snapshot_date:'2026-11-01',source_ref:'network://20261101/contract',
    provenance:{origin:'constructed'},order_patch:{conclusion:'高负荷，上行PRB94%，掉线率2.6%，资源不足异常释放占82%。',
      resource_totalverdict:'上行PRB94%，掉线率2.6%。',analysis_date:'2026-11-01',degradation_time:'2026-11-01 18:00—21:59'},
    observations,rules:archiveRules(record),parameters:{MlbDirection:'DOWNLINK'},neighbors:[],alarms:{active:[]}}
  const orders=()=>structuredClone(record)
  orders.analysisData=id=>store.read(id);orders.caseRecords=()=>[]
  return {directory,store,record,snapshot,orders}
}

test('network observations and rules persist with provenance, exact dates, metric names and atomic validation',t=>{
  const {directory,store,snapshot}=fixture(t)
  const written=store.write(snapshot), reopened=createNetworkDataStore({database:path.join(directory,'network.sqlite')})
  t.after(()=>reopened.close())
  assert.equal(reopened.summary(snapshot.ticket_id).version,written.version)
  const summary=reopened.query({ticket_id:snapshot.ticket_id})
  assert.equal(summary.analysis.usable_count,8)
  assert.equal(summary.analysis.synthetic,true)
  assert.equal(summary.rule_count,1)
  assert.equal(summary.analysis.series[0].max,94)
  assert.equal(reopened.query({operation:'series',ticket_id:snapshot.ticket_id,metric:'his016'}).total,8)
  assert.equal(reopened.query({ticket_id:snapshot.ticket_id,snapshot_date:'2026-06-30'}).status,'not_found')
  const invalid=structuredClone(snapshot);invalid.observations[0].value=101
  assert.throws(()=>store.write(invalid),/无效观测/)
  assert.equal(store.summary(snapshot.ticket_id).version,written.version)
  assert.throws(()=>reopened.write(snapshot),/只读/)
})

test('new network data refreshes an old missing-data context and invalidates its stale root conclusion',async t=>{
  const {directory,store,snapshot,orders}=fixture(t)
  snapshot.evaluation_policy={ul_prb_target_percent:75}
  snapshot.observations.forEach(row=>row.threshold={operator:'gt',value:85,source_ref:'analysis-policy://contract'})
  const run=createIcosService({directory,orders})
  const first=await run('context',{ticket_id:snapshot.ticket_id})
  assert.equal((await run('root_cause',{run_id:first.run_id})).result.status,'not_called')
  store.write(snapshot)
  const refreshed=await run('context',{operation:'read',run_id:first.run_id,view:'summary'})
  assert.equal(refreshed.refreshed_from_network_data,true)
  assert.equal(refreshed.result.network_context.snapshot_date,'2026-11-01')
  assert.equal(refreshed.result.observation_analysis.input_count,8)
  assert.equal(refreshed.analysis_basis.snapshot_date,'2026-11-01')
  assert.equal(refreshed.analysis_basis.diagnostic_source,'network_snapshot')
  assert.equal(refreshed.analysis_basis.anomaly_thresholds[0].value,85)
  assert.equal(refreshed.analysis_basis.evaluation_targets.ul_prb_target_percent,75)
  assert.equal(refreshed.result.observation_analysis.series[0].declared_thresholds[0].value,85)
  assert.equal(refreshed.workflow.find(row=>row.stage==='root_cause').status,'not_started')
  assert.equal((await run('root_cause',{run_id:first.run_id})).status,'needs_judgment')
})

test('SDK queries stored metrics and small floating point changes stay lossless JSON',async t=>{
  const {directory,store,snapshot}=fixture(t)
  snapshot.observations.forEach((row,i)=>row.value=1.00000000001-i*.000000000001)
  store.write(snapshot)
  const previous=process.env.WIRELESS_NETWORK_DB
  process.env.WIRELESS_NETWORK_DB=path.join(directory,'network.sqlite')
  const ctx=new Context();new SystemPrompt(ctx,{});new ToolRuntime(ctx);apply(ctx)
  t.after(async()=>{await ctx.fiber.dispose();if(previous===undefined)delete process.env.WIRELESS_NETWORK_DB;else process.env.WIRELESS_NETWORK_DB=previous})
  for(const [name,args] of [['wireless_network_query',{ticket_id:snapshot.ticket_id,snapshot_date:snapshot.snapshot_date}],
    ['wireless_data_analyze',{ticket_id:snapshot.ticket_id,snapshot_date:snapshot.snapshot_date,baseline_points:4}]]) {
    const result=await ctx.tools.execute({name,arguments:args,callId:name,signal:new AbortController().signal})
    assert.equal(result.isError,false,JSON.stringify(result))
    assert.deepEqual(JSON.parse(JSON.stringify(result.value)),result.value)
  }
})

test('archive-provided rules reach the source matcher and a supported action survives the unchanged decision chain',async t=>{
  const {directory,store,snapshot,record,orders}=fixture(t);store.write(snapshot)
  const run=createIcosService({directory,orders}),context=await run('context',{ticket_id:snapshot.ticket_id}),id=context.run_id
  const judge=async(stage,judgment)=>{
    const pending=await run(stage,{run_id:id})
    if(pending.status!=='needs_judgment') return pending
    return run(stage,{run_id:id,judgment_token:pending.judgment_token,judgment})
  }
  await run('objective',{run_id:id})
  await judge('root_cause',{causes:[{cause:'高负荷',category:'资源',confidence:95,evidence:'上行PRB94%，掉线率2.6%'}],reasoning:'Quantified resource observation'})
  await run('cases',{run_id:id});await run('candidates',{run_id:id})
  await judge('alignment',{plans:[{plan_id:'NGFGFA009',relation:'针对根因',causes:['高负荷'],reason:'UL capacity and current DL-only configuration'}],reasoning:'Matched action'})
  const risk=await run('parameter_risk',{run_id:id})
  assert.equal(risk.result['1'].final_b_para,'DUAL')
  assert.equal(risk.result['1'].shape,'dispatchable')
  await judge('consistency',{actions:[{execution_id:'1',parachinname:'负载均衡方向',relevance:'指标正向',path:'UL congestion -> load redistribution',evidence:'规则库事实'}],conflicts:[]})
  const decision=await run('decision',{run_id:id,operation:'finalize'})
  assert.equal(decision.result.decision.chain.dispatched_after,1)
  assert.equal(decision.device_operation_performed,false)
  const explanation=await run('decision',{run_id:id,operation:'explain'})
  assert.equal(explanation.read_only,true)
  assert.equal(explanation.revision,decision.revision)
  assert.equal(explanation.result.actions[0].rule_check.para,'DUAL')
  assert.equal(explanation.result.actions[0].rule_check.rule_scope,'!=DUAL')
  assert.equal(explanation.result.actions[0].selected_target,'DUAL')
  const byTicket=await run('context',{operation:'read',view:'summary',ticket_id:snapshot.ticket_id})
  assert.equal(byTicket.run_id,id)
  assert.equal(byTicket.stage_summaries.decision.result.chain.dispatched_after,1)
  assert.equal(byTicket.revision,decision.revision)
  const explainedByTicket=await run('decision',{operation:'explain',ticket_id:snapshot.ticket_id})
  assert.equal(explainedByTicket.run_id,id)
  assert.equal(explainedByTicket.result.actions[0].selected,true)
  const atTarget=structuredClone(snapshot);atTarget.parameters.MlbDirection='DUAL'
  const adapted=orderAnalysisInput(record,{networkData:atTarget})
  assert.equal(adapted.initial_plans[0].f_para,'DUAL')
  assert.equal(adapted.initial_plans[0].long_eval_result,undefined)
})
