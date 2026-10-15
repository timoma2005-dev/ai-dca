import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { limitRelaxation, netCreationNearTotalLimit, mergeEventLogs, validateEventLog, persistEventLog, eventKey, selectPreviousDate, runEtfPcfEvents, ETF_PCF_FALLBACK_MAX_READS } from '../workers/ocr-proxy/src/etfPcfEvents.js';
import { parseEtfPcf, buildEtfPcfCacheKey } from '../workers/ocr-proxy/src/etfPcfLimit.js';
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
test('projection sidecar reuses bounded downloads; validator/date-put/pointer failures preserve original events and permanent writes', async () => {
  for (const failure of ['none', 'validator', 'put', 'pointer']) {
    const kv = new KV();
    seed(kv, limits(previous, [
      { code: '159941', net: unlimited, total: l(10000000), subscriptionAllowed: true, redemptionAllowed: true },
      { code: '513100', net: unknown, total: unknown, creationRedemption: '仅允许赎回' },
      { code: '513110', net: unknown, total: unknown, creationRedemption: '申购和赎回皆允许' }
    ]));
    const put = kv.put.bind(kv);
    kv.put = async (key, value, opts) => {
      if ((failure === 'put' && key.startsWith('etf-pcf-shares:') && !key.endsWith('latest')) || (failure === 'pointer' && key.endsWith('shares:latest'))) throw Error('synthetic_failure');
      return put(key, value, opts);
    };
    let downloads = 0;
    const fetchedAt = new Date(Date.now() - 1000).toISOString();
    const sharesFetch = async () => {
      downloads++;
      return { ok: true, source: 'szse_fund_report', fetchedAt, records: [
        { code: '159941', date: previous, shares: 10001000, unit: '份', ...(failure === 'validator' ? {} : { dateEvidence: { source: 'szse_fund_report', column: '日期', type: 'iso_date' } }) },
        { code: '159941', date: '2026-10-09', shares: 1000, unit: '份', dateEvidence: { source: 'szse_fund_report', column: '日期', type: 'iso_date' } }
      ] };
    };
    const result = await stage(kv, { sharesFetch });
    assert.equal(result.ok, true); assert.equal(downloads, 2);
    const events = JSON.parse(kv.store.get(eventKey(previous)));
    assert.ok(events.events.some(e => e.signal_type === 'net_creation_near_total_limit'));
    assert.ok(kv.store.has(eventKey(date, 'limits')));
    assert.ok(kv.puts.filter(p => p.key.startsWith('etf-pcf-events')).every(p => p.options === undefined));
    if (failure === 'none') {
      const data = JSON.parse(kv.store.get('etf-pcf-shares:20261012'));
      assert.equal(data.records.find(r => r.code === '159941').deltaShares, 10000000);
      assert.equal(data.records.find(r => r.code === '159941').atLimit, true);
      assert.equal(data.records.length, 13);
      assert.equal(data.records.find(r => r.code === '159941').creationShares, 10000000);
      assert.equal(data.records.find(r => r.code === '159941').creationSharesKind, 'estimate');
      assert.equal(data.records.find(r => r.code === '513100').creationShares, 0);
      assert.equal(data.records.find(r => r.code === '513100').creationSharesKind, 'exact');
      assert.equal(data.records.find(r => r.code === '513110').creationShares, null);
      const snapshot = JSON.parse(kv.store.get(eventKey(date, 'limits')));
      assert.equal(snapshot.records.find(r => r.code === '159941').subscriptionAllowed, true);
      assert.match(data.calendar.notice, /szse\.cn/);
      assert.ok(kv.store.has('etf-pcf-shares:latest'));
    }
    if (failure === 'pointer') assert.ok(kv.store.has('etf-pcf-shares:20261012'));
  }
});

test('SSE status uses validated date-specific KV cache only; expired/source/identity misses stay unknown', async () => {
  const { mapSsePcfFields, buildSsePcfCacheKey, buildSsePcfSourceUrl } = await import('../workers/ocr-proxy/src/ssePcfLimit.js');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/etf-pcf-sse/SSE51310020261013.json', import.meta.url)));
  for (const failure of ['none', 'expired', 'source', 'identity']) {
    const kv = new KV();
    const cached = {
      ...mapSsePcfFields(fixture.result[0], { code: '513100', now: new Date(at) }),
      sourceUrl: buildSsePcfSourceUrl('513100'), fetchedAt: at, expiresAt: '2026-10-14T01:00:00.000Z'
    };
    if (failure === 'expired') cached.expiresAt = at;
    if (failure === 'source') cached.source = 'szse_pcf';
    if (failure === 'identity') cached.code = '513110';
    kv.store.set(buildSsePcfCacheKey('513100', date), JSON.stringify(cached));
    const result = await stage(kv);
    assert.equal(result.ok, true);
    const snapshot = JSON.parse(kv.store.get(eventKey(date, 'limits')));
    const row = snapshot.records.find(r => r.code === '513100');
    if (failure === 'none') {
      assert.equal(row.subscriptionAllowed, false);
      assert.equal(row.redemptionAllowed, true);
      assert.equal(row.creationRedemption, '仅允许赎回');
      assert.deepEqual(row.total, unknown);
    } else assert.equal(row, undefined);
    assert.ok(kv.gets.includes(buildSsePcfCacheKey('513100', date)));
    assert.ok(kv.puts.every(p => !p.key.startsWith('sse-pcf:')));
  }
});

test('limit_relaxation tier: 5x, 10x, unlimited', () => {
  // 5x tier: ratio 5-9.99
  const r5 = relax(l(100), l(500));
  assert.equal(r5.event.tier, '5x');
  assert.equal(r5.event.ratio, 5);

  const r8 = relax(l(100), l(800));
  assert.equal(r8.event.tier, '5x');
  assert.equal(r8.event.ratio, 8);

  // 10x tier: ratio >= 10
  const r10 = relax(l(100), l(1000));
  assert.equal(r10.event.tier, '10x');
  assert.equal(r10.event.ratio, 10);

  const r15 = relax(l(100), l(1500));
  assert.equal(r15.event.tier, '10x');

  // unlimited tier: transition to unlimited
  const rUnlimited = relax(l(100), unlimited);
  assert.equal(rUnlimited.event.tier, 'unlimited');
  assert.equal(rUnlimited.event.ratio, null);
  assert.equal(rUnlimited.event.transition, 'to_unlimited');
});

test('validateEventLog accepts tier field', () => {
  const r5 = relax(l(100), l(500), {code: '159501'});
  const r10 = relax(l(100), l(1000), {code: '159659'});
  const rUnlimited = relax(l(100), unlimited, {code: '159660'});
  const testLog = log(date, [r5, r10, rUnlimited]);
  assert.ok(validateEventLog(testLog, date));
});

test('fallback baseline populates history when snapshot missing', async () => {
  const kv = new KV();
  for (const code of ['159941', '159659', '159660', '159696', '159632']) {
    kv.store.set(buildEtfPcfCacheKey(code, previous), JSON.stringify({
      ...pcf(), code, date: previous, netSubscribeLimitKind: 'limited', netSubscribeLimitShares: 100000
    }));
  }
  const result = await stage(kv);
  assert.equal(result.ok, true);
  const data = JSON.parse(kv.store.get(eventKey(date)));
  const event = data.events.find(e => e.signal_type === 'limit_relaxation' && e.code === '159941' && e.basis === 'net');
  assert.ok(event);
  assert.equal(event.ratio, 13);
  assert.equal(event.tier, '10x');
  assert.equal(data.checks.find(c => c.signal_type === 'limit_relaxation' && c.code === '159941' && c.basis === 'net').status, 'ok');
  assert.ok(kv.puts.every(p => p.key !== eventKey(previous, 'limits')));
});

test('fallback below 50% coverage leaves baseline empty', async () => {
  const kv = new KV();
  for (const code of ['159941', '159659', '159660']) {
    kv.store.set(buildEtfPcfCacheKey(code, previous), JSON.stringify({
      ...pcf(), code, date: previous, netSubscribeLimitKind: 'limited', netSubscribeLimitShares: 100000
    }));
  }
  const result = await stage(kv);
  assert.equal(result.ok, true);
  const data = JSON.parse(kv.store.get(eventKey(date)));
  assert.equal(data.checks.find(c => c.signal_type === 'limit_relaxation' && c.code === '159941' && c.basis === 'net').status, 'unknown');
});

test('invalid fallback entries skipped gracefully', async () => {
  const kv = new KV();
  for (const code of ['159501', '159509', '159513', '159632', '159659', '159660', '159696', '159941']) {
    kv.store.set(buildEtfPcfCacheKey(code, previous), JSON.stringify({ schemaVersion: 1, source: 'wrong_source', code, date: previous }));
  }
  kv.store.set(buildEtfPcfCacheKey('159501', previous), 'not-json');
  const result = await stage(kv);
  assert.equal(result.ok, true);
  const data = JSON.parse(kv.store.get(eventKey(date)));
  assert.equal(data.events.length, 0);
  assert.ok(data.checks.every(c => c.status === 'unknown'));
});

// ─── 方案 B：快照解耦、fallback 收敛与持久化预算 ───────────────────
const back = (n) => new Date(Date.parse(date) - n * 86400000).toISOString().slice(0, 10);
const today = date.replaceAll('-', '');
const perCodeKey = (k) => /^etf-pcf:\d{6}:\d{8}$/.test(k);
// fallback 只读历史日期；当日 etf-pcf:<513xxx> 是 SSE 申赎状态读取，不计入。
const fallbackGets = (kv) => kv.gets.filter((k) => perCodeKey(k) && !k.endsWith(today));

test('complete snapshots skip per-code fallback reads', async () => {
  const kv = new KV();
  for (let i = 1; i <= 10; i++) {
    const d = back(i);
    seed(kv, limits(d, [{ code: '159941', net: l(100000), total: unlimited }]));
    kv.store.set(eventKey(d, 'shares'), JSON.stringify({
      schemaVersion: 1, source: 'szse_fund_report', date: d, fetchedAt: at,
      records: [{ code: '159941', date: d, shares: 1000, unit: '份' }]
    }));
  }
  const result = await stage(kv);
  assert.equal(result.ok, true);
  assert.equal(fallbackGets(kv).length, 0); // 快照齐全不触发单条 fallback
  assert.ok(kv.store.has(eventKey(date, 'limits'))); // 当日 limits 快照独立保存
});

test('all-missing snapshots with unconfirmed calendar bound fallback reads', async () => {
  const kv = new KV();
  const result = await stage(kv, { tradingCalendar: null });
  assert.equal(result.ok, true);
  const gets = fallbackGets(kv);
  assert.equal(gets.length, ETF_PCF_FALLBACK_MAX_READS); // 读取次数受明确上限控制
  assert.ok(gets.includes(buildEtfPcfCacheKey('159941', back(1))));
  assert.ok(!gets.includes(buildEtfPcfCacheKey('159941', back(9)))); // 最近日期优先，超限日不再读取
  const data = JSON.parse(kv.store.get(eventKey(date)));
  assert.equal(data.events.length, 0);
  assert.ok(data.checks.filter(c => c.signal_type === 'limit_relaxation')
    .every(c => c.status === 'unknown' && c.reason === 'unconfirmed_previous_session'));
  assert.ok(kv.store.has(eventKey(date, 'limits')));
});

test('fallback reads skip non-session dates in the 10-day window', async () => {
  const kv = new KV();
  const result = await stage(kv);
  assert.equal(result.ok, true);
  const gets = fallbackGets(kv);
  assert.ok(gets.length > 0 && gets.length <= ETF_PCF_FALLBACK_MAX_READS);
  for (const weekend of ['20261003', '20261004', '20261010', '20261011'])
    assert.ok(!gets.some(k => k.endsWith(weekend)), weekend); // 周末无 PCF，不浪费读取
});

test('hanging shares source cannot block limits snapshot or limit events', async () => {
  const kv = new KV();
  seed(kv, limits(previous, [{ code: '159941', net: l(100000), total: unlimited }]));
  const result = await stage(kv, { deadlineMs: 2000, sharesFetch: () => new Promise(() => {}) });
  assert.equal(result.ok, true); // shares 下载在预算内止损，事件阶段继续完成
  assert.ok(kv.store.has(eventKey(date, 'limits')));
  const data = JSON.parse(kv.store.get(eventKey(date)));
  assert.ok(data.events.some(e => e.code === '159941' && e.basis === 'net')); // 限额事件不受 shares 故障阻断
  assert.ok(data.checks.some(c => c.signal_type === 'net_creation_near_total_limit' && c.reason === 'timeout'));
});

test('fallback KV read failures never become an empty baseline', async () => {
  const kv = new KV();
  const store = kv.store;
  kv.get = async (key) => {
    if (/^etf-pcf:159\d{3}:\d{8}$/.test(key)) throw Error('kv read down');
    return store.get(key) ?? null;
  };
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const result = await stage(kv);
    assert.equal(result.ok, true);
    assert.ok(kv.store.has(eventKey(date, 'limits'))); // fallback 失败不阻断当日快照保存
    const data = JSON.parse(kv.store.get(eventKey(date)));
    assert.equal(data.events.length, 0); // 不冒充基准，无伪造事件
    const check = data.checks.find(c => c.signal_type === 'limit_relaxation' && c.code === '159941' && c.basis === 'net');
    assert.equal(check.status, 'unknown');
    assert.equal(check.reason, 'baseline_read_failed'); // 读取失败与缺失明确区分
    assert.ok(warns.some(w => w.includes('etf_pcf_events_fallback_read_failed'))); // 明确报错
  } finally {
    console.warn = originalWarn;
  }
});

test('older dated fallback data cannot replace the missing previous session', async () => {
  const kv = new KV();
  for (const code of ['159941', '159659', '159660', '159696', '159632']) {
    kv.store.set(buildEtfPcfCacheKey(code, '2026-10-09'), JSON.stringify({
      ...pcf(), code, date: '2026-10-09', netSubscribeLimitKind: 'limited', netSubscribeLimitShares: 100000
    }));
  }
  const result = await stage(kv);
  assert.equal(result.ok, true);
  const data = JSON.parse(kv.store.get(eventKey(date)));
  assert.equal(data.events.length, 0); // 最近交易日基准缺失时不用 T-2 造信号
  const check = data.checks.find(c => c.signal_type === 'limit_relaxation' && c.code === '159941' && c.basis === 'net');
  assert.equal(check.status, 'unknown');
  assert.equal(check.reason, 'unconfirmed_recent_baseline');
});
