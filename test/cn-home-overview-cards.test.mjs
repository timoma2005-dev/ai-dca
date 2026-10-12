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

test('breadth counts include flatCount with a 0 fallback', () => {
  assert.match(source, /count\(b,\s*'flatCount',\s*'flat'\)/);
  assert.match(source, /涨 \/ \{fall\} 跌 \/ \{flat\} 平 \(全池 \{total\} 只\)/);
});

test('breadth progress bar renders up/flat/down segments with proportional widths', () => {
  assert.match(source, /className="cn-home-breadth-progress"/);
  assert.match(source, /className="cn-home-progress-up" style=\{\{ width: `\$\{upPct\.toFixed\(1\)\}%` \}\}/);
  assert.match(source, /className="cn-home-progress-flat" style=\{\{ width: `\$\{flatPct\.toFixed\(1\)\}%` \}\}/);
  assert.match(source, /className="cn-home-progress-down" style=\{\{ width: `\$\{downPct\.toFixed\(1\)\}%` \}\}/);
});

test('median card shows 实时口径 when the previous-day median is missing', () => {
  assert.match(source, /\{prevMedian == null \? '实时口径' : /);
});

test('three cards exist: breadth / median premium / OTC quotas', () => {
  assert.match(source, /场内全池涨跌比/);
  assert.match(source, /场内溢价中位数/);
  assert.match(source, /场外可用申购额度/);
});

test('quota card has the full-detail entry and the limited-count footnote', () => {
  assert.match(source, /查看完整额度详情/);
  assert.match(source, /onClick=\{\(\) => onOpenDetail\?\.\('CNY'\)\}/);
  assert.match(source, /\{limitedCount\} 只限购/);
});

test('cards are equal height with baseline-aligned footnotes', () => {
  assert.deepEqual(declarations('.cn-home-ov-card', 'display'), ['flex']);
  assert.deepEqual(declarations('.cn-home-ov-card', 'flex-direction'), ['column']);
  assert.deepEqual(declarations('.cn-home-ov-foot', 'margin-top'), ['auto']);
});

test('new cards use the tone variables (no hardcoded up/down colors)', () => {
  assert.deepEqual(declarations('.cn-home-metric-value.is-up', 'color'), ['var(--tone-up)']);
  assert.deepEqual(declarations('.cn-home-metric-value.is-down', 'color'), ['var(--tone-down)']);
  assert.deepEqual(declarations('.cn-home-progress-up', 'background'), ['var(--tone-up)']);
  assert.deepEqual(declarations('.cn-home-progress-down', 'background'), ['var(--tone-down)']);
});
