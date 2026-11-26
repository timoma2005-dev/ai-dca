import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildFundPageHtml, buildSitemapXml, fundSeoFunds, SITE_ORIGIN } from '../scripts/vite/fundSeoPages.mjs';

test('each fund page has a searchable title, description, canonical and share card', () => {
  const funds = fundSeoFunds();
  const fund = funds.find((item) => item.code === '513100');
  const html = buildFundPageHtml(fund, funds);
  assert.match(html, /<title>513100 溢价率实时 · 国泰纳斯达克100ETF \| AI-DCA<\/title>/);
  assert.match(html, /<meta name="description" content="国泰纳斯达克100ETF（513100）场内实时溢价率/);
  assert.match(html, new RegExp(`<link rel="canonical" href="${SITE_ORIGIN}/fund/513100.html"`));
  assert.match(html, /og:image/);
  assert.match(html, /href="\/fund\/159941.html"/, 'links to peers for crawling');
  assert.doesNotMatch(html, /href="\/fund\/513100.html">513100/, 'does not list itself among peers');
});

test('sitemap lists the home page, the daily report and every fund page', () => {
  const funds = fundSeoFunds();
  const xml = buildSitemapXml(funds, '2026-11-26');
  assert.match(xml, new RegExp(`<loc>${SITE_ORIGIN}/daily.html</loc>`));
  for (const fund of funds) assert.ok(xml.includes(`${SITE_ORIGIN}/fund/${fund.code}.html`), fund.code);
  assert.ok(funds.length >= 15);
});

test('robots.txt points to the sitemap and entry pages carry description + og tags', () => {
  assert.match(fs.readFileSync('public/robots.txt', 'utf8'), /Sitemap: https:\/\/fast\.freebacktrack\.tech\/sitemap\.xml/);
  for (const file of ['index.html', 'home.html', 'daily.html']) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /<meta name="description" content="[^"]+"/, file);
    assert.match(html, /<meta property="og:image" content="https:\/\/fast\.freebacktrack\.tech\/og-cover\.png"/, file);
    assert.match(html, /<link rel="canonical" href="https:\/\/fast\.freebacktrack\.tech\//, file);
  }
  assert.match(fs.readFileSync('vite.config.js', 'utf8'), /fundSeoPagesPlugin\(\)/);
});
