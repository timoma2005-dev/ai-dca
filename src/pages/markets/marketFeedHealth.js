// 行情页连接状态：按「最后一次成功拿到行情（接口返回或 WS 推送）」的时间判断，
// 不再「有行就显示连接正常」。交易时段内超过阈值显示「数据延迟」并自动强制重拉（轮询兜底）。
import { useEffect, useRef, useState } from 'react';
import { parseMarketRefreshTimestamp } from './marketRefreshTime.js';

export const FEED_STALE_MS = 2 * 60 * 1000;
export const FEED_DATA_STALE_MS = 5 * 60 * 1000;
export const FEED_POLL_MS = 30 * 1000;

function zonedParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(now));
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return { weekday: get('weekday'), minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

/** 是否处于交易时段（不含节假日）：A 股 9:30–11:30 / 13:00–15:00（北京时间），美股 9:30–16:00（纽约时间）。 */
export function isMarketTradingTime(market = 'cn', now = Date.now()) {
  const us = String(market || '').toLowerCase() === 'us';
  const { weekday, minutes } = zonedParts(now, us ? 'America/New_York' : 'Asia/Shanghai');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  if (us) return minutes >= 570 && minutes < 960;
  return (minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900);
}

export function evaluateMarketFeedHealth({ market = 'cn', lastSuccessAt = 0, dataTimestamp = '', hasRows = false, now = Date.now() } = {}) {
  if (!lastSuccessAt && !hasRows) return { status: 'waiting', label: '等待行情数据', title: '' };
  const trading = isMarketTradingTime(market, now);
  if (!trading) return { status: 'closed', label: '休市中', title: '非交易时段，显示最近一次收到的行情' };
  const fetchAge = lastSuccessAt ? now - lastSuccessAt : Infinity;
  const dataAt = parseMarketRefreshTimestamp(dataTimestamp)?.getTime() || 0;
  const dataAge = dataAt ? now - dataAt : 0;
  if (fetchAge > FEED_STALE_MS || dataAge > FEED_DATA_STALE_MS) {
    return { status: 'delayed', label: '数据延迟', title: '超过 2 分钟未收到新行情，正在自动重连' };
  }
  return { status: 'live', label: '实时行情连接正常', title: '' };
}

/**
 * lastSuccessAt：最后一次接口刷新成功的时间（ms）；WS 推送由本 hook 自行监听记录。
 * onStale：交易时段内数据延迟时调用（强制重拉），至多每 FEED_POLL_MS 一次。
 */
export function useMarketFeedHealth({ market = 'cn', lastSuccessAt = 0, dataTimestamp = '', hasRows = false, onStale } = {}) {
  const [now, setNow] = useState(() => Date.now());
  const [lastPushAt, setLastPushAt] = useState(0);
  const onStaleRef = useRef(onStale);
  const lastPollRef = useRef(0);
  useEffect(() => { onStaleRef.current = onStale; });

  useEffect(() => {
    setLastPushAt(0);
    lastPollRef.current = 0;
  }, [market]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPush = (event) => {
      if (Array.isArray(event?.detail?.items) && event.detail.items.length) setLastPushAt(Date.now());
    };
    window.addEventListener('ai-dca-price-push', onPush);
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => {
      window.removeEventListener('ai-dca-price-push', onPush);
      window.clearInterval(timer);
    };
  }, []);

  const health = evaluateMarketFeedHealth({ market, lastSuccessAt: Math.max(lastSuccessAt || 0, lastPushAt), dataTimestamp, hasRows, now });

  useEffect(() => {
    if (health.status !== 'delayed') return;
    if (now - lastPollRef.current < FEED_POLL_MS) return;
    lastPollRef.current = now;
    onStaleRef.current?.();
  }, [health.status, now]);

  return health;
}
