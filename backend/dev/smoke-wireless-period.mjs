/** Verify historical ticket analysis and explicitly selected later snapshots remain separate. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base=process.env.HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3088';
const directory = '.run/wuyouxia-period-' + Date.now(); fs.mkdirSync(directory,{recursive:true});
const sessionId='wuyouxia-period-'+Date.now();
async function turn(name,message) {
 const response=await fetch(base+'/api/chat/stream',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,message}),signal:AbortSignal.timeout(300000)});
 const raw=await response.text();const frames=raw.split('\n\n').flatMap(block=>{const d=block.match(/\ndata: (.+)/)?.[1];return d?[{event:block.match(/^event: (.+)/)?.[1],data:JSON.parse(d)}]:[]});
 const calls=frames.flatMap(e=>e.data.params?.event?.type==='tool/call'?[e.data.params.event.data]:[]).map(c=>({name:c.name,args:JSON.parse(c.arguments)}));
 const errors=frames.flatMap(e=>e.data.params?.event?.type==='tool/result'?e.data.params.event.data.message?.content?.filter(b=>b.type==='tool-result'&&b.isError)||[]:[]);
 const answer=frames.find(e=>e.event==='done')?.data.finalResponse||'';
 const result={message,calls,errors,answer}; fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2));fs.writeFileSync(directory+'/'+name+'-events.json',JSON.stringify(frames,null,2));
 console.log(JSON.stringify({name,tools:calls,errors:errors.length,answer}));
 assert.ok(answer);assert.equal(errors.length,0);return result;
}
const summary=await turn('summary','总结6月工单 SNXIA512260630163682851377932320 的信息。');
assert.ok(summary.calls.some(c=>c.name==='wireless_order_query'));
assert.ok(!summary.calls.some(c=>c.args.analysis_scope==='latest'||c.args.snapshot_date==='2026-11-01'));
const history=await turn('historical','继续针对这张6月工单做根因分析，并梳理当时的方案和执行情况。');
assert.ok(!history.calls.some(c=>c.args.analysis_scope==='latest'||c.args.snapshot_date==='2026-11-01'));
const current=await turn('november','现在明确改为分析这个小区2026年11月1日的状态，用那天的数据重新做根因分析并生成优化方案。');
assert.ok(current.calls.some(c=>['wireless_icos_context','wireless_network_query'].includes(c.name)&&c.args.snapshot_date==='2026-11-01'));
assert.ok(current.calls.some(c=>c.name==='wireless_icos_decision'));
assert.match(current.answer,/DUAL/);
console.log(JSON.stringify({passed:true,directory,sessionId}));
