// 本地直连面板的纯数据变换：把 directMarketData.js 拉回的腾讯行情 / 蛋卷净值 /
// 东财 K 线整理成视图模型。不依赖 DOM，全部可在 node:test 直接验证。

function finiteNumber(value) {
  // Number(null) === 0 是常见陷阱，空值必须显式当作缺失。
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 场内价格相对基金单位净值的溢价率（%）；任一缺失返回 null。 */
export function computePremiumPercent(price, nav) {
  const p = finiteNumber(price);
  const n = finiteNumber(nav);
  if (p == null || n == null || n <= 0) return null;
  return round2((p / n - 1) * 100);
}

/**
 * 合并直连行情与净值为表格行。
 * @param {Array<{code:string,name?:string}>} universe 标的池（保持顺序）
 * @param {Record<string, any>} quotes fetchDirectQuotes 返回里的 quotes 映射
 * @param {Record<string, any>} [navs]  fetchDanjuanDirectQuotes 返回里的 quotes 映射
 */
export function buildDirectRows({ universe = [], quotes = {}, navs = {} } = {}) {
  return universe.map((item) => {
    const code = String(item.code || '').trim();
    const quote = quotes?.[code] || null;
    const nav = navs?.[code] || null;
    const price = finiteNumber(quote?.price);
    const latestNav = finiteNumber(nav?.latestNav);
    const available = Boolean(quote && price != null && price > 0);
    return {
      code,
      name: String(item.name || quote?.name || code),
      available,
      price,
      previousClose: finiteNumber(quote?.previousClose),
      open: finiteNumber(quote?.open),
      high: finiteNumber(quote?.high),
      low: finiteNumber(quote?.low),
      changePercent: finiteNumber(quote?.changePercent),
      volume: finiteNumber(quote?.volume),
      quoteTime: String(quote?.time || ''),
      source: String(quote?.source || 'tencent-direct'),
      latestNav,
      navDate: String(nav?.latestNavDate || ''),
      navSource: String(nav?.navSource || nav?.source || ''),
      premiumPercent: computePremiumPercent(price, latestNav),
    };
  });
}

/** 行集合的汇总指标，供头部状态条展示。 */
export function summarizeDirectRows(rows = []) {
  const summary = { total: rows.length, available: 0, up: 0, down: 0, flat: 0, missing: 0, premiumAvailable: 0 };
  for (const row of rows) {
    if (!row.available) {
      summary.missing += 1;
      continue;
    }
    summary.available += 1;
    if (row.premiumPercent != null) summary.premiumAvailable += 1;
    const change = finiteNumber(row.changePercent);
    if (change == null || change === 0) summary.flat += 1;
    else if (change > 0) summary.up += 1;
    else summary.down += 1;
  }
  return summary;
}

/** 溢价优先（null 沉底），其次涨跌幅降序，最后代码升序，保证结果稳定。 */
export function sortDirectRows(rows = [], { byPremium = false } = {}) {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (byPremium) {
      if (a.premiumPercent == null && b.premiumPercent != null) return 1;
      if (a.premiumPercent != null && b.premiumPercent == null) return -1;
      if (a.premiumPercent != null && b.premiumPercent != null && a.premiumPercent !== b.premiumPercent) {
        return b.premiumPercent - a.premiumPercent;
      }
    }
    const ac = finiteNumber(a.changePercent);
    const bc = finiteNumber(b.changePercent);
    const av = ac == null ? Number.NEGATIVE_INFINITY : ac;
    const bv = bc == null ? Number.NEGATIVE_INFINITY : bc;
    if (av !== bv) return bv - av;
    return String(a.code).localeCompare(String(b.code));
  });
  return copy;
}

/**
 * 把收盘价序列映射为 SVG 折线 / 面积路径（viewBox 坐标）。
 * 数据不足时返回空路径，调用方据此渲染占位。
 */
export function buildLinePath(candles = [], { width = 640, height = 220, pad = 8 } = {}) {
  const closes = candles.map((c) => finiteNumber(c?.c)).filter((n) => n != null);
  if (closes.length < 2 || width <= pad * 2 || height <= pad * 2) {
    return { line: '', area: '', points: [], min: null, max: null, last: null };
  }
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const points = closes.map((value, index) => {
    const x = pad + (index / (closes.length - 1)) * innerW;
    const y = pad + (1 - (value - min) / span) * innerH;
    return { x: round2(x), y: round2(y), value };
  });
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  const area = `${line} L${points[points.length - 1].x} ${height - pad} L${points[0].x} ${height - pad} Z`;
  return { line, area, points, min: round2(min), max: round2(max), last: points[points.length - 1] };
}

/** 直连搜索结果归一化为可加入标的池的 {code, name}。 */
export function normalizeDirectSearchResults(results = []) {
  return (Array.isArray(results) ? results : [])
    .filter((item) => /^\d{6}$/.test(String(item?.code || '')))
    .map((item) => ({ code: String(item.code), name: String(item.name || item.code) }));
}
