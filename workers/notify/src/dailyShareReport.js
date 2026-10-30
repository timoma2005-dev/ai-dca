/* global console, Response, fetch */
// 每日溢价日报（开盘前 09:05 / 收盘后 15:35）与周末周报（周六 10:00）。
// 生成一段可直接转发到微信群/雪球的文字，推送到管理员账号（默认 lovexl）的邮件通道，
// 同时把最新一份写入 KV，供公开页 /daily.html 读取（GET /api/notify/share-report/latest）。
import { readSettings, writeSettings } from './notifyStorage.js';
import { resolveMarketDigestClient } from './marketPremiumDigest.js';
import { getClientRecord } from './clientSettings.js';
import { getShanghaiDateParts, isTradingDayShanghai } from './holdingsNavSupport.js';
import { jsonResponse, readOrigin } from './notifyHttp.js';

export const SHARE_REPORT_CRONS = Object.freeze({ pre: '5 1 * * MON-FRI', post: '35 7 * * MON-FRI', weekly: '0 2 * * SAT' });
const KV_LATEST = 'share-report:latest';
const KV_DAY_PREFIX = 'share-report:day:';
const DAY_TTL = 40 * 24 * 3600;
const SITE = 'https://fast.freebacktrack.tech';
// lovexl 账号的「账号通知」客户端（已验证 QQ 邮箱绑在这里）
const DEFAULT_CLIENT_ID = 'account:usr_ad2be81697b5eec7ca3b2204efb7270c';

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

function overnightPick(nq, lof) {
  const ok = nq.filter((r) => Number.isFinite(r.premiumPct));
  if (!ok.length) return null;
  const allHigh = ok.every((r) => r.premiumPct > HALT_LINE);
  if (allHigh && lof && Number.isFinite(lof.premiumPct)) return { row: lof, why: `全部 ETF 溢价高于 ${HALT_LINE}%，隔夜拿 LOF` };
  const low = ok.slice().sort((a, b) => a.premiumPct - b.premiumPct)[0];
  return { row: low, why: '溢价最低的 ETF' };
}

function navBaseOf(rows) {
  return rows.filter((r) => r.group !== 'lof' && r.navDate).map((r) => r.navDate).sort().at(-1) || '';
}

export function composeDailyReport(kind, rows, date) {
  const nq = rows.filter((r) => r.group === 'nasdaq');
  const lof = rows.find((r) => r.group === 'lof');
  const spx = rows.filter((r) => r.group === 'sp500');
  const ranked = nq.filter((r) => Number.isFinite(r.premiumPct)).sort((a, b) => a.premiumPct - b.premiumPct);
  const med = median(nq.map((r) => r.premiumPct));
  const spMed = median(spx.map((r) => r.premiumPct));
  const navBase = navBaseOf(rows);
  const marks = ['①', '②', '③'];
  const item = (r, i) => `${marks[i]} ${r.short} ${r.code}\u3000${f2(r.premiumPct)}%`;
  const halts = ranked.filter((r) => r.premiumPct > HALT_LINE);
  const pre = kind === 'pre';
  const title = `纳指QDII溢价日报 · ${mmdd(date)} ${pre ? '开盘前' : '收盘'}`;
  const lines = [`【${title}】`];
  lines.push(`${pre ? '按昨收价' : '按收盘价'}，净值基准 ${navBase ? mmdd(navBase) : '—'}（东财口径）`, '');
  lines.push(pre
    ? `纳指100 ETF 溢价中位 ${f2(med)}%`
    : `纳指100 ETF 溢价中位 ${f2(med)}%，涨跌中位 ${sp(median(nq.map((r) => r.changePercent)))}`);
  lines.push('', '溢价最低', ...ranked.slice(0, 3).map(item));
  lines.push('', '溢价最高', ...ranked.slice(-3).reverse().map(item), '');
  if (pre) {
    lines.push(halts.length ? `溢价>${HALT_LINE}%，预计 9:30 停牌到 10:30：${halts.length} 只` : `没有溢价>${HALT_LINE}% 的，9:30 全部正常开盘`);
    const open = ranked.filter((r) => r.premiumPct <= HALT_LINE);
    if (open.length && halts.length) lines.push(`9:30 正常开盘：${open.map((r) => r.short).join('、')}`);
  } else {
    lines.push(`溢价>${HALT_LINE}%（明早可能停牌到 10:30）：${halts.length} 只`);
    const pick = overnightPick(nq, lof);
    if (pick) lines.push(`隔夜参考：${pick.row.short} ${pick.row.code}\u3000${f2(pick.row.premiumPct)}%（${pick.why}）`);
  }
  if (lof && Number.isFinite(lof.premiumPct)) lines.push(`LOF 161130 溢价 ${f2(lof.premiumPct)}%`);
  lines.push(`标普500 ETF 溢价中位 ${f2(spMed)}%`);
  const url = link(`daily_${kind}_${date.replaceAll('-', '')}`);
  const shareText = [...lines, '', `实时溢价/切换提醒 👉 ${url}`, '注：仅供参考，不构成投资建议。'].join('\n');
  // 邮件正文：去掉与邮件标题重复的【】行和链接行（邮件底部有按钮）
  const emailText = [...lines.slice(1), '', '可转发的文字版：打开详情页点「复制文字版」。', '注：仅供参考，不构成投资建议。'].join('\n');
  return { kind, date, title, text: shareText, emailText, url, median: med, spMedian: spMed, navBase };
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
  return { kind: 'weekly', date, title, text: lines.join('\n'), emailText: lines.slice(2).join('\n'), url };
}

function toNotification(report) {
  return {
    eventId: `share-report-${report.kind}-${report.date}-${Date.now()}`,
    eventType: 'switch-strategy-trigger',
    ruleId: `share-report-${report.kind}`,
    title: report.title,
    summary: '可直接复制转发的溢价日报',
    body: report.emailText || report.text,
    body_md: (report.emailText || report.text).split('\n').map((l) => (l ? `${l}  ` : '')).join('\n'),
    symbol: '纳指QDII',
    strategyName: '溢价日报',
    triggerCondition: report.kind === 'weekly' ? '周六周报' : (report.kind === 'pre' ? '开盘前' : '收盘后'),
    purchaseAmount: '',
    detailUrl: report.url,
    url: report.url,
    tags: ['溢价日报']
  };
}

async function deliver(env, report, runClientDetection, { channel = 'email', accountUsername = '', clientId = '' } = {}) {
  let settings = await readSettings(env);
  const wanted = String(clientId || env?.SHARE_REPORT_CLIENT_ID || DEFAULT_CLIENT_ID).trim();
  const direct = wanted ? getClientRecord(settings, wanted) : null;
  const username = String(accountUsername || env?.SHARE_REPORT_USERNAME || 'lovexl').trim().toLowerCase();
  // 优先该账号的「账号通知」客户端（邮箱绑在这里），不走 ADMIN_NOTIFY_CLIENT_ID。
  const clients = Object.values(settings?.clients || {}).filter((c) => String(c?.accountUsername || '').trim().toLowerCase() === username);
  const explicitId = String(env?.SHARE_REPORT_CLIENT_ID || '').trim();
  const client = (direct?.clientId ? direct : null)
    || (explicitId && clients.find((c) => c.clientId === explicitId))
    || clients.find((c) => String(c.clientId || '').startsWith('account:'))
    || resolveMarketDigestClient(settings, env, { accountUsername: username, clientId: explicitId });
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

const EM_URL = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=50&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=ai-dca-share&Fcodes=';

// 溢价统一用东方财富 FundMNFInfo 的 ZJL（与竞价看板同口径：净值未公布的按同类估算到同一基准日），
// 不再用 fund-metrics（那里 IOPV / 最新净值混用，基准日不一致）。LOF 161130 东财无场内价，用腾讯价 / 最新净值。
async function fetchRows() {
  const codes = [...SHARE_NASDAQ, ...SHARE_LOF, ...SHARE_SP500].map(([c]) => c);
  const resp = await fetch(EM_URL + codes.join(','), { headers: { 'user-agent': 'okhttp/3.12.0' } });
  if (!resp.ok) throw new Error(`eastmoney HTTP ${resp.status}`);
  const data = await resp.json();
  const raw = {};
  (Array.isArray(data?.Datas) ? data.Datas : []).forEach((it) => { raw[String(it.FCODE)] = it; });
  let lofPx = null;
  try {
    const t = await (await fetch('https://qt.gtimg.cn/q=sz161130')).text();
    const f = t.split('~');
    lofPx = { cur: Number(f[3]) || null, pre: Number(f[4]) || null };
  } catch { lofPx = null; }
  return buildShareRowsFromEastmoney(raw, { lofPx, navBaseDate: String(data?.Expansion?.FSRQ || '') });
}

export function buildShareRowsFromEastmoney(raw = {}, { lofPx = null, navBaseDate = '' } = {}) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const pick = (list, group) => list.map(([code, short]) => {
    const it = raw[code] || {};
    const zjl = num(it.ZJL);
    let price = num(it.NEWPRICE);
    let changePercent = num(it.CHANGERATIO);
    let premiumPct = zjl == null ? null : -zjl;
    const nav = num(it.NAV);
    if (group === 'lof' && lofPx?.cur && nav) {
      price = lofPx.cur;
      changePercent = lofPx.pre ? (lofPx.cur / lofPx.pre - 1) * 100 : null;
      premiumPct = (lofPx.cur / nav - 1) * 100;
    }
    const navDate = String(it.PDATE || '').slice(0, 10);
    return {
      code, short, group, price,
      changePercent: changePercent == null ? null : Number(changePercent.toFixed(2)),
      premiumPct: premiumPct == null ? null : Number(premiumPct.toFixed(2)),
      navDate,
      navEstimated: Boolean(navBaseDate && navDate && navDate < navBaseDate && group !== 'lof')
    };
  });
  return [...pick(SHARE_NASDAQ, 'nasdaq'), ...pick(SHARE_LOF, 'lof'), ...pick(SHARE_SP500, 'sp500')];
}

export async function runShareReport(env, kind, scheduledMs, { runClientDetection, send = true, force = false, clientId = '' } = {}) {
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
    const rows = await fetchRows();
    report = { ...composeDailyReport(kind, rows, date), rows };
    await env.NOTIFY_STATE.put(`${KV_DAY_PREFIX}${date}:${kind}`, JSON.stringify(report), { expirationTtl: DAY_TTL });
  }
  report.generatedAt = new Date().toISOString();
  await env.NOTIFY_STATE.put(KV_LATEST, JSON.stringify(report));
  const delivery = send && typeof runClientDetection === 'function' ? await deliver(env, report, runClientDetection, { clientId }) : null;
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
  const out = await runShareReport(env, kind, Date.now(), { runClientDetection, send: body?.send !== false, force: body?.force === true, clientId: String(body?.clientId || '') });
  return jsonResponse({ ok: out.ok, skipped: out.skipped || null, report: out.report ? { title: out.report.title, text: out.report.text, url: out.report.url } : null, delivery: out.delivery }, { origin });
}
