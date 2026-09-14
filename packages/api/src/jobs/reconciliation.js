const pool = require('../db/pool');
const { decrypt } = require('../db/crypto');
const { summarizeBuckets } = require('../services/providerUsage');
const { billingFor, reconcilableProviders } = require('../services/providerRegistry');
const { requiresAccountId } = require('../constants/providers');

// Fallback deviation threshold (%) used when an org has reconciliation alerting
// enabled (alert_rules.metric = 'reconciliation_deviation') but didn't set an
// explicit threshold_pct.
const DEFAULT_DEVIATION_THRESHOLD_PCT = 10;

// Primary source: the provider's real billed-dollar Costs API (OpenAI
// /v1/organization/costs, Anthropic /v1/organizations/cost_report) — genuine
// ground truth, verifies against actual provider billing. If that call fails
// (key lacks the required scope, endpoint outage, etc.), falls back to
// recomputing from the token-usage API + the same local PRICING table client
// SDKs use (services/providerUsage.js summarizeBuckets) — weaker (catches
// SDK-side bugs like WhisperX's retry over-billing, but not real billing
// discrepancies), but keeps reconciliation running instead of going dark.
// `source` on reconciliation_runs records which one actually produced the row.
// `cred` is { apiKey, accountId } — accountId is provider_account_id, needed by
// providers whose billing routes are scoped by a team/org id (xAI).
//
// Dispatch goes through the registry rather than a ternary. The old
// `provider === 'anthropic' ? … : fetchOpenAIRealCost(…)` treated every
// non-Anthropic provider as OpenAI, so a Grok admin key was sent to
// api.openai.com. The caller guarantees `billingFor(provider)` is non-null.
async function fetchProviderTotal(provider, cred, periodStart, periodEnd) {
  const billing = billingFor(provider);
  try {
    const total = await billing.realCost(cred, periodStart, periodEnd);
    return { total, source: 'provider_costs_api' };
  } catch (err) {
    // Only providers with an independent token-usage source can fall back. For
    // the rest (xAI: usage and billed cost are the same call) re-throwing is
    // the honest outcome — a row marked `error`, not a number we made up.
    if (!billing.usage) throw err;
    console.warn(`[reconciliation] ${provider} real Costs API failed, falling back to token estimate:`, err.message);
    const buckets = await billing.usage(cred, periodStart, periodEnd);
    const { costUsd } = summarizeBuckets(buckets, provider);
    return { total: costUsd, source: 'token_estimate_fallback' };
  }
}

async function sendReconciliationAlert(webhookUrl, provider, providerComputedUsd, clientReportedUsd, deviationPct, source) {
  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
  const providerFieldLabel = source === 'provider_costs_api' ? 'Facturado por el proveedor' : 'Estimado (fallback por tokens)';
  const payload = {
    embeds: [{
      title: `🔍 Desviación de costo detectada — ${providerLabel}`,
      description: source === 'provider_costs_api'
        ? 'El costo reportado por los clientes se desvía del billing real del proveedor.'
        : 'El costo reportado por los clientes se desvía del estimado por Observatory (la API de costos real del proveedor no estuvo disponible — ver logs).',
      color: 16744272,
      fields: [
        { name: 'Reportado por clientes',   value: `$${clientReportedUsd.toFixed(4)}`, inline: true },
        { name: providerFieldLabel,         value: `$${providerComputedUsd.toFixed(4)}`, inline: true },
        { name: 'Desviación',                     value: `${deviationPct.toFixed(1)}%`, inline: true },
      ],
      footer:    { text: 'LLM Observatory — Reconciliación diaria' },
      timestamp: new Date().toISOString(),
    }],
  };
  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    return res.ok;
  } catch (err) {
    console.error('[reconciliation] Discord webhook error:', err.message);
    return false;
  }
}

async function reconcileOrgProvider(orgId, provider, cred, periodStart, periodEnd) {
  const { total: providerComputedUsd, source } = await fetchProviderTotal(provider, cred, periodStart, periodEnd);

  const clientRes = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_calls
     WHERE org_id = $1 AND provider = $2 AND timestamp >= $3 AND timestamp < $4`,
    [orgId, provider, periodStart.toISOString(), periodEnd.toISOString()]
  );
  const clientReportedUsd = parseFloat(clientRes.rows[0].total);

  // Guard the denominator so a near-zero-spend day doesn't produce a
  // meaningless triple-digit deviation % from noise (e.g. $0.0001 vs $0.0003).
  const base = Math.max(providerComputedUsd, 0.01);
  const deviationPct = Math.abs(providerComputedUsd - clientReportedUsd) / base * 100;

  return { providerComputedUsd, clientReportedUsd, deviationPct, source };
}

// Runs daily. Reconciles the trailing 24h for every (org, provider) pair that
// has an admin-level provider credential configured — reconciliation itself
// isn't opt-in (it just records a row), but Discord alerting on top of it is,
// same UX as spend alerts: configure an alert_rules row with
// metric='reconciliation_deviation' to get notified.
async function runReconciliation() {
  try {
    const periodEnd   = new Date();
    const periodStart = new Date(periodEnd);
    periodStart.setDate(periodStart.getDate() - 1);

    // Filtered in SQL, not in the loop: a provider with no billing API must
    // never be picked up at all. Previously every admin credential was fetched
    // and non-Anthropic ones fell through to the OpenAI branch.
    const creds = await pool.query(
      `SELECT DISTINCT ON (org_id, provider) org_id, provider, api_key_encrypted, provider_account_id
       FROM provider_credentials
       WHERE key_type = 'admin' AND provider = ANY($1)
       ORDER BY org_id, provider, created_at DESC`,
      [reconcilableProviders()]
    );

    for (const cred of creds.rows) {
      const { org_id: orgId, provider } = cred;
      let result = { providerComputedUsd: 0, clientReportedUsd: 0, deviationPct: 0, source: null };
      let status = 'ok', errorMessage = null;

      // A provider that needs an account id but has none isn't an error, it's
      // an unfinished setup — indistinguishable from "not configured" to the
      // user. Writing an `error` row here would put a false alarm in the
      // notification bell; the signal the user should see is is_valid=false on
      // the credential itself, which POST /api/credentials/:id/test sets.
      if (requiresAccountId(provider) && !cred.provider_account_id) {
        console.warn(`[reconciliation] ${provider} org ${orgId} skipped: missing provider_account_id`);
        continue;
      }

      try {
        const credential = { apiKey: decrypt(cred.api_key_encrypted), accountId: cred.provider_account_id };
        result = await reconcileOrgProvider(orgId, provider, credential, periodStart, periodEnd);
      } catch (err) {
        status = 'error';
        errorMessage = err.message;
        console.error(`[reconciliation] ${provider} org ${orgId} failed:`, err.message);
      }

      if (status === 'ok') {
        const ruleRes = await pool.query(
          `SELECT * FROM alert_rules
           WHERE org_id = $1 AND metric = 'reconciliation_deviation' AND enabled = true
             AND (provider = $2 OR provider = 'all')
           ORDER BY (provider = $2) DESC LIMIT 1`,
          [orgId, provider]
        );
        const rule = ruleRes.rows[0];

        if (rule) {
          const thresholdPct = parseFloat(rule.threshold_pct ?? DEFAULT_DEVIATION_THRESHOLD_PCT);
          if (result.deviationPct > thresholdPct) {
            status = 'alert';
            const debounceOk = !rule.last_triggered_at ||
              (Date.now() - new Date(rule.last_triggered_at).getTime()) / 3600000 >= (parseInt(rule.debounce_hours, 10) || 6);
            if (debounceOk) {
              const success = await sendReconciliationAlert(
                rule.discord_webhook_url, provider,
                result.providerComputedUsd, result.clientReportedUsd, result.deviationPct, result.source
              );
              await pool.query(
                `INSERT INTO alert_history (org_id, rule_id, provider, current_value, threshold_usd, success)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [orgId, rule.id, provider, result.deviationPct, thresholdPct, success]
              );
              await pool.query(`UPDATE alert_rules SET last_triggered_at = NOW() WHERE id = $1`, [rule.id]);
            }
          }
        }
      }

      await pool.query(
        `INSERT INTO reconciliation_runs
           (org_id, provider, period_start, period_end, provider_computed_usd, client_reported_usd, deviation_pct, status, error_message, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [orgId, provider, periodStart.toISOString(), periodEnd.toISOString(),
         result.providerComputedUsd, result.clientReportedUsd, result.deviationPct, status, errorMessage,
         result.source || 'provider_costs_api']
      );

      console.log(`[reconciliation] org ${orgId} ${provider}: client=$${result.clientReportedUsd.toFixed(4)} provider=$${result.providerComputedUsd.toFixed(4)} (${result.source}) deviation=${result.deviationPct.toFixed(1)}% status=${status}`);
    }
  } catch (err) {
    console.error('[reconciliation] job error:', err.message);
  }
}

module.exports = { runReconciliation, reconcileOrgProvider };
