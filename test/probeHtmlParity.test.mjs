import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProbeHtml, DEFAULT_ANALYTICS_ENDPOINT } from '../workers/shared/probeHtml.js';
import { PROBE_HTML as cnDataProbeHtml } from '../services/cn-data/src/sync/probeHtml.js';

const ABSOLUTE_ENDPOINT = 'https://api.freebacktrack.tech/api/sync/analytics/track';

test('probe 页面：shared 规范实现与 cn-data 叶子副本同口径（仅 analytics 地址差异）', () => {
  // cn-data 走同源相对路径，是 shared 构建器的默认产物。
  assert.equal(buildProbeHtml(), cnDataProbeHtml);
  assert.equal(DEFAULT_ANALYTICS_ENDPOINT, '/api/sync/analytics/track');

  // Worker 变体只应在 analytics URL 一行上不同。
  const workerVariant = buildProbeHtml({ analyticsUrl: ABSOLUTE_ENDPOINT });
  const expectedWorker = cnDataProbeHtml.replace(
    `        const apiUrl = '${DEFAULT_ANALYTICS_ENDPOINT}';`,
    `        const apiUrl = '${ABSOLUTE_ENDPOINT}';`
  );
  assert.equal(workerVariant, expectedWorker);
});

test('probe 页面：占位符已全部解析，且关键结构仍在', () => {
  for (const html of [buildProbeHtml(), buildProbeHtml({ analyticsUrl: ABSOLUTE_ENDPOINT }), cnDataProbeHtml]) {
    assert.equal(html.includes('__ANALYTICS_ENDPOINT__'), false, '模板占位符不得泄漏到产物');
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /runDiagnosis/);
    assert.match(html, /CF_COLO_NAMES/);
    assert.match(html, /api\/sync\/analytics\/track/);
  }
});
