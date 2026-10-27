/* global URL */
// 本地直连面板的渲染冒烟：rolldown 打包真实组件后 renderToStaticMarkup，
// 并静态校验 markets / fundSwitch 两个页面的接线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { rolldown } from 'rolldown';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireFromRoot = createRequire(join(root, 'package.json'));
const abs = (rel) => JSON.stringify(join(root, rel));

const UNIVERSE = [
  { code: '513100', name: '纳指ETF国泰' },
  { code: '159941', name: '纳指ETF广发' },
  { code: '513500', name: '标普500ETF' },
];

const entrySource = `
import { createElement as h } from ${JSON.stringify(requireFromRoot.resolve('react'))};
import { renderToStaticMarkup } from ${JSON.stringify(requireFromRoot.resolve('react-dom/server'))};
import { LocalDirectModeBar, LocalDirectPanel } from ${abs('src/components/markets/LocalDirectPanel.jsx')};
import { FundSwitchLocalTab } from ${abs('src/components/markets/FundSwitchLocalTab.jsx')};
import { LOCAL_DIRECT_SCOPES } from ${abs('src/app/localDirectMode.js')};
const noop = () => {};
export function renderModeBar(props) {
  return renderToStaticMarkup(h(LocalDirectModeBar, { onChange: noop, ...props }));
}
export function renderPanel(props) {
  return renderToStaticMarkup(h(LocalDirectPanel, { universe: ${JSON.stringify(UNIVERSE)}, ...props }));
}
export function renderFundSwitchLocalTab() {
  return renderToStaticMarkup(h(FundSwitchLocalTab));
}
export { LOCAL_DIRECT_SCOPES };
`;

async function loadBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'local-direct-ui-'));
  const entry = join(dir, 'entry.jsx');
  writeFileSync(entry, entrySource);
  const bundle = await rolldown({
    input: entry,
    platform: 'node',
    logLevel: 'silent',
    moduleTypes: { '.css': 'empty', '.jpg': 'empty', '.png': 'empty', '.svg': 'empty' },
    transform: { jsx: 'react-jsx', define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' } },
  });
  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();
  for (const chunk of output) {
    writeFileSync(join(dir, chunk.fileName), chunk.type === 'chunk' ? chunk.code : chunk.source);
  }
  const mod = await import(pathToFileURL(join(dir, output[0].fileName)).href);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const { mod, cleanup } = await loadBundle();
test.after(cleanup);

test('mode bar renders cloud/local segments with active state and scope-agnostic note', () => {
  const off = mod.renderModeBar({ scope: mod.LOCAL_DIRECT_SCOPES.MARKETS, enabled: false });
  assert.match(off, /data-testid="local-direct-mode-bar"/);
  assert.match(off, /云端/);
  assert.match(off, /本地直连/);
  // 说明文案：浏览器直连、不经本服务、失败切云端。
  assert.match(off, /浏览器直连行情接口/);
  assert.match(off, /不经过美股策略助手服务/);
  assert.match(off, /如接口不可用请切换云端/);
  // 分段条始终恰好一个激活按钮；关闭态激活的是排在前面的「云端」。
  assert.equal((off.match(/aria-pressed="true"/g) || []).length, 1);
  const offButtons = off.split('<button').slice(1);
  assert.match(offButtons[0], /is-active/);
  assert.match(offButtons[0], /云端/);
  assert.doesNotMatch(offButtons[1], /is-active/);
  const on = mod.renderModeBar({ scope: mod.LOCAL_DIRECT_SCOPES.MARKETS, enabled: true });
  assert.equal((on.match(/aria-pressed="true"/g) || []).length, 1);
  const onButtons = on.split('<button').slice(1);
  assert.doesNotMatch(onButtons[0], /is-active/);
  assert.match(onButtons[1], /is-active/);
  assert.match(onButtons[1], /本地直连/);
  // compact 模式隐藏说明文案。
  const compact = mod.renderModeBar({ scope: mod.LOCAL_DIRECT_SCOPES.MARKETS, enabled: true, compact: true });
  assert.doesNotMatch(compact, /如接口不可用请切换云端/);
  assert.match(compact, /is-compact/);
});

test('panel SSR shell shows scope, premium title, search input and loading skeleton', () => {
  const html = mod.renderPanel({
    scope: mod.LOCAL_DIRECT_SCOPES.FUND_SWITCH,
    showPremium: true,
  });
  assert.match(html, /data-testid="local-direct-panel"/);
  assert.match(html, /data-scope="fundSwitch"/);
  assert.match(html, /溢价看板/);
  assert.match(html, /aria-label="直连搜索标的"/);
  // 初始 loading：摘要仍按 universe 计数。
  assert.match(html, /标的/);
  assert.match(html, /正在直连行情厂商接口/);
  // 东财基金净值为主、蛋卷兜底。
  assert.match(html, /东财净值/);
  assert.match(html, /fundmobapi\.eastmoney\.com/);
  assert.match(html, /蛋卷兜底/);
});

test('panel without premium hides nav wording and uses plain title', () => {
  const html = mod.renderPanel({ scope: mod.LOCAL_DIRECT_SCOPES.MARKETS });
  assert.match(html, /本地直连行情/);
  assert.doesNotMatch(html, /溢价看板/);
  assert.doesNotMatch(html, /danjuanfunds\.com/);
  assert.doesNotMatch(html, /fundmobapi\.eastmoney\.com/);
  assert.match(html, /data-scope="markets"/);
});

test('fundSwitch local tab renders the premium panel through the extracted component', () => {
  const html = mod.renderFundSwitchLocalTab();
  assert.match(html, /data-testid="local-direct-panel"/);
  assert.match(html, /data-scope="fundSwitch"/);
  assert.match(html, /溢价看板/);
});

test('markets and fundSwitch pages wire the local-direct entry', () => {
  const markets = readFileSync(new URL('../src/pages/MarketsExperience.jsx', import.meta.url), 'utf8');
  assert.match(markets, /useLocalDirectMode\(LOCAL_DIRECT_SCOPES\.MARKETS\)/);
  assert.match(markets, /if \(localDirect\) \{/);
  // 行情中心直连沿用云端列表/详情组件，只换数据源。
  assert.match(markets, /<LocalDirectMarketsView/);
  const view = readFileSync(new URL('../src/components/markets/LocalDirectMarketsView.jsx', import.meta.url), 'utf8');
  assert.match(view, /MarketsFullTablePanel/);
  assert.match(view, /MarketsMainContent/);
  assert.match(view, /localDirect: true/);
  assert.match(view, /omitColumnIds=\{omitColumnIds\}/);
  assert.match(view, /本地直连已精简部分数据，需要更详细的数据请使用云端/);
  assert.match(view, /classList\.toggle\('markets-full-table-active', showFullTable\)/);
  const mobileList = readFileSync(new URL('../src/pages/markets/MobileFundList.jsx', import.meta.url), 'utf8');
  assert.match(mobileList, /expandable=\{!localDirect\}/);
  assert.match(view, /fetchEastmoneyFundNavs/);
  const detail = readFileSync(new URL('../src/pages/markets/MarketSymbolDetailPanel.jsx', import.meta.url), 'utf8');
  assert.match(detail, /!summaryMode && !localDirect \? <ChartToolbarPopover/);
  // 数据源切换改为右侧悬浮标签，云端/直连两种视图都挂载，保证可切回。
  assert.equal((markets.match(/<LocalDirectModeFloat enabled=\{localDirect\}/g) || []).length, 2);
  // 列表锁滚动只在列表态生效，详情态放开（手机端详情页可滑动）。
  assert.match(markets, /typeof document === 'undefined' \|\| localDirect\) return undefined/);

  // 面板净值走东财 FundMNFInfo（与竞价看板同链路），蛋卷仅兜底。
  const panel = readFileSync(new URL('../src/components/markets/LocalDirectPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /fetchEastmoneyFundNavs/);
  assert.match(panel, /fetchDanjuanDirectQuotes/);

  const fundSwitch = readFileSync(new URL('../src/pages/FundSwitchExperience.jsx', import.meta.url), 'utf8');
  assert.match(fundSwitch, /\{ id: 'local', label: '本地直连'/);
  assert.match(fundSwitch, /activeView === 'local'/);
  assert.match(fundSwitch, /<FundSwitchLocalTab\s*\/>/);
  // 直连细节抽到独立组件，避免编排文件超过 refactor guard 的 100 行预算。
  const localTab = readFileSync(new URL('../src/components/markets/FundSwitchLocalTab.jsx', import.meta.url), 'utf8');
  assert.match(localTab, /scope=\{LOCAL_DIRECT_SCOPES\.FUND_SWITCH\}/);
  assert.match(localTab, /showPremium/);
  assert.match(localTab, /NASDAQ_ETFS/);
});
