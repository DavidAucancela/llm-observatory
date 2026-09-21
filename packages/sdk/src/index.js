const Anthropic = require('@anthropic-ai/sdk');

// Cost per million tokens (USD) — July 2026
const ANTHROPIC_PRICING = {
  'claude-fable-5':               { input: 10.00, output: 50.00 },
  'claude-mythos-5':              { input: 10.00, output: 50.00 },
  'claude-opus-4-8':              { input:  5.00, output: 25.00 },
  'claude-opus-4-7':              { input:  5.00, output: 25.00 },
  'claude-opus-4-6':              { input:  5.00, output: 25.00 },
  // Claude Sonnet 5 launched at an introductory $2/$10 rate through 2026-08-31;
  // this table uses the post-intro standard rate so it doesn't silently go stale.
  'claude-sonnet-5':              { input:  3.00, output: 15.00 },
  'claude-sonnet-4-6':            { input:  3.00, output: 15.00 },
  'claude-haiku-4-5':             { input:  0.80, output:  4.00 },
  'claude-haiku-4-5-20251001':    { input:  0.80, output:  4.00 },
  'claude-3-5-sonnet-20241022':   { input:  3.00, output: 15.00 },
  'claude-3-5-haiku-20241022':    { input:  0.80, output:  4.00 },
  'claude-3-opus-20240229':       { input: 15.00, output: 75.00 },
  'claude-3-haiku-20240307':      { input:  0.25, output:  1.25 },
};

const OPENAI_PRICING = {
  // Current generation — July 2026
  'gpt-5.6-sol':    { input:  5.00, output: 30.00 },
  'gpt-5.6':        { input:  5.00, output: 30.00 }, // alias of gpt-5.6-sol
  'gpt-5.6-terra':  { input:  2.50, output: 15.00 },
  'gpt-5.6-luna':   { input:  1.00, output:  6.00 },
  'gpt-5.5':        { input:  5.00, output: 30.00 },
  'gpt-5.5-pro':    { input: 30.00, output: 180.00 },
  'gpt-5.4':        { input:  2.50, output: 15.00 },
  'gpt-5.4-mini':   { input:  0.75, output:  4.50 },
  'gpt-5.4-nano':   { input:  0.20, output:  1.25 },
  'gpt-5.4-pro':    { input: 30.00, output: 180.00 },
  'chat-latest':    { input:  5.00, output: 30.00 },
  'gpt-5.3-codex':  { input:  1.75, output: 14.00 },
  // Legacy — still billable
  'gpt-4o':        { input:  2.50, output: 10.00 },
  'gpt-4o-mini':   { input:  0.15, output:  0.60 },
  'gpt-4-turbo':   { input: 10.00, output: 30.00 },
  'gpt-4':         { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo': { input:  0.50, output:  1.50 },
  'o1':            { input: 15.00, output: 60.00 },
  'o1-mini':       { input:  3.00, output: 12.00 },
  'o3-mini':       { input:  1.10, output:  4.40 },
  'o3':            { input: 10.00, output: 40.00 },
  'gpt-4.1':       { input:  2.00, output:  8.00 },
  'gpt-4.1-mini':  { input:  0.40, output:  1.60 },
  'gpt-4.1-nano':  { input:  0.10, output:  0.40 },
};

// Embeddings: price per million input tokens
const OPENAI_EMBEDDINGS_PRICING = {
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
  'text-embedding-ada-002': 0.10,
};

// Whisper: price per minute of audio
const OPENAI_WHISPER_PRICE_PER_MINUTE = 0.006;

// TTS: price per million characters
const OPENAI_TTS_PRICING = {
  'tts-1':          15.00,
  'tts-1-hd':       30.00,
  'gpt-4o-mini-tts': 15.00,
};

// Cost per million tokens (USD) — July 2026. Standard (<=200k context) tier only;
// gemini-*-pro models roughly double past 200k context, not modeled here.
const GEMINI_PRICING = {
  'gemini-3.1-pro-preview': { input: 2.00, output: 12.00 },
  'gemini-3.5-flash':       { input: 1.50, output:  9.00 },
  'gemini-3-flash-preview': { input: 0.50, output:  3.00 },
  'gemini-3.1-flash-lite':  { input: 0.25, output:  1.50 },
  'gemini-2.5-pro':         { input: 1.25, output: 10.00 },
  'gemini-2.5-flash':       { input: 0.30, output:  2.50 },
};

// Cost per million tokens (USD) — August 2026, per docs.x.ai/docs/models. Standard
// (<200k context) tier only; xAI doubles input/output rates at >=200k context,
// not modeled here (same simplification as GEMINI_PRICING above). Cached-input
// discount also not modeled — cache_read_tokens is tracked/displayed but billed
// at the standard input rate, matching how Anthropic/OpenAI/Gemini already work here.
const GROK_PRICING = {
  'grok-4.6':                     { input: 2.00, output:  6.00 },
  'grok-4.5':                     { input: 2.00, output:  6.00 },
  'grok-4.3':                     { input: 1.25, output:  2.50 },
  'grok-4.20-0309-reasoning':     { input: 1.25, output:  2.50 },
  'grok-4.20-0309-non-reasoning': { input: 1.25, output:  2.50 },
  'grok-4.20-multi-agent-0309':   { input: 1.25, output:  2.50 },
  'grok-build-0.1':               { input: 1.00, output:  2.00 },
};

// Cost per million tokens (USD) — August 2026, per platform.kimi.ai/docs/pricing.
// Cache-miss (standard) rate only — same simplification as GROK_PRICING above.
const KIMI_PRICING = {
  'kimi-k3':                   { input: 3.00, output: 15.00 },
  'kimi-k2.6':                 { input: 0.95, output:  4.00 },
  'kimi-k2.7-code':            { input: 0.95, output:  4.00 },
  'kimi-k2.7-code-highspeed':  { input: 1.90, output:  8.00 },
};

// Cost per million tokens (USD) — per deepinfra.com/pricing, read 2026-09-21.
// DeepInfra hosts hundreds of models and reprices them often, so this covers
// only the popular ones: a model missing here prices at $0 and is flagged
// cost_confidence='unknown' (see finalizeMetricPricing) instead of guessing.
// When the API response carries its own cost (see extractDeepInfraCost) that
// figure wins over this table. Cache-miss (standard) rate only — same
// simplification as GROK_PRICING/KIMI_PRICING above. Ids are DeepInfra's own
// `org/Model` form and are case-sensitive.
const DEEPINFRA_PRICING = {
  'deepseek-ai/DeepSeek-V4-Flash-0731':          { input: 0.06,  output:  0.18 },
  'deepseek-ai/DeepSeek-V4-Flash':               { input: 0.09,  output:  0.18 },
  'deepseek-ai/DeepSeek-V4-Pro':                 { input: 1.30,  output:  2.60 },
  'deepseek-ai/DeepSeek-V3.2':                   { input: 0.26,  output:  0.38 },
  'deepseek-ai/DeepSeek-V3.1':                   { input: 0.25,  output:  0.95 },
  'deepseek-ai/DeepSeek-V3':                     { input: 0.32,  output:  0.89 },
  'moonshotai/Kimi-K3':                          { input: 2.85,  output: 14.25 },
  'moonshotai/Kimi-K2.7-Code':                   { input: 0.68,  output:  3.40 },
  'Qwen/Qwen3-Max':                              { input: 1.20,  output:  6.00 },
  'google/gemma-4-31B-it':                       { input: 0.13,  output:  0.38 },
  'google/gemini-2.5-flash':                     { input: 0.30,  output:  2.50 },
  'anthropic/claude-sonnet-5':                   { input: 3.00,  output: 15.00 },
  'meta-llama/Llama-3.3-70B-Instruct-Turbo':     { input: 0.10,  output:  0.32 },
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': { input: 0.02,  output:  0.04 },
  'mistralai/Mistral-Nemo-Instruct-2407':        { input: 0.019, output:  0.03 },
};

// Chat/text pricing tables keyed by provider — used to normalize the model id
// and to decide cost_confidence. Embeddings/Whisper/TTS have their own tables
// and are handled by the cost_usd===0 guard in finalizeMetricPricing.
const PROVIDER_PRICING = {
  anthropic: ANTHROPIC_PRICING,
  openai:    OPENAI_PRICING,
  gemini:    GEMINI_PRICING,
  grok:      GROK_PRICING,
  kimi:      KIMI_PRICING,
  deepinfra: DEEPINFRA_PRICING,
};

const MODEL_SNAPSHOT_SUFFIX_RE = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

// Best-effort canonicalization of a raw model id before a pricing lookup:
// strips a `models/` prefix (Gemini accepts both forms) and a trailing
// -YYYYMMDD / -YYYY-MM-DD snapshot suffix — but only when the stripped id is
// actually present in `pricingTable`, so unknown/future ids pass through
// untouched. Mirrors packages/web/src/utils/modelAlias.js's suffix handling.
function normalizeModelId(model, pricingTable) {
  if (!model || typeof model !== 'string') return model;
  let m = model.startsWith('models/') ? model.slice(7) : model;
  if (pricingTable && pricingTable[m]) return m;
  const stripped = m.replace(MODEL_SNAPSHOT_SUFFIX_RE, '');
  if (pricingTable && pricingTable[stripped]) return stripped;
  return m;
}

// Mutates the outgoing metric payload: canonicalizes `data.model` and stamps
// `cost_confidence: 'unknown'` when the model has no entry in its provider's
// pricing table AND the call clearly used tokens but still priced at $0 (i.e.
// the SDK failed to price it, not a genuine free call). Never overrides a
// cost_confidence the caller set explicitly.
function finalizeMetricPricing(data) {
  if (!data || typeof data !== 'object') return;
  const table = PROVIDER_PRICING[data.provider];
  if (!table || !data.model) return;
  data.model = normalizeModelId(data.model, table);
  if (data.cost_confidence) return;
  const usedTokens =
    (data.input_tokens || 0) + (data.output_tokens || 0) + (data.total_tokens || 0) > 0;
  if (!table[data.model] && Number(data.cost_usd) === 0 && usedTokens) {
    data.cost_confidence = 'unknown';
  }
}

async function _postMetric(url, data, token) {
  finalizeMetricPricing(data);
  const body    = JSON.stringify(data);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
  } catch (firstErr) {
    // One retry after 1 s — still inside fire-and-forget, never blocks the caller
    await new Promise(r => setTimeout(r, 1000));
    await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
  }
}

function maskKey(key) {
  if (!key || key.length < 12) return null;
  return key.substring(0, 8) + '…' + key.slice(-4);
}

function classifyError(err) {
  if (!err) return {};
  const status = err.status || err.statusCode || 500;
  let error_type;
  if (status === 401 || status === 403)    error_type = 'auth_error';
  else if (status === 429)                 error_type = 'rate_limit';
  else if (status === 400)                 error_type = 'invalid_request';
  else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') error_type = 'network_error';
  else if (err.name === 'AbortError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') error_type = 'timeout';
  else if (status >= 500)                  error_type = 'server_error';
  else                                     error_type = 'unknown_error';
  return {
    error_type,
    error_message: (err.message || String(err)).substring(0, 500),
  };
}

function truncate(str, max) {
  if (typeof str !== 'string') return str;
  return str.length > max ? str.slice(0, max) : str;
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}

// ── Full request/response capture — Anthropic ────────────────────────────────
// Scoped to messages.create only (see CLAUDE.md); embeddings/transcription/
// speech keep the lightweight prompt_preview-only capture.
function extractAnthropicRequestDetails(params) {
  const promptFull = truncate(JSON.stringify(params.messages || []), 20000);
  const systemPrompt = params.system
    ? truncate(typeof params.system === 'string' ? params.system : JSON.stringify(params.system), 4000)
    : null;
  const requestParams = {
    temperature: params.temperature,
    max_tokens:  params.max_tokens,
    top_p:       params.top_p,
    stream:      !!params.stream,
  };
  return { promptFull, systemPrompt, requestParams };
}

function extractAnthropicResponseDetails(message) {
  const content = message?.content || [];
  const responseFull = truncate(
    content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    20000
  );
  const toolCalls = content
    .filter(b => b.type === 'tool_use')
    .map(b => ({ name: b.name, arguments: b.input }));
  return { responseFull, toolCalls, stopReason: message?.stop_reason || null };
}

// ── Full request/response capture — OpenAI chat completions ──────────────────
function extractOpenAIRequestDetails(params) {
  const messages = params.messages || [];
  const promptFull = truncate(JSON.stringify(messages), 20000);
  const systemMsg = messages.find(m => m.role === 'system');
  const systemPrompt = systemMsg
    ? truncate(typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content), 4000)
    : null;
  const requestParams = {
    temperature: params.temperature,
    max_tokens:  params.max_tokens,
    top_p:       params.top_p,
    stream:      !!params.stream,
  };
  return { promptFull, systemPrompt, requestParams };
}

function extractOpenAIResponseDetails(response) {
  const message = response?.choices?.[0]?.message;
  const responseFull = truncate(message?.content || '', 20000);
  const toolCalls = (message?.tool_calls || []).map(tc => ({
    name: tc.function?.name,
    arguments: safeJsonParse(tc.function?.arguments),
  }));
  return { responseFull, toolCalls, stopReason: response?.choices?.[0]?.finish_reason || null };
}

// ── Full request/response capture — Gemini ────────────────────────────────────
function geminiPromptPreview(contents) {
  if (typeof contents === 'string') return contents.substring(0, 200);
  const first = Array.isArray(contents) ? contents[0] : contents;
  const text = first?.parts?.map(p => p.text).filter(Boolean).join(' ') ?? JSON.stringify(first ?? '');
  return String(text).substring(0, 200);
}

function extractGeminiRequestDetails(params) {
  const promptFull = truncate(
    typeof params.contents === 'string' ? params.contents : JSON.stringify(params.contents || ''),
    20000
  );
  const systemInstruction = params.config?.systemInstruction;
  const systemPrompt = systemInstruction
    ? truncate(typeof systemInstruction === 'string' ? systemInstruction : JSON.stringify(systemInstruction), 4000)
    : null;
  const requestParams = {
    temperature: params.config?.temperature,
    max_tokens:  params.config?.maxOutputTokens,
    top_p:       params.config?.topP,
  };
  return { promptFull, systemPrompt, requestParams };
}

function extractGeminiToolNames(params) {
  const tools = params.config?.tools || [];
  return tools.flatMap(t => (t.functionDeclarations || []).map(fd => fd.name)).filter(Boolean);
}

function extractGeminiResponseDetails(response) {
  const responseFull = truncate(response?.text || '', 20000);
  const toolCalls = (response?.functionCalls || []).map(fc => ({ name: fc.name, arguments: fc.args }));
  const stopReason = response?.candidates?.[0]?.finishReason || null;
  return { responseFull, toolCalls, stopReason };
}

function calculateCost(model, inputTokens, outputTokens) {
  const pricing = ANTHROPIC_PRICING[normalizeModelId(model, ANTHROPIC_PRICING)];
  if (!pricing) {
    console.warn(`[LLM Observatory] Unknown Anthropic model pricing: "${model}" — cost recorded as $0`);
    return 0;
  }
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

function calculateOpenAICost(model, inputTokens, outputTokens) {
  const pricing = OPENAI_PRICING[normalizeModelId(model, OPENAI_PRICING)];
  if (!pricing) {
    console.warn(`[LLM Observatory] Unknown OpenAI model pricing: "${model}" — cost recorded as $0`);
    return 0;
  }
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

function calculateOpenAIEmbeddingCost(model, inputTokens) {
  const price = OPENAI_EMBEDDINGS_PRICING[model];
  if (!price) {
    console.warn(`[LLM Observatory] Unknown embedding model pricing: "${model}" — cost recorded as $0`);
    return 0;
  }
  return (inputTokens / 1_000_000) * price;
}

function calculateWhisperCost(durationSeconds) {
  return (durationSeconds / 60) * OPENAI_WHISPER_PRICE_PER_MINUTE;
}

function calculateTTSCost(model, characterCount) {
  const price = OPENAI_TTS_PRICING[model];
  if (!price) {
    console.warn(`[LLM Observatory] Unknown TTS model pricing: "${model}" — cost recorded as $0`);
    return 0;
  }
  return (characterCount / 1_000_000) * price;
}

function calculateGeminiCost(model, inputTokens, outputTokens) {
  const pricing = GEMINI_PRICING[normalizeModelId(model, GEMINI_PRICING)];
  if (!pricing) {
    console.warn(`[LLM Observatory] Unknown Gemini model pricing: "${model}" — cost recorded as $0`);
    return 0;
  }
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

function calculateGrokCost(model, inputTokens, outputTokens) {
  const pricing = GROK_PRICING[normalizeModelId(model, GROK_PRICING)];
  if (!pricing) {
    console.warn(`[LLM Observatory] Unknown Grok model pricing: "${model}" — cost recorded as $0`);
    return 0;
  }
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

function calculateKimiCost(model, inputTokens, outputTokens) {
  const pricing = KIMI_PRICING[normalizeModelId(model, KIMI_PRICING)];
  if (!pricing) {
    console.warn(`[LLM Observatory] Unknown Kimi model pricing: "${model}" — cost recorded as $0`);
    return 0;
  }
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

function calculateDeepInfraCost(model, inputTokens, outputTokens) {
  const pricing = DEEPINFRA_PRICING[normalizeModelId(model, DEEPINFRA_PRICING)];
  if (!pricing) {
    console.warn(`[LLM Observatory] Unknown DeepInfra model pricing: "${model}" — cost recorded as $0`);
    return 0;
  }
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

// DeepInfra may report the billed cost of a request inside `usage`. The field
// name is not in their public docs, so accept the two plausible spellings and
// only trust a finite, non-negative number — anything else falls back to the
// pricing table. Unverified against a live response: confirm with a real call.
function extractDeepInfraCost(usage) {
  const raw = usage?.estimated_cost ?? usage?.estimated_cost_usd;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

class MonitoredAnthropic {
  constructor(options = {}) {
    const { observatoryUrl = 'http://localhost:3001', observatoryToken, apiKey, tags = {}, ...anthropicOptions } = options;
    this.observatoryUrl   = observatoryUrl;
    this.observatoryToken = observatoryToken;
    this.tags      = tags;
    this.apiKeyHint = maskKey(apiKey || anthropicOptions.apiKey || process.env.ANTHROPIC_API_KEY);
    this.client    = new Anthropic({ apiKey, ...anthropicOptions });
    this.messages  = this._buildMessagesProxy();
  }

  _buildMessagesProxy() {
    const self = this;
    return {
      create: async (params) => {
        const startTime = Date.now();
        const promptPreview = typeof params.messages?.[0]?.content === 'string'
          ? params.messages[0].content.substring(0, 200)
          : JSON.stringify(params.messages?.[0]?.content || '').substring(0, 200);
        const tools = params.tools?.map(t => t.name) || [];
        const { promptFull, systemPrompt, requestParams } = extractAnthropicRequestDetails(params);

        // Streaming path — capture usage from finalMessage() after caller consumes stream
        if (params.stream) {
          let stream;
          try {
            stream = await self.client.messages.create(params);
          } catch (err) {
            self._sendMetric({
              model: params.model, input_tokens: 0, output_tokens: 0, total_tokens: 0,
              cost_usd: 0, latency_ms: Date.now() - startTime, status_code: err.status || 500,
              cache_read_tokens: 0, cache_write_tokens: 0, error_message: err.message || null,
              tools_used: tools, prompt_preview: promptPreview, tags: self.tags,
              api_key_hint: self.apiKeyHint, prompt_full: promptFull,
              system_prompt: systemPrompt, request_params: requestParams,
              ...classifyError(err),
            }).catch(() => {});
            throw err;
          }

          stream.finalMessage().then(finalMsg => {
            const inputTokens  = finalMsg.usage?.input_tokens  || 0;
            const outputTokens = finalMsg.usage?.output_tokens || 0;
            const cacheReadTokens  = finalMsg.usage?.cache_read_input_tokens    || 0;
            const cacheWriteTokens = finalMsg.usage?.cache_creation_input_tokens || 0;
            const { responseFull, toolCalls, stopReason } = extractAnthropicResponseDetails(finalMsg);
            self._sendMetric({
              model: params.model,
              input_tokens: inputTokens, output_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
              cost_usd: calculateCost(params.model, inputTokens, outputTokens),
              latency_ms: Date.now() - startTime, status_code: 200,
              cache_read_tokens: cacheReadTokens, cache_write_tokens: cacheWriteTokens,
              tools_used: tools, prompt_preview: promptPreview, tags: self.tags,
              api_key_hint: self.apiKeyHint, prompt_full: promptFull,
              system_prompt: systemPrompt, request_params: requestParams,
              response_full: responseFull, tool_calls: toolCalls, stop_reason: stopReason,
            }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));
          }).catch(err => console.warn('[LLM Observatory] Streaming metric capture failed:', err.message));

          return stream;
        }

        // Non-streaming path
        let response;
        let statusCode = 200;
        let error = null;

        try {
          response = await self.client.messages.create(params);
        } catch (err) {
          statusCode = err.status || 500;
          error = err;
        }

        const inputTokens      = response?.usage?.input_tokens               || 0;
        const outputTokens     = response?.usage?.output_tokens              || 0;
        const cacheReadTokens  = response?.usage?.cache_read_input_tokens    || 0;
        const cacheWriteTokens = response?.usage?.cache_creation_input_tokens || 0;
        const { responseFull, toolCalls, stopReason } = response
          ? extractAnthropicResponseDetails(response)
          : { responseFull: null, toolCalls: [], stopReason: null };

        self._sendMetric({
          model: params.model,
          input_tokens: inputTokens, output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cost_usd: calculateCost(params.model, inputTokens, outputTokens),
          latency_ms: Date.now() - startTime, status_code: statusCode,
          cache_read_tokens: cacheReadTokens, cache_write_tokens: cacheWriteTokens,
          error_message: error ? (error.message || null) : null,
          tools_used: tools, prompt_preview: promptPreview, tags: self.tags,
          api_key_hint: self.apiKeyHint, prompt_full: promptFull,
          system_prompt: systemPrompt, request_params: requestParams,
          response_full: responseFull, tool_calls: toolCalls, stop_reason: stopReason,
          ...(error ? classifyError(error) : {}),
        }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));

        if (error) throw error;
        return response;
      }
    };
  }

  async _sendMetric(data) {
    await _postMetric(`${this.observatoryUrl}/api/metrics`, data, this.observatoryToken);
  }
}

class MonitoredOpenAI {
  constructor(options = {}) {
    const { observatoryUrl = 'http://localhost:3001', observatoryToken, apiKey, tags = {}, ...openaiOptions } = options;
    this.observatoryUrl   = observatoryUrl;
    this.observatoryToken = observatoryToken;
    this.tags      = tags;
    this.apiKeyHint = maskKey(apiKey || openaiOptions.apiKey || process.env.OPENAI_API_KEY);
    const OpenAI = require('openai');
    this.client = new OpenAI({ apiKey, ...openaiOptions });
    this.chat = { completions: { create: this._createCompletion.bind(this) } };
    this.embeddings = { create: this._createEmbedding.bind(this) };
    this.audio = {
      transcriptions: { create: this._createTranscription.bind(this) },
      speech:         { create: this._createSpeech.bind(this) },
    };
    this.responses = { create: this._createResponse.bind(this) };
  }

  async _createCompletion(params) {
    const startTime = Date.now();
    const firstMsg = params.messages?.[0];
    const promptPreview = typeof firstMsg?.content === 'string'
      ? firstMsg.content.substring(0, 200)
      : JSON.stringify(firstMsg?.content || '').substring(0, 200);
    const tools = params.tools?.map(t => t.function?.name || t.name) || [];
    const { promptFull, systemPrompt, requestParams } = extractOpenAIRequestDetails(params);

    // Streaming path — wrap the async iterable to capture the final usage chunk
    if (params.stream) {
      let stream;
      try {
        // include_usage ensures the final chunk carries token counts
        const streamParams = { ...params, stream_options: { include_usage: true, ...params.stream_options } };
        stream = await this.client.chat.completions.create(streamParams);
      } catch (err) {
        this._sendMetric({
          provider: 'openai', model: params.model, input_tokens: 0, output_tokens: 0,
          total_tokens: 0, cost_usd: 0, latency_ms: Date.now() - startTime,
          status_code: err.status || 500, tools_used: tools, prompt_preview: promptPreview, tags: this.tags,
          api_key_hint: this.apiKeyHint, prompt_full: promptFull,
          system_prompt: systemPrompt, request_params: requestParams,
          ...classifyError(err),
        }).catch(() => {});
        throw err;
      }

      return this._wrapOpenAIStream(stream, startTime, params, tools, promptPreview, { promptFull, systemPrompt, requestParams });
    }

    // Non-streaming path
    let response;
    let statusCode = 200;
    let error = null;

    try {
      response = await this.client.chat.completions.create(params);
    } catch (err) {
      statusCode = err.status || 500;
      error = err;
    }

    const inputTokens      = response?.usage?.prompt_tokens                          || 0;
    const outputTokens     = response?.usage?.completion_tokens                      || 0;
    const cacheReadTokens  = response?.usage?.prompt_tokens_details?.cached_tokens   || 0;
    const { responseFull, toolCalls, stopReason } = response
      ? extractOpenAIResponseDetails(response)
      : { responseFull: null, toolCalls: [], stopReason: null };

    this._sendMetric({
      provider: 'openai', model: params.model,
      input_tokens: inputTokens, output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cost_usd: calculateOpenAICost(params.model, inputTokens, outputTokens),
      latency_ms: Date.now() - startTime, status_code: statusCode,
      cache_read_tokens: cacheReadTokens, cache_write_tokens: 0,
      error_message: error ? (error.message || null) : null,
      tools_used: tools, prompt_preview: promptPreview, tags: this.tags,
      api_key_hint: this.apiKeyHint, prompt_full: promptFull,
      system_prompt: systemPrompt, request_params: requestParams,
      response_full: responseFull, tool_calls: toolCalls, stop_reason: stopReason,
      ...(error ? classifyError(error) : {}),
    }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));

    if (error) throw error;
    return response;
  }

  async* _wrapOpenAIStream(stream, startTime, params, tools, promptPreview, requestDetails) {
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0;
    let responseText = '';
    let stopReason = null;
    const toolCallsMap = new Map(); // index -> { name, arguments: '' } — OpenAI streams tool_calls as fragments
    try {
      for await (const chunk of stream) {
        if (chunk.usage) {
          inputTokens     = chunk.usage.prompt_tokens                        || 0;
          outputTokens    = chunk.usage.completion_tokens                    || 0;
          cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens || 0;
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) responseText += choice.delta.content;
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            const entry = toolCallsMap.get(idx) || { name: '', arguments: '' };
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            toolCallsMap.set(idx, entry);
          }
        }
        if (choice?.finish_reason) stopReason = choice.finish_reason;
        yield chunk;
      }
    } finally {
      const toolCalls = Array.from(toolCallsMap.values()).map(tc => ({
        name: tc.name, arguments: safeJsonParse(tc.arguments),
      }));
      this._sendMetric({
        provider: 'openai', model: params.model,
        input_tokens: inputTokens, output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cost_usd: calculateOpenAICost(params.model, inputTokens, outputTokens),
        latency_ms: Date.now() - startTime, status_code: 200,
        cache_read_tokens: cacheReadTokens, cache_write_tokens: 0,
        tools_used: tools, prompt_preview: promptPreview, tags: this.tags,
        api_key_hint: this.apiKeyHint, prompt_full: requestDetails.promptFull,
        system_prompt: requestDetails.systemPrompt, request_params: requestDetails.requestParams,
        response_full: truncate(responseText, 20000), tool_calls: toolCalls, stop_reason: stopReason,
      }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));
    }
  }

  async _createEmbedding(params) {
    const startTime = Date.now();
    const inputPreview = Array.isArray(params.input)
      ? `[${params.input.length} input(s)] ${String(params.input[0]).substring(0, 150)}`
      : String(params.input).substring(0, 200);

    let response, statusCode = 200, error = null;
    try {
      response = await this.client.embeddings.create(params);
    } catch (err) {
      statusCode = err.status || 500;
      error = err;
    }

    const inputTokens = response?.usage?.prompt_tokens || 0;
    this._sendMetric({
      provider: 'openai', model: params.model,
      input_tokens: inputTokens, output_tokens: 0, total_tokens: inputTokens,
      cost_usd: calculateOpenAIEmbeddingCost(params.model, inputTokens),
      latency_ms: Date.now() - startTime, status_code: statusCode,
      tools_used: [], prompt_preview: inputPreview,
      tags: this.tags, api_key_hint: this.apiKeyHint, ...(error ? classifyError(error) : {}),
    }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));

    if (error) throw error;
    return response;
  }

  async _createTranscription(params) {
    const startTime = Date.now();
    const originalFormat = params.response_format;
    const canGetDuration = !originalFormat || ['json', 'verbose_json', 'text'].includes(originalFormat);

    let response, statusCode = 200, error = null;
    try {
      // Force verbose_json internally to capture duration for accurate cost tracking.
      // srt/vtt formats can't be reconstructed from verbose_json, so they skip duration.
      const callParams = canGetDuration ? { ...params, response_format: 'verbose_json' } : params;
      response = await this.client.audio.transcriptions.create(callParams);
    } catch (err) {
      statusCode = err.status || 500;
      error = err;
    }

    const durationSeconds = response?.duration || 0;
    const transcribedText = typeof response === 'string' ? response : (response?.text || '');
    const preview = durationSeconds
      ? `audio transcription · ${Math.floor(durationSeconds / 60)}m ${Math.round(durationSeconds % 60)}s`
      : 'audio transcription';

    this._sendMetric({
      provider: 'openai', model: params.model || 'whisper-1',
      input_tokens: Math.round(durationSeconds), output_tokens: transcribedText.length,
      total_tokens: Math.round(durationSeconds),
      cost_usd: calculateWhisperCost(durationSeconds),
      latency_ms: Date.now() - startTime, status_code: statusCode,
      tools_used: [], prompt_preview: preview,
      tags: this.tags, api_key_hint: this.apiKeyHint, ...(error ? classifyError(error) : {}),
    }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));

    if (error) throw error;

    // Return in the format the user originally requested
    if (!canGetDuration) return response; // srt / vtt — already in correct format
    if (!originalFormat || originalFormat === 'json') return { text: response.text };
    if (originalFormat === 'text') return response.text;
    return response; // verbose_json
  }

  async _createSpeech(params) {
    const startTime = Date.now();
    const charCount = (params.input || '').length;

    let response, statusCode = 200, error = null;
    try {
      response = await this.client.audio.speech.create(params);
    } catch (err) {
      statusCode = err.status || 500;
      error = err;
    }

    this._sendMetric({
      provider: 'openai', model: params.model || 'tts-1',
      input_tokens: charCount, output_tokens: 0, total_tokens: charCount,
      cost_usd: calculateTTSCost(params.model || 'tts-1', charCount),
      latency_ms: Date.now() - startTime, status_code: statusCode,
      tools_used: [],
      prompt_preview: `[TTS ${params.voice || ''}] ${(params.input || '').substring(0, 170)}`,
      tags: this.tags, api_key_hint: this.apiKeyHint, ...(error ? classifyError(error) : {}),
    }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));

    if (error) throw error;
    return response;
  }

  async _createResponse(params) {
    const startTime = Date.now();
    const inputPreview = typeof params.input === 'string'
      ? params.input.substring(0, 200)
      : JSON.stringify(params.input?.[0] || '').substring(0, 200);

    if (params.stream) {
      let stream;
      try {
        stream = await this.client.responses.create(params);
      } catch (err) {
        this._sendMetric({
          provider: 'openai', model: params.model, input_tokens: 0, output_tokens: 0,
          total_tokens: 0, cost_usd: 0, latency_ms: Date.now() - startTime,
          status_code: err.status || 500, tools_used: [], prompt_preview: inputPreview,
          tags: this.tags, api_key_hint: this.apiKeyHint, ...classifyError(err),
        }).catch(() => {});
        throw err;
      }
      return this._wrapResponsesStream(stream, startTime, params, inputPreview);
    }

    let response, statusCode = 200, error = null;
    try {
      response = await this.client.responses.create(params);
    } catch (err) {
      statusCode = err.status || 500;
      error = err;
    }

    const inputTokens  = response?.usage?.input_tokens  || 0;
    const outputTokens = response?.usage?.output_tokens || 0;
    this._sendMetric({
      provider: 'openai', model: params.model,
      input_tokens: inputTokens, output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cost_usd: calculateOpenAICost(params.model, inputTokens, outputTokens),
      latency_ms: Date.now() - startTime, status_code: statusCode,
      tools_used: [], prompt_preview: inputPreview,
      tags: this.tags, api_key_hint: this.apiKeyHint, ...(error ? classifyError(error) : {}),
    }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));

    if (error) throw error;
    return response;
  }

  async* _wrapResponsesStream(stream, startTime, params, inputPreview) {
    let inputTokens = 0, outputTokens = 0;
    try {
      for await (const event of stream) {
        if (event.type === 'response.completed') {
          inputTokens  = event.response?.usage?.input_tokens  || 0;
          outputTokens = event.response?.usage?.output_tokens || 0;
        }
        yield event;
      }
    } finally {
      this._sendMetric({
        provider: 'openai', model: params.model,
        input_tokens: inputTokens, output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cost_usd: calculateOpenAICost(params.model, inputTokens, outputTokens),
        latency_ms: Date.now() - startTime, status_code: 200,
        tools_used: [], prompt_preview: inputPreview,
        tags: this.tags, api_key_hint: this.apiKeyHint,
      }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));
    }
  }

  async _sendMetric(data) {
    await _postMetric(`${this.observatoryUrl}/api/metrics`, data, this.observatoryToken);
  }
}

class MonitoredGemini {
  constructor(options = {}) {
    const { observatoryUrl = 'http://localhost:3001', observatoryToken, apiKey, tags = {}, ...geminiOptions } = options;
    this.observatoryUrl   = observatoryUrl;
    this.observatoryToken = observatoryToken;
    this.tags       = tags;
    this.apiKeyHint = maskKey(apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    const { GoogleGenAI } = require('@google/genai');
    this.client = new GoogleGenAI({ apiKey, ...geminiOptions });
    this.models = {
      generateContent:       this._generateContent.bind(this),
      generateContentStream: this._generateContentStream.bind(this),
    };
  }

  async _generateContent(params) {
    const startTime = Date.now();
    const promptPreview = geminiPromptPreview(params.contents);
    const tools = extractGeminiToolNames(params);
    const { promptFull, systemPrompt, requestParams } = extractGeminiRequestDetails(params);

    let response, statusCode = 200, error = null;
    try {
      response = await this.client.models.generateContent(params);
    } catch (err) {
      statusCode = err.status || err.code || 500;
      error = err;
    }

    const usage = response?.usageMetadata || {};
    const inputTokens     = usage.promptTokenCount        || 0;
    const outputTokens    = usage.candidatesTokenCount    || 0;
    const cacheReadTokens = usage.cachedContentTokenCount || 0;
    const { responseFull, toolCalls, stopReason } = response
      ? extractGeminiResponseDetails(response)
      : { responseFull: null, toolCalls: [], stopReason: null };

    this._sendMetric({
      provider: 'gemini', model: params.model,
      input_tokens: inputTokens, output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cost_usd: calculateGeminiCost(params.model, inputTokens, outputTokens),
      latency_ms: Date.now() - startTime, status_code: statusCode,
      cache_read_tokens: cacheReadTokens, cache_write_tokens: 0,
      error_message: error ? (error.message || null) : null,
      tools_used: tools, prompt_preview: promptPreview, tags: this.tags,
      api_key_hint: this.apiKeyHint, prompt_full: promptFull,
      system_prompt: systemPrompt, request_params: { ...requestParams, stream: false },
      response_full: responseFull, tool_calls: toolCalls, stop_reason: stopReason,
      ...(error ? classifyError(error) : {}),
    }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));

    if (error) throw error;
    return response;
  }

  async* _generateContentStream(params) {
    const startTime = Date.now();
    const promptPreview = geminiPromptPreview(params.contents);
    const tools = extractGeminiToolNames(params);
    const { promptFull, systemPrompt, requestParams } = extractGeminiRequestDetails(params);

    let stream;
    try {
      stream = await this.client.models.generateContentStream(params);
    } catch (err) {
      this._sendMetric({
        provider: 'gemini', model: params.model, input_tokens: 0, output_tokens: 0,
        total_tokens: 0, cost_usd: 0, latency_ms: Date.now() - startTime,
        status_code: err.status || err.code || 500, tools_used: tools, prompt_preview: promptPreview,
        tags: this.tags, api_key_hint: this.apiKeyHint, prompt_full: promptFull,
        system_prompt: systemPrompt, request_params: { ...requestParams, stream: true },
        ...classifyError(err),
      }).catch(() => {});
      throw err;
    }

    // usageMetadata is cumulative per chunk (per Gemini's documented behavior) —
    // the last chunk that carries it holds the final totals, so just keep
    // overwriting rather than summing.
    let usage = {};
    let responseText = '';
    let stopReason = null;
    const toolCallsAcc = [];
    try {
      for await (const chunk of stream) {
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        if (chunk.text) responseText += chunk.text;
        if (chunk.functionCalls?.length) {
          toolCallsAcc.push(...chunk.functionCalls.map(fc => ({ name: fc.name, arguments: fc.args })));
        }
        const finishReason = chunk.candidates?.[0]?.finishReason;
        if (finishReason) stopReason = finishReason;
        yield chunk;
      }
    } finally {
      const inputTokens     = usage.promptTokenCount        || 0;
      const outputTokens    = usage.candidatesTokenCount    || 0;
      const cacheReadTokens = usage.cachedContentTokenCount || 0;
      this._sendMetric({
        provider: 'gemini', model: params.model,
        input_tokens: inputTokens, output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cost_usd: calculateGeminiCost(params.model, inputTokens, outputTokens),
        latency_ms: Date.now() - startTime, status_code: 200,
        cache_read_tokens: cacheReadTokens, cache_write_tokens: 0,
        tools_used: tools, prompt_preview: promptPreview, tags: this.tags,
        api_key_hint: this.apiKeyHint, prompt_full: promptFull,
        system_prompt: systemPrompt, request_params: { ...requestParams, stream: true },
        response_full: truncate(responseText, 20000), tool_calls: toolCallsAcc, stop_reason: stopReason,
      }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));
    }
  }

  async _sendMetric(data) {
    await _postMetric(`${this.observatoryUrl}/api/metrics`, data, this.observatoryToken);
  }
}

// ── Shared chat-completions handling for OpenAI-compatible providers ─────────
// Grok (xAI) and Kimi (Moonshot) both expose an OpenAI-shaped chat.completions
// API — same request/response shape, streamed the same way — so MonitoredGrok
// and MonitoredKimi share this proxy instead of each re-implementing the
// streaming/tool-call-fragment-accumulation logic that MonitoredOpenAI already
// has above. MonitoredOpenAI itself is untouched: it also covers embeddings/
// whisper/tts/responses, which don't apply to either of these providers.
function extractCachedTokensNested(usage) {
  return usage?.prompt_tokens_details?.cached_tokens || 0;
}

function extractCachedTokensFlat(usage) {
  return usage?.cached_tokens || 0;
}

// `extractCostFn(usage)` is optional: a provider that reports the billed cost
// in the response (DeepInfra) returns it here and it overrides the table-based
// `calculateCostFn`; returning null/undefined falls back to the table.
function resolveOpenAICompatibleCost(calculateCostFn, extractCostFn, model, usage, inputTokens, outputTokens) {
  const reported = extractCostFn && usage ? extractCostFn(usage) : null;
  return reported != null ? reported : calculateCostFn(model, inputTokens, outputTokens);
}

function buildOpenAICompatibleChatProxy(self, { provider, calculateCostFn, extractCacheReadTokens, extractCostFn }) {
  return {
    create: async (params) => {
      const startTime = Date.now();
      const firstMsg = params.messages?.[0];
      const promptPreview = typeof firstMsg?.content === 'string'
        ? firstMsg.content.substring(0, 200)
        : JSON.stringify(firstMsg?.content || '').substring(0, 200);
      const tools = params.tools?.map(t => t.function?.name || t.name) || [];
      const { promptFull, systemPrompt, requestParams } = extractOpenAIRequestDetails(params);

      if (params.stream) {
        let stream;
        try {
          const streamParams = { ...params, stream_options: { include_usage: true, ...params.stream_options } };
          stream = await self.client.chat.completions.create(streamParams);
        } catch (err) {
          self._sendMetric({
            provider, model: params.model, input_tokens: 0, output_tokens: 0,
            total_tokens: 0, cost_usd: 0, latency_ms: Date.now() - startTime,
            status_code: err.status || 500, tools_used: tools, prompt_preview: promptPreview, tags: self.tags,
            api_key_hint: self.apiKeyHint, prompt_full: promptFull,
            system_prompt: systemPrompt, request_params: requestParams,
            ...classifyError(err),
          }).catch(() => {});
          throw err;
        }

        return wrapOpenAICompatibleStream(self, stream, startTime, params, tools, promptPreview,
          { promptFull, systemPrompt, requestParams }, { provider, calculateCostFn, extractCacheReadTokens, extractCostFn });
      }

      let response, statusCode = 200, error = null;
      try {
        response = await self.client.chat.completions.create(params);
      } catch (err) {
        statusCode = err.status || 500;
        error = err;
      }

      const inputTokens     = response?.usage?.prompt_tokens     || 0;
      const outputTokens    = response?.usage?.completion_tokens || 0;
      const cacheReadTokens = response?.usage ? extractCacheReadTokens(response.usage) : 0;
      const { responseFull, toolCalls, stopReason } = response
        ? extractOpenAIResponseDetails(response)
        : { responseFull: null, toolCalls: [], stopReason: null };

      self._sendMetric({
        provider, model: params.model,
        input_tokens: inputTokens, output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cost_usd: resolveOpenAICompatibleCost(calculateCostFn, extractCostFn, params.model, response?.usage, inputTokens, outputTokens),
        latency_ms: Date.now() - startTime, status_code: statusCode,
        cache_read_tokens: cacheReadTokens, cache_write_tokens: 0,
        error_message: error ? (error.message || null) : null,
        tools_used: tools, prompt_preview: promptPreview, tags: self.tags,
        api_key_hint: self.apiKeyHint, prompt_full: promptFull,
        system_prompt: systemPrompt, request_params: requestParams,
        response_full: responseFull, tool_calls: toolCalls, stop_reason: stopReason,
        ...(error ? classifyError(error) : {}),
      }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));

      if (error) throw error;
      return response;
    },
  };
}

async function* wrapOpenAICompatibleStream(self, stream, startTime, params, tools, promptPreview, requestDetails, { provider, calculateCostFn, extractCacheReadTokens, extractCostFn }) {
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0;
  let finalUsage = null;
  let responseText = '';
  let stopReason = null;
  const toolCallsMap = new Map();
  try {
    for await (const chunk of stream) {
      if (chunk.usage) {
        inputTokens     = chunk.usage.prompt_tokens     || 0;
        outputTokens    = chunk.usage.completion_tokens || 0;
        cacheReadTokens = extractCacheReadTokens(chunk.usage);
        finalUsage      = chunk.usage;
      }
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) responseText += choice.delta.content;
      if (choice?.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index ?? 0;
          const entry = toolCallsMap.get(idx) || { name: '', arguments: '' };
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          toolCallsMap.set(idx, entry);
        }
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      yield chunk;
    }
  } finally {
    const toolCalls = Array.from(toolCallsMap.values()).map(tc => ({
      name: tc.name, arguments: safeJsonParse(tc.arguments),
    }));
    self._sendMetric({
      provider, model: params.model,
      input_tokens: inputTokens, output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cost_usd: resolveOpenAICompatibleCost(calculateCostFn, extractCostFn, params.model, finalUsage, inputTokens, outputTokens),
      latency_ms: Date.now() - startTime, status_code: 200,
      cache_read_tokens: cacheReadTokens, cache_write_tokens: 0,
      tools_used: tools, prompt_preview: promptPreview, tags: self.tags,
      api_key_hint: self.apiKeyHint, prompt_full: requestDetails.promptFull,
      system_prompt: requestDetails.systemPrompt, request_params: requestDetails.requestParams,
      response_full: truncate(responseText, 20000), tool_calls: toolCalls, stop_reason: stopReason,
    }).catch(err => console.warn('[LLM Observatory] Failed to send metric:', err.message));
  }
}

class MonitoredGrok {
  constructor(options = {}) {
    const { observatoryUrl = 'http://localhost:3001', observatoryToken, apiKey, tags = {}, ...grokOptions } = options;
    this.observatoryUrl   = observatoryUrl;
    this.observatoryToken = observatoryToken;
    this.tags       = tags;
    this.apiKeyHint = maskKey(apiKey || process.env.XAI_API_KEY);
    const OpenAI = require('openai');
    this.client = new OpenAI({ apiKey: apiKey || process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1', ...grokOptions });
    this.chat = {
      completions: buildOpenAICompatibleChatProxy(this, {
        provider: 'grok', calculateCostFn: calculateGrokCost, extractCacheReadTokens: extractCachedTokensNested,
      }),
    };
  }

  async _sendMetric(data) {
    await _postMetric(`${this.observatoryUrl}/api/metrics`, data, this.observatoryToken);
  }
}

class MonitoredKimi {
  constructor(options = {}) {
    const { observatoryUrl = 'http://localhost:3001', observatoryToken, apiKey, tags = {}, ...kimiOptions } = options;
    this.observatoryUrl   = observatoryUrl;
    this.observatoryToken = observatoryToken;
    this.tags       = tags;
    this.apiKeyHint = maskKey(apiKey || process.env.MOONSHOT_API_KEY);
    const OpenAI = require('openai');
    this.client = new OpenAI({ apiKey: apiKey || process.env.MOONSHOT_API_KEY, baseURL: 'https://api.moonshot.ai/v1', ...kimiOptions });
    this.chat = {
      completions: buildOpenAICompatibleChatProxy(this, {
        provider: 'kimi', calculateCostFn: calculateKimiCost, extractCacheReadTokens: extractCachedTokensFlat,
      }),
    };
  }

  async _sendMetric(data) {
    await _postMetric(`${this.observatoryUrl}/api/metrics`, data, this.observatoryToken);
  }
}

// DeepInfra also speaks the OpenAI chat.completions dialect (base URL below), so
// it reuses the shared proxy. Unlike Grok/Kimi it can report the billed cost in
// the response, so it passes extractCostFn. Cached prompt tokens are reported
// OpenAI-style under prompt_tokens_details.
class MonitoredDeepInfra {
  constructor(options = {}) {
    const { observatoryUrl = 'http://localhost:3001', observatoryToken, apiKey, tags = {}, ...deepinfraOptions } = options;
    this.observatoryUrl   = observatoryUrl;
    this.observatoryToken = observatoryToken;
    this.tags       = tags;
    const key = apiKey || process.env.DEEPINFRA_API_KEY || process.env.DEEPINFRA_TOKEN;
    this.apiKeyHint = maskKey(key);
    const OpenAI = require('openai');
    this.client = new OpenAI({ apiKey: key, baseURL: 'https://api.deepinfra.com/v1/openai', ...deepinfraOptions });
    this.chat = {
      completions: buildOpenAICompatibleChatProxy(this, {
        provider: 'deepinfra', calculateCostFn: calculateDeepInfraCost,
        extractCacheReadTokens: extractCachedTokensNested, extractCostFn: extractDeepInfraCost,
      }),
    };
  }

  async _sendMetric(data) {
    await _postMetric(`${this.observatoryUrl}/api/metrics`, data, this.observatoryToken);
  }
}

module.exports = {
  MonitoredAnthropic,
  MonitoredOpenAI,
  MonitoredGemini,
  MonitoredGrok,
  MonitoredKimi,
  MonitoredDeepInfra,
  maskKey,
  classifyError,
  calculateCost,
  calculateOpenAICost,
  calculateOpenAIEmbeddingCost,
  calculateWhisperCost,
  calculateTTSCost,
  calculateGeminiCost,
  calculateGrokCost,
  calculateKimiCost,
  calculateDeepInfraCost,
  normalizeModelId,
  finalizeMetricPricing,
  ANTHROPIC_PRICING,
  OPENAI_PRICING,
  OPENAI_EMBEDDINGS_PRICING,
  OPENAI_WHISPER_PRICE_PER_MINUTE,
  OPENAI_TTS_PRICING,
  GEMINI_PRICING,
  GROK_PRICING,
  KIMI_PRICING,
  DEEPINFRA_PRICING,
};
