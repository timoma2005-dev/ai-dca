// PCF 净申购顶格事件：沿用限额放开信号的设置与通知投递路径。
import { deliverNotification } from './deliveryEngine.js';
import { readSettings } from './notifyStorage.js';

const FUND_NAMES = {
  '159501': '嘉实纳斯达克100ETF',
  '159632': '华安纳斯达克100ETF',
  '159659': '招商纳斯达克100ETF',
  '159660': '汇添富纳斯达克100ETF',
  '159696': '易方达纳斯达克100ETF',
  '159941': '广发纳斯达克100ETF',
  '159509': '景顺长城纳斯达克科技ETF',
  '159513': '大成纳斯达克100ETF',
};

function formatShares(shares) {
  if (shares >= 10000) return `${(shares / 10000).toFixed(0)}万`;
  return `${shares}`;
}

const invalid = (reason) => Response.json({ ok: false, reason }, { status: 400 });

export async function handlePcfAtLimit(request, env) {
  try {
    let input;
    try { input = await request.json(); }
    catch { return invalid('invalid_json'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('invalid_body');
    const { code, date, netCreation, totalLimitShares } = input;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return invalid('invalid_code');
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return invalid('invalid_date');
    if (!Number.isSafeInteger(netCreation) || netCreation < 0) return invalid('invalid_net_creation');
    if (!Number.isSafeInteger(totalLimitShares) || totalLimitShares <= 0) return invalid('invalid_total_limit_shares');
    const ratio = netCreation / totalLimitShares;
    if (ratio < 0.9) return invalid('ratio_below_0.9');

    const fundName = FUND_NAMES[code] || code;
    const percent = (ratio * 100).toFixed(1).replace(/\.0$/, '');
    const title = `🔴 ${code} ${fundName} 今日申购顶格打满`;
    const bodyLines = [
      `净申购：${formatShares(netCreation)}份`,
      `总限额：${formatShares(totalLimitShares)}份`,
      `利用率：${percent}%`,
      `日期：${date}`,
      '',
      '💡 当日净申购已达总限额，新增申购空间耗尽，留意溢价变化',
    ];
    const notification = {
      eventId: `pcf-at-limit:${code}:${date}`,
      eventType: 'pcf_at_limit',
      ruleId: 'pcf-at-limit',
      title,
      body: bodyLines.join('\n'),
      body_md: [`**${title}**`, '', ...bodyLines.map(l => l ? `- ${l}` : '')].join('\n'),
      summary: title,
      symbol: code,
      createdAt: new Date().toISOString(),
    };
    const settings = await readSettings(env).catch(() => null);
    const result = await deliverNotification(env, notification, { settings });
    return Response.json({ ok: true, delivered: result });
  } catch (e) {
    console.error('[pcf-at-limit] handler error:', e);
    return Response.json({ ok: false, reason: e.message }, { status: 500 });
  }
}
