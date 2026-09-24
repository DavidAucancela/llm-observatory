// LLM-as-judge: scores a single api_calls row's prompt/response with a second
// LLM call, triggered on demand from routes/evaluations.js (never automatic on
// ingest — that would silently double an org's spend on every request).
//
// Reuses whatever 'sdk' provider_credentials the org already has configured —
// no separate "judge key" concept. Default judge model per provider is the
// same fast/cheap tier routes/credentials.js already uses for PING_MODEL.
//
// Local pricing table: deliberately NOT delegated to @llm-observatory/sdk.
// Unlike services/providerUsage.js (which now prices historical sync through
// services/pricingBridge over the SDK tables), llmJudge only needs the single
// default judge model's rate per provider — a 5-line table, not a full pricing
// surface. Folding JUDGE_MODEL into pricingBridge is possible future cleanup.

function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

const JUDGE_MODEL = {
  anthropic: { model: 'claude-haiku-4-5-20251001', pricing: { input: 0.80, output: 4.00 } },
  openai:    { model: 'gpt-4o-mini',               pricing: { input: 0.15, output: 0.60 } },
  gemini:    { model: 'gemini-3.5-flash',          pricing: { input: 1.50, output: 9.00 } },
  grok:      { model: 'grok-4.6',                  pricing: { input: 2.00, output: 6.00 } },
  kimi:      { model: 'kimi-k2.6',                 pricing: { input: 0.95, output: 4.00 } },
  deepinfra: { model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', pricing: { input: 0.10, output: 0.32 } },
};

// Providers whose chat completion endpoint has the OpenAI request/response
// shape — differ only in base URL and model name.
const OPENAI_SHAPED_BASE_URL = {
  openai: 'https://api.openai.com/v1',
  grok:   'https://api.x.ai/v1',
  kimi:   'https://api.moonshot.ai/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
};

function truncateForJudge(str, max = 4000) {
  if (typeof str !== 'string') return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function buildJudgePrompt(promptText, responseText) {
  return `You are an expert AI response evaluator. Rate the quality of the AI'S RESPONSE below on a 0-100 scale, considering whether it correctly and helpfully addresses the user's request, is accurate, and is clear and well-formed.

Respond with ONLY a JSON object and nothing else: {"score": <integer 0-100>, "reasoning": "<one or two sentences explaining the score>"}

USER REQUEST:
${truncateForJudge(promptText)}

AI RESPONSE:
${truncateForJudge(responseText)}`;
}

// Judge models are asked for bare JSON but some wrap it in a ```json fence
// even when told not to — strip that before parsing, then fail loudly rather
// than fabricate a score if it still isn't valid JSON.
function parseJudgeReply(text) {
  const stripped = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error('Judge response was not valid JSON');
  }
  const score = Number(parsed.score);
  if (!Number.isFinite(score)) throw new Error('Judge response had no numeric score');
  return {
    score: Math.max(0, Math.min(100, score)),
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 2000) : null,
  };
}

async function callAnthropicJudge(apiKey, judgePrompt) {
  const { model, pricing } = JUDGE_MODEL.anthropic;
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 500, messages: [{ role: 'user', content: judgePrompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic judge call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { ...parseJudgeReply(text), model, pricing,
    inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0 };
}

async function callOpenAIShapedJudge(provider, apiKey, judgePrompt) {
  const { model, pricing } = JUDGE_MODEL[provider];
  const res = await fetchWithTimeout(`${OPENAI_SHAPED_BASE_URL[provider]}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 500, messages: [{ role: 'user', content: judgePrompt }] }),
  });
  if (!res.ok) throw new Error(`${provider} judge call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  return { ...parseJudgeReply(text), model, pricing,
    inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0 };
}

async function callGeminiJudge(apiKey, judgePrompt) {
  const { model, pricing } = JUDGE_MODEL.gemini;
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: judgePrompt }] }] }),
    }
  );
  if (!res.ok) throw new Error(`Gemini judge call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
  const usage = data.usageMetadata || {};
  return { ...parseJudgeReply(text), model, pricing,
    inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0 };
}

// provider: one of the 5 supported providers, must have a JUDGE_MODEL entry.
// Returns { score, reasoning, model, inputTokens, outputTokens, costUsd }.
async function judgeApiCall(provider, apiKey, { promptText, responseText }) {
  if (!JUDGE_MODEL[provider]) throw new Error(`No judge model configured for provider "${provider}"`);
  const judgePrompt = buildJudgePrompt(promptText, responseText);

  const result = provider === 'anthropic' ? await callAnthropicJudge(apiKey, judgePrompt)
    : provider === 'gemini' ? await callGeminiJudge(apiKey, judgePrompt)
    : await callOpenAIShapedJudge(provider, apiKey, judgePrompt);

  const costUsd = (result.inputTokens / 1_000_000) * result.pricing.input
    + (result.outputTokens / 1_000_000) * result.pricing.output;

  return {
    score: result.score, reasoning: result.reasoning, model: result.model,
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd,
  };
}

module.exports = { judgeApiCall, JUDGE_MODEL };
