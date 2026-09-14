# CLAUDE.md — LLM Observatory

## Project Overview

**LLM Observatory** is a multi-tenant SaaS observability platform for monitoring Claude API (and OpenAI) usage in real-time. It provides cost tracking, latency monitoring, token analysis, budget alerts, Discord notifications, team management, outbound webhooks, and data export with a WebSocket-driven dashboard.

**Monorepo with 4 packages:**
- `packages/sdk` — Drop-in Node.js wrapper for Anthropic/OpenAI SDKs
- `packages/sdk-python` — Drop-in Python wrapper for Anthropic/OpenAI SDKs
- `packages/api` — Express + PostgreSQL backend with Socket.io
- `packages/web` — React + Vite + Tailwind frontend dashboard

---

## Architecture

```
User Application
  └─► MonitoredAnthropic / MonitoredOpenAI  (SDK — Node.js or Python)
      │   Authorization: Bearer obs_sk_xxx   ← Observatory token (org identity)
      ├─► Claude / OpenAI API               (real request, awaited)
      └─► Observatory API                   (async metric POST, fire & forget)
          ├─► org_id resolution             (token hash → org)
          ├─► PostgreSQL                    (persists metrics, scoped by org_id)
          ├─► Socket.io                     (broadcasts to clients)
          ├─► React Dashboard               (WebSocket real-time updates)
          └─► Outbound Webhooks             (HMAC-signed POST to customer URLs, fire & forget)
```

**Key principles:**
- SDK sends metrics asynchronously — zero latency overhead on user API calls.
- Every metric is attributed to an organization via Observatory token (`obs_sk_`).
- All DB queries are scoped by `org_id` — tenants never see each other's data.

---

## Development Commands

```bash
# Root (runs api + web concurrently)
npm install
npm run dev
npm run seed      # Populate 600 demo records

# API only
cd packages/api
npm run dev       # nodemon
npm run migrate   # Run schema.sql
npm run seed
npm run seed:demo # Public showcase org: demo@llm-observatory.com / Demo1234! + fake credentials

# Web only
cd packages/web
npm run dev       # Vite dev server on port 5173
npm run build

# Tests
npm test          # Runs tests in all workspaces
```

**Ports:**
- Web dev server: `5173` (proxies `/api` and `/socket.io` to API)
- API server: `3001`
- PostgreSQL: `5432`

---

## Environment Variables

File: `.env` (copy from `.env.example`)

```bash
POSTGRES_USER=postgres
POSTGRES_PASSWORD=changeme
POSTGRES_DB=llm_observatory
DATABASE_URL=postgresql://postgres:changeme@localhost:5432/llm_observatory
PORT=3001
NODE_ENV=development
ENCRYPTION_KEY=<32-byte hex>   # For AES-256-GCM encryption of stored API keys
JWT_SECRET=<64-byte hex>       # For signing JWTs
JWT_EXPIRES_IN=1h              # JWT expiry (default 1h); change to e.g. 8h if needed
```

Frontend build-time:
```bash
VITE_API_URL=http://localhost:3001   # Empty string for Docker (nginx proxy handles it)
```

Email (Resend) y URLs públicas:
```bash
RESEND_API_KEY=<resend api key>
EMAIL_FROM=onboarding@resend.dev   # Use Resend's own domain until custom domain verified
APP_URL=http://localhost:5173      # URL pública del frontend — usada en links de email
SUPPORT_EMAIL=<support inbox>      # Recibe los emails de password reset (fallback: EMAIL_FROM)
```

Docker/Railway internal networking:
```bash
API_INTERNAL_URL=http://api.railway.internal:3001
```

---

## Package Details

Per-package conventions live in each package's own `CLAUDE.md`, loaded only when working there:
- `packages/sdk/CLAUDE.md`
- `packages/sdk-python/CLAUDE.md`
- `packages/api/CLAUDE.md` (also has the full API Routes Reference)
- `packages/web/CLAUDE.md`

---

## Docker Setup

```bash
docker-compose up -d --build
# API at http://localhost:3001
# Web at http://localhost:80
```

Services: `postgres:16`, `api` (Node 20 Alpine), `web` (Nginx with multi-stage build).

**Auto-migrate on start:** The API Dockerfile CMD runs `node src/db/migrate.js && node src/index.js` — schema migrations run automatically on every container start. All DDL uses `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT EXISTS` so it is idempotent.

The web Dockerfile uses `entrypoint.sh` for runtime environment variable substitution in nginx config. `entrypoint.sh` also reads the DNS resolver from `/etc/resolv.conf` at container start and injects it as `${RESOLVER}` into the nginx template — this allows nginx to re-resolve `api.railway.internal` dynamically on each request (IPv6 nameservers are wrapped in `[brackets]` automatically).

---

## Deploy to Railway

See the `deploy-railway` skill (`.claude/skills/deploy-railway/SKILL.md`) for the full steps and the `API_INTERNAL_URL` gotcha.

---

## Important Patterns & Conventions

- **Fire-and-forget metrics:** SDK never awaits metric POSTs. Always keep it that way to preserve zero-latency guarantee.
- **Observatory token required:** `POST /api/metrics` requires `Authorization: Bearer obs_sk_xxx`. Without it the request is rejected. Create tokens in the sidebar's Claves (`/keys`) page.
- **org_id first param:** In every route handler, `const orgId = req.user.orgId` is the first value pushed to the params array (`$1`). All other dynamic filters start at `$2`. Never skip this or data leaks across tenants.
- **SQL parameterization:** All DB queries use `$1, $2, ...` params. Never interpolate user input into SQL strings.
- **Zod validation:** All POST body inputs validated with Zod schemas in route files.
- **Async DB ops:** All database operations use async/await with the pg pool.
- **Socket.io broadcast:** After inserting a metric, always `io.emit('new-metric', metric)` so dashboards update in real-time.
- **Webhook delivery after metric insert:** After the socket.io emit, always call `deliverWebhooks(req.user.orgId, 'metric.created', row).catch(() => {})`. Never await it. Import from `../services/webhooks`.
- **Webhook secret:** Generated server-side as `crypto.randomBytes(32).toString('hex')`. Stored in plaintext in `webhook_endpoints.secret` (unlike observatory tokens which store only the hash). Shown once on creation, never returned again by the API.
- **Webhook signature verification (receiver side):** `HMAC-SHA256(secret, JSON.stringify(payload))` — compare against `X-Observatory-Signature` header after stripping `sha256=` prefix.
- **Time zone:** All timestamps stored as `TIMESTAMPTZ`. Always use timezone-aware comparisons.
- **Cost precision:** Use `DECIMAL(10,6)` for costs. Don't round until display layer.
- **Provider capabilities go through `packages/api/src/constants/providers.js`** — the single source of truth for which providers exist and what each can do (`adminKey`/`sync`/`reconcile`/`liveBalance`/`accountId`). Never write a new hardcoded provider-name list (`['anthropic', 'openai']`, a Zod enum, a `provider === 'anthropic' ? … : …` ternary) — that's exactly the pattern that let the alert-rule dropdown offer a provider the API rejected with a 400, and let a non-Anthropic admin key get silently sent to `api.openai.com` in reconciliation. Test capabilities with `providersWith('sync')` / `isKnownProvider()`, not a literal list. `services/providerRegistry.js` maps those capabilities to the functions that implement them (sync fetchers, reconciliation billing) — add a provider there, not with another ternary branch. `GET /api/providers` exposes the same matrix to the frontend.
- **Server-side cost math goes through `packages/api/src/services/pricingBridge.js`** — the single adapter over `@llm-observatory/sdk`'s pricing tables + `calculate*` fns + `normalizeModelId`. Never re-add a local `PRICING` table in `packages/api` (`services/providerUsage.js` used to have one and it drifted). The bridge adds only a provider→fn dispatch map and the Anthropic cache-write **1.25× surcharge** (`CACHE_CREATION_INPUT_MULTIPLIER`). `services/llmJudge.js` keeps its own 5-line `JUDGE_MODEL` table on purpose (single model per provider, not a full surface).
- **`@llm-observatory/sdk` is an npm dependency of `packages/api`** (`"^1.2.0"`), resolved by `npm install --production` in `packages/api/Dockerfile`. The **published npm version can lag the monorepo source** — npm `1.1.0` was left stale after `normalizeModelId`/Grok+Kimi landed, so prod briefly ran an SDK without them. When you change SDK exports the API uses: `npm publish` from `packages/sdk` (bump the version) **and** bump the range in `packages/api/package.json` (Docker layer-caches `npm install` on that file). The Dockerfile also `COPY scripts/ ./scripts/` so `packages/api/scripts/*` run in the container.
- **Failed calls book $0:** `POST /api/metrics` forces `cost_usd = 0` on any `status_code >= 400` (a rejected request isn't billed) and, unless the client asserted `cost_confidence: 'known'`, marks it `'unknown'`.
- **Encryption key:** Default key exists in code but should always be overridden via `ENCRYPTION_KEY` env var in production.
- **api_key_hint linkage:** Every metric must carry `api_key_hint` (set by SDK). Never remove this field — it's the only link between `api_calls` and `provider_credentials`.
- **Observatory token hash:** Token hash stored as SHA-256 hex. Full `obs_sk_` value is shown once at creation and never stored. Index on `token_hash WHERE revoked_at IS NULL` keeps lookup fast.
- **Dashboard Sync button:** Only calls `fetchAll()` (local DB refresh). Never call `POST /api/sync/:provider` from the dashboard header — that requires an admin key and belongs in Settings → Sync tab only.
- **Dashboard provider filter:** Dashboard reads configured providers from `/api/credentials` and filters projection/chart series to only show those providers. Don't hardcode `['anthropic', 'openai']` in UI loops.
- **Dark mode:** Use `theme-light` / `theme-dark` CSS classes (CSS custom properties), NOT Tailwind's `dark` class strategy. The App.jsx shell applies `className={darkMode ? 'theme-dark' : 'theme-light'}` on the root div.
- **New page pattern:** Every new page must render `<main className="obs-main">` with `obs-header` + `obs-content` children. Use `obs-tabbar` + `obs-tab` for sub-navigation within a page.
- **CSS classes:** Use `.obs-btn`, `.obs-btn-primary`, `.obs-table`, `.obs-section-label`, `.obs-field`, `.obs-input`, `.obs-select`, `.kchip`, `.vbadge`, `.tsw`, `.iprog-bar/.iprog-fill`, `.dot/.dot-pulse` from `index.css`. Do not create new Tailwind utility classes for these patterns.

Sidebar-specific classes: `.obs-brand-logo` (logo img), `.obs-nav-body` (flex column container for label+desc), `.obs-nav-desc` (subtitle 10px), `.obs-user-menu` (dropdown absolute above user block), `.obs-user-menu-item` (action row), `.obs-user-menu-item--danger` (red hover), `.obs-user-menu-sep` (divider), `.obs-role-badge.role-admin` (cyan accent color), `.obs-user-icon-collapsed` (user icon shown in collapsed state).
- **Role checks:** `requireAdmin` middleware blocks non-admins and observatory tokens. For frontend-only role gating, read `user.role` from `useAuth()`. Admins can invite/remove members and manage tokens.

---

## Testing

```bash
# SDK Node.js (39 tests — pricing, anthropic wrapper, openai wrapper, helpers)
cd packages/sdk && npm test

# SDK Python (38 tests)
cd packages/sdk-python && pytest tests/ -v

# API integration (42 tests — auth, metrics scoping, webhooks, middleware)
# Requires PostgreSQL running on :5432
DATABASE_URL=postgresql://postgres:changeme@localhost:5432/llm_observatory_test \
JWT_SECRET=<hex> ENCRYPTION_KEY=<hex> \
cd packages/api && npm test
```

CI: `.github/workflows/test.yml` — 3 jobs paralelos (sdk-node, sdk-python, api + postgres service).

**Test files:**
- `packages/sdk/src/__tests__/` — pricing.test.js, anthropic.test.js, openai.test.js, helpers.test.js
- `packages/api/src/__tests__/` — auth.test.js, metrics.test.js, webhooks-service.test.js, webhooks-routes.test.js, middleware.test.js

---

## Known Limitations / Production Considerations

- HTTPS not enforced in code (delegate to reverse proxy)
- CORS allows all origins (`*`) — restrict in production
- Alert debounce is 6h — cannot be configured per rule
- Sync feature requires admin-level API keys from providers
- No superadmin panel — org management done directly in DB for now
- Observatory tokens do not expire automatically — revoke manually via Settings or `DELETE /api/tokens/:id`
- `AUTH_EMAIL` / `AUTH_PASSWORD_HASH` env vars still supported for legacy single-admin bootstrapping; on startup the API creates an org + org_member for that user if none exists
- Webhook delivery has no retry queue or delivery log — failures are silently swallowed after 1 retry. For production, consider adding a `webhook_deliveries` audit table.
- `EMAIL_FROM` must be `onboarding@resend.dev` (or a verified custom domain in Resend) — unverified custom domains cause Resend to reject all emails to non-owner addresses.
- Password reset is support-mediated (reset link goes to `SUPPORT_EMAIL` for manual forwarding). Once a custom domain is verified in Resend, `sendPasswordResetEmail()` can be switched back to emailing the user directly.
- `trust proxy` is set to `1` in Express (`app.set('trust proxy', 1)`) — required for Railway's reverse proxy so `express-rate-limit` reads the real client IP from `X-Forwarded-For`.
- JWT tokens expire after **1 hour** by default (`JWT_EXPIRES_IN=1h`). Server-side revocation via `POST /api/auth/logout` adds the JTI to `revoked_tokens` table. Cron cleans expired JTIs every 15 min.
- DB backups: `scripts/backup.sh` + `.github/workflows/backup.yml` — pg_dump daily to S3/R2. Requires secrets: `DATABASE_URL`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_BUCKET`, `R2_ACCOUNT_ID` in GitHub Actions.
- `scripts/reprice-zero-cost-calls.js` — recalculates `cost_usd` for historical `api_calls` rows that landed at $0 because their model wasn't yet in the SDK pricing tables (`ANTHROPIC_PRICING`/`OPENAI_PRICING`/`GEMINI_PRICING` in `packages/sdk/src/index.js`) at ingest time. Only touches `status_code < 400 AND cost_confidence = 'known'` rows — never overwrites a genuine $0 or a call already flagged `unknown`. Dry-run by default; `--apply` writes, `--org=<id>` scopes to one org.
- `packages/api/scripts/repair-cost-history.js` — one-off repair for rows corrupted by the pre-`pricingBridge` cost bugs. Ships inside the API package so it runs in the Railway container (`cd /app && node scripts/repair-cost-history.js`, `DATABASE_URL` already set). **Two passes:** (1) reprice `cost_usd = 0 AND status_code < 400 AND cost_confidence = 'known' AND total_tokens > 0` rows via `src/services/pricingBridge` (covers dated OpenAI model ids, Fable 5, cache tokens); skips models with no bridge table (embeddings); (2) zero `cost_usd` + set `cost_confidence = 'unknown'` on `status_code >= 400` rows. Dry-run by default; `--apply` writes all ops in one transaction, `--org=<id>` scopes. The `sync:<provider>` double-count is **not** repaired here — re-run `POST /api/sync/:provider` (Settings → Sync); the new idempotent `importBuckets` recomputes each day's gap against live rows. (A removed pass 3 tried to do this offline and double-counted cache tokens on already-correct gap rows.)
- **Cost reconciliation (2026-08-29→30):** all six recorded-vs-billed bugs fixed and deployed — see PRs #50–#55. Production `api_calls` repaired via the script above + a full re-sync per org.

---

## Roadmap / Pending Work

### Short-term
- [x] Frontend role-based UI — hide admin actions (invite, remove member, sync, alerts) from `member` role users
- [x] Rate limiting on `POST /api/metrics` — protect against token abuse
- [x] Observatory token `last_used_at` update on each metric POST
- [x] Pagination on team member list and invitations list
- [x] Cost-tracking reconciliation — 6 recorded-vs-billed bugs fixed (PRs #50–#55): SDK pricing via `pricingBridge`, gap-based sync import, $0 on failed calls, RFC-4180 CSV, cache-write pricing
- [x] `@llm-observatory/sdk` 1.2.0 published + API pinned to `^1.2.0` — Grok/Kimi tables + `normalizeModelId` resolve in prod; pricingBridge's inline mirror removed
- [x] Provider capability registry (`constants/providers.js` + `services/providerRegistry.js`, `GET /api/providers`) — replaces 8 places where the provider list had drifted independently
- [x] Grok/xAI admin-key billing — historical sync, Costs-API reconciliation (no token-fallback — usage and billed cost are the same call), prepaid balance, management-key validation, all against `management-api.x.ai`. Supersedes the earlier "SDK-metrics only, no sync/reconciliation" Grok/Kimi scope decision — Kimi/Gemini remain SDK-only, xAI does expose an org-level billing API after all.
- [x] Custom date-range filter — Dashboard/Solicitudes/Modelos/Finanzas share one `useRangeFilter` hook + a `TopBar` date-range popover; replaced the `90d` preset. Backend `start`/`end` override, previously only on `GET /api/metrics`/`/summary`/`/export`, extended to tag-keys/tag-values/tag-breakdown/project-breakdown and `/api/balances`.

### Medium-term
- [x] Cache hit rate tracking — `cache_read_tokens` + `cache_write_tokens` in DB, SDK, API and UI drawer
- [x] Error capture — `error_message` in DB, SDK, API; filter in Activity tab (status=error/success)
- [x] Python SDK (`packages/sdk-python`) — `observatory_token` auth, cache tracking, `error_type` classification, sync/async variants
- [x] Webhook delivery for metric events (outbound to customer systems) — HMAC-signed, fire-and-forget, Settings UI
- [x] AES-256-GCM encryption — replaces CBC; backwards compatible; no key rotation needed
- [x] JWT 1h expiry + server-side revocation (`POST /api/auth/logout`, JTI blacklist, 15-min cleanup cron)
- [x] Comprehensive test suite — 79 tests (SDK Node.js 39 + API integration 42), CI via GitHub Actions
- [x] DB backup workflow — `scripts/backup.sh` + `.github/workflows/backup.yml` (pg_dump → R2/S3)
- [x] Operational limits documented in README (rate limits, data retention, JWT expiry)
- [ ] Superadmin panel — cross-org visibility for platform operators
- [ ] Per-org usage quotas — hard limits on metrics volume
- [ ] Audit log — record sensitive actions (member added/removed, token revoked, key deleted)
- [ ] SSO / OAuth login (Google, GitHub) via passport.js
- [ ] Granular roles beyond admin/member (e.g. viewer with read-only access)

### Long-term / SaaS
- [ ] Billing integration (Stripe) — free tier + paid plans per org
- [ ] Self-serve org deletion with data purge
- [ ] Webhook delivery log — `webhook_deliveries` table for audit trail and retry visibility
