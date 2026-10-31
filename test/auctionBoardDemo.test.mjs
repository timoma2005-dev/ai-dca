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
function createPage({ demo, date = '2026-10-23', speed, real: realData }) {
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
    // 演示引擎只允许同步读一次服务端录制的竞价（/api/notify/demo-teaser/auction）；这里返回 503，走模拟行情
    XMLHttpRequest: function XMLHttpRequest() {
      this.status = 0;
      this.open = (method, url) => { this.url = url; };
      this.send = () => { net.push(this.url === '/api/notify/demo-teaser/auction' ? 'teaser' : `xhr:${this.url}`); this.status = 503; };
    },
    Image: function Image() { net.push('image'); },
    setTimeout: (fn) => { timers.timeouts.push(fn); return timers.timeouts.length; },
    clearTimeout() {},
    setInterval: (fn) => { timers.intervals.push(fn); return timers.intervals.length; },
    addEventListener() {},
    postMessage() {},
  };
  ctx.window = ctx;
  ctx.parent = ctx;
  if (demo) ctx.AUCTION_BOARD_DEMO_OPTIONS = { date, realNow: () => real, ...(realData ? { real: realData } : {}) };
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
  assert.deepEqual(page.net, ['teaser'], 'only the server-side auction teaser is asked, never a quote provider');
  assert.ok(page.writes.length > 0);
  assert.ok(page.writes.every((k) => k.startsWith('demo_')), page.writes.join(','));
  assert.ok(!page.store.has('nqCfg') && !page.store.has('nqLog') && !page.store.has('nqHeld'));
});

test('simulated clock starts at 09:15 and runs through auction (half speed), lunch (fast) and close', () => {
  const page = createPage({ demo: true, speed: 60 });
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
});

test('default speed plays 09:15 → close (15:05 stop) within the 3-minute time-limited demo; speed buttons kept', () => {
  assert.equal(DEMO_FEATURES.adminAuction.limit, 'time');
  assert.equal(DEMO_FEATURES.adminAuction.durationSec, 180);
  const page = createPage({ demo: true });
  const demo = page.ctx.AUCTION_BOARD_DEMO;
  const speed = page.ctx.AUCTION_BOARD_ENV.defaultSpeed;
  assert.equal(speed, 120);
  const total = (15 * 60) / (speed / 2) + (120 * 60) / speed + (90 * 60) / (speed * 10) + (125 * 60) / speed;
  assert.ok(total <= 170, `播完需 ${total} 秒，需留出加载余量`);
  page.advance(Math.ceil(total * 1000) - 2_000);
  assert.ok(demo.simSec() < 15 * 3600 + 5 * 60, 'not finished before the computed total');
  page.advance(2_000);
  assert.equal(Math.round(demo.simSec()), 15 * 3600 + 5 * 60, '收盘后停在 15:05');
  const src = fs.readFileSync(path.join(ROOT, 'public/auction-board-demo.js'), 'utf8');
  for (const n of [60, 120, 240]) assert.match(src, new RegExp(`data-speed="${n}"`));
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
  assert.match(page.log(), /国泰 偏离 ≥ \+0\.1 → 达切换线/);
  assert.match(page.$('act-h').innerHTML, /切换：卖出 <span class="hs">国泰<\/span> → 买入 <span class="hl">华泰柏瑞<\/span>/);

  await page.at('10:25');
  assert.match(page.log(), /华泰柏瑞 离开买入区/);
  assert.match(page.log(), /大成 进入买入区/);
  assert.match(page.$('act-h').innerHTML, /买入 <span class="hl">大成<\/span>/);

  await page.at('10:35');
  assert.match(page.log(), /嘉实 复牌/);
  await page.at('11:10');
  assert.match(page.$('act-h').innerHTML, /继续持有 国泰/);
  assert.match(page.$('act-p').innerHTML, /已达切换线，暂无买入区候选，继续持有不空仓/);
  assert.doesNotMatch(page.$('act-h').innerHTML, /等回 0/);

  await page.at('12:00');
  assert.equal(page.$('phase').textContent, '午休');
  await page.at('13:50');
  assert.match(page.log(), /富国 进入买入区/);
  await page.at('14:40');
  assert.match(page.log(), /博时 进入买入区/);
  // 候选按回归概率优先：富国（近 5 月 76%）排在博时（57%）前
  assert.match(page.$('act-h').innerHTML, /切换：卖出 <span class="hs">国泰<\/span> → 买入 <span class="hl">富国<\/span>/);
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
  assert.ok(feature.points.some((point) => /纳指期货/.test(point)));
  const src = read('src/pages/AdminAuctionExperience.jsx');
  assert.match(src, /export const AUCTION_BOARD_SRC = '\/auction-board\.html';/);
  assert.match(src, /export const AUCTION_BOARD_DEMO_SRC = '\/auction-board-demo\.html';/);
  assert.match(src, /const demo = useDemoActive\(\);/);
  assert.match(src, /src=\{demo \? AUCTION_BOARD_DEMO_SRC : AUCTION_BOARD_SRC\}/);
  assert.match(src, /if \(demo \|\| !target \|\| !readyRef\.current\) return;/);
  assert.match(src, /if \(demo\) return undefined;/);
});

test('real replay: server frames drive the board (top 3 only), clock covers 09:15 → 09:31, no demo holding', async () => {
  const q = (code, cur, pre) => ({ full: code, code, cur, pre, open: cur, b1: cur, b1v: 10, a1: cur, a1v: 8, t: '20261026092000', vol: 100, flag: '' });
  const frame = (s, cur) => ({ s, etfTime: '20261026092000', nqLast: { t: '2026-10-26 09:20', p: 101 }, etf: { sh513100: q('513100', cur, 2), sz159513: q('159513', 1.8, 1.8) } });
  const real = {
    mode: 'replay', date: '2026-10-26', topN: 3, total: 12,
    nq: { pts: [{ t: '2026-10-23 15:00', p: 100 }], base: { t: '2026-10-23 15:00', p: 100, approx: false }, src: 'x' },
    nav: { 513100: { nav: 1.9, date: 'd', src: 'fm' } },
    frames: [frame(33300, 2.0), frame(34000, 2.02), frame(34260, 2.04)],
  };
  const page = createPage({ demo: true, real });
  const env = page.ctx.AUCTION_BOARD_ENV;
  const demo = page.ctx.AUCTION_BOARD_DEMO;
  assert.equal(env.real, 'replay');
  assert.equal(demo.day, '2026-10-26');
  assert.equal(env.held.length, 0);
  assert.equal(demo.simSec(), 33300);
  assert.equal(env.load().etf.sh513100.cur, 2.0);
  demo.seek(34100);
  const snap = env.load();
  assert.equal(snap.etf.sh513100.cur, 2.02);
  assert.equal(Object.keys(snap.etf).length, 2);
  assert.equal(snap.nq.pts.at(-1).p, 101);
  page.advance(600_000);
  assert.equal(demo.simSec(), 34260, 'stops at the last recorded frame');
  assert.deepEqual(page.net, [], 'replay data was handed in, nothing fetched');
});
test('simulated switch panel: estimate at bid/ask, history ranges, paper tracking stored under demo prefix', async () => {
  const page = createPage({ demo: true });
  await page.at('10:40');
  page.$('sim-open').listeners.click[0]();
  const out = page.$('sim-out').innerHTML;
  assert.match(out, /成交价偏离差/);
  assert.match(out, /今日到收盘（历史）/);
  assert.match(out, /持有 5 个交易日/);
  assert.match(out, /佣金（万0.5 × 2）/);
  assert.match(out, /−0\.01%/, 'commission 2 × 0.005% shown');
  assert.match(page.$('sim-from').innerHTML, /513100" selected/, 'defaults to the held fund');
  page.$('sim-to').listeners.change[0].call({ value: '513100' });
  assert.match(page.$('sim-out').innerHTML, /请选择两只不同的基金/);
  page.$('sim-to').listeners.change[0].call({ value: '159941' });
  page.$('sim-amt').listeners.input[0].call({ value: '50000' });
  page.$('sim-rec').listeners.click[0]();
  assert.match(page.$('sim-paper').innerHTML, /纸面跟踪/);
  const saved = JSON.parse(page.store.get('demo_nqSim'));
  assert.equal(saved.amt, 50000);
  assert.equal(saved.paper.length, 1);
  assert.equal(saved.paper[0].z, '159941');
  assert.equal(saved.paper[0].qtyA % 100, 0);
  page.$('sim-paper').listeners.click[0]({ target: { getAttribute: (k) => (k === 'data-del' ? '0' : null) } });
  assert.equal(JSON.parse(page.store.get('demo_nqSim')).paper.length, 0);
  assert.deepEqual(page.net, ['teaser']);
});

// v2 信息架构（2026-10-31）：主屏「下一步」主卡 + NQ + 持仓 + 行情；工具抽屉 / 设置 / 说明 三个弹层同一时间只开一个。
const between = (html, from, to) => {
  const a = html.indexOf(from);
  assert.ok(a >= 0, from);
  const b = to ? html.indexOf(to, a + from.length) : html.length;
  assert.ok(b > a, to);
  return html.slice(a, b);
};

test('v2 layout: main screen keeps strategy card, NQ, holding and one market card; tools/settings/info live in overlays', () => {
  const html = BOARD_HTML.split('<script>')[0];
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  for (const id of ['act-h', 'act-flow', 'cyc', 'cyc-s1-rec', 'nq-pct', 'hold-name', 'hold-amt', 'mview', 'mseg', 'cols-btn', 'etf-body', 'm-items', 'bars']) assert.match(main, new RegExp(`id="${id}"`), `main has ${id}`);
  for (const id of ['tl-buy', 'sim-from', 'sim-paper', 'cyc-log-b', 'thr', 'log', 'rule-txt', 'ntf-toggle']) assert.doesNotMatch(main, new RegExp(`id="${id}"`), `main no longer has ${id}`);
  const tools = between(html, 'id="ov-tools"', 'id="ov-set"');
  for (const id of ['tl-buy', 'tl-bpx', 'tl-sell', 'tl-spx', 'tl-amt', 'tl-fill', 'tl-rec', 'tl-clr', 'tl-out', 'sim-from', 'sim-to', 'sim-amt', 'sim-out', 'sim-rec', 'sim-paper', 'cyc-st', 'cyc-log-b']) assert.match(tools, new RegExp(`id="${id}"`), `tools has ${id}`);
  const set = between(html, 'id="ov-set"', 'id="ov-info"');
  const pane = (p) => between(set, `data-p="${p}"`, { a: 'data-p="b"', b: 'data-p="c"', c: 'id="cfg-reset"' }[p]);
  for (const id of ['trig', 'thr', 'lo', 'sp-tol']) assert.match(pane('a'), new RegExp(`id="${id}"`), `盘中轮动 has ${id}`);
  for (const id of ['cyc-thr', 'sp-tol2']) assert.match(pane('b'), new RegExp(`id="${id}"`), `隔夜轮动 has ${id}`);
  for (const id of ['halt-thr', 'act-amt', 'ntf-hero', 'ntf-chk', 'ntf-tip', 'ntf-toggle', 'ntf-test']) assert.match(pane('c'), new RegExp(`id="${id}"`), `通用 has ${id}`);
  const info = between(html, 'id="ov-info"');
  for (const id of ['log', 'rule-txt', 'rule-halt', 'bt-cyc', 'rev-asof']) assert.match(info, new RegExp(`id="${id}"`), `info has ${id}`);
  const pop = between(html, 'id="live-pop"', '<main');
  for (const id of ['s-em', 's-sina', 's-qq', 'updated', 'segs']) assert.match(pop, new RegExp(`id="${id}"`), `time capsule has ${id}`);
  assert.match(html, /<nav class="modes" id="vtabs"/);
  assert.match(html, /data-v="cyc">隔夜轮动/);
  // 红涨绿跌
  assert.match(BOARD_HTML, /--up:#e5484d; --down:#16a34a;/);
  assert.match(BOARD_HTML, /function cls\(x\) \{ return x > 0 \? "up" : x < 0 \? "dn" : ""; \}/);
  assert.match(BOARD_HTML, /\.up \{ color:var\(--up\); \} \.dn \{ color:var\(--down\); \}/);
  // 隔夜轮动仅超管
  assert.match(BOARD_HTML, /if \(!IS_SUPER\) v = "dev";/);
  assert.match(BOARD_HTML, /if \(!IS_SUPER\) \[\$\("set-tab-b"\), \$\("rule-cyc"\), \$\("bt-cyc"\), \$\("paper-cyc-b"\)\]/);
});

test('v2 overlays: only one of tools drawer / settings / info is open at a time; mask closes it', async () => {
  const page = createPage({ demo: true });
  await page.at('10:40');
  const open = () => ['ov-tools', 'ov-set', 'ov-info'].filter((id) => !page.$(id).classList.contains('hide'));
  for (const id of ['ov-tools', 'ov-set', 'ov-info', 'ov-mask']) page.$(id).classList.add('hide');
  page.$('sim-open').listeners.click[0]();
  assert.deepEqual(open(), ['ov-tools']);
  assert.ok(!page.$('ov-mask').classList.contains('hide'));
  assert.match(page.$('sim-out').innerHTML, /成交价偏离差/);
  page.$('ntf').listeners.click[0](); // 🔔 → 设置 · 通用（通知）
  assert.deepEqual(open(), ['ov-set']);
  page.$('ov-mask').listeners.click[0]();
  assert.deepEqual(open(), []);
  assert.ok(page.$('ov-mask').classList.contains('hide'));
});

test('v2 market card: filter applies to the table, groups collapse, UI prefs saved under the key prefix', async () => {
  const page = createPage({ demo: true });
  await page.at('09:55');
  assert.match(page.$('etf-body').innerHTML, /<tr class="spx">/);
  page.$('mseg').listeners.click[0]({ target: { getAttribute: (k) => (k === 'data-f' ? 'zone' : null) } });
  const body = page.$('etf-body').innerHTML;
  assert.doesNotMatch(body, /<tr class="spx">/, 'S&P reference group hidden under the buy-zone filter');
  assert.match(body, /华泰柏瑞/);
  assert.doesNotMatch(body, /<tr class="held">/, 'held fund outside the buy zone is filtered out');
  page.$('mseg').listeners.click[0]({ target: { getAttribute: (k) => (k === 'data-f' ? 'all' : null) } });
  const grp = { getAttribute: () => 'nq' };
  page.$('etf-body').listeners.click[0]({ target: { closest: (sel) => (sel === '[data-g]' ? grp : null) } });
  assert.doesNotMatch(page.$('etf-body').innerHTML, /data-code="513100"/, 'Nasdaq group collapsed');
  assert.deepEqual(JSON.parse(page.store.get('demo_nqUi')).closed, { nq: true });
  page.$('cols-btn').listeners.click[0]();
  assert.equal(JSON.parse(page.store.get('demo_nqUi')).cols, true);
  assert.ok(page.ctx.document.body.classList.contains('wide'));
  assert.ok(page.writes.every((k) => k.startsWith('demo_')));
});
