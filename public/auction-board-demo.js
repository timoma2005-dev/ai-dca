/* 竞价看板演示引擎（只给 /auction-board-demo.html 用）。
 * 演示页由 public/auction-board.html 在构建时生成（scripts/vite/auctionBoardDemoPage.mjs），先加载本文件，再运行与正式页同一份看板脚本。
 * 这里只提供：模拟交易时钟（加载即从 09:15 开始加速推进）+ 确定性模拟行情（12 只纳指 QDII ETF、NQ00Y）+ 演示持仓。
 * 不发任何网络请求；localStorage 只用 demo_ 前缀（与正式页 nqCfg / nqLog / nqHeld 互不影响）。 */
(function (root) {
  "use strict";
  var OPT = root.AUCTION_BOARD_DEMO_OPTIONS || {};
  var KEY_PREFIX = "demo_";
  var OPEN = 34200, NOON = 41400, PM = 46800, CLOSE = 54000; // 09:30 / 11:30 / 13:00 / 15:00
  var START = 33300, END = 54300; // 09:15 起，15:05 停
  // [代码, 名称（同雷达演示）, 昨收, 雷达演示溢价中枢 %]；看板溢价 = 雷达中枢 − PREMIUM_SHIFT：排序与价差与雷达演示一致，
  // 只有嘉实 / 国泰超过 10%（集合竞价推算停牌），嘉实另在 09:30–10:30 真实停牌（行情停牌标志）。
  var PREMIUM_SHIFT = 4.7;
  var ETFS = [
    ["sh513100", "纳指ETF国泰", 2.243, 14.9], ["sz159501", "纳指ETF嘉实", 1.512, 16.2],
    ["sz159941", "纳指ETF广发", 1.668, 14.3], ["sz159696", "纳指ETF易方达", 1.735, 14.6],
    ["sz159659", "纳斯达克100ETF招商", 2.106, 12.7], ["sz159632", "纳斯达克ETF华安", 2.214, 10.6],
    ["sh513300", "纳斯达克ETF华夏", 2.387, 11.5], ["sh513870", "纳指ETF富国", 1.698, 12.2],
    ["sh513110", "纳指ETF华泰柏瑞", 2.447, 9.8], ["sz159660", "纳指ETF汇添富", 2.052, 11.9],
    ["sh513390", "纳指100ETF博时", 1.946, 10.1], ["sz159513", "纳斯达克100ETF大成", 1.774, 9.7]
  ];
  // 偏离剧本（百分点，按模拟时刻线性插值）：持仓国泰回归 → 切换；候选进出买入区（−0.50 ~ −0.20）；偏贵且无候选 → 卖出等回 0。
  var DEV = {
    "513100": [["09:15", -0.35], ["09:40", -0.30], ["09:52", 0.06], ["10:30", 0.1], ["10:55", 0.28], ["13:00", 0.3], ["13:30", -0.08], ["14:05", -0.06], ["14:20", 0.05], ["15:00", 0.08]],
    "159501": [["09:15", -0.05], ["15:00", 0.02]],
    "159941": [["09:15", 0.08], ["15:00", 0.1]],
    "159696": [["09:15", -0.06], ["15:00", -0.02]],
    "159659": [["09:15", 0.12], ["15:00", 0.09]],
    "159632": [["09:15", -0.05], ["15:00", -0.08]],
    "513300": [["09:15", -0.1], ["15:00", -0.12]],
    "513870": [["09:15", 0.05], ["13:20", 0], ["13:45", -0.28], ["15:00", -0.3]],
    "513110": [["09:15", -0.3], ["09:50", -0.28], ["10:20", -0.12], ["15:00", -0.1]],
    "159660": [["09:15", 0.15], ["15:00", 0.12]],
    "513390": [["09:15", -0.62], ["14:15", -0.62], ["14:35", -0.42], ["15:00", -0.4]],
    "159513": [["09:15", -0.15], ["09:55", -0.16], ["10:15", -0.34], ["10:40", -0.3], ["11:00", -0.15], ["15:00", -0.12]]
  };
  var HALT = { "159501": [OPEN, 37800] }; // 真实停牌（停牌标志）09:30–10:30
  // NQ 自昨日 15:00 涨跌（%），键为相对昨日 15:00 的分钟数；午休期间走平，保证偏离剧本按时出现。
  var NQ_BASE = 25180;
  var NQ_PATH = [[0, 0], [390, 0.25], [540, 0.45], [780, 0.62], [1020, 0.55], [1095, 0.58], [1110, 0.6], [1170, 0.48], [1230, 0.7], [1320, 0.7], [1380, 0.55], [1440, 0.65]];
  // 本轮买入（同持仓演示：08-20 以 2.074 买回国泰，配对卖出华泰柏瑞 2.404）
  var ROUNDS = [{ code: "513100", date: "2026-08-20", price: 2.074, fromCode: "513110", fromPrice: 2.404 }];

  function p2(n) { return (n < 10 ? "0" : "") + n; }
  function hm2s(s) { var a = s.split(":"); return +a[0] * 3600 + +a[1] * 60 + (+a[2] || 0); }
  function interp(keys, x) {
    if (x <= keys[0][0]) return keys[0][1];
    for (var i = 1; i < keys.length; i++) {
      if (x <= keys[i][0]) { var a = keys[i - 1], b = keys[i]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); }
    }
    return keys[keys.length - 1][1];
  }
  var DEV_S = {};
  Object.keys(DEV).forEach(function (c) { DEV_S[c] = DEV[c].map(function (k) { return [hm2s(k[0]), k[1]]; }); });
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  /* ---------- 模拟交易日：默认取北京时间最近一个工作日（周末也能看），可用 ?date=YYYY-MM-DD 指定 ---------- */
  function ymd(ms) { var d = new Date(ms); return d.getUTCFullYear() + "-" + p2(d.getUTCMonth() + 1) + "-" + p2(d.getUTCDate()); }
  function pickDay() {
    var q = /[?&]date=(\d{4}-\d\d-\d\d)/.exec((root.location && root.location.search) || "");
    var ds = OPT.date || (q && q[1]);
    if (!ds) {
      var ms = Date.now() + 8 * 3600000;
      while ([0, 6].indexOf(new Date(ms).getUTCDay()) >= 0) ms -= 86400000;
      ds = ymd(ms);
    }
    return ds;
  }
  var DAY = pickDay();
  var MIDNIGHT = Date.parse(DAY + "T00:00:00Z") - 8 * 3600000; // 模拟交易日北京时间 0 点（epoch ms）
  var prevMs = Date.parse(DAY + "T00:00:00Z") - 86400000;
  while ([0, 6].indexOf(new Date(prevMs).getUTCDay()) >= 0) prevMs -= 86400000;
  var PREV = ymd(prevMs);
  var BASE_MS = Date.parse(PREV + "T15:00:00Z") - 8 * 3600000; // 昨日 15:00（北京）
  var DAY_GAP_MIN = Math.round((MIDNIGHT - BASE_MS) / 60000); // 昨日 15:00 → 今日 0 点的分钟数（周一跨周末更长）
  var SKIP_MIN = DAY_GAP_MIN - 540; // 跨周末多出的分钟：期指剧本在此期间走平，今日走势与周二到周五一致

  /* ---------- 模拟时钟：集合竞价半速、午休 10 倍速，其余按 speed（默认 1 秒 = 60 秒） ---------- */
  var realNow = OPT.realNow || function () { return Date.now(); };
  var sp = /[?&]speed=(\d+(?:\.\d+)?)/.exec((root.location && root.location.search) || "");
  var clock = { sim: START, real: realNow(), speed: +(OPT.speed || (sp && sp[1]) || 60), paused: false };
  function rate(s) { return s < OPEN ? clock.speed / 2 : s >= NOON && s < PM ? clock.speed * 10 : clock.speed; }
  function nextEdge(s) { return s < OPEN ? OPEN : s < NOON ? NOON : s < PM ? PM : END; }
  function advance() {
    var r = realNow(), dt = (r - clock.real) / 1000;
    clock.real = r;
    if (clock.paused || !(dt > 0)) return;
    while (dt > 1e-9 && clock.sim < END) {
      var rt = rate(clock.sim), edge = nextEdge(clock.sim), need = (edge - clock.sim) / rt;
      if (dt <= need) { clock.sim += dt * rt; dt = 0; } else { clock.sim = edge; dt -= need; }
    }
    if (clock.sim > END) clock.sim = END;
  }
  function simSec() { advance(); return clock.sim; }
  function now() { return MIDNIGHT + Math.floor(simSec() * 1000); }

  /* ---------- 模拟行情 ---------- */
  function nqPctAt(m) { var v = Math.max(0, m - SKIP_MIN); return interp(NQ_PATH, v) / 100 + (v > 0 ? Math.sin(v / 7) * 0.00004 : 0); }
  function marketSec(s) { return s < START ? START : s >= NOON && s < PM ? NOON : s > CLOSE ? CLOSE : s; } // 午休 / 收盘后 ETF 价格冻结
  function priceAt(e, s) { var t = marketSec(s); return e[2] * (1 + nqPctAt(DAY_GAP_MIN + t / 60) + interp(DEV_S[e[0].slice(2)], t) / 100); }
  var NAV = {};
  ETFS.forEach(function (e) { NAV[e[0].slice(2)] = priceAt(e, START) / (1 + (e[3] - PREMIUM_SHIFT) / 100); });
  function stampOf(s) { var x = Math.floor(s); return DAY.replace(/-/g, "") + p2(Math.floor(x / 3600)) + p2(Math.floor(x / 60) % 60) + p2(x % 60); }
  function snapshot(s) {
    var nowMin = DAY_GAP_MIN + Math.floor(s / 60), pts = [];
    for (var m = 0; m <= nowMin; m = m ? m + 1 : Math.max(1, SKIP_MIN)) {
      var ms = BASE_MS + m * 60000, d = new Date(ms + 8 * 3600000);
      pts.push({ t: ymd(ms + 8 * 3600000) + " " + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()), p: +(NQ_BASE * (1 + nqPctAt(m))).toFixed(2) });
    }
    var etf = {}, nav = {}, t = marketSec(s), auction = s < OPEN;
    ETFS.forEach(function (e) {
      var code = e[0].slice(2), px = priceAt(e, s), h = HALT[code], halted = h && s >= h[0] && s < h[1];
      var v = 200 + hash(code + Math.floor(t / 60)) % 4800, vol = auction ? Math.floor((t - START) / 6) * 37 : 80000 + Math.floor((t - OPEN) / 60) * 1310;
      var b1 = auction ? px : Math.floor(px * 1000) / 1000, a1 = auction ? px : b1 + 0.001;
      etf[e[0]] = halted
        ? { full: e[1], code: code, cur: e[2], pre: e[2], open: 0, b1: 0, b1v: 0, a1: 0, a1v: 0, t: stampOf(s), vol: 0, flag: "S" }
        : { full: e[1], code: code, cur: px, pre: e[2], open: px, b1: b1, b1v: v, a1: a1, a1v: Math.round(v * 0.8), t: stampOf(s), vol: vol, flag: "" };
      nav[code] = { nav: NAV[code], date: "演示参考净值", src: "demo" };
    });
    return { nq: { pts: pts, base: { t: pts[0].t, p: pts[0].p, approx: false }, src: "演示 NQ00Y（模拟）" }, etf: etf, nav: nav, etfTime: stampOf(s) };
  }

  /* ---------- 演示条 ---------- */
  function fmt(s) { var x = Math.floor(s); return p2(Math.floor(x / 3600)) + ":" + p2(Math.floor(x / 60) % 60); }
  var bar = null;
  function renderBar() {
    if (!bar) return;
    var s = clock.sim, lbl = bar.querySelector ? bar.querySelector("[data-demo-clock]") : null;
    if (lbl) lbl.textContent = "模拟 " + fmt(s) + (s >= END ? " · 已播完" : clock.paused ? " · 已暂停" : " · 1秒=" + clock.speed + "秒");
    [].forEach.call((bar.querySelectorAll && bar.querySelectorAll("[data-speed]")) || [], function (b) {
      b.style.background = +b.getAttribute("data-speed") === clock.speed ? "#92400e" : "transparent";
      b.style.color = +b.getAttribute("data-speed") === clock.speed ? "#fff" : "#92400e";
    });
  }
  function mountBar() {
    var doc = root.document;
    if (!doc || !doc.createElement) return;
    try { doc.title = "【演示数据】" + doc.title.replace(/^【演示数据】/, ""); } catch { /* ignore */ }
    bar = doc.createElement("div");
    bar.setAttribute("data-demo-banner", "1");
    bar.setAttribute("role", "note");
    bar.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:7px 24px;background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e;font-size:12px;line-height:1.5";
    var btn = "border:1px solid #f59e0b;border-radius:6px;padding:1px 8px;font-size:12px;cursor:pointer;background:transparent;color:#92400e";
    bar.innerHTML = '<b style="background:#f59e0b;color:#fff;border-radius:6px;padding:1px 8px">演示数据</b>' +
      '<span>模拟行情与交易时钟（09:15 起加速播放），不是真实行情，不请求任何行情接口</span>' +
      '<span data-demo-clock style="font-weight:600"></span><span style="flex:1"></span>' +
      '<button type="button" data-speed="30" style="' + btn + '">×30</button><button type="button" data-speed="60" style="' + btn + '">×60</button>' +
      '<button type="button" data-speed="120" style="' + btn + '">×120</button><button type="button" data-demo="pause" style="' + btn + '">暂停/继续</button>' +
      '<button type="button" data-demo="restart" style="' + btn + '">重播</button>';
    bar.addEventListener("click", function (ev) {
      var t = ev.target, s = t && t.getAttribute && t.getAttribute("data-speed"), a = t && t.getAttribute && t.getAttribute("data-demo");
      if (s) api.setSpeed(+s); else if (a === "pause") (clock.paused ? api.resume : api.pause)(); else if (a === "restart") api.restart();
    });
    var top = doc.querySelector && doc.querySelector(".top");
    if (top && top.insertBefore) top.insertBefore(bar, top.firstChild); else if (doc.body && doc.body.insertBefore) doc.body.insertBefore(bar, doc.body.firstChild);
    [].forEach.call((doc.querySelectorAll && doc.querySelectorAll(".meta .src")) || [], function (el) { el.style.display = "none"; });
    var logo = doc.querySelector && doc.querySelector(".logo");
    if (logo && logo.appendChild) { var tag = doc.createElement("span"); tag.textContent = "演示"; tag.style.cssText = "font-size:11px;font-weight:600;color:#b45309;background:#fef3c7;border-radius:6px;padding:1px 6px"; logo.appendChild(tag); }
    renderBar();
    if (root.setInterval) root.setInterval(function () { simSec(); renderBar(); }, 500);
  }

  function clearLog() { try { root.localStorage.removeItem(KEY_PREFIX + "nqLog"); } catch { /* ignore */ } }
  var api = {
    day: DAY,
    prevDay: PREV,
    etfs: ETFS.map(function (e) { return { code: e[0].slice(2), name: e[1], pre: e[2], premium: +(e[3] - PREMIUM_SHIFT).toFixed(2), radarBase: e[3] }; }),
    premiumShift: PREMIUM_SHIFT,
    simSec: simSec,
    now: now,
    snapshot: function (s) { return snapshot(s == null ? simSec() : s); },
    seek: function (hm) { clock.sim = Math.max(START, Math.min(END, typeof hm === "number" ? hm : hm2s(hm))); clock.real = realNow(); renderBar(); },
    setSpeed: function (n) { simSec(); if (n > 0) clock.speed = n; renderBar(); },
    pause: function () { simSec(); clock.paused = true; renderBar(); },
    resume: function () { clock.real = realNow(); clock.paused = false; renderBar(); },
    restart: function () { clearLog(); if (root.location && root.location.reload) root.location.reload(); }
  };
  clearLog(); // 每次打开都从 09:15 重播，今日信号重新记录
  root.AUCTION_BOARD_DEMO = api;
  root.AUCTION_BOARD_ENV = {
    demo: true,
    keyPrefix: KEY_PREFIX,
    now: now,
    load: function () { return snapshot(simSec()); },
    interval: 1000,
    tickMs: 250,
    held: ["513100"],
    rounds: ROUNDS,
    heldLabel: "演示持仓"
  };
  mountBar();
})(globalThis);
