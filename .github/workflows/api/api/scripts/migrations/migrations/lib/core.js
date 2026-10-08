'use strict';
const crypto = require('crypto');
const h = s => crypto.createHash('sha256').update(s).digest('hex');
const TRANSITIONS = {
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  APPROVED: ['VALIDATING', 'CANCELLED', 'EXPIRED'],
  VALIDATING: ['EXECUTING', 'REJECTED', 'FAILED'],
  EXECUTING: ['COMPLETED', 'FAILED'],
  COMPLETED: [], REJECTED: [], FAILED: [], CANCELLED: [], EXPIRED: [],
};
const RESERVING = ['APPROVED', 'VALIDATING', 'EXECUTING'];
class SafeError extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }

// ---- Provider abstraction: nothing is connected, everything is UNSUPPORTED ----
const METHODS = ['getBalance', 'getTransactions', 'getAccountInfo', 'createPayment', 'getPaymentStatus', 'cancelPayment'];
class UnsupportedProvider {
  constructor() { this.name = 'none'; for (const m of METHODS) this[m] = async () => ({ status: 'UNSUPPORTED', method: m }); }
  capabilities() { return Object.fromEntries(METHODS.map(m => [m, 'UNSUPPORTED'])); }
}

// ---- Store contract: every method may be sync (MemoryStore) or async (PgStore); the Engine always awaits. ----
// cas() = atomic compare-and-set of state; the audit event and accounting entry are written in the SAME atomic unit.
class MemoryStore {
  constructor() { this.kind = 'EPHEMERAL_MEMORY'; this.actions = new Map(); this.keys = new Map(); this.log = []; this.payloads = []; this.entries = []; this.limits = new Map(); this.modes = new Map(); this.fails = new Map(); }
  getOrCreate(userId, key, build) { // synchronous = atomic
    const k = userId + ':' + key;
    if (this.keys.has(k)) return { action: this.actions.get(this.keys.get(k)), created: false };
    const a = build(); this.actions.set(a.id, a); this.keys.set(k, a.id); return { action: a, created: true };
  }
  get(id) { return this.actions.get(id); }
  listByUser(u, limit = 100) { return [...this.actions.values()].filter(a => a.userId === u).slice(-limit); }
  cas(id, from, to, patch = {}, ev, entry) {
    const a = this.actions.get(id);
    if (!a || a.state !== from || !TRANSITIONS[from].includes(to)) return null;
    Object.assign(a, patch, { state: to, updatedAt: Date.now() });
    if (entry) this.entries.push(Object.freeze(entry));
    if (ev) this.appendAudit(ev);
    return a;
  }
  patch(id, patch) { Object.assign(this.actions.get(id), patch); }
  exposure(u, excludeId, dayStart) {
    const acts = this.listByUser(u, 1e9).filter(x => x.id !== excludeId), sum = f => acts.filter(f).reduce((s, x) => s + x.amountMinor, 0);
    return { reservedMinor: sum(x => RESERVING.includes(x.state)), spentTodayMinor: sum(x => (x.state === 'COMPLETED' || RESERVING.includes(x.state)) && x.createdAt >= dayStart && x.createdAt < dayStart + 864e5) };
  }
  appendAudit(e) {
    const prevHash = this.log.length ? this.log[this.log.length - 1].hash : '0', payload = JSON.stringify(e);
    const r = Object.freeze({ ...e, seq: this.log.length + 1, prevHash, hash: h(prevHash + payload) });
    this.log.push(r); this.payloads.push(payload); return r;
  }
  recentAudit(n) { return this.log.slice(-n); }
  verifyChain() { let p = '0'; return this.log.every((r, i) => { const ok = r.prevHash === p && r.hash === h(p + this.payloads[i]); p = r.hash; return ok; }); }
  getLimits(u) { return this.limits.get(u) || null; }
  setLimits(u, l) { this.limits.set(u, l); }
  getMode(u) { return this.modes.get(u) || 'NORMAL'; }
  setMode(u, m) { this.modes.set(u, m); }
  incFails(u) { const n = (this.fails.get(u) || 0) + 1; this.fails.set(u, n); return n; }
  resetFails(u) { this.fails.set(u, 0); }
}

// ---- Risk engine (pure): ALLOW / WARN / BLOCK with machine-readable reasons ----
function evaluateRisk(a, c) {
  const block = [], warn = [];
  const L = c.limits;
  if (!L) block.push('LIMITS_NOT_CONFIGURED');
  if (c.mode === 'LOCKDOWN') block.push('LOCKDOWN');
  if (c.mode === 'EMERGENCY') block.push('EMERGENCY_MODE');
  if (c.providerCaps.createPayment !== 'SUPPORTED') block.push('PROVIDER_' + (c.providerCaps.createPayment || 'UNKNOWN'));
  const b = c.balance;
  if (!b || b.status !== 'OK') block.push('BALANCE_UNAVAILABLE');
  else {
    if (b.source !== 'REAL_PROVIDER_DATA') block.push('BALANCE_NOT_PROVIDER_DATA');
    const age = c.now - b.asOf;
    if (!(age >= 0) || age > c.maxBalanceAgeMs) block.push('BALANCE_STALE');
    else if (age > c.maxBalanceAgeMs / 2) warn.push('BALANCE_AGING');
    if (b.currency !== a.currency) block.push('CURRENCY_MISMATCH');
    const avail = b.minor - c.reservedMinor;
    if (a.amountMinor > avail) block.push('INSUFFICIENT_BALANCE');
    else if (L && avail - a.amountMinor < L.minReserveMinor) block.push('BELOW_MIN_RESERVE');
    if (a.amountMinor > avail * 0.5) warn.push('LARGE_SHARE_OF_BALANCE');
  }
  if (L) {
    if (!(a.amountMinor <= L.maxAmountMinor)) block.push('AMOUNT_ABOVE_LIMIT');
    if (c.spentTodayMinor + a.amountMinor > L.dailyLimitMinor) block.push('DAILY_LIMIT');
    if (!L.allowedCurrencies.includes(a.currency)) block.push('CURRENCY_NOT_ALLOWED');
    if (!L.allowedDestinations.includes(a.destination)) block.push('DESTINATION_NOT_ALLOWED');
  }
  if (!/^[A-Za-z0-9._:-]{3,64}$/.test(a.destination)) block.push('INVALID_DESTINATION');
  if (c.mode === 'DEFENSIVE' || c.mode === 'CAUTIOUS') warn.push('MODE_' + c.mode);
  return { decision: block.length ? 'BLOCK' : warn.length ? 'WARN' : 'ALLOW', block, warn };
}

const DEFAULTS = { maxBalanceAgeMs: 5 * 60e3, approvalTtlMs: 10 * 60e3, pendingTtlMs: 30 * 60e3, providerTimeoutMs: 10e3, lockdownAfterFailures: 3 };
const paramsHash = a => h(JSON.stringify([a.userId, a.amountMinor, a.currency, a.destination, a.purpose]));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class Engine {
  constructor({ store, provider, clock = Date.now, cfg = {} }) { this.store = store; this.provider = provider || new UnsupportedProvider(); this.clock = clock; this.cfg = { ...DEFAULTS, ...cfg }; }
  audit(e) { return this.store.appendAudit({ ts: this.clock(), ...e }); }
  async own(userId, id) { const a = typeof id === 'string' && UUID.test(id) ? await this.store.get(id) : null; if (!a || a.userId !== userId) throw new SafeError('NOT_FOUND'); return a; }
  async ctx(userId, excludeId) {
    const now = this.clock(), d = new Date(now), dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    let balance; try { balance = await this.provider.getBalance(userId); } catch (e) { balance = { status: 'ERROR' }; }
    return {
      now, balance, limits: await this.store.getLimits(userId), mode: await this.store.getMode(userId), maxBalanceAgeMs: this.cfg.maxBalanceAgeMs,
      providerCaps: this.provider.capabilities ? this.provider.capabilities() : {}, ...(await this.store.exposure(userId, excludeId, dayStart)),
    };
  }
  async move(a, from, to, patch, rid, extra = {}) {
    const ev = { ts: this.clock(), actor: extra.actor || 'system', event: 'STATE_CHANGE', requestId: rid, actionId: a.id, prev: from, next: to, ...extra.data };
    const r = await this.store.cas(a.id, from, to, patch, ev, extra.entry);
    if (!r) throw new SafeError('INVALID_TRANSITION', `${from}->${to}`);
    return r;
  }
  async setLimits(userId, l, rid) {
    const ok = l && Number.isSafeInteger(l.maxAmountMinor) && Number.isSafeInteger(l.dailyLimitMinor) && Number.isSafeInteger(l.minReserveMinor) && l.maxAmountMinor >= 0 && l.dailyLimitMinor >= 0 && l.minReserveMinor >= 0 && Array.isArray(l.allowedCurrencies) && Array.isArray(l.allowedDestinations);
    if (!ok) throw new SafeError('INVALID_LIMITS');
    await this.store.setLimits(userId, { ...l }); await this.audit({ actor: userId, event: 'LIMITS_SET', requestId: rid, limits: l });
  }
  async clearLockdown(userId, rid) { await this.store.setMode(userId, 'NORMAL'); await this.store.resetFails(userId); await this.audit({ actor: userId, event: 'LOCKDOWN_CLEARED', requestId: rid }); }
  async create(userId, p, rid) {
    const okp = p && Number.isSafeInteger(p.amountMinor) && p.amountMinor > 0 && /^[A-Z]{3}$/.test(p.currency || '') && typeof p.destination === 'string' && typeof p.purpose === 'string' && p.purpose.length <= 200 && typeof p.idempotencyKey === 'string' && p.idempotencyKey.length >= 8 && p.idempotencyKey.length <= 100;
    if (!okp) throw new SafeError('INVALID_REQUEST');
    const now = this.clock();
    const { action, created } = await this.store.getOrCreate(userId, p.idempotencyKey, () => {
      const a = { id: crypto.randomUUID(), userId, amountMinor: p.amountMinor, currency: p.currency, destination: p.destination, purpose: p.purpose, idempotencyKey: p.idempotencyKey, state: 'PENDING', createdAt: now, updatedAt: now, expiresAt: now + this.cfg.pendingTtlMs, risk: null, approval: null, reconciliationRequired: false, result: null };
      a.paramsHash = paramsHash(a); return a;
    });
    if (!created) return action;
    await this.audit({ actor: userId, event: 'ACTION_CREATED', requestId: rid, actionId: action.id, prev: null, next: 'PENDING' });
    const risk = evaluateRisk(action, await this.ctx(userId, action.id));
    await this.store.patch(action.id, { risk });
    await this.audit({ actor: 'risk_engine', event: 'RISK_DECISION', requestId: rid, actionId: action.id, risk });
    if (risk.decision === 'BLOCK') await this.move(action, 'PENDING', 'REJECTED', { result: { reasons: risk.block } }, rid);
    return this.store.get(action.id);
  }
  async approve(userId, id, { paramsHash: ph } = {}, rid) {
    const a = await this.own(userId, id), now = this.clock();
    if (a.state === 'PENDING' && now > a.expiresAt) { await this.move(a, 'PENDING', 'EXPIRED', {}, rid); throw new SafeError('EXPIRED'); }
    if (a.state !== 'PENDING') throw new SafeError('INVALID_TRANSITION', `${a.state}->APPROVED`);
    if (!a.risk) throw new SafeError('RISK_PENDING');
    if (a.risk.decision === 'BLOCK') throw new SafeError('RISK_BLOCKED');
    if (ph !== a.paramsHash) throw new SafeError('PARAMS_MISMATCH');
    const approval = { action_id: a.id, user_id: userId, amount: a.amountMinor, currency: a.currency, destination: a.destination, purpose: a.purpose, risk_summary: a.risk, approval_timestamp: now, expiration_timestamp: now + this.cfg.approvalTtlMs, idempotency_key: a.idempotencyKey, paramsHash: a.paramsHash };
    return this.move(a, 'PENDING', 'APPROVED', { approval }, rid, { actor: userId });
  }
  async cancel(userId, id, rid) {
    const a = await this.own(userId, id);
    if (a.state !== 'PENDING' && a.state !== 'APPROVED') throw new SafeError('INVALID_TRANSITION', `${a.state}->CANCELLED`);
    return this.move(a, a.state, 'CANCELLED', {}, rid, { actor: userId });
  }
  async execute(userId, id, rid) {
    let a = await this.own(userId, id);
    if (['COMPLETED', 'FAILED', 'VALIDATING', 'EXECUTING'].includes(a.state)) return a; // idempotent: never re-run
    if (a.state !== 'APPROVED') throw new SafeError(a.state === 'PENDING' ? 'NO_APPROVAL' : 'EXECUTION_BLOCKED', a.state);
    const claimed = await this.store.cas(id, 'APPROVED', 'VALIDATING', {}, { ts: this.clock(), actor: userId, event: 'STATE_CHANGE', requestId: rid, actionId: id, prev: 'APPROVED', next: 'VALIDATING' });
    if (!claimed) return this.store.get(id); // lost the race: another request owns this action
    a = await this.store.get(id); // re-read AFTER the claim: validate what is actually stored
    const rej = async (reasons) => { await this.move(a, 'VALIDATING', 'REJECTED', { result: { reasons } }, rid); throw new SafeError('EXECUTION_BLOCKED', reasons); };
    const ap = a.approval;
    if (!ap || ap.user_id !== userId) await rej(['NO_APPROVAL']);
    if (this.clock() > ap.expiration_timestamp) await rej(['APPROVAL_EXPIRED']);
    if (paramsHash(a) !== ap.paramsHash || a.amountMinor !== ap.amount || a.destination !== ap.destination || a.currency !== ap.currency) await rej(['PARAMS_CHANGED_AFTER_APPROVAL']);
    const risk = evaluateRisk(a, await this.ctx(userId, id));
    await this.audit({ actor: 'risk_engine', event: 'RISK_DECISION', requestId: rid, actionId: id, risk, phase: 'PRE_EXECUTION' });
    if (risk.decision === 'BLOCK') await rej(risk.block);
    await this.move(a, 'VALIDATING', 'EXECUTING', {}, rid);
    let res, timer;
    try {
      res = await Promise.race([this.provider.createPayment({ idempotencyKey: a.idempotencyKey, amountMinor: a.amountMinor, currency: a.currency, destination: a.destination, purpose: a.purpose }), new Promise((_, rj) => { timer = setTimeout(() => rj(new Error('TIMEOUT')), this.cfg.providerTimeoutMs); })]);
    } catch (e) { res = { status: e.message === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR' }; } finally { clearTimeout(timer); }
    if (res && res.status === 'CONFIRMED' && res.providerTxId) {
      try {
        const entry = { id: crypto.randomUUID(), actionId: a.id, type: 'PAYMENT', amountMinor: -a.amountMinor, currency: a.currency, source: 'REAL_PROVIDER_DATA', providerTxId: res.providerTxId, ts: this.clock() };
        await this.move(a, 'EXECUTING', 'COMPLETED', { result: { providerTxId: res.providerTxId } }, rid, { data: { provider: this.provider.name, providerClass: 'CONFIRMED' }, entry });
      } catch (e) { // provider confirmed but we could not record it: never report success
        try { await this.store.patch(a.id, { reconciliationRequired: true }); } catch (_) { /* store is down; error below still surfaces */ }
        throw new SafeError('PERSISTENCE_FAILURE_RECONCILIATION_REQUIRED');
      }
      await this.store.resetFails(userId);
    } else {
      const cls = res && res.status ? res.status : 'ERROR', unsupported = cls === 'UNSUPPORTED';
      await this.move(a, 'EXECUTING', 'FAILED', { reconciliationRequired: !unsupported, result: { reasons: ['PROVIDER_' + cls] } }, rid, { data: { provider: this.provider.name, providerClass: cls } });
      if (!unsupported && (await this.store.incFails(userId)) >= this.cfg.lockdownAfterFailures) { await this.store.setMode(userId, 'LOCKDOWN'); await this.audit({ actor: 'system', event: 'MODE_CHANGED', next: 'LOCKDOWN', reason: 'REPEATED_FAILURES' }); }
    }
    return this.store.get(id);
  }
}
module.exports = { Engine, MemoryStore, UnsupportedProvider, evaluateRisk, paramsHash, SafeError, TRANSITIONS, METHODS };
