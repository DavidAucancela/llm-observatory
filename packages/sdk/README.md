# @llm-observatory/sdk

Drop-in Node.js wrapper for the Anthropic, OpenAI, Gemini, Grok (xAI), Kimi (Moonshot AI), and DeepInfra SDKs that streams usage metrics to your [LLM Observatory](https://github.com/DavidAucancela/llm-observatory) dashboard with **zero latency overhead**.

## How it works

The SDK wraps the official provider clients. Your API call returns immediately — metrics are sent to Observatory **asynchronously** (fire and forget) after the response arrives.

```
Your app ──► MonitoredAnthropic.messages.create()
               │
               ├──► Anthropic API        (awaited — your response)
               └──► Observatory API      (async, non-blocking)
```

## Installation

```bash
npm install @llm-observatory/sdk
# If using OpenAI, Grok, Kimi, or DeepInfra (Grok/Kimi/DeepInfra reuse the OpenAI SDK with a custom baseURL):
npm install openai
# If using Gemini:
npm install @google/genai
```

> If the package is not yet available on npm, install directly from GitHub:
> ```bash
> npm install github:DavidAucancela/llm-observatory/packages/sdk
> ```

## Usage

### Anthropic

```javascript
const { MonitoredAnthropic } = require('@llm-observatory/sdk');

const client = new MonitoredAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,       // your Anthropic API key
  observatoryUrl: 'http://localhost:3001',      // your Observatory API URL
  observatoryToken: process.env.OBSERVATORY_TOKEN  // obs_sk_... token from dashboard
});

// Use exactly like the official Anthropic SDK
const response = await client.messages.create({
  model: 'claude-opus-4-8', // or your preferred model
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### OpenAI

```javascript
const { MonitoredOpenAI } = require('@llm-observatory/sdk');

const client = new MonitoredOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  observatoryUrl: 'http://localhost:3001',
  observatoryToken: process.env.OBSERVATORY_TOKEN
});

const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### Gemini

```javascript
const { MonitoredGemini } = require('@llm-observatory/sdk');

const client = new MonitoredGemini({
  apiKey: process.env.GEMINI_API_KEY,
  observatoryUrl: 'http://localhost:3001',
  observatoryToken: process.env.OBSERVATORY_TOKEN
});

const response = await client.models.generateContent({
  model: 'gemini-3.5-flash',
  contents: 'Hello!'
});
```

### Grok (xAI)

```javascript
const { MonitoredGrok } = require('@llm-observatory/sdk');

const client = new MonitoredGrok({
  apiKey: process.env.XAI_API_KEY,
  observatoryUrl: 'http://localhost:3001',
  observatoryToken: process.env.OBSERVATORY_TOKEN
});

// Same shape as MonitoredOpenAI — xAI's API is OpenAI-compatible
const response = await client.chat.completions.create({
  model: 'grok-4.6',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### Kimi (Moonshot AI)

```javascript
const { MonitoredKimi } = require('@llm-observatory/sdk');

const client = new MonitoredKimi({
  apiKey: process.env.MOONSHOT_API_KEY,
  observatoryUrl: 'http://localhost:3001',
  observatoryToken: process.env.OBSERVATORY_TOKEN
});

const response = await client.chat.completions.create({
  model: 'kimi-k3',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### DeepInfra

```javascript
const { MonitoredDeepInfra } = require('@llm-observatory/sdk');

const client = new MonitoredDeepInfra({
  apiKey: process.env.DEEPINFRA_API_KEY,
  observatoryUrl: 'http://localhost:3001',
  observatoryToken: process.env.OBSERVATORY_TOKEN
});

const response = await client.chat.completions.create({
  model: 'deepseek-ai/DeepSeek-V4-Pro',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

DeepInfra model ids are the `org/Model` form and are case-sensitive.

### Constructor options

| Option | Required | Description |
|--------|----------|-------------|
| `apiKey` | Yes | Your provider API key (falls back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `XAI_API_KEY` / `MOONSHOT_API_KEY` env vars) |
| `observatoryUrl` | Yes | Base URL of your Observatory API (e.g. `http://localhost:3001`) |
| `observatoryToken` | Yes | `obs_sk_...` token created in Settings → Team → Observatory Tokens |

All other options are forwarded to the underlying provider SDK.

## Observatory token

Create a token in your Observatory dashboard:

**Settings → Team tab → Observatory Tokens → New token**

The full `obs_sk_...` value is shown **once** at creation. Store it as an environment variable in your application.

The token identifies which organization the metrics belong to. Each application/project can have its own token.

## Metrics recorded

Each API call records:

| Field | Description |
|-------|-------------|
| `model` | Model name |
| `provider` | `anthropic`, `openai`, `gemini`, `grok`, `kimi`, or `deepinfra` |
| `input_tokens` | Prompt tokens used |
| `output_tokens` | Completion tokens used |
| `cost_usd` | Estimated cost (USD) |
| `latency_ms` | End-to-end request latency |
| `status` | `success` or `error` |
| `prompt_preview` | First 200 chars of the user message |
| `api_key_hint` | Masked key (`sk-ant-…xxxx`) for credential linkage |

## Supported models

**Anthropic:** claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001, claude-3-5-sonnet-20241022, claude-3-5-haiku-20241022, claude-3-opus-20240229, claude-3-haiku-20240307

**OpenAI:** gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-4, gpt-3.5-turbo, gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, o1, o1-mini, o3, o3-mini

**Gemini:** gemini-3.1-pro-preview, gemini-3.5-flash, gemini-3-flash-preview, gemini-3.1-flash-lite, gemini-2.5-pro, gemini-2.5-flash

**Grok (xAI):** grok-4.6, grok-4.5, grok-4.3, grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning, grok-4.20-multi-agent-0309, grok-build-0.1

**Kimi (Moonshot AI):** kimi-k3, kimi-k2.6, kimi-k2.7-code, kimi-k2.7-code-highspeed

**DeepInfra:** a subset of popular models (DeepSeek V3/V3.1/V3.2/V4, Kimi K3/K2.7-Code, Qwen3-Max, Gemma 4, Llama 3.3 70B / 3.1 8B Turbo, Mistral Nemo, …) — DeepInfra hosts hundreds and reprices often, so a model missing from the table is recorded with `cost_usd = 0` and flagged `cost_confidence: 'unknown'`. If the API response reports its own cost it is used instead of the table.

Unknown models are tracked with `cost_usd = 0` and a warning is logged. Pricing tables use the standard (<200k context) tier where a provider charges more beyond that threshold — see `src/index.js` for the exact per-model rates.

## OpenAI extended support

`MonitoredOpenAI` also instruments:

- **Embeddings** — `client.embeddings.create()`
- **Transcription** — `client.audio.transcriptions.create()` (Whisper)
- **Text-to-speech** — `client.audio.speech.create()`

`MonitoredGrok`, `MonitoredKimi` and `MonitoredDeepInfra` only instrument `chat.completions.create()` (streaming and non-streaming).

## License

MIT
