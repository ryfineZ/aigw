'use strict';

const { executeIFlowRequest, parseIFlowBusinessStatusError, randomUUID } = require('./iflow.js');

// 多模态请求使用的 User-Agent
const MULTIMODAL_USER_AGENT = 'iFlow-Cli-MultimodalHelper';

const VISION_CONTEXT_PREFIX = '[vision_context]';
const MAX_PROMPT_CONTEXT_MESSAGE_SIZE = 800;
const MAX_PROMPT_CONTEXT_TOTAL_SIZE = 4000;
const MAX_CURRENT_TASK_SIZE = 1200;

// ─── Glob pattern matching ────────────────────────────────────────────────────

function matchModelPattern(pattern, model) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = '^' + escaped.replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr).test(model);
}

function matchAnyPattern(patterns, model) {
  const m = model.toLowerCase().trim();
  if (!m) return false;
  for (const pattern of patterns) {
    const p = pattern.toLowerCase().trim();
    if (!p) continue;
    if (matchModelPattern(p, m)) return true;
  }
  return false;
}

function shouldBridgeModel(cfg, model) {
  const m = model.toLowerCase().trim();
  if (!m) return false;
  if (matchAnyPattern(cfg.passThroughModels, m)) return false;
  return true;
}

// ─── Image collection ─────────────────────────────────────────────────────────

function collectImageParts(body, maxImages) {
  if (Buffer.isBuffer(body)) body = body.toString();
  const obj = typeof body === 'string' ? JSON.parse(body) : body;
  const messages = obj.messages;
  if (!Array.isArray(messages)) return [];

  const results = [];
  let index = 0;

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const content = messages[msgIdx].content;
    if (!Array.isArray(content)) continue;

    for (let contentIdx = 0; contentIdx < content.length; contentIdx++) {
      const part = content[contentIdx];
      const partType = ((part.type || '')).toLowerCase().trim();
      if (partType !== 'image_url' && partType !== 'input_image') continue;

      let imageURL = '';
      if (partType === 'image_url') {
        imageURL = (part.image_url && part.image_url.url || '').trim();
      } else {
        imageURL = (part.image_url || '').trim();
      }
      if (!imageURL) continue;

      index++;
      const eligible = maxImages <= 0 || index <= maxImages;
      results.push({
        messageIndex: msgIdx,
        contentIndex: contentIdx,
        imageRef: `img_${index}`,
        url: imageURL,
        eligible,
        skipReason: eligible ? '' : 'max_images_exceeded',
      });
    }
  }
  return results;
}

// ─── Context extraction ───────────────────────────────────────────────────────

function extractMessageText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    return (content.text || '').trim();
  }
  const parts = [];
  for (const item of content) {
    const t = ((item.type || '')).toLowerCase().trim();
    if (t === 'text') {
      const text = (item.text || '').trim();
      if (text) parts.push(text);
    } else if (t === 'image_url' || t === 'input_image') {
      parts.push('[image]');
    } else {
      const text = (item.text || '').trim();
      if (text) parts.push(text);
    }
  }
  return parts.join(' ');
}

function compactText(text) {
  if (!text) return '';
  return text.trim().split(/\s+/).join(' ');
}

function extractContextText(body, contextMessages) {
  const obj = typeof body === 'string' ? JSON.parse(body) : body;
  const messages = obj.messages;
  if (!Array.isArray(messages) || messages.length === 0) return '';

  let count = contextMessages > 0 ? Math.min(contextMessages, messages.length) : messages.length;
  const start = messages.length - count;
  const lines = [];

  for (let i = start; i < messages.length; i++) {
    const msg = messages[i];
    const role = (msg.role || 'unknown').trim();
    let text = compactText(extractMessageText(msg.content));
    if (!text) continue;
    if (text.length > MAX_PROMPT_CONTEXT_MESSAGE_SIZE) text = text.slice(0, MAX_PROMPT_CONTEXT_MESSAGE_SIZE) + '...';
    lines.push(`${role}: ${text}`);
  }

  if (lines.length === 0) return '';
  let out = lines.join('\n');
  if (out.length > MAX_PROMPT_CONTEXT_TOTAL_SIZE) out = out.slice(0, MAX_PROMPT_CONTEXT_TOTAL_SIZE) + '...';
  return out;
}

function extractCurrentUserTask(body) {
  const obj = typeof body === 'string' ? JSON.parse(body) : body;
  const messages = obj.messages;
  if (!Array.isArray(messages)) return '';

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if ((msg.role || '').toLowerCase().trim() !== 'user') continue;
    let task = extractMessageText(msg.content);
    task = task.replace(/\[image\]/g, ' ');
    task = compactText(task);
    if (!task) continue;
    if (task.length > MAX_CURRENT_TASK_SIZE) task = task.slice(0, MAX_CURRENT_TASK_SIZE) + '...';
    return task;
  }
  return '';
}

// ─── Extractor prompt builders ────────────────────────────────────────────────

function buildExtractorSystemPrompt(schemaVersion) {
  return (
    'You are a vision extractor for a non-vision downstream model. ' +
    'Return ONLY valid JSON, no markdown, no extra text. ' +
    `Schema version: ${schemaVersion}. ` +
    'Output object schema: ' +
    `{"schema_version":"${schemaVersion}","images":[{"image_ref":"img_1","conclusion":"...","description":"...","ocr_text":"...","entities":["..."],"evidence":["..."],"confidence":0.0}],"global_summary":"...","errors":["..."]}. ` +
    'Rules: keep image_ref exactly as provided; conclusion must only use visual evidence relevant to CURRENT_TASK; ' +
    'if evidence is insufficient, set conclusion to "insufficient_visual_evidence" and keep confidence low; keep facts concise and verifiable.'
  );
}

function buildExtractorUserPrompt(cfg, body, images, currentTask, hints) {
  const refs = images.map(img => img.imageRef);
  let contextText = extractContextText(body, cfg.contextMessages);
  if (!contextText) contextText = '(empty)';
  if (!currentTask) currentTask = '(not provided)';

  let retryHint = '';
  if (hints && hints.retry && hints.lowConfidenceRefs && hints.lowConfidenceRefs.length > 0) {
    retryHint = '\nRetry mode: previous extraction confidence was low for image refs: ' +
      hints.lowConfidenceRefs.join(', ') +
      '. Re-check these refs and improve evidence grounding.';
  }

  return (
    `CURRENT_TASK:\n${currentTask}\n\n` +
    'Analyze the following images with conversation context.\n' +
    `Image refs (same order as attached images): ${refs.join(', ')}\n` +
    `Conversation context:\n${contextText}\n` +
    `${retryHint}\n` +
    'Return JSON only.'
  );
}

function buildExtractorRequestBody(cfg, body, images, currentTask, hints) {
  const parts = [
    { type: 'text', text: buildExtractorUserPrompt(cfg, body, images, currentTask, hints) },
    ...images.map(img => ({ type: 'image_url', image_url: { url: img.url } })),
  ];

  const payload = {
    model: cfg.extractorModel,
    stream: false,
    messages: [
      { role: 'system', content: buildExtractorSystemPrompt(cfg.schemaVersion) },
      { role: 'user', content: parts },
    ],
  };
  if (cfg.maxTokens > 0) payload.max_tokens = cfg.maxTokens;
  payload.temperature = cfg.temperature || 0;
  return Buffer.from(JSON.stringify(payload));
}

// ─── JSON extraction ──────────────────────────────────────────────────────────

function extractFirstJSONObject(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const candidate = trimmed.slice(start, end + 1).trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {}
  return null;
}

function extractAssistantMessageText(data) {
  const obj = typeof data === 'string' ? JSON.parse(data) : data;
  const choice = obj.choices && obj.choices[0];
  if (!choice) throw new Error('multimodal extractor response missing choices[0]');
  const content = choice.message && choice.message.content;
  if (content == null) throw new Error('multimodal extractor response missing choices[0].message.content');
  if (typeof content === 'string') {
    const text = content.trim();
    if (!text) throw new Error('multimodal extractor response content is empty');
    return text;
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      const text = (item.text || '').trim();
      if (text) parts.push(text);
    }
    const out = parts.join('\n').trim();
    if (!out) throw new Error('multimodal extractor returned array content without text');
    return out;
  }
  const fallback = JSON.stringify(content).trim();
  if (!fallback) throw new Error('multimodal extractor content is empty');
  return fallback;
}

function parseExtractionEnvelope(raw, defaultSchemaVersion) {
  const obj = extractFirstJSONObject(raw);
  if (!obj) throw new Error('multimodal extractor response is not valid JSON object');

  const envelope = {
    schema_version: (obj.schema_version || defaultSchemaVersion || 'v1').trim(),
    images: [],
    global_summary: (obj.global_summary || '').trim(),
    errors: Array.isArray(obj.errors) ? obj.errors.map(e => (e || '').trim()).filter(Boolean) : [],
  };

  if (Array.isArray(obj.images)) {
    for (const item of obj.images) {
      envelope.images.push({
        image_ref: (item.image_ref || '').trim(),
        conclusion: (item.conclusion || '').trim(),
        description: (item.description || '').trim(),
        ocr_text: (item.ocr_text || '').trim(),
        entities: Array.isArray(item.entities) ? item.entities.map(e => (e || '').trim()).filter(Boolean) : [],
        evidence: Array.isArray(item.evidence) ? item.evidence.map(e => (e || '').trim()).filter(Boolean) : [],
        confidence: typeof item.confidence === 'number' ? item.confidence : 0,
      });
    }
  }
  return envelope;
}

// ─── Confidence summary ───────────────────────────────────────────────────────

function summarizeConfidence(envelope, images, threshold) {
  const summary = { lowRefs: [], lowCount: 0, avgConfidence: 0 };
  if (!envelope || threshold <= 0) return summary;

  const byRef = {};
  for (const item of envelope.images) {
    if (item.image_ref) byRef[item.image_ref] = item;
  }

  let total = 0;
  let sum = 0;
  for (const image of images) {
    if (!image.eligible) continue;
    total++;
    const confidence = byRef[image.imageRef] ? byRef[image.imageRef].confidence : 0;
    sum += confidence;
    if (confidence < threshold) summary.lowRefs.push(image.imageRef);
  }
  summary.lowCount = summary.lowRefs.length;
  if (total > 0) summary.avgConfidence = sum / total;
  return summary;
}

function shouldPreferRetryResult(current, candidate) {
  if (candidate.lowCount < current.lowCount) return true;
  if (candidate.lowCount > current.lowCount) return false;
  return candidate.avgConfidence > current.avgConfidence + 1e-6;
}

// ─── Image rewriting ──────────────────────────────────────────────────────────

function rewriteImageParts(body, images, envelope, extractionErr, schemaVersion) {
  if (images.length === 0) return { body, rewritten: 0 };

  const extracted = {};
  let globalSummary = '';
  let globalErrors = [];
  if (envelope) {
    for (const item of envelope.images) {
      if (item.image_ref) extracted[item.image_ref] = item;
    }
    globalSummary = envelope.global_summary || '';
    globalErrors = envelope.errors || [];
  }

  const effectiveSchema = (envelope && envelope.schema_version) || schemaVersion || 'v1';

  // Deep clone body object to avoid mutation
  const obj = JSON.parse(typeof body === 'string' ? body : body.toString());
  let rewritten = 0;

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const block = {
      schema_version: effectiveSchema,
      image_ref: image.imageRef,
      status: 'fallback',
      description: 'visual context unavailable',
      conclusion: 'insufficient_visual_evidence',
    };

    if (!image.eligible) {
      block.status = 'skipped';
      block.error = image.skipReason;
    } else if (extracted[image.imageRef]) {
      const item = extracted[image.imageRef];
      block.status = 'ok';
      block.conclusion = item.conclusion;
      block.description = item.description;
      if (item.ocr_text) block.ocr_text = item.ocr_text;
      if (item.entities && item.entities.length > 0) block.entities = item.entities;
      if (item.evidence && item.evidence.length > 0) block.evidence = item.evidence;
      block.confidence = item.confidence;
    } else if (extractionErr) {
      block.error = compactText(extractionErr.message || String(extractionErr));
    } else {
      block.error = 'missing_extractor_output';
    }

    if (!block.conclusion) {
      block.conclusion = block.description || 'insufficient_visual_evidence';
    }

    if (i === 0) {
      if (globalSummary) block.global_summary = globalSummary;
      if (globalErrors && globalErrors.length > 0) block.errors = globalErrors;
    }

    const text = VISION_CONTEXT_PREFIX + '\n' + JSON.stringify(block);

    // Rewrite in-place
    const msgContent = obj.messages[image.messageIndex].content;
    msgContent[image.contentIndex] = { type: 'text', text };
    rewritten++;
  }

  return { body: Buffer.from(JSON.stringify(obj)), rewritten };
}

// ─── Extractor call ───────────────────────────────────────────────────────────

async function extractEnvelope(endpoint, apiKey, cfg, body, images, currentTask, hints, iflowOptions) {
  const requestBody = buildExtractorRequestBody(cfg, body, images, currentTask, hints);

  const sessionID = randomUUID();
  const resp = await executeIFlowRequest(endpoint, apiKey, requestBody, {
    ...iflowOptions,
    model: cfg.extractorModel,
    sessionID,
    conversationID: '',
    timeoutMs: cfg.timeoutMs,
    userAgent: MULTIMODAL_USER_AGENT,  // 使用多模态专用的 User-Agent
    minimalHeaders: true,  // 辅助模型请求使用最小 headers（无 session-id, traceparent 等）
  });

  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    const ct = resp.headers['content-type'] || '';
    const summary = resp.body.length > 400 ? resp.body.slice(0, 400).toString() + '...' : resp.body.toString();
    throw new Error(`multimodal extractor status ${resp.statusCode}: ${summary}`);
  }

  const bizErr = parseIFlowBusinessStatusError(resp.body);
  if (bizErr) throw new Error(`multimodal extractor business status ${bizErr.code}: ${bizErr.msg}`);

  const data = JSON.parse(resp.body.toString());
  const text = extractAssistantMessageText(data);
  return parseExtractionEnvelope(text, cfg.schemaVersion);
}

// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * maybeApplyMultimodalBridge
 * @param {Buffer|string} body - original request body (OpenAI format)
 * @param {object} cfg - multimodal config from config.js
 * @param {string} endpoint - iFlow chat completions endpoint
 * @param {string} apiKey - API key to use for extractor
 * @param {string} model - model being used in the original request
 * @param {object} iflowOptions - options passed to executeIFlowRequest
 * @returns {Promise<Buffer>} - possibly rewritten body
 */
async function maybeApplyMultimodalBridge(body, cfg, endpoint, apiKey, model, iflowOptions) {
  if (!cfg.enabled) return typeof body === 'string' ? Buffer.from(body) : body;

  const m = (model || '').trim();
  if (!m) return typeof body === 'string' ? Buffer.from(body) : body;
  if (!shouldBridgeModel(cfg, m)) return typeof body === 'string' ? Buffer.from(body) : body;

  const images = collectImageParts(body, cfg.maxImages);
  if (images.length === 0) return typeof body === 'string' ? Buffer.from(body) : body;

  const eligible = images.filter(img => img.eligible);
  const currentTask = extractCurrentUserTask(body);

  let envelope = null;
  let extractionErr = null;
  let confidenceSummary = { lowRefs: [], lowCount: 0, avgConfidence: 0 };

  if (eligible.length > 0) {
    try {
      envelope = await extractEnvelope(endpoint, apiKey, cfg, body, eligible, currentTask, null, iflowOptions);
      if (envelope && cfg.lowConfidenceRetry > 0) {
        confidenceSummary = summarizeConfidence(envelope, eligible, cfg.lowConfidenceThreshold);
        for (let attempt = 0; attempt < cfg.lowConfidenceRetry && confidenceSummary.lowCount > 0; attempt++) {
          try {
            const retryEnvelope = await extractEnvelope(endpoint, apiKey, cfg, body, eligible, currentTask, {
              retry: true,
              lowConfidenceRefs: [...confidenceSummary.lowRefs],
            }, iflowOptions);
            const retrySummary = summarizeConfidence(retryEnvelope, eligible, cfg.lowConfidenceThreshold);
            if (shouldPreferRetryResult(confidenceSummary, retrySummary)) {
              envelope = retryEnvelope;
              confidenceSummary = retrySummary;
            }
          } catch (retryErr) {
            console.warn(`[multimodal] retry attempt ${attempt + 1} failed:`, retryErr.message);
          }
        }
      }
    } catch (err) {
      extractionErr = err;
      console.warn('[multimodal] extraction failed, using fallback:', err.message);
    }
  }

  const { body: rewrittenBody, rewritten } = rewriteImageParts(body, images, envelope, extractionErr, cfg.schemaVersion);
  if (rewritten === 0) return typeof body === 'string' ? Buffer.from(body) : body;
  return rewrittenBody;
}

module.exports = { maybeApplyMultimodalBridge };
