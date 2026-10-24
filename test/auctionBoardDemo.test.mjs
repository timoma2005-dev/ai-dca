import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { setImmediate } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { AUCTION_BOARD_DEMO_FILE, buildAuctionBoardDemoHtml } from '../scripts/vite/auctionBoardDemoPage.mjs';
import { RADAR_DEMO_ETFS } from '../src/app/demo/fixtures/adminRadar.js';
import { DEMO_FEATURES, demoFeatureFor } from '../src/app/demo/featureDemo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BOARD_HTML = read('public/auction-board.html');
const DEMO_JS = read('public/auction-board-demo.js');
const boardScript = (html) => html.match(/<script>([\s\S]*?)<\/script>/)[1];

// 极简 DOM：只够看板脚本 / 演示引擎运行，并记录一切可能发出网络请求的入口。
function createPage({ demo, date = '2026-10-23', speed }) {
  const net = [];
  const store = new Map();
  const writes = [];
  const els = new Map();
  const timers = { timeouts: [], intervals: [] };
  let real = 1_000_000;
  function el(id = '') {
    const attrs = {};
    const listeners = {};
    const set = new Set();
    const node = {
      id, textContent: '', innerHTML: '', className: '', value: '', checked: false, style: {}, children: [], firstChild: null,
      classList: { toggle(c, on) { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); }, add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) },
      setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null),
      addEventListener(t, f) { (listeners[t] ||= []).push(f); }, listeners,
      insertBefore() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
    };
    return node;
  }
  const byId = (id) => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); };
  byId('segs').children = Array.from({ length: 5 }, () => el());
  const mseg = ['all', 'zone', 'halt'].map((f) => { const b = el(); b.setAttribute('data-f', f); return b; });
  const top = el('top');
  const document = {
    title: '纳指期指与ETF竞价看板',
    head: { appendChild: (n) => net.push(`append:${n.tag}:${n.src || ''}`) },
    body: el('body'),
    getElementById: byId,
    createElement(tag) { const n = el(); n.tag = tag; if (/^(script|img|iframe|link)$/i.test(tag)) net.push(`create:${tag}`); return n; },
    querySelector: (sel) => (sel === '.top' ? top : null),
    querySelectorAll: (sel) => (sel === '#mseg button' ? mseg : []),
    addEventListener() {},
  };
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { writes.push(k); store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const ctx = {
    document, localStorage, console: globalThis.console, Promise, JSON, Math, Date, Object, Array, String, Number, RegExp, Error, isFinite, parseFloat, decodeURIComponent,
    location: { origin: 'https://demo.test', hash: '', search: speed ? `?speed=${speed}` : '', reload() {} },
    history: { replaceState() {} },
    fetch: () => { net.push('fetch'); return Promise.reject(new Error('blocked')); },
    XMLHttpRequest: function XMLHttpRequest() { net.push('xhr'); },
    Image: function Image() { net.push('image'); },
    setTimeout: (fn) => { timers.timeouts.push(fn); return timers.timeouts.length; },
    clearTimeout() {},
    setInterval: (fn) => { timers.intervals.push(fn); return timers.intervals.length; },
    addEventListener() {},
    postMessage() {},
  };
  ctx.window = ctx;
  ctx.parent = ctx;
  if (demo) ctx.AUCTION_BOARD_DEMO_OPTIONS = { date, realNow: () => real };
  vm.createContext(ctx);
  const html = demo ? buildAuctionBoardDemoHtml(BOARD_HTML) : BOARD_HTML;
  if (demo) vm.runInContext(DEMO_JS, ctx, { filename: 'auction-board-demo.js' });
  vm.runInContext(boardScript(html), ctx, { filename: 'auction-board.html' });
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    ctx, net, store, writes, $: byId,
    advance(ms) { real += ms; },
    // 触发一次数据刷新（同"刷新"按钮）+ 时钟 tick
    async refresh() { await flush(); for (const f of byId('refresh').listeners.click || []) f(); await flush(); await flush(); for (const f of timers.intervals) f(); },
    async at(hm) { ctx.AUCTION_BOARD_DEMO.seek(hm); await this.refresh(); },
    log: () => byId('log').innerHTML,
  };
}

test('demo page is generated from the formal board: same script, demo engine injected first', () => {
  const html = buildAuctionBoardDemoHtml(BOARD_HTML);
  assert.equal(AUCTION_BOARD_DEMO_FILE, 'auction-board-demo.html');
  assert.equal(boardScript(html), boardScript(BOARD_HTML));
  assert.ok(html.indexOf('<script src="./auction-board-demo.js"></script>') < html.indexOf('<script>'));
  assert.match(html, /<title>【演示数据】纳指期指与ETF竞价看板<\/title>/);
  assert.throws(() => buildAuctionBoardDemoHtml(BOARD_HTML.replace('<script>', '<script>1</script><script>')));
  assert.match(read('vite.config.js'), /auctionBoardDemoPlugin\(\{ root: HERE \}\)/);
});

test('demo premiums keep the radar demo ranking and spreads; only a couple exceed 10%', () => {
  const page = createPage({ demo: true });
  const etfs = JSON.parse(JSON.stringify(page.ctx.AUCTION_BOARD_DEMO.etfs)); // vm 跨 realm，转成本 realm 对象再比较
  assert.deepEqual(etfs.map((e) => e.code), RADAR_DEMO_ETFS.map((e) => e.code));
  for (const e of etfs) {
    const radar = RADAR_DEMO_ETFS.find((r) => r.code === e.code);
    assert.equal(e.radarBase, radar.base);
    assert.equal(e.name, radar.name);
  }
  assert.deepEqual(etfs.filter((e) => e.premium > 10).map((e) => e.code).sort(), ['159501', '513100']);
});

test('demo page never requests real market data and only writes demo_ storage keys', async () => {
  const page = createPage({ demo: true });
  for (const hm of ['09:16', '09:45', '10:40', '13:10', '14:58', '15:03']) await page.at(hm);
  page.$('thr').listeners.input[0].call({ value: '0.25' });
  assert.deepEqual(page.net, []);
  assert.ok(page.writes.length > 0);
  assert.ok(page.writes.every((k) => k.startsWith('demo_')), page.writes.join(','));
  assert.ok(!page.store.has('nqCfg') && !page.store.has('nqLog') && !page.store.has('nqHeld'));
});

test('simulated clock starts at 09:15 and runs through auction (half speed), lunch (fast) and close', () => {
  const page = createPage({ demo: true });
  const demo = page.ctx.AUCTION_BOARD_DEMO;
  assert.equal(demo.simSec(), 9 * 3600 + 15 * 60);
  page.advance(10_000); // 竞价阶段 ×30：10 秒 = 5 分钟
  assert.equal(Math.round(demo.simSec()), 9 * 3600 + 20 * 60);
  page.advance(30_000); // 20 秒到 09:30，余 10 秒 ×60 → 09:40
  assert.equal(Math.round(demo.simSec()), 9 * 3600 + 40 * 60);
  demo.seek('11:29');
  page.advance(1_000 + 9_000); // 1 秒到 11:30，午休 ×600：9 秒 = 90 分钟
  assert.equal(Math.round(demo.simSec()), 13 * 3600);
  page.advance(3_600_000);
  assert.equal(Math.round(demo.simSec()), 15 * 3600 + 5 * 60); // 15:05 停住
  const total = (15 * 60) / 30 + (120 * 60) / 60 + (90 * 60) / 600 + (125 * 60) / 60;
  assert.ok(total <= DEMO_FEATURES.adminAuction.durationSec, `播完需 ${total} 秒`);
});

test('clock-driven states: auction halt, resume, regression switch, candidates in/out, sell-and-wait, close', async () => {
  const page = createPage({ demo: true });
  await page.refresh();
  assert.equal(page.$('phase').textContent, '集合竞价');
  assert.match(page.$('etf-body').innerHTML, /溢价&gt;10%，预计停牌至10:30|溢价>10%，预计停牌至10:30/);
  assert.match(page.$('act-h').innerHTML, /纳指ETF国泰|国泰/);
  assert.match(page.$('act-h').innerHTML, /停牌中/);
  assert.equal(page.$('hold-src').textContent, '演示持仓');
  assert.match(page.$('hold-name').textContent, /513100/);
  assert.match(page.$('hold-kv').innerHTML, /本轮买入/);

  await page.at('09:27');
  assert.equal(page.$('phase').textContent, '竞价结束');
  await page.at('09:35');
  assert.equal(page.$('phase').textContent, '连续竞价');
  assert.match(page.$('act-h').innerHTML, /继续持有 国泰/);
  assert.match(page.log(), /国泰 复牌/);
  assert.match(page.$('etf-body').innerHTML, /<span class="st halt">停牌<\/span>/); // 嘉实真实停牌

  await page.at('09:55');
  assert.match(page.log(), /国泰 偏离回到 0 → 回归/);
  assert.match(page.$('act-h').innerHTML, /切换：卖出 <span class="hs">国泰<\/span> → 买入 <span class="hl">华泰柏瑞<\/span>/);

  await page.at('10:25');
  assert.match(page.log(), /华泰柏瑞 离开买入区/);
  assert.match(page.log(), /大成 进入买入区/);
  assert.match(page.$('act-h').innerHTML, /买入 <span class="hl">大成<\/span>/);

  await page.at('10:35');
  assert.match(page.log(), /嘉实 复牌/);
  await page.at('11:10');
  assert.match(page.log(), /国泰 偏离 ≥ \+0\.2/);
  assert.match(page.$('act-h').innerHTML, /卖出 <span class="hs">国泰<\/span>，等回 0 买回/);

  await page.at('12:00');
  assert.equal(page.$('phase').textContent, '午休');
  await page.at('13:50');
  assert.match(page.log(), /富国 进入买入区/);
  await page.at('14:40');
  assert.match(page.log(), /博时 进入买入区/);
  assert.match(page.$('act-h').innerHTML, /切换：卖出 <span class="hs">国泰<\/span> → 买入 <span class="hl">博时<\/span>/);
  await page.at('14:58');
  assert.equal(page.$('phase').textContent, '收盘集合竞价');
  await page.at('15:02');
  assert.equal(page.$('phase').textContent, '已收盘');
  assert.equal(page.$('act-h').innerHTML, '非交易时段');
});

test('demo is deterministic and weekend-safe (Monday base is the previous Friday 15:00)', () => {
  const a = createPage({ demo: true, date: '2026-10-26' }).ctx.AUCTION_BOARD_DEMO;
  const b = createPage({ demo: true, date: '2026-10-23' }).ctx.AUCTION_BOARD_DEMO;
  assert.equal(a.prevDay, '2026-10-23');
  const sa = a.snapshot(10 * 3600);
  const sb = b.snapshot(10 * 3600);
  assert.equal(sa.nq.base.t, '2026-10-23 15:00');
  assert.equal(sa.etf.sh513100.cur.toFixed(6), sb.etf.sh513100.cur.toFixed(6));
  assert.equal(sa.nq.pts.at(-1).p, sb.nq.pts.at(-1).p);
});

test('demo ignores parent holdings messages; formal board still uses real sources and unprefixed keys', async () => {
  assert.match(BOARD_HTML, /if \(ev\.origin !== location\.origin \|\| ENV\.held\) return;/);
  const page = createPage({ demo: false });
  await new Promise((r) => setImmediate(r));
  assert.ok(page.net.includes('create:script'), 'formal board loads JSONP market scripts');
  assert.match(BOARD_HTML, /push2his\.eastmoney\.com\/api\/qt\/stock\/trends2\/get\?secid=103\.NQ00Y/);
  assert.match(BOARD_HTML, /https:\/\/qt\.gtimg\.cn\/q=/);
  assert.match(BOARD_HTML, /fundmobapi\.eastmoney\.com\/FundMNewApi\/FundMNFInfo/);
  page.$('thr').listeners.input[0].call({ value: '0.3' });
  assert.ok(page.store.has('nqCfg'));
  assert.ok(page.writes.every((k) => !k.startsWith('demo_')));
});

test('adminAuction feature demo is ready and embeds the demo page instead of the gated board', () => {
  const feature = demoFeatureFor('adminAuction');
  assert.ok(feature);
  assert.match(feature.pitch, /09:15/);
  const src = read('src/pages/AdminAuctionExperience.jsx');
  assert.match(src, /export const AUCTION_BOARD_SRC = '\/auction-board\.html';/);
  assert.match(src, /export const AUCTION_BOARD_DEMO_SRC = '\/auction-board-demo\.html';/);
  assert.match(src, /const \[demo\] = useState\(\(\) => isFeatureDemoActive\(\)\);/);
  assert.match(src, /src=\{demo \? AUCTION_BOARD_DEMO_SRC : AUCTION_BOARD_SRC\}/);
  assert.match(src, /if \(demo \|\| !target \|\| !readyRef\.current\) return;/);
  assert.match(src, /if \(demo\) return undefined;/);
});
