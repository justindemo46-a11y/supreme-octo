// Same assertions run against MemoryStore always, and against PgStore when TEST_DATABASE_URL is set (otherwise reported as SKIPPED).
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('crypto');
const { Engine, MemoryStore } = require('../lib/core');
const stores = [['memory', () => new MemoryStore()]];
const pgUrl = process.env.TEST_DATABASE_URL;
if (pgUrl) { const { PgStore } = require('../lib/pgstore'); stores.push(['postgres', () => PgStore.fromUrl(pgUrl)]); }
else test('postgres store contract', { skip: 'SKIPPED: TEST_DATABASE_URL not set; PgStore is UNVERIFIED' }, () => {});
const uid = () => 'u-' + crypto.randomUUID();
const act = (userId, key, over = {}) => () => ({ id: crypto.randomUUID(), userId, amountMinor: 5000, currency: 'USD', destination: 'acct-friend', purpose: 'p', idempotencyKey: key, state: 'PENDING', paramsHash: 'ph', createdAt: Date.now(), expiresAt: Date.now() + 6e5, ...over });
const ev = (e = 'E', extra = {}) => ({ ts: Date.now(), actor: 'test', event: e, ...extra });

for (const [name, mk] of stores) {
  const S = mk();
  test.after(async () => { if (S.pool) await S.pool.end(); });
  test(`[${name}] getOrCreate: concurrent duplicates -> one row`, async () => {
    const u = uid(), rs = await Promise.all(Array.from({ length: 10 }, () => S.getOrCreate(u, 'key-12345', act(u, 'key-12345'))));
    assert.equal(rs.filter(r => r.created).length, 1); assert.equal(new Set(rs.map(r => r.action.id)).size, 1);
  });
  test(`[${name}] cas: exactly one concurrent winner; invalid transition refused`, async () => {
    const u = uid(), { action } = await S.getOrCreate(u, 'key-cas-1', act(u, 'key-cas-1')); assert.ok(await S.cas(action.id, 'PENDING', 'APPROVED', { approval: { x: 1 } }, ev('A')));
    const rs = await Promise.all(Array.from({ length: 6 }, () => S.cas(action.id, 'APPROVED', 'VALIDATING', {}, ev('V'))));
    assert.equal(rs.filter(Boolean).length, 1); assert.equal(await S.cas(action.id, 'VALIDATING', 'PENDING'), null); assert.equal(await S.cas(action.id, 'COMPLETED', 'PENDING'), null);
    assert.equal((await S.get(action.id)).state, 'VALIDATING'); assert.deepEqual((await S.get(action.id)).approval, { x: 1 });
  });
  test(`[${name}] cas writes audit + accounting entry atomically; failed cas writes neither`, async () => {
    const u = uid(), { action } = await S.getOrCreate(u, 'key-atom-1', act(u, 'key-atom-1')), before = (await S.recentAudit(1000000)).length;
    assert.equal(await S.cas(action.id, 'EXECUTING', 'COMPLETED', {}, ev('NOPE')), null);
    assert.equal((await S.recentAudit(1000000)).length, before);
    await S.cas(action.id, 'PENDING', 'APPROVED', {}, ev('A')); await S.cas(action.id, 'APPROVED', 'VALIDATING'); await S.cas(action.id, 'VALIDATING', 'EXECUTING');
    const entry = { id: crypto.randomUUID(), actionId: action.id, type: 'PAYMENT', amountMinor: -5000, currency: 'USD', source: 'REAL_PROVIDER_DATA', providerTxId: 'tx1', ts: Date.now() };
    assert.ok(await S.cas(action.id, 'EXECUTING', 'COMPLETED', { result: { ok: 1 } }, ev('DONE', { actionId: action.id }), entry));
    assert.ok((await S.recentAudit(1000000)).some(a => a.event === 'DONE' && a.actionId === action.id));
    if (S.entries) assert.equal(S.entries.filter(e => e.actionId === action.id).length, 1);
  });
  test(`[${name}] audit chain stays valid under concurrent appends`, async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => S.appendAudit(ev('C' + i)))); assert.equal(await S.verifyChain(), true);
  });
  test(`[${name}] incFails is atomic; exposure sums reserved and today's spend`, async () => {
    const u = uid(); const ns = await Promise.all(Array.from({ length: 8 }, () => S.incFails(u))); assert.equal(Math.max(...ns.map(Number)), 8); await S.resetFails(u); assert.equal(Number(await S.incFails(u)), 1);
    const a = await S.getOrCreate(u, 'key-exp-1', act(u, 'key-exp-1')); await S.cas(a.action.id, 'PENDING', 'APPROVED', {}, ev('A'));
    const d = new Date(), dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    assert.deepEqual(await S.exposure(u, null, dayStart), { reservedMinor: 5000, spentTodayMinor: 5000 }); assert.deepEqual(await S.exposure(u, a.action.id, dayStart), { reservedMinor: 0, spentTodayMinor: 0 });
    await S.setMode(u, 'LOCKDOWN'); assert.equal(await S.getMode(u), 'LOCKDOWN'); assert.equal(await S.getMode(uid()), 'NORMAL');
  });
  test(`[${name}] engine end-to-end on this store (SIMULATED provider)`, async () => {
    const u = uid(); let calls = 0;
    const provider = { name: 'sim', capabilities: () => ({ createPayment: 'SUPPORTED' }), getBalance: async () => ({ status: 'OK', minor: 100000, currency: 'USD', asOf: Date.now(), source: 'REAL_PROVIDER_DATA' }), createPayment: async () => ({ status: 'CONFIRMED', providerTxId: 'tx' + ++calls }) };
    const e = new Engine({ store: S, provider }); await e.setLimits(u, { maxAmountMinor: 20000, dailyLimitMinor: 30000, minReserveMinor: 10000, allowedCurrencies: ['USD'], allowedDestinations: ['acct-friend'] }, 'r');
    const a = await e.create(u, { amountMinor: 5000, currency: 'USD', destination: 'acct-friend', purpose: 'x', idempotencyKey: 'e2e-' + crypto.randomUUID() }, 'r'); assert.equal(a.state, 'PENDING');
    await assert.rejects(e.execute(u, a.id, 'r'), x => x.code === 'NO_APPROVAL');
    await e.approve(u, a.id, { paramsHash: a.paramsHash }, 'r');
    await Promise.all(Array.from({ length: 5 }, () => e.execute(u, a.id, 'r').catch(() => 0)));
    assert.equal(calls, 1); const fresh = await new Engine({ store: S, provider }).own(u, a.id); assert.equal(fresh.state, 'COMPLETED'); assert.equal(await S.verifyChain(), true);
    await assert.rejects(new Engine({ store: S, provider }).own('someone-else', a.id), x => x.code === 'NOT_FOUND');
  });
  if (name === 'postgres') test('[postgres] DB itself refuses audit mutation and invalid transitions', async () => {
    await assert.rejects(S.pool.query("UPDATE audit_events SET actor='x'"), /append-only/); await assert.rejects(S.pool.query('DELETE FROM audit_events'), /append-only/);
    const u = uid(), { action } = await S.getOrCreate(u, 'key-db-1', act(u, 'key-db-1')); await assert.rejects(S.pool.query("UPDATE actions SET state='COMPLETED' WHERE id=$1", [action.id]), /invalid transition/);
  });
}
