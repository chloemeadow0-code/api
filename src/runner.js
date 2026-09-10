import dns from 'node:dns/promises';
import net from 'node:net';
import { decrypt, encrypt, mutateStore, readStore } from './store.js';
import { accessTokenInBrowser, checkinInBrowser, refreshInBrowser, requestInBrowser } from './browser.js';
import { readInviteCount, recordInviteCount } from './invite-alerts.js';
import { fallbackTopupQuoteAmount, minimumTopupFromError, rechargeConversionFromPublicPrice, rechargeConversionFromQuote, rechargeConversionFromTopups, topupQuoteRequestAmount } from './cost.js';

const accountRunQueues = new Map();

export function serializeAccountRun(id, task) {
  const previous = accountRunQueues.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  accountRunQueues.set(id, current);
  return current.finally(() => {
    if (accountRunQueues.get(id) === current) accountRunQueues.delete(id);
  });
}

function privateIp(ip) {
  return ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip.startsWith('169.254.') || ip.startsWith('fc') || ip.startsWith('fd');
}

export async function safeUrl(base, endpoint) {
  const url = new URL(endpoint || '/', base);
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.hostname === 'localhost')) {
    throw new Error('只允许 HTTPS 站点');
  }
  if (net.isIP(url.hostname) && privateIp(url.hostname)) throw new Error('不允许访问内网地址');
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(x => privateIp(x.address))) throw new Error('站点解析到内网地址');
  return url;
}

export function valueAt(obj, dotted) {
  return dotted.split('.').reduce((v, k) => v?.[k], obj);
}

export function tokenFromRefresh(data) {
  if (!data || typeof data !== 'object') return '';
  for (const key of ['access_token', 'accessToken', 'token']) {
    if (typeof data[key] === 'string' && data[key]) return data[key].replace(/^Bearer\s+/i, '');
  }
  for (const value of Object.values(data)) {
    const found = tokenFromRefresh(value);
    if (found) return found;
  }
  return '';
}

export function refreshCookieFromHeaders(headers, fallback = '') {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') || ''];
  const match = values.join(',').match(/(?:^|[,;]\s*)(new_api_refresh=[^;,\s]+)/i);
  return match?.[1] || fallback;
}

async function refreshBearer(account) {
  if (account.authType !== 'bearer' || !account.refreshPath) return false;
  if (account.refreshMode === 'browser') {
    const data = await refreshInBrowser(account.baseUrl, account.refreshPath);
    const token = tokenFromRefresh(data);
    if (!token) throw new Error('服务器浏览器刷新成功，但响应中没有新的 Access Token');
    account.credential = encrypt(token);
    // Browser-mode requests prefer browserAccessToken. Replace it too, or the
    // freshly refreshed credential is immediately overwritten by the expired
    // browser token on the retry.
    account.browserAccessToken = encrypt(token);
    return true;
  }
  if (!account.refreshCookie) return false;
  const url = await safeUrl(account.baseUrl, account.refreshPath);
  const currentCookie = decrypt(account.refreshCookie);
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json, text/plain, */*', cookie: currentCookie, origin: account.baseUrl, referer: `${account.baseUrl}/` },
    redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`自动刷新失败：${data?.message || data?.error || `HTTP ${response.status}`} (HTTP ${response.status})`);
  const token = tokenFromRefresh(data) || String(response.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('刷新接口成功，但响应中没有新的 Access Token');
  account.credential = encrypt(token);
  account.refreshCookie = encrypt(refreshCookieFromHeaders(response.headers, currentCookie));
  return true;
}

export function isExpiredAuthentication(status, data) {
  const message = String(data?.error?.message || data?.error || data?.message || data?.msg || '');
  return status === 401 || status === 403 || /unauthorized|invalid\s+(access\s+)?token|not\s+logged\s+in|登录已?失效|未登录|请先登录/i.test(message);
}

export function isHtmlResponse(text, contentType = '') {
  return /text\/html/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(String(text));
}

export function shouldUseBrowserSession(account, panelType = 'generic', retried = false, allowBrowserRecovery = true) {
  return allowBrowserRecovery && !retried && panelType !== 'public' && account.refreshMode === 'browser';
}

export function isRateLimitedError(error) {
  return /(?:HTTP\s*)?429\b|too many requests|rate.?limit|请求过于频繁|访问过于频繁|频率限制/i.test(String(error?.message || error || ''));
}

export function isAuthenticationError(error) {
  return /\b(?:401|403)\b|unauthorized|invalid\s+(access\s+)?token|not\s+logged\s+in|登录已?失效|未登录|请先登录/i.test(String(error?.message || error || ''));
}

export async function retryTwice(task, delayMs = 0, shouldRetry = () => true) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await task(attempt); } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) throw error;
    }
    if (attempt < 1 && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw lastError;
}

export function browserLoginOptions(account, env = process.env) {
  const enabled = value => value === true || /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
  let hostname = '';
  try { hostname = new URL(account.baseUrl).hostname.toLowerCase(); } catch {}
  const identities = [account.id, account.name, account.baseUrl, hostname].map(value => String(value || '').trim().toLowerCase());
  try {
    const configured = JSON.parse(String(env.BROWSER_LOGIN_ACCOUNTS_JSON || ''));
    if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
      const entry = Object.entries(configured).find(([key]) => identities.includes(String(key).trim().toLowerCase()));
      if (entry && entry[1] && typeof entry[1] === 'object') {
        const login = entry[1];
        return {
          actionText: String(login.action || login.actionText || account.browserLoginAction || ''),
          nextActionText: String(login.nextAction || login.nextActionText || login.providerAction || ''),
          username: String(login.username || ''),
          password: String(login.password || ''),
          agree: enabled(login.agree)
        };
      }
    }
  } catch {}
  const selector = String(env.BROWSER_LOGIN_ACCOUNT || '').trim().toLowerCase();
  const matched = !selector || identities.includes(selector);
  return {
    actionText: matched ? String(env.BROWSER_LOGIN_ACTION || account.browserLoginAction || '') : account.browserLoginAction || '',
    nextActionText: matched ? String(env.BROWSER_LOGIN_NEXT_ACTION || '') : '',
    username: matched ? String(env.BROWSER_LOGIN_USERNAME || '') : '',
    password: matched ? String(env.BROWSER_LOGIN_PASSWORD || '') : '',
    agree: matched && enabled(env.BROWSER_LOGIN_AGREE)
  };
}

export function browserCheckinOptions(account, env = process.env) {
  const enabled = value => value === true || /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
  let hostname = '';
  try { hostname = new URL(account.baseUrl).hostname.toLowerCase(); } catch {}
  const identities = [account.id, account.name, account.baseUrl, hostname].map(value => String(value || '').trim().toLowerCase());
  try {
    const configured = JSON.parse(String(env.BROWSER_CHECKIN_ACCOUNTS_JSON || ''));
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return null;
    const entry = Object.entries(configured).find(([key]) => identities.includes(String(key).trim().toLowerCase()));
    if (!entry) return null;
    const value = entry[1];
    const checkin = value && typeof value === 'object' ? value : {};
    return {
      actionText: String(checkin.action || checkin.actionText || 'Check in'),
      path: String(checkin.path || '/'),
      turnstile: checkin.turnstile === undefined ? true : enabled(checkin.turnstile)
    };
  } catch { return null; }
}

async function runCheckin(account, endpoint, panelType) {
  const browserOptions = browserCheckinOptions(account);
  if (browserOptions) return classifyCheckin(await checkinInBrowser(account.baseUrl, endpoint, browserOptions));
  return classifyCheckin(await call(account, endpoint, account.checkinMethod || 'POST', panelType));
}

function browserAuthHeaders(account, panelType, includeCredential = false) {
  const headers = panelType === 'newapi' ? { 'new-api-user': String(account.userId || '') } : {};
  if (!includeCredential) return headers;
  if (account.browserAccessToken) return { ...headers, authorization: `Bearer ${decrypt(account.browserAccessToken)}` };
  const token = panelType === 'generic' ? decrypt(account.credential) : '';
  if (!token) return headers;
  if (account.authType === 'bearer') return { authorization: `Bearer ${token}` };
  if (account.authType === 'header') return { [account.headerName || 'authorization']: token };
  return headers;
}

async function recoverWithBrowserOnce(account, endpoint, method, panelType, body, rejectedTokens = new Set()) {
  let browserError;
  try {
    const ignoredTokens = [
      account.browserAccessToken ? decrypt(account.browserAccessToken) : '',
      panelType === 'generic' && account.credential ? decrypt(account.credential) : '',
      ...rejectedTokens
    ].filter(Boolean);
    const token = await accessTokenInBrowser(account.baseUrl, { ...browserLoginOptions(account), ignoredTokens });
    if (token) {
      const previousBrowserAccessToken = account.browserAccessToken;
      account.browserAccessToken = encrypt(token);
      try {
        const data = await requestInBrowser(account.baseUrl, endpoint, method, browserAuthHeaders(account, panelType, true), body);
        mutateStore(latest => {
          const saved = latest.accounts.find(item => item.id === account.id);
          if (saved) saved.browserAccessToken = account.browserAccessToken;
        });
        return { data };
      } catch (error) {
        account.browserAccessToken = previousBrowserAccessToken;
        if (isAuthenticationError(error)) rejectedTokens.add(token);
        if (isRateLimitedError(error)) throw error;
        throw error;
      }
    }
  } catch (error) {
    if (isRateLimitedError(error)) throw error;
    browserError = error;
  }
  try {
    const data = await requestInBrowser(account.baseUrl, endpoint, method, browserAuthHeaders(account, panelType), body);
    return { data };
  } catch (error) {
    if (isRateLimitedError(error)) throw error;
    browserError = error;
  }
  if ((account.browserAccessToken || (panelType === 'generic' && account.credential)) && (panelType === 'newapi' || ['bearer', 'header'].includes(account.authType))) {
    try {
      const data = await requestInBrowser(account.baseUrl, endpoint, method, browserAuthHeaders(account, panelType, true), body);
      return { data };
    } catch (error) {
      if (isRateLimitedError(error)) throw error;
      browserError = error;
    }
  }
  throw browserError || new Error('服务器浏览器未取得可用登录态');
}

async function recoverAuthentication(account, endpoint, method, panelType, retried, body = '', options = {}) {
  if (retried || panelType === 'public') return null;
  const allowBrowserRecovery = options.allowBrowserRecovery !== false;
  let refreshError = null;
  if (panelType === 'generic' && (allowBrowserRecovery || account.refreshMode !== 'browser')) {
    try {
      if (await refreshBearer(account)) {
        if (account.refreshMode !== 'browser') return { retry: true };
        try {
          const data = await requestInBrowser(account.baseUrl, endpoint, method, browserAuthHeaders(account, panelType, true), body);
          return { data };
        } catch (error) {
          if (isRateLimitedError(error)) throw error;
          refreshError = error;
        }
      }
    } catch (error) {
      if (isRateLimitedError(error)) throw error;
      refreshError = error;
    }
  }
  if (shouldUseBrowserSession(account, panelType, retried, allowBrowserRecovery)) {
    const rejectedTokens = new Set();
    try {
      return await retryTwice(() => recoverWithBrowserOnce(account, endpoint, method, panelType, body, rejectedTokens), 600, error => !isRateLimitedError(error));
    } catch (error) {
      if (isRateLimitedError(error)) throw new Error(`站点请求过于频繁 (HTTP 429)，已停止自动重试，请稍后再试`);
      const details = refreshError ? `；刷新接口：${refreshError.message}` : '';
      throw new Error(`服务器浏览器登录态无效，最多尝试两次后仍未取得可用令牌，请点击“浏览器登录”重新登录：${error.message}${details}`);
    }
  }
  if (refreshError) throw refreshError;
  return null;
}

async function call(account, endpoint, method, panelType = 'generic', retried = false, body = '', options = {}) {
  const url = await safeUrl(account.baseUrl, endpoint);
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    referer: `${account.baseUrl}/`,
    'user-agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36 Edg/136.0.0.0'
  };
  const token = decrypt(account.credential);
  if (panelType === 'newapi') {
    headers.cookie = token;
    headers['new-api-user'] = String(account.userId || '');
  } else if (panelType !== 'public') {
    if (account.authType === 'bearer') headers.authorization = `Bearer ${token}`;
    if (account.authType === 'cookie') headers.cookie = token;
    if (account.authType === 'header') headers[account.headerName || 'authorization'] = token;
  }
  if (account.refreshMode === 'browser' && account.browserAccessToken) headers.authorization = `Bearer ${decrypt(account.browserAccessToken)}`;
  const requestBody = !['GET', 'HEAD'].includes(method) && body ? body : undefined;
  if (requestBody) headers['content-type'] = 'application/json';
  const response = await fetch(url, { method, headers, body: requestBody, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch {
    const html = isHtmlResponse(text, response.headers.get('content-type') || '');
    const loginRedirect = response.status >= 300 && response.status < 400;
    if (html || loginRedirect) {
      const recovered = await recoverAuthentication(account, url.href, method, panelType, retried, requestBody, options);
      if (recovered?.retry) return call(account, endpoint, method, panelType, true, body, options);
      if (recovered && 'data' in recovered) return recovered.data;
    }
    throw new Error(html ? `接口返回网页而不是 JSON (HTTP ${response.status})` : loginRedirect ? `接口重定向到登录页面 (HTTP ${response.status})` : text.slice(0, 200) || `接口没有返回 JSON (HTTP ${response.status})`);
  }
  if (isExpiredAuthentication(response.status, data)) {
    const recovered = await recoverAuthentication(account, url.href, method, panelType, retried, requestBody, options);
    if (recovered?.retry) return call(account, endpoint, method, panelType, true, body, options);
    if (recovered && 'data' in recovered) return recovered.data;
    const message = data?.error?.message || data?.error || data?.message || data?.msg || 'Unauthorized';
    throw new Error(`${message} (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.error || data?.message || data?.msg;
    throw new Error(message ? `${message} (HTTP ${response.status})` : `HTTP ${response.status}`);
  }
  return data;
}

export function formatNewApiQuota(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${(amount / 500000).toFixed(2)}` : '—';
}

function findConfig(data, names) {
  if (!data || typeof data !== 'object') return undefined;
  for (const name of names) if (data[name] !== undefined) return data[name];
  for (const value of Object.values(data)) {
    const found = findConfig(value, names);
    if (found !== undefined) return found;
  }
}

export function formatQuota(value, config = {}, preference = 'auto') {
  const quota = Number(value);
  if (!Number.isFinite(quota)) return '—';
  const quotaPerUnit = Number(findConfig(config, ['quota_per_unit', 'quotaPerUnit', 'QuotaPerUnit'])) || 500000;
  const configuredType = String(findConfig(config, ['quota_display_type', 'quotaDisplayType', 'QuotaDisplayType']) || 'USD').toUpperCase();
  const type = preference === 'auto' ? configuredType : String(preference).toUpperCase();
  if (type === 'TOKENS' || type === 'RAW') return Math.round(quota).toLocaleString('zh-CN');
  const usd = quota / quotaPerUnit;
  if (type === 'CNY') {
    const rate = Number(findConfig(config, ['usd_exchange_rate', 'usdExchangeRate', 'USDExchangeRate'])) || 7.2;
    return `¥${(usd * rate).toFixed(2)}`;
  }
  return `$${usd.toFixed(2)}`;
}

export function readRemainingQuota(data) {
  const quota = Number(valueAt(data, 'data.quota'));
  const total = Number(valueAt(data, 'data.total_quota'));
  const used = Number(valueAt(data, 'data.used_quota'));
  if (Number.isFinite(quota) && quota > 0) return quota;
  if (Number.isFinite(total) && Number.isFinite(used) && total > used) return total - used;
  return Number.isFinite(quota) ? quota : undefined;
}

export function readConfiguredBalance(data, field = 'balance') {
  const configured = valueAt(data, field);
  if (configured !== undefined && configured !== null && configured !== '') return configured;
  return readRemainingQuota(data);
}

export function pricingGroupRatio(pricingResponse, userGroup = '') {
  const ratios = pricingResponse?.group_ratio || pricingResponse?.data?.group_ratio;
  if (!ratios || typeof ratios !== 'object' || Array.isArray(ratios)) return 1;
  const group = String(userGroup || '').trim();
  if (group && Object.hasOwn(ratios, group)) {
    const ratio = Number(ratios[group]);
    if (Number.isFinite(ratio) && ratio > 0) return ratio;
  }
  const entries = Object.entries(ratios).filter(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0);
  if (entries.length === 1) return Number(entries[0][1]);
  if (Object.hasOwn(ratios, 'default')) {
    const ratio = Number(ratios.default);
    if (Number.isFinite(ratio) && ratio > 0) return ratio;
  }
  return 1;
}

function groupRatioSuffix(groupRatio) {
  return groupRatio === 1 ? '' : ` · 分组倍率 ${groupRatio}`;
}

export function summarizeModelPrice(item, quotaPerUnit = 500000, groupRatio = 1) {
  if (!item) throw new Error('定价列表中找不到这个模型');
  if (Number(item.quota_type) === 1) {
    const price = Number(item.model_price) * groupRatio;
    if (!Number.isFinite(price)) throw new Error('该模型没有可用的按次价格');
    return { type: 'per_call', text: `$${price.toFixed(4)} / 次${groupRatioSuffix(groupRatio)}`, model: item.model_name, price, priceUnit: item.price_unit || 'usd' };
  }
  const ratio = Number(item.model_ratio) * groupRatio;
  const completion = Number(item.completion_ratio || 1);
  if (!Number.isFinite(ratio)) throw new Error('该模型没有可用的 Token 价格');
  const input = ratio * 1000000 / quotaPerUnit;
  const output = input * completion;
  return { type: 'tokens', text: `输入 $${input.toFixed(4)} / 1M · 输出 $${output.toFixed(4)} / 1M${groupRatioSuffix(groupRatio)}`, model: item.model_name };
}

export function pricingAuthType(account) {
  return account.panelType === 'generic' ? 'generic' : 'newapi';
}

export function pricingRequestAccount(account) {
  return account.pricingCookie ? { ...account, authType: 'cookie', credential: account.pricingCookie } : account;
}

export function modelCategory(name) {
  const value = String(name).toLowerCase();
  if (/gemini/.test(value)) return 'Gemini';
  if (/gemma/.test(value)) return 'Gemma';
  if (/claude/.test(value)) return 'Claude';
  if (/deepseek/.test(value)) return 'DeepSeek';
  if (/qwen|qwq/.test(value)) return 'Qwen';
  if (/gpt|(^|[-_])o[134]([\-_.]|$)/.test(value)) return 'GPT';
  if (/grok/.test(value)) return 'Grok';
  if (/(^|[/_-])glm([/_.-]|$)|zai-org|z-ai/.test(value)) return 'GLM';
  if (/kimi|moonshot/.test(value)) return 'Kimi';
  if (/mistral|mixtral|codestral|devstral|ministral/.test(value)) return 'Mistral';
  if (/minimax/.test(value)) return 'MiniMax';
  if (/nemotron|nvidia/.test(value)) return 'Nemotron';
  if (/stepfun|(^|[/_-])step[-_.]/.test(value)) return 'Step';
  if (/cohere|command-r|north-mini/.test(value)) return 'Cohere';
  if (/llama|meta\//.test(value)) return 'Llama';
  if (/sora|video|veo/.test(value)) return '视频';
  if (/image|dall-e|flux|midjourney/.test(value)) return '图像';
  return '其他';
}

export async function modelApiUrl(account, endpoint) {
  const base = String(account.modelBaseUrl || account.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('请填写模型 API 地址');
  const suffix = /\/v1$/i.test(base) ? String(endpoint).replace(/^\/v1/i, '') : endpoint;
  return safeUrl(`${base}/`, String(suffix).replace(/^\//, ''));
}

async function callApiKey(account, endpoint, options = {}) {
  if (!account.apiKey) throw new Error('请先填写该站 API Key');
  const url = await modelApiUrl(account, endpoint);
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { authorization: `Bearer ${decrypt(account.apiKey)}`, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'SitePointsHub/1.0' },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs || 20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `模型接口 HTTP ${response.status}`);
  return data;
}

export function buildModelCatalog(modelsResponse, pricingResponse, quotaPerUnit = 500000, userGroup = '') {
  const available = new Set((modelsResponse?.data || []).map(x => typeof x === 'string' ? x : x.id).filter(Boolean));
  const customPricing = Array.isArray(pricingResponse?.data?.models);
  const groupRatio = customPricing ? 1 : pricingGroupRatio(pricingResponse, userGroup);
  const prices = customPricing
    ? pricingResponse.data.models.map(x => ({
      model_name: x.name,
      quota_type: x.quotaType,
      price_type: x.priceType,
      model_price: x.priceValue,
      price_label: x.priceLabel,
      price_unit: 'quota'
    }))
    : Array.isArray(pricingResponse?.data) ? pricingResponse.data : Array.isArray(pricingResponse) ? pricingResponse : [];
  const priced = prices
    .filter(x => available.has(x.model_name))
    .map(x => {
      const perCall = Number(x.quota_type) === 1 || x.price_type === 'call';
      if (perCall) {
        if (!Number.isFinite(Number(x.model_price))) return null;
        const price = Number(x.model_price) * groupRatio;
        return { name: x.model_name, category: modelCategory(x.model_name), billing: 'call', price, priceUnit: x.price_unit || 'usd', text: x.price_label || `$${price.toFixed(4)} / 次${groupRatioSuffix(groupRatio)}` };
      }
      if (x.price_label && customPricing) return { name: x.model_name, category: modelCategory(x.model_name), billing: 'token', price: Number(x.model_price), text: x.price_label };
      const ratio = Number(x.model_ratio) * groupRatio;
      if (!Number.isFinite(ratio)) return null;
      const input = ratio * 1000000 / quotaPerUnit;
      const output = input * Number(x.completion_ratio || 1);
      return {
        name: x.model_name, category: modelCategory(x.model_name), billing: 'token', price: ratio,
        inputPriceUsd: input, outputPriceUsd: output,
        text: `输入 $${input.toFixed(4)} / 1M · 输出 $${output.toFixed(4)} / 1M${groupRatioSuffix(groupRatio)}`
      };
    })
    .filter(Boolean);
  const pricedNames = new Set(priced.map(model => model.name));
  const unpriced = [...available]
    .filter(name => !pricedNames.has(name))
    .map(name => ({ name, category: modelCategory(name), billing: 'token', price: null, text: '价格未知 · 可正常选择和测试' }));
  return [...priced, ...unpriced].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export function hasModelPricing(response) {
  const list = Array.isArray(response?.data?.models) ? response.data.models : Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
  return list.some(item => item && typeof item === 'object' && (item.model_price !== undefined || item.model_ratio !== undefined || item.quota_type !== undefined || item.priceValue !== undefined || item.priceLabel !== undefined));
}

export function modelsFromPricing(response) {
  const list = Array.isArray(response?.data?.models) ? response.data.models : Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
  return { data: list.map(item => ({ id: item?.model_name || item?.name })).filter(item => item.id) };
}

async function loadModelPricing(account, auth, options = {}) {
  const paths = ['/api/pricing', '/api/models/pricing', '/api/models']; const errors = [];
  for (const path of paths) {
    try {
      const response = await call(account, path, 'GET', auth, false, '', options);
      if (hasModelPricing(response)) return response;
      errors.push(`${path}: JSON 中没有价格字段`);
    } catch (error) { errors.push(`${path}: ${error.message}`); }
  }
  throw new Error(`没有找到可用的模型价格接口。已尝试：${errors.join('；')}`);
}

export function estimateRemainingCalls(balanceRaw, model, quotaPerUnit = 500000) {
  if (!model || model.billing !== 'call') return null;
  const price = Number(model.price);
  if (price === 0) return 'unlimited';
  if (balanceRaw === null || balanceRaw === undefined || balanceRaw === '') return null;
  const balance = Number(balanceRaw);
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(balance)) return null;
  const available = model.priceUnit === 'quota' ? balance : balance / (Number(quotaPerUnit) || 500000);
  return Math.max(0, Math.floor(available / price));
}

export function estimateAccountCalls(account, model) {
  const direct = estimateRemainingCalls(account?.balanceRaw, model, account?.quotaPerUnit);
  if (direct !== null) return direct;
  const shown = String(account?.balance ?? '').replace(/,/g, '');
  const amount = Number(shown.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(amount)) return null;
  const quotaPerUnit = Number(account?.quotaPerUnit) || 500000;
  if (model?.priceUnit === 'quota') {
    if (shown.includes('$')) return estimateRemainingCalls(amount * quotaPerUnit, model, quotaPerUnit);
    if (shown.includes('¥')) return null;
    if (account?.currency === 'raw' || account?.currency === 'tokens') return estimateRemainingCalls(amount, model, quotaPerUnit);
    return estimateRemainingCalls(amount * quotaPerUnit, model, quotaPerUnit);
  }
  if (model?.priceUnit === 'usd' && (shown.includes('$') || account?.currency === 'usd')) {
    return estimateRemainingCalls(amount * quotaPerUnit, model, quotaPerUnit);
  }
  return null;
}

export function buildPerCallCatalog(modelsResponse, pricingResponse) {
  return buildModelCatalog(modelsResponse, pricingResponse).filter(x => x.billing === 'call').map(({ billing, ...x }) => x);
}

async function refreshModelCatalogUnlocked(id, options = {}) {
  const db = readStore(); const account = db.accounts.find(x => x.id === id);
  if (!account) throw new Error('账户不存在');
  const pricingAccount = pricingRequestAccount(account); const auth = pricingAuthType(pricingAccount);
  let models = null; let modelsError = '';
  try { models = await callApiKey(account, '/v1/models'); }
  catch (error) { modelsError = error.message; }
  let pricing = { data: [] };
  try {
    pricing = await loadModelPricing(pricingAccount, auth, options);
    account.modelPricingError = '';
  } catch (error) {
    account.modelPricingError = error.message;
    if (options.requirePricing) throw error;
  }
  if (!models) models = modelsFromPricing(pricing);
  if (!models.data?.length) throw new Error(`无法拉取模型：${modelsError || '模型列表和价格列表均为空'}`);
  let status = {};
  try { status = await call(account, '/api/status', 'GET', 'public'); } catch {}
  if (!account.userGroup) {
    try {
      const profile = account.panelType === 'generic' && account.balancePath
        ? await call(account, account.balancePath, account.balanceMethod || 'GET', 'generic', false, account.balanceBody ? decrypt(account.balanceBody) : '', options)
        : await call(account, '/api/user/self', 'GET', 'newapi', false, '', options);
      account.userGroup = String(valueAt(profile, 'data.group') ?? valueAt(profile, 'user.group') ?? valueAt(profile, 'group') ?? '').trim();
    } catch {}
  }
  const quotaPerUnit = Number(findConfig(status, ['quota_per_unit', 'quotaPerUnit', 'QuotaPerUnit'])) || 500000;
  account.quotaPerUnit = quotaPerUnit;
  account.models = buildModelCatalog(models, pricing, quotaPerUnit, account.userGroup).map(model => ({
    ...model,
    estimatedCalls: estimateAccountCalls(account, model)
  }));
  const selected = account.models.find(model => model.name === account.modelName);
  if (selected) account.modelPrice = {
    type: selected.billing === 'call' ? 'per_call' : 'tokens', text: selected.text, model: selected.name,
    price: selected.price, priceUnit: selected.priceUnit,
    estimatedCalls: estimateAccountCalls(account, selected)
  };
  account.modelsCheckedAt = new Date().toISOString();
  mutateStore(latest => {
    const saved = latest.accounts.find(x => x.id === id);
    if (!saved) return;
    saved.quotaPerUnit = account.quotaPerUnit;
    saved.userGroup = account.userGroup;
    saved.models = account.models;
    if (selected) saved.modelPrice = account.modelPrice;
    saved.modelsCheckedAt = account.modelsCheckedAt;
    saved.modelPricingError = account.modelPricingError;
  });
  return account.models;
}

export function refreshModelCatalog(id, options = {}) {
  return serializeAccountRun(id, () => refreshModelCatalogUnlocked(id, options));
}

export async function testModelConnection(id) {
  const db = readStore();
  const account = db.accounts.find(x => x.id === id);
  if (!account) throw new Error('账户不存在');
  if (!account.modelName) throw new Error('请先选择一个模型');
  const started = Date.now();
  const result = await callApiKey(account, '/v1/chat/completions', {
    method: 'POST',
    body: { model: account.modelName, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false },
    timeoutMs: 60000
  });
  if (!result?.choices?.length) throw new Error(result?.message || '模型没有返回有效结果');
  return { ok: true, model: account.modelName, latencyMs: Date.now() - started, usage: result.usage || null };
}

async function refreshModelPriceUnlocked(id) {
  const db = readStore();
  const account = db.accounts.find(x => x.id === id);
  if (!account) throw new Error('账户不存在');
  if (!account.modelName) throw new Error('请先填写模型名称');
  const pricingAccount = pricingRequestAccount(account); const pricingAuth = pricingAuthType(pricingAccount);
  const [pricing, status] = await Promise.all([
    loadModelPricing(pricingAccount, pricingAuth),
    call(account, '/api/status', 'GET', 'public').catch(() => ({}))
  ]);
  const list = Array.isArray(pricing?.data) ? pricing.data : Array.isArray(pricing) ? pricing : [];
  const item = list.find(x => x.model_name === account.modelName);
  const quotaPerUnit = Number(findConfig(status, ['quota_per_unit', 'quotaPerUnit', 'QuotaPerUnit'])) || 500000;
  account.modelPrice = summarizeModelPrice(item, quotaPerUnit, pricingGroupRatio(pricing, account.userGroup));
  account.modelPriceCheckedAt = new Date().toISOString();
  mutateStore(latest => {
    const saved = latest.accounts.find(x => x.id === id);
    if (!saved || saved.modelName !== account.modelName) return;
    saved.modelPrice = account.modelPrice;
    saved.modelPriceCheckedAt = account.modelPriceCheckedAt;
    saved.quotaPerUnit = quotaPerUnit;
  });
  return account.modelPrice;
}

export function refreshModelPrice(id) {
  return serializeAccountRun(id, () => refreshModelPriceUnlocked(id));
}

export function classifyCheckin(data) {
  const message = String(data?.message ?? data?.msg ?? '').trim();
  const already = /已签到|已经签到|重复签到|already\s*(checked|signed)|checked\s*in/i.test(message);
  if (already) return { status: 'already', message: message || '今日已签到' };
  if (data?.success === false || data?.ok === false || (typeof data?.code === 'number' && data.code !== 0 && data.code !== 200)) {
    throw new Error(message || '站点返回签到失败');
  }
  return { status: 'ok', message: message || '签到成功' };
}

async function runNewApi(account, action) {
  if (!account.userId) throw new Error('请填写用户 ID');
  if (!account.credential && account.refreshMode !== 'browser') throw new Error('请填写登录 Cookie');
  let checkin;
  if (action === 'checkin') checkin = await runCheckin(account, '/api/user/checkin', 'newapi');
  let config = {};
  try { config = await call(account, '/api/status', 'GET', 'public'); } catch {}
  const data = await call(account, '/api/user/self', 'GET', 'newapi');
  const rawBalance = readRemainingQuota(data);
  if (rawBalance === undefined) throw new Error(data?.message || '余额响应中没有 data.quota');
  const quotaPerUnit = Number(findConfig(config, ['quota_per_unit', 'quotaPerUnit', 'QuotaPerUnit'])) || 500000;
  const userGroup = String(valueAt(data, 'data.group') ?? '').trim();
  const quotaDisplayType = String(findConfig(config, ['quota_display_type', 'quotaDisplayType', 'QuotaDisplayType']) || 'USD').toUpperCase();
  const usdExchangeRate = Number(findConfig(config, ['usd_exchange_rate', 'usdExchangeRate', 'USDExchangeRate'])) || 7.2;
  let rechargeConversion = null;
  try {
    const topups = await call(account, '/api/user/topup/self?p=0&page_size=20', 'GET', 'newapi', false, '', { allowBrowserRecovery: false });
    rechargeConversion = rechargeConversionFromTopups(topups, quotaPerUnit, quotaDisplayType);
  } catch {}
  let topupQuoteConversion = null;
  let topupQuoteError = '';
  try {
    let info = {};
    try { info = await call(account, '/api/user/topup/info', 'GET', 'newapi', false, '', { allowBrowserRecovery: false }); }
    catch (error) { topupQuoteError = `充值档位接口：${error.message}`; }
    let requestedAmount = topupQuoteRequestAmount(info, quotaPerUnit, quotaDisplayType);
    if (requestedAmount) {
      let quote = await call(account, '/api/user/amount', 'POST', 'newapi', false, JSON.stringify({ amount: requestedAmount, top_up_code: '' }), { allowBrowserRecovery: false });
      const correctedMinimum = minimumTopupFromError(quote);
      if (!rechargeConversionFromQuote(quote, requestedAmount, quotaPerUnit, quotaDisplayType)) {
        requestedAmount = correctedMinimum && correctedMinimum !== requestedAmount
          ? correctedMinimum
          : fallbackTopupQuoteAmount(requestedAmount, quotaPerUnit, quotaDisplayType);
        quote = await call(account, '/api/user/amount', 'POST', 'newapi', false, JSON.stringify({ amount: requestedAmount, top_up_code: '' }), { allowBrowserRecovery: false });
      }
      topupQuoteConversion = rechargeConversionFromQuote(quote, requestedAmount, quotaPerUnit, quotaDisplayType);
      if (topupQuoteConversion) topupQuoteError = '';
      else topupQuoteError = String(quote?.data ?? quote?.message ?? quote?.error ?? '报价接口没有返回有效金额');
    }
  } catch (error) { topupQuoteError = error.message; }
  if (!topupQuoteConversion) {
    topupQuoteConversion = rechargeConversionFromPublicPrice(findConfig(config, ['price', 'Price']));
    if (topupQuoteConversion) topupQuoteError = '';
  }
  return { balance: formatQuota(rawBalance, config, account.currency || 'auto'), rawBalance, quotaPerUnit, userGroup, quotaDisplayType, usdExchangeRate, rechargeConversion, topupQuoteConversion, topupQuoteError, topupQuoteCheckedAt: new Date().toISOString(), inviteCount: readInviteCount(data), checkin };
}

async function runGeneric(account, action) {
  let checkin;
  if (action === 'checkin') {
    if (!account.checkinPath) throw new Error('尚未配置签到接口');
    checkin = await runCheckin(account, account.checkinPath, 'generic');
  }
  if (!account.balancePath) throw new Error('尚未配置余额接口；模型与价格功能仍可使用');
  const data = await call(account, account.balancePath, account.balanceMethod || 'GET', 'generic', false, account.balanceBody ? decrypt(account.balanceBody) : '');
  const raw = readConfiguredBalance(data, account.balanceField || 'balance');
  if (raw === undefined) throw new Error(`余额字段 ${account.balanceField || 'balance'} 不存在`);
  const divisor = Number(account.balanceDivisor || 1);
  const amount = divisor !== 1 && Number.isFinite(Number(raw)) ? Number(raw) / divisor : raw;
  const prefix = account.currency === 'cny' ? '¥' : account.currency === 'usd' ? '$' : '';
  const balance = Number.isFinite(Number(amount)) ? `${prefix}${Number(amount).toFixed(2)}` : String(amount ?? '—');
  const userGroup = String(valueAt(data, 'data.group') ?? valueAt(data, 'user.group') ?? valueAt(data, 'group') ?? '').trim();
  return { balance, rawBalance: Number.isFinite(Number(raw)) ? Number(raw) : null, quotaPerUnit: divisor || 1, userGroup, inviteCount: readInviteCount(data), checkin };
}

async function runAccountUnlocked(id, action = 'poll') {
  const db = readStore();
  const account = db.accounts.find(x => x.id === id);
  if (!account || !account.enabled) throw new Error('账户不存在或已停用');
  const originalCredential = account.credential;
  const originalRefreshCookie = account.refreshCookie;
  const originalBrowserAccessToken = account.browserAccessToken;
  const startedAt = new Date().toISOString();
  let observedInviteCount = null;
  let run;
  try {
    const panelType = account.panelType === 'generic' ? 'generic' : 'newapi';
    const result = panelType === 'newapi' ? await runNewApi(account, action) : await runGeneric(account, action);
    account.balance = result.balance;
    account.balanceRaw = result.rawBalance;
    account.quotaPerUnit = result.quotaPerUnit || account.quotaPerUnit || 500000;
    if (result.quotaDisplayType) account.quotaDisplayType = result.quotaDisplayType;
    if (Number(result.usdExchangeRate) > 0) account.usdExchangeRate = Number(result.usdExchangeRate);
    if (result.rechargeConversion) account.rechargeConversion = result.rechargeConversion;
    if (result.topupQuoteConversion) account.topupQuoteConversion = result.topupQuoteConversion;
    account.topupQuoteError = result.topupQuoteError || '';
    account.topupQuoteCheckedAt = result.topupQuoteCheckedAt || '';
    if (result.userGroup) account.userGroup = result.userGroup;
    if (result.inviteCount !== null) {
      observedInviteCount = result.inviteCount;
      account.inviteCount = result.inviteCount;
    }
    if (account.modelPrice?.type === 'per_call') {
      account.modelPrice.estimatedCalls = estimateAccountCalls(account, {
        billing: 'call', price: account.modelPrice.price, priceUnit: account.modelPrice.priceUnit
      });
    }
    account.detectedType = panelType;
    account.lastStatus = 'ok';
    account.lastError = '';
    account.lastCheckedAt = new Date().toISOString();
    if (action === 'checkin') {
      account.lastCheckinAt = account.lastCheckedAt;
      account.lastCheckinStatus = result.checkin.status;
      account.lastCheckinMessage = result.checkin.message;
    }
    run = { id: crypto.randomUUID(), accountId: id, action, status: result.checkin?.status || 'ok', message: result.checkin?.message || '', startedAt };
  } catch (error) {
    account.lastStatus = 'error';
    account.lastError = error.message;
    account.lastCheckedAt = new Date().toISOString();
    run = { id: crypto.randomUUID(), accountId: id, action, status: 'error', message: error.message, startedAt };
  }
  return mutateStore(latest => {
    const saved = latest.accounts.find(x => x.id === id);
    if (saved) {
      if (account.lastStatus === 'ok' && observedInviteCount !== null) recordInviteCount(latest, saved, observedInviteCount, new Date(account.lastCheckedAt));
      for (const field of ['balance', 'balanceRaw', 'quotaPerUnit', 'quotaDisplayType', 'usdExchangeRate', 'rechargeConversion', 'topupQuoteConversion', 'topupQuoteError', 'topupQuoteCheckedAt', 'userGroup', 'detectedType', 'lastStatus', 'lastError', 'lastCheckedAt', 'lastCheckinAt', 'lastCheckinStatus', 'lastCheckinMessage']) {
        if (Object.hasOwn(account, field)) saved[field] = account[field];
      }
      if (saved.modelPrice?.type === 'per_call') {
        saved.modelPrice.estimatedCalls = estimateAccountCalls(saved, {
          billing: 'call', price: saved.modelPrice.price, priceUnit: saved.modelPrice.priceUnit
        });
      }
      if (account.credential !== originalCredential && saved.credential === originalCredential) saved.credential = account.credential;
      if (account.refreshCookie !== originalRefreshCookie && saved.refreshCookie === originalRefreshCookie) saved.refreshCookie = account.refreshCookie;
      if (account.browserAccessToken !== originalBrowserAccessToken && saved.browserAccessToken === originalBrowserAccessToken) saved.browserAccessToken = account.browserAccessToken;
    }
    latest.runs.unshift(run);
    latest.runs = latest.runs.slice(0, 5000);
    return saved || account;
  });
}

export function runAccount(id, action = 'poll') {
  return serializeAccountRun(id, () => runAccountUnlocked(id, action));
}

export function shouldPoll(account, pollTags = []) {
  const enabledTags = new Set(pollTags);
  return account.enabled && Array.isArray(account.tags) && account.tags.some(tag => enabledTags.has(tag));
}

export async function runAll(action = 'poll') {
  const db = readStore();
  const ids = db.accounts.filter(account => shouldPoll(account, db.pollTags || [])).map(x => x.id);
  const results = [];
  for (const id of ids) {
    try { results.push({ status: 'fulfilled', value: await runAccount(id, action) }); }
    catch (reason) { results.push({ status: 'rejected', reason }); }
  }
  return results;
}
