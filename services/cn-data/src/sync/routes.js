import { randomBytes } from 'node:crypto';
import { resolveUser, openAuthDb } from '../authSession.js';
import { sha256Hex } from '../account/store.js';
import { nowIso, withTransaction } from '../db.js';

// Worker payloads are preserved; SQLite is the primary storage on CN.
const json = (body, { status = 200, origin = '*' } = {}) => ({
  status, body, headers: { 'Access-Control-Allow-Origin': origin }
});
const readBody = (request) => request.body;
const randomId = (prefix = '') => prefix + randomBytes(16).toString('hex');
const normalizeUsername = (username = '') => String(username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 48);
function requireUser(request) {
  try {
    const id = resolveUser(request.rawHeaders, request.urlObject, request.body);
    const auth = openAuthDb();
    if (!auth) return { id, username: '' };
    try {
      const row = auth.prepare('SELECT username FROM users WHERE id = ?').get(id);
      return { id, username: String(row?.username || '') };
    } finally { auth.close(); }
  } catch (error) {
    if ([400, 401, 403].includes(error.status)) return null;
    throw error;
  }
}
function registeredUsers() {
  const auth = openAuthDb();
  if (!auth) return { total: 0 };
  try { return auth.prepare('SELECT COUNT(*) AS total FROM users').get(); }
  finally { auth.close(); }
}
const PROBE_HTML = "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n  <title>网络连通性诊断 · 美股策略助手</title>\n  <style>\n    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n    body {\n      font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif;\n      background: #f8fafc;\n      color: #0f172a;\n      line-height: 1.5;\n      padding: 16px;\n      min-height: 100vh;\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: flex-start;\n    }\n    .container {\n      width: 100%;\n      max-width: 680px;\n      margin-top: 24px;\n      margin-bottom: 40px;\n    }\n    .card {\n      background: #ffffff;\n      border: 1px solid #e2e8f0;\n      border-radius: 20px;\n      padding: 24px;\n      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.03);\n      margin-bottom: 16px;\n    }\n    .header {\n      text-align: center;\n      margin-bottom: 24px;\n    }\n    .badge-top {\n      display: inline-flex;\n      align-items: center;\n      gap: 6px;\n      padding: 4px 12px;\n      border-radius: 9999px;\n      font-size: 12px;\n      font-weight: 600;\n      background: #eef2ff;\n      color: #4f46e5;\n      margin-bottom: 8px;\n    }\n    h1 {\n      font-size: 22px;\n      font-weight: 800;\n      color: #0f172a;\n      margin-bottom: 6px;\n    }\n    p.subtitle {\n      font-size: 13px;\n      color: #64748b;\n    }\n    .status-banner {\n      border-radius: 16px;\n      padding: 18px;\n      display: flex;\n      align-items: flex-start;\n      gap: 14px;\n      margin-bottom: 20px;\n      transition: all 0.3s ease;\n    }\n    .status-banner.loading {\n      background: #f1f5f9;\n      border: 1px solid #cbd5e1;\n      color: #334155;\n    }\n    .status-banner.success {\n      background: #ecfdf5;\n      border: 1px solid #a7f3d0;\n      color: #065f46;\n    }\n    .status-banner.failed {\n      background: #fff1f2;\n      border: 1px solid #fecdd3;\n      color: #9f1239;\n    }\n    .status-icon {\n      font-size: 26px;\n      line-height: 1;\n      flex-shrink: 0;\n    }\n    .status-title {\n      font-size: 16px;\n      font-weight: 700;\n      margin-bottom: 4px;\n    }\n    .status-desc {\n      font-size: 13px;\n      opacity: 0.9;\n      line-height: 1.5;\n    }\n    .grid-info {\n      display: grid;\n      grid-template-columns: repeat(2, 1fr);\n      gap: 12px;\n      margin-bottom: 20px;\n    }\n    @media (max-width: 520px) {\n      .grid-info { grid-template-columns: 1fr; }\n    }\n    .info-item {\n      background: #f8fafc;\n      border: 1px solid #f1f5f9;\n      border-radius: 12px;\n      padding: 12px 14px;\n    }\n    .info-label {\n      font-size: 11px;\n      font-weight: 600;\n      color: #94a3b8;\n      text-transform: uppercase;\n      letter-spacing: 0.5px;\n      margin-bottom: 3px;\n    }\n    .info-value {\n      font-size: 14px;\n      font-weight: 700;\n      color: #1e293b;\n      word-break: break-all;\n    }\n    .info-value.mono {\n      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;\n    }\n    .btn-group {\n      display: flex;\n      flex-wrap: wrap;\n      gap: 10px;\n    }\n    button, a.btn {\n      display: inline-flex;\n      align-items: center;\n      justify-content: center;\n      gap: 8px;\n      border-radius: 9999px;\n      font-size: 13px;\n      font-weight: 700;\n      padding: 10px 18px;\n      cursor: pointer;\n      text-decoration: none;\n      transition: all 0.15s ease;\n      border: none;\n    }\n    .btn-primary {\n      background: #4f46e5;\n      color: #ffffff;\n      flex: 1;\n      min-width: 140px;\n    }\n    .btn-primary:hover { background: #4338ca; }\n    .btn-secondary {\n      background: #f1f5f9;\n      color: #334155;\n    }\n    .btn-secondary:hover { background: #e2e8f0; }\n    .btn-success {\n      background: #10b981;\n      color: #ffffff;\n      flex: 1;\n      min-width: 140px;\n    }\n    .btn-success:hover { background: #059669; }\n    .solution-box {\n      margin-top: 16px;\n      background: #fffbeb;\n      border: 1px solid #fef3c7;\n      border-radius: 14px;\n      padding: 14px 16px;\n      font-size: 13px;\n      color: #92400e;\n    }\n    .solution-title {\n      font-weight: 700;\n      margin-bottom: 6px;\n      display: flex;\n      align-items: center;\n      gap: 6px;\n    }\n    .solution-box ol {\n      margin-left: 20px;\n      line-height: 1.6;\n    }\n    .toast {\n      position: fixed;\n      bottom: 24px;\n      left: 50%;\n      transform: translateX(-50%) translateY(100px);\n      background: #0f172a;\n      color: #ffffff;\n      padding: 10px 20px;\n      border-radius: 9999px;\n      font-size: 13px;\n      font-weight: 600;\n      opacity: 0;\n      transition: all 0.25s ease;\n      pointer-events: none;\n      z-index: 1000;\n    }\n    .toast.show {\n      transform: translateX(-50%) translateY(0);\n      opacity: 1;\n    }\n    .footer-note {\n      text-align: center;\n      font-size: 12px;\n      color: #94a3b8;\n      margin-top: 16px;\n    }\n    .spinner {\n      display: inline-block;\n      width: 14px;\n      height: 14px;\n      border: 2px solid rgba(255, 255, 255, 0.3);\n      border-radius: 50%;\n      border-top-color: currentColor;\n      animation: spin 0.8s linear infinite;\n    }\n    @keyframes spin {\n      to { transform: rotate(360deg); }\n    }\n  </style>\n</head>\n<body>\n  <div class=\"container\">\n    <div class=\"header\">\n      <div class=\"badge-top\">🌐 网络连通探活诊断工具</div>\n      <h1>美股策略助手 · 连接检测</h1>\n      <p class=\"subtitle\">自动排查当前网络与 CN 国内专线 (5000 端口) 的可达性与阻断原因</p>\n    </div>\n\n    <div class=\"card\">\n      <div id=\"statusBanner\" class=\"status-banner loading\">\n        <div class=\"status-icon\" id=\"statusIcon\">⏳</div>\n        <div>\n          <div class=\"status-title\" id=\"statusTitle\">正在探测网络环境…</div>\n          <div class=\"status-desc\" id=\"statusDesc\">正在连接 Cloudflare 边缘节点并测试 cn.freebacktrack.tech:5000 可达性，请稍候约 2~3 秒。</div>\n        </div>\n      </div>\n\n      <div class=\"grid-info\">\n        <div class=\"info-item\">\n          <div class=\"info-label\">您的公网 IP 地址</div>\n          <div class=\"info-value mono\" id=\"infoIp\">检测中…</div>\n        </div>\n        <div class=\"info-item\">\n          <div class=\"info-label\">网络接入节点 / 地区</div>\n          <div class=\"info-value\" id=\"infoColo\">检测中…</div>\n        </div>\n        <div class=\"info-item\">\n          <div class=\"info-label\">CN 专线 (5000 端口) 连通性</div>\n          <div class=\"info-value\" id=\"infoCnStatus\">探测中…</div>\n        </div>\n        <div class=\"info-item\">\n          <div class=\"info-label\">全球通用专线 (443 端口)</div>\n          <div class=\"info-value\" id=\"infoGlobalStatus\">探测中…</div>\n        </div>\n      </div>\n\n      <div id=\"solutionBox\" class=\"solution-box\" style=\"display: none;\">\n        <div class=\"solution-title\">💡 诊断结论与解决建议</div>\n        <div id=\"solutionContent\"></div>\n      </div>\n\n      <div style=\"margin-top: 20px;\" class=\"btn-group\">\n        <button type=\"button\" class=\"btn-primary\" id=\"btnRetest\" onclick=\"runDiagnosis()\">\n          🔄 重新测速\n        </button>\n        <button type=\"button\" class=\"btn-secondary\" id=\"btnCopyReport\" onclick=\"copyDiagnosticReport()\">\n          📋 复制诊断报告\n        </button>\n        <a href=\"https://freebacktrack.tech\" target=\"_blank\" class=\"btn btn-secondary\" id=\"btnGlobalAccess\">\n          🌐 访问全球 443 专线\n        </a>\n      </div>\n    </div>\n\n    <div class=\"footer-note\">\n      美股策略助手 · 诊断信息已加密上报，用于协助定位区域网络故障\n    </div>\n  </div>\n\n  <div id=\"toast\" class=\"toast\"></div>\n\n  <script>\n    const CF_COLO_NAMES = {\n      SJW: '中国华北·石家庄 (北京接入)',\n      PEK: '中国华北·北京',\n      PKX: '中国华北·北京大兴',\n      TSN: '中国华北·天津',\n      TYN: '中国华北·太原',\n      HET: '中国华北·呼和浩特',\n      SHA: '中国华东·上海',\n      PVG: '中国华东·上海浦东',\n      HGH: '中国华东·杭州',\n      NKG: '中国华东·南京',\n      SZV: '中国华东·苏州',\n      WNZ: '中国华东·温州',\n      NGB: '中国华东·宁波',\n      HFE: '中国华东·合肥',\n      FOC: '中国华东·福州',\n      XMN: '中国华东·厦门',\n      TAO: '中国华东·青岛',\n      TNA: '中国华东·济南',\n      CAN: '中国华南·广州',\n      SZX: '中国华南·深圳',\n      ZHA: '中国华南·湛江',\n      NNG: '中国华南·南宁',\n      HAK: '中国华南·海口',\n      WUH: '中国华中·武汉',\n      CSX: '中国华中·长沙',\n      CGO: '中国华中·郑州',\n      CTU: '中国西南·成都',\n      TFU: '中国西南·成都天府',\n      CKG: '中国西南·重庆',\n      KMG: '中国西南·昆明',\n      KWE: '中国西南·贵阳',\n      XIY: '中国西北·西安',\n      LHW: '中国西北·兰州',\n      XNN: '中国西北·西宁',\n      URC: '中国西北·乌鲁木齐',\n      SHE: '中国东北·沈阳',\n      DLC: '中国东北·大连',\n      CGQ: '中国东北·长春',\n      HRB: '中国东北·哈尔滨',\n      HKG: '中国香港',\n      MFM: '中国澳门',\n      TPE: '中国台湾·台北',\n      SIN: '新加坡',\n      NRT: '日本·东京',\n      ICN: '韩国·首尔'\n    };\n\n    let latestReport = null;\n\n    function showToast(msg) {\n      const t = document.getElementById('toast');\n      t.textContent = msg;\n      t.classList.add('show');\n      setTimeout(() => t.classList.remove('show'), 2500);\n    }\n\n    function parseTrace(text) {\n      const data = {};\n      (text || '').split('\\n').forEach(line => {\n        const idx = line.indexOf('=');\n        if (idx > 0) data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();\n      });\n      return data;\n    }\n\n    async function fetchCfTrace() {\n      const endpoints = [\n        'https://freebacktrack.tech/cdn-cgi/trace',\n        'https://www.cloudflare-cn.com/cdn-cgi/trace',\n        'https://cloudflare-dns.com/cdn-cgi/trace'\n      ];\n      for (const ep of endpoints) {\n        try {\n          const res = await fetch(ep, { cache: 'no-store', signal: AbortSignal.timeout(3500) });\n          if (res.ok) {\n            const text = await res.text();\n            const p = parseTrace(text);\n            if (p.ip || p.colo) return p;\n          }\n        } catch {}\n      }\n      return {};\n    }\n\n    async function probeCnTarget() {\n      const isCnHost = window.location.host.includes('cn.freebacktrack.tech');\n      const url = isCnHost\n        ? `/api/market-collector/health?probe=${Date.now()}`\n        : `https://cn.freebacktrack.tech:5000/api/market-collector/health?probe=${Date.now()}`;\n      const t0 = performance.now();\n      try {\n        await fetch(url, {\n          method: 'GET',\n          mode: isCnHost ? 'cors' : 'no-cors',\n          cache: 'no-store',\n          signal: AbortSignal.timeout(5000)\n        });\n        const latency = Math.max(1, Math.round(performance.now() - t0));\n        return { ok: true, latency, error: '' };\n      } catch (err) {\n        const latency = Math.max(1, Math.round(performance.now() - t0));\n        const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';\n        return {\n          ok: false,\n          latency,\n          error: isTimeout ? '连接超时 (>5s)' : '5000端口受阻或网络拒绝'\n        };\n      }\n    }\n\n    async function probeGlobalTarget() {\n      const t0 = performance.now();\n      try {\n        await fetch('https://freebacktrack.tech/cdn-cgi/trace', {\n          cache: 'no-store',\n          signal: AbortSignal.timeout(4000)\n        });\n        return { ok: true, latency: Math.max(1, Math.round(performance.now() - t0)) };\n      } catch {\n        return { ok: false, latency: 0 };\n      }\n    }\n\n    async function reportToAnalytics(report) {\n      try {\n        const payload = {\n          type: 'network_trace',\n          meta: {\n            source: 'standalone_probe_page',\n            ip: report.ip,\n            loc: report.loc,\n            colo: report.colo,\n            coloRegion: report.coloRegion,\n            cnStatus: report.cnOk ? 'ok' : 'failed',\n            cnReachable: report.cnOk,\n            cnLatency: report.cnLatency,\n            cnError: report.cnError,\n            globalOk: report.globalOk,\n            userAgent: navigator.userAgent\n          }\n        };\n        const apiUrl = '/api/sync/analytics/track';\n        fetch(apiUrl, {\n          method: 'POST',\n          headers: { 'Content-Type': 'application/json' },\n          body: JSON.stringify(payload)\n        }).catch(() => {});\n      } catch {}\n    }\n\n    async function runDiagnosis() {\n      const banner = document.getElementById('statusBanner');\n      const icon = document.getElementById('statusIcon');\n      const title = document.getElementById('statusTitle');\n      const desc = document.getElementById('statusDesc');\n      const btn = document.getElementById('btnRetest');\n      const solutionBox = document.getElementById('solutionBox');\n      const solutionContent = document.getElementById('solutionContent');\n\n      btn.disabled = true;\n      btn.innerHTML = '<span class=\"spinner\"></span> 测速中…';\n\n      banner.className = 'status-banner loading';\n      icon.textContent = '⏳';\n      title.textContent = '正在探测网络环境…';\n      desc.textContent = '正在排查您的 IP、Cloudflare 接入边缘以及 5000 端口连通性…';\n\n      document.getElementById('infoIp').textContent = '获取中…';\n      document.getElementById('infoColo').textContent = '检测中…';\n      document.getElementById('infoCnStatus').textContent = '探测中…';\n      document.getElementById('infoGlobalStatus').textContent = '探测中…';\n      solutionBox.style.display = 'none';\n\n      const [cf, cnProbe, globalProbe] = await Promise.all([\n        fetchCfTrace(),\n        probeCnTarget(),\n        probeGlobalTarget()\n      ]);\n\n      const ip = cf.ip || '未能获取';\n      const loc = cf.loc || 'CN';\n      const colo = (cf.colo || '未知').toUpperCase();\n      const coloRegion = CF_COLO_NAMES[colo] || (loc === 'CN' ? `中国·节点 (${colo})` : `${loc}·${colo}`);\n\n      document.getElementById('infoIp').textContent = ip;\n      document.getElementById('infoColo').textContent = `${colo} · ${coloRegion}`;\n\n      if (cnProbe.ok) {\n        document.getElementById('infoCnStatus').innerHTML = `<span style=\"color: #10b981; font-weight: bold;\">🟢 正常 (${cnProbe.latency}ms)</span>`;\n      } else {\n        document.getElementById('infoCnStatus').innerHTML = `<span style=\"color: #e11d48; font-weight: bold;\">🔴 受阻 (${cnProbe.error})</span>`;\n      }\n\n      if (globalProbe.ok) {\n        document.getElementById('infoGlobalStatus').innerHTML = `<span style=\"color: #10b981; font-weight: bold;\">🟢 正常 (${globalProbe.latency}ms)</span>`;\n      } else {\n        document.getElementById('infoGlobalStatus').innerHTML = `<span style=\"color: #f59e0b; font-weight: bold;\">🟡 异常/未连通</span>`;\n      }\n\n      latestReport = {\n        time: new Date().toLocaleString(),\n        ip,\n        loc,\n        colo,\n        coloRegion,\n        cnOk: cnProbe.ok,\n        cnLatency: cnProbe.latency,\n        cnError: cnProbe.error,\n        globalOk: globalProbe.ok,\n        globalLatency: globalProbe.latency\n      };\n\n      reportToAnalytics(latestReport);\n\n      if (cnProbe.ok) {\n        banner.className = 'status-banner success';\n        icon.textContent = '✅';\n        title.textContent = 'CN 专线连通良好，可以正常访问！';\n        desc.textContent = `当前网络与国内服务器（cn.freebacktrack.tech:5000）连接正常，响应延迟为 ${cnProbe.latency}ms。`;\n        solutionBox.style.display = 'none';\n      } else if (globalProbe.ok && !cnProbe.ok) {\n        banner.className = 'status-banner failed';\n        icon.textContent = '🚫';\n        title.textContent = '检测到 5000 端口受阻，无法打开 CN 页面';\n        desc.textContent = `您的互联网连接完全正常，但您当前所在网络阻断了非标 5000 端口（${cnProbe.error}）。`;\n        solutionBox.style.display = 'block';\n        solutionContent.innerHTML = `\n          <p style=\"margin-bottom: 8px;\"><strong>阻断原因：</strong>国内部分企业内网、校园网或宽带运营商（移动/长宽/广电等）防火墙默认只放行 80 和 443 端口，导致无法直连 <code>cn.freebacktrack.tech:5000</code>。</p>\n          <ol>\n            <li><strong>快速方案（强烈推荐）：</strong>直接点击下方按钮切换到<strong>「全球通用 443 专线」</strong>，走标准 443 端口，不受任何运营商端口拦截影响。</li>\n            <li><strong>切换网络：</strong>将电脑或手机切换到电信/联通网络或使用<strong>手机 5G 热点</strong>后，点击上方「重新测速」重试。</li>\n            <li><strong>反馈管理员：</strong>点击下方「复制诊断报告」，将报告发送至群内或管理员。</li>\n          </ol>\n        `;\n      } else {\n        banner.className = 'status-banner failed';\n        icon.textContent = '⚠️';\n        title.textContent = '本地网络异常或完全无法连接';\n        desc.textContent = '未能检测到有效的公网互联网连接，请先检查您的 Wi-Fi 或蜂窝移动网络。';\n        solutionBox.style.display = 'none';\n      }\n\n      btn.disabled = false;\n      btn.innerHTML = '🔄 重新测速';\n    }\n\n    function copyDiagnosticReport() {\n      if (!latestReport) {\n        showToast('请等待测速完成后再复制');\n        return;\n      }\n      const text = [\n        '【美股策略助手 · 网络连通诊断报告】',\n        `探测时间: ${latestReport.time}`,\n        `客户端IP: ${latestReport.ip}`,\n        `接入节点: ${latestReport.colo} (${latestReport.coloRegion})`,\n        `地理国家: ${latestReport.loc}`,\n        `CN专线(5000): ${latestReport.cnOk ? `正常 (${latestReport.cnLatency}ms)` : `受阻 (${latestReport.cnError})`}`,\n        `全球专线(443): ${latestReport.globalOk ? `正常 (${latestReport.globalLatency}ms)` : '受阻'}`,\n        `浏览器UA: ${navigator.userAgent}`\n      ].join('\\n');\n\n      if (navigator.clipboard && navigator.clipboard.writeText) {\n        navigator.clipboard.writeText(text).then(() => {\n          showToast('✅ 诊断报告已复制到剪贴板！');\n        }).catch(() => {\n          prompt('请复制以下诊断报告：', text);\n        });\n      } else {\n        prompt('请复制以下诊断报告：', text);\n      }\n    }\n\n    window.addEventListener('DOMContentLoaded', runDiagnosis);\n  </script>\n</body>\n</html>\n";
function analyticsEventIdentity(event = {}) {
  return String(event.userId || event.visitorId || '').trim();
}

function updateDailyAnalyticsAggregate(db, events = []) {
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
  for (const [date, stats] of dailyStats) {
    db.prepare(`INSERT INTO analytics_daily_stats (event_date, pv, switch_runs) VALUES (?, ?, ?)
      ON CONFLICT(event_date) DO UPDATE SET pv = pv + excluded.pv, switch_runs = switch_runs + excluded.switch_runs`).run(date, stats.pv, stats.switchRuns);
  }
  for (const user of dailyUsers.values()) {
    db.prepare(`INSERT INTO analytics_daily_users (event_date, identity, is_visitor_only, has_page_view, has_page_engagement) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_date, identity) DO UPDATE SET
        is_visitor_only = MAX(is_visitor_only, excluded.is_visitor_only),
        has_page_view = MAX(has_page_view, excluded.has_page_view),
        has_page_engagement = MAX(has_page_engagement, excluded.has_page_engagement)
    `).run(user.date, user.identity, user.isVisitorOnly, user.hasPageView, user.hasPageEngagement);
  }
}


function handleTrackAnalytics(request, db, origin) {
  const body = readBody(request);
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
      if (!meta.colo) meta.colo = request.headers.get('cf-colo') || '';
      if (!meta.loc) meta.loc = request.headers.get('cf-country') || '';
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
    const result = db.prepare(`INSERT OR IGNORE INTO analytics_events
      (id, type, user_id, username, visitor_id, session_id, path, event_date, created_at, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
      );
    accepted += 1;
    if (result?.changes === 0) continue;
    acceptedEvents.push(normalizedEvent);
  }
  if (!accepted) return json({ message: 'missing event type' }, { status: 400, origin });
  if (acceptedEvents.length) updateDailyAnalyticsAggregate(db, acceptedEvents);
  return json({ ok: true, accepted }, { origin });
}

function handleMeta(request, db, origin) {
  const user = requireUser(request);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const meta = db.prepare('SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes, content_hash AS contentHash, last_end_id AS lastEndId, last_end_type AS lastEndType FROM backups WHERE user_id = ?').get(user.id);
  return json(meta || { version: null, updatedAt: '', keyCount: 0, bytes: 0, contentHash: '', lastEndId: '', lastEndType: '' }, { origin });
}

function archiveCurrentBackup(db, user, current) {
  if (!current || !Number.isSafeInteger(Number(current.version)) || Number(current.version) <= 0) return false;
  const encoded = String(current.envelope || '');
  if (!encoded) return false;
  db.prepare(`INSERT OR IGNORE INTO backup_versions
    (user_id, version, kv_key, updated_at, key_count, bytes, content_hash, envelope, cipher_sha256,
     last_end_id, last_end_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, Number(current.version), String(current.kvKey || `backup:${user.id}`), String(current.updatedAt || nowIso()),
      Number(current.keyCount) || 0, Number(current.bytes) || encoded.length, String(current.contentHash || ''), encoded,
      String(current.cipherSha256 || '') || sha256Hex(encoded), String(current.lastEndId || ''), String(current.lastEndType || ''), nowIso());
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

function handleGetBackupVersions(request, db, origin) {
  const user = requireUser(request);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const requestedLimit = Number(new URL(request.url).searchParams.get('limit'));
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const current = db.prepare(`SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes,
    content_hash AS contentHash FROM backups WHERE user_id = ?`).get(user.id);
  const history = db.prepare(`SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes,
    content_hash AS contentHash FROM backup_versions WHERE user_id = ? ORDER BY version DESC LIMIT ?`).all(user.id, limit);
  const currentVersion = current ? Number(current.version) : null;
  const versions = new Map();
  for (const row of history || []) versions.set(Number(row.version), backupVersionSummary(row, currentVersion));
  if (currentVersion != null && currentVersion > 0) versions.set(currentVersion, backupVersionSummary(current, currentVersion, 'current'));
  return json({ currentVersion, versions: [...versions.values()].sort((left, right) => right.version - left.version).slice(0, limit) }, { origin });
}

function handleRollbackBackupVersion(request, db, origin) {
  const user = requireUser(request);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const body = readBody(request);
  const targetVersion = Number(body.version);
  const baseVersion = Number(body.baseVersion);
  if (!Number.isSafeInteger(targetVersion) || targetVersion <= 0) return json({ message: '缺少有效的目标版本', code: 'VERSION_REQUIRED' }, { status: 400, origin });
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) return json({ message: '缺少有效的当前版本', code: 'BASE_VERSION_REQUIRED' }, { status: 400, origin });
  const current = db.prepare(`SELECT version, kv_key AS kvKey, updated_at AS updatedAt, key_count AS keyCount, bytes,
    content_hash AS contentHash, envelope, cipher_sha256 AS cipherSha256, last_end_id AS lastEndId, last_end_type AS lastEndType
    FROM backups WHERE user_id = ?`).get(user.id);
  const currentVersion = Number(current?.version) || 0;
  if (!current) return json({ message: '云端没有可回滚的备份', code: 'BACKUP_NOT_FOUND' }, { status: 404, origin });
  if (currentVersion !== baseVersion) return json({ message: '云端版本已变化，请刷新版本列表后再回滚', code: 'REVISION_MISMATCH', currentVersion }, { status: 409, origin });
  if (targetVersion === currentVersion) return json({ version: currentVersion, unchanged: true }, { origin });
  const target = db.prepare(`SELECT version, key_count AS keyCount, bytes, content_hash AS contentHash, envelope
    FROM backup_versions WHERE user_id = ? AND version = ?`).get(user.id, targetVersion);
  if (!target?.envelope) return json({ message: '目标版本不存在或不可恢复', code: 'VERSION_NOT_FOUND' }, { status: 404, origin });
  let parsed;
  try { parsed = JSON.parse(String(target.envelope)); } catch { parsed = null; }
  if (!parsed?.ciphertext || parsed.source !== 'ai-dca-secure-sync' || !parsed.crypto) {
    return json({ message: '目标版本密文已损坏，无法回滚', code: 'VERSION_CORRUPTED' }, { status: 409, origin });
  }
  archiveCurrentBackup(db, user, current);
  const maxVersion = db.prepare('SELECT MAX(version) AS maxVersion FROM backup_versions WHERE user_id = ?').get(user.id);
  const version = Math.max(currentVersion, Number(maxVersion?.maxVersion) || 0) + 1;
  const encoded = String(target.envelope);
  const updatedAt = nowIso();
  db.prepare(`UPDATE backups SET version = ?, updated_at = ?, key_count = ?, bytes = ?, content_hash = ?,
    envelope = ?, cipher_sha256 = ?, last_end_id = ?, last_end_type = ? WHERE user_id = ? AND version = ?`)
    .run(version, updatedAt, Number(target.keyCount) || Number(parsed?.meta?.keyCount) || 0, encoded.length,
      String(target.contentHash || parsed?.meta?.contentHash || ''), encoded, sha256Hex(encoded), `rollback:v${targetVersion}`, 'version-rollback', user.id, baseVersion);
  return json({ version, updatedAt, rolledBackFrom: targetVersion, keyCount: Number(target.keyCount) || 0, bytes: encoded.length }, { origin });
}

function handleGetLatest(request, db, origin) {
  const user = requireUser(request);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const meta = db.prepare('SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes, kv_key AS kvKey, envelope, cipher_sha256 AS cipherSha256, content_hash AS contentHash, last_end_id AS lastEndId, last_end_type AS lastEndType FROM backups WHERE user_id = ?').get(user.id);
  if (!meta) return json({ version: null, encryptedEnvelope: null }, { origin });
  const encoded = meta.envelope ? String(meta.envelope) : '';
  if (encoded && meta.cipherSha256) {
    // 校验 SQLite 内密文完整性：不一致绝不把坏 blob 发给端侧。
    const actual = sha256Hex(encoded);
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

function handlePutLatest(request, db, origin) {
  const user = requireUser(request);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const body = readBody(request);
  const encryptedEnvelope = body.encryptedEnvelope || {};
  if (!encryptedEnvelope.ciphertext || encryptedEnvelope.source !== 'ai-dca-secure-sync') {
    return json({ message: '密文备份格式不合法' }, { status: 400, origin });
  }
  const current = db.prepare('SELECT version, kv_key AS kvKey, updated_at AS updatedAt, key_count AS keyCount, bytes, content_hash AS contentHash, envelope, cipher_sha256 AS cipherSha256, last_end_id AS lastEndId, last_end_type AS lastEndType FROM backups WHERE user_id = ?').get(user.id);
  const incomingHash = String(encryptedEnvelope?.meta?.contentHash || '');
  // 内容未变化：保持版本号不变，不重写存储，不报冲突。
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
  const cipherSha = sha256Hex(encoded);
  const updatedAt = nowIso();
  const keyCount = Number(encryptedEnvelope?.meta?.keyCount) || 0;
  // 强一致主存储：密文 BLOB + 完整性校验和 + 版本元数据写入同一 SQLite 行（单次原子写）。
  if (current) {
    archiveCurrentBackup(db, user, current);
    db.prepare('UPDATE backups SET version = ?, updated_at = ?, key_count = ?, bytes = ?, content_hash = ?, envelope = ?, cipher_sha256 = ?, last_end_id = ?, last_end_type = ? WHERE user_id = ?')
      .run(version, updatedAt, keyCount, encoded.length, incomingHash, encoded, cipherSha, endId, endType, user.id);
  } else {
    db.prepare('INSERT INTO backups (user_id, version, kv_key, updated_at, key_count, bytes, content_hash, envelope, cipher_sha256, last_end_id, last_end_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, version, kvKey, updatedAt, keyCount, encoded.length, incomingHash, encoded, cipherSha, endId, endType);
  }
  return json({ version, updatedAt, keyCount, bytes: encoded.length, contentHash: incomingHash, lastEndId: endId, lastEndType: endType, sameEnd }, { origin });
}


export function handleSyncRoute(db, method, url, body, headers = {}) {
  const routes = {
    '/api/sync/analytics/track': { POST: handleTrackAnalytics },
    '/api/sync/meta': { GET: handleMeta },
    '/api/sync/versions': { GET: handleGetBackupVersions },
    '/api/sync/versions/rollback': { POST: handleRollbackBackupVersion },
    '/api/sync/latest': { GET: handleGetLatest, PUT: handlePutLatest },
    '/api/sync/health': { GET: () => json({ ok: true, service: 'sync', at: nowIso() }) },
    '/api/sync/probe': { GET: () => ({ status: 200, body: PROBE_HTML, headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300'
    } }) }
  };
  const route = routes[url.pathname];
  if (!route) return null;
  if (!route[method]) return json({ message: 'not found' }, { status: 404 });
  const request = { url: url.href, urlObject: url, body, rawHeaders: headers, headers: new Headers(headers) };
  const origin = request.headers.get('origin') || '*';
  const result = withTransaction(db, () => route[method](request, db, origin));
  return { ...result, headers: { ...result.headers, 'Access-Control-Allow-Origin': origin } };
}
