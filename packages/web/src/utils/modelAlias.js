// Best-effort shortener for raw model IDs (e.g. "claude-3-5-sonnet-20241022"
// -> "sonnet-3.5") so they fit in the compact spaces of the dashboard's
// legend and "Modelos principales" list without CSS ellipsis eating the
// meaningful part of the name. Not a full parser — unmatched/unknown model
// IDs pass through unchanged, degrading safely for future model names.
const ALIAS_RULES = [
  // Anthropic: claude-{family}-{version}-YYYYMMDD -> {family}-{version}
  [/^claude-3-5-sonnet(-.*)?$/i, 'sonnet-3.5'],
  [/^claude-3-5-haiku(-.*)?$/i, 'haiku-3.5'],
  [/^claude-3-opus(-.*)?$/i, 'opus-3'],
  [/^claude-3-sonnet(-.*)?$/i, 'sonnet-3'],
  [/^claude-3-haiku(-.*)?$/i, 'haiku-3'],
  // Newer families, generalised so a new minor/major needs no edit here. The
  // minor-version rule MUST come first: the old per-major rules folded every
  // 4.x into "opus-4"/"sonnet-4"/"haiku-4", so claude-opus-4-8, -4-7 and -4-6
  // were indistinguishable in the legend and the "top models" list.
  [/^claude-(opus|sonnet|haiku)-(\d+)-(\d{1,2})(?:-\d{8})?$/i, '$1-$2.$3'],   // claude-opus-4-8, claude-haiku-4-5-20251001
  [/^claude-(opus|sonnet|haiku)-(\d+)(?:-\d{8})?$/i, '$1-$2'],                // claude-sonnet-5, claude-sonnet-4-20250514
  [/^claude-(fable|mythos)-(\d+)(?:-.*)?$/i, '$1-$2'],                          // claude-fable-5, claude-mythos-5
  // OpenAI
  [/^gpt-4o-mini(-.*)?$/i, 'gpt-4o-mini'],
  [/^gpt-4o(-.*)?$/i, 'gpt-4o'],
  [/^gpt-4-turbo(-.*)?$/i, 'gpt-4-turbo'],
  [/^gpt-4(-.*)?$/i, 'gpt-4'],
  [/^gpt-3\.5-turbo(-.*)?$/i, 'gpt-3.5-turbo'],
  [/^o1-mini(-.*)?$/i, 'o1-mini'],
  [/^o1(-.*)?$/i, 'o1'],
  [/^o3-mini(-.*)?$/i, 'o3-mini'],
  [/^o3(-.*)?$/i, 'o3'],
  // The bare "-latest" suffix is stripped below, which would leave just "chat".
  [/^chat-latest$/i, 'chat-latest'],
  // Gemini
  [/^gemini-3\.1-pro-preview(-.*)?$/i, 'gemini-3.1-pro'],
  [/^gemini-3\.5-flash(-.*)?$/i, 'gemini-3.5-flash'],
  [/^gemini-3-flash-preview(-.*)?$/i, 'gemini-3-flash'],
  [/^gemini-3\.1-flash-lite(-.*)?$/i, 'gemini-3.1-flash-lite'],
  [/^gemini-2\.5-pro(-.*)?$/i, 'gemini-2.5-pro'],
  [/^gemini-2\.5-flash(-.*)?$/i, 'gemini-2.5-flash'],
  // Grok / Kimi
  // xAI dated builds: drop the MMDD build stamp but keep the variant, so the
  // reasoning / non-reasoning / multi-agent 4.20 models stay distinguishable.
  [/^(grok-[\d.]+)-\d{4}-(.+)$/i, '$1-$2'],     // grok-4.20-0309-non-reasoning
  [/^(grok-[\d.]+-.+)-\d{4}$/i, '$1'],          // grok-4.20-multi-agent-0309
  [/^grok-2(-.*)?$/i, 'grok-2'],
  [/^grok-3(-.*)?$/i, 'grok-3'],
  [/^kimi-k2(-.*)?$/i, 'kimi-k2'],
  [/^moonshot-v1(-.*)?$/i, 'moonshot-v1'],
  // DeepInfra / open-weight ids (org prefix already stripped)
  [/^(?:Meta-)?Llama-([\d.]+)-(\d+B)-Instruct(?:-Turbo)?$/i, 'Llama-$1-$2'],
];

// Catch-all: strip a trailing date/build suffix (-YYYYMMDD, -latest,
// -preview, -20240620 etc.) when no specific rule above matched.
const TRAILING_SUFFIX_RE = /-(?:\d{6,8}|latest|preview)$/i;

export function shortModelName(model) {
  if (!model) return model;
  // DeepInfra (and other hosts) namespace ids as `org/Model`; the org is noise in
  // a compact label ("deepseek-ai/DeepSeek-V4-Pro" -> "DeepSeek-V4-Pro").
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  if (!bare) return model;
  for (const [pattern, alias] of ALIAS_RULES) {
    // Every pattern is anchored ^…$, so replace() on a match yields the alias
    // (with $1/$2 capture groups substituted where the rule uses them).
    if (pattern.test(bare)) return bare.replace(pattern, alias);
  }
  const stripped = bare.replace(TRAILING_SUFFIX_RE, '');
  return stripped || bare;
}
