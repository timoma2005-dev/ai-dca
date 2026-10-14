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
  const limits = TARGET_CODES.map((code, i) => ({
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
