import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const source = readFileSync(new URL('../src/pages/CnHomeExperience.jsx', import.meta.url), 'utf8');
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

test('overview is a compact two-row bar (breadth + median / OTC quotas)', () => {
  assert.match(source, /function OverviewBar\(/);
  assert.equal(source.match(/className="cn-home-ovbar-row"/g)?.length, 2);
  assert.doesNotMatch(source, /function OverviewCards\(/);
});

test('breadth counts include flatCount with a 0 fallback', () => {
  assert.match(source, /count\(b,\s*'flatCount',\s*'flat'\)/);
  assert.match(source, /场内全池 \$\{total\} 只：\$\{rise\} 涨 \/ \$\{fall\} 跌 \/ \$\{flat\} 平/);
});

test('breadth progress bar renders up/flat/down segments with proportional widths', () => {
  assert.match(source, /className="cn-home-breadth-progress"/);
  assert.match(source, /className="cn-home-progress-up" style=\{\{ width: `\$\{upPct\.toFixed\(1\)\}%` \}\}/);
  assert.match(source, /className="cn-home-progress-flat" style=\{\{ width: `\$\{flatPct\.toFixed\(1\)\}%` \}\}/);
  assert.match(source, /className="cn-home-progress-down" style=\{\{ width: `\$\{downPct\.toFixed\(1\)\}%` \}\}/);
});

test('median keeps 实时口径 hint when the previous-day median is missing', () => {
  assert.match(source, /prevMedian == null \? '，实时口径'/);
});

test('quota chips open the full-detail page per currency', () => {
  assert.match(source, /quota\(cny, 'CNY'\)/);
  assert.match(source, /quota\(usd, 'USD'\)/);
  assert.match(source, /onClick=\{\(\) => onOpenDetail\?\.\(currency\)\}/);
});

test('rows stay on one line each', () => {
  assert.deepEqual(declarations('.cn-home-ovbar-row', 'flex-wrap'), ['nowrap']);
  assert.deepEqual(declarations('.cn-home-ovbar-row', 'white-space'), ['nowrap']);
});

test('metric colors use the tone variables (no hardcoded up/down colors)', () => {
  assert.deepEqual(declarations('.cn-home-metric-value.is-up', 'color'), ['var(--tone-up)']);
  assert.deepEqual(declarations('.cn-home-metric-value.is-down', 'color'), ['var(--tone-down)']);
  assert.deepEqual(declarations('.cn-home-progress-up', 'background'), ['var(--tone-up)']);
  assert.deepEqual(declarations('.cn-home-progress-down', 'background'), ['var(--tone-down)']);
});
