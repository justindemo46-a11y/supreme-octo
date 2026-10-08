const crypto = require('crypto');
const { Engine, MemoryStore, UnsupportedProvider, SafeError } = require('../lib/core');
let engine; const hits = new Map();
const eq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const getEngine = () => engine || (engine = new Engine({ store: process.env.DATABASE_URL ? require('../lib/pgstore').PgStore.fromUrl(process.env.DATABASE_URL) : new MemoryStore(), provider: new UnsupportedProvider() }));
const view = a => a && ({ id: a.id, state: a.state, amountMinor: a.amountMinor, currency: a.currency, destination: a.destination, purpose: a.purpose, paramsHash: a.paramsHash, risk: a.risk, result: a.result, reconciliationRequired: a.reconciliationRequired, sourceClass: 'USER_INPUT' });
module.exports = async (req, res) => {
  const rid = crypto.randomUUID(); res.setHeader('X-Request-Id', rid); res.setHeader('Cache-Control', 'no-store');
  const send = (c, b) => res.status(c).json({ requestId: rid, ...b });
  try {
    const token = process.env.APP_API_TOKEN, user = process.env.APP_USER_ID;
    if (!token || token.length < 32 || !user) return send(503, { error: 'AUTH_NOT_CONFIGURED' });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m || !eq(m[1], token)) return send(401, { error: 'UNAUTHENTICATED' });
    const ip = req.headers['x-forwarded-for'] || 'x', now = Date.now(), w = (hits.get(ip) || []).filter(t => now - t < 60e3);
    w.push(now); hits.set(ip, w); if (w.length > 30) return send(429, { error: 'RATE_LIMITED' });
    if (!process.env.DATABASE_URL && process.env.ALLOW_EPHEMERAL_STORE !== '1') return send(503, { error: 'STORE_UNSUPPORTED', note: 'Set DATABASE_URL (Postgres). Writes are disabled without a persistent store.' });
    const e = getEngine();
    if (req.method === 'GET') return send(200, { store: e.store.kind, actions: (await e.store.listByUser(user, 100)).map(view), audit: await e.store.recentAudit(50), mode: await e.store.getMode(user) });
    if (req.method !== 'POST') return send(405, { error: 'METHOD_NOT_ALLOWED' });
    const b = req.body || {};
    const ops = {
      create: () => e.create(user, b, rid).then(view), approve: () => e.approve(user, b.actionId, b, rid).then(view),
      cancel: () => e.cancel(user, b.actionId, rid).then(view), execute: () => e.execute(user, b.actionId, rid).then(view),
      set_limits: async () => { await e.setLimits(user, b.limits, rid); return { ok: true }; }, clear_lockdown: async () => { await e.clearLockdown(user, rid); return { ok: true }; },
    };
    if (!Object.hasOwn(ops, b.op)) return send(400, { error: 'INVALID_REQUEST' });
    return send(200, { result: await ops[b.op]() });
  } catch (err) {
    if (err instanceof SafeError) return send(err.code === 'NOT_FOUND' ? 404 : 409, { error: err.code, detail: err.detail });
    console.error(JSON.stringify({ rid, error: err.message })); return send(500, { error: 'INTERNAL' });
  }
};
