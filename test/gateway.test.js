import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { appendBoundedTail, extractUsage, installGateway, rewriteGatewayBody, selectGatewayCandidates } from '../src/gateway.js';

test('gateway ignores the client model and uses polling sites in saved order', () => {
  const db = {
    pollTags: ['网关'],
    accounts: [
      { id: 'first', enabled: true, tags: ['网关'], apiKey: 'encrypted', modelName: 'gemini-real' },
      { id: 'skip', enabled: true, tags: ['其他'], apiKey: 'encrypted', modelName: 'gpt-real' },
      { id: 'second', enabled: true, tags: ['网关'], apiKey: 'encrypted', modelName: 'claude-real' }
    ]
  };

  assert.deepEqual(selectGatewayCandidates(db).map(account => account.id), ['first', 'second']);
  assert.equal(rewriteGatewayBody({ model: 'anything', messages: [] }, db.accounts[0]).model, 'gemini-real');
});

test('gateway extracts input output and cached tokens from JSON and streams', () => {
  assert.deepEqual(extractUsage(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 } } })), { inputTokens: 100, outputTokens: 20, cachedTokens: 80, totalTokens: 120 });
  const stream = 'data: {"choices":[],"usage":{"input_tokens":50,"output_tokens":10,"input_tokens_details":{"cached_tokens":30}}}\n\ndata: [DONE]\n';
  assert.deepEqual(extractUsage(stream), { inputTokens: 50, outputTokens: 10, cachedTokens: 30, totalTokens: 60 });
  assert.deepEqual(rewriteGatewayBody({ model: 'alias', stream: true }, { modelName: 'real' }, '/v1/chat/completions').stream_options, { include_usage: true });
});

test('gateway audit keeps only a bounded response tail', () => {
  let tail = appendBoundedTail(Buffer.alloc(0), Buffer.from('1234'), 6);
  tail = appendBoundedTail(tail, Buffer.from('56789'), 6);
  assert.equal(tail.toString(), '456789');
});

test('gateway rejects requests when its client key is missing', async () => {
  const previous = process.env.GATEWAY_API_KEY;
  delete process.env.GATEWAY_API_KEY;
  const app = express(); app.use(express.json()); installGateway(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(response.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.GATEWAY_API_KEY; else process.env.GATEWAY_API_KEY = previous;
  }
});
