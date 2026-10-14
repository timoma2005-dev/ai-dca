// PCF 限额放开事件信号推送处理器
// 接收来自 ocr-proxy worker 的限额放开事件，格式化后通过现有推送基础设施发送

import { deliverNotification } from './deliveryEngine.js';
import { readSettings } from './notifyStorage.js';

// 8 只深市纳指 ETF 名称映射
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

// 历史命中率（来自 researcher 校准，2026-10-14）
const HIT_RATES = {
  '5x': '12/13',
  '10x': '9/9',
  'unlimited': '9/9', // 彻底放开按 10x 口径
};

function formatShares(shares) {
  if (shares == null) return '未设限';
  if (shares >= 10000) return `${(shares / 10000).toFixed(0)}万`;
  return `${shares}`;
}

function formatLimitChange(prev, cur, ratio, tier) {
  const prevStr = prev.kind === 'unlimited' ? '未设限' : `${formatShares(prev.shares)}份`;
  const curStr = cur.kind === 'unlimited' ? '未设限' : `${formatShares(cur.shares)}份`;
  if (tier === 'unlimited') {
    return `${prevStr}→${curStr}（彻底放开）`;
  }
  const ratioStr = ratio >= 10 ? `${ratio.toFixed(0)}x` : `${ratio.toFixed(1)}x`;
  return `${prevStr}→${curStr}（${ratioStr}）`;
}

export async function handlePcfSignal(request, env) {
  try {
    const body = await request.json();
    const { code, tier, prev, cur, ratio, date, premium } = body;

    if (!code || !tier || !prev || !cur || !date) {
      return new Response(JSON.stringify({ ok: false, reason: 'missing_required_fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!['5x', '10x', 'unlimited'].includes(tier)) {
      return new Response(JSON.stringify({ ok: false, reason: 'invalid_tier' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const fundName = FUND_NAMES[code] || code;
    const limitChange = formatLimitChange(prev, cur, ratio, tier);
    const hitRate = HIT_RATES[tier] || 'N/A';
    const tierLabel = tier === 'unlimited' ? '彻底放开' : `${tier}放宽`;

    const title = `📈 ${code} ${fundName} 限额${tierLabel}`;
    const bodyLines = [
      `限额变化：${limitChange}`,
      premium != null ? `当前溢价：${Number(premium).toFixed(2)}%` : null,
      `历史命中率（${tier === 'unlimited' ? '≥10x' : '≥' + tier}）：${hitRate}`,
      '',
      '💡 限额放开后溢价通常回落，关注做空/切换机会',
    ].filter(Boolean);

    const notification = {
      eventId: `pcf-signal:${code}:${date}:${tier}`,
      eventType: 'pcf_limit_relaxation',
      ruleId: `pcf-signal:${tier}`,
      title,
      body: bodyLines.join('\n'),
      body_md: [`**${title}**`, '', ...bodyLines.map(l => l ? `- ${l}` : '')].join('\n'),
      summary: title,
      symbol: code,
      createdAt: new Date().toISOString(),
    };

    const settings = await readSettings(env).catch(() => null);
    const result = await deliverNotification(env, notification, { settings });

    return new Response(JSON.stringify({ ok: true, delivered: result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[pcf-signal] handler error:', e);
    return new Response(JSON.stringify({ ok: false, reason: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
