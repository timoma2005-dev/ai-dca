// 首页「场内走势」长周期（3月/半年/1年）：读 /api/etf-history/home-premium.json（SVIP，api:etf-history），
// 转成 PremiumChart 的 series 形状。纯函数部分可被 node 测试直接导入。
export const HOME_RANGES = [
  { key: 'today', label: '今日', days: 0 },
  { key: '3m', label: '3月', days: 66 },
  { key: '6m', label: '半年', days: 130 },
  { key: '1y', label: '1年', days: 250 },
];

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function median(values) {
  const s = values.filter((v) => v != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function ffill(values) {
  let last = null;
  return values.map((v) => { if (v != null) last = v; return last; });
}
function isLof(code) { return /^16/.test(String(code || '')); }

// payload: {dates[], funds:[{code,name,groupKey,prem[],close[]}], groups[]}
export function buildDailySeries(payload, { mode = 'premium', group = 'all', range = '3m' } = {}) {
  const dates = Array.isArray(payload?.dates) ? payload.dates : [];
  const funds = Array.isArray(payload?.funds) ? payload.funds : [];
  const spec = HOME_RANGES.find((r) => r.key === range) || HOME_RANGES[1];
  const from = Math.max(0, dates.length - spec.days);
  const ds = dates.slice(from);
  if (!ds.length) return [];
  const pick = (f) => ffill((mode === 'premium' ? f.prem : f.close || []).slice(from).map(num));
  const toPoints = (values) => {
    const pts = [];
    values.forEach((v, i) => { if (v != null) pts.push({ t: ds[i], value: Math.round(v * 10000) / 10000 }); });
    return pts;
  };
  if (group === 'all') {
    const groups = (payload.groups || []).filter((g) => g && g.key);
    return groups.map((g) => {
      const members = funds.filter((f) => (g.key === 'all' || f.groupKey === g.key) && !(mode === 'premium' && isLof(f.code)));
      const cols = members.map(pick);
      let values;
      if (mode === 'premium') values = ds.map((_, i) => median(cols.map((c) => c[i])));
      else {
        // 等权：各基金以区间首个有效价归一为 100
        const norm = cols.map((c) => { const base = c.find((v) => v != null); return base ? c.map((v) => (v == null ? null : (v / base) * 100)) : c; });
        values = ds.map((_, i) => { const xs = norm.map((c) => c[i]).filter((v) => v != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; });
      }
      return { groupKey: 'all', key: `${mode}-daily-${g.key}`, label: `${g.label}${mode === 'premium' ? '中位数' : '等权'}`, points: toPoints(values) };
    }).filter((line) => line.points.length);
  }
  return funds
    .filter((f) => f.groupKey === group)
    .map((f) => ({ code: f.code, key: f.code, name: f.name, groupKey: f.groupKey, points: toPoints(pick(f)) }))
    .filter((line) => line.points.length);
}

export function rangeLabel(range) {
  const spec = HOME_RANGES.find((r) => r.key === range);
  return spec && spec.key !== 'today' ? `近${spec.label} · 日收盘` : '';
}
