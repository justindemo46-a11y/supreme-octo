const test = require('node:test'), assert = require('node:assert/strict');
const { Engine, MemoryStore, UnsupportedProvider, SafeError } = require('../lib/core');
const T0 = Date.UTC(2026, 9, 8, 12);
// SIMULATED provider: exists only in tests to exercise the execution path. Never imported by api/.
class SimProvider {
  constructor(o = {}) { this.name = 'sim'; this.calls = 0; this.o = { balance: 100000, mode: 'ok', ...o }; }
  capabilities() { return { createPayment: 'SUPPORTED' }; }
  async getBalance() { return { status: 'OK', minor: this.o.balance, currency: 'USD', asOf: this.o.asOf ?? T0, source: 'REAL_PROVIDER_DATA' }; }
  async createPayment() { this.calls++; if (this.o.mode === 'timeout') return new Promise(() => {}); if (this.o.mode === 'throw') throw new Error('boom'); if (this.o.mode === 'unsupported') return { status: 'UNSUPPORTED' }; return { status: 'CONFIRMED', providerTxId: 'tx' + this.calls }; }
}
const LIM = { maxAmountMinor: 20000, dailyLimitMinor: 30000, minReserveMinor: 10000, allowedCurrencies: ['USD'], allowedDestinations: ['acct-friend'] };
const P = (n = 1, o = {}) => ({ amountMinor: 5000, currency: 'USD', destination: 'acct-friend', purpose: 'test', idempotencyKey: 'key-0000' + n, ...o });
function mk(po, cfg, limits = LIM) { const store = new MemoryStore(), provider = new SimProvider(po), now = { t: T0 }; const e = new Engine({ store, provider, clock: () => now.t, cfg: { providerTimeoutMs: 30, ...cfg } }); if (limits) store.setLimits('u', limits); return { e, store, provider, now }; }
const approved = async (x, p = P()) => { const a = await x.e.create('u', p, 'r'); await x.e.approve('u', a.id, { paramsHash: a.paramsHash }, 'r'); return a; };
const blocked = (a, code) => assert.ok(a.state === 'REJECTED' && a.result.reasons.includes(code), JSON.stringify(a.result));
const rejects = (p, code) => assert.rejects(p, e => e instanceof SafeError && e.code === code);

test('no approval -> execution blocked', async () => { const x = mk(); const a = await x.e.create('u', P(), 'r'); await rejects(x.e.execute('u', a.id, 'r'), 'NO_APPROVAL'); assert.equal(x.provider.calls, 0); });
test('happy path completes, accounting references action, audit chain', async () => {
  const x = mk(); const a = await approved(x); const r = await x.e.execute('u', a.id, 'r');
  assert.equal(r.state, 'COMPLETED'); assert.equal(x.store.entries[0].actionId, a.id); assert.equal(x.store.entries[0].source, 'REAL_PROVIDER_DATA');
  const states = x.store.log.filter(l => l.event === 'STATE_CHANGE').map(l => l.next); assert.deepEqual(states, ['APPROVED', 'VALIDATING', 'EXECUTING', 'COMPLETED']);
  x.store.log.forEach((l, i) => assert.equal(l.prevHash, i ? x.store.log[i - 1].hash : '0')); assert.throws(() => { 'use strict'; x.store.log[0].event = 'x'; });
});
test('expired approval -> blocked', async () => { const x = mk(); const a = await approved(x); x.now.t += 11 * 60e3; x.provider.o.asOf = x.now.t; await rejects(x.e.execute('u', a.id, 'r'), 'EXECUTION_BLOCKED'); blocked(x.store.get(a.id), 'APPROVAL_EXPIRED'); assert.equal(x.provider.calls, 0); });
test('params modified after approval -> blocked', async () => { const x = mk(); const a = await approved(x); x.store.get(a.id).amountMinor = 9000; await rejects(x.e.execute('u', a.id, 'r'), 'EXECUTION_BLOCKED'); blocked(x.store.get(a.id), 'PARAMS_CHANGED_AFTER_APPROVAL'); assert.equal(x.provider.calls, 0); });
test('wrong paramsHash on approve -> refused', async () => { const x = mk(); const a = await x.e.create('u', P(), 'r'); await rejects(x.e.approve('u', a.id, { paramsHash: 'bad' }, 'r'), 'PARAMS_MISMATCH'); });
test('amount above limit -> blocked', async () => blocked(await mk().e.create('u', P(1, { amountMinor: 25000 }), 'r'), 'AMOUNT_ABOVE_LIMIT'));
test('insufficient balance -> blocked', async () => blocked(await mk({ balance: 3000 }).e.create('u', P(), 'r'), 'INSUFFICIENT_BALANCE'));
test('min reserve -> blocked', async () => blocked(await mk({ balance: 12000 }).e.create('u', P(), 'r'), 'BELOW_MIN_RESERVE'));
test('stale balance -> blocked', async () => blocked(await mk({ asOf: T0 - 6 * 60e3 }).e.create('u', P(), 'r'), 'BALANCE_STALE'));
test('invalid / non-allowlisted destination -> blocked', async () => { const x = mk(); blocked(await x.e.create('u', P(1, { destination: 'bad dest!' }), 'r'), 'INVALID_DESTINATION'); blocked(await x.e.create('u', P(2, { destination: 'acct-other' }), 'r'), 'DESTINATION_NOT_ALLOWED'); });
test('no limits configured -> fail closed', async () => blocked(await mk({}, {}, null).e.create('u', P(), 'r'), 'LIMITS_NOT_CONFIGURED'));
test('daily limit counts reserved/completed', async () => { const x = mk(); await approved(x, P(1, { amountMinor: 20000 })); blocked(await x.e.create('u', P(2, { amountMinor: 15000 }), 'r'), 'DAILY_LIMIT'); });
test('lockdown blocks create and pre-execution', async () => { const x = mk(); const a = await approved(x); x.store.setMode('u', 'LOCKDOWN'); await rejects(x.e.execute('u', a.id, 'r'), 'EXECUTION_BLOCKED'); blocked(x.store.get(a.id), 'LOCKDOWN'); blocked(await x.e.create('u', P(2), 'r'), 'LOCKDOWN'); });
test('unsupported provider -> UNSUPPORTED, never success', async () => {
  const e = new Engine({ store: new MemoryStore(), provider: new UnsupportedProvider() }); await e.setLimits('u', LIM, 'r'); const a = await e.create('u', P(), 'r'); blocked(a, 'PROVIDER_UNSUPPORTED'); blocked(a, 'BALANCE_UNAVAILABLE');
  assert.equal((await new UnsupportedProvider().createPayment()).status, 'UNSUPPORTED');
  const x = mk({ mode: 'unsupported' }); const b = await approved(x); assert.equal((await x.e.execute('u', b.id, 'r')).state, 'FAILED'); assert.equal(x.store.entries.length, 0);
});
test('duplicate idempotency key -> same action, one provider call', async () => { const x = mk(); const a = await approved(x); const b = await x.e.create('u', P(), 'r'); assert.equal(a.id, b.id); await x.e.execute('u', a.id, 'r'); await x.e.execute('u', a.id, 'r'); assert.equal(x.provider.calls, 1); assert.equal(x.store.entries.length, 1); });
test('concurrent duplicate creates -> one action; concurrent executes -> one payment', async () => {
  const x = mk(); const rs = await Promise.all(Array.from({ length: 10 }, () => x.e.create('u', P(), 'r'))); assert.equal(new Set(rs.map(r => r.id)).size, 1); assert.equal(x.store.actions.size, 1);
  const a = rs[0]; await x.e.approve('u', a.id, { paramsHash: a.paramsHash }, 'r'); await Promise.all(Array.from({ length: 6 }, () => x.e.execute('u', a.id, 'r').catch(() => 0))); assert.equal(x.provider.calls, 1); assert.equal(x.store.entries.length, 1);
});
test('invalid transitions blocked', async () => { const x = mk(); const a = await approved(x); await x.e.execute('u', a.id, 'r'); await rejects(x.e.approve('u', a.id, { paramsHash: a.paramsHash }, 'r'), 'INVALID_TRANSITION'); await rejects(x.e.cancel('u', a.id, 'r'), 'INVALID_TRANSITION'); assert.equal(x.store.cas(a.id, 'COMPLETED', 'PENDING'), null); });
test('provider error -> FAILED, reconciliation flagged, no accounting', async () => { const x = mk({ mode: 'throw' }); const a = await approved(x); const r = await x.e.execute('u', a.id, 'r'); assert.equal(r.state, 'FAILED'); assert.ok(r.reconciliationRequired); assert.equal(x.store.entries.length, 0); });
test('provider timeout -> FAILED (not success), repeated failures -> LOCKDOWN', async () => {
  const x = mk({ mode: 'timeout' }, { lockdownAfterFailures: 2 }, { ...LIM, dailyLimitMinor: 1e6 });
  for (let i = 1; i <= 2; i++) { const a = await approved(x, P(i)); const r = await x.e.execute('u', a.id, 'r'); assert.equal(r.state, 'FAILED'); assert.equal(r.result.reasons[0], 'PROVIDER_TIMEOUT'); assert.ok(r.reconciliationRequired); }
  assert.equal(x.store.getMode('u'), 'LOCKDOWN'); await x.e.clearLockdown('u', 'r'); assert.equal(x.store.getMode('u'), 'NORMAL');
});
test('storage failure after provider confirm -> no false success', async () => { const x = mk(); const a = await approved(x); const orig = x.store.cas.bind(x.store); x.store.cas = (id, f, t, ...r) => { if (t === 'COMPLETED') throw new Error('db down'); return orig(id, f, t, ...r); }; await rejects(x.e.execute('u', a.id, 'r'), 'PERSISTENCE_FAILURE_RECONCILIATION_REQUIRED'); assert.notEqual(x.store.get(a.id).state, 'COMPLETED'); assert.ok(x.store.get(a.id).reconciliationRequired); });
test('authorization: other user cannot see/approve/execute', async () => { const x = mk(); const a = await x.e.create('u', P(), 'r'); for (const f of [() => x.e.approve('v', a.id, { paramsHash: a.paramsHash }, 'r'), () => x.e.execute('v', a.id, 'r'), () => x.e.cancel('v', a.id, 'r')]) await rejects(f(), 'NOT_FOUND'); });
test('validation: bad inputs rejected', async () => { const x = mk(); for (const bad of [P(1, { amountMinor: -5 }), P(1, { amountMinor: 1.5 }), P(1, { currency: 'usd' }), P(1, { idempotencyKey: 'x' }), null]) await rejects(x.e.create('u', bad, 'r'), 'INVALID_REQUEST'); });
test('API: auth failures and fail-closed store', async () => {
  const api = require('../api/actions'); const mkRes = () => { const r = { h: {}, setHeader(k, v) { r.h[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  process.env.APP_API_TOKEN = 't'.repeat(40); process.env.APP_USER_ID = 'owner'; delete process.env.ALLOW_EPHEMERAL_STORE;
  let r = mkRes(); await api({ method: 'POST', headers: {} }, r); assert.equal(r.code, 401);
  r = mkRes(); await api({ method: 'POST', headers: { authorization: 'Bearer wrong' } }, r); assert.equal(r.code, 401);
  r = mkRes(); await api({ method: 'POST', headers: { authorization: 'Bearer ' + 't'.repeat(40) }, body: { op: 'create' } }, r); assert.equal(r.code, 503); assert.equal(r.body.error, 'STORE_UNSUPPORTED');
  delete process.env.APP_API_TOKEN; r = mkRes(); await api({ method: 'GET', headers: {} }, r); assert.equal(r.code, 503);
});
