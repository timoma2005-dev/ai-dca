import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { crc32, unzipXlsx, parseEtfPcfSharesXlsx, fetchEtfPcfShares, decimalShares, supportsRawDeflate, historicalSharesUrl } from '../workers/etf-shares/src/etfPcfShares.js';
// Synthetic minimal OOXML builder; every number/date/header below is synthetic.
export function zip(parts,{method=0,flags=0}={}){
 const locals=[],central=[];let offset=0;
 for(const [name,value] of parts){const n=Buffer.from(name),b=Buffer.from(value),compressed=method===8?deflateRawSync(b):b,c=crc32(b),l=Buffer.alloc(30),d=Buffer.alloc(46);
 l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(flags,6);l.writeUInt16LE(method,8);l.writeUInt32LE(c,14);l.writeUInt32LE(compressed.length,18);l.writeUInt32LE(b.length,22);l.writeUInt16LE(n.length,26);
 d.writeUInt32LE(0x02014b50);d.writeUInt16LE(20,6);d.writeUInt16LE(flags,8);d.writeUInt16LE(method,10);d.writeUInt32LE(c,16);d.writeUInt32LE(compressed.length,20);d.writeUInt32LE(b.length,24);d.writeUInt16LE(n.length,28);d.writeUInt32LE(offset,42);
 locals.push(l,n,compressed);central.push(d,n);offset+=l.length+n.length+compressed.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(parts.length,8);end.writeUInt16LE(parts.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}
const cell=(ref,value,t='inlineStr',style='')=>`<c r="${ref}" t="${t}" ${style}>${t==='inlineStr'?`<is><t>${value}</t></is>`:`<v>${value}</v>`}</c>`;
export function syntheticParts({date='2026-10-12',code='159659',shares='1000',unit='份',dateType='inlineStr',system1904=false,shared=false}={}){
 const row=(n,c)=>`<row r="${n}">${c}</row>`;
 return [
 ['xl/workbook.xml',`<workbook xmlns:r="urn:r"><workbookPr date1904="${system1904}"/><sheets><sheet name="synthetic" r:id="r1"/></sheets></workbook>`],
 ['xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml" Type="urn:worksheet/worksheet"/></Relationships>'],
 ['xl/styles.xml','<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'],
 ['xl/sharedStrings.xml',shared?'<sst><si><t>159659</t></si></sst>':'<sst/>'],
 ['xl/worksheets/sheet1.xml',`<worksheet><sheetData>${row(1,cell('A1','基金代码')+cell('B1',`基金份额(${unit})`)+cell('C1','日期'))}${row(2,cell('A2',shared?'0':code,shared?'s':'inlineStr')+cell('B2',shares)+cell('C2',date,dateType,dateType==='n'?'s="1"':''))}</sheetData></worksheet>`]
 ];
}
test('real current fixture: ZIP/CRC valid; undated report requires a supported verified calendar',async()=>{
 const b=readFileSync(new URL('./fixtures/etf-pcf-events/szse-current-20261013.xlsx',import.meta.url));
 if(!supportsRawDeflate()){await assert.rejects(unzipXlsx(b),/deflate_raw_unavailable/);return;}
 assert.equal((await unzipXlsx(b)).has('xl/worksheets/sheet1.xml'),true);
 await assert.rejects(parseEtfPcfSharesXlsx(b, { fetchedAt: '2027-10-16T01:00:00.000Z' }),/missing_report_date/);
});
test('synthetic stored/deflate, shared strings, only target codes and exact 万份 conversion',async()=>{
 for(const method of [0,...(supportsRawDeflate()?[8]:[])]){
  const records=await parseEtfPcfSharesXlsx(zip(syntheticParts({shared:true,shares:'1.0001',unit:'万份'}),{method}));
  assert.deepEqual(records,[{code:'159659',date:'2026-10-12',shares:10001,unit:'万份'}]);
 }
 assert.equal(decimalShares('9007199254740991','份'),Number.MAX_SAFE_INTEGER);
 for(const [v,u] of [['9007199254740992','份'],['1.00001','万份'],['0.1','份'],['1','元']])assert.throws(()=>decimalShares(v,u));
});
test('synthetic code numeric padding does not turn unrelated leading-zero code into target',async()=>{
 const p=syntheticParts();p[4][1]=p[4][1].replace(cell('A2','159659'),cell('A2','1','n'));await assert.rejects(parseEtfPcfSharesXlsx(zip(p)),/report_shape/);
});
test('synthetic 1900 and 1904 dates require styles; serial 60 and untyped numbers rejected',async()=>{
 const serial=Math.round((Date.parse('2026-10-12')-Date.UTC(1899,11,30))/86400000);
 for(const system1904 of [false,true]){
  const date=system1904?Math.round((Date.parse('2026-10-12')-Date.UTC(1904,0,1))/86400000):serial;
  assert.equal((await parseEtfPcfSharesXlsx(zip(syntheticParts({date:String(date),dateType:'n',system1904}))))[0].date,'2026-10-12');
 }
 await assert.rejects(parseEtfPcfSharesXlsx(zip(syntheticParts({date:'60',dateType:'n'}))),/excel_date/);
 const p=syntheticParts({date:String(serial),dateType:'n'});p[4][1]=p[4][1].replace('s="1"','s="0"');await assert.rejects(parseEtfPcfSharesXlsx(zip(p)),/untyped_date/);
});
test('ZIP security: encryption/methods/ZIP64/path traversal/duplicates/nested/CRC/bounds/bombs',async()=>{
 for(const p of [[['../evil.xml','<x/>']],[['x.xlsx','<x/>']],[['/x.xml','<x/>']],[['x.xml','<x/>'],['x.xml','<x/>']],Array.from({length:33},(_,i)=>[`${i}.xml`,'<x/>'])])await assert.rejects(unzipXlsx(zip(p)));
 for(const opts of [{flags:1},{method:9}])await assert.rejects(unzipXlsx(zip([['x.xml','<x/>']],opts)));
 const bad=zip([['x.xml','<x/>']]);bad[35]^=1;await assert.rejects(unzipXlsx(bad),/crc_or_length/);
 const z64=zip([['x.xml','<x/>']]);z64.writeUInt32LE(0xffffffff,18);await assert.rejects(unzipXlsx(z64));
 await assert.rejects(unzipXlsx(zip([['x.xml','<x>'+ 'a'.repeat(200000)+'</x>']],{method:8})),/zip_bomb/);
 await assert.rejects(unzipXlsx(Buffer.alloc(1048577)),/download_limit/);
});
test('XML security: DTD/entities/malformed/index/text/shared strings/rows/cells',async()=>{
 for(const xml of ['<!DOCTYPE x SYSTEM "https://evil"><x/>','<x>&evil;</x>','<x><a></x>'])await assert.rejects(unzipXlsx(zip([['x.xml',xml]])));
 for(const modify of [p=>p[3][1]='<sst><si><t>'+ 'a'.repeat(4097)+'</t></si></sst>',p=>p[3][1]='<sst>'+ '<si><t>x</t></si>'.repeat(50001)+'</sst>',p=>p[4][1]=p[4][1].replace('<v>0</v>','<v>99</v>')]){const p=syntheticParts({shared:true});modify(p);await assert.rejects(parseEtfPcfSharesXlsx(zip(p)));}
 const rows=syntheticParts();rows[4][1]='<worksheet>'+ '<row r="1"/>'.repeat(20001)+'</worksheet>';await assert.rejects(parseEtfPcfSharesXlsx(zip(rows)),/row_limit/);
 const cells=syntheticParts();cells[4][1]='<worksheet><row r="1">'+Array.from({length:200001},(_,i)=>`<c r="A${i+1}"/>`).join('')+'</row></worksheet>';await assert.rejects(parseEtfPcfSharesXlsx(zip(cells))); // download cap precedes cell cap
});
test('download manual redirect rejects all 3xx, cancels body, HTML, streaming and declared limits',async()=>{
 for(const status of [300,301,302,303,304,307,308,399]){
  let cancelled=0;const r=await fetchEtfPcfShares({fetchImpl:async(_,init)=>{assert.equal(init.redirect,'manual');return {status,body:{cancel:async()=>cancelled++}};}});assert.equal(r.reason,'redirect_rejected');assert.equal(cancelled,1);
 }
 for(const response of [new Response('<html>bad</html>',{headers:{'content-type':'text/html'}}),new Response('x',{headers:{'content-length':'1048577'}}),new Response(new Uint8Array(1048577)),new Response('<html>200</html>')])assert.equal((await fetchEtfPcfShares({fetchImpl:async()=>response})).ok,false);
});
test('download abort/timeout and missing runtime capability degrade unknown',async()=>{
 const wait=(_,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted'))));
 assert.equal((await fetchEtfPcfShares({fetchImpl:wait,timeoutMs:10})).reason,'timeout');
 const ctrl=new AbortController();ctrl.abort();let calls=0;assert.equal((await fetchEtfPcfShares({signal:ctrl.signal,fetchImpl:async()=>{calls++;}})).reason,'timeout');assert.equal(calls,0);
 const original=globalThis.DecompressionStream;globalThis.DecompressionStream=undefined;try{assert.equal(supportsRawDeflate(),false);await assert.rejects(unzipXlsx(zip(syntheticParts(),{method:8})),/deflate_raw_unavailable/);}finally{globalThis.DecompressionStream=original;}
 assert.throws(()=>historicalSharesUrl('2026-01-01','2026-10-01'));
});
test('strict thousands grouping and opt-in report date evidence, rejects inference outside verified calendar coverage', async () => {
  assert.equal(decimalShares('7,062,986,575', '份'), 7062986575);
  for (const value of ['70,62,986,575', '1,00', ',100', '1,000,', '1,000.1']) assert.throws(() => decimalShares(value, '份'));
  const [row] = await parseEtfPcfSharesXlsx(zip(syntheticParts({ shares: '1,000' })), { includeEvidence: true });
  assert.deepEqual(row.dateEvidence, { source: 'szse_fund_report', column: '日期', type: 'iso_date' });
  assert.equal(row.shares, 1000);
  const bytes = readFileSync(new URL('./fixtures/etf-pcf-events/szse-current-20261013.xlsx', import.meta.url));
  await assert.rejects(parseEtfPcfSharesXlsx(bytes, { includeEvidence: true, fetchedAt: '2027-10-16T01:00:00.000Z' }), /missing_report_date/);
});

function undatedParts() {
  const parts = syntheticParts({ code: '159501', shares: '7,077,986,575' });
  parts[4][1] = parts[4][1].replace('基金份额(份)', '当前规模(份)').replace(cell('C1', '日期'), cell('C1', '上市日期'));
  return parts;
}
test('new current-size template infers the prior verified session using Shanghai fetch date', async () => {
  for (const [fetchedAt, date] of [
    ['2026-10-16T01:00:00.000Z', '2026-10-15'],
    ['2026-10-18T01:00:00.000Z', '2026-10-16'],
    ['2026-10-08T01:00:00.000Z', '2026-09-30'],
    ['2026-10-15T16:00:00.000Z', '2026-10-15']
  ]) {
    const [record] = await parseEtfPcfSharesXlsx(zip(undatedParts()), { fetchedAt, includeEvidence: true });
    assert.equal(record.date, date);
    assert.equal(record.shares, 7077986575);
    assert.deepEqual(record.dateEvidence, { source: 'szse_fund_report', column: null, type: 'inferred_from_fetch_time', inferredDate: date });
  }
  await assert.rejects(parseEtfPcfSharesXlsx(zip(undatedParts()), { fetchedAt: '2027-10-16T01:00:00.000Z' }), /missing_report_date/);
  const parts = undatedParts();
  parts[4][1] = parts[4][1].replace('当前规模(份)', '基金份额(份)');
  await assert.rejects(parseEtfPcfSharesXlsx(zip(parts)), /missing_report_date/);
});
test('undated download requires dated historical sample matching both date and exact shares', async () => {
  for (const [date, shares, ok] of [
    ['2026-10-15', '7077986575', true],
    ['2026-10-15', '7077986574', false],
    ['2026-10-14', '7077986575', false]
  ]) {
    const urls = [];
    const result = await fetchEtfPcfShares({ fetchedAt: '2026-10-16T01:00:00.000Z', fetchImpl: async (url) => {
      urls.push(url);
      return new Response(zip(urls.length === 1 ? undatedParts() : syntheticParts({ code: '159501', date, shares })));
    } });
    assert.equal(result.ok, ok);
    if (!ok) assert.equal(result.reason, 'date_mismatch');
    assert.equal(urls[1], historicalSharesUrl('2026-10-15', '2026-10-15'));
    assert.equal(urls.length, 2);
  }
  let calls = 0;
  assert.equal((await fetchEtfPcfShares({ fetchImpl: async () => { calls++; return new Response(zip(syntheticParts())); } })).ok, true);
  assert.equal(calls, 1);
});
