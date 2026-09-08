import crypto from 'node:crypto';

function textPart(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (['input_text', 'output_text', 'text'].includes(part.type)) return String(part.text || '');
  return '';
}

function chatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  const parts = content.map(part => {
    const text = textPart(part);
    if (text) return { type: 'text', text };
    if (part?.type === 'input_image') {
      const url = part.image_url || part.url;
      return url ? { type: 'image_url', image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } } : null;
    }
    return null;
  }).filter(Boolean);
  if (parts.every(part => part.type === 'text')) return parts.map(part => part.text).join('');
  return parts;
}

function responseInputMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id || item.id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') });
      continue;
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: item.arguments || item.input || '' } }] });
      continue;
    }
    if (item.type === 'message' || item.role) {
      const role = item.role === 'developer' ? 'system' : item.role || 'user';
      messages.push({ role, content: chatContent(item.content) });
    }
  }
  return messages;
}

function chatTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(tool => {
    if (tool?.type === 'function' && tool.function) return tool;
    if (tool?.type === 'function' && tool.name) return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} }, ...(tool.strict === undefined ? {} : { strict: tool.strict }) } };
    if (tool?.type === 'custom' && tool.name) return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } } };
    return null;
  }).filter(Boolean);
}

function chatToolChoice(choice) {
  if (!choice || typeof choice === 'string') return choice;
  if (choice.type === 'function' && choice.name) return { type: 'function', function: { name: choice.name } };
  if (choice.type === 'allowed_tools') return choice.mode === 'required' ? 'required' : 'auto';
  return 'auto';
}

function chatResponseFormat(text) {
  const format = text?.format;
  if (!format || format.type === 'text') return null;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') return { type: 'json_schema', json_schema: { name: format.name || 'response', schema: format.schema || {}, ...(format.strict === undefined ? {} : { strict: format.strict }) } };
  return null;
}

export function responsesToChatBody(body = {}, modelName = '') {
  const messages = responseInputMessages(body.input);
  if (body.instructions) messages.unshift({ role: 'system', content: chatContent(body.instructions) });
  if (!messages.length) messages.push({ role: 'user', content: '' });
  const tools = chatTools(body.tools);
  const responseFormat = chatResponseFormat(body.text);
  return {
    model: modelName || body.model,
    messages,
    stream: false,
    ...(Number.isFinite(Number(body.max_output_tokens)) ? { max_tokens: Number(body.max_output_tokens) } : {}),
    ...(Number.isFinite(Number(body.temperature)) ? { temperature: Number(body.temperature) } : {}),
    ...(Number.isFinite(Number(body.top_p)) ? { top_p: Number(body.top_p) } : {}),
    ...(tools.length ? { tools, tool_choice: chatToolChoice(body.tool_choice || 'auto') } : {}),
    ...(body.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: Boolean(body.parallel_tool_calls) }),
    ...(body.reasoning?.effort ? { reasoning_effort: body.reasoning.effort } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {})
  };
}

export function simplifiedChatBody(body = {}, modelName = '') {
  const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens);
  return {
    model: modelName || body.model,
    messages: Array.isArray(body.messages) ? body.messages : [],
    stream: body.stream === true,
    ...(Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
    ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools, tool_choice: body.tool_choice || 'auto' } : {}),
    ...(body.stop === undefined ? {} : { stop: body.stop })
  };
}

function responseUsage(usage = {}) {
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens);
  const cachedTokens = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens);
  if (![inputTokens, outputTokens, totalTokens].some(Number.isFinite)) return null;
  const input = Number.isFinite(inputTokens) ? inputTokens : 0;
  const output = Number.isFinite(outputTokens) ? outputTokens : 0;
  return { input_tokens: input, input_tokens_details: { cached_tokens: Number.isFinite(cachedTokens) ? cachedTokens : 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: Number.isFinite(totalTokens) ? totalTokens : input + output };
}

export function chatCompletionToResponse(data = {}, requestedModel = '') {
  const choice = data.choices?.[0] || {};
  const message = choice.message || {};
  const responseId = `resp_${String(data.id || crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g, '')}`;
  const output = [];
  const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map(textPart).join('') : '';
  if (content || message.refusal) output.push({ id: `msg_${crypto.randomUUID().replace(/-/g, '')}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: message.refusal ? 'refusal' : 'output_text', ...(message.refusal ? { refusal: message.refusal } : { text: content, annotations: [] }) }] });
  for (const call of message.tool_calls || []) {
    if (call?.type !== 'function' || !call.function) continue;
    output.push({ id: `fc_${crypto.randomUUID().replace(/-/g, '')}`, type: 'function_call', status: 'completed', call_id: call.id || `call_${crypto.randomUUID().replace(/-/g, '')}`, name: call.function.name, arguments: call.function.arguments || '' });
  }
  return {
    id: responseId,
    object: 'response',
    created_at: Number(data.created) || Math.floor(Date.now() / 1000),
    status: choice.finish_reason === 'length' ? 'incomplete' : 'completed',
    error: null,
    incomplete_details: choice.finish_reason === 'length' ? { reason: 'max_output_tokens' } : null,
    model: requestedModel || data.model || '',
    output,
    output_text: content,
    parallel_tool_calls: true,
    usage: responseUsage(data.usage)
  };
}

function sse(type, data, sequenceNumber) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...data })}\n\n`;
}

export function responseToSse(response) {
  let sequence = 0;
  const pending = { ...response, status: 'in_progress', output: [], usage: null };
  let stream = sse('response.created', { response: pending }, sequence++);
  stream += sse('response.in_progress', { response: pending }, sequence++);
  for (let outputIndex = 0; outputIndex < response.output.length; outputIndex += 1) {
    const item = response.output[outputIndex];
    const inProgress = { ...item, status: 'in_progress' };
    if (item.type === 'message') {
      inProgress.content = [];
      stream += sse('response.output_item.added', { output_index: outputIndex, item: inProgress }, sequence++);
      const part = item.content[0];
      stream += sse('response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { ...part, ...(part.type === 'output_text' ? { text: '' } : {}) } }, sequence++);
      if (part.type === 'output_text') {
        stream += sse('response.output_text.delta', { item_id: item.id, output_index: outputIndex, content_index: 0, delta: part.text }, sequence++);
        stream += sse('response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text: part.text }, sequence++);
      }
      stream += sse('response.content_part.done', { item_id: item.id, output_index: outputIndex, content_index: 0, part }, sequence++);
    } else if (item.type === 'function_call') {
      stream += sse('response.output_item.added', { output_index: outputIndex, item: { ...inProgress, arguments: '' } }, sequence++);
      stream += sse('response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: item.arguments }, sequence++);
      stream += sse('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: item.arguments }, sequence++);
    }
    stream += sse('response.output_item.done', { output_index: outputIndex, item }, sequence++);
  }
  stream += sse('response.completed', { response }, sequence++);
  return stream;
}

export function chatCompletionResponse(data, originalBody = {}) {
  const response = chatCompletionToResponse(data, originalBody.model);
  if (originalBody.stream === true) return new Response(responseToSse(response), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } });
  return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
