const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const { decrypt } = require('../db/crypto');
const { requireAdmin } = require('../middleware/auth');
const { PROVIDERS, PROVIDER_CAPS, requiresAccountId } = require('../constants/providers');
const { fetchGrokPrepaidBalance } = require('../services/providerUsage');
const { appendTimeWindow } = require('../utils/dateRange');

const router = express.Router();

// provider -> live-balance fetcher, cred -> Promise<{ balance_usd, as_of, recent_changes }>.
// Only Grok today; the next provider with a live-balance API is one more entry.
const LIVE_BALANCE_FETCHERS = {
  grok: (cred) => fetchGrokPrepaidBalance(cred.apiKey, cred.accountId),
};

// In-process cache, 60s per (orgId, provider) — the dashboard/Finance page can
// fire this in parallel for several providers on every render; there's no
// reason to hit xAI more than once a minute for a number that changes only
// when someone spends or tops up.
const LIVE_BALANCE_CACHE = new Map(); // `${orgId}:${provider}` -> { at, data }
const LIVE_BALANCE_TTL_MS = 60_000;

const BalanceSchema = z.object({
  // Was ['anthropic','openai'], which 400'd manual recharges for the three
  // providers added later even though their spend was already being measured.
  provider:   z.enum(PROVIDERS),
  amount_usd: z.number().positive(),
  note:       z.string().max(200).optional(),
});

router.get('/', async (req, res) => {
  try {
    const { orgId } = req.user;
    const range = req.query.range || '30d';
    const spendingParams = [orgId];
    // 'all' isn't exposed by the range picker (no UI sends it) but is kept as
    // a valid value for any future/direct caller wanting unfiltered spend.
    const timeWindow = range === 'all'
      ? 'TRUE'
      : appendTimeWindow(spendingParams, { range, start: req.query.start, end: req.query.end });

    const [balances, spending] = await Promise.all([
      pool.query(
        'SELECT * FROM provider_balances WHERE org_id = $1 ORDER BY recharged_at DESC',
        [orgId]
      ),
      pool.query(
        `SELECT provider, COALESCE(SUM(cost_usd), 0) as spent
         FROM api_calls
         WHERE org_id = $1 AND ${timeWindow}
         GROUP BY provider`,
        spendingParams
      ),
    ]);

    // Seeded from the full provider list: the previous two-key literals meant
    // a provider's spend was summed by SQL and then dropped on the floor here.
    const totalLoaded = Object.fromEntries(PROVIDERS.map(p => [p, 0]));
    for (const b of balances.rows) {
      totalLoaded[b.provider] = (totalLoaded[b.provider] || 0) + parseFloat(b.amount_usd);
    }

    const totalSpent = Object.fromEntries(PROVIDERS.map(p => [p, 0]));
    for (const s of spending.rows) {
      totalSpent[s.provider] = parseFloat(s.spent);
    }

    const providers = PROVIDERS.map(p => ({
      provider:     p,
      total_loaded: totalLoaded[p] || 0,
      total_spent:  totalSpent[p]  || 0,
      remaining:    Math.max(0, (totalLoaded[p] || 0) - (totalSpent[p] || 0)),
      pct_used:     totalLoaded[p] > 0
        ? Math.min(100, ((totalSpent[p] || 0) / totalLoaded[p]) * 100)
        : 0,
    }));

    res.json({ providers, history: balances.rows });
  } catch (err) {
    console.error('GET /api/balances error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { orgId } = req.user;
    const data = BalanceSchema.parse(req.body);
    const result = await pool.query(
      'INSERT INTO provider_balances (org_id, provider, amount_usd, note) VALUES ($1, $2, $3, $4) RETURNING *',
      [orgId, data.provider, data.amount_usd, data.note || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/balances/:provider/live — the provider's own reported balance, when
// it has one. Deliberately never written to provider_balances: that table is
// a manual recharge ledger (amount_usd, note, recharged_at) and mixing a
// provider-reported figure into it would corrupt total_loaded/pct_used above.
// The two are shown side by side in the UI instead.
router.get('/:provider/live', async (req, res) => {
  const { provider } = req.params;
  const { orgId }    = req.user;

  if (!PROVIDER_CAPS[provider]) {
    return res.status(400).json({ error: `Proveedor desconocido: ${provider}` });
  }
  const fetcher = LIVE_BALANCE_FETCHERS[provider];
  if (!fetcher) {
    return res.status(404).json({ supported: false, reason: 'provider_has_no_balance_api' });
  }

  const cacheKey = `${orgId}:${provider}`;
  const cached = LIVE_BALANCE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < LIVE_BALANCE_TTL_MS) {
    return res.json({ provider, supported: true, ...cached.data });
  }

  try {
    const credRow = await pool.query(
      `SELECT api_key_encrypted, provider_account_id FROM provider_credentials
       WHERE org_id = $1 AND provider = $2 AND key_type = 'admin'
       ORDER BY created_at DESC LIMIT 1`,
      [orgId, provider]
    );
    if (!credRow.rows.length) {
      return res.status(409).json({ supported: true, configured: false, reason: 'missing_admin_key' });
    }
    const { api_key_encrypted, provider_account_id } = credRow.rows[0];
    if (requiresAccountId(provider) && !provider_account_id) {
      return res.status(409).json({ supported: true, configured: false, reason: 'missing_account_id' });
    }

    const cred = { apiKey: decrypt(api_key_encrypted), accountId: provider_account_id };
    const data = await fetcher(cred);
    LIVE_BALANCE_CACHE.set(cacheKey, { at: Date.now(), data });
    res.json({ provider, supported: true, ...data });
  } catch (err) {
    console.error(`GET /api/balances/${provider}/live error:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { orgId } = req.user;
    await pool.query(
      'DELETE FROM provider_balances WHERE id = $1 AND org_id = $2',
      [req.params.id, orgId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
