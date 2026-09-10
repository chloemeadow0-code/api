import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackTopupQuoteAmount, gatewayCostSummary, minimumTopupFromError, modelPriceSnapshot, rechargeConversionFromPublicPrice, rechargeConversionFromQuote, rechargeConversionFromTopups, topupQuoteRequestAmount } from '../src/cost.js';

test('reads the latest successful New API topup as a real conversion rate', () => {
  const response = { data: { items: [
    { id: 3, amount: 100, money: 45, status: 'pending', complete_time: 0 },
    { id: 2, amount: 100, money: 36, status: 'success', complete_time: 20 },
    { id: 1, amount: 50, money: 20, status: 'success', complete_time: 10 }
  ] } };
  assert.deepEqual(rechargeConversionFromTopups(response), {
    faceAmountUsd: 100, paidCny: 36, cnyPerUsd: 0.36, paymentMethod: '', completedAt: 20, source: 'topup_history'
  });
  assert.equal(rechargeConversionFromTopups({ data: { items: [] } }), null);
});

test('converts token-displayed recharge quota to nominal dollars', () => {
  const conversion = rechargeConversionFromTopups({ data: [{ amount: 5000000, money: 36, status: 'success', complete_time: 1 }] }, 500000, 'TOKENS');
  assert.equal(conversion.faceAmountUsd, 10);
  assert.equal(conversion.cnyPerUsd, 3.6);
});

test('builds a read-only recharge quote conversion from the minimum topup', () => {
  assert.equal(topupQuoteRequestAmount({ data: { min_topup: 10, amount_options: [20, 50] } }), 20);
  assert.equal(topupQuoteRequestAmount({ data: { min_topup: 2 } }, 500000, 'TOKENS'), 5000000);
  assert.equal(topupQuoteRequestAmount({ data: { min_topup: 1, amount_options: '[5, 20]' } }), 5);
  assert.equal(topupQuoteRequestAmount({}), 10);
  assert.equal(fallbackTopupQuoteAmount(10), 100);
  assert.equal(fallbackTopupQuoteAmount(5000000, 500000, 'TOKENS'), 50000000);
  assert.equal(minimumTopupFromError({ message: 'error', data: '充值数量不能小于 1000' }), 1000);
  assert.deepEqual(rechargeConversionFromQuote({ success: true, data: '3.60' }, 10), {
    faceAmountUsd: 10, paidCny: 3.6, cnyPerUsd: 0.36, requestedAmount: 10, source: 'topup_quote'
  });
  assert.equal(rechargeConversionFromQuote({ success: true, data: '7.20' }, 1000000, 500000, 'TOKENS').cnyPerUsd, 3.6);
  assert.equal(rechargeConversionFromQuote({ success: false, data: 'bad' }, 10), null);
  assert.deepEqual(rechargeConversionFromPublicPrice('0.36'), {
    faceAmountUsd: 1, paidCny: 0.36, cnyPerUsd: 0.36, source: 'status_price'
  });
  assert.equal(rechargeConversionFromPublicPrice(0), null);
});

test('snapshots model prices and estimates real savings from successful usage', () => {
  const account = {
    id: 'a', modelName: 'gpt', quotaPerUnit: 500000, usdExchangeRate: 7.2,
    rechargeConversion: { cnyPerUsd: 3.6 },
    topupQuoteConversion: { cnyPerUsd: 7.2 },
    models: [{ name: 'gpt', billing: 'token', inputPriceUsd: 2, outputPriceUsd: 10 }]
  };
  assert.deepEqual(modelPriceSnapshot(account), { billing: 'token', inputPriceUsd: 2, outputPriceUsd: 10 });
  const summary = gatewayCostSummary([
    { action: 'gateway', status: 'ok', accountId: 'a', billing: 'token', inputPriceUsd: 2, outputPriceUsd: 10, inputTokens: 1000000, outputTokens: 100000 },
    { action: 'gateway', status: 'error', accountId: 'a', billing: 'token', inputPriceUsd: 2, outputPriceUsd: 10, inputTokens: 1000000, outputTokens: 100000 }
  ], [account]);
  assert.equal(summary.nominalUsd, 3);
  assert.equal(summary.referenceCny, 21.6);
  assert.equal(summary.actualCny, 10.8);
  assert.equal(summary.savedCny, 10.8);
  assert.equal(summary.pricedRequests, 1);
});

test('prices per-call requests and never turns a missing token price into free usage', () => {
  const account = { id: 'a', modelName: 'image', quotaPerUnit: 500000, rechargeConversion: { cnyPerUsd: 3.6 }, models: [{ name: 'image', billing: 'call', price: 10000, priceUnit: 'quota' }] };
  assert.deepEqual(modelPriceSnapshot(account), { billing: 'call', callPriceUsd: 0.02 });
  assert.deepEqual(modelPriceSnapshot({ modelName: 'unknown', models: [{ name: 'unknown', billing: 'token', inputPriceUsd: null, price: null }] }), {});
  const summary = gatewayCostSummary([{ action: 'gateway', status: 'ok', accountId: 'a', billing: 'call', callPriceUsd: 0.02 }], [account]);
  assert.equal(summary.nominalUsd, 0.02);
  assert.equal(Number(summary.actualCny.toFixed(6)), 0.072);
});

test('backfills historical usage with the logged model instead of the currently selected model', () => {
  const account = {
    id: 'a', modelName: 'new-model', rechargeConversion: { cnyPerUsd: 3.6 },
    models: [
      { name: 'old-model', billing: 'token', inputPriceUsd: 2, outputPriceUsd: 10 },
      { name: 'new-model', billing: 'token', inputPriceUsd: 20, outputPriceUsd: 100 }
    ]
  };
  const summary = gatewayCostSummary([
    { action: 'gateway', status: 'ok', accountId: 'a', modelName: 'old-model', inputTokens: 1000000, outputTokens: 0 }
  ], [account]);
  assert.equal(summary.nominalUsd, 0);
  assert.equal(summary.pricedRequests, 0);
  assert.equal(summary.historical.nominalUsd, 2);
  assert.equal(summary.historical.pricedRequests, 1);
  assert.equal(summary.historicalEstimates, 1);
  assert.equal(summary.breakdown[0].estimated, true);
  assert.equal(summary.breakdown[0].modelName, 'old-model');
});

test('values free credit with the site recharge quote instead of assuming a currency rate', () => {
  const accounts = [{
    id: 'free', usdExchangeRate: 99, topupQuoteConversion: { cnyPerUsd: 3.6 },
    models: [{ name: 'gpt', billing: 'token', inputPriceUsd: 2, outputPriceUsd: 10 }]
  }];
  const summary = gatewayCostSummary([
    { action: 'gateway', status: 'ok', accountId: 'free', modelName: 'gpt', billing: 'token', inputPriceUsd: 2, outputPriceUsd: 10, inputTokens: 1000000, outputTokens: 0 }
  ], accounts);
  assert.equal(summary.nominalUsd, 2);
  assert.equal(summary.referenceCny, 7.2);
  assert.equal(summary.actualCny, 0);
  assert.equal(summary.savedCny, 7.2);
  assert.equal(summary.freeCreditEstimates, 1);
});

test('does not invent RMB value when a site has no recharge conversion', () => {
  const accounts = [{
    id: 'unknown-rate', usdExchangeRate: 7.2,
    models: [{ name: 'gpt', billing: 'token', inputPriceUsd: 2, outputPriceUsd: 10 }]
  }];
  const summary = gatewayCostSummary([
    { action: 'gateway', status: 'ok', accountId: 'unknown-rate', modelName: 'gpt', billing: 'token', inputPriceUsd: 2, outputPriceUsd: 10, inputTokens: 1000000, outputTokens: 0 }
  ], accounts);
  assert.equal(summary.nominalUsd, 2);
  assert.equal(summary.referenceCny, 0);
  assert.equal(summary.savedCny, 0);
  assert.equal(summary.missingConversion, 1);
  assert.equal(summary.breakdown[0].conversionAvailable, false);
});

test('estimates old usage from total tokens when the input/output split is missing', () => {
  const accounts = [{
    id: 'total-only', usdExchangeRate: 7.2,
    models: [{ name: 'gpt', billing: 'token', inputPriceUsd: 2, outputPriceUsd: 10 }]
  }];
  const summary = gatewayCostSummary([
    { action: 'gateway', status: 'ok', accountId: 'total-only', modelName: 'gpt', inputTokens: 0, outputTokens: 0, totalTokens: 500000 }
  ], accounts);
  assert.equal(summary.nominalUsd, 0);
  assert.equal(summary.historical.nominalUsd, 1);
  assert.equal(summary.historical.tokenSplitEstimates, 1);
});

test('reports successful requests that still lack model price or token usage', () => {
  const summary = gatewayCostSummary([
    { action: 'gateway', status: 'ok', accountId: 'no-price', modelName: 'gpt', inputTokens: 1, outputTokens: 1 }
  ], [{ id: 'no-price', models: [] }]);
  assert.equal(summary.totalSuccessful, 1);
  assert.equal(summary.pricedRequests, 0);
  assert.equal(summary.missingPriceOrUsage, 1);
});
