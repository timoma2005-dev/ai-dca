// 基金溢价静态落地页：构建时为每只场内 QDII ETF 生成 fund/<code>.html（可被搜索引擎收录的标题、描述和正文），
// 页面打开后再用公开的 home-market-series 接口填实时溢价；同时输出 sitemap.xml。
import { SWITCH_STRATEGY_ETFS } from '../../src/app/nasdaqCatalog.js';

export const SITE_ORIGIN = 'https://fast.freebacktrack.tech';
export const OG_IMAGE = `${SITE_ORIGIN}/og-cover.png`;
const SERIES_API = '/api/market-collector/aggregates/home-market-series';
const INDEX_LABEL = { nasdaq100: '纳斯达克100', sp500: '标普500', us50: '美国50' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fundSeoFunds(list = SWITCH_STRATEGY_ETFS) {
  return list.map((fund) => ({ code: fund.code, name: fund.name, indexLabel: INDEX_LABEL[fund.index_key] || '美股' }));
}

export function fundPagePath(code) {
  return `/fund/${code}.html`;
}

export function buildFundPageHtml(fund, funds = fundSeoFunds()) {
  const { code, name, indexLabel } = fund;
  const url = `${SITE_ORIGIN}${fundPagePath(code)}`;
  const title = `${code} 溢价率实时 · ${name} | AI-DCA`;
  const description = `${name}（${code}）场内实时溢价率、价格和最新净值，以及同类${indexLabel} QDII ETF 溢价排名对比。交易时段每分钟更新，溢价低位可免费设置提醒。`;
  const peers = funds.filter((item) => item.indexLabel === indexLabel && item.code !== code);
  const others = funds.filter((item) => item.indexLabel !== indexLabel);
  const link = (item) => `<a href="${fundPagePath(item.code)}">${esc(item.code)} ${esc(item.name)}</a>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${url}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="AI-DCA 美股策略助手" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${OG_IMAGE}" />
<meta name="twitter:card" content="summary_large_image" />
<style>
  body{margin:0;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#0f172a;background:#f8fafc}
  .wrap{max-width:720px;margin:0 auto;padding:20px 16px 110px}
  header{display:flex;align-items:center;gap:10px;margin-bottom:14px}header a{color:#0f172a;text-decoration:none;font-weight:700}
  .logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#8b5cf6)}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;margin-bottom:12px}
  h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 8px}
  .meta{color:#94a3b8;font-size:12px}
  .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
  .kpi{background:#f8fafc;border-radius:10px;padding:10px}.kpi span{display:block;font-size:12px;color:#475569}.kpi b{font-size:18px;font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  th,td{padding:8px 6px;border-bottom:1px solid #e2e8f0;text-align:right;font-size:14px}th{color:#94a3b8;font-weight:500;font-size:12px}
  th:first-child,td:first-child{text-align:left}tr.me td{background:#eef2ff;font-weight:700}
  td a,.links a{color:#4f46e5;text-decoration:none}.links{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px}
  p{color:#475569;margin:6px 0}
  .cta{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.96);border-top:1px solid #e2e8f0;padding:10px 16px calc(10px + env(safe-area-inset-bottom))}
  .cta .in{max-width:720px;margin:0 auto;display:flex;gap:8px}
  .btn{flex:1;display:inline-flex;align-items:center;justify-content:center;height:40px;border-radius:999px;font-weight:700;font-size:14px;text-decoration:none}
  .pri{background:#4f46e5;color:#fff}.sec{background:#eef2ff;color:#4f46e5}
</style>
</head>
<body>
<div class="wrap">
  <header><span class="logo"></span><a href="/">AI-DCA 美股策略助手</a></header>
  <div class="card">
    <h1>${esc(code)} ${esc(name)} 溢价率实时</h1>
    <div class="meta" id="asof">${esc(indexLabel)} QDII ETF · 交易时段每分钟更新</div>
    <div class="kpis">
      <div class="kpi"><span>场内溢价率</span><b id="k-prem">—</b></div>
      <div class="kpi"><span>场内价格</span><b id="k-price">—</b></div>
      <div class="kpi"><span>参考净值</span><b id="k-nav">—</b></div>
    </div>
    <p id="k-rank"></p>
  </div>
  <div class="card">
    <h2>同类${esc(indexLabel)} ETF 溢价排名</h2>
    <table><thead><tr><th>基金</th><th>价格</th><th>溢价</th></tr></thead><tbody id="peers"><tr><td colspan="3" class="meta">加载中…</td></tr></tbody></table>
  </div>
  <div class="card">
    <h2>什么是 QDII ETF 溢价</h2>
    <p>${esc(name)}投资海外市场，受外汇额度限制经常暂停申购，场内价格会高于基金净值，高出的比例就是溢价率。溢价越高，买入时多付的成本越大；溢价回落时还会额外亏损。</p>
    <p>同一指数的几只 ETF 溢价常常相差几个百分点，换到溢价更低的那只、或在溢价低位时买入，可以明显降低持有成本。AI-DCA 免费提供溢价实时排名、每日溢价日报，以及溢价低位和换基机会提醒。</p>
  </div>
  <div class="card">
    <h2>同类基金</h2>
    <div class="links">${peers.map(link).join('')}</div>
    <h2 style="margin-top:12px">其他美股 QDII ETF</h2>
    <div class="links">${others.map(link).join('')}</div>
    <p class="meta" style="margin-top:12px">溢价按最新公布净值估算，净值有 1～2 个交易日滞后；仅供参考，不构成投资建议。</p>
  </div>
</div>
<div class="cta"><div class="in">
  <a class="btn sec" href="/daily.html?utm_source=fund_page&amp;utm_content=${esc(code)}">今日溢价日报</a>
  <a class="btn pri" href="/home.html?tab=markets&amp;utm_source=fund_page&amp;utm_content=${esc(code)}">看全部实时行情</a>
</div></div>
<script>
(function () {
  var CODE = ${JSON.stringify(code)};
  function f(n, d) { return n == null || !isFinite(n) ? "—" : Number(n).toFixed(d); }
  function pct(n) { return n == null || !isFinite(n) ? "—" : Number(n).toFixed(2) + "%"; }
  function last(s) { var p = s && s.points || []; return p[p.length - 1] || null; }
  try {
    var q = new URLSearchParams({ p: location.pathname, t: document.title, r: document.referrer ? new URL(document.referrer).origin : "", rnd: Math.random().toString(36).slice(2, 8) });
    if (!(navigator.sendBeacon && navigator.sendBeacon("/gc/count?" + q))) new Image().src = "/gc/count?" + q;
  } catch (e) {}
  fetch(${JSON.stringify(SERIES_API)}, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
    var series = (d && d.modes && d.modes.premium && d.modes.premium.series) || [];
    var me = series.filter(function (s) { return s.code === CODE; })[0];
    var p = last(me);
    if (p) {
      document.getElementById("k-prem").textContent = pct(p.premiumPercent);
      document.getElementById("k-price").textContent = f(p.price, 3);
      document.getElementById("k-nav").textContent = f(p.nav, 4);
      document.getElementById("asof").textContent = "更新于 " + String(p.time || "").replace("T", " ").slice(0, 16) + (p.navDate ? " · 净值日期 " + p.navDate : "");
    }
    var peers = series.filter(function (s) { return me ? s.groupKey === me.groupKey : true; }).map(function (s) { return { s: s, p: last(s) }; })
      .filter(function (x) { return x.p && x.p.premiumPercent != null; }).sort(function (a, b) { return a.p.premiumPercent - b.p.premiumPercent; });
    var rank = peers.findIndex(function (x) { return x.s.code === CODE; });
    if (rank >= 0) document.getElementById("k-rank").textContent = "当前在同类 " + peers.length + " 只中溢价第 " + (rank + 1) + " 低。";
    document.getElementById("peers").innerHTML = peers.map(function (x) {
      return '<tr' + (x.s.code === CODE ? ' class="me"' : '') + '><td><a href="/fund/' + x.s.code + '.html">' + x.s.code + ' ' + String(x.s.name || '').replace(/[<>&"]/g, '') + '</a></td><td>' + f(x.p.price, 3) + '</td><td>' + pct(x.p.premiumPercent) + '</td></tr>';
    }).join("") || '<tr><td colspan="3" class="meta">暂无数据</td></tr>';
  }).catch(function () {
    document.getElementById("peers").innerHTML = '<tr><td colspan="3" class="meta">实时数据加载失败，请稍后刷新。</td></tr>';
  });
})();
</script>
</body>
</html>
`;
}

export function buildSitemapXml(funds = fundSeoFunds(), lastmod = new Date().toISOString().slice(0, 10)) {
  const urls = ['/', '/daily.html', ...funds.map((fund) => fundPagePath(fund.code))];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((path) => `  <url><loc>${SITE_ORIGIN}${path}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq></url>`).join('\n')}
</urlset>
`;
}

/** Vite 插件：开发服务器按需生成，构建时作为静态资源输出。 */
export function fundSeoPagesPlugin() {
  return {
    name: 'fund-seo-pages',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = String(req.url || '').split('?')[0];
        const fund = fundSeoFunds().find((item) => fundPagePath(item.code) === pathname);
        if (pathname === '/sitemap.xml') {
          res.setHeader('content-type', 'application/xml; charset=utf-8');
          res.end(buildSitemapXml());
          return undefined;
        }
        if (!fund) return next();
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(buildFundPageHtml(fund));
        return undefined;
      });
    },
    generateBundle() {
      const funds = fundSeoFunds();
      for (const fund of funds) {
        this.emitFile({ type: 'asset', fileName: fundPagePath(fund.code).slice(1), source: buildFundPageHtml(fund, funds) });
      }
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: buildSitemapXml(funds) });
    },
  };
}
