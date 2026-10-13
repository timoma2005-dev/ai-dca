import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { limitRelaxation, netCreationNearTotalLimit, mergeEventLogs, validateEventLog, persistEventLog, eventKey, selectPreviousDate, runEtfPcfEvents } from '../workers/ocr-proxy/src/etfPcfEvents.js';
import { parseEtfPcf } from '../workers/ocr-proxy/src/etfPcfLimit.js';
const at='2026-10-13T01:00:00.000Z',date='2026-10-13',previous='2026-10-12',code='159659';
const l=shares=>({kind:'limited',shares}),unlimited={kind:'unlimited',shares:null},unknown={kind:'unknown',shares:null};
const relax=(prev,cur,overrides={})=>limitRelaxation({code,date,basis:'total',prev_date:previous,when_detected:at,prev,cur,...overrides});
const creation=(netCreation,totalLimit=l(10000000),overrides={})=>netCreationNearTotalLimit({code,date:previous,prev_date:'2026-10-09',when_detected:at,netCreation,totalLimit,...overrides});
function log(d,results=[],time=at){return {schemaVersion:1,source:'szse_pcf_events',date:d,events:results.flatMap(r=>r.event?[r.event]:[]),checks:results.map(r=>r.check),updatedAt:time,run_id:time};}
class KV{
 constructor(){this.store=new Map();this.puts=[];this.gets=[];}
 async get(key){this.gets.push(key);return this.store.get(key)??null;}
 async put(key,value,options){this.puts.push({key,value,options,time:Date.now()});this.store.set(key,value);}
}
function pcf(){const text=new TextDecoder('gbk').decode(readFileSync(new URL('./fixtures/etf-pcf/ETF15994120261013.gbk.txt',import.meta.url)));return {...parseEtfPcf(text,{code:'159941',date}),fetchedAt:at,expiresAt:'2026-10-14T01:00:00.000Z'};}
const limits=(d,records)=>({schemaVersion:1,source:'szse_pcf',date:d,fetchedAt:at,records:records.map(r=>({date:d,...r}))});
const seed=(kv,s,type='limits')=>kv.store.set(eventKey(s.date,type),JSON.stringify(s));
const failShares=async()=>({ok:false,reason:'source_failure'});
function stage(kv,extra={}){return runEtfPcfEvents({env:{FUND_LIMIT_KV:kv},scheduledTime:Date.parse(at),detectedAt:at,pcfs:[pcf()],sharesFetch:failShares,...extra});}
test('known 159659 2026-09-21 total 2m → 10m ratio=5; net unlimited unchanged',()=>{
 const r=relax(l(2000000),l(10000000),{date:'2026-09-21',prev_date:'2026-09-18'});assert.equal(r.event.ratio,5);
 assert.equal(relax(unlimited,unlimited,{basis:'net'}).event,null);
 assert.equal(creation(10000000).event.ratio,1); // known difference only; no invented absolute shares
});
test('4.99/5; zero denominators and each unlimited transition; unknown/malformed',()=>{
 assert.equal(relax(l(100),l(499)).event,null);assert.equal(relax(l(100),l(500)).event.ratio,5);
 assert.equal(relax(l(0),l(1)).check.reason,'zero_denominator');assert.equal(relax(l(0),l(0)).check.status,'ok');assert.equal(relax(l(1),l(0)).event,null);
 for(const prev of [l(0),l(1)]){const e=relax(prev,unlimited).event;assert.equal(e.ratio,null);assert.equal(e.ratio_kind,'unbounded');assert.equal(e.transition,'to_unlimited');}
 assert.equal(relax(unlimited,l(100)).check.reason,'tightening');assert.equal(relax(unlimited,unlimited).event,null);
 for(const bad of [unknown,null,{kind:'limited',shares:-1},{kind:'unlimited',shares:1}]){assert.equal(relax(bad,l(10)).check.status,'unknown');assert.equal(relax(l(10),bad).check.status,'unknown');}
});
test('89.99/90%, negative/zero differences, unlimited/unknown/zero total',()=>{
 assert.equal(creation(8999000).event,null);assert.equal(creation(9000000).event.ratio,0.9);
 assert.equal(creation(11000000).event.ratio,1.1);assert.equal(creation(-1).check.reason,'negative_net_creation');assert.equal(creation(0).event,null);
 assert.equal(creation(1,unlimited).check.status,'skip');for(const t of [unknown,null,l(0)])assert.equal(creation(1,t).check.status,'unknown');
});
test('weekends/holidays require sequence evidence; T-10 allowed, T-11 forbidden, unknown nearest never backfilled',()=>{
 assert.equal(selectPreviousDate('2026-09-21',['2026-09-18']),null);
 assert.equal(selectPreviousDate('2026-09-21',['2026-09-18'],['2026-09-18']),'2026-09-18');
 assert.equal(selectPreviousDate(date,['2026-10-03'],['2026-10-03']),'2026-10-03');assert.equal(selectPreviousDate(date,['2026-10-02'],['2026-10-02']),null);
 assert.equal(selectPreviousDate(date,['2026-10-09',previous],[previous]),previous);assert.equal(relax(unknown,l(500)).check.status,'unknown');
});
test('merge reruns preserve first detection, yesterday signal1 and next-day signal2',()=>{
 const r=relax(l(100),l(500),{date:previous,prev_date:'2026-10-09'}),old=log(previous,[r]),incoming=log(previous,[creation(10000000)]);
 const combined=mergeEventLogs(old,incoming);assert.equal(combined.events.length,2);
 const rerun=mergeEventLogs(combined,log(previous,[creation(10000000,undefined,{when_detected:'2026-10-13T02:00:00.000Z'})],'2026-10-13T02:00:00.000Z'));
 assert.equal(rerun.events.length,2);assert.equal(rerun.events.find(e=>e.signal_type==='net_creation_near_total_limit').when_detected,at);assert.ok(validateEventLog(rerun,previous,Infinity));
 assert.equal(validateEventLog({...rerun,source:'sse_pcf'},previous,Infinity),false);assert.equal(validateEventLog({...rerun,date},previous,Infinity),false);
});
test('per-key 1s writes, unchanged content skipped, read/write failures and corrupt records never overwritten',async()=>{
 const kv=new KV(),first=log(date,[relax(l(100),l(500))]);await persistEventLog(kv,first);await persistEventLog(kv,{...first,updatedAt:'2026-10-13T02:00:00.000Z',run_id:'rerun'});assert.equal(kv.puts.length,1);
 const next=log(date,[relax(l(100),l(500)),relax(unlimited,l(2),{basis:'net'})]);await persistEventLog(kv,next);assert.ok(kv.puts[1].time-kv.puts[0].time>=1000);assert.equal(kv.puts[0].options,undefined);
 kv.get=async()=>{throw Error('read down');};await assert.rejects(persistEventLog(kv,next));assert.equal(kv.puts.length,2);
 const broken=new KV();broken.store.set(eventKey(date),'bad');await assert.rejects(persistEventLog(broken,first));assert.equal(broken.puts.length,0);
 const writeFail=new KV();writeFail.put=async()=>{throw Error('write down');};await assert.rejects(persistEventLog(writeFail,first));assert.equal(writeFail.store.size,0);
});
test('eventual visibility preserves locally acknowledged signal1 while merging signal2',async()=>{
 const kv=new KV();kv.get=async()=>null;
 await persistEventLog(kv,log(previous,[relax(l(100),l(500),{date:previous,prev_date:'2026-10-09'})]));
 await persistEventLog(kv,log(previous,[creation(10000000)]));assert.equal(JSON.parse(kv.puts.at(-1).value).events.length,2);
});
test('stage permanent snapshots, isolated shares failure and inflight deduplication',async()=>{
 const kv=new KV();seed(kv,limits(previous,[{code:'159941',net:l(100000),total:unlimited}]));let calls=0;
 const opts={sharesFetch:async()=>{calls++;return failShares();}};const a=stage(kv,opts),b=stage(kv,opts);assert.equal(a,b);await a;
 assert.equal(calls,2);const data=JSON.parse(kv.store.get(eventKey(date)));assert.ok(data.events.some(e=>e.code==='159941'&&e.basis==='net'));assert.ok(data.checks.some(c=>c.signal_type==='net_creation_near_total_limit'&&c.status==='unknown'));
 assert.ok(kv.store.has(eventKey(date,'limits')));assert.ok(kv.puts.every(p=>p.options===undefined));
});
test('synthetic two-session historical shares attribute signal2 to T-1 and merge prior signal1',async()=>{
 const kv=new KV();seed(kv,limits(previous,[{code,total:l(10000000),net:unlimited}]));
 await persistEventLog(kv,log(previous,[relax(l(2000000),l(10000000),{date:previous,prev_date:'2026-10-09'})]));
 const records=[{code,date:'2026-10-09',shares:1000,unit:'份'},{code,date:previous,shares:10001000,unit:'份'}]; // SYNTHETIC absolute shares
 const calls=[];await stage(kv,{sharesFetch:async args=>{calls.push(args);return calls.length===1?{ok:false,reason:'missing_report_date'}:{ok:true,source:'szse_fund_report',records};}});
 assert.equal(calls.length,2);const data=JSON.parse(kv.store.get(eventKey(previous)));assert.equal(data.events.length,2);assert.ok(data.events.some(e=>e.signal_type==='net_creation_near_total_limit'&&e.ratio===1));assert.ok(kv.store.has(eventKey(previous,'shares')));
});
test('failed reads stop writes; timeout budget and holiday avoid fabricated limits',async()=>{
 const kv=new KV();kv.get=async()=>{throw Error('kv down');};await stage(kv);assert.equal(kv.puts.length,0);
 const zero=new KV();await stage(zero,{deadlineMs:0});assert.equal(zero.puts.length,0);
 const holiday=new KV();await stage(holiday,{pcfs:[]});assert.equal(holiday.store.has(eventKey(date,'limits')),false);const data=JSON.parse(holiday.store.get(eventKey(date)));assert.equal(data.events.length,0);assert.ok(data.checks.every(c=>c.status==='unknown'));
});
