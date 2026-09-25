## `packages/api`

**Entry point:** `src/index.js`

**Structure:**
```
src/
├── index.js            Express app, Socket.io setup, route registration, orphan cleanup
├── db/
│   ├── pool.js         PostgreSQL connection pool
│   ├── schema.sql      Table definitions + indexes + multi-tenancy backfill
│   ├── migrate.js      Runs schema.sql (also runs automatically on Docker container start)
│   ├── seed.js         600 demo records (org-scoped)
│   ├── seed-demo.js    Public showcase org + demo user + fake credentials (npm run seed:demo); exports seedDemo() — re-run weekly by cron in index.js (Mondays 05:00, only if org slug 'demo' exists)
│   └── crypto.js       AES-256-GCM encrypt/decrypt for API keys (v2: format); CBC legacy fallback for old values
├── middleware/
│   └── auth.js         JWT + Observatory token resolution; requireAdmin guard
├── constants/
│   └── providers.js    PROVIDERS / PROVIDER_CAPS / PROVIDER_LABELS / ADMIN_KEY_HELP — single source of truth for which providers exist and what each can do (adminKey/sync/reconcile/liveBalance/accountId). Replaced 8 places where the provider list had drifted (alert-rule dropdown offering a provider the API 400'd, balances.js dropping a provider's spend silently). Test capabilities via `providersWith('sync')` etc., never a hardcoded provider-name list.
├── routes/
│   ├── auth.js         Login, register (creates org), invite flow, password reset
│   ├── metrics.js      POST/GET metrics, summary, export, projection (org-scoped)
│   ├── budgets.js      Budget CRUD (org-scoped)
│   ├── balances.js     Provider balance tracking (org-scoped)
│   ├── credentials.js  API key storage + testing (org-scoped). PROVIDER_TESTERS is one tester per (provider, key_type) — a provider with no 'admin' entry (gemini, kimi, deepinfra) falls through to a real 400 instead of silently validating an admin key against the plain models endpoint. PATCH /:id edits only the non-secret fields (label, provider_account_id) without touching the key itself.
│   ├── providers.js    GET / — the capability matrix (constants/providers.js) the web builds its provider pickers from. Static, no org scoping, no DB hit.
│   ├── alerts.js       Alert rules + Discord webhooks (org-scoped)
│   ├── sync.js         Historical data sync from provider APIs (org-scoped), dispatched per-provider via services/providerRegistry.js's SYNC_PROVIDERS. importBuckets is GAP-BASED + idempotent: one txn drops the window's sync:<provider> rows, then per (provider,model,UTC-day) inserts one row for bucket_cost − SUM(live rows) only when > 0. Prevents the double-count when an org runs both the SDK and sync. `clampDayTotal` (Grok only) rescales a day's gaps proportionally when the provider's free-text usage categories can't be matched 1:1 against the SDK's own model ids, so a mismatch can't double-count the day.
│   ├── tokens.js       Observatory token CRUD (create/list/revoke)
│   ├── team.js         Team member management + email invitations
│   ├── webhooks.js     Outbound webhook endpoints CRUD + test delivery
│   ├── insights.js     GET /summary (computed insights) + POST /dismiss (org-scoped)
│   ├── notifications.js GET / (merged alert_history + reconciliation_runs + invitations) + POST /read-all
│   └── evaluations.js  Quality scores per api_calls row — human (any member) or LLM-as-judge (admin-only, POST /judge)
├── services/
│   ├── email.js        Resend integration: activation, password reset, invitations
│   ├── webhooks.js     deliverWebhooks() — HMAC-SHA256 signed POST, fire-and-forget
│   ├── insights.js     computeInsights() — rule-based detectors over api_calls, stateless (no cron, no snapshot table)
│   ├── pricingBridge.js costForProviderUsage / splitRecordedCost / isKnownModel / canonicalModelId — the ONLY place packages/api turns tokens into a $ estimate. Wraps @llm-observatory/sdk's calculate* fns + *_PRICING tables + normalizeModelId; adds only the provider→fn dispatch and the Anthropic cache-write 1.25× surcharge. `splitRecordedCost(provider, model, {inputTokens, outputTokens, recordedCost})` reconciles a modelled input/output split against an already-recorded cost for the /models breakdown chart: the parts ALWAYS sum to `recordedCost` — a positive residual (sync-imported rows, models with no rate, the cache-write surcharge) comes back as `unattributedCost`, a negative one scales input/output down and flags `approx`. Used by providerUsage.js and metrics.js.
│   ├── providerUsage.js fetch{Anthropic,OpenAI}{Usage,RealCost} + summarizeBuckets (prices via pricingBridge, counts cache_creation tokens); fetch{Grok}{Usage,RealCost,PrepaidBalance} + validateGrokManagementKey against xAI's Management API (`management-api.x.ai`, NOT `api.x.ai` — that 404s). xAI gotchas verified against a live account: amounts are in CENTS and prepaid credit is a NEGATIVE number; usage is grouped by free-text `description` (`groupBy: 'model'` 400s), parsed by `parseGrokUsageGroup()`; there is no independent token-level source, so usage and billed cost come from the exact same call (no fallback registered for Grok in providerRegistry.js). No local pricing table anymore.
│   ├── providerRegistry.js Maps constants/providers.js's capabilities to the functions that implement them (PROVIDER_BILLING for reconciliation, SYNC_PROVIDERS for sync), replacing the `provider === 'anthropic' ? … : fetchOpenAI…` ternaries that had grown dangerous as providers were added — with 5 providers the `else` branch silently meant "OpenAI", so a Grok/Gemini/Kimi admin key was sent to api.openai.com. Adding a provider's billing here is one entry; gemini/kimi/deepinfra are absent on purpose (no org-level billing API to call).
│   ├── coverage.js     `computeCoverage(orgId, req.dateRange)` → `GET /api/metrics/coverage`. `assessCoverage()` is the pure decision logic (no DB): for the picked window, is it before the first record / older than retention / past a provider's last successful sync, and can a sync fill it (`can_sync`, `suggested_sync`). Read-only — never triggers a sync. "Before first record" only sets `needs_attention` for custom windows or when an admin key could backfill it (so presets don't nag a new org); a provider that never synced is never reported as a gap. Ping (`test:%`) and judge rows don't count as data.
│   ├── syncWindow.js   `resolveSyncWindow({start,end,days})` → the [startDate,endDate] handed to the provider fetchers. start/end (same syntax as the date filter) OR `days` (default 30, must be a positive integer). Start floored to UTC midnight (a mid-day start left the first day's previous import outside the delete window → duplicate on same-day re-sync), end capped at now, days older than retention trimmed with a warning (entirely older = 400).
│   └── llmJudge.js     judgeApiCall(provider, apiKey, {promptText, responseText}) — scores one request via a second LLM call. Covers all 6 providers via 3 request shapes (Anthropic /v1/messages; OpenAI-shaped /v1/chat/completions for openai/grok/kimi/deepinfra; Gemini generateContent). Keeps its own 5-line JUDGE_MODEL table on purpose (one model per provider, not a full surface) — not folded into pricingBridge.
├── utils/
│   ├── retention.js    `retentionDays()` (DATA_RETENTION_DAYS, default 90, NaN-safe) shared by the nightly purge in index.js and the sync/coverage code; `retentionCutoffMs()` = earliest UTC midnight a synced day can be stamped at and survive the purge.
│   └── dateRange.js    `parseRange(query, {defaultRange, allowAll})` is the ONE parser for `?range=&start=&end=`, exposed as `rangeMiddleware()` → `req.dateRange` (`{range, custom, start, end, spanMs, interval, dblInterval}`); metrics.js applies it router-wide (GET only), balances.js per-route with `allowAll`. Invalid input is a **400** (bad/impossible date, datetime without a timezone, only one of start/end, start>end, span > 366d, `range=custom` without dates, unknown preset) — never a 500 or a silent 7d. Bare `YYYY-MM-DD` = a UTC day (`end` inclusive to 23:59:59.999Z); `spanMs = end-start+1ms`. `appendTimeWindow(params, req.dateRange, column)` builds the WHERE fragment for the range-only endpoints; `/summary` has its own inline version for the previous-period window. `getRangeIntervals(range)` still backs services/insights.js.
└── jobs/
    └── alertChecker.js Hourly cron: check spend per org → Discord alerts
```

**Database tables:**

Multi-tenancy tables (new):
- `organizations` — Tenant orgs. Columns: `id`, `name`, `slug` (unique), `created_at`
- `org_members` — User ↔ org membership with role. Columns: `org_id`, `user_id`, `role` (`admin`|`member`), `joined_at`
- `invitations` — Email invitations with 7-day expiry tokens. Columns: `org_id`, `email`, `token`, `invited_by`, `expires_at`, `accepted_at`
- `observatory_tokens` — SDK auth tokens (hash stored, never plaintext). Columns: `org_id`, `name`, `token_hash`, `token_prefix`, `created_by`, `last_used_at`, `revoked_at`

Tenant-scoped tables (existing, all have `org_id`):
- `api_calls` — All metric records. Key columns: `org_id`, `api_key_hint` (links to credential), `prompt_preview` (`sync:provider` for sync imports, `test:sdk_integration` for ping tests, `eval:judge` for LLM-judge calls), `cost_confidence` (`known`|`unknown` — on ingest, any `status_code >= 400` call has `cost_usd` forced to 0 and, unless the client asserted `known`, is marked `unknown`; a failed call is never billed; see `POST /` in `routes/metrics.js`), `likely_retry_of` (self-FK, `ON DELETE SET NULL` — set at ingest when the same org/provider/model/prompt_preview/api_key_hint landed within a 5-minute window, i.e. the client's own SDK probably retried and re-billed the same call; heuristic, surfaced in UI only, never auto-adjusts cost). Partial index `idx_api_calls_live_rollup (org_id, provider, model, timestamp) WHERE prompt_preview IS NULL OR NOT LIKE 'sync:%'/'test:%' AND <> 'eval:judge'` backs sync.js's gap rollup.
- `budgets` — Spending limits (daily/weekly/monthly), `org_id`
- `provider_balances` — Balance recharge tracking, `org_id`
- `provider_credentials` — Encrypted API keys (`key_type`: `sdk` | `admin`), `org_id`. `provider_account_id` — provider-side account/team id some billing APIs require in the path (only xAI today: the Management API's teamId, not discoverable through the API itself). Stored in **plaintext** on purpose — it's not a secret (sits in the console URL) and the Keys page needs to show it back for editing; don't wrap it in `encrypt()`.
- `alert_rules` — Discord alert configs with thresholds, `org_id`. `threshold_pct` — deviation-percent threshold, only meaningful for `metric = 'reconciliation_deviation'` (falls back to `DEFAULT_DEVIATION_THRESHOLD_PCT` in `jobs/reconciliation.js` if unset).
- `alert_history` — Alert audit log, `org_id`
- `sync_logs` — Data sync history, `org_id`
- `webhook_endpoints` — Outbound webhook URLs with HMAC secret. Columns: `org_id`, `name`, `url`, `secret` (plaintext, not hashed), `events` (TEXT[] default `{metric.created}`), `is_active`. Secret shown once on creation, never again. Partial index on `(org_id) WHERE is_active = true`.
- `insight_dismissals` — Which auto-computed insight (`insight_key`, e.g. `cost_spike:openai:gpt-4o`) an org muted and until when. Columns: `org_id`, `insight_key`, `dismissed_until`, `dismissed_by`. Unique on `(org_id, insight_key)` — "Silenciar 24h" upserts this row. Insights themselves are never persisted; `services/insights.js`'s `computeInsights()` recomputes them from `api_calls` on every `GET /api/insights/summary` call (4 rule-based detectors: cost spike, error rate breach, latency regression per model, and an org-level cost-per-request improvement — thresholds documented as constants at the top of the file).
- `notification_reads` — One row per user: `last_read_at` watermark for the in-app notification bell. Columns: `user_id` (PK), `last_read_at` (default `-infinity`, so everything is unread before the first "mark all read"). Notifications are never stored — `GET /api/notifications` assembles them live from `alert_history`, `reconciliation_runs` (`status IN ('alert','error')`), and `invitations.accepted_at`, all of which already have real timestamps.
- `evaluations` — Quality score per `api_calls` row. Columns: `org_id`, `api_call_id` (FK, `ON DELETE CASCADE`), `name` (default `'quality'` — a named-metric slot for future scores like `'toxicity'`, unused otherwise), `method` (`human`|`llm_judge`), `score` (0-100 `DECIMAL`), `reasoning`, `evaluator_model` (NULL for `human`), `created_by` (NULL for `llm_judge`). LLM-judge scoring is **on-demand only** (`POST /api/evaluations/judge`, admin-only) — never automatic on ingest, so it can't silently double an org's LLM spend. The judge call itself is billable, so the route also inserts a normal `api_calls` row for it (`prompt_preview = 'eval:judge'`) via `services/llmJudge.js` — judge spend shows up on the dashboard like any other call. Judge picks whichever `key_type='sdk'` credential matches the original call's provider, falling back to any configured sdk credential; returns 400 if none exists or if the target call has no `response_full` captured.
- `reconciliation_runs` — Daily comparison of client-reported `cost_usd` against the provider's real billed-dollar total (OpenAI `GET /v1/organization/costs`, Anthropic `GET /v1/organizations/cost_report`, xAI `POST .../usage` summed — genuine ground truth, all dispatched through `services/providerRegistry.js`'s `billingFor(provider)`). Falls back to a token-usage-based estimate (`fetch{OpenAI,Anthropic}Usage` + `summarizeBuckets`, priced via `services/pricingBridge`) if the real Costs API call fails and the provider has an independent usage source — `source` column records which one produced the row (`provider_costs_api` | `token_estimate_fallback`); **Grok has no fallback** (its usage and billed-cost figures come from the same call), so a Grok failure is an honest `error` row, not a guessed number. Other columns: `org_id`, `provider`, `period_start/end`, `provider_computed_usd`, `client_reported_usd`, `deviation_pct`, `status` (`ok`|`alert`|`error`). Populated by the `runReconciliation()` cron (`jobs/reconciliation.js`, daily at 03:30) for every `(org, provider)` with an admin credential configured **and** `provider_registry.reconcilableProviders()` support (gemini/kimi/deepinfra are filtered out in SQL, never fetched at all) — a provider that needs `provider_account_id` but doesn't have one yet is skipped with a warning, not written as an `error` row (unfinished setup ≠ failure). Read via `GET /api/reconciliation` and `GET /api/reconciliation/latest`. **Anthropic gotcha:** `cost_report`'s `amount` field is a decimal string in cents despite looking like dollars (their own docs example: `"123.45"` → `$1.23`) — must divide by 100; OpenAI's `amount.value` is already a plain USD float, no conversion. **xAI gotcha:** same cents issue, and prepaid credit is a *negative* number in their ledger — see `services/providerUsage.js`'s module comment before touching the sign.

Auth tables:
- `users` — Accounts with bcrypt passwords. Columns: `email`, `password_hash`, `is_active`, `activation_token`, `reset_token`, `reset_token_expires`
- `revoked_tokens` — JWT JTI blacklist for server-side logout. Columns: `jti` (PK), `exp`. Cleaned every 15 min by cron.

**Auth middleware (`middleware/auth.js`):**
- Public paths: `GET /health`, `POST /api/auth/login`, `POST /api/auth/register`, `GET /api/auth/activate`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`, `GET /api/auth/invite-info`, `POST /api/auth/accept-invite`
- `POST /api/metrics`: requires `Authorization: Bearer obs_sk_xxx` (Observatory token)
- All other routes: require `Authorization: Bearer <jwt>`
- Observatory token path: SHA-256 hash lookup → sets `req.user = { orgId, isObservatoryToken: true }`
- JWT path: verifies signature → checks `revoked_tokens` table by `jti` → sets `req.user = { id, email, orgId, role, jti, exp }`
- `requireAdmin`: blocks observatory tokens; requires `req.user.role === 'admin'`
- `POST /api/auth/logout`: inserts `jti` into `revoked_tokens` — token rejected on all subsequent requests

**Registration & password reset flow (changed 2026-06-28):**
- Registration **auto-activates** accounts (`is_active = true` on INSERT) — no activation email is sent and login does NOT check `is_active`. `GET /api/auth/activate` still exists but is legacy.
- Duplicate email on register always returns 409, even if the existing account is inactive (prevents account takeover via re-registration).
- Password reset is **support-mediated**: `sendPasswordResetEmail()` sends the reset link to `SUPPORT_EMAIL` (fallback `EMAIL_FROM`), not to the user — support forwards it manually. Reason: Resend cannot email arbitrary addresses without a verified custom domain.

**Rate limiting (`src/index.js`):** `express-rate-limit`, two limiters, both **1000 req/min** — `generalLimiter` (all routes) and `metricsLimiter` (`POST /api/metrics`). Was 300; raised because the dashboard's parallel fetches hit the limit.

**Data integrity — cascade delete:** `DELETE /api/credentials/:id` automatically deletes all `api_calls` where `api_key_hint = key_hint`. Admin key deletions also remove `sync:provider` records. All constrained by `org_id`.

**Orphan cleanup on startup:** Deletes `test:sdk_integration` records for providers with no credentials (scoped to org), and `sync:*` records for providers with no admin key.

**Time series logic:** buckets are UTC (`date_trunc(unit, ts, 'UTC')`; `db/pool.js` also pins the session to UTC). Hourly for `24h` and for a custom window of ≤ 24h, daily otherwise. A custom window's previous period is `[start - spanMs, start)` (exclusive at the top so a boundary row isn't counted twice); `prev_time_series` is now populated for custom ranges too (shifted forward by `spanMs`).

**Alert debounce:** `debounce_hours` per rule (default 6h) to prevent spam. Checker groups by `${org_id}:${metric}`.

**Encryption format:** `v2:iv_hex:ciphertext_hex:tag_hex` (AES-256-GCM, 12-byte IV, 16-byte auth tag). Legacy CBC format `iv_hex:ciphertext_hex` still decrypts transparently — new writes always use GCM. No ENCRYPTION_KEY rotation needed.

**org_id in queries:** Every route uses `req.user.orgId` as the first param (`$1`) in all SQL queries. Dynamic filter params start at `$2` onwards.

## API Routes Reference

### Auth (public)
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/auth/login` | POST | Public | Login → JWT |
| `/api/auth/register` | POST | Public | Register user + create org atomically (account queda activa de inmediato) |
| `/api/auth/me` | GET | JWT | Current session info |
| `/api/auth/activate` | GET | Public | Legacy — activation email ya no se envía en el registro |
| `/api/auth/forgot-password` | POST | Public | Request password reset (link se envía a `SUPPORT_EMAIL`, no al usuario) |
| `/api/auth/reset-password` | POST | Public | Reset password with token |
| `/api/auth/invite-info` | GET | Public | Get invite details (`?token=`) |
| `/api/auth/accept-invite` | POST | Public | Accept invite, create/login account |

### Observatory tokens
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/tokens` | GET | JWT | List org's Observatory tokens |
| `/api/tokens` | POST | JWT | Create token (returns full `obs_sk_` once) |
| `/api/tokens/:id` | DELETE | JWT | Revoke token |

### Team management
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/team/members` | GET | JWT | List org members |
| `/api/team/members/:userId` | DELETE | JWT (admin) | Remove member |
| `/api/team/invitations` | GET | JWT | List pending invitations |
| `/api/team/invite` | POST | JWT (admin) | Send email invitation |
| `/api/team/invitations/:id` | DELETE | JWT (admin) | Cancel invitation |

### Metrics & data
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/metrics` | POST | Observatory token | Record metric from SDK |
| `/api/metrics` | GET | JWT | List (paginated + filtered) |
| `/api/metrics/summary` | GET | JWT | Aggregated stats + time series. `by_model` rows carry the token split (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `error_count`) plus the cost split added by `enrichByModel` (`input_cost`, `output_cost`, `unattributed_cost`, `cost_split_priced`, `cost_split_approx`) — the three costs always sum to `total_cost` |
| `/api/metrics/projection` | GET | JWT | Monthly spend projection |
| `/api/metrics/export` | GET | JWT | CSV download |
| `/api/metrics/coverage` | GET | JWT | Coverage assessment for the picked window (`?range=` or `?start=&end=`): `needs_attention`, `before_first_data`, `beyond_retention`, `sync_gaps[]`, `can_sync`, `suggested_sync {start,end}`, `retention_days`. Read-only |
| `/api/metrics/tag-keys` | GET | JWT | Distinct tag keys used in range (`?range=` or `?start=&end=`) |
| `/api/metrics/tag-values` | GET | JWT | Distinct values for `?key=` in range |
| `/api/metrics/tag-breakdown` | GET | JWT | Cost/requests grouped by tag value in range |
| `/api/metrics/project-breakdown` | GET | JWT | Cost/requests grouped by Observatory token name in range |
| `/api/metrics/:id` | GET | JWT | Single metric detail |

### Webhooks (outbound delivery)
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/webhooks` | GET | JWT | List org's webhook endpoints (secret shown as `…xxxx` hint) |
| `/api/webhooks` | POST | JWT | Create endpoint — returns secret once in full |
| `/api/webhooks/:id` | DELETE | JWT | Delete endpoint |
| `/api/webhooks/:id/test` | POST | JWT | Send test payload (`webhook.test` event) |

**Webhook delivery:** After every `POST /api/metrics` insert, `deliverWebhooks(orgId, 'metric.created', row)` fires for all active endpoints of the org. Each POST includes headers:
- `X-Observatory-Signature: sha256=<hmac-hex>` — HMAC-SHA256 of the full JSON body using the endpoint secret
- `X-Observatory-Event: metric.created`

Delivery is fire-and-forget with 1 retry after 1s. Failures are silent (metric already saved).

### Insights (auto-computed, org-scoped)
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/insights/summary` | GET | JWT | Computed insights for `?range=` (24h\|7d\|30d\|90d), excluding muted ones |
| `/api/insights/dismiss` | POST | JWT | Mute an `insight_key` for `hours` (default 24, max 168) |

### Evaluations (quality scores, org-scoped)
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/evaluations` | GET | JWT | List evaluations for `?api_call_id=` |
| `/api/evaluations` | POST | JWT (not observatory token) | Submit a human score (0-100) |
| `/api/evaluations/judge` | POST | JWT (admin) | Score via LLM-as-judge — billable, inserts a matching `api_calls` row too |

### Notifications (auto-assembled, user-scoped read state)
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/notifications` | GET | JWT | Last 20 events (budget alerts, reconciliation deviations, team joins), with `read` flag per the caller's `notification_reads` watermark |
| `/api/notifications/read-all` | POST | JWT | Sets `last_read_at = NOW()` for the caller |

### Other resources (all JWT, all org-scoped)
| Route | Method | Description |
|-------|--------|-------------|
| `/api/budgets` | GET/POST | List/create budgets |
| `/api/budgets/:id` | DELETE | Delete budget |
| `/api/balances` | GET/POST | Balance tracking |
| `/api/balances/:id` | DELETE | Remove balance record |
| `/api/credentials` | GET/POST | Credential management |
| `/api/credentials/:id` | PATCH | Edit non-secret fields (`label`, `provider_account_id`) — resets `is_valid`/`last_tested_at` to untested |
| `/api/credentials/:id/test` | POST | Validate key against provider API |
| `/api/credentials/:id/ping` | POST | Idempotent SDK test metric (replaces previous) |
| `/api/credentials/:id` | DELETE | Remove credential + cascade delete its api_calls |
| `/api/credentials/openai/balance` | GET | Fetch OpenAI usage |
| `/api/providers` | GET | Provider capability matrix (`constants/providers.js`) — no org scoping |
| `/api/alerts/rules` | GET/POST | Alert rule management |
| `/api/alerts/rules/:id` | PUT/DELETE | Update/delete rule |
| `/api/alerts/history` | GET | Alert audit log |
| `/api/alerts/rules/:id/test` | POST | Send test Discord alert |
| `/api/sync/:provider` | POST | Start historical sync (requires admin key). Window: `?start=&end=` (or in the JSON body; bare `YYYY-MM-DD` = UTC day) OR `?days=N`; 400 on bad input. Response echoes `window`, `clamped`, `warning` (data older than retention is trimmed, not imported-then-purged) |
| `/api/sync/:provider/data` | DELETE | Delete ALL api_calls for provider |
| `/api/sync/logs` | GET | Sync history |
| `/api/sync/status` | GET | Latest sync status |
| `/health` | GET | Health check (public) |

**Query params for GET /api/metrics:** `page`, `limit`, `range` (24h|7d|30d|60d|90d|custom), `sortBy`, `sortDir`, `model`, `provider`, `start`, `end`. `start`/`end` (both required together; ISO datetime **with a timezone**, or a bare `YYYY-MM-DD` UTC day) always override `range` — this is the convention every range-aware endpoint follows (`/summary`, `/export`, `tag-keys`, `tag-values`, `tag-breakdown`, `project-breakdown`, `/api/balances`), so a frontend custom date-range picker only ever needs to add `start`/`end` to the existing query string, never a special `range` value of its own (the web sends `range=custom` alongside them by convention; `range=custom` WITHOUT dates is a 400). `/api/balances` `remaining`/`pct_used` use lifetime spend so they don't move with the filter; only `total_spent` follows the range. The picker's UI only offers 24h/7d/30d + a custom popover — `60d`/`90d` remain valid values for direct API callers (e.g. `/api/insights/summary`) but no longer have a button.
