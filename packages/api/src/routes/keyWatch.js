// Key audit API (services/keyWatch.js) — what the /security page renders and
// the actions it takes. Every query is scoped by req.user.orgId ($1).
const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');
const {
  KeyWatchError, keyWatchAll, keyWatchOverview, disableProviderKey,
} = require('../services/keyWatch');

const router = express.Router();

function sendError(res, next, err) {
  if (err instanceof KeyWatchError) {
    return res.status(err.status).json({ error: err.message, code: err.code, params: err.params });
  }
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
  return next(err);
}

const intId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// GET /api/key-watch/overview — keys with 24h/7d usage, SDK coverage, open events
router.get('/overview', async (req, res, next) => {
  try {
    res.json(await keyWatchOverview(req.user.orgId));
  } catch (err) { sendError(res, next, err); }
});

const EventsQuery = z.object({
  key_id: z.string().max(120).optional(),
  include_historical: z.enum(['true', 'false']).optional(),
  include_acknowledged: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// GET /api/key-watch/events
router.get('/events', async (req, res, next) => {
  try {
    const q = EventsQuery.parse(req.query);
    const params = [req.user.orgId];
    let where = 'e.org_id = $1';
    if (q.key_id) { params.push(q.key_id); where += ` AND e.key_id = $${params.length}`; }
    if (q.include_historical !== 'true') where += ' AND e.historical = false';
    if (q.include_acknowledged !== 'true') where += ` AND (e.acknowledged_at IS NULL OR e.type = 'key_disabled')`;
    params.push(q.limit || 50);
    const r = await pool.query(
      `SELECT e.id, e.provider, e.key_id, e.type, e.severity, e.day, e.first_hour, e.last_hour, e.details,
              e.historical, e.discord, e.acknowledged_at, e.created_at, e.updated_at,
              k.id AS key_row_id, k.name AS key_name, k.project_name, u.email AS acknowledged_by_email
       FROM key_events e
       LEFT JOIN provider_keys k ON k.org_id = e.org_id AND k.provider = e.provider AND k.key_id = e.key_id
       LEFT JOIN users u ON u.id = e.acknowledged_by
       WHERE ${where}
       ORDER BY e.day DESC, e.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ events: r.rows });
  } catch (err) { sendError(res, next, err); }
});

// POST /api/key-watch/run — "Revisar ahora" for every watched provider of the org
router.post('/run', requireAdmin, async (req, res, next) => {
  try {
    const results = await keyWatchAll({ orgId: req.user.orgId, trigger: 'manual' });
    res.json({ results });
  } catch (err) { sendError(res, next, err); }
});

const KeyPatch = z.object({
  linked_credential_id: z.number().int().positive().nullable().optional(),
  expected_unmonitored: z.boolean().optional(),
}).refine(d => d.linked_credential_id !== undefined || d.expected_unmonitored !== undefined, {
  message: 'Nada que actualizar',
});

// PATCH /api/key-watch/keys/:id — link to an SDK credential / mark as expected without SDK
router.patch('/keys/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const body = KeyPatch.parse(req.body);
    const orgId = req.user.orgId;
    const key = await pool.query(`SELECT provider FROM provider_keys WHERE org_id = $1 AND id = $2`, [orgId, id]);
    if (!key.rows.length) return res.status(404).json({ error: 'Clave no encontrada', code: 'not_found' });

    if (body.linked_credential_id) {
      const cred = await pool.query(
        `SELECT 1 FROM provider_credentials WHERE org_id = $1 AND id = $2 AND provider = $3 AND key_type = 'sdk'`,
        [orgId, body.linked_credential_id, key.rows[0].provider]
      );
      if (!cred.rows.length) return res.status(400).json({ error: 'Credencial inválida', code: 'invalid_credential' });
    }
    const sets = [];
    const params = [orgId, id];
    if (body.linked_credential_id !== undefined) { params.push(body.linked_credential_id); sets.push(`linked_credential_id = $${params.length}`); }
    if (body.expected_unmonitored !== undefined) { params.push(body.expected_unmonitored); sets.push(`expected_unmonitored = $${params.length}`); }
    const r = await pool.query(
      `UPDATE provider_keys SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2
       RETURNING id, key_id, linked_credential_id, expected_unmonitored`,
      params
    );
    res.json({ data: r.rows[0] });
  } catch (err) { sendError(res, next, err); }
});

// POST /api/key-watch/events/:id/ack — mark an event as reviewed (leaves the bell)
router.post('/events/:id/ack', requireAdmin, async (req, res, next) => {
  try {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const r = await pool.query(
      `UPDATE key_events SET acknowledged_at = NOW(), acknowledged_by = $3, updated_at = NOW()
       WHERE org_id = $1 AND id = $2 AND acknowledged_at IS NULL RETURNING id`,
      [req.user.orgId, id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Evento no encontrado', code: 'not_found' });
    res.json({ success: true });
  } catch (err) { sendError(res, next, err); }
});

const DisableBody = z.object({ confirm_name: z.string().min(1).max(200) });

// POST /api/key-watch/keys/:id/disable — Anthropic: deactivate (reversible).
// OpenAI: DELETE (its admin API has no disable — irreversible).
router.post('/keys/:id/disable', requireAdmin, async (req, res, next) => {
  try {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { confirm_name } = DisableBody.parse(req.body);
    const result = await disableProviderKey({ orgId: req.user.orgId, id, confirmName: confirm_name, userId: req.user.id });
    res.json({ success: true, ...result });
  } catch (err) { sendError(res, next, err); }
});

module.exports = router;
