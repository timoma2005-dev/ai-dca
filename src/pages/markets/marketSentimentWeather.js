import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { fetchQuotes } from './marketsApiLoader.js';
import { createSentimentStore } from './marketSentimentSnapshot.js';

export const BREADTH_ITEMS = [
  ['159509', 2.89], ['513100', 2.21], ['159501', 1.62], ['159941', 2.32],
  ['159696', 1.79], ['159659', 1.72], ['159632', 1.97], ['513300', 1.80],
  ['513870', 2.06], ['513110', 2.03], ['159660', 1.92], ['513390', 1.62],
  ['159513', 2.13], ['161130', 1.70],
];

export const DEFAULT_RULES = {
  blazingSunTemp: 25,
  fgGreed: 75,
  partlyCloudyTemp: 10,
  overcastTemp: 0,
  rainyTemp: -10,
  vixStorm: 30,
  fgStorm: 20,
};

export const WEATHER_STATES = {
  blazingSun: {
    name: '艳阳高照',
    icon: '☀️',
    glow: 'text-amber-500',
    surfaceClass: 'border-amber-200 bg-gradient-to-r from-amber-50 via-white to-yellow-50 dark:border-amber-900/50 dark:from-amber-950/40 dark:via-slate-900 dark:to-yellow-950/30',
    pageSurfaceClass: 'bg-gradient-to-r from-amber-50 via-white to-yellow-50 dark:from-amber-950/30 dark:via-slate-900 dark:to-yellow-950/20',
    decorClass: 'text-amber-300/70',
    orbClass: 'bg-amber-200/50',
  },
  partlyCloudy: {
    name: '多云见晴',
    icon: '🌤️',
    glow: 'text-amber-500',
    surfaceClass: 'border-sky-200 bg-gradient-to-r from-sky-50 via-white to-amber-50 dark:border-sky-900/50 dark:from-sky-950/40 dark:via-slate-900 dark:to-amber-950/30',
    pageSurfaceClass: 'bg-gradient-to-r from-sky-50 via-white to-amber-50 dark:from-sky-950/30 dark:via-slate-900 dark:to-amber-950/20',
    decorClass: 'text-sky-300/70',
    orbClass: 'bg-sky-200/50',
  },
  overcast: {
    name: '阴云密布',
    icon: '☁️',
    glow: 'text-slate-400',
    surfaceClass: 'border-slate-200 bg-gradient-to-r from-slate-100 via-white to-slate-50 dark:border-slate-700 dark:from-slate-800 dark:via-slate-900 dark:to-slate-800',
    pageSurfaceClass: 'bg-gradient-to-r from-slate-100 via-white to-slate-50 dark:from-slate-800 dark:via-slate-900 dark:to-slate-800',
    decorClass: 'text-slate-300/70',
    orbClass: 'bg-slate-300/50',
  },
  rainy: {
    name: '细雨连绵',
    icon: '🌧️',
    glow: 'text-sky-500',
    surfaceClass: 'border-sky-200 bg-gradient-to-r from-sky-100 via-white to-blue-50 dark:border-sky-900/50 dark:from-sky-950/50 dark:via-slate-900 dark:to-blue-950/30',
    pageSurfaceClass: 'bg-gradient-to-r from-sky-100 via-white to-blue-50 dark:from-sky-950/40 dark:via-slate-900 dark:to-blue-950/20',
    decorClass: 'text-sky-300/70',
    orbClass: 'bg-blue-200/50',
  },
  storm: {
    name: '恐慌雷暴',
    icon: '⚡',
    glow: 'text-indigo-500',
    surfaceClass: 'border-indigo-200 bg-gradient-to-r from-indigo-50 via-white to-violet-50 dark:border-indigo-900/50 dark:from-indigo-950/50 dark:via-slate-900 dark:to-violet-950/30',
    pageSurfaceClass: 'bg-gradient-to-r from-indigo-50 via-white to-violet-50 dark:from-indigo-950/40 dark:via-slate-900 dark:to-violet-950/20',
    decorClass: 'text-indigo-300/70',
    orbClass: 'bg-indigo-200/50',
  },
};

export function calculateCompositeTemp({ ndxChange = 0, fearGreed = 50, vix = 18, breadth = { up: 0, down: 0 } } = {}) {
  const ndxDelta = ndxChange * 5.2;
  const fgDelta = (fearGreed - 50) * 0.32;
  const vixDelta = vix >= 25 ? -4 - (vix - 25) * 1.2 : vix >= 18 ? -(vix - 18) * 0.5 : (18 - vix) * 0.65;
  const breadthDelta = ((breadth.up - breadth.down) / BREADTH_ITEMS.length) * 12;
  return Math.round((16 + ndxDelta + fgDelta + vixDelta + breadthDelta) * 10) / 10;
}

export function selectWeatherState({ compositeTemp = 0, fearGreed = 50, vix = 18, breadth = { up: 0, down: 0 }, rules = DEFAULT_RULES } = {}) {
  const effectiveRules = { ...DEFAULT_RULES, ...(rules || {}) };
  if (vix >= effectiveRules.vixStorm || fearGreed <= effectiveRules.fgStorm) return WEATHER_STATES.storm;

  const breadthUp = Math.max(0, Number(breadth?.up) || 0);
  const breadthDown = Math.max(0, Number(breadth?.down) || 0);
  const breadthTotal = breadthUp + breadthDown;
  if (breadthTotal > 0 && breadthDown / breadthTotal >= 0.75) return WEATHER_STATES.rainy;

  if (compositeTemp >= effectiveRules.blazingSunTemp || fearGreed >= effectiveRules.fgGreed) return WEATHER_STATES.blazingSun;
  if (compositeTemp >= effectiveRules.partlyCloudyTemp) return WEATHER_STATES.partlyCloudy;
  if (compositeTemp >= effectiveRules.overcastTemp) return WEATHER_STATES.overcast;
  return WEATHER_STATES.rainy;
}

let sharedStore = null;
function sentimentStore() {
  if (!sharedStore) {
    sharedStore = createSentimentStore({ fetchQuotes: (codes) => fetchQuotes(codes), breadthCodes: BREADTH_ITEMS.map(([code]) => code) });
  }
  return sharedStore;
}

// 情绪条 / 研报 / 页面背景共用同一个快照；未拿到数据时不再用写死的兜底值冒充实时行情。
export function useMarketSentimentWeather(rules = DEFAULT_RULES) {
  const store = sentimentStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      await store.refresh();
    } finally {
      if (manual) setRefreshing(false);
    }
  }, [store]);

  const { breadth, ready } = snapshot;
  const fearGreed = snapshot.fearGreed.value;
  const vix = snapshot.vix.value;
  const ndxChange = snapshot.qqq.value ?? 0;
  const compositeTemp = useMemo(() => (ready ? calculateCompositeTemp({ ndxChange, fearGreed: fearGreed ?? 50, vix: vix ?? 18, breadth }) : null), [
    breadth, fearGreed, ndxChange, ready, vix,
  ]);
  const tempLabel = compositeTemp == null ? '—' : (compositeTemp >= 0 ? '+' : '') + compositeTemp.toFixed(1) + '°C';
  const effectiveRules = useMemo(() => ({ ...DEFAULT_RULES, ...(rules || {}) }), [rules]);
  const weather = useMemo(() => (compositeTemp == null
    ? WEATHER_STATES.overcast
    : selectWeatherState({ compositeTemp, fearGreed: fearGreed ?? 50, vix: vix ?? 18, breadth, rules: effectiveRules })), [
    breadth, compositeTemp, effectiveRules, fearGreed, vix,
  ]);

  return {
    breadth,
    compositeTemp,
    error: snapshot.error,
    fearGreed,
    ndxChange,
    qqqChangePercent: snapshot.qqq.value,
    vooChangePercent: snapshot.voo.value,
    ready,
    refresh,
    refreshing,
    snapshot,
    tempLabel,
    vix,
    weather,
  };
}
