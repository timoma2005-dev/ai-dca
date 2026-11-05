import { useState } from 'react';
import { CheckCircle2, Copy, LoaderCircle, PlugZap, RefreshCw, X } from 'lucide-react';
import { GHOST_BTN, PRIMARY_BTN, SUBTLE_BTN } from '../../app/holdingsHelpers.js';
import { cx } from '../../components/experience-ui.jsx';

function fmtShares(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}

function buildBridgeCommand(url) {
  let port = '8765';
  try { port = new URL(url).port || port; } catch { /* 使用默认端口 */ }
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://fast.freebacktrack.tech';
  return `python tzzb_bridge.py --port ${port} --allow-origin "${origin}" --expose-header mcp-session-id tzzb-mcp`;
}

export function LocalMcpImportModal({ mcp }) {
  const [copied, setCopied] = useState(false);
  if (!mcp?.open) return null;
  const { url, setUrl, autoSync, setAutoSync, clearMissing, setClearMissing, status, plan, startDate, setStartDate } = mcp;
  const loading = status.state === 'loading';
  const command = buildBridgeCommand(url);
  const changeRows = plan ? plan.rows.filter((row) => row.type) : [];
  const trades = plan?.trades || [];
  const selectedTrades = trades.filter((t) => t.selected).length;
  const selectedAdjust = changeRows.filter((row) => row.selected).length;
  const selectedCount = selectedTrades + selectedAdjust;
  const staleCount = plan?.staleAdjustments?.length || 0;

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 浏览器拒绝时用户可手动选中 */ }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 px-4 py-6" onClick={mcp.onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <div>
            <div className="flex items-center gap-1.5 text-sm font-bold text-slate-900"><PlugZap className="h-4 w-4 text-indigo-500" />本地 MCP 导入交易记录</div>
            <div className="mt-0.5 text-xs text-slate-500">浏览器直连你电脑上的 tzzb-mcp（同花顺投资账本），登录信息与持仓不经过本站服务器。</div>
          </div>
          <button type="button" className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700" onClick={mcp.onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 text-xs text-slate-600">
          <details className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <summary className="cursor-pointer font-semibold text-slate-700">首次使用：本机启动步骤</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              <li>在同花顺 App 的「投资账本」里绑定银河等券商账户，确认网页版 tzzb.10jqka.com.cn 能看到持仓。</li>
              <li>安装 tzzb-mcp 与桥接：<code className="rounded bg-white px-1">pip install mcp-proxy</code>，并在 tzzb-mcp 目录执行 <code className="rounded bg-white px-1">pip install .</code></li>
              <li>下载桥接脚本 <a className="font-semibold text-indigo-600 underline" href="/tzzb_bridge.py" download="tzzb_bridge.py">tzzb_bridge.py</a>（在 mcp-proxy 上放行浏览器访问本机的预检），在它所在目录启动（保持窗口开着）：</li>
            </ol>
            <div className="mt-1 flex items-start gap-2">
              <code className="block flex-1 break-all rounded-lg bg-slate-900 px-2 py-1.5 font-mono text-[11px] text-slate-100">{command}</code>
              <button type="button" className={cx(SUBTLE_BTN, 'shrink-0')} onClick={copyCommand}>
                {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}<span>{copied ? '已复制' : '复制'}</span>
              </button>
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500">首次读取时 tzzb-mcp 会弹出 Chrome，请在里面登录投资账本（约 7 天有效）。浏览器询问「访问本地网络」时请允许。建议用电脑版 Chrome / Edge。</div>
          </details>

          <label className="flex flex-col gap-1">
            <span className="font-semibold text-slate-700">本地 MCP 地址</span>
            <div className="flex gap-2">
              <input
                className="h-9 flex-1 rounded-lg border border-slate-200 px-3 font-mono text-xs focus:border-indigo-300 focus:outline-none"
                value={url}
                placeholder="http://127.0.0.1:8765/mcp"
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') mcp.onFetch(); }}
              />
              <button type="button" className={PRIMARY_BTN} disabled={loading} onClick={mcp.onFetch}>
                {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}<span>读取</span>
              </button>
            </div>
          </label>

          <label className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-700">成交记录起始日</span>
            <input
              type="date"
              className="h-8 rounded-lg border border-slate-200 px-2 text-xs focus:border-indigo-300 focus:outline-none"
              value={startDate || ''}
              onChange={(event) => setStartDate(event.target.value)}
            />
            <span className="text-[11px] text-slate-500">从这天到今天，逐笔读取 tzzb_trade_history 写入交易记录；已有的同一笔自动跳过。</span>
          </label>

          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={autoSync} onChange={(event) => setAutoSync(event.target.checked)} />
              <span>进入持仓页自动导入（不再弹确认，10 分钟内最多一次）</span>
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={clearMissing} onChange={(event) => setClearMissing(event.target.checked)} />
              <span>账本里已没有的场内持仓，按清仓记录</span>
            </label>
          </div>

          {status.message ? (
            <div className={cx('rounded-xl px-3 py-2', status.state === 'error' ? 'border border-rose-200 bg-rose-50 text-rose-700' : 'border border-slate-200 bg-slate-50 text-slate-700')}>
              {status.message}
            </div>
          ) : null}

          {plan && plan.accounts?.length ? (
            <div className="text-[11px] text-slate-500">{plan.accounts.map((acc) => `${acc.label} ${acc.count} 只`).join('；')}</div>
          ) : null}

          {trades.length ? (
            <div className="rounded-xl border border-slate-200">
              <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-3 py-1.5">
                <span className="font-semibold text-slate-700">新增成交 {trades.length} 笔（已选 {selectedTrades}）</span>
                <span className="flex gap-3 text-[11px]">
                  <button type="button" className="text-indigo-600 hover:underline" onClick={() => mcp.onSetAllTrades(true)}>全选</button>
                  <button type="button" className="text-slate-500 hover:underline" onClick={() => mcp.onSetAllTrades(false)}>全不选</button>
                </span>
              </div>
              <div className="max-h-64 overflow-auto">
                <table className="w-full min-w-[560px] text-xs">
                  <thead className="sticky top-0 bg-white text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium" />
                      <th className="px-2 py-1.5 text-left font-medium">成交时间</th>
                      <th className="px-2 py-1.5 text-left font-medium">代码 / 名称</th>
                      <th className="px-2 py-1.5 text-left font-medium">方向</th>
                      <th className="px-2 py-1.5 text-right font-medium">数量</th>
                      <th className="px-2 py-1.5 text-right font-medium">价格</th>
                      <th className="px-2 py-1.5 text-right font-medium">金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => (
                      <tr key={t.id} className="border-t border-slate-100">
                        <td className="px-2 py-1"><input type="checkbox" checked={t.selected} onChange={() => mcp.onToggleTrade(t.id)} /></td>
                        <td className="px-2 py-1 tabular-nums text-slate-600">{t.date} {t.time}</td>
                        <td className="px-2 py-1"><span className="font-mono text-slate-800">{t.code}</span> <span className="text-[11px] text-slate-500">{t.name}</span></td>
                        <td className={cx('px-2 py-1 font-semibold', t.type === 'BUY' ? 'text-rose-600' : 'text-emerald-600')}>{t.type === 'BUY' ? '买入' : '卖出'}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtShares(t.shares)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{t.price}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtShares(t.money)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {changeRows.length ? (
            <div className="font-semibold text-slate-700">写入成交后仍不一致的份额（起始日之前没录的持仓），按 {plan.date} 记期初调整</div>
          ) : null}
          {changeRows.length ? (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[560px] text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium" />
                    <th className="px-2 py-1.5 text-left font-medium">代码 / 名称</th>
                    <th className="px-2 py-1.5 text-right font-medium">本站份额</th>
                    <th className="px-2 py-1.5 text-right font-medium">账本份额</th>
                    <th className="px-2 py-1.5 text-right font-medium">调整</th>
                    <th className="px-2 py-1.5 text-right font-medium">记账价</th>
                  </tr>
                </thead>
                <tbody>
                  {changeRows.map((row) => (
                    <tr key={row.code} className="border-t border-slate-100">
                      <td className="px-2 py-1.5"><input type="checkbox" checked={row.selected} onChange={() => mcp.onToggleRow(row.code)} /></td>
                      <td className="px-2 py-1.5"><div className="font-mono text-slate-800">{row.code}</div><div className="text-[11px] text-slate-500">{row.name}{row.missingInBroker ? '（账本无）' : ''}</div></td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtShares(row.ledgerShares)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtShares(row.brokerShares)}</td>
                      <td className={cx('px-2 py-1.5 text-right font-semibold tabular-nums', row.delta > 0 ? 'text-rose-600' : 'text-emerald-600')}>
                        {row.delta > 0 ? '+' : '−'}{fmtShares(Math.abs(row.delta))}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <input
                          className="h-7 w-20 rounded border border-slate-200 px-1.5 text-right tabular-nums"
                          value={row.price || ''}
                          onChange={(event) => mcp.onRowPriceChange(row.code, event.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {plan ? <div className="text-[11px] text-slate-400">成交按投资账本原始日期、价格、数量逐笔写入（备注含成交时间与编号）。起始日起旧的「本地 MCP 同步」汇总调整会被删除，避免和逐笔成交重复。剩余差额按 {plan.date} 记期初调整，记账价默认取该代码第一笔成交价（可改）。场外基金 tzzb-mcp 暂无持仓接口，不动。</div> : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button type="button" className={GHOST_BTN} onClick={mcp.onClose}>关闭</button>
          <button type="button" className={PRIMARY_BTN} disabled={!selectedCount || loading} onClick={mcp.onImport}>
            <span>{selectedCount ? `写入 ${selectedCount} 笔${staleCount ? `，删除 ${staleCount} 笔旧调整` : ''}` : '无需写入'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default LocalMcpImportModal;
