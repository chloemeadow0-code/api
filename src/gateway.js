import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { decrypt, readStore, writeStore } from './store.js';
import { modelApiUrl, shouldPoll } from './runner.js';

function authorized(req) {
  const expected = process.env.GATEWAY_API_KEY || '';
  const actual = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || !actual) return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function selectGatewayCandidates(db) {
  return db.accounts.filter(account => shouldPoll(account, db.pollTags || []) && account.apiKey && account.modelName);
}

export function rewriteGatewayBody(body, account, endpoint = '') {
  const rewritten = { ...body, model: account.modelName };
  if (endpoint === '/v1/chat/completions' && body?.stream === true && !body.stream_options) rewritten.stream_options = { include_usage: true };
  return rewritten;
}

function normalizedUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const inputTokens = Number(value.input_tokens ?? value.prompt_tokens ?? value.promptTokenCount);
  const outputTokens = Number(value.output_tokens ?? value.completion_tokens ?? value.candidatesTokenCount);
  const cachedTokens = Number(value.input_tokens_details?.cached_tokens ?? value.prompt_tokens_details?.cached_tokens ?? value.cache_read_input_tokens ?? value.cachedContentTokenCount ?? 0);
  const totalTokens = Number(value.total_tokens ?? value.totalTokenCount);
  if (![inputTokens, outputTokens, cachedTokens, totalTokens].some(Number.isFinite)) return null;
  return { inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0, outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0, cachedTokens: Number.isFinite(cachedTokens) ? cachedTokens : 0, totalTokens: Number.isFinite(totalTokens) ? totalTokens : (Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0) };
}

function usageIn(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['usage', 'usageMetadata']) {
    const usage = normalizedUsage(value[key]); if (usage) return usage;
  }
  for (const child of Object.values(value)) { const usage = usageIn(child); if (usage) return usage; }
  return null;
}

export function extractUsage(text = '') {
  const candidates = [];
  try { candidates.push(JSON.parse(text)); } catch {}
  for (const line of String(text).split(/\r?\n/)) {
    const raw = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!raw || raw === '[DONE]') continue;
    try { candidates.push(JSON.parse(raw)); } catch {}
  }
  let found = null;
  for (const candidate of candidates) found = usageIn(candidate) || found;
  return found;
}

export function appendBoundedTail(current = Buffer.alloc(0), chunk = Buffer.alloc(0), maximum = 262144) {
  const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  return next.length > maximum ? next.subarray(next.length - maximum) : next;
}

function candidates() {
  const db = readStore();
  return selectGatewayCandidates(db);
}

export function recordGatewayRun(account, status, message = '', details = {}) {
  const db = readStore();
  db.runs.unshift({
    id: crypto.randomUUID(), accountId: account.id, action: 'gateway', status,
    message: `${account.modelName}${message ? ` · ${message}` : ''}`,
    modelName: account.modelName, ...details,
    startedAt: new Date().toISOString()
  });
  db.runs = db.runs.slice(0, 5000);
  writeStore(db);
}

async function upstreamRequest(account, endpoint, body) {
  const url = await modelApiUrl(account, endpoint);
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${decrypt(account.apiKey)}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'user-agent': 'SitePointsHub-Gateway/1.0'
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(Number(process.env.GATEWAY_TIMEOUT_MS || 120000))
  });
}

function forward(response, res, onComplete = () => {}) {
  res.status(response.status);
  for (const name of ['content-type', 'cache-control', 'x-request-id']) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!response.body) { onComplete(''); return res.end(); }
  const body = Readable.fromWeb(response.body);
  let auditTail = Buffer.alloc(0);
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    onComplete(auditTail.toString('utf8'));
  };
  body.on('data', chunk => { auditTail = appendBoundedTail(auditTail, chunk); });
  body.on('end', complete);
  body.on('error', complete);
  body.pipe(res);
}

export function installGateway(app) {
  app.get('/v1/models', (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: { message: 'Invalid gateway API key', type: 'authentication_error' } });
    const alias = process.env.GATEWAY_MODEL_NAME || 'xiaoju-auto';
    const models = candidates().length ? [alias] : [];
    res.json({ object: 'list', data: models.map(id => ({ id, object: 'model', created: 0, owned_by: 'site-points-hub' })) });
  });

  for (const endpoint of ['/v1/chat/completions', '/v1/responses', '/v1/embeddings']) {
    app.post(endpoint, async (req, res) => {
      if (!authorized(req)) return res.status(401).json({ error: { message: 'Invalid gateway API key', type: 'authentication_error' } });
      const model = String(req.body?.model || '');
      if (!model) return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
      const routes = candidates();
      if (!routes.length) return res.status(404).json({ error: { message: 'No polling upstream has both an API key and a selected model', type: 'model_not_found' } });
      const errors = [];
      const requestId = crypto.randomUUID();
      for (let index = 0; index < routes.length; index += 1) {
        const account = routes[index]; const started = Date.now();
        try {
          const response = await upstreamRequest(account, endpoint, rewriteGatewayBody(req.body, account, endpoint));
          if (!response.ok) {
            errors.push(`${account.name}: HTTP ${response.status}`);
            recordGatewayRun(account, 'error', `HTTP ${response.status}，已尝试下一站`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, statusCode: response.status, endpoint });
            await response.arrayBuffer();
            continue;
          }
          return forward(response, res, text => recordGatewayRun(account, 'ok', `HTTP ${response.status}`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, statusCode: response.status, endpoint, ...extractUsage(text) }));
        } catch (error) {
          errors.push(`${account.name}: ${error.message}`);
          recordGatewayRun(account, 'error', `${error.message}，已尝试下一站`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, endpoint });
        }
      }
      res.status(502).json({ error: { message: `All upstreams failed: ${errors.join('; ')}`, type: 'upstream_error' } });
    });
  }
}
