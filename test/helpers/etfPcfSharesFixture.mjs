import { buildSharesProjection } from '../../workers/ocr-proxy/src/etfPcfSharesProjection.js';
import { TARGET_CODES } from '../../workers/ocr-proxy/src/etfPcfShares.js';
export const calendar = {
  source: 'verified_trading_calendar',
  from: '2026-10-09',
  to: '2026-10-12',
  sessions: ['2026-10-09', '2026-10-12']
};
export function syntheticProjection({
  fetchedAt = '2026-10-13T01:03:20.000Z',
  partial = false,
  date = '2026-10-12',
  prevDate = '2026-10-09',
  tradingCalendar = calendar
} = {}) {
  const deltas = [10000000, 9500000, 12500000, -1000000, 2000000, 0, 0, 0];
  const records = TARGET_CODES.filter((code) => code.startsWith('159')).flatMap((code, i) => [
    {
      code,
      date,
      shares: 20000000000 + deltas[i],
      unit: '份',
      name: `synthetic 纳斯达克100ETF ${code}`
    },
    ...(partial && i === 6 ? [] : [{ code, date: prevDate, shares: 20000000000, unit: '份' }])
  ]);
  const limits = TARGET_CODES.slice(0, 8).map((code, i) => ({
    code,
    date,
    total: {
      kind: i === 4 ? 'unlimited' : i === 5 ? 'unknown' : 'limited',
      shares: i === 4 || i === 5 ? null : 10000000
    }
  }));
  return buildSharesProjection({
    date,
    records,
    limits,
    fetchedAt,
    projectedAt: fetchedAt,
    calendar: tradingCalendar,
    dateEvidence: { source: 'szse_fund_report', column: '数据日期', type: 'iso_date' }
  });
}

// 2026-10-20 起新快照形态：513（沪市）接入上一期份额来源，记录携带非空 prevShares/deltaShares；
// 限额环比结论（limitChange/limitChanges/prevLimitDate）与顶层限额日期为 worker 预计算的透传字段，
// 共享校验只看沪深统一的份额/差额/利用率口径，不校验透传字段内部形态。
// buildSharesProjection 不产出沪市份额，这里在合成快照上直接补齐一套口径一致的 513100 记录。
export function sseDeltaProjection({ fetchedAt = '2026-10-13T01:03:20.000Z' } = {}) {
  const data = syntheticProjection({ fetchedAt });
  data.limitDate = '2026-10-13';
  data.prevLimitDate = '2026-10-09';
  data.limitSummary = { changed: ['513100'], total: 1 };
  Object.assign(data.records.find((r) => r.code === '513100'), {
    shares: 30000000000,
    prevDate: data.prevDate,
    prevShares: 29990000000,
    deltaShares: 10000000,
    creationShares: 10000000,
    creationSharesKind: 'estimate',
    subscriptionAllowed: true,
    redemptionAllowed: true,
    totalLimitKind: 'limited',
    totalLimitShares: 200000000,
    netLimitKind: 'limited',
    netLimitShares: 200000000,
    effLimitKind: 'limited',
    effLimitShares: 200000000,
    limitSource: 'net',
    limitDate: '2026-10-13',
    utilization: 0.05,
    atLimit: false,
    nearTotalLimit: false,
    status: 'complete',
    reasons: ['missing_dated_nav'],
    prevLimitDate: '2026-10-09',
    limitChange: 'tightened',
    limitChanges: {
      total: {
        change: 'tightened',
        ratio: 0.5,
        before: { kind: 'limited', shares: 400000000 },
        after: { kind: 'limited', shares: 200000000 }
      },
      net: {
        change: 'unchanged',
        ratio: 1,
        before: { kind: 'limited', shares: 200000000 },
        after: { kind: 'limited', shares: 200000000 }
      },
      accountTotal: {
        change: 'relaxed',
        ratio: null,
        before: { kind: 'limited', shares: 500000 },
        after: { kind: 'unlimited', shares: null }
      },
      accountNet: null
    }
  });
  return data;
}
