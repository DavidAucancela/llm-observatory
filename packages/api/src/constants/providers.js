// Single source of truth for "which providers exist and what can each one do".
//
// Before this file the same list lived literally in eight places (the Zod enums
// of credentials/balances/alerts/metrics, both CROSS JOIN (VALUES …) lists in
// GET /summary, and the sync whitelist), and they had already drifted into real
// bugs: the web's alert-rule dropdown offers Grok while alerts.js rejects it
// with a 400, and balances.js silently filtered Grok's spend out of its own
// response. Anything that needs to branch on a provider reads from here.
//
// Capabilities, not provider names, are what callers should test against —
// `providersWith('sync')` keeps working when the sixth provider lands.
//
//   adminKey    — the provider has an org-level key distinct from the SDK key.
//   sync        — historical usage can be imported (routes/sync.js).
//   reconcile   — a real billed-dollar figure can be fetched for the daily
//                 recorded-vs-billed cron (jobs/reconciliation.js).
//   liveBalance — a credit/prepaid balance can be read on demand.
//   accountId   — 'required' when the provider's billing API needs an account
//                 or team identifier in the path that the key itself does not
//                 carry, stored as provider_credentials.provider_account_id.
//                 Only xAI needs this today: its Management API routes are
//                 /v1/billing/teams/{teamId}/… and the teamId is not
//                 discoverable through the API — it is copied from the console.

const PROVIDER_CAPS = {
  anthropic: { adminKey: true,  sync: true,  reconcile: true,  liveBalance: false, accountId: 'none' },
  openai:    { adminKey: true,  sync: true,  reconcile: true,  liveBalance: false, accountId: 'none' },
  gemini:    { adminKey: false, sync: false, reconcile: false, liveBalance: false, accountId: 'none' },
  grok:      { adminKey: true,  sync: true,  reconcile: true,  liveBalance: true,  accountId: 'required' },
  kimi:      { adminKey: false, sync: false, reconcile: false, liveBalance: false, accountId: 'none' },
};

// Ordered: anthropic and openai first because every "which provider?" dropdown
// in the UI reads this order, and those two are the ones most orgs configure.
const PROVIDERS = Object.keys(PROVIDER_CAPS);

const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  openai:    'OpenAI',
  gemini:    'Gemini',
  grok:      'Grok',
  kimi:      'Kimi',
};

// Where an admin/org-level key comes from. Surfaced verbatim in the 400 that
// POST /api/sync/:provider returns when the key is missing, so the message is
// actionable instead of "credential not found".
const ADMIN_KEY_HELP = {
  anthropic: 'Consola de Anthropic → Settings → Admin Keys (clave sk-ant-admin-…)',
  openai:    'Plataforma de OpenAI → Settings → API keys → Admin key (clave sk-admin-…)',
  grok:      'Consola de xAI → Settings → Management Keys, y el Team ID en Settings → Team',
};

function providersWith(cap) {
  return PROVIDERS.filter(p => PROVIDER_CAPS[p][cap] === true);
}

function requiresAccountId(provider) {
  return PROVIDER_CAPS[provider]?.accountId === 'required';
}

function isKnownProvider(provider) {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CAPS, provider);
}

module.exports = {
  PROVIDERS,
  PROVIDER_CAPS,
  PROVIDER_LABELS,
  ADMIN_KEY_HELP,
  providersWith,
  requiresAccountId,
  isKnownProvider,
};
