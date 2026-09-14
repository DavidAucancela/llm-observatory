-- ── users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  SERIAL PRIMARY KEY,
  email               VARCHAR(255) NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  role                VARCHAR(20)  NOT NULL DEFAULT 'admin',
  is_active           BOOLEAN      NOT NULL DEFAULT false,
  activation_token    TEXT,
  reset_token         TEXT,
  reset_token_expires TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_login_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_reset      ON users(reset_token)        WHERE reset_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_activation ON users(activation_token)   WHERE activation_token IS NOT NULL;

-- ── api_calls ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_calls (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider VARCHAR(50) NOT NULL DEFAULT 'anthropic',
  model VARCHAR(100) NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd DECIMAL(10, 6) NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL DEFAULT 200,
  tools_used JSONB DEFAULT '[]'::jsonb,
  prompt_preview VARCHAR(200),
  prompt_full TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_calls_timestamp ON api_calls(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_api_calls_model ON api_calls(model);
CREATE INDEX IF NOT EXISTS idx_api_calls_provider ON api_calls(provider);
-- Composite index for the summary/filter queries (timestamp + provider + model)
CREATE INDEX IF NOT EXISTS idx_api_calls_filter ON api_calls(timestamp DESC, provider, model);

-- ── budgets ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS budgets (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  limit_usd DECIMAL(10, 2) NOT NULL,
  period VARCHAR(20) NOT NULL DEFAULT 'monthly',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── provider_balances ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_balances (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(50) NOT NULL,
  amount_usd DECIMAL(10, 2) NOT NULL,
  note VARCHAR(200),
  recharged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── provider_credentials ───────────────────────────────────────────────────────
-- Supports multiple keys per provider, separated by key_type: 'sdk' or 'admin'
CREATE TABLE IF NOT EXISTS provider_credentials (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(50) NOT NULL,
  key_type VARCHAR(10) NOT NULL DEFAULT 'sdk',
  label VARCHAR(100),
  api_key_encrypted TEXT NOT NULL,
  key_hint VARCHAR(30),
  is_valid BOOLEAN,
  last_tested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Drop the old single-provider unique constraint if it exists (migration from v1)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'provider_credentials_provider_key'
    AND conrelid = 'provider_credentials'::regclass
  ) THEN
    ALTER TABLE provider_credentials DROP CONSTRAINT provider_credentials_provider_key;
  END IF;
END $$;

-- Add role/is_active to users table for deployments created before auth was added
ALTER TABLE users ADD COLUMN IF NOT EXISTS role      VARCHAR(20) NOT NULL DEFAULT 'admin';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN     NOT NULL DEFAULT false;

-- Add new columns to existing tables (idempotent migrations)
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS key_type VARCHAR(10) NOT NULL DEFAULT 'sdk';
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS label VARCHAR(100);

-- ── alert_rules ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_rules (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(50) NOT NULL DEFAULT 'all',
  metric VARCHAR(50) NOT NULL DEFAULT 'daily_spend',
  threshold_usd DECIMAL(10,2) NOT NULL,
  discord_webhook_url TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  debounce_hours INTEGER NOT NULL DEFAULT 6,
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration: add debounce_hours to existing installations
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS debounce_hours INTEGER NOT NULL DEFAULT 6;

CREATE TABLE IF NOT EXISTS alert_history (
  id SERIAL PRIMARY KEY,
  rule_id INTEGER REFERENCES alert_rules(id) ON DELETE CASCADE,
  provider VARCHAR(50),
  current_value DECIMAL(10,4),
  threshold_usd DECIMAL(10,2),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  success BOOLEAN
);

-- ── sync_logs ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_logs (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  records_synced INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Add missing columns to sync_logs if upgrading from older schema
ALTER TABLE sync_logs ADD COLUMN IF NOT EXISTS records_synced INTEGER DEFAULT 0;
ALTER TABLE sync_logs ADD COLUMN IF NOT EXISTS date_range_start TIMESTAMPTZ;
ALTER TABLE sync_logs ADD COLUMN IF NOT EXISTS date_range_end TIMESTAMPTZ;

-- ── tags on api_calls (project/env metadata from SDK) ─────────────────────────
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '{}'::jsonb;

-- ── api_key_hint on api_calls (links metric to originating credential) ─────────
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS api_key_hint VARCHAR(30);
CREATE INDEX IF NOT EXISTS idx_api_calls_key_hint ON api_calls(api_key_hint) WHERE api_key_hint IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- Multi-tenancy
-- ════════════════════════════════════════════════════════════════════════════

-- ── organizations ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  slug       VARCHAR(100) NOT NULL UNIQUE,
  plan       VARCHAR(20)  NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── org_members ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_members (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       VARCHAR(20) NOT NULL DEFAULT 'member',
  invited_by INTEGER REFERENCES users(id),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org  ON org_members(org_id);

-- ── invitations ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invitations (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       VARCHAR(255) NOT NULL,
  role        VARCHAR(20)  NOT NULL DEFAULT 'member',
  token       VARCHAR(64)  NOT NULL UNIQUE,
  invited_by  INTEGER REFERENCES users(id),
  expires_at  TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token) WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email) WHERE accepted_at IS NULL;

-- ── observatory_tokens ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observatory_tokens (
  id           SERIAL PRIMARY KEY,
  org_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         VARCHAR(100) NOT NULL,
  token_hash   VARCHAR(64)  NOT NULL UNIQUE,
  token_prefix VARCHAR(20)  NOT NULL,
  created_by   INTEGER REFERENCES users(id),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_obs_tokens_hash ON observatory_tokens(token_hash) WHERE revoked_at IS NULL;

-- ── Add org_id to all tenant tables ──────────────────────────────────────────
ALTER TABLE api_calls            ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id);
ALTER TABLE budgets              ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id);
ALTER TABLE provider_balances    ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id);
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id);
ALTER TABLE alert_rules          ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id);
ALTER TABLE alert_history        ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id);
ALTER TABLE sync_logs            ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id);

-- ── Indexes for org-scoped lookups ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_api_calls_org   ON api_calls(org_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_credentials_org ON provider_credentials(org_id);
CREATE INDEX IF NOT EXISTS idx_budgets_org     ON budgets(org_id);
CREATE INDEX IF NOT EXISTS idx_balances_org    ON provider_balances(org_id);
CREATE INDEX IF NOT EXISTS idx_alert_rules_org ON alert_rules(org_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_org   ON sync_logs(org_id);

-- ── Cache token tracking ─────────────────────────────────────────────────────
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS cache_read_tokens  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER NOT NULL DEFAULT 0;

-- ── Error capture columns ─────────────────────────────────────────────────────
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS error_type    VARCHAR(100);
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS error_message TEXT;
CREATE INDEX IF NOT EXISTS idx_api_calls_error ON api_calls(error_type) WHERE error_type IS NOT NULL;

-- ── Backfill existing data into a default org (runs once when no orgs exist) ──
DO $$
DECLARE v_org_id INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM users LIMIT 1)
     AND NOT EXISTS (SELECT 1 FROM organizations LIMIT 1) THEN

    INSERT INTO organizations (name, slug)
    VALUES ('Default Organization', 'default')
    RETURNING id INTO v_org_id;

    INSERT INTO org_members (org_id, user_id, role)
    SELECT v_org_id, id, 'admin' FROM users
    ON CONFLICT DO NOTHING;

    UPDATE api_calls            SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE budgets              SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE provider_balances    SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE provider_credentials SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE alert_rules          SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE alert_history        SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE sync_logs            SET org_id = v_org_id WHERE org_id IS NULL;
  END IF;
END $$;

-- ── Webhook endpoints (outbound delivery) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  events      TEXT[] NOT NULL DEFAULT '{metric.created}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org
  ON webhook_endpoints(org_id) WHERE is_active = true;

-- ── revoked_tokens — JWT JTI blacklist for server-side logout ─────────────────
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti  VARCHAR(36)  PRIMARY KEY,
  exp  TIMESTAMPTZ  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_exp ON revoked_tokens(exp);

-- ── Full request/response capture (prompt_full already existed but was never
--    populated by the SDK; the rest are new) ──────────────────────────────────
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS response_full  TEXT;
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS system_prompt  TEXT;
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS request_params JSONB DEFAULT '{}'::jsonb;
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS tool_calls     JSONB DEFAULT '[]'::jsonb;
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS stop_reason    VARCHAR(50);

-- ── Cost confidence — distinguishes a genuinely-known $0 (e.g. a 400 rejected
--    before any provider call) from a client that simply doesn't know the real
--    cost (e.g. a timed-out call after retries). Ingest defaults this to
--    'known', then the server overrides it to 'unknown' when status_code >= 400
--    and cost_usd = 0 and the client didn't explicitly assert 'known' — see
--    POST /api/metrics. Never silently trust an unlabeled zero on an error. ───
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS cost_confidence VARCHAR(10) NOT NULL DEFAULT 'known';
CREATE INDEX IF NOT EXISTS idx_api_calls_cost_confidence ON api_calls(cost_confidence) WHERE cost_confidence = 'unknown';

-- ── Reconciliation — daily comparison of client-reported cost_usd against the
--    provider's real billed-dollar Costs API (source='provider_costs_api';
--    genuine ground truth) or, if that call fails, a recomputed estimate from
--    the token-usage API + the local PRICING table sync.js uses
--    (source='token_estimate_fallback' — weaker, catches SDK-side cost bugs
--    like a retry re-billing the same request, but not real billing
--    discrepancies). See packages/api/src/jobs/reconciliation.js. ────────────
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id                     SERIAL PRIMARY KEY,
  org_id                 INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider               VARCHAR(50) NOT NULL,
  period_start           TIMESTAMPTZ NOT NULL,
  period_end             TIMESTAMPTZ NOT NULL,
  provider_computed_usd  DECIMAL(10, 6) NOT NULL,
  client_reported_usd    DECIMAL(10, 6) NOT NULL,
  deviation_pct          DECIMAL(6, 2) NOT NULL,
  status                 VARCHAR(10) NOT NULL DEFAULT 'ok', -- 'ok' | 'alert' | 'error'
  error_message          TEXT,
  source                 VARCHAR(30) NOT NULL DEFAULT 'provider_costs_api', -- 'provider_costs_api' | 'token_estimate_fallback'
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_org ON reconciliation_runs(org_id, created_at DESC);

-- ── Reconciliation alert threshold — reuses alert_rules' Discord delivery +
--    debounce machinery via metric = 'reconciliation_deviation'. threshold_usd
--    is repurposed as a percentage for this metric (e.g. 10.00 = 10%). ────────
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS threshold_pct DECIMAL(6, 2);

-- ── Likely-retry detection — set at ingest (POST /api/metrics) when a call
--    with the same (org, provider, model, prompt_preview, api_key_hint)
--    landed within the retry-detection window (see RETRY_WINDOW in
--    routes/metrics.js). Points at the earlier call; NULL means no match
--    found (not necessarily "not a retry" — detection is heuristic, exact
--    prompt_preview match only). Never used to silently adjust cost figures —
--    surfaced in the UI only, so a human decides what it means. ─────────────
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS likely_retry_of INTEGER REFERENCES api_calls(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_api_calls_retry_lookup ON api_calls(org_id, provider, model, prompt_preview, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_api_calls_likely_retry ON api_calls(likely_retry_of) WHERE likely_retry_of IS NOT NULL;

-- ── Speeds up the sync-reconciliation "gap" rollup in routes/sync.js: the sum of
--    an org's LIVE (non-sync, non-ping, non-judge) api_calls per provider+model+day.
--    Predicate matches that query's WHERE exactly; LIKE/<> on constants are
--    IMMUTABLE so this is a valid partial-index predicate. ────────────────────
CREATE INDEX IF NOT EXISTS idx_api_calls_live_rollup
  ON api_calls (org_id, provider, model, timestamp)
  WHERE prompt_preview IS NULL
     OR (prompt_preview NOT LIKE 'sync:%'
     AND prompt_preview NOT LIKE 'test:%'
     AND prompt_preview <> 'eval:judge');

-- ── Insight dismissals — insights themselves are computed on-demand from
--    api_calls (see services/insights.js), never persisted. The only state
--    kept is which insight_key an org muted and until when, so "Silenciar
--    24h" is shared across the whole org, not per-browser. insight_key is a
--    deterministic string per detector+entity (e.g. "cost_spike:openai:gpt-4o"
--    or "improvement:org" for the org-level detector). ─────────────────────
CREATE TABLE IF NOT EXISTS insight_dismissals (
  id               SERIAL PRIMARY KEY,
  org_id           INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  insight_key      TEXT NOT NULL,
  dismissed_until  TIMESTAMPTZ NOT NULL,
  dismissed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, insight_key)
);
CREATE INDEX IF NOT EXISTS idx_insight_dismissals_org ON insight_dismissals(org_id);

-- ── Notification reads — a single "read up to here" watermark per user, not a
--    row per notification. Notifications themselves are never stored either;
--    they're assembled on every GET /api/notifications from tables that
--    already have real timestamps: alert_history, reconciliation_runs
--    (status alert|error), and invitations.accepted_at. Default '-infinity'
--    means everything is unread until the user's first read-all. ───────────
CREATE TABLE IF NOT EXISTS notification_reads (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_read_at  TIMESTAMPTZ NOT NULL DEFAULT '-infinity'
);

-- ── Evaluations — quality score per api_calls row, either a human opinion or
--    an LLM-as-judge call triggered on demand (never automatic on ingest — that
--    would silently double an org's spend on every request). score is 0-100 so
--    a judge model can be nuanced instead of forced into a 1-5 bucket. `name`
--    allows more than one named metric per call in the future (e.g. a separate
--    "toxicity" score alongside "quality"); v1 only ever writes 'quality'.
--    A judge call is itself billable, so routes/evaluations.js also inserts a
--    normal api_calls row for it (prompt_preview='eval:judge') — judge spend
--    must show up on the dashboard like any other call, not go untracked. ────
CREATE TABLE IF NOT EXISTS evaluations (
  id               SERIAL PRIMARY KEY,
  org_id           INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  api_call_id      INTEGER NOT NULL REFERENCES api_calls(id) ON DELETE CASCADE,
  name             VARCHAR(50) NOT NULL DEFAULT 'quality',
  method           VARCHAR(20) NOT NULL, -- 'human' | 'llm_judge'
  score            DECIMAL(5, 2) NOT NULL,
  reasoning        TEXT,
  evaluator_model  VARCHAR(100), -- NULL for method='human'
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL, -- NULL for method='llm_judge'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evaluations_api_call ON evaluations(api_call_id);

-- ── token_name — snapshot of the observatory_tokens.name that authenticated
--    this call at ingest time, so project breakdowns don't depend on clients
--    consistently setting a free-text `project` tag. Survives token renames
--    (frozen at insert) but not deletes (no FK — token rows can be revoked). ─
ALTER TABLE api_calls ADD COLUMN IF NOT EXISTS token_name VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_evaluations_org      ON evaluations(org_id, created_at DESC);

-- ── provider_account_id — the provider-side account/team identifier that some
--    billing APIs require in the request path and that the API key itself does
--    not carry. Only xAI needs it today: the Management API routes are
--    /v1/billing/teams/{teamId}/… and the teamId is NOT discoverable through
--    the API — it is copied from console.x.ai → Settings → Team.
--    Deliberately stored in PLAINTEXT, unlike api_key_encrypted: this is not a
--    secret (it sits in the console URL), and encrypting it would stop the
--    Keys page from showing it back for editing and stop SQL from filtering on
--    it. Please don't "fix" this by wrapping it in encrypt().
--    Generic name, not xai_team_id, so the next provider whose billing API is
--    scoped by an org/project id reuses the column instead of adding one. ────
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS provider_account_id VARCHAR(120);
