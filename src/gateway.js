import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { decrypt, readStore, writeStore } from './store.js';
import { modelApiUrl, shouldPoll } from './runner.js';
import { chatCompletionResponse, responsesToChatBody, simplifiedChatBody } from './responses-compat.js';

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

function nonEmptyText(value) {
  if (typeof value === 'string') return Boolean(value.trim());
  if (!Array.isArray(value)) return false;
  return value.some(item => nonEmptyText(item?.text ?? item?.content ?? item));
}

function payloadHasModelOutput(value, endpoint) {
  if (!value || typeof value !== 'object') return false;
  if (endpoint === '/v1/embeddings') return Array.isArray(value.data) && value.data.some(item => Array.isArray(item?.embedding) && item.embedding.length);
  if (Array.isArray(value.choices) && value.choices.some(choice =>
    nonEmptyText(choice?.text) ||
    nonEmptyText(choice?.message?.content) ||
    nonEmptyText(choice?.message?.reasoning_content) ||
    nonEmptyText(choice?.message?.refusal) ||
    nonEmptyText(choice?.delta?.content) ||
    nonEmptyText(choice?.delta?.reasoning_content) ||
    (Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0) ||
    (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0)
  )) return true;
  if (nonEmptyText(value.output_text)) return true;
  if (Array.isArray(value.output) && value.output.some(item =>
    nonEmptyText(item?.content) || nonEmptyText(item?.text) ||
    ['function_call', 'computer_call', 'web_search_call'].includes(item?.type)
  )) return true;
  if (/\.delta$|\.done$/.test(String(value.type || '')) && nonEmptyText(value.delta ?? value.text ?? value.content)) return true;
  if (value.type === 'response.output_item.added' && ['function_call', 'computer_call', 'web_search_call'].includes(value.item?.type)) return true;
  return value.response && value.response !== value ? payloadHasModelOutput(value.response, endpoint) : false;
}

export function hasMeaningfulModelResponse(text = '', endpoint = '/v1/chat/completions') {
  const source = String(text || '').trim();
  if (!source) return false;
  try { if (payloadHasModelOutput(JSON.parse(source), endpoint)) return true; } catch {}
  let sawSse = false;
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    sawSse = true;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try { if (payloadHasModelOutput(JSON.parse(raw), endpoint)) return true; } catch {}
  }
  if (sawSse || /<\s*!doctype|<html|<body/i.test(source)) return false;
  return !/^[{[]/.test(source) && Boolean(source.trim());
}

export function appendBoundedTail(current = Buffer.alloc(0), chunk = Buffer.alloc(0), maximum = 262144) {
  const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  return next.length > maximum ? next.subarray(next.length - maximum) : next;
}

function redactUpstreamText(value = '') {
  return String(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|sess|token)-[A-Za-z0-9._-]{12,}\b/gi, '[已隐藏]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarizeUpstreamError(status, text = '', maximum = 360) {
  let detail = '';
  try {
    const data = JSON.parse(String(text));
    const candidates = [data?.error?.message, data?.message, data?.msg, data?.detail, typeof data?.error === 'string' ? data.error : ''];
    detail = candidates.find(value => typeof value === 'string' && value.trim()) || '';
  } catch {
    const title = String(text).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    detail = title || (!/<[a-z][\s\S]*>/i.test(String(text)) ? text : '');
  }
  detail = redactUpstreamText(detail);
  if (detail.length > maximum) detail = `${detail.slice(0, maximum - 1)}…`;
  return `HTTP ${status}${detail ? ` · ${detail}` : ''}`;
}

async function readResponsePrefix(response, maximum = 16384) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maximum) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const remaining = maximum - size;
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      size += Math.min(chunk.length, remaining);
      if (chunk.length > remaining || size >= maximum) break;
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  return Buffer.concat(chunks).toString('utf8');
}

function responseWithPrefetchedBody(response, reader, chunks, readerDone = false) {
  let index = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (index < chunks.length) return controller.enqueue(chunks[index++]);
      if (readerDone) return controller.close();
      const { done, value } = await reader.read();
      if (done) { readerDone = true; controller.close(); } else controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function validateSuccessfulResponse(response, endpoint, maximum = 262144) {
  if (!response.body) return { valid: false, response: null, preview: '' };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < maximum) {
    const { done, value } = await reader.read();
    if (done) {
      const preview = Buffer.concat(chunks).toString('utf8');
      if (!hasMeaningfulModelResponse(preview, endpoint)) return { valid: false, response: null, preview };
      return { valid: true, response: responseWithPrefetchedBody(response, reader, chunks, true), preview };
    }
    const chunk = Buffer.from(value);
    const remaining = maximum - size;
    chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
    size += Math.min(chunk.length, remaining);
    const preview = Buffer.concat(chunks).toString('utf8');
    if (hasMeaningfulModelResponse(preview, endpoint)) return { valid: true, response: responseWithPrefetchedBody(response, reader, chunks), preview };
    if (chunk.length > remaining || size >= maximum) break;
  }
  try { await reader.cancel(); } catch {}
  return { valid: false, response: null, preview: Buffer.concat(chunks).toString('utf8') };
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

function shouldUseResponsesCompatibility(status) {
  return [400, 404, 405, 415, 422, 501].includes(Number(status));
}

async function responsesViaChat(account, originalBody) {
  const chatBody = responsesToChatBody(originalBody, account.modelName);
  let response = await upstreamRequest(account, '/v1/chat/completions', chatBody);
  if (!response.ok && [400, 422].includes(response.status)) {
    try { await readResponsePrefix(response); } catch {}
    response = await upstreamRequest(account, '/v1/chat/completions', simplifiedChatBody(chatBody, account.modelName));
  }
  if (!response.ok) {
    let responseText = '';
    try { responseText = await readResponsePrefix(response); } catch {}
    return { response: null, error: summarizeUpstreamError(response.status, responseText), status: response.status };
  }
  let responseText = '';
  try { responseText = await readResponsePrefix(response, 4 * 1024 * 1024); }
  catch (error) { return { response: null, error: `Chat 兼容响应读取失败：${redactUpstreamText(error.message).slice(0, 300)}`, status: response.status }; }
  if (!hasMeaningfulModelResponse(responseText, '/v1/chat/completions')) return { response: null, error: `HTTP ${response.status} · Chat 兼容接口也没有返回模型内容`, status: response.status };
  let data;
  try { data = JSON.parse(responseText); }
  catch { return { response: null, error: `HTTP ${response.status} · Chat 兼容接口没有返回有效 JSON`, status: response.status }; }
  return { response: chatCompletionResponse(data, originalBody), error: '', status: response.status };
}

async function simplifiedChatAttempt(account, originalBody) {
  const response = await upstreamRequest(account, '/v1/chat/completions', simplifiedChatBody(originalBody, account.modelName));
  if (!response.ok) {
    let responseText = '';
    try { responseText = await readResponsePrefix(response); } catch {}
    return { response: null, error: summarizeUpstreamError(response.status, responseText), status: response.status };
  }
  const checked = await validateSuccessfulResponse(response, '/v1/chat/completions');
  if (!checked.valid) return { response: null, error: `HTTP ${response.status} · 精简参数后仍然没有返回模型内容`, status: response.status };
  return { response: checked.response, error: '', status: response.status };
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
            let responseText = '';
            try { responseText = await readResponsePrefix(response); } catch {}
            const upstreamError = summarizeUpstreamError(response.status, responseText);
            if (endpoint === '/v1/chat/completions' && [400, 422].includes(response.status)) {
              const compatible = await simplifiedChatAttempt(account, req.body);
              if (compatible.response) return forward(compatible.response, res, text => recordGatewayRun(account, 'ok', `精简不兼容参数后成功 · HTTP ${compatible.status}`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, statusCode: compatible.status, endpoint, upstreamEndpoint: endpoint, adapterLabel: 'Chat 参数精简', adapted: true, ...extractUsage(text) }));
              const combinedError = `${upstreamError}；精简参数重试失败：${compatible.error}`;
              errors.push(`${account.name}: ${combinedError}`);
              recordGatewayRun(account, 'error', `${combinedError}，已尝试下一站`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, statusCode: compatible.status || response.status, endpoint, upstreamEndpoint: endpoint, adapterLabel: 'Chat 参数精简', adapted: true, upstreamError: combinedError });
              continue;
            }
            if (endpoint === '/v1/responses' && shouldUseResponsesCompatibility(response.status)) {
              const compatible = await responsesViaChat(account, req.body);
              if (compatible.response) return forward(compatible.response, res, text => recordGatewayRun(account, 'ok', `Responses 已转为 Chat · HTTP ${compatible.status}`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, statusCode: compatible.status, endpoint, upstreamEndpoint: '/v1/chat/completions', adapterLabel: 'Responses → Chat', adapted: true, ...extractUsage(text) }));
              const combinedError = `${upstreamError}；Chat 兼容失败：${compatible.error}`;
              errors.push(`${account.name}: ${combinedError}`);
              recordGatewayRun(account, 'error', `${combinedError}，已尝试下一站`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, statusCode: compatible.status || response.status, endpoint, upstreamEndpoint: '/v1/chat/completions', adapterLabel: 'Responses → Chat', adapted: true, upstreamError: combinedError });
              continue;
            }
            errors.push(`${account.name}: ${upstreamError}`);
            recordGatewayRun(account, 'error', `${upstreamError}，已尝试下一站`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, statusCode: response.status, endpoint, upstreamError });
            continue;
          }
          const checked = await validateSuccessfulResponse(response, endpoint);
          if (!checked.valid) {
            const reported = summarizeUpstreamError(response.status, checked.preview);
            const upstreamError = `${reported}${reported === `HTTP ${response.status}` ? '' : ' ·'} 上游未返回模型内容`;
            if (endpoint === '/v1/responses') {
              const compatible = await responsesViaChat(account, req.body);
              if (compatible.response) return forward(compatible.response, res, text => recordGatewayRun(account, 'ok', `Responses 空回后已转为 Chat · HTTP ${compatible.status}`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, statusCode: compatible.status, endpoint, upstreamEndpoint: '/v1/chat/completions', adapterLabel: 'Responses → Chat', adapted: true, ...extractUsage(text) }));
              const combinedError = `${upstreamError}；Chat 兼容失败：${compatible.error}`;
              errors.push(`${account.name}: ${combinedError}`);
              recordGatewayRun(account, 'error', `${combinedError}，已尝试下一站`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, statusCode: compatible.status || response.status, endpoint, upstreamEndpoint: '/v1/chat/completions', adapterLabel: 'Responses → Chat', adapted: true, upstreamError: combinedError, ...extractUsage(checked.preview) });
              continue;
            }
            errors.push(`${account.name}: ${upstreamError}`);
            recordGatewayRun(account, 'error', `${upstreamError}，已尝试下一站`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, statusCode: response.status, endpoint, upstreamError, ...extractUsage(checked.preview) });
            continue;
          }
          return forward(checked.response, res, text => recordGatewayRun(account, 'ok', `HTTP ${response.status}`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, statusCode: response.status, endpoint, ...extractUsage(text) }));
        } catch (error) {
          const upstreamError = redactUpstreamText(error.message).slice(0, 360);
          errors.push(`${account.name}: ${upstreamError}`);
          recordGatewayRun(account, 'error', `${upstreamError}，已尝试下一站`, { requestId, attempt: index + 1, latencyMs: Date.now() - started, endpoint, upstreamError });
        }
      }
      res.status(502).json({ error: { message: `All upstreams failed: ${errors.join('; ')}`, type: 'upstream_error' } });
    });
  }
}
