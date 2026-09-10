const $ = s => document.querySelector(s);
let accounts = []; let tags = []; let dashboardData = null; let activeFilter = ''; let activeStatusFilter = '';
let priceAlertData = null; let inviteAlertData = null;

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '请求失败');
  return data;
}

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function priceWithEstimate(price = {}) {
  if (!price?.text) return '';
  if (price.type !== 'per_call') return price.text;
  if (price.estimatedCalls === 'unlimited') return `${price.text} · 预计不限次数`;
  if (Number.isInteger(price.estimatedCalls)) return `${price.text} · 预计还可 ${price.estimatedCalls.toLocaleString()} 次`;
  return `${price.text} · 刷新余额后估算`;
}

function filteredAccounts(list = accounts) {
  return list.filter(account => (!activeFilter || (account.tags || []).includes(activeFilter)) && (!activeStatusFilter || account.lastStatus === activeStatusFilter));
}

function setPriceAlertBadge(count = 0) {
  const badge = $('#priceAlertBadge');
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.classList.toggle('hidden', !count);
}

function setInviteAlertBadge(count = 0) {
  const badge = $('#inviteAlertBadge');
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.classList.toggle('hidden', !count);
}

async function refreshPriceAlertBadge() {
  if ($('#app').classList.contains('hidden')) return;
  try {
    const latest = await api('/api/price-alerts');
    setPriceAlertBadge(latest.unreadCount || 0);
    if (!$('#priceAlertsView').classList.contains('hidden')) {
      priceAlertData = latest;
      renderPriceAlerts();
    }
  } catch {}
}
async function refreshInviteAlertBadge() {
  if ($('#app').classList.contains('hidden') || !$('#inviteAlertsView').classList.contains('hidden')) return;
  try { setInviteAlertBadge((await api('/api/invite-alerts')).unreadCount || 0); } catch {}
}
setInterval(() => { refreshPriceAlertBadge(); refreshInviteAlertBadge(); }, 60000);

async function load() {
  try {
    const data = await api('/api/dashboard');
    accounts = data.accounts;
    tags = data.tags || [];
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#logout').classList.remove('hidden');
    render(data);
  } catch {
    accounts = [];
    $('#login').classList.remove('hidden');
    $('#app').classList.add('hidden');
    $('#logout').classList.add('hidden');
  }
}

function render(data) {
  dashboardData = data;
  $('#siteCount').textContent = data.accounts.length;
  $('#okCount').textContent = data.accounts.filter(x => x.lastStatus === 'ok').length;
  $('#errorCount').textContent = data.accounts.filter(x => x.lastStatus === 'error').length;
  $('#errorStat').classList.toggle('active', activeStatusFilter === 'error');
  $('#errorStat').setAttribute('aria-pressed', String(activeStatusFilter === 'error'));
  $('#errorStat').title = activeStatusFilter === 'error' ? '再次点击显示全部状态' : '点击只看异常站点';
  $('#errorFilterHint').textContent = activeStatusFilter === 'error' ? '正在只看异常 · 再点取消' : '点击筛选异常站点';
  setPriceAlertBadge(data.priceAlertUnreadCount || 0);
  setInviteAlertBadge(data.inviteAlertUnreadCount || 0);
  const allTags = [...new Set(data.tags || [])].sort((a, b) => a.localeCompare(b));
  const enabledTags = new Set(data.pollTags || []);
  $('#pollTags').innerHTML = allTags.map(tag => `<span class="tag-item"><button class="tag-toggle ${enabledTags.has(tag) ? 'active' : 'ghost'}" data-tag="${esc(tag)}" onclick="togglePollTag(this.dataset.tag,${!enabledTags.has(tag)})">${enabledTags.has(tag) ? '✓ ' : ''}${esc(tag)}</button><button class="tag-delete" data-tag="${esc(tag)}" onclick="deleteTag(this.dataset.tag)" title="删除标签">×</button></span>`).join('') || '<span class="hint">先在这里添加一个标签。</span>';
  $('#filterTags').innerHTML = `<button class="tag-toggle ${activeFilter ? 'ghost' : 'active'}" onclick="setTagFilter('')">全部</button>` + allTags.map(tag => `<button class="tag-toggle ${activeFilter === tag ? 'active' : 'ghost'}" data-tag="${esc(tag)}" onclick="setTagFilter(this.dataset.tag)">${esc(tag)}</button>`).join('');
  const visibleAccounts = filteredAccounts(data.accounts);
  $('#cards').innerHTML = visibleAccounts.length ? visibleAccounts.map(a => `
    <article class="card" draggable="true" ondragstart="startAccountDrag(event,'${a.id}')" ondragover="dragAccountOver(event)" ondragleave="this.classList.remove('drag-over')" ondrop="dropAccount(event,'${a.id}')" ondragend="endAccountDrag(event)">
      <div class="top"><strong>${esc(a.name)}</strong><span class="drag-handle" title="拖动排序">⋮⋮</span><span class="status ${a.lastStatus === 'error' ? 'error' : ''}">${a.lastStatus === 'error' ? '异常' : a.lastStatus === 'ok' ? '正常' : '未运行'}</span></div>
      <div class="site-tags">${(a.tags || []).map(tag => `<span>${esc(tag)}</span>`).join('') || '<span class="empty-tag">未设置标签</span>'}</div>
      <a class="site-link" href="${esc(a.baseUrl)}" target="_blank" rel="noopener noreferrer">打开站点 ↗</a>
      ${a.refreshMode === 'browser' ? `<span class="browser-badge">${a.hasRefreshCookie ? '云端续期 · 浏览器备用' : '服务器浏览器登录态'}${a.browserLoginAction ? ` · 自动点 ${esc(a.browserLoginAction)}` : ''}</span>` : ''}
      ${a.refreshMode !== 'browser' && a.hasRefreshCookie ? '<span class="browser-badge">云端令牌自动续期</span>' : ''}
      <div class="balance">${esc(a.balance ?? '—')}</div>
      ${a.topupQuoteConversion ? `<div class="recharge-rate"><span>${a.topupQuoteConversion.source === 'status_price' ? '站点公开充值比例' : '当前最低充值档换算'}</span><strong>¥${Number(a.topupQuoteConversion.paidCny).toFixed(4)} → ${Number(a.topupQuoteConversion.faceAmountUsd).toFixed(2)} 站内额度</strong><small>${a.topupQuoteConversion.source === 'status_price' ? '报价接口不可用时按站点公开 price 配置估算' : '用于额度价值估算，不代表已经充值'}</small></div>` : ''}
      ${!a.topupQuoteConversion && a.topupQuoteError ? `<div class="recharge-rate"><span>充值换算暂不可用</span><small>${esc(a.topupQuoteError)}</small></div>` : ''}
      ${a.rechargeConversion ? `<div class="recharge-rate"><span>最近真实充值</span><strong>¥${Number(a.rechargeConversion.paidCny).toFixed(2)} → ${Number(a.rechargeConversion.faceAmountUsd).toFixed(2)} 站内额度</strong><small>每 1 站内额度实付 ¥${Number(a.rechargeConversion.cnyPerUsd).toFixed(4)}</small></div>` : ''}
      <div class="model-box"><strong>${esc(a.modelName || '尚未选择模型')}</strong><span>${esc(priceWithEstimate(a.modelPrice) || (a.hasApiKey ? '点击选择模型并查看价格' : '请先编辑并填写 API Key'))}</span></div>
      <p class="meta">${a.lastError ? esc(a.lastError) : a.lastCheckinMessage ? esc(a.lastCheckinMessage) : a.lastCheckedAt ? '更新于 ' + new Date(a.lastCheckedAt).toLocaleString() : '等待首次刷新'}</p>
      <div class="card-actions"><button onclick="run('${a.id}','poll',this)">刷新</button><button class="secondary" onclick="run('${a.id}','checkin',this)">签到</button><button class="ghost" onclick="openTagPicker('${a.id}')">选择标签</button><button class="ghost" onclick="openModels('${a.id}')">选择模型</button><button class="ghost" onclick="testModel('${a.id}',this)">测试模型</button>${a.refreshMode === 'browser' ? `<button class="ghost" onclick="openServerBrowser('${a.id}')">浏览器登录</button>` : ''}<button class="ghost" onclick="edit('${a.id}')">编辑</button><button class="ghost" onclick="removeAccount('${a.id}')">删除</button></div>
    </article>`).join('') : `<article class="panel"><p>${activeStatusFilter ? '当前筛选下没有异常站点。' : activeFilter ? '这个标签下还没有站点。' : '还没有站点，先添加一个。'}</p></article>`;
}

window.showView = view => {
  $('#dashboardView').classList.toggle('hidden', view !== 'dashboard');
  $('#statsView').classList.toggle('hidden', view !== 'stats');
  $('#logsView').classList.toggle('hidden', view !== 'logs');
  $('#priceAlertsView').classList.toggle('hidden', view !== 'priceAlerts');
  $('#inviteAlertsView').classList.toggle('hidden', view !== 'inviteAlerts');
  document.querySelectorAll('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'stats') loadStats();
  if (view === 'logs') loadLogs();
  if (view === 'priceAlerts') loadPriceAlerts();
  if (view === 'inviteAlerts') loadInviteAlerts();
};

window.renderInviteAlerts = () => {
  if (!inviteAlertData) return;
  const siteSelect = $('#inviteSiteFilter');
  const selectedSite = siteSelect.value;
  siteSelect.innerHTML = '<option value="">全部站点</option>' + (inviteAlertData.sites || []).map(site => `<option value="${esc(site.id)}">${esc(site.name)}</option>`).join('');
  siteSelect.value = selectedSite;
  const activeSite = siteSelect.value;
  const alerts = inviteAlertData.alerts.filter(item => !activeSite || item.accountId === activeSite);
  $('#inviteMonitoredCount').textContent = inviteAlertData.monitoredCount.toLocaleString();
  $('#inviteRecentAddedCount').textContent = Number(inviteAlertData.recentAddedCount || 0).toLocaleString();
  $('#inviteUnreadCount').textContent = inviteAlertData.unreadCount.toLocaleString();
  $('#inviteAlertsUpdatedAt').textContent = inviteAlertData.lastScan?.checkedAt ? `检测于 ${new Date(inviteAlertData.lastScan.checkedAt).toLocaleString()}` : inviteAlertData.lastCheckedAt ? '已有基准，等待检测新增' : '尚未建立邀请基准';
  $('#inviteAlertHistory').innerHTML = alerts.map(item => {
    const details = `<strong>${esc(item.accountName)}</strong><b class="invite-added">+${Number(item.addedCount).toLocaleString()} 人</b><span>邀请人数 ${Number(item.previousCount).toLocaleString()} → ${Number(item.currentCount).toLocaleString()}</span><time>${new Date(item.detectedAt).toLocaleString()}</time><em>打开站点查收 ↗</em>`;
    const linked = item.url ? `<a class="invite-alert-link" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${details}</a>` : `<div class="invite-alert-link">${details}</div>`;
    return `<article class="unread">${linked}<div class="price-alert-actions"><button class="ghost" onclick="dismissInviteAlert('${esc(item.id)}')">已读</button></div></article>`;
  }).join('') || `<p>暂无新增邀请提醒。点击“检测新增”即可逐站检查。${inviteAlertData.lastScan ? `上次成功 ${inviteAlertData.lastScan.refreshed}/${inviteAlertData.lastScan.monitored} 个站点${inviteAlertData.lastScan.failed ? `，失败 ${inviteAlertData.lastScan.failed} 个` : ''}。` : ''}</p>`;
};

window.loadInviteAlerts = async () => {
  try {
    inviteAlertData = await api('/api/invite-alerts');
    renderInviteAlerts(); setInviteAlertBadge(inviteAlertData.unreadCount || 0);
  } catch (error) { alert(`邀请提醒加载失败：${error.message}`); }
};

window.scanInvites = async () => {
  const button = $('#scanInvites'); const original = button.textContent;
  button.disabled = true; button.textContent = '逐站检测中…';
  try {
    inviteAlertData = await api('/api/invite-alerts/scan', { method: 'POST' });
    renderInviteAlerts(); setInviteAlertBadge(inviteAlertData.unreadCount || 0);
  } catch (error) { alert(`邀请检测失败：${error.message}`); }
  finally { button.disabled = false; button.textContent = original; }
};

window.dismissInviteAlert = async id => {
  try {
    inviteAlertData = await api(`/api/invite-alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    renderInviteAlerts(); setInviteAlertBadge(inviteAlertData.unreadCount || 0);
  } catch (error) { alert(`已读操作失败：${error.message}`); }
};

window.clearInviteAlertHistory = async () => {
  if (!confirm('确定清空全部邀请提醒吗？')) return;
  inviteAlertData = await api('/api/invite-alerts', { method: 'DELETE' });
  renderInviteAlerts(); setInviteAlertBadge(0);
};

function usdPerCall(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return '—';
  if (price === 0) return '$0 / 次';
  return `$${price < 0.0001 ? price.toFixed(8) : price.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} / 次`;
}

function usdPerToken(inputValue, outputValue) {
  const input = inputValue === null || inputValue === undefined ? NaN : Number(inputValue);
  const output = outputValue === null || outputValue === undefined ? NaN : Number(outputValue);
  if (!Number.isFinite(input)) return '—';
  const shownOutput = Number.isFinite(output) ? output : input;
  return `输入 ${usdPerMillion(input)} · 输出 ${usdPerMillion(shownOutput)}`;
}

function usdPerMillion(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  const formatted = amount < 0.0001 && amount !== 0 ? amount.toFixed(8) : amount.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `$${formatted} / 1M`;
}

function watchedPrice(item, state = 'new') {
  const input = item[`${state}PriceUsd`];
  const output = item[`${state}OutputPriceUsd`];
  return (item.billing || 'call') === 'token' ? usdPerToken(input, output) : usdPerCall(input);
}

window.renderPriceModelSearch = () => {
  if (!priceAlertData) return;
  const query = String($('#priceModelSearch').value || '').trim().toLowerCase();
  const results = $('#priceModelSearchResults');
  if (!query) {
    results.innerHTML = '<p>输入模型名称后查看全站最低价。</p>';
    return;
  }
  const matches = (priceAlertData.modelPrices || []).filter(item => String(item.canonicalName || item.modelName || '').includes(query));
  if (!matches.length) {
    results.innerHTML = '<p>当前模型目录里没有找到匹配报价，可先点“立即扫描”更新各站数据。</p>';
    return;
  }
  const lowest = (billing, field) => matches
    .filter(item => item.billing === billing && Number.isFinite(Number(item[field])))
    .sort((a, b) => Number(a[field]) - Number(b[field]) || a.accountName.localeCompare(b.accountName))[0];
  const cards = [
    { label: '按次最低', item: lowest('call', 'priceUsd'), format: item => usdPerCall(item.priceUsd) },
    { label: '输入最低', item: lowest('token', 'priceUsd'), format: item => usdPerMillion(item.priceUsd) },
    { label: '输出最低', item: lowest('token', 'outputPriceUsd'), format: item => usdPerMillion(item.outputPriceUsd) }
  ];
  const siteCount = new Set(matches.map(item => item.accountId)).size;
  const modelCount = new Set(matches.map(item => item.canonicalName || item.modelName)).size;
  results.innerHTML = `<p class="price-search-summary">找到 ${modelCount} 个模型、${matches.length} 条报价，来自 ${siteCount} 个站点。</p><div class="price-search-cards">${cards.map(({ label, item, format }) => item
    ? `<article><span>${label}</span><strong>${esc(format(item))}</strong><b>${esc(item.modelName)}</b><small>${esc(item.accountName)}</small></article>`
    : `<article class="empty"><span>${label}</span><strong>暂无</strong><small>没有这种计费方式</small></article>`).join('')}</div>`;
};

window.renderPriceAlerts = () => {
  if (!priceAlertData) return;
  const siteSelect = $('#priceSiteFilter');
  const selectedSite = siteSelect.value;
  siteSelect.innerHTML = '<option value="">全部站点</option>' + (priceAlertData.sites || []).map(site => `<option value="${esc(site.id)}">${esc(site.name)}</option>`).join('');
  siteSelect.value = selectedSite;
  const activeSite = siteSelect.value;
  const activeBilling = $('#priceBillingFilter').value;
  const activeScope = $('#priceScopeFilter').value;
  const alerts = priceAlertData.alerts.filter(item => (!activeSite || item.accountId === activeSite || item.currentAccountId === activeSite) && (!activeBilling || (item.billing || 'call') === activeBilling) && (!activeScope || (item.scope || 'precise') === activeScope));
  const callLeaderCount = (priceAlertData.leaders?.length || 0) + (priceAlertData.broadLeaders?.length || 0);
  const tokenLeaderCount = (priceAlertData.tokenLeaders?.length || 0) + (priceAlertData.tokenBroadLeaders?.length || 0);
  $('#priceLeaderCount').textContent = (activeBilling === 'call' ? callLeaderCount : activeBilling === 'token' ? tokenLeaderCount : callLeaderCount + tokenLeaderCount).toLocaleString();
  $('#priceUnreadCount').textContent = alerts.filter(item => item.unread).length.toLocaleString();
  $('#priceSiteCount').textContent = (priceAlertData.lastScan?.monitored || 0).toLocaleString();
  $('#priceFailureCount').textContent = (priceAlertData.lastScan?.failed || 0).toLocaleString();
  $('#priceAlertsUpdatedAt').textContent = priceAlertData.lastCheckedAt ? `扫描于 ${new Date(priceAlertData.lastCheckedAt).toLocaleString()}` : '尚未扫描';
  $('#priceScanHint').textContent = priceAlertData.lastScan
    ? `本次已在后台尝试全部 ${priceAlertData.lastScan.monitored} 个启用站点，成功刷新 ${priceAlertData.lastScan.refreshed} 个${priceAlertData.lastScan.failed ? `，${priceAlertData.lastScan.failed} 个失败` : ''}。认证失败不会启动浏览器；按量以输入价格为主、输出价格为次进行比较。`
    : '按次与按量的两套规则首次扫描都只建立价格基准，不产生提醒；自动扫描不会启动浏览器登录。';
  renderPriceModelSearch();
  $('#priceAlertHistory').innerHTML = alerts.map(item => {
    const watchText = item.pinned
      ? item.watchStatus === 'missing' ? `原站点模型已消失 · ${esc(item.watchedAccountName || item.accountName)} · ${esc(item.watchedModelName || item.modelName)}`
        : `${esc(item.watchMessage || '持续观察中')} · 当前 ${esc(watchedPrice(item, 'current'))}${item.currentModelName ? ` · ${esc(item.currentModelName)}` : ''}${item.currentAccountName ? ` · ${esc(item.currentAccountName)}` : ''}${item.watchCheckMessage ? ` · ${esc(item.watchCheckMessage)}` : ''}`
      : '';
    const scopeLabel = item.scope === 'broad' ? '一个连接符' : '两个连接符';
    const billingLabel = (item.billing || 'call') === 'token' ? '按量' : '按次';
    return `<article class="${item.unread ? 'unread ' : ''}${item.pinned ? 'pinned' : ''}"><strong>${item.pinned ? '<i class="pin-mark">加精</i>' : ''}<i class="comparison-mark">${billingLabel}</i><i class="comparison-mark">${scopeLabel}</i>${esc(item.comparisonName || item.modelName)}</strong><b class="price-drop">${esc(watchedPrice(item))}</b><span>当时最低变体：${esc(item.modelName)}</span><span>${item.kind === 'new' ? '新发现可用最低价' : `<span class="price-old">${esc(watchedPrice(item, 'old'))}</span> → 降价`}</span><span>${esc(item.accountName)}</span>${watchText ? `<p class="watch-state ${esc(item.watchStatus || 'watching')}">${watchText}</p>` : ''}<time>${new Date(item.detectedAt).toLocaleString()}${item.lastChangedAt ? ` · 最近变化 ${new Date(item.lastChangedAt).toLocaleString()}` : ''}</time><div class="price-alert-actions"><button class="ghost" onclick="togglePriceAlertPin('${esc(item.id)}',${!item.pinned})">${item.pinned ? '取消加精' : '加精'}</button><button class="ghost" onclick="dismissPriceAlert('${esc(item.id)}')">已读</button></div></article>`;
  }).join('') || '<p>暂无降价提醒。</p>';
};

window.loadPriceAlerts = async () => {
  try {
    priceAlertData = await api('/api/price-alerts');
    renderPriceAlerts();
    setPriceAlertBadge(priceAlertData.unreadCount || 0);
  } catch (error) { alert(`降价提醒加载失败：${error.message}`); }
};

window.scanPrices = async () => {
  const button = $('#scanPrices'); const original = button.textContent;
  button.disabled = true; button.textContent = '扫描中…';
  try {
    priceAlertData = await api('/api/price-alerts/scan', { method: 'POST' });
    renderPriceAlerts();
    setPriceAlertBadge(priceAlertData.unreadCount || 0);
  } catch (error) { alert(`价格扫描失败：${error.message}`); }
  finally { button.disabled = false; button.textContent = original; }
};

window.clearPriceAlertHistory = async () => {
  if (!confirm('确定清除全部未加精消息吗？加精观察项会保留。')) return;
  priceAlertData = await api('/api/price-alerts', { method: 'DELETE' });
  renderPriceAlerts(); setPriceAlertBadge(priceAlertData.unreadCount || 0);
};

window.togglePriceAlertPin = async (id, pinned) => {
  try {
    priceAlertData = await api(`/api/price-alerts/${encodeURIComponent(id)}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) });
    renderPriceAlerts(); setPriceAlertBadge(priceAlertData.unreadCount || 0);
  } catch (error) { alert(`加精操作失败：${error.message}`); }
};

window.dismissPriceAlert = async id => {
  try {
    priceAlertData = await api(`/api/price-alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    renderPriceAlerts(); setPriceAlertBadge(priceAlertData.unreadCount || 0);
  } catch (error) { alert(`已读操作失败：${error.message}`); }
};

window.loadStats = async () => {
  try {
    const range = Number($('#trendRange').value || 7);
    const query = new URLSearchParams({ days: range, accountId: $('#statsAccount').value, modelName: $('#statsModel').value });
    const data = await api(`/api/stats?${query}`);
    const selectedAccount = $('#statsAccount').value; const selectedModel = $('#statsModel').value;
    $('#statsAccount').innerHTML = '<option value="">全部站点</option>' + data.filters.accounts.map(account => `<option value="${esc(account.id)}">${esc(account.name)}</option>`).join('');
    $('#statsModel').innerHTML = '<option value="">全部模型</option>' + data.filters.models.map(model => `<option value="${esc(model)}">${esc(model)}</option>`).join('');
    $('#statsAccount').value = selectedAccount; $('#statsModel').value = selectedModel;
    const accountLabel = data.filters.accounts.find(account => account.id === selectedAccount)?.name || '全部站点';
    $('#statsScope').textContent = `当前范围：${accountLabel} · ${selectedModel || '全部模型'}`;
    $('#statsUpdatedAt').textContent = `更新于 ${new Date(data.updatedAt).toLocaleTimeString()}`;
    $('#todayRequests').textContent = data.today.requests.toLocaleString();
    $('#todaySuccessRate').textContent = `${data.today.successRate}%`;
    $('#monthRequests').textContent = data.month.requests.toLocaleString();
    $('#allResults').textContent = `${data.all.successful.toLocaleString()} / ${data.all.failed.toLocaleString()}`;
    $('#firstHitRate').textContent = `${data.all.firstHitRate}%`;
    $('#switchCount').textContent = data.all.switched.toLocaleString();
    $('#averageLatency').textContent = data.all.averageLatencyMs === null ? '—' : `${data.all.averageLatencyMs} ms`;
    $('#p95Latency').textContent = data.all.p95LatencyMs === null ? '—' : `${data.all.p95LatencyMs} ms`;
    $('#inputTokens').textContent = data.tokens.all.input.toLocaleString(); $('#todayInputTokens').textContent = `今日 ${data.tokens.today.input.toLocaleString()}`;
    $('#outputTokens').textContent = data.tokens.all.output.toLocaleString(); $('#todayOutputTokens').textContent = `今日 ${data.tokens.today.output.toLocaleString()}`;
    $('#cachedTokens').textContent = data.tokens.all.cached.toLocaleString(); $('#todayCachedTokens').textContent = `今日 ${data.tokens.today.cached.toLocaleString()}`;
    $('#totalTokens').textContent = data.tokens.all.total.toLocaleString(); $('#measuredRequests').textContent = `${data.tokens.all.measured.toLocaleString()} 次返回用量`;
    const money = value => `¥${Number(value || 0).toFixed(4)}`;
    $('#nominalCost').textContent = `${Number(data.costs?.nominalUsd || 0).toFixed(4)} 额度`;
    $('#referenceCost').textContent = money(data.costs?.referenceCny);
    $('#actualCost').textContent = money(data.costs?.actualCny);
    const saved = Number(data.costs?.savedCny || 0);
    $('#savingLabel').textContent = saved < 0 ? '可信金额多花' : '可信累计节省';
    $('#savedCost').textContent = money(Math.abs(saved));
    const costs = data.costs || {};
    const costDetails = [
      `${Number(costs.pricedRequests || 0).toLocaleString()} / ${Number(costs.totalSuccessful || 0).toLocaleString()} 次带价格快照`,
      `${Number(costs.coveredSites || 0)} 个站点`
    ];
    if (Number(costs.freeCreditEstimates || 0) > 0) costDetails.push(`${Number(costs.freeCreditEstimates).toLocaleString()} 次无充值，按免费额度`);
    if (Number(costs.tokenSplitEstimates || 0) > 0) costDetails.push(`${Number(costs.tokenSplitEstimates).toLocaleString()} 次仅总 Token 估算`);
    if (Number(costs.missingPriceOrUsage || 0) > 0) costDetails.push(`${Number(costs.missingPriceOrUsage).toLocaleString()} 次缺价格或用量`);
    if (Number(costs.missingConversion || 0) > 0) costDetails.push(`${Number(costs.missingConversion).toLocaleString()} 次未取得充值换算`);
    $('#pricedRequests').textContent = costDetails.join(' · ');
    const historical = costs.historical || {};
    $('#historicalSavedCost').textContent = money(Math.abs(Number(historical.savedCny || 0)));
    const historicalDetails = [
      `${Number(historical.pricedRequests || 0).toLocaleString()} 次旧调用`,
      `${Number(historical.coveredSites || 0).toLocaleString()} 个站点`,
      `站内额度 ${Number(historical.nominalUsd || 0).toFixed(4)}`,
      `额度价值 ${money(historical.referenceCny)}`
    ];
    if (Number(historical.tokenSplitEstimates || 0) > 0) historicalDetails.push(`${Number(historical.tokenSplitEstimates).toLocaleString()} 次仅总 Token 估算`);
    $('#historicalCostSummary').textContent = `${historicalDetails.join(' · ')}。旧日志没有调用时价格，不计入上方可信总额。`;
    const costRows = (costs.breakdown || []).map(row => {
      const kind = row.estimated ? '旧估算' : '可信快照';
      const usage = row.billing === 'call' ? `${Number(row.requests || 0).toLocaleString()} 次` : `${Number(row.totalTokens || 0).toLocaleString()} Token`;
      const estimateNote = Number(row.tokenSplitEstimates || 0) > 0 ? ` · ${Number(row.tokenSplitEstimates).toLocaleString()} 次仅总 Token` : '';
      const converted = row.conversionAvailable ? `额度价值 ${money(row.referenceCny)} · 节省 ${money(row.savedCny)}` : '未取得本站充值换算，暂不折算人民币';
      return `<div class="cost-breakdown-row ${row.estimated ? 'estimated' : 'trusted'}"><span><strong>${esc(row.accountName)} · ${esc(row.modelName)}</strong><small>${kind} · ${esc((row.priceLabels || []).join(' / ') || '价格未知')} · ${usage}${estimateNote}</small></span><em><strong>${Number(row.nominalUsd || 0).toFixed(4)} 额度</strong><small>${converted}</small></em></div>`;
    }).join('');
    $('#costBreakdown').innerHTML = costRows || '<p>暂无可计算的费用记录。</p>';
    $('#trendTitle').textContent = `近 ${range} 天请求`;
    const max = Math.max(1, ...data.days.map(day => day.requests));
    $('#trendChart').innerHTML = data.days.map(day => `<div class="trend-day"><div class="trend-bar"><i style="height:${Math.max(day.requests ? 8 : 2, day.requests / max * 100)}%"></i></div><strong>${day.requests}</strong><span>${esc(day.date.slice(5))}</span></div>`).join('');
    const rows = list => list.map((row, index) => `<div><b>${index + 1}</b><span><strong>${esc(row.name)}</strong><small>${row.attempts} 次尝试 · 成功 ${row.successful} · 失败 ${row.failed}</small><i class="success-bar"><u style="width:${row.successRate}%"></u></i></span><em>${row.successRate}%<small>${row.averageLatencyMs === null ? '—' : row.averageLatencyMs + ' ms'}</small></em></div>`).join('') || '<p>当前范围还没有网关调用记录。</p>';
    $('#siteRanking').innerHTML = rows(data.sites);
    $('#modelRanking').innerHTML = rows(data.models);
    const compactRows = list => list.map((row, index) => `<div><b>${index + 1}</b><span><strong>${esc(row.name)}</strong></span><em>${row.count.toLocaleString()} 次</em></div>`).join('') || '<p>暂无记录。</p>';
    $('#failureRanking').innerHTML = compactRows(data.failures);
    $('#endpointRanking').innerHTML = compactRows(data.endpoints);
  } catch (error) { alert(`统计加载失败：${error.message}`); }
};

window.loadLogs = async () => {
  try {
    const query = new URLSearchParams({ action: $('#logAction').value, status: $('#logStatus').value, accountId: $('#logAccount').value });
    const data = await api(`/api/logs?${query}`);
    const selected = $('#logAccount').value;
    $('#logAccount').innerHTML = '<option value="">全部站点</option>' + data.accounts.map(account => `<option value="${esc(account.id)}">${esc(account.name)}</option>`).join('');
    $('#logAccount').value = selected;
    $('#logResults').innerHTML = data.runs.map(run => {
      const action = run.action === 'gateway' ? '网关' : run.action === 'checkin' ? '签到' : '轮询';
      const result = run.status === 'ok' ? '成功' : run.status === 'already' ? '已签到' : '失败';
      const usage = Number.isFinite(run.totalTokens) ? `输入 ${run.inputTokens || 0} · 输出 ${run.outputTokens || 0} · 缓存 ${run.cachedTokens || 0} · 总计 ${run.totalTokens}` : '';
      const route = run.adapterLabel || (run.adapted ? `${run.endpoint} → ${run.upstreamEndpoint}` : run.endpoint || '');
      const details = [run.modelName, route, usage, Number.isFinite(run.latencyMs) ? `${run.latencyMs} ms` : '', run.statusCode && !run.upstreamError ? `HTTP ${run.statusCode}` : '', run.upstreamError || ''].filter(Boolean).join(' · ');
      return `<article><time>${new Date(run.startedAt).toLocaleString()}</time><strong>${esc(run.accountName)}</strong><span class="log-kind">${action}</span><span class="${run.status}">${result}</span><p>${esc(details || run.message || '—')}</p></article>`;
    }).join('') || '<p>当前筛选下没有日志。</p>';
  } catch (error) { alert(`日志加载失败：${error.message}`); }
};
for (const selector of ['#logAction', '#logStatus', '#logAccount']) document.addEventListener('change', event => { if (event.target.matches(selector)) loadLogs(); });

window.setTagFilter = tag => { activeFilter = tag; render(dashboardData); };
window.toggleErrorFilter = () => { activeStatusFilter = activeStatusFilter === 'error' ? '' : 'error'; render(dashboardData); };
let draggedAccount = '';
window.startAccountDrag = (event, id) => { draggedAccount = id; event.dataTransfer.effectAllowed = 'move'; event.currentTarget.classList.add('dragging'); };
window.dragAccountOver = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; event.currentTarget.classList.add('drag-over'); };
window.endAccountDrag = event => { event.currentTarget.classList.remove('dragging'); document.querySelectorAll('.drag-over').forEach(card => card.classList.remove('drag-over')); };
window.dropAccount = async (event, targetId) => {
  event.preventDefault(); event.currentTarget.classList.remove('drag-over');
  if (!draggedAccount || draggedAccount === targetId) return;
  const visible = filteredAccounts(accounts);
  const from = visible.findIndex(account => account.id === draggedAccount); const target = visible.findIndex(account => account.id === targetId);
  if (from < 0 || target < 0) return;
  const [moved] = visible.splice(from, 1); const rect = event.currentTarget.getBoundingClientRect();
  let insertAt = visible.findIndex(account => account.id === targetId);
  if (event.clientY > rect.top + rect.height / 2) insertAt += 1;
  visible.splice(insertAt, 0, moved); draggedAccount = '';
  await api('/api/accounts/order', { method: 'POST', body: JSON.stringify({ orderedIds: visible.map(account => account.id) }) });
  await load();
};

$('#loginForm').onsubmit = async event => {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector('button');
  button.disabled = true;
  button.textContent = '正在登录…';
  $('#loginError').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: new FormData(event.target).get('password') }) });
    await load();
  } catch (error) { $('#loginError').textContent = error.message; }
  finally { button.disabled = false; button.textContent = '进入控制台'; }
};

$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
$('#addTagForm').onsubmit = async event => {
  event.preventDefault(); const form = event.target; const tag = new FormData(form).get('tag');
  try { await api('/api/tags', { method: 'POST', body: JSON.stringify({ tag }) }); form.reset(); load(); }
  catch (error) { alert(error.message); }
};
$('#add').onclick = () => { const form = $('#accountForm'); form.reset(); form.elements.id.value = ''; $('#accountSaveError').textContent = ''; toggleFields(); $('#editor').showModal(); };
$('#cancel').onclick = () => $('#editor').close();
function toggleFields() { const custom = $('#panelType').value === 'generic'; $('#simpleFields').classList.toggle('hidden', custom); $('#advancedFields').classList.toggle('hidden', !custom); }
$('#panelType').onchange = toggleFields;
$('#accountForm').onsubmit = async event => {
  event.preventDefault();
  const button = $('#accountSaveButton');
  $('#accountSaveError').textContent = '';
  const values = Object.fromEntries(new FormData(event.target));
  if (values.panelType === 'generic') values.credential = values.genericCredential;
  delete values.genericCredential;
  button.disabled = true; button.textContent = '正在保存…';
  try {
    await api('/api/accounts', { method: 'POST', body: JSON.stringify(values) });
    $('#editor').close(); await load();
  } catch (error) { $('#accountSaveError').textContent = error.message; }
  finally { button.disabled = false; button.textContent = '保存'; }
};

window.edit = id => { const account = accounts.find(x => x.id === id), form = $('#accountForm'); form.reset(); $('#accountSaveError').textContent = ''; Object.entries(account).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value ?? ''; }); toggleFields(); $('#editor').showModal(); };
window.run = async (id, action, button) => {
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = action === 'checkin' ? '签到中…' : '刷新中…'; }
  try { await api(`/api/accounts/${id}/${action}`, { method: 'POST' }); }
  catch (error) { alert(error.message); }
  finally {
    if (button) { button.disabled = false; button.textContent = original; }
    await load();
  }
};
window.openServerBrowser = async id => {
  const browserWindow = window.open('about:blank', 'sitePointsServerBrowser');
  try {
    await api(`/api/accounts/${id}/browser-open`, { method: 'POST' });
    if (browserWindow) browserWindow.location = '/browser'; else location.href = '/browser';
  } catch (error) {
    browserWindow?.close();
    alert(`服务器浏览器打开失败：${error.message}`);
  }
};
let taggingAccount = '';
window.openTagPicker = id => {
  taggingAccount = id; const account = accounts.find(x => x.id === id); const selected = new Set(account.tags || []);
  $('#tagPickerTitle').textContent = `${account.name} · 选择标签`;
  $('#tagChoices').innerHTML = tags.map(tag => `<label><input type="checkbox" name="tags" value="${esc(tag)}" ${selected.has(tag) ? 'checked' : ''}> ${esc(tag)}</label>`).join('') || '<p>还没有标签，请先在页面顶部添加。</p>';
  $('#tagPicker').showModal();
};
$('#tagPickerForm').onsubmit = async event => {
  event.preventDefault(); const selected = new FormData(event.target).getAll('tags');
  await api(`/api/accounts/${taggingAccount}/tags`, { method: 'POST', body: JSON.stringify({ tags: selected }) });
  $('#tagPicker').close(); load();
};
$('#closeTags').onclick = () => $('#tagPicker').close();
let pickingAccount = ''; let pickedModels = []; let modelLoadSequence = 0; let modelsLoading = false;
let activeBilling = localStorage.getItem('modelBilling') === 'token' ? 'token' : 'call';
function showCategory(category) {
  document.querySelectorAll('.category-button').forEach(button => button.classList.toggle('active', button.dataset.category === category));
  const models = pickedModels.filter(model => model.billing === activeBilling && model.category === category);
  $('#modelChoices').innerHTML = models.map(model => {
    const estimate = model.estimatedCalls === 'unlimited' ? ' · 预计不限次数' : Number.isInteger(model.estimatedCalls) ? ` · 预计还可 ${model.estimatedCalls.toLocaleString()} 次` : ' · 刷新余额后估算';
    return `<button class="model-choice" data-model="${esc(model.name)}" onclick="chooseModel(this.dataset.model)"><span>${esc(model.name)}</span><strong>${esc(model.text + (model.billing === 'call' ? estimate : ''))}</strong></button>`;
  }).join('') || '<p>这个分类没有模型。</p>';
}
function renderCategories() {
  if (modelsLoading) {
    $('#modelCategories').innerHTML = '<p>正在拉取当前站点的模型和价格…</p>';
    $('#modelChoices').innerHTML = '';
    return;
  }
  const visible = pickedModels.filter(model => model.billing === activeBilling);
  const categories = [...new Set(visible.map(model => model.category))];
  $('#modelCategories').innerHTML = categories.map(category => `<button class="category-button ghost" data-category="${esc(category)}" onclick="showCategory('${esc(category)}')">${esc(category)} <small>${visible.filter(model => model.category === category).length}</small></button>`).join('') || `<p>没有找到可用的${activeBilling === 'call' ? '按次' : '按量'}模型。</p>`;
  $('#modelChoices').innerHTML = '';
  if (categories.length) showCategory(categories[0]);
}
window.setBilling = billing => { activeBilling = billing; localStorage.setItem('modelBilling', billing); document.querySelectorAll('.billing-button').forEach(button => { const active = button.dataset.billing === billing; button.classList.toggle('active', active); button.classList.toggle('ghost', !active); }); renderCategories(); };
window.openModels = async id => {
  const requestSequence = ++modelLoadSequence;
  pickingAccount = id;
  const account = accounts.find(x => x.id === id);
  if (!account?.hasApiKey) return alert('请先编辑站点并填写 API Key');
  pickedModels = [];
  modelsLoading = true;
  $('#modelPickerTitle').textContent = `${account.name} · 选择模型`;
  $('#modelPicker').showModal();
  setBilling(activeBilling);
  try {
    const models = (await api(`/api/accounts/${id}/models`, { method: 'POST' })).models;
    if (requestSequence !== modelLoadSequence || pickingAccount !== id) return;
    pickedModels = models;
    modelsLoading = false;
    setBilling(activeBilling);
  } catch (error) {
    if (requestSequence !== modelLoadSequence || pickingAccount !== id) return;
    modelsLoading = false;
    $('#modelCategories').innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
};
window.showCategory = showCategory;
window.chooseModel = async model => { await api(`/api/accounts/${pickingAccount}/model`, { method: 'POST', body: JSON.stringify({ model }) }); $('#modelPicker').close(); load(); };
window.testModel = async (id, button) => {
  const original = button.textContent;
  button.disabled = true; button.textContent = '测试中…';
  try {
    const result = await api(`/api/accounts/${id}/model-test`, { method: 'POST' });
    alert(`模型调用成功：${result.model}\n响应耗时：${result.latencyMs} ms\n本次已真实调用，会计入上游使用记录并消耗相应额度。`);
  } catch (error) { alert(`模型连接失败：${error.message}`); }
  finally { button.disabled = false; button.textContent = original; }
};
$('#closeModels').onclick = () => {
  modelLoadSequence++;
  modelsLoading = false;
  pickedModels = [];
  $('#modelPicker').close();
};
window.togglePollTag = async (tag, enabled) => { try { await api('/api/poll-tags', { method: 'POST', body: JSON.stringify({ tag, enabled }) }); load(); } catch (error) { alert(error.message); } };
window.deleteTag = async tag => {
  if (!confirm(`确定删除标签“${tag}”吗？它会从所有站点中移除。`)) return;
  await api(`/api/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
  if (activeFilter === tag) activeFilter = '';
  await load();
};
window.removeAccount = async id => { if (confirm('确定删除这个站点？')) { await api(`/api/accounts/${id}`, { method: 'DELETE' }); load(); } };
async function runBatch(action, button) {
  const targets = filteredAccounts(accounts);
  if (!targets.length) return alert('当前筛选下没有可执行的站点。');
  const original = button.textContent; let ok = 0; let failed = 0; button.disabled = true;
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const account = targets[index];
      button.textContent = `${index + 1}/${targets.length} ${account.name}`;
      $('#batchProgress').textContent = `正在${action === 'checkin' ? '签到' : '刷新'} ${index + 1}/${targets.length}：${account.name}`;
      try { const result = await api(`/api/accounts/${account.id}/${action}`, { method: 'POST' }); result.lastStatus === 'error' ? failed += 1 : ok += 1; }
      catch { failed += 1; }
    }
    $('#batchProgress').textContent = `执行完成：成功 ${ok} 个，失败 ${failed} 个。`;
    await load();
  } finally { button.disabled = false; button.textContent = original; }
}
$('#pollAll').onclick = event => runBatch('poll', event.currentTarget);
$('#checkinAll').onclick = event => runBatch('checkin', event.currentTarget);
load();
