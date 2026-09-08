import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletionResponse, chatCompletionToResponse, responseToSse, responsesToChatBody, simplifiedChatBody } from '../src/responses-compat.js';

test('converts Responses text, tools and tool results to Chat Completions', () => {
  const body = responsesToChatBody({
    model: 'alias', instructions: 'Be concise', max_output_tokens: 50, stream: true,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'function_call_output', call_id: 'call_1', output: 'done' }
    ],
    tools: [{ type: 'function', name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
    tool_choice: { type: 'function', name: 'lookup' }
  }, 'real-model');
  assert.equal(body.model, 'real-model');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 50);
  assert.deepEqual(body.messages.map(item => item.role), ['system', 'user', 'tool']);
  assert.equal(body.tools[0].function.name, 'lookup');
  assert.equal(body.tool_choice.function.name, 'lookup');
});

test('converts a Chat text result to Responses JSON and SSE', async () => {
  const chat = { id: 'chat_1', created: 10, model: 'real', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } };
  const converted = chatCompletionToResponse(chat, 'alias');
  assert.equal(converted.object, 'response');
  assert.equal(converted.model, 'alias');
  assert.equal(converted.output[0].content[0].text, 'hello');
  assert.equal(converted.usage.input_tokens, 4);
  const stream = responseToSse(converted);
  assert.match(stream, /event: response\.output_text\.delta/);
  assert.match(stream, /event: response\.completed/);
  const response = chatCompletionResponse(chat, { model: 'alias', stream: true });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.match(await response.text(), /"delta":"hello"/);
});

test('converts Chat function calls to Responses function call items', () => {
  const converted = chatCompletionToResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] } }] }, 'alias');
  assert.equal(converted.output[0].type, 'function_call');
  assert.equal(converted.output[0].call_id, 'call_1');
  assert.equal(converted.output[0].name, 'lookup');
  assert.match(responseToSse(converted), /response\.function_call_arguments\.delta/);
});

test('simplifies a rejected streaming Chat request without dropping messages or tools', () => {
  const body = simplifiedChatBody({
    model: 'alias', messages: [{ role: 'user', content: 'hello' }], stream: true,
    stream_options: { include_usage: true }, max_completion_tokens: 12, reasoning_effort: 'high', metadata: { source: 'client' },
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
  }, 'real');
  assert.equal(body.model, 'real');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 12);
  assert.equal(body.messages[0].content, 'hello');
  assert.equal(body.tools[0].function.name, 'lookup');
  assert.equal(body.stream_options, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.metadata, undefined);
});
