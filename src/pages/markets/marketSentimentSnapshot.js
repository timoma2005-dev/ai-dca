// 市场情绪快照：情绪条、研报、页面背景共用同一份快照（模块级单例 + 订阅），
// 不再各自持有一份行情、也不再用写死的兜底涨跌幅 / F&G / VIX 冒充实时数据。
// 每个标的只在拿到有效数值时才覆盖，失败或缺字段时保留上次成功值并记录其时间。

export const SENTIMENT_US_SYMBOLS = ['^VIX', 'CNN_FNG', 'QQQ', 'VOO'];
export const SENTIMENT_STALE_MS = 2 * 60 * 1000;
export const SENTIMENT_POLL_MS = 15000;

const CHANGE_KEYS = ['changePercent', 'change_percent', 'pctChange'];
const LEVEL_KEYS = ['price', 'value', 'close'];
const LEVEL_SYMBOLS = new Set(['^VIX', 'CNN_FNG']);

export function pickQuoteNumber(quote, keys) {
  for (const key of keys) {
    const raw = quote?.[key];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function findSentimentQuote(quoteMap, rawCode) {
  if (!quoteMap || typeof quoteMap !== 'object') return null;
  const code = String(rawCode || '');
  const digits = code.replace(/\D/g, '');
  const candidates = [code, digits, 'sh' + digits, 'sz' + digits, 'SH' + digits, 'SZ' + digits];
  for (const candidate of candidates) {
    if (candidate && quoteMap[candidate] && typeof quoteMap[candidate] === 'object') return quoteMap[candidate];
  }
  return null;
}

function usableValue(code, quote) {
  if (!quote) return null;
  if (LEVEL_SYMBOLS.has(code)) {
    const level = pickQuoteNumber(quote, LEVEL_KEYS);
    return level != null && level > 0 ? level : null;
  }
  return pickQuoteNumber(quote, CHANGE_KEYS);
}

/** 合并一次拉取结果：只有有效数值才覆盖；返回 { entries, updated }。 */
export function mergeSentimentEntries(previous = {}, quoteMap = {}, codes = [], now = Date.now()) {
  const entries = { ...previous };
  let updated = 0;
  for (const code of codes) {
    const value = usableValue(code, findSentimentQuote(quoteMap, code));
    if (value == null) continue;
    entries[code] = { value, at: now };
    updated += 1;
  }
  return { entries, updated };
}

function entryView(entry, now) {
  if (!entry) return { value: null, at: 0, stale: false };
  return { value: entry.value, at: entry.at, stale: now - entry.at > SENTIMENT_STALE_MS };
}

/** 从 entries 派生一份完整快照（情绪条与研报都只读它）。 */
export function deriveSentimentSnapshot(entries = {}, { breadthCodes = [], now = Date.now(), lastSuccessAt = 0, loading = false, error = '' } = {}) {
  let up = 0;
  let down = 0;
  let missing = 0;
  for (const code of breadthCodes) {
    const entry = entries[code];
    if (!entry) { missing += 1; continue; }
    if (entry.value >= 0) up += 1;
    else down += 1;
  }
  const qqq = entryView(entries.QQQ, now);
  const voo = entryView(entries.VOO, now);
  const fearGreed = entryView(entries.CNN_FNG, now);
  const vix = entryView(entries['^VIX'], now);
  return {
    qqq: { ...qqq, value: qqq.value == null ? null : Number(qqq.value.toFixed(2)) },
    voo: { ...voo, value: voo.value == null ? null : Number(voo.value.toFixed(2)) },
    fearGreed: { ...fearGreed, value: fearGreed.value == null ? null : Math.round(fearGreed.value) },
    vix: { ...vix, value: vix.value == null ? null : Number(vix.value.toFixed(2)) },
    breadth: { up, down, missing },
    ready: up + down > 0,
    lastSuccessAt,
    stale: Boolean(lastSuccessAt) && now - lastSuccessAt > SENTIMENT_STALE_MS,
    loading,
    error,
  };
}

/** 单例行情快照存储：多个订阅者共享一个轮询；refresh(true) 为手动刷新。 */
export function createSentimentStore({ fetchQuotes, breadthCodes = [], pollMs = SENTIMENT_POLL_MS, now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let entries = {};
  let lastSuccessAt = 0;
  let loading = true;
  let error = '';
  let inflight = null;
  let timer = null;
  let snapshot = deriveSentimentSnapshot(entries, { breadthCodes, now: now(), loading });
  const listeners = new Set();

  function publish() {
    snapshot = deriveSentimentSnapshot(entries, { breadthCodes, now: now(), lastSuccessAt, loading, error });
    listeners.forEach((listener) => listener());
  }

  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      const [etfPayload, usPayload] = await Promise.all([
        fetchQuotes(breadthCodes).catch(() => null),
        fetchQuotes(SENTIMENT_US_SYMBOLS).catch(() => null),
      ]);
      const at = now();
      const merged = { ...(etfPayload?.quotes || {}), ...(usPayload?.quotes || {}) };
      const result = mergeSentimentEntries(entries, merged, [...breadthCodes, ...SENTIMENT_US_SYMBOLS], at);
      entries = result.entries;
      if (result.updated > 0) { lastSuccessAt = at; error = ''; } else { error = '行情指标暂不可用'; }
      loading = false;
      publish();
    })().finally(() => { inflight = null; });
    return inflight;
  }

  return {
    getSnapshot: () => snapshot,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        timer = setTimer(() => { void refresh(); }, pollMs);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size && timer) { clearTimer(timer); timer = null; }
      };
    },
  };
}

export function formatSentimentTime(at) {
  if (!at) return '';
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
}

/** 单个指标格子的展示：加载中占位 / 无数据 — / 有值（过期时附「延迟 HH:MM:SS」）。不回退成「暂无」。 */
export function sentimentCellState(view, { loading = false, format = (value) => String(value) } = {}) {
  if (!view || view.value == null) {
    return loading ? { text: '…', note: '', title: '加载中' } : { text: '—', note: '', title: '暂无可用数据' };
  }
  const time = formatSentimentTime(view.at);
  return {
    text: format(view.value),
    note: view.stale ? '延迟' : '',
    title: view.stale ? `数据延迟，最后更新 ${time}` : `更新于 ${time}`,
  };
}
