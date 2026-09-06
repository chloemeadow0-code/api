import test from 'node:test';
import assert from 'node:assert/strict';
import { bearerTokenFromHeaders, bearerTokenFromResponseText, browserTargetIdsToClose, createSerialBrowserQueue, normalizeLoginActionText } from '../src/browser.js';
import { browserCheckinOptions, browserLoginOptions, buildModelCatalog, buildPerCallCatalog, classifyCheckin, estimateAccountCalls, estimateRemainingCalls, formatNewApiQuota, formatQuota, hasModelPricing, isAuthenticationError, isExpiredAuthentication, isHtmlResponse, isRateLimitedError, modelApiUrl, modelCategory, modelsFromPricing, pricingAuthType, pricingGroupRatio, pricingRequestAccount, readConfiguredBalance, readRemainingQuota, refreshCookieFromHeaders, retryTwice, serializeAccountRun, shouldPoll, shouldUseBrowserSession, summarizeModelPrice, tokenFromRefresh, valueAt } from '../src/runner.js';

test('reads rotated bearer credentials from refresh responses', () => {
  assert.equal(tokenFromRefresh({ success: true, data: { access_token: 'Bearer fresh-token' } }), 'fresh-token');
  assert.equal(refreshCookieFromHeaders(new Headers({ 'set-cookie': 'new_api_refresh=rotated; Path=/api/user/auth; HttpOnly' }), 'old'), 'new_api_refresh=rotated');
});

test('refreshes bearer auth for nonstandard expired-login responses', () => {
  assert.equal(isExpiredAuthentication(401, {}), true);
  assert.equal(isExpiredAuthentication(403, { message: 'Forbidden' }), true);
  assert.equal(isExpiredAuthentication(400, { error: 'Unauthorized' }), true);
  assert.equal(isExpiredAuthentication(200, { message: 'invalid access token' }), true);
  assert.equal(isExpiredAuthentication(500, { message: 'upstream failed' }), false);
});

test('recognizes login pages returned with a misleading HTTP 200', () => {
  assert.equal(isHtmlResponse('<!DOCTYPE html><html><body>login</body></html>', 'text/html; charset=utf-8'), true);
  assert.equal(isHtmlResponse('{"success":true}', 'application/json'), false);
});

test('uses the persistent server browser as a fallback for generic session accounts', () => {
  assert.equal(shouldUseBrowserSession({ authType: 'cookie', refreshMode: 'browser' }), true);
  assert.equal(shouldUseBrowserSession({ authType: 'bearer', refreshMode: 'browser' }), true);
  assert.equal(shouldUseBrowserSession({ authType: 'cookie', refreshMode: 'http' }), false);
  assert.equal(shouldUseBrowserSession({ refreshMode: 'browser' }, 'newapi'), true);
  assert.equal(shouldUseBrowserSession({ refreshMode: 'browser' }, 'public'), false);
  assert.equal(shouldUseBrowserSession({ refreshMode: 'browser' }, 'generic', true), false);
  assert.equal(shouldUseBrowserSession({ refreshMode: 'browser' }, 'generic', false, false), false);
});

test('browser recovery retries twice and stops immediately after success', async () => {
  let attempts = 0;
  const result = await retryTwice(async () => {
    attempts++;
    if (attempts < 3) throw new Error('temporary login failure');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);

  attempts = 0;
  assert.equal(await retryTwice(async () => { attempts++; return 'ready'; }), 'ready');
  assert.equal(attempts, 1);
});

test('browser recovery never retries HTTP 429 rate limits', async () => {
  let attempts = 0;
  await assert.rejects(() => retryTwice(async () => {
    attempts++;
    throw new Error('Too many requests (HTTP 429)');
  }, 0, error => !isRateLimitedError(error)), /429/);
  assert.equal(attempts, 1);
  assert.equal(isRateLimitedError(new Error('请求过于频繁')), true);
  assert.equal(isAuthenticationError(new Error('Unauthorized (HTTP 401)')), true);
  assert.equal(isAuthenticationError(new Error('upstream unavailable (HTTP 500)')), false);
});

test('reads bearer tokens captured from browser network requests', () => {
  assert.equal(bearerTokenFromHeaders({ Authorization: 'Bearer browser-token' }), 'browser-token');
  assert.equal(bearerTokenFromHeaders({ Authorization: 'Bearer stale-token' }, ['stale-token']), '');
  assert.equal(bearerTokenFromHeaders({ authorization: 'Basic abc' }), '');
});

test('reads access tokens returned directly by browser login responses', () => {
  const token = 'eyJheader.payload.signature';
  assert.equal(bearerTokenFromResponseText(JSON.stringify({ data: { access_token: token } })), token);
  assert.equal(bearerTokenFromResponseText(JSON.stringify({ data: { refresh_token: token } })), '');
  assert.equal(bearerTokenFromResponseText(JSON.stringify({ token: 'short' })), '');
  assert.equal(bearerTokenFromResponseText(JSON.stringify({ accessToken: token }), [token]), '');
});

test('normalizes configured browser login button text', () => {
  assert.equal(normalizeLoginActionText(' Sign up '), 'signup');
  assert.equal(normalizeLoginActionText('SIGN-UP'), 'signup');
});

test('server browser keeps the active page and caps accumulated tabs', () => {
  const targets = [
    { id: 'old-a', type: 'page' },
    { id: 'active', type: 'page' },
    { id: 'old-b', type: 'page' },
    { id: 'old-c', type: 'page' },
    { id: 'worker', type: 'service_worker' }
  ];
  assert.deepEqual(browserTargetIdsToClose(targets, ['active'], 3), ['old-c']);
});

test('server browser operations run one at a time', async () => {
  const queue = createSerialBrowserQueue();
  const events = [];
  const first = queue(async () => {
    events.push('first-start');
    await new Promise(resolve => setTimeout(resolve, 10));
    events.push('first-end');
  });
  const second = queue(async () => {
    events.push('second-start');
    events.push('second-end');
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('loads browser login credentials from scoped environment variables', () => {
  const account = { id: 'a', name: '星期五', baseUrl: 'https://friday.example' };
  const env = { BROWSER_LOGIN_ACCOUNT: '星期五', BROWSER_LOGIN_ACTION: 'Sign in', BROWSER_LOGIN_USERNAME: 'user', BROWSER_LOGIN_PASSWORD: 'secret' };
  assert.deepEqual(browserLoginOptions(account, env), { actionText: 'Sign in', nextActionText: '', username: 'user', password: 'secret', agree: false });
  assert.deepEqual(browserLoginOptions({ ...account, name: '其他' }, env), { actionText: '', nextActionText: '', username: '', password: '', agree: false });
});

test('loads separate browser login credentials for multiple sites', () => {
  const env = { BROWSER_LOGIN_ACCOUNTS_JSON: JSON.stringify({
    '星期五': { action: 'Sign in', nextAction: 'Continue with GitHub', username: 'friday-user', password: 'friday-secret', agree: true },
    'other.example': { action: 'Login', username: 'other-user', password: 'other-secret' }
  }) };
  assert.deepEqual(browserLoginOptions({ name: '星期五', baseUrl: 'https://friday.example' }, env), { actionText: 'Sign in', nextActionText: 'Continue with GitHub', username: 'friday-user', password: 'friday-secret', agree: true });
  assert.deepEqual(browserLoginOptions({ name: '其他', baseUrl: 'https://other.example' }, env), { actionText: 'Login', nextActionText: '', username: 'other-user', password: 'other-secret', agree: false });
});

test('loads separate browser Turnstile check-in settings', () => {
  const env = { BROWSER_CHECKIN_ACCOUNTS_JSON: JSON.stringify({
    'Tabi': { action: 'Check in', path: '/profile' },
    'other.example': { action: '签到', turnstile: false }
  }) };
  assert.deepEqual(browserCheckinOptions({ name: 'Tabi', baseUrl: 'https://tabi.example' }, env), { actionText: 'Check in', path: '/profile', turnstile: true });
  assert.deepEqual(browserCheckinOptions({ name: '其他', baseUrl: 'https://other.example' }, env), { actionText: '签到', path: '/', turnstile: false });
  assert.deepEqual(browserCheckinOptions({ name: '默认', baseUrl: 'https://default.example' }, { BROWSER_CHECKIN_ACCOUNTS_JSON: '{"默认":{}}' }), { actionText: 'Check in', path: '/', turnstile: true });
  assert.equal(browserCheckinOptions({ name: '未配置', baseUrl: 'https://none.example' }, env), null);
});

test('serializes concurrent balance and check-in runs for the same account', async () => {
  const events = []; let releaseFirst;
  const first = serializeAccountRun('same-site', async () => {
    events.push('first-start');
    await new Promise(resolve => { releaseFirst = resolve; });
    events.push('first-end');
  });
  const second = serializeAccountRun('same-site', async () => { events.push('second-start'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start']);
});

test('reads nested balance fields', () => {
  assert.equal(valueAt({ data: { points: 120 } }, 'data.points'), 120);
});

test('recognizes pricing returned by the panel models endpoint', () => {
  assert.equal(hasModelPricing({ data: [{ model_name: 'gpt-x', model_ratio: 1 }] }), true);
  assert.equal(hasModelPricing({ data: [{ id: 'gpt-x', object: 'model' }] }), false);
  assert.equal(hasModelPricing('<!doctype html>'), false);
});

test('formats New API quota units', () => {
  assert.equal(formatNewApiQuota(750000), '$1.50');
  assert.equal(formatNewApiQuota('bad'), '—');
});

test('classifies check-in business results', () => {
  assert.deepEqual(classifyCheckin({ success: true, message: '签到成功' }), { status: 'ok', message: '签到成功' });
  assert.deepEqual(classifyCheckin({ success: false, message: '今日已签到' }), { status: 'already', message: '今日已签到' });
  assert.deepEqual(classifyCheckin({ success: false, message: 'Checked in' }), { status: 'already', message: 'Checked in' });
  assert.throws(() => classifyCheckin({ success: false, message: 'Token 无效' }), /Token 无效/);
});

test('formats quota using each site currency settings', () => {
  const config = { data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 7.2 } };
  assert.equal(formatQuota(1000000, config, 'auto'), '¥14.40');
  assert.equal(formatQuota(1000000, config, 'usd'), '$2.00');
  assert.equal(formatQuota(1000000, config, 'raw'), '1,000,000');
});

test('supports panels that keep remaining credit in total quota', () => {
  assert.equal(readRemainingQuota({ data: { quota: 0, total_quota: 55467567, used_quota: 0 } }), 55467567);
  assert.equal(readRemainingQuota({ data: { quota: 100, total_quota: 1000, used_quota: 400 } }), 100);
  assert.equal(readRemainingQuota({ data: { quota: 0, total_quota: 1000, used_quota: 1000 } }), 0);
});

test('falls back to New API quota when a custom balance field misses', () => {
  const response = { data: { quota: 62500000, used_quota: 0 }, success: true };
  assert.equal(readConfiguredBalance(response, 'balance'), 62500000);
  assert.equal(readConfiguredBalance(response, 'data.quota'), 62500000);
});

test('distinguishes per-call and token model pricing', () => {
  assert.equal(summarizeModelPrice({ model_name: 'image', quota_type: 1, model_price: 0.03 }).text, '$0.0300 / 次');
  assert.equal(summarizeModelPrice({ model_name: 'chat', quota_type: 0, model_ratio: 1.25, completion_ratio: 4 }, 500000).text, '输入 $2.5000 / 1M · 输出 $10.0000 / 1M');
});

test('applies the current account group ratio to model prices', () => {
  const models = { data: [{ id: 'gpt-free-call' }, { id: 'gpt-free-token' }] };
  const pricing = {
    data: [
      { model_name: 'gpt-free-call', quota_type: 1, model_price: 0.02 },
      { model_name: 'gpt-free-token', quota_type: 0, model_ratio: 2, completion_ratio: 4 }
    ],
    group_ratio: { default: 1, free: 0 }
  };
  assert.equal(pricingGroupRatio(pricing, 'free'), 0);
  const catalog = buildModelCatalog(models, pricing, 500000, 'free');
  assert.equal(catalog.find(model => model.name === 'gpt-free-call').price, 0);
  assert.match(catalog.find(model => model.name === 'gpt-free-call').text, /\$0\.0000 \/ 次 · 分组倍率 0/);
  assert.match(catalog.find(model => model.name === 'gpt-free-token').text, /输入 \$0\.0000.*分组倍率 0/);
});

test('pricing reuses each panel login authentication', () => {
  assert.equal(pricingAuthType({ panelType: 'generic' }), 'generic');
  assert.equal(pricingAuthType({ panelType: 'auto' }), 'newapi');
  assert.equal(pricingAuthType({ panelType: 'newapi' }), 'newapi');
});

test('pricing can use a dedicated cookie without changing balance auth', () => {
  const account = { authType: 'bearer', credential: 'bearer-secret', pricingCookie: 'encrypted-cookie' };
  const pricing = pricingRequestAccount(account);
  assert.equal(pricing.authType, 'cookie');
  assert.equal(pricing.credential, 'encrypted-cookie');
  assert.equal(account.authType, 'bearer');
});

test('direct model API accepts both host and v1 base addresses', async () => {
  assert.equal((await modelApiUrl({ baseUrl: 'https://example.com' }, '/v1/models')).href, 'https://example.com/v1/models');
  assert.equal((await modelApiUrl({ baseUrl: 'https://site.example', modelBaseUrl: 'https://example.com/v1' }, '/v1/models')).href, 'https://example.com/v1/models');
});

test('only sites with an enabled tag participate in polling', () => {
  assert.equal(shouldPoll({ enabled: true, tags: ['常用'] }, ['常用']), true);
  assert.equal(shouldPoll({ enabled: true, tags: ['备用'] }, ['常用']), false);
  assert.equal(shouldPoll({ enabled: true, tags: [] }, ['常用']), false);
  assert.equal(shouldPoll({ enabled: false, tags: ['常用'] }, ['常用']), false);
});

test('categorizes and keeps only available per-call models', () => {
  const models = { data: [{ id: 'gpt-image-1' }, { id: 'gemini-2.5-pro' }, { id: 'token-model' }] };
  const pricing = { data: [
    { model_name: 'gpt-image-1', quota_type: 1, model_price: 0.04 },
    { model_name: 'gemini-2.5-pro', quota_type: 1, model_price: 0.02 },
    { model_name: 'token-model', quota_type: 0, model_ratio: 1 }
  ] };
  assert.deepEqual(buildPerCallCatalog(models, pricing).map(x => [x.name, x.category]), [['gemini-2.5-pro', 'Gemini'], ['gpt-image-1', 'GPT']]);
  assert.equal(modelCategory('claude-3-opus'), 'Claude');
});

test('recognizes common token-priced model families', () => {
  assert.equal(modelCategory('zai-org/GLM-5.1-FP8'), 'GLM');
  assert.equal(modelCategory('o-kimi-k3'), 'Kimi');
  assert.equal(modelCategory('mistral/devstral-latest'), 'Mistral');
  assert.equal(modelCategory('gmicloud/minimax-m2.7'), 'MiniMax');
  assert.equal(modelCategory('nvidia/nemotron-3-ultra'), 'Nemotron');
  assert.equal(modelCategory('google/gemma-4-31b-it'), 'Gemma');
  assert.equal(modelCategory('stepfun/step-3.7-flash'), 'Step');
  assert.equal(modelCategory('cohere/north-mini-code'), 'Cohere');
});

test('supports custom quota-per-call pricing responses', () => {
  const models = { data: [{ id: 'gemini-2.5-pro' }, { id: 'token-model' }] };
  const pricing = { data: { models: [
    { name: 'gemini-2.5-pro', priceLabel: '200 额度/次', priceType: 'call', priceValue: 200, quotaType: 1 },
    { name: 'token-model', priceLabel: '3 额度/1K tokens', priceType: 'token', priceValue: 3, quotaType: 0 }
  ] } };
  assert.deepEqual(buildPerCallCatalog(models, pricing), [{ name: 'gemini-2.5-pro', category: 'Gemini', price: 200, priceUnit: 'quota', text: '200 额度/次' }]);
});

test('includes token-priced models in the amount catalog', () => {
  const models = { data: [{ id: 'gpt-5.4' }] };
  const pricing = { data: { models: [{ name: 'gpt-5.4', priceLabel: '5 额度/1K tokens', priceType: 'token', priceValue: 5, quotaType: 0 }] } };
  assert.deepEqual(buildModelCatalog(models, pricing), [{ name: 'gpt-5.4', category: 'GPT', billing: 'token', price: 5, text: '5 额度/1K tokens' }]);
});

test('keeps models selectable when the panel has no pricing endpoint', () => {
  assert.deepEqual(buildModelCatalog({ data: [{ id: 'gpt-direct' }] }, { data: [] }), [{
    name: 'gpt-direct', category: 'GPT', billing: 'token', price: null, text: '价格未知 · 可正常选择和测试'
  }]);
});

test('builds the available model list from pricing when v1 models is unauthorized', () => {
  assert.deepEqual(modelsFromPricing({ data: [{ model_name: 'gpt-priced' }, { model_name: 'claude-priced' }] }), {
    data: [{ id: 'gpt-priced' }, { id: 'claude-priced' }]
  });
});

test('estimates remaining uses for per-call models', () => {
  assert.equal(estimateRemainingCalls(24495, { billing: 'call', price: 200, priceUnit: 'quota' }), 122);
  assert.equal(estimateRemainingCalls(5000000, { billing: 'call', price: 2, priceUnit: 'usd' }, 500000), 5);
  assert.equal(estimateRemainingCalls(0, { billing: 'call', price: 0, priceUnit: 'quota' }), 'unlimited');
  assert.equal(estimateRemainingCalls(null, { billing: 'call', price: 200, priceUnit: 'quota' }), null);
  assert.equal(estimateRemainingCalls(24495, { billing: 'token', price: 200, priceUnit: 'quota' }), null);
  assert.equal(estimateAccountCalls({ balance: '24,495.00', quotaPerUnit: 1 }, { billing: 'call', price: 200, priceUnit: 'quota' }), 122);
  assert.equal(estimateAccountCalls({ balance: '$10.00', quotaPerUnit: 500000 }, { billing: 'call', price: 2, priceUnit: 'usd' }), 5);
});
