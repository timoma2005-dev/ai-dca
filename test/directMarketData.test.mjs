/* global document, setTimeout, URL */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  fetchDirectKline,
  fetchEastmoneyFundNavs,
  normalizeDirectSymbol,
  parseEastmoneyFundNavPayload,
  parseEastmoneyKlinePayload,
  parseTencentQuoteText,
  parseTencentSearchText
} from '../src/app/directMarketData.js';

// 东财接口不发 CORS 头，生产链路走 script 标签 JSONP；在 node 下用 jsdom 模拟。
// handle 返回响应体（触发回调）或字符串 'error'（触发 script.onerror）。
function installJsonpHarness(handle) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const originals = {
    window: globalThis.window,
    document: globalThis.document,
    DOMException: globalThis.DOMException,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DOMException = dom.window.DOMException;
  const realCreate = document.createElement.bind(document);
  const seenUrls = [];
  document.createElement = (tagName) => {
    const el = realCreate(tagName);
    if (tagName === 'script') {
      Object.defineProperty(el, 'src', {
        get() { return el.getAttribute('src') || ''; },
        set(value) {
          el.setAttribute('src', value);
          seenUrls.push(value);
          setTimeout(() => {
            const url = new URL(value);
            const cb = url.searchParams.get('cb') || url.searchParams.get('callback');
            const outcome = handle(value);
            if (outcome === 'error') { el.onerror?.(); return; }
            if (cb && typeof globalThis.window[cb] === 'function') globalThis.window[cb](outcome);
            el.onload?.();
          }, 0);
        },
      });
    }
    return el;
  };
  return {
    seenUrls,
    restore() {
      globalThis.window = originals.window;
      globalThis.document = originals.document;
      globalThis.DOMException = originals.DOMException;
    },
  };
}

test('direct symbol normalization maps CN ETF symbols to Tencent and Eastmoney ids', () => {
  assert.deepEqual(normalizeDirectSymbol('513100'), {
    market: 'cn',
    code: '513100',
    tencent: 'sh513100',
    eastmoneySecid: '1.513100'
  });
  assert.deepEqual(normalizeDirectSymbol('159941'), {
    market: 'cn',
    code: '159941',
    tencent: 'sz159941',
    eastmoneySecid: '0.159941'
  });
  assert.equal(normalizeDirectSymbol('AAPL').tencent, 'usAAPL');
});

test('Tencent quote text normalizes market quote fields', () => {
  const text = 'v_sh513100="1~纳指ETF国泰~513100~2.167~2.158~2.150~3356138~0~0~2.167~411~2.166~1564~2.165~5061~2.164~436~2.163~3098~2.168~2749~2.169~2746~2.170~7318~2.171~5064~2.172~1773~~20260703161434~0.009~0.42~2.175~2.140~2.151~3356138~727000000~1.2~12.3~~~~3.1~100~200~1.5~2.38~1.82";';
  const quotes = parseTencentQuoteText(text);

  assert.equal(quotes['513100'].name, '纳指ETF国泰');
  assert.equal(quotes['513100'].price, 2.167);
  assert.equal(quotes['513100'].previousClose, 2.158);
  assert.equal(quotes['513100'].changePercent, 0.42);
  assert.equal(quotes.sh513100.source, 'tencent-direct');
});

test('Tencent smartbox search parser decodes fund records', () => {
  const rows = parseTencentSearchText('v_hint="sh~513100~\\u7eb3\\u6307ETF\\u56fd\\u6cf0~nzetfgt~QDII-ETF"');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'sh513100');
  assert.equal(rows[0].name, '纳指ETF国泰');
  assert.equal(rows[0].assetType, 'exchange_fund');
  assert.equal(rows[0].fundKind, 'exchange');
  assert.equal(rows[0].fundVenue, 'exchange');
});

test('Tencent smartbox normalizes OTC jj records to six-digit fund codes', () => {
  const rows = parseTencentSearchText('v_hint="jj~539001~u5efau4fe1u7eb3u6307u6570u636eu5e7fu573a"');

  assert.equal(rows[0].symbol, '539001');
  assert.equal(rows[0].code, '539001');
  assert.equal(rows[0].exchange, '场外基金');
  assert.equal(rows[0].fundKind, 'otc');
  assert.equal(rows[0].assetType, 'otc_fund');
  assert.equal(rows[0].fundVenue, 'otc');
});


test('Eastmoney kline payload maps csv rows to candle schema', () => {
  const payload = {
    rc: 0,
    data: {
      code: '513100',
      name: '纳指ETF国泰',
      klines: [
        '2026-07-01,2.100,2.120,2.130,2.090,12345,2600000.0,1.2,0.9,0.02,0.5'
      ]
    }
  };
  const normalized = parseEastmoneyKlinePayload(payload, { symbol: '513100', timeframe: '1d' });

  assert.equal(normalized.symbol, '513100');
  assert.equal(normalized.candles.length, 1);
  assert.equal(normalized.candles[0].o, 2.1);
  assert.equal(normalized.candles[0].c, 2.12);
  assert.equal(normalized.source, 'eastmoney-direct');
});

test('FundMNFInfo payload: premium is ZJL negated directly, NAV kept separately', () => {
  // ZJL = 东财折价率（%），负值即溢价；不再依赖 NEWPRICE 反推参考净值。
  const body = {
    Datas: [
      { FCODE: '513100', NAV: '2.0500', PDATE: '2026-10-24T00:00:00', ZJL: '-2.3800', NEWPRICE: '2.1000' },
      { FCODE: '159941', NAV: '1.9800', PDATE: '2026-10-24T00:00:00', ZJL: '', NEWPRICE: '' },
      { FCODE: '513500', NAV: '', PDATE: '', ZJL: '1.2500' },
      { FCODE: '513660', NAV: '', PDATE: '', ZJL: 'bad' }
    ]
  };
  const quotes = parseEastmoneyFundNavPayload(body, ['513100', '159941', '513500', '513660']);

  // 折价率 -2.38% → 溢价率 +2.38%，与 NEWPRICE 无关。
  assert.equal(quotes['513100'].premiumPercent, 2.38);
  assert.equal(quotes['513100'].latestNav, 2.05);
  assert.equal(quotes['513100'].latestNavDate, '2026-10-24');
  assert.equal(quotes['513100'].navSource, 'eastmoney-zjl');
  assert.equal(quotes['513100'].source, 'eastmoney-fund-direct');

  // 无 ZJL：保留官方 NAV，溢价留空，交由上层按价格/净值重算。
  assert.equal(quotes['159941'].premiumPercent, null);
  assert.equal(quotes['159941'].latestNav, 1.98);
  assert.equal(quotes['159941'].navSource, 'eastmoney-nav');

  // 只有 ZJL 也能出溢价（正折价率 → 负溢价），净值可空。
  assert.equal(quotes['513500'].premiumPercent, -1.25);
  assert.equal(quotes['513500'].latestNav, null);

  // 两者都缺失的代码被跳过。
  assert.equal(quotes['513660'], undefined);
});

test('FundMNFInfo parser filters by requested codes and tolerates bad payloads', () => {
  const body = {
    Datas: [
      { FCODE: '513100', NAV: '2.05', PDATE: '2026-10-24' },
      { FCODE: '159941', NAV: '1.98', PDATE: '2026-10-24' }
    ]
  };
  const only = parseEastmoneyFundNavPayload(body, ['sh513100']);
  assert.deepEqual(Object.keys(only), ['513100']);
  assert.deepEqual(parseEastmoneyFundNavPayload(null, ['513100']), {});
  assert.deepEqual(parseEastmoneyFundNavPayload({ Datas: 'x' }, ['513100']), {});
  assert.deepEqual(parseEastmoneyFundNavPayload({ Datas: [{ FCODE: 'bad', NAV: '1' }] }, ['bad']), {});
});

test('direct Eastmoney kline uses JSONP (cb param) and limit does not truncate memory cache', async () => {
  const payload = {
    rc: 0,
    data: {
      code: '513111',
      name: '测试ETF',
      klines: [
        '2026-07-01,1.000,1.010,1.020,0.990,100,1000,0,0,0,0',
        '2026-07-02,1.010,1.020,1.030,1.000,100,1000,0,0,0,0',
        '2026-07-03,1.020,1.030,1.040,1.010,100,1000,0,0,0,0'
      ]
    }
  };
  const harness = installJsonpHarness(() => payload);
  try {
    const limited = await fetchDirectKline('513111', { timeframe: '1d', limit: 2 });
    const cachedFull = await fetchDirectKline('513111', { timeframe: '1d' });

    // inflight 去重 + 内存缓存：只插一次 script。
    assert.equal(harness.seenUrls.length, 1);
    assert.equal(limited.candles.length, 2);
    assert.equal(cachedFull.candles.length, 3);
    assert.match(harness.seenUrls[0], /push2his\.eastmoney\.com/);
    assert.match(harness.seenUrls[0], /secid=1\.513111/);
    assert.match(harness.seenUrls[0], /klt=101/);
    assert.match(harness.seenUrls[0], /[?&]cb=aiDcaJsonp_/);
  } finally {
    harness.restore();
  }
});

test('direct Eastmoney kline rejects when the JSONP script fails', async () => {
  const harness = installJsonpHarness(() => 'error');
  try {
    await assert.rejects(fetchDirectKline('513222', { timeframe: '1d' }), /jsonp script failed/);
  } finally {
    harness.restore();
  }
});

test('FundMNFInfo loads via JSONP with the callback (not cb) parameter', async () => {
  const body = { Datas: [{ FCODE: '513100', NAV: '2.0500', PDATE: '2026-10-24', ZJL: '-2.3800' }] };
  const harness = installJsonpHarness(() => body);
  try {
    const res = await fetchEastmoneyFundNavs(['513100']);
    assert.equal(res.quotes['513100'].premiumPercent, 2.38);
    assert.match(harness.seenUrls[0], /fundmobapi\.eastmoney\.com/);
    assert.match(harness.seenUrls[0], /[?&]callback=aiDcaJsonp_/);
    assert.doesNotMatch(harness.seenUrls[0], /[?&]cb=/);
  } finally {
    harness.restore();
  }
});
