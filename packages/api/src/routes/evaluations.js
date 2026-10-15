const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const { decrypt } = require('../db/crypto');
const { requireAdmin } = require('../middleware/auth');
const { judgeApiCall } = require('../services/llmJudge');
const { emitNewMetric } = require('../services/realtime');

const router = express.Router();

const HumanScoreSchema = z.object({
  api_call_id: z.number().int().positive(),
  name:        z.string().min(1).max(50).default('quality'),
  score:       z.number().min(0).max(100),
  reasoning:   z.string().max(2000).optional(),
});

const JudgeSchema = z.object({
  api_call_id: z.number().int().positive(),
  name:        z.string().min(1).max(50).default('quality'),
});

// GET /api/evaluations?api_call_id=X — list evaluations for one request
router.get('/', async (req, res, next) => {
  try {
    const { orgId } = req.user;
    const apiCallId = parseInt(req.query.api_call_id);
    if (isNaN(apiCallId)) return res.status(400).json({ error: 'api_call_id inválido' });

    const result = await pool.query(
      `SELECT id, name, method, score, reasoning, evaluator_model, created_by, created_at
       FROM evaluations WHERE org_id = $1 AND api_call_id = $2 ORDER BY created_at DESC`,
      [orgId, apiCallId]
    );
    res.json({ evaluations: result.rows });
  } catch (err) { next(err); }
});

// POST /api/evaluations — human-submitted score. Any org member (not observatory
// tokens — this is a dashboard action, not something SDK code should be able to do).
router.post('/', async (req, res, next) => {
  try {
    if (req.user.isObservatoryToken) {
      return res.status(403).json({ error: 'Se requiere autenticación de usuario' });
    }
    const { orgId } = req.user;
    const data = HumanScoreSchema.parse(req.body);

    const callCheck = await pool.query(
      'SELECT id FROM api_calls WHERE id = $1 AND org_id = $2', [data.api_call_id, orgId]
    );
    if (!callCheck.rows.length) return res.status(404).json({ error: 'Request no encontrado' });

    const result = await pool.query(
      `INSERT INTO evaluations (org_id, api_call_id, name, method, score, reasoning, created_by)
       VALUES ($1, $2, $3, 'human', $4, $5, $6) RETURNING *`,
      [orgId, data.api_call_id, data.name, data.score, data.reasoning || null, req.user.id]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    next(err);
  }
});

// POST /api/evaluations/judge — score via a second LLM call. Admin-only: unlike
// a human opinion, this spends the org's own provider credits.
router.post('/judge', requireAdmin, async (req, res, next) => {
  try {
    const { orgId } = req.user;
    const data = JudgeSchema.parse(req.body);

    const callResult = await pool.query(
      'SELECT id, provider, prompt_full, prompt_preview, response_full FROM api_calls WHERE id = $1 AND org_id = $2',
      [data.api_call_id, orgId]
    );
    if (!callResult.rows.length) return res.status(404).json({ error: 'Request no encontrado' });
    const apiCall = callResult.rows[0];

    if (!apiCall.response_full) {
      return res.status(400).json({ error: 'Este request no tiene texto de respuesta capturado para evaluar' });
    }

    // Prefer a credential for the same provider as the call being judged; fall
    // back to any other configured sdk credential. Admin keys are excluded —
    // they're scoped to usage/cost-report endpoints on some providers, not
    // valid for making an actual inference call.
    const credResult = await pool.query(
      `SELECT provider, api_key_encrypted FROM provider_credentials
       WHERE org_id = $1 AND key_type = 'sdk'
       ORDER BY (provider = $2) DESC, created_at DESC LIMIT 1`,
      [orgId, apiCall.provider]
    );
    if (!credResult.rows.length) {
      return res.status(400).json({ error: 'No hay ninguna clave SDK configurada para usar como juez. Agregá una en Claves.' });
    }
    const { provider: judgeProvider, api_key_encrypted } = credResult.rows[0];
    const apiKey = decrypt(api_key_encrypted);

    const judged = await judgeApiCall(judgeProvider, apiKey, {
      promptText: apiCall.prompt_full || apiCall.prompt_preview || '',
      responseText: apiCall.response_full,
    });

    const evalResult = await pool.query(
      `INSERT INTO evaluations (org_id, api_call_id, name, method, score, reasoning, evaluator_model)
       VALUES ($1, $2, $3, 'llm_judge', $4, $5, $6) RETURNING *`,
      [orgId, data.api_call_id, data.name, judged.score, judged.reasoning, judged.model]
    );

    // The judge call is itself billable — record it like any other metric so
    // it's visible on the dashboard instead of becoming invisible spend.
    const metricResult = await pool.query(
      `INSERT INTO api_calls
         (org_id, provider, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, status_code, prompt_preview)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 200, 'eval:judge') RETURNING *`,
      [
        orgId, judgeProvider, judged.model, judged.inputTokens, judged.outputTokens,
        judged.inputTokens + judged.outputTokens, judged.costUsd,
      ]
    );
    emitNewMetric(req, metricResult.rows[0]);

    res.status(201).json({ success: true, data: evalResult.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    if (err.message?.includes('judge call failed') || err.message?.includes('Judge response')) {
      return res.status(502).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
