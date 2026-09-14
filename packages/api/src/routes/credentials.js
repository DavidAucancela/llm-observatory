const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const { encrypt, decrypt, maskKey } = require('../db/crypto');
const { requireAdmin } = require('../middleware/auth');
const { PROVIDERS, PROVIDER_CAPS } = require('../constants/providers');
const { validateGrokManagementKey } = require('../services/providerUsage');

const router = express.Router();

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

// Columns returned to the client on every credential read. provider_account_id
// is included on purpose — it is not a secret (see the schema comment) and the
// Keys page has to show it back so a mistyped team id can be corrected.
const CRED_COLUMNS =
  'id, provider, key_type, label, key_hint, provider_account_id, is_valid, last_tested_at, created_at';

const CredentialSchema = z.object({
  provider: z.enum(PROVIDERS),
  key_type: z.enum(['sdk', 'admin']),
  label:    z.string().min(1).max(100),
  value:    z.string().min(10),
  // Loose length check rather than a format regex: xAI's team id format isn't
  // contractually documented, and rejecting a valid id would be worse than
  // letting /test surface a real 403 from the provider.
  provider_account_id: z.string().trim().min(4).max(120).optional(),
}).superRefine((data, ctx) => {
  const caps = PROVIDER_CAPS[data.provider];
  // Previously any provider could be given an admin key. For gemini/kimi that
  // key was dead weight: nothing ever read it, /test validated it against the
  // plain models endpoint, and it made the credential look meaningful.
  if (data.key_type === 'admin' && !caps.adminKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['key_type'],
      message: `${data.provider} no tiene claves admin — usa key_type "sdk"`,
    });
  }
  if (data.key_type === 'admin' && caps.accountId === 'required' && !data.provider_account_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['provider_account_id'],
      message: 'Falta el Team ID del proveedor (xAI: consola → Settings → Team)',
    });
  }
});

// Only the two non-secret fields are editable. The key value never is: rotating
// a key means creating a new credential, and letting PATCH touch it would make
// the key_hint / is_valid columns lie.
const CredentialPatchSchema = z.object({
  label:               z.string().min(1).max(100).optional(),
  provider_account_id: z.string().trim().min(4).max(120).optional(),
}).refine(d => d.label !== undefined || d.provider_account_id !== undefined, {
  message: 'Nada que actualizar',
});

// GET /api/credentials — list credentials for current org (keys masked)
router.get('/', async (req, res, next) => {
  try {
    const { orgId } = req.user;
    const result = await pool.query(
      `SELECT ${CRED_COLUMNS}
       FROM provider_credentials WHERE org_id = $1
       ORDER BY provider, key_type, created_at DESC`,
      [orgId]
    );
    res.json({ credentials: result.rows });
  } catch (err) { next(err); }
});

// POST /api/credentials — add a new credential
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { orgId } = req.user;
    const { provider, key_type, label, value, provider_account_id } = CredentialSchema.parse(req.body);
    const encrypted = encrypt(value);
    const hint      = maskKey(value);

    const result = await pool.query(
      `INSERT INTO provider_credentials (org_id, provider, key_type, label, api_key_encrypted, key_hint, provider_account_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING ${CRED_COLUMNS}`,
      [orgId, provider, key_type, label, encrypted, hint, provider_account_id || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    next(err);
  }
});

// PATCH /api/credentials/:id — edit the non-secret fields.
// Exists because DELETE cascades into api_calls: without this route, fixing a
// mistyped team id would mean deleting the credential and taking every synced
// row of history with it.
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { orgId } = req.user;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

    const patch = CredentialPatchSchema.parse(req.body);
    const sets = [];
    const vals = [];
    if (patch.label !== undefined)               { vals.push(patch.label);               sets.push(`label = $${vals.length}`); }
    if (patch.provider_account_id !== undefined) { vals.push(patch.provider_account_id); sets.push(`provider_account_id = $${vals.length}`); }
    // Changing the account id can invalidate a credential that tested fine, so
    // the validity verdict goes back to "untested" rather than staying stale.
    sets.push('is_valid = NULL', 'last_tested_at = NULL', 'updated_at = NOW()');
    vals.push(id, orgId);

    const result = await pool.query(
      `UPDATE provider_credentials SET ${sets.join(', ')}
       WHERE id = $${vals.length - 1} AND org_id = $${vals.length}
       RETURNING ${CRED_COLUMNS}`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Credencial no encontrada' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    next(err);
  }
});

// POST /api/credentials/:id/ping — idempotent test metric (replaces previous one)
router.post('/:id/ping', requireAdmin, async (req, res, next) => {
  try {
    const { orgId } = req.user;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

    const row = await pool.query(
      'SELECT provider, key_hint FROM provider_credentials WHERE id = $1 AND org_id = $2',
      [id, orgId]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'Credencial no encontrada' });

    const { provider, key_hint } = row.rows[0];
    const PING_MODEL = {
      anthropic: 'claude-haiku-4-5-20251001', gemini: 'gemini-3.5-flash', openai: 'gpt-4o-mini',
      grok: 'grok-4.6', kimi: 'kimi-k2.6',
    };
    const model = PING_MODEL[provider];

    await pool.query(
      `DELETE FROM api_calls WHERE org_id = $1 AND provider = $2 AND prompt_preview = 'test:sdk_integration' AND api_key_hint = $3`,
      [orgId, provider, key_hint]
    );

    const result = await pool.query(
      `INSERT INTO api_calls (org_id, provider, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, status_code, prompt_preview, api_key_hint)
       VALUES ($1, $2, $3, 12, 24, 36, 0.0001, 123, 200, 'test:sdk_integration', $4) RETURNING *`,
      [orgId, provider, model, key_hint]
    );

    if (req.app.get('io')) req.app.get('io').emit('new-metric', result.rows[0]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// One tester per (provider, key_type). Every tester returns { valid, error }.
// A provider missing a 'admin' entry (gemini, kimi — no admin-key concept)
// falls through to the default below instead of silently validating an admin
// key against the plain models endpoint, which is what the old if/else chain
// did: gemini and kimi's branches never looked at key_type at all, so an
// "admin" key of theirs was marked valid without ever meaning anything.
const PROVIDER_TESTERS = {
  anthropic: {
    async admin(apiKey) {
      const response = await fetchWithTimeout(
        'https://api.anthropic.com/v1/organizations/usage_report/messages?limit=1',
        { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } }
      );
      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: `Anthropic Admin API respondió con ${response.status}` };
      }
      return { valid: response.status === 200 || response.status === 400, error: null };
    },
    async sdk(apiKey) {
      const response = await fetchWithTimeout('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      });
      return response.status === 200
        ? { valid: true, error: null }
        : { valid: false, error: `Anthropic API respondió con ${response.status}` };
    },
  },
  openai: {
    async admin(apiKey) {
      const startOfMonth = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);
      const response = await fetchWithTimeout(
        `https://api.openai.com/v1/organization/usage/completions?start_time=${startOfMonth}&limit=1`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      return response.status === 200
        ? { valid: true, error: null }
        : { valid: false, error: `OpenAI Organization API respondió con ${response.status}` };
    },
    async sdk(apiKey) {
      const response = await fetchWithTimeout('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      return response.status === 200
        ? { valid: true, error: null }
        : { valid: false, error: `OpenAI API respondió con ${response.status}` };
    },
  },
  gemini: {
    async sdk(apiKey) {
      const response = await fetchWithTimeout(
        'https://generativelanguage.googleapis.com/v1beta/models',
        { headers: { 'x-goog-api-key': apiKey } }
      );
      return response.status === 200
        ? { valid: true, error: null }
        : { valid: false, error: `Gemini API respondió con ${response.status}` };
    },
  },
  grok: {
    // A single GET call: the Management API's own validation endpoint returns
    // the key's teamId and acls, so the team-id match and the Billing scope
    // check both happen without a second request to /prepaid/balance.
    async admin(apiKey, accountId) {
      return validateGrokManagementKey(apiKey, accountId);
    },
    async sdk(apiKey) {
      const response = await fetchWithTimeout('https://api.x.ai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      return response.status === 200
        ? { valid: true, error: null }
        : { valid: false, error: `xAI API respondió con ${response.status}` };
    },
  },
  kimi: {
    async sdk(apiKey) {
      const response = await fetchWithTimeout('https://api.moonshot.ai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      return response.status === 200
        ? { valid: true, error: null }
        : { valid: false, error: `Moonshot API respondió con ${response.status}` };
    },
  },
};

// POST /api/credentials/:id/test — validate a key against provider API
router.post('/:id/test', requireAdmin, async (req, res, next) => {
  try {
    const { orgId } = req.user;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

    const row = await pool.query(
      'SELECT provider, key_type, api_key_encrypted, provider_account_id FROM provider_credentials WHERE id = $1 AND org_id = $2',
      [id, orgId]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'Credencial no encontrada' });

    const { provider, key_type, api_key_encrypted, provider_account_id } = row.rows[0];
    const apiKey = decrypt(api_key_encrypted);

    const tester = PROVIDER_TESTERS[provider]?.[key_type];
    const { valid, error: errorMsg } = tester
      ? await tester(apiKey, provider_account_id)
      : { valid: false, error: `${provider} no tiene claves de tipo "${key_type}"` };

    await pool.query(
      'UPDATE provider_credentials SET is_valid = $1, last_tested_at = NOW() WHERE id = $2',
      [valid, id]
    );

    res.json({ success: true, valid, error: errorMsg });
  } catch (err) { next(err); }
});

// DELETE /api/credentials/:id — delete credential + cascade its api_calls
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { orgId } = req.user;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

    const credResult = await pool.query(
      'SELECT provider, key_type, key_hint FROM provider_credentials WHERE id = $1 AND org_id = $2',
      [id, orgId]
    );
    if (!credResult.rows.length) return res.status(404).json({ error: 'Credencial no encontrada' });

    const { provider, key_type, key_hint } = credResult.rows[0];

    if (key_hint) {
      await pool.query('DELETE FROM api_calls WHERE org_id = $1 AND api_key_hint = $2', [orgId, key_hint]);
    }
    if (key_type === 'admin') {
      await pool.query(
        `DELETE FROM api_calls WHERE org_id = $1 AND provider = $2 AND prompt_preview = $3`,
        [orgId, provider, `sync:${provider}`]
      );
    }

    await pool.query('DELETE FROM provider_credentials WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/credentials/openai/balance — fetch monthly usage from OpenAI org API
router.get('/openai/balance', async (req, res, next) => {
  try {
    const { orgId } = req.user;
    const row = await pool.query(
      `SELECT api_key_encrypted FROM provider_credentials
       WHERE org_id = $1 AND provider = 'openai' AND key_type = 'admin'
       ORDER BY created_at DESC LIMIT 1`,
      [orgId]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'No hay Admin Key de OpenAI configurada' });

    const apiKey = decrypt(row.rows[0].api_key_encrypted);
    const now    = new Date();
    const startOfMonth = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
    const url = `https://api.openai.com/v1/organization/usage/completions?start_time=${startOfMonth}&bucket_width=1d&limit=31`;

    const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: `OpenAI ${response.status}: ${text}` });
    }

    const data = await response.json();
    let inputTokens = 0, outputTokens = 0;
    for (const bucket of (data.data || [])) {
      for (const r of (bucket.results || [])) {
        inputTokens  += parseInt(r.input_tokens  || 0);
        outputTokens += parseInt(r.output_tokens || 0);
      }
    }
    const costUsd = (inputTokens / 1_000_000) * 2.5 + (outputTokens / 1_000_000) * 10.0;
    res.json({
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      cost_usd:      costUsd,
      month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    });
  } catch (err) { next(err); }
});

module.exports = router;
