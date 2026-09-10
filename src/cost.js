function topupItems(response) {
  const candidates = [response?.data?.items, response?.data?.data, response?.data, response?.items, response];
  return candidates.find(Array.isArray) || [];
}

function completedTopup(item) {
  const status = String(item?.status || '').trim().toLowerCase();
  return ['success', 'succeeded', 'paid', 'complete', 'completed'].includes(status)
    || (!status && Number(item?.complete_time ?? item?.completeTime) > 0);
}

export function rechargeConversionFromTopups(response, quotaPerUnit = 500000, quotaDisplayType = 'USD') {
  const divisor = Number(quotaPerUnit);
  const tokenDisplay = String(quotaDisplayType || '').toUpperCase() === 'TOKENS';
  if (tokenDisplay && (!Number.isFinite(divisor) || divisor <= 0)) return null;
  const rows = topupItems(response)
    .filter(completedTopup)
    .map(item => {
      const nominal = Number(item?.amount);
      const paidCny = Number(item?.money ?? item?.paid_money ?? item?.paidAmount);
      const faceAmountUsd = tokenDisplay ? nominal / divisor : nominal;
      const completedAt = Number(item?.complete_time ?? item?.completeTime ?? item?.create_time ?? item?.createdAt ?? item?.id ?? 0);
      if (!Number.isFinite(faceAmountUsd) || faceAmountUsd <= 0 || !Number.isFinite(paidCny) || paidCny <= 0) return null;
      return {
        faceAmountUsd,
        paidCny,
        cnyPerUsd: paidCny / faceAmountUsd,
        paymentMethod: String(item?.payment_method ?? item?.paymentMethod ?? ''),
        completedAt
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.completedAt - a.completedAt);
  return rows.length ? { ...rows[0], source: 'topup_history' } : null;
}

function responseData(response) {
  return response?.data && typeof response.data === 'object' && !Array.isArray(response.data) ? response.data : response;
}

export function topupQuoteRequestAmount(response, quotaPerUnit = 500000, quotaDisplayType = 'USD') {
  const data = responseData(response) || {};
  let configured = data.amount_options ?? data.amountOptions ?? data.amounts;
  if (typeof configured === 'string') {
    try { configured = JSON.parse(configured); } catch { configured = configured.split(/[,，\s]+/); }
  }
  const options = Array.isArray(configured)
    ? configured
    : configured && typeof configured === 'object' ? Object.keys(configured) : [];
  const positiveOptions = options.map(Number).filter(value => Number.isFinite(value) && value > 0);
  const minimum = Number(data.min_topup ?? data.minTopup);
  const validMinimum = Number.isFinite(minimum) && minimum > 0 ? minimum : 0;
  const nominalAmount = positiveOptions.length
    ? Math.max(validMinimum, Math.min(...positiveOptions))
    : Math.max(validMinimum, 10);
  if (String(quotaDisplayType || '').toUpperCase() !== 'TOKENS') return Math.max(1, Math.ceil(nominalAmount));
  const divisor = Number(quotaPerUnit);
  if (!Number.isFinite(divisor) || divisor <= 0) return null;
  return Math.max(1, Math.ceil(nominalAmount * divisor));
}

export function fallbackTopupQuoteAmount(requestedAmount, quotaPerUnit = 500000, quotaDisplayType = 'USD') {
  const requested = Number(requestedAmount);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  if (String(quotaDisplayType || '').toUpperCase() === 'TOKENS') return Math.ceil(requested * 10);
  return Math.ceil(Math.max(100, requested * 10));
}

export function minimumTopupFromError(response) {
  const message = [response?.message, response?.msg, response?.error, response?.data].filter(value => typeof value === 'string').join(' ');
  const amount = Number(message.match(/(?:不能小于|at least|minimum(?:\s+is)?)\D*([\d]+)/i)?.[1]);
  return Number.isFinite(amount) && amount > 0 ? Math.ceil(amount) : null;
}

export function rechargeConversionFromQuote(response, requestedAmount, quotaPerUnit = 500000, quotaDisplayType = 'USD') {
  if (response?.success === false || response?.ok === false) return null;
  const paidCny = Number(response?.data ?? response?.amount ?? response?.money);
  const requested = Number(requestedAmount);
  const divisor = Number(quotaPerUnit);
  const tokenDisplay = String(quotaDisplayType || '').toUpperCase() === 'TOKENS';
  const faceAmountUsd = tokenDisplay ? requested / divisor : requested;
  if (!Number.isFinite(paidCny) || paidCny <= 0 || !Number.isFinite(faceAmountUsd) || faceAmountUsd <= 0) return null;
  return {
    faceAmountUsd,
    paidCny,
    cnyPerUsd: paidCny / faceAmountUsd,
    requestedAmount: requested,
    source: 'topup_quote'
  };
}

export function rechargeConversionFromPublicPrice(value) {
  const cnyPerUsd = Number(value);
  if (!Number.isFinite(cnyPerUsd) || cnyPerUsd <= 0) return null;
  return {
    faceAmountUsd: 1,
    paidCny: cnyPerUsd,
    cnyPerUsd,
    source: 'status_price'
  };
}

function tokenPrices(model, account) {
  let input = model?.inputPriceUsd === null || model?.inputPriceUsd === undefined ? NaN : Number(model.inputPriceUsd);
  let output = model?.outputPriceUsd === null || model?.outputPriceUsd === undefined ? NaN : Number(model.outputPriceUsd);
  if (!Number.isFinite(input)) {
    const label = String(model?.text || '');
    input = Number(label.match(/(?:输入|input)\s*\$?\s*([\d.]+)/i)?.[1]);
    output = Number(label.match(/(?:输出|output)\s*\$?\s*([\d.]+)/i)?.[1]);
  }
  if (!Number.isFinite(input)) {
    const ratio = Number(model?.price);
    const quotaPerUnit = Number(account?.quotaPerUnit);
    if (Number.isFinite(ratio) && Number.isFinite(quotaPerUnit) && quotaPerUnit > 0) input = ratio * 1000000 / quotaPerUnit;
  }
  if (!Number.isFinite(input) || input < 0) return null;
  if (!Number.isFinite(output) || output < 0) output = input;
  return { inputPriceUsd: input, outputPriceUsd: output };
}

export function modelPriceSnapshot(account, modelName = account?.modelName) {
  const model = account?.models?.find(item => item.name === modelName);
  if (!model) return {};
  if (model.billing === 'call') {
    let callPriceUsd = Number(model.price);
    if (model.priceUnit === 'quota') callPriceUsd /= Number(account.quotaPerUnit);
    return Number.isFinite(callPriceUsd) && callPriceUsd >= 0 ? { billing: 'call', callPriceUsd } : {};
  }
  const prices = tokenPrices(model, account);
  return prices ? { billing: 'token', ...prices } : {};
}

function eventNominalUsd(event, account) {
  const snapshot = event.billing ? event : { ...modelPriceSnapshot(account, event.modelName), ...event };
  if (snapshot.billing === 'call' && Number.isFinite(Number(snapshot.callPriceUsd))) {
    return { nominalUsd: Number(snapshot.callPriceUsd), tokenSplitEstimated: false, billing: 'call', callPriceUsd: Number(snapshot.callPriceUsd) };
  }
  if (snapshot.billing !== 'token') return null;
  const inputTokens = Number(snapshot.inputTokens);
  const outputTokens = Number(snapshot.outputTokens);
  const totalTokens = Number(snapshot.totalTokens);
  const inputPrice = Number(snapshot.inputPriceUsd);
  const outputPrice = Number(snapshot.outputPriceUsd);
  if (![inputPrice, outputPrice].every(Number.isFinite)) return null;
  if ([inputTokens, outputTokens].every(Number.isFinite) && inputTokens + outputTokens > 0) {
    return {
      nominalUsd: inputTokens * inputPrice / 1000000 + outputTokens * outputPrice / 1000000,
      tokenSplitEstimated: false,
      billing: 'token', inputPriceUsd: inputPrice, outputPriceUsd: outputPrice
    };
  }
  if (Number.isFinite(totalTokens) && totalTokens > 0) {
    return { nominalUsd: totalTokens * inputPrice / 1000000, tokenSplitEstimated: true, billing: 'token', inputPriceUsd: inputPrice, outputPriceUsd: outputPrice };
  }
  return null;
}

function emptyCostTotals() {
  return {
    nominalUsd: 0, referenceCny: 0, actualCny: 0, savedCny: 0,
    pricedRequests: 0, freeCreditEstimates: 0, tokenSplitEstimates: 0, missingConversion: 0
  };
}

function addCost(target, nominalUsd, referenceCny, actualCny, freeCredit, tokenSplitEstimated, conversionAvailable) {
  target.nominalUsd += nominalUsd;
  target.referenceCny += referenceCny;
  target.actualCny += actualCny;
  target.savedCny += referenceCny - actualCny;
  target.pricedRequests += 1;
  if (freeCredit) target.freeCreditEstimates += 1;
  if (tokenSplitEstimated) target.tokenSplitEstimates += 1;
  if (!conversionAvailable) target.missingConversion += 1;
}

export function gatewayCostSummary(events = [], accounts = []) {
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const coveredSites = new Set(); const historicalSites = new Set(); const breakdown = new Map();
  const totals = {
    ...emptyCostTotals(),
    totalSuccessful: 0,
    historicalEstimates: 0,
    missingPriceOrUsage: 0,
    coveredSites: 0
  };
  const historical = emptyCostTotals();
  for (const event of events) {
    if (event.action !== 'gateway' || event.status !== 'ok') continue;
    totals.totalSuccessful += 1;
    const account = accountMap.get(event.accountId);
    const calculated = eventNominalUsd(event, account);
    if (!calculated || !Number.isFinite(calculated.nominalUsd) || calculated.nominalUsd < 0) {
      totals.missingPriceOrUsage += 1;
      continue;
    }
    const nominalUsd = calculated.nominalUsd;
    const quoteRate = Number(account?.topupQuoteConversion?.cnyPerUsd);
    const rechargeRate = Number(account?.rechargeConversion?.cnyPerUsd);
    const hasRecharge = Number.isFinite(rechargeRate) && rechargeRate > 0;
    const valueRate = Number.isFinite(quoteRate) && quoteRate > 0 ? quoteRate : hasRecharge ? rechargeRate : NaN;
    const conversionAvailable = Number.isFinite(valueRate) && valueRate > 0;
    const referenceCny = conversionAvailable ? nominalUsd * valueRate : 0;
    const actualCny = hasRecharge ? nominalUsd * rechargeRate : 0;
    const estimated = !event.billing;
    const target = estimated ? historical : totals;
    addCost(target, nominalUsd, referenceCny, actualCny, !hasRecharge, calculated.tokenSplitEstimated, conversionAvailable);
    (estimated ? historicalSites : coveredSites).add(account.id);
    if (estimated) totals.historicalEstimates += 1;

    const modelName = event.modelName || account?.modelName || '未知模型';
    const breakdownKey = `${account?.id || event.accountId || ''}\u0000${modelName}\u0000${estimated ? 'historical' : 'snapshot'}`;
    if (!breakdown.has(breakdownKey)) breakdown.set(breakdownKey, {
      accountId: account?.id || event.accountId || '', accountName: account?.name || '已删除站点', modelName,
      estimated, billing: calculated.billing, requests: 0, nominalUsd: 0, referenceCny: 0, actualCny: 0, savedCny: 0,
      conversionAvailable, conversionSource: Number.isFinite(quoteRate) && quoteRate > 0 ? 'topup_quote' : hasRecharge ? 'topup_history' : '',
      inputTokens: 0, outputTokens: 0, totalTokens: 0, tokenSplitEstimates: 0, priceLabels: new Set()
    });
    const row = breakdown.get(breakdownKey);
    row.requests += 1; row.nominalUsd += nominalUsd; row.referenceCny += referenceCny;
    row.actualCny += actualCny; row.savedCny += referenceCny - actualCny;
    row.inputTokens += Number(event.inputTokens) || 0; row.outputTokens += Number(event.outputTokens) || 0;
    row.totalTokens += Number(event.totalTokens) || (Number(event.inputTokens) || 0) + (Number(event.outputTokens) || 0);
    if (calculated.tokenSplitEstimated) row.tokenSplitEstimates += 1;
    if (calculated.billing === 'call') row.priceLabels.add(`${Number(calculated.callPriceUsd).toFixed(6)} 额度 / 次`);
    else row.priceLabels.add(`输入 ${Number(calculated.inputPriceUsd).toFixed(4)} 额度 / 1M · 输出 ${Number(calculated.outputPriceUsd).toFixed(4)} 额度 / 1M`);
  }
  totals.coveredSites = coveredSites.size;
  totals.historical = { ...historical, coveredSites: historicalSites.size };
  totals.breakdown = [...breakdown.values()]
    .map(row => ({ ...row, priceLabels: [...row.priceLabels] }))
    .sort((a, b) => b.referenceCny - a.referenceCny || b.nominalUsd - a.nominalUsd);
  return totals;
}
