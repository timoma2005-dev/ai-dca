import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareMissingLast,
  createMissingLastNumericSort,
  isOtcFundRow,
  resolveMarketPriceDisplay,
  resolveMarketPriceValue,
  resolveTurnoverDisplay,
  toNumberOrNull,
} from '../src/pages/markets/marketMissingValue.js';
import { queryMobileFundPage } from '../src/pages/markets/mobileFundMetrics.js';
import { describeSortState, nextSortState } from '../src/components/data-table/sortState.js';
import { computeScrollEdges } from '../src/components/data-table/scrollEdges.js';
import { validatePromptText } from '../src/app/textPromptValidation.js';
import { authFieldAttrs, missingAuthField, resolveAuthFormHint } from '../src/app/authFormState.js';
import { sidenavLinkA11y } from '../src/components/consoleSidenavA11y.js';
import { chartA11yProps, summarizeMultiSeries, summarizeSeries } from '../src/lib/chartA11y.js';
import {
  ARTICLES_PATH,
  ARTICLES_URL,
  articleSlugFromFramePath,
  buildArticleFrameUrl,
  buildParentUrlWithArticle,
  clampFrameHeight,
  normalizeArticleSlug,
  readArticleSlugFromSearch,
  readFrameHeightMessage,
  resolveArticlesBase,
} from '../src/pages/articles/articleUrlSync.js';

// #5 缺失值
test('toNumberOrNull treats null/empty/NaN as missing instead of 0', () => {
  assert.equal(toNumberOrNull(null), null);
  assert.equal(toNumberOrNull(undefined), null);
  assert.equal(toNumberOrNull(''), null);
  assert.equal(toNumberOrNull('  '), null);
  assert.equal(toNumberOrNull('abc'), null);
  assert.equal(toNumberOrNull(0), 0);
  assert.equal(toNumberOrNull('1.25'), 1.25);
});

test('otc fund price shows latest nav with date, never 0.00', () => {
  const row = { symbol: '017436', fundKind: 'otc', price: null, latestNav: 1.2345, latestNavDate: '2026-10-23' };
  assert.equal(isOtcFundRow(row), true);
  assert.equal(resolveMarketPriceValue(row), 1.2345);
  const view = resolveMarketPriceDisplay(row, (v) => v.toFixed(4));
  assert.equal(view.text, '1.2345');
  assert.equal(view.note, '净值 10-23');
  assert.match(view.title, /2026-10-23/);
  assert.equal(view.missing, false);
});

test('missing otc nav renders dash with daily-nav hint', () => {
  const view = resolveMarketPriceDisplay({ symbol: 'jj017436', price: null, latestNav: null });
  assert.equal(view.text, '—');
  assert.equal(view.note, '净值日更');
  assert.equal(view.missing, true);
  assert.equal(resolveMarketPriceDisplay({ symbol: 'sh513100', price: 0 }).text, '—');
  assert.equal(resolveMarketPriceDisplay({ symbol: 'sh513100', price: null }).note, '暂无');
});

test('turnover display distinguishes missing from real values', () => {
  assert.equal(resolveTurnoverDisplay({ fundKind: 'otc', turnover: null }).text, '—');
  assert.match(resolveTurnoverDisplay({ fundKind: 'otc', turnover: null }).title, /场外/);
  assert.equal(resolveTurnoverDisplay({ symbol: 'sh513100' }).text, '—');
  assert.equal(resolveTurnoverDisplay({ symbol: 'sh513100', turnover: 250000000 }).text, '2.50亿');
});

test('compareMissingLast keeps missing values last in both directions', () => {
  const values = [3, null, 1, '', 2, undefined];
  const asc = [...values].sort((a, b) => compareMissingLast(a, b, false));
  assert.deepEqual(asc.slice(0, 3), [1, 2, 3]);
  // TanStack 降序会把结果取反，模拟之
  const desc = [...values].sort((a, b) => -compareMissingLast(a, b, true));
  assert.deepEqual(desc.slice(0, 3), [3, 2, 1]);
  assert.ok(desc.slice(3).every((v) => toNumberOrNull(v) == null));
  const fn = createMissingLastNumericSort(() => true);
  const row = (v) => ({ getValue: () => v });
  assert.equal(-fn(row(null), row(5), 'price') > 0, true);
});

test('mobile fund list sorts missing price last for asc and desc', () => {
  const rows = [
    { symbol: 'a', fundKind: 'otc', latestNav: 1.5 },
    { symbol: 'b', fundKind: 'otc', price: null },
    { symbol: 'c', fundKind: 'otc', latestNav: 0.9 },
  ];
  const asc = queryMobileFundPage(rows, { sorting: { id: 'price', desc: false } }).items.map((r) => r.symbol);
  const desc = queryMobileFundPage(rows, { sorting: { id: 'price', desc: true } }).items.map((r) => r.symbol);
  assert.deepEqual(asc, ['c', 'a', 'b']);
  assert.deepEqual(desc, ['a', 'c', 'b']);
});

// #11 排序三态
test('sort state cycles none -> desc -> asc -> none with aria-sort and titles', () => {
  assert.equal(nextSortState(false), 'desc');
  assert.equal(nextSortState('desc'), 'asc');
  assert.equal(nextSortState('asc'), false);
  assert.deepEqual(
    [false, 'desc', 'asc'].map((s) => describeSortState(s, '涨跌幅').ariaSort),
    ['none', 'descending', 'ascending']
  );
  assert.equal(describeSortState(false, '涨跌幅').title, '涨跌幅：未排序，点击降序');
  assert.equal(describeSortState('desc', '涨跌幅').title, '涨跌幅：当前降序，点击升序');
  assert.equal(describeSortState('asc').title, '当前升序，点击取消排序');
});

// #12 横向滚动阴影
test('scroll edges report clipped sides', () => {
  assert.deepEqual(computeScrollEdges({ scrollLeft: 0, scrollWidth: 500, clientWidth: 500 }), { left: false, right: false });
  assert.deepEqual(computeScrollEdges({ scrollLeft: 0, scrollWidth: 900, clientWidth: 400 }), { left: false, right: true });
  assert.deepEqual(computeScrollEdges({ scrollLeft: 200, scrollWidth: 900, clientWidth: 400 }), { left: true, right: true });
  assert.deepEqual(computeScrollEdges({ scrollLeft: 500, scrollWidth: 900, clientWidth: 400 }), { left: true, right: false });
});

// #13 prompt 替代
test('prompt replacement requires a trimmed name and enforces max length', () => {
  assert.deepEqual(validatePromptText('   ', { label: '视图名称' }), { ok: false, value: '', error: '请输入视图名称' });
  assert.equal(validatePromptText('  我的筛选  ').value, '我的筛选');
  assert.equal(validatePromptText('一二三四五六七八九十一二三四五六七八九十', { maxLength: 18 }).value.length, 18);
  assert.equal(validatePromptText(null).ok, false);
});

// #15 登录表单
test('auth form fields get ids, names and autocomplete per mode', () => {
  const login = authFieldAttrs('login');
  const register = authFieldAttrs('register');
  assert.equal(login.username.autoComplete, 'username');
  assert.equal(login.password.autoComplete, 'current-password');
  assert.equal(register.password.autoComplete, 'new-password');
  assert.notEqual(login.username.id, register.username.id);
  assert.ok(login.username.placeholder && login.password.placeholder);
  assert.equal(login.password.name, 'password');
});

test('auth hint stays hidden until input or failed submit', () => {
  assert.equal(resolveAuthFormHint({}), '');
  assert.equal(resolveAuthFormHint({ touched: true }), '');
  assert.equal(resolveAuthFormHint({ touched: true, username: 'u' }), '请填写登录密码');
  assert.equal(resolveAuthFormHint({ submitted: true }), '请填写用户名');
  assert.equal(resolveAuthFormHint({ submitted: true, username: 'u', password: 'p' }), '');
  assert.equal(resolveAuthFormHint({ submitted: true, busy: 'login' }), '');
  assert.equal(missingAuthField({ username: '  ', password: 'x' }), '请填写用户名');
});

// #20 侧栏
test('collapsed sidenav links expose aria-label, title and aria-current', () => {
  const active = sidenavLinkA11y({ key: 'markets', label: '行情' }, 'markets');
  assert.deepEqual(active, { 'aria-label': '行情', title: '行情', 'aria-current': 'page' });
  const locked = sidenavLinkA11y({ key: 'admin', label: '管理', locked: true }, 'markets');
  assert.equal(locked['aria-label'], '管理（需要更高权限）');
  assert.equal(locked['aria-current'], undefined);
});

// #21 图表摘要
test('chart summary includes subject, range, latest value and change', () => {
  const summary = summarizeSeries({
    title: '走势图',
    subject: '纳指ETF 513100',
    points: [{ date: '2026-01-02', c: 1 }, { date: '2026-03-02', c: 0.8 }, { date: '2026-10-23', c: 1.1 }],
    getValue: (p) => p.c,
    getDate: (p) => p.date,
    digits: 3,
  });
  assert.equal(summary.label, '走势图：纳指ETF 513100，区间 2026-01-02 至 2026-10-23，最新 1.100，区间涨跌 +10.00%');
  assert.deepEqual(summary.details, ['最高 1.100', '最低 0.800', '共 3 个数据点']);
  assert.deepEqual(chartA11yProps(summary), { role: 'img', 'aria-label': summary.label });
  assert.equal(summarizeSeries({ title: '收益曲线', points: [] }).label, '收益曲线，暂无数据');
  const pct = summarizeSeries({ title: '收益', points: [1, 3.5], unit: '%', changeMode: 'difference' });
  assert.match(pct.label, /最新 3\.50%，区间变化 \+2\.50 个百分点/);
});

test('multi-series summary lists latest value of each line', () => {
  const summary = summarizeMultiSeries({
    title: '场内分时溢价率走势',
    lines: [{ label: 'A', points: [{ value: 1 }, { value: 2 }] }, { label: 'B', points: [{ value: 3 }] }],
    getValue: (p) => p.value,
    unit: '%',
    changeMode: 'difference',
  });
  assert.equal(summary.label, '场内分时溢价率走势，2 条曲线，最新：A 2.00%；B 3.00%');
  assert.equal(summary.details.length, 2);
});

// #19 文章深链
test('article slug normalization rejects unsafe paths', () => {
  assert.equal(normalizeArticleSlug('articles/2026-06-22-abc/index.html'), 'articles/2026-06-22-abc/');
  assert.equal(normalizeArticleSlug('articles/2026-06-22-abc/'), 'articles/2026-06-22-abc/');
  assert.equal(normalizeArticleSlug('by-date.html'), 'by-date.html');
  assert.equal(normalizeArticleSlug('index.html'), '');
  assert.equal(normalizeArticleSlug('../etc/passwd'), '');
  assert.equal(normalizeArticleSlug('articles/../x/'), '');
  assert.equal(normalizeArticleSlug('https://evil.test/a'), '');
  assert.equal(normalizeArticleSlug('javascript:alert(1)'), '');
  assert.equal(normalizeArticleSlug('%E0%A4%A'), '');
});

test('article url sync maps iframe path <-> parent query', () => {
  const slug = articleSlugFromFramePath('/wechat/articles/2026-06-22-%E5%88%87/index.html');
  assert.equal(slug, 'articles/2026-06-22-切/');
  assert.equal(articleSlugFromFramePath('/wechat/'), '');
  assert.equal(buildArticleFrameUrl('/wechat/', slug), '/wechat/articles/2026-06-22-%E5%88%87/');
  assert.equal(buildArticleFrameUrl('/wechat/', ''), '/wechat/');
  assert.equal(readArticleSlugFromSearch('?tab=articles&article=articles%2Fx%2F'), 'articles/x/');
  const next = buildParentUrlWithArticle('https://fast.freebacktrack.tech/home.html?tab=articles#top', 'articles/x/');
  assert.equal(new URL(next).searchParams.get('article'), 'articles/x/');
  assert.equal(new URL(next).searchParams.get('tab'), 'articles');
  assert.equal(new URL(next).hash, '#top');
  assert.equal(buildParentUrlWithArticle(next, 'articles/x/'), '');
  assert.equal(new URL(buildParentUrlWithArticle(next, '')).searchParams.has('article'), false);
  assert.equal(buildParentUrlWithArticle('https://fast.freebacktrack.tech/home.html?tab=articles', ''), '');
});

test('articles iframe uses same-origin path on cn hosts only', () => {
  assert.equal(resolveArticlesBase({ hostname: 'fast.freebacktrack.tech' }), ARTICLES_PATH);
  assert.equal(resolveArticlesBase({ hostname: 'cn.freebacktrack.tech' }), ARTICLES_PATH);
  assert.equal(resolveArticlesBase({ hostname: 'localhost' }), ARTICLES_URL);
  assert.equal(clampFrameHeight(10), 480);
  assert.equal(clampFrameHeight(1234.2), 1235);
  assert.equal(clampFrameHeight('x'), 480);
  assert.equal(readFrameHeightMessage({ origin: 'https://evil.test', data: { type: 'wechat-article:height', height: 900 } }, ['https://fast.freebacktrack.tech']), null);
  assert.equal(readFrameHeightMessage({ origin: 'https://fast.freebacktrack.tech', data: { type: 'wechat-article:height', height: 900 } }, ['https://fast.freebacktrack.tech']), 900);
});
