import { isTradingDayShanghai } from '../src/app/holidaysCN.js';
export { isTradingDayShanghai };
// The existing 2026 closure table was checked against both exchange notices.
// No network request occurs here; unsupported years fail closed.
export const CALENDAR_NOTICE = 'https://investor.szse.cn/disclosure/notice/general/t20251222_618087.html';
export function confirmedSharesCalendar(from, to) {
  const valid = (value) =>
    typeof value === 'string' &&
    /^2026-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(from) || !valid(to) || from > to || Date.parse(to) - Date.parse(from) > 40 * 86400000)
    return null;
  const sessions = [];
  for (let ms = Date.parse(from); ms <= Date.parse(to); ms += 86400000) {
    const date = new Date(ms).toISOString().slice(0, 10);
    if (isTradingDayShanghai(date)) sessions.push(date);
  }
  return { source: 'verified_trading_calendar', from, to, sessions, notice: CALENDAR_NOTICE };
}
export function isCompleteSharesCalendar(calendar) {
  const expected = confirmedSharesCalendar(calendar?.from, calendar?.to);
  return (
    !!expected &&
    calendar.source === expected.source &&
    Array.isArray(calendar.sessions) &&
    JSON.stringify(calendar.sessions) === JSON.stringify(expected.sessions)
  );
}
