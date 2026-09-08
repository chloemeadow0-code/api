import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('add-site action clears the previous edit id', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /form\.elements\.id\.value\s*=\s*''/);
});

test('site cards include a safe external link', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /class="site-link"/);
  assert.match(source, /rel="noopener noreferrer"/);
});

test('expired login hides the stale dashboard', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /\$\('#app'\)\.classList\.add\('hidden'\)/);
  assert.match(source, /\$\('#logout'\)\.classList\.add\('hidden'\)/);
});

test('login explicitly sends cookies and shows progress', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /credentials:\s*'same-origin'/);
  assert.match(source, /正在登录/);
  assert.match(source, /await load\(\)/);
});

test('dashboard accepts accounts without a selected model price', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!price\?\.text\) return ''/);
});

test('model picker preserves amount billing instead of forcing per-call', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /localStorage\.getItem\('modelBilling'\)/);
  assert.match(source, /localStorage\.setItem\('modelBilling', billing\)/);
  assert.match(source, /setBilling\(activeBilling\)/);
  assert.doesNotMatch(source, /preferredBilling/);
});

test('model picker never renders models left over from another site', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /pickedModels = \[\];\s*modelsLoading = true/);
  assert.match(source, /const requestSequence = \+\+modelLoadSequence/);
  assert.match(source, /requestSequence !== modelLoadSequence \|\| pickingAccount !== id/);
  assert.match(source, /if \(modelsLoading\)/);
});

test('custom bearer accounts can save automatic refresh settings', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /name="refreshPath"/);
  assert.match(html, /name="refreshCookie"/);
  assert.match(html, /遇到 401/);
  assert.match(html, /name="pricingCookie"/);
  assert.match(html, /name="modelBaseUrl"/);
  assert.match(html, /GET \/v1\/models/);
  assert.match(html, /name="refreshMode"/);
  assert.match(html, /name="browserLoginAction"/);
  assert.match(html, /失效后自动点击的登录按钮/);
  assert.match(html, /BROWSER_LOGIN_ACCOUNT/);
  assert.match(html, /BROWSER_LOGIN_PASSWORD/);
  assert.match(html, /BROWSER_LOGIN_ACCOUNTS_JSON/);
  assert.match(html, /BROWSER_LOGIN_AGREE/);
  assert.match(html, /BROWSER_LOGIN_NEXT_ACTION/);
  assert.match(html, /Continue with GitHub/);
  assert.match(html, /BROWSER_CHECKIN_ACCOUNTS_JSON/);
  assert.match(html, /turnstile/);
  assert.match(html, /agree:true/);
  assert.match(html, /先点登录入口，再填写账号密码、勾选协议/);
  assert.match(html, /name="balanceMethod"/);
  assert.match(html, /name="balanceBody"/);
  assert.match(html, /服务器浏览器/);
  assert.match(html, /Session\/Cookie/);
  assert.match(source, /\/browser-open/);
});

test('server browser routes require the admin session', () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const browser = fs.readFileSync(new URL('../src/browser.js', import.meta.url), 'utf8');
  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const startup = fs.readFileSync(new URL('../start-container.sh', import.meta.url), 'utf8');
  assert.match(source, /app\.get\('\/browser', auth/);
  assert.match(source, /app\.use\('\/browser', auth/);
  assert.match(source, /validSession\(cookies\(req\)\.session, sessionSecret\)/);
  assert.match(dockerfile, /chromium/);
  assert.match(startup, /\/data\/browser-profile/);
  assert.match(startup, /SingletonLock/);
  assert.match(startup, /json\/version/);
  assert.match(startup, /browser_watchdog/);
  assert.match(startup, /restarting in 5 seconds/);
  assert.match(startup, /x11vnc .* -localhost/);
  assert.match(browser, /formReadyExpression/);
  assert.match(browser, /if \(closeWhenDone\) await closeTarget/);
  assert.match(browser, /Page\.navigate.*about:blank/);
  assert.match(browser, /BROWSER_LOGIN_WINDOW_MS/);
});

test('manual refresh shows progress while browser recovery runs', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /run\('\$\{a\.id\}','poll',this\)/);
  assert.match(source, /刷新中…/);
  assert.match(source, /签到中…/);
});

test('account save reports server validation errors and shows progress', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="accountSaveError"/);
  assert.match(source, /正在保存/);
  assert.match(source, /accountSaveError'\)\.textContent = error\.message/);
});

test('site cards include a real model invocation test', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, />测试模型</);
  assert.match(source, /\/model-test/);
  assert.match(source, /本次已真实调用/);
});

test('polling is controlled by account tags', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /#pollTags/);
  assert.match(source, /#addTagForm/);
  assert.match(source, /openTagPicker/);
  assert.match(source, /\/tags/);
  assert.match(source, /togglePollTag/);
  assert.doesNotMatch(source, /参与轮询<\/label>/);
});

test('tag filter and order controls are available', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="errorStat"/);
  assert.match(html, /onclick="toggleErrorFilter\(\)"/);
  assert.match(source, /activeStatusFilter/);
  assert.match(source, /filteredAccounts/);
  assert.match(source, /setTagFilter/);
  assert.match(source, /draggable="true"/);
  assert.match(source, /dropAccount/);
  assert.match(source, /\/api\/accounts\/order/);
  assert.doesNotMatch(source, /↑ 上移/);
  assert.doesNotMatch(source, /↓ 下移/);
});

test('created tags can be deleted with confirmation', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /deleteTag/);
  assert.match(source, /确定删除标签/);
  assert.match(source, /method: 'DELETE'/);
});

test('batch actions visibly run tagged sites one by one', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /async function runBatch/);
  assert.match(source, /for \(let index = 0; index < targets\.length/);
  assert.match(source, /正在.*\$\{index \+ 1\}\/\$\{targets\.length\}/);
  assert.match(source, /const targets = filteredAccounts\(accounts\)/);
  assert.match(source, /当前筛选下没有可执行的站点/);
});

test('run logs distinguish gateway traffic', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /run\.action === 'gateway' \? '网关'/);
  assert.match(source, /run\.upstreamError/);
  assert.match(source, /run\.upstreamEndpoint/);
});

test('left navigation opens a real gateway statistics module', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /class="sidebar"/);
  assert.match(html, />调用统计</);
  assert.match(html, /id="trendChart"/);
  assert.match(source, /\/api\/stats\?\$\{query\}/);
  assert.match(html, /id="statsAccount"/);
  assert.match(html, /id="statsModel"/);
  assert.match(source, /class="success-bar"/);
});

test('left navigation includes filterable run logs', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, />运行日志</);
  assert.match(html, /id="logAction"/);
  assert.match(html, /id="logStatus"/);
  assert.match(html, /id="logAccount"/);
  assert.match(source, /\/api\/logs\?/);
});

test('left navigation includes unread per-call price alerts', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, />降价提醒/);
  assert.match(html, /id="priceAlertBadge"/);
  assert.doesNotMatch(html, /id="priceLeaders"/);
  assert.match(html, /id="priceAlertHistory"/);
  assert.match(html, /id="priceSiteFilter"/);
  assert.match(html, /id="priceBillingFilter"/);
  assert.match(html, />按次</);
  assert.match(html, />按量</);
  assert.match(html, /id="priceScopeFilter"/);
  assert.match(html, /全站模型最低价查询/);
  assert.match(html, /id="priceModelSearch"/);
  assert.match(html, /id="priceModelSearchResults"/);
  assert.doesNotMatch(html, /id="priceModelFilter"/);
  assert.match(html, />一个连接符</);
  assert.match(html, />两个连接符</);
  assert.match(html, /清除未加精/);
  assert.match(source, /\/api\/price-alerts\/scan/);
  assert.match(source, /togglePriceAlertPin/);
  assert.match(source, /dismissPriceAlert/);
  assert.match(source, /setPriceAlertBadge/);
  assert.match(source, /renderPriceModelSearch/);
  assert.match(source, /priceAlertData\.modelPrices/);
});

test('left navigation includes invitation usage alerts', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, />邀请提醒/);
  assert.match(html, /id="inviteAlertBadge"/);
  assert.match(html, /id="inviteAlertHistory"/);
  assert.match(html, /id="inviteSiteFilter"/);
  assert.doesNotMatch(html, /id="inviteSiteCounts"/);
  assert.doesNotMatch(html, />本次新增来自</);
  assert.match(html, />新增邀请记录</);
  assert.match(html, />本次新增</);
  assert.doesNotMatch(html, />累计邀请</);
  assert.match(source, /\/api\/invite-alerts\/scan/);
  assert.match(source, /scanInvites/);
  assert.match(source, /dismissInviteAlert/);
  assert.match(source, /invite-alert-link/);
  assert.match(source, /打开站点查收/);
  assert.match(source, /target="_blank"/);
});

test('public invite preview exposes only chosen names and links', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const invites = fs.readFileSync(new URL('../public/invites.js', import.meta.url), 'utf8');
  assert.match(html, /name="inviteUrl"/);
  assert.match(html, /href="\/invites\.html"/);
  assert.match(invites, /item\.name/);
  assert.match(invites, /item\.tags/);
  assert.match(invites, /item\.url/);
  assert.doesNotMatch(invites, /balance|apiKey|credential|modelName/);
});
