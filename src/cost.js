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

export function modelPriceSnapshot(account) {
  const model = account?.models?.find(item => item.name === account.modelName);
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
  const snapshot = event.billing ? event : { ...modelPriceSnapshot(account), ...event };
  if (snapshot.billing === 'call' && Number.isFinite(Number(snapshot.callPriceUsd))) return Number(snapshot.callPriceUsd);
  if (snapshot.billing !== 'token') return null;
  const inputTokens = Number(snapshot.inputTokens);
  const outputTokens = Number(snapshot.outputTokens);
  const inputPrice = Number(snapshot.inputPriceUsd);
  const outputPrice = Number(snapshot.outputPriceUsd);
  if (![inputTokens, outputTokens, inputPrice, outputPrice].every(Number.isFinite)) return null;
  return inputTokens * inputPrice / 1000000 + outputTokens * outputPrice / 1000000;
}

export function gatewayCostSummary(events = [], accounts = []) {
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const coveredSites = new Set();
  const totals = { nominalUsd: 0, referenceCny: 0, actualCny: 0, savedCny: 0, pricedRequests: 0, coveredSites: 0 };
  for (const event of events) {
    if (event.action !== 'gateway' || event.status !== 'ok') continue;
    const account = accountMap.get(event.accountId);
    const cnyPerUsd = Number(account?.rechargeConversion?.cnyPerUsd);
    if (!Number.isFinite(cnyPerUsd) || cnyPerUsd <= 0) continue;
    const nominalUsd = eventNominalUsd(event, account);
    if (!Number.isFinite(nominalUsd) || nominalUsd < 0) continue;
    const exchangeRate = Number(account?.usdExchangeRate) > 0 ? Number(account.usdExchangeRate) : 7.2;
    const referenceCny = nominalUsd * exchangeRate;
    const actualCny = nominalUsd * cnyPerUsd;
    totals.nominalUsd += nominalUsd;
    totals.referenceCny += referenceCny;
    totals.actualCny += actualCny;
    totals.savedCny += referenceCny - actualCny;
    totals.pricedRequests += 1;
    coveredSites.add(account.id);
  }
  totals.coveredSites = coveredSites.size;
  return totals;
}
