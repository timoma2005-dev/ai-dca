import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const chartSource = readFileSync(new URL('../src/pages/cn-home/PremiumChart.jsx', import.meta.url), 'utf8');
const homeSource = readFileSync(new URL('../src/pages/CnHomeExperience.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/pages/cn-home.css', import.meta.url), 'utf8');
const styles = postcss.parse(css);

function declarations(selector, property) {
  const values = [];
  styles.walkRules((rule) => {
    const parts = String(rule.selector).split(',').map((s) => s.trim());
    if (!parts.includes(selector)) return;
    rule.walkDecls(property, (decl) => values.push(decl.value));
  });
  return values;
}

test('chart uses the 800x380 viewBox geometry', () => {
  assert.match(chartSource, /const W = 800;/);
  assert.match(chartSource, /const H = 380;/);
  assert.match(chartSource, /viewBox=\{`0 0 \$\{W\} \$\{H\}`\}/);
});

test('empty series renders the 暂无今日走势 state', () => {
  assert.match(chartSource, /if \(!model\.rows\.length\) return <div className="cn-home-empty">暂无今日走势<\/div>/);
});

test('interactive legend toggles curves via hiddenKeys', () => {
  assert.match(chartSource, /const \[hiddenKeys, setHiddenKeys\] = useState\(\[\]\)/);
  assert.match(chartSource, /onClick=\{\(\) => toggleLine\(item\.key\)\}/);
  assert.match(chartSource, /aria-pressed=\{!hidden\}/);
  assert.match(chartSource, /cn-home-legend-chip\$\{hidden \? ' is-hidden' : ''\}/);
  // curves are drawn from the hidden-filtered model, so a hidden curve renders no path
  assert.match(chartSource, /buildChartModel\(lines, mode, hiddenKeys\)/);
  assert.match(chartSource, /\{model\.rows\.map\(\(line\) => \(\s*<path key=\{line\.rowKey\}/);
  // the legend still lists every series so a hidden curve can be re-enabled
  assert.match(chartSource, /legendItems\.map\(\(item\) =>/);
});

test('tooltip has a header with time and metric label plus a ranked list', () => {
  assert.match(chartSource, /className="cn-home-chart-tooltip"/);
  assert.match(chartSource, /<div className="cn-home-tooltip-head"><span>\{tipTime\}<\/span><span>\{mode === 'premium' \? '实时溢价率' : '分时价格'\}<\/span><\/div>/);
  assert.match(chartSource, /className="cn-home-tooltip-list"/);
  assert.match(chartSource, /tooltipRows\(model\.rows, cursor, mode\)/);
});

test('tooltip time is defensive across point field shapes', () => {
  assert.match(chartSource, /tipRows\.map\(\(r\) => r\.p\?\.t\)\.find\(Boolean\)/);
});

test('end labels show the color dot, name, and latest value', () => {
  assert.match(chartSource, /<circle cx=\{LABEL_X\} cy=\{pointY\} r=\{2\.5\} fill=\{line\.color\} \/>/);
  assert.match(chartSource, /\{`\$\{lineLabel\(line\)\.replace\(\/ETF\/g, ''\)\} \$\{fmtValue\(latest, mode\)\}`\}/);
});

test('zone panel only renders in premium mode with the LOF exclusion note', () => {
  assert.match(chartSource, /if \(mode !== 'premium' \|\| !zones\.length\) return null;/);
  assert.match(chartSource, /分区统计不含 LOF/);
});

test('strategy suggestion switches wording at the 3% high-low gap threshold (D2)', () => {
  assert.match(chartSource, /const STRATEGY_THRESHOLD = 3;/);
  assert.match(chartSource, /if \(gapHighLow != null && gapHighLow >= STRATEGY_THRESHOLD\)/);
  assert.match(chartSource, /当前高-低利差达/);
  assert.match(chartSource, /处于温和区间/);
});

test('theme state is scoped to the .cn-home root with cn-home: storage keys (D3)', () => {
  assert.match(homeSource, /const THEME_KEY = 'cn-home:theme';/);
  assert.match(homeSource, /const COLOR_MODE_KEY = 'cn-home:colorMode';/);
  assert.match(homeSource, /<main className="cn-home" data-theme=\{theme\} data-color=\{colorMode\}>/);
  assert.doesNotMatch(homeSource, /document\.documentElement\.setAttribute\('data-theme'/);
  assert.deepEqual(declarations('.cn-home[data-theme="dark"]', '--bg-main'), ['#090d16']);
  assert.deepEqual(declarations('.cn-home[data-color="us"]', '--tone-up'), ['#10b981']);
  assert.deepEqual(declarations('.cn-home[data-color="us"]', '--tone-down'), ['#e53e3e']);
});

test('theme and color-mode toggles sit in the head with lucide icons', () => {
  assert.match(homeSource, /import \{ AlertCircle, ChevronRight, Moon, Palette, RefreshCw, Sun \} from 'lucide-react';/);
  assert.match(homeSource, /className="cn-home-head-actions"/);
  assert.match(homeSource, /onClick=\{toggleTheme\}/);
  assert.match(homeSource, /onClick=\{toggleColorMode\}/);
});

test('mobile defaults to the Nasdaq-100 group (D4)', () => {
  assert.match(homeSource, /window\.innerWidth < 640/);
  assert.match(homeSource, /\/nasdaq\/i\.test\(String\(g\.key \|\| ''\)\) \|\| \/纳指\/\.test\(String\(g\.label \|\| ''\)\)/);
});

test('data pipeline is untouched: same aggregates routes and cache keys', () => {
  assert.match(homeSource, /overview: '\/aggregates\/home-market-overview'/);
  assert.match(homeSource, /series: '\/aggregates\/home-market-series'/);
  assert.match(homeSource, /limits: '\/aggregates\/fund-limit-overview'/);
  assert.match(homeSource, /function cacheKey\(section\) \{ return `cn-home:\$\{section\}:v1`; \}/);
});
