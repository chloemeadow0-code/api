import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayStatistics } from '../src/stats.js';

test('gateway statistics count logical requests, switches and rankings', () => {
  const runs = [
    { id: 'a1', requestId: 'a', attempt: 1, action: 'gateway', accountId: 'one', modelName: 'gpt-a', status: 'error', latencyMs: 100, startedAt: '2026-09-05T01:00:00Z' },
    { id: 'a2', requestId: 'a', attempt: 2, action: 'gateway', accountId: 'two', modelName: 'gpt-b', status: 'ok', latencyMs: 200, startedAt: '2026-09-05T01:00:01Z' },
    { id: 'b1', requestId: 'b', attempt: 1, action: 'gateway', accountId: 'one', modelName: 'gpt-a', status: 'ok', latencyMs: 300, billing: 'token', inputPriceUsd: 2, outputPriceUsd: 10, inputTokens: 100, outputTokens: 20, cachedTokens: 60, totalTokens: 120, startedAt: '2026-09-05T02:00:00Z' },
    { id: 'poll', action: 'poll', accountId: 'one', status: 'ok', startedAt: '2026-09-05T02:00:00Z' }
  ];
  const accounts = [
    { id: 'one', name: '一号', rechargeConversion: { cnyPerUsd: 3.6 }, topupQuoteConversion: { cnyPerUsd: 7.2 }, usdExchangeRate: 7.2, modelName: 'gpt-a', models: [{ name: 'gpt-a', billing: 'token', inputPriceUsd: 2, outputPriceUsd: 10 }] },
    { id: 'two', name: '二号' }
  ];
  const stats = gatewayStatistics(runs, accounts, new Date('2026-09-05T03:00:00Z'), 'UTC');
  assert.equal(stats.today.requests, 2);
  assert.equal(stats.today.successRate, 100);
  assert.equal(stats.all.switched, 1);
  assert.equal(stats.all.firstHitRate, 50);
  assert.equal(stats.all.averageLatencyMs, 250);
  assert.equal(stats.all.p95LatencyMs, 300);
  assert.equal(stats.month.requests, 2);
  assert.deepEqual(stats.failures, [{ name: '网络或其他错误', count: 1 }]);
  assert.deepEqual(stats.tokens.all, { input: 100, output: 20, cached: 60, total: 120, measured: 1 });
  assert.equal(stats.sites[0].name, '一号');
  assert.equal(stats.sites[0].successRate, 50);
  assert.equal(stats.costs.pricedRequests, 1);
  assert.equal(stats.costs.nominalUsd, 0.0004);
  assert.equal(stats.costs.actualCny, 0.00144);
  assert.equal(stats.costs.savedCny, 0.00144);
  const filtered = gatewayStatistics(runs, accounts, new Date('2026-09-05T03:00:00Z'), 'UTC', 7, { modelName: 'gpt-b' });
  assert.equal(filtered.all.requests, 1);
  assert.deepEqual(filtered.filters.models, ['gpt-a', 'gpt-b']);
});
