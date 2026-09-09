import { gatewayCostSummary } from './cost.js';

function dayKey(value, timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

export function gatewayStatistics(runs = [], accounts = [], now = new Date(), timeZone = 'Asia/Shanghai', trendLength = 7, filters = {}) {
  const allEvents = runs.filter(run => run.action === 'gateway');
  const events = allEvents.filter(run => (!filters.accountId || run.accountId === filters.accountId) && (!filters.modelName || run.modelName === filters.modelName));
  const accountNames = new Map(accounts.map(account => [account.id, account.name]));
  const requests = new Map();
  for (const event of events) {
    const key = event.requestId || event.id;
    if (!requests.has(key)) requests.set(key, []);
    requests.get(key).push(event);
  }
  const today = dayKey(now, timeZone);
  const month = today.slice(0, 7);
  const summarize = groups => {
    const list = [...groups.values()];
    const successful = list.filter(items => items.some(item => item.status === 'ok')).length;
    return { requests: list.length, successful, failed: list.length - successful, successRate: list.length ? Math.round(successful * 1000 / list.length) / 10 : 0 };
  };
  const todayGroups = new Map([...requests].filter(([, items]) => dayKey(items[0].startedAt, timeZone) === today));
  const monthGroups = new Map([...requests].filter(([, items]) => dayKey(items[0].startedAt, timeZone).startsWith(month)));
  const siteMap = new Map(); const modelMap = new Map(); const failureMap = new Map(); const endpointMap = new Map();
  for (const event of events) {
    const site = accountNames.get(event.accountId) || '已删除站点';
    for (const [map, key] of [[siteMap, site], [modelMap, event.modelName || '未知模型']]) {
      if (!map.has(key)) map.set(key, { name: key, attempts: 0, successful: 0, failed: 0, latencyTotal: 0, latencyCount: 0 });
      const row = map.get(key); row.attempts += 1; event.status === 'ok' ? row.successful += 1 : row.failed += 1;
      if (Number.isFinite(event.latencyMs)) { row.latencyTotal += event.latencyMs; row.latencyCount += 1; }
    }
    const endpoint = event.endpoint || '旧记录';
    endpointMap.set(endpoint, (endpointMap.get(endpoint) || 0) + 1);
    if (event.status === 'error') {
      const reason = event.statusCode ? `HTTP ${event.statusCode}` : /timeout|aborted/i.test(event.message || '') ? '连接超时' : '网络或其他错误';
      failureMap.set(reason, (failureMap.get(reason) || 0) + 1);
    }
  }
  const finishRows = map => [...map.values()].map(row => ({ ...row, successRate: row.attempts ? Math.round(row.successful * 1000 / row.attempts) / 10 : 0, averageLatencyMs: row.latencyCount ? Math.round(row.latencyTotal / row.latencyCount) : null })).sort((a, b) => b.successful - a.successful || b.attempts - a.attempts);
  const all = summarize(requests); const todaySummary = summarize(todayGroups); const monthSummary = summarize(monthGroups);
  const switched = [...requests.values()].filter(items => items.length > 1).length;
  const firstAttemptSuccessful = [...requests.values()].filter(items => items.some(item => item.status === 'ok' && (item.attempt || 1) === 1)).length;
  const successLatencies = events.filter(item => item.status === 'ok' && Number.isFinite(item.latencyMs)).map(item => item.latencyMs);
  const tokenTotals = events.filter(item => item.status === 'ok').reduce((sum, item) => ({ input: sum.input + (Number(item.inputTokens) || 0), output: sum.output + (Number(item.outputTokens) || 0), cached: sum.cached + (Number(item.cachedTokens) || 0), total: sum.total + (Number(item.totalTokens) || 0), measured: sum.measured + (Number.isFinite(item.totalTokens) || Number.isFinite(item.inputTokens) ? 1 : 0) }), { input: 0, output: 0, cached: 0, total: 0, measured: 0 });
  const costs = gatewayCostSummary(events, accounts);
  const todayEvents = events.filter(item => dayKey(item.startedAt, timeZone) === today && item.status === 'ok');
  const todayTokens = todayEvents.reduce((sum, item) => ({ input: sum.input + (Number(item.inputTokens) || 0), output: sum.output + (Number(item.outputTokens) || 0), cached: sum.cached + (Number(item.cachedTokens) || 0), total: sum.total + (Number(item.totalTokens) || 0) }), { input: 0, output: 0, cached: 0, total: 0 });
  const sortedLatencies = [...successLatencies].sort((a, b) => a - b);
  const p95LatencyMs = sortedLatencies.length ? sortedLatencies[Math.ceil(sortedLatencies.length * .95) - 1] : null;
  const days = [];
  for (let offset = trendLength - 1; offset >= 0; offset -= 1) {
    const date = new Date(now); date.setDate(date.getDate() - offset); const key = dayKey(date, timeZone);
    const groups = new Map([...requests].filter(([, items]) => dayKey(items[0].startedAt, timeZone) === key));
    days.push({ date: key, ...summarize(groups) });
  }
  return {
    today: todaySummary, month: monthSummary,
    all: { ...all, switched, firstHitRate: all.requests ? Math.round(firstAttemptSuccessful * 1000 / all.requests) / 10 : 0, averageLatencyMs: successLatencies.length ? Math.round(successLatencies.reduce((a, b) => a + b, 0) / successLatencies.length) : null, p95LatencyMs },
    days, sites: finishRows(siteMap), models: finishRows(modelMap),
    failures: [...failureMap].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    endpoints: [...endpointMap].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    filters: { accounts: accounts.map(account => ({ id: account.id, name: account.name })), models: [...new Set(allEvents.map(event => event.modelName).filter(Boolean))].sort((a, b) => a.localeCompare(b)), accountId: filters.accountId || '', modelName: filters.modelName || '' },
    tokens: { today: todayTokens, all: tokenTotals }, costs, updatedAt: now.toISOString()
  };
}
