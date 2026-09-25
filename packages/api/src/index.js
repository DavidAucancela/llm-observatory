const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

// ── Validate required environment variables before anything else ───────────────
const required = ['DATABASE_URL', 'ENCRYPTION_KEY', 'JWT_SECRET'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const cron = require('node-cron');
const { Server } = require('socket.io');
const pool = require('./db/pool');
const { retentionDays } = require('./utils/retention');
const logger = require('./logger');
const { authMiddleware } = require('./middleware/auth');

const authRouter        = require('./routes/auth');
const metricsRouter     = require('./routes/metrics');
const budgetsRouter     = require('./routes/budgets');
const balancesRouter    = require('./routes/balances');
const credentialsRouter = require('./routes/credentials');
const providersRouter   = require('./routes/providers');
const alertsRouter      = require('./routes/alerts');
const syncRouter        = require('./routes/sync');
const tokensRouter      = require('./routes/tokens');
const teamRouter        = require('./routes/team');
const webhooksRouter    = require('./routes/webhooks');
const reconciliationRouter = require('./routes/reconciliation');
const insightsRouter    = require('./routes/insights');
const notificationsRouter = require('./routes/notifications');
const evaluationsRouter = require('./routes/evaluations');
const { checkAlerts }   = require('./jobs/alertChecker');
const { runReconciliation } = require('./jobs/reconciliation');
const { seedDemo }      = require('./db/seed-demo');

const app = express();
const server = http.createServer(app);

// Trust Railway/nginx reverse proxy so express-rate-limit reads the real client IP
// from X-Forwarded-For instead of the internal proxy address
app.set('trust proxy', 1);

// CORS origin: restrict in production via CORS_ORIGIN env var
const corsOrigin = process.env.CORS_ORIGIN || '*';
const io = new Server(server, { cors: { origin: corsOrigin, methods: ['GET', 'POST'] } });

// Security headers
app.use(helmet());

// CORS
app.use(cors({ origin: corsOrigin }));
// Default 100kb is too small once metrics include full prompt/response text
// (prompt_full + response_full + tool_calls can approach ~50kb combined, more
// once JSON-escaped) — see POST /api/metrics in routes/metrics.js.
app.use(express.json({ limit: '1mb' }));
app.set('io', io);

// ── Rate limiters ─────────────────────────────────────────────────────────────
// General API: 1000 req/min per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Metrics ingest (SDK fire-and-forget): 1 000 req/min per IP
// High limit allows bursts from apps under load; still prevents runaway loops
const metricsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Metrics rate limit exceeded.' },
});

app.use('/api', generalLimiter);
app.use('/api/metrics', metricsLimiter);

// ── Auth middleware (applies to all routes; exceptions are defined inside) ─────
app.use(authMiddleware);

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.use('/api/auth', authRouter);
app.use('/api/metrics', metricsRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/balances', balancesRouter);
app.use('/api/credentials', credentialsRouter);
app.use('/api/providers', providersRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/sync', syncRouter);
app.use('/api/tokens', tokensRouter);
app.use('/api/team', teamRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/reconciliation', reconciliationRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/evaluations', evaluationsRouter);

// ── 404 handler — must be after all routes ────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(err.message, err.stack);
  const message = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
  res.status(500).json({ error: message });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info('Client connected:', socket.id);
  socket.on('disconnect', () => logger.info('Client disconnected:', socket.id));
});

// ── Start server ──────────────────────────────────────────────────────────────
async function startServer() {
  const port = process.env.PORT || 3001;

  try {
    const fs = require('fs');
    const sql = fs.readFileSync(path.join(__dirname, 'db/schema.sql'), 'utf8');
    await pool.query(sql);
    logger.info('✅ Database schema ready');
  } catch (err) {
    logger.error('DB migration failed:', err.message);
  }

  // Clean up orphan test/sync records per org (no credentials in that org)
  try {
    const r1 = await pool.query(
      `DELETE FROM api_calls ac
       WHERE ac.prompt_preview = 'test:sdk_integration'
       AND NOT EXISTS (
         SELECT 1 FROM provider_credentials pc
         WHERE pc.provider = ac.provider AND pc.org_id = ac.org_id
       )`
    );
    const r2 = await pool.query(
      `DELETE FROM api_calls ac
       WHERE ac.prompt_preview LIKE 'sync:%'
       AND NOT EXISTS (
         SELECT 1 FROM provider_credentials pc
         WHERE pc.provider = ac.provider AND pc.key_type = 'admin' AND pc.org_id = ac.org_id
       )`
    );
    if (r1.rowCount + r2.rowCount > 0)
      logger.info(`🧹 Cleaned ${r1.rowCount + r2.rowCount} orphan records`);
  } catch (err) {
    logger.error('Orphan cleanup failed:', err.message);
  }

  if (process.env.AUTH_EMAIL && process.env.AUTH_PASSWORD_HASH) {
    try {
      const userRes = await pool.query(
        `INSERT INTO users (email, password_hash, role, is_active)
         VALUES ($1, $2, 'admin', true)
         ON CONFLICT (email) DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           role          = EXCLUDED.role,
           is_active     = EXCLUDED.is_active
         RETURNING id`,
        [process.env.AUTH_EMAIL, process.env.AUTH_PASSWORD_HASH]
      );
      const userId = userRes.rows[0].id;

      const memberCheck = await pool.query(
        'SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      if (!memberCheck.rows.length) {
        const slug = process.env.AUTH_EMAIL.split('@')[0].toLowerCase()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
          + '-' + Date.now();
        const orgRes = await pool.query(
          `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
          [process.env.AUTH_EMAIL + "'s Organization", slug]
        );
        await pool.query(
          `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`,
          [orgRes.rows[0].id, userId]
        );
      }
      logger.info(`✅ Admin user synced: ${process.env.AUTH_EMAIL}`);
    } catch (err) {
      logger.error('Admin user setup failed:', err.message);
    }
  }

  // Cron: clean up expired revoked JWT tokens every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    pool.query('DELETE FROM revoked_tokens WHERE exp < NOW()').catch(() => {});
  });

  // Cron: check alerts every hour
  cron.schedule('0 * * * *', () => {
    logger.info('Running scheduled alert check...');
    checkAlerts();
  });

  // Cron: reconcile client-reported cost against provider token-usage APIs at 03:30 daily
  cron.schedule('30 3 * * *', () => {
    logger.info('Running scheduled cost reconciliation...');
    runReconciliation();
  });

  // Cron: data retention — delete records older than DATA_RETENTION_DAYS (default 90) at 02:00 daily
  cron.schedule('0 2 * * *', async () => {
    const days = retentionDays();
    try {
      const result = await pool.query(
        `DELETE FROM api_calls WHERE timestamp < NOW() - ($1 || ' days')::interval`,
        [days]
      );
      if (result.rowCount > 0) logger.info(`Data retention: deleted ${result.rowCount} records older than ${days} days`);
    } catch (err) {
      logger.error('Data retention job failed:', err.message);
    }
  });

  // Cron: refresh demo showcase data weekly (Mondays 05:00) — only if the demo org exists
  cron.schedule('0 5 * * 1', async () => {
    try {
      const demo = await pool.query(`SELECT 1 FROM organizations WHERE slug = 'demo'`);
      if (demo.rowCount === 0) return;
      logger.info('Refreshing demo org data...');
      await seedDemo();
      logger.info('Demo org data refreshed');
    } catch (err) {
      logger.error('Demo refresh failed:', err.message);
    }
  });

  server.listen(port, () => logger.info(`🚀 API server running on port ${port}`));
}

if (require.main === module) startServer();

module.exports = { app, server };
