import crypto from 'node:crypto';
import { readStore, writeStore } from './store.js';
import { refreshModelCatalog } from './runner.js';

const MAX_ALERTS = 300;
let activeScan = null;

export function canonicalModelName(name) {
  return String(name || '').trim().toLowerCase();
}

export function comparableModelName(name) {
  const canonical = canonicalModelName(name);
  const parts = canonical.split('-').filter(Boolean);
  return parts.length >= 3 ? parts.slice(0, 3).join('-') : canonical;
}

export function oneConnectorModelName(name) {
  const canonical = canonicalModelName(name);
  const parts = canonical.split('-').filter(Boolean);
  return parts.length >= 2 ? parts.slice(0, 2).join('-') : canonical;
}

export function normalizedPerCallPrice(account, model) {
  if (model?.billing !== 'call') return null;
  const price = Number(model.price);
  if (!Number.isFinite(price) || price < 0) return null;
  if (model.priceUnit === 'quota') {
    const quotaPerUnit = Number(account?.quotaPerUnit);
    return Number.isFinite(quotaPerUnit) && quotaPerUnit > 0 ? price / quotaPerUnit : null;
  }
  return !model.priceUnit || model.priceUnit === 'usd' ? price : null;
}

export function normalizedTokenPrice(account, model) {
  if (model?.billing !== 'token') return null;
  let inputPriceUsd = model.inputPriceUsd === null || model.inputPriceUsd === undefined ? NaN : Number(model.inputPriceUsd);
  let outputPriceUsd = model.outputPriceUsd === null || model.outputPriceUsd === undefined ? NaN : Number(model.outputPriceUsd);
  if (!Number.isFinite(inputPriceUsd)) {
    const label = String(model.text || '');
    const inputMatch = label.match(/(?:输入|input)\s*\$?\s*([\d.]+)/i);
    const outputMatch = label.match(/(?:输出|output)\s*\$?\s*([\d.]+)/i);
    if (inputMatch) inputPriceUsd = Number(inputMatch[1]);
    if (outputMatch) outputPriceUsd = Number(outputMatch[1]);
  }
  if (!Number.isFinite(inputPriceUsd)) {
    const ratio = Number(model.price);
    const quotaPerUnit = Number(account?.quotaPerUnit);
    if (Number.isFinite(ratio) && ratio >= 0 && Number.isFinite(quotaPerUnit) && quotaPerUnit > 0) {
      inputPriceUsd = ratio * 1000000 / quotaPerUnit;
    }
  }
  if (!Number.isFinite(inputPriceUsd) || inputPriceUsd < 0) return null;
  if (!Number.isFinite(outputPriceUsd) || outputPriceUsd < 0) outputPriceUsd = inputPriceUsd;
  return { priceUsd: inputPriceUsd, outputPriceUsd };
}

function normalizedModelPrice(account, model, billing) {
  if (billing === 'token') return normalizedTokenPrice(account, model);
  const priceUsd = normalizedPerCallPrice(account, model);
  return priceUsd === null ? null : { priceUsd, outputPriceUsd: null };
}

function roundedVisiblePrice(value, billing = 'call') {
  if (value === null || value === undefined) return NaN;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return NaN;
  const digits = amount !== 0 && Math.abs(amount) < 0.0001 ? 8 : billing === 'token' ? 4 : 6;
  return Number(amount.toFixed(digits));
}

function comparePrices(left, right) {
  const billing = left.billing || right.billing || 'call';
  const leftInput = roundedVisiblePrice(left.priceUsd, billing);
  const rightInput = roundedVisiblePrice(right.priceUsd, billing);
  if (leftInput !== rightInput) return leftInput - rightInput;
  const leftOutput = left.outputPriceUsd === null || left.outputPriceUsd === undefined ? leftInput : roundedVisiblePrice(left.outputPriceUsd, billing);
  const rightOutput = right.outputPriceUsd === null || right.outputPriceUsd === undefined ? rightInput : roundedVisiblePrice(right.outputPriceUsd, billing);
  return leftOutput - rightOutput;
}

function meaningfulPriceAlert(alert) {
  if (alert.kind !== 'drop' || alert.oldPriceUsd === null || alert.oldPriceUsd === undefined) return true;
  const billing = alert.billing || 'call';
  return comparePrices(
    { billing, priceUsd: alert.newPriceUsd, outputPriceUsd: alert.newOutputPriceUsd },
    { billing, priceUsd: alert.oldPriceUsd, outputPriceUsd: alert.oldOutputPriceUsd }
  ) < 0;
}

function buildLeaders(accounts, comparisonName, scope, billing = 'call') {
  const leaders = new Map();
  for (const account of accounts) {
    for (const model of account.models || []) {
      const key = comparisonName(model.name);
      const price = normalizedModelPrice(account, model, billing);
      if (!key || !price) continue;
      const candidate = { key, scope, billing, comparisonName: key, modelName: model.name, ...price, accountId: account.id, accountName: account.name, checkedAt: account.modelsCheckedAt || null };
      const current = leaders.get(key);
      const compared = current ? comparePrices(candidate, current) : -1;
      if (!current || compared < 0 || (compared === 0 && candidate.accountName.localeCompare(current.accountName) < 0)) leaders.set(key, candidate);
    }
  }
  return [...leaders.values()].sort((a, b) => a.modelName.localeCompare(b.modelName));
}

export function buildPriceLeaders(accounts = []) {
  return buildLeaders(accounts, comparableModelName, 'precise');
}

export function buildOneConnectorPriceLeaders(accounts = []) {
  return buildLeaders(accounts, oneConnectorModelName, 'broad');
}

export function buildTokenPriceLeaders(accounts = []) {
  return buildLeaders(accounts, comparableModelName, 'precise', 'token');
}

export function buildOneConnectorTokenPriceLeaders(accounts = []) {
  return buildLeaders(accounts, oneConnectorModelName, 'broad', 'token');
}

export function buildSitePrices(accounts = []) {
  const prices = new Map();
  for (const account of accounts) {
    for (const model of account.models || []) {
      const comparisonName = comparableModelName(model.name);
      const billing = model.billing === 'token' ? 'token' : 'call';
      const price = normalizedModelPrice(account, model, billing);
      if (!comparisonName || !price) continue;
      const key = `${account.id}:${billing}:${comparisonName}`;
      const candidate = { key, billing, comparisonName, modelName: model.name, ...price, accountId: account.id, accountName: account.name, checkedAt: account.modelsCheckedAt || null };
      const current = prices.get(key);
      if (!current || comparePrices(candidate, current) < 0) prices.set(key, candidate);
    }
  }
  return [...prices.values()].sort((a, b) => a.accountName.localeCompare(b.accountName) || a.comparisonName.localeCompare(b.comparisonName));
}

export function buildModelPriceCatalog(accounts = []) {
  const prices = [];
  for (const account of accounts) {
    for (const model of account.models || []) {
      const billing = model.billing === 'token' ? 'token' : 'call';
      const price = normalizedModelPrice(account, model, billing);
      const modelName = String(model.name || '').trim();
      if (!modelName || !price) continue;
      prices.push({
        billing,
        modelName,
        canonicalName: canonicalModelName(modelName),
        ...price,
        accountId: account.id,
        accountName: account.name,
        checkedAt: account.modelsCheckedAt || null
      });
    }
  }
  return prices.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName) || comparePrices(a, b) || a.accountName.localeCompare(b.accountName));
}

function watchFields(scope = 'precise', billing = 'call') {
  const broad = scope === 'broad';
  if (billing === 'token') return {
    initializedField: broad ? 'tokenBroadInitialized' : 'tokenInitialized',
    leadersField: broad ? 'tokenBroadLeaders' : 'tokenLeaders'
  };
  return {
    initializedField: broad ? 'broadInitialized' : 'initialized',
    leadersField: broad ? 'broadLeaders' : 'leaders'
  };
}

export function updatePinnedPriceAlerts(alerts = [], leaders = [], now = new Date(), scope = 'precise', billing = 'call') {
  const comparisonName = scope === 'broad' ? oneConnectorModelName : comparableModelName;
  const currentByFamily = new Map(leaders.map(item => [item.key || comparisonName(item.modelName), item]));
  const changedAt = now.toISOString();
  for (const alert of alerts) {
    if (!alert.pinned || (alert.scope || 'precise') !== scope || (alert.billing || 'call') !== billing) continue;
    const family = alert.comparisonName || (scope === 'broad' ? oneConnectorModelName(alert.modelName) : comparableModelName(alert.modelName));
    const current = currentByFamily.get(family);
    const previousPrice = Number(alert.currentPriceUsd ?? alert.newPriceUsd);
    const previousOutputPrice = Number(alert.currentOutputPriceUsd ?? alert.newOutputPriceUsd);
    const previousModel = alert.currentModelName || alert.modelName;
    const previousAccountId = alert.currentAccountId || alert.accountId;
    let change = null;

    if (!current) {
      if (alert.watchStatus !== 'missing') change = { status: 'missing', message: '当前已找不到这个模型' };
      alert.currentPriceUsd = null;
      alert.currentOutputPriceUsd = null;
      alert.currentModelName = '';
      alert.currentAccountId = '';
      alert.currentAccountName = '';
    } else {
      const previous = {
        priceUsd: previousPrice,
        outputPriceUsd: Number.isFinite(previousOutputPrice) ? previousOutputPrice : previousPrice
      };
      const compared = Number.isFinite(previousPrice) ? comparePrices(current, previous) : 0;
      if (alert.watchStatus === 'missing') change = { status: 'restored', message: '模型重新出现了' };
      else if (compared > 0) change = { status: 'up', message: '价格变贵了' };
      else if (compared < 0) change = { status: 'down', message: '价格又降低了' };
      else if (previousModel !== current.modelName || previousAccountId !== current.accountId) change = { status: 'switched', message: '最低站点或模型变体已变化' };
      alert.currentPriceUsd = current.priceUsd;
      alert.currentOutputPriceUsd = current.outputPriceUsd ?? null;
      alert.currentModelName = current.modelName;
      alert.currentAccountId = current.accountId;
      alert.currentAccountName = current.accountName;
    }

    alert.lastWatchedAt = changedAt;
    if (change) {
      alert.watchStatus = change.status;
      alert.watchMessage = change.message;
      alert.lastChangedAt = changedAt;
      alert.unread = true;
    } else if (!alert.watchStatus) {
      alert.watchStatus = current ? 'watching' : 'missing';
      alert.watchMessage = current ? '持续观察中' : '当前已找不到这个模型';
    }
  }
  return alerts;
}

export function updatePriceWatchState(db, leaders, now = new Date(), scope = 'precise', billing = 'call') {
  const previous = db.priceWatch || {};
  const { initializedField, leadersField } = watchFields(scope, billing);
  const initialized = previous[initializedField] === true;
  const oldLeaders = previous[leadersField] || {};
  const nextLeaders = Object.fromEntries(leaders.map(item => [item.key, item]));
  const alerts = Array.isArray(previous.alerts) ? previous.alerts : [];
  const comparisonName = scope === 'broad' ? oneConnectorModelName : comparableModelName;
  updatePinnedPriceAlerts(alerts, leaders, now, scope, billing);
  const pinnedFamilies = new Set(alerts
    .filter(alert => alert.pinned && (alert.scope || 'precise') === scope && (alert.billing || 'call') === billing)
    .map(alert => alert.comparisonName || comparisonName(alert.modelName)));
  const created = [];
  for (const current of leaders) {
    const old = oldLeaders[current.key] || Object.values(oldLeaders)
      .filter(item => comparisonName(item.modelName) === current.key)
      .sort(comparePrices)[0];
    const isNewModel = initialized && !old;
    const isCheaper = old && comparePrices(current, old) < 0;
    if ((!isNewModel && !isCheaper) || pinnedFamilies.has(current.key)) continue;
    created.push({
      id: crypto.randomUUID(), unread: true, kind: isNewModel ? 'new' : 'drop', scope, billing, comparisonName: current.key, modelName: current.modelName,
      oldPriceUsd: old?.priceUsd ?? null, newPriceUsd: current.priceUsd,
      oldOutputPriceUsd: old?.outputPriceUsd ?? null, newOutputPriceUsd: current.outputPriceUsd ?? null,
      oldAccountName: old?.accountName || '', accountId: current.accountId, accountName: current.accountName,
      detectedAt: now.toISOString()
    });
  }
  db.priceWatch = {
    ...previous, [initializedField]: true, [leadersField]: nextLeaders,
    alerts: [...created.reverse(), ...alerts].slice(0, MAX_ALERTS),
    lastCheckedAt: now.toISOString()
  };
  return created;
}

export function priceAlertsView(db = readStore()) {
  const watch = db.priceWatch || {};
  const alerts = Array.isArray(watch.alerts) ? [...watch.alerts].filter(meaningfulPriceAlert).sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const aTime = a.pinned ? a.pinnedAt || a.detectedAt : a.detectedAt;
    const bTime = b.pinned ? b.pinnedAt || b.detectedAt : b.detectedAt;
    return String(bTime || '').localeCompare(String(aTime || ''));
  }) : [];
  const sitePrices = buildSitePrices(db.accounts || []);
  const siteNames = new Map((db.accounts || []).map(item => [item.id, item.name]));
  for (const alert of alerts) {
    if (alert.accountId && alert.accountName) siteNames.set(alert.accountId, alert.accountName);
    if (alert.currentAccountId && alert.currentAccountName) siteNames.set(alert.currentAccountId, alert.currentAccountName);
  }
  return {
    leaders: Object.values(watch.leaders || {}).sort((a, b) => a.modelName.localeCompare(b.modelName)),
    broadLeaders: Object.values(watch.broadLeaders || {}).sort((a, b) => a.modelName.localeCompare(b.modelName)),
    tokenLeaders: Object.values(watch.tokenLeaders || {}).sort((a, b) => a.modelName.localeCompare(b.modelName)),
    tokenBroadLeaders: Object.values(watch.tokenBroadLeaders || {}).sort((a, b) => a.modelName.localeCompare(b.modelName)),
    modelPrices: buildModelPriceCatalog(db.accounts || []),
    sitePrices,
    sites: [...siteNames].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    alerts,
    unreadCount: alerts.filter(alert => alert.unread).length,
    initialized: watch.initialized === true,
    broadInitialized: watch.broadInitialized === true,
    tokenInitialized: watch.tokenInitialized === true,
    tokenBroadInitialized: watch.tokenBroadInitialized === true,
    lastCheckedAt: watch.lastCheckedAt || null,
    lastScan: watch.lastScan || null
  };
}

export function priceScanCandidates(accounts = []) {
  return accounts.filter(account => account.enabled !== false);
}

async function performPriceScan() {
  const snapshot = readStore();
  const candidates = priceScanCandidates(snapshot.accounts);
  const errors = [];
  let refreshed = 0;
  for (const account of candidates) {
    try { await refreshModelCatalog(account.id, { allowBrowserRecovery: false, requirePricing: true }); refreshed++;
    } catch (error) { errors.push({ accountId: account.id, accountName: account.name, message: error.message }); }
  }
  const db = readStore();
  const now = new Date();
  const leaders = buildPriceLeaders(db.accounts);
  const broadLeaders = buildOneConnectorPriceLeaders(db.accounts);
  const tokenLeaders = buildTokenPriceLeaders(db.accounts);
  const tokenBroadLeaders = buildOneConnectorTokenPriceLeaders(db.accounts);
  const created = [
    ...updatePriceWatchState(db, leaders, now, 'precise'),
    ...updatePriceWatchState(db, broadLeaders, now, 'broad'),
    ...updatePriceWatchState(db, tokenLeaders, now, 'precise', 'token'),
    ...updatePriceWatchState(db, tokenBroadLeaders, now, 'broad', 'token')
  ];
  db.priceWatch.lastScan = { monitored: candidates.length, refreshed, failed: errors.length, errors: errors.slice(0, 30) };
  writeStore(db);
  return { ...priceAlertsView(db), createdCount: created.length };
}

export function scanPriceAlerts() {
  if (activeScan) return activeScan;
  activeScan = performPriceScan().finally(() => { activeScan = null; });
  return activeScan;
}

export function markPriceAlertsRead() {
  const db = readStore();
  if (db.priceWatch?.alerts) db.priceWatch.alerts.forEach(alert => { alert.unread = false; });
  writeStore(db);
  return priceAlertsView(db);
}

export function clearPriceAlerts() {
  const db = readStore();
  if (db.priceWatch) db.priceWatch.alerts = (db.priceWatch.alerts || []).filter(alert => alert.pinned);
  writeStore(db);
  return priceAlertsView(db);
}

export function setPriceAlertPinned(id, pinned = true) {
  const db = readStore();
  const alert = db.priceWatch?.alerts?.find(item => item.id === id);
  if (!alert) throw Error('提醒不存在');
  alert.pinned = Boolean(pinned);
  if (alert.pinned) {
    const now = new Date().toISOString();
    const broad = alert.scope === 'broad';
    const billing = alert.billing || 'call';
    const family = alert.comparisonName || (broad ? oneConnectorModelName(alert.modelName) : comparableModelName(alert.modelName));
    const { leadersField } = watchFields(alert.scope || 'precise', billing);
    const current = db.priceWatch?.[leadersField]?.[family];
    alert.pinnedAt = now;
    alert.unread = false;
    alert.lastWatchedAt = now;
    alert.watchStatus = current ? 'watching' : 'missing';
    alert.watchMessage = current ? '持续观察中' : '当前已找不到这个模型';
    alert.currentPriceUsd = current?.priceUsd ?? null;
    alert.currentOutputPriceUsd = current?.outputPriceUsd ?? null;
    alert.currentModelName = current?.modelName || '';
    alert.currentAccountId = current?.accountId || '';
    alert.currentAccountName = current?.accountName || '';
  } else {
    delete alert.pinnedAt;
  }
  writeStore(db);
  return priceAlertsView(db);
}

export function dismissPriceAlert(id) {
  const db = readStore();
  const alerts = db.priceWatch?.alerts || [];
  const remaining = alerts.filter(alert => alert.id !== id);
  if (remaining.length === alerts.length) throw Error('提醒不存在');
  db.priceWatch.alerts = remaining;
  writeStore(db);
  return priceAlertsView(db);
}
