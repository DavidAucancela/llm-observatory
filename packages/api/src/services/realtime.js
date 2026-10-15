const jwt  = require('jsonwebtoken');
const pool = require('../db/pool');

// Socket.io is tenant-scoped: every connection must present a dashboard JWT
// (handshake `auth.token`) and is joined to its org's room. Events go to that
// room only — never `io.emit` — and carry no metric content: a broadcast of the
// inserted api_calls row used to hand every connected client (authenticated or
// not) every org's prompts and responses. Clients refetch over the REST API,
// which is where org scoping lives.

const orgRoom = (orgId) => `org:${orgId}`;

async function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token;
  // Observatory tokens identify an SDK, not a dashboard viewer.
  if (typeof token !== 'string' || !token || token.startsWith('obs_sk_')) {
    return next(new Error('unauthorized'));
  }
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return next(new Error('unauthorized'));
  }
  if (!decoded.orgId) return next(new Error('unauthorized'));
  if (decoded.jti) {
    try {
      const revoked = await pool.query('SELECT 1 FROM revoked_tokens WHERE jti = $1', [decoded.jti]);
      if (revoked.rows.length) return next(new Error('unauthorized'));
    } catch {
      // Same fail-open as the HTTP auth middleware when the lookup errors.
    }
  }
  socket.data.orgId = decoded.orgId;
  socket.join(orgRoom(decoded.orgId));
  next();
}

function emitToOrg(io, orgId, event, payload) {
  if (!io || !orgId) return;
  io.to(orgRoom(orgId)).emit(event, payload);
}

// The dashboard only needs to know *that* something landed; it refetches the
// summary itself. Keep this free of prompt/response/cost/key data.
function metricEvent(row) {
  return { id: row.id, provider: row.provider, timestamp: row.timestamp };
}

function emitNewMetric(req, row) {
  emitToOrg(req.app.get('io'), row.org_id, 'new-metric', metricEvent(row));
}

module.exports = { socketAuth, emitToOrg, emitNewMetric, metricEvent, orgRoom };
