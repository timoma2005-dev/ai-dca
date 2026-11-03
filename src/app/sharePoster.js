// 溢价日报分享图：把 /api/notify/share-report/latest 的日报画成一张竖图（含二维码），
// 弹出预览层，支持系统分享 / 下载；微信内置浏览器里长按图片即可保存或转发。
// 纯 DOM + Canvas，不依赖 React，日报页和首页共用。
import QRCode from 'qrcode';
import { apiUrl } from './apiBase.js';

const W = 750;
const PAD = 40;
const FONT = '-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif';
const HALT = 10;
const LATEST_API = '/api/notify/share-report/latest';

function f2(n) { return n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(2); }
function median(values) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function posterShareUrl(report, source = 'poster') {
  const base = report?.url || 'https://fast.freebacktrack.tech/daily.html';
  try {
    const u = new URL(base, 'https://fast.freebacktrack.tech');
    u.searchParams.set('utm_source', 'poster');
    u.searchParams.set('utm_medium', 'share');
    if (!u.searchParams.get('utm_campaign')) u.searchParams.set('utm_campaign', `daily_${report?.date || ''}`);
    u.searchParams.set('utm_content', source);
    return u.toString();
  } catch {
    return base;
  }
}

export function buildPosterModel(report) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const nq = rows.filter((r) => r.group === 'nasdaq' && Number.isFinite(Number(r.premiumPct)))
    .map((r) => ({ ...r, premiumPct: Number(r.premiumPct) }))
    .sort((a, b) => a.premiumPct - b.premiumPct);
  const lof = rows.find((r) => r.group === 'lof' && Number.isFinite(Number(r.premiumPct))) || null;
  const sp = rows.filter((r) => r.group === 'sp500').map((r) => Number(r.premiumPct));
  const med = Number.isFinite(Number(report?.median)) ? Number(report.median) : median(nq.map((r) => r.premiumPct));
  const spMed = Number.isFinite(Number(report?.spMedian)) ? Number(report.spMedian) : median(sp);
  const halted = nq.filter((r) => r.premiumPct > HALT).length;
  return {
    title: report?.title || '纳指QDII溢价日报',
    pre: report?.kind === 'pre',
    navBase: report?.navBase || '',
    nq,
    lof,
    median: med,
    spMedian: spMed,
    halted,
    lowest: nq[0] || null,
    text: report?.text || '',
  };
}

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  String(text || '').split('\n').forEach((para) => {
    if (!para) { out.push(''); return; }
    let line = '';
    for (const ch of para) {
      if (ctx.measureText(line + ch).width > maxWidth && line) { out.push(line); line = ch; } else line += ch;
    }
    out.push(line);
  });
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function drawReportPoster(report, { source = 'poster', scale = 2 } = {}) {
  const model = buildPosterModel(report);
  const qrUrl = posterShareUrl(report, source);
  const qrCanvas = document.createElement('canvas');
  await QRCode.toCanvas(qrCanvas, qrUrl, { margin: 1, width: 180, color: { dark: '#0f172a', light: '#ffffff' } });

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `26px ${FONT}`;
  const hasTable = model.nq.length > 0;
  const textLines = hasTable ? [] : wrapLines(measure, model.text.replace(/\n?实时溢价[^\n]*$/m, '').replace(/https?:\/\/\S+/g, ''), W - PAD * 2 - 40);
  const rowH = 54;
  const tableH = hasTable ? 70 + model.nq.length * rowH + (model.lof ? 70 : 0) + (model.spMedian != null ? 50 : 0) : textLines.length * 40 + 40;
  const H = 300 + (hasTable ? 170 : 0) + tableH + 250;

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, W, 260);
  grad.addColorStop(0, '#4f46e5');
  grad.addColorStop(1, '#7c3aed');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 260);

  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText('AI-DCA · 纳指 QDII 溢价', PAD, 56);
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 40px ${FONT}`;
  ctx.fillText(model.title.replace(/^纳指QDII溢价日报 · /, ''), PAD, 116);
  ctx.font = `24px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  const sub = hasTable
    ? `${model.pre ? '按昨收价' : '按收盘价'}${model.navBase ? ` · 净值基准 ${model.navBase.slice(5)}` : ''} · 溢价从低到高`
    : '每周回顾';
  ctx.fillText(sub, PAD, 166);

  let y = 210;
  if (hasTable) {
    const cardW = (W - PAD * 2 - 24) / 3;
    const kpis = [
      ['溢价中位', model.median != null ? `${f2(model.median)}%` : '—'],
      ['溢价最低', model.lowest ? `${model.lowest.short}` : '—'],
      [model.pre ? '预计停牌' : '溢价>10%', `${model.halted} 只`],
    ];
    kpis.forEach(([label, value], i) => {
      const x = PAD + i * (cardW + 12);
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, x, y, cardW, 120, 18);
      ctx.fill();
      ctx.fillStyle = '#64748b';
      ctx.font = `22px ${FONT}`;
      ctx.fillText(label, x + 20, y + 38);
      ctx.fillStyle = '#0f172a';
      ctx.font = `800 34px ${FONT}`;
      ctx.fillText(value, x + 20, y + 84);
    });
    y += 150;
  } else {
    y += 20;
  }

  ctx.fillStyle = '#ffffff';
  roundRect(ctx, PAD, y, W - PAD * 2, tableH, 20);
  ctx.fill();
  if (hasTable) {
    const maxP = Math.max(...model.nq.map((r) => r.premiumPct), 1);
    let ry = y + 40;
    ctx.fillStyle = '#94a3b8';
    ctx.font = `22px ${FONT}`;
    ctx.fillText('纳指 100 ETF', PAD + 24, ry);
    ctx.textAlign = 'right';
    ctx.fillText('溢价', W - PAD - 24, ry);
    ctx.textAlign = 'left';
    ry += 46;
    model.nq.forEach((r, i) => {
      const hot = r.premiumPct > HALT;
      const low = i < 3;
      ctx.fillStyle = low ? '#16a34a' : '#cbd5e1';
      ctx.font = `700 22px ${FONT}`;
      ctx.fillText(String(i + 1), PAD + 24, ry);
      ctx.fillStyle = '#0f172a';
      ctx.font = `600 26px ${FONT}`;
      ctx.fillText(r.short || r.code, PAD + 60, ry);
      ctx.fillStyle = '#94a3b8';
      ctx.font = `20px ${FONT}`;
      ctx.fillText(r.code, PAD + 200, ry);
      const barX = PAD + 300;
      const barW = W - PAD * 2 - 300 - 130;
      ctx.fillStyle = '#f1f5f9';
      roundRect(ctx, barX, ry - 9, barW, 18, 9);
      ctx.fill();
      ctx.fillStyle = low ? '#22c55e' : hot ? '#f59e0b' : '#818cf8';
      roundRect(ctx, barX, ry - 9, Math.max(18, barW * Math.max(0, r.premiumPct) / maxP), 18, 9);
      ctx.fill();
      ctx.textAlign = 'right';
      ctx.fillStyle = hot ? '#b45309' : '#0f172a';
      ctx.font = `800 26px ${FONT}`;
      ctx.fillText(`${f2(r.premiumPct)}%`, W - PAD - 24, ry);
      ctx.textAlign = 'left';
      ry += rowH;
    });
    if (model.lof) {
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(PAD + 24, ry - 20, W - PAD * 2 - 48, 1);
      ry += 20;
      ctx.fillStyle = '#334155';
      ctx.font = `600 24px ${FONT}`;
      ctx.fillText(`LOF ${model.lof.code}（${model.lof.short || '易方达'}）`, PAD + 24, ry);
      ctx.textAlign = 'right';
      ctx.font = `800 26px ${FONT}`;
      ctx.fillText(`${f2(model.lof.premiumPct)}%`, W - PAD - 24, ry);
      ctx.textAlign = 'left';
      ry += 50;
    }
    if (model.spMedian != null) {
      ctx.fillStyle = '#64748b';
      ctx.font = `22px ${FONT}`;
      ctx.fillText(`标普 500 ETF 溢价中位 ${f2(model.spMedian)}%`, PAD + 24, ry);
    }
  } else {
    ctx.fillStyle = '#334155';
    ctx.font = `26px ${FONT}`;
    textLines.forEach((line, i) => ctx.fillText(line, PAD + 20, y + 40 + i * 40));
  }
  y += tableH + 30;

  ctx.fillStyle = '#ffffff';
  roundRect(ctx, PAD, y, W - PAD * 2, 220, 20);
  ctx.fill();
  ctx.drawImage(qrCanvas, PAD + 20, y + 20, 180, 180);
  ctx.fillStyle = '#0f172a';
  ctx.font = `800 30px ${FONT}`;
  ctx.fillText('长按识别二维码', PAD + 230, y + 62);
  ctx.fillStyle = '#4f46e5';
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText('看实时溢价 · 开启切换提醒', PAD + 230, y + 108);
  ctx.fillStyle = '#94a3b8';
  ctx.font = `22px ${FONT}`;
  ctx.fillText('fast.freebacktrack.tech', PAD + 230, y + 150);
  ctx.font = `20px ${FONT}`;
  ctx.fillText('仅供参考，不构成投资建议', PAD + 230, y + 184);

  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

const SHEET_CSS = `
.sp-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.72);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;gap:12px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.sp-img{max-width:min(420px,100%);max-height:72vh;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.35);background:#fff}
.sp-tip{color:#e2e8f0;font-size:13px;text-align:center}
.sp-row{display:flex;gap:10px}
.sp-btn{height:40px;padding:0 18px;border-radius:999px;border:0;font:inherit;font-weight:700;cursor:pointer;background:#fff;color:#4f46e5;text-decoration:none;display:inline-flex;align-items:center}
.sp-btn.pri{background:#4f46e5;color:#fff}
`;

export async function openPosterSheet(canvas, { filename = 'ai-dca-premium.png', title = '纳指QDII溢价日报', onEvent } = {}) {
  if (!document.getElementById('sp-style')) {
    const style = document.createElement('style');
    style.id = 'sp-style';
    style.textContent = SHEET_CSS;
    document.head.appendChild(style);
  }
  const dataUrl = canvas.toDataURL('image/png');
  const blob = await canvasToBlob(canvas);
  const file = blob && typeof File !== 'undefined' ? new File([blob], filename, { type: 'image/png' }) : null;
  const canShareFile = Boolean(file && navigator.canShare && navigator.canShare({ files: [file] }));
  const mask = document.createElement('div');
  mask.className = 'sp-mask';
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-label', '分享图');
  mask.innerHTML = `<img class="sp-img" alt="${title}" src="${dataUrl}" />
    <div class="sp-tip">微信里长按图片可保存或发送给朋友</div>
    <div class="sp-row">
      ${canShareFile ? '<button type="button" class="sp-btn pri" data-act="share">分享</button>' : ''}
      <a class="sp-btn${canShareFile ? '' : ' pri'}" data-act="save" href="${dataUrl}" download="${filename}">保存图片</a>
      <button type="button" class="sp-btn" data-act="close">关闭</button>
    </div>`;
  const close = () => mask.remove();
  mask.addEventListener('click', (event) => {
    const act = event.target?.closest?.('[data-act]')?.getAttribute('data-act');
    if (event.target === mask || act === 'close') { close(); return; }
    if (act === 'save') onEvent?.('save');
    if (act === 'share') {
      onEvent?.('share');
      navigator.share({ files: [file], title }).catch(() => {});
    }
  });
  document.body.appendChild(mask);
  return close;
}

export async function shareReportPoster(report, { source = 'poster', onEvent } = {}) {
  const canvas = await drawReportPoster(report, { source });
  onEvent?.('open');
  return openPosterSheet(canvas, { filename: `ai-dca-${report?.date || 'premium'}.png`, title: report?.title, onEvent });
}

export async function shareLatestReportPoster({ source = 'home', onEvent } = {}) {
  const response = await fetch(apiUrl(LATEST_API), { cache: 'no-store' });
  const json = await response.json();
  if (!json?.data) throw new Error('日报还没生成');
  return shareReportPoster(json.data, { source, onEvent });
}
