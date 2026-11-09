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

function LocalMcpConsent({ onConsent, onClose }) {
  const [agreed, setAgreed] = useState(false);
  return (
    <div className="flex flex-col gap-3 text-xs leading-relaxed text-slate-600">
      <div className="font-semibold text-slate-800">使用前请阅读</div>
      <ol className="list-decimal space-y-1.5 pl-4">
        <li><span className="font-semibold text-slate-700">本机运行：</span>tzzb-mcp 与 tzzb_bridge.py 由你自行下载并在自己电脑上运行，用你本人登录的同花顺投资账本读取你自己的数据。本站不代你登录，也不在服务器上运行这些程序。</li>
        <li><span className="font-semibold text-slate-700">登录信息不上传：</span>投资账本的登录状态（Cookie）只保存在你的电脑上，不会发送到本站服务器。</li>
        <li><span className="font-semibold text-slate-700">上传到本站的内容：</span>只有你确认导入的交易记录（代码、日期、方向、数量、价格、金额、费用、成交编号），用于在你的账户里计算持仓收益。这些属于你的金融账户信息，仅你本人账户可见，不对外提供。</li>
        <li><span className="font-semibold text-slate-700">随时删除：</span>导入的记录可在持仓页逐条或批量删除；关闭本功能后不再读取。</li>
        <li><span className="font-semibold text-slate-700">第三方服务：</span>tzzb-mcp 为第三方开源工具，与同花顺及本站无合作关系。使用时请遵守同花顺的用户协议，并自行承担账号被限制等风险；请勿高频调用，勿用于他人账户。</li>
        <li><span className="font-semibold text-slate-700">数据仅供参考：</span>导入结果可能与券商实际成交存在差异，请自行核对；本站不提供任何投资建议。</li>
        <li><span className="font-semibold text-slate-700">本机安全：</span>运行期间会开启带调试端口的 Chrome，建议使用单独的浏览器配置，不要在其中登录网银或券商交易；用完关闭。</li>
      </ol>
      <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
        <input type="checkbox" className="mt-0.5" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        <span>我已阅读并同意以上说明，单独同意本站保存我确认导入的交易记录。</span>
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className={GHOST_BTN} onClick={onClose}>取消</button>
        <button type="button" className={PRIMARY_BTN} disabled={!agreed} onClick={onConsent}>同意并继续</button>
      </div>
    </div>
  );
}

export function LocalMcpImportModal({ mcp }) {
  const [copied, setCopied] = useState(false);
  if (!mcp?.open) return null;
  if (!mcp.consented) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 px-4 py-6" onClick={mcp.onClose}>
        <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <div className="flex items-center gap-1.5 text-sm font-bold text-slate-900"><PlugZap className="h-4 w-4 text-indigo-500" />本地 MCP 导入：使用说明</div>
            <button type="button" className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700" onClick={mcp.onClose}>
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">
            <LocalMcpConsent onConsent={mcp.onConsent} onClose={mcp.onClose} />
          </div>
        </div>
      </div>
    );
  }
  const { url, setUrl, autoSync, setAutoSync, status, plan, startDate, setStartDate } = mcp;
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
            <span className="text-[11px] text-slate-500">每次全量导入：清空本站全部场内记录，再从这天到今天逐笔写入 tzzb_trade_history；这天之前的持仓记一笔期初。</span>
          </label>

          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={autoSync} onChange={(event) => setAutoSync(event.target.checked)} />
              <span>进入持仓页自动导入（不再弹确认，10 分钟内最多一次）</span>
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
          {plan ? <div className="text-[11px] text-slate-400">写入前会删除本站全部场内记录（含手工录入），场外基金不动。成交按投资账本原始日期、价格、数量逐笔写入（备注含成交时间与编号）。起始日之前的持仓按 {plan.date} 记期初，记账价默认取该代码第一笔成交价（可改）。场外基金 tzzb-mcp 暂无持仓接口，不动。</div> : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button type="button" className="mr-auto text-[11px] text-slate-400 hover:text-slate-600 hover:underline" onClick={mcp.onRevokeConsent}>撤回同意</button>
          <button type="button" className={GHOST_BTN} onClick={mcp.onClose}>关闭</button>
          <button type="button" className={PRIMARY_BTN} disabled={(!selectedCount && !staleCount) || loading} onClick={mcp.onImport}>
            <span>{selectedCount || staleCount ? `${staleCount ? `清空 ${staleCount} 笔场内记录，` : ''}写入 ${selectedCount} 笔` : '无需写入'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default LocalMcpImportModal;
