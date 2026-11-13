// Starts the API for the Playwright run on its own database, so E2E never
// touches the dev DB: creates `llm_observatory_e2e` if missing, applies the
// schema, loads the demo org (seed:demo — idempotent) and serves on E2E_API_PORT.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const root   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const apiDir = path.join(root, 'packages/api');

// Local runs reuse the repo's .env (DB password etc.); CI passes env directly.
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const base = new URL(process.env.DATABASE_URL || 'postgresql://postgres:changeme@localhost:5432/llm_observatory');
const dbUrl = new URL(base);
dbUrl.pathname = '/llm_observatory_e2e';

const admin = new pg.Client({ connectionString: Object.assign(new URL(base), { pathname: '/postgres' }).toString() });
await admin.connect();
const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['llm_observatory_e2e']);
if (!rowCount) await admin.query('CREATE DATABASE llm_observatory_e2e');
await admin.end();

const env = {
  ...process.env,
  DATABASE_URL: dbUrl.toString(),
  PORT: process.env.E2E_API_PORT || '3101',
  NODE_ENV: 'test',
  AUTO_SYNC_ENABLED: 'false',
  JWT_SECRET: process.env.JWT_SECRET || '00'.repeat(64),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '00'.repeat(32),
};

for (const script of ['src/db/migrate.js', 'src/db/seed-demo.js']) {
  execFileSync(process.execPath, [script], { cwd: apiDir, env, stdio: 'inherit' });
}

const api = spawn(process.execPath, ['src/index.js'], { cwd: apiDir, env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => api.kill(sig));
api.on('exit', code => process.exit(code ?? 0));
