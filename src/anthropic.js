'use strict';

const crypto = require('crypto');

function randomUUID() {
  return crypto.randomUUID();
}

// ─── Request conversion: Anthropic → OpenAI ──────────────────────────────────

function convertAnthropicToOpenAI(body, defaultModel) {
  const obj = typeof body === 'string' ? JSON.parse(body) : body;

  let model = (obj.model || '').trim();
  if (!model) model = (defaultModel || '').trim();
  if (!model) throw new Error('model is required');

  const out = { model, messages: [] };

  if (obj.max_tokens != null) out.max_tokens = obj.max_tokens;
  if (obj.temperature != null) out.temperature = obj.temperature;
  else if (obj.top_p != null) out.top_p = obj.top_p;
  if (obj.top_k != null) out.top_k = obj.top_k;
  if (obj.stop_sequences != null && Array.isArray(obj.stop_sequences)) {
    if (obj.stop_sequences.length === 1) out.stop = obj.stop_sequences[0];
    else if (obj.stop_sequences.length > 1) out.stop = obj.stop_sequences;
  }
  if (obj.user && obj.user.trim()) out.user = obj.user;
  if (obj.conversation_id && obj.conversation_id.trim()) out.conversation_id = obj.conversation_id;
  if (obj.session_id && obj.session_id.trim()) out.session_id = obj.session_id;

  // system
  if (obj.system != null) {
    const systemContent = convertAnthropicSystemToOpenAIContent(obj.system);
    if (systemContent && systemContent.length > 0) {
      out.messages.push({ role: 'system', content: systemContent });
    }
  }

  // messages
  if (Array.isArray(obj.messages)) {
    for (const msg of obj.messages) {
      const converted = convertAnthropicMessageToOpenAI(msg);
      for (const item of converted) out.messages.push(item);
    }
  }

  if (out.messages.length === 0) throw new Error('messages is required');

  // tools
  if (Array.isArray(obj.tools) && obj.tools.length > 0) {
    const tools = [];
    for (const tool of obj.tools) {
      const name = (tool.name || '').trim();
      if (!name) continue;
      const entry = {
        type: 'function',
        function: {
          name,
          description: tool.description || '',
          parameters: tool.input_schema || {},
        },
      };
      tools.push(entry);
    }
    if (tools.length > 0) out.tools = tools;
  }

  // tool_choice
  if (obj.tool_choice != null) {
    const tc = obj.tool_choice;
    switch ((tc.type || '').trim()) {
      case 'auto': out.tool_choice = 'auto'; break;
      case 'any': out.tool_choice = 'required'; break;
      case 'none': out.tool_choice = 'none'; break;
      case 'tool': {
        const toolName = (tc.name || '').trim();
        if (toolName) out.tool_choice = { type: 'function', function: { name: toolName } };
        break;
      }
    }
  }

  return { body: out, model };
}

function convertAnthropicSystemToOpenAIContent(system) {
  if (typeof system === 'string') {
    const text = system.trim();
    if (!text) return null;
    return [{ type: 'text', text }];
  }
  if (Array.isArray(system)) {
    const out = [];
    for (const part of system) {
      const converted = convertAnthropicContentPart(part);
      if (converted) out.push(converted);
    }
    return out.length > 0 ? out : null;
  }
  return null;
}

function convertAnthropicMessageToOpenAI(message) {
  const role = (message.role || '').trim();
  if (!role) return [];

  const content = message.content;
  if (content == null) return [{ role, content: '' }];
  if (typeof content === 'string') return [{ role, content }];
  if (!Array.isArray(content)) return [{ role, content: JSON.stringify(content) }];

  const contentItems = [];
  const toolCalls = [];
  const toolResults = [];

  for (const part of content) {
    const partType = ((part.type || '')).toLowerCase().trim();
    switch (partType) {
      case 'text':
      case 'image': {
        const converted = convertAnthropicContentPart(part);
        if (converted) contentItems.push(converted);
        break;
      }
      case 'tool_use': {
        if (role !== 'assistant') break;
        let toolID = (part.id || '').trim();
        if (!toolID) toolID = 'call_' + randomUUID();
        const toolName = (part.name || '').trim();
        if (!toolName) break;
        let args = '{}';
        if (part.input != null) {
          if (typeof part.input === 'object') {
            args = JSON.stringify(part.input);
          } else if (typeof part.input === 'string' && part.input.trim()) {
            try { JSON.parse(part.input); args = part.input; }
            catch (_) { args = JSON.stringify({ raw: part.input }); }
          }
        }
        toolCalls.push({ id: toolID, type: 'function', function: { name: toolName, arguments: args } });
        break;
      }
      case 'tool_result': {
        const toolCallID = (part.tool_use_id || '').trim();
        if (!toolCallID) break;
        const resultText = convertAnthropicToolResultContentToString(part.content);
        toolResults.push({ role: 'tool', tool_call_id: toolCallID, content: resultText });
        break;
      }
      case 'thinking':
      case 'redacted_thinking':
        break;
      default: {
        const converted = convertAnthropicContentPart(part);
        if (converted) contentItems.push(converted);
      }
    }
  }

  const result = [...toolResults];
  if (contentItems.length === 0 && toolCalls.length === 0) return result;

  const msg = { role };
  msg.content = contentItems.length > 0 ? contentItems : '';
  if (role === 'assistant' && toolCalls.length > 0) msg.tool_calls = toolCalls;
  result.push(msg);
  return result;
}

function convertAnthropicContentPart(part) {
  const type = ((part.type || '')).toLowerCase().trim();
  if (type === 'text') {
    const text = (part.text || '').trim();
    if (!text) return null;
    return { type: 'text', text };
  }
  if (type === 'image') {
    const url = extractAnthropicImageURL(part);
    if (!url) return null;
    return { type: 'image_url', image_url: { url } };
  }
  return null;
}

function extractAnthropicImageURL(part) {
  if (part.source) {
    const srcType = ((part.source.type || '')).toLowerCase().trim();
    if (srcType === 'base64') {
      const mediaType = (part.source.media_type || 'application/octet-stream').trim();
      const data = (part.source.data || '').trim();
      if (data) return `data:${mediaType};base64,${data}`;
    }
    if (srcType === 'url') {
      const url = (part.source.url || '').trim();
      if (url) return url;
    }
  }
  return (part.url || '').trim();
}

function convertAnthropicToolResultContentToString(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text);
      else parts.push(JSON.stringify(item));
    }
    const joined = parts.join('\n\n').trim();
    return joined || JSON.stringify(content);
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    return JSON.stringify(content);
  }
  return JSON.stringify(content);
}

// ─── Response conversion: OpenAI → Anthropic ─────────────────────────────────

function convertOpenAIToAnthropic(data) {
  const obj = typeof data === 'string' ? JSON.parse(data) : data;
  if (!obj.choices) throw new Error('upstream response missing choices');

  let id = (obj.id || '').trim();
  if (!id) id = 'msg_' + randomUUID().replace(/-/g, '');
  const model = (obj.model || 'unknown').trim();

  const contentBlocks = [];
  let hasToolUse = false;

  const choice = obj.choices[0] || {};
  const msg = choice.message || {};

  // content
  if (msg.content != null) {
    if (typeof msg.content === 'string') {
      const text = msg.content;
      if (text.trim()) contentBlocks.push({ type: 'text', text });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        const partType = ((part.type || '')).toLowerCase().trim();
        if (partType === 'text' && (part.text || '').trim()) {
          contentBlocks.push({ type: 'text', text: part.text });
        } else if (partType === 'reasoning' && (part.text || '').trim()) {
          contentBlocks.push({ type: 'thinking', thinking: part.text.trim() });
        } else if (partType === 'tool_calls' && Array.isArray(part.tool_calls)) {
          for (const tc of part.tool_calls) {
            contentBlocks.push(buildAnthropicToolUseBlock(tc));
            hasToolUse = true;
          }
        }
      }
    }
  }

  // reasoning_content
  if (msg.reasoning_content && msg.reasoning_content.trim()) {
    contentBlocks.push({ type: 'thinking', thinking: msg.reasoning_content.trim() });
  }

  // tool_calls
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      contentBlocks.push(buildAnthropicToolUseBlock(tc));
      hasToolUse = true;
    }
  }

  const { inputTokens, outputTokens, cachedTokens } = extractOpenAIUsage(obj.usage);
  let stopReason = mapOpenAIFinishReason(choice.finish_reason || '');
  if (hasToolUse) stopReason = 'tool_use';

  const usage = { input_tokens: inputTokens, output_tokens: outputTokens };
  if (cachedTokens > 0) usage.cache_read_input_tokens = cachedTokens;

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

function buildAnthropicToolUseBlock(toolCall) {
  let toolID = (toolCall.id || '').trim();
  if (!toolID) toolID = 'toolu_' + randomUUID().replace(/-/g, '');
  const name = (toolCall.function && toolCall.function.name || 'unknown_tool').trim();
  let input = {};
  const args = (toolCall.function && toolCall.function.arguments || '').trim();
  if (args) {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
      else input = { value: parsed };
    } catch (_) {
      input = { raw: args };
    }
  }
  return { type: 'tool_use', id: toolID, name, input };
}

function mapOpenAIFinishReason(reason) {
  switch ((reason || '').trim()) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    default: return 'end_turn';
  }
}

function extractOpenAIUsage(usage) {
  if (!usage) return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  const cachedTokens = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  if (cachedTokens > 0) inputTokens = Math.max(0, inputTokens - cachedTokens);
  return { inputTokens, outputTokens, cachedTokens };
}

// ─── Anthropic SSE stream writer ──────────────────────────────────────────────

function writeAnthropicSSE(res, anthropicBody) {
  const obj = typeof anthropicBody === 'string' ? JSON.parse(anthropicBody) : anthropicBody;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.writeHead(200);

  const id = obj.id || '';
  const model = obj.model || '';
  const stopReason = obj.stop_reason || null;
  const usage = obj.usage || {};

  const usagePayload = {
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
  };
  if (usage.cache_read_input_tokens) usagePayload.cache_read_input_tokens = usage.cache_read_input_tokens;

  writeAnthropicEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const blocks = Array.isArray(obj.content) ? obj.content : [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const blockType = ((block.type || '')).toLowerCase().trim();

    if (blockType === 'text') {
      writeAnthropicEvent(res, 'content_block_start', {
        type: 'content_block_start', index,
        content_block: { type: 'text', text: '' },
      });
      writeAnthropicEvent(res, 'content_block_delta', {
        type: 'content_block_delta', index,
        delta: { type: 'text_delta', text: block.text || '' },
      });
    } else if (blockType === 'thinking') {
      writeAnthropicEvent(res, 'content_block_start', {
        type: 'content_block_start', index,
        content_block: { type: 'thinking', thinking: '' },
      });
      writeAnthropicEvent(res, 'content_block_delta', {
        type: 'content_block_delta', index,
        delta: { type: 'thinking_delta', thinking: block.thinking || '' },
      });
    } else if (blockType === 'tool_use') {
      writeAnthropicEvent(res, 'content_block_start', {
        type: 'content_block_start', index,
        content_block: { type: 'tool_use', id: block.id || '', name: block.name || '', input: {} },
      });
      let inputRaw = block.input != null ? JSON.stringify(block.input) : '{}';
      if (!inputRaw || inputRaw === 'null') inputRaw = '{}';
      writeAnthropicEvent(res, 'content_block_delta', {
        type: 'content_block_delta', index,
        delta: { type: 'input_json_delta', partial_json: inputRaw },
      });
    } else {
      continue;
    }

    writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
  }

  writeAnthropicEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: usagePayload,
  });
  writeAnthropicEvent(res, 'message_stop', { type: 'message_stop' });
}

function writeAnthropicEvent(res, eventName, payload) {
  const body = JSON.stringify(payload);
  res.write(`event: ${eventName}\ndata: ${body}\n\n`);
}

function writeAnthropicSSEError(res, code, message) {
  if (code < 400 || code > 599) code = 502;
  if (!message) message = `status ${code}`;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.writeHead(200);
  writeAnthropicEvent(res, 'error', {
    type: 'error',
    error: { type: 'api_error', message },
  });
}

// ─── Token estimation ─────────────────────────────────────────────────────────

function estimateInputTokens(body) {
  const obj = typeof body === 'string' ? JSON.parse(body) : body;
  let textBytes = 0;
  let imageCount = 0;

  function collectText(text) { textBytes += Buffer.byteLength(text || '', 'utf8'); }

  if (obj.system != null) {
    if (typeof obj.system === 'string') collectText(obj.system);
    else if (Array.isArray(obj.system)) {
      for (const p of obj.system) if (p.type === 'text') collectText(p.text);
    }
  }

  if (Array.isArray(obj.messages)) {
    for (const msg of obj.messages) {
      const content = msg.content;
      if (typeof content === 'string') { collectText(content); continue; }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const t = ((part.type || '')).toLowerCase().trim();
        if (t === 'text' || t === 'thinking') { collectText(part.text); collectText(part.thinking); }
        else if (t === 'tool_result') collectText(convertAnthropicToolResultContentToString(part.content));
        else if (t === 'image') imageCount++;
      }
    }
  }

  const estimate = Math.floor(textBytes / 4) + imageCount * 85;
  return Math.max(1, estimate);
}

module.exports = {
  convertAnthropicToOpenAI,
  convertOpenAIToAnthropic,
  writeAnthropicSSE,
  writeAnthropicSSEError,
  estimateInputTokens,
};
