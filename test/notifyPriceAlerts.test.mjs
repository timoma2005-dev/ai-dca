import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateHoldingAlertRules, evaluateMarketAlertRules } from '../workers/notify/src/alertRuleEvaluation.js';

function buildJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('evaluateHoldingAlertRules fetches live fund metrics and triggers cost based gain alerts', async () => {
  const metricRequests = [];
  let writtenState = null;
  const env = {
    __notifySettings: { accountUsername: 'lovexl' },
    __notifyCurrentClientId: 'web:test',
    PUBLIC_DATA_BASE_URL: 'https://example.test',
    MARKETS: {
      fetch: async (request) => {
        const body = await request.json();
        metricRequests.push(body);
        return buildJsonResponse({
          items: [{
            ok: true,
            code: '021000',
            currentPrice: 2.4,
            previousClose: 2.2,
            latestNav: 2.4,
            previousNav: 2.2,
            latestNavDate: '2026-06-26',
            source: 'test'
          }]
        });
      }
    }
  };

  const result = await evaluateHoldingAlertRules(env, [{
    ruleId: 'holding-alert:021000:gain:test',
    symbol: '021000',
    name: '南方纳指 I',
    alertType: 'gain',
    threshold: 10,
    holdingCost: 2.139,
    fundKind: 'qdii',
    cooldownHours: 24
  }], {
    clientId: 'web:test',
    settings: { accountUsername: 'lovexl' },
    now: new Date('2026-09-30T02:00:00.000Z'),
    readState: async () => ({}),
    writeState: async (state) => { writtenState = state; }
  });

  assert.equal(metricRequests.length, 1);
  assert.deepEqual(metricRequests[0].codes, ['021000']);
  assert.equal(metricRequests[0].refresh, true);
  assert.equal(metricRequests[0].fundKinds['021000'], 'qdii');
  assert.equal(result.delivered.length, 1);
  // 合并契约：delivered 每项是一条组投递，含完整通知、快照与真实聚合状态。
  const item = result.delivered[0];
  assert.equal(item.alertType, 'gain');
  assert.equal(item.status, 'delivered');
  assert.ok(item.notification.merged);
  assert.equal(item.notification.holdingCount, 1);
  assert.equal(item.notification.alerts[0].ruleId, 'holding-alert:021000:gain:test');
  assert.equal(item.notification.alerts[0].symbol, '021000');
  assert.ok(item.notification.alerts[0].actualValue > 0);
  assert.match(item.notification.body, /021000 \+12\.20% → 点此查看持仓。/);
  assert.match(item.notification.detailUrl, /tab=holdings/);
  assert.ok(!item.notification.params.code, '合并通知链接不应选中单只持仓');
  const stateKey = 'holding-alert:021000:gain:test';
  assert.ok(writtenState[stateKey].lastPushedAt > 0);
  assert.ok(writtenState[stateKey].lastPushedValue > 0);
});

test('evaluateMarketAlertRules skips exchange alerts outside A-share trading hours', async () => {
  let fetched = false;
  const env = {
    MARKETS: {
      fetch: async () => {
        fetched = true;
        return buildJsonResponse({ items: [] });
      }
    }
  };

  const result = await evaluateMarketAlertRules(env, [{
    ruleId: 'market-alert:159509:premium-below:test',
    symbol: '159509',
    name: '纳指科技ETF景顺',
    alertType: 'premium-below',
    threshold: 15,
    fundKind: 'exchange',
    cooldownHours: 24
  }], {
    now: new Date('2026-07-02T12:00:00.000Z'),
    readState: async () => ({})
  });

  assert.equal(fetched, false);
  assert.equal(result.delivered.length, 0);
  assert.deepEqual(result.skipped, [{ ruleId: 'market-alert:159509:premium-below:test', reason: 'exchange-market-closed' }]);
});

test('evaluateMarketAlertRules uses mapped premiumPercent during A-share trading hours', async () => {
  const metricRequests = [];
  let writtenState = null;
  const env = {
    __notifySettings: { accountUsername: 'lovexl' },
    __notifyCurrentClientId: 'web:test',
    MARKETS: {
      fetch: async (request) => {
        const body = await request.json();
        metricRequests.push(body);
        return buildJsonResponse({
          items: [{
            ok: true,
            code: '159509',
            currentPrice: 2.662,
            previousClose: 2.660,
            premiumPercent: 14.2,
            quoteDate: '2026-07-02',
            source: 'test'
          }]
        });
      }
    }
  };

  const result = await evaluateMarketAlertRules(env, [{
    ruleId: 'market-alert:159509:premium-below:test',
    symbol: '159509',
    name: '纳指科技ETF景顺',
    alertType: 'premium-below',
    threshold: 15,
    fundKind: 'exchange',
    cooldownHours: 24
  }], {
    clientId: 'web:test',
    settings: { accountUsername: 'lovexl' },
    now: new Date('2026-07-02T02:00:00.000Z'),
    readState: async () => ({}),
    writeState: async (state) => { writtenState = state; }
  });

  assert.equal(metricRequests.length, 1);
  assert.deepEqual(metricRequests[0].codes, ['159509']);
  assert.equal(metricRequests[0].fundKinds['159509'], 'exchange');
  assert.equal(result.delivered.length, 1);
  assert.equal(result.delivered[0].actualValue, 14.2);
  assert.equal(writtenState['market-alert:159509:premium-below:test'].lastPushedValue, 14.2);
});
