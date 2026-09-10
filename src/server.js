import express from 'express';
import crypto from 'node:crypto';
import net from 'node:net';
import { encrypt, mutateStore, readStore, writeStore } from './store.js';
import { estimateAccountCalls, refreshModelCatalog, refreshModelPrice, runAccount, runAll, safeUrl, testModelConnection } from './runner.js';
import { installGateway } from './gateway.js';
import { createSession, validSession } from './session.js';
import { gatewayStatistics } from './stats.js';
import { browserAvailable, openBrowserLogin, waitForBrowserLogin } from './browser.js';
import { clearPriceAlerts, dismissPriceAlert, markPriceAlertsRead, priceAlertsView, scanPriceAlerts, setPriceAlertPinned } from './price-alerts.js';
import { clearInviteAlerts, dismissInviteAlert, inviteAlertsView } from './invite-alerts.js';

const app = express();
const port = Number(process.env.PORT || 8080);
const password = process.env.ADMIN_PASSWORD || 'admin';
const sessionSecret = process.env.APP_SECRET || 'development-only-secret';
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
installGateway(app);

function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(x => x.trim().split('='))); }
function auth(req, res, next) { if (!validSession(cookies(req).session, sessionSecret)) return res.status(401).json({ error: '请先登录' }); next(); }
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/browser', auth, (_req, res) => res.redirect('/browser/vnc.html?path=browser/websockify&autoconnect=true&resize=scale'));
app.use('/browser', auth, express.static(process.env.BROWSER_WEB_ROOT || '/usr/share/novnc'));
app.get('/api/public/invites', (_req, res) => {
  const db = readStore();
  const invites = db.accounts.flatMap(account => {
    try {
      const url = new URL(String(account.inviteUrl || ''));
      if (url.protocol !== 'https:') return [];
      return [{ name: String(account.name || '').trim(), tags: (account.tags || []).map(tag => String(tag)).filter(Boolean), url: url.href }];
    } catch { return []; }
  }).filter(item => item.name);
  res.json({ invites });
});
app.post('/api/login', (req, res) => {
  const a = Buffer.from(String(req.body.password || '')); const b = Buffer.from(password);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: '密码错误' });
  const token = createSession(sessionSecret);
  res.setHeader('set-cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', auth, (_req, res) => { res.setHeader('set-cookie', 'session=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/dashboard', auth, (_req, res) => {
  const db = readStore();
  const tags = [...new Set([...(db.tags || []), ...db.accounts.flatMap(account => account.tags || [])])];
  res.json({ accounts: db.accounts.map(({ credential, refreshCookie, pricingCookie, apiKey, balanceBody, browserAccessToken, models, ...x }) => ({ ...x, hasCredential: Boolean(credential), hasRefreshCookie: Boolean(refreshCookie), hasPricingCookie: Boolean(pricingCookie), hasApiKey: Boolean(apiKey), hasBalanceBody: Boolean(balanceBody), modelCount: models?.length || 0 })), tags, pollTags: db.pollTags || [], runs: db.runs.slice(0, 30), priceAlertUnreadCount: priceAlertsView(db).unreadCount, inviteAlertUnreadCount: inviteAlertsView(db).unreadCount });
});
app.get('/api/stats', auth, (_req, res) => {
  const db = readStore();
  const days = Number(_req.query.days) === 30 ? 30 : 7;
  const accountId = String(_req.query.accountId || '').slice(0, 100); const modelName = String(_req.query.modelName || '').slice(0, 200);
  res.json(gatewayStatistics(db.runs, db.accounts, new Date(), process.env.TZ || 'Asia/Shanghai', days, { accountId, modelName }));
});
app.get('/api/logs', auth, (req, res) => {
  const db = readStore();
  const action = String(req.query.action || ''); const status = String(req.query.status || ''); const accountId = String(req.query.accountId || '');
  const allowedActions = new Set(['', 'gateway', 'poll', 'checkin']); const allowedStatuses = new Set(['', 'ok', 'error', 'already']);
  if (!allowedActions.has(action) || !allowedStatuses.has(status)) return res.status(400).json({ error: '筛选条件无效' });
  const accountNames = new Map(db.accounts.map(account => [account.id, account.name]));
  const runs = db.runs.filter(run => (!action || run.action === action) && (!status || run.status === status) && (!accountId || run.accountId === accountId)).slice(0, 500);
  res.json({ runs: runs.map(run => ({ ...run, accountName: accountNames.get(run.accountId) || '已删除站点' })), accounts: db.accounts.map(account => ({ id: account.id, name: account.name })) });
});
app.get('/api/price-alerts', auth, (_req, res) => res.json(priceAlertsView()));
app.post('/api/price-alerts/scan', auth, async (_req, res) => {
  try { res.json(await scanPriceAlerts()); } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/price-alerts/read', auth, (_req, res) => res.json(markPriceAlertsRead()));
app.post('/api/price-alerts/:id/pin', auth, (req, res) => {
  try { res.json(setPriceAlertPinned(req.params.id, req.body.pinned !== false)); } catch (error) { res.status(404).json({ error: error.message }); }
});
app.delete('/api/price-alerts/:id', auth, (req, res) => {
  try { res.json(dismissPriceAlert(req.params.id)); } catch (error) { res.status(404).json({ error: error.message }); }
});
app.delete('/api/price-alerts', auth, (_req, res) => res.json(clearPriceAlerts()));
app.get('/api/invite-alerts', auth, (_req, res) => res.json(inviteAlertsView()));
let activeInviteScan = null;
async function performInviteScan() {
  const snapshot = readStore();
  const candidates = snapshot.accounts.filter(account => account.enabled !== false);
  const previousCounts = new Map(candidates.map(account => [
    account.id,
    account.inviteCount !== undefined && account.inviteCount !== null && Number.isFinite(Number(account.inviteCount))
      ? Math.trunc(Number(account.inviteCount)) : null
  ]));
  const additions = []; const errors = []; let refreshed = 0;
  for (const account of candidates) {
    try {
      const result = await runAccount(account.id, 'poll');
      if (result.lastStatus !== 'ok') {
        errors.push({ accountId: account.id, accountName: account.name, message: result.lastError || '检测失败' });
        continue;
      }
      refreshed++;
      const previous = previousCounts.get(account.id); const current = Number(result.inviteCount);
      if (previous !== null && Number.isFinite(current) && current > previous) {
        additions.push({ accountId: account.id, accountName: account.name, addedCount: Math.trunc(current) - previous });
      }
    } catch (error) {
      errors.push({ accountId: account.id, accountName: account.name, message: error.message });
    }
  }
  const db = readStore(); db.inviteWatch ||= {};
  db.inviteWatch.lastScan = {
    monitored: candidates.length, refreshed, failed: errors.length,
    addedCount: additions.reduce((sum, item) => sum + item.addedCount, 0),
    additions, errors: errors.slice(0, 30), checkedAt: new Date().toISOString()
  };
  writeStore(db);
  return inviteAlertsView(db);
}
app.post('/api/invite-alerts/scan', auth, async (_req, res) => {
  try {
    if (!activeInviteScan) activeInviteScan = performInviteScan().finally(() => { activeInviteScan = null; });
    res.json(await activeInviteScan);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/invite-alerts/:id', auth, (req, res) => {
  try { res.json(dismissInviteAlert(req.params.id)); } catch (error) { res.status(404).json({ error: error.message }); }
});
app.delete('/api/invite-alerts', auth, (_req, res) => res.json(clearInviteAlerts()));
app.post('/api/accounts', auth, (req, res) => {
  const b = req.body;
  if (!b.name || !b.baseUrl) return res.status(400).json({ error: '名称和站点地址必填' });
  const db = readStore(); const old = b.id && db.accounts.find(x => x.id === b.id);
  let balanceBody = old?.balanceBody || '';
  if (String(b.balanceBody || '').trim()) {
    try { JSON.parse(b.balanceBody); } catch { return res.status(400).json({ error: '余额请求体必须是合法 JSON' }); }
    balanceBody = encrypt(String(b.balanceBody).trim());
  }
  const tags = b.tags === undefined ? old?.tags || [] : Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(/[,，]/);
  const account = {
    ...old, id: old?.id || crypto.randomUUID(), name: b.name.trim(), baseUrl: b.baseUrl.trim().replace(/\/$/, ''), inviteUrl: b.inviteUrl?.trim() || '', modelBaseUrl: b.modelBaseUrl?.trim().replace(/\/$/, '') || '', panelType: b.panelType || 'auto', currency: b.currency || 'auto', userId: b.userId?.trim() || '', newApiCredentialType: b.newApiCredentialType ? (b.newApiCredentialType === 'bearer' ? 'bearer' : 'cookie') : old?.newApiCredentialType || 'cookie', modelName: b.modelName !== undefined ? b.modelName.trim() : old?.modelName || '', tags: [...new Set(tags.map(x => String(x).trim()).filter(Boolean))].slice(0, 10), balancePath: b.balancePath?.trim() || '', balanceMethod: b.balanceMethod === 'POST' ? 'POST' : 'GET', balanceBody, balanceField: b.balanceField || 'balance', balanceDivisor: b.balanceDivisor || '1', checkinPath: b.checkinPath?.trim() || '', checkinMethod: b.checkinMethod || 'POST', authType: b.authType || 'bearer', headerName: b.headerName || '', refreshPath: b.refreshPath?.trim() || '', refreshMode: b.refreshMode === 'browser' ? 'browser' : 'http', browserLoginAction: String(b.browserLoginAction || '').trim().slice(0, 60), enabled: b.enabled !== false,
    credential: b.credential ? encrypt(b.credential.replace(/^Bearer\s+/i, '')) : old?.credential || '',
    refreshCookie: b.refreshCookie ? encrypt(b.refreshCookie.replace(/^Cookie:\s*/i, '')) : old?.refreshCookie || '',
    pricingCookie: b.pricingCookie ? encrypt(b.pricingCookie.replace(/^Cookie:\s*/i, '')) : old?.pricingCookie || '',
    apiKey: b.apiKey ? encrypt(b.apiKey.replace(/^Bearer\s+/i, '')) : old?.apiKey || '', updatedAt: new Date().toISOString()
  };
  if (b.credential || (old?.newApiCredentialType && old.newApiCredentialType !== account.newApiCredentialType)) account.browserAccessToken = '';
  if (old?.modelName !== account.modelName) account.modelPrice = null;
  if (old) db.accounts[db.accounts.indexOf(old)] = account; else db.accounts.push(account);
  writeStore(db); res.json({ ok: true, id: account.id });
});
app.delete('/api/accounts/:id', auth, (req, res) => { const db = readStore(); db.accounts = db.accounts.filter(x => x.id !== req.params.id); writeStore(db); res.json({ ok: true }); });
app.post('/api/tags', auth, (req, res) => {
  const tag = String(req.body.tag || '').trim();
  if (!tag) return res.status(400).json({ error: '标签不能为空' });
  if (tag.length > 30) return res.status(400).json({ error: '标签最多 30 个字' });
  const db = readStore(); db.tags = [...new Set([...(db.tags || []), tag])];
  writeStore(db); res.json({ ok: true, tags: db.tags });
});
app.delete('/api/tags/:tag', auth, (req, res) => {
  const tag = String(req.params.tag || '').trim(); const db = readStore();
  db.tags = (db.tags || []).filter(item => item !== tag);
  db.pollTags = (db.pollTags || []).filter(item => item !== tag);
  db.accounts.forEach(account => { account.tags = (account.tags || []).filter(item => item !== tag); });
  writeStore(db); res.json({ ok: true });
});
app.post('/api/accounts/:id/tags', auth, (req, res) => {
  const db = readStore(); const account = db.accounts.find(x => x.id === req.params.id);
  if (!account) return res.status(404).json({ error: '账户不存在' });
  const known = new Set([...(db.tags || []), ...db.accounts.flatMap(item => item.tags || [])]);
  account.tags = [...new Set((Array.isArray(req.body.tags) ? req.body.tags : []).map(x => String(x).trim()).filter(tag => known.has(tag)))];
  writeStore(db); res.json({ ok: true, tags: account.tags });
});
app.post('/api/accounts/order', auth, (req, res) => {
  const db = readStore(); const orderedIds = Array.isArray(req.body.orderedIds) ? req.body.orderedIds : [];
  const selected = new Set(orderedIds); const byId = new Map(db.accounts.map(account => [account.id, account]));
  if (selected.size !== orderedIds.length || orderedIds.some(id => !byId.has(id))) return res.status(400).json({ error: '站点顺序无效' });
  const ordered = orderedIds.map(id => byId.get(id)); let index = 0;
  db.accounts = db.accounts.map(account => selected.has(account.id) ? ordered[index++] : account);
  writeStore(db); res.json({ ok: true });
});
app.post('/api/poll-tags', auth, (req, res) => {
  const tag = String(req.body.tag || '').trim();
  if (!tag) return res.status(400).json({ error: '标签不能为空' });
  const db = readStore(); const tags = new Set(db.pollTags || []);
  if (req.body.enabled === true) tags.add(tag); else tags.delete(tag);
  db.pollTags = [...tags]; writeStore(db); res.json({ ok: true, pollTags: db.pollTags });
});
app.post('/api/accounts/:id/polling', auth, (req, res) => {
  const db = readStore(); const account = db.accounts.find(x => x.id === req.params.id);
  if (!account) return res.status(404).json({ error: '账户不存在' });
  account.pollEnabled = req.body.enabled === true;
  writeStore(db); res.json({ ok: true, pollEnabled: account.pollEnabled });
});
app.post('/api/accounts/:id/pricing', auth, async (req, res) => { try { res.json(await refreshModelPrice(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/accounts/:id/models', auth, async (req, res) => { try { res.json({ models: await refreshModelCatalog(req.params.id) }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/accounts/:id/model', auth, (req, res) => {
  const db = readStore(); const account = db.accounts.find(x => x.id === req.params.id);
  if (!account) return res.status(404).json({ error: '账户不存在' });
  const model = account.models?.find(x => x.name === req.body.model);
  if (!model) return res.status(400).json({ error: '请从已拉取的模型中选择' });
  account.modelName = model.name;
  account.modelPrice = {
    type: model.billing === 'call' ? 'per_call' : 'tokens', text: model.text, model: model.name,
    price: model.price, priceUnit: model.priceUnit,
    estimatedCalls: estimateAccountCalls(account, model)
  };
  writeStore(db); res.json({ ok: true, modelName: model.name, modelPrice: account.modelPrice });
});
app.post('/api/accounts/:id/model-test', auth, async (req, res) => { try { res.json(await testModelConnection(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/browser/status', auth, async (_req, res) => res.json({ available: await browserAvailable() }));
app.post('/api/accounts/:id/browser-open', auth, async (req, res) => {
  try {
    const account = readStore().accounts.find(x => x.id === req.params.id);
    if (!account) return res.status(404).json({ error: '账户不存在' });
    if (account.refreshMode !== 'browser') return res.status(400).json({ error: '请先把续期方式设为服务器浏览器' });
    const url = await safeUrl(account.baseUrl, '/');
    const opened = await openBrowserLogin(url.href);
    const captureId = crypto.randomUUID();
    mutateStore(latest => {
      const saved = latest.accounts.find(item => item.id === account.id);
      if (saved) {
        saved.browserCaptureId = captureId;
        saved.browserCaptureStatus = 'waiting';
        saved.browserCaptureError = '';
      }
    });
    waitForBrowserLogin(account.baseUrl, opened.targetId).then(captured => {
      mutateStore(latest => {
        const saved = latest.accounts.find(item => item.id === account.id);
        if (!saved || saved.browserCaptureId !== captureId) return;
        if (captured.accessToken) saved.browserAccessToken = encrypt(captured.accessToken);
        if (captured.refreshCookie) saved.refreshCookie = encrypt(captured.refreshCookie);
        if (!captured.accessToken && !captured.refreshCookie && captured.sessionCookie
          && (saved.panelType !== 'generic' || saved.authType === 'cookie')) {
          saved.credential = encrypt(captured.sessionCookie);
          saved.newApiCredentialType = 'cookie';
        }
        saved.browserCaptureStatus = 'captured';
        saved.browserCaptureAt = new Date().toISOString();
        saved.browserCaptureError = '';
      });
    }).catch(error => {
      mutateStore(latest => {
        const saved = latest.accounts.find(item => item.id === account.id);
        if (!saved || saved.browserCaptureId !== captureId) return;
        saved.browserCaptureStatus = /超时/.test(error.message) ? 'timeout' : 'error';
        saved.browserCaptureError = error.message;
      });
    });
    const { targetId: _targetId, ...result } = opened;
    res.json({ ...result, capture: 'waiting' });
  } catch (e) { res.status(503).json({ error: e.message }); }
});
app.post('/api/accounts/:id/:action', auth, async (req, res) => { try { res.json(await runAccount(req.params.id, req.params.action)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/run-all/:action', auth, async (req, res) => { await runAll(req.params.action); res.json({ ok: true }); });

let lastCheckinDate = '';
setInterval(async () => {
  await runAll('poll');
  const now = new Date(); const hour = Number(process.env.AUTO_CHECKIN_HOUR ?? 8); const date = now.toLocaleDateString('sv-SE', { timeZone: process.env.TZ || 'Asia/Shanghai' });
  const localHour = Number(new Intl.DateTimeFormat('en', { hour: 'numeric', hour12: false, timeZone: process.env.TZ || 'Asia/Shanghai' }).format(now));
  if (localHour === hour && lastCheckinDate !== date) { lastCheckinDate = date; await runAll('checkin'); }
}, Math.max(1, Number(process.env.POLL_INTERVAL_MINUTES || 30)) * 60000).unref();

setTimeout(() => scanPriceAlerts().catch(error => console.error('[price-alerts]', error.message)), 15000).unref();
setInterval(() => scanPriceAlerts().catch(error => console.error('[price-alerts]', error.message)), Math.max(5, Number(process.env.PRICE_SCAN_INTERVAL_MINUTES || 30)) * 60000).unref();

const server = app.listen(port, '0.0.0.0', () => console.log(`Site Points Hub listening on ${port}`));
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/browser/websockify')) return socket.destroy();
  if (!validSession(cookies(req).session, sessionSecret)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = net.connect(6080, '127.0.0.1', () => {
    const headers = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) headers.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
    upstream.write(`${req.method} /websockify HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
});
