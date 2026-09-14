const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const { sendDiscordAlert } = require('../jobs/alertChecker');
const { requireAdmin } = require('../middleware/auth');
const { PROVIDERS } = require('../constants/providers');

const router = express.Router();

// `reconciliation_deviation` is read by jobs/reconciliation.js but was missing
// from the metric enum, so the rule it looks for could not be created through
// the API at all — only by inserting straight into the table. Likewise the
// provider enum stopped at openai while the web's dropdown already offered all
// five, so picking Grok there returned a 400.
const RuleSchema = z.object({
  provider:            z.enum([...PROVIDERS, 'all']).default('all'),
  metric:              z.enum(['daily_spend', 'weekly_spend', 'monthly_spend', 'reconciliation_deviation']).default('daily_spend'),
  threshold_usd:       z.number().positive(),
  // Deviation threshold in percent, only meaningful for
  // metric='reconciliation_deviation'. The column existed but neither POST nor
  // PUT ever wrote it, so every reconciliation rule silently ran on the 10%
  // fallback in reconciliation.js.
  threshold_pct:       z.number().positive().max(1000).optional(),
  discord_webhook_url: z.string().url(),
  debounce_hours:      z.number().int().min(1).max(168).default(6),
}).refine(d => d.metric !== 'reconciliation_deviation' || d.threshold_pct !== undefined, {
  path: ['threshold_pct'],
  message: 'threshold_pct es obligatorio para metric="reconciliation_deviation"',
});

router.get('/rules', async (req, res) => {
  try {
    const { orgId } = req.user;
    const result = await pool.query(
      'SELECT * FROM alert_rules WHERE org_id = $1 ORDER BY created_at DESC',
      [orgId]
    );
    res.json({ rules: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/rules', requireAdmin, async (req, res) => {
  try {
    const { orgId } = req.user;
    const data = RuleSchema.parse(req.body);
    const result = await pool.query(
      `INSERT INTO alert_rules (org_id, provider, metric, threshold_usd, threshold_pct, discord_webhook_url, debounce_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [orgId, data.provider, data.metric, data.threshold_usd, data.threshold_pct ?? null,
       data.discord_webhook_url, data.debounce_hours]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/rules/:id', requireAdmin, async (req, res) => {
  try {
    const { orgId } = req.user;
    const { enabled, threshold_usd, threshold_pct, discord_webhook_url, debounce_hours } = req.body;
    const sets = [];
    const vals = [];
    if (enabled !== undefined)             { vals.push(enabled);            sets.push(`enabled = $${vals.length}`); }
    if (threshold_usd !== undefined)       { vals.push(threshold_usd);      sets.push(`threshold_usd = $${vals.length}`); }
    if (threshold_pct !== undefined)       { vals.push(threshold_pct);      sets.push(`threshold_pct = $${vals.length}`); }
    if (discord_webhook_url !== undefined) { vals.push(discord_webhook_url); sets.push(`discord_webhook_url = $${vals.length}`); }
    if (debounce_hours !== undefined)      { vals.push(parseInt(debounce_hours, 10) || 6); sets.push(`debounce_hours = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id, orgId);
    const result = await pool.query(
      `UPDATE alert_rules SET ${sets.join(', ')}
       WHERE id = $${vals.length - 1} AND org_id = $${vals.length} RETURNING *`,
      vals
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/rules/:id', requireAdmin, async (req, res) => {
  try {
    const { orgId } = req.user;
    await pool.query(
      'DELETE FROM alert_rules WHERE id = $1 AND org_id = $2',
      [req.params.id, orgId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/history', async (req, res) => {
  try {
    const { orgId } = req.user;
    const result = await pool.query(
      `SELECT ah.*, ar.provider as rule_provider, ar.threshold_usd as rule_threshold, ar.discord_webhook_url
       FROM alert_history ah
       LEFT JOIN alert_rules ar ON ah.rule_id = ar.id
       WHERE ah.org_id = $1
       ORDER BY ah.sent_at DESC LIMIT 50`,
      [orgId]
    );
    res.json({ history: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/rules/:id/test', requireAdmin, async (req, res) => {
  try {
    const { orgId } = req.user;
    const rule = await pool.query(
      'SELECT * FROM alert_rules WHERE id = $1 AND org_id = $2',
      [req.params.id, orgId]
    );
    if (!rule.rows.length) return res.status(404).json({ error: 'Rule not found' });
    const r       = rule.rows[0];
    const success = await sendDiscordAlert(r.discord_webhook_url, r.provider, 99.99, parseFloat(r.threshold_usd), true);
    res.json({ success, message: success ? 'Alerta de prueba enviada a Discord' : 'Error al enviar la alerta' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
