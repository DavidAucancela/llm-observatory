const crypto  = require('crypto');
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');
const { app, server } = require('../index');
const { resetDb, createOrg, pool } = require('./helpers');

let baseUrl;
const clients = [];

beforeAll(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(resetDb);

afterEach(() => {
  while (clients.length) clients.pop().disconnect();
});

// Resolves with the connected socket, or rejects with the connect_error.
function connect(auth) {
  const socket = ioClient(baseUrl, { transports: ['websocket'], auth, reconnection: false, forceNew: true });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const METRIC = {
  provider: 'anthropic', model: 'claude-sonnet-4-6',
  input_tokens: 10, output_tokens: 5, total_tokens: 15,
  cost_usd: 0.001, latency_ms: 100, status_code: 200,
  prompt_full: 'secret prompt', response_full: 'secret response', system_prompt: 'secret system',
};

describe('Socket.io auth + org scoping', () => {
  it('rejects a connection without a token', async () => {
    await expect(connect({})).rejects.toThrow('unauthorized');
  });

  it('rejects an observatory token (SDK credential, not a dashboard session)', async () => {
    const { obsToken } = await createOrg('Obs Socket');
    await expect(connect({ token: obsToken })).rejects.toThrow('unauthorized');
  });

  it('rejects an invalid JWT', async () => {
    await expect(connect({ token: 'not-a-jwt' })).rejects.toThrow('unauthorized');
  });

  it('rejects a revoked JWT', async () => {
    const { orgId, userId } = await createOrg('Revoked Socket');
    const jti = crypto.randomUUID(); // revoked_tokens isn't truncated by resetDb
    const token = jwt.sign({ id: userId, orgId, role: 'admin', jti }, process.env.JWT_SECRET, { expiresIn: '1h' });
    await pool.query(`INSERT INTO revoked_tokens (jti, exp) VALUES ($1, NOW() + INTERVAL '1 hour')`, [jti]);
    await expect(connect({ token })).rejects.toThrow('unauthorized');
  });

  it('delivers new-metric only to the same org, with no metric content', async () => {
    const orgA = await createOrg('Org A Socket');
    const orgB = await createOrg('Org B Socket');
    const socketA = await connect({ token: orgA.jwt });
    const socketB = await connect({ token: orgB.jwt });

    const receivedB = [];
    socketB.on('new-metric', (m) => receivedB.push(m));
    const gotA = new Promise(resolve => socketA.once('new-metric', resolve));

    const res = await request(app)
      .post('/api/metrics')
      .set('Authorization', `Bearer ${orgA.obsToken}`)
      .send(METRIC);
    expect(res.status).toBe(201);

    const payload = await gotA;
    expect(payload).toEqual({ id: res.body.data.id, provider: 'anthropic', timestamp: expect.any(String) });
    expect(JSON.stringify(payload)).not.toContain('secret');

    // Give a stray cross-org delivery time to arrive before asserting none did.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(receivedB).toEqual([]);
  });
});
