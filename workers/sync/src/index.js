import { handleInternalSyncBackup } from './internalSyncBackup.js';
import { handleInternalAuthSync } from './internalAuthSync.js';

const PROBE_HTML = "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n  <title>网络连通性诊断 · 美股策略助手</title>\n  <style>\n    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n    body {\n      font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif;\n      background: #f8fafc;\n      color: #0f172a;\n      line-height: 1.5;\n      padding: 16px;\n      min-height: 100vh;\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: flex-start;\n    }\n    .container {\n      width: 100%;\n      max-width: 680px;\n      margin-top: 24px;\n      margin-bottom: 40px;\n    }\n    .card {\n      background: #ffffff;\n      border: 1px solid #e2e8f0;\n      border-radius: 20px;\n      padding: 24px;\n      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.03);\n      margin-bottom: 16px;\n    }\n    .header {\n      text-align: center;\n      margin-bottom: 24px;\n    }\n    .badge-top {\n      display: inline-flex;\n      align-items: center;\n      gap: 6px;\n      padding: 4px 12px;\n      border-radius: 9999px;\n      font-size: 12px;\n      font-weight: 600;\n      background: #eef2ff;\n      color: #4f46e5;\n      margin-bottom: 8px;\n    }\n    h1 {\n      font-size: 22px;\n      font-weight: 800;\n      color: #0f172a;\n      margin-bottom: 6px;\n    }\n    p.subtitle {\n      font-size: 13px;\n      color: #64748b;\n    }\n    .status-banner {\n      border-radius: 16px;\n      padding: 18px;\n      display: flex;\n      align-items: flex-start;\n      gap: 14px;\n      margin-bottom: 20px;\n      transition: all 0.3s ease;\n    }\n    .status-banner.loading {\n      background: #f1f5f9;\n      border: 1px solid #cbd5e1;\n      color: #334155;\n    }\n    .status-banner.success {\n      background: #ecfdf5;\n      border: 1px solid #a7f3d0;\n      color: #065f46;\n    }\n    .status-banner.failed {\n      background: #fff1f2;\n      border: 1px solid #fecdd3;\n      color: #9f1239;\n    }\n    .status-icon {\n      font-size: 26px;\n      line-height: 1;\n      flex-shrink: 0;\n    }\n    .status-title {\n      font-size: 16px;\n      font-weight: 700;\n      margin-bottom: 4px;\n    }\n    .status-desc {\n      font-size: 13px;\n      opacity: 0.9;\n      line-height: 1.5;\n    }\n    .grid-info {\n      display: grid;\n      grid-template-columns: repeat(2, 1fr);\n      gap: 12px;\n      margin-bottom: 20px;\n    }\n    @media (max-width: 520px) {\n      .grid-info { grid-template-columns: 1fr; }\n    }\n    .info-item {\n      background: #f8fafc;\n      border: 1px solid #f1f5f9;\n      border-radius: 12px;\n      padding: 12px 14px;\n    }\n    .info-label {\n      font-size: 11px;\n      font-weight: 600;\n      color: #94a3b8;\n      text-transform: uppercase;\n      letter-spacing: 0.5px;\n      margin-bottom: 3px;\n    }\n    .info-value {\n      font-size: 14px;\n      font-weight: 700;\n      color: #1e293b;\n      word-break: break-all;\n    }\n    .info-value.mono {\n      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;\n    }\n    .btn-group {\n      display: flex;\n      flex-wrap: wrap;\n      gap: 10px;\n    }\n    button, a.btn {\n      display: inline-flex;\n      align-items: center;\n      justify-content: center;\n      gap: 8px;\n      border-radius: 9999px;\n      font-size: 13px;\n      font-weight: 700;\n      padding: 10px 18px;\n      cursor: pointer;\n      text-decoration: none;\n      transition: all 0.15s ease;\n      border: none;\n    }\n    .btn-primary {\n      background: #4f46e5;\n      color: #ffffff;\n      flex: 1;\n      min-width: 140px;\n    }\n    .btn-primary:hover { background: #4338ca; }\n    .btn-secondary {\n      background: #f1f5f9;\n      color: #334155;\n    }\n    .btn-secondary:hover { background: #e2e8f0; }\n    .btn-success {\n      background: #10b981;\n      color: #ffffff;\n      flex: 1;\n      min-width: 140px;\n    }\n    .btn-success:hover { background: #059669; }\n    .solution-box {\n      margin-top: 16px;\n      background: #fffbeb;\n      border: 1px solid #fef3c7;\n      border-radius: 14px;\n      padding: 14px 16px;\n      font-size: 13px;\n      color: #92400e;\n    }\n    .solution-title {\n      font-weight: 700;\n      margin-bottom: 6px;\n      display: flex;\n      align-items: center;\n      gap: 6px;\n    }\n    .solution-box ol {\n      margin-left: 20px;\n      line-height: 1.6;\n    }\n    .toast {\n      position: fixed;\n      bottom: 24px;\n      left: 50%;\n      transform: translateX(-50%) translateY(100px);\n      background: #0f172a;\n      color: #ffffff;\n      padding: 10px 20px;\n      border-radius: 9999px;\n      font-size: 13px;\n      font-weight: 600;\n      opacity: 0;\n      transition: all 0.25s ease;\n      pointer-events: none;\n      z-index: 1000;\n    }\n    .toast.show {\n      transform: translateX(-50%) translateY(0);\n      opacity: 1;\n    }\n    .footer-note {\n      text-align: center;\n      font-size: 12px;\n      color: #94a3b8;\n      margin-top: 16px;\n    }\n    .spinner {\n      display: inline-block;\n      width: 14px;\n      height: 14px;\n      border: 2px solid rgba(255, 255, 255, 0.3);\n      border-radius: 50%;\n      border-top-color: currentColor;\n      animation: spin 0.8s linear infinite;\n    }\n    @keyframes spin {\n      to { transform: rotate(360deg); }\n    }\n  </style>\n</head>\n<body>\n  <div class=\"container\">\n    <div class=\"header\">\n      <div class=\"badge-top\">🌐 网络连通探活诊断工具</div>\n      <h1>美股策略助手 · 连接检测</h1>\n      <p class=\"subtitle\">自动排查当前网络与 CN 国内专线 (5000 端口) 的可达性与阻断原因</p>\n    </div>\n\n    <div class=\"card\">\n      <div id=\"statusBanner\" class=\"status-banner loading\">\n        <div class=\"status-icon\" id=\"statusIcon\">⏳</div>\n        <div>\n          <div class=\"status-title\" id=\"statusTitle\">正在探测网络环境…</div>\n          <div class=\"status-desc\" id=\"statusDesc\">正在连接 Cloudflare 边缘节点并测试 cn.freebacktrack.tech:5000 可达性，请稍候约 2~3 秒。</div>\n        </div>\n      </div>\n\n      <div class=\"grid-info\">\n        <div class=\"info-item\">\n          <div class=\"info-label\">您的公网 IP 地址</div>\n          <div class=\"info-value mono\" id=\"infoIp\">检测中…</div>\n        </div>\n        <div class=\"info-item\">\n          <div class=\"info-label\">网络接入节点 / 地区</div>\n          <div class=\"info-value\" id=\"infoColo\">检测中…</div>\n        </div>\n        <div class=\"info-item\">\n          <div class=\"info-label\">CN 专线 (5000 端口) 连通性</div>\n          <div class=\"info-value\" id=\"infoCnStatus\">探测中…</div>\n        </div>\n        <div class=\"info-item\">\n          <div class=\"info-label\">全球通用专线 (443 端口)</div>\n          <div class=\"info-value\" id=\"infoGlobalStatus\">探测中…</div>\n        </div>\n      </div>\n\n      <div id=\"solutionBox\" class=\"solution-box\" style=\"display: none;\">\n        <div class=\"solution-title\">💡 诊断结论与解决建议</div>\n        <div id=\"solutionContent\"></div>\n      </div>\n\n      <div style=\"margin-top: 20px;\" class=\"btn-group\">\n        <button type=\"button\" class=\"btn-primary\" id=\"btnRetest\" onclick=\"runDiagnosis()\">\n          🔄 重新测速\n        </button>\n        <button type=\"button\" class=\"btn-secondary\" id=\"btnCopyReport\" onclick=\"copyDiagnosticReport()\">\n          📋 复制诊断报告\n        </button>\n        <a href=\"https://freebacktrack.tech\" target=\"_blank\" class=\"btn btn-secondary\" id=\"btnGlobalAccess\">\n          🌐 访问全球 443 专线\n        </a>\n      </div>\n    </div>\n\n    <div class=\"footer-note\">\n      美股策略助手 · 诊断信息已加密上报，用于协助定位区域网络故障\n    </div>\n  </div>\n\n  <div id=\"toast\" class=\"toast\"></div>\n\n  <script>\n    const CF_COLO_NAMES = {\n      SJW: '中国华北·石家庄 (北京接入)',\n      PEK: '中国华北·北京',\n      PKX: '中国华北·北京大兴',\n      TSN: '中国华北·天津',\n      TYN: '中国华北·太原',\n      HET: '中国华北·呼和浩特',\n      SHA: '中国华东·上海',\n      PVG: '中国华东·上海浦东',\n      HGH: '中国华东·杭州',\n      NKG: '中国华东·南京',\n      SZV: '中国华东·苏州',\n      WNZ: '中国华东·温州',\n      NGB: '中国华东·宁波',\n      HFE: '中国华东·合肥',\n      FOC: '中国华东·福州',\n      XMN: '中国华东·厦门',\n      TAO: '中国华东·青岛',\n      TNA: '中国华东·济南',\n      CAN: '中国华南·广州',\n      SZX: '中国华南·深圳',\n      ZHA: '中国华南·湛江',\n      NNG: '中国华南·南宁',\n      HAK: '中国华南·海口',\n      WUH: '中国华中·武汉',\n      CSX: '中国华中·长沙',\n      CGO: '中国华中·郑州',\n      CTU: '中国西南·成都',\n      TFU: '中国西南·成都天府',\n      CKG: '中国西南·重庆',\n      KMG: '中国西南·昆明',\n      KWE: '中国西南·贵阳',\n      XIY: '中国西北·西安',\n      LHW: '中国西北·兰州',\n      XNN: '中国西北·西宁',\n      URC: '中国西北·乌鲁木齐',\n      SHE: '中国东北·沈阳',\n      DLC: '中国东北·大连',\n      CGQ: '中国东北·长春',\n      HRB: '中国东北·哈尔滨',\n      HKG: '中国香港',\n      MFM: '中国澳门',\n      TPE: '中国台湾·台北',\n      SIN: '新加坡',\n      NRT: '日本·东京',\n      ICN: '韩国·首尔'\n    };\n\n    let latestReport = null;\n\n    function showToast(msg) {\n      const t = document.getElementById('toast');\n      t.textContent = msg;\n      t.classList.add('show');\n      setTimeout(() => t.classList.remove('show'), 2500);\n    }\n\n    function parseTrace(text) {\n      const data = {};\n      (text || '').split('\\n').forEach(line => {\n        const idx = line.indexOf('=');\n        if (idx > 0) data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();\n      });\n      return data;\n    }\n\n    async function fetchCfTrace() {\n      const endpoints = [\n        'https://freebacktrack.tech/cdn-cgi/trace',\n        'https://www.cloudflare-cn.com/cdn-cgi/trace',\n        'https://cloudflare-dns.com/cdn-cgi/trace'\n      ];\n      for (const ep of endpoints) {\n        try {\n          const res = await fetch(ep, { cache: 'no-store', signal: AbortSignal.timeout(3500) });\n          if (res.ok) {\n            const text = await res.text();\n            const p = parseTrace(text);\n            if (p.ip || p.colo) return p;\n          }\n        } catch {}\n      }\n      return {};\n    }\n\n    async function probeCnTarget() {\n      const isCnHost = window.location.host.includes('cn.freebacktrack.tech');\n      const url = isCnHost\n        ? `/api/market-collector/health?probe=${Date.now()}`\n        : `https://cn.freebacktrack.tech:5000/api/market-collector/health?probe=${Date.now()}`;\n      const t0 = performance.now();\n      try {\n        await fetch(url, {\n          method: 'GET',\n          mode: isCnHost ? 'cors' : 'no-cors',\n          cache: 'no-store',\n          signal: AbortSignal.timeout(5000)\n        });\n        const latency = Math.max(1, Math.round(performance.now() - t0));\n        return { ok: true, latency, error: '' };\n      } catch (err) {\n        const latency = Math.max(1, Math.round(performance.now() - t0));\n        const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';\n        return {\n          ok: false,\n          latency,\n          error: isTimeout ? '连接超时 (>5s)' : '5000端口受阻或网络拒绝'\n        };\n      }\n    }\n\n    async function probeGlobalTarget() {\n      const t0 = performance.now();\n      try {\n        await fetch('https://freebacktrack.tech/cdn-cgi/trace', {\n          cache: 'no-store',\n          signal: AbortSignal.timeout(4000)\n        });\n        return { ok: true, latency: Math.max(1, Math.round(performance.now() - t0)) };\n      } catch {\n        return { ok: false, latency: 0 };\n      }\n    }\n\n    async function reportToAnalytics(report) {\n      try {\n        const payload = {\n          type: 'network_trace',\n          meta: {\n            source: 'standalone_probe_page',\n            ip: report.ip,\n            loc: report.loc,\n            colo: report.colo,\n            coloRegion: report.coloRegion,\n            cnStatus: report.cnOk ? 'ok' : 'failed',\n            cnReachable: report.cnOk,\n            cnLatency: report.cnLatency,\n            cnError: report.cnError,\n            globalOk: report.globalOk,\n            userAgent: navigator.userAgent\n          }\n        };\n        const apiUrl = 'https://api.freebacktrack.tech/api/sync/analytics/track';\n        fetch(apiUrl, {\n          method: 'POST',\n          headers: { 'Content-Type': 'application/json' },\n          body: JSON.stringify(payload)\n        }).catch(() => {});\n      } catch {}\n    }\n\n    async function runDiagnosis() {\n      const banner = document.getElementById('statusBanner');\n      const icon = document.getElementById('statusIcon');\n      const title = document.getElementById('statusTitle');\n      const desc = document.getElementById('statusDesc');\n      const btn = document.getElementById('btnRetest');\n      const solutionBox = document.getElementById('solutionBox');\n      const solutionContent = document.getElementById('solutionContent');\n\n      btn.disabled = true;\n      btn.innerHTML = '<span class=\"spinner\"></span> 测速中…';\n\n      banner.className = 'status-banner loading';\n      icon.textContent = '⏳';\n      title.textContent = '正在探测网络环境…';\n      desc.textContent = '正在排查您的 IP、Cloudflare 接入边缘以及 5000 端口连通性…';\n\n      document.getElementById('infoIp').textContent = '获取中…';\n      document.getElementById('infoColo').textContent = '检测中…';\n      document.getElementById('infoCnStatus').textContent = '探测中…';\n      document.getElementById('infoGlobalStatus').textContent = '探测中…';\n      solutionBox.style.display = 'none';\n\n      const [cf, cnProbe, globalProbe] = await Promise.all([\n        fetchCfTrace(),\n        probeCnTarget(),\n        probeGlobalTarget()\n      ]);\n\n      const ip = cf.ip || '未能获取';\n      const loc = cf.loc || 'CN';\n      const colo = (cf.colo || '未知').toUpperCase();\n      const coloRegion = CF_COLO_NAMES[colo] || (loc === 'CN' ? `中国·节点 (${colo})` : `${loc}·${colo}`);\n\n      document.getElementById('infoIp').textContent = ip;\n      document.getElementById('infoColo').textContent = `${colo} · ${coloRegion}`;\n\n      if (cnProbe.ok) {\n        document.getElementById('infoCnStatus').innerHTML = `<span style=\"color: #10b981; font-weight: bold;\">🟢 正常 (${cnProbe.latency}ms)</span>`;\n      } else {\n        document.getElementById('infoCnStatus').innerHTML = `<span style=\"color: #e11d48; font-weight: bold;\">🔴 受阻 (${cnProbe.error})</span>`;\n      }\n\n      if (globalProbe.ok) {\n        document.getElementById('infoGlobalStatus').innerHTML = `<span style=\"color: #10b981; font-weight: bold;\">🟢 正常 (${globalProbe.latency}ms)</span>`;\n      } else {\n        document.getElementById('infoGlobalStatus').innerHTML = `<span style=\"color: #f59e0b; font-weight: bold;\">🟡 异常/未连通</span>`;\n      }\n\n      latestReport = {\n        time: new Date().toLocaleString(),\n        ip,\n        loc,\n        colo,\n        coloRegion,\n        cnOk: cnProbe.ok,\n        cnLatency: cnProbe.latency,\n        cnError: cnProbe.error,\n        globalOk: globalProbe.ok,\n        globalLatency: globalProbe.latency\n      };\n\n      reportToAnalytics(latestReport);\n\n      if (cnProbe.ok) {\n        banner.className = 'status-banner success';\n        icon.textContent = '✅';\n        title.textContent = 'CN 专线连通良好，可以正常访问！';\n        desc.textContent = `当前网络与国内服务器（cn.freebacktrack.tech:5000）连接正常，响应延迟为 ${cnProbe.latency}ms。`;\n        solutionBox.style.display = 'none';\n      } else if (globalProbe.ok && !cnProbe.ok) {\n        banner.className = 'status-banner failed';\n        icon.textContent = '🚫';\n        title.textContent = '检测到 5000 端口受阻，无法打开 CN 页面';\n        desc.textContent = `您的互联网连接完全正常，但您当前所在网络阻断了非标 5000 端口（${cnProbe.error}）。`;\n        solutionBox.style.display = 'block';\n        solutionContent.innerHTML = `\n          <p style=\"margin-bottom: 8px;\"><strong>阻断原因：</strong>国内部分企业内网、校园网或宽带运营商（移动/长宽/广电等）防火墙默认只放行 80 和 443 端口，导致无法直连 <code>cn.freebacktrack.tech:5000</code>。</p>\n          <ol>\n            <li><strong>快速方案（强烈推荐）：</strong>直接点击下方按钮切换到<strong>「全球通用 443 专线」</strong>，走标准 443 端口，不受任何运营商端口拦截影响。</li>\n            <li><strong>切换网络：</strong>将电脑或手机切换到电信/联通网络或使用<strong>手机 5G 热点</strong>后，点击上方「重新测速」重试。</li>\n            <li><strong>反馈管理员：</strong>点击下方「复制诊断报告」，将报告发送至群内或管理员。</li>\n          </ol>\n        `;\n      } else {\n        banner.className = 'status-banner failed';\n        icon.textContent = '⚠️';\n        title.textContent = '本地网络异常或完全无法连接';\n        desc.textContent = '未能检测到有效的公网互联网连接，请先检查您的 Wi-Fi 或蜂窝移动网络。';\n        solutionBox.style.display = 'none';\n      }\n\n      btn.disabled = false;\n      btn.innerHTML = '🔄 重新测速';\n    }\n\n    function copyDiagnosticReport() {\n      if (!latestReport) {\n        showToast('请等待测速完成后再复制');\n        return;\n      }\n      const text = [\n        '【美股策略助手 · 网络连通诊断报告】',\n        `探测时间: ${latestReport.time}`,\n        `客户端IP: ${latestReport.ip}`,\n        `接入节点: ${latestReport.colo} (${latestReport.coloRegion})`,\n        `地理国家: ${latestReport.loc}`,\n        `CN专线(5000): ${latestReport.cnOk ? `正常 (${latestReport.cnLatency}ms)` : `受阻 (${latestReport.cnError})`}`,\n        `全球专线(443): ${latestReport.globalOk ? `正常 (${latestReport.globalLatency}ms)` : '受阻'}`,\n        `浏览器UA: ${navigator.userAgent}`\n      ].join('\\n');\n\n      if (navigator.clipboard && navigator.clipboard.writeText) {\n        navigator.clipboard.writeText(text).then(() => {\n          showToast('✅ 诊断报告已复制到剪贴板！');\n        }).catch(() => {\n          prompt('请复制以下诊断报告：', text);\n        });\n      } else {\n        prompt('请复制以下诊断报告：', text);\n      }\n    }\n\n    window.addEventListener('DOMContentLoaded', runDiagnosis);\n  </script>\n</body>\n</html>\n";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const ANALYTICS_RETENTION_DAYS = 31;
const ANALYTICS_CLEANUP_BATCH_SIZE = 5000;
const ANALYTICS_CLEANUP_MAX_BATCHES = 12;
const ADMIN_USERNAMES = new Set(['lovexl', 'wanghao0902', 'de88903']);

function isAdminUsername(username = '') {
  return ADMIN_USERNAMES.has(String(username || '').trim().toLowerCase());
}

function corsHeaders(origin = '*') {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,PUT,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400'
  };
}

function json(payload, { status = 200, origin = '*' } = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { ...corsHeaders(origin), 'content-type': 'application/json; charset=utf-8' }
  });
}

function nowIso() { return new Date().toISOString(); }

export function analyticsRetentionCutoffDate(nowMs = Date.now()) {
  const keepDays = Math.max(1, ANALYTICS_RETENTION_DAYS - 1);
  return new Date(Number(nowMs) - keepDays * 86400000).toISOString().slice(0, 10);
}

export async function pruneOldAnalyticsEvents(env, nowMs = Date.now(), options = {}) {
  const cutoff = analyticsRetentionCutoffDate(nowMs);
  const batchSize = Math.max(
    1,
    Math.min(Number(options.batchSize) || ANALYTICS_CLEANUP_BATCH_SIZE, ANALYTICS_CLEANUP_BATCH_SIZE),
  );
  const maxBatches = Math.max(
    1,
    Math.min(Number(options.maxBatches) || ANALYTICS_CLEANUP_MAX_BATCHES, ANALYTICS_CLEANUP_MAX_BATCHES),
  );
  let deleted = 0;
  let batches = 0;
  let lastBatchDeleted = 0;

  while (batches < maxBatches) {
    const result = await env.DB.prepare(`DELETE FROM analytics_events
      WHERE id IN (
        SELECT id FROM analytics_events
        WHERE event_date < ?
        ORDER BY event_date ASC, created_at ASC
        LIMIT ?
      )`).bind(cutoff, batchSize).run();
    lastBatchDeleted = Number(result?.meta?.changes) || 0;
    deleted += lastBatchDeleted;
    batches += 1;
    if (lastBatchDeleted < batchSize) break;
  }

  return {
    cutoff,
    deleted,
    batches,
    hitBatchLimit: batches >= maxBatches && lastBatchDeleted >= batchSize,
  };
}

function normalizeUsername(username = '') {
  return String(username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 48);
}

function randomId(prefix = '') {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}${hex}`;
}

async function sha256Hex(text = '') {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

async function ensureSchema(env) {
  if (!env.DB) throw new Error('D1 binding DB missing');
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  try {
    await env.DB.prepare("ALTER TABLE users ADD COLUMN password_salt TEXT NOT NULL DEFAULT ''").run();
  } catch {
    // Existing databases may already have this column.
  }
  try {
    await env.DB.prepare("ALTER TABLE users ADD COLUMN last_login_at TEXT NOT NULL DEFAULT ''").run();
  } catch {
    // Existing databases may already have this column.
  }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sync_events (
    event_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    visitor_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    event_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}'
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_analytics_events_date_type ON analytics_events (event_date, type)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_analytics_events_date_created ON analytics_events (event_date, created_at DESC)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS analytics_daily_stats (
    event_date TEXT PRIMARY KEY,
    pv INTEGER NOT NULL DEFAULT 0,
    switch_runs INTEGER NOT NULL DEFAULT 0
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS analytics_daily_users (
    event_date TEXT NOT NULL,
    identity TEXT NOT NULL,
    is_visitor_only INTEGER NOT NULL DEFAULT 0,
    has_page_view INTEGER NOT NULL DEFAULT 0,
    has_page_engagement INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_date, identity)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_analytics_daily_users_date_flags
    ON analytics_daily_users (event_date, has_page_view, has_page_engagement)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS backups (
    user_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    kv_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    key_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT ''
  )`).run();
  for (const alter of [
    "ALTER TABLE backups ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE backups ADD COLUMN envelope TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE backups ADD COLUMN cipher_sha256 TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE backups ADD COLUMN last_end_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE backups ADD COLUMN last_end_type TEXT NOT NULL DEFAULT ''"
  ]) {
    try {
      await env.DB.prepare(alter).run();
    } catch {
      // 现有表可能已存在该列。
    }
  }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS backup_versions (
    user_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    kv_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    key_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    envelope TEXT NOT NULL DEFAULT '',
    cipher_sha256 TEXT NOT NULL DEFAULT '',
    last_end_id TEXT NOT NULL DEFAULT '',
    last_end_type TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, version)
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_backup_versions_user_version ON backup_versions (user_id, version DESC)').run();
}

async function hashPasswordCredential(passwordHash, salt) {
  return sha256Hex(`${salt}:${passwordHash}`);
}

async function createSession(env, user) {
  const accessToken = randomId('acc_');
  const refreshToken = randomId('ref_');
  const tokenHash = await sha256Hex(accessToken);
  const expires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, user.id, nowIso(), expires).run();
  return { userId: user.id, username: user.username, accessToken, refreshToken, expiresAt: expires, isAdmin: isAdminUsername(user.username) };
}

async function requireUser(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`SELECT users.id, users.username
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
    .bind(tokenHash, nowIso()).first();
  return row || null;
}

function analyticsEventIdentity(event = {}) {
  return String(event.userId || event.visitorId || '').trim();
}

export async function updateDailyAnalyticsAggregate(env, events = []) {
  const dailyStats = new Map();
  const dailyUsers = new Map();
  for (const event of events) {
    const date = String(event.date || event.createdAt || nowIso()).slice(0, 10);
    const type = String(event.type || '');
    const stats = dailyStats.get(date) || { pv: 0, switchRuns: 0 };
    if (type === 'page_view') stats.pv += 1;
    if (type === 'switch_worker_run') stats.switchRuns += 1;
    dailyStats.set(date, stats);
    const identity = analyticsEventIdentity(event);
    if (!identity) continue;
    const key = date + ' ' + identity;
    const user = dailyUsers.get(key) || { date, identity, isVisitorOnly: 0, hasPageView: 0, hasPageEngagement: 0 };
    if (type === 'page_view') user.hasPageView = 1;
    if (type === 'page_engagement') user.hasPageEngagement = 1;
    if (!event.userId && event.visitorId) user.isVisitorOnly = 1;
    dailyUsers.set(key, user);
  }
  const statements = [];
  for (const [date, stats] of dailyStats) {
    statements.push(env.DB.prepare(`INSERT INTO analytics_daily_stats (event_date, pv, switch_runs) VALUES (?, ?, ?)
      ON CONFLICT(event_date) DO UPDATE SET pv = pv + excluded.pv, switch_runs = switch_runs + excluded.switch_runs`).bind(date, stats.pv, stats.switchRuns));
  }
  for (const user of dailyUsers.values()) {
    statements.push(env.DB.prepare(`INSERT INTO analytics_daily_users (event_date, identity, is_visitor_only, has_page_view, has_page_engagement) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_date, identity) DO UPDATE SET
        is_visitor_only = MAX(is_visitor_only, excluded.is_visitor_only),
        has_page_view = MAX(has_page_view, excluded.has_page_view),
        has_page_engagement = MAX(has_page_engagement, excluded.has_page_engagement)
    `).bind(user.date, user.identity, user.isVisitorOnly, user.hasPageView, user.hasPageEngagement));
  }
  if (!statements.length) return;
  if (typeof env.DB.batch === 'function') {
    await env.DB.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}


async function handleTrackAnalytics(request, env, origin) {
  const body = await readBody(request);
  const events = Array.isArray(body?.events) ? body.events.slice(0, 50) : [body];
  let accepted = 0;
  const acceptedEvents = [];
  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== 'object') continue;
    const id = String(rawEvent.id || randomId('evt_')).slice(0, 96);
    const type = String(rawEvent.type || '').trim().slice(0, 64);
    if (!type) continue;
    if (type === 'network_trace' && rawEvent.meta && typeof rawEvent.meta === 'object') {
      const meta = { ...rawEvent.meta };
      if (!meta.ip) meta.ip = request.headers.get('cf-connecting-ip') || '';
      if (!meta.colo) meta.colo = request.cf?.colo || '';
      if (!meta.loc) meta.loc = request.cf?.country || '';
      rawEvent.meta = meta;
    }
    const createdAt = String(rawEvent.createdAt || nowIso()).slice(0, 40);
    const eventDate = String(rawEvent.date || createdAt.slice(0, 10) || nowIso().slice(0, 10)).slice(0, 10);
    const normalizedEvent = {
      id,
      type,
      createdAt,
      date: eventDate,
      userId: String(rawEvent.userId || '').slice(0, 96),
      username: normalizeUsername(rawEvent.username || ''),
      visitorId: String(rawEvent.visitorId || '').slice(0, 120),
      sessionId: String(rawEvent.sessionId || '').slice(0, 120),
      path: String(rawEvent.path || '').slice(0, 500),
      meta: JSON.stringify(rawEvent.meta || {}).slice(0, 4000)
    };
    const result = await env.DB.prepare(`INSERT OR IGNORE INTO analytics_events
      (id, type, user_id, username, visitor_id, session_id, path, event_date, created_at, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        normalizedEvent.id,
        normalizedEvent.type,
        normalizedEvent.userId,
        normalizedEvent.username,
        normalizedEvent.visitorId,
        normalizedEvent.sessionId,
        normalizedEvent.path,
        normalizedEvent.date,
        normalizedEvent.createdAt,
        normalizedEvent.meta
      ).run();
    accepted += 1;
    if (result?.meta?.changes === 0) continue;
    acceptedEvents.push(normalizedEvent);
  }
  if (!accepted) return json({ message: 'missing event type' }, { status: 400, origin });
  if (acceptedEvents.length) await updateDailyAnalyticsAggregate(env, acceptedEvents);
  return json({ ok: true, accepted }, { origin });
}

async function handleAnalyticsGuests(request, env, origin) {
  const user = await requireUser(request, env);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  if (!isAdminUsername(user.username)) return json({ message: '无管理员权限' }, { status: 403, origin });
  const requestedLimit = Number(new URL(request.url).searchParams.get('limit')?.trim() || 200);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 200;
  const result = await env.DB.prepare(`SELECT identity AS visitorId, MIN(event_date) AS firstSeenDate,
    MAX(event_date) AS lastActiveDate, COUNT(*) AS activeDays
    FROM analytics_daily_users WHERE is_visitor_only = 1
    GROUP BY identity ORDER BY lastActiveDate DESC LIMIT ?`).bind(limit).all();
  return json({ ok: true, available: true, guests: result?.results || [] }, { origin });
}

async function handleRegister(request, env, origin) {
  const body = await readBody(request);
  const username = normalizeUsername(body.username);
  const passwordHash = String(body.passwordHash || '').trim();
  if (username.length < 3) return json({ message: '用户名至少 3 位' }, { status: 400, origin });
  if (passwordHash.length < 32) return json({ message: '密码不合法' }, { status: 400, origin });
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) return json({ message: '用户名已存在' }, { status: 409, origin });
  const user = { id: randomId('usr_'), username };
  const salt = randomId('pwd_');
  const storedHash = await hashPasswordCredential(passwordHash, salt);
  try {
    await env.DB.prepare('INSERT INTO users (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(user.id, username, storedHash, salt, nowIso(), nowIso()).run();
  } catch (err) {
    // 高并发下两个请求可能同时通过上面的存在性检查，UNIQUE 约束是最后一道防线。
    if (String(err?.message || '').includes('UNIQUE constraint failed')) {
      return json({ message: '用户名已存在' }, { status: 409, origin });
    }
    throw err;
  }
  return json(await createSession(env, user), { origin });
}

async function handleLogin(request, env, origin) {
  const body = await readBody(request);
  const username = normalizeUsername(body.username);
  const passwordHash = String(body.passwordHash || '').trim();
  const user = await env.DB.prepare('SELECT id, username, password_hash, password_salt FROM users WHERE username = ?').bind(username).first();
  const expectedHash = user ? await hashPasswordCredential(passwordHash, user.password_salt || '') : '';
  if (!user || user.password_hash !== expectedHash) return json({ message: '用户名或密码不正确' }, { status: 401, origin });
  const session = await createSession(env, user);
  const meta = await env.DB.prepare('SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes FROM backups WHERE user_id = ?').bind(user.id).first();
  return json({ ...session, latestBackupMeta: meta || null }, { origin });
}

async function handleMeta(request, env, origin) {
  const user = await requireUser(request, env);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const meta = await env.DB.prepare('SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes, content_hash AS contentHash, last_end_id AS lastEndId, last_end_type AS lastEndType FROM backups WHERE user_id = ?').bind(user.id).first();
  return json(meta || { version: null, updatedAt: '', keyCount: 0, bytes: 0, contentHash: '', lastEndId: '', lastEndType: '' }, { origin });
}

async function archiveCurrentBackup(env, user, current) {
  if (!current || !Number.isSafeInteger(Number(current.version)) || Number(current.version) <= 0) return false;
  let encoded = String(current.envelope || '');
  if (!encoded && current.kvKey && env.SYNC_BACKUPS) {
    const stored = await env.SYNC_BACKUPS.get(current.kvKey);
    encoded = stored ? String(stored) : '';
  }
  if (!encoded) return false;
  await env.DB.prepare(`INSERT OR IGNORE INTO backup_versions
    (user_id, version, kv_key, updated_at, key_count, bytes, content_hash, envelope, cipher_sha256,
     last_end_id, last_end_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(user.id, Number(current.version), String(current.kvKey || `backup:${user.id}`), String(current.updatedAt || nowIso()),
      Number(current.keyCount) || 0, Number(current.bytes) || encoded.length, String(current.contentHash || ''), encoded,
      String(current.cipherSha256 || '') || await sha256Hex(encoded), String(current.lastEndId || ''), String(current.lastEndType || ''), nowIso()).run();
  return true;
}

function backupVersionSummary(row, currentVersion = null, source = 'history') {
  const version = Number(row?.version) || 0;
  return {
    version,
    updatedAt: String(row?.updatedAt || ''),
    keyCount: Number(row?.keyCount) || 0,
    bytes: Number(row?.bytes) || 0,
    contentHash: String(row?.contentHash || ''),
    current: currentVersion != null && version === Number(currentVersion),
    source
  };
}

async function handleGetBackupVersions(request, env, origin) {
  const user = await requireUser(request, env);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const requestedLimit = Number(new URL(request.url).searchParams.get('limit'));
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const current = await env.DB.prepare(`SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes,
    content_hash AS contentHash FROM backups WHERE user_id = ?`).bind(user.id).first();
  const history = await env.DB.prepare(`SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes,
    content_hash AS contentHash FROM backup_versions WHERE user_id = ? ORDER BY version DESC LIMIT ?`).bind(user.id, limit).all();
  const currentVersion = current ? Number(current.version) : null;
  const versions = new Map();
  for (const row of history?.results || []) versions.set(Number(row.version), backupVersionSummary(row, currentVersion));
  if (currentVersion != null && currentVersion > 0) versions.set(currentVersion, backupVersionSummary(current, currentVersion, 'current'));
  return json({ currentVersion, versions: [...versions.values()].sort((left, right) => right.version - left.version).slice(0, limit) }, { origin });
}

async function handleRollbackBackupVersion(request, env, origin) {
  const user = await requireUser(request, env);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const body = await readBody(request);
  const targetVersion = Number(body.version);
  const baseVersion = Number(body.baseVersion);
  if (!Number.isSafeInteger(targetVersion) || targetVersion <= 0) return json({ message: '缺少有效的目标版本', code: 'VERSION_REQUIRED' }, { status: 400, origin });
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) return json({ message: '缺少有效的当前版本', code: 'BASE_VERSION_REQUIRED' }, { status: 400, origin });
  const current = await env.DB.prepare(`SELECT version, kv_key AS kvKey, updated_at AS updatedAt, key_count AS keyCount, bytes,
    content_hash AS contentHash, envelope, cipher_sha256 AS cipherSha256, last_end_id AS lastEndId, last_end_type AS lastEndType
    FROM backups WHERE user_id = ?`).bind(user.id).first();
  const currentVersion = Number(current?.version) || 0;
  if (!current) return json({ message: '云端没有可回滚的备份', code: 'BACKUP_NOT_FOUND' }, { status: 404, origin });
  if (currentVersion !== baseVersion) return json({ message: '云端版本已变化，请刷新版本列表后再回滚', code: 'REVISION_MISMATCH', currentVersion }, { status: 409, origin });
  if (targetVersion === currentVersion) return json({ version: currentVersion, unchanged: true }, { origin });
  const target = await env.DB.prepare(`SELECT version, key_count AS keyCount, bytes, content_hash AS contentHash, envelope
    FROM backup_versions WHERE user_id = ? AND version = ?`).bind(user.id, targetVersion).first();
  if (!target?.envelope) return json({ message: '目标版本不存在或不可恢复', code: 'VERSION_NOT_FOUND' }, { status: 404, origin });
  let parsed;
  try { parsed = JSON.parse(String(target.envelope)); } catch { parsed = null; }
  if (!parsed?.ciphertext || parsed.source !== 'ai-dca-secure-sync' || !parsed.crypto) {
    return json({ message: '目标版本密文已损坏，无法回滚', code: 'VERSION_CORRUPTED' }, { status: 409, origin });
  }
  await archiveCurrentBackup(env, user, current);
  const maxVersion = await env.DB.prepare('SELECT MAX(version) AS maxVersion FROM backup_versions WHERE user_id = ?').bind(user.id).first();
  const version = Math.max(currentVersion, Number(maxVersion?.maxVersion) || 0) + 1;
  const encoded = String(target.envelope);
  const updatedAt = nowIso();
  await env.DB.prepare(`UPDATE backups SET version = ?, updated_at = ?, key_count = ?, bytes = ?, content_hash = ?,
    envelope = ?, cipher_sha256 = ?, last_end_id = ?, last_end_type = ? WHERE user_id = ? AND version = ?`)
    .bind(version, updatedAt, Number(target.keyCount) || Number(parsed?.meta?.keyCount) || 0, encoded.length,
      String(target.contentHash || parsed?.meta?.contentHash || ''), encoded, await sha256Hex(encoded), `rollback:v${targetVersion}`, 'version-rollback', user.id, baseVersion).run();
  try { await env.SYNC_BACKUPS.put(String(current.kvKey || `backup:${user.id}`), encoded); } catch { /* D1 是主存储，KV 仅作兼容镜像。 */ }
  return json({ version, updatedAt, rolledBackFrom: targetVersion, keyCount: Number(target.keyCount) || 0, bytes: encoded.length }, { origin });
}

async function handleGetLatest(request, env, origin) {
  const user = await requireUser(request, env);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const meta = await env.DB.prepare('SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes, kv_key AS kvKey, envelope, cipher_sha256 AS cipherSha256, content_hash AS contentHash, last_end_id AS lastEndId, last_end_type AS lastEndType FROM backups WHERE user_id = ?').bind(user.id).first();
  if (!meta) return json({ version: null, encryptedEnvelope: null }, { origin });
  let encoded = meta.envelope ? String(meta.envelope) : '';
  let backfilled = false;
  if (!encoded) {
    // 旧行：密文仅在 KV，回退读取并惰性回填进 D1（强一致主存储）。
    const legacy = await env.SYNC_BACKUPS.get(meta.kvKey);
    encoded = legacy ? String(legacy) : '';
    backfilled = Boolean(encoded);
  } else if (meta.cipherSha256) {
    // 校验 D1 内密文完整性：不一致绝不把坏 blob 发给端侧。
    const actual = await sha256Hex(encoded);
    if (actual !== String(meta.cipherSha256)) {
      return json({ message: '云端密文完整性校验失败，请重传备份', code: 'STORAGE_CORRUPTED' }, { status: 409, origin });
    }
  }
  if (!encoded) return json({ version: null, encryptedEnvelope: null }, { origin });
  let encryptedEnvelope = null;
  try {
    encryptedEnvelope = JSON.parse(encoded);
  } catch {
    return json({ message: '云端密文解析失败，请重传备份', code: 'STORAGE_CORRUPTED' }, { status: 409, origin });
  }
  if (backfilled) {
    // 旧 KV blob 回填进 D1 主存储，不改版本，幂等。
    const cipherSha = await sha256Hex(encoded);
    try {
      await env.DB.prepare('UPDATE backups SET envelope = ?, cipher_sha256 = ? WHERE user_id = ?')
        .bind(encoded, cipherSha, user.id).run();
    } catch {
      // 回填失败不影响本次读取。
    }
  }
  return json({
    version: meta.version,
    updatedAt: meta.updatedAt,
    keyCount: meta.keyCount,
    bytes: meta.bytes,
    kvKey: meta.kvKey,
    contentHash: meta.contentHash || '',
    lastEndId: meta.lastEndId || '',
    lastEndType: meta.lastEndType || '',
    encryptedEnvelope
  }, { origin });
}

async function handlePutLatest(request, env, origin) {
  const user = await requireUser(request, env);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const body = await readBody(request);
  const encryptedEnvelope = body.encryptedEnvelope || {};
  if (!encryptedEnvelope.ciphertext || encryptedEnvelope.source !== 'ai-dca-secure-sync') {
    return json({ message: '密文备份格式不合法' }, { status: 400, origin });
  }
  const current = await env.DB.prepare('SELECT version, kv_key AS kvKey, updated_at AS updatedAt, key_count AS keyCount, bytes, content_hash AS contentHash, envelope, cipher_sha256 AS cipherSha256, last_end_id AS lastEndId, last_end_type AS lastEndType FROM backups WHERE user_id = ?').bind(user.id).first();
  const incomingHash = String(encryptedEnvelope?.meta?.contentHash || '');
  // 内容未变化：保持版本号不变，不重写 KV，不报冲突。
  if (current && incomingHash && incomingHash === String(current.contentHash || '')) {
    return json({
      version: Number(current.version),
      updatedAt: current.updatedAt,
      keyCount: Number(current.keyCount) || 0,
      bytes: Number(current.bytes) || 0,
      unchanged: true
    }, { origin });
  }
  // 端标识（登录账号粒度）：username 相同则连续修改只覆盖、不涨版本；不同账号才涨版本。
  const end = body.end && typeof body.end === 'object' ? body.end : {};
  const endId = String(end.id || '').slice(0, 80);
  const endType = String(end.type || '').slice(0, 40);
  const sameEnd = Boolean(current && endId && endId === String(current.lastEndId || ''));
  const baseVersion = body.baseVersion == null ? null : Number(body.baseVersion);
  // 乐观锁仅用于跨账号并发：同端连续写入直接覆盖，不做 baseVersion 校验。
  if (current && !sameEnd && baseVersion !== null && Number(current.version) !== baseVersion) {
    return json({ message: '云端数据已更新，请先处理冲突', currentVersion: current.version }, { status: 409, origin });
  }
  const version = current ? (sameEnd ? Number(current.version) : Number(current.version) + 1) : 1;
  const kvKey = current?.kvKey || `backup:${user.id}`;
  const encoded = JSON.stringify(encryptedEnvelope);
  const cipherSha = await sha256Hex(encoded);
  const updatedAt = nowIso();
  const keyCount = Number(encryptedEnvelope?.meta?.keyCount) || 0;
  // 强一致主存储：密文 BLOB + 完整性校验和 + 版本元数据写入同一 D1 行（单次原子写）。
  if (current) {
    await archiveCurrentBackup(env, user, current);
    await env.DB.prepare('UPDATE backups SET version = ?, updated_at = ?, key_count = ?, bytes = ?, content_hash = ?, envelope = ?, cipher_sha256 = ?, last_end_id = ?, last_end_type = ? WHERE user_id = ?')
      .bind(version, updatedAt, keyCount, encoded.length, incomingHash, encoded, cipherSha, endId, endType, user.id).run();
  } else {
    await env.DB.prepare('INSERT INTO backups (user_id, version, kv_key, updated_at, key_count, bytes, content_hash, envelope, cipher_sha256, last_end_id, last_end_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(user.id, version, kvKey, updatedAt, keyCount, encoded.length, incomingHash, encoded, cipherSha, endId, endType).run();
  }
  // KV 镜像仅为旧 Worker 回滚兼容（尽力而为，不阻塞、不影响一致性）。
  try {
    await env.SYNC_BACKUPS.put(kvKey, encoded);
  } catch {
    // 镜像失败不影响主存储一致性。
  }
  return json({ version, updatedAt, keyCount, bytes: encoded.length, contentHash: incomingHash, lastEndId: endId, lastEndType: endType, sameEnd }, { origin });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '*';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/sync/internal/sync-backup') return handleInternalSyncBackup(request, env, origin, () => ensureSchema(env));
    await ensureSchema(env);
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/api/sync/analytics/track') return handleTrackAnalytics(request, env, origin);
      if (request.method === 'GET' && url.pathname === '/api/sync/analytics/guests') return handleAnalyticsGuests(request, env, origin);
      if (request.method === 'POST' && url.pathname === '/api/sync/auth/register') return handleRegister(request, env, origin);
      if (request.method === 'POST' && url.pathname === '/api/sync/auth/login') return handleLogin(request, env, origin);
      if (request.method === 'POST' && url.pathname === '/api/sync/internal/sync-auth') return handleInternalAuthSync(request, env, origin);
      if (request.method === 'GET' && url.pathname === '/api/sync/meta') return handleMeta(request, env, origin);
      if (request.method === 'GET' && url.pathname === '/api/sync/versions') return handleGetBackupVersions(request, env, origin);
      if (request.method === 'POST' && url.pathname === '/api/sync/versions/rollback') return handleRollbackBackupVersion(request, env, origin);
      if (request.method === 'GET' && url.pathname === '/api/sync/latest') return handleGetLatest(request, env, origin);
      if (request.method === 'PUT' && url.pathname === '/api/sync/latest') return handlePutLatest(request, env, origin);
      if (request.method === 'GET' && (url.pathname === '/probe' || url.pathname === '/api/sync/probe')) {
        return new Response(PROBE_HTML, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'access-control-allow-origin': origin,
            'cache-control': 'public, max-age=300'
          }
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/sync/health') return json({ ok: true, service: 'sync', at: nowIso() }, { origin });
      return json({ message: 'not found' }, { status: 404, origin });
    } catch (err) {
      return json({ message: err?.message || 'server error' }, { status: 500, origin });
    }
  },
  async scheduled(controller, env) {
    try {
      await ensureSchema(env);
      const result = await pruneOldAnalyticsEvents(env, Number(controller?.scheduledTime) || Date.now());
      console.log('[sync] analytics retention cleanup', JSON.stringify(result));
    } catch (error) {
      console.log('[sync] analytics retention cleanup failed', JSON.stringify({
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  }
};
