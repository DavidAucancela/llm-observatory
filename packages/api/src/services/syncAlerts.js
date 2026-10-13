// Discord side of the sync notifications. The bell side needs no code here: it
// reads sync_logs rows whose `details` carry `alert` / `new_skipped_models`
// (routes/notifications.js).
//
// There's no org-level Discord setting — the webhook lives on alert rules — so
// a sync alert goes to the org's enabled rule for that provider, else its
// 'all' rule, else any enabled rule. No rule → bell only.

const pool = require('../db/pool');

async function orgDiscordWebhook(orgId, provider) {
  const r = await pool.query(
    `SELECT discord_webhook_url FROM alert_rules
     WHERE org_id = $1 AND enabled = true AND discord_webhook_url IS NOT NULL
     ORDER BY (provider = $2) DESC, (provider = 'all') DESC, id
     LIMIT 1`,
    [orgId, provider]
  );
  return r.rows[0]?.discord_webhook_url || null;
}

const COLOR = { error: 15158332, warning: 16744272 };

// Returns true (sent), false (send failed) or null (no webhook configured).
async function sendSyncDiscordAlert(orgId, provider, { title, description, fields = [], severity = 'warning' }) {
  const url = await orgDiscordWebhook(orgId, provider);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title, description, fields, color: COLOR[severity] || COLOR.warning,
          footer: { text: 'LLM Observatory — Sincronización' },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    return res.ok;
  } catch (err) {
    console.error('[sync] Discord webhook error:', err.message);
    return false;
  }
}

module.exports = { orgDiscordWebhook, sendSyncDiscordAlert };
