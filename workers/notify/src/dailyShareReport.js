/* global console, Response */
// 每日溢价日报（开盘前 09:05 / 收盘后 15:35）与周末周报（周六 10:00）。
// 生成一段可直接转发到微信群/雪球的文字，推送到管理员账号（默认 lovexl）的邮件通道，
// 同时把最新一份写入 KV，供公开页 /daily.html 读取（GET /api/notify/share-report/latest）。
import { readSettings, writeSettings } from './notifyStorage.js';
import { fetchFundMetricsPayload } from './getNav.js';
import { normalizeMarketPremiumMetric, resolveMarketDigestClient } from './marketPremiumDigest.js';
import { getShanghaiDateParts, isTradingDayShanghai } from './holdingsNavSupport.js';
import { jsonResponse, readOrigin } from './notifyHttp.js';

export const SHARE_REPORT_CRONS = Object.freeze({ pre: '5 1 * * MON-FRI', post: '35 7 * * MON-FRI', weekly: '0 2 * * SAT' });
const KV_LATEST = 'share-report:latest';
const KV_DAY_PREFIX = 'share-report:day:';
const DAY_TTL = 40 * 24 * 3600;
const SITE = 'https://fast.freebacktrack.tech';

// 纳指 100 标准 ETF + LOF 161130（隔夜轮动用）+ 标普 500
export const SHARE_NASDAQ = Object.freeze([
  ['513100', '国泰'], ['513110', '华泰柏瑞'], ['513300', '华夏'], ['513390', '博时'], ['513870', '富国'],
  ['159501', '嘉实'], ['159513', '大成'], ['159632', '华安'], ['159659', '招商'], ['159660', '汇添富'],
  ['159696', '易方达'], ['159941', '广发']
]);
export const SHARE_LOF = Object.freeze([['161130', '易方达LOF']]);
export const SHARE_SP500 = Object.freeze([['513500', '博时'], ['513650', '南方'], ['159612', '国泰'], ['159655', '华夏']]);
const HALT_LINE = 10;

function f2(n) { return Number.isFinite(n) ? n.toFixed(2) : '—'; }
function pp(n) { return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}pp` : '—'; }
function sp(n) { return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—'; }
function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function mmdd(date) { const [, m, d] = String(date).split('-'); return `${Number(m)}月${Number(d)}日`; }
function link(campaign) { return `${SITE}/daily.html?utm_source=wechat&utm_medium=share&utm_campaign=${campaign}`; }

export function buildShareRows(items = []) {
  const byCode = new Map(items.map((raw) => normalizeMarketPremiumMetric(raw)).filter((it) => it.code).map((it) => [it.code, it]));
  const pick = (list, group) => list.map(([code, short]) => {
    const it = byCode.get(code) || { code };
    return {
      code, short, group,
      price: Number.isFinite(it.price) ? it.price : null,
      changePercent: Number.isFinite(it.changePercent) ? it.changePercent : null,
      premiumPct: Number.isFinite(it.premiumPct) ? Number(it.premiumPct.toFixed(2)) : null,
      prevPremiumPct: Number.isFinite(it.previousPremiumApproxPct) ? Number(it.previousPremiumApproxPct.toFixed(2)) : null
    };
  });
  return [...pick(SHARE_NASDAQ, 'nasdaq'), ...pick(SHARE_LOF, 'lof'), ...pick(SHARE_SP500, 'sp500')];
}

function overnightPick(nq, lof) {
  const ok = nq.filter((r) => Number.isFinite(r.premiumPct));
  if (!ok.length) return null;
  const allHigh = ok.every((r) => r.premiumPct > HALT_LINE);
  if (allHigh && lof && Number.isFinite(lof.premiumPct)) return { row: lof, why: `全部 ETF 溢价高于 ${HALT_LINE}%，隔夜拿 LOF` };
  const low = ok.slice().sort((a, b) => a.premiumPct - b.premiumPct)[0];
  return { row: low, why: '溢价最低的 ETF' };
}

export function composeDailyReport(kind, rows, date) {
  const nq = rows.filter((r) => r.group === 'nasdaq');
  const lof = rows.find((r) => r.group === 'lof');
  const spx = rows.filter((r) => r.group === 'sp500');
  const field = kind === 'pre' ? 'prevPremiumPct' : 'premiumPct';
  const ranked = nq.filter((r) => Number.isFinite(r[field])).sort((a, b) => a[field] - b[field]);
  const med = median(nq.map((r) => r[field]));
  const spMed = median(spx.map((r) => r[field]));
  const fmt = (r) => `${r.short} ${r.code} ${f2(r[field])}%`;
  const lines = [];
  let title;
  if (kind === 'pre') {
    title = `纳指QDII溢价日报 · ${mmdd(date)} 开盘前`;
    const halts = ranked.filter((r) => r[field] > HALT_LINE);
    const open = ranked.filter((r) => r[field] <= HALT_LINE);
    lines.push(`【${title}】`, '');
    lines.push(`昨收溢价中位 ${f2(med)}%（纳指100 ETF ${ranked.length} 只）`);
    lines.push(`最低：${ranked.slice(0, 3).map(fmt).join('、') || '—'}`);
    lines.push(`最高：${ranked.slice(-3).reverse().map(fmt).join('、') || '—'}`);
    lines.push(halts.length
      ? `溢价>${HALT_LINE}% 预计 9:30 停牌至 10:30：${halts.length} 只`
      : `没有溢价>${HALT_LINE}% 的 ETF，9:30 全部正常开盘`);
    lines.push(`9:30 正常开盘：${open.length ? open.map((r) => r.short).join('、') : '无'}${lof && Number.isFinite(lof[field]) ? `；LOF 161130 溢价 ${f2(lof[field])}%` : ''}`);
    lines.push(`标普500 ETF 溢价中位 ${f2(spMed)}%`);
  } else {
    title = `纳指QDII溢价日报 · ${mmdd(date)} 收盘`;
    const avgChg = median(nq.map((r) => r.changePercent));
    const prevMed = median(nq.map((r) => r.prevPremiumPct));
    lines.push(`【${title}】`, '');
    lines.push(`纳指100 ETF 涨跌中位 ${sp(avgChg)}，溢价中位 ${f2(med)}%${Number.isFinite(med) && Number.isFinite(prevMed) ? `（较昨收 ${pp(med - prevMed)}）` : ''}`);
    lines.push(`溢价最低：${ranked.slice(0, 3).map(fmt).join('、') || '—'}`);
    lines.push(`溢价最高：${ranked.slice(-3).reverse().map(fmt).join('、') || '—'}`);
    lines.push(`高于 ${HALT_LINE}%（明早可能停牌到 10:30）：${ranked.filter((r) => r[field] > HALT_LINE).length} 只`);
    const pick = overnightPick(nq, lof);
    if (pick) lines.push(`隔夜参考：${pick.row.short} ${pick.row.code}（${pick.why}，${f2(pick.row[field])}%）`);
    lines.push(`标普500 ETF 溢价中位 ${f2(spMed)}%`);
  }
  const url = link(`daily_${kind}_${date.replaceAll('-', '')}`);
  lines.push('', `实时溢价、偏离和切换提醒 👉 ${url}`, '', '注：溢价按最新公布净值估算，仅供参考，不构成投资建议。');
  return { kind, date, title, text: lines.join('\n'), url, median: med, spMedian: spMed };
}

export function composeWeeklyReport(days = [], date) {
  const posts = days.filter((d) => d && d.kind === 'post');
  const title = `纳指QDII溢价周报 · ${mmdd(date)}`;
  const lines = [`【${title}】`, ''];
  if (!posts.length) {
    lines.push('本周没有收盘快照。');
  } else {
    posts.forEach((d) => {
      const nq = (d.rows || []).filter((r) => r.group === 'nasdaq' && Number.isFinite(r.premiumPct)).sort((a, b) => a.premiumPct - b.premiumPct);
      lines.push(`${mmdd(d.date)}：溢价中位 ${f2(d.median)}%，最低 ${nq[0] ? `${nq[0].short} ${f2(nq[0].premiumPct)}%` : '—'}`);
    });
    const first = posts[0].median; const last = posts[posts.length - 1].median;
    if (Number.isFinite(first) && Number.isFinite(last)) lines.push('', `本周溢价中位 ${f2(first)}% → ${f2(last)}%（${pp(last - first)}）`);
    const counts = {};
    posts.forEach((d) => {
      const nq = (d.rows || []).filter((r) => r.group === 'nasdaq' && Number.isFinite(r.premiumPct)).sort((a, b) => a.premiumPct - b.premiumPct);
      if (nq[0]) counts[nq[0].short] = (counts[nq[0].short] || 0) + 1;
    });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) lines.push(`本周最常出现的最低溢价：${top[0]}（${top[1]} 天）`);
  }
  const url = link(`weekly_${date.replaceAll('-', '')}`);
  lines.push('', `下周每个交易日开盘前/收盘后更新 👉 ${url}`, '', '注：仅供参考，不构成投资建议。');
  return { kind: 'weekly', date, title, text: lines.join('\n'), url };
}

function toNotification(report) {
  return {
    eventId: `share-report-${report.kind}-${report.date}-${Date.now()}`,
    eventType: 'switch-strategy-trigger',
    ruleId: `share-report-${report.kind}`,
    title: report.title,
    summary: '可直接复制转发的溢价日报',
    body: report.text,
    body_md: report.text.split('\n').map((l) => (l ? `${l}  ` : '')).join('\n'),
    symbol: '纳指QDII',
    strategyName: '溢价日报',
    triggerCondition: report.kind === 'weekly' ? '周六周报' : (report.kind === 'pre' ? '开盘前' : '收盘后'),
    purchaseAmount: '',
    detailUrl: report.url,
    url: report.url,
    tags: ['溢价日报']
  };
}

async function deliver(env, report, runClientDetection, { channel = 'email', accountUsername = '' } = {}) {
  let settings = await readSettings(env);
  const client = resolveMarketDigestClient(settings, env, { accountUsername: accountUsername || env?.SHARE_REPORT_USERNAME || 'lovexl' });
  if (!client?.clientId) return { ok: false, error: 'client-not-found' };
  const result = await runClientDetection(env, settings, client, {
    reason: `share-report-${report.kind}`,
    testPayload: toNotification(report),
    targetChannels: channel ? [channel] : null
  });
  settings = result.settings;
  await writeSettings(env, settings);
  return { ok: true, clientId: client.clientId, summary: result.summary };
}

async function fetchRows(env) {
  const codes = [...SHARE_NASDAQ, ...SHARE_LOF, ...SHARE_SP500].map(([c]) => c);
  const fundKinds = Object.fromEntries(codes.map((c) => [c, 'exchange']));
  const payload = await fetchFundMetricsPayload(env, codes, { refresh: true, fundKinds });
  return buildShareRows(Array.isArray(payload?.items) ? payload.items : []);
}

export async function runShareReport(env, kind, scheduledMs, { runClientDetection, send = true, force = false } = {}) {
  const { date } = getShanghaiDateParts(new Date(scheduledMs || Date.now()));
  if (kind !== 'weekly' && !force && !isTradingDayShanghai(date)) return { ok: true, skipped: 'non-trading-day', date };
  let report;
  if (kind === 'weekly') {
    const days = [];
    for (let i = 6; i >= 1; i -= 1) {
      const d = getShanghaiDateParts(new Date((scheduledMs || Date.now()) - i * 86400000)).date;
      const v = await env.NOTIFY_STATE.get(`${KV_DAY_PREFIX}${d}:post`, 'json').catch(() => null);
      if (v) days.push(v);
    }
    report = composeWeeklyReport(days, date);
  } else {
    const rows = await fetchRows(env);
    report = { ...composeDailyReport(kind, rows, date), rows };
    await env.NOTIFY_STATE.put(`${KV_DAY_PREFIX}${date}:${kind}`, JSON.stringify(report), { expirationTtl: DAY_TTL });
  }
  report.generatedAt = new Date().toISOString();
  await env.NOTIFY_STATE.put(KV_LATEST, JSON.stringify(report));
  const delivery = send && typeof runClientDetection === 'function' ? await deliver(env, report, runClientDetection) : null;
  console.log('[share-report]', JSON.stringify({ kind, date, delivered: delivery?.ok ?? null, summary: delivery?.summary || null }));
  return { ok: true, report, delivery };
}

export async function handleShareReportLatest(request, env) {
  const latest = await env.NOTIFY_STATE.get(KV_LATEST, 'json').catch(() => null);
  return new Response(JSON.stringify({ ok: Boolean(latest), data: latest }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=120'
    }
  });
}

// 管理员手动触发：POST /api/notify/admin/share-report {kind:'pre'|'post'|'weekly', send?, force?}
// 认证：NOTIFY_ADMIN_TOKEN 或专用 SHARE_REPORT_TOKEN（Bearer / x-admin-token）。
export async function handleAdminShareReport(request, env, { runClientDetection, isValidAdminToken, readRequestAdminToken }) {
  const origin = readOrigin(request);
  const shareToken = String(env?.SHARE_REPORT_TOKEN || '').trim();
  const provided = readRequestAdminToken(request);
  const ok = isValidAdminToken(request, env) || (shareToken.length >= 24 && provided === shareToken);
  if (!ok) return jsonResponse({ error: 'forbidden' }, { status: 403, origin });
  const body = await request.json().catch(() => ({}));
  const kind = ['pre', 'post', 'weekly'].includes(body?.kind) ? body.kind : 'post';
  const out = await runShareReport(env, kind, Date.now(), { runClientDetection, send: body?.send !== false, force: body?.force === true });
  return jsonResponse({ ok: out.ok, skipped: out.skipped || null, report: out.report ? { title: out.report.title, text: out.report.text, url: out.report.url } : null, delivery: out.delivery }, { origin });
}
